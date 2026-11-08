/**
 * Screenshots and page metrics for CART-0's "after" state: run on a seeded storefront build, against the real local
 * Worker + D1, in the same way as artifacts/CART-0/before/ (viewport 360/768/1440, reduced motion, sticky header made
 * static, full page, word count of body.innerText).
 *
 *   node tests/e2e/cart-shots.ts <outDir> [--choice]   # --choice: the build features a variable product (sheet-choice-*)
 *
 * Boots its own Worker over a fresh seeded D1 (harness.ts), like the e2e run. Local only.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright';
import { ARTIFACTS, seedFresh, startWorker } from './harness.ts';
import { ev, firstPlainCard, gotoCart, itemJson, launch, loopbackContext, pickPlace, pickVariant, seedCart, sheet, waitSheetOpen, type CartLine } from './flows.ts';

const out = process.argv[2] ?? '';
const choiceOnly = process.argv.includes('--choice');
if (!out) throw new Error('usage: node tests/e2e/cart-shots.ts <outDir> [--choice]');
mkdirSync(out, { recursive: true });

const WIDTHS = [360, 768, 1440] as const;
const LANGS = ['ar', 'fr'] as const;
const ORDER_SLUG = { ar: 'taqm-al-hammam-a-3-fi-1-piano-led', fr: 'ecouteurs-sans-fil' } as const; // as in before/metrics.json
const viewport = (w: number): { width: number; height: number } => ({ width: w, height: w === 1440 ? 900 : 800 });
type Lang = (typeof LANGS)[number];

async function newCtx(browser: Browser, lang: Lang, w: number, reduced: boolean): Promise<BrowserContext> {
  return loopbackContext(browser, { viewport: viewport(w), locale: lang === 'ar' ? 'ar-DZ' : 'fr-DZ', reducedMotion: reduced ? 'reduce' : 'no-preference' });
}
const staticHeader = (page: Page): Promise<unknown> => ev(page, `document.querySelectorAll('.sticky,header').forEach(e => { if (getComputedStyle(e).position === 'sticky') e.style.position = 'static'; })`);
const measure = async (page: Page): Promise<{ pageHeight: number; formHeight: number; words: number }> => ev(page, `({
  pageHeight: document.documentElement.scrollHeight,
  formHeight: (() => { const f = document.querySelector('form[action="/api/order"]'); return f ? Math.round(f.getBoundingClientRect().height) : 0; })(),
  words: document.body.innerText.split(/\\s+/).length,
})`);
/** Wait until every image on the page, and every image in the sheet, has loaded. */
const imagesLoaded = (page: Page): Promise<unknown> => ev(page, `Promise.race([Promise.all([document.fonts.ready, ...[...document.images].map(i => { i.loading='eager'; return i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; }); })]), new Promise(r => setTimeout(r, 8000))])`);

async function cartFor(browser: Browser, web: string): Promise<Record<Lang, CartLine[]>> {
  const ctx = await loopbackContext(browser);
  const page = await ctx.newPage();
  const lines: Partial<Record<Lang, CartLine[]>> = {};
  for (const lang of LANGS) {
    await gotoCart(page, `${web}/${lang}/`);
    const x = await firstPlainCard(page, web, lang);
    const y = pickVariant(lang);
    lines[lang] = [{ p: x.item.id, v: x.variantId, q: 1 }, { p: y.productId, v: y.variantId, q: 2 }];
  }
  await ctx.close();
  return lines as Record<Lang, CartLine[]>;
}

async function openSheet(page: Page): Promise<void> {
  await page.locator('[data-cart-open]').first().click();
  await waitSheetOpen(page);
  await sheet(page).locator('.cs-i, .cs-e, .cs-ch').first().waitFor({ timeout: 10_000 });
}

