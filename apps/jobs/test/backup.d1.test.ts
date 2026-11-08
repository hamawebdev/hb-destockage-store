// JOBS-1 end to end on local workerd: D1 (DB-1 migrations + fixtures) → backup → local R2 →
// download + sha256 check → restore into a FRESH D1 with `wrangler d1 execute --local --file` →
// verifyRestore. Nothing remote.
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { BackupError, runBackup, type BackupManifest } from '../src/backup/export.ts';
import { backupHealthCheck, backupJob } from '../src/backup/job.ts';
import { readStatus, type BackupStatus } from '../src/backup/status.ts';
import { verifyRestore } from '../src/backup/verify.ts';
import { captureConsole } from './helpers/batch.ts';
import { PII, seedBackupFixtures } from './helpers/fixtures.ts';
import { localPlatform, type LocalPlatform } from './helpers/platform.ts';
import { restoreWithWrangler, type Restored } from './helpers/restore.ts';
import { migrationFiles } from './helpers/schema.ts';

type E = { DB: D1Database; BACKUPS: R2Bucket };
let p: LocalPlatform<E>;
let manifest: BackupManifest;
let dumpSql: string;
let restored: Restored;
const logs: string[] = [];
const T0 = Date.UTC(2026, 10, 4, 2, 0, 0);

beforeAll(async () => {
  p = await localPlatform<E>({ r2_buckets: [{ binding: 'BACKUPS', bucket_name: 'hb-backups-test' }] });
  await seedBackupFixtures(p.env.DB);
  const cap = captureConsole();
  try {
    let clock = T0 + 5_000; // cron fired at T0, job started 5 s later; each now() call advances 100 ms
    manifest = await backupJob(p.env, { startedAt: T0, now: () => (clock += 100) });
  } finally {
    cap.restore();
    logs.push(...cap.lines);
  }
  const obj = await p.env.BACKUPS.get(manifest.object.key);
  const gz = new Uint8Array(await obj!.arrayBuffer());
  expect(createHash('sha256').update(gz).digest('hex')).toBe(manifest.object.sha256);
  const raw = gunzipSync(gz);
  expect(createHash('sha256').update(raw).digest('hex')).toBe(manifest.object.rawSha256);
  dumpSql = raw.toString('utf8');
  restored = await restoreWithWrangler(dumpSql);
}, 180_000);

afterAll(async () => {
  await restored?.dispose();
  await p?.dispose();
});

