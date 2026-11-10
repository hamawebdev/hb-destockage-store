// SHIP-5 (SHIP-0 contract rules 4, 5, 7): settling sends the admin could not finish. A parcel is
// never created here: the cron only looks parcels up, validates drafts the courier already holds,
// and writes what it learns with compare-and-swap.
import { foundDisposition, getCourier, isResendSafe, type CourierAdapter, type LookupResult } from '@hb/couriers';
import {
  autoResolveItem,
  casShipment,
  classifyConstraintError,
  claimValidate,
  clip,
  deliveryExceptions,
  raiseException,
  raiseExceptionOnceItem,
  recordAccepted,
  shipmentCas,
  shipments,
  systemAuditItem,
  type Shipment,
} from '@hb/db';
import { and, asc, eq, isNotNull, isNull, lt, lte, notExists, or, sql } from 'drizzle-orm';
import { changesOf, courierCtx, logStepError, SYSTEM_ACTOR, type SyncAccount, type SyncContext } from './context.ts';
import { claimShipment, releaseShipment } from './events.ts';

const subjectOf = (id: number) => `s:${id}`;

function accept(ctx: SyncContext, sh: Shipment, expected: 'uncertain' | 'draft' | 'accepted', tracking: string, displayName: string, action: string) {
  const now = ctx.now();
  return recordAccepted(ctx.db, {
    shipmentId: sh.id,
    orderId: sh.orderId,
    expected,
    tracking,
    courierName: displayName,
    address: sh.address,
    actor: SYSTEM_ACTOR,
    now,
    audit: (when) => systemAuditItem(ctx.db, { action, entity: 'shipments', entityId: sh.id, after: { courier: sh.courier, tracking, status: 'shipped' } }, when, now),
  });
}

/** One person-facing exception for a slot the system can't settle, and no more automatic checks. */
async function handToPerson(ctx: SyncContext, sh: Shipment, detail: string, expected: Shipment['state'] = 'uncertain'): Promise<void> {
  const now = ctx.now();
  await ctx.db.batch([
    shipmentCas(ctx.db, sh.id, expected, { verifyNextAt: null, verifyInconclusiveSince: null }),
    raiseExceptionOnceItem(ctx.db, { kind: 'uncertain_send', subject: subjectOf(sh.id), shipmentId: sh.id, orderId: sh.orderId, courier: sh.courier, detail, now }),
  ]);
}

/** Rule 4: the courier gave a tracking another shipment already holds. */
async function duplicateTracking(ctx: SyncContext, sh: Shipment, expected: 'uncertain' | 'draft', tracking: string): Promise<void> {
  const now = ctx.now();
  await casShipment(ctx.db, sh.id, expected, { state: 'uncertain', errorCode: 'duplicate_tracking', errorDetail: clip(tracking), verifyNextAt: null, updatedAt: now });
  await raiseException(ctx.db, { kind: 'uncertain_send', subject: subjectOf(sh.id), shipmentId: sh.id, orderId: sh.orderId, courier: sh.courier, detail: 'duplicate_tracking', now });
}

// ---------------------------------------------------------------------------------------------
// D1-only steps

