// Retention on local R2 (workerd via getPlatformProxy).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { runIdFor, runPrefix } from '../src/backup/export.ts';
import { applyRetention, listAll, runTime } from '../src/backup/retention.ts';
import { localPlatform, type LocalPlatform } from './helpers/platform.ts';

type E = { BACKUPS: R2Bucket };
let p: LocalPlatform<E>;
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 4, 2, 5, 0);

async function putRun(at: number, complete = true): Promise<string> {
  const prefix = runPrefix(runIdFor(at));
  await p.env.BACKUPS.put(`${prefix}dump.sql.gz`, 'x');
  if (complete) await p.env.BACKUPS.put(`${prefix}manifest.json`, '{}');
  return prefix;
}

async function runs(): Promise<string[]> {
  return [...new Set((await listAll(p.env.BACKUPS, 'd1/')).filter((k) => runTime(k) !== null).map((k) => k.slice(0, 22)))].sort();
}

beforeAll(async () => {
  p = await localPlatform<E>({ r2_buckets: [{ binding: 'BACKUPS', bucket_name: 'hb-backups-retention' }] });
}, 60_000);
afterAll(async () => p?.dispose());
beforeEach(async () => {
  const keys = await listAll(p.env.BACKUPS, '');
  if (keys.length) await p.env.BACKUPS.delete(keys);
});

describe('applyRetention', { timeout: 60_000 }, () => {
  test('daily runs: keeps the last 35 days, deletes older; status.json and foreign keys untouched', async () => {
    const base = Date.UTC(2026, 10, 4, 2, 0, 0);
    for (let d = 0; d < 40; d++) await putRun(base - d * DAY);
    await p.env.BACKUPS.put('d1/status.json', '{}');
    await p.env.BACKUPS.put('d1/README.txt', 'x');
    const r = await applyRetention(p.env.BACKUPS, NOW);
    // ages 0..35 days (+5 min) — day 35 is 35 d 5 min old → deleted; 0..34 kept.
    expect(r.deletedRuns).toHaveLength(5);
    expect(await runs()).toHaveLength(35);
    expect((await runs())[0]).toBe(runPrefix(runIdFor(base - 34 * DAY)));
    expect(await p.env.BACKUPS.head('d1/status.json')).not.toBeNull();
    expect(await p.env.BACKUPS.head('d1/README.txt')).not.toBeNull();
  });

  test('stopped cron: the 7 newest complete runs survive however old', async () => {
    const old = NOW - 60 * DAY;
    for (let d = 0; d < 10; d++) await putRun(old - d * DAY);
    const r = await applyRetention(p.env.BACKUPS, NOW);
    expect(r.kept).toHaveLength(7);
    expect(r.deletedRuns).toEqual([0, 1, 2].map((i) => runPrefix(runIdFor(old - (9 - i) * DAY))));
    expect(await runs()).toHaveLength(7);
  });

  test('fewer than 7 complete runs, all old: nothing deleted', async () => {
    for (let d = 0; d < 3; d++) await putRun(NOW - (90 + d) * DAY);
    const r = await applyRetention(p.env.BACKUPS, NOW);
    expect(r.deletedRuns).toEqual([]);
  });

  test('orphans (no manifest): removed after 24 h, recent ones kept; orphans never count as kept', async () => {
    const fresh = await putRun(NOW - 60 * 60_000, false);
    const stale = await putRun(NOW - 2 * DAY, false);
    const r = await applyRetention(p.env.BACKUPS, NOW);
    expect(r.deletedRuns).toEqual([stale]);
    expect(await runs()).toEqual([fresh]);
    expect(r.complete).toBe(0);
  });

  test('INCONSISTENT runs never take a protected slot and do not count as complete (review r1 F1)', async () => {
    const old = NOW - 60 * DAY;
    const good: string[] = [];
    for (let d = 0; d < 7; d++) good.push(await putRun(old - (d + 5) * DAY));
    const bad: string[] = [];
    for (let d = 0; d < 5; d++) {
      const prefix = await putRun(old - d * DAY); // newer than every good run
      await p.env.BACKUPS.put(`${prefix}INCONSISTENT`, 'x');
      bad.push(prefix);
    }
    const r = await applyRetention(p.env.BACKUPS, NOW);
    expect(r.complete).toBe(7);
    expect(r.inconsistent).toBe(5);
    expect(r.kept.sort()).toEqual(good.sort());
    expect(r.deletedRuns).toEqual(bad.sort());
  });

  test('custom limits', async () => {
    for (let d = 0; d < 5; d++) await putRun(NOW - d * DAY - 60_000);
    const r = await applyRetention(p.env.BACKUPS, NOW, { retentionDays: 2, keepLatest: 1 });
    expect(r.deletedRuns).toHaveLength(3);
  });
});
