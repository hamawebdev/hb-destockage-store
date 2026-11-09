// UX-8 / UX-10 — parcel follow-up reads: delayed parcels (no courier update for too long) and the
// delivery success rate by courier and by wilaya. Read-only; delivery fields only (no customers
// columns, no flags), so every role with orders.view may see them.

import { and, asc, count, eq, gte, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { orders, shipments, wilayas, type Db } from '@hb/db';
import { getCourier } from '@hb/couriers';
import { readSetting } from '../dashboard/data.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// Delayed parcels
// ---------------------------------------------------------------------------------------------

/** settings key; owner edits it in /settings. */
export const DELAY_SETTING = 'delayedParcelDays';
export const DEFAULT_DELAY_DAYS = 3;
export const DELAY_MIN = 1;
export const DELAY_MAX = 30;
/** Choices offered on the page; the store's own setting is always added. */
export const DELAY_CHOICES = [2, 3, 5, 7] as const;
export const DELAYED_PAGE_SIZE = 100;

export function isDelayDays(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= DELAY_MIN && n <= DELAY_MAX;
}

export async function delayDaysSetting(db: Db): Promise<number> {
  const raw = await readSetting(db, DELAY_SETTING);
  return isDelayDays(raw) ? raw : DEFAULT_DELAY_DAYS;
}

/** A parcel the courier accepted, not finished (delivered or back with us). */
const followed = and(
  inArray(shipments.state, ['draft', 'accepted']),
  or(isNull(shipments.courierStatus), notInArray(shipments.courierStatus, ['delivered', 'returned'])),
)!;

/** Last time we heard from the courier about this parcel; else when it was handed over. */
export const lastUpdateSql = sql<number>`coalesce(${shipments.courierStatusAt}, ${shipments.acceptedAt}, ${shipments.createdAt})`.mapWith(Number);

export interface DelayedRow {
  shipmentId: number;
  courier: string;
  tracking: string | null;
  courierStatus: string | null;
  courierStatusRaw: string | null;
  lastUpdateAt: number;
  deliveryType: 'home' | 'stop_desk';
  wilayaCode: number;
  wilayaFr: string;
  wilayaAr: string;
  ref: string;
  name: string;
  phoneE164: string;
  orderStatus: string;
}

function delayedWhere(now: number, days: number, courier: string | null): SQL {
  const cutoff = now - days * DAY_MS;
  const parts: SQL[] = [followed, sql`${lastUpdateSql} < ${cutoff}`];
  if (courier !== null) parts.push(eq(shipments.courier, courier));
  return and(...parts)!;
}

/** Longest silence first. */
export async function delayedParcels(db: Db, now: number, days: number, courier: string | null): Promise<{ rows: DelayedRow[]; total: number }> {
  const where = delayedWhere(now, days, courier);
  const [rows, totals] = await Promise.all([
    db
      .select({
        shipmentId: shipments.id,
        courier: shipments.courier,
        tracking: shipments.tracking,
        courierStatus: shipments.courierStatus,
        courierStatusRaw: shipments.courierStatusRaw,
        lastUpdateAt: lastUpdateSql,
        deliveryType: shipments.deliveryType,
        wilayaCode: shipments.wilayaCode,
        wilayaFr: wilayas.nameFr,
        wilayaAr: wilayas.nameAr,
        ref: orders.ref,
        name: orders.name,
        phoneE164: orders.phoneE164,
        orderStatus: orders.status,
      })
      .from(shipments)
      .innerJoin(orders, eq(orders.id, shipments.orderId))
      .innerJoin(wilayas, eq(wilayas.code, shipments.wilayaCode))
      .where(where)
      .orderBy(asc(lastUpdateSql), asc(shipments.id))
      .limit(DELAYED_PAGE_SIZE),
    db.select({ n: count() }).from(shipments).where(where),
  ]);
  return { rows, total: totals[0]?.n ?? 0 };
}

export async function delayedCount(db: Db, now: number, days: number): Promise<number> {
  const r = await db.select({ n: count() }).from(shipments).where(delayedWhere(now, days, null)).get();
  return r?.n ?? 0;
}

/** Couriers with followed parcels, for the filter. */
export async function followedCouriers(db: Db): Promise<string[]> {
  const rows = await db.selectDistinct({ courier: shipments.courier }).from(shipments).where(followed).orderBy(asc(shipments.courier));
  return rows.map((r) => r.courier);
}

export function courierName(id: string): string {
  return getCourier(id)?.displayName ?? id;
}

// ---------------------------------------------------------------------------------------------
// Delivery success rate (UX-10)
// ---------------------------------------------------------------------------------------------

export const PERIODS = [30, 90, 365] as const;
export type Period = (typeof PERIODS)[number];
export const DEFAULT_PERIOD: Period = 90;

/**
 * Counted from orders, so parcels sent before the courier integration (courier typed by hand)
 * count too. Outcome = the order's status: only `delivered` and `returned` are final, which status
 * sync is the only one to set for a tracked parcel. Courier = the live shipment's courier when
 * there is one, else the name typed when it was shipped.
 */
const liveCourierSql = sql<string | null>`(select s.courier from ${shipments} s where s.order_id = ${orders.id} and s.state in ('draft', 'accepted') order by s.id desc limit 1)`;
const courierKeySql = sql<string>`coalesce(${liveCourierSql}, 'name:' || nullif(lower(trim(${orders.courierName})), ''), '')`;

export interface RateRow {
  /** Courier key (a courier id, `name:<typed name>`, or '' when none was recorded) or wilaya code. */
  key: string;
  wilayaFr?: string;
  wilayaAr?: string;
  delivered: number;
  returned: number;
  inTransit: number;
}

const outcomeCols = {
  delivered: sql<number>`sum(case when ${orders.status} = 'delivered' then 1 else 0 end)`.mapWith(Number),
  returned: sql<number>`sum(case when ${orders.status} = 'returned' then 1 else 0 end)`.mapWith(Number),
  inTransit: sql<number>`sum(case when ${orders.status} = 'shipped' then 1 else 0 end)`.mapWith(Number),
};

const shippedSince = (since: number) => and(inArray(orders.status, ['shipped', 'delivered', 'returned']), gte(orders.createdAt, since));

export async function ratesByCourier(db: Db, since: number): Promise<RateRow[]> {
  const rows = await db
    .select({ key: courierKeySql, ...outcomeCols })
    .from(orders)
    .where(shippedSince(since))
    .groupBy(courierKeySql);
  return rows.map((r) => ({ ...r, key: String(r.key ?? '') }));
}

export async function ratesByWilaya(db: Db, since: number, courierKey: string | null): Promise<RateRow[]> {
  const where = courierKey === null ? shippedSince(since) : and(shippedSince(since), sql`${courierKeySql} = ${courierKey}`);
  const rows = await db
    .select({ key: orders.wilayaCode, wilayaFr: wilayas.nameFr, wilayaAr: wilayas.nameAr, ...outcomeCols })
    .from(orders)
    .innerJoin(wilayas, eq(wilayas.code, orders.wilayaCode))
    .where(where)
    .groupBy(orders.wilayaCode, wilayas.nameFr, wilayas.nameAr);
  return rows.map((r) => ({ ...r, key: String(r.key) }));
}

/** Delivered share of finished parcels, 0–100 rounded; null when none finished. */
export function successRate(r: Pick<RateRow, 'delivered' | 'returned'>): number | null {
  const done = r.delivered + r.returned;
  return done === 0 ? null : Math.round((r.delivered / done) * 100);
}

/** Below this many finished parcels a rate is shown but marked as too few to judge. */
export const MIN_SAMPLE = 10;

export function totals(rows: readonly RateRow[]): Pick<RateRow, 'delivered' | 'returned' | 'inTransit'> {
  return rows.reduce((a, r) => ({ delivered: a.delivered + r.delivered, returned: a.returned + r.returned, inTransit: a.inTransit + r.inTransit }), { delivered: 0, returned: 0, inTransit: 0 });
}
