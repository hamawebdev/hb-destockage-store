// DB-4 — order write path (H). Plan: artifacts/DB-4/plan.md (approved with two guards: precise
// error mapping; ref collisions retried inside createOrder).
//
// Everything that writes an order runs as ONE D1 batch (= one transaction). D1 has no interactive
// transactions, so guards are expressed in SQL:
//   - stock: an unconditional `stock = stock - qty` on tracked variants; the CHECK
//     `variants_stock_nonneg` aborts the whole batch when it would go negative (a 0-row conditional
//     UPDATE would NOT abort: rev-d trap). NULL stock = untracked: 0 rows, stays NULL, orderable.
//   - admin changes: every statement is guarded by `orders.id = :id AND version = :v` and the
//     version-bumping UPDATE runs last, so a stale version writes nothing at all.
// Batch items are Drizzle query BUILDERS, never `db.run(sql…)`: in drizzle-orm 0.45 a raw item with
// bound parameters breaks inside a D1 `db.batch()` (SQLiteRaw has no prepared `stmt`: "Cannot read
// properties of undefined (reading 'bind')"). Callers' `extra` items must be builders too.
import { and, desc, eq, gte, isNotNull, ne, SQL, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { getTableConfig, type SQLiteTable, type SQLiteUpdateSetSource } from 'drizzle-orm/sqlite-core';
import { customers, orderEvents, orderItems, orders, variants } from './schema.ts';
import {
  CALLABLE_STATUSES,
  canTransition,
  computeTotals,
  DUPLICATE_WINDOW_MS,
  findTransition,
  isOrderFlag,
  makeOrderRef,
  MAX_ORDER_LINES,
  ORDER_REF_RE,
  type AdminRole,
  type CallOutcome,
  type OrderFlag,
  type OrderStatus,
  type StatusHop,
} from '@hb/shared';
import type { DbLang, TurnstileResult } from './enums.ts';
import type { Db } from './index.ts';

/** A statement for `db.batch` (what `extra` items are). */
export type OrderBatchItem = BatchItem<'sqlite'>;
type Item = OrderBatchItem;

// ---------------------------------------------------------------------------------------------
// Error classification (lead guard 1): identify the constraint exactly; anything else rethrows.
// ---------------------------------------------------------------------------------------------

export type ConstraintHit = 'idempotency_key' | 'ref' | 'stock' | 'shipment_in_progress';

const PATTERNS: readonly [ConstraintHit, RegExp][] = [
  ['idempotency_key', /\bUNIQUE constraint failed: orders\.idempotency_key(?![\w.])/],
  ['ref', /\bUNIQUE constraint failed: orders\.ref(?![\w.])/],
  ['stock', /\bCHECK constraint failed: variants_stock_nonneg(?!\w)/],
  // RAISE(ABORT) from the open-slot triggers (migration 0012).
  ['shipment_in_progress', /\bshipment_in_progress\b/],
];

/** Driver messages along the `cause` chain, excluding Drizzle's "Failed query: <sql>" wrapper text. */
function driverMessages(err: unknown): string[] {
  const out: string[] = [];
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 8; e = e.cause, depth++) {
    if (!e.message.startsWith('Failed query:')) out.push(e.message);
  }
  return out;
}

/** Which known constraint an error is, or null (= unexpected: the caller must rethrow). */
export function classifyConstraintError(err: unknown): ConstraintHit | null {
  const msgs = driverMessages(err);
  const hits = PATTERNS.filter(([, re]) => msgs.some((m) => re.test(m))).map(([k]) => k);
  return hits.length === 1 ? hits[0]! : null;
}

// ---------------------------------------------------------------------------------------------
// createOrder
// ---------------------------------------------------------------------------------------------

export interface OrderLineInput {
  readonly variantId: number;
  readonly productId: number;
  readonly nameFr: string;
  readonly nameAr: string;
  readonly variantLabelFr: string | null;
  readonly variantLabelAr: string | null;
  readonly sku: string;
  readonly unitPriceDzd: number;
  readonly qty: number;
  readonly lineTotalDzd: number;
}

export interface CreateOrderInput {
  readonly customer: { readonly phoneE164: string; readonly name: string };
  readonly order: {
    readonly ref: string;
    readonly idempotencyKey: string;
    readonly lang: DbLang;
    readonly wilayaCode: number;
    readonly communeId: number;
    readonly subtotalDzd: number;
    readonly feeDzd: number;
    readonly totalDzd: number;
    readonly feeSource: string;
    readonly flags: readonly OrderFlag[];
    readonly turnstile: TurnstileResult | null;
    readonly fillMs: number | null;
    readonly riskScore: number | null;
    readonly ipHash: string | null;
  };
  readonly lines: readonly OrderLineInput[];
  readonly now?: number;
}

