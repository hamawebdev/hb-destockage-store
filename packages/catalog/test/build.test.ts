import { describe, expect, test } from 'vitest';
import { formatPrice } from '@hb/shared/format';
import { assertPropsUrls, BuildError, buildAllPages, buildCategoryProps, buildContentProps, buildHomeProps, buildNotFoundProps, buildOrderConfirmationProps, buildProductProps, buildSearchProps, createBuildContext, paragraphs } from '../src/build.ts';
import { fixtureContext, FIXTURE_SITE_URL } from '../src/fixtures/props.ts';
import stringsAr from '../src/fixtures/strings.ar.json' with { type: 'json' };
import stringsFr from '../src/fixtures/strings.fr.json' with { type: 'json' };
import { stubImageManifest } from '../src/image-stub.ts';
import { fixtureSnapshot, LANGS, validateSnapshot } from '../src/index.ts';
import { buildSearchIndex } from '../src/search.ts';

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
    [{ alternates: [{ hreflang: 'ar', href: 'https://comptoirdeluxe.example//evil.example/' }] }],
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

describe('CAT-3 r1: only sellable variants drive what is shown', () => {
  type MutableSnap = { products: { id: number; variants: { id: number; isDefault: boolean; stock: number | null; priceDzd: number; compareAtDzd: number | null }[]; images: { placeholder: boolean }[] }[]; categories: { image?: unknown }[] };
  const variant = (s: MutableSnap, id: number) => s.products.find((p) => p.id === 101)!.variants.find((v) => v.id === id)!;
  const ctxFor = (s: MutableSnap) =>
    createBuildContext(s as unknown as typeof fixtureSnapshot, { siteUrl: FIXTURE_SITE_URL, strings, images: stubImageManifest(s as unknown as typeof fixtureSnapshot) });

  test('F1: an out-of-stock default is not preselected while another variant is available', () => {
    const s = structuredClone(fixtureSnapshot) as unknown as MutableSnap;
    variant(s, 1011).isDefault = false;
    variant(s, 1012).isDefault = true; // M/Bleu, stock 0
    for (const lang of LANGS) {
      const p = buildProductProps(ctxFor(s), lang, 101);
      expect(p.orderForm.defaultVariantId).toBe(1011);
      expect(p.variants.find((v) => v.isDefault)!.id).toBe(1011);
      expect(p.stock.state).toBe('in_stock');
      expect(p.price.amountDzd).toBe(1900);
    }
  });

  test('F1: when nothing is available the admin default stays and the form is not orderable', () => {
    const s = structuredClone(fixtureSnapshot) as unknown as MutableSnap;
    for (const id of [1011, 1014]) variant(s, id).stock = 0;
    const p = buildProductProps(ctxFor(s), 'fr', 101);
    expect(p.orderForm.defaultVariantId).toBe(1011);
    expect(p.stock.state).toBe('out_of_stock');
    expect(p.orderForm.orderable).toBe(false);
  });

  test('F2: card from-price, discount and swatches ignore variants that cannot be bought', () => {
    const s = structuredClone(fixtureSnapshot) as unknown as MutableSnap;
    Object.assign(variant(s, 1012), { priceDzd: 1500, compareAtDzd: 2400 }); // cheapest, but stock 0
    const card = buildCategoryProps(ctxFor(s), 'fr', 1).products.find((c) => c.id === 101)!;
    expect(card.price).toMatchObject({ amountDzd: 1900, from: true, discountPercent: 21 });
    const home = buildHomeProps(ctxFor(s), 'fr').featured.find((c) => c.id === 101)!;
    expect(home.price.amountDzd).toBe(1900);
    // Bleu is still sellable through L/Bleu; Rouge through M/Rouge.
    expect(card.swatches.map((x) => x.label)).toEqual(['Rouge', 'Bleu']);
    variant(s, 1014).stock = 0; // now no blue variant can be bought
    expect(buildCategoryProps(ctxFor(s), 'fr', 1).products.find((c) => c.id === 101)!.swatches.map((x) => x.label)).toEqual(['Rouge']);
  });

  test('F3: placeholder photos raise hasPlaceholders on every template', () => {
    const s = structuredClone(fixtureSnapshot) as unknown as MutableSnap & { products: { placeholder: boolean; translationPlaceholder: string[] }[]; categories: { placeholder: boolean; translationPlaceholder: string[] }[]; contentPages: { placeholder: boolean }[] };
    for (const p of s.products) Object.assign(p, { placeholder: false, translationPlaceholder: [] });
    for (const c of s.categories) Object.assign(c, { placeholder: false, translationPlaceholder: [] });
    for (const p of s.products) for (const i of p.images) i.placeholder = false;
    const clean = ctxFor(s);
    expect(buildHomeProps(clean, 'fr').layout.hasPlaceholders).toBe(false);
    expect(buildCategoryProps(clean, 'fr', 1).layout.hasPlaceholders).toBe(false);
    s.products.find((p) => p.id === 104)!.images[0]!.placeholder = true; // a card photo only
    const dirty = ctxFor(s);
    expect(buildHomeProps(dirty, 'fr').layout.hasPlaceholders).toBe(true);
    expect(buildCategoryProps(dirty, 'fr', 1).layout.hasPlaceholders).toBe(true);
    expect(buildSearchProps(dirty, 'fr').layout.hasPlaceholders).toBe(true);
    expect(buildNotFoundProps(dirty, 'fr').layout.hasPlaceholders).toBe(false); // its links show 106's photo
    s.products.find((p) => p.id === 106)!.images[0]!.placeholder = true; // the Cuisine link photo
    expect(buildNotFoundProps(ctxFor(s), 'fr').layout.hasPlaceholders).toBe(true);
  });
});

