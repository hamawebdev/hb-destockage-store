/**
 * CART-5 (ledger C-11, plus the browser half of C-6/C-7): a storefront built with the cart OFF, in a real browser
 * at 360 px, /ar/ and /fr/, on the real Worker and local D1. Runs only from tests/e2e/cart-run.sh (HB_CART_E2E=off),
 * which builds the cart-off site and starts web + admin; skipped in the ordinary e2e suite (cart on).
 *
 *  - home, category and search (results rendered by search.js): no header cart, every card / result has a buy link
 *    to its product's /{lang}/order/<slug>/, ≥ 44×44 px, accessible name containing the product name; axe on the
 *    search page with results showing: zero violations;
 *  - a single-product order: card buy link → order form → confirmation → the order in the admin.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { AxeBuilder } from '@axe-core/playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { adminLogin, adminPage, fillCustomer, launch, loopbackContext, orderByRef, pickPlace, submitUntilConfirmed } from './flows.ts';
import { d1 } from './harness.ts';

const ON = process.env['HB_CART_E2E'] === 'off';
const WEB = process.env['HB_E2E_WEB_URL'] ?? '';
const ADMIN = process.env['HB_E2E_ADMIN_URL'] ?? '';
const OUT = process.env['HB_E2E_OUT'] ?? '/mnt/data/ecom website/artifacts/CART-5/e2e';
const LANGS = ['ar', 'fr'] as const;
type Lang = (typeof LANGS)[number];

let browser: Browser | undefined;
beforeAll(async () => {
  if (ON) browser = await launch();
  mkdirSync(OUT, { recursive: true });
});
afterAll(async () => browser?.close());

const log: string[] = [];
const note = (s: string) => {
  log.push(s);
  writeFileSync(`${OUT}/cart-switch-log.txt`, log.join('\n') + '\n');
};

async function page(lang: Lang, width = 360): Promise<Page> {
  const ctx = await loopbackContext(browser as Browser, { viewport: { width, height: 800 }, locale: lang === 'ar' ? 'ar-DZ' : 'fr-DZ' });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => note(`pageerror ${lang}: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error') note(`console error ${lang}: ${m.text()}`);
  });
  return p;
}

/** Every buy link on the page: href, box, accessible name, and the name of the card / result it belongs to. */
async function buyLinks(p: Page, selector: string, nameSel: string) {
  return p.locator(selector).evaluateAll(
    (els, nameSel) =>
      // The home grid hides the cards of an incomplete last row (CSS): only what the customer sees counts.
      els.filter((a) => a.getClientRects().length > 0).map((a) => {
        const r = a.getBoundingClientRect();
        const holder = a.closest('article, li');
        return {
          href: a.getAttribute('href') ?? '',
          w: r.width,
          h: r.height,
          name: (a.textContent ?? '').replace(/\s+/g, ' ').trim(),
          product: (holder?.querySelector(nameSel)?.textContent ?? '').replace(/\s+/g, ' ').trim(),
        };
      }),
    nameSel,
  );
}

const visibleCards = (p: Page): Promise<number> => p.locator('article.cat-card').evaluateAll((els) => els.filter((e) => e.getClientRects().length > 0).length);

function slugsOf(lang: Lang): Map<string, string> {
  const rows = d1<{ slug: string; name: string }>(`SELECT slug_${lang} AS slug, name_${lang} AS name FROM products WHERE status = 'active'`);
  return new Map(rows.map((r) => [r.slug, r.name]));
}

async function expectNoCart(p: Page, where: string) {
  expect(await p.locator('[data-cart-open], .hd-cart, [data-cart-add], .cat-add-cart').count(), `${where}: cart UI`).toBe(0);
  const scripts = await p.evaluate(() => [...document.querySelectorAll('[data-js]')].map((e) => (e as HTMLElement).dataset['js']).join(' '));
  expect(scripts, `${where}: data-js`).not.toMatch(/cart/);
}

function expectBuy(links: Awaited<ReturnType<typeof buyLinks>>, lang: Lang, where: string, cards: number) {
  const slugs = slugsOf(lang);
  expect(links.length, `${where}: buy links`).toBe(cards);
  expect(cards, `${where}: cards`).toBeGreaterThan(0);
  for (const l of links) {
    const m = new RegExp(`^/${lang}/order/([a-z0-9-]+)/$`).exec(l.href);
    expect(m, `${where}: ${l.href}`).not.toBeNull();
    expect(slugs.get(m![1]!), `${where}: ${l.href} is that product's order form`).toBe(l.product);
    expect(l.w, `${where}: ${l.href} width`).toBeGreaterThanOrEqual(44);
    expect(l.h, `${where}: ${l.href} height`).toBeGreaterThanOrEqual(44);
    expect(l.name, `${where}: accessible name`).toContain(l.product);
  }
  note(`${where}: ${links.length} buy links OK (min ${Math.min(...links.map((l) => l.w)).toFixed(0)}×${Math.min(...links.map((l) => l.h)).toFixed(0)} px)`);
}

