// SHIP-5 (SHIP-0 contract rules 9 to 13): one code path for webhook and poll events. An event is
// appended once per (shipment, dedupe key); only `delivered` and `returned` move an order, through
// applyOrderChange with the system actor, every statement guarded by the order version.
import { getCourier, type ParcelEvent } from '@hb/couriers';
import {
  applyOrderChange,
  orderGuard,
  raiseExceptionItem,
  readOrderSnapshot,
  recordAccepted,
  shipmentEvents,
  shipments,
  systemAuditItem,
  type OrderBatchItem,
  type Shipment,
  type ShipmentEvent,
  type ShipmentEventSource,
} from '@hb/db';
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { changesOf, logStepError, SYSTEM_ACTOR, type SyncContext } from './context.ts';

const TERMINAL = new Set(['delivered', 'returned']);
const PROMOTES_DRAFT = new Set(['in_transit', 'delivered', 'returning', 'returned']);
/** An `occurred_at` this far past arrival is not believed (rule 10). */
const FUTURE_SLACK_MS = 5 * 60_000;

/** Rule 9: insert once per (shipment, dedupe key). True if this call added it. */
export async function appendEvent(ctx: SyncContext, shipmentId: number, ev: ParcelEvent, source: ShipmentEventSource, receivedAt: number): Promise<boolean> {
  const res = await ctx.db
    .insert(shipmentEvents)
    .values({
      shipmentId,
      dedupeKey: ev.eventKey.slice(0, 300),
      rawStatus: ev.rawStatus.slice(0, 200),
      mapped: ev.status,
      reason: ev.reason === null ? null : ev.reason.slice(0, 300),
      occurredAt: ev.occurredAt,
      receivedAt,
      source,
    })
    .onConflictDoNothing({ target: [shipmentEvents.shipmentId, shipmentEvents.dedupeKey] });
  return changesOf(res) === 1;
}

/** The shipment's own row lease (`verify_lease_until`): one run works on a shipment at a time. */
export async function claimShipment(ctx: SyncContext, id: number): Promise<boolean> {
  const now = ctx.now();
  const res = await ctx.db
    .update(shipments)
    .set({ verifyLeaseUntil: now + ctx.limits.LEASE_MS })
    .where(and(eq(shipments.id, id), or(isNull(shipments.verifyLeaseUntil), lt(shipments.verifyLeaseUntil, now))));
  return changesOf(res) === 1;
}

export async function releaseShipment(ctx: SyncContext, id: number): Promise<void> {
  await ctx.db.update(shipments).set({ verifyLeaseUntil: null }).where(eq(shipments.id, id));
}

const effectiveAt = (ev: Pick<ShipmentEvent, 'occurredAt' | 'receivedAt'>) => (ev.occurredAt !== null && ev.occurredAt <= ev.receivedAt + FUTURE_SLACK_MS ? ev.occurredAt : ev.receivedAt);

/** Flip a pending event, only if it is still pending. */
const settle = (ctx: SyncContext, eventId: number, state: 'applied' | 'ignored' | 'exception', when?: ReturnType<typeof sql>) =>
  ctx.db
    .update(shipmentEvents)
    .set({ state, appliedAt: ctx.now() })
    .where(and(eq(shipmentEvents.id, eventId), eq(shipmentEvents.state, 'pending'), when));

async function readShipment(ctx: SyncContext, id: number): Promise<Shipment | undefined> {
  return (await ctx.db.select().from(shipments).where(eq(shipments.id, id)))[0];
}

/** Applies every pending event of up to EVENT_SHIPMENTS shipments, oldest first. */
export async function applyPendingEvents(ctx: SyncContext, deadline: number): Promise<number> {
  const ids = await ctx.db
    .select({ id: shipmentEvents.shipmentId })
    .from(shipmentEvents)
    .where(eq(shipmentEvents.state, 'pending'))
    .groupBy(shipmentEvents.shipmentId)
    .orderBy(sql`min(${shipmentEvents.id})`)
    .limit(ctx.limits.EVENT_SHIPMENTS);
  let applied = 0;
  for (const { id } of ids) {
    if (ctx.now() >= deadline) break;
    if (!(await claimShipment(ctx, id))) continue;
    try {
      applied += await applyShipmentEvents(ctx, id);
    } catch (err) {
      logStepError('events', err, { shipment: id });
    } finally {
      await releaseShipment(ctx, id);
    }
  }
  return applied;
}

async function applyShipmentEvents(ctx: SyncContext, shipmentId: number): Promise<number> {
  const pending = await ctx.db
    .select()
    .from(shipmentEvents)
    .where(and(eq(shipmentEvents.shipmentId, shipmentId), eq(shipmentEvents.state, 'pending')))
    .orderBy(asc(shipmentEvents.id));
  let done = 0;
  for (const ev of pending) {
    const sh = await readShipment(ctx, shipmentId);
    if (!sh) return done;
    if ((await processEvent(ctx, sh, ev)) !== 'pending') done++;
  }
  return done;
}

type Outcome = 'pending' | 'applied' | 'ignored' | 'exception';