/** Rule 7. `reserved` never attempted ⇒ failed; `sending` too long ⇒ uncertain, with the sweep time as its end. */
export async function sweepStale(ctx: SyncContext): Promise<number> {
  const now = ctx.now();
  const cutoff = now - ctx.limits.STALE_MS;
  const rows = await ctx.db
    .select()
    .from(shipments)
    .where(or(and(eq(shipments.state, 'reserved'), isNull(shipments.attemptedAt), lt(shipments.createdAt, cutoff)), and(eq(shipments.state, 'sending'), lt(shipments.attemptedAt, cutoff))))
    .limit(100);
  let swept = 0;
  for (const sh of rows) {
    if (sh.state === 'reserved') {
      if (await casShipment(ctx.db, sh.id, 'reserved', { state: 'failed', errorCode: 'not_attempted', errorDetail: null, updatedAt: now })) swept++;
      continue;
    }
    const verifies = getCourier(sh.courier)?.capabilities.verifyByReference === true;
    const when = sql`EXISTS (SELECT 1 FROM ${shipments} WHERE ${shipments.id} = ${sh.id} AND ${shipments.state} = 'uncertain' AND ${shipments.errorDetail} = 'stale_sending')`;
    const res = await ctx.db.batch([
      shipmentCas(ctx.db, sh.id, 'sending', {
        state: 'uncertain',
        errorCode: 'uncertain',
        errorDetail: 'stale_sending',
        attemptEndedAt: now,
        verifyNextAt: verifies ? now + ctx.limits.VERIFY_DELAY_MS : null,
        updatedAt: now,
      }),
      systemAuditItem(ctx.db, { action: 'shipment.sweep', entity: 'shipments', entityId: sh.id, after: { state: 'uncertain' } }, when, now),
    ]);
    if (changesOf(res[0]) !== 1) continue;
    swept++;
    if (!verifies) await raiseException(ctx.db, { kind: 'uncertain_send', subject: subjectOf(sh.id), shipmentId: sh.id, orderId: sh.orderId, courier: sh.courier, detail: 'stale_sending', now });
  }
  return swept;
}

/** Rule 4: an accepted parcel whose order move did not commit. Stops once a person must decide. */
export async function applyUnapplied(ctx: SyncContext, deadline: number): Promise<number> {
  const now = ctx.now();
  const rows = await ctx.db
    .select()
    .from(shipments)
    .where(
      and(
        eq(shipments.state, 'accepted'),
        isNull(shipments.appliedAt),
        lt(shipments.acceptedAt, now - ctx.limits.UNAPPLIED_GRACE_MS),
        notExists(
          ctx.db
            .select({ one: sql`1` })
            .from(deliveryExceptions)
            .where(and(eq(deliveryExceptions.kind, 'order_not_applicable'), eq(deliveryExceptions.subject, sql`'s:' || ${shipments.id}`))),
        ),
      ),
    )
    .limit(50);
  let shipped = 0;
  for (const sh of rows) {
    if (ctx.now() >= deadline || !sh.tracking) continue;
    if (!(await claimShipment(ctx, sh.id))) continue;
    try {
      const res = await accept(ctx, sh, 'accepted', sh.tracking, getCourier(sh.courier)?.displayName ?? sh.courier, 'shipment.apply');
      if (res.kind === 'shipped') shipped++;
    } catch (err) {
      logStepError('unapplied', err, { shipment: sh.id });
    } finally {
      await releaseShipment(ctx, sh.id);
    }
  }
  return shipped;
}

/** Rule 5, last line: no automatic check is possible, so a person decides at once. */
export async function parkUnverifiable(ctx: SyncContext, accounts: readonly SyncAccount[]): Promise<number> {
  const byId = new Map(accounts.map((a) => [a.row.id, a]));
  const rows = await ctx.db.select().from(shipments).where(and(eq(shipments.state, 'uncertain'), isNotNull(shipments.verifyNextAt))).limit(200);
  let parked = 0;
  for (const sh of rows) {
    const account = byId.get(sh.accountId);
    const reason = !account ? 'courier_unknown' : !account.adapter.capabilities.verifyByReference ? 'no_lookup' : !account.usable ? 'account_off' : null;
    if (reason === null) continue;
    await handToPerson(ctx, sh, reason);
    parked++;
  }
  return parked;
}

/** A draft nobody managed to validate within 5 minutes goes to a person (rule 14). */
export async function flagOldDrafts(ctx: SyncContext): Promise<number> {
  const now = ctx.now();
  const rows = await ctx.db
    .select()
    .from(shipments)
    .where(and(eq(shipments.state, 'draft'), lt(sql`coalesce(${shipments.attemptEndedAt}, ${shipments.updatedAt})`, now - ctx.limits.DRAFT_AGE_MS)))
    .limit(200);
  if (rows.length === 0) return 0;
  await ctx.db.batch(
    rows.map((sh) =>
      raiseExceptionOnceItem(ctx.db, { kind: 'draft_unvalidated', subject: subjectOf(sh.id), shipmentId: sh.id, orderId: sh.orderId, courier: sh.courier, detail: sh.errorCode ?? 'not_validated', now }),
    ) as [ReturnType<typeof raiseExceptionOnceItem>, ...ReturnType<typeof raiseExceptionOnceItem>[]],
  );
  return rows.length;
}

