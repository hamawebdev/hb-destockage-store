import { describe, expect, test } from 'vitest';
import { buildOrderStepProps, buildPageProps, buildProductProps } from '../src/build.ts';
import { fixtureContext } from '../src/fixtures/props.ts';
import { fixtureSnapshot, LANGS, validateSnapshot, type CatalogSnapshot } from '../src/index.ts';
import { buildSitemap } from '../src/seo.ts';

const ctx = fixtureContext();

describe('ORDER-STEP routes', () => {
  test('one noindex page per published product and language at /{lang}/order/<slug>/', () => {
    const fr = ctx.router.entries({ template: 'order-step', lang: 'fr' });
    expect(fr.map((e) => e.entityId)).toEqual(ctx.router.entries({ template: 'product', lang: 'fr' }).map((e) => e.entityId));
    expect(fr.find((e) => e.entityId === 101)).toMatchObject({
      path: '/fr/order/tablier-de-cuisine/',
      param: 'order/tablier-de-cuisine',
      indexable: false,
      paths: { ar: '/ar/order/mariyalat-matbakh/', fr: '/fr/order/tablier-de-cuisine/' },
    });
    expect(ctx.router.url('ar', { template: 'order-step', id: 102 })).toBe('/ar/order/miqlat-28-cm/');
    expect(() => ctx.router.url('fr', { template: 'order-step', id: 107 })).toThrow(/not published/);
  });

  test('never in the sitemap', () => {
    expect(buildSitemap(ctx).some((e) => e.loc.includes('/order/'))).toBe(false);
  });

  test.each(['confirmation', 'review'])('product slug %j is refused (collides with an /order/ route)', (slug) => {
    const s = structuredClone(fixtureSnapshot) as unknown as { products: { slug: { fr: string; ar: string } }[] };
    s.products[1]!.slug.fr = slug;
    const r = validateSnapshot(s as unknown as CatalogSnapshot, { requireAllWilayas: false });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.issues.map((i) => i.message).join()).toMatch(/collides with an \/order\/ route/);
  });
});

describe('OrderStepProps', () => {
  test.each(LANGS)('layout: noindex, no alternates, language switch, no LCP/og image (%s)', (lang) => {
    const p = buildOrderStepProps(ctx, lang, 101);
    const other = lang === 'ar' ? 'fr' : 'ar';
    expect(p.layout.template).toBe('order-step');
    expect(p.layout.noindex).toBe(true);
    expect(p.layout.alternates).toEqual([]);
    expect(p.layout.languageSwitch.href).toBe(ctx.router.url(other, { template: 'order-step', id: 101 }));
    expect(p.layout.lcpImage).toBeNull();
    expect(p.layout.ogImage).toBeNull();
  });

  test('summary image: 360–480 w only, sizes 120px, not LCP', () => {
    const img = buildOrderStepProps(ctx, 'fr', 101).image!;
    expect(img.candidates.map((c) => c.width)).toEqual([360, 480]);
    expect(img.srcset).toBe(img.candidates.map((c) => `${c.url} ${c.width}w`).join(', '));
    expect(img.src).toBe(img.candidates[1]!.url);
    expect([img.width, img.sizes, img.lcp]).toEqual([480, '120px', false]);
  });

  test('price, options, variants and orderForm are the product page objects', () => {
    for (const id of [101, 102, 104, 106]) {
      const step = buildOrderStepProps(ctx, 'ar', id);
      const page = buildProductProps(ctx, 'ar', id);
      expect(step.price).toEqual(page.price);
      expect(step.options).toEqual(page.options);
      expect(step.variants).toEqual(page.variants);
      expect(step.orderForm).toEqual(page.orderForm);
      expect(step.product.href).toBe(page.product.href);
    }
  });

  test('breadcrumbs: Home › category › product (linked) › order CTA (current)', () => {
    const b = buildOrderStepProps(ctx, 'fr', 102).breadcrumbs;
    expect(b.map((x) => [x.label, x.href])).toEqual([
      ['Accueil', '/fr/'],
      ['Cuisine', '/fr/c/cuisine/'],
      ['Ustensiles', '/fr/c/ustensiles/'],
      ['Poêle 28 cm', '/fr/p/poele-28-cm/'],
      ['Commander', null],
    ]);
  });

  test('sold-out product: the page is built, the form is not orderable', () => {
    const p = buildOrderStepProps(ctx, 'fr', 102);
    expect(p.orderForm.orderable).toBe(false);
    expect(p.variants.every((v) => !v.available)).toBe(true);
  });

  test('single-variant product: singleVariant, no options', () => {
    const p = buildOrderStepProps(ctx, 'fr', 104);
    expect(p.orderForm.singleVariant).toBe(true);
    expect(p.options).toEqual([]);
    expect(p.variants).toHaveLength(1);
  });

  test('pages\' fields: ProductProps.orderStepHref and OrderStepProps.category', () => {
    for (const lang of LANGS) {
      const page = buildProductProps(ctx, lang, 101);
      expect(page.orderStepHref).toBe(ctx.router.url(lang, { template: 'order-step', id: 101 }));
      expect(buildOrderStepProps(ctx, lang, 101).category).toEqual(page.category);
    }
  });

  test('dispatch through buildPageProps', () => {
    const e = ctx.router.entries({ template: 'order-step', lang: 'ar' })[0]!;
    expect(buildPageProps(ctx, e).template).toBe('order-step');
  });
});
