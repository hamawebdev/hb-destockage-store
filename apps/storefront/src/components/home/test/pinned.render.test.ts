// D-026: products with no category lead the home products section (`pinnedCount`), and the whole-row trim
// (which hides trailing cards at 2, 3 and 4 columns) is skipped whenever it would hide one of them.
// Also: a product page with no category renders without the "more in <category>" link and JSON-LD category.
import { fixturePages } from '@hb/catalog/fixtures/props';
import type { HomeProps, ProductCard, ProductProps } from '@hb/catalog';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import ProductView from '../../catalog/ProductView.astro';
import { productJsonLd } from '../../catalog/lib/jsonld.ts';
import HomeView from '../HomeView.astro';

let container: AstroContainer;
beforeAll(async () => {
  container = await AstroContainer.create();
});

const pages = Object.values(fixturePages('fr'));
const home = pages.find((p) => p.template === 'home')!.props as HomeProps;
const card = home.featured[0]!;
const cards = (n: number): ProductCard[] => Array.from({ length: n }, (_, i) => ({ ...card, id: 9000 + i, name: `Carte ${i}` }));
const classes = async (featured: ProductCard[], pinnedCount: number): Promise<string> => {
  const html = await container.renderToString(HomeView, { props: { props: { ...home, featured, packs: [], pinnedCount }, tiles: [] } });
  return /class="(hm-products[^"]*)"/.exec(html)![1]!;
};

describe('home products section', () => {
  it('trims to whole rows when no leading card is pinned (unchanged behaviour)', async () => {
    expect(await classes(cards(5), 0)).toBe('hm-products hm-g2-odd hm-g3-3 hm-g4-4');
  });

  it('never trims a pinned card away: 5 cards, all without a category', async () => {
    // 5 is not a rule (rules exist for whole rows only), so nothing is hidden at any width.
    expect(await classes(cards(5), 5)).toBe('hm-products hm-g3-5 hm-g4-5');
  });

  it('trims only the columns where every hidden card is a categorised one', async () => {
    // 7 cards, 5 pinned: 2 columns would hide card 7 (fine), 3 columns keep 6 (fine), 4 columns would keep 4 (< 5): skipped.
    expect(await classes(cards(7), 5)).toBe('hm-products hm-g2-odd hm-g3-6 hm-g4-7');
  });

  it('a card with no photo still renders its name, price and link', async () => {
    const html = await container.renderToString(HomeView, { props: { props: { ...home, featured: [{ ...card, image: null }], packs: [], pinnedCount: 1 }, tiles: [] } });
    expect(html).toContain(`href="${card.href}"`);
    expect(html).toContain(card.name);
    expect(html).toContain('hm-solo');
  });
});

describe('product page with no category', () => {
  const p = pages.find((x) => x.template === 'product' && (x.props as ProductProps).related.length > 0)!.props as ProductProps;
  const bare: ProductProps = { ...p, category: null, breadcrumbs: [p.breadcrumbs[0]!, p.breadcrumbs.at(-1)!] };

  it('keeps the related products, drops the category link', async () => {
    const html = await container.renderToString(ProductView, { props: { ...bare } });
    expect(html).toContain('id="cat-rel-h"');
    expect(html).not.toContain('cat-more');
    expect(html).not.toContain(`href="${p.category!.href}"`);
  });

  it('JSON-LD has no category key', () => {
    expect(productJsonLd(p)).toHaveProperty('category');
    expect(productJsonLd(bare)).not.toHaveProperty('category');
  });
});