describe('HB_STRICT_COPY', () => {
  const withPlaceholder = { ar: strings.ar, fr: { ...strings.fr, 'meta.home.title': 'Accueil [PLACEHOLDER]' } };
  const make = (strictCopy?: boolean) =>
    createBuildContext(fixtureSnapshot, {
      siteUrl: FIXTURE_SITE_URL,
      strings: withPlaceholder,
      images: stubImageManifest(fixtureSnapshot),
      ...(strictCopy === undefined ? {} : { strictCopy }),
    });
  test('placeholder copy is allowed by default and in dev', () => {
    expect(buildHomeProps(make(false), 'fr').layout.title).toContain('[PLACEHOLDER]');
  });
  test('strictCopy fails the build on a placeholder string', () => {
    expect(() => buildHomeProps(make(true), 'fr')).toThrow(/meta\.home\.title.*placeholder/);
  });
  test('defaults to HB_STRICT_COPY=1 from the environment', () => {
    const prev = process.env['HB_STRICT_COPY'];
    process.env['HB_STRICT_COPY'] = '1';
    try {
      expect(make().strictCopy).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['HB_STRICT_COPY'];
      else process.env['HB_STRICT_COPY'] = prev;
    }
    expect(make().strictCopy).toBe(prev === '1');
  });
});

describe('home hero (lead ruling: no implicit hero)', () => {
  const ctxWith = (hero: number | null) => {
    const s = structuredClone(fixtureSnapshot) as unknown as { settings: { homeHeroProductId: number | null } };
    s.settings.homeHeroProductId = hero;
    return createBuildContext(s as unknown as typeof fixtureSnapshot, { siteUrl: FIXTURE_SITE_URL, strings, images: stubImageManifest(fixtureSnapshot) });
  };
  test.each([null, 107])('hero id %s ⇒ type-led hero: no image, no product, no LCP, no og:image', (hero) => {
    const h = buildHomeProps(ctxWith(hero), 'ar');
    expect(h.hero).toEqual({ image: null, product: null });
    expect(h.layout.lcpImage).toBeNull();
    expect(h.layout.ogImage).toBeNull();
    expect(h.featured.length).toBe(3); // featured products are unaffected
  });
  test('an explicit published hero is used', () => {
    expect(buildHomeProps(ctxWith(104), 'fr').hero.product?.id).toBe(104);
  });
});

