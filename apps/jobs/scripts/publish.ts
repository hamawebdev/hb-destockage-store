// `npm run publish -w @hb/jobs` — local publish pipeline (JOBS-3). Never deploys.
//
//   npm run publish -w @hb/jobs -- --site-origin https://<domain> [--enqueue] [--source d1|seed]
//                                  [--persist-to <dir>] [--strict-copy] [--image-cache <dir>]
// --site-origin (or env HB_SITE_ORIGIN) is required: canonical/hreflang/og URLs and the catalogue
// build need the absolute origin.
//
// Picks queued publish_runs from the local D1 (as the admin's Publish button leaves them) and,
// for each one:
//   export    D1 → snapshot JSON (@hb/db/export exportCatalogSnapshot, DB-5), validated by
//             @hb/catalog/sources fromExport. `--source seed` uses fromSeed(data/) instead, until
//             DB-5 lands (the run is still claimed/recorded in D1).
//   originals copy each image original the snapshot references from local R2 MEDIA (fallback
//             data/photos) into a temp dir, by key.
//   catalog   pagedata's pre-build (CAT-4/5, packages/catalog/src/bin/catalog.ts): AVIF variants +
//             image manifest (content-hash cache), search indexes, per-wilaya commune JSON.
//   astro     npm run build -w @hb/storefront, HB_SNAPSHOT=<snapshot>.
//   budget    npm run budget: static-only for content-only changes, full otherwise (JOBS-7, D-003).
// Then records status, timings_json, budget_ok, error and log_tail on the run and prints the
// deploy command it would run. Heavy: run it under /tmp/hb-locks/heavy.sh on the shared machine.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { getPlatformProxy } from 'wrangler';
import { runPublishQueue, StageError, type PublishStages, type SnapshotResult } from '../src/publish/pipeline.ts';
import { budgetWithMode } from '../src/publish/budget-stage.ts';
import { enqueueRun } from '../src/publish/runs.ts';
import { budgetVerdict, buildFingerprint, LAST_GOOD_FILE } from './lib/fingerprint.ts';
import { containedPath } from './lib/private-dir.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// The repo's pinned wrangler, as in RESTORE.md (JOBS-3 review nit), never a global npx.
export const DEPLOY_COMMAND = './node_modules/.bin/wrangler deploy -c apps/web/wrangler.jsonc';

const { values: args } = parseArgs({
  options: {
    enqueue: { type: 'boolean', default: false },
    source: { type: 'string', default: 'd1' },
    'persist-to': { type: 'string', default: join(REPO, '.wrangler/hb-local') },
    'site-origin': { type: 'string' },
    'strict-copy': { type: 'boolean', default: false },
    'image-cache': { type: 'string' },
    'skip-catalog': { type: 'boolean', default: false },
  },
});
if (args.source !== 'd1' && args.source !== 'seed') {
  console.error('--source must be d1 or seed');
  process.exit(2);
}
const siteOrigin = args['site-origin'] ?? process.env['HB_SITE_ORIGIN'];
if (!siteOrigin || !/^https:\/\/[a-z0-9.-]+$/i.test(siteOrigin)) {
  console.error('--site-origin https://<domain> (or HB_SITE_ORIGIN) is required, absolute, no trailing slash');
  process.exit(2);
}

/** A command that exited non-zero: its exit code and last output line (never the command line). */
class CommandError extends StageError {
  readonly exitCode: number | null;
  constructor(stage: string, exitCode: number | null, lastLine: string) {
    super(stage, `${stage} exited ${exitCode}${lastLine ? `: ${lastLine}` : ''}`);
    this.exitCode = exitCode;
  }
}

/** Runs a command, streaming its output into the run log; rejects on non-zero exit. */
function run(stage: string, cmd: string, argv: string[], env: Record<string, string>, log: (l: string) => void): Promise<string> {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, argv, { cwd: REPO, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const onData = (b: Buffer) => {
      const text = b.toString('utf8');
      out += text;
      for (const line of text.split('\n')) if (line.trim()) log(line);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => fail(new StageError(stage, e.message)));
    child.on('close', (code) => (code === 0 ? ok(out) : fail(new CommandError(stage, code, lastLine(out)))));
  });
}

