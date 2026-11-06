// DB-5 — `@hb/db/backup-node` (Node only): restore a D1 export (`wrangler d1 export` / jobs' dump,
// plain or .gz) into a FRESH local D1 and verify it against the backup's manifest. Used by jobs'
// `restore:verify` (JOBS-1 §5) and its tests. The import goes through `wrangler d1 execute --file`
// (it splits trigger bodies correctly); the check through `verifyRestore` on workerd's D1.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { getPlatformProxy } from 'wrangler';
import { orderDumpSchemaFirst, verifyRestore, type BackupManifest, type D1Like, type RestoreMismatch } from './backup.ts';

export { orderDumpSchemaFirst, schemaFirst, splitSqlStatements } from './backup.ts';
import { LOCAL_DATABASE_ID } from './seed/guard.ts';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function wranglerBin(): string {
  for (const c of [join(pkgDir, 'node_modules', '.bin', 'wrangler'), resolve(pkgDir, '..', '..', 'node_modules', '.bin', 'wrangler')]) {
    try {
      readFileSync(c);
      return c;
    } catch {
      /* next */
    }
  }
  return 'wrangler';
}

export interface VerifyFromDumpOptions {
  /** Path to the dump (`.sql` or `.sql.gz`). */
  readonly dumpFile: string;
  readonly manifest: BackupManifest;
  /** Scratch directory (default: a new dir under $TMPDIR). Removed afterwards unless `keep`. */
  readonly workDir?: string;
  readonly keep?: boolean;
}

export async function verifyRestoreFromDump(opts: VerifyFromDumpOptions): Promise<{ ok: boolean; mismatches: RestoreMismatch[]; workDir: string }> {
  const workDir = opts.workDir ?? mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'hb-restore-'));
  try {
    const sqlFile = join(workDir, 'restore.sql');
    const raw = readFileSync(opts.dumpFile);
    const text = (opts.dumpFile.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8');
    writeFileSync(sqlFile, orderDumpSchemaFirst(text));
    // A config of its own, so the restore can never touch the shared worktree DB or anything remote.
    const configPath = join(workDir, 'wrangler.jsonc');
    writeFileSync(
      configPath,
      JSON.stringify({
        name: 'hb-restore-verify',
        compatibility_date: '2026-11-01',
        d1_databases: [{ binding: 'DB', database_name: 'hb-destockage', database_id: LOCAL_DATABASE_ID }],
      }),
    );
    const persist = join(workDir, 'state');
    const r = spawnSync(wranglerBin(), ['d1', 'execute', 'hb-destockage', '--local', '--persist-to', persist, '--config', configPath, '--file', sqlFile], {
      env: { ...process.env, CI: '1' },
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`verifyRestoreFromDump: import failed (exit ${r.status}):\n${r.stdout}\n${r.stderr}`);
    const proxy = await getPlatformProxy<{ DB: D1Like }>({ configPath, persist: { path: join(persist, 'v3') }, remoteBindings: false });
    try {
      const res = await verifyRestore(proxy.env.DB, opts.manifest);
      return { ...res, workDir };
    } finally {
      await proxy.dispose();
    }
  } finally {
    if (!opts.keep && opts.workDir === undefined) rmSync(workDir, { recursive: true, force: true });
  }
}
