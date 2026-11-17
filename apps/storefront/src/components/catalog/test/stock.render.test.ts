// PAGES-4: stock and availability states on cards and product pages, related products and
// placeholder copy, rendered with Astro's container on CAT-3's fixture props (both languages).
import { fixturePages } from '@hb/catalog/fixtures/props';
import type { CategoryProps, ProductCard as Card, ProductProps, StockProps } from '@hb/catalog';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import ProductCard from '../ProductCard.astro';
import ProductView from '../ProductView.astro';
import Stock from '../Stock.astro';

let container: AstroContainer;
beforeAll(async () => {
  container = await AstroContainer.create();
});
afterEach(() => {
  delete process.env['HB_STRICT_COPY'];
});

type L = 'ar' | 'fr';
const pages = { ar: fixturePages('ar'), fr: fixturePages('fr') };
const product = (l: L, slug: { ar: string; fr: string }): ProductProps => pages[l][`/${l}/p/${slug[l]}/`]!.props as ProductProps;
const strings = (l: L) => product(l, PAN).layout.strings;
const PAN = { fr: 'poele-28-cm', ar: 'miqlat-28-cm' }; // simple, out of stock (orderable false)
const POT = { fr: 'casserole-20-cm', ar: 'tanjara-20-cm' }; // simple, low stock (2)
const KNIVES = { fr: 'set-de-couteaux', ar: 'taqm-sakakin' }; // untracked stock
const RACK = { fr: 'egouttoir', ar: 'musaffat' }; // placeholder; Arabic translation placeholder
const APRON = { fr: 'tablier-de-cuisine', ar: 'mariyalat-matbakh' }; // variants: in / out / low
const card = (l: L, name: string): Card => {
  const cards = Object.values(pages[l]).flatMap((p) => (p.template === 'category' ? (p.props as CategoryProps).products : []));
  const c = cards.find((x) => x.name.startsWith(name));
  if (!c) throw new Error(`no card ${name}`);
  return c;
};
const renderCard = (l: L, c: Card) => container.renderToString(ProductCard, { props: { card: c, lang: l, strings: strings(l) } });
const stockLine = (l: L, s: StockProps, quiet = false) => container.renderToString(Stock, { props: { stock: s, lang: l, strings: strings(l), quiet } });