describe.skipIf(!ON)('cart off (built with settings.cartEnabled = false)', () => {
  for (const lang of LANGS) {
    for (const width of [360, 1440]) {
      it(`${lang} ${width}px: home and a category: no cart, a buy link on every card`, async () => {
        const p = await page(lang, width);
        await p.goto(`${WEB}/${lang}/`);
        await p.waitForLoadState('load');
        await expectNoCart(p, `${lang} home`);
        expectBuy(await buyLinks(p, 'a.cat-card-buy', '.cat-card-title'), lang, `${lang}-${width} home`, await visibleCards(p));
        await p.screenshot({ path: `${OUT}/${lang}-${width}-home.png`, fullPage: true });
        const cat = await p.locator('.hd-nav a, .hd-sheet a[href*="/c/"]').first().getAttribute('href');
        await p.goto(`${WEB}${cat}`);
        await p.waitForLoadState('load');
        await expectNoCart(p, `${lang} category`);
        expectBuy(await buyLinks(p, 'a.cat-card-buy', '.cat-card-title'), lang, `${lang}-${width} category ${cat}`, await visibleCards(p));
        await p.screenshot({ path: `${OUT}/${lang}-${width}-category.png`, fullPage: true });
        await p.context().close();
      });

      it(`${lang} ${width}px: search results rendered by search.js carry a buy link each; axe clean`, async () => {
        const p = await page(lang, width);
        // A word customers would type: the first word of an active product's name in this language.
        const term = (d1<{ name: string }>(`SELECT name_${lang} AS name FROM products WHERE status = 'active' ORDER BY id LIMIT 1`)[0]?.name ?? '').split(/\s+/)[0] ?? '';
        expect(term.length).toBeGreaterThan(1);
        await p.goto(`${WEB}/${lang}/search/?q=${encodeURIComponent(term)}`);
        await p.locator('#cat-sresults li').first().waitFor({ state: 'visible', timeout: 20_000 });
        await expectNoCart(p, `${lang} search`);
        const rows = await p.locator('#cat-sresults li').count();
        expectBuy(await buyLinks(p, '#cat-sresults a.cat-res-buy', '.cat-res-name'), lang, `${lang}-${width} search "${term}"`, rows);
        await p.screenshot({ path: `${OUT}/${lang}-${width}-search-results.png`, fullPage: true });
        const axe = await new AxeBuilder({ page: p }).analyze();
        writeFileSync(`${OUT}/axe-${lang}-${width}-search-results.json`, JSON.stringify(axe.violations, null, 2));
        note(`${lang}-${width} search results axe: ${axe.violations.length} violation(s)${axe.violations.map((v) => ` ${v.id}`).join('')}`);
        expect(axe.violations).toEqual([]);
        await p.context().close();
      });
    }

    it(`${lang} 360px: single-product order: card buy link → order form → confirmation → admin`, async () => {
      const p = await page(lang);
      await p.goto(`${WEB}/${lang}/`);
      await p.waitForLoadState('load');
      // The first in-stock card: its buy link is the customer's way in.
      const card = p.locator('article.cat-card:not(.cat-card--out)').first();
      const product = ((await card.locator('.cat-card-title').textContent()) ?? '').trim();
      const buy = card.locator('a.cat-card-buy');
      const href = (await buy.getAttribute('href')) ?? '';
      await buy.scrollIntoViewIfNeeded();
      await p.screenshot({ path: `${OUT}/${lang}-360-order-1-card.png` });
      await Promise.all([p.waitForURL((u) => u.pathname === href, { timeout: 20_000 }), buy.click()]);
      await p.waitForLoadState('load');
      await expectNoCart(p, `${lang} order step`);
      // A variable product: pick the first available value of each option group (the order page keeps the picker).
      for (const group of await p.locator('.cat-picker fieldset, .cat-picker [role="radiogroup"]').all()) {
        const choice = group.locator('input[type="radio"]:not(:disabled)').first();
        if (await choice.count()) await choice.check({ force: true });
      }
      const place = pickPlace();
      const seed = (Date.now() % 1_000_000) + (lang === 'ar' ? 1 : 2);
      const who = await fillCustomer(p, place, seed, 1);
      await p.screenshot({ path: `${OUT}/${lang}-360-order-2-form.png`, fullPage: true });
      const ref = await submitUntilConfirmed(p);
      await p.screenshot({ path: `${OUT}/${lang}-360-order-3-confirmation.png`, fullPage: true });
      const row = orderByRef(ref);
      expect(row.lang).toBe(lang);
      expect(row.name).toBe(who.name);
      const items = d1<{ name: string; qty: number }>(`SELECT p.name_${lang} AS name, oi.qty AS qty FROM order_items oi JOIN variants v ON v.id = oi.variant_id JOIN products p ON p.id = v.product_id WHERE oi.order_id = ${row.id}`);
      expect(items).toEqual([{ name: product, qty: 1 }]);
      const cookie = await adminLogin(ADMIN);
      const html = await adminPage(ADMIN, cookie, `/orders/${ref}`);
      expect(html).toContain(ref);
      expect(html).toContain(who.name);
      const shot = await browser!.newContext({ viewport: { width: 360, height: 900 }, extraHTTPHeaders: { cookie } });
      const ap = await shot.newPage();
      await ap.goto(`${ADMIN}/orders/${ref}`);
      await ap.screenshot({ path: `${OUT}/${lang}-360-order-4-admin.png`, fullPage: true });
      await shot.close();
      note(`${lang} order ${ref}: ${product} ×1 via ${href} → confirmation → admin /orders/${ref} OK`);
      await p.context().close();
    });
  }
});
