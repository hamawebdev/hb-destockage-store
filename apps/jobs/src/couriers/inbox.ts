// SHIP-5 (SHIP-0 contract rules 13a, 13b, 13c, 13e): drains the webhook inbox the public route
// filled. Signatures are verified here, with the account's sealed webhook secret, against the
// time the webhook arrived. Each row is claimed under a lease; dedupe and the order guards make an
// expired lease's second pass harmless.
import { courierWebhookInbox, isForeignTracking, raiseExceptionItem, shipments, type Shipment } from '@hb/db';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { log } from '../log.ts';
import { errorClass, type SyncAccount, type SyncContext } from './context.ts';
import { appendEvent } from './events.ts';

/** Where the owner's webhook signing secret sits inside the sealed credentials (admin settings). */
export const WEBHOOK_SECRET_FIELD = 'webhookSecret';

interface InboxRow {
  id: number;
  account_id: number;
  courier: string;
  body: ArrayBuffer | number[];
  headers: string;
  attempts: number;
  received_at: number;
}

/** Claims and processes pending rows of usable accounts. Rows of other accounts wait untouched. */
export async function drainInbox(ctx: SyncContext, accounts: readonly SyncAccount[], deadline: number): Promise<number> {
  const usable = new Map(accounts.filter((a) => a.usable).map((a) => [a.row.id, a]));
  if (usable.size === 0) return 0;
  let processed = 0;
  while (ctx.now() < deadline) {
    const now = ctx.now();
    const claimed = await ctx.d1
      .prepare(
        `UPDATE courier_webhook_inbox SET lease_until = ?1
         WHERE id IN (
           SELECT id FROM courier_webhook_inbox
           WHERE state IN ('pending', 'held') AND (lease_until IS NULL OR lease_until < ?2)
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?2)
             AND account_id IN (SELECT value FROM json_each(?3))
           ORDER BY id LIMIT ?4)
         AND (lease_until IS NULL OR lease_until < ?2)
         RETURNING id, account_id, courier, body, headers, attempts, received_at`,
      )
      .bind(now + ctx.limits.LEASE_MS, now, JSON.stringify([...usable.keys()]), ctx.limits.INBOX_BATCH)
      .all<InboxRow>();
    const rows = claimed.results.sort((a, b) => a.id - b.id);
    if (rows.length === 0) break;
    for (const row of rows) {
      const account = usable.get(row.account_id);
      try {
        if (!account || account.adapter.id !== row.courier) throw new Error('inbox row does not match its account');
        await processRow(ctx, account, row);
      } catch (err) {
        await failRow(ctx, row, err);
      }
      processed++;
    }
    if (rows.length < ctx.limits.INBOX_BATCH) break;
  }
  return processed;
}

async function processRow(ctx: SyncContext, account: SyncAccount, row: InboxRow): Promise<void> {
  const { adapter } = account;
  const rawBody = new Uint8Array(row.body as ArrayBuffer);
  const headers = JSON.parse(row.headers) as Record<string, string>;
  if (adapter.capabilities.webhook === 'hmac') {
    const secret = account.credentials?.[WEBHOOK_SECRET_FIELD] ?? '';
    const verified = await adapter.verifyWebhook({ rawBody, headers, secret, now: row.received_at });
    if (!verified.ok) return reject(ctx, row, verified.reason);
  }
  const parsed = adapter.parseWebhook(rawBody);
  if (!parsed.ok) return reject(ctx, row, parsed.reason);
  if (parsed.badRows > 0) log('courier_sync.webhook_bad_rows', { courier: adapter.id, inbox: row.id, count: parsed.badRows });

  const unmatched = new Set<string>();
  for (const ev of parsed.events) {
    const sh = await shipmentByTracking(ctx, adapter.id, ev.tracking);
    if (sh) await appendEvent(ctx, sh.id, ev, 'webhook', row.received_at);
    else if (!(await isForeignTracking(ctx.db, adapter.id, ev.tracking))) unmatched.add(ev.tracking);
  }
  const now = ctx.now();
  const where = eq(courierWebhookInbox.id, row.id);
  if (unmatched.size > 0 && now - row.received_at < ctx.limits.HOLD_MS) {
    // The webhook may have beaten our tracking write: try again next run.
    await ctx.db.update(courierWebhookInbox).set({ state: 'held', leaseUntil: null }).where(where);
    return;
  }
  await ctx.db.batch([
    ctx.db.update(courierWebhookInbox).set({ state: 'done', leaseUntil: null, processedAt: now }).where(where),
    ...[...unmatched].map((tracking) =>
      raiseExceptionItem(ctx.db, { kind: 'unmatched_tracking', subject: `t:${adapter.id}|${tracking}`, courier: adapter.id, detail: 'webhook', now }),
    ),
  ]);
}

/** Shipment lookup is by (this account's courier, tracking) only: never another courier's parcel. */
export async function shipmentByTracking(ctx: SyncContext, courier: string, tracking: string): Promise<Shipment | undefined> {
  return (await ctx.db.select().from(shipments).where(and(eq(shipments.courier, courier), eq(shipments.tracking, tracking))))[0];
}

async function reject(ctx: SyncContext, row: InboxRow, reason: string): Promise<void> {
  const now = ctx.now();
  await ctx.db.batch([
    ctx.db.update(courierWebhookInbox).set({ state: 'rejected', leaseUntil: null, processedAt: now }).where(eq(courierWebhookInbox.id, row.id)),
    raiseExceptionItem(ctx.db, { kind: 'invalid_signature', subject: `c:${row.courier}`, courier: row.courier, detail: reason, now }),
  ]);
}

async function failRow(ctx: SyncContext, row: InboxRow, err: unknown): Promise<void> {
  const now = ctx.now();
  const attempts = row.attempts + 1;
  log('courier_sync.inbox_failed', { inbox: row.id, attempts, error: errorClass(err) });
  try {
    if (attempts >= ctx.limits.INBOX_MAX_ATTEMPTS) {
      await ctx.db.batch([
        ctx.db.update(courierWebhookInbox).set({ state: 'poison', attempts, leaseUntil: null, processedAt: now }).where(eq(courierWebhookInbox.id, row.id)),
        raiseExceptionItem(ctx.db, { kind: 'inbox_poison', subject: `i:${row.id}`, courier: row.courier, detail: errorClass(err), now }),
      ]);
    } else {
      await ctx.db
        .update(courierWebhookInbox)
        .set({ attempts, leaseUntil: null, nextAttemptAt: now + attempts * 60_000 })
        .where(eq(courierWebhookInbox.id, row.id));
    }
  } catch (inner) {
    log('courier_sync.inbox_failed', { inbox: row.id, error: errorClass(inner) });
  }
}

/** Rule 13c: only finished rows go, after 14 days. */
export async function purgeInbox(ctx: SyncContext): Promise<void> {
  await ctx.db
    .delete(courierWebhookInbox)
    .where(and(inArray(courierWebhookInbox.state, ['done', 'rejected']), lt(courierWebhookInbox.processedAt, ctx.now() - ctx.limits.PURGE_MS)));
}
