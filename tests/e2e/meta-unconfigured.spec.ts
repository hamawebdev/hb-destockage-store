/** With no Meta configuration: no script, no choice, no request (contract §11 row 3d; lead condition 1). */
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Browser } from 'playwright';
import { LANGS, MODE, launchMeta, metaContext, templateUrls, watchPage } from './meta-support.ts';
import { expectNumbersShown, expectPreselected, fillCustomer, openOrderStep, submitUntilConfirmed } from './flows.ts';
import { place, uniqueSeed, variant } from './meta-support.ts';

const web = () => inject('webUrl') as string;

describe.runIf(MODE === 'unconfigured')('Meta not configured', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchMeta();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it.each(LANGS)('/%s/: no script, no choice, no request', async (lang) => {
    const { ctx, net } = await metaContext(browser);
    for (const { url } of templateUrls(lang)) {
      const page = await ctx.newPage();
      const errors = watchPage(page);
      await page.goto(`${web()}${url}`);
      await page.waitForLoadState('load');
      await page.mouse.wheel(0, 200);
      await new Promise((ok) => setTimeout(ok, 700));
      expect(await page.locator('.mc').count()).toBe(0);
      expect(await page.evaluate(() => typeof (window as unknown as { fbq?: unknown }).fbq)).toBe('undefined');
      expect(await page.locator('[data-meta-pixel],[data-meta-content]').count()).toBe(0);
      expect(errors).toEqual([]);
      await page.close();
    }
    expect(net.meta).toEqual([]);
    expect(net.unexpected).toEqual([]);
    await ctx.close();
  });

  it.each(LANGS)('/%s/: the Worker-served confirmation page has no Meta origin in its CSP', async (lang) => {
    const { ctx } = await metaContext(browser);
    const page = await ctx.newPage();
    const r = await page.goto(`${web()}/${lang}/order/confirmation/?ref=HB-AAAAA`);
    expect(r!.headers()['content-security-policy'] ?? '').not.toContain('facebook');
    await ctx.close();
  });

  it.each(LANGS)('/%s/: an order goes through with no Meta request', async (lang) => {
    const { ctx, net } = await metaContext(browser);
    const page = await ctx.newPage();
    const v = variant(lang);
    const where = place();
    await openOrderStep(page, web(), lang, v);
    await expectPreselected(page, v);
    await fillCustomer(page, where, uniqueSeed(), 1);
    await expectNumbersShown(page, [where.fee, v.price + where.fee]);
    const ref = await submitUntilConfirmed(page);
    expect(ref).toMatch(/^HB-/);
    expect(net.meta).toEqual([]);
    await ctx.close();
  });
});
