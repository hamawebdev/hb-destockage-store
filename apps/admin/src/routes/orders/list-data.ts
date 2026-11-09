// AORD-1 — orders list: the D1 reads. Per page: the page of orders (+1 row to detect a next page)
// and the 69 wilayas for the filter.

import { and, asc, count, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { communes, customers, orderItems, orders, wilayas, type Db } from '@hb/db';
import type { OrderStatus } from '@hb/shared';
import { cursorPage } from '../../lib/pagination.ts';
import { ORDERS_PAGE_SIZE, ordersOrderBy, ordersWhere, type OrdersFilter } from './list-query.ts';

/**
 * `orders.flags` as plain strings. DB-1 types it `OrderFlag[]`, but a flag added later by `web`
 * can be in the column before the admin knows it: it is shown as its raw code, never dropped.
 */
export function stringFlags(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((f): f is string => typeof f === 'string') : [];
}

export interface OrderListRow {
  id: number;
  ref: string;
  createdAt: number;
  name: string;
  phoneE164: string;
  wilayaCode: number;
  wilayaFr: string;
  wilayaAr: string;
  communeFr: string;
  communeAr: string;
  status: OrderStatus;
  version: number;
  courierName: string | null;
  courierTracking: string | null;
  feeDzd: number;
  totalDzd: number;
  /** Sensitive (`customers.sensitive`): absent — never selected — for logistics. */
  callAttempts?: number;
  flags?: string[];
  customerBlocked?: boolean;
  itemCount: number;
  firstItemFr: string | null;
  firstItemAr: string | null;
  firstItemQty: number | null;
}

export interface WilayaOption {
  code: number;
  nameFr: string;
  nameAr: string;
}

export interface OrdersPage {
  rows: OrderListRow[];
  /** Encoded cursor for the next page, or null. */
  next: string | null;
  wilayas: WilayaOption[];
}

// Correlated sub-selects on order_items (indexed by order_id); at most PAGE_SIZE + 1 rows.
const firstItem = (col: typeof orderItems.nameFr | typeof orderItems.nameAr | typeof orderItems.qty) =>
  sql`(select ${col} from ${orderItems} where ${orderItems.orderId} = ${orders.id} order by ${orderItems.id} limit 1)`;

/** Columns that need `customers.sensitive` (lib/projection.ts ORDER_SENSITIVE / CUSTOMER_SENSITIVE). */
const SENSITIVE_COLUMNS = {
  callAttempts: orders.callAttempts,
  flags: orders.flags,
  customerBlocked: customers.blocked,
};

/** The list query, exported so tests can EXPLAIN it against D1. `sensitive` = canSeeSensitive(user). */
export function ordersListQuery(db: Db, filter: OrdersFilter, sensitive: boolean, pageSize = ORDERS_PAGE_SIZE) {
  return db
    .select({
      ...(sensitive ? SENSITIVE_COLUMNS : {}),
      id: orders.id,
      ref: orders.ref,
      createdAt: orders.createdAt,
      name: orders.name,
      phoneE164: orders.phoneE164,
      wilayaCode: orders.wilayaCode,
      wilayaFr: wilayas.nameFr,
      wilayaAr: wilayas.nameAr,
      communeFr: communes.nameFr,
      communeAr: communes.nameAr,
      status: orders.status,
      version: orders.version,
      courierName: orders.courierName,
      courierTracking: orders.courierTracking,
      feeDzd: orders.feeDzd,
      totalDzd: orders.totalDzd,
      itemCount: sql<number>`(select count(*) from ${orderItems} where ${orderItems.orderId} = ${orders.id})`.mapWith(Number),
      firstItemFr: firstItem(orderItems.nameFr).mapWith(String),
      firstItemAr: firstItem(orderItems.nameAr).mapWith(String),
      firstItemQty: firstItem(orderItems.qty).mapWith(Number),
    })
    .from(orders)
    .innerJoin(wilayas, eq(wilayas.code, orders.wilayaCode))
    .innerJoin(communes, eq(communes.id, orders.communeId))
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .where(ordersWhere(filter))
    .orderBy(...ordersOrderBy)
    .limit(pageSize + 1);
}

export async function fetchOrdersPage(db: Db, filter: OrdersFilter, sensitive: boolean, pageSize = ORDERS_PAGE_SIZE): Promise<OrdersPage> {
  // Not db.batch(): drizzle-orm 0.45 reads batch results as objects, so the joined tables'
  // same-named columns (wilayas.name_fr / communes.name_fr) collide and every later column shifts.
  // Outside a batch it reads raw arrays. Two reads in parallel instead.
  const [rows, wilayaRows] = await Promise.all([
    ordersListQuery(db, filter, sensitive, pageSize),
    db.select({ code: wilayas.code, nameFr: wilayas.nameFr, nameAr: wilayas.nameAr }).from(wilayas).orderBy(asc(wilayas.code)),
  ]);
  const page = cursorPage(rows, pageSize, (r) => ({ at: r.createdAt, id: r.id }));
  return {
    rows: page.rows.map((r) => ({
      ...r,
      ...('flags' in r ? { flags: stringFlags(r.flags) } : {}),
      ...('customerBlocked' in r ? { customerBlocked: Boolean(r.customerBlocked) } : {}),
      // A sub-select with no row maps NULL through String/Number; normalise back to null.
      firstItemFr: r.itemCount > 0 ? r.firstItemFr : null,
      firstItemAr: r.itemCount > 0 ? r.firstItemAr : null,
      firstItemQty: r.itemCount > 0 ? r.firstItemQty : null,
    })),
    next: page.next,
    wilayas: wilayaRows,
  };
}

/** Orders per status across the whole table (the tab counts). */
export async function statusCounts(db: Db): Promise<Map<string, number>> {
  const rows = await db.select({ status: orders.status, n: count() }).from(orders).groupBy(orders.status);
  return new Map(rows.map((r) => [r.status, r.n]));
}

export interface OrdersToday {
  total: number;
  toCall: number;
  confirmed: number;
  cancelled: number;
  /** Confirmed ÷ (confirmed + cancelled) among today's handled orders, %; null before any is handled. */
  rate: number | null;
}

const PAST_CONFIRMATION: readonly OrderStatus[] = ['confirmed', 'shipped', 'delivered', 'returned'];

/** `todayStart`: start of the Algiers day. `toCall` is what is due now, whatever day it came in. */
export async function ordersToday(db: Db, todayStart: number, now: number): Promise<OrdersToday> {
  const [byStatus, due] = await Promise.all([
    db.select({ status: orders.status, n: count() }).from(orders).where(gte(orders.createdAt, todayStart)).groupBy(orders.status),
    db
      .select({ n: count() })
      .from(orders)
      .where(and(inArray(orders.status, ['new', 'called', 'unreachable']), or(isNull(orders.nextCallAt), lte(orders.nextCallAt, now))))
      .get(),
  ]);
  const of = (s: readonly string[]) => byStatus.filter((r) => s.includes(r.status)).reduce((a, r) => a + r.n, 0);
  const confirmed = of(PAST_CONFIRMATION);
  const cancelled = of(['cancelled']);
  const handled = confirmed + cancelled;
  return {
    total: byStatus.reduce((a, r) => a + r.n, 0),
    toCall: due?.n ?? 0,
    confirmed,
    cancelled,
    rate: handled === 0 ? null : Math.round((confirmed / handled) * 100),
  };
}