describe('backup run', { timeout: 60_000 }, () => {
  test('keys, manifest written after the dump, atomic mode', async () => {
    expect(manifest.runId).toBe('20261104T020000Z');
    expect(manifest.object.key).toBe('d1/2026/11/04/020000Z/dump.sql.gz');
    const m = await p.env.BACKUPS.get('d1/2026/11/04/020000Z/manifest.json');
    expect(await m!.json()).toEqual(manifest);
    expect(manifest.mode).toBe('atomic');
    expect(manifest.consistent).toBe(true);
    expect(manifest.scheduledAt).toBe('2026-11-04T02:00:00.000Z');
    expect(Date.parse(manifest.startedAt)).toBeGreaterThan(T0);
    expect(manifest.durationMs).toBe(Date.parse(manifest.finishedAt) - Date.parse(manifest.startedAt));
    expect(manifest.durationMs).toBeLessThan(1000);
  });

  test('every user table from sqlite_master, D1/SQLite internals excluded', async () => {
    const { results } = await p.env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`,
    ).all<{ name: string }>();
    expect(manifest.tables.map((t) => t.name).sort()).toEqual(results.map((r) => r.name));
    expect(manifest.tables.map((t) => t.name)).toEqual(expect.arrayContaining(['orders', 'audit_log', 'd1_migrations', 'zz_edge', 'zz_frozen']));
    expect(manifest.tables.some((t) => /^(_cf_|sqlite_)/.test(t.name))).toBe(false);
    expect(manifest.tables.find((t) => t.name === 'orders')!.rows).toBe(2);
  });

  test('schema version = latest applied migration; sequences captured', () => {
    expect(manifest.schemaVersion).toBe(migrationFiles().at(-1));
    expect(manifest.sequences).toEqual(expect.arrayContaining([{ name: 'zz_edge', seq: 3 }]));
  });

  test('dump layout: defer FKs, tables, data, sequences, then indexes and triggers last', () => {
    const i = (s: string) => dumpSql.indexOf(s);
    expect(dumpSql.startsWith('-- hb-destockage D1 backup 20261104T020000Z')).toBe(true);
    expect(i('PRAGMA defer_foreign_keys = ON;')).toBeGreaterThan(0);
    expect(i('INSERT INTO "zz_frozen"')).toBeLessThan(i('CREATE TRIGGER zz_frozen_no_insert'));
    expect(i('INSERT INTO "wilayas"')).toBeLessThan(i('INSERT INTO "orders"'));
    expect(i('DELETE FROM sqlite_sequence;')).toBeLessThan(i('CREATE INDEX zz_edge_t_idx'));
  });

  test('status.json records the success; logs hold no personal data', async () => {
    const s = await readStatus(p.env.BACKUPS);
    expect(s.lastSuccess).toMatchObject({ runId: '20261104T020000Z', schemaVersion: manifest.schemaVersion });
    expect(s.lastFailure).toBeNull();
    const out = logs.join('\n');
    expect(out).toContain('backup.done');
    for (const v of [PII.name, PII.phone, '560417403', PII.note, 'Oliviers']) expect(out).not.toContain(v);
  });
});

describe('restore into a fresh D1 (wrangler d1 execute --local --file)', { timeout: 60_000 }, () => {
  test('verifyRestore passes: every table, row count, digest and the schema version', async () => {
    const r = await verifyRestore(restored.db, manifest);
    expect(r.mismatches).toEqual([]);
    expect(r.ok).toBe(true);
  });

  test('values round-trip exactly (blob, real, NUL, Arabic, quotes, untyped column)', async () => {
    const rows = await restored.db
      .prepare(`SELECT id, hex(b) AS b, typeof(b) AS tb, r, typeof(r) AS tr, hex(t) AS t, u, typeof(u) AS tu FROM zz_edge ORDER BY id`)
      .all();
    expect(rows.results).toEqual([
      { id: 1, b: '0001FF', tb: 'blob', r: 0.1, tr: 'real', t: '610062', u: 3.5, tu: 'real' },
      { id: 2, b: '', tb: 'null', r: 1e300, tr: 'real', t: Buffer.from('سطر\nثاني').toString('hex').toUpperCase(), u: 'txt', tu: 'text' },
    ]);
    const s = await restored.db.prepare(`SELECT value FROM settings WHERE key = 'shop'`).first<{ value: string }>();
    expect(JSON.parse(s!.value)).toEqual({ note: "l'été; -- pas de DROP\nligne 2", ar: 'متجر' });
  });

  test('AUTOINCREMENT counter, indexes and triggers restored', async () => {
    await restored.db.prepare(`INSERT INTO zz_edge (t) VALUES ('next')`).run();
    expect((await restored.db.prepare(`SELECT max(id) AS m FROM zz_edge`).first<{ m: number }>())!.m).toBe(4);
    await expect(restored.db.prepare(`UPDATE zz_edge SET t = 'x' WHERE id = 1`).run()).rejects.toThrow(/append-only/);
    await expect(restored.db.prepare(`INSERT INTO zz_frozen VALUES (2, 'no')`).run()).rejects.toThrow(/frozen/);
    const idx = await restored.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'zz_edge_t_idx'`).first();
    expect(idx).not.toBeNull();
  });

  test('verifyRestore detects a changed value, a missing row and an extra table', async () => {
    await restored.db.prepare(`UPDATE settings SET value = '{}' WHERE key = 'shop'`).run();
    // not order_events: its append-only triggers are restored too and refuse the delete
    await restored.db.prepare(`DELETE FROM order_items`).run();
    await restored.db.prepare(`CREATE TABLE zz_extra (id INTEGER PRIMARY KEY)`).run();
    const r = await verifyRestore(restored.db, manifest);
    expect(r.ok).toBe(false);
    // zz_edge: row added by the previous test; (schema): zz_extra changed the DDL
    expect(r.mismatches.map((m) => m.table).sort()).toEqual(['(schema)', 'order_items', 'settings', 'zz_edge', 'zz_extra']);
  });

  test('schema hash catches a missing index or trigger even when every row matches (review r1 F3)', async () => {
    const fresh = await restoreWithWrangler(dumpSql);
    try {
      expect((await verifyRestore(fresh.db, manifest)).ok).toBe(true);
      await fresh.db.prepare(`DROP TRIGGER zz_edge_no_update`).run();
      const r = await verifyRestore(fresh.db, manifest);
      expect(r.mismatches.map((m) => m.table)).toEqual(['(schema)']);
    } finally {
      await fresh.dispose();
    }
  });
});

