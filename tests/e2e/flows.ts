/**
 * Shared flows for the e2e specs, written against the contracts:
 *  - the order journey = ORDER-STEP (artifacts/ORDER-STEP/plan.md): the product page's GET form
 *    `#cat-buy` (picker + CTA; with JS also `a.cat-cta` carrying ?v=<variantId>) → the prerendered
 *    order step /{lang}/order/<slug>/ with orderform's form; picker radios carry `data-ov` =
 *    option value id on both pages (pages' VariantPicker);
 *  - form field names of the order form = the shared OrderDraft/OrderInput names
 *    (packages/shared/src/order-schema.ts: name, phone, wilayaCode, communeId, qty, items/options,
 *    idempotencyKey, step);
 *  - D1 columns = packages/db/migrations/0000_init.sql;
 *  - admin dev login = apps/admin/src/auth/dev-routes.tsx (POST /__dev/login email=…@dev.local,
 *    same-origin only: Sec-Fetch-Site or Origin, lib/csrf.ts isSameOriginRequest);
 *  - admin order actions = apps/admin/src/routes/orders (admin-orders f51bab5, its route table and
 *    test/orders/detail.test.ts): POST /orders/:ref/call with `outcome` (callback + callbackAt:
 *    new → called; confirmed: called → confirmed), then POST /orders/:ref/transition with to=shipped
 *    and courierName. Every admin POST is admin-core's `postAs` shape (apps/admin/test/helpers.ts):
 *    urlencoded, Origin + Sec-Fetch-Site: same-origin, `_csrf` (here read from the rendered page,
 *    like its `csrfFrom`) and the form's `version`.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { d1, integersIn, testPhone } from './harness.ts';

export const CHROME = '/usr/bin/google-chrome';
export const launch = (): Promise<Browser> => chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

/**
 * A browser context that only reaches loopback: every other origin (the Turnstile script) is
 * aborted, so an e2e run never calls a third party. Turnstile missing ⇒ the order is accepted and
 * flagged (project rule), which is the path these specs exercise.
 */
export async function loopbackContext(browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}): Promise<BrowserContext> {
  const ctx = await browser.newContext(opts);
  await ctx.route('**/*', (route) => {
    const { protocol, hostname } = new URL(route.request().url());
    if (protocol === 'data:' || protocol === 'blob:' || hostname === '127.0.0.1' || hostname === 'localhost') return route.continue();
    return route.abort();
  });
  return ctx;
}

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

/** Pick the variant's option values in the page's picker (product page or order step). */
export async function chooseVariant(page: Page, p: Pick): Promise<void> {
  for (const v of p.optionValueIds) {
    const radio = page.locator(`input[type="radio"][data-ov="${v}"]`).first();
    if (!(await radio.count())) throw new Error(`no picker radio for option value ${v} of variant ${p.variantId} at ${page.url()}`);
    if (await radio.isChecked()) continue;
    // the radio itself is visually hidden: a customer clicks its label (the pill or swatch)
    await page.locator('label', { has: radio }).first().click();
    if (!(await radio.isChecked())) throw new Error(`clicking the label of option value ${v} did not select it at ${page.url()}`);
  }
}

/** The order step's path for a product (CAT-1 orderStepPath). */
export const orderStepPath = (lang: string, slug: string): string => `/${lang}/order/${slug}/`;

/**
 * The customer's way in: open the product page, pick the variant, press the CTA, land on the order
 * step. With JS, variant.js reveals the CTA link (which carries ?v=<variantId>) and hides the
 * form's button; wait for that first, so the pick reaches the link. Without JS: the form's button.
 */
export async function openOrderStep(page: Page, web: string, lang: string, p: Pick, opts: { js?: boolean } = {}): Promise<void> {
  const js = opts.js !== false;
  const res = await page.goto(`${web}/${lang}/p/${p.slug}/`);
  if (res?.status() !== 200) throw new Error(`product page /${lang}/p/${p.slug}/: HTTP ${res?.status()} (build the storefront from the seed: HB_SNAPSHOT=seed)`);
  const buy = page.locator('#cat-buy');
  if (!(await buy.count())) throw new Error(`/${lang}/p/${p.slug}/ has no #cat-buy form (ORDER-STEP product page)`);
  const cta = buy.locator(js ? 'a.cat-cta' : 'button.cat-cta').first();
  await cta.waitFor({ state: 'visible', timeout: 15_000 });
  await chooseVariant(page, p);
  const target = orderStepPath(lang, p.slug);
  await Promise.all([page.waitForURL((u) => u.pathname === target, { timeout: 20_000 }), cta.click()]);
  await page.waitForLoadState('load');
}

