// SHIP-6: /delivery/exceptions (SHIP-0 contract rule 14). Seeing needs delivery.view; resolving needs
// delivery.send. Every action is audited. The audit and resolve statements are guarded by the
// exception still being open and, where the action touches a shipment, by the shipment's expected
// state; the shipment compare-and-swap runs last. A second resolver, or one who lost to the cron,
// writes nothing and is told so.
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { getCourier } from '@hb/couriers';
import {
  adminUsers,
  buildOrderChange,
  classifyConstraintError,
  courierAccounts,
  courierWebhookInbox,
  deliveryExceptions,
  orders,
  readOrderSnapshot,
  recordAccepted,
  shipments,
  trackingInUse,
  type DeliveryException,
  type DeliveryExceptionKind,
  type OrderBatchItem,
  type Shipment,
} from '@hb/db';
import { audit, noAudit } from '../../audit/audit.ts';
import { can } from '../../auth/permissions.ts';
import { requirePerm } from '../../auth/require-role.ts';
import type { AppEnv } from '../../env.ts';
import { readForm } from '../../lib/forms.ts';
import { renderError } from '../../ui/error-page.tsx';
import { useUi } from '../../ui/context.ts';
import { StatusBadge } from '../../ui/badge.tsx';
import { ErrorSummary, Form, FormActions, Submit, Textarea, TextInput } from '../../ui/form.tsx';
import { Bdi, DateTime, Num } from '../../ui/format.tsx';
import { withFlash } from '../../ui/flash.tsx';
import { Table } from '../../ui/table.tsx';
import { xm, type ExceptionMessage } from './exceptions-messages.ts';
import { openCredentials, readKeyState } from './keys.ts';
import { validateDraft, type SendRun } from './send.ts';

type Ctx = Context<AppEnv>;

export const RESOLUTIONS = {
  unknown_status: ['delivered', 'returned', 'no_change'],
  uncertain_send: ['parcel_exists', 'no_parcel'],
  draft_unvalidated: ['validate', 'no_parcel'],
  terminal_conflict: ['handled'],
  order_not_applicable: ['handled'],
  unmatched_tracking: ['foreign', 'no_change'],
  invalid_signature: ['acknowledge'],
  inbox_poison: ['acknowledge', 'retry'],
} as const satisfies Record<DeliveryExceptionKind, readonly string[]>;
type Resolution = (typeof RESOLUTIONS)[DeliveryExceptionKind][number];

const TRACKING_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NOTE_MAX = 500;
const LIST_LIMIT = 200;

export interface ExceptionRow {
  ex: DeliveryException;
  ref: string | null;
  tracking: string | null;
  shipmentState: Shipment['state'] | null;
  resolverName: string | null;
}

