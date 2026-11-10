// The publish export for an end-to-end run (MSET-6): local D1 -> snapshot, exactly as the publish does
// (@hb/db/export exportCatalogSnapshot), written to <out>/d1-export.json. The site is then built from
// <out>/snapshot.json = the seed snapshot with its `settings` REPLACED by the exported settings: the
// catalogue rows are the same seed either way, and a `seed` source lets the build read photo originals
// from data/photos instead of a local R2 copy.
//   node tests/e2e/meta-export.ts <persist-dir> <out-dir>
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformProxy } from 'wrangler';
import { fromSeed, findRepoRoot } from '@hb/catalog/sources';
import { createDb } from '@hb/db';
import { exportCatalogSnapshot } from '@hb/db/export';

const [persist, out] = process.argv.slice(2);
if (!persist || !out) throw new Error('usage: meta-export.ts <persist-dir> <out-dir>');
const root = findRepoRoot(fileURLToPath(new URL('.', import.meta.url)));
const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: join(root, 'packages/db/wrangler.jsonc'), persist: { path: join(resolve(persist), 'v3') }, remoteBindings: false });
try {
  const exported = await exportCatalogSnapshot(createDb(proxy.env.DB));
  writeFileSync(join(out, 'd1-export.json'), JSON.stringify(exported));
  const seed = await fromSeed(root);
  writeFileSync(join(out, 'snapshot.json'), JSON.stringify({ ...seed, settings: exported.settings }));
  console.log(`export: settings.metaPixel = ${JSON.stringify(exported.settings.metaPixel)}`);
} finally {
  await proxy.dispose();
}
