// ACAT-6 packs: pure item-list logic + HTTP tests on a real D1.
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { nextItems, PACK_MAX_ITEMS } from '../../src/routes/products/pack.tsx';
import { harness, postAs, USERS, type Harness } from '../helpers.ts';
import { idAndLabelProblems } from './html.ts';

// The shared machine is heavily loaded: real-D1 HTTP tests can take seconds each.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

describe('nextItems (pure)', () => {
  const items = [{ variantId: 1, qty: 1 }, { variantId: 2, qty: 3 }];
  const pick = new Set([1, 2, 3]);
  test('add / duplicate / not pickable / full', () => {
    expect(nextItems(items, 'add', { variant_id: 3, qty: 2 }, pick)).toEqual({ ok: true, items: [...items, { variantId: 3, qty: 2 }] });
    expect(nextItems(items, 'add', { variant_id: 2, qty: 1 }, pick)).toMatchObject({ ok: false, error: 'pack.err.duplicate' });
    expect(nextItems(items, 'add', { variant_id: 9, qty: 1 }, pick)).toMatchObject({ ok: false, error: 'pack.err.variant' });
    const full = Array.from({ length: PACK_MAX_ITEMS }, (_, i) => ({ variantId: 100 + i, qty: 1 }));
    expect(nextItems(full, 'add', { variant_id: 3, qty: 1 }, pick)).toMatchObject({ ok: false, error: 'pack.err.full' });
  });
  test('update / move / remove; unknown item is stale', () => {
    expect(nextItems(items, 'update', { variant_id: 1, qty: 5 }, pick)).toEqual({ ok: true, items: [{ variantId: 1, qty: 5 }, items[1]] });
    expect(nextItems(items, 'move', { variant_id: 2, dir: 'up' }, pick)).toEqual({ ok: true, items: [items[1], items[0]] });
    expect(nextItems(items, 'move', { variant_id: 1, dir: 'up' }, pick)).toEqual({ ok: true, items });
    expect(nextItems(items, 'remove', { variant_id: 1 }, pick)).toEqual({ ok: true, items: [items[1]] });
    expect(nextItems(items, 'remove', { variant_id: 7 }, pick)).toMatchObject({ ok: false, error: 'err.stale' });
  });
});

let h: Harness;
let catId = 0;
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
const all = <T,>(sql: string, ...a: unknown[]) => h.db.prepare(sql).bind(...a).all<T>().then((r) => r.results);
const version = async (pid: number) => String((await one<{ updated_at: number }>('select updated_at from products where id = ?', pid))!.updated_at);
const items = (pid: number) => all<{ variant_id: number; qty: number }>('select variant_id, qty from pack_items where pack_product_id = ? order by position', pid);
let auditFloor = 0;

async function create(data: Record<string, string>): Promise<number> {
  const res = await post(USERS.content, '/products', { category_id: String(catId), price: '1000', ...data });
  expect(res.status).toBe(303);
  return Number(/\/products\/(\d+)/.exec(res.headers.get('Location')!)![1]);
}
const variantOf = async (pid: number) => (await one<{ id: number }>('select id from variants where product_id = ?', pid))!.id;

let pack = 0;
let a = 0;
let b = 0;
beforeEach(async () => {
  auditFloor = (await one<{ n: number }>('select coalesce(max(id), 0) n from audit_log'))!.n;
  for (const sql of ['delete from images', 'delete from pack_items', 'delete from variants', 'delete from product_options', 'delete from products', 'delete from categories']) {
    await h.db.prepare(sql).run();
  }
  catId = (await one<{ id: number }>("insert into categories (slug_fr, slug_ar, name_fr, name_ar) values ('c', 'c', 'C', 'ص') returning id"))!.id;
  const pa = await create({ kind: 'simple', name_fr: 'Casserole', name_ar: 'قدر', sku: 'A' });
  const pb = await create({ kind: 'simple', name_fr: 'Poêle', name_ar: 'مقلاة', sku: 'B' });
  a = await variantOf(pa);
  b = await variantOf(pb);
  pack = await create({ kind: 'pack', name_fr: 'Pack cuisine', name_ar: 'حزمة', sku: 'PACK-1', price: '1800' });
});

