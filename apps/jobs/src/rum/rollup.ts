// RUM rollup and purge (JOBS-5). Daily, for each Algiers-local day: p50/p75 of TTFB and LCP per
// (template, lang, colo, asn) from rum_events into rum_daily (DB-1), then delete raw rum_events
// older than 90 days. Touches rum_events and rum_daily only, never customer data.
//
// Day = Africa/Algiers calendar day (UTC+1 all year, no DST): [D 00:00+01:00, D+1 00:00+01:00).
// Percentile = nearest rank (value at ceil(p·n) in ascending order); n = max(TTFB, LCP samples).
// Unknown colo → '' and unknown ASN → 0 (rum_daily's NOT NULL key columns).
import { log } from '../log.ts';

export const RUM_RETENTION_DAYS = 90;
const ALGIERS_OFFSET_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** D1 allows 100 bound parameters per statement: 10 columns → 9 rows per INSERT. */
const ROWS_PER_INSERT = 9;

export function algiersDay(ms: number): string {
  return new Date(ms + ALGIERS_OFFSET_MS).toISOString().slice(0, 10);
}

export function dayBounds(day: string): [number, number] {
  const start = Date.parse(`${day}T00:00:00Z`) - ALGIERS_OFFSET_MS;
  return [start, start + DAY_MS];
}

/** Nearest-rank percentile of an ascending array; null when empty. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length))) - 1]!;
}

interface Group {
  template: string;
  lang: string;
  colo: string;
  asn: number;
  ttfb: number[];
  lcp: number[];
}

export interface RollupResult {
  day: string;
  samples: number;
  groups: number;
}

/** Recomputes one day from scratch (idempotent: the day's rows are replaced in one batch). */
export async function rollupDay(db: D1Database, day: string, pageSize = 5000): Promise<RollupResult> {
  const [from, to] = dayBounds(day);
  const groups = new Map<string, Group>();
  let samples = 0;
  let lastId = 0;
  for (;;) {
    const { results } = await db
      .prepare(
        `SELECT id, template, lang, colo, asn, metric, value FROM rum_events
          WHERE at >= ?1 AND at < ?2 AND metric IN ('TTFB', 'LCP') AND id > ?3
          ORDER BY id LIMIT ?4`,
      )
      .bind(from, to, lastId, pageSize)
      .all<{ id: number; template: string; lang: string; colo: string | null; asn: number | null; metric: 'TTFB' | 'LCP'; value: number }>();
    for (const r of results) {
      const colo = r.colo ?? '';
      const asn = r.asn ?? 0;
      const key = JSON.stringify([r.template, r.lang, colo, asn]);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { template: r.template, lang: r.lang, colo, asn, ttfb: [], lcp: [] }));
      (r.metric === 'TTFB' ? g.ttfb : g.lcp).push(r.value);
      samples++;
    }
    if (results.length < pageSize) break;
    lastId = results[results.length - 1]!.id;
  }

  const rows = [...groups.values()].map((g) => {
    g.ttfb.sort((a, b) => a - b);
    g.lcp.sort((a, b) => a - b);
    return [day, g.template, g.lang, g.colo, g.asn, Math.max(g.ttfb.length, g.lcp.length),
      percentile(g.ttfb, 0.5), percentile(g.ttfb, 0.75), percentile(g.lcp, 0.5), percentile(g.lcp, 0.75)];
  });
  const stmts: D1PreparedStatement[] = [db.prepare('DELETE FROM rum_daily WHERE day = ?1').bind(day)];
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + ROWS_PER_INSERT);
    stmts.push(
      db
        .prepare(
          `INSERT INTO rum_daily (day, template, lang, colo, asn, n, ttfb_p50, ttfb_p75, lcp_p50, lcp_p75) VALUES ${chunk
            .map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .join(', ')}`,
        )
        .bind(...chunk.flat()),
    );
  }
  await db.batch(stmts); // one transaction: the day is never half-replaced
  return { day, samples, groups: rows.length };
}

/** Deletes rum_events older than `days` (RUM only), in bounded chunks. Returns the count. */
export async function purgeRumEvents(db: D1Database, now: number, days = RUM_RETENTION_DAYS, chunk = 5000): Promise<number> {
  const cutoff = now - days * DAY_MS;
  let deleted = 0;
  for (;;) {
    const r = await db
      .prepare('DELETE FROM rum_events WHERE id IN (SELECT id FROM rum_events WHERE at < ?1 ORDER BY id LIMIT ?2)')
      .bind(cutoff, chunk)
      .run();
    const n = r.meta.changes ?? 0;
    deleted += n;
    if (n < chunk) return deleted;
  }
}

/**
 * Daily job: roll up yesterday and the day before (late beacons are folded in by the re-run), then
 * purge. Logs counts only.
 */
export async function rumJob(db: D1Database, now: number, opts: { days?: number } = {}): Promise<{ rollups: RollupResult[]; purged: number }> {
  const today = algiersDay(now);
  const rollups: RollupResult[] = [];
  for (let back = opts.days ?? 2; back >= 1; back--) {
    const day = algiersDay(Date.parse(`${today}T12:00:00Z`) - back * DAY_MS);
    const r = await rollupDay(db, day);
    rollups.push(r);
    log('rum.rollup', { day: r.day, samples: r.samples, groups: r.groups });
  }
  const purged = await purgeRumEvents(db, now);
  log('rum.purge', { deleted: purged, olderThanDays: RUM_RETENTION_DAYS });
  return { rollups, purged };
}