describe.each(['ar', 'fr'] as const)('stock states (%s)', (l) => {
  const s = () => strings(l);

  it('Stock: four states as text + class, plural low-stock count, quiet hides in-stock only', async () => {
    expect(await stockLine(l, { state: 'out_of_stock', qty: 0 })).toContain(s()['stock.out']!);
    expect(await stockLine(l, { state: 'in_stock', qty: 9 })).toContain(s()['stock.in']!);
    expect(await stockLine(l, { state: 'in_stock', qty: null })).toContain(s()['stock.available']!);
    const low = await stockLine(l, { state: 'low_stock', qty: 3 });
    expect(low).toContain('cat-stock--low_stock');
    expect(low).toContain(s()['stock.low.few']!.replace('{count}', '3'));
    expect(await stockLine(l, { state: 'in_stock', qty: 9 }, true)).toBe('');
    expect(await stockLine(l, { state: 'in_stock', qty: null }, true)).toBe('');
    expect(await stockLine(l, { state: 'low_stock', qty: 2 }, true)).toContain('cat-stock--low_stock');
  });

  it('cards: sold out is dimmed and says so; low stock shows; untracked and in-stock stay quiet', async () => {
    const out = await renderCard(l, card(l, product(l, PAN).product.name));
    expect(out).toContain('cat-card--out');
    expect(out).toContain(s()['stock.out']!);
    const low = await renderCard(l, card(l, product(l, POT).product.name));
    expect(low).toContain('cat-stock--low_stock');
    const untracked = await renderCard(l, card(l, product(l, KNIVES).product.name));
    expect(untracked).not.toContain('cat-stock');
    expect(untracked).not.toContain('cat-card--out');
  });

  it('variable card: "from" price over orderable variants, colour dots', async () => {
    const html = await renderCard(l, card(l, product(l, APRON).product.name));
    expect(html).toContain(s()['price.from']!.split('{price}')[0]!.trim());
    expect(html).toMatch(/<li class="cat-dot"><svg/);
  });

  it('product page: sold out ⇒ "épuisé" block, no picker, no order bar; low ⇒ count; untracked ⇒ "disponible"', async () => {
    const pan = product(l, PAN);
    expect(pan.orderForm.orderable).toBe(false);
    const html = await container.renderToString(ProductView, { props: { ...pan } });
    expect(html).toContain('cat-stock--out_of_stock');
    expect(html).not.toContain('cat-buybar');
    expect(html).not.toContain('data-cta');
    expect(html).toContain('href="https://wa.me/'); // sold out: ask on WhatsApp instead
    expect(html).not.toContain('cat-picker');
    expect(await container.renderToString(ProductView, { props: { ...product(l, POT) } })).toContain(s()['stock.low.two']!.replace('{count}', '2'));
    expect(await container.renderToString(ProductView, { props: { ...product(l, KNIVES) } })).toContain(s()['stock.available']!);
  });

  it('variants: one block per variant with its own state; the sold-out one is marked unavailable for variant.js', async () => {
    const p = product(l, APRON);
    const html = await container.renderToString(ProductView, { props: { ...p } });
    for (const v of p.variants) {
      const block = html.match(new RegExp(`<div class="cat-vp[^"]*"[^>]*data-k="${v.key}"[^>]*>[\\s\\S]*?</div>\\s*</div>`))?.[0] ?? '';
      expect(block, v.sku).toContain(`cat-stock--${v.stock.state}`);
      expect(block).toContain(`data-a="${v.available ? 1 : 0}"`);
      expect(block).toContain(`data-max="${v.maxQty}"`);
    }
  });

  it('related products: rendered as cards under their own heading with a link to the category', async () => {
    const p = product(l, POT);
    const html = await container.renderToString(ProductView, { props: { ...p } });
    expect(html).toContain('id="cat-rel-h"');
    for (const r of p.related) expect(html).toContain(`href="${r.href}"`);
    expect(html).toContain(`href="${p.category!.href}"`);
    const none = await container.renderToString(ProductView, { props: { ...p, related: [] } });
    expect(none).not.toContain('cat-rel-h');
  });

  it('placeholder products: their [PLACEHOLDER] copy is shown as provided; QA markers dev-only', async () => {
    const p = product(l, RACK);
    const dev = await container.renderToString(ProductView, { props: { ...p } });
    expect(dev).toContain(p.product.name);
    expect(p.product.name).toContain('[PLACEHOLDER]');
    expect(dev).toContain('cat-pdp-ph');
    const c = await renderCard(l, card(l, p.product.name));
    expect(c).toContain('cat-flag--ph');
    process.env['HB_STRICT_COPY'] = '1';
    const strictCard = await renderCard(l, card(l, p.product.name));
    expect(strictCard).toContain(p.product.name); // data copy stays visible as provided
    expect(strictCard).not.toContain('cat-flag--ph');
  });
});

describe('Arabic translation placeholder', () => {
  it('flags the Arabic card only, and the rendered pill follows translationPlaceholder', async () => {
    const ar = card('ar', product('ar', RACK).product.name.split(' ')[0]!);
    const fr = card('fr', product('fr', RACK).product.name.split(' ')[0]!);
    expect(ar.translationPlaceholder).toBe(true);
    expect(fr.translationPlaceholder).toBe(false);
    // Same card without the content placeholder: only the translation flag decides the pill.
    expect(await renderCard('ar', { ...ar, placeholder: false })).toContain('cat-flag--ph');
    expect(await renderCard('fr', { ...fr, placeholder: false })).not.toContain('cat-flag--ph');
  });
  it('the product page banner follows translationPlaceholder too', async () => {
    const ar = product('ar', RACK);
    const fr = product('fr', RACK);
    const html = (p: ProductProps) => container.renderToString(ProductView, { props: { ...p, product: { ...p.product, placeholder: false } } });
    expect(await html(ar)).toContain('cat-pdp-ph');
    expect(await html(fr)).not.toContain('cat-pdp-ph');
  });
});
