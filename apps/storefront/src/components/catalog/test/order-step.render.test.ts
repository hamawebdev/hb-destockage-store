// ORDER-STEP: the order step page, rendered with Astro's container on CAT-3's fixture props (ar, fr).
import { fixturePages } from '@hb/catalog/fixtures/props';
import type { OrderStepProps } from '@hb/catalog';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';
import OrderStepView from '../OrderStepView.astro';

let container: AstroContainer;
beforeAll(async () => {
  container = await AstroContainer.create();
});

type L = 'ar' | 'fr';
const pages = { ar: fixturePages('ar'), fr: fixturePages('fr') };
const step = (l: L, slug: { ar: string; fr: string }): OrderStepProps => {
  const page = pages[l][`/${l}/order/${slug[l]}/`];
  if (!page || page.template !== 'order-step') throw new Error(`no order step ${slug[l]}`);
  return page.props as OrderStepProps;
};
const render = (p: OrderStepProps) => container.renderToString(OrderStepView, { props: { ...p } });
const APRON = { fr: 'tablier-de-cuisine', ar: 'mariyalat-matbakh' };
const PAN = { fr: 'poele-28-cm', ar: 'miqlat-28-cm' };
const KNIVES = { fr: 'set-de-couteaux', ar: 'taqm-sakakin' };

describe.each(['ar', 'fr'] as const)('order step (%s)', (l) => {
  it('is noindex and links back to the product, with the order breadcrumb', async () => {
    const p = step(l, APRON);
    expect(p.layout.noindex).toBe(true);
    const html = await render(p);
    expect(html).toContain(`class="cat-more cat-step-back" href="${p.product.href}"`);
    expect(html).toContain('<nav class="cat-crumbs"');
    expect(html).toContain(p.breadcrumbs[p.breadcrumbs.length - 1]!.label);
  });

  it('summary: the title is the h1, the photo is eager with no fetchpriority (LCP is text)', async () => {
    const p = step(l, APRON);
    const html = await render(p);
    expect(html).toMatch(new RegExp(`<h1 class="cat-step-title">${p.product.name}</h1>`));
    const img = html.match(/<img class="cat-step-img"[^>]*>/)?.[0] ?? '';
    expect(img).toContain('loading="eager"');
    expect(img).not.toContain('fetchpriority');
    expect(img).toContain(`sizes="${p.image!.sizes}"`);
  });

  it('variants: picker inputs join the order form; one price block per variant with variant.js data', async () => {
    const p = step(l, APRON);
    const html = await render(p);
    expect(html).toContain('<form id="order-form"');
    for (const o of p.options) expect(html).toContain(`name="opt.${o.id}"`);
    expect(html.match(/<input[^>]*class="cat-val-in"[^>]*form="order-form"/g)?.length).toBe(p.options.reduce((n, o) => n + o.values.length, 0));
    expect(html).toMatch(/<input type="hidden" name="variantId" value="" form="order-form">/);
    for (const v of p.variants) expect(html).toContain(`data-v="${v.id}"`);
    expect(html).toContain('class="container cat-pdp cat-step"');
    expect(html).not.toContain('#order"');
  });

  it('single variant: no picker, the form posts its own variantId', async () => {
    const html = await render(step(l, KNIVES));
    expect(html).not.toContain('cat-picker');
    expect(html).toMatch(/<input[^>]*name="variantId"[^>]*>/);
  });

  it('sold out: the page exists, the form is disabled', async () => {
    const p = step(l, PAN);
    expect(p.orderForm.orderable).toBe(false);
    const html = await render(p);
    expect(html).toMatch(/<fieldset[^>]*disabled/);
    expect(html).toContain('cat-stock--out_of_stock');
  });
});
