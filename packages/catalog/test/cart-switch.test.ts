// CART-3: what the catalogue build gives the storefront for the cart switch (ledger C-6).
import { describe, expect, test } from 'vitest';
import { buildAllPages, createBuildContext, type BuildContext } from '../src/build.ts';
import { stubImageManifest } from '../src/image-stub.ts';
import { fixtureContext, FIXTURE_PAGE_SIZE, FIXTURE_SITE_URL } from '../src/fixtures/props.ts';
import stringsAr from '../src/fixtures/strings.ar.json' with { type: 'json' };
import stringsFr from '../src/fixtures/strings.fr.json' with { type: 'json' };
import { buildSearchIndex, type SearchFolding } from '../src/search.ts';
import { fixtureSnapshot, orderStepPath, type CatalogSnapshot, type ProductCard } from '../src/index.ts';

const folding: SearchFolding = { searchKey: (s) => s.toLowerCase(), normalizeForSearch: (s) => s.toLowerCase() };
const cartOff: CatalogSnapshot = { ...fixtureSnapshot, settings: { ...fixtureSnapshot.settings, cartEnabled: false } };
const offCtx = (): BuildContext =>
  createBuildContext(cartOff, {
    siteUrl: FIXTURE_SITE_URL,
    strings: { ar: stringsAr as Record<string, string>, fr: stringsFr as Record<string, string> },
    images: stubImageManifest(cartOff),
    pageSize: FIXTURE_PAGE_SIZE,
  });

/** Every ProductCard anywhere in a page's props. */
function cardsIn(x: unknown, out: ProductCard[] = []): ProductCard[] {
  if (Array.isArray(x)) for (const v of x) cardsIn(v, out);
  else if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    if (typeof o['orderHref'] === 'string' && typeof o['href'] === 'string' && 'stock' in o) out.push(o as unknown as ProductCard);
    else for (const v of Object.values(o)) cardsIn(v, out);
  }
  return out;
}

describe('cart switch in page props', () => {
  test('layout.cartEnabled mirrors settings.cartEnabled on every page', () => {
    for (const p of buildAllPages(fixtureContext())) expect((p.page.props as { layout: { cartEnabled: boolean } }).layout.cartEnabled).toBe(true);
    for (const p of buildAllPages(offCtx())) expect((p.page.props as { layout: { cartEnabled: boolean } }).layout.cartEnabled).toBe(false);
  });

  test("every card's orderHref is that product's ORDER-STEP page, in its language", () => {
    const ctx = fixtureContext();
    const pages = buildAllPages(ctx);
    const cards = pages.flatMap((p) => cardsIn(p.page.props).map((c) => [p.entry.lang, c] as const));
    expect(cards.length).toBeGreaterThan(10);
    for (const [lang, c] of cards) {
      const product = fixtureSnapshot.products.find((p) => p.id === c.id)!;
      expect(c.orderHref).toBe(orderStepPath(lang, product.slug[lang]));
      expect(pages.some((p) => p.entry.path === c.orderHref && p.entry.template === 'order-step')).toBe(true);
    }
  });

  test('search index: `o` (order path) only in a cart-off build; cart-on entries unchanged', () => {
    for (const lang of ['ar', 'fr'] as const) {
      const on = buildSearchIndex(fixtureContext(), lang, folding);
      const off = buildSearchIndex(offCtx(), lang, folding);
      for (const e of on.entries) expect('o' in e).toBe(false);
      expect(off.entries.map(({ o: _o, ...rest }) => rest)).toEqual(on.entries);
      for (const e of off.entries) {
        const product = fixtureSnapshot.products.find((p) => p.id === e.id)!;
        expect(e.o).toBe(orderStepPath(lang, product.slug[lang]));
      }
    }
  });
});
