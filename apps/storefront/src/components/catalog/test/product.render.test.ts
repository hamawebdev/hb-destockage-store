// Renders the product template with Astro's container on CAT-3's fixture props (both languages).
import { fixturePages } from '@hb/catalog/fixtures/props';
import type { ProductProps } from '@hb/catalog';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import ProductView from '../ProductView.astro';
import VariantPicker from '../VariantPicker.astro';
import { productJsonLd, serializeJsonLd } from '../lib/jsonld.ts';
import { defaultVariant } from '../lib/variants.ts';

let container: AstroContainer;
beforeAll(async () => {
  container = await AstroContainer.create();
});

const pages = { ar: fixturePages('ar'), fr: fixturePages('fr') };
const product = (lang: 'ar' | 'fr', slug: { ar: string; fr: string }): ProductProps => {
  const page = pages[lang][`/${lang}/p/${slug[lang]}/`];
  if (!page || page.template !== 'product') throw new Error(`no product ${slug[lang]}`);
  return page.props as ProductProps;
};
const APRON = { fr: 'tablier-de-cuisine', ar: 'mariyalat-matbakh' };
const PACK = { fr: 'pack-cuisine-3-en-1', ar: 'bak-matbakh-3-fi-1' };
const PAN = { fr: 'poele-28-cm', ar: 'miqlat-28-cm' };
const KNIVES = { fr: 'set-de-couteaux', ar: 'taqm-sakakin' };
const render = (p: ProductProps, slots?: Record<string, string>) =>
  container.renderToString(ProductView, { props: { ...p }, ...(slots ? { slots } : {}) });
const tag = (html: string, re: RegExp) => html.match(re)?.[0] ?? '';