async function raiseFor(ctx: SyncContext, sh: Shipment, ev: ShipmentEvent, kind: 'order_not_applicable' | 'terminal_conflict' | 'unknown_status', detail: string): Promise<Outcome> {
  const now = ctx.now();
  await ctx.db.batch([
    settle(ctx, ev.id, 'exception'),
    raiseExceptionItem(ctx.db, { kind, subject: `s:${sh.id}`, shipmentId: sh.id, orderId: sh.orderId, courier: sh.courier, rawStatus: ev.rawStatus, detail, now }),
  ]);
  return 'exception';
}

/** Rules 10 to 13, in the contract's order. */
export async function processEvent(ctx: SyncContext, sh: Shipment, ev: ShipmentEvent): Promise<Outcome> {
  const now = ctx.now();
  const terminalEvent = TERMINAL.has(ev.mapped);

  // Rule 12, first: a failed shipment never moves an order.
  if (sh.state === 'failed') {
    if (terminalEvent) return raiseFor(ctx, sh, ev, 'order_not_applicable', 'shipment_failed');
    await settle(ctx, ev.id, 'ignored');
    return 'ignored';
  }

  // Slot still open: the event waits, except that a parcel moving on proves a draft shipped.
  const open = sh.state !== 'accepted' || sh.appliedAt === null;
  if (open) {
    if (sh.state !== 'draft' || !PROMOTES_DRAFT.has(ev.mapped) || !sh.tracking) return 'pending';
    const promoted = await recordAccepted(ctx.db, {
      shipmentId: sh.id,
      orderId: sh.orderId,
      expected: 'draft',
      tracking: sh.tracking,
      courierName: getCourier(sh.courier)?.displayName ?? sh.courier,
      address: sh.address,
      actor: SYSTEM_ACTOR,
      now,
      audit: (when) => systemAuditItem(ctx.db, { action: 'shipment.promote', entity: 'shipments', entityId: sh.id, after: { tracking: sh.tracking, status: ev.mapped } }, when, now),
    });
    if (promoted.kind !== 'shipped') return 'pending';
    const fresh = await readShipment(ctx, sh.id);
    return fresh ? processEvent(ctx, fresh, ev) : 'pending';
  }

  // Rule 11: a terminal shipment stays as it is.
  if (sh.courierStatus !== null && TERMINAL.has(sh.courierStatus)) {
    if (terminalEvent && ev.mapped !== sh.courierStatus) return raiseFor(ctx, sh, ev, 'terminal_conflict', `${sh.courierStatus}_then_${ev.mapped}`);
    await settle(ctx, ev.id, 'ignored');
    return 'ignored';
  }

  const display = { courierStatus: ev.mapped, courierStatusRaw: ev.rawStatus, courierStatusAt: effectiveAt(ev), updatedAt: now };

  if (terminalEvent) {
    const order = await readOrderSnapshot(ctx.db, sh.orderId);
    if (!order) return 'pending';
    // Moved by hand already: the shipment catches up, nothing else changes.
    if (order.status === ev.mapped) {
      await ctx.db.batch([ctx.db.update(shipments).set(display).where(eq(shipments.id, sh.id)), settle(ctx, ev.id, 'ignored')]);
      return 'ignored';
    }
    if (order.status !== 'shipped') return raiseFor(ctx, sh, ev, 'order_not_applicable', `order_${order.status}`);
    const guard = orderGuard(sh.orderId, order.version);
    const extra: OrderBatchItem[] = [
      ctx.db.update(shipments).set(display).where(and(eq(shipments.id, sh.id), guard)),
      settle(ctx, ev.id, 'applied', guard),
      systemAuditItem(ctx.db, { action: `shipment.${ev.mapped}`, entity: 'shipments', entityId: sh.id, after: { status: ev.mapped, raw: ev.rawStatus, eventId: ev.id } }, guard, now),
    ];
    const res = await applyOrderChange(ctx.db, { orderId: sh.orderId, expectedVersion: order.version, actor: SYSTEM_ACTOR, hops: [['shipped', ev.mapped as 'delivered' | 'returned']], now }, extra);
    if (res.ok) return 'applied';
    // Someone touched the order meanwhile: try again next run.
    if (res.code === 'version_conflict') return 'pending';
    return raiseFor(ctx, sh, ev, 'order_not_applicable', res.code);
  }

  // Non-terminal on an applied shipment: shown only (rule 10); unknown goes to a person (rule 13).
  const at = effectiveAt(ev);
  const newer = sh.courierStatusAt === null || at > sh.courierStatusAt;
  const items: OrderBatchItem[] = [];
  if (newer) {
    items.push(
      ctx.db
        .update(shipments)
        .set(display)
        .where(and(eq(shipments.id, sh.id), sql`(${shipments.courierStatus} IS NULL OR ${shipments.courierStatus} NOT IN ('delivered', 'returned'))`)),
    );
  }
  if (ev.mapped === 'unknown') {
    items.push(settle(ctx, ev.id, 'exception'), raiseExceptionItem(ctx.db, { kind: 'unknown_status', subject: `s:${sh.id}`, shipmentId: sh.id, orderId: sh.orderId, courier: sh.courier, rawStatus: ev.rawStatus, detail: 'unmapped', now }));
    await ctx.db.batch(items as [OrderBatchItem, ...OrderBatchItem[]]);
    return 'exception';
  }
  items.push(settle(ctx, ev.id, 'applied'));
  await ctx.db.batch(items as [OrderBatchItem, ...OrderBatchItem[]]);
  return 'applied';
}
