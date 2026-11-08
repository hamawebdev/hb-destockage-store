// Field-level access to customer and order records (permission `customers.sensitive`).
//
// Enforced where data is SELECTED, so a template cannot leak what it never received:
//
//   const cols = customerColumns(c.var.user);
//   const row = await db.select(cols).from(customers).where(eq(customers.id, id)).get();
//   // row.notes / row.flags / row.blocked … are `undefined` for logistics (never fetched)
//
//   const o = await db.select(orderColumns(c.var.user)).from(orders)…
//
// The SELECT side is the enforcement. For rows obtained another way (joins, aliases, raw SQL,
// relational queries), projectCustomer / projectOrder are ALLOW-LISTS (review 18f8a4b F1):
// without customers.sensitive they keep only the table's delivery keys plus aliases you
// declare safe, and drop every other key whatever its name (customerBlocked, ip_hash,
// customerNotes…).
//
//   projectOrder(user, row, { safe: ['customerName', 'communeNameFr'] })
//
// `canSeeCustomerHistory(user)` gates the customer's order history and counters on pages.
// The order timeline (order_events: call attempts, outcomes, notes) counts as sensitive (it
// is the call workflow, like callAttempts): render it only when canSeeSensitive(user).
// Logistics sees the current status and, at most, the status_change events, selected without
// their notes.
import { getTableColumns } from 'drizzle-orm';
import { customers, orders } from '@hb/db';
import { can } from '../auth/permissions.ts';
import type { CurrentUser } from '../env.ts';

/** Customer columns that need `customers.sensitive`. Everything else is a delivery field. */
export const CUSTOMER_SENSITIVE = [
  'orderCount',
  'deliveredCount',
  'returnedCount',
  'cancelledCount',
  'flags',
  'blocked',
  'notes',
  'lastOrderAt',
] as const satisfies readonly (keyof typeof customers.$inferSelect)[];

/** Order columns that need `customers.sensitive` (anti-fraud, call workflow internals). */
export const ORDER_SENSITIVE = [
  'idempotencyKey',
  'flags',
  'turnstile',
  'fillMs',
  'riskScore',
  'ipHash',
  'callAttempts',
  'nextCallAt',
  'claimedByUserId',
  'claimedUntil',
] as const satisfies readonly (keyof typeof orders.$inferSelect)[];

type CustomerCols = ReturnType<typeof getTableColumns<typeof customers>>;
type OrderCols = ReturnType<typeof getTableColumns<typeof orders>>;
type CustomerSensitiveKey = (typeof CUSTOMER_SENSITIVE)[number];
type OrderSensitiveKey = (typeof ORDER_SENSITIVE)[number];

/** Delivery columns always present; sensitive ones optional (absent without the permission). */
export type CustomerColumnsFor = Omit<CustomerCols, CustomerSensitiveKey> & Partial<Pick<CustomerCols, CustomerSensitiveKey>>;
export type OrderColumnsFor = Omit<OrderCols, OrderSensitiveKey> & Partial<Pick<OrderCols, OrderSensitiveKey>>;

export function canSeeSensitive(user: Pick<CurrentUser, 'role'>): boolean {
  return can(user, 'customers.sensitive');
}

/** Same rule, named for page logic: order history and counters on the customer page. */
export const canSeeCustomerHistory = canSeeSensitive;

/** Non-sensitive (delivery) keys of each table: the allow-lists. */
export const CUSTOMER_DELIVERY_KEYS: readonly string[] = Object.keys(getTableColumns(customers)).filter(
  (k) => !(CUSTOMER_SENSITIVE as readonly string[]).includes(k),
);
export const ORDER_DELIVERY_KEYS: readonly string[] = Object.keys(getTableColumns(orders)).filter(
  (k) => !(ORDER_SENSITIVE as readonly string[]).includes(k),
);

function pick<T extends Record<string, unknown>>(obj: T, keys: ReadonlySet<string>): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj)) if (keys.has(k)) (out as Record<string, unknown>)[k] = obj[k];
  return out;
}

/** A declared-safe alias may not look like sensitive data (it would defeat the allow-list). */
const SENSITIVE_NAME = /(note|flag|block|risk|ip_?hash|iphash|turnstile|fill_?ms|idempotency|count|attempt|claim|history|next_?call)/i;

function allowSet(base: readonly string[], opts: ProjectOptions): Set<string> {
  for (const k of opts.safe ?? []) {
    if (SENSITIVE_NAME.test(k) || (CUSTOMER_SENSITIVE as readonly string[]).includes(k) || (ORDER_SENSITIVE as readonly string[]).includes(k)) {
      throw new Error(`projection: "${k}" cannot be declared safe`);
    }
  }
  return new Set([...base, ...(opts.safe ?? [])]);
}

export interface ProjectOptions {
  /** Extra keys (e.g. join aliases) that you have checked are delivery data. */
  safe?: readonly string[];
}

function omit<T extends Record<string, unknown>>(obj: T, keys: readonly string[]): T {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}

export function customerColumns(user: Pick<CurrentUser, 'role'>): CustomerColumnsFor {
  const all = getTableColumns(customers);
  return canSeeSensitive(user) ? all : omit(all, CUSTOMER_SENSITIVE);
}

export function orderColumns(user: Pick<CurrentUser, 'role'>): OrderColumnsFor {
  const all = getTableColumns(orders);
  return canSeeSensitive(user) ? all : omit(all, ORDER_SENSITIVE);
}

/**
 * Allow-list for an already-fetched customer-like row: without customers.sensitive only the
 * customers table's delivery keys and `opts.safe` survive; every other key is dropped.
 */
export function projectCustomer<T extends Record<string, unknown>>(user: Pick<CurrentUser, 'role'>, row: T, opts: ProjectOptions = {}): Partial<T> {
  return canSeeSensitive(user) ? row : pick(row, allowSet(CUSTOMER_DELIVERY_KEYS, opts));
}

/**
 * Allow-list for an already-fetched order-like row (joins welcome): without customers.sensitive
 * only the orders table's delivery keys and `opts.safe` survive; every other key is dropped.
 */
export function projectOrder<T extends Record<string, unknown>>(user: Pick<CurrentUser, 'role'>, row: T, opts: ProjectOptions = {}): Partial<T> {
  return canSeeSensitive(user) ? row : pick(row, allowSet(ORDER_DELIVERY_KEYS, opts));
}
