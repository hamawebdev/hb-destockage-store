// CART-3: buy link on product cards when the cart is off (ledger C-6, C-7), rendered with Astro's container on
// CAT-3's fixture props with layout.cartEnabled switched.
import { fixturePages } from '@hb/catalog/fixtures/props';
import type { CategoryProps, HomeProps, LayoutProps, ProductProps, SearchProps } from '@hb/catalog';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import CategoryView from '../CategoryView.astro';
import ProductView from '../ProductView.astro';
import SearchView from '../SearchView.astro';
import HomeView from '../../home/HomeView.astro';

let container: AstroContainer;
beforeAll(async () => {
  container = await AstroContainer.create();
});

type WithLayout = { layout: LayoutProps };
const pages = { ar: fixturePages('ar'), fr: fixturePages('fr') };
function page<T extends WithLayout>(lang: 'ar' | 'fr', template: string, cartEnabled: boolean): T {
  const p = Object.values(pages[lang]).find((x) => x.template === template && (template !== 'category' || (x.props as CategoryProps).products.length > 0));
  if (!p) throw new Error(`no ${template} page`);
  const props = p.props as unknown as T;
  return { ...props, layout: { ...props.layout, cartEnabled } };
}
const cardsOf = (props: unknown): { name: string; orderHref: string; href: string }[] => {
  const p = props as Partial<HomeProps & CategoryProps & SearchProps & ProductProps>;
  return [...(p.featured ?? []), ...(p.packs ?? []), ...(p.products ?? []), ...(p.suggested ?? []), ...(p.related ?? [])];
};
const VIEWS = [
  ['home', HomeView],
  ['category', CategoryView],
  ['search', SearchView],
  ['product', ProductView],
] as const;
/** HomeView takes `{ props, tiles }`; the others take the page props directly. */
const wrap = (template: string, props: unknown): unknown => (template === 'home' ? { props, tiles: [] } : props);
const buyLinks = (html: string) => [...html.matchAll(/<a class="cat-card-buy" href="([^"]+)" data-no-prefetch>([^<]+)<span class="cat-sr"> ([^<]+)<\/span><\/a>/g)];

describe.each(['ar', 'fr'] as const)('cards (%s)', (lang) => {
  const verb = lang === 'ar' ? 'اطلب الآن' : 'Commander';
  it.each(VIEWS)('%s, cart off: one buy link per card, to its order form, named "<verb> <product>"', async (template, View) => {
    const props = page<WithLayout>(lang, template, false);
    const cards = cardsOf(props);
    expect(cards.length).toBeGreaterThan(0);
    const html = await container.renderToString(View as never, { props: wrap(template, props) as never });
    const links = buyLinks(html);
    // Home shows whole rows only, so it may render fewer cards than its props carry: every rendered card has its link.
    expect(links.length).toBe((html.match(/<article class="cat-card/g) ?? []).length);
    expect(links.length).toBeGreaterThan(0);
    if (template !== 'home') expect(links.length).toBe(cards.length);
    for (const l of links) {
      const c = cards.find((x) => x.orderHref === l[1]);
      expect(c, l[1]).toBeDefined();
      expect(l[1]).toMatch(new RegExp(`^/${lang}/order/[a-z0-9-]+/$`));
      expect(l[2]).toBe(props.layout.strings['product.orderCta']);
      expect(l[3]).toBe(c!.name);
    }
    // No add-to-cart anywhere when the cart is off: cards (CART-3) and the PDP's own button (CART-4).
    expect(html).not.toContain('data-cart-add');
    expect(html).not.toContain('cat-add-cart');
  });

  it.each(VIEWS)('%s, cart on: no buy link (today\'s markup)', async (template, View) => {
    const props = page<WithLayout>(lang, template, true);
    const html = await container.renderToString(View as never, { props: wrap(template, props) as never });
    expect(html).not.toContain('cat-card-buy');
    if (template === 'home') expect(html).toContain('data-cart-add');
    if (template === 'product') expect(html).toContain('cat-add-cart');
  });

  it('search, cart off: the results\' buy label travels in data-i18n; cart on: it does not', async () => {
    const off = await container.renderToString(SearchView, { props: page<SearchProps>(lang, 'search', false) as never });
    const on = await container.renderToString(SearchView, { props: page<SearchProps>(lang, 'search', true) as never });
    expect(off).toContain('card.buy');
    expect(on).not.toContain('card.buy');
  });

  it('the orderCta string is the verb the card shows', () => {
    expect(pages[lang] && page<WithLayout>(lang, 'home', false).layout.strings['product.orderCta']).toBe(verb);
  });
});
