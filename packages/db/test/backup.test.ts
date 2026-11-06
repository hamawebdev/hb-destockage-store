// DB-5 (first half): canonical digests, verifyRestore, and restore-from-dump on workerd D1.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { buildManifest, canonicalValue, digestRows, tableDigest, verifyRestore, type D1Like } from '../src/backup.ts';
import { schemaFirst, splitSqlStatements, verifyRestoreFromDump } from '../src/backup-node.ts';
import { LOCAL_DATABASE_ID } from '../src/seed/guard.ts';
import { exec, freshD1, type RawD1 } from './d1.ts';
import { MIGRATIONS_DIR } from './helpers.ts';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const fixture = readFileSync(new URL('./fixtures/data-at-0000.sql', import.meta.url), 'utf8')
  .split(/;\n/)
  .map((s) => s.replace(/^--.*$/gm, '').trim())
  .filter(Boolean);

describe('canonical digest rules (agreed with jobs)', () => {
  test('rows as JSON arrays in column order, joined by newlines, sha256 hex', () => {
    const rows = [{ a: 1, b: 'x', extra: 'ignored' }, { b: null, a: 2 }];
    expect(digestRows(['a', 'b'], rows)).toEqual({ rows: 2, digest: sha('[1,"x"]\n[2,null]') });
    expect(digestRows(['a'], [])).toEqual({ rows: 0, digest: sha('') });
  });
  test('BLOBs as lowercase hex (number[] / ArrayBuffer / Buffer), bigint as text, undefined as null', () => {
    expect(canonicalValue([0, 15, 255])).toBe('000fff');
    expect(canonicalValue(new Uint8Array([1, 171]).buffer)).toBe('01ab');
    expect(canonicalValue(Buffer.from([16]))).toBe('10');
    expect(canonicalValue(9007199254740993n)).toBe('9007199254740993');
    expect(canonicalValue(undefined)).toBeNull();
  });
});

describe('dump handling (wrangler d1 export is not restorable as is)', () => {
  test('splits on ; outside strings, identifiers, comments and trigger bodies (CASE … END included)', () => {
    const sql = `PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE "c" (id integer, w integer REFERENCES "w"(code));
INSERT INTO "c" VALUES(1,'a;b''c;END;');
-- a comment; with semicolons
CREATE TRIGGER "t" BEFORE INSERT ON "c" BEGIN SELECT CASE WHEN NEW.id < 0 THEN RAISE(ABORT, 'no; END;') END; SELECT 1; END;
CREATE TABLE "w" (code integer primary key, "x;y" text);
/* block; comment */ INSERT INTO "w" VALUES(1,'z');`;
    expect(splitSqlStatements(sql)).toEqual([
      'PRAGMA defer_foreign_keys=TRUE',
      'CREATE TABLE "c" (id integer, w integer REFERENCES "w"(code))',
      "INSERT INTO \"c\" VALUES(1,'a;b''c;END;')",
      "-- a comment; with semicolons\nCREATE TRIGGER \"t\" BEFORE INSERT ON \"c\" BEGIN SELECT CASE WHEN NEW.id < 0 THEN RAISE(ABORT, 'no; END;') END; SELECT 1; END",
      'CREATE TABLE "w" (code integer primary key, "x;y" text)',
      '/* block; comment */ INSERT INTO "w" VALUES(1,\'z\')',
    ]);
  });
  test('schemaFirst hoists every CREATE TABLE after the PRAGMAs, keeping the rest in order', () => {
    const out = splitSqlStatements(schemaFirst(`PRAGMA x;\nCREATE TABLE a (i);\nINSERT INTO a VALUES(1);\nCREATE TABLE b (j);\nINSERT INTO b VALUES(2);\nCREATE INDEX ia ON a(i);`));
    expect(out).toEqual(['PRAGMA x', 'CREATE TABLE a (i)', 'CREATE TABLE b (j)', 'INSERT INTO a VALUES(1)', 'INSERT INTO b VALUES(2)', 'CREATE INDEX ia ON a(i)']);
  });
});