describe.each(['ar', 'fr'] as const)('product page (%s)', (lang) => {
  it('multi-option picker: opt.<id> radios inside the GET form (no form attribute), default checked, hidden v', async () => {
    const p = product(lang, APRON);
    const html = await render(p);
    for (const o of p.options) expect(html).toContain(`name="opt.${o.id}"`);
    expect(html).not.toContain('form="order-form"');
    expect(html).toMatch(/<input type="hidden" name="v" value="" disabled>/);
    const def = defaultVariant(p.variants)!;
    for (const id of def.optionValueIds) expect(tag(html, new RegExp(`<input[^>]*id="ov-${id}"[^>]*>`))).toContain('checked');
    // One block per variant, keyed by the CAT-1 combination key; the default one is visible without JS.
    for (const v of p.variants) expect(html).toContain(`data-k="${v.key}"`);
    expect(tag(html, /<div class="cat-vp cat-vp-d"[^>]*>/)).toContain(`data-v="${def.id}"`);
    expect(html).toContain('cat-vp-none');
    expect(html).not.toContain('⟦');
  });

  it('preselects CAT-3\'s effective default (isDefault), whichever variant it is', async () => {
    const p = product(lang, APRON);
    const pick = p.variants.find((v) => v.available && !v.isDefault)!;
    const html = await render({ ...p, variants: p.variants.map((v) => ({ ...v, isDefault: v === pick })) });
    for (const id of pick.optionValueIds) expect(tag(html, new RegExp(`<input[^>]*id="ov-${id}"[^>]*>`))).toContain('checked');
    expect(tag(html, /<div class="cat-vp cat-vp-d"[^>]*>/)).toContain(`data-v="${pick.id}"`);
  });

  it('colour swatches are SVG fills (no style=), sizes are text', async () => {
    const html = await render(product(lang, APRON));
    expect(html).toContain('<rect width="1" height="1" fill="#b3261e">');
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/<script/);
  });

  it('gallery: first image is the eager LCP, thumbnails are anchors with a 72px sizes', async () => {
    const p = product(lang, APRON);
    const html = await render(p);
    const first = tag(html, /<figure class="cat-gal-slide" id="photo-1">[\s\S]*?<img[^>]*>/);
    expect(first).toContain('fetchpriority="high"');
    expect(first).toContain(`sizes="${p.images[0]!.sizes}"`);
    expect(html).toContain('href="#photo-2"');
    expect(html).toMatch(/<a href="#photo-1"[^>]*>\s*<img[^>]*sizes="72px"[^>]*loading="lazy"/);
  });

  it('BUG-18: slides 2+ carry no src/srcset outside <noscript> (no request before LCP); each has a <noscript> copy', async () => {
    const p = product(lang, APRON);
    const html = await render(p);
    const track = tag(html, /<div class="cat-gal-track"[\s\S]*?<\/div>/);
    const slides = track.split('<figure').slice(1);
    expect(slides).toHaveLength(p.images.length);
    expect(slides[0]).toContain('fetchpriority="high"');
    for (const [i, sl] of slides.slice(1).entries()) {
      const outside = sl.replace(/<noscript>[\s\S]*?<\/noscript>/g, '');
      expect(outside, `slide ${i + 2}`).not.toMatch(/\s(src|srcset)="/);
      expect(outside).toContain(`data-srcset="${p.images[i + 1]!.srcset}"`);
      expect(outside).toMatch(/<img[^>]*hidden/);
      expect(sl).toMatch(/<noscript>\s*<img[^>]*srcset=/);
    }
  });

  it('BUG-18: related cards and pack thumbnails are deferred too; the only requestable image outside <noscript> is the LCP one (+ ≥1024 thumbnails)', async () => {
    for (const p of [product(lang, PACK), product(lang, APRON)]) {
      const html = await render(p);
      const outside = html.replace(/<noscript>[\s\S]*?<\/noscript>/g, '').replace(/<nav class="cat-gal-thumbs"[\s\S]*?<\/nav>/, '');
      const live = outside.match(/<img\b[^>]*\ssrcset="[^"]*"[^>]*>/g) ?? [];
      expect(live, p.product.name).toHaveLength(1);
      expect(live[0]).toContain('fetchpriority="high"');
      const rel = tag(html, /<section class="cat-sec cat-rel"[\s\S]*?<\/section>/);
      expect(rel.match(/<noscript>\s*<img/g)?.length).toBe(p.related.filter((r) => r.image).length);
    }
  });

  it('pack: contents listed with quantities; an item without its own page is not a link', async () => {
    const p = product(lang, PACK);
    const html = await render(p);
    for (const it of p.packItems) expect(html).toContain(it.name);
    const noPage = p.packItems.find((i) => i.href === null)!;
    expect(html).toContain(`<span class="cat-pack-name">${noPage.name}</span>`);
    expect(html).toContain('<h2 id="cat-pack-h"');
  });

  it('single variant: no picker, stock state shown; brand in <bdi dir=ltr>', async () => {
    const pan = await render(product(lang, PAN));
    expect(pan).not.toContain('cat-picker');
    expect(pan).toContain('cat-stock--out_of_stock');
    const knives = await render(product(lang, KNIVES));
    expect(knives).toMatch(/<bdi( lang="fr")? dir="ltr">HB Home<\/bdi>/);
    if (lang === 'ar') expect(knives).toContain('<bdi lang="fr" dir="ltr">HB Home</bdi>');
  });

  it('ORDER-STEP: the picker sits in a GET form to the order step; CTA (button, and a hidden ?v= link for JS) + sticky bar', async () => {
    const p = product(lang, PACK);
    const html = await render(p);
    expect(html).toContain(`<form id="cat-buy" class="cat-buy" method="get" action="${p.orderStepHref}">`);
    const def = p.variants.find((v) => v.isDefault)!;
    expect(html).toContain(`<input type="hidden" name="v" value="${def.id}">`);
    expect(html).toMatch(/<button class="cat-btn cat-cta" type="submit" data-cta-btn>/);
    expect(html).toContain(`href="${p.orderStepHref}?v=${def.id}" data-cta="${p.orderStepHref}" hidden`);
    expect(html).toMatch(/<button class="cat-btn cat-buybar-cta" type="submit" form="cat-buy" data-cta-btn>/);
    expect(html).not.toContain('#order');
    expect(html).not.toContain('order-form');
    // The GET carries only v / opt.*: no other named control inside the form.
    const form = tag(html, /<form id="cat-buy"[\s\S]*?<\/form>/);
    const names = [...form.matchAll(/\sname="([^"]+)"/g)].map((m) => m[1]);
    expect(names.every((n) => n === 'v' || n!.startsWith('opt.'))).toBe(true);
  });
});

