// UX-7 — customer history on every order: the phone's other orders and how its parcels ended.
// Sensitive (order history is a `customers.sensitive` field, lib/projection.ts): read only for
// owner and confirmer. Counters come from the customers row (one row per phone, kept by
// applyOrderChange); the list is the latest few other orders of the same customer.

import { and, desc, eq, ne } from 'drizzle-orm';
import { orders, type Db } from '@hb/db';
import type { OrderStatus } from '@hb/shared';

export const HISTORY_LIMIT = 5;

export interface HistoryRow {
  ref: string;
  createdAt: number;
  status: OrderStatus;
  totalDzd: number;
  courierName: string | null;
}

export interface CustomerHistory {
  rows: HistoryRow[];
  /** More other orders exist than `rows` shows. */
  more: boolean;
}

/** The customer's other orders, newest first (index orders_customer_created_idx). */
export async function fetchCustomerHistory(db: Db, customerId: number, excludeOrderId: number): Promise<CustomerHistory> {
  const rows = await db
    .select({
      ref: orders.ref,
      createdAt: orders.createdAt,
      status: orders.status,
      totalDzd: orders.totalDzd,
      courierName: orders.courierName,
    })
    .from(orders)
    .where(and(eq(orders.customerId, customerId), ne(orders.id, excludeOrderId)))
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(HISTORY_LIMIT + 1);
  return { rows: rows.slice(0, HISTORY_LIMIT), more: rows.length > HISTORY_LIMIT };
}

/**
 * How much to worry about returns, from the phone's finished parcels.
 * - `frequent`: at least 2 returns and at least as many returns as deliveries (≥ 50 % returned).
 * - `some`: at least one return.
 * - `none`: no return yet.
 */
export type ReturnerLevel = 'frequent' | 'some' | 'none';

export const FREQUENT_RETURNS_MIN = 2;

export function returnerLevel(delivered: number, returned: number): ReturnerLevel {
  if (returned >= FREQUENT_RETURNS_MIN && returned >= delivered) return 'frequent';
  if (returned > 0) return 'some';
  return 'none';
}

/** Share of finished parcels that were delivered, 0–100 (rounded), or null with none finished. */
export function deliveryRate(delivered: number, returned: number): number | null {
  const done = delivered + returned;
  return done === 0 ? null : Math.round((delivered / done) * 100);
}
