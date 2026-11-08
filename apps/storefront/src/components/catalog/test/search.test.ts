// search.js (public/js) — parity with geo's normalizeForSearch (GEO-5 corpus + random strings),
// matching on CAT-5's real index built from the fixture catalogue, and the template.
import { fixtureContext, fixturePages } from '@hb/catalog/fixtures/props';
import type { SearchIndexEntry, SearchProps } from '@hb/catalog';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import SearchView from '../SearchView.astro';
import { match, normalizeForSearch } from '../../../../public/js/search.js';

const repo = join(fileURLToPath(new URL('.', import.meta.url)), '../../../../../..');
type Row = { in: string; lang: 'ar' | 'fr'; out: string; key: string };
const corpus = JSON.parse(readFileSync(join(repo, 'data/geo/search.corpus.json'), 'utf8')) as Row[];
type Geo = { normalizeForSearch: (s: string, l?: string) => string; searchKey: (s: string, l?: string) => string };
let geo: Geo;
type Fold = (s: unknown) => string;
const fold = normalizeForSearch as Fold;
const find = match as (e: readonly SearchIndexEntry[], q: string) => SearchIndexEntry[];

beforeAll(async () => {
  geo = (await import(pathToFileURL(join(repo, 'data/geo/search.mjs')).href)) as Geo;
});

describe('normalizeForSearch port = geo GEO-5', () => {
  it(`all ${corpus.length} corpus rows`, () => {
    const bad = corpus.filter((r) => fold(r.in) !== r.out);
    expect(bad).toEqual([]);
  });
  it('same output as data/geo/search.mjs on mixed random strings', () => {
    const alphabet = "aàâäçéèêëîïôöùûüœæß AÉ'’-.,/0123456789٠١٢٣٤٥٦٧٨٩۰۹ابتةجحخدذرزسشصضطظعغفقكلمنهويىءأإآؤئٱـًٌٍَُِّْٰڨڧڢکیابن  ";
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 2000; i++) {
      const s = Array.from({ length: 1 + Math.floor(rnd() * 24) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('');
      expect(fold(s), JSON.stringify(s)).toBe(geo.normalizeForSearch(s));
    }
  });
  it('corpus keys contain the folded query (the GEO-5 contract the index relies on)', () => {
    for (const r of corpus) expect(r.key.includes(fold(r.in)), r.in).toBe(true);
  });
});

describe('match on the CAT-5 index of the fixture catalogue', async () => {
  const { buildSearchIndex } = await import('@hb/catalog/search');
  const { loadGeoModules } = await import('@hb/catalog/assets');
  const { folding } = await loadGeoModules(repo);
  const ix = { ar: buildSearchIndex(fixtureContext(), 'ar', folding), fr: buildSearchIndex(fixtureContext(), 'fr', folding) };
  const names = (l: 'ar' | 'fr', q: string) => find(ix[l].entries, q).map((e) => e.n);

  it('accents, case and partial words (fr)', () => {
    expect(names('fr', 'POELE')).toEqual(['Poêle 28 cm']);
    expect(names('fr', 'cass')).toEqual(['Casserole 20 cm']);
    expect(names('fr', 'egou')[0]).toMatch(/^Égouttoir/);
  });
  it('every word must match, in any order; names starting with the query come first', () => {
    expect(names('fr', 'cuisine pack')).toEqual(['Pack cuisine 3 en 1']);
    expect(names('fr', 'pack')[0]).toBe('Pack cuisine 3 en 1');
    expect(names('fr', 'pack inexistant')).toEqual([]);
  });
  it('category, brand and option values are searchable', () => {
    expect(names('fr', 'hb home')).toEqual(['Set de couteaux']);
    expect(names('fr', 'rouge')).toEqual(['Tablier de cuisine']);
    expect(names('fr', 'ustensiles').length).toBeGreaterThan(0);
  });
  it('Arabic: hamza/tashkeel/ta marbuta folding, Eastern digits', () => {
    expect(names('ar', 'مقلاة')).toEqual(['مقلاة 28 سم']);
    expect(names('ar', 'مقلاه')).toEqual(['مقلاة 28 سم']);
    expect(names('ar', 'طنجرة ٢٠')).toEqual(['طنجرة 20 سم']);
    expect(names('ar', 'مَرْيَلة')).toEqual(['مريلة مطبخ']);
  });
  it('empty or punctuation-only query matches nothing', () => {
    expect(find(ix.fr.entries, '  -- ')).toEqual([]);
  });
});

describe.each(['ar', 'fr'] as const)('search template (%s)', (lang) => {
  let container: AstroContainer;
  beforeAll(async () => {
    container = await AstroContainer.create();
  });
  it('GET form on ?q=, status line, no-JS note, categories; heading without the store name (BUG-9)', async () => {
    const page = fixturePages(lang)[`/${lang}/search/`];
    if (!page || page.template !== 'search') throw new Error('no search page');
    const p = page.props as SearchProps;
    const html = await container.renderToString(SearchView, { props: { ...p } });
    expect(html).toMatch(new RegExp(`<form class="cat-sform" role="search" method="get" action="${p.layout.path}">`));
    expect(html).toContain('name="q"');
    expect(html).toMatch(/id="cat-sstatus" class="cat-sstatus" role="status"/);
    expect(html).toContain('<noscript>');
    expect(html).toContain(`data-index="${p.indexUrl}"`);
    for (const c of p.categories) expect(html).toContain(`href="${c.href}"`);
    const h1 = html.match(/<h1[^>]*>([^<]*)<\/h1>/)?.[1] ?? '';
    expect(h1).toBe(p.layout.strings['search.title']);
    expect(h1).not.toContain(p.layout.storeName);
    expect(html).not.toMatch(/<script|\sstyle="/);
  });
});
