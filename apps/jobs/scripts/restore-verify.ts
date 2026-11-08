// Verifies a backup dump, and optionally a restored D1, against its manifest (JOBS-1).
// The full operator flow is scripts/restore.ts; this is the standalone check. See ../RESTORE.md.
//
//   npm run restore:verify -w @hb/jobs -- --manifest <file> --dump <dump.sql.gz> --dump-only
//   npm run restore:verify -w @hb/jobs -- --manifest <file> --dump <dump.sql.gz> --persist-to <dir>
//   … --remote --database <name> --database-id <id>   (operator only: needs `wrangler login`)
//
// Every path must be OUTSIDE any git worktree (backups hold customer personal data).
// Exit 0 = verified; 1 = mismatch; 2 = usage/refused. Prints table names, counts and hashes only.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getPlatformProxy } from 'wrangler';
import { checkDump, readManifest } from './lib/dump.ts';
import { verifyDatabase } from './lib/verify-db.ts';
import { assertOutsideGitWorktree } from './lib/private-dir.ts';

const { values: args } = parseArgs({
  options: {
    manifest: { type: 'string' },
    dump: { type: 'string' },
    'dump-only': { type: 'boolean', default: false },
    'persist-to': { type: 'string' },
    database: { type: 'string', default: 'hb-restore' },
    'database-id': { type: 'string', default: 'local-hb-restore' },
    remote: { type: 'boolean', default: false },
  },
});

function usage(msg: string): never {
  console.error(`restore-verify: ${msg}`);
  console.error('usage: --manifest <file> --dump <dump.sql.gz> (--dump-only | --persist-to <dir> | --remote --database <name> --database-id <id>)');
  process.exit(2);
}

if (!args.manifest || !args.dump) usage('--manifest and --dump are required');
if (!args['dump-only'] && !args.remote && !args['persist-to']) usage('say where the restored database is (--persist-to or --remote), or --dump-only');
try {
  assertOutsideGitWorktree(args.manifest, '--manifest');
  assertOutsideGitWorktree(args.dump, '--dump');
  if (args['persist-to']) assertOutsideGitWorktree(args['persist-to'], '--persist-to');
} catch (err) {
  usage((err as Error).message);
}

const manifest = readManifest(resolve(args.manifest));
const dump = checkDump(resolve(args.dump), manifest);
console.log(`dump sha256: ${dump.ok ? 'OK' : `MISMATCH (${dump.reason})`} (${manifest.runId})`);
if (!manifest.consistent) console.log('WARNING: this run is marked INCONSISTENT: it may not load. Prefer another run.');
if (!dump.ok) process.exit(1);
if (args['dump-only']) process.exit(manifest.consistent ? 0 : 1);

const dir = mkdtempSync(join(tmpdir(), 'hb-restore-verify-'));
const cfg = join(dir, 'wrangler.json');
writeFileSync(
  cfg,
  JSON.stringify({
    name: 'hb-restore-verify',
    compatibility_date: '2026-11-01',
    d1_databases: [{ binding: 'DB', database_name: args.database, database_id: args['database-id'], ...(args.remote ? { remote: true } : {}) }],
  }),
);
// wrangler --persist-to X keeps local state in X/v3.
const proxy = await getPlatformProxy<{ DB: D1Database }>({
  configPath: cfg,
  ...(args['persist-to'] ? { persist: { path: join(resolve(args['persist-to']), 'v3') } } : {}),
});
let ok = false;
try {
  ok = await verifyDatabase(proxy.env.DB, manifest);
} finally {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