test('SLOT_SIZES describe the rendered slot width (lead: never under-resolve)', async () => {
  const { SLOT_SIZES } = await import('../src/build.ts');
  const { IMAGE_WIDTHS } = await import('../src/types.ts');
  // Browser choice: the smallest candidate ≥ slot width × DPR (else the largest).
  const pick = (cssPx: number, dpr: number): number => IMAGE_WIDTHS.find((w) => w >= cssPx * dpr) ?? 1200;
  // Phones: the gallery is the container, 100vw minus a 1rem gutter on each side.
  expect(SLOT_SIZES.gallery.endsWith('calc(100vw - 2rem)')).toBe(true);
  expect(pick(360 - 32, 2.625)).toBe(960); // 360 px phone at DPR 2.625 still gets 960 w
  expect(pick(412 - 32, 1.75)).toBe(720); // Lighthouse's 412 px × 1.75 slot really is 380 px
  // Cards: 2 columns below 768 px (gutters 2 × 1rem + 12 px gap).
  expect(SLOT_SIZES.card.endsWith('calc((100vw - 44px) / 2)')).toBe(true);
  const p = buildProductProps(ctx, 'fr', 101);
  expect(p.images[0]!.sizes).toBe(SLOT_SIZES.gallery);
  expect(p.layout.lcpImage!.sizes).toBe(SLOT_SIZES.gallery);
});

describe('photos with a printed price (HOME-0: never on the homepage)', () => {
  const noCardImages = (h: ReturnType<typeof buildHomeProps>): string[] =>
    [...h.featured, ...h.packs].flatMap((c) => (c.image ? [c.image.src] : []));
  type Snap = typeof fixtureSnapshot;
  function build(mut: (s: Snap) => void) {
    const snapshot = structuredClone(fixtureSnapshot) as Snap;
    mut(snapshot);
    return createBuildContext(snapshot, { siteUrl: FIXTURE_SITE_URL, strings, images: stubImageManifest(snapshot) });
  }
  const urls = (c: ReturnType<typeof build>, key: string): string[] => stubImageManifest(c.snapshot)[key]!.candidates.map((x) => x.url);
  const printed = [14600];
  const snap = (s: Snap, id: number) => s.products.find((p) => p.id === id)!;

  test('a product whose photos all print a price drops off the homepage; the next clean product fills in', () => {
    const c = build((s) => {
      for (const img of snap(s, 106).images) (img as { printedPricesDzd?: readonly number[] }).printedPricesDzd = printed;
    });
    const h = buildHomeProps(c, 'fr');
    expect(h.featured.map((x) => x.id)).not.toContain(106);
    expect(h.packs.map((x) => x.id)).not.toContain(106);
    expect(h.featured.length).toBeGreaterThanOrEqual(4);
    // The product itself still sells on its own page, its photo included (BUG-14).
    expect(buildProductProps(c, 'fr', 106).images.length).toBeGreaterThan(0);
  });

  test('a card and the cart thumbnail use the first clean photo when the main one prints a price', () => {
    const c = build((s) => {
      (snap(s, 101).images[0] as { printedPricesDzd?: readonly number[] }).printedPricesDzd = printed;
    });
    const clean = snap(c.snapshot, 101).images.find((i) => (i.printedPricesDzd?.length ?? 0) === 0)!;
    const home = buildHomeProps(c, 'fr');
    const card = home.featured.find((x) => x.id === 101)!;
    expect(urls(c, clean.key)).toContain(card.image?.src);
    const printedUrls = urls(c, snap(c.snapshot, 101).images[0]!.key);
    expect(noCardImages(home).some((u) => printedUrls.includes(u))).toBe(false);
  });

  test('a category tile skips a printed own photo and printed product photos', () => {
    const c = build((s) => {
      const cat = s.categories.find((x) => x.id === 1)!;
      (cat as { image?: unknown }).image = { ...snap(s, 101).images[0]!, id: 900, key: 'fixture/own-category.jpg', printedPricesDzd: printed };
      for (const p of s.products.filter((x) => x.categoryId === 1 || s.categories.find((y) => y.id === x.categoryId)?.parentId === 1)) {
        for (const img of p.images) (img as { printedPricesDzd?: readonly number[] }).printedPricesDzd = printed;
      }
    });
    const tile = buildHomeProps(c, 'fr').categories.find((x) => x.id === 1)!;
    expect(tile.image).toBeNull();
  });

  test('the hero never takes a printed photo', () => {
    const c = build((s) => {
      (s.settings as { homeHeroProductId: number | null }).homeHeroProductId = 106;
      for (const img of snap(s, 106).images) (img as { printedPricesDzd?: readonly number[] }).printedPricesDzd = printed;
    });
    const h = buildHomeProps(c, 'fr');
    expect(h.hero.image).toBeNull();
    expect(h.layout.lcpImage).toBeNull();
  });
});

