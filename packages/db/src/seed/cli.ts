// DB-3: `npm run seed -w @hb/db [-- --root <repo> --persist-to <dir> --no-photos]`
//
// Loads data/ into the shared LOCAL D1 (and data/photos into local R2) of this worktree:
//   1. validates the seed catalogue (data/catalog/validate.mjs); exits 1 on any issue;
//   2. applies migrations: wrangler d1 migrations apply hb-destockage --local --persist-to <dir>;
//   3. converges the catalogue to data/ in ONE batch: upserts every row and deletes the seeded
//      products' child rows (images, options, values, variants, pack items) that left data/;
//      refuses (exit 3, nothing written) if a variant to delete is referenced by an order line or a
//      pack outside data/. Never touches orders, customers, events or audit;
//   4. uploads every referenced photo to R2 bucket hb-media (binding MEDIA) under its key.
// Default persist dir: <worktree>/.wrangler/hb-local, the path web, admin, jobs and e2e use
// (packages/db/wrangler.jsonc). Development only: never run against a remote database.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { blockedVariantDeletionsQuery, buildCatalogueStatements, buildReferenceStatements, referencedImageKeys } from './build.ts';
import { databaseIdFromWranglerJsonc, seedRefusals } from './guard.ts';
import { loadSeedInput, SeedValidationError } from './load.ts';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const configPath = join(pkgDir, 'wrangler.jsonc');

interface D1Like {
  prepare(sql: string): { bind(...v: unknown[]): { all<T>(): Promise<{ results: T[] }> }; first<T>(): Promise<T | null> };
  batch(stmts: unknown[]): Promise<unknown>;
}
interface R2Like {
  put(key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

const CONTENT_TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif' };

async function main(): Promise<number> {
  const configText = readFileSync(configPath, 'utf8');
  const refusals = seedRefusals({
    argv: process.argv.slice(2),
    env: process.env,
    databaseId: databaseIdFromWranglerJsonc(configText),
    configText,
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
  // remoteBindings: false (defaults to true in wrangler): never connect a binding to Cloudflare.
  const proxy = await getPlatformProxy<{ DB: D1Like; MEDIA: R2Like }>({ configPath, persist: { path: join(persist, 'v3') }, remoteBindings: false });
  try {
    const db = proxy.env.DB;
    // DB-3 r3: refuse (and write nothing) when converging would delete a variant that an order line
    // or a pack outside data/ still references.
    const blocked: { id: number; sku: string; order_lines: number; other_packs: number }[] = [];
    for (const q of blockedVariantDeletionsQuery(input)) {
      blocked.push(...(await db.prepare(q.sql).bind(...q.params).all<(typeof blocked)[number]>()).results);
    }
    if (blocked.length > 0) {
      console.error(
        `seed: REFUSED. These variants are no longer in data/ but are still referenced; nothing was written:\n` +
          blocked.map((b) => `  - variant ${b.id} (${b.sku}): ${b.order_lines} order line(s), ${b.other_packs} pack(s) outside data/`).join('\n'),
      );
      return 3;
    }
    // Reference data: idempotent upserts in chunks. Catalogue: ONE batch = one transaction, so the
    // local catalogue converges to data/ completely or not at all.
    const reference = buildReferenceStatements(input);
    for (let i = 0; i < reference.length; i += 200) {
      await db.batch(reference.slice(i, i + 200).map((s) => db.prepare(s.sql).bind(...s.params)));
    }
    const catalogue = buildCatalogueStatements(input);
    await db.batch(catalogue.map((s) => db.prepare(s.sql).bind(...s.params)));
    console.log(`seed: ${reference.length} reference statements, ${catalogue.length} catalogue statements (one batch)`);

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