async function main(): Promise<void> {
  seedFresh();
  const web = await startWorker('web', path.join(ARTIFACTS, 'shots-logs'));
  const browser = await launch();
  try {
    if (choiceOnly) {
      await choiceShots(browser, web.url);
      return;
    }
    const carts = await cartFor(browser, web.url);
    const metrics: unknown[] = [];
    const checkout: unknown[] = [];
    for (const lang of LANGS) for (const w of WIDTHS) {
      const ctx = await newCtx(browser, lang, w, true);
      const page = await ctx.newPage();
      // order step: the same page and the same steps as artifacts/CART-0/before
      const r = await page.goto(`${web.url}/${lang}/order/${ORDER_SLUG[lang]}/`, { waitUntil: 'load' });
      await page.waitForTimeout(1200);
      await imagesLoaded(page);
      await staticHeader(page);
      const m = await measure(page);
      await page.screenshot({ path: path.join(out, `order-${lang}-${w}.png`), fullPage: true });
      metrics.push({ lang, w, status: r?.status() ?? 0, ...m, url: ORDER_SLUG[lang] });

      // checkout with two lines
      await gotoCart(page, `${web.url}/${lang}/checkout/`);
      await seedCart(page, carts[lang]);
      await page.locator('#of-rows .of-row').nth(1).waitFor({ timeout: 15_000 });
      const place = pickPlace();
      const form = page.locator('form[action="/api/order"]');
      await form.locator('select[name="wilayaCode"]').selectOption(String(place.wilaya));
      await form.locator(`[name="communeId"] option[value="${place.communeId}"]`).waitFor({ state: 'attached', timeout: 15_000 });
      await form.locator('[name="communeId"]').selectOption(String(place.communeId));
      await page.waitForTimeout(800); // the quote, with its fee and total
      await imagesLoaded(page);
      await staticHeader(page);
      const c = await measure(page);
      await page.screenshot({ path: path.join(out, `checkout-${lang}-${w}.png`), fullPage: true });
      checkout.push({ lang, w, ...c });
      await ctx.close();

      // sheet: two lines, then empty
      const s = await newCtx(browser, lang, w, true);
      const sp = await s.newPage();
      await gotoCart(sp, `${web.url}/${lang}/`);
      await seedCart(sp, carts[lang]);
      await openSheet(sp);
      await waitSheetOpen(sp, 2);
      await imagesLoaded(sp);
      await sp.waitForTimeout(300);
      await sp.screenshot({ path: path.join(out, `sheet-${lang}-${w}.png`) });
      await sheet(sp).locator('.cs-rm').first().click();
      await waitSheetOpen(sp, 1);
      await sheet(sp).locator('.cs-rm').first().click();
      await sheet(sp).locator('.cs-e').waitFor({ timeout: 10_000 });
      await sp.screenshot({ path: path.join(out, `sheet-empty-${lang}-${w}.png`) });
      await s.close();
    }
    writeFileSync(path.join(out, 'metrics.json'), `${JSON.stringify(metrics, null, 1)}\n`);
    writeFileSync(path.join(out, 'metrics-checkout.json'), `${JSON.stringify(checkout, null, 1)}\n`);
    await motionShots(browser, web.url, carts);
  } finally {
    await browser.close();
    await web.stop();
  }
}

/** Slow the page's own animations through CDP (no CSS injected), and catch mid-animation frames. */
async function motionShots(browser: Browser, web: string, carts: Record<Lang, CartLine[]>): Promise<void> {
  for (const lang of LANGS) {
    const ctx = await newCtx(browser, lang, 360, false);
    const page = await ctx.newPage();
    await gotoCart(page, `${web}/${lang}/`);
    await seedCart(page, carts[lang]);
    const cdp: CDPSession = await ctx.newCDPSession(page);
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.1 });
    await page.locator('[data-cart-open]').first().click();
    await page.locator('dialog.cs[open]').waitFor({ state: 'attached', timeout: 15_000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(out, `sheet-enter-${lang}-360.png`), animations: 'allow' });
    await page.waitForTimeout(2500);
    await waitSheetOpen(page, 2);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(out, `sheet-exit-${lang}-360.png`), animations: 'allow' });
    await ctx.close();
  }
}

/** The choice view: a homepage card with options (scratch build featuring a variable product). */
async function choiceShots(browser: Browser, web: string): Promise<void> {
  for (const lang of LANGS) for (const w of WIDTHS) {
    const ctx = await newCtx(browser, lang, w, true);
    const page = await ctx.newPage();
    await gotoCart(page, `${web}/${lang}/`);
    const buttons = page.locator('[data-cart-add]');
    let index = -1;
    for (let i = 0; i < (await buttons.count()); i++) {
      const it = await itemJson(web, lang, Number(await buttons.nth(i).getAttribute('data-cart-add')));
      if (it.options.length > 1) { index = i; break; }
    }
    if (index < 0) throw new Error('no homepage product with two option groups');
    await buttons.nth(index).click();
    await waitSheetOpen(page);
    await sheet(page).locator('.cs-ch').waitFor({ timeout: 10_000 });
    await imagesLoaded(page);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(out, `sheet-choice-${lang}-${w}.png`) });
    await ctx.close();
  }
}

await main();
