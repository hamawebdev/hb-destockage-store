// AORD-2 — order detail: the D1 reads. Two round trips: the order (with place names, customer and
// claim holder), then items, timeline and (owner) audit rows in parallel. Not db.batch(): see
// list-data.ts (drizzle 0.45 maps batch rows by column name).

import { and, asc, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { adminUsers, auditLog, communes, customers, orderEvents, orderItems, orders, wilayas, type Db } from '@hb/db';
import type { OrderStatus } from '@hb/shared';
import { stringFlags } from './list-data.ts';

export interface OrderDetail {
  id: number;
  ref: string;
  createdAt: number;
  updatedAt: number;
  status: OrderStatus;
  version: number;
  callAttempts: number;
  nextCallAt: number | null;
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
  flags: string[];
  courierName: string | null;
  courierTracking: string | null;
  claimedByUserId: number | null;
  claimedByName: string | null;
  claimedUntil: number | null;
  stockRestoredAt: number | null;
  customer: {
    id: number;
    name: string;
    blocked: boolean;
    orderCount: number;
    deliveredCount: number;
    returnedCount: number;
    cancelledCount: number;
  };
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

export async function fetchOrderByRef(db: Db, ref: string): Promise<OrderDetail | null> {
  const [row] = await db
    .select({
      id: orders.id,
      ref: orders.ref,
      createdAt: orders.createdAt,
      updatedAt: orders.updatedAt,
      status: orders.status,
      version: orders.version,
      callAttempts: orders.callAttempts,
      nextCallAt: orders.nextCallAt,
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
      flags: orders.flags,
      courierName: orders.courierName,
      courierTracking: orders.courierTracking,
      claimedByUserId: orders.claimedByUserId,
      claimedByName: claimer.name,
      claimedUntil: orders.claimedUntil,
      stockRestoredAt: orders.stockRestoredAt,
      customerId: customers.id,
      customerName: customers.name,
      customerBlocked: customers.blocked,
      orderCount: customers.orderCount,
      deliveredCount: customers.deliveredCount,
      returnedCount: customers.returnedCount,
      cancelledCount: customers.cancelledCount,
    })
    .from(orders)
    .innerJoin(wilayas, eq(wilayas.code, orders.wilayaCode))
    .innerJoin(communes, eq(communes.id, orders.communeId))
    .innerJoin(customers, eq(customers.id, orders.customerId))
    .leftJoin(claimer, eq(claimer.id, orders.claimedByUserId))
    .where(eq(orders.ref, ref))
    .limit(1);
  if (!row) return null;
  const { customerId, customerName, customerBlocked, orderCount, deliveredCount, returnedCount, cancelledCount, ...o } = row;
  return {
    ...o,
    flags: stringFlags(o.flags),
    customer: {
      id: customerId,
      name: customerName,
      blocked: Boolean(customerBlocked),
      orderCount,
      deliveredCount,
      returnedCount,
      cancelledCount,
    },
  };
}

export async function fetchOrderChildren(
  db: Db,
  orderId: number,
  opts: { withAudit: boolean },
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
      outcome: orderEvents.outcome,
      note: orderEvents.note,
      actorType: orderEvents.actorType,
      actorName: adminUsers.name,
      at: orderEvents.at,
    })
    .from(orderEvents)
    .leftJoin(adminUsers, eq(adminUsers.id, orderEvents.actorUserId))
    .where(eq(orderEvents.orderId, orderId))
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
