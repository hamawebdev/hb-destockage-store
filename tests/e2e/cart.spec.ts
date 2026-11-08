/**
 * The cart (CART-0, artifacts/CART-0/plan.md "Done means"), in /ar/ and /fr/ at 360 px, on the real Worker and the
 * real local D1: a real customer path through a real browser with the site's own CSP.
 *
 * The choice view needs a homepage product with options, which the seed does not have: that test runs on a scratch
 * build featuring a variable product and is skipped here otherwise (see FEATURES.homeChoice).
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
import { ARTIFACTS, d1, integersIn } from './harness.ts';
import { needs } from './needs.ts';
import { adminLogin, adminPage, cartLines, cartRaw, chooseVariant, closeSheet, ev, expectNumbersShown, fillCustomer, firstPlainCard, gotoCart, homeCards, itemJson, launch, loopbackContext, openOrderStep, orderByRef, pickPlace, pickVariant, seedCart, sellableVariants, sheet, submitUntilConfirmed, waitSheetOpen, expectPreselected } from './flows.ts';

const VIEW = { viewport: { width: 360, height: 800 }, isMobile: false };
const MAX_QTY = 10;
const MAX_LINES = 10;
const WANT = ['storefront', 'seed', 'webOrder', 'webQuote', 'orderForm'] as const;

let browser: Browser | undefined;
beforeAll(async () => { browser = await launch(); });
afterAll(async () => { await browser?.close(); });

const note = (line: string): void => {
  mkdirSync(ARTIFACTS, { recursive: true });
  appendFileSync(`${ARTIFACTS}/cart-refs.txt`, `${line}\n`);
  console.log(line);
};
const seed = (salt: number): number => (Date.now() % 1_000_000) + salt;
const context = (opts: Parameters<Browser['newContext']>[0] = {}): Promise<BrowserContext> => loopbackContext(browser as Browser, { ...VIEW, ...opts });

/** Numbers in a string, in Western digits (the Arabic count may use either). */
const numbers = (s: string): number[] => integersIn(s);

async function count(page: Page): Promise<number> {
  return (await cartLines(page)).reduce((n, l) => n + l.q, 0);
}
async function waitCount(page: Page, want: number): Promise<void> {
  const end = Date.now() + 10_000;
  for (;;) {
    const have = await count(page);
    if (have === want) return;
    if (Date.now() > end) throw new Error(`cart count ${have}, expected ${want}`);
    await page.waitForTimeout(100);
  }
}
/** The header count, once it has painted the wanted value. */
async function waitBadge(page: Page, want: number): Promise<void> {
  const n = page.locator('[data-cart-n]').first();
  const end = Date.now() + 10_000;
  for (;;) {
    const text = want === 0 ? '' : String(want);
    const shown = await n.textContent();
    const hidden = await n.isHidden();
    if ((want === 0 ? hidden : !hidden) && (shown ?? '') === text) return;
    if (Date.now() > end) throw new Error(`header count: shown "${shown}" hidden ${hidden}, expected ${want}`);
    await page.waitForTimeout(100);
  }
}
async function qtyOf(page: Page, variantId: number): Promise<string> {
  return (await sheet(page).locator(`.cs-i:has([data-k="plus:${variantId}"]) .cs-c`).textContent()) ?? '';
}
async function waitQty(page: Page, variantId: number, want: number): Promise<void> {
  const end = Date.now() + 10_000;
  for (;;) {
    const have = await qtyOf(page, variantId);
    if (have === String(want)) return;
    if (Date.now() > end) throw new Error(`variant ${variantId} shows quantity "${have}", expected ${want}`);
    await page.waitForTimeout(100);
  }
}
const focusInside = (page: Page): Promise<boolean> => ev<boolean>(page, `(() => { const d = document.querySelector('dialog.cs'); return !!d && d.contains(document.activeElement) && document.activeElement !== d })()`);