describe('verifyRestore on workerd D1', () => {
  let d1: RawD1;
  let dispose: () => Promise<void>;
  const db = () => d1 as unknown as D1Like;
  beforeEach(async () => {
    ({ d1, dispose } = await freshD1());
    for (const s of fixture) await d1.prepare(s).run();
    for (let i = 0; i < 7; i++) await d1.prepare(`insert into rum_events (template, path, lang, metric, value) values ('home', '/fr/', 'fr', 'LCP', ${i})`).run();
  });
  afterEach(async () => dispose?.());

  test('a database verifies against its own manifest', async () => {
    const m = await buildManifest(db());
    expect(m.tables.find((t) => t.name === 'rum_events')?.rows).toBe(8);
    expect(m.tables.some((t) => t.name.startsWith('_cf_') || t.name.startsWith('sqlite_'))).toBe(false);
    expect(await verifyRestore(db(), m)).toEqual({ ok: true, mismatches: [] });
  });

  test('pagination does not change the digest; equals the jobs shim (SELECT *, OFFSET pages)', async () => {
    const whole = await tableDigest(db(), 'rum_events', 1000);
    expect(await tableDigest(db(), 'rum_events', 3)).toEqual(whole);
    // jobs' interim shim: SELECT * ORDER BY rowid LIMIT/OFFSET, columns from table_xinfo.
    const cols = (await d1.prepare('PRAGMA table_xinfo("rum_events")').all<{ name: string; hidden: number }>()).results.filter((c) => c.hidden === 0).map((c) => c.name);
    const rows = (await d1.prepare('SELECT * FROM "rum_events" ORDER BY rowid').all<Record<string, unknown>>()).results;
    expect(digestRows(cols, rows)).toEqual(whole);
  });

  test('one changed value, a missing row, an extra table, a schema change: each reported', async () => {
    const m = await buildManifest(db());
    await exec(d1, "update customers set name = 'Amina' where id = 1");
    await exec(d1, 'delete from rum_events where value = 3');
    await exec(d1, 'create table stray (x integer)');
    await exec(d1, 'drop index orders_created_idx');
    const r = await verifyRestore(db(), m);
    expect(r.ok).toBe(false);
    expect(r.mismatches.map((x) => x.table).sort()).toEqual(['(schema)', 'customers', 'rum_events', 'stray']);
    expect(r.mismatches.find((x) => x.table === 'rum_events')?.actual).toMatchObject({ rows: 7 });
  });

  test('a table missing from the restore and a different migration version are reported', async () => {
    await exec(d1, "create table d1_migrations (id integer primary key autoincrement, name text, applied_at text); insert into d1_migrations (name) values ('0007_stock_taken.sql')");
    const m = await buildManifest(db());
    expect(m.schemaVersion).toBe('0007_stock_taken.sql');
    await exec(d1, "insert into d1_migrations (name) values ('0008_next.sql'); drop table rum_daily");
    const tables = (await verifyRestore(db(), m)).mismatches.map((x) => x.table).sort();
    expect(tables).toEqual(['(schema)', '(schemaVersion)', 'd1_migrations', 'rum_daily']);
  });
});

describe('verifyRestoreFromDump: real `wrangler d1 export` dump into a fresh local D1', () => {
  test('the dump restores to an identical database; a corrupted dump is caught', async () => {
    const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'hb-db5-'));
    try {
      const wrangler = fileURLToPath(new URL('../../../node_modules/.bin/wrangler', import.meta.url));
      const cfg = join(work, 'wrangler.jsonc');
      writeFileSync(cfg, JSON.stringify({ name: 'src', compatibility_date: '2026-11-01', d1_databases: [{ binding: 'DB', database_name: 'hb-destockage', database_id: LOCAL_DATABASE_ID, migrations_dir: MIGRATIONS_DIR }] }));
      // `wrangler d1 export --local` has no --persist-to: it reads <cwd>/.wrangler/state. So the source DB
      // lives in the default state dir of the scratch directory, and every command runs from there.
      const persist = join(work, '.wrangler', 'state');
      const run = (...args: string[]) => {
        const r = spawnSync(wrangler, ['d1', ...args, '--local', '--config', cfg], { cwd: work, env: { ...process.env, CI: '1' }, encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`${args.join(' ')}: ${r.stdout}\n${r.stderr}`);
      };
      run('migrations', 'apply', 'hb-destockage');
      const dataFile = join(work, 'data.sql');
      writeFileSync(dataFile, fixture.join(';\n') + ';\n');
      run('execute', 'hb-destockage', '--file', dataFile);
      const dump = join(work, 'dump.sql');
      run('export', 'hb-destockage', '--output', dump);

      const proxy = await getPlatformProxy<{ DB: D1Like }>({ configPath: cfg, persist: { path: join(persist, 'v3') }, remoteBindings: false });
      const manifest = await buildManifest(proxy.env.DB);
      await proxy.dispose();
      expect(manifest.schemaVersion).toMatch(/^0007_/);

      expect(await verifyRestoreFromDump({ dumpFile: dump, manifest })).toMatchObject({ ok: true, mismatches: [] });

      const bad = join(work, 'bad.sql');
      writeFileSync(bad, readFileSync(dump, 'utf8').replaceAll("'Amine'", "'Amina'"));
      const r = await verifyRestoreFromDump({ dumpFile: bad, manifest });
      expect(r.ok).toBe(false);
      expect(r.mismatches.map((x) => x.table).sort()).toEqual(['customers', 'orders']);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
