// Verifies a restored D1 against a backup manifest (JOBS-1). Operator procedure: ../RESTORE.md.
//
//   npm run restore:verify -w @hb/jobs -- --manifest manifest.json [--dump dump.sql.gz]
//       [--persist-to <dir>] [--database hb-restore] [--database-id <id>] [--remote]
//
// --dump        also checks the downloaded dump's sha256 (gzip and raw) against the manifest.
// --persist-to  wrangler's --persist-to directory of the local restore (default ./.wrangler/state).
// --remote      verify the restored database on Cloudflare (operator only: needs `wrangler login`
//               and --database-id; not exercised in this project, which never logs in).
// Exit 0 = every table, row count, digest and the schema version match; 1 = mismatch; 2 = usage.
// Prints table names, counts and digests only, never row data.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { getPlatformProxy } from 'wrangler';
import { verifyRestore, type VerifiableManifest } from '../src/backup/verify.ts';

const { values: args } = parseArgs({
  options: {
    manifest: { type: 'string' },
    dump: { type: 'string' },
    'persist-to': { type: 'string', default: '.wrangler/state' },
    database: { type: 'string', default: 'hb-restore' },
    'database-id': { type: 'string', default: 'local-hb-restore' },
    remote: { type: 'boolean', default: false },
  },
});

if (!args.manifest) {
  console.error('usage: restore-verify --manifest manifest.json [--dump dump.sql.gz] [--persist-to dir] [--database name] [--database-id id] [--remote]');
  process.exit(2);
}

interface Manifest extends VerifiableManifest {
  runId: string;
  object: { sha256: string; rawSha256: string };
}
const manifest = JSON.parse(readFileSync(resolve(args.manifest), 'utf8')) as Manifest;
let failed = false;

if (args.dump) {
  const gz = readFileSync(resolve(args.dump));
  const gzOk = createHash('sha256').update(gz).digest('hex') === manifest.object.sha256;
  const rawOk = gzOk && createHash('sha256').update(gunzipSync(gz)).digest('hex') === manifest.object.rawSha256;
  console.log(`dump sha256: ${gzOk && rawOk ? 'OK' : 'MISMATCH'} (${manifest.runId})`);
  failed ||= !(gzOk && rawOk);
}

const dir = mkdtempSync(join(tmpdir(), 'hb-restore-verify-'));
const cfg = join(dir, 'wrangler.json');
writeFileSync(
  cfg,
  JSON.stringify({
    name: 'hb-restore-verify',
    compatibility_date: '2026-11-01',
    d1_databases: [
      { binding: 'DB', database_name: args.database, database_id: args['database-id'], ...(args.remote ? { remote: true } : {}) },
    ],
  }),
);
// wrangler --persist-to X keeps local state in X/v3.
const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: cfg, persist: { path: join(resolve(args['persist-to']!), 'v3') } });
try {
  const r = await verifyRestore(proxy.env.DB, manifest);
  for (const t of manifest.tables) {
    const m = r.mismatches.find((x) => x.table === t.name);
    console.log(`${m ? 'MISMATCH' : 'ok      '} ${t.name} rows=${t.rows}${m ? ` actual=${JSON.stringify(m.actual)}` : ''}`);
  }
  for (const m of r.mismatches.filter((x) => !manifest.tables.some((t) => t.name === x.table))) {
    console.log(`MISMATCH ${m.table} expected=${JSON.stringify(m.expected)} actual=${JSON.stringify(m.actual)}`);
  }
  console.log(r.ok ? `RESTORE VERIFIED: ${manifest.tables.length} tables, schema ${manifest.schemaVersion}` : `RESTORE NOT VERIFIED: ${r.mismatches.length} mismatch(es)`);
  failed ||= !r.ok;
} finally {
  await proxy.dispose();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
