// AORD-2 — order detail: the D1 reads. Two round trips: the order (with place names, customer and
// claim holder), then items, timeline and (owner) audit rows in parallel. Not db.batch(): see
// list-data.ts (drizzle 0.45 maps batch rows by column name).

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { adminUsers, auditLog, communes, customers, orderEvents, orderItems, orders, wilayas, type Db } from '@hb/db';
import type { OrderStatus } from '@hb/shared';
import { stringFlags } from './list-data.ts';

/**
 * Fields that need `customers.sensitive` (owner, confirmer): anti-fraud flags, call-workflow
 * internals and the customer's history and blocked state (lib/projection.ts). `null` for logistics:
 * not selected at all, so no template can leak them.
 */
export interface OrderRisk {
  callAttempts: number;
  nextCallAt: number | null;
  flags: string[];
  claimedByUserId: number | null;
  claimedByName: string | null;
  claimedUntil: number | null;
  customerBlocked: boolean;
  orderCount: number;
  deliveredCount: number;
  returnedCount: number;
  cancelledCount: number;
}

export interface OrderDetail {
  id: number;
  ref: string;
  createdAt: number;
  updatedAt: number;
  status: OrderStatus;
  version: number;
  name: string;
  phoneE164: string;
  address: string | null;
  lang: 'ar' | 'fr';
  wilayaCode: number;
  wilayaFr: string;
  wilayaAr: string;
  communeId: number;
  communeFr: string;
  communeAr: string;
  subtotalDzd: number;
  feeDzd: number;
  totalDzd: number;
  feeSource: string;
  courierName: string | null;
  courierTracking: string | null;
  stockRestoredAt: number | null;
  customer: { id: number; name: string };
  risk: OrderRisk | null;
}

export interface OrderItemRow {
  id: number;
  nameFr: string;
  nameAr: string;
  variantLabelFr: string | null;
  variantLabelAr: string | null;
  sku: string;
  unitPriceDzd: number;
  qty: number;
  lineTotalDzd: number;
}

export interface OrderEventRow {
  id: number;
  type: string;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus | null;
  outcome: string | null;
  note: string | null;
  actorType: string;
  actorName: string | null;
  at: number;
}

export interface OrderAuditRow {
  id: number;
  action: string;
  actorEmail: string | null;
  before: unknown;
  after: unknown;
  at: number;
}

/** Audit actions shown on the detail page: the ones with no order_events row of their own. */
export const DETAIL_AUDIT_ACTIONS = ['order.contact', 'order.claim', 'order.release'] as const;

const claimer = alias(adminUsers, 'claimer');

/** Selected only with `customers.sensitive` (see OrderRisk). */
const RISK_COLUMNS = {
  callAttempts: orders.callAttempts,
  nextCallAt: orders.nextCallAt,
  flags: orders.flags,
  claimedByUserId: orders.claimedByUserId,
  claimedByName: claimer.name,
  claimedUntil: orders.claimedUntil,
  customerBlocked: customers.blocked,
  orderCount: customers.orderCount,
  deliveredCount: customers.deliveredCount,
  returnedCount: customers.returnedCount,
  cancelledCount: customers.cancelledCount,
};

