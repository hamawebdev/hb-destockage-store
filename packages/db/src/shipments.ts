// SHIP-3 (SHIP-0 contract rules 1, 3, 4): the shipment write path shared by the admin and jobs.
//
// A parcel is never created twice: the slot is reserved in D1 before any courier call. Every later
// `state` change is compare-and-swap, and because a 0-row update does not abort a D1 batch, every
// other statement in an accept batch carries a guard requiring the state that batch set.
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { Db } from './index.ts';
import { auditLog, deliveryExceptions, shipments } from './schema.ts';
import type { DeliveryExceptionKind, DeliveryType, ShipmentState } from './enums.ts';
import { buildOrderChange, classifyConstraintError, guardedInsertSelect, orderGuard, readOrderSnapshot, type OrderBatchItem, type OrderChangeActor } from './orders.ts';

export const LIVE_SHIPMENT_STATES = ['reserved', 'sending', 'draft', 'accepted', 'uncertain'] as const satisfies readonly ShipmentState[];

const MAX_ACCEPT_ATTEMPTS = 3;
const DETAIL_MAX_CHARS = 300;

export const clip = (text: string | null | undefined): string | null => (text == null ? null : text.slice(0, DETAIL_MAX_CHARS));

// ---------------------------------------------------------------------------------------------
// Reserve
// ---------------------------------------------------------------------------------------------

export interface ReserveInput {
  readonly orderId: number;
  readonly version: number;
  readonly courier: string;
  readonly accountId: number;
  readonly deliveryType: DeliveryType;
  readonly stopDeskId: string | null;
  readonly stopDeskName: string | null;
  readonly address: string | null;
  readonly createdBy: number;
  readonly now: number;
}

export type ReserveResult = { readonly ok: true; readonly shipmentId: number } | { readonly ok: false; readonly code: 'taken' | 'stale' };

/**
 * Takes the order's one parcel slot, or nothing. The amounts and destination are copied by this same
 * statement from the row at the expected version, so the snapshot is what that version says.
 */
export async function reserveShipment(db: Db, input: ReserveInput): Promise<ReserveResult> {
  const rows = await guardedInsertSelect(
    db,
    shipments,
    {
      order_id: sql`id`,
      courier: input.courier,
      account_id: input.accountId,
      state: 'reserved',
      reference: sql`ref`,
      delivery_type: input.deliveryType,
      stop_desk_id: input.stopDeskId,
      stop_desk_name: input.stopDeskName,
      address: input.address,
      cod_amount_dzd: sql`total_dzd`,
      fee_dzd: sql`fee_dzd`,
      wilaya_code: sql`wilaya_code`,
      commune_id: sql`commune_id`,
      created_by: input.createdBy,
      created_at: input.now,
      updated_at: input.now,
    },
    sql`FROM orders WHERE id = ${input.orderId} AND version = ${input.version} AND status = 'confirmed'`,
  )
    .onConflictDoNothing()
    .returning({ id: shipments.id });
  const id = rows[0]?.id;
  if (id !== undefined) return { ok: true, shipmentId: id };
  const live = await db
    .select({ id: shipments.id })
    .from(shipments)
    .where(and(eq(shipments.orderId, input.orderId), inArray(shipments.state, [...LIVE_SHIPMENT_STATES])));
  return { ok: false, code: live.length > 0 ? 'taken' : 'stale' };
}

// ---------------------------------------------------------------------------------------------
// Compare-and-swap
// ---------------------------------------------------------------------------------------------

type ShipmentPatch = Partial<typeof shipments.$inferInsert>;

export function shipmentCas(db: Db, shipmentId: number, expected: ShipmentState, patch: ShipmentPatch) {
  return db
    .update(shipments)
    .set(patch)
    .where(and(eq(shipments.id, shipmentId), eq(shipments.state, expected)));
}

const changesOf = (result: unknown): number => (result as { meta?: { changes?: number } }).meta?.changes ?? 0;

/** True only if this caller made the change. */
export async function casShipment(db: Db, shipmentId: number, expected: ShipmentState, patch: ShipmentPatch): Promise<boolean> {
  return changesOf(await shipmentCas(db, shipmentId, expected, patch)) === 1;
}

