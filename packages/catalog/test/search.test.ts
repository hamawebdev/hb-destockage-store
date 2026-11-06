import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { assetsMarkdown, loadGeoModules, measure, writeCatalogAssets, type GeoBuild } from '../src/assets.ts';
import { buildCategoryProps } from '../src/build.ts';
import { fixtureContext } from '../src/fixtures/props.ts';
import { buildSearchIndex, type SearchFolding } from '../src/search.ts';
import { isSameOriginPath, type SearchIndex } from '../src/index.ts';

/** Stand-in for geo's search.mjs: lower-case, strip Latin diacritics. */
const fold = (s: string): string => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const folding: SearchFolding = { searchKey: (s) => fold(s), normalizeForSearch: (s) => fold(s) };
const ctx = fixtureContext();

describe('buildSearchIndex', () => {
  const fr = buildSearchIndex(ctx, 'fr', folding);
  const ar = buildSearchIndex(ctx, 'ar', folding);
  const by = (ix: SearchIndex, id: number) => ix.entries.find((e) => e.id === id)!;

  test('one entry per published product, both languages', () => {
    expect(fr.lang).toBe('fr');
    expect(fr.entries.map((e) => e.id)).toEqual([106, 101, 102, 103, 104, 105]);
    expect(ar.entries.map((e) => e.id)).toEqual(fr.entries.map((e) => e.id));
  });

  test('fields match the cards the listings show', () => {
    const cards = [1, 2, 3].flatMap((page) => buildCategoryProps(ctx, 'fr', 1, page).products);
    for (const e of fr.entries) {
      const card = cards.find((c) => c.id === e.id)!;
      expect([e.n, e.b, e.p, e.f, e.u]).toEqual([card.name, card.brandLatin, card.price.amountDzd, card.price.from, card.href]);
    }
    expect(by(fr, 101)).toMatchObject({ c: 'Cuisine', s: 0, f: true, p: 1900 });
    expect(by(fr, 102).s).toBe(2);
    expect(by(fr, 103).s).toBe(1);
    expect(by(fr, 104).b).toBe('HB Home');
  });

  test('k covers name, brand, category and option values, folded, |-separated', () => {
    expect(by(fr, 101).k).toBe('tablier de cuisine|cuisine|m|l|rouge|bleu');
    expect(by(fr, 104).k).toBe('set de couteaux|hb home|cuisine');
    expect(by(fr, 102).k).toBe('poele 28 cm|ustensiles');
    expect(by(fr, 101).k.includes(fold('Rouge'))).toBe(true);
    expect(by(ar, 101).k).toContain(fold('أزرق'));
  });

  test('placeholder flag includes translation placeholders of that language', () => {
    expect(by(ar, 105).x).toBe(true);
    expect(by(fr, 105).x).toBe(true); // placeholder product in every language
    expect(by(fr, 104).x).toBe(true); // fixture products are all placeholder: true
  });

  test('thumbnails are the smallest candidate, every URL passes the allow-list', () => {
    for (const e of [...fr.entries, ...ar.entries]) {
      expect(isSameOriginPath(e.u)).toBe(true);
      expect(e.t).toMatch(/^\/img\/[0-9a-f]+-360\.avif$/);
    }
  });
});

describe('writeCatalogAssets', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  /** geo's build.mjs stand-in: writes one file per code it knows. */
  const fakeGeo = (codes: readonly number[]): GeoBuild => ({
    async buildGeoAssets(outDir, { lang }) {
      const files: string[] = [];
      for (const code of codes) {
        const rel = `geo/communes/${lang}/${code}.json`;
        await mkdir(join(outDir, `geo/communes/${lang}`), { recursive: true });
        await writeFile(join(outDir, rel), JSON.stringify([[code * 100 + 1, `Commune ${code}`]]));
        files.push(rel);
      }
      return { wilayas: codes.map((code) => ({ code, label: `${code} - W${code}` })), files };
    },
  });

  test('writes /search/<lang>.json and measures search + commune files', async () => {
    const out = await mkdtemp(join(tmpdir(), 'hb-assets-'));
    dirs.push(out);
    const r = await writeCatalogAssets(ctx, { outDir: out, folding, geo: fakeGeo([7, 16, 31]) });
    const written = JSON.parse(await readFile(join(out, 'search/fr.json'), 'utf8')) as SearchIndex;
    expect(written).toEqual(buildSearchIndex(ctx, 'fr', folding));
    expect(r.search.ar.path).toBe('/search/ar.json');
    expect(r.search.fr.br).toBeLessThan(r.search.fr.raw);
    expect(r.communes.ar.map((c) => c.path)).toEqual(['/geo/communes/ar/7.json', '/geo/communes/ar/16.json', '/geo/communes/ar/31.json']);
    expect(assetsMarkdown(r, 6)).toMatch(/\| \/search\/fr\.json \| [\d,]+ \| [\d,]+ \| [\d,]+ \|/);
  });

  test('fails when geo has no commune file for a wilaya the form lists', async () => {
    const out = await mkdtemp(join(tmpdir(), 'hb-assets-'));
    dirs.push(out);
    await expect(writeCatalogAssets(ctx, { outDir: out, folding, geo: fakeGeo([7, 16]) })).rejects.toThrow(/lack wilayas 31/);
  });

  test('loadGeoModules requires geo exports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hb-geo-'));
    dirs.push(root);
    await mkdir(join(root, 'data/geo'), { recursive: true });
    await writeFile(join(root, 'data/geo/search.mjs'), 'export const searchKey = (s) => s; export const normalizeForSearch = (s) => s;');
    await writeFile(join(root, 'data/geo/build.mjs'), 'export const nope = 1;');
    await expect(loadGeoModules(root)).rejects.toThrow(/buildGeoAssets/);
    await writeFile(join(root, 'data/geo/build.mjs'), 'export async function buildGeoAssets() { return { wilayas: [], files: [] }; }');
    const m = await loadGeoModules(root);
    expect(m.folding.searchKey('x')).toBe('x');
  });

  test('measure', () => {
    const m = measure('/x.json', 'a'.repeat(1000));
    expect(m.raw).toBe(1000);
    expect(m.br).toBeLessThan(50);
  });
});
