/**
 * The order journey works with JavaScript disabled, in both languages: product page → the GET
 * form's CTA → order step (which cannot read the query, so the customer picks the variant there:
 * ORDER-STEP plan §7 Q0) → server review step rendered by the Worker → confirm → 303 to the
 * confirmation page (BRIEF §2).
 */
import { afterAll, beforeAll, describe, expect } from 'vitest';
import type { Browser } from 'playwright';
import { needs } from './needs.ts';
import { chooseVariant, expectNumbersShown, fillCustomer, launch, loopbackContext, openOrderStep, orderByRef, pickPlace, pickVariant, submitUntilConfirmed } from './flows.ts';

let browser: Browser | undefined;
beforeAll(async () => { browser = await launch(); });
afterAll(async () => { await browser?.close(); });

describe.each(['ar', 'fr'] as const)('no-JS order in /%s/', (lang) => {
  needs('storefront', 'seed', 'webOrder', 'orderForm')('review page shows fee and total, confirm creates the order', async ({ web }) => {
    const ctx = await loopbackContext(browser as Browser, { javaScriptEnabled: false });
    const page = await ctx.newPage();
    const v = pickVariant(lang);
    const place = pickPlace();
    await openOrderStep(page, web, lang, v);
    await chooseVariant(page, v); // the step shows the default: the customer picks again
    // without JS the commune list may only appear on the review page: fill what the form offers
    const form = page.locator('form[action="/api/order"]');
    await form.locator('[name="name"]').fill(`E2E NoJS ${lang}`);
    await form.locator('[name="phone"]').fill(lang === 'ar' ? '0661234567' : '0771234567');
    await form.locator('select[name="wilayaCode"]').selectOption(String(place.wilaya));
    await Promise.all([page.waitForURL(/\/api\/order/, { timeout: 20_000 }), form.locator('button[type="submit"], input[type="submit"]').last().click()]);
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
