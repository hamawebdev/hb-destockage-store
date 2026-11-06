// DB-3: `npm run seed -w @hb/db [-- --root <repo> --persist-to <dir> --no-photos]`
//
// Loads data/ into the shared LOCAL D1 (and data/photos into local R2) of this worktree:
//   1. validates the seed catalogue (data/catalog/validate.mjs); exits 1 on any issue;
//   2. applies migrations: wrangler d1 migrations apply hb-destockage --local --persist-to <dir>;
//   3. upserts every row (idempotent: re-running updates in place, never touches orders);
//   4. uploads every referenced photo to R2 bucket hb-media (binding MEDIA) under its key.
// Default persist dir: <worktree>/.wrangler/hb-local, the path web, admin, jobs and e2e use
// (packages/db/wrangler.jsonc). Development only: never run against a remote database.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildSeedStatements, referencedImageKeys } from './build.ts';
import { databaseIdFromWranglerJsonc, seedRefusals } from './guard.ts';
import { loadSeedInput, SeedValidationError } from './load.ts';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const configPath = join(pkgDir, 'wrangler.jsonc');
const BATCH = 200;

interface D1Like {
  prepare(sql: string): { bind(...v: unknown[]): unknown; first<T>(): Promise<T | null> };
  batch(stmts: unknown[]): Promise<unknown>;
}
interface R2Like {
  put(key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

const CONTENT_TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif' };

async function main(): Promise<number> {
  const refusals = seedRefusals({
    argv: process.argv.slice(2),
    env: process.env,
    databaseId: databaseIdFromWranglerJsonc(readFileSync(configPath, 'utf8')),
  });
  if (refusals.length > 0) {
    console.error(`seed: REFUSED. The seed writes invented data and only targets the local D1:\n  - ${refusals.join('\n  - ')}`);
    return 2;
  }
  const { values } = parseArgs({
    options: {
      root: { type: 'string', default: resolve(pkgDir, '..', '..') },
      'persist-to': { type: 'string', default: resolve(pkgDir, '..', '..', '.wrangler', 'hb-local') },
      'no-photos': { type: 'boolean', default: false },
    },
  });
  const root = resolve(values.root);
  const persist = resolve(values['persist-to']);
  const t0 = Date.now();

  let loaded;
  try {
    loaded = await loadSeedInput(root);
  } catch (e) {
    if (e instanceof SeedValidationError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
  const { input, photosDir } = loaded;
  console.log(`seed: root ${root}`);
  console.log(`seed: persist ${persist}`);

  const bin = resolveWranglerBin(join(pkgDir, 'node_modules', '.bin', 'wrangler'));
  const mig = spawnSync(bin, ['d1', 'migrations', 'apply', 'hb-destockage', '--local', '--persist-to', persist, '--config', configPath], {
    env: { ...process.env, CI: '1' },
    encoding: 'utf8',
  });
  if (mig.status !== 0) {
    console.error(mig.stdout, mig.stderr);
    return 1;
  }
  console.log('seed: migrations applied');

  const { getPlatformProxy } = await import('wrangler');
  const proxy = await getPlatformProxy<{ DB: D1Like; MEDIA: R2Like }>({ configPath, persist: { path: join(persist, 'v3') } });
  try {
    const db = proxy.env.DB;
    const statements = buildSeedStatements(input);
    for (let i = 0; i < statements.length; i += BATCH) {
      await db.batch(statements.slice(i, i + BATCH).map((s) => db.prepare(s.sql).bind(...s.params)));
    }
    console.log(`seed: ${statements.length} statements`);

    if (!values['no-photos']) {
      const keys = referencedImageKeys(input);
      for (const key of keys) {
        const bytes = readFileSync(join(photosDir, key));
        await proxy.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: CONTENT_TYPES[extname(key).toLowerCase()] ?? 'application/octet-stream' } });
      }
      console.log(`seed: ${keys.length} photos in R2 hb-media`);
    }

    for (const t of ['wilayas', 'communes', 'delivery_fees', 'categories', 'products', 'variants', 'images', 'pack_items', 'content_pages', 'settings', 'admin_users']) {
      const r = await db.prepare(`SELECT count(*) AS n FROM "${t}"`).first<{ n: number }>();
      console.log(`seed: ${t.padEnd(14)} ${r?.n}`);
    }
  } finally {
    await proxy.dispose();
  }
  console.log(`seed: done in ${Date.now() - t0} ms`);
  return 0;
}

/** node_modules/.bin may live in the package or be hoisted to the repo root. */
function resolveWranglerBin(local: string): string {
  for (const candidate of [local, resolve(pkgDir, '..', '..', 'node_modules', '.bin', 'wrangler')]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return 'wrangler';
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
