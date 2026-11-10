// CART-4 (ledger C-10): orders sent from pages built before a cart switch still go through. The Worker never gates
// /api/order on settings.cartEnabled: a cart-checkout payload (several lines) is accepted while the stored switch says
// off, and a single-product payload (JSON and the no-JS form) while it says on. Real Worker in workerd, real local D1.
import { vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 90_000 });
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { postForm, postJson, startSeeded, type Started } from './support/harness.ts';

let h: Started;
beforeAll(async () => {
  h = await startSeeded();
});
afterAll(async () => {
  await h?.server.close();
});

let seq = 0;
const freshPhone = () => `0771${String(300000 + seq++).padStart(6, '0')}`;
const setCart = (on: boolean) =>
  h.env.DB.prepare(`insert into settings (key, value) values ('cartEnabled', ?) on conflict (key) do update set value = excluded.value`)
    .bind(JSON.stringify(on))
    .run();
const stored = async () => (await h.env.DB.prepare(`select value from settings where key = 'cartEnabled'`).first<{ value: string }>())?.value;

function order(over: Record<string, unknown>) {
  return {
    idempotencyKey: crypto.randomUUID(),
    lang: 'fr',
    name: 'Amine Test',
    phone: freshPhone(),
    wilayaCode: 16,
    communeId: 1601,
    website: '',
    fillMs: 9000,
    ...over,
  };
}
async function lines(ref: unknown) {
  return (
    await h.env.DB.prepare('select variant_id, qty from order_items where order_id = (select id from orders where ref = ?) order by variant_id')
      .bind(ref)
      .all<{ variant_id: number; qty: number }>()
  ).results;
}

describe('/api/order ignores the cart switch', () => {
  test('cart OFF in D1: a cart-checkout payload (2 lines, from a page built while the cart was on) → 201', async () => {
    await setCart(false);
    expect(await stored()).toBe('false');
    const items = [{ variantId: 11, qty: 1 }, { variantId: 21, qty: 2 }];
    const res = await postJson(h.server, '/api/order', order({ items, expectedTotalDzd: 14600 + 2 * 15500 + 600 }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ duplicate: false, totalDzd: 14600 + 2 * 15500 + 600 });
    expect(await lines(json['ref'])).toEqual([
      { variant_id: 11, qty: 1 },
      { variant_id: 21, qty: 2 },
    ]);
  });

  test('cart ON in D1: a single-product JSON payload (from a page built while the cart was off) → 201', async () => {
    await setCart(true);
    expect(await stored()).toBe('true');
    const res = await postJson(h.server, '/api/order', order({ items: [{ variantId: 11, qty: 1 }], expectedTotalDzd: 15200 }));
    expect(res.status).toBe(201);
    const json = (await res.json()) as Record<string, unknown>;
    expect(await lines(json['ref'])).toEqual([{ variant_id: 11, qty: 1 }]);
  });

  test.each([false, true])('cart %s in D1: the no-JS single-product form still reaches its review step (200) and confirms (303)', async (on) => {
    await setCart(on);
    const phone = freshPhone();
    const review = await postForm(h.server, '/api/order', { lang: 'ar', variantId: '11', qty: '1', name: 'Amine', phone, wilayaCode: '16', website: '' });
    expect(review.status).toBe(200);
    const f: Record<string, string> = {};
    for (const m of (await review.text()).matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) f[m[1]!] = m[2]!;
    await new Promise((r) => setTimeout(r, 1600)); // MIN_REVIEW_MS
    const res = await postForm(h.server, '/api/order', { ...f, name: 'Amine', phone, communeId: '1602' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toMatch(/^\/ar\/order\/confirmation\/\?ref=HB-/);
  });

  test('a missing key (never switched) changes nothing either', async () => {
    await h.env.DB.prepare(`delete from settings where key = 'cartEnabled'`).run();
    const items = [{ variantId: 11, qty: 1 }, { variantId: 21, qty: 1 }];
    const res = await postJson(h.server, '/api/order', order({ items, expectedTotalDzd: 14600 + 15500 + 600 }));
    expect(res.status).toBe(201);
  });
});
