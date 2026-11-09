/** The shopper's path in both languages, exact counts and parameters (contract §11 rows 8, 9). */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { startMetaStandIn, type MetaStandIn } from '../../apps/web/test/support/meta-stand-in.ts';
import { expectNumbersShown, expectPreselected, fillCustomer, openOrderStep, orderByRef, submitUntilConfirmed } from './flows.ts';
import { expectNoUnexpectedRequests, CONFIGURED, LANGS, STAND_IN_PORT, expectShape, fbqCalls, launchMeta, metaContext, place, simpleProducts, tracked, uniqueSeed, until, variant, waitTracked, type Lang } from './meta-support.ts';

describe.runIf(CONFIGURED)('Meta funnel', () => {
  let browser: Browser;
  let standIn: MetaStandIn;
  const web = () => inject('webUrl') as string;
  beforeAll(async () => {
    browser = await launchMeta();
    standIn = await startMetaStandIn(STAND_IN_PORT);
  });
  afterAll(async () => {
    await browser?.close();
    await standIn?.close().catch(() => {});
  });
  beforeEach(() => standIn.reset());
  afterEach(expectNoUnexpectedRequests);

  async function addToCart(page: Page, p: { slug: string }, lang: Lang, expectAdded: number) {
    await page.goto(`${web()}/${lang}/p/${p.slug}/`);
    // A click before the Pixel has started is not counted, so wait for it the way a shopper's first look would.
    await waitTracked(page, 'ViewContent');
    await new Promise((ok) => setTimeout(ok, 300));
    const add = page.locator('.cat-add-cart').first();
    await add.waitFor({ state: 'visible' });
    await add.click();
    await waitTracked(page, 'AddToCart', expectAdded);
  }

  describe.each(LANGS)('/%s/', (lang) => {
    it('ViewContent once on a product page, with the default variant', async () => {
      const { ctx } = await metaContext(browser, { consent: 'granted' });
      const page = await ctx.newPage();
      const v = variant(lang);
      await page.goto(`${web()}/${lang}/p/${v.slug}/`);
      await waitTracked(page, 'ViewContent');
      await new Promise((ok) => setTimeout(ok, 300));
      const views = await tracked(page, 'ViewContent');
      expect(views).toHaveLength(1);
      const content = await page.locator('[data-meta-content]').getAttribute('data-meta-content');
      const [id, price] = content!.split(':');
      expect(views[0]![2]).toEqual({ content_type: 'product', content_ids: [id], currency: 'DZD', value: Number(price) });
      expectShape(await fbqCalls(page));
      await ctx.close();
    });

    it('AddToCart counts the added quantity: a new line, then a second unit', async () => {
      const { ctx } = await metaContext(browser, { consent: 'granted' });
      const page = await ctx.newPage();
      const [p] = simpleProducts(lang);
      await addToCart(page, p!, lang, 1);
      expect((await tracked(page, 'AddToCart'))[0]![2]).toEqual({ content_type: 'product', contents: [{ id: String(p!.variantId), quantity: 1 }], currency: 'DZD', value: p!.price });

      await page.keyboard.press('Escape');
      const add = page.locator('.cat-add-cart').first();
      await add.click();
      await waitTracked(page, 'AddToCart', 2);
      const calls = await tracked(page, 'AddToCart');
      expect(calls).toHaveLength(2);
      expect(calls[1]![2]).toEqual({ content_type: 'product', contents: [{ id: String(p!.variantId), quantity: 1 }], currency: 'DZD', value: p!.price });
      expectShape(await fbqCalls(page));
      await ctx.close();
    });

    it('InitiateCheckout once on the order step, for the chosen variant', async () => {
      const { ctx } = await metaContext(browser, { consent: 'granted' });
      const page = await ctx.newPage();
      const v = variant(lang);
      await openOrderStep(page, web(), lang, v);
      await expectPreselected(page, v);
      await waitTracked(page, 'InitiateCheckout');
      await new Promise((ok) => setTimeout(ok, 300));
      const calls = await tracked(page, 'InitiateCheckout');
      expect(calls).toHaveLength(1);
      expect(calls[0]![2]).toMatchObject({ content_type: 'product', contents: [{ id: String(v.variantId), quantity: 1 }], num_items: 1, currency: 'DZD', value: v.price });
      expectShape(await fbqCalls(page));
      await ctx.close();
    });

    it('a two-line cart: InitiateCheckout once at checkout, then Purchase and the server event list every line', async () => {
      const { ctx } = await metaContext(browser, { consent: 'granted' });
      const page = await ctx.newPage();
      const [a, b] = simpleProducts(lang);
      await addToCart(page, a!, lang, 1);
      await addToCart(page, b!, lang, 1);

      await page.goto(`${web()}/${lang}/checkout/`);
      await waitTracked(page, 'InitiateCheckout');
      const ic = await tracked(page, 'InitiateCheckout');
      expect(ic).toHaveLength(1);
      const lines = [{ id: String(a!.variantId), quantity: 1 }, { id: String(b!.variantId), quantity: 1 }];
      expect(ic[0]![2]).toEqual({ content_type: 'product', contents: lines, num_items: 2, currency: 'DZD', value: a!.price + b!.price });

      const where = place();
      await page.locator('form[action="/api/order"]').waitFor({ state: 'visible' });
      await fillCustomer(page, where, uniqueSeed(), 1);
      const total = a!.price + b!.price + where.fee;
      await expectNumbersShown(page, [total]);
      const ref = await submitUntilConfirmed(page);

      await waitTracked(page, 'Purchase');
      await until(() => standIn.events().length === 1, 'one server event');
      const row = orderByRef(ref);
      expect(row.total_dzd).toBe(total);
      const purchase = (await tracked(page, 'Purchase'))[0]!;
      expect(purchase[2]).toEqual({ currency: 'DZD', value: total, content_type: 'product', contents: lines });
      expect((purchase[3] as { eventID: string }).eventID).toBe(ref);
      expect(standIn.events()[0]).toMatchObject({ event_id: ref, custom_data: { value: total, contents: lines } });
      expectShape(await fbqCalls(page));
      await ctx.close();
    });
  });
});
