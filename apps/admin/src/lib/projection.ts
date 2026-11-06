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
// For rows obtained another way (joins, raw SQL, relational queries), pass them through
// projectCustomer / projectOrder before rendering. `canSeeCustomerHistory(user)` gates the
// customer's order history and counters on pages.
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

/** Strips sensitive keys from an already-fetched customer-like row (defence in depth). */
export function projectCustomer<T extends Record<string, unknown>>(user: Pick<CurrentUser, 'role'>, row: T): T {
  return canSeeSensitive(user) ? row : omit(row, CUSTOMER_SENSITIVE);
}

/** Strips sensitive keys from an already-fetched order-like row (defence in depth). */
export function projectOrder<T extends Record<string, unknown>>(user: Pick<CurrentUser, 'role'>, row: T): T {
  return canSeeSensitive(user) ? row : omit(row, ORDER_SENSITIVE);
}
