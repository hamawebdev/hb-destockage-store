/**
 * The order form works with JavaScript disabled (BRIEF §2: server review step rendered by the
 * Worker, then confirm → 303 to the confirmation page), in both languages.
 */
import { afterAll, beforeAll, describe, expect } from 'vitest';
import type { Browser } from 'playwright';
import { needs } from './needs.ts';
import { chooseVariant, expectNumbersShown, fillCustomer, launch, orderByRef, pickPlace, pickVariant, submitUntilConfirmed } from './flows.ts';

let browser: Browser | undefined;
beforeAll(async () => { browser = await launch(); });
afterAll(async () => { await browser?.close(); });

describe.each(['ar', 'fr'] as const)('no-JS order in /%s/', (lang) => {
  needs('storefront', 'seed', 'webOrder', 'orderForm')('review page shows fee and total, confirm creates the order', async ({ web }) => {
    const ctx = await (browser as Browser).newContext({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    const v = pickVariant(lang);
    const place = pickPlace();
    const res = await page.goto(`${web}/${lang}/p/${v.slug}/`);
    expect(res?.status()).toBe(200);
    await chooseVariant(page, v);
    // without JS the commune list may only appear on the review page: fill what the form offers
    const form = page.locator('form[action="/api/order"]');
    await form.locator('[name="name"]').fill(`E2E NoJS ${lang}`);
    await form.locator('[name="phone"]').fill(lang === 'ar' ? '0661234567' : '0771234567');
    await form.locator('select[name="wilayaCode"]').selectOption(String(place.wilaya));
    await Promise.all([page.waitForLoadState('load'), form.locator('button[type="submit"], input[type="submit"]').last().click()]);
    // server review step (POST /api/order without step=confirm → 200 review page)
    expect(page.url()).toContain('/api/order');
    if (await page.locator('[name="communeId"]').count()) {
      await page.locator('[name="communeId"]').selectOption(String(place.communeId));
    } else {
      await fillCustomer(page, place, 3, 1);
    }
    const total = v.price + place.fee;
    await expectNumbersShown(page, [place.fee, total], 'body');
    await page.waitForTimeout(1600); // MIN_REVIEW_MS (1500) before confirming
    const ref = await submitUntilConfirmed(page);
    const o = orderByRef(ref);
    expect({ total: o.total_dzd, fee: o.fee_dzd, lang: o.lang }).toEqual({ total, fee: place.fee, lang });
    await ctx.close();
  });
});
