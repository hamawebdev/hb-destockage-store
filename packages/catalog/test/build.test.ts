import { describe, expect, test } from 'vitest';
import { formatPrice } from '@hb/shared/format';
import { assertPropsUrls, BuildError, buildAllPages, buildCategoryProps, buildContentProps, buildHomeProps, buildNotFoundProps, buildOrderConfirmationProps, buildProductProps, buildSearchProps, createBuildContext, paragraphs } from '../src/build.ts';
import { fixtureContext, FIXTURE_SITE_URL } from '../src/fixtures/props.ts';
import stringsAr from '../src/fixtures/strings.ar.json' with { type: 'json' };
import stringsFr from '../src/fixtures/strings.fr.json' with { type: 'json' };
import { stubImageManifest } from '../src/image-stub.ts';
import { fixtureSnapshot, LANGS } from '../src/index.ts';

const ctx = fixtureContext();
const strings = { ar: stringsAr as Record<string, string>, fr: stringsFr as Record<string, string> };

describe('every page, both languages', () => {
  const pages = buildAllPages(ctx);

  test('one props object per route, JSON-serialisable and deterministic', () => {
    expect(pages.length).toBe(ctx.router.entries().length);
    const again = buildAllPages(fixtureContext());
    expect(JSON.stringify(again)).toBe(JSON.stringify(pages));
    expect(JSON.parse(JSON.stringify(pages))).toEqual(pages);
  });

  test.each(LANGS)('layout invariants (%s)', (lang) => {
    for (const { entry, page } of pages.filter((p) => p.entry.lang === lang)) {
      const l = page.props.layout;
      expect(l.template).toBe(entry.template);
      expect(l.lang).toBe(lang);
      expect(l.dir).toBe(lang === 'ar' ? 'rtl' : 'ltr');
      expect(l.path).toBe(entry.path);
      expect(l.canonicalUrl).toBe(FIXTURE_SITE_URL + entry.path);
      expect(l.preloadArabicFont).toBe(lang === 'ar');
      expect(l.languageSwitch.href).toBe(entry.paths[lang === 'ar' ? 'fr' : 'ar']);
      expect(l.title.length).toBeGreaterThan(0);
      expect(l.description.length).toBeGreaterThan(0);
      expect(l.strings['_meta.lang']).toBeUndefined();
      expect(l.noindex).toBe(!entry.indexable);
      if (entry.indexable) {
        expect(l.alternates.map((a) => a.hreflang)).toEqual(['ar', 'fr', 'x-default']);
        expect(l.alternates[2]!.href).toBe(FIXTURE_SITE_URL + entry.paths.ar);
      } else {
        expect(l.alternates).toEqual([]);
      }
      if (l.lcpImage) expect(l.lcpImage.lcp).toBe(true);
    }
  });
});

describe('home', () => {
  test.each(LANGS)('hero is the LCP image; featured follow settings (%s)', (lang) => {
    const h = buildHomeProps(ctx, lang);
    expect(h.hero.product?.id).toBe(106);
    expect(h.hero.image?.lcp).toBe(true);
    expect(h.layout.lcpImage).toEqual(h.hero.image);
    expect(h.layout.ogImage?.width).toBe(1200);
    expect(h.featured.map((c) => c.id)).toEqual([106, 101, 104]);
    expect(h.packs.map((c) => c.id)).toEqual([106]);
    expect(h.categories.map((c) => [c.id, c.count])).toEqual([[1, 6], [3, 0]]);
    expect(h.featured.every((c) => c.image?.lcp === false)).toBe(true);
  });
  test('nav tree with counts', () => {
    const nav = buildHomeProps(ctx, 'fr').layout.nav;
    expect(nav.map((n) => [n.name, n.count, n.children.map((c) => [c.name, c.count])])).toEqual([
      ['Cuisine', 6, [['Ustensiles', 2]]],
      ['Salle de bain', 0, []],
    ]);
  });
  test('contact formatting', () => {
    expect(buildHomeProps(ctx, 'ar').layout.contact).toEqual({
      phoneDisplay: '0560 41 74 03',
      phoneHref: 'tel:+213560417403',
      whatsappDisplay: '+213 779 942 022',
      whatsappHref: 'https://wa.me/213779942022',
      email: null,
    });
  });
});