/** The courier may be called only if this returned true, and only after it committed. */
export const claimSending = (db: Db, shipmentId: number, now: number) => casShipment(db, shipmentId, 'reserved', { state: 'sending', attemptedAt: now, updatedAt: now });

/** Marks that a validate call is about to run; only the winner makes the call. */
export async function claimValidate(db: Db, shipmentId: number, now: number, opts: { readonly retryAfterMs?: number } = {}): Promise<boolean> {
  const free = opts.retryAfterMs === undefined ? isNull(shipments.validateAttemptedAt) : sql`(${shipments.validateAttemptedAt} IS NULL OR ${shipments.validateAttemptedAt} <= ${now - opts.retryAfterMs})`;
  const res = await db
    .update(shipments)
    .set({ validateAttemptedAt: now, updatedAt: now })
    .where(and(eq(shipments.id, shipmentId), eq(shipments.state, 'draft'), free));
  return changesOf(res) === 1;
}

// ---------------------------------------------------------------------------------------------
// Audit and exceptions
// ---------------------------------------------------------------------------------------------

/** An audit row written by the system, inside a batch, only when `when` holds. */
export function systemAuditItem(
  db: Db,
  entry: { readonly action: string; readonly entity: string; readonly entityId: string | number; readonly before?: unknown; readonly after?: unknown },
  when: SQL,
  now: number,
): OrderBatchItem {
  return guardedInsertSelect(
    db,
    auditLog,
    {
      actor_type: 'system',
      action: entry.action,
      entity: entry.entity,
      entity_id: String(entry.entityId),
      before: entry.before === undefined ? null : JSON.stringify(entry.before),
      after: entry.after === undefined ? null : JSON.stringify(entry.after),
      at: now,
    },
    sql`WHERE ${when}`,
  );
}

export interface RaiseException {
  readonly kind: DeliveryExceptionKind;
  readonly subject: string;
  readonly shipmentId?: number | null;
  readonly orderId?: number | null;
  readonly courier?: string | null;
  readonly rawStatus?: string;
  readonly detail?: string | null;
  readonly now: number;
}

/** One open row per kind, subject and raw status; a repeat adds to its count. */
export function raiseExceptionItem(db: Db, e: RaiseException) {
  return db
    .insert(deliveryExceptions)
    .values({
      kind: e.kind,
      subject: e.subject,
      shipmentId: e.shipmentId ?? null,
      orderId: e.orderId ?? null,
      courier: e.courier ?? null,
      rawStatus: e.rawStatus ?? '',
      detail: clip(e.detail),
      createdAt: e.now,
      updatedAt: e.now,
    })
    .onConflictDoUpdate({
      target: [deliveryExceptions.kind, deliveryExceptions.subject, deliveryExceptions.rawStatus],
      targetWhere: sql`state = 'open'`,
      set: { count: sql`${deliveryExceptions.count} + 1`, updatedAt: e.now },
    });
}

export async function raiseException(db: Db, e: RaiseException): Promise<void> {
  await raiseExceptionItem(db, e);
}

// ---------------------------------------------------------------------------------------------
// Accept
// ---------------------------------------------------------------------------------------------

export interface AcceptInput {
  readonly shipmentId: number;
  readonly orderId: number;
  /** State this caller expects: send `sending`, cron `uncertain`, draft `draft`, retry `accepted`. */
  readonly expected: Extract<ShipmentState, 'sending' | 'uncertain' | 'draft' | 'accepted'>;
  readonly tracking: string;
  readonly labelUrl?: string | null;
  readonly courierName: string;
  /** The address the parcel was sent to, copied to the order. */
  readonly address?: string | null;
  readonly actor: OrderChangeActor;
  readonly now: number;
  /** The audit row, written only when `when` holds. */
  readonly audit: (when: SQL) => OrderBatchItem;
  /** More statements for the same batch (e.g. closing an exception), each written only when `when` holds. */
  readonly extra?: (when: SQL) => OrderBatchItem[];
}

export type AcceptResult =
  /** The order moved to `shipped`. */
  | { readonly kind: 'shipped' }
  /** Tracking is in D1, the order did not move yet; the cron retries. */
  | { readonly kind: 'stored' }
  /** Someone else moved this shipment first. Nothing was written. */
  | { readonly kind: 'lost' }
  | { readonly kind: 'duplicate_tracking' }
  /** Tracking stored, the order cannot move; one exception raised. */
  | { readonly kind: 'not_applicable' };

