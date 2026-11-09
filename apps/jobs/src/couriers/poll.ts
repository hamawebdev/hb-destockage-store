// SHIP-5 (SHIP-0 contract rules 13a, 13d, 17): polling one account, least recently polled parcels
// first, and keeping the courier lists the sending page reads from D1 fresh.
import { courierAccounts, DIRECTORY_MAX_AGE_MS, orders, raiseExceptionOnceItem, readDirectory, refreshDirectory, shipments, type DirectoryTask } from '@hb/db';
import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { log } from '../log.ts';
import { changesOf, courierCtx, type SyncAccount, type SyncContext } from './context.ts';
import { appendEvent } from './events.ts';

/** Polls up to `pollBatchSize` open parcels of the account. Respects `minPollSeconds` and backoff. */
export async function pollAccount(ctx: SyncContext, account: SyncAccount): Promise<number> {
  const { adapter, credentials, row } = account;
  if (!account.usable || !credentials) return 0;
  const now = ctx.now();
  const caps = adapter.capabilities;
  // Claim the account: one poll per account at a time, no sooner than the courier allows.
  const claim = await ctx.db
    .update(courierAccounts)
    .set({ pollLeaseUntil: now + ctx.limits.LEASE_MS })
    .where(
      and(
        eq(courierAccounts.id, row.id),
        or(isNull(courierAccounts.pollLeaseUntil), lt(courierAccounts.pollLeaseUntil, now)),
        or(isNull(courierAccounts.pollBackoffUntil), lt(courierAccounts.pollBackoffUntil, now)),
        or(isNull(courierAccounts.lastPolledAt), lt(courierAccounts.lastPolledAt, now - caps.minPollSeconds * 1000 + 1)),
      ),
    );
  if (changesOf(claim) !== 1) return 0;

  let added = 0;
  try {
    const cols = { id: shipments.id, tracking: shipments.tracking, firstAbsentAt: shipments.firstAbsentAt, orderId: shipments.orderId };
    const leastRecent = [sql`${shipments.lastPolledAt} IS NOT NULL`, asc(shipments.lastPolledAt), asc(shipments.id)] as const;
    const open = await ctx.db
      .select(cols)
      .from(shipments)
      .where(
        and(
          eq(shipments.accountId, row.id),
          inArray(shipments.state, ['draft', 'accepted']),
          isNotNull(shipments.tracking),
          or(isNull(shipments.courierStatus), notInArray(shipments.courierStatus, ['delivered', 'returned'])),
        ),
      )
      .orderBy(...leastRecent)
      .limit(caps.pollBatchSize);
    // Lead ruling (SHIP-5 review nit 2): delivered parcels stay watched for 14 days, only in the room
    // the open ones leave in this one batch, so a courier's later return correction reaches a person
    // as a terminal_conflict. It moves nothing by itself.
    const room = caps.pollBatchSize - open.length;
    const watched =
      room > 0
        ? await ctx.db
            .select(cols)
            .from(shipments)
            .where(
              and(
                eq(shipments.accountId, row.id),
                eq(shipments.state, 'accepted'),
                isNotNull(shipments.tracking),
                eq(shipments.courierStatus, 'delivered'),
                gte(shipments.courierStatusAt, now - ctx.limits.DELIVERED_WATCH_MS),
              ),
            )
            .orderBy(...leastRecent)
            .limit(room)
        : [];
    const watchedIds = new Set(watched.map((p) => p.id));
    const parcels = [...open, ...watched];
    if (parcels.length === 0) {
      await ctx.db.update(courierAccounts).set({ pollLeaseUntil: null, lastPolledAt: now }).where(eq(courierAccounts.id, row.id));
      return 0;
    }
    const byTracking = new Map(parcels.map((p) => [p.tracking!, p]));
    const result = await adapter.fetchStatuses([...byTracking.keys()], credentials, courierCtx(ctx, ctx.limits.CALL_MS));
    const at = ctx.now();
    if (!result.ok) {
      await ctx.db
        .update(courierAccounts)
        .set({ pollLeaseUntil: null, pollBackoffUntil: at + Math.max(ctx.limits.POLL_BACKOFF_MS, result.retryAfterMs ?? 0) })
        .where(eq(courierAccounts.id, row.id));
      log('courier_sync.poll_failed', { courier: adapter.id });
      return 0;
    }
    for (const ev of result.events) {
      const p = byTracking.get(ev.tracking);
      // Only parcels this account asked about: never another courier's or account's.
      if (p && (await appendEvent(ctx, p.id, ev, 'poll', at))) added++;
    }
    if (result.invalid.length > 0 || result.badRows > 0) log('courier_sync.poll_dropped', { courier: adapter.id, invalid: result.invalid.length, badRows: result.badRows });

    const absent = new Set(result.absent);
    const items = [];
    for (const p of parcels) {
      if (absent.has(p.tracking!) && !watchedIds.has(p.id)) {
        const since = p.firstAbsentAt ?? at;
        items.push(ctx.db.update(shipments).set({ lastPolledAt: at, firstAbsentAt: since }).where(eq(shipments.id, p.id)));
        if (at - since >= ctx.limits.ABSENT_MS) {
          items.push(raiseExceptionOnceItem(ctx.db, { kind: 'unmatched_tracking', subject: `t:${adapter.id}|${p.tracking}`, shipmentId: p.id, orderId: p.orderId, courier: adapter.id, detail: 'absent_from_poll', now: at }));
        }
      } else {
        items.push(ctx.db.update(shipments).set({ lastPolledAt: at, firstAbsentAt: null }).where(eq(shipments.id, p.id)));
      }
    }
    items.push(ctx.db.update(courierAccounts).set({ pollLeaseUntil: null, pollBackoffUntil: null, lastPolledAt: at }).where(eq(courierAccounts.id, row.id)));
    await ctx.db.batch(items as [(typeof items)[0], ...(typeof items)[0][]]);
    return added;
  } catch (err) {
    await ctx.db.update(courierAccounts).set({ pollLeaseUntil: null }).where(eq(courierAccounts.id, row.id));
    throw err;
  }
}