async function fetchExceptions(c: Ctx, state: 'open' | 'resolved'): Promise<ExceptionRow[]> {
  const rows = await c.var.db
    .select({ ex: deliveryExceptions, ref: orders.ref, tracking: shipments.tracking, shipmentState: shipments.state, resolverName: adminUsers.name })
    .from(deliveryExceptions)
    .leftJoin(orders, eq(orders.id, deliveryExceptions.orderId))
    .leftJoin(shipments, eq(shipments.id, deliveryExceptions.shipmentId))
    .leftJoin(adminUsers, eq(adminUsers.id, deliveryExceptions.resolvedBy))
    .where(eq(deliveryExceptions.state, state))
    .orderBy(state === 'open' ? desc(deliveryExceptions.updatedAt) : desc(deliveryExceptions.resolvedAt))
    .limit(LIST_LIMIT);
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Page

function ResolveForms(props: { row: ExceptionRow; idSuffix: number }) {
  const tm = xm(useUi().lang);
  const { ex } = props.row;
  const base = `/delivery/exceptions/${ex.id}/resolve`;
  const actions: readonly Resolution[] = RESOLUTIONS[ex.kind];
  return (
    <div class="actions">
      {actions.map((a) => {
        if (a === 'parcel_exists') {
          return (
            <Form action={base}>
              <input type="hidden" name="action" value={a} />
              <TextInput name="tracking" label={tm('field.tracking')} idSuffix={props.idSuffix} dir="ltr" maxlength={64} autocomplete="off" />
              <FormActions>
                <Submit variant="secondary">{tm('action.parcel_exists')}</Submit>
              </FormActions>
            </Form>
          );
        }
        if (a === 'handled') {
          return (
            <Form action={base}>
              <input type="hidden" name="action" value={a} />
              <Textarea name="note" label={tm('field.note')} idSuffix={props.idSuffix} rows={2} maxlength={NOTE_MAX} />
              <FormActions>
                <Submit variant="secondary">{tm('action.handled')}</Submit>
              </FormActions>
            </Form>
          );
        }
        return (
          <Form action={base}>
            <input type="hidden" name="action" value={a} />
            <Submit variant={a === 'no_parcel' ? 'danger' : 'secondary'}>{tm(`action.${a}`)}</Submit>
          </Form>
        );
      })}
    </div>
  );
}

export function ExceptionsPage(props: { rows: readonly ExceptionRow[]; state: 'open' | 'resolved'; canResolve: boolean; error?: string }) {
  const { lang } = useUi();
  const tm = xm(lang);
  return (
    <>
      {props.error ? <ErrorSummary errors={{ _form: props.error }} /> : null}
      <p>{tm('intro')}</p>
      <nav class="tabs" aria-label={tm('title')}>
        <a class={props.state === 'open' ? 'tab tab--current' : 'tab'} href="/delivery/exceptions" aria-current={props.state === 'open' ? 'page' : undefined}>{tm('tab.open')}</a>
        <a class={props.state === 'resolved' ? 'tab tab--current' : 'tab'} href="/delivery/exceptions?state=resolved" aria-current={props.state === 'resolved' ? 'page' : undefined}>{tm('tab.resolved')}</a>
      </nav>
      <Table
        caption={tm(props.state === 'open' ? 'caption.open' : 'caption.resolved')}
        rows={props.rows}
        rowKey={(r) => String(r.ex.id)}
        stack
        empty={tm(props.state === 'open' ? 'empty.open' : 'empty.resolved')}
        columns={[
          {
            key: 'kind',
            header: tm('col.kind'),
            cell: (r) => (
              <>
                <StatusBadge tone={r.ex.kind === 'uncertain_send' || r.ex.kind === 'terminal_conflict' ? 'danger' : 'warning'} label={tm(`kind.${r.ex.kind}`)} />
                {props.state === 'open' ? <p class="muted">{tm(`help.${r.ex.kind}` as ExceptionMessage)}</p> : null}
              </>
            ),
          },
          { key: 'order', header: tm('col.order'), cell: (r) => (r.ref ? <a href={`/orders/${r.ref}#shipment`}><Bdi>{r.ref}</Bdi></a> : '—') },
          {
            key: 'parcel',
            header: tm('col.parcel'),
            cell: (r) => {
              const courier = r.ex.courier ? (getCourier(r.ex.courier)?.displayName ?? r.ex.courier) : null;
              const tracking = r.tracking ?? (r.ex.subject.startsWith('t:') ? r.ex.subject.slice(r.ex.subject.indexOf('|') + 1) : null);
              return (
                <>
                  {courier ? <Bdi>{courier}</Bdi> : null} {tracking ? <Bdi ltr>{tracking}</Bdi> : null}
                </>
              );
            },
          },
          {
            key: 'detail',
            header: tm('col.detail'),
            cell: (r) => (
              <>
                {r.ex.rawStatus ? <span lang="fr" dir="auto">« {r.ex.rawStatus} » </span> : null}
                {r.ex.detail ? <code dir="ltr">{r.ex.detail}</code> : null}
                {r.ex.count > 1 ? <p class="muted">{tm('count', { count: r.ex.count })}</p> : null}
                {r.ex.state === 'resolved' ? (
                  <p>
                    {tm('resolution', { resolution: r.ex.resolution ?? '' })} {r.resolverName ? tm('by', { name: r.resolverName }) : null}
                    {r.ex.resolutionNote ? <span> · <Bdi>{r.ex.resolutionNote}</Bdi></span> : null}
                  </p>
                ) : null}
              </>
            ),
          },
          { key: 'when', header: tm('col.when'), cell: (r) => <DateTime ms={r.ex.state === 'resolved' && r.ex.resolvedAt ? r.ex.resolvedAt : r.ex.createdAt} /> },
          ...(props.canResolve && props.state === 'open' ? [{ key: 'action', header: tm('col.action'), cell: (r: ExceptionRow) => <ResolveForms row={r} idSuffix={r.ex.id} /> }] : []),
        ]}
      />
      {props.rows.length >= LIST_LIMIT ? <p class="muted"><Num value={LIST_LIMIT} /></p> : null}
    </>
  );
}

async function renderList(c: Ctx, status: 200 | 409 | 422, state: 'open' | 'resolved', error?: string) {
  const rows = await fetchExceptions(c, state);
  c.status(status);
  return c.render(<ExceptionsPage rows={rows} state={state} canResolve={can(c.var.user, 'delivery.send')} {...(error ? { error } : {})} />, { title: xm(c.var.lang)('title') });
}

// ---------------------------------------------------------------------------------------------
// Resolving

const changesOf = (result: unknown): number => (result as { meta?: { changes?: number } }).meta?.changes ?? 0;

interface Resolve {
  ex: DeliveryException;
  resolution: Resolution;
  note: string | null;
  now: number;
}

const openGuard = (id: number): SQL => sql`EXISTS (SELECT 1 FROM ${deliveryExceptions} WHERE ${deliveryExceptions.id} = ${id} AND ${deliveryExceptions.state} = 'open')`;
const shipmentIn = (id: number, state: Shipment['state'], extra?: SQL): SQL =>
  sql`EXISTS (SELECT 1 FROM ${shipments} WHERE ${shipments.id} = ${id} AND ${shipments.state} = ${state}${extra ? sql` AND ${extra}` : sql``})`;
/** The row this request just resolved, so a statement after it runs only for this resolver. */
const resolvedByMe = (c: Ctx, r: Resolve): SQL =>
  sql`EXISTS (SELECT 1 FROM ${deliveryExceptions} WHERE ${deliveryExceptions.id} = ${r.ex.id} AND ${deliveryExceptions.state} = 'resolved' AND ${deliveryExceptions.resolution} = ${r.resolution} AND ${deliveryExceptions.resolvedBy} = ${c.var.user.id} AND ${deliveryExceptions.resolvedAt} = ${r.now})`;

function resolveItem(c: Ctx, r: Resolve, when?: SQL) {
  return c.var.db
    .update(deliveryExceptions)
    .set({ state: 'resolved', resolution: r.resolution, resolutionNote: r.note, resolvedBy: c.var.user.id, resolvedAt: r.now, updatedAt: r.now })
    .where(and(eq(deliveryExceptions.id, r.ex.id), eq(deliveryExceptions.state, 'open'), when));
}

function auditItem(c: Ctx, r: Resolve, when: SQL, after: Record<string, unknown> = {}) {
  return audit(
    c,
    { action: 'deliveryException.resolve', entity: 'delivery_exceptions', entityId: r.ex.id, before: { kind: r.ex.kind, state: 'open' }, after: { resolution: r.resolution, ...after } },
    { when },
  );
}

type Outcome = { ok: true } | { ok: false; status: 409 | 422; key: ExceptionMessage; detail?: string };
const gone: Outcome = { ok: false, status: 409, key: 'err.gone' };

/** Audit + resolve only. */
async function closeOnly(c: Ctx, r: Resolve, when?: SQL, after?: Record<string, unknown>): Promise<Outcome> {
  const guard = when ? sql`${openGuard(r.ex.id)} AND ${when}` : openGuard(r.ex.id);
  const res = await c.var.db.batch([auditItem(c, r, guard, after), resolveItem(c, r, when)]);
  return changesOf(res.at(-1)) === 1 ? { ok: true } : gone;
}

async function shipmentOf(c: Ctx, ex: DeliveryException): Promise<Shipment | undefined> {
  if (ex.shipmentId === null) return undefined;
  return (await c.var.db.select().from(shipments).where(eq(shipments.id, ex.shipmentId)))[0];
}

/** Treat as delivered / returned: the resolver's own role and the order version decide. */
async function moveOrder(c: Ctx, r: Resolve, to: 'delivered' | 'returned'): Promise<Outcome> {
  if (r.ex.orderId === null) return { ok: false, status: 422, key: 'err.action' };
  const snap = await readOrderSnapshot(c.var.db, r.ex.orderId);
  if (!snap) return gone;
  const guard = openGuard(r.ex.id);
  const after = sql`EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.id} = ${snap.id} AND ${orders.version} = ${snap.version + 1} AND ${orders.status} = ${to})`;
  const built = buildOrderChange(
    c.var.db,
    snap,
    { orderId: snap.id, expectedVersion: snap.version, actor: { userId: c.var.user.id, role: c.var.user.role }, hops: [[snap.status, to]], now: r.now },
    [auditItem(c, r, sql`${guard} AND EXISTS (SELECT 1 FROM ${orders} WHERE ${orders.id} = ${snap.id} AND ${orders.version} = ${snap.version})`, { order: to })],
    { guard },
  );
  if (!built.ok) return { ok: false, status: 409, key: 'err.transition' };
  try {
    const res = await c.var.db.batch([...built.items, resolveItem(c, r, after)] as [OrderBatchItem, ...OrderBatchItem[]]);
    return changesOf(res.at(-1)) === 1 ? { ok: true } : gone;
  } catch (err) {
    if (classifyConstraintError(err) === 'shipment_in_progress') return { ok: false, status: 409, key: 'err.transition' };
    throw err;
  }
}

/** "No parcel": the slot is freed, the tracking (if any) kept for the record. */
async function noParcel(c: Ctx, r: Resolve, expected: 'uncertain' | 'draft'): Promise<Outcome> {
  const sh = await shipmentOf(c, r.ex);
  if (!sh || sh.state !== expected) return gone;
  const shipGuard = shipmentIn(sh.id, expected);
  const res = await c.var.db.batch([
    auditItem(c, r, sql`${openGuard(r.ex.id)} AND ${shipGuard}`, { shipment: sh.id }),
    resolveItem(c, r, shipGuard),
    c.var.db
      .update(shipments)
      .set({ state: 'failed', errorCode: 'no_parcel', errorDetail: null, verifyNextAt: null, updatedAt: r.now })
      .where(and(eq(shipments.id, sh.id), eq(shipments.state, expected), resolvedByMe(c, r))),
  ]);
  return changesOf(res.at(-1)) === 1 ? { ok: true } : gone;
}

/** "The parcel exists, tracking X": accepted (or a draft on a courier with a validation step). */
async function parcelExists(c: Ctx, r: Resolve, tracking: string): Promise<Outcome> {
  if (!TRACKING_RE.test(tracking)) return { ok: false, status: 422, key: 'err.tracking' };
  const sh = await shipmentOf(c, r.ex);
  if (!sh || sh.state !== 'uncertain') return gone;
  const adapter = getCourier(sh.courier);
  if (!adapter) return { ok: false, status: 422, key: 'err.action' };
  if (await trackingInUse(c.var.db, sh.courier, tracking)) return { ok: false, status: 409, key: 'err.trackingUsed' };
  try {
    if (adapter.capabilities.needsValidation) {
      const shipGuard = shipmentIn(sh.id, 'uncertain');
      const res = await c.var.db.batch([
        auditItem(c, r, sql`${openGuard(r.ex.id)} AND ${shipGuard}`, { shipment: sh.id, tracking, state: 'draft' }),
        resolveItem(c, r, shipGuard),
        c.var.db
          .update(shipments)
          .set({ state: 'draft', tracking, errorCode: null, errorDetail: null, verifyNextAt: null, attemptEndedAt: r.now, updatedAt: r.now })
          .where(and(eq(shipments.id, sh.id), eq(shipments.state, 'uncertain'), resolvedByMe(c, r))),
      ]);
      return changesOf(res.at(-1)) === 1 ? { ok: true } : gone;
    }
    const accepted = shipmentIn(sh.id, 'accepted', sql`${shipments.tracking} = ${tracking}`);
    const res = await recordAccepted(c.var.db, {
      shipmentId: sh.id,
      orderId: sh.orderId,
      expected: 'uncertain',
      tracking,
      courierName: adapter.displayName,
      address: sh.address,
      actor: { userId: c.var.user.id, role: c.var.user.role },
      now: r.now,
      audit: (when) => auditItem(c, r, sql`${when} AND ${openGuard(r.ex.id)}`, { shipment: sh.id, tracking, state: 'accepted' }),
      // Same guard as the audit, so the exception never closes without its audit row.
      extra: (when) => [resolveItem(c, r, when)],
    });
    if (res.kind === 'lost') return gone;
    if (res.kind === 'duplicate_tracking') return { ok: false, status: 409, key: 'err.trackingUsed' };
    if (res.kind === 'shipped') return { ok: true };
    // Tracking stored, order not moved yet: close the exception; the cron moves the order.
    await closeOnly(c, r, accepted, { shipment: sh.id, tracking, state: 'accepted' });
    return { ok: false, status: 409, key: 'err.notApplied' };
  } catch (err) {
    if (classifyConstraintError(err) === 'duplicate_tracking') return { ok: false, status: 409, key: 'err.trackingUsed' };
    throw err;
  }
}

/** Validate a draft again, then close the exception if it shipped. */
async function validateAgain(c: Ctx, r: Resolve): Promise<Outcome> {
  const sh = await shipmentOf(c, r.ex);
  if (!sh || sh.state !== 'draft' || !sh.tracking) return gone;
  const adapter = getCourier(sh.courier);
  const account = (await c.var.db.select().from(courierAccounts).where(eq(courierAccounts.id, sh.accountId)))[0];
  const state = await readKeyState(c.env);
  const credentials = state.ok ? await openCredentials(state.key, account) : null;
  if (!adapter || !account || !credentials || !account.enabled) return { ok: false, status: 409, key: 'err.keys' };
  const ref = (await c.var.db.select({ ref: orders.ref }).from(orders).where(eq(orders.id, sh.orderId)))[0]?.ref ?? sh.reference;
  const run: SendRun = { adapter, account, credentials, items: [] };
  const out = await validateDraft(c, run, sh, ref, sh.tracking, { retryAfterMs: 60_000 });
  if (out.outcome === 'sent') return closeOnly(c, r, shipmentIn(sh.id, 'accepted'), { shipment: sh.id, validated: true });
  const detail = out.outcome === 'awaiting_validation' ? (out.detail ?? out.reason) : out.outcome;
  return { ok: false, status: 409, key: 'err.validate', detail };
}

async function retryInbox(c: Ctx, r: Resolve): Promise<Outcome> {
  const inboxId = Number(r.ex.subject.startsWith('i:') ? r.ex.subject.slice(2) : NaN);
  if (!Number.isSafeInteger(inboxId)) return { ok: false, status: 422, key: 'err.action' };
  const res = await c.var.db.batch([
    auditItem(c, r, openGuard(r.ex.id), { inbox: inboxId }),
    resolveItem(c, r),
    c.var.db
      .update(courierWebhookInbox)
      .set({ state: 'pending', attempts: 0, leaseUntil: null, nextAttemptAt: null, processedAt: null })
      .where(and(eq(courierWebhookInbox.id, inboxId), eq(courierWebhookInbox.state, 'poison'), resolvedByMe(c, r))),
  ]);
  return changesOf(res[1]) === 1 ? { ok: true } : gone;
}

async function resolveOne(c: Ctx, r: Resolve, tracking: string): Promise<Outcome> {
  switch (r.resolution) {
    case 'delivered':
    case 'returned':
      return moveOrder(c, r, r.resolution);
    case 'no_parcel':
      return noParcel(c, r, r.ex.kind === 'draft_unvalidated' ? 'draft' : 'uncertain');
    case 'parcel_exists':
      return parcelExists(c, r, tracking);
    case 'validate':
      return validateAgain(c, r);
    case 'retry':
      return retryInbox(c, r);
    case 'handled':
      if (!r.note) return { ok: false, status: 422, key: 'err.noteRequired' };
      return closeOnly(c, r);
    case 'no_change':
    case 'foreign':
    case 'acknowledge':
      return closeOnly(c, r);
  }
}

export function registerExceptions(r: Hono<AppEnv>): void {
  r.get('/exceptions', requirePerm('delivery.view'), (c) => renderList(c, 200, c.req.query('state') === 'resolved' ? 'resolved' : 'open'));

  r.post('/exceptions/:id/resolve', requirePerm('delivery.send'), async (c) => {
    const tm = xm(c.var.lang);
    const id = Number(c.req.param('id'));
    const ex = Number.isSafeInteger(id) && id > 0 ? (await c.var.db.select().from(deliveryExceptions).where(eq(deliveryExceptions.id, id)))[0] : undefined;
    if (!ex) {
      noAudit(c, 'unknown exception, nothing written');
      return renderError(c, 404);
    }
    const values = await readForm(c);
    const action = values['action'] ?? '';
    const allowed: readonly string[] = RESOLUTIONS[ex.kind];
    if (!allowed.includes(action)) {
      noAudit(c, 'action not offered for this exception, nothing written');
      return renderList(c, 422, 'open', tm('err.action'));
    }
    if (ex.state !== 'open') {
      noAudit(c, 'exception already resolved, nothing written');
      return renderList(c, 409, 'open', tm('err.gone'));
    }
    const note = (values['note'] ?? '').trim().slice(0, NOTE_MAX);
    const out = await resolveOne(c, { ex, resolution: action as Resolution, note: note === '' ? null : note, now: Date.now() }, (values['tracking'] ?? '').trim());
    if (out.ok) return c.redirect(withFlash('/delivery/exceptions', 'saved'), 303);
    // Statements carrying an audit row were guarded and wrote nothing; the refusal itself is not a change.
    noAudit(c, `resolve refused: ${out.key}`);
    return renderList(c, out.status, 'open', out.detail === undefined ? tm(out.key) : tm(out.key, { detail: out.detail }));
  });
}
