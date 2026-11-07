/**
 * The catalogue pre-build step (runs before `astro build`): images (CAT-4), then search indexes and
 * per-wilaya commune files (CAT-5), into the storefront's static root.
 *
 *   HB_SNAPSHOT=<seed|path to export JSON> HB_SITE_ORIGIN=https://… /tmp/hb-locks/heavy.sh node packages/catalog/src/bin/catalog.ts \
 *     --out apps/storefront/public --manifest apps/storefront/.catalog/image-manifest.json \
 *     [--originals <dir>] [--cache <dir>] [--images-report <file>] [--assets-report <file>] \
 *     [--repo-root <dir>]
 *
 * Writes <out>/img/*, <out>/search/{ar,fr}.json, <out>/geo/communes/{ar,fr}/<code>.json,
 * <out>/sitemap.xml, <out>/robots.txt (CAT-6) and the image manifest. The origin comes from
 * HB_SITE_ORIGIN, the same variable the pages use (required; --site-url may only repeat it).
 * With HB_SNAPSHOT=fixture no image is encoded (the fixture has no photos): the manifest is the
 * stub (stub: true, URLs only) and everything else is written as usual. geo's modules are loaded from <repo-root>/data/geo/. There is no partial mode:
 * the snapshot, geo data and brand copy must all be complete (HB_SNAPSHOT_PARTIAL is refused
 * except with HB_SNAPSHOT=fixture).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { assetsMarkdown, loadGeoModules, writeCatalogAssets } from '../assets.ts';
import { createBuildContext } from '../build.ts';
import { buildSitemap, robotsTxt, ROBOTS_PATH, SITEMAP_PATH, sitemapXml } from '../seo.ts';
import { stubImageManifest } from '../image-stub.ts';
import { buildImages, dirOriginalReader, seedOriginalReader, sizesMarkdown, type ImagePipelineResult } from '../images.ts';
import { findRepoRoot, loadSnapshot, loadStrings, siteOriginFromEnv } from '../sources.ts';

const { values: a } = parseArgs({
  options: {
    'repo-root': { type: 'string' },
    out: { type: 'string' },
    manifest: { type: 'string' },
    cache: { type: 'string' },
    originals: { type: 'string' },
    'images-report': { type: 'string' },
    'assets-report': { type: 'string' },
    'site-url': { type: 'string' },
  },
});
if (!a.out || !a.manifest) {
  console.error('usage: catalog.ts --out <site root> --manifest <file> [--originals dir] [--cache dir] [--images-report f] [--assets-report f] [--site-url u] [--repo-root d]');
  process.exit(2);
}

// One origin for pages and sitemap/robots: HB_SITE_ORIGIN via siteOriginFromEnv (the function
// shell's build uses too). No silent default except with HB_SNAPSHOT=fixture. --site-url may only
// repeat it.
let siteUrl: string;
try {
  siteUrl = siteOriginFromEnv();
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}
const flagOrigin = a['site-url']?.replace(/\/+$/, '');
if (flagOrigin !== undefined && flagOrigin !== siteUrl) {
  console.error(`--site-url ${flagOrigin} disagrees with HB_SITE_ORIGIN (${siteUrl})`);
  process.exit(2);
}

const repoRoot = resolve(a['repo-root'] ?? findRepoRoot(process.cwd()));
const out = resolve(a.out);
const snapshot = await loadSnapshot({ repoRoot });
if (snapshot.meta.source === 'd1' && !a.originals) {
  console.error('d1 snapshots need --originals <dir>: the R2 objects copied to a directory under their keys');
  process.exit(2);
}

const t0 = performance.now();
// The fixture has no photo files: dev/test builds get a stub manifest (URLs, no encoded files) and
// still get search indexes, commune files, sitemap and robots.
const images: ImagePipelineResult =
  snapshot.meta.source === 'fixture'
    ? { manifest: stubImageManifest(snapshot), report: [], warnings: [] }
    : await buildImages(snapshot, {
        outDir: out,
        cacheDir: resolve(a.cache ?? `${repoRoot}/node_modules/.cache/hb-catalog-images`),
        readOriginal: a.originals ? dirOriginalReader(resolve(a.originals)) : seedOriginalReader(repoRoot),
      });
for (const w of images.warnings) console.warn(`warning: ${w.message}`);
const tImages = performance.now();
await mkdir(dirname(resolve(a.manifest)), { recursive: true });
await writeFile(resolve(a.manifest), JSON.stringify(images.manifest, null, 2) + '\n');

const strings = await loadStrings(repoRoot);
const ctx = createBuildContext(snapshot, { siteUrl, strings, images: images.manifest });
const { folding, geo } = await loadGeoModules(repoRoot);
const assets = await writeCatalogAssets(ctx, { outDir: out, folding, geo });
const sitemap = buildSitemap(ctx);
await writeFile(join(out, SITEMAP_PATH), sitemapXml(sitemap));
await writeFile(join(out, ROBOTS_PATH), robotsTxt(ctx.siteUrl));
const tEnd = performance.now();

const secs = (ms: number): string => (ms / 1000).toFixed(1);
const cached = images.report.filter((r) => r.cached).length;
if (a['images-report']) {
  await mkdir(dirname(resolve(a['images-report'])), { recursive: true });
  await writeFile(resolve(a['images-report']), sizesMarkdown(images) + `\nRun: ${images.report.length} images (${cached} from cache) in ${secs(tImages - t0)} s.\n`);
}
if (a['assets-report']) {
  await mkdir(dirname(resolve(a['assets-report'])), { recursive: true });
  await writeFile(resolve(a['assets-report']), assetsMarkdown(assets, ctx.products.length) + `\nRun: search + geo assets in ${secs(tEnd - tImages)} s, snapshot source ${snapshot.meta.source}.\n`);
}
console.log(
  `catalog: ${images.report.length} images (${cached} cached) in ${secs(tImages - t0)} s; ` +
    `search ar ${assets.search.ar.br} B br / fr ${assets.search.fr.br} B br; ` +
    `${assets.communes.ar.length} commune files per language in ${secs(tEnd - tImages)} s; sitemap ${sitemap.length} URLs`,
);