describe('single-option picker (no JS: radios post variantId)', () => {
  it('values map to variant ids; a value whose only variant is out of stock is disabled', async () => {
    const p = product('fr', APRON);
    const size = p.options[0]!;
    const variants = [
      { ...p.variants[0]!, optionValueIds: [size.values[0]!.id], key: String(size.values[0]!.id), isDefault: true },
      { ...p.variants[1]!, optionValueIds: [size.values[1]!.id], key: String(size.values[1]!.id), isDefault: false },
    ];
    const options = [{ ...size, values: [size.values[0]!, { ...size.values[1]!, available: false }] }];
    const html = await container.renderToString(VariantPicker, { props: { options, variants, strings: p.layout.strings } });
    expect(html).toContain('data-mode="single"');
    expect(tag(html, /<input[^>]*id="ov-301"[^>]*>/)).toMatch(/name="variantId" value="1011"[^>]*checked/);
    expect(tag(html, /<input[^>]*id="ov-302"[^>]*>/)).toMatch(/value="1012"[^>]*disabled/);
    expect(html).not.toContain('type="hidden"');
  });
});

function tenSizes(p: ProductProps, defaultAt: number): ProductProps {
  const base = p.variants[0]!;
  const values = Array.from({ length: 10 }, (_, i) => ({ id: 900 + i, label: `T${i + 1}`, swatchHex: null, available: true, imageIndexes: [] }));
  const variants = values.map((v, i) => ({ ...base, id: 9000 + i, sku: `T-${i + 1}`, optionValueIds: [v.id], key: String(v.id), label: v.label, isDefault: i === defaultAt, price: { ...base.price, amountDzd: 1000 + i, label: `${1000 + i} DA` } }));
  return { ...p, options: [{ id: 99, type: 'size', name: 'Taille', values }], variants };
}

describe('single option with 9+ values (no JS)', () => {
  it('one block per value in radio order; the default block is marked visible wherever it sits', async () => {
    const p = tenSizes(product('fr', APRON), 9);
    // Orderable ⇒ the sticky buy bar (second .cat-vps) is rendered too, for the browser checks.
    const html = await render(p);
    expect(html).toContain('data-mode="single"');
    expect(html.match(/<div class="cat-vp[^"]*"[^>]*data-k="/g)).toHaveLength(10);
    expect(tag(html, /<div class="cat-vp cat-vp-d"[^>]*>/)).toContain('data-v="9009"');
    expect(tag(html, /<input[^>]*id="ov-909"[^>]*>/)).toMatch(/name="v" value="9009"[^>]*checked/);
    // The neutral "from" block comes after every positional block, so the :nth-child rules never reach it.
    const box = tag(html, /<div class="cat-vps"[\s\S]*?<div class="cat-picker"/);
    expect(box.lastIndexOf('cat-vp-any')).toBeGreaterThan(box.lastIndexOf('data-k="909"'));
    expect(box).toMatch(/cat-vp-any[\s\S]*?1000 DA/);
    // PAGES_RENDER_OUT=<dir>: keep the markup for the no-JS browser check (artifacts/PAGES-5).
    const out = process.env['PAGES_RENDER_OUT'];
    if (out) writeFileSync(`${out}/ten-sizes-default-10.html`, html);
  });
});

describe('JSON-LD', () => {
  it('Product with one Offer per active variant, DZD integer prices, schema.org availability', () => {
    const p = product('fr', APRON);
    const ld = productJsonLd(p) as { offers: { price: number; priceCurrency: string; availability: string; sku: string }[]; image: string[]; url: string };
    expect(ld.offers).toHaveLength(p.variants.length);
    for (const o of ld.offers) {
      expect(o.priceCurrency).toBe('DZD');
      expect(Number.isInteger(o.price)).toBe(true);
    }
    expect(ld.offers.find((o) => o.sku === 'TAB-M-BLU')?.availability).toBe('https://schema.org/OutOfStock');
    expect(ld.url).toBe(p.layout.canonicalUrl);
    for (const i of ld.image) expect(i).toMatch(/^https:\/\//);
  });
  it('single variant ⇒ one Offer object; brand only when set', () => {
    const ld = productJsonLd(product('ar', KNIVES)) as { offers: unknown; brand?: { name: string } };
    expect(Array.isArray(ld.offers)).toBe(false);
    expect(ld.brand?.name).toBe('HB Home');
    expect((productJsonLd(product('ar', PAN)) as { brand?: unknown }).brand).toBeUndefined();
  });
  it('serialisation cannot close the script element', () => {
    const s = serializeJsonLd({ name: '</script><script>alert(1)</script> ' });
    expect(s).not.toContain('<');
    expect(s).not.toContain(' ');
    expect(JSON.parse(s).name).toBe('</script><script>alert(1)</script> ');
  });
});
