// AORD-5 — shipping hand-off: the D1 reads. Delivery fields only (plan artifacts/AORD-5/plan.md §2):
// no customers columns, no order_events, no flags/risk. Not db.batch() for joined selects (see
// list-data.ts: drizzle 0.45 maps batch rows by name).

import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { communes, orderItems, orders, wilayas, type Db } from '@hb/db';
import type { OrderStatus } from '@hb/shared';

export const SHIPPING_PAGE_SIZE = 50;
export const MAX_BATCH = 50;

/** Statuses a slip may be printed for (plan §1). */
export const PRINTABLE: readonly OrderStatus[] = ['confirmed', 'shipped'];

export interface ShippingRow {
  id: number;
  ref: string;
  version: number;
  createdAt: number;
  name: string;
  phoneE164: string;
  address: string | null;
  wilayaCode: number;
  wilayaFr: string;
  wilayaAr: string;
  communeFr: string;
  communeAr: string;
  totalDzd: number;
  itemCount: number;
  courierName: string | null;
  courierTracking: string | null;
}

const rowColumns = {
  id: orders.id,
  ref: orders.ref,
  version: orders.version,
  createdAt: orders.createdAt,
  name: orders.name,
  phoneE164: orders.phoneE164,
  address: orders.address,
  wilayaCode: orders.wilayaCode,
  wilayaFr: wilayas.nameFr,
  wilayaAr: wilayas.nameAr,
  communeFr: communes.nameFr,
  communeAr: communes.nameAr,
  totalDzd: orders.totalDzd,
  itemCount: sql<number>`(select count(*) from ${orderItems} where ${orderItems.orderId} = ${orders.id})`.mapWith(Number),
  courierName: orders.courierName,
  courierTracking: orders.courierTracking,
};

/** Oldest first: the order that has waited longest ships first. */
export function shippingQuery(db: Db, status: 'confirmed' | 'shipped') {
  return db
    .select(rowColumns)
    .from(orders)
    .innerJoin(wilayas, eq(wilayas.code, orders.wilayaCode))
    .innerJoin(communes, eq(communes.id, orders.communeId))
    .where(eq(orders.status, status))
    .orderBy(asc(orders.createdAt), asc(orders.id))
    .limit(SHIPPING_PAGE_SIZE);
}

export async function shippingCounts(db: Db): Promise<{ confirmed: number; shipped: number }> {
  const rows = await db
    .select({ status: orders.status, n: count() })
    .from(orders)
    .where(inArray(orders.status, ['confirmed', 'shipped']))
    .groupBy(orders.status);
  const get = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  return { confirmed: get('confirmed'), shipped: get('shipped') };
}

export interface SlipItem {
  nameFr: string;
  nameAr: string;
  variantLabelFr: string | null;
  variantLabelAr: string | null;
  sku: string;
  qty: number;
}

export interface Slip {
  id: number;
  ref: string;
  status: OrderStatus;
  createdAt: number;
  name: string;
  phoneE164: string;
  address: string | null;
  wilayaCode: number;
  wilayaFr: string;
  wilayaAr: string;
  /** `wilayas.courier_code`, filled by the future courier integration (D-001); null today. */
  courierWilayaCode: string | null;
  communeFr: string;
  communeAr: string;
  feeDzd: number;
  totalDzd: number;
  courierName: string | null;
  courierTracking: string | null;
  items: SlipItem[];
}

/**
 * Slips for up to MAX_BATCH refs, printable statuses only. Returns the slips (in the order the refs
 * were given) and the refs that were refused (unknown or not confirmed/shipped).
 */
export async function fetchSlips(db: Db, refs: readonly string[]): Promise<{ slips: Slip[]; refused: string[] }> {
  if (refs.length === 0) return { slips: [], refused: [] };
  const rows = await db
    .select({
      id: orders.id,
      ref: orders.ref,
      status: orders.status,
      createdAt: orders.createdAt,
      name: orders.name,
      phoneE164: orders.phoneE164,
      address: orders.address,
      wilayaCode: orders.wilayaCode,
      wilayaFr: wilayas.nameFr,
      wilayaAr: wilayas.nameAr,
      courierWilayaCode: wilayas.courierCode,
      communeFr: communes.nameFr,
      communeAr: communes.nameAr,
      feeDzd: orders.feeDzd,
      totalDzd: orders.totalDzd,
      courierName: orders.courierName,
      courierTracking: orders.courierTracking,
    })
    .from(orders)
    .innerJoin(wilayas, eq(wilayas.code, orders.wilayaCode))
    .innerJoin(communes, eq(communes.id, orders.communeId))
    .where(and(inArray(orders.ref, [...refs]), inArray(orders.status, [...PRINTABLE])));
  const items = rows.length
    ? await db
        .select({
          orderId: orderItems.orderId,
          nameFr: orderItems.nameFr,
          nameAr: orderItems.nameAr,
          variantLabelFr: orderItems.variantLabelFr,
          variantLabelAr: orderItems.variantLabelAr,
          sku: orderItems.sku,
          qty: orderItems.qty,
        })
        .from(orderItems)
        .where(inArray(orderItems.orderId, rows.map((r) => r.id)))
        .orderBy(asc(orderItems.id))
    : [];
  const byRef = new Map(rows.map((r) => [r.ref, { ...r, items: items.filter((i) => i.orderId === r.id).map(({ orderId: _o, ...i }) => i) }]));
  return {
    slips: refs.flatMap((ref) => (byRef.has(ref) ? [byRef.get(ref)!] : [])),
    refused: refs.filter((ref) => !byRef.has(ref)),
  };
}