export type CreateOrderResult =
  | { readonly ok: true; readonly orderId: number; readonly ref: string; readonly replayed: boolean }
  | { readonly ok: false; readonly reason: 'out_of_stock'; readonly variantIds: readonly number[] }
  | { readonly ok: false; readonly reason: 'ref_collision' };

export interface CreateOrderOptions {
  /** New ref after a collision (default: `makeOrderRef(crypto.getRandomValues)`). */
  readonly newRef?: () => string;
  /** Total refs tried, the input's included (default 3). */
  readonly maxRefAttempts?: number;
}

/** Programming errors (bad input from the caller), thrown before any I/O. */
export function assertOrderInput(input: CreateOrderInput): void {
  const { lines, order } = input;
  if (lines.length < 1 || lines.length > MAX_ORDER_LINES) throw new TypeError(`createOrder: ${lines.length} lines`);
  if (!ORDER_REF_RE.test(order.ref)) throw new TypeError(`createOrder: bad ref ${order.ref}`);
  for (const f of order.flags) if (!isOrderFlag(f)) throw new TypeError(`createOrder: unknown flag ${String(f)}`);
  const t = computeTotals(lines, order.feeDzd);
  t.lines.forEach((l, i) => {
    if (l.lineTotalDzd !== lines[i]!.lineTotalDzd) throw new TypeError(`createOrder: line ${i} total ${lines[i]!.lineTotalDzd} ≠ ${l.lineTotalDzd}`);
  });
  if (t.subtotalDzd !== order.subtotalDzd || t.totalDzd !== order.totalDzd) {
    throw new TypeError(`createOrder: totals ${order.subtotalDzd}/${order.totalDzd} ≠ computeTotals ${t.subtotalDzd}/${t.totalDzd}`);
  }
}

function defaultNewRef(): string {
  return makeOrderRef(crypto.getRandomValues(new Uint8Array(5)));
}

function createOrderItems(db: Db, input: CreateOrderInput, ref: string, now: number): Item[] {
  const { customer: c, order: o } = input;
  const orderId = sql`(SELECT id FROM orders WHERE idempotency_key = ${o.idempotencyKey})`;
  const items: Item[] = [
    db
      .insert(customers)
      .values({ phoneE164: c.phoneE164, name: c.name, orderCount: 1, lastOrderAt: now, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: customers.phoneE164,
        set: { name: sql`excluded.name`, orderCount: sql`${customers.orderCount} + 1`, lastOrderAt: sql`excluded.last_order_at`, updatedAt: now },
      }),
    db.insert(orders).values({
      ref,
      idempotencyKey: o.idempotencyKey,
      customerId: sql`(SELECT id FROM customers WHERE phone_e164 = ${c.phoneE164})`,
      name: c.name,
      phoneE164: c.phoneE164,
      wilayaCode: o.wilayaCode,
      communeId: o.communeId,
      lang: o.lang,
      status: 'new',
      subtotalDzd: o.subtotalDzd,
      feeDzd: o.feeDzd,
      totalDzd: o.totalDzd,
      feeSource: o.feeSource,
      flags: [...o.flags],
      turnstile: o.turnstile,
      fillMs: o.fillMs,
      riskScore: o.riskScore,
      ipHash: o.ipHash,
      createdAt: now,
      updatedAt: now,
    }),
  ];
  for (const l of input.lines) {
    items.push(
      db.insert(orderItems).values({
        orderId,
        variantId: l.variantId,
        productId: l.productId,
        nameFr: l.nameFr,
        nameAr: l.nameAr,
        variantLabelFr: l.variantLabelFr,
        variantLabelAr: l.variantLabelAr,
        sku: l.sku,
        unitPriceDzd: l.unitPriceDzd,
        qty: l.qty,
        lineTotalDzd: l.lineTotalDzd,
        // Evaluated in the same batch BEFORE the decrements below: qty if the variant is tracked now
        // (its decrement will apply or abort the batch), 0 if untracked (nothing is taken).
        stockTaken: sql`CASE WHEN (SELECT ${variants.stock} FROM ${variants} WHERE ${variants.id} = ${l.variantId}) IS NOT NULL THEN ${l.qty} ELSE 0 END`,
      }),
    );
  }
  for (const l of input.lines) {
    items.push(
      db
        .update(variants)
        .set({ stock: sql`${variants.stock} - ${l.qty}`, updatedAt: now })
        .where(and(eq(variants.id, l.variantId), isNotNull(variants.stock))),
    );
  }
  items.push(db.insert(orderEvents).values({ orderId, type: 'created', toStatus: 'new', actorType: 'customer', at: now }));
  return items;
}

