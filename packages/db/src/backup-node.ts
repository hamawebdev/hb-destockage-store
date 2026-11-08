// DB-5 — `@hb/db/backup-node` (Node only): restore a D1 export (`wrangler d1 export` / jobs' dump,
// plain or .gz) into a FRESH local D1 and verify it against the backup's manifest. Used by jobs'
// `restore:verify` (JOBS-1 §5) and its tests. The import goes through `wrangler d1 execute --file`
// (it splits trigger bodies correctly); the check through `verifyRestore` on workerd's D1.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * Refuses a path inside a git worktree (DB-5 r1, rev-a): a dump holds customer data and must never
 * land where `git add` could pick it up. Walks up from the path (or its nearest existing parent).
 */
export function assertOutsideGitWorktree(path: string, what: string): void {
  let dir = resolve(path);
  while (!existsSync(dir)) dir = dirname(dir);
  dir = realpathSync(dir);
  for (;;) {
    if (existsSync(join(dir, '.git'))) throw new Error(`verifyRestoreFromDump: ${what} ${path} is inside the git worktree ${dir}; use a scratch dir under $TMPDIR`);
    const up = dirname(dir);
    if (up === dir) return;
    dir = up;
  }
}

export interface VerifyFromDumpOptions {
  /** Path to the dump (`.sql` or `.sql.gz`). */
  readonly dumpFile: string;
  readonly manifest: BackupManifest;
  /** Scratch directory (default: a new dir under $TMPDIR). Removed afterwards unless `keep`. */
  readonly workDir?: string;
  readonly keep?: boolean;
}

/**
 * Restores `dumpFile` into a fresh local D1 and verifies it against `manifest`.
 * Resolves `{ ok, mismatches }` when the restore ran. THROWS when the restore could not run (bad
 * path, import error, wrangler failure): a throw means NOT verified, never "verified with
 * differences"; the error carries wrangler's output, so log it only where customer data may go.
 */
export async function verifyRestoreFromDump(opts: VerifyFromDumpOptions): Promise<{ ok: boolean; mismatches: RestoreMismatch[]; workDir: string }> {
  assertOutsideGitWorktree(opts.dumpFile, 'dumpFile');
  if (opts.workDir !== undefined) assertOutsideGitWorktree(opts.workDir, 'workDir');
  const workDir = opts.workDir ?? mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'hb-restore-'));
  const owned = opts.workDir === undefined && !opts.keep;
  // Interrupted (Ctrl-C, kill): remove the scratch copy of the dump before exiting.
  const onSignal = (sig: NodeJS.Signals) => {
    if (owned) rmSync(workDir, { recursive: true, force: true });
    process.kill(process.pid, sig);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
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
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (owned) rmSync(workDir, { recursive: true, force: true });
  }
}
