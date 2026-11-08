// ACAT-7 stock screen: HTTP tests on a real D1 (plan artifacts/ACAT-7/plan.md §5 + §7).
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createDb, createOrder, transitionOrder } from '@hb/db';
import { safeBack } from '../../src/routes/products/stock.tsx';
import { harness, postAs, USERS, type Harness } from '../helpers.ts';
import { idAndLabelProblems } from './html.ts';

// The shared machine is heavily loaded: real-D1 HTTP tests can take seconds each.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let h: Harness;
beforeAll(async () => {
  h = await harness();
}, 120_000);
afterAll(async () => {
  await h?.close();
});

async function post(email: string, path: string, data: Record<string, string>) {
  return postAs(h, email, path, data);
}
const one = <T,>(sql: string, ...a: unknown[]) => h.db.prepare(sql).bind(...a).first<T>();
const stock = async (id: number) => (await one<{ stock: number | null }>('select stock from variants where id = ?', id))!.stock;
let auditFloor = 0;
const audits = async (action: string) =>
  (await h.db.prepare('select before, after from audit_log where action = ? and id > ? order by id').bind(action, auditFloor).all<{ before: string; after: string }>()).results;

let vid = 0;
let pid = 0;
beforeEach(async () => {
  auditFloor = (await one<{ n: number }>('select coalesce(max(id), 0) n from audit_log'))!.n;
  // Orders (append-only events) keep their variants alive: delete what is unreferenced and rename the
  // rest out of the way of this test's fixed SKU and slugs.
  for (const sql of [
    'delete from pack_items',
    'delete from variants where id not in (select variant_id from order_items)',
    "update variants set sku = 'OLD-' || id, stock = null",
    'delete from products where id not in (select product_id from variants)',
    "update products set slug_fr = 'old-' || id, slug_ar = 'old-' || id, status = 'archived'",
    'delete from categories where id not in (select category_id from products)',
    "update categories set slug_fr = 'old-' || id, slug_ar = 'old-' || id",
  ]) {
    await h.db.prepare(sql).run();
  }
  const cat = (await one<{ id: number }>("insert into categories (slug_fr, slug_ar, name_fr, name_ar) values ('c', 'c', 'C', 'ص') returning id"))!.id;
  pid = (await one<{ id: number }>("insert into products (kind, category_id, slug_fr, slug_ar, name_fr, name_ar) values ('simple', ?, 'p', 'p', 'Poêle', 'مقلاة') returning id", cat))!.id;
  vid = (await one<{ id: number }>("insert into variants (product_id, sku, price_dzd, stock, is_default) values (?, 'HB-P', 2500, 10, 1) returning id", pid))!.id;
});

describe('access', () => {
  test('logistics: stock screen yes, prices no; confirmer: neither', async () => {
    const page = await h.as(USERS.logistics, '/products/stock');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('HB-P');
    expect((await post(USERS.logistics, '/products/stock/set', { variant_id: String(vid), stock: '12', was: '10' })).status).toBe(303);
    expect((await postAs(h, USERS.logistics, `/products/${pid}/variants`, {})).status).toBe(403);
    expect((await h.as(USERS.confirmer, '/products/stock')).status).toBe(403);
    expect((await postAs(h, USERS.confirmer, '/products/stock/set', { variant_id: String(vid), stock: '1', was: '12' })).status).toBe(403);
    expect(await stock(vid)).toBe(12);
  });
});