/** With JS the step preselects the variant from ?v=: every option value of the pick ends up checked. */
export async function expectPreselected(page: Page, p: Pick): Promise<void> {
  const v = new URL(page.url()).searchParams.get('v');
  if (v !== String(p.variantId)) throw new Error(`the CTA did not carry the variant: ?v=${v}, expected ${p.variantId} (${page.url()})`);
  // polled from here, not page.waitForFunction: the site's CSP (correctly) forbids eval in the page
  for (const ov of p.optionValueIds) {
    const radio = page.locator(`input[type="radio"][data-ov="${ov}"]`).first();
    const end = Date.now() + 10_000;
    while (!(await radio.isChecked())) {
      if (Date.now() > end) throw new Error(`?v=${p.variantId} did not preselect option value ${ov} on the order step`);
      await page.waitForTimeout(100);
    }
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
    const btn = page.locator('form[action="/api/order"] button[type="submit"], form[action="/api/order"] input[type="submit"]').last();
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

/** Headers a browser sends on a same-origin form POST (admin-core lib/csrf.ts isSameOriginRequest). */
export const sameOrigin = (admin: string): Record<string, string> => ({ origin: admin, 'sec-fetch-site': 'same-origin' });

/** Cookie header for an admin dev session (local only). Throws unless the login answers 303 with a cookie. */
export async function adminLogin(admin: string, email = 'owner@dev.local'): Promise<string> {
  const r = await fetch(`${admin}/__dev/login`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...sameOrigin(admin) }, body: new URLSearchParams({ email }),
  });
  const cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  if (r.status !== 303 || !cookie) throw new Error(`dev login as ${email} failed: HTTP ${r.status}`);
  return cookie;
}

/** GET an admin page as a session; anything but 200 throws (a 403/404 fails the spec). */
export async function adminPage(admin: string, cookie: string, p: string): Promise<string> {
  const r = await fetch(`${admin}${p}`, { headers: { cookie }, redirect: 'manual' });
  if (r.status !== 200) throw new Error(`GET ${p}: HTTP ${r.status}`);
  return r.text();
}

/** The CSRF token rendered in an admin page (admin-core test helpers' csrfFrom). */
export function csrfFrom(html: string): string {
  const m = /name="_csrf" value="([^"]+)"/.exec(html);
  if (!m?.[1]) throw new Error('no _csrf in the admin page');
  return m[1];
}

/** The rendered `<form action=…>` (optionally the one containing `has`), or null. */
export function formIn(html: string, action: string, has = ''): string | null {
  for (const m of html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)) {
    if (m[0].includes(`action="${action}"`) && m[0].includes(has)) return m[0];
  }
  return null;
}

/** POST a same-origin form as a session (admin-core's postAs shape; `_csrf` supplied by the caller). */
export function postAs(admin: string, cookie: string, p: string, data: Record<string, string>): Promise<Response> {
  return fetch(`${admin}${p}`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', ...sameOrigin(admin) },
    body: new URLSearchParams(data),
  });
}

/** Tomorrow 10:00 in Algiers as a datetime-local value (a callback time the call form accepts). */
export function tomorrowAlgiers(now = Date.now()): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Algiers', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(now + 24 * 3600_000)).map((x) => [x.type, x.value]));
  return `${p['year']}-${p['month']}-${p['day']}T10:00`;
}

/**
 * Submit one order action from the order's detail page, as the page's form would: read the form,
 * its `version` and the `_csrf`, POST the fields. Must answer 303 (the app's success redirect);
 * a missing form, 403, 404, 409 or 422 throws with the status.
 */
export async function orderAction(admin: string, cookie: string, ref: string, action: 'call' | 'transition', data: Record<string, string>): Promise<void> {
  const html = await adminPage(admin, cookie, `/orders/${ref}`);
  const path = `/orders/${ref}/${action}`;
  const f = formIn(html, path, action === 'transition' ? `name="to" value="${data['to']}"` : '');
  if (!f) throw new Error(`the page /orders/${ref} has no ${action}${data['to'] ? ` to ${data['to']}` : ''} form for this user`);
  const version = /name="version" value="(\d+)"/.exec(f)?.[1];
  if (version === undefined) throw new Error(`the ${action} form has no version field`);
  const r = await postAs(admin, cookie, path, { _csrf: csrfFrom(html), version, ...data });
  if (r.status !== 303) throw new Error(`POST ${path} ${JSON.stringify(data)}: HTTP ${r.status} (expected 303)`);
}
