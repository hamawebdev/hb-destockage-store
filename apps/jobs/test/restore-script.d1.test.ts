// The operator scripts end to end (review r1 F3/F5 + the flaky-test fix): the source platform is
// disposed BEFORE any script runs, so no two workerd processes ever share persisted state.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { backupJob } from '../src/backup/job.ts';
import { runBackup, type BackupManifest } from '../src/backup/export.ts';
import { PII, seedBackupFixtures } from './helpers/fixtures.ts';
import { localPlatform, type LocalPlatform } from './helpers/platform.ts';

type E = { DB: D1Database; BACKUPS: R2Bucket };
const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const T0 = Date.UTC(2026, 10, 4, 2, 0, 0);
let p: LocalPlatform<E>;
let good: BackupManifest;
let files: string; // manifest + dump copies, outside any git worktree
let gz: Uint8Array;

const node = (script: string, args: string[]) =>
  spawnSync(process.execPath, [script, ...args], { cwd: APP, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });

beforeAll(async () => {
  p = await localPlatform<E>({ r2_buckets: [{ binding: 'BACKUPS', bucket_name: 'hb-backups' }] });
  await seedBackupFixtures(p.env.DB);
  good = await backupJob(p.env, { startedAt: T0 });
  // a newer run marked INCONSISTENT (forced: paginated with an update on every page)
  await runBackup(p.env, {
    startedAt: T0 + 3_600_000,
    mode: 'paginated',
    pageSize: 50,
    onPage: async () => {
      await p.env.DB.prepare(`UPDATE settings SET updated_at = updated_at + 1 WHERE key = 'shop'`).run();
    },
  });
  gz = new Uint8Array(await (await p.env.BACKUPS.get(good.object.key))!.arrayBuffer());
  files = mkdtempSync(join(tmpdir(), 'hb-restore-test-files-'));
  writeFileSync(join(files, 'manifest.json'), JSON.stringify(good));
  writeFileSync(join(files, 'dump.sql.gz'), gz);
  await p.dispose(false); // keep the files: the scripts read them next
}, 180_000);

afterAll(() => {
  rmSync(p.dir, { recursive: true, force: true });
  rmSync(files, { recursive: true, force: true });
});

describe('scripts/restore.ts (download → check → load → verify)', { timeout: 180_000 }, () => {
  test('--run latest: restores the newest GOOD run, verifies schema and data, deletes its work dir', () => {
    const r = node('scripts/restore.ts', ['--run', 'latest', '--target', 'hb-restore-test', '--source-persist-to', p.persistTo]);
    expect(r.stdout).toContain('dump sha256: OK (20261104T020000Z');
    expect(r.stdout).toContain(`RESTORE VERIFIED: ${good.tables.length} tables`);
    expect(r.status).toBe(0);
    const work = /work dir \(0700, outside any git worktree\): (\S+)/.exec(r.stdout)![1]!;
    expect(work.startsWith(tmpdir())).toBe(true);
    expect(r.stdout).toContain(`deleted ${work}`);
    expect(existsSync(work)).toBe(false);
    for (const v of [PII.name, PII.phone, PII.note]) expect(r.stdout + r.stderr).not.toContain(v);
  });

  test('refuses a run marked INCONSISTENT (and still cleans up)', () => {
    const r = node('scripts/restore.ts', ['--run', 'd1/2026/11/04/030000Z', '--target', 'hb-restore-test', '--source-persist-to', p.persistTo]);
    expect(r.stderr).toContain('marked INCONSISTENT');
    expect(r.status).toBe(1);
    const work = /work dir \(0700, outside any git worktree\): (\S+)/.exec(r.stdout)![1]!;
    expect(existsSync(work)).toBe(false);
  });

  test('refuses a restore target inside a git worktree, and the live database name', () => {
    const inRepo = join(APP, '.restore-should-not-exist');
    const r = node('scripts/restore.ts', ['--run', 'latest', '--target', 'hb-restore-test', '--target-persist-to', inRepo, '--source-persist-to', p.persistTo]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/inside the git worktree/);
    expect(existsSync(inRepo)).toBe(false);
    expect(node('scripts/restore.ts', ['--run', 'latest', '--target', 'hb-destockage']).status).toBe(2);
  });
});