describe('set', () => {
  test('audited with before/after; conditional on the value shown (order in between → 409, nothing written)', async () => {
    expect((await post(USERS.logistics, '/products/stock/set', { variant_id: String(vid), stock: '15', was: '10' })).status).toBe(303);
    const [a] = await audits('stock.set');
    expect(JSON.parse(a!.before)).toEqual({ sku: 'HB-P', stock: 10 });
    expect(JSON.parse(a!.after)).toEqual({ sku: 'HB-P', stock: 15 });
    await h.db.prepare('update variants set stock = stock - 1 where id = ?').bind(vid).run(); // an order
    const res = await post(USERS.logistics, '/products/stock/set', { variant_id: String(vid), stock: '20', was: '15' });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('valeur actuelle 14');
    expect(await stock(vid)).toBe(14);
    expect(await audits('stock.set')).toHaveLength(1);
  });

  test('two sets from the same shown value: exactly one wins', async () => {
    const [r1, r2] = await Promise.all([
      post(USERS.logistics, '/products/stock/set', { variant_id: String(vid), stock: '30', was: '10' }),
      post(USERS.owner, '/products/stock/set', { variant_id: String(vid), stock: '40', was: '10' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([303, 409]);
    expect([30, 40]).toContain(await stock(vid));
    expect(await audits('stock.set')).toHaveLength(1);
  });

  test.each([['1.5'], ['-1'], ['1e3'], [''], ['abc']])('refuses stock=%j', async (value) => {
    expect((await post(USERS.logistics, '/products/stock/set', { variant_id: String(vid), stock: value, was: '10' })).status).toBe(422);
    expect(await stock(vid)).toBe(10);
  });

  test('Eastern-Arabic digits accepted; unknown fields (price, active) refused', async () => {
    expect((await post(USERS.logistics, '/products/stock/set', { variant_id: String(vid), stock: '٧', was: '10' })).status).toBe(303);
    expect(await stock(vid)).toBe(7);
    expect((await post(USERS.logistics, '/products/stock/set', { variant_id: String(vid), stock: '8', was: '7', price: '1' })).status).toBe(422);
    expect((await post(USERS.logistics, '/products/stock/set', { variant_id: String(vid), stock: '8', was: '7', active: '0' })).status).toBe(422);
    expect((await one<{ price_dzd: number }>('select price_dzd from variants where id = ?', vid))!.price_dzd).toBe(2500);
  });

  test('bumps the variant version, so a grid opened before fails its guard', async () => {
    const before = (await one<{ updated_at: number }>('select updated_at from variants where id = ?', vid))!.updated_at;
    await post(USERS.logistics, '/products/stock/set', { variant_id: String(vid), stock: '11', was: '10' });
    expect((await one<{ updated_at: number }>('select updated_at from variants where id = ?', vid))!.updated_at).toBeGreaterThan(before);
  });
});

describe('adjust', () => {
  test('relative change with reason and note, audited', async () => {
    expect((await post(USERS.logistics, '/products/stock/adjust', { variant_id: String(vid), delta: '+5', reason: 'received', note: 'Livraison 12' })).status).toBe(422); // '+5' is not an integer form
    expect((await post(USERS.logistics, '/products/stock/adjust', { variant_id: String(vid), delta: '5', reason: 'received', note: 'Livraison 12' })).status).toBe(303);
    expect(await stock(vid)).toBe(15);
    const [a] = await audits('stock.adjust');
    expect(JSON.parse(a!.after)).toEqual({ sku: 'HB-P', stock: 15, delta: 5, reason: 'received', note: 'Livraison 12' });
  });

  test('never below 0; refused on an untracked variant; no customer-return reason', async () => {
    const res = await post(USERS.logistics, '/products/stock/adjust', { variant_id: String(vid), delta: '-11', reason: 'damaged' });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('stock actuel : 10');
    expect(await stock(vid)).toBe(10);
    expect((await post(USERS.logistics, '/products/stock/adjust', { variant_id: String(vid), delta: '-1', reason: 'customer_return' })).status).toBe(422);
    await h.db.prepare('update variants set stock = null where id = ?').bind(vid).run();
    expect((await post(USERS.logistics, '/products/stock/adjust', { variant_id: String(vid), delta: '3', reason: 'received' })).status).toBe(422);
    expect(await stock(vid)).toBeNull();
  });

  test('two parallel adjusts both apply (no lost update), two audit rows', async () => {
    const [r1, r2] = await Promise.all([
      post(USERS.logistics, '/products/stock/adjust', { variant_id: String(vid), delta: '2', reason: 'received' }),
      post(USERS.owner, '/products/stock/adjust', { variant_id: String(vid), delta: '3', reason: 'count' }),
    ]);
    expect([r1.status, r2.status]).toEqual([303, 303]);
    expect(await stock(vid)).toBe(15);
    expect(await audits('stock.adjust')).toHaveLength(2);
  });
});

describe('track / untrack', () => {
  test('untrack needs the confirmation, then sets NULL; the confirm page warns about cancellations', async () => {
    const page = await (await h.as(USERS.logistics, `/products/stock/track?variant=${vid}`)).text();
    expect(page).toContain('ne remettront plus de stock');
    expect((await post(USERS.logistics, '/products/stock/track', { variant_id: String(vid), track: '0', was: '10' })).status).toBe(422);
    expect((await post(USERS.logistics, '/products/stock/track', { variant_id: String(vid), track: '0', was: '10', confirm: '1' })).status).toBe(303);
    expect(await stock(vid)).toBeNull();
    const [a] = await audits('stock.track');
    expect(JSON.parse(a!.after)).toEqual({ sku: 'HB-P', stock: null });
  });

  test('track takes the count in the same POST (never an intermediate 0)', async () => {
    await h.db.prepare('update variants set stock = null where id = ?').bind(vid).run();
    const page = await (await h.as(USERS.logistics, `/products/stock/track?variant=${vid}`)).text();
    expect(page).toContain('ne remettront pas de stock');
    expect((await post(USERS.logistics, '/products/stock/track', { variant_id: String(vid), track: '1', confirm: '1' })).status).toBe(422);
    expect(await stock(vid)).toBeNull();
    expect((await post(USERS.logistics, '/products/stock/track', { variant_id: String(vid), track: '1', stock: '5', confirm: '1' })).status).toBe(303);
    expect(await stock(vid)).toBe(5);
  });

  test('stale: tracking a variant that became tracked meanwhile → 409', async () => {
    await h.db.prepare('update variants set stock = null where id = ?').bind(vid).run();
    await h.db.prepare('update variants set stock = 9 where id = ?').bind(vid).run();
    expect((await post(USERS.logistics, '/products/stock/track', { variant_id: String(vid), track: '1', stock: '5', confirm: '1' })).status).toBe(409);
    expect(await stock(vid)).toBe(9);
  });
});

describe('filters and redirects', () => {
  test('state filters and a long Arabic search (no LIKE)', async () => {
    await h.db.prepare("insert into variants (product_id, sku, price_dzd, stock) values (?, 'HB-OUT', 1, 0), (?, 'HB-LOW', 1, 2), (?, 'HB-NT', 1, null)").bind(pid, pid, pid).run();
    const html = (s: string) => h.as(USERS.logistics, `/products/stock?state=${s}`).then((r) => r.text());
    expect(await html('out')).toContain('HB-OUT');
    expect(await html('out')).not.toContain('HB-LOW');
    expect(await html('low')).toContain('HB-LOW');
    expect(await html('untracked')).toContain('HB-NT');
    const q = encodeURIComponent('مقلاة '.repeat(15));
    expect((await h.as(USERS.logistics, `/products/stock?q=${q}`)).status).toBe(200);
  });

  test('safeBack only returns the stock screen with known params', () => {
    expect(safeBack('/products/stock?state=low&evil=1')).toBe('/products/stock?state=low');
    for (const evil of ['//evil.example', 'https://evil.example/products/stock', '/products/1', 'javascript:alert(1)', '/\\evil']) {
      expect(safeBack(evil)).toBe('/products/stock');
    }
  });
});

// DB-4 r2 (team/db 9527c50): order_items.stock_taken records what an order took; cancel restores
// exactly that, and only to a variant that is still tracked (ACAT-7 plan §7 #2).
describe('tracking vs order cancellation (DB-4 stock_taken)', () => {
  let n = 0;
  async function placeOrder(qty: number) {
    await h.db.prepare("insert or ignore into wilayas (code, name_fr, name_ar) values (16, 'Alger', 'الجزائر')").run();
    await h.db.prepare("insert or ignore into communes (id, wilaya_code, name_fr, name_ar) values (1601, 16, 'Alger Centre', 'الجزائر الوسطى')").run();
    n++;
    const res = await createOrder(createDb(h.db), {
      customer: { phoneE164: '+213555123456', name: 'Test' },
      order: {
        ref: `HB-T${String(n).padStart(4, '0')}`,
        idempotencyKey: crypto.randomUUID(),
        lang: 'fr',
        wilayaCode: 16,
        communeId: 1601,
        subtotalDzd: 2500 * qty,
        feeDzd: 600,
        totalDzd: 2500 * qty + 600,
        feeSource: 'table',
        flags: [],
        turnstile: null,
        fillMs: null,
        riskScore: null,
        ipHash: null,
      },
      lines: [{ variantId: vid, productId: pid, nameFr: 'Poêle', nameAr: 'مقلاة', variantLabelFr: null, variantLabelAr: null, sku: 'HB-P', unitPriceDzd: 2500, qty, lineTotalDzd: 2500 * qty }],
    });
    if (!res.ok) throw new Error(`order failed: ${JSON.stringify(res)}`);
    return res.orderId;
  }
  async function cancel(orderId: number) {
    await h.db.prepare("update orders set status = 'called' where id = ?").bind(orderId).run();
    const v = (await one<{ version: number }>('select version from orders where id = ?', orderId))!.version;
    const owner = (await one<{ id: number }>('select id from admin_users where email = ?', USERS.owner))!.id;
    const r = await transitionOrder(createDb(h.db), orderId, 'cancelled', { userId: owner, role: 'owner' }, 'customer_refused', v);
    expect(r.ok).toBe(true);
  }

  test('tracked order → untrack → cancel: stock stays NULL', async () => {
    const order = await placeOrder(2);
    expect(await stock(vid)).toBe(8);
    expect((await post(USERS.logistics, '/products/stock/track', { variant_id: String(vid), track: '0', was: '8', confirm: '1' })).status).toBe(303);
    await cancel(order);
    expect(await stock(vid)).toBeNull();
  });

  test('untracked order → track(5) → cancel: stock stays 5', async () => {
    await h.db.prepare('update variants set stock = null where id = ?').bind(vid).run();
    const order = await placeOrder(3);
    expect(await stock(vid)).toBeNull();
    expect((await post(USERS.logistics, '/products/stock/track', { variant_id: String(vid), track: '1', stock: '5', confirm: '1' })).status).toBe(303);
    await cancel(order);
    expect(await stock(vid)).toBe(5);
  });

  test('control: tracked order cancelled while still tracked restores its quantity', async () => {
    const order = await placeOrder(2);
    expect(await stock(vid)).toBe(8);
    await cancel(order);
    expect(await stock(vid)).toBe(10);
  });
});

describe('accessibility of repeated rows (rev-f a7c5393 F1)', () => {
  test('stock rows: no repeated id, every label points inside its own row and names its SKU', async () => {
    await h.db.prepare("insert into variants (product_id, sku, price_dzd, stock) values (?, 'HB-2', 1, 4), (?, 'HB-3', 1, 6)").bind(pid, pid).run();
    for (const user of [USERS.logistics, USERS.ownerAr]) {
      const html = await (await h.as(user, '/products/stock')).text();
      // A stacking table (cards below 600 px): one row per variant.
      const rows = [...html.matchAll(/<tr data-key="(\d+)">([\s\S]*?)<\/tr>/g)];
      expect(rows.length).toBeGreaterThanOrEqual(3);
      expect(idAndLabelProblems(html, /<tr data-key="\d+">[\s\S]*?<\/tr>/)).toEqual([]);
      // Each row's field labels name its own SKU (rev-f nit: no identical accessible names).
      for (const [, , body] of rows) {
        const sku = /<bdi dir="ltr" class="code">([^<]+)<\/bdi>/.exec(body!)?.[1];
        if (!body!.includes('name="stock"')) continue;
        expect(body).toContain(`(\u2066${sku}\u2069)`);
      }
    }
  });

  test('the delta hint keeps its sign in both languages (isolated LTR)', async () => {
    expect(await (await h.as(USERS.logistics, '/products/stock')).text()).toContain('\u2066+5\u2069');
    expect(await (await h.as(USERS.ownerAr, '/products/stock')).text()).toContain('\u2066+5\u2069');
  });
});
