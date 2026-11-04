// GEO-3: storefront geo assets. Called by packages/catalog (pagedata) during the build.
//
//   buildGeoAssets(outDir, { lang }) writes  <outDir>/geo/communes/<lang>/<code>.json  for the
//   69 wilayas: [[communeId, "name"], …] sorted with Intl.Collator(lang) (id breaks ties), and
//   returns { wilayas, files }: wilayas = [{ code, label: "16 - Alger" }] in code order (for
//   inlining in the order form), files = paths written, relative to outDir.
//
// Per-language files are smaller than one file with both names (artifacts/GEO-3/sizes.md).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadWilayas, loadCommunes } from './index.mjs';

export const LANGS = /** @type {const} */ (['ar', 'fr']);
export const communesFile = (lang, code) => `geo/communes/${lang}/${code}.json`;

/** Pure part: the per-wilaya lists for one language. */
export function geoAssets(lang) {
  if (!LANGS.includes(lang)) throw new TypeError(`buildGeoAssets: lang must be "ar" or "fr", got ${lang}`);
  const key = lang === 'ar' ? 'name_ar' : 'name_fr';
  const collator = new Intl.Collator(lang);
  const wilayas = loadWilayas();
  const communes = loadCommunes();
  return {
    wilayas: wilayas.map((w) => ({ code: w.code, label: `${w.code} - ${w[key]}` })),
    communes: wilayas.map((w) => ({
      code: w.code,
      list: communes
        .filter((c) => c.wilaya_code === w.code)
        .sort((a, b) => collator.compare(a[key], b[key]) || a.id - b.id)
        .map((c) => [c.id, c[key]]),
    })),
  };
}

export async function buildGeoAssets(outDir, { lang } = {}) {
  const { wilayas, communes } = geoAssets(lang);
  await mkdir(join(outDir, 'geo', 'communes', lang), { recursive: true });
  const files = [];
  for (const { code, list } of communes) {
    const rel = communesFile(lang, code);
    await writeFile(join(outDir, rel), JSON.stringify(list));
    files.push(rel);
  }
  return { wilayas, files };
}