describe('scripts/restore.ts --orders-since (RESTORE.md §2 step 4, review r2)', { timeout: 180_000 }, () => {
  test('lists complete orders (customer, wilaya, commune, address, items, totals) from an SQL copy', () => {
    const r = node('scripts/restore.ts', ['--orders-since', '1970-01-01T00:00:00Z', '--from-sql', join(files, 'dump.sql.gz')]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(': 2\n');
    expect(r.stdout).toMatch(/HB-T0001 .*status new/);
    expect(r.stdout).toContain(`customer: ${PII.name}  ${PII.phone}`);
    expect(r.stdout).toContain(`wilaya 16 Alger  commune 1601 Alger Centre  address: ${PII.note}`);
    expect(r.stdout).toContain('- 1 × Pack cuisine [HB-PK-001] 15000 DZD = 15000 DZD');
    expect(r.stdout).toContain('subtotal 15000 DZD + delivery 400 DZD = total 15400 DZD');
    const work = /deleted (\S+)/.exec(r.stderr)![1]!;
    expect(work.startsWith(tmpdir())).toBe(true);
    expect(existsSync(work)).toBe(false);
  });

  test('loads a `wrangler d1 export`-style file (child INSERTs before the parent table) via db\'s schema-first reorder', () => {
    const exportStyle = [
      'PRAGMA defer_foreign_keys=TRUE;',
      'CREATE TABLE orders (id INTEGER PRIMARY KEY, ref TEXT, created_at INTEGER, status TEXT, name TEXT, phone_e164 TEXT, wilaya_code INTEGER REFERENCES wilayas(code), commune_id INTEGER REFERENCES communes(id), address TEXT, lang TEXT, subtotal_dzd INTEGER, fee_dzd INTEGER, total_dzd INTEGER, flags TEXT);',
      `INSERT INTO "orders" VALUES(7,'HB-X7K2Q',1800000000000,'new','Test Export','+213770000007',16,1601,'Rue; ''Export'' 7','fr',100,400,500,'[]');`,
      'CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id), qty INTEGER, sku TEXT, name_fr TEXT, variant_label_fr TEXT, unit_price_dzd INTEGER, line_total_dzd INTEGER);',
      `INSERT INTO "order_items" VALUES(1,7,1,'SKU-1','Article',NULL,100,100);`,
      'CREATE TABLE wilayas (code INTEGER PRIMARY KEY, name_fr TEXT);',
      `INSERT INTO "wilayas" VALUES(16,'Alger');`,
      'CREATE TABLE communes (id INTEGER PRIMARY KEY, wilaya_code INTEGER, name_fr TEXT);',
      `INSERT INTO "communes" VALUES(1601,16,'Alger Centre');`,
    ].join('\n');
    writeFileSync(join(files, 'export-style.sql'), exportStyle);
    const r = node('scripts/restore.ts', ['--orders-since', '2027-01-01T00:00:00Z', '--from-sql', join(files, 'export-style.sql')]);
    expect(r.stderr).not.toMatch(/failed/);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('HB-X7K2Q');
    expect(r.stdout).toContain("commune 1601 Alger Centre  address: Rue; 'Export' 7");
    expect(r.stdout).toContain('- 1 × Article [SKU-1] 100 DZD = 100 DZD');
  });

  test('a window after the last order lists nothing; an SQL file inside the repo is refused', () => {
    const r = node('scripts/restore.ts', ['--orders-since', '2999-01-01T00:00:00Z', '--from-sql', join(files, 'dump.sql.gz')]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(': 0\n');
    const inRepo = join(APP, 'package.json');
    const refused = node('scripts/restore.ts', ['--orders-since', '2026-01-01T00:00:00Z', '--from-sql', inRepo]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/inside the git worktree/);
  });
});

describe('scripts/restore.ts interrupted (review r2 nit)', { timeout: 180_000 }, () => {
  test('Ctrl-C (SIGINT) removes the private folder', async () => {
    const child = spawn(process.execPath, ['scripts/restore.ts', '--run', 'latest', '--target', 'hb-restore-test', '--source-persist-to', p.persistTo], {
      cwd: APP,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    });
    let out = '';
    const work = await new Promise<string>((ok, fail) => {
      child.stdout.on('data', (b: Buffer) => {
        out += b.toString();
        const m = /work dir \(0700, outside any git worktree\): (\S+)/.exec(out);
        if (m) ok(m[1]!);
      });
      child.on('exit', () => fail(new Error(`exited before printing the work dir: ${out}`)));
    });
    expect(existsSync(work)).toBe(true);
    child.kill('SIGINT');
    const code = await new Promise<number | null>((ok) => child.on('exit', (c) => ok(c)));
    expect(code).toBe(130);
    expect(existsSync(work)).toBe(false);
  });
});

describe('scripts/restore-verify.ts', { timeout: 120_000 }, () => {
  test('--dump is required; paths inside a git worktree are refused', () => {
    expect(node('scripts/restore-verify.ts', ['--manifest', join(files, 'manifest.json'), '--dump-only']).status).toBe(2);
    const inRepo = join(APP, '.verify-should-not-exist');
    mkdirSync(inRepo, { recursive: true });
    try {
      writeFileSync(join(inRepo, 'manifest.json'), '{}');
      const r = node('scripts/restore-verify.ts', ['--manifest', join(inRepo, 'manifest.json'), '--dump', join(files, 'dump.sql.gz'), '--dump-only']);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/inside the git worktree/);
    } finally {
      rmSync(inRepo, { recursive: true, force: true });
    }
  });

  test('--dump-only: OK on the real dump, MISMATCH on a corrupted one, before anything is loaded', () => {
    const ok = node('scripts/restore-verify.ts', ['--manifest', join(files, 'manifest.json'), '--dump', join(files, 'dump.sql.gz'), '--dump-only']);
    expect(ok.stdout).toContain('dump sha256: OK');
    expect(ok.status).toBe(0);
    const bad = Uint8Array.from(gz);
    bad[bad.length - 9] = bad[bad.length - 9]! ^ 0xff;
    writeFileSync(join(files, 'bad.sql.gz'), bad);
    const r = node('scripts/restore-verify.ts', ['--manifest', join(files, 'manifest.json'), '--dump', join(files, 'bad.sql.gz'), '--dump-only']);
    expect(r.stdout).toContain('dump sha256: MISMATCH');
    expect(r.status).toBe(1);
  });
});
