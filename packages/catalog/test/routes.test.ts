import { describe, expect, test } from 'vitest';
import {
  alternatesFor,
  createRouter,
  fixtureSnapshot,
  RouteError,
  type CatalogSnapshot,
} from '../src/index.ts';

describe('createRouter', () => {
  const r = createRouter(fixtureSnapshot, 2);

  test('URL scheme', () => {
    expect(r.url('ar', { template: 'home' })).toBe('/ar/');
    expect(r.url('fr', { template: 'category', id: 1 })).toBe('/fr/c/cuisine/');
    expect(r.url('fr', { template: 'category', id: 1, page: 2 })).toBe('/fr/c/cuisine/2/');
    expect(r.url('ar', { template: 'product', id: 101 })).toBe('/ar/p/mariyalat-matbakh/');
    expect(r.url('fr', { template: 'search' })).toBe('/fr/search/');
    expect(r.url('ar', { template: 'order-confirmed' })).toBe('/ar/order/confirmation/');
    expect(r.url('fr', { template: 'content', id: 1 })).toBe('/fr/livraison/');
    expect(r.url('ar', { template: 'not-found' })).toBe('/ar/404.html');
  });

  test('every path is unique, root-relative and has a twin in the other language', () => {
    const all = r.entries();
    expect(new Set(all.map((e) => e.path)).size).toBe(all.length);
    for (const e of all) {
      expect(e.path.startsWith(`/${e.lang}/`)).toBe(true);
      expect(e.paths[e.lang]).toBe(e.path);
      const other = e.lang === 'ar' ? 'fr' : 'ar';
      expect(all.some((x) => x.path === e.paths[other] && x.lang === other)).toBe(true);
    }
  });

  test('publishes only active entities; paginates the subtree', () => {
    const cats = r.entries({ template: 'category', lang: 'fr' }).map((e) => e.path);
    // Cuisine subtree: 101..106 minus draft 107 = 6 products → 3 pages; Ustensiles: 102, 103 → 1; Salle de bain: empty → 1.
    expect(cats).toEqual(['/fr/c/cuisine/', '/fr/c/cuisine/2/', '/fr/c/cuisine/3/', '/fr/c/ustensiles/', '/fr/c/salle-de-bain/']);
    const prods = r.entries({ template: 'product', lang: 'fr' }).map((e) => e.entityId);
    expect(prods).toEqual([106, 101, 102, 103, 104, 105]);
    expect(() => r.url('fr', { template: 'product', id: 107 })).toThrow(RouteError);
    expect(() => r.url('fr', { template: 'category', id: 4 })).toThrow(RouteError);
    expect(() => r.url('fr', { template: 'category', id: 1, page: 4 })).toThrow(RouteError);
  });

  test('param is the path after /<lang>/', () => {
    const e = r.entries({ lang: 'fr' });
    expect(e.find((x) => x.template === 'home')!.param).toBe('');
    expect(e.find((x) => x.template === 'category' && x.page === 2)!.param).toBe('c/cuisine/2');
  });

  test('indexable: not search, confirmation or 404', () => {
    const noindex = r.entries({ lang: 'ar' }).filter((e) => !e.indexable).map((e) => e.template);
    expect(noindex).toEqual(['search', 'order-confirmed', 'not-found']);
  });

  test('throws on a path collision', () => {
    const s = structuredClone(fixtureSnapshot) as unknown as { contentPages: { slug: { fr: string; ar: string } }[] };
    s.contentPages[1]!.slug.fr = 'livraison';
    expect(() => createRouter(s as unknown as CatalogSnapshot)).toThrow(/collision \/fr\/livraison\//);
  });
});

test('alternatesFor: reciprocal + x-default → Arabic page', () => {
  expect(alternatesFor({ ar: '/ar/p/a/', fr: '/fr/p/b/' }, 'https://example.dz/')).toEqual([
    { hreflang: 'ar', href: 'https://example.dz/ar/p/a/' },
    { hreflang: 'fr', href: 'https://example.dz/fr/p/b/' },
    { hreflang: 'x-default', href: 'https://example.dz/ar/p/a/' },
  ]);
});
