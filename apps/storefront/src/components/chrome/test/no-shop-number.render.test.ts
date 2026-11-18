// D-029: shoppers see the shop's phone and WhatsApp only after ordering. The footer (on every page), the home page,
// every product page and every order step of the fixture catalogue carry neither; the confirmation page still does.
import { fixturePages } from '@hb/catalog/fixtures/props';
import type { ContactProps, HomeProps, LayoutProps, OrderConfirmationProps, OrderStepProps, ProductProps } from '@hb/catalog';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import Footer from '../Footer.astro';
import HomeView from '../../home/HomeView.astro';
import ProductView from '../../catalog/ProductView.astro';
import OrderStepView from '../../catalog/OrderStepView.astro';
import Confirmation from '../../order/Confirmation.astro';

let container: AstroContainer;
beforeAll(async () => {
  container = await AstroContainer.create();
});

/** The shop's numbers in any spelling a page could carry them: display digits, tel:, wa.me. */
const shopNumber = (c: ContactProps): RegExp => {
  const national = c.phoneDisplay.replace(/\D/g, '').replace(/^0/, '');
  const wa = c.whatsappHref.replace(/\D/g, '').replace(/^213/, '');
  return new RegExp([national, wa, c.phoneDisplay, c.whatsappDisplay].map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + '|tel:|wa\\.me');
};
const digitsOnly = (html: string) => html.replace(/[\s ⁦-⁩]/g, '');

describe.each(['ar', 'fr'] as const)('no shop number before an order (%s)', (lang) => {
  const pages = Object.values(fixturePages(lang));
  const of = <T>(template: string) => pages.filter((p) => p.template === template).map((p) => p.props as T);
  const layout = of<HomeProps>('home')[0]!.layout as LayoutProps;
  const re = shopNumber(layout.contact);
  const clean = (html: string) => {
    expect(html).not.toMatch(re);
    expect(digitsOnly(html)).not.toMatch(re);
  };

  it('footer', async () => clean(await container.renderToString(Footer, { props: { layout } })));

  it('home page', async () => clean(await container.renderToString(HomeView, { props: { props: of<HomeProps>('home')[0]!, tiles: [] } })));

  it('every product page, sold out included', async () => {
    const products = of<ProductProps>('product');
    expect(products.length).toBeGreaterThan(0);
    for (const p of products) clean(await container.renderToString(ProductView, { props: { ...p } }));
  });

  it('every order step', async () => {
    const steps = of<OrderStepProps>('order-step');
    expect(steps.length).toBeGreaterThan(0);
    for (const p of steps) clean(await container.renderToString(OrderStepView, { props: { ...p } }));
  });

  it('the confirmation page still gives both, as working links', async () => {
    const props = of<OrderConfirmationProps>('order-confirmed')[0]!;
    const html = await container.renderToString(Confirmation, { props: { props } });
    expect(html).toContain(`href="${props.layout.contact.phoneHref}"`);
    expect(html).toContain(`href="${props.layout.contact.whatsappHref}"`);
    expect(props.layout.contact.phoneHref).toMatch(/^tel:\+213\d{9}$/);
    expect(props.layout.contact.whatsappHref).toMatch(/^https:\/\/wa\.me\/213\d{9}$/);
  });
});
