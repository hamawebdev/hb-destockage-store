/**
 * CAT-4 CLI: encode every image of a snapshot and write the manifest the page-props builders read.
 *
 *   HB_SNAPSHOT=seed node packages/catalog/src/bin/images.ts \
 *     --out apps/storefront/public --manifest apps/storefront/.catalog/image-manifest.json \
 *     [--cache node_modules/.cache/hb-catalog-images] [--report artifacts/CAT-4/sizes.md] \
 *     [--repo-root <dir>] [--originals <dir>] [--threads 2] [--concurrency 2]
 *
 * Originals are read from `--originals <dir>` by key (`<dir>/<SnapshotImage.key>`), default
 * `<repo-root>/data/photos/`. For a `d1` export the publish pipeline first copies the R2 objects
 * into a directory under the same keys and passes it here (required for `d1`).
 * Run it under /tmp/hb-locks/heavy.sh on the shared machine.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildImages, dirOriginalReader, seedOriginalReader, sizesMarkdown } from '../images.ts';
import { findRepoRoot, loadSnapshot } from '../sources.ts';

const { values: a } = parseArgs({
  options: {
    'repo-root': { type: 'string' },
    out: { type: 'string' },
    manifest: { type: 'string' },
    cache: { type: 'string' },
    report: { type: 'string' },
    originals: { type: 'string' },
    threads: { type: 'string', default: '2' },
    concurrency: { type: 'string', default: '2' },
  },
});

if (!a.out || !a.manifest) {
  console.error('usage: images.ts --out <site root> --manifest <file> [--cache dir] [--report file] [--repo-root dir]');
  process.exit(2);
}

const repoRoot = resolve(a['repo-root'] ?? findRepoRoot(process.cwd()));
const snapshot = await loadSnapshot({ repoRoot });
if (snapshot.meta.source === 'd1' && !a.originals) {
  console.error('d1 snapshots need --originals <dir>: the R2 objects copied to a directory under their keys');
  process.exit(2);
}

const t0 = performance.now();
const result = await buildImages(snapshot, {
  outDir: resolve(a.out),
  cacheDir: resolve(a.cache ?? `${repoRoot}/node_modules/.cache/hb-catalog-images`),
  readOriginal: a.originals ? dirOriginalReader(resolve(a.originals)) : seedOriginalReader(repoRoot),
  threads: Number(a.threads),
  concurrency: Number(a.concurrency),
});
const seconds = ((performance.now() - t0) / 1000).toFixed(1);

await mkdir(dirname(resolve(a.manifest)), { recursive: true });
await writeFile(resolve(a.manifest), JSON.stringify(result.manifest, null, 2) + '\n');
if (a.report) {
  await mkdir(dirname(resolve(a.report)), { recursive: true });
  const cached = result.report.filter((r) => r.cached).length;
  await writeFile(
    resolve(a.report),
    sizesMarkdown(result) + `\nRun: ${result.report.length} images (${cached} from cache) in ${seconds} s, snapshot source ${snapshot.meta.source}.\n`,
  );
}
console.log(`images: ${result.report.length} (${result.report.filter((r) => r.cached).length} cached) in ${seconds} s → ${a.manifest}`);