/** `sensitive` = canSeeSensitive(user) (lib/projection.ts). */
export async function fetchOrderByRef(db: Db, ref: string, sensitive: boolean): Promise<OrderDetail | null> {
  const base = {
    id: orders.id,
    ref: orders.ref,
    createdAt: orders.createdAt,
    updatedAt: orders.updatedAt,
    status: orders.status,
    version: orders.version,
    name: orders.name,
    phoneE164: orders.phoneE164,
    address: orders.address,
    lang: orders.lang,
    wilayaCode: orders.wilayaCode,
    wilayaFr: wilayas.nameFr,
    wilayaAr: wilayas.nameAr,
    communeId: orders.communeId,
    communeFr: communes.nameFr,
    communeAr: communes.nameAr,
    subtotalDzd: orders.subtotalDzd,
    feeDzd: orders.feeDzd,
    totalDzd: orders.totalDzd,
    feeSource: orders.feeSource,
    courierName: orders.courierName,
    courierTracking: orders.courierTracking,
    stockRestoredAt: orders.stockRestoredAt,
    customerId: customers.id,
    customerName: customers.name,
  };
  const q = (cols: Record<string, unknown>) =>
    db
      .select(cols as typeof base & typeof RISK_COLUMNS)
      .from(orders)
      .innerJoin(wilayas, eq(wilayas.code, orders.wilayaCode))
      .innerJoin(communes, eq(communes.id, orders.communeId))
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .leftJoin(claimer, eq(claimer.id, orders.claimedByUserId))
      .where(eq(orders.ref, ref))
      .limit(1);
  const [row] = await q(sensitive ? { ...base, ...RISK_COLUMNS } : base);
  if (!row) return null;
  const { customerId, customerName } = row;
  const o: OrderDetail = {
    id: row.id,
    ref: row.ref,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: row.status,
    version: row.version,
    name: row.name,
    phoneE164: row.phoneE164,
    address: row.address,
    lang: row.lang,
    wilayaCode: row.wilayaCode,
    wilayaFr: row.wilayaFr,
    wilayaAr: row.wilayaAr,
    communeId: row.communeId,
    communeFr: row.communeFr,
    communeAr: row.communeAr,
    subtotalDzd: row.subtotalDzd,
    feeDzd: row.feeDzd,
    totalDzd: row.totalDzd,
    feeSource: row.feeSource,
    courierName: row.courierName,
    courierTracking: row.courierTracking,
    stockRestoredAt: row.stockRestoredAt,
    customer: { id: customerId, name: customerName },
    risk: sensitive
      ? {
          callAttempts: row.callAttempts,
          nextCallAt: row.nextCallAt,
          flags: stringFlags(row.flags),
          claimedByUserId: row.claimedByUserId,
          claimedByName: row.claimedByName,
          claimedUntil: row.claimedUntil,
          customerBlocked: Boolean(row.customerBlocked),
          orderCount: row.orderCount,
          deliveredCount: row.deliveredCount,
          returnedCount: row.returnedCount,
          cancelledCount: row.cancelledCount,
        }
      : null,
  };
  return o;
}

export async function fetchOrderChildren(
  db: Db,
  orderId: number,
  /** `sensitive` = canSeeSensitive(user). Without it the timeline is status changes only: no call
   * attempts, no notes, no outcomes (admin-core rule: order_events are sensitive). */
  opts: { withAudit: boolean; sensitive: boolean },
): Promise<{ items: OrderItemRow[]; events: OrderEventRow[]; audit: OrderAuditRow[] }> {
  const itemsQ = db
    .select({
      id: orderItems.id,
      nameFr: orderItems.nameFr,
      nameAr: orderItems.nameAr,
      variantLabelFr: orderItems.variantLabelFr,
      variantLabelAr: orderItems.variantLabelAr,
      sku: orderItems.sku,
      unitPriceDzd: orderItems.unitPriceDzd,
      qty: orderItems.qty,
      lineTotalDzd: orderItems.lineTotalDzd,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.id));
  const eventsQ = db
    .select({
      id: orderEvents.id,
      type: orderEvents.type,
      fromStatus: orderEvents.fromStatus,
      toStatus: orderEvents.toStatus,
      outcome: opts.sensitive ? orderEvents.outcome : sql<string | null>`null`,
      note: opts.sensitive ? orderEvents.note : sql<string | null>`null`,
      actorType: orderEvents.actorType,
      actorName: adminUsers.name,
      at: orderEvents.at,
    })
    .from(orderEvents)
    .leftJoin(adminUsers, eq(adminUsers.id, orderEvents.actorUserId))
    .where(
      opts.sensitive
        ? eq(orderEvents.orderId, orderId)
        : and(eq(orderEvents.orderId, orderId), inArray(orderEvents.type, ['created', 'status_change'])),
    )
    .orderBy(asc(orderEvents.at), asc(orderEvents.id));
  const auditQ = opts.withAudit
    ? db
        .select({
          id: auditLog.id,
          action: auditLog.action,
          actorEmail: auditLog.actorEmail,
          before: auditLog.before,
          after: auditLog.after,
          at: auditLog.at,
        })
        .from(auditLog)
        .where(and(eq(auditLog.entity, 'orders'), eq(auditLog.entityId, String(orderId)), inArray(auditLog.action, [...DETAIL_AUDIT_ACTIONS])))
        .orderBy(asc(auditLog.at), asc(auditLog.id))
    : null;
  const [items, events, audit] = await Promise.all([itemsQ, eventsQ, auditQ ?? Promise.resolve([] as OrderAuditRow[])]);
  return { items, events, audit };
}

/** Groups events written in the same batch (same `at`) into one timeline entry. */
export function groupTimeline(events: readonly OrderEventRow[]): OrderEventRow[][] {
  const groups: OrderEventRow[][] = [];
  for (const e of events) {
    const last = groups[groups.length - 1];
    if (last && last[0]!.at === e.at && last[0]!.actorName === e.actorName) last.push(e);
    else groups.push([e]);
  }
  return groups;
}
