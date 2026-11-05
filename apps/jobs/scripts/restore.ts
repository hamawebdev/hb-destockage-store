// Restore a D1 backup from R2 into a NEW database, in one guarded command (JOBS-1, review r1).
// Procedure and context: ../RESTORE.md.
//
//   node apps/jobs/scripts/restore.ts --run d1/2026/11/04/020000Z --target hb-restore-20261104 \
//        [--remote --target-id <id>]            restore on Cloudflare (operator; needs `wrangler login`)
//        [--target-persist-to <dir>]            local restore (rehearsal); default: inside the work dir
//        [--source-remote | --source-persist-to <dir>]   where the backups are (default: local jobs state)
//        [--keep] [--allow-inconsistent]
//   --run latest   picks the newest GOOD run (manifest, no INCONSISTENT marker).
//
// Guarantees:
// - Files (manifest, dump.sql.gz, dump.sql, local restored state) live only in a fresh 0700 dir
//   under the system temp dir, never inside a git worktree, and are deleted on exit unless --keep.
// - The dump is checked against the manifest (gzip and SQL sha256) BEFORE anything is loaded, and
//   the exact verified bytes are what gets loaded.
// - Runs marked INCONSISTENT are refused unless --allow-inconsistent.
// - After loading: every table's rows + digest, the migration version and the schema hash.
// Exit 0 = restored and verified.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getPlatformProxy } from 'wrangler';
import { checkDump, readManifest } from './lib/dump.ts';
import { assertOutsideGitWorktree, makePrivateDir } from './lib/private-dir.ts';
import { verifyDatabase } from './lib/verify-db.ts';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(APP, '../..');
const WRANGLER = join(REPO, 'node_modules/.bin/wrangler');
const BUCKET = 'hb-backups';

const { values: args } = parseArgs({
  options: {
    run: { type: 'string' },
    target: { type: 'string' },
    'target-id': { type: 'string' },
    remote: { type: 'boolean', default: false },
    'target-persist-to': { type: 'string' },
    'source-remote': { type: 'boolean', default: false },
    'source-persist-to': { type: 'string', default: join(REPO, '.wrangler/hb-local') },
    keep: { type: 'boolean', default: false },
    'allow-inconsistent': { type: 'boolean', default: false },
  },
});

function die(msg: string, code = 2): never {
  console.error(`restore: ${msg}`);
  process.exit(code);
}

if (!args.run || !args.target) die('--run <d1/YYYY/MM/DD/HHmmssZ|latest> and --target <new database name> are required');
if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(args.target) || args.target === 'hb-destockage') die('--target must be a NEW database name (never the live hb-destockage)');
if (args.remote && !args['target-id']) die('--remote needs --target-id (printed by `wrangler d1 create`)');
if (args['target-persist-to']) {
  try {
    assertOutsideGitWorktree(args['target-persist-to'], '--target-persist-to');
  } catch (err) {
    die((err as Error).message);
  }
}

function wrangler(argv: string[], what: string): string {
  const r = spawnSync(WRANGLER, argv, { cwd: APP, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
  if (r.status !== 0) throw new Error(`${what} failed (wrangler exit ${r.status}): ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}`);
  return r.stdout;
}

const source = args['source-remote'] ? ['--remote'] : ['--local', '--persist-to', resolve(args['source-persist-to']!)];
const getObject = (key: string, file: string) =>
  wrangler(['r2', 'object', 'get', `${BUCKET}/${key}`, '--file', file, ...source, '-c', join(APP, 'wrangler.jsonc')], `download ${key}`);

// From here on, never process.exit() before the finally: the work dir must be cleaned up.
const work = await makePrivateDir(args.run === 'latest' ? 'latest' : args.run.replace(/^d1\//, ''));
let exitCode = 1;
try {
  console.log(`work dir (0700, outside any git worktree): ${work}`);
  let run = args.run.replace(/\/?$/, '/');
  if (args.run === 'latest') {
    // Newest good run via the status file the job maintains (lastSuccess is only ever a good run).
    getObject('d1/status.json', join(work, 'status.json'));
    const s = JSON.parse(readFileSync(join(work, 'status.json'), 'utf8')) as { lastSuccess?: { key?: string } };
    if (!s.lastSuccess?.key) throw new Error('no good backup recorded in d1/status.json');
    run = s.lastSuccess.key.replace(/dump\.sql\.gz$/, '');
  }
  if (!/^d1\/\d{4}\/\d{2}\/\d{2}\/\d{6}Z\/$/.test(run)) throw new Error(`bad --run ${args.run}`);

  getObject(`${run}manifest.json`, join(work, 'manifest.json'));
  getObject(`${run}dump.sql.gz`, join(work, 'dump.sql.gz'));
  const manifest = readManifest(join(work, 'manifest.json'));
  if (!manifest.consistent && !args['allow-inconsistent']) {
    throw new Error(`run ${manifest.runId} is marked INCONSISTENT (writes during export): it may not load. Pick another run, or pass --allow-inconsistent knowingly.`);
  }

  // 1. integrity BEFORE loading; keep exactly the verified bytes.
  const dump = checkDump(join(work, 'dump.sql.gz'), manifest);
  if (!dump.ok) throw new Error(`dump rejected: ${dump.reason}`);
  const sqlFile = join(work, 'dump.sql');
  writeFileSync(sqlFile, dump.raw, { mode: 0o600 });
  console.log(`dump sha256: OK (${manifest.runId}, ${manifest.tables.length} tables, schema ${manifest.schemaVersion})`);

  // 2. load into the NEW database.
  const targetPersist = resolve(args['target-persist-to'] ?? join(work, 'restored-state'));
  const cfg = join(work, 'wrangler.json');
  writeFileSync(
    cfg,
    JSON.stringify({
      name: 'hb-restore',
      compatibility_date: '2026-11-01',
      d1_databases: [
        { binding: 'DB', database_name: args.target, database_id: args['target-id'] ?? `local-${args.target}`, ...(args.remote ? { remote: true } : {}) },
      ],
    }),
  );
  const target = args.remote ? ['--remote'] : ['--local', '--persist-to', targetPersist];
  wrangler(['d1', 'execute', args.target, '--file', sqlFile, '--yes', ...target, '-c', cfg], 'load');
  console.log(`loaded into ${args.target} (${args.remote ? 'remote' : `local ${targetPersist}`})`);

  // 3. verify what is now in the database.
  const proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: cfg,
    ...(args.remote ? {} : { persist: { path: join(targetPersist, 'v3') } }),
  });
  try {
    exitCode = (await verifyDatabase(proxy.env.DB, manifest)) ? 0 : 1;
  } finally {
    await proxy.dispose();
  }
  if (exitCode === 0) {
    console.log(`\nNext (RESTORE.md §3 steps 5–8): point the DB binding of apps/web, apps/admin and apps/jobs at ${args.target}${args['target-id'] ? ` (${args['target-id']})` : ''} and deploy; delete unused restore databases.`);
  }
} catch (err) {
  console.error(`restore: ${(err as Error).message}`);
  exitCode = 1;
} finally {
  if (args.keep) {
    console.log(`kept (0700): ${work}. It holds customer personal data: delete it when done (rm -rf "${work}").`);
  } else {
    rmSync(work, { recursive: true, force: true });
    console.log(`deleted ${work}`);
  }
}
process.exit(exitCode);
