/**
 * A variant order in /ar/ and in /fr/ (JS on), placed the way a customer does: product page →
 * pick the variant → CTA → order step (ORDER-STEP). The form shows the wilaya's fee and the correct
 * total before confirming; the order reaches D1 and the admin; a duplicate submit (same key, and
 * the same customer going through the page again) returns the same ref and one order; then
 * (admin, admin-orders' contract) new → called → confirmed by call outcomes and → shipped by a manual transition with a courier, each recorded in order_events.
 */
import { afterAll, beforeAll, describe, expect } from 'vitest';
import type { Browser } from 'playwright';
import { d1 } from './harness.ts';
import { needs } from './needs.ts';
import { adminLogin, adminPage, expectNumbersShown, expectPreselected, fillCustomer, launch, loopbackContext, openOrderStep, orderAction, orderByRef, pickPlace, pickVariant, submitUntilConfirmed, tomorrowAlgiers, type Pick, type Place } from './flows.ts';

let browser: Browser | undefined;
beforeAll(async () => { browser = await launch(); });
afterAll(async () => { await browser?.close(); });

const QTY = 2;
const refs: Partial<Record<'ar' | 'fr', string>> = {};
interface Placed { v: Pick; place: Place; seed: number; name: string; phone: string }
const placed: Partial<Record<'ar' | 'fr', Placed>> = {};

describe.each(['ar', 'fr'] as const)('variant order in /%s/', (lang) => {
  needs('storefront', 'seed', 'webOrder', 'webQuote', 'orderForm')('from the product page: shows the wilaya fee and the correct total, then creates the order', async ({ web }) => {
    const v = pickVariant(lang);
    const place = pickPlace();
    const ctx = await loopbackContext(browser as Browser);
    const page = await ctx.newPage();
    await openOrderStep(page, web, lang, v);
    await expectPreselected(page, v);
    const seed = Date.now() % 1_000_000 + (lang === 'ar' ? 1 : 2);
    const { name, phone } = await fillCustomer(page, place, seed, QTY);
    const subtotal = v.price * QTY;
    const total = subtotal + place.fee;
    await expectNumbersShown(page, [place.fee, total]);
    const ref = await submitUntilConfirmed(page);
    expect(await page.locator('body').innerText()).toContain(ref);
    const o = orderByRef(ref);
    expect({ lang: o.lang, wilaya: o.wilaya_code, commune: o.commune_id, subtotal: o.subtotal_dzd, fee: o.fee_dzd, total: o.total_dzd, status: o.status })
      .toEqual({ lang, wilaya: place.wilaya, commune: place.communeId, subtotal, fee: place.fee, total, status: 'new' });
    const items = d1<{ variant_id: number; qty: number }>(`SELECT variant_id, qty FROM order_items WHERE order_id = ${o.id}`);
    expect(items).toEqual([{ variant_id: v.variantId, qty: QTY }]);
    refs[lang] = ref;
    placed[lang] = { v, place, seed, name, phone };
    await ctx.close();
  });

  needs('storefront', 'seed', 'webOrder', 'webQuote', 'orderForm')('a duplicate submit returns the same ref and creates one order', async ({ web }) => {
    const ref = refs[lang];
    const p = placed[lang];
    if (!ref || !p) throw new Error('the order test above did not create an order');
    const o = orderByRef(ref);
    // the same idempotency key again (a double click, a retried request): every success is 201
    const body = {
      lang, items: [{ variantId: p.v.variantId, qty: QTY }], name: p.name, phone: p.phone,
      wilayaCode: p.place.wilaya, communeId: p.place.communeId, idempotencyKey: o.idempotency_key, expectedTotalDzd: o.total_dzd, fillMs: 10_000,
    };
    const r = await fetch(`${web}/api/order`, { method: 'POST', headers: { 'content-type': 'application/json', origin: web }, body: JSON.stringify(body) });
    expect(r.status).toBe(201);
    expect((await r.json() as { ref?: string }).ref).toBe(ref);
    expect(d1<{ n: number }>(`SELECT COUNT(*) AS n FROM orders WHERE idempotency_key = '${o.idempotency_key}'`)[0]?.n).toBe(1);
    // the same customer going through the product page again (new page view, new key): server dedup
    const ctx = await loopbackContext(browser as Browser);
    const page = await ctx.newPage();
    await openOrderStep(page, web, lang, p.v);
    await expectPreselected(page, p.v);
    await fillCustomer(page, p.place, p.seed, QTY);
    await expectNumbersShown(page, [p.place.fee, o.total_dzd]);
    expect(await submitUntilConfirmed(page), 'a genuine double submit gets the existing order back').toBe(ref);
    expect(d1<{ n: number }>(`SELECT COUNT(*) AS n FROM orders WHERE phone_e164 = '${o.phone_e164}'`)[0]?.n).toBe(1);
    await ctx.close();
  });

  needs('storefront', 'seed', 'webOrder', 'orderForm', 'adminAuth', 'adminOrders')('the order reaches the admin', async ({ admin }) => {
    const ref = refs[lang];
    if (!ref) throw new Error('the order test above did not create an order');
    const cookie = await adminLogin(admin);
    expect(await adminPage(admin, cookie, '/orders')).toContain(ref);
    expect(await adminPage(admin, cookie, `/orders/${ref}`)).toContain(ref);
  });

  needs('storefront', 'seed', 'webOrder', 'orderForm', 'adminAuth', 'adminOrders', 'adminTransitions')('the order moves new → called → confirmed → shipped in the admin', async ({ admin }) => {
    const ref = refs[lang];
    if (!ref) throw new Error('the order test above did not create an order');
    const o = orderByRef(ref);
    const before = d1<{ n: number }>(`SELECT COUNT(*) AS n FROM order_events WHERE order_id = ${o.id}`)[0]?.n ?? 0;
    const confirmer = await adminLogin(admin, 'confirmer@dev.local');
    // a call with a callback: new → called (flagsChecked: a flagged order must be checked before confirming)
    await orderAction(admin, confirmer, ref, 'call', { outcome: 'callback', callbackAt: tomorrowAlgiers() });
    expect(orderByRef(ref).status).toBe('called');
    await orderAction(admin, confirmer, ref, 'call', { outcome: 'confirmed', flagsChecked: '1' });
    expect(orderByRef(ref).status).toBe('confirmed');
    const logistics = await adminLogin(admin, 'logistics@dev.local');
    await orderAction(admin, logistics, ref, 'transition', { to: 'shipped', courierName: 'E2E Express', courierTracking: `E2E-${ref}` });
    const shipped = d1<{ status: string; courier_name: string | null }>(`SELECT status, courier_name FROM orders WHERE id = ${o.id}`)[0];
    expect(shipped).toEqual({ status: 'shipped', courier_name: 'E2E Express' });
    const after = d1<{ n: number }>(`SELECT COUNT(*) AS n FROM order_events WHERE order_id = ${o.id}`)[0]?.n ?? 0;
    expect(after - before, 'order_events rows for new→called, called→confirmed, confirmed→shipped').toBeGreaterThanOrEqual(3);
  });
});
