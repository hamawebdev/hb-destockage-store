/**
 * Shared flows for the e2e specs, written against the contracts:
 *  - form field names of the order form = the shared OrderDraft/OrderInput names
 *    (packages/shared/src/order-schema.ts: name, phone, wilayaCode, communeId, qty, items/options,
 *    idempotencyKey, step);
 *  - D1 columns = packages/db/migrations/0000_init.sql;
 *  - admin dev login = apps/admin/src/auth/dev-routes.tsx (POST /__dev/login email=…@dev.local).
 */
import { chromium, type Browser, type Page } from 'playwright';
import { d1, integersIn, testPhone } from './harness.ts';

export const CHROME = '/usr/bin/google-chrome';
export const launch = (): Promise<Browser> => chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

export interface Pick { productId: number; slug: string; variantId: number; price: number; optionValueIds: number[] }
export interface Place { wilaya: number; fee: number; communeId: number }

/** A non-default active variant of an active variable product with stock for qty 2. */
export function pickVariant(lang: 'ar' | 'fr'): Pick {
  const rows = d1<{ pid: number; slug: string; vid: number; price: number }>(
    `SELECT p.id AS pid, p.slug_${lang} AS slug, v.id AS vid, v.price_dzd AS price FROM products p JOIN variants v ON v.product_id = p.id
     WHERE p.kind = 'variable' AND p.status = 'active' AND v.active = 1 AND v.is_default = 0 AND (v.stock IS NULL OR v.stock >= 5)
     ORDER BY p.id, v.id LIMIT 1`);
  const r = rows[0];
  if (!r) throw new Error('the seed has no active variable product with a non-default variant in stock');
  const ov = d1<{ id: number }>(`SELECT option_value_id AS id FROM variant_option_values WHERE variant_id = ${r.vid}`).map((x) => x.id);
  return { productId: r.pid, slug: r.slug, variantId: r.vid, price: r.price, optionValueIds: ov };
}

/** A wilaya with an available, non-zero fee and at least one commune (the highest code: 58+ wilayas). */
export function pickPlace(): Place {
  const r = d1<{ code: number; fee: number }>(
    `SELECT d.wilaya_code AS code, d.fee_dzd AS fee FROM delivery_fees d WHERE d.available = 1 AND d.fee_dzd > 0
     AND EXISTS (SELECT 1 FROM communes c WHERE c.wilaya_code = d.wilaya_code) ORDER BY d.wilaya_code DESC LIMIT 1`)[0];
  if (!r) throw new Error('no wilaya with an available delivery fee in the seeded D1');
  const c = d1<{ id: number }>(`SELECT id FROM communes WHERE wilaya_code = ${r.code} ORDER BY id LIMIT 1`)[0];
  if (!c) throw new Error(`wilaya ${r.code} has no commune`);
  return { wilaya: r.code, fee: r.fee, communeId: c.id };
}

/** Select the variant in the order form: a control whose value is the variant id, else its option values. */
export async function chooseVariant(page: Page, p: Pick): Promise<void> {
  const form = page.locator('form[action="/api/order"]');
  const byId = form.locator(`option[value="${p.variantId}"], input[value="${p.variantId}"]`);
  if (await byId.count()) {
    const el = byId.first();
    if ((await el.evaluate((e) => e.tagName)) === 'OPTION') {
      const sel = form.locator('select').filter({ has: page.locator(`option[value="${p.variantId}"]`) }).first();
      await sel.selectOption(String(p.variantId));
    } else await el.check({ force: true });
    return;
  }
  for (const v of p.optionValueIds) {
    const opt = form.locator(`option[value="${v}"]`);
    if (await opt.count()) {
      await form.locator('select').filter({ has: page.locator(`option[value="${v}"]`) }).first().selectOption(String(v));
      continue;
    }
    const input = form.locator(`input[value="${v}"]`);
    if (!(await input.count())) throw new Error(`no control for option value ${v} of variant ${p.variantId} (contract: value = option_value id or variant id)`);
    await input.first().check({ force: true });
  }
}

export async function fillCustomer(page: Page, place: Place, seed: number, qty: number): Promise<{ name: string; phone: string }> {
  const form = page.locator('form[action="/api/order"]');
  const name = `E2E Test ${seed}`;
  const phone = testPhone(seed);
  await form.locator('[name="name"]').fill(name);
  await form.locator('[name="phone"]').fill(phone);
  await form.locator('select[name="wilayaCode"]').selectOption(String(place.wilaya));
  const commune = form.locator('[name="communeId"]');
  await commune.locator(`option[value="${place.communeId}"]`).waitFor({ state: 'attached', timeout: 15_000 });
  await commune.selectOption(String(place.communeId));
  const q = form.locator('[name="qty"]');
  if (await q.count()) await q.fill(String(qty));
  return { name, phone };
}

/** Poll until the page shows both integers (price/fee/total summary rendered). */
export async function expectNumbersShown(page: Page, nums: number[], where = 'form[action="/api/order"]'): Promise<void> {
  const end = Date.now() + 15_000;
  let seen: number[] = [];
  while (Date.now() < end) {
    seen = integersIn(await page.locator(where).first().innerText());
    if (nums.every((n) => seen.includes(n))) return;
    await page.waitForTimeout(300);
  }
  throw new Error(`expected ${nums.join(', ')} on the page (${where}); saw ${seen.join(', ')}`);
}

/** Submit until the confirmation page (JS path may have a confirm step). Returns the order ref. */
export async function submitUntilConfirmed(page: Page): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const m = /\/order\/confirmation\/\?ref=(HB-[A-Z0-9]+)/.exec(page.url());
    if (m?.[1]) return m[1];
    const btn = page.locator('form button[type="submit"], form input[type="submit"]').last();
    await Promise.all([page.waitForURL(/ref=HB-|\/api\/order/, { timeout: 20_000 }).catch(() => {}), btn.click()]);
    await page.waitForLoadState('load');
  }
  const m = /\/order\/confirmation\/\?ref=(HB-[A-Z0-9]+)/.exec(page.url());
  if (!m?.[1]) throw new Error(`no confirmation page after submitting (at ${page.url()})`);
  return m[1];
}

export interface OrderRow { id: number; ref: string; idempotency_key: string; status: string; wilaya_code: number; commune_id: number; lang: string; subtotal_dzd: number; fee_dzd: number; total_dzd: number; name: string; phone_e164: string }
export function orderByRef(ref: string): OrderRow {
  const r = d1<OrderRow>(`SELECT * FROM orders WHERE ref = '${ref.replace(/'/g, '')}'`);
  if (r.length !== 1) throw new Error(`expected 1 order with ref ${ref}, found ${r.length}`);
  return r[0] as OrderRow;
}

/** Cookie header for an admin dev session (local only). */
export async function adminLogin(admin: string, email = 'owner@dev.local'): Promise<string> {
  const r = await fetch(`${admin}/__dev/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email }) });
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  if (r.status !== 303 || !cookie) throw new Error(`dev login as ${email} failed: HTTP ${r.status}`);
  return cookie;
}
