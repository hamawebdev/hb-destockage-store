/**
 * Wilaya and commune pickers: 69 wilayas in the picker and 1,541 communes in total across all
 * wilayas, in both languages (CLAUDE.md data/: 69 wilayas / 1,541 communes). The pickers live on
 * the order step (/{lang}/order/<slug>/, ORDER-STEP).
 */
import { describe, expect } from 'vitest';
import { needs } from './needs.ts';
import { d1 } from './harness.ts';
import { launch, loopbackContext, orderStepPath, pickPlace, pickVariant } from './flows.ts';

const WILAYAS = 69;
const COMMUNES = 1541;

describe.each(['ar', 'fr'] as const)('geo pickers in /%s/', (lang) => {
  needs('storefront', 'seed', 'orderForm')(`the wilaya picker lists ${WILAYAS} wilayas`, async ({ web }) => {
    const browser = await launch();
    const page = await (await loopbackContext(browser)).newPage();
    const v = pickVariant(lang);
    expect((await page.goto(`${web}${orderStepPath(lang, v.slug)}`))?.status()).toBe(200);
    const codes = await page.locator('form[action="/api/order"] select[name="wilayaCode"] option').evaluateAll(
      (os) => os.map((o) => (o as unknown as { value: string }).value).filter((x) => /^\d+$/.test(x)).map(Number));
    await browser.close();
    expect(new Set(codes).size).toBe(WILAYAS);
    expect(Math.min(...codes)).toBe(1);
    expect(Math.max(...codes)).toBe(WILAYAS);
  });

  needs('storefront', 'seed', 'orderForm', 'geoFiles')('choosing a wilaya fills the commune picker with that wilaya\'s communes', async ({ web }) => {
    const browser = await launch();
    const page = await (await loopbackContext(browser)).newPage();
    const v = pickVariant(lang);
    const place = pickPlace();
    const rows = await (await fetch(`${web}/geo/communes/${lang}/${place.wilaya}.json`)).json() as Array<[number, string]>;
    expect((await page.goto(`${web}${orderStepPath(lang, v.slug)}`))?.status()).toBe(200);
    const form = page.locator('form[action="/api/order"]');
    await form.locator('select[name="wilayaCode"]').selectOption(String(place.wilaya));
    await form.locator(`[name="communeId"] option[value="${place.communeId}"]`).waitFor({ state: 'attached', timeout: 15_000 });
    const ids = await form.locator('[name="communeId"] option').evaluateAll(
      (os) => os.map((o) => (o as unknown as { value: string }).value).filter((x) => /^\d+$/.test(x)).map(Number));
    await browser.close();
    expect([...ids].sort((a, b) => a - b)).toEqual(rows.map(([id]) => id).sort((a, b) => a - b));
  });

  needs('storefront', 'geoFiles')(`communes total ${COMMUNES} across all wilayas`, async ({ web }) => {
    let total = 0;
    const ids = new Set<number>();
    for (let code = 1; code <= WILAYAS; code++) {
      const r = await fetch(`${web}/geo/communes/${lang}/${code}.json`);
      expect(r.status, `/geo/communes/${lang}/${code}.json`).toBe(200);
      const rows = await r.json() as Array<[number, string]>;
      expect(rows.length, `wilaya ${code} has communes`).toBeGreaterThan(0);
      for (const [id, name] of rows) { ids.add(id); expect(name.trim().length).toBeGreaterThan(0); }
      total += rows.length;
    }
    expect(total).toBe(COMMUNES);
    expect(ids.size).toBe(COMMUNES);
  });

  needs('seed')(`the seeded D1 holds ${WILAYAS} wilayas and ${COMMUNES} communes`, async () => {
    expect(d1<{ n: number }>('SELECT COUNT(*) AS n FROM wilayas')[0]?.n).toBe(WILAYAS);
    expect(d1<{ n: number }>('SELECT COUNT(*) AS n FROM communes')[0]?.n).toBe(COMMUNES);
  });
});