// ---------------------------------------------------------------------------------------------------------------------
// journeys
// ---------------------------------------------------------------------------------------------------------------------
describe.each(['ar', 'fr'] as const)('cart journey in /%s/ at 360 px', (lang) => {
  needs(...WANT, 'adminAuth', 'adminOrders')('X from a homepage card + Y from its product page, change a quantity in the sheet, order: one order with both lines', async ({ web, admin }) => {
    const ctx = await context();
    const page = await ctx.newPage();
    const place = pickPlace();
    await gotoCart(page, `${web}/${lang}/`);
    const x = await firstPlainCard(page, web, lang);
    await page.locator('[data-cart-add]').nth(x.index).click();
    await waitSheetOpen(page, 1);
    expect(await sheet(page).locator('.cs-ch').count(), 'a product with no choices goes straight in').toBe(0);
    await closeSheet(page);

    const y = pickVariant(lang);
    expect(y.productId, 'X and Y must be different products').not.toBe(x.item.id);
    await gotoCart(page, `${web}/${lang}/p/${y.slug}/`);
    await page.locator('a.cat-cta').first().waitFor({ state: 'visible', timeout: 15_000 });
    await chooseVariant(page, y);
    await page.locator('.cat-add-cart').click();
    await waitSheetOpen(page, 2);
    await waitQty(page, y.variantId, 1);

    await sheet(page).locator(`[data-k="plus:${y.variantId}"]`).click();
    await waitQty(page, y.variantId, 2);
    expect((await cartLines(page)).sort((a, b) => a.v - b.v), 'the cart holds ids and quantities').toEqual([
      { p: x.item.id, v: x.variantId, q: 1 }, { p: y.productId, v: y.variantId, q: 2 },
    ].sort((a, b) => a.v - b.v));
    expect(numbers((await sheet(page).locator('.cs-to bdi').textContent()) ?? ''), 'the sheet total counts the changed quantity')
      .toEqual([x.price + y.price * 2]);

    await Promise.all([page.waitForURL((u) => u.pathname === `/${lang}/checkout/`, { timeout: 20_000 }), sheet(page).locator('a.cs-go').click()]);
    await page.locator('#of-rows .of-row').nth(1).waitFor({ timeout: 15_000 });
    const s = seed(lang === 'ar' ? 11 : 12);
    const { phone } = await fillCustomer(page, place, s, 1);
    const subtotal = x.price + y.price * 2;
    const total = subtotal + place.fee;
    await expectNumbersShown(page, [place.fee, total]);
    const ref = await submitUntilConfirmed(page);
    expect(await page.locator('body').innerText()).toContain(ref);
    await waitBadge(page, 0); // only what was ordered leaves the cart, and everything was ordered
    expect(await cartLines(page), 'the cart is empty after the order').toEqual([]);

    const o = orderByRef(ref);
    expect({ lang: o.lang, subtotal: o.subtotal_dzd, fee: o.fee_dzd, total: o.total_dzd, wilaya: o.wilaya_code, commune: o.commune_id })
      .toEqual({ lang, subtotal, fee: place.fee, total, wilaya: place.wilaya, commune: place.communeId });
    const items = d1<{ variant_id: number; product_id: number; qty: number; unit_price_dzd: number; line_total_dzd: number }>(`SELECT variant_id, product_id, qty, unit_price_dzd, line_total_dzd FROM order_items WHERE order_id = ${o.id} ORDER BY variant_id`);
    expect(items).toEqual([
      { variant_id: x.variantId, product_id: x.item.id, qty: 1, unit_price_dzd: x.price, line_total_dzd: x.price },
      { variant_id: y.variantId, product_id: y.productId, qty: 2, unit_price_dzd: y.price, line_total_dzd: y.price * 2 },
    ].sort((a, b) => a.variant_id - b.variant_id));
    expect(d1<{ n: number }>(`SELECT COUNT(*) AS n FROM orders WHERE phone_e164 = '${o.phone_e164}'`)[0]?.n, 'one order, not one per product').toBe(1);

    const cookie = await adminLogin(admin);
    expect(await adminPage(admin, cookie, '/orders')).toContain(ref);
    const detail = await adminPage(admin, cookie, `/orders/${ref}`);
    expect(detail).toContain(ref);
    expect(detail, 'both lines are visible in the admin').toContain(x.sku);
    const ySku = d1<{ sku: string }>(`SELECT sku FROM variants WHERE id = ${y.variantId}`)[0]?.sku ?? '';
    expect(detail, 'both lines are visible in the admin').toContain(ySku);
    const adminNumbers = integersIn(detail.replace(/<[^>]+>/g, ' '));
    expect(adminNumbers, 'admin shows the delivery fee').toContain(place.fee);
    expect(adminNumbers, 'admin shows the total').toContain(total);

    note(`${lang} cart order ${ref}: ${x.sku} x1, ${ySku} x2, subtotal ${subtotal}, fee ${place.fee}, total ${total}, phone ${phone}`);
    await ctx.close();
  });

  needs(...WANT)('a direct order from the product page leaves hb.cart.v1 byte-identical', async ({ web }) => {
    const ctx = await context();
    const page = await ctx.newPage();
    await gotoCart(page, `${web}/${lang}/`);
    const x = await firstPlainCard(page, web, lang);
    await page.locator('[data-cart-add]').nth(x.index).click();
    await waitSheetOpen(page, 1);
    await closeSheet(page);
    await waitCount(page, 1);
    const before = await cartRaw(page);
    expect(before, 'the cart holds a line before the direct order').toBeTruthy();

    const place = pickPlace();
    const y = pickVariant(lang);
    await openOrderStep(page, web, lang, y);
    await expectPreselected(page, y);
    expect(await cartRaw(page), 'opening the order step').toBe(before);
    const s = seed(lang === 'ar' ? 21 : 22);
    await fillCustomer(page, place, s, 1);
    await expectNumbersShown(page, [place.fee, y.price + place.fee]);
    const ref = await submitUntilConfirmed(page);
    expect(await cartRaw(page), 'after the order').toBe(before);
    await page.locator('[data-cart-n]').first().waitFor({ state: 'attached' });
    const o = orderByRef(ref);
    expect({ subtotal: o.subtotal_dzd, total: o.total_dzd }).toEqual({ subtotal: y.price, total: y.price + place.fee });
    expect(d1<{ variant_id: number; qty: number }>(`SELECT variant_id, qty FROM order_items WHERE order_id = ${o.id}`), 'the cart line is not in the order').toEqual([{ variant_id: y.variantId, qty: 1 }]);
    note(`${lang} direct order ${ref}: variant ${y.variantId} x1, total ${o.total_dzd}, cart bytes unchanged: ${before}`);
    await ctx.close();

    // a visitor with no cart at all: the direct path never creates the key
    const fresh = await context();
    const p2 = await fresh.newPage();
    await openOrderStep(p2, web, lang, y);
    await expectPreselected(p2, y);
    expect(await cartRaw(p2), 'a direct order must not create the cart key').toBeNull();
    await fresh.close();
  });

  needs(...WANT)('checkout without JavaScript: says it needs JavaScript and links to the products', async ({ web }) => {
    const ctx = await context({ javaScriptEnabled: false });
    const page = await ctx.newPage();
    const r = await page.goto(`${web}/${lang}/checkout/`);
    expect(r?.status()).toBe(200);
    await expect.poll(async () => page.locator('noscript').count()).toBeGreaterThan(0);
    const body = await page.locator('main').innerText();
    expect(body.trim().length, 'the no-JS checkout is not blank').toBeGreaterThan(0);
    expect(await page.locator(`main a[href="/${lang}/"]`).count(), 'a link back to the products').toBeGreaterThan(0);
    await ctx.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the sheet: keyboard, screen reader, motion
// ---------------------------------------------------------------------------------------------------------------------
describe.each(['ar', 'fr'] as const)('cart sheet in /%s/', (lang) => {
  needs(...WANT)('opens and closes by keyboard, Escape closes, focus returns to the opener, it is a labelled dialog with focus inside', async ({ web }) => {
    const ctx = await context();
    const page = await ctx.newPage();
    await gotoCart(page, `${web}/${lang}/`);
    const [line] = sellableVariants(1);
    await seedCart(page, [{ p: line!.p, v: line!.v, q: 1 }]);
    const opener = page.locator('[data-cart-open]').first();
    await opener.waitFor({ state: 'visible' });

    await opener.focus();
    await page.keyboard.press('Enter');
    await waitSheetOpen(page, 1);
    expect(await ev<string>(page, `document.querySelector('dialog.cs').tagName`), 'native dialog').toBe('DIALOG');
    expect(await ev<boolean>(page, `document.querySelector('dialog.cs').matches(':modal')`), 'opened with showModal, so it is modal').toBe(true);
    const title = (await page.locator('#cs-t').textContent()) ?? '';
    expect(title.trim().length, 'the dialog title has text').toBeGreaterThan(0);
    expect(await sheet(page).getAttribute('aria-labelledby')).toBe('cs-t');
    expect(await page.getByRole('dialog', { name: title }).count(), 'dialog role with the accessible name').toBe(1);
    await expect.poll(() => focusInside(page)).toBe(true);

    // focus stays inside while tabbing through the sheet's controls
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Tab');
      expect(await focusInside(page), `focus stayed inside after Tab ${i + 1}`).toBe(true);
    }

    await page.keyboard.press('Escape');
    await sheet(page).waitFor({ state: 'hidden', timeout: 5_000 });
    expect(await ev<boolean>(page, `document.activeElement === document.querySelector('[data-cart-open]')`), 'focus back on the cart button').toBe(true);

    // reopen by keyboard, close with the close button by keyboard
    await page.keyboard.press('Enter');
    await waitSheetOpen(page, 1);
    await expect.poll(() => focusInside(page)).toBe(true);
    await page.locator('dialog.cs .cs-x').focus();
    await page.keyboard.press('Enter');
    await sheet(page).waitFor({ state: 'hidden', timeout: 5_000 });
    expect(await ev<boolean>(page, `document.activeElement === document.querySelector('[data-cart-open]')`), 'focus back after the close button').toBe(true);
    await ctx.close();
  });

  needs(...WANT)('after an add, focus returns to the add button that opened it', async ({ web }) => {
    const ctx = await context();
    const page = await ctx.newPage();
    await gotoCart(page, `${web}/${lang}/`);
    const x = await firstPlainCard(page, web, lang);
    const add = page.locator('[data-cart-add]').nth(x.index);
    await add.focus();
    await page.keyboard.press('Enter');
    await waitSheetOpen(page, 1);
    await expect.poll(() => focusInside(page)).toBe(true);
    await page.keyboard.press('Escape');
    await sheet(page).waitFor({ state: 'hidden', timeout: 5_000 });
    expect(await ev<number>(page, `Number(document.activeElement && document.activeElement.getAttribute('data-cart-add'))`), 'focus back on the same add button').toBe(x.item.id);
    await ctx.close();
  });

  needs(...WANT)('the polite live region announces the count', async ({ web }) => {
    const ctx = await context();
    const page = await ctx.newPage();
    await gotoCart(page, `${web}/${lang}/`);
    const x = await firstPlainCard(page, web, lang);
    await page.locator('[data-cart-add]').nth(x.index).click();
    await waitSheetOpen(page, 1);
    const live = sheet(page).locator('[aria-live="polite"]');
    expect(await live.count()).toBe(1);
    await expect.poll(async () => (await live.textContent()) ?? '').not.toBe('');
    await sheet(page).locator(`[data-k="plus:${x.variantId}"]`).click();
    await waitQty(page, x.variantId, 2);
    const ui = (await (await fetch(`${web}/${lang}/cart/ui.json`)).json()) as Record<string, string>;
    const form = (n: number): string => (ui[`cart.count.${new Intl.PluralRules(lang === 'ar' ? 'ar-DZ' : 'fr-DZ').select(n)}`] ?? '').replace('{count}', String(n));
    await expect.poll(async () => (await live.textContent()) ?? '').toBe(form(2));
    await sheet(page).locator(`[data-k="minus:${x.variantId}"]`).click();
    await waitQty(page, x.variantId, 1);
    await expect.poll(async () => (await live.textContent()) ?? '').toBe(form(1));
    await ctx.close();
  });

  needs(...WANT)('entry and exit are really animated', async ({ web }) => {
    const ctx = await context();
    const page = await ctx.newPage();
    await gotoCart(page, `${web}/${lang}/`);
    const [line] = sellableVariants(1);
    await seedCart(page, [{ p: line!.p, v: line!.v, q: 1 }]);
    await startSampling(page);
    await page.locator('[data-cart-open]').first().click();
    await waitSheetOpen(page, 1);
    await page.waitForTimeout(600);
    let s = await stopSampling(page);
    const entry = motion(s);
    expect(entry.between, `the entry shows intermediate positions, sampled ${s.length} frames: ${JSON.stringify(entry.xs)}`).toBeGreaterThanOrEqual(2);
    expect(entry.backdropBetween, 'the scrim fades in').toBeGreaterThanOrEqual(1);
    expect(s.some((f) => f.durations.some((d) => d >= 100)), 'a transition with a real duration ran').toBe(true);
    expect(entry.movedInward, 'the panel comes in from the inline-end side, not the other way').toBe(true);

    await startSampling(page);
    await page.keyboard.press('Escape');
    await sheet(page).waitFor({ state: 'hidden', timeout: 5_000 });
    s = await stopSampling(page);
    const exit = motion(s);
    expect(exit.between, `the exit shows intermediate positions (no snap), sampled ${s.length} frames: ${JSON.stringify(exit.xs)}`).toBeGreaterThanOrEqual(2);
    expect(s.some((f) => !f.open && f.display !== 'none'), 'it stays painted while it leaves').toBe(true);
    expect(s[s.length - 1]?.display).toBe('none');
    await ctx.close();
  });

  needs(...WANT)("under reducedMotion: 'reduce' no transition runs", async ({ web }) => {
    const ctx = await context({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await gotoCart(page, `${web}/${lang}/`);
    const [line] = sellableVariants(1);
    await seedCart(page, [{ p: line!.p, v: line!.v, q: 1 }]);
    await startSampling(page);
    await page.locator('[data-cart-open]').first().click();
    await waitSheetOpen(page, 1);
    await page.waitForTimeout(500);
    let s = await stopSampling(page);
    expect(motion(s).between, `no intermediate positions on entry: ${JSON.stringify(motion(s).xs)}`).toBe(0);
    expect(s.every((f) => f.durations.every((d) => d < 1)), 'no transition with a real duration on entry').toBe(true);
    await startSampling(page);
    await page.keyboard.press('Escape');
    await sheet(page).waitFor({ state: 'hidden', timeout: 5_000 });
    s = await stopSampling(page);
    expect(motion(s).between, `no intermediate positions on exit: ${JSON.stringify(motion(s).xs)}`).toBe(0);
    expect(s.every((f) => f.durations.every((d) => d < 1)), 'no transition with a real duration on exit').toBe(true);
    await ctx.close();
  });
});

interface Frame { x: number; open: boolean; display: string; backdrop: number; durations: number[] }
/** Start recording the dialog's real position, every animation frame, until stopSampling. */
async function startSampling(page: Page): Promise<void> {
  await ev(page, `(() => {
    window.__s = []; window.__run = true;
    const tick = () => {
      const d = document.querySelector('dialog.cs');
      if (d) {
        const cs = getComputedStyle(d);
        window.__s.push({
          x: Math.round(d.getBoundingClientRect().x * 10) / 10, open: d.open, display: cs.display,
          backdrop: parseFloat(getComputedStyle(d, '::backdrop').opacity),
          durations: d.getAnimations({ subtree: true }).map((a) => a.effect.getTiming().duration),
        });
      }
      if (window.__run) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);
}
async function stopSampling(page: Page): Promise<Frame[]> {
  await page.waitForTimeout(100);
  return ev<Frame[]>(page, `(() => { window.__run = false; return window.__s; })()`);
}
/** How many frames sit strictly between the rest positions, among those where the dialog is rendered. */
function motion(frames: Frame[]): { between: number; backdropBetween: number; xs: number[]; movedInward: boolean } {
  const shown = frames.filter((f) => f.display !== 'none');
  const xs = shown.map((f) => f.x);
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  const between = xs.filter((x) => x > lo + 1 && x < hi - 1).length;
  const backdropBetween = shown.filter((f) => f.backdrop > 0.02 && f.backdrop < 0.98).length;
  // on entry the first shown frame is the panel off-canvas, the last is at rest
  const first = xs[0] ?? 0;
  const last = xs[xs.length - 1] ?? 0;
  return { between, backdropBetween, xs: xs.slice(0, 24), movedInward: Math.abs(first - last) > 100 };
}

// ---------------------------------------------------------------------------------------------------------------------
// persistence, empty cart, limits
// ---------------------------------------------------------------------------------------------------------------------
describe.each(['ar', 'fr'] as const)('cart persistence and limits in /%s/', (lang) => {
  needs(...WANT)('the cart survives navigation and a fresh page load, and keeps tabs in step', async ({ web }) => {
    const ctx = await context();
    const page = await ctx.newPage();
    await gotoCart(page, `${web}/${lang}/`);
    const x = await firstPlainCard(page, web, lang);
    await page.locator('[data-cart-add]').nth(x.index).click();
    await waitSheetOpen(page, 1);
    await closeSheet(page);
    await waitBadge(page, 1);

    // navigate by a real link
    const link = page.locator(`main a[href^="/${lang}/c/"]`).first();
    await link.scrollIntoViewIfNeeded();
    await Promise.all([page.waitForURL((u) => u.pathname.startsWith(`/${lang}/c/`), { timeout: 20_000 }), link.click()]);
    await page.locator('html.cart-on').waitFor({ state: 'attached', timeout: 20_000 });
    await waitBadge(page, 1);

    await page.reload({ waitUntil: 'load' });
    await page.locator('html.cart-on').waitFor({ state: 'attached', timeout: 20_000 });
    await waitBadge(page, 1);

    const fresh = await ctx.newPage();
    await gotoCart(fresh, `${web}/${lang}/`);
    await waitBadge(fresh, 1);
    expect((await cartLines(fresh)).map((l) => l.v)).toEqual([x.variantId]);

    // a second tab changes the cart: the first follows without a reload (storage event)
    await fresh.locator('[data-cart-open]').first().click();
    await waitSheetOpen(fresh, 1);
    await sheet(fresh).locator(`[data-k="plus:${x.variantId}"]`).click();
    await waitQty(fresh, x.variantId, 2);
    await waitBadge(page, 2);
    await ctx.close();
  });

  needs(...WANT)('removing the last line shows the empty message and a link back to products', async ({ web }) => {
    const ctx = await context();
    const page = await ctx.newPage();
    await gotoCart(page, `${web}/${lang}/`);
    const [line] = sellableVariants(1);
    await seedCart(page, [{ p: line!.p, v: line!.v, q: 1 }]);
    await page.locator('[data-cart-open]').first().click();
    await waitSheetOpen(page, 1);
    await sheet(page).locator('.cs-rm').click();
    await sheet(page).locator('.cs-e').waitFor({ timeout: 10_000 });
    const message = await sheet(page).locator('.cs-e p').textContent();
    expect((message ?? '').trim().length, 'the empty cart says something').toBeGreaterThan(0);
    expect(await sheet(page).locator(`.cs-e a[href="/${lang}/"]`).count(), 'a link back to the products').toBe(1);
    expect(await sheet(page).locator('.cs-go').count(), 'nothing to order').toBe(0);
    expect(await cartLines(page)).toEqual([]);
    await closeSheet(page);

    // a fresh open with an empty cart shows the same thing
    await page.locator('[data-cart-open]').first().click();
    await waitSheetOpen(page, 0);
    await sheet(page).locator('.cs-e').waitFor({ timeout: 10_000 });
    await closeSheet(page);

    // the checkout with an empty cart says so too
    await gotoCart(page, `${web}/${lang}/checkout/`);
    await page.locator('#of-empty').waitFor({ state: 'visible', timeout: 15_000 });
    expect(await page.locator(`#of-empty a[href="/${lang}/"]`).count()).toBe(1);
    await ctx.close();
  });

  needs(...WANT)(`the stepper stops at MAX_QTY_PER_LINE (${MAX_QTY}), with one message`, async ({ web }) => {
    const ctx = await context();
    const page = await ctx.newPage();
    await gotoCart(page, `${web}/${lang}/`);
    const x = await firstPlainCard(page, web, lang);
    expect(x.item.variants[0]!.max, 'a variant with no stock limit below the cap').toBe(MAX_QTY);
    await seedCart(page, [{ p: x.item.id, v: x.variantId, q: 1 }]);
    await page.locator('[data-cart-open]').first().click();
    await waitSheetOpen(page, 1);
    const plus = sheet(page).locator(`[data-k="plus:${x.variantId}"]`);
    for (let n = 2; n <= MAX_QTY; n++) {
      await plus.click();
      await waitQty(page, x.variantId, n);
    }
    expect(await plus.getAttribute('aria-disabled'), 'the plus button stops at the limit').toBe('true');
    expect(await sheet(page).locator(`[data-k="minus:${x.variantId}"]`).getAttribute('aria-disabled')).toBeNull();
    await plus.click({ force: true }); // aria-disabled, not disabled: a customer's tap still lands and gets the message
    await sheet(page).locator('.cs-w').waitFor({ timeout: 5_000 });
    expect(await sheet(page).locator('.cs-w').count(), 'one short message').toBe(1);
    expect(await cartLines(page)).toEqual([{ p: x.item.id, v: x.variantId, q: MAX_QTY }]);
    await ctx.close();
  });

  needs(...WANT)('the stepper stops at the variant stock limit', async ({ web }) => {
    const ctx = await context();
    const page = await ctx.newPage();
    await gotoCart(page, `${web}/${lang}/`);
    // the sheet follows the build's per-product JSON, so that decides the expected limit (D1 stock drops as earlier specs order)
    let low: { p: number; v: number; stock: number } | undefined;
    for (const c of d1<{ p: number; v: number }>(`SELECT p.id AS p, v.id AS v FROM products p JOIN variants v ON v.product_id = p.id WHERE p.status = 'active' AND v.active = 1 AND v.stock BETWEEN 2 AND 9 ORDER BY v.id`)) {
      const item = await itemJson(web, lang, c.p);
      const vj = item.variants.find((v) => v.id === c.v);
      if (vj?.ok && vj.max >= 2 && vj.max < MAX_QTY) { low = { p: c.p, v: c.v, stock: vj.max }; break; }
    }
    if (!low) throw new Error('no variant with a low stock in the build');
    await seedCart(page, [{ p: low.p, v: low.v, q: 1 }]);
    await page.locator('[data-cart-open]').first().click();
    await waitSheetOpen(page, 1);
    const plus = sheet(page).locator(`[data-k="plus:${low.v}"]`);
    for (let n = 2; n <= low.stock; n++) {
      await plus.click();
      await waitQty(page, low.v, n);
    }
    expect(await plus.getAttribute('aria-disabled')).toBe('true');
    await plus.click({ force: true });
    await sheet(page).locator('.cs-w').waitFor({ timeout: 5_000 });
    expect(await cartLines(page)).toEqual([{ p: low.p, v: low.v, q: low.stock }]);
    await ctx.close();
  });

  needs(...WANT)(`an add stops at MAX_ORDER_LINES (${MAX_LINES}), with one message`, async ({ web }) => {
    const ctx = await context();
    const page = await ctx.newPage();
    await gotoCart(page, `${web}/${lang}/`);
    const x = await firstPlainCard(page, web, lang);
    const full = sellableVariants(MAX_LINES, [x.item.id]);
    await seedCart(page, full.map(({ p, v }) => ({ p, v, q: 1 })));
    await page.locator('[data-cart-add]').nth(x.index).click();
    await waitSheetOpen(page, MAX_LINES);
    await sheet(page).locator('.cs-f .cs-w').waitFor({ timeout: 5_000 });
    expect(numbers((await sheet(page).locator('.cs-f .cs-w').textContent()) ?? ''), 'the message names the limit').toContain(MAX_LINES);
    const lines = await cartLines(page);
    expect(lines.length, 'still 10 lines').toBe(MAX_LINES);
    expect(lines.some((l) => l.v === x.variantId), 'the 11th product did not go in').toBe(false);
    await ctx.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// the choice view (scratch build only: FEATURES.homeChoice)
// ---------------------------------------------------------------------------------------------------------------------
describe.each(['ar', 'fr'] as const)('choice view in /%s/', (lang) => {
  needs(...WANT, 'homeChoice')('a homepage product with options asks first; the add stays disabled until complete; the chosen variant lands in the cart', async ({ web }) => {
    const ctx = await context();
    const page = await ctx.newPage();
    await gotoCart(page, `${web}/${lang}/`);
    const cards = await homeCards(page, web, lang);
    // the option-heaviest card, so "complete" means more than one click when the build has one
    const c = cards.filter((k) => k.item.options.length > 0).sort((a, b) => b.item.options.length - a.item.options.length)[0];
    if (!c) throw new Error('no homepage card with options');
    const addBtn = page.locator('[data-cart-add]').nth(c.index);
    await addBtn.focus();
    await page.keyboard.press('Enter');
    await waitSheetOpen(page);
    await sheet(page).locator('.cs-ch').waitFor({ timeout: 10_000 });
    expect(await sheet(page).locator('fieldset.cs-fs').count(), 'the sheet asks for each option').toBe(c.item.options.length);
    expect(await sheet(page).locator('.cs-i').count(), 'not the cart yet').toBe(0);
    expect(await cartLines(page), 'nothing in the cart before the choice').toEqual([]);
    await expect.poll(() => focusInside(page)).toBe(true);
    const add = sheet(page).locator('.cs-f button.btn-primary');
    await add.waitFor();
    expect(await add.isDisabled(), 'add disabled before any choice').toBe(true);

    const target = c.item.variants.find((v) => v.ok);
    if (!target) throw new Error('no sellable variant to choose');
    const clicks = c.item.options.map((o) => o.values.find((v) => target.ovs.includes(v.id))!.id);
    for (let i = 0; i < clicks.length; i++) {
      const radio = sheet(page).locator(`input[type="radio"][value="${clicks[i]}"]`);
      await radio.check();
      if (i < clicks.length - 1) expect(await add.isDisabled(), `add still disabled after ${i + 1} of ${clicks.length} choices`).toBe(true);
    }
    expect(await add.isDisabled(), 'add enabled once the choice is complete').toBe(false);
    await add.click();
    await waitSheetOpen(page, 1);
    await expect.poll(() => sheet(page).locator('.cs-ch').count()).toBe(0);
    expect(await cartLines(page)).toEqual([{ p: c.item.id, v: target.id, q: 1 }]);
    const vLabel = target.label;
    if (vLabel) expect(await sheet(page).locator('.cs-v').first().textContent(), 'the sheet line shows the chosen variant').toContain(vLabel);

    // Choice view -> cart -> close: focus returns to the card's add button
    await page.keyboard.press('Escape');
    await sheet(page).waitFor({ state: 'hidden', timeout: 5_000 });
    expect(await ev<number>(page, `Number(document.activeElement && document.activeElement.getAttribute('data-cart-add'))`), 'focus back on the add button').toBe(c.item.id);

    // the plain cards still go straight in
    const plain = cards.find((k) => k.item.options.length === 0);
    if (plain) {
      await page.locator('[data-cart-add]').nth(plain.index).click();
      await waitSheetOpen(page, 2);
      expect(await sheet(page).locator('.cs-ch').count()).toBe(0);
    }
    note(`${lang} choice view: product ${c.item.id} (${c.item.options.length} option groups), chosen variant ${target.id} "${target.label}"`);
    await ctx.close();
  });
});
