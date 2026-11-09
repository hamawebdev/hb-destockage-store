// UX-9 — low-stock alerts over real D1: who sees it, which variants, the order, the sales pace,
// the quick "set" form coming back here, and the dashboard tile pointing at it.
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { daysLeft } from '../../src/routes/products/alerts.tsx';
import { harness, postAs, USERS, type Harness } from '../helpers.ts';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let h: Harness;
const one = <T,>(sql: string, ...a: unknown[]) => h.db.prepare(sql).bind(...a).first<T>();
const V: Record<string, number> = {};

beforeAll(async () => {
  h = await harness();
  const cat = (await one<{ id: number }>("insert into categories (slug_fr, slug_ar, name_fr, name_ar) values ('c', 'c', 'C', 'ص') returning id"))!.id;
  const product = async (slug: string, status: string) =>
    (await one<{ id: number }>("insert into products (kind, category_id, slug_fr, slug_ar, name_fr, name_ar, status) values ('simple', ?, ?, ?, ?, ?, ?) returning id", cat, slug, slug, `Produit ${slug}`, `منتج ${slug}`, status))!.id;
  const variant = async (pid: number, sku: string, stock: number | null, active = 1) =>
    (await one<{ id: number }>('insert into variants (product_id, sku, price_dzd, stock, is_default, active) values (?, ?, 1000, ?, 1, ?) returning id', pid, sku, stock, active))!.id;
  V.out = await variant(await product('out', 'active'), 'SKU-OUT', 0);
  V.lowSelling = await variant(await product('lows', 'active'), 'SKU-LOW-S', 2);
  V.lowQuiet = await variant(await product('lowq', 'active'), 'SKU-LOW-Q', 2);
  V.three = await variant(await product('three', 'draft'), 'SKU-THREE', 3);
  V.plenty = await variant(await product('plenty', 'active'), 'SKU-PLENTY', 50);
  V.untracked = await variant(await product('untracked', 'active'), 'SKU-UNTRACKED', null);
  V.archived = await variant(await product('arch', 'archived'), 'SKU-ARCH', 0);
  V.inactive = await variant(await product('inact', 'active'), 'SKU-INACTIVE', 0, 0);
  // 6 units of SKU-LOW-S ordered in the window (one cancelled order of 9 that must not count).
  await h.db.prepare("insert into wilayas (code, name_fr, name_ar) values (16, 'Alger', 'الجزائر')").run();
  await h.db.prepare("insert into communes (id, wilaya_code, name_fr, name_ar) values (1601, 16, 'Bab Ezzouar', 'باب الزوار')").run();
  const cust = (await one<{ id: number }>("insert into customers (phone_e164, name) values ('+213560417403', 'A') returning id"))!.id;
  const now = Date.now();
  let i = 0;
  for (const [qty, status] of [[4, 'new'], [2, 'delivered'], [9, 'cancelled']] as const) {
    i++;
    const o = (await one<{ id: number }>(
      `insert into orders (ref, idempotency_key, customer_id, name, phone_e164, wilaya_code, commune_id, lang, status, subtotal_dzd, fee_dzd, total_dzd, fee_source, created_at, updated_at)
       values (?, ?, ?, 'A', '+213560417403', 16, 1601, 'fr', ?, ?, 0, ?, 'test', ?, ?) returning id`,
      `HB-AL00${i}`, `k${i}`, cust, status, qty * 1000, qty * 1000, now - 86_400_000, now - 86_400_000,
    ))!.id;
    await h.db
      .prepare("insert into order_items (order_id, variant_id, product_id, name_fr, name_ar, sku, unit_price_dzd, qty, line_total_dzd) select ?, id, product_id, 'x', 'x', sku, 1000, ?, ? from variants where id = ?")
      .bind(o, qty, qty * 1000, V.lowSelling)
      .run();
  }
}, 180_000);

afterAll(async () => {
  await h?.close();
});

describe('daysLeft', () => {
  test('pace over 30 days', () => {
    expect(daysLeft(2, 0)).toBeNull();
    expect(daysLeft(2, 6)).toBe(10);
    expect(daysLeft(1, 60)).toBe(0);
  });
});

describe('/products/stock/alerts', () => {
  test('owner: out of stock first, then low by sales; untracked, plentiful, archived and inactive excluded', async () => {
    const res = await h.as(USERS.owner, '/products/stock/alerts');
    expect(res.status).toBe(200);
    const html = await res.text();
    const at = (sku: string) => html.indexOf(sku);
    expect(at('SKU-OUT')).toBeGreaterThan(0);
    expect(at('SKU-OUT')).toBeLessThan(at('SKU-LOW-S'));
    expect(at('SKU-LOW-S')).toBeLessThan(at('SKU-LOW-Q'));
    expect(at('SKU-LOW-Q')).toBeLessThan(at('SKU-THREE'));
    for (const sku of ['SKU-PLENTY', 'SKU-UNTRACKED', 'SKU-ARCH', 'SKU-INACTIVE']) expect(html).not.toContain(sku);
    expect(html).toContain('≈ 10 jours'); // 2 left, 6 ordered in 30 days (the cancelled 9 do not count)
    expect(html).toContain('pas de vente récente');
    expect(html).toContain('href="/settings#f-lowStockThreshold"');
  });
  test('the quick set form comes back to the alerts', async () => {
    const res = await postAs(h, USERS.owner, '/products/stock/set', { variant_id: String(V.lowQuiet), stock: '40', was: '2', back: '/products/stock/alerts' });
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toMatch(/^\/products\/stock\/alerts(\?|$)/);
    expect(await (await h.as(USERS.owner, '/products/stock/alerts')).text()).not.toContain('SKU-LOW-Q');
  });
  test('roles: logistics and content see it, without the settings link; confirmer gets 403', async () => {
    const lg = await h.as(USERS.logistics, '/products/stock/alerts');
    expect(lg.status).toBe(200);
    expect(await lg.text()).not.toContain('/settings#f-lowStockThreshold');
    expect((await h.as(USERS.content, '/products/stock/alerts')).status).toBe(200);
    expect((await h.as(USERS.confirmer, '/products/stock/alerts')).status).toBe(403);
  });
  test('Arabic page, and the dashboard tile counts the same set and links here', async () => {
    expect(await (await h.as(USERS.ownerAr, '/products/stock/alerts')).text()).toContain('تنبيهات المخزون');
    const dash = await (await h.as(USERS.owner, '/dashboard')).text();
    expect(dash).toMatch(/data-tile="lowStock"[\s\S]*?href="\/products\/stock\/alerts"[\s\S]*?tile__value[^>]*>(<[^>]+>)*3</);
  });
  test('empty state when nothing is low', async () => {
    await h.db.prepare("update variants set stock = 100 where stock is not null").run();
    const html = await (await h.as(USERS.owner, '/products/stock/alerts')).text();
    expect(html).toContain('Aucune alerte');
  });
});