// ---------------------------------------------------------------------------------------------
// Courier steps (one account)

/** The cause the send recorded, which `isResendSafe` weighs (CARR-0, rev-h note). */
const causeOf = (sh: Shipment): string | null => (sh.errorCode === 'uncertain' ? sh.errorDetail : null);

/** Rule 5 for one account. */
export async function verifyUncertain(ctx: SyncContext, account: SyncAccount, deadline: number): Promise<number> {
  const { adapter, credentials } = account;
  if (!account.usable || !credentials || !adapter.capabilities.verifyByReference) return 0;
  const rows = await ctx.db
    .select()
    .from(shipments)
    .where(and(eq(shipments.accountId, account.row.id), eq(shipments.state, 'uncertain'), isNotNull(shipments.verifyNextAt), lte(shipments.verifyNextAt, ctx.now())))
    .orderBy(asc(shipments.verifyNextAt))
    .limit(ctx.limits.VERIFY_BATCH);
  let settled = 0;
  for (const sh of rows) {
    if (ctx.now() >= deadline) break;
    if (!(await claimShipment(ctx, sh.id))) continue;
    try {
      const lookup = await adapter.findByReference(sh.reference, { attemptedAt: sh.attemptedAt ?? sh.createdAt }, credentials, courierCtx(ctx, ctx.limits.CALL_MS));
      if (await settleLookup(ctx, account, sh, lookup)) settled++;
    } catch (err) {
      logStepError('verify', err, { shipment: sh.id });
    } finally {
      await releaseShipment(ctx, sh.id);
    }
  }
  return settled;
}

async function settleLookup(ctx: SyncContext, account: SyncAccount, sh: Shipment, lookup: LookupResult): Promise<boolean> {
  const { adapter } = account;
  const now = ctx.now();
  const autoClose = (resolution: string) => ctx.db.batch([autoResolveItem(ctx.db, subjectOf(sh.id), ['uncertain_send'], resolution, now)]);
  if (lookup.kind === 'found') {
    const disposition = foundDisposition(lookup, adapter.capabilities);
    if (disposition === 'person') {
      await handToPerson(ctx, sh, lookup.gone ? 'found_gone' : `found_${lookup.status}`);
      return true;
    }
    if (disposition === 'shipped') {
      const res = await accept(ctx, sh, 'uncertain', lookup.tracking, adapter.displayName, 'shipment.found');
      if (res.kind === 'duplicate_tracking') {
        await duplicateTracking(ctx, sh, 'uncertain', lookup.tracking);
        return true;
      }
      if (res.kind !== 'lost') await autoClose('parcel_found');
      return res.kind !== 'lost';
    }
    // A draft the courier holds: keep its tracking; the validate step makes the one call.
    try {
      const moved = await casShipment(ctx.db, sh.id, 'uncertain', { state: 'draft', tracking: lookup.tracking, verifyNextAt: null, verifyInconclusiveSince: null, errorCode: null, errorDetail: null, updatedAt: now });
      if (moved) await autoClose('parcel_found');
      return moved;
    } catch (err) {
      if (classifyConstraintError(err) !== 'duplicate_tracking') throw err;
      await duplicateTracking(ctx, sh, 'uncertain', lookup.tracking);
      return true;
    }
  }
  if (lookup.kind === 'multiple') {
    await handToPerson(ctx, sh, 'multiple');
    return true;
  }
  // A stored tracking means the courier answered once: a later `not_found` can't free the slot.
  if (sh.tracking === null && isResendSafe(lookup, sh.attemptEndedAt ?? Number.NaN, adapter.capabilities, causeOf(sh))) {
    const when = sql`EXISTS (SELECT 1 FROM ${shipments} WHERE ${shipments.id} = ${sh.id} AND ${shipments.state} = 'failed' AND ${shipments.errorCode} = 'verified_absent')`;
    const res = await ctx.db.batch([
      shipmentCas(ctx.db, sh.id, 'uncertain', { state: 'failed', errorCode: 'verified_absent', errorDetail: null, verifyNextAt: null, verifyInconclusiveSince: null, updatedAt: now }),
      systemAuditItem(ctx.db, { action: 'shipment.absent', entity: 'shipments', entityId: sh.id, after: { state: 'failed', reason: 'verified_absent' } }, when, now),
      autoResolveItem(ctx.db, subjectOf(sh.id), ['uncertain_send'], 'verified_absent', now, when),
    ]);
    return changesOf(res[0]) === 1;
  }
  // `unavailable`, or a `not_found` that proves nothing yet: keep checking; after 30 minutes a person is told too.
  const since = sh.verifyInconclusiveSince ?? now;
  const wait = Math.max(ctx.limits.VERIFY_DELAY_MS, lookup.kind === 'unavailable' ? (lookup.retryAfterMs ?? 0) : 0);
  const keep = shipmentCas(ctx.db, sh.id, 'uncertain', { verifyInconclusiveSince: since, verifyNextAt: now + wait });
  if (now - since >= ctx.limits.INCONCLUSIVE_MS) {
    await ctx.db.batch([keep, raiseExceptionOnceItem(ctx.db, { kind: 'uncertain_send', subject: subjectOf(sh.id), shipmentId: sh.id, orderId: sh.orderId, courier: sh.courier, detail: `inconclusive_${lookup.kind}`, now })]);
  } else {
    await keep;
  }
  return false;
}

