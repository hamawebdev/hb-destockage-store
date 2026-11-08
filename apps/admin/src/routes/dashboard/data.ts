// Dashboard data: one function per tile. Each runs only for roles allowed to see it, and a tile
// whose source is missing (table not migrated yet, malformed JSON) returns `unavailable` rather
// than failing the page. Plan: artifacts/ADMIN-5/plan.md.
import { and, count, countDistinct, desc, eq, gte, inArray, isNotNull, isNull, lte, max, ne, or, sql } from 'drizzle-orm';
import * as v from 'valibot';
import { deliveryFees, notificationDeliveries, orders, publishRuns, settings, variants, type Db } from '@hb/db';
import type { OrderStatus } from '@hb/shared';
import { startOfAlgiersDay } from '../../lib/time.ts';

export type Tile<T> = { ok: true; value: T } | { ok: false };

/** Runs a tile query; any error (missing table/column, bad JSON) → unavailable, logged without data. */
export async function safeTile<T>(name: string, run: () => Promise<T>): Promise<Tile<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'dashboard tile unavailable', tile: name, error: (err as Error).name }));
    return { ok: false };
  }
}

export const OPEN_CALL_STATUSES = ['new', 'called', 'unreachable'] as const satisfies readonly OrderStatus[];
const DAY_MS = 24 * 60 * 60 * 1000;
export const BACKUP_STALE_HOURS = 26;
export const DEFAULT_LOW_STOCK = 3;

export async function readSetting(db: Db, key: string): Promise<unknown> {
  const row = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get();
  return row?.value;
}

export async function lowStockThreshold(db: Db): Promise<number> {
  const raw = await readSetting(db, 'lowStockThreshold');
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 1000 ? raw : DEFAULT_LOW_STOCK;
}

export async function ordersByStatus(db: Db, since: number): Promise<Map<string, number>> {
  const rows = await db
    .select({ status: orders.status, n: count() })
    .from(orders)
    .where(gte(orders.createdAt, since))
    .groupBy(orders.status)
    .all();
  return new Map(rows.map((r) => [r.status, r.n]));
}

export function dayWindows(now: number): { today: number; week: number } {
  return { today: startOfAlgiersDay(now), week: now - 7 * DAY_MS };
}

export async function toCallCount(db: Db, now: number): Promise<number> {
  const r = await db
    .select({ n: count() })
    .from(orders)
    .where(and(inArray(orders.status, [...OPEN_CALL_STATUSES]), or(isNull(orders.nextCallAt), lte(orders.nextCallAt, now))))
    .get();
  return r?.n ?? 0;
}

export async function flaggedOpenCount(db: Db): Promise<number> {
  const r = await db
    .select({ n: count() })
    .from(orders)
    .where(and(inArray(orders.status, [...OPEN_CALL_STATUSES]), ne(sql`${orders.flags}`, '[]')))
    .get();
  return r?.n ?? 0;
}

export async function toShipCount(db: Db): Promise<number> {
  const r = await db.select({ n: count() }).from(orders).where(eq(orders.status, 'confirmed')).get();
  return r?.n ?? 0;
}

export async function lowStockCount(db: Db, threshold: number): Promise<number> {
  const r = await db
    .select({ n: count() })
    .from(variants)
    .where(and(eq(variants.active, true), isNotNull(variants.stock), lte(variants.stock, threshold)))
    .get();
  return r?.n ?? 0;
}

export async function placeholderFeesCount(db: Db): Promise<number> {
  const r = await db.select({ n: count() }).from(deliveryFees).where(eq(deliveryFees.placeholder, true)).get();
  return r?.n ?? 0;
}

// ---------------------------------------------------------------------------------------------
// Backup status (JOBS-1): settings['jobs.backup_status']. Age computed HERE from lastSuccess.at,
// never taken from `health`, so the tile turns red even if the jobs Worker stops running.
// ---------------------------------------------------------------------------------------------

const When = v.object({ at: v.string() });
const BackupStatus = v.object({
  lastSuccess: v.nullable(v.looseObject({ ...When.entries })),
  lastFailure: v.nullable(v.looseObject({ ...When.entries, stage: v.string() })),
});

export type BackupView =
  | { state: 'never' }
  | { state: 'ok' | 'stale'; ageHours: number; failureStage: string | null }
  | { state: 'unavailable' };

export function backupView(raw: unknown, now: number): BackupView {
  const r = v.safeParse(BackupStatus, typeof raw === 'string' ? safeJson(raw) : raw);
  if (!r.success) return { state: raw === undefined || raw === null ? 'never' : 'unavailable' };
  const { lastSuccess, lastFailure } = r.output;
  const successAt = lastSuccess ? Date.parse(lastSuccess.at) : NaN;
  if (!lastSuccess || Number.isNaN(successAt)) return { state: 'never' };
  const ageHours = Math.max(0, Math.floor((now - successAt) / 3_600_000));
  const failureAt = lastFailure ? Date.parse(lastFailure.at) : NaN;
  const failureStage = lastFailure && !Number.isNaN(failureAt) && failureAt > successAt ? lastFailure.stage.slice(0, 40) : null;
  return { state: now - successAt > BACKUP_STALE_HOURS * 3_600_000 ? 'stale' : 'ok', ageHours, failureStage };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Notifications not sent (JOBS-6, DB-7): dead deliveries. last_error values are fixed, data-free
// labels (jobs' contract), so they are safe to show.
// ---------------------------------------------------------------------------------------------

export interface DeadSummary {
  orders: number;
  lastAt: number | null;
  invalidMessages: number;
  recent: { ref: string; channel: string; lastError: string | null; deadAt: number | null }[];
}

export async function deadNotifications(db: Db): Promise<DeadSummary> {
  const agg = await db
    .select({ n: countDistinct(notificationDeliveries.orderId), lastAt: max(notificationDeliveries.deadAt) })
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.status, 'dead'))
    .get();
  const recent = await db
    .select({ ref: orders.ref, channel: notificationDeliveries.channel, lastError: notificationDeliveries.lastError, deadAt: notificationDeliveries.deadAt })
    .from(notificationDeliveries)
    .innerJoin(orders, eq(orders.id, notificationDeliveries.orderId))
    .where(eq(notificationDeliveries.status, 'dead'))
    .orderBy(desc(notificationDeliveries.deadAt))
    .limit(50)
    .all();
  const invalid = await readSetting(db, 'jobs.notify_invalid');
  const invalidCount =
    invalid !== null && typeof invalid === 'object' && typeof (invalid as { count?: unknown }).count === 'number'
      ? (invalid as { count: number }).count
      : 0;
  return { orders: agg?.n ?? 0, lastAt: agg?.lastAt ?? null, invalidMessages: invalidCount, recent };
}

export async function lastPublish(db: Db): Promise<{ status: string; at: number } | null> {
  const r = await db
    .select({ status: publishRuns.status, at: publishRuns.requestedAt })
    .from(publishRuns)
    .orderBy(desc(publishRuns.requestedAt), desc(publishRuns.id))
    .limit(1)
    .get();
  return r ?? null;
}