/** Missing or old lists for the wilayas of orders waiting to be sent, within a small budget. */
export async function refreshLists(ctx: SyncContext, account: SyncAccount): Promise<void> {
  const { adapter, credentials } = account;
  if (!account.usable || !credentials) return;
  const waiting = await ctx.db
    .selectDistinct({ code: orders.wilayaCode })
    .from(orders)
    .where(eq(orders.status, 'confirmed'))
    .limit(69);
  const codes = waiting.map((w) => w.code);
  const cached = await readDirectory(ctx.db, adapter.id, codes);
  const now = ctx.now();
  const fresh = (kind: DirectoryTask['kind'], code: number) => cached.some((r) => r.kind === kind && r.wilayaCode === code && now - r.fetchedAt < DIRECTORY_MAX_AGE_MS);
  const c = (t: number) => courierCtx(ctx, t);
  const tasks: DirectoryTask[] = [];
  if (!fresh('wilayas', 0)) tasks.push({ kind: 'wilayas', wilayaCode: 0, fetch: (t) => adapter.listWilayas(credentials, c(t)) });
  for (const code of codes) {
    if (tasks.length >= ctx.limits.REFRESH_WILAYAS) break;
    if (!fresh('communes', code)) tasks.push({ kind: 'communes', wilayaCode: code, fetch: (t) => adapter.listCommunes(code, credentials, c(t)) });
    if (adapter.capabilities.stopDesk && !fresh('stop_desks', code)) tasks.push({ kind: 'stop_desks', wilayaCode: code, fetch: (t) => adapter.listStopDesks(code, credentials, c(t)) });
  }
  if (tasks.length > 0) await refreshDirectory(ctx.db, adapter.id, tasks, { budgetMs: ctx.limits.REFRESH_BUDGET_MS, perCallMs: ctx.limits.CALL_MS, now: ctx.now });
}