/** Tracked line variants whose current stock is below the summed requested quantity. */
async function shortVariants(db: Db, lines: readonly OrderLineInput[]): Promise<number[]> {
  const want = new Map<number, number>();
  for (const l of lines) want.set(l.variantId, (want.get(l.variantId) ?? 0) + l.qty);
  const ids = [...want.keys()];
  const rows = await db.all<{ id: number; stock: number | null }>(
    sql`SELECT id, stock FROM variants WHERE id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`,
  );
  return rows.filter((r) => r.stock !== null && r.stock < want.get(r.id)!).map((r) => r.id).sort((a, b) => a - b);
}

export async function createOrder(db: Db, input: CreateOrderInput, opts: CreateOrderOptions = {}): Promise<CreateOrderResult> {
  assertOrderInput(input);
  const now = input.now ?? Date.now();
  const newRef = opts.newRef ?? defaultNewRef;
  const maxRef = Math.max(1, opts.maxRefAttempts ?? 3);
  let ref = input.order.ref;
  let refAttempts = 1;
  let stockRetried = false;

  for (;;) {
    try {
      // The id/ref read rides in the same batch (no extra round trip).
      const read = db.select({ id: orders.id, ref: orders.ref }).from(orders).where(eq(orders.idempotencyKey, input.order.idempotencyKey));
      const results = (await db.batch([...createOrderItems(db, input, ref, now), read] as unknown as [Item, ...Item[]])) as unknown[];
      const row = (results.at(-1) as { id: number; ref: string }[])[0]!;
      return { ok: true, orderId: row.id, ref: row.ref, replayed: false };
    } catch (err) {
      switch (classifyConstraintError(err)) {
        case 'idempotency_key': {
          const row = await db.get<{ id: number; ref: string }>(sql`SELECT id, ref FROM orders WHERE idempotency_key = ${input.order.idempotencyKey}`);
          if (!row) throw err; // unique hit but no row: impossible unless deleted; never a silent replay
          return { ok: true, orderId: row.id, ref: row.ref, replayed: true };
        }
        case 'ref': {
          if (refAttempts >= maxRef) return { ok: false, reason: 'ref_collision' };
          refAttempts++;
          ref = newRef();
          if (!ORDER_REF_RE.test(ref)) throw new TypeError(`createOrder: newRef() returned ${ref}`);
          continue;
        }
        case 'stock': {
          const short = await shortVariants(db, input.lines);
          if (short.length > 0) return { ok: false, reason: 'out_of_stock', variantIds: short };
          if (stockRetried) {
            const tracked = await db.all<{ id: number }>(
              sql`SELECT id FROM variants WHERE stock IS NOT NULL AND id IN (${sql.join(input.lines.map((l) => sql`${l.variantId}`), sql`, `)})`,
            );
            return { ok: false, reason: 'out_of_stock', variantIds: tracked.map((r) => r.id).sort((a, b) => a - b) };
          }
          stockRetried = true; // stock came back between the batch and the re-read: try once more
          continue;
        }
        default:
          throw err;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Dedup (same phone + overlapping variant within the window, not cancelled)
// ---------------------------------------------------------------------------------------------

export interface DuplicateQuery {
  readonly phoneE164: string;
  readonly variantIds: readonly number[];
  readonly now?: number;
  /** Default 30 minutes. */
  readonly windowMs?: number;
}

/** @hb/shared DUPLICATE_WINDOW_MS (30 min). */
export const DEDUP_WINDOW_MS = DUPLICATE_WINDOW_MS;

/** The query alone (a builder: safe inside `db.batch`), so web can put it in its read batch. */
export function recentDuplicateQuery(db: Db, q: DuplicateQuery) {
  const since = (q.now ?? Date.now()) - (q.windowMs ?? DEDUP_WINDOW_MS);
  return db
    .select({ id: orders.id, ref: orders.ref, version: orders.version })
    .from(orders)
    .where(
      and(
        eq(orders.phoneE164, q.phoneE164),
        gte(orders.createdAt, since),
        ne(orders.status, 'cancelled'),
        sql`EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = ${orders.id} AND i.variant_id IN (${sql.join(q.variantIds.map((v) => sql`${v}`), sql`, `)}))`,
      ),
    )
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(1);
}

export async function findRecentDuplicate(db: Db, q: DuplicateQuery): Promise<{ id: number; ref: string; version: number } | null> {
  if (q.variantIds.length === 0) return null;
  return (await recentDuplicateQuery(db, q))[0] ?? null;
}

/**
 * Marks an existing order as hit by a duplicate submit: adds flag `duplicate` once, bumps version,
 * and logs a `note` event (actor customer) describing the second attempt (no PII beyond its own).
 * The version bump is deliberately NOT version-guarded: the customer's resubmit wins, so an admin
 * who has the order open gets `version_conflict` on save and must reload. The admin can tell why
 * from the latest event (`note`, outcome `duplicate_submit`, actor `customer`) — show it as
 * "updated by the customer" (DB-4 r1 nit).
 */
export async function markDuplicate(db: Db, orderId: number, attempt: string, now = Date.now()): Promise<void> {
  await db.batch([
    db.insert(orderEvents).values({ orderId, type: 'note', outcome: 'duplicate_submit', note: attempt, actorType: 'customer', at: now }),
    db
      .update(orders)
      .set({
        flags: sql`CASE WHEN EXISTS (SELECT 1 FROM json_each(${orders.flags}) WHERE value = 'duplicate') THEN ${orders.flags}
          ELSE json_insert(${orders.flags}, '$[#]', 'duplicate') END`,
        version: sql`${orders.version} + 1`,
        updatedAt: now,
      })
      .where(eq(orders.id, orderId)),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Admin order changes (composable, version-guarded)
// ---------------------------------------------------------------------------------------------

/**
 * Fields an order change may set. A key present with `null` clears the column; an absent key leaves
 * it unchanged. Phone, wilaya/commune and fee changes go through `updateOrderContact` (DB-6), which
 * re-links the customer and re-quotes; claims are written by admin-orders without a version bump.
 */
export interface OrderPatch {
  readonly name?: string;
  readonly address?: string | null;
  readonly courierName?: string | null;
  readonly courierTracking?: string | null;
  readonly nextCallAt?: number | null;
}

/** Patchable keys (Drizzle property → SQL column, for documentation). */
const PATCH_COLUMNS: Record<keyof OrderPatch, string> = {
  name: 'name',
  address: 'address',
  courierName: 'courier_name',
  courierTracking: 'courier_tracking',
  nextCallAt: 'next_call_at',
};

/** A person, or the courier status sync (SHIP-0 contract). */
export type OrderChangeActor = { readonly userId: number; readonly role: AdminRole } | { readonly system: 'courier_sync' };

/** The only hops the courier sync may make. Anything else, and any call attempt, is refused. */
export const SYSTEM_HOPS: readonly StatusHop[] = [
  ['confirmed', 'shipped'],
  ['shipped', 'delivered'],
  ['shipped', 'returned'],
];

export interface OrderChange {
  readonly orderId: number;
  readonly expectedVersion: number;
  readonly actor: OrderChangeActor;
  /** Status hops in order (from @hb/shared resolveCallOutcome or a single transition). [] = none. */
  readonly hops?: readonly StatusHop[];
  /** Stored on each status_change event (e.g. a CancelReason). */
  readonly outcome?: string | null;
  readonly callAttempt?: { readonly outcome: CallOutcome; readonly note?: string | null };
  readonly note?: string | null;
  readonly patch?: OrderPatch;
  readonly now?: number;
}

export interface OrderSnapshot {
  readonly id: number;
  readonly status: OrderStatus;
  readonly version: number;
  readonly customerId: number;
}

export type OrderChangeRefusal = 'illegal_transition' | 'forbidden' | 'not_callable';
export type ApplyOrderChangeResult =
  | { readonly ok: true; readonly version: number; readonly status: OrderStatus }
  /** `shipment_in_progress`: a parcel slot is open on this order (open-slot triggers, migration 0012). */
  | { readonly ok: false; readonly code: 'not_found' | 'version_conflict' | 'shipment_in_progress' | OrderChangeRefusal };

/** `EXISTS (order :id at version :v)` — guard for callers' own `extra` statements. */
export function orderGuard(orderId: number, version: number): SQL {
  return sql`EXISTS (SELECT 1 FROM orders WHERE id = ${orderId} AND version = ${version})`;
}

const COUNTER: Partial<Record<OrderStatus, 'deliveredCount' | 'returnedCount' | 'cancelledCount'>> = {
  delivered: 'deliveredCount',
  returned: 'returnedCount',
  cancelled: 'cancelledCount',
};

/**
 * `INSERT INTO <table> SELECT <one value per column, table order> <from>`: an insert that writes a
 * row only when `<from>` (e.g. `FROM orders WHERE id = ? AND version = ?`, or `WHERE <guard>`)
 * yields one. `values` is keyed by SQL column name; a column not given gets its schema default
 * (SQL default expression or literal), else NULL (so an integer primary key autoincrements).
 * Built from the table's own column list, so it follows schema changes. Returns the insert
 * builder (batch-safe; chain `.onConflictDoUpdate(…)` for an upsert).
 */
export function guardedInsertSelect<T extends SQLiteTable>(db: Db, table: T, values: Record<string, unknown>, from: SQL) {
  const cols = getTableConfig(table).columns;
  const known = new Set(cols.map((c) => c.name));
  for (const k of Object.keys(values)) if (!known.has(k)) throw new TypeError(`guardedInsertSelect: unknown column ${k}`);
  const lit = (val: unknown): SQL => (val instanceof SQL ? val : sql`${typeof val === 'boolean' ? (val ? 1 : 0) : (val ?? null)}`);
  const list = cols.map((c) => {
    if (c.name in values) return lit(values[c.name]);
    if (c.primary || !c.hasDefault || c.default === undefined) return sql`NULL`;
    return lit(c.default);
  });
  return db.insert(table).select(sql`SELECT ${sql.join(list, sql`, `)} ${from}`);
}

export interface OrderChangeOptions {
  /**
   * Extra condition on every statement this change writes (events, restock, counter, order update).
   * A 0-row update does not abort a D1 batch, so a caller whose batch starts with a compare-and-swap
   * passes a guard requiring the state that swap set: if the swap lost, nothing else is written.
   */
  readonly guard?: SQL;
}

/**
 * Pure builder: validates the hops against @hb/shared for the actor's role and returns the guarded
 * batch items, the caller's `extra` placed just before the final version bump (always last).
 */
export function buildOrderChange(
  db: Db,
  current: OrderSnapshot,
  change: OrderChange,
  extra: readonly Item[] = [],
  opts: OrderChangeOptions = {},
): { ok: true; items: [Item, ...Item[]]; status: OrderStatus } | { ok: false; code: OrderChangeRefusal } {
  const now = change.now ?? Date.now();
  const { id } = current;
  const v = change.expectedVersion;
  const actor = change.actor;
  const isSystem = 'system' in actor;
  const hops = change.hops ?? [];

  let status = current.status;
  let restore = false;
  for (const [from, to] of hops) {
    if (from !== status) return { ok: false, code: 'illegal_transition' };
    const t = findTransition(from, to);
    if (!t) return { ok: false, code: 'illegal_transition' };
    const allowed = isSystem ? SYSTEM_HOPS.some(([f, t]) => f === from && t === to) : canTransition(from, to, actor.role);
    if (!allowed) return { ok: false, code: 'forbidden' };
    if (t.stock === 'restore') restore = true;
    status = to;
  }
  if (change.callAttempt && !CALLABLE_STATUSES.includes(current.status)) return { ok: false, code: 'not_callable' };
  if (change.callAttempt && (isSystem || !(['owner', 'confirmer'] as AdminRole[]).includes(actor.role))) return { ok: false, code: 'forbidden' };

  const items: Item[] = [];
  const guard = opts.guard ?? sql`1`;
  const from = sql`FROM orders WHERE id = ${id} AND version = ${v} AND ${guard}`;
  const who = isSystem ? { actor_type: 'system', actor_user_id: null } : { actor_type: 'admin', actor_user_id: actor.userId };
  const event = (values: Record<string, unknown>) => guardedInsertSelect(db, orderEvents, { order_id: sql`id`, ...who, at: now, ...values }, from);
  if (change.callAttempt) {
    items.push(event({ type: 'call_attempt', outcome: change.callAttempt.outcome, note: change.callAttempt.note ?? null }));
  }
  for (const [f, t] of hops) items.push(event({ type: 'status_change', from_status: f, to_status: t, outcome: change.outcome ?? null }));
  if (change.note) items.push(event({ type: 'note', note: change.note }));
  if (restore) {
    items.push(
      db
        .update(variants)
        .set({
          stock: sql`${variants.stock} + (SELECT SUM(oi.stock_taken) FROM order_items oi WHERE oi.order_id = ${id} AND oi.variant_id = ${variants.id})`,
          updatedAt: now,
        })
        // Restore exactly what createOrder took (order_items.stock_taken), and only to a variant that
        // is still tracked: untracked at order time → nothing taken → nothing restored; tracked then,
        // untracked now → stays NULL (DB-4 r1).
        .where(
          sql`${variants.id} IN (SELECT variant_id FROM order_items WHERE order_id = ${id} AND stock_taken > 0) AND ${variants.stock} IS NOT NULL
            AND EXISTS (SELECT 1 FROM orders WHERE id = ${id} AND version = ${v} AND stock_restored_at IS NULL) AND ${guard}`,
        ),
    );
  }
  const counter = hops.length > 0 ? COUNTER[status] : undefined;
  if (counter) {
    items.push(
      db
        .update(customers)
        .set({ [counter]: sql`${customers[counter]} + 1`, updatedAt: now })
        .where(and(eq(customers.id, current.customerId), orderGuard(id, v), guard)),
    );
  }
  items.push(...extra);

  const set: SQLiteUpdateSetSource<typeof orders> = {
    status,
    version: sql`${orders.version} + 1`,
    updatedAt: now,
    callAttempts: sql`${orders.callAttempts} + ${change.callAttempt ? 1 : 0}`,
  };
  if (restore) set.stockRestoredAt = sql`COALESCE(${orders.stockRestoredAt}, ${now})`;
  // A logged call releases the confirmer's claim (AORD-0 §5).
  if (change.callAttempt) Object.assign(set, { claimedByUserId: null, claimedUntil: null });
  for (const k of Object.keys(PATCH_COLUMNS) as (keyof OrderPatch)[]) {
    const val = change.patch?.[k];
    if (val !== undefined) (set as Record<string, unknown>)[k] = val;
  }
  items.push(db.update(orders).set(set).where(and(eq(orders.id, id), eq(orders.version, v), guard)));
  return { ok: true, items: items as [Item, ...Item[]], status };
}

async function readSnapshot(db: Db, orderId: number): Promise<OrderSnapshot | undefined> {
  const r = await db.get<{ id: number; status: OrderStatus; version: number; customer_id: number }>(
    sql`SELECT id, status, version, customer_id FROM orders WHERE id = ${orderId}`,
  );
  return r && { id: r.id, status: r.status, version: r.version, customerId: r.customer_id };
}

/** Reads the order, builds the change, runs ONE batch. A stale version changes nothing. */
export async function applyOrderChange(db: Db, change: OrderChange, extra: readonly Item[] = [], opts: OrderChangeOptions = {}): Promise<ApplyOrderChangeResult> {
  const current = await readSnapshot(db, change.orderId);
  if (!current) return { ok: false, code: 'not_found' };
  if (current.version !== change.expectedVersion) return { ok: false, code: 'version_conflict' };
  const built = buildOrderChange(db, current, change, extra, opts);
  if (!built.ok) return built;
  let results: { meta?: { changes?: number } }[];
  try {
    results = (await db.batch(built.items)) as unknown as { meta?: { changes?: number } }[];
  } catch (err) {
    // The open-slot trigger aborted the whole batch: nothing was written.
    if (classifyConstraintError(err) === 'shipment_in_progress') return { ok: false, code: 'shipment_in_progress' };
    throw err;
  }
  if ((results.at(-1)?.meta?.changes ?? 0) !== 1) {
    return (await readSnapshot(db, change.orderId)) ? { ok: false, code: 'version_conflict' } : { ok: false, code: 'not_found' };
  }
  return { ok: true, version: change.expectedVersion + 1, status: built.status };
}

/** The task's signature: one status hop. */
export async function transitionOrder(
  db: Db,
  orderId: number,
  to: OrderStatus,
  actor: { userId: number; role: AdminRole },
  outcome: string | null,
  expectedVersion: number,
  extra: readonly Item[] = [],
  now?: number,
): Promise<ApplyOrderChangeResult> {
  const current = await readSnapshot(db, orderId);
  if (!current) return { ok: false, code: 'not_found' };
  return applyOrderChange(
    db,
    { orderId, expectedVersion, actor, hops: [[current.status, to]], outcome, ...(now === undefined ? {} : { now }) },
    extra,
  );
}