describe('category', () => {
  test('pagination over the subtree, first card is LCP', () => {
    const p1 = buildCategoryProps(ctx, 'fr', 1, 1);
    expect(p1.totalCount).toBe(6);
    expect(p1.products.map((c) => c.id)).toEqual([106, 101]);
    expect(p1.products[0]!.image?.lcp).toBe(true);
    expect(p1.products[1]!.image?.lcp).toBe(false);
    expect(p1.layout.lcpImage).toEqual(p1.products[0]!.image);
    expect(p1.pagination).toMatchObject({ page: 1, pageCount: 3, prevHref: null, nextHref: '/fr/c/cuisine/2/' });
    const p3 = buildCategoryProps(ctx, 'fr', 1, 3);
    expect(p3.products.map((c) => c.id)).toEqual([104, 105]);
    expect(p3.pagination).toMatchObject({ prevHref: '/fr/c/cuisine/2/', nextHref: null });
    expect(p3.pagination.pages.filter((x) => x.current).map((x) => x.n)).toEqual([3]);
    expect(p3.layout.title).toContain('Page 3');
    expect(p1.subCategories.map((c) => [c.name, c.count])).toEqual([['Ustensiles', 2]]);
  });
  test.each(LANGS)('breadcrumbs end at the current category (%s)', (lang) => {
    const b = buildCategoryProps(ctx, lang, 2).breadcrumbs;
    expect(b.map((x) => x.href)).toEqual([`/${lang}/`, `/${lang}/c/${lang === 'fr' ? 'cuisine' : 'matbakh'}/`, null]);
  });
  test('empty category', () => {
    const e = buildCategoryProps(ctx, 'ar', 3);
    expect(e.products).toEqual([]);
    expect(e.pagination.pageCount).toBe(1);
    expect(e.layout.lcpImage).toBeNull();
  });
});

describe('product', () => {
  test('variable: option matrix, availability, labels', () => {
    const p = buildProductProps(ctx, 'fr', 101);
    expect(p.variants.map((v) => [v.sku, v.label, v.key, v.stock.state, v.available, v.maxQty])).toEqual([
      ['TAB-M-RGE', 'M / Rouge', '301-303', 'in_stock', true, 8],
      ['TAB-M-BLU', 'M / Bleu', '301-304', 'out_of_stock', false, 0],
      ['TAB-L-BLU', 'L / Bleu', '302-304', 'low_stock', true, 2],
    ]);
    expect(p.options.map((o) => [o.name, o.values.map((v) => [v.label, v.available])])).toEqual([
      ['Taille', [['M', true], ['L', true]]],
      ['Couleur', [['Rouge', true], ['Bleu', true]]],
    ]);
    // Gallery: general, then colour-value (Bleu), then variant (L/Bleu).
    expect(p.images.map((i) => [i.variantId, i.optionValueId])).toEqual([[null, null], [null, 304], [1014, null]]);
    expect(p.variants.map((v) => [v.sku, v.imageIndex, v.imageIndexes])).toEqual([
      ['TAB-M-RGE', null, [0]],
      ['TAB-M-BLU', 1, [1, 0]],
      ['TAB-L-BLU', 2, [2, 1, 0]],
    ]);
    expect(p.options[1]!.values.map((x) => [x.label, x.imageIndexes])).toEqual([['Rouge', []], ['Bleu', [1]]]);
    expect(p.price.amountDzd).toBe(1900);
    expect(p.price.from).toBe(false);
    expect(p.price.discountPercent).toBe(21);
    expect(p.price.label).toBe(formatPrice(1900, 'fr'));
    expect(p.orderForm).toMatchObject({ singleVariant: false, defaultVariantId: 1011, orderable: true, qty: { min: 1, max: 8 } });
    expect(p.orderForm.communesUrlTemplate).toBe('/geo/communes/fr/{code}.json');
    expect(p.orderForm.confirmationHref).toBe('/fr/order/confirmation/');
    expect(p.orderForm.wilayas.map((w) => w.label)).toEqual(['7 - Biskra', '16 - Alger', '31 - Oran']);
    expect(p.images[0]!.lcp).toBe(true);
    expect(p.images.slice(1).every((i) => !i.lcp)).toBe(true);
    expect(p.category).toEqual({ id: 1, name: 'Cuisine', href: '/fr/c/cuisine/' });
    expect(p.breadcrumbs.at(-1)).toEqual({ label: 'Tablier de cuisine', href: null });
    expect(p.product.description).toEqual(['Coton épais, poche frontale.', 'Lavable en machine à 40 °C.']);
  });
  test('card: from-price and swatches', () => {
    const card = buildHomeProps(ctx, 'ar').featured.find((c) => c.id === 101)!;
    expect(card.price).toMatchObject({ amountDzd: 1900, from: true });
    expect(card.swatches).toEqual([{ label: 'أحمر', hex: '#b3261e' }, { label: 'أزرق', hex: '#1e4fb3' }]);
    expect(card.stock).toEqual({ state: 'in_stock', qty: 10 });
  });
  test('pack contents, draft component has no link', () => {
    const p = buildProductProps(ctx, 'ar', 106);
    expect(p.packItems.map((i) => [i.productId, i.qty, i.href])).toEqual([
      [102, 1, '/ar/p/miqlat-28-cm/'],
      [103, 1, '/ar/p/tanjara-20-cm/'],
      [107, 2, null],
    ]);
    expect(p.orderForm.singleVariant).toBe(true);
    expect(p.layout.ogImage?.url).toMatch(/^\/img\/[0-9a-f]+-og\.jpg$/);
  });
  test('stock states: out, low, untracked', () => {
    const out = buildProductProps(ctx, 'fr', 102);
    expect(out.stock).toEqual({ state: 'out_of_stock', qty: 0 });
    expect(out.orderForm.orderable).toBe(false);
    expect(buildProductProps(ctx, 'fr', 103).stock).toEqual({ state: 'low_stock', qty: 2 });
    const untracked = buildProductProps(ctx, 'fr', 104);
    expect(untracked.stock).toEqual({ state: 'in_stock', qty: null });
    expect(untracked.variants[0]!.maxQty).toBe(10);
  });
  test('placeholder and translation placeholder flags', () => {
    expect(buildProductProps(ctx, 'ar', 105).product).toMatchObject({ placeholder: true, translationPlaceholder: true });
    expect(buildProductProps(ctx, 'fr', 105).product.translationPlaceholder).toBe(false);
    expect(buildProductProps(ctx, 'ar', 105).layout.hasPlaceholders).toBe(true);
  });
  test('related: not itself, max 4, same category first', () => {
    const r = buildProductProps(ctx, 'fr', 102).related.map((c) => c.id);
    expect(r).not.toContain(102);
    expect(r.length).toBe(4);
    expect(r[0]).toBe(103);
  });
});