/** Rule 4: the first validate of a draft nobody validated yet (a create past the cutoff, or found by a lookup). */
export async function validateDrafts(ctx: SyncContext, account: SyncAccount, deadline: number): Promise<number> {
  const { adapter, credentials } = account;
  if (!account.usable || !credentials || !adapter.capabilities.needsValidation) return 0;
  const rows = await ctx.db
    .select()
    .from(shipments)
    .where(and(eq(shipments.accountId, account.row.id), eq(shipments.state, 'draft'), isNull(shipments.validateAttemptedAt), isNotNull(shipments.tracking)))
    .limit(ctx.limits.VERIFY_BATCH);
  let done = 0;
  for (const sh of rows) {
    if (ctx.now() >= deadline || !sh.tracking) break;
    if (!(await claimValidate(ctx.db, sh.id, ctx.now()))) continue;
    try {
      if (await validateOne(ctx, adapter, account, sh, sh.tracking)) done++;
    } catch (err) {
      logStepError('validate', err, { shipment: sh.id });
    }
  }
  return done;
}

async function validateOne(ctx: SyncContext, adapter: CourierAdapter, account: SyncAccount, sh: Shipment, tracking: string): Promise<boolean> {
  const askCollection = account.row.config['askCollection'] === true;
  const res = await adapter.validateParcel(tracking, { askCollection }, account.credentials!, courierCtx(ctx, ctx.limits.CALL_MS));
  if (res.kind === 'validated') {
    const accepted = await accept(ctx, sh, 'draft', tracking, adapter.displayName, 'shipment.validate');
    if (accepted.kind === 'duplicate_tracking') await duplicateTracking(ctx, sh, 'draft', tracking);
    return accepted.kind === 'shipped' || accepted.kind === 'stored';
  }
  const now = ctx.now();
  const code = res.kind === 'uncertain' ? 'validate_uncertain' : res.code;
  const detail = res.kind === 'uncertain' ? res.cause : res.detail;
  await ctx.db
    .update(shipments)
    .set({ errorCode: code, errorDetail: clip(detail), updatedAt: now })
    .where(and(eq(shipments.id, sh.id), eq(shipments.state, 'draft')));
  return false;
}
