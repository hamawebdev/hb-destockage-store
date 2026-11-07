import { describe, expect, test } from 'vitest';
import { checkCatalogAssets } from '../integrations/postbuild-core.mjs';

const origin = 'https://shop.example.dz';
const good: Record<string, string> = {
  'search/ar.json': JSON.stringify({ v: 1, lang: 'ar', entries: [{ id: 1 }] }),
  'search/fr.json': JSON.stringify({ v: 1, lang: 'fr', entries: [{ id: 1 }] }),
  'sitemap.xml': `<urlset><url><loc>${origin}/ar/</loc></url></urlset>`,
  'robots.txt': `User-agent: *\nDisallow: /api/\nSitemap: ${origin}/sitemap.xml\n`,
};
const wilayas = Array.from({ length: 69 }, (_, i) => `${i + 1}.json`);
const run = (files: Record<string, string>, communes: string[] = wilayas) =>
  checkCatalogAssets((rel: string) => files[rel] ?? null, (dir: string) => (dir.startsWith('geo/communes/') ? communes : []), origin);

describe('checkCatalogAssets (pre-build outputs in dist)', () => {
  test('complete outputs pass', () => expect(run(good)).toEqual([]));
  test('a missing search index fails', () => {
    const { ['search/fr.json']: _, ...rest } = good;
    expect(run(rest).join()).toMatch(/search\/fr\.json missing/);
  });
  test('an unparsable or empty index fails', () => {
    expect(run({ ...good, 'search/ar.json': '{' }).join()).toMatch(/invalid JSON/);
    expect(run({ ...good, 'search/ar.json': JSON.stringify({ lang: 'ar', entries: [] }) }).join()).toMatch(/non-empty ar search index/);
  });
  test('fewer than 69 commune files per language fails', () => expect(run(good, wilayas.slice(0, 58)).join()).toMatch(/58 wilaya files, expected 69/));
  test('sitemap and robots must use the site origin', () => {
    expect(run({ ...good, 'sitemap.xml': '<loc>https://other.example/ar/</loc>' }).join()).toMatch(/sitemap\.xml does not use/);
    expect(run({ ...good, 'robots.txt': 'Sitemap: https://other.example/sitemap.xml' }).join()).toMatch(/robots\.txt does not point/);
  });
});