describe('pack editor', () => {
  test('a pack is created with its own single variant and no items', async () => {
    expect((await one<{ kind: string }>('select kind from products where id = ?', pack))!.kind).toBe('pack');
    expect(await all('select id from variants where product_id = ?', pack)).toHaveLength(1);
    const html = await (await h.as(USERS.content, `/products/${pack}`)).text();
    expect(html).toContain('id="sec-pack"');
    expect(html).not.toContain('id="sec-options"');
  });

  test('add, update qty, move, remove: each audited with before/after', async () => {
    expect((await post(USERS.content, `/products/${pack}/pack/add`, { v: await version(pack), variant_id: String(a), qty: '2' })).status).toBe(303);
    expect((await post(USERS.content, `/products/${pack}/pack/add`, { v: await version(pack), variant_id: String(b), qty: '1' })).status).toBe(303);
    expect(await items(pack)).toEqual([{ variant_id: a, qty: 2 }, { variant_id: b, qty: 1 }]);
    expect((await post(USERS.content, `/products/${pack}/pack/update`, { v: await version(pack), variant_id: String(b), qty: '4' })).status).toBe(303);
    expect((await post(USERS.content, `/products/${pack}/pack/move`, { v: await version(pack), variant_id: String(b), dir: 'up' })).status).toBe(303);
    expect(await items(pack)).toEqual([{ variant_id: b, qty: 4 }, { variant_id: a, qty: 2 }]);
    expect((await post(USERS.content, `/products/${pack}/pack/remove`, { v: await version(pack), variant_id: String(a) })).status).toBe(303);
    expect(await items(pack)).toEqual([{ variant_id: b, qty: 4 }]);
    const rows = await all<{ before: string; after: string }>("select before, after from audit_log where action = 'pack.update' and id > ? order by id", auditFloor);
    expect(rows).toHaveLength(5);
    expect(JSON.parse(rows[4]!.after)).toEqual({ items: [{ variantId: b, qty: 4 }] });
  });

  test('refuses a pack inside a pack, duplicates, qty 0 / 100, and a stale version', async () => {
    const other = await create({ kind: 'pack', name_fr: 'Autre pack', name_ar: 'حزمة أخرى', sku: 'PACK-2' });
    const pv = await variantOf(other);
    expect((await post(USERS.content, `/products/${pack}/pack/add`, { v: await version(pack), variant_id: String(pv), qty: '1' })).status).toBe(422);
    expect((await post(USERS.content, `/products/${pack}/pack/add`, { v: await version(pack), variant_id: String(a), qty: '0' })).status).toBe(422);
    expect((await post(USERS.content, `/products/${pack}/pack/add`, { v: await version(pack), variant_id: String(a), qty: '100' })).status).toBe(422);
    expect((await post(USERS.content, `/products/${pack}/pack/add`, { v: await version(pack), variant_id: String(a), qty: '1' })).status).toBe(303);
    expect((await post(USERS.content, `/products/${pack}/pack/add`, { v: await version(pack), variant_id: String(a), qty: '1' })).status).toBe(422);
    expect((await post(USERS.content, `/products/${pack}/pack/add`, { v: '1', variant_id: String(b), qty: '1' })).status).toBe(409);
    expect(await items(pack)).toEqual([{ variant_id: a, qty: 1 }]);
  }, 180_000); // ~12 sequential requests: slow on the shared machine

  test('pack routes 404 on a non-pack product; confirmer gets 403', async () => {
    const simple = (await one<{ product_id: number }>('select product_id from variants where id = ?', a))!.product_id;
    expect((await post(USERS.content, `/products/${simple}/pack/add`, { v: await version(simple), variant_id: String(b), qty: '1' })).status).toBe(404);
    expect((await postAs(h, USERS.confirmer, `/products/${pack}/pack/add`, { v: '0', variant_id: String(a), qty: '1' })).status).toBe(403);
  });

  test('an empty pack cannot be activated; with contents and an image it can', async () => {
    await h.db.prepare("insert into images (product_id, r2_key, width, height, alt_fr, alt_ar) values (?, 'k/p.jpg', 10, 10, 'p', 'ح')").bind(pack).run();
    const r1 = await post(USERS.content, `/products/${pack}/status`, { to: 'active', v: await version(pack) });
    expect(r1.status).toBe(422);
    expect(await r1.text()).toContain('pack needs');
    await post(USERS.content, `/products/${pack}/pack/add`, { v: await version(pack), variant_id: String(a), qty: '1' });
    expect((await post(USERS.content, `/products/${pack}/status`, { to: 'active', v: await version(pack) })).status).toBe(303);
  });

  test('pack page with several lines: no repeated id, every label resolves', async () => {
    await post(USERS.content, `/products/${pack}/pack/add`, { v: await version(pack), variant_id: String(a), qty: '1' });
    await post(USERS.content, `/products/${pack}/pack/add`, { v: await version(pack), variant_id: String(b), qty: '2' });
    const html = await (await h.as(USERS.content, `/products/${pack}`)).text();
    expect(idAndLabelProblems(html)).toEqual([]);
  });

  test('a variant in a pack keeps its product from being deleted', async () => {
    await post(USERS.content, `/products/${pack}/pack/add`, { v: await version(pack), variant_id: String(a), qty: '1' });
    const simple = (await one<{ product_id: number }>('select product_id from variants where id = ?', a))!.product_id;
    expect((await post(USERS.content, `/products/${simple}/delete`, {})).status).toBe(409);
  });
});