/** Dynamic import of a contract module that may not have landed yet on this branch. */
async function contract<T>(specifier: string, task: string): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch {
    throw new Error(`${specifier} not available yet (${task})`);
  }
}

const persistTo = resolve(args['persist-to']!);
const workRoot = join(REPO, '.wrangler/publish');
const cfgDir = await mkdtemp(join(tmpdir(), 'hb-publish-'));
const cfg = join(cfgDir, 'wrangler.json');
await writeFile(
  cfg,
  JSON.stringify({
    name: 'hb-publish',
    compatibility_date: '2026-11-01',
    // Repo convention (packages/db/wrangler.jsonc): same local D1 and R2 as admin and seed.
    d1_databases: [{ binding: 'DB', database_name: 'hb-destockage', database_id: '00000000-0000-4000-8000-000000000d1b' }],
    r2_buckets: [{ binding: 'MEDIA', bucket_name: 'hb-media' }],
  }),
);
const proxy = await getPlatformProxy<{ DB: D1Database; MEDIA: R2Bucket }>({ configPath: cfg, persist: { path: join(persistTo, 'v3') } });

const stages: PublishStages = {
  async exportSnapshot(runId, log): Promise<SnapshotResult> {
    const dir = join(workRoot, String(runId));
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'snapshot.json');
    let snapshot: { products: unknown[] };
    if (args.source === 'seed') {
      log('source: seed (data/) — D1 export arrives with DB-5');
      const { fromSeed } = await contract<{ fromSeed: (root: string) => Promise<{ products: unknown[] }> }>('@hb/catalog/sources', 'CAT-2');
      snapshot = await fromSeed(REPO);
    } else {
      const { exportCatalogSnapshot } = await contract<{
        exportCatalogSnapshot: (db: D1Database, o: { publishRunId: number }) => Promise<{ products: unknown[] }>;
      }>('@hb/db/export', 'DB-5');
      snapshot = await exportCatalogSnapshot(proxy.env.DB, { publishRunId: runId });
    }
    const text = JSON.stringify(snapshot);
    await writeFile(file, text);
    const { fromExport } = await contract<{ fromExport: (f: string) => Promise<unknown> }>('@hb/catalog/sources', 'CAT-2');
    await fromExport(file); // strict validation (69 wilayas, integrity); throws with the offending path
    return { file, sha256: createHash('sha256').update(text).digest('hex'), productCount: snapshot.products.length };
  },

  async build(snapshot, log) {
    const timings: Record<string, number> = {};
    const env: Record<string, string> = { HB_SNAPSHOT: snapshot.file, HB_SITE_ORIGIN: siteOrigin };
    if (args['strict-copy']) env['HB_STRICT_COPY'] = '1';

    if (!args['skip-catalog']) {
      let t = Date.now();
      const originals = await mkdtemp(join(tmpdir(), 'hb-originals-'));
      try {
        const n = await copyOriginals(snapshot.file, originals, log);
        timings['originalsMs'] = Date.now() - t;
        log(`originals: ${n} files`);
        t = Date.now();
        await run(
          'catalog',
          process.execPath,
          [
            'packages/catalog/src/bin/catalog.ts',
            '--out', 'apps/storefront/public',
            '--manifest', 'apps/storefront/.catalog/image-manifest.json',
            '--originals', originals,
            ...(args['image-cache'] ? ['--cache', resolve(args['image-cache'])] : []),
            '--site-url', siteOrigin,
          ],
          env,
          log,
        );
        timings['catalogMs'] = Date.now() - t;
      } finally {
        await rm(originals, { recursive: true, force: true });
      }
    }
    const t = Date.now();
    await run('astro', 'npm', ['run', 'build', '-w', '@hb/storefront'], env, log);
    timings['astroMs'] = Date.now() - t;
    return timings;
  },

  async budget(snapshot, log) {
    // JOBS-7 (D-003): static-only for content-only changes, full for any image or template/code
    // change, decided from this build's fingerprint vs the last good build's. Both BLOCKING.
    // measure's contract: exit 0 pass, 1 violations, 2 usage/internal error; verdict = last line
    // of <out>/budget.txt.
    const out = join(dirname(snapshot.file), 'budget');
    const runId = Number(dirname(snapshot.file).split('/').at(-1));
    return budgetWithMode(
      {
        readLastGood: async () => (existsSync(LAST_GOOD_FILE) ? readFile(LAST_GOOD_FILE, 'utf8') : null),
        writeLastGood: async (text) => {
          await mkdir(dirname(LAST_GOOD_FILE), { recursive: true });
          const tmp = `${LAST_GOOD_FILE}.${process.pid}.tmp`;
          await writeFile(tmp, text);
          await rename(tmp, LAST_GOOD_FILE); // atomic: a crash never leaves a half-written file
        },
        fingerprint: async () => buildFingerprint(REPO, join(REPO, 'apps/storefront/.catalog/image-manifest.json')),
        runBudget: async (staticOnly) => {
          let exitCode: number | null = 0;
          try {
            await run('budget', 'npm', ['run', 'budget', '--', '--out', out, ...(staticOnly ? ['--static-only'] : [])], {}, log);
          } catch (err) {
            if (!(err instanceof CommandError)) throw err;
            exitCode = err.exitCode;
          }
          const verdict = existsSync(join(out, 'budget.txt')) ? budgetVerdict(await readFile(join(out, 'budget.txt'), 'utf8')) : '(no budget.txt)';
          return { exitCode, verdict };
        },
      },
      log,
      runId,
      Date.now,
    );
  },
};

