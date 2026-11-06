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
//   node apps/jobs/scripts/restore.ts --orders-since 2026-11-04T08:00:00Z --from-sql <file.sql[.gz]>
//   Lists every order created at or after that time in an SQL copy of the database (a `wrangler d1
//   export` taken before a Time Travel restore, or a backup dump), with customer, wilaya, commune,
//   address and items, so staff can re-enter them (RESTORE.md §2). The copy is loaded into a
//   throw-away local D1 in the private folder with the repo's pinned wrangler and its own config.
//   The output contains personal data: print it for staff, do not paste it into chat.
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
import { gunzipSync } from 'node:zlib';
import { orderDumpSchemaFirst } from '@hb/db/backup';
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
    'orders-since': { type: 'string' },
    'from-sql': { type: 'string' },
  },
});

// Ctrl-C / kill must not leave customer data behind (review r2): the private folder is removed on
// SIGINT, SIGTERM and SIGHUP as well as on normal exit.
let removeWork: (() => void) | null = null;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => {
    removeWork?.();
    console.error(`restore: interrupted (${sig}); private folder removed`);
    process.exit(130);
  });
}

function die(msg: string, code = 2): never {
  console.error(`restore: ${msg}`);
  process.exit(code);
}

if (args['orders-since'] !== undefined) {
  const since = Date.parse(args['orders-since']);
  if (!args['from-sql'] || Number.isNaN(since)) die('--orders-since <ISO time> needs --from-sql <file.sql[.gz]>');
  try {
    assertOutsideGitWorktree(args['from-sql'], '--from-sql');
  } catch (err) {
    die((err as Error).message);
  }
  process.exit(await ordersSince(since, resolve(args['from-sql'])));
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
  if (r.status !== 0) {
    // wrangler prints the cause (✘ [ERROR] …) on stdout or stderr; the last lines are often only
    // the log-file path. Prefer the error lines.
    const lines = `${r.stdout}\n${r.stderr}`.split('\n').map((l) => l.trim()).filter(Boolean);
    const errors = lines.filter((l) => /error|✘|no such|constraint|failed/i.test(l) && !/logs were written/i.test(l));
    throw new Error(`${what} failed (wrangler exit ${r.status}): ${(errors.length ? errors : lines).slice(-3).join(' | ')}`);
  }
  return r.stdout;
}

const source = args['source-remote'] ? ['--remote'] : ['--local', '--persist-to', resolve(args['source-persist-to']!)];
const getObject = (key: string, file: string) =>
  wrangler(['r2', 'object', 'get', `${BUCKET}/${key}`, '--file', file, ...source, '-c', join(APP, 'wrangler.jsonc')], `download ${key}`);

// From here on, never process.exit() before the finally: the work dir must be cleaned up.
const work = await makePrivateDir(args.run === 'latest' ? 'latest' : args.run.replace(/^d1\//, ''));
removeWork = () => rmSync(work, { recursive: true, force: true });
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

interface OrderRow {
  id: number;
  ref: string;
  created_at: number;
  status: string;
  name: string;
  phone_e164: string;
  wilaya_code: number;
  wilaya: string | null;
  commune_id: number;
  commune: string | null;
  address: string | null;
  lang: string;
  subtotal_dzd: number;
  fee_dzd: number;
  total_dzd: number;
  flags: string;
}

/** --orders-since mode: list complete orders from an SQL copy. Returns the exit code. */
async function ordersSince(since: number, fromSql: string): Promise<number> {
  const dir = await makePrivateDir('orders-since');
  removeWork = () => rmSync(dir, { recursive: true, force: true });
  try {
    let bytes = readFileSync(fromSql);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
    // A raw `wrangler d1 export` lists child INSERTs before their parent's CREATE TABLE and does
    // not load into a fresh D1 ("no such table: main.wilayas"; found by db). db's helper hoists every
    // CREATE TABLE first; a jobs backup dump is already in that order and passes through unchanged.
    const sqlFile = join(dir, 'copy.sql');
    writeFileSync(sqlFile, orderDumpSchemaFirst(bytes.toString('utf8')), { mode: 0o600 });
    const cfg = join(dir, 'wrangler.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        name: 'hb-orders-since',
        compatibility_date: '2026-11-01',
        d1_databases: [{ binding: 'DB', database_name: 'hb-scratch', database_id: 'local-hb-scratch' }],
      }),
    );
    const state = join(dir, 'state');
    wrangler(['d1', 'execute', 'hb-scratch', '--local', '--file', sqlFile, '--persist-to', state, '--yes', '-c', cfg], 'load copy');
    const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: cfg, persist: { path: join(state, 'v3') } });
    try {
      const db = proxy.env.DB;
      const orders = (
        await db
          .prepare(
            `SELECT o.id, o.ref, o.created_at, o.status, o.name, o.phone_e164, o.wilaya_code, w.name_fr AS wilaya,
                    o.commune_id, c.name_fr AS commune, o.address, o.lang, o.subtotal_dzd, o.fee_dzd, o.total_dzd, o.flags
               FROM orders o LEFT JOIN wilayas w ON w.code = o.wilaya_code LEFT JOIN communes c ON c.id = o.commune_id
              WHERE o.created_at >= ?1 ORDER BY o.created_at, o.id`,
          )
          .bind(since)
          .all<OrderRow>()
      ).results;
      console.log(`# Orders created since ${new Date(since).toISOString()} in ${fromSql}: ${orders.length}`);
      console.log('# PERSONAL DATA: for staff re-entry only. Do not paste into chat or email.\n');
      for (const o of orders) {
        const items = (
          await db
            .prepare(`SELECT qty, sku, name_fr, variant_label_fr, unit_price_dzd, line_total_dzd FROM order_items WHERE order_id = ?1 ORDER BY id`)
            .bind(o.id)
            .all<{ qty: number; sku: string; name_fr: string; variant_label_fr: string | null; unit_price_dzd: number; line_total_dzd: number }>()
        ).results;
        console.log(`${o.ref}  ${new Date(o.created_at).toISOString()}  status ${o.status}  lang ${o.lang}  flags ${o.flags}`);
        console.log(`  customer: ${o.name}  ${o.phone_e164}`);
        console.log(`  wilaya ${o.wilaya_code} ${o.wilaya ?? '?'}  commune ${o.commune_id} ${o.commune ?? '?'}  address: ${o.address ?? '(none)'}`);
        for (const i of items) {
          console.log(`  - ${i.qty} × ${i.name_fr}${i.variant_label_fr ? ` (${i.variant_label_fr})` : ''} [${i.sku}] ${i.unit_price_dzd} DZD = ${i.line_total_dzd} DZD`);
        }
        if (items.length === 0) console.log('  - (no items recorded)');
        console.log(`  subtotal ${o.subtotal_dzd} DZD + delivery ${o.fee_dzd} DZD = total ${o.total_dzd} DZD\n`);
      }
    } finally {
      await proxy.dispose();
    }
    return 0;
  } catch (err) {
    console.error(`restore: ${(err as Error).message}`);
    return 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    console.error(`deleted ${dir}`);
  }
}