describe('modes and failures', { timeout: 180_000 }, () => {
  test('paginated mode (page size 2) yields the same digests as the atomic snapshot', async () => {
    // compare with an atomic run taken just before (backupJob mirrors its status into settings,
    // so the first manifest's settings digest is legitimately out of date by now)
    const atomic = await runBackup(p.env, { startedAt: T0 + 50_000, mode: 'atomic' });
    const m = await runBackup(p.env, { startedAt: T0 + 60_000, mode: 'paginated', pageSize: 2 });
    expect(m.mode).toBe('paginated');
    expect(m.consistent).toBe(true);
    expect(m.attempts).toBe(1);
    expect(m.tables).toEqual(atomic.tables);
    expect(m.schemaSha256).toBe(atomic.schemaSha256);
    expect(m.schemaVersion).toBe(manifest.schemaVersion);
  });

  const touchShop = async () => {
    await p.env.DB.prepare(`UPDATE settings SET updated_at = updated_at + 1 WHERE key = 'shop'`).run();
  };

  test('paginated: inserts during the export (beacons, new orders) do not make it inconsistent (review r1 N1)', async () => {
    const m = await runBackup(p.env, {
      startedAt: T0 + 90_000,
      mode: 'paginated',
      pageSize: 3,
      onPage: async () => {
        await p.env.DB.prepare(`INSERT INTO audit_log (actor_type, action, entity) VALUES ('system', 'test.write', 'x')`).run();
      },
    });
    expect(m.attempts).toBe(1);
    expect(m.consistent).toBe(true);
  });

  test('paginated: an update of an existing row during the export triggers a retry; the retry is consistent', async () => {
    let wrote = false;
    const m = await runBackup(p.env, {
      startedAt: T0 + 120_000,
      mode: 'paginated',
      pageSize: 3,
      onPage: async () => {
        if (wrote) return;
        wrote = true;
        await touchShop();
      },
    });
    expect(m.attempts).toBe(2);
    expect(m.consistent).toBe(true);
  });

  test('paginated: changes on every attempt → marked INCONSISTENT, counted as a FAILED run everywhere (review r1 F1)', async () => {
    const before = await readStatus(p.env.BACKUPS);
    const alert = vi.fn(async (_subject: string, _text: string, _id: string) => undefined);
    const err = await backupJob(p.env, { startedAt: T0 + 180_000, mode: 'paginated', pageSize: 50, alert, onPage: touchShop }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackupError);
    expect((err as BackupError).stage).toBe('consistency');
    const prefix = 'd1/2026/11/04/020300Z/';
    expect(await p.env.BACKUPS.head(`${prefix}INCONSISTENT`)).not.toBeNull();
    const m = (await (await p.env.BACKUPS.get(`${prefix}manifest.json`))!.json()) as BackupManifest;
    expect(m).toMatchObject({ consistent: false, attempts: 3 });
    const s = await readStatus(p.env.BACKUPS);
    expect(s.lastSuccess).toEqual(before.lastSuccess); // not recorded as a success
    expect(s.lastFailure).toMatchObject({ runId: '20261104T020300Z', stage: 'consistency', error: 'InconsistentSnapshot' });
    expect(alert).toHaveBeenCalledOnce();
    expect(alert.mock.calls[0]![0]).toBe('HB backup FAILED');
    expect(await p.env.BACKUPS.head('d1/in_progress.json')).toBeNull();
  });

  test('a run killed mid-way is reported by the next run (review r1 F2)', async () => {
    await p.env.BACKUPS.put('d1/in_progress.json', JSON.stringify({ runId: '20261103T020000Z', startedAt: '2026-11-03T02:00:00.000Z' }));
    const alert = vi.fn(async (_subject: string, _text: string, _id: string) => undefined);
    await backupJob(p.env, { startedAt: T0 + 200_000, alert });
    const s = await readStatus(p.env.BACKUPS);
    expect(s.lastFailure).toMatchObject({ runId: '20261103T020000Z', stage: 'killed', error: 'NoCompletion' });
    expect(s.lastSuccess?.runId).toBe('20261104T020320Z');
    expect(alert).toHaveBeenCalledOnce();
    expect(alert.mock.calls[0]![1]).toContain('killed');
    expect(await p.env.BACKUPS.head('d1/in_progress.json')).toBeNull();
  });

  test('status is mirrored to D1 settings for the admin dashboard; no row data in it', async () => {
    const row = await p.env.DB.prepare(`SELECT value FROM settings WHERE key = 'jobs.backup_status'`).first<{ value: string }>();
    const mirrored = JSON.parse(row!.value) as BackupStatus;
    expect(mirrored.lastSuccess?.runId).toBe('20261104T020320Z');
    for (const v of [PII.name, PII.phone, PII.note]) expect(row!.value).not.toContain(v);
  });

  test('health check: stale after 26 h without a good backup → alert; fresh → silent', async () => {
    const alert = vi.fn(async (_subject: string, _text: string, _id: string) => undefined);
    const last = Date.parse((await readStatus(p.env.BACKUPS)).lastSuccess!.at);
    expect(await backupHealthCheck(p.env, { now: () => last + 25 * 3_600_000, alert })).toBe(true);
    expect(alert).not.toHaveBeenCalled();
    expect(await backupHealthCheck(p.env, { now: () => last + 27 * 3_600_000, alert })).toBe(false);
    expect(alert).toHaveBeenCalledOnce();
    expect(alert.mock.calls[0]![0]).toBe('HB backup STALE');
    expect((await readStatus(p.env.BACKUPS)).health).toMatchObject({ stale: true, lastSuccessAgeHours: 27 });
  });

  test('precision guard: an integer beyond 2^53 fails the run loudly, no manifest, status + alert', async () => {
    await p.env.DB.prepare(`CREATE TABLE zz_big (id INTEGER PRIMARY KEY, v INTEGER)`).run();
    await p.env.DB.prepare(`INSERT INTO zz_big VALUES (1, 9007199254740993)`).run();
    const alert = vi.fn(async (_subject: string, _text: string, _id: string) => undefined);
    const cap = captureConsole();
    let err: unknown;
    try {
      await backupJob(p.env, { startedAt: T0 + 240_000, alert });
    } catch (e) {
      err = e;
    } finally {
      cap.restore();
      await p.env.DB.prepare(`DROP TABLE zz_big`).run();
    }
    expect(err).toBeInstanceOf(BackupError);
    expect((err as BackupError).stage).toBe('export');
    expect((err as BackupError).causeClass).toBe('PrecisionError');
    expect(await p.env.BACKUPS.head('d1/2026/11/04/020400Z/manifest.json')).toBeNull();
    expect((await readStatus(p.env.BACKUPS)).lastFailure).toMatchObject({ runId: '20261104T020400Z', stage: 'export', error: 'PrecisionError' });
    expect(alert).toHaveBeenCalledOnce();
    expect(cap.lines.join('\n')).not.toContain('9007199254740993');
  });
});
