/**
 * CAT-5 — writes the per-language search indexes and geo's commune files into the static output,
 * and measures them (Node only: '@hb/catalog/assets').
 *
 *  <outDir>/search/<lang>.json              SearchIndex (buildSearchIndex)
 *  <outDir>/geo/communes/<lang>/<code>.json geo's buildGeoAssets (GEO-3), one file per wilaya
 *
 * geo's modules are loaded from `<repoRoot>/data/geo/` at build time (search.mjs, build.mjs).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import type { BuildContext } from './build.ts';
import { communesPath, searchIndexPath } from './routes.ts';
import { buildSearchIndex, type SearchFolding } from './search.ts';
import { importFresh } from './sources.ts';
import { LANGS, type Lang, type WilayaOption } from './types.ts';

export interface GeoBuild {
  buildGeoAssets(outDir: string, opts: { lang: Lang }): Promise<{ wilayas: WilayaOption[]; files: string[] }>;
}

export async function loadGeoModules(repoRoot: string): Promise<{ folding: SearchFolding; geo: GeoBuild }> {
  const dir = resolve(repoRoot, 'data/geo');
  const folding = await importFresh<Partial<SearchFolding>>(join(dir, 'search.mjs'));
  const geo = await importFresh<Partial<GeoBuild>>(join(dir, 'build.mjs'));
  if (typeof folding.searchKey !== 'function' || typeof folding.normalizeForSearch !== 'function') {
    throw new Error(`${dir}/search.mjs must export searchKey and normalizeForSearch (GEO-5)`);
  }
  if (typeof geo.buildGeoAssets !== 'function') throw new Error(`${dir}/build.mjs must export buildGeoAssets (GEO-3)`);
  return { folding: folding as SearchFolding, geo: geo as GeoBuild };
}

export interface AssetSize {
  /** Root-relative URL path. */
  readonly path: string;
  readonly raw: number;
  readonly gzip: number;
  readonly br: number;
}

export function measure(path: string, body: Buffer | string): AssetSize {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  return {
    path,
    raw: buf.length,
    gzip: gzipSync(buf, { level: 9 }).length,
    br: brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
}

export interface CatalogAssetsResult {
  readonly search: Readonly<Record<Lang, AssetSize>>;
  readonly communes: Readonly<Record<Lang, readonly AssetSize[]>>;
  /** The wilaya `<option>` list inlined in the order form (as JSON, for size only). */
  readonly wilayaOptions: Readonly<Record<Lang, AssetSize>>;
}

export async function writeCatalogAssets(
  ctx: BuildContext,
  opts: { readonly outDir: string; readonly folding: SearchFolding; readonly geo: GeoBuild },
): Promise<CatalogAssetsResult> {
  const outDir = resolve(opts.outDir);
  const search = {} as Record<Lang, AssetSize>;
  const communes = {} as Record<Lang, AssetSize[]>;
  const wilayaOptions = {} as Record<Lang, AssetSize>;
  const snapshotCodes = [...ctx.snapshot.wilayas].map((w) => w.code).sort((a, b) => a - b);

  for (const lang of LANGS) {
    const index = buildSearchIndex(ctx, lang, opts.folding);
    const body = JSON.stringify(index);
    const path = searchIndexPath(lang);
    await mkdir(dirname(join(outDir, path)), { recursive: true });
    await writeFile(join(outDir, path), body);
    search[lang] = measure(path, body);

    const geo = await opts.geo.buildGeoAssets(outDir, { lang });
    // The order form lists the snapshot's wilayas; every one must have its commune file.
    const geoCodes = geo.wilayas.map((w) => w.code);
    const missing = snapshotCodes.filter((c) => !geoCodes.includes(c));
    if (missing.length) throw new Error(`geo assets (${lang}) lack wilayas ${missing.join(', ')}`);
    communes[lang] = [];
    for (const code of snapshotCodes) {
      const p = communesPath(lang, code);
      communes[lang].push(measure(p, await readFile(join(outDir, p))));
    }
    const options = [...ctx.snapshot.wilayas].sort((a, b) => a.code - b.code).map((w) => ({ code: w.code, label: `${w.code} - ${w.name[lang]}` }));
    wilayaOptions[lang] = measure(`(inline wilaya options, ${lang})`, JSON.stringify(options));
  }
  return { search, communes, wilayaOptions };
}

const kb = (n: number): string => n.toLocaleString('en');

/** Markdown sizes table (artifacts/CAT-5/sizes.md). */
export function assetsMarkdown(r: CatalogAssetsResult, products: number): string {
  const lines = ['# CAT-5 asset sizes', '', `Bytes: raw / gzip -9 / brotli q11 (node:zlib). Products indexed: ${products}.`, ''];
  lines.push('## Search indexes', '', '| file | raw | gzip | br |', '|---|---:|---:|---:|');
  for (const lang of LANGS) {
    const s = r.search[lang];
    lines.push(`| ${s.path} | ${kb(s.raw)} | ${kb(s.gzip)} | ${kb(s.br)} |`);
  }
  lines.push('', '## Commune files (one per wilaya)', '', '| lang | files | total br | median br | max br | max raw |', '|---|---:|---:|---:|---:|---:|');
  for (const lang of LANGS) {
    const xs = r.communes[lang];
    const br = xs.map((x) => x.br).sort((a, b) => a - b);
    lines.push(
      `| ${lang} | ${xs.length} | ${kb(br.reduce((a, b) => a + b, 0))} | ${kb(br[Math.floor(br.length / 2)] ?? 0)} | ${kb(br.at(-1) ?? 0)} | ${kb(Math.max(0, ...xs.map((x) => x.raw)))} |`,
    );
  }
  lines.push('', '## Wilaya options (inlined in the order form)', '', '| lang | raw | gzip | br |', '|---|---:|---:|---:|');
  for (const lang of LANGS) {
    const w = r.wilayaOptions[lang];
    lines.push(`| ${lang} | ${kb(w.raw)} | ${kb(w.gzip)} | ${kb(w.br)} |`);
  }
  return lines.join('\n') + '\n';
}