describe('a product with no category', () => {
  type Snap = typeof fixtureSnapshot;
  // 105 loses its category; the admin's home selection (106, 101, 104) does not name it.
  function build(mut: (s: Snap) => void = () => {}) {
    const snapshot = structuredClone(fixtureSnapshot) as Snap;
    (snapshot.products.find((p) => p.id === 105)! as { categoryId: number | null }).categoryId = null;
    mut(snapshot);
    return createBuildContext(snapshot, { siteUrl: FIXTURE_SITE_URL, strings, images: stubImageManifest(snapshot) });
  }
  const c = build();
  const folding = { searchKey: (x: string) => x.toLowerCase(), normalizeForSearch: (x: string) => x.toLowerCase() };

  test('the snapshot is valid and the product is published, with its page and its order page', () => {
    expect(validateSnapshot(c.snapshot, { requireAllWilayas: false }).ok).toBe(true);
    expect(c.publishedProductIds.has(105)).toBe(true);
    const templates = c.router.entries().filter((e) => e.entityId === 105 && (e.template === 'product' || e.template === 'order-step')).map((e) => `${e.lang} ${e.template}`).sort();
    expect(templates).toEqual(['ar order-step', 'ar product', 'fr order-step', 'fr product']);
    expect(() => buildAllPages(c)).not.toThrow();
  });

  test.each(LANGS)('home (%s): always in the products section, first, whatever the selection', (lang) => {
    const h = buildHomeProps(c, lang);
    expect(h.featured[0]!.id).toBe(105);
    expect(h.pinnedCount).toBe(1);
    expect(h.featured.map((x) => x.id).slice(1)).toEqual(buildHomeProps(fixtureContext(), lang).featured.map((x) => x.id).filter((id) => id !== 105));
    expect(h.featured[0]!.href).toBe(c.router.url(lang, { template: 'product', id: 105 }));
    expect(buildHomeProps(fixtureContext(), lang).pinnedCount).toBe(0);
  });

  test('home: listed even with no photo, and never with a photo that prints a price', () => {
    const none = build((s) => void ((s.products.find((p) => p.id === 105)! as unknown as { images: unknown[] }).images = []));
    expect(buildHomeProps(none, 'fr').featured[0]).toMatchObject({ id: 105, image: null });
    const printed = build((s) => {
      for (const img of s.products.find((p) => p.id === 105)!.images) (img as { printedPricesDzd?: readonly number[] }).printedPricesDzd = [1900];
    });
    expect(buildHomeProps(printed, 'fr').featured[0]).toMatchObject({ id: 105, image: null });
  });

  test.each(LANGS)('product page (%s): no category, breadcrumb Home › product, orderable', (lang) => {
    const p = buildProductProps(c, lang, 105);
    expect(p.category).toBeNull();
    expect(p.breadcrumbs.map((b) => b.href)).toEqual([c.router.url(lang, { template: 'home' }), null]);
    expect(p.orderForm.orderable).toBe(true);
    expect(p.orderForm.productId).toBe(105);
  });

  test('under no category: not in any listing, count or navigation total; still found by search', () => {
    for (const cat of c.categories) {
      expect(c.subtreeProducts.get(cat.id)!.map((p) => p.id)).not.toContain(105);
    }
    const before = fixtureContext();
    const was = fixtureSnapshot.products.find((p) => p.id === 105)!.categoryId!;
    expect(c.subtreeProducts.get(was)!.length).toBe(before.subtreeProducts.get(was)!.length - 1);
    const entry = buildSearchIndex(c, 'fr', folding).entries.find((e) => e.id === 105)!;
    expect(entry.c).toBeNull();
    expect(entry.k).toContain(c.productById.get(105)!.name.fr.toLowerCase());
  });

  test('a category that does not exist is still refused', () => {
    const s = structuredClone(fixtureSnapshot) as Snap;
    (s.products.find((p) => p.id === 105)! as { categoryId: number | null }).categoryId = 9999;
    const r = validateSnapshot(s, { requireAllWilayas: false });
    expect(r.ok ? [] : r.issues.map((i) => i.message)).toContain('unknown category 9999');
  });
});