describe('search, content, confirmation, 404', () => {
  test.each(LANGS)('search (%s)', (lang) => {
    const s = buildSearchProps(ctx, lang);
    expect(s).toMatchObject({ indexUrl: `/search/${lang}.json`, queryParam: 'q', minQueryLength: 2 });
    expect(s.layout.noindex).toBe(true);
    expect(s.suggested.length).toBe(3);
  });
  test.each(LANGS)('content (%s)', (lang) => {
    const c = buildContentProps(ctx, lang, 1);
    expect(c.page.key).toBe('delivery');
    expect(c.page.blocks).toBe(fixtureSnapshot.contentPages[0]!.body[lang]);
    expect(c.breadcrumbs).toHaveLength(2);
    expect(c.layout.footerLinks.map((f) => f.key)).toEqual(['about', 'delivery']);
  });
  test.each(LANGS)('confirmation and 404 (%s)', (lang) => {
    const o = buildOrderConfirmationProps(ctx, lang);
    expect(o.deliveryHref).toBe(lang === 'fr' ? '/fr/livraison/' : '/ar/tawsil/');
    expect(o.continueHref).toBe(`/${lang}/`);
    const n = buildNotFoundProps(ctx, lang);
    expect(n.layout.path).toBe(`/${lang}/404.html`);
    expect(n.categories.length).toBe(2);
  });
});

describe('failures', () => {
  test('missing brand string', () => {
    const { ['meta.titleTemplate']: _drop, ...rest } = strings.fr;
    void _drop;
    expect(() => createBuildContext(fixtureSnapshot, { siteUrl: FIXTURE_SITE_URL, strings: { ar: strings.ar, fr: rest }, images: stubImageManifest(fixtureSnapshot) })).toThrow(BuildError);
  });
  test('image missing from the manifest', () => {
    const { ['fixture/poele.jpg']: _drop, ...images } = stubImageManifest(fixtureSnapshot);
    void _drop;
    expect(() => createBuildContext(fixtureSnapshot, { siteUrl: FIXTURE_SITE_URL, strings, images })).toThrow(/fixture\/poele\.jpg/);
  });
  test('siteUrl must be an origin', () => {
    expect(() => createBuildContext(fixtureSnapshot, { siteUrl: 'https://x.dz/shop', strings, images: stubImageManifest(fixtureSnapshot) })).toThrow(BuildError);
  });
});

test('paragraphs', () => {
  expect(paragraphs('a\n\n  b \n\n\n\nc\n')).toEqual(['a', 'b', 'c']);
  expect(paragraphs('')).toEqual([]);
});

describe('URL allow-list on built props', () => {
  test('every URL in every fixture page passes', () => {
    for (const { page } of buildAllPages(ctx)) expect(() => assertPropsUrls(page.props, FIXTURE_SITE_URL)).not.toThrow();
  });
  test.each([
    [{ href: '//evil.example/' }],
    [{ layout: { canonicalUrl: 'https://evil.example/ar/' } }],
    [{ alternates: [{ hreflang: 'ar', href: 'https://hbdestockage.example//evil.example/' }] }],
    [{ image: { src: '/img/x-360.avif', srcset: '/img/x-360.avif 360w, //evil.example/x.avif 720w' } }],
    [{ items: [{ url: 'javascript:alert(1)' }] }],
  ])('rejects %j', (props) => {
    expect(() => assertPropsUrls(props, FIXTURE_SITE_URL)).toThrow(/props/);
  });
  test('manifest URLs are checked at context creation', () => {
    const images = stubImageManifest(fixtureSnapshot);
    const bad = { ...images, 'fixture/poele.jpg': { ...images['fixture/poele.jpg']!, og: { url: '//evil.example/og.jpg', bytes: 0 } } };
    expect(() => createBuildContext(fixtureSnapshot, { siteUrl: FIXTURE_SITE_URL, strings, images: bad })).toThrow(/og image/);
  });
});