function lastLine(s: string): string {
  return s.trim().split('\n').filter(Boolean).at(-1) ?? '';
}

/** Copies every image original the snapshot references (by key) from local R2, else data/photos. */
async function copyOriginals(snapshotFile: string, dir: string, log: (l: string) => void): Promise<number> {
  const keys = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if ((k === 'key' || k === 'r2Key') && typeof x === 'string' && /\.(jpe?g|png|webp|avif)$/i.test(x)) keys.add(x);
        else walk(x);
      }
    }
  };
  walk(JSON.parse(await readFile(snapshotFile, 'utf8')));
  let missing = 0;
  for (const key of keys) {
    // Refuse keys that would escape the temp dir or data/photos, before any read or write.
    const dest = containedPath(dir, key);
    const seeded = containedPath(join(REPO, 'data/photos'), key);
    if (!dest || !seeded) throw new StageError('originals', 'image key outside the originals directory refused (absolute or ".." path)');
    await mkdir(dirname(dest), { recursive: true });
    const obj = await proxy.env.MEDIA.get(key);
    if (obj) {
      await writeFile(dest, new Uint8Array(await obj.arrayBuffer()));
    } else if (existsSync(seeded)) {
      await copyFile(seeded, dest);
    } else {
      missing++;
    }
  }
  if (missing) log(`originals: ${missing} key(s) not found in R2 MEDIA or data/photos`);
  return keys.size - missing;
}

let exitCode = 0;
try {
  if (args.enqueue) {
    const id = await enqueueRun(proxy.env.DB);
    console.log(id === null ? 'enqueue: a run is already queued or running' : `enqueued publish run #${id}`);
  }
  const results = await runPublishQueue(proxy.env.DB, stages, { deployCommand: DEPLOY_COMMAND, onLog: (l) => console.log(l) });
  if (results.length === 0) console.log('no queued publish run');
  for (const r of results) {
    console.log(`run #${r.id}: ${r.status}${r.error ? ` (${r.error})` : ''} in ${r.timings['totalMs']} ms ${JSON.stringify(r.timings)}`);
    if (r.status === 'succeeded') console.log(`\nDeploy (not run here; the client deploys):\n  ${DEPLOY_COMMAND}\n`);
    if (r.status !== 'succeeded') exitCode = 1;
  }
} finally {
  await proxy.dispose();
  await rm(cfgDir, { recursive: true, force: true });
}
process.exit(exitCode);