/**
 * The parcel is accepted. One batch: the shipment first, then, all guarded by the order version and
 * by the shipment being accepted with this tracking, the slot close, events, audit and the order.
 * A stale version therefore stores the tracking and nothing else.
 */
export async function recordAccepted(db: Db, input: AcceptInput): Promise<AcceptResult> {
  const { shipmentId: id, orderId, tracking, now } = input;
  const guard = sql`EXISTS (SELECT 1 FROM ${shipments} WHERE ${shipments.id} = ${id} AND ${shipments.state} = 'accepted' AND ${shipments.tracking} = ${tracking})`;
  let expected: AcceptInput['expected'] = input.expected;
  if (expected === 'accepted') {
    // A retry: someone may have applied it since this caller read the row.
    const row = (await db.select({ state: shipments.state, tracking: shipments.tracking, appliedAt: shipments.appliedAt }).from(shipments).where(eq(shipments.id, id)))[0];
    if (row?.state !== 'accepted' || row.tracking !== tracking) return { kind: 'lost' };
    if (row.appliedAt !== null) return { kind: 'shipped' };
  }
  const patch: ShipmentPatch = { state: 'accepted', tracking, errorCode: null, errorDetail: null, updatedAt: now, verifyNextAt: null };
  if (input.expected !== 'accepted') patch.acceptedAt = now;
  if (input.labelUrl !== undefined) patch.labelUrl = input.labelUrl;

  for (let attempt = 0; attempt < MAX_ACCEPT_ATTEMPTS; attempt++) {
    const cas = shipmentCas(db, id, expected, patch);
    const snapshot = await readOrderSnapshot(db, orderId);
    const built =
      snapshot && snapshot.status === 'confirmed'
        ? buildOrderChange(
            db,
            snapshot,
            {
              orderId,
              expectedVersion: snapshot.version,
              actor: input.actor,
              hops: [['confirmed', 'shipped']],
              patch: { courierName: input.courierName, courierTracking: tracking, ...(input.address != null ? { address: input.address } : {}) },
              now,
            },
            [
              db
                .update(shipments)
                .set({ appliedAt: now, updatedAt: now })
                .where(and(eq(shipments.id, id), orderGuard(orderId, snapshot.version), guard)),
              input.audit(sql`${orderGuard(orderId, snapshot.version)} AND ${guard}`),
              ...(input.extra?.(sql`${orderGuard(orderId, snapshot.version)} AND ${guard}`) ?? []),
            ],
            { guard },
          )
        : null;

    if (!built?.ok) {
      // Tracking is never left only in memory, and a person is told why the order did not move.
      const stored = changesOf(await cas) === 1;
      if (!stored && expected !== 'accepted') return { kind: 'lost' };
      await raiseException(db, { kind: 'order_not_applicable', subject: `s:${id}`, shipmentId: id, orderId, detail: 'parcel_accepted_order_not_confirmed', now });
      return { kind: 'not_applicable' };
    }

    let results: unknown[];
    try {
      results = (await db.batch([cas, ...built.items] as unknown as [OrderBatchItem, ...OrderBatchItem[]])) as unknown[];
    } catch (err) {
      if (classifyConstraintError(err) === 'duplicate_tracking') return { kind: 'duplicate_tracking' };
      throw err;
    }
    if (changesOf(results.at(-1)) === 1) return { kind: 'shipped' };
    if (changesOf(results[0]) !== 1 && expected !== 'accepted') {
      const row = (await db.select({ state: shipments.state, tracking: shipments.tracking }).from(shipments).where(eq(shipments.id, id)))[0];
      if (row?.state !== 'accepted' || row.tracking !== tracking) return { kind: 'lost' };
    }
    expected = 'accepted'; // our tracking is stored; only the order move is left to retry
  }
  return { kind: 'stored' };
}

/** A person says the order's parcel exists under this tracking; the row must be findable. */
export async function trackingInUse(db: Db, courier: string, tracking: string): Promise<boolean> {
  const rows = await db.select({ id: shipments.id }).from(shipments).where(and(eq(shipments.courier, courier), eq(shipments.tracking, tracking)));
  return rows.length > 0;
}

