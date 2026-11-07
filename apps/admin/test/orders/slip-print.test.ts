// AORD-5 — print CSS: a slip fits one A6 page (typical order) or one A5 page (largest possible order)
// in both UI languages, one page per slip. Real slips are rendered through the app, the real
// stylesheets are inlined, and Chrome prints them to PDF at the slip's own @page size.
// Needs admin-core's slip classes in public/assets/print.css (team/admin-core de58fa5) and a Chrome
// binary; skips with a reason otherwise.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { orders } from '@hb/db';
import { tokensCss } from '@hb/ui-tokens';
import { harness, tokenFor, USERS, type Harness } from '../helpers.ts';
import { dbOf, insertOrder, refOf, seedGeoAndCatalog } from './fixtures.ts';

const CHROME = '/usr/bin/google-chrome';
const asset = (f: string) => readFileSync(fileURLToPath(new URL(`../../public/assets/${f}`, import.meta.url).href), 'utf8');
const printCss = asset('print.css');
const adminCss = asset('admin.css');
const ready = printCss.includes('.slip') && existsSync(CHROME);

type Browser = { newPage(): Promise<{ setContent(h: string): Promise<void>; pdf(o: object): Promise<Uint8Array>; close(): Promise<void> }>; close(): Promise<void> };
let h: Harness;
let browser: Browser;
const REF = { typical: refOf(6001), largest: refOf(6002), second: refOf(6003) };

beforeAll(async () => {
  if (!ready) return;
  h = await harness();
  const db = dbOf(h.db);
  const cat = await seedGeoAndCatalog(db);
  await insertOrder(db, cat, { ref: REF.typical, createdAt: Date.now() - 3000, status: 'confirmed', name: 'Amina Benali', items: [['A', 2], ['B', 1]] });
  await insertOrder(db, cat, { ref: REF.second, createdAt: Date.now() - 2000, status: 'shipped', name: 'كريم حداد', items: [['A', 1]] });
  // Largest possible order: MAX_ORDER_LINES = 10 lines, a 120-char name, a 300-char address.
  await insertOrder(db, cat, {
    ref: REF.largest,
    createdAt: Date.now() - 1000,
    status: 'confirmed',
    name: 'Mohamed El Amine Benabdallah Ould Sidi Cheikh '.repeat(3).slice(0, 120),
    items: Array.from({ length: 10 }, (_, i) => [i % 2 ? 'A' : 'B', 10] as const),
  });
  await db.update(orders).set({ address: 'Cité 1200 logements AADL, bâtiment 14, escalier B, 3e étage, porte gauche, à côté de la mosquée El Feth — ' .repeat(3).slice(0, 300) }).where(eq(orders.ref, REF.largest));
  await db.update(orders).set({ address: 'Lotissement 45, rue des Frères Bouadou, Bab Ezzouar' }).where(eq(orders.ref, REF.typical));
  const { chromium } = createRequire(import.meta.url)('playwright') as { chromium: { launch(o: object): Promise<Browser> } };
  browser = await chromium.launch({ executablePath: CHROME });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await h?.close();
});

async function slipsHtml(email: string, refs: string[], size: 'a6' | 'a5'): Promise<string> {
  const p = new URLSearchParams();
  for (const r of refs) p.append('ref', r);
  p.set('size', size);
  p.set('_csrf', await tokenFor(h.db, email));
  const res = await h.as(email, '/orders/shipping/slips', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin' },
    body: p.toString(),
  });
  expect(res.status).toBe(200);
  return (await res.text())
    .replace('<link rel="stylesheet" href="/assets/tokens.css"/>', `<style>${tokensCss}</style>`)
    .replace('<link rel="stylesheet" href="/assets/admin.css"/>', `<style>${adminCss}</style>`)
    .replace(/<link rel="stylesheet" href="\/assets\/print.css"[^>]*\/>/, `<style>${printCss}</style>`)
    .replace(/<script src="\/assets\/admin.js" defer=""><\/script>/, '');
}

/** Page sizes in points (ISO A6 105×148 mm, A5 148×210 mm; 1 mm = 72 / 25.4 pt). */
const SIZE_PT = { a6: [297.6, 419.5], a5: [419.5, 595.3] } as const;

/**
 * Prints with Chrome at the CSS page size and returns the number of pages, after checking that every
 * page really is the expected size (a page-size keyword Chrome does not know silently falls back to
 * US Letter, which would make "fits one page" meaningless).
 */
async function pages(html: string, size: 'a6' | 'a5'): Promise<number> {
  const page = await browser.newPage();
  await page.setContent(html);
  const pdf = Buffer.from(await page.pdf({ preferCSSPageSize: true, printBackground: true })).toString('latin1');
  await page.close();
  const boxes = [...pdf.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const [w, h] = SIZE_PT[size];
  for (const [bw, bh] of boxes) {
    expect(Math.abs(bw! - w), `page width ${bw} pt for ${size}`).toBeLessThan(2);
    expect(Math.abs(bh! - h), `page height ${bh} pt for ${size}`).toBeLessThan(2);
  }
  return pdf.match(/\/Type\s*\/Page(?!s)/g)?.length ?? 0;
}

describe.skipIf(!ready)('slip print layout (needs admin-core de58fa5 print classes + Chrome)', () => {
  for (const [lang, email] of [['fr', USERS.owner], ['ar', USERS.ownerAr]] as const) {
    test(`${lang}: a typical slip fits one A6 page`, async () => {
      expect(await pages(await slipsHtml(email, [REF.typical], 'a6'), 'a6')).toBe(1);
    });
    test(`${lang}: the largest possible order fits one A5 page`, async () => {
      expect(await pages(await slipsHtml(email, [REF.largest], 'a5'), 'a5')).toBe(1);
    });
    test(`${lang}: two slips → exactly two pages (one per slip)`, async () => {
      expect(await pages(await slipsHtml(email, [REF.typical, REF.second], 'a6'), 'a6')).toBe(2);
    });
    test(`${lang}: names and addresses in <bdi>, ref and phone LTR`, async () => {
      const html = await slipsHtml(email, [REF.typical, REF.second], 'a6');
      expect(html).toContain('<bdi>Amina Benali</bdi>');
      expect(html).toContain('<bdi>كريم حداد</bdi>');
      expect(html).toContain('<bdi>Lotissement 45, rue des Frères Bouadou, Bab Ezzouar</bdi>');
      expect(html).toContain(`<span class="slip__ref" dir="ltr">${REF.typical}</span>`);
      expect(html).toMatch(/<span class="slip__phone" dir="ltr">0\d{9}<\/span>/);
    });
  }
});

test('print classes present (else the print-layout tests above are skipped)', () => {
  // Fails loudly once Chrome is there but the CSS is not, so a skip can't hide a missing sheet.
  if (existsSync(CHROME)) expect(printCss.includes('.slip'), 'apps/admin/public/assets/print.css lacks the slip classes (admin-core de58fa5)').toBe(true);
});
