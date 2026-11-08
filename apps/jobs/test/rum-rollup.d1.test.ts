import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { algiersDay, dayBounds, percentile, purgeRumEvents, rollupDay, rumJob } from '../src/rum/rollup.ts';
import { localPlatform, type LocalPlatform } from './helpers/platform.ts';
import { applyMigrations, insertOrders } from './helpers/schema.ts';

let p: LocalPlatform<{ DB: D1Database }>;
const DAY = 86_400_000;
const D = '2026-11-04';
const [START] = dayBounds(D); // 2026-11-03T23:00:00Z

type Ev = { at: number; template?: string; lang?: string; metric: string; value: number; colo?: string | null; asn?: number | null };
async function insert(evs: Ev[]): Promise<void> {
  const db = p.env.DB;
  for (let i = 0; i < evs.length; i += 50) {
    await db.batch(
      evs.slice(i, i + 50).map((e) =>
        db
          .prepare(`INSERT INTO rum_events (at, template, path, lang, metric, value, colo, asn) VALUES (?, ?, '/x', ?, ?, ?, ?, ?)`)
          .bind(e.at, e.template ?? 'product', e.lang ?? 'ar', e.metric, e.value, e.colo === undefined ? 'ALG' : e.colo, e.asn === undefined ? 36947 : e.asn),
      ),
    );
  }
}
const daily = (day = D) => p.env.DB.prepare(`SELECT * FROM rum_daily WHERE day = ? ORDER BY template, lang, colo, asn`).bind(day).all().then((r) => r.results);

beforeAll(async () => {
  p = await localPlatform();
  await applyMigrations(p.env.DB);
  await insertOrders(p.env.DB, [1]);
}, 60_000);
afterAll(async () => p?.dispose());
beforeEach(async () => {
  await p.env.DB.batch([p.env.DB.prepare('DELETE FROM rum_events'), p.env.DB.prepare('DELETE FROM rum_daily')]);
});

describe('helpers', () => {
  test('Algiers day (UTC+1, no DST) and its bounds', () => {
    expect(algiersDay(Date.UTC(2026, 10, 3, 22, 59, 59))).toBe('2026-11-03');
    expect(algiersDay(Date.UTC(2026, 10, 3, 23, 0, 0))).toBe('2026-11-04');
    expect(algiersDay(Date.UTC(2026, 6, 1, 23, 30))).toBe('2026-07-02'); // summer: still UTC+1
    expect(dayBounds(D)).toEqual([Date.UTC(2026, 10, 3, 23), Date.UTC(2026, 10, 4, 23)]);
  });
  test('nearest-rank percentile', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.75)).toBe(7);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.75)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 0.75)).toBe(75);
  });
});

describe('rollupDay', { timeout: 60_000 }, () => {
  test('p50/p75 per (template, lang, colo, asn); other metrics and other days ignored; n = max(TTFB, LCP)', async () => {
    await insert([
      ...[100, 200, 300, 400].map((v) => ({ at: START + 1000, metric: 'TTFB', value: v })),
      ...[1000, 1500, 2000].map((v) => ({ at: START + 2000, metric: 'LCP', value: v })),
      { at: START + 3000, metric: 'INP', value: 999 },
      { at: START + 4000, metric: 'TTFB', value: 50, lang: 'fr', colo: null, asn: null },
      { at: START - 1, metric: 'TTFB', value: 1 }, // 2026-11-03 in Algiers
      { at: START + DAY, metric: 'TTFB', value: 1 }, // 2026-11-05
    ]);
    const r = await rollupDay(p.env.DB, D);
    expect(r).toEqual({ day: D, samples: 8, groups: 2 });
    expect(await daily()).toEqual([
      { day: D, template: 'product', lang: 'ar', colo: 'ALG', asn: 36947, n: 4, ttfb_p50: 200, ttfb_p75: 300, lcp_p50: 1500, lcp_p75: 2000 },
      { day: D, template: 'product', lang: 'fr', colo: '', asn: 0, n: 1, ttfb_p50: 50, ttfb_p75: 50, lcp_p50: null, lcp_p75: null },
    ]);
  });

  test('idempotent; a re-run folds in late beacons; pagination; > 9 groups (chunked inserts)', async () => {
    const evs: Ev[] = [];
    for (let g = 0; g < 25; g++) for (let i = 0; i < 4; i++) evs.push({ at: START + g * 1000 + i, metric: 'LCP', value: 1000 + i, asn: 1000 + g });
    await insert(evs);
    expect(await rollupDay(p.env.DB, D, 7)).toMatchObject({ samples: 100, groups: 25 });
    expect(await rollupDay(p.env.DB, D, 7)).toMatchObject({ samples: 100, groups: 25 });
    expect(await daily()).toHaveLength(25);
    await insert([{ at: START + 99_000, metric: 'LCP', value: 9000, asn: 1000 }]);
    await rollupDay(p.env.DB, D);
    const g0 = (await daily()).find((r) => r['asn'] === 1000)!;
    expect(g0).toMatchObject({ n: 5, lcp_p50: 1002, lcp_p75: 1003 });
  });
});

describe('purgeRumEvents', { timeout: 60_000 }, () => {
  test('deletes only rum_events older than 90 days, in chunks; customer data untouched', async () => {
    const now = Date.UTC(2026, 10, 5, 2, 30);
    await insert([
      ...Array.from({ length: 12 }, (_, i) => ({ at: now - 91 * DAY - i, metric: 'LCP', value: 1 })),
      { at: now - 90 * DAY + 1, metric: 'LCP', value: 2 },
      { at: now - DAY, metric: 'LCP', value: 3 },
    ]);
    const before = await p.env.DB.prepare(`SELECT (SELECT count(*) FROM orders) o, (SELECT count(*) FROM customers) c, (SELECT count(*) FROM rum_daily) d`).first();
    expect(await purgeRumEvents(p.env.DB, now, 90, 5)).toBe(12);
    expect((await p.env.DB.prepare('SELECT value FROM rum_events ORDER BY value').all()).results).toEqual([{ value: 2 }, { value: 3 }]);
    expect(await p.env.DB.prepare(`SELECT (SELECT count(*) FROM orders) o, (SELECT count(*) FROM customers) c, (SELECT count(*) FROM rum_daily) d`).first()).toEqual(before);
  });
});

describe('rumJob', { timeout: 60_000 }, () => {
  test('rolls up yesterday and the day before (Algiers), then purges', async () => {
    const now = Date.UTC(2026, 10, 5, 2, 30); // 03:30 Algiers on 2026-11-05
    await insert([
      { at: START + 10, metric: 'TTFB', value: 100 }, // 2026-11-04
      { at: START - 10, metric: 'TTFB', value: 200 }, // 2026-11-03
      { at: now - 100 * DAY, metric: 'TTFB', value: 1 },
    ]);
    const r = await rumJob(p.env.DB, now);
    expect(r.rollups.map((x) => [x.day, x.samples])).toEqual([['2026-11-03', 1], ['2026-11-04', 1]]);
    expect(r.purged).toBe(1);
  });
});

describe('scheduled wiring', { timeout: 60_000 }, () => {
  test('cron 30 2 * * * runs the RUM job (and nothing else)', async () => {
    const { default: worker } = await import('../src/index.ts');
    const now = Date.UTC(2026, 10, 5, 2, 30);
    await insert([{ at: START + 10, metric: 'LCP', value: 1234 }]);
    await worker.scheduled({ cron: '30 2 * * *', scheduledTime: now, noRetry() {} } as ScheduledController, { DB: p.env.DB } as never, {} as ExecutionContext);
    expect(await daily()).toHaveLength(1);
  });
});
