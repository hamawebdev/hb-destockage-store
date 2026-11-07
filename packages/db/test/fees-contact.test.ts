// DB-6 on real D1 (workerd via getPlatformProxy): @hb/db/fees and updateOrderContact.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// workerd D1 per test: generous timeout on a loaded shared machine.
vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });
import { checkFeeProviderConformance, computeTotals, type FeeProvider } from '@hb/shared';
import type { AnyD1Database } from 'drizzle-orm/d1';
import { createAdminTableFeeProvider } from '../src/fees.ts';
import { updateOrderContact } from '../src/order-contact.ts';
import { createOrder } from '../src/orders.ts';
import { createDb, type Db } from '../src/index.ts';
import { exec, freshD1, type RawD1 } from './d1.ts';

let d1: RawD1;
let db: Db;
let dispose: () => Promise<void>;

beforeEach(async () => {
  ({ d1, db, dispose } = await freshD1());
  await exec(
    d1,
    `insert into admin_users (id, email, name, role) values (1, 'owner@dev.local', 'O', 'owner'), (2, 'confirmer@dev.local', 'C', 'confirmer'), (3, 'logistics@dev.local', 'L', 'logistics');
     insert into categories (id, slug_fr, slug_ar, name_fr, name_ar) values (1, 'c', 'c-ar', 'C', 'ك');
     insert into products (id, category_id, slug_fr, slug_ar, name_fr, name_ar, status) values (10, 1, 'p', 'p-ar', 'Pack', 'طقم', 'active');
     insert into variants (id, product_id, sku, price_dzd, stock, weight_g, is_default) values (100, 10, 'PACK', 14600, 50, 1200, 1);
     insert into wilayas (code, name_fr, name_ar) values (16, 'Alger', 'الجزائر'), (31, 'Oran', 'وهران'), (9, 'Blida', 'البليدة'), (11, 'Tamanrasset', 'تمنراست');
     insert into communes (id, wilaya_code, name_fr, name_ar) values (1601, 16, 'Alger Centre', 'الجزائر الوسطى'), (1602, 16, 'Sidi Mhamed', 'سيدي امحمد'), (3101, 31, 'Oran', 'وهران'), (901, 9, 'Blida', 'البليدة'), (1101, 11, 'Tamanrasset', 'تمنراست');
     insert into delivery_fees (wilaya_code, fee_dzd, available, placeholder) values (16, 600, 1, 0), (31, 900, 1, 0), (9, 700, 1, 1), (11, 1500, 0, 0)`,
  );
}, 300_000);
afterEach(async () => dispose?.());

function brokenD1() {
  const down = () => Promise.reject(new Error('D1_ERROR: database unavailable'));
  const stmt = { bind: () => stmt, first: down, all: down, raw: down, run: down };
  return { prepare: () => stmt, batch: down, exec: down, dump: down } as unknown as AnyD1Database;
}

const items = [{ variantId: 100, qty: 1, weightG: 1200, unitPriceDzd: 14600 }];
const NO = { available: false, feeDzd: null, source: 'table' };

describe('@hb/db/fees createAdminTableFeeProvider', () => {
  test('passes the @hb/shared conformance suite (served 16 and 31; placeholder 9 and unavailable 11 unserved)', async () => {
    const provider = createAdminTableFeeProvider(db);
    const served = { 16: 600, 31: 900 } as const;
    const unserved = Array.from({ length: 69 }, (_, i) => i + 1).filter((c) => !(c in served));
    const failures = await checkFeeProviderConformance(provider, {
      served,
      unserved,
      source: 'table',
      communes: { 16: 1601, 31: 3101 },
      communeIndependent: true,
      itemIndependent: true,
      failing: () => createAdminTableFeeProvider(createDb(brokenD1())),
    });
    expect(failures).toEqual([]);
  }, 120_000);

  test('served, unavailable, missing row, out-of-range codes', async () => {
    const p = createAdminTableFeeProvider(db);
    expect(await p.quote({ wilayaCode: 16, communeId: 1601, items })).toEqual({ available: true, feeDzd: 600, source: 'table' });
    expect(await p.quote({ wilayaCode: 11, items })).toEqual(NO);
    expect(await p.quote({ wilayaCode: 59, items })).toEqual(NO);
    expect(await p.quote({ wilayaCode: 0, items })).toEqual(NO);
    expect(await p.quote({ wilayaCode: 70, items })).toEqual(NO);
  });

  test('placeholder (invented) fees are never served unless explicitly allowed for local dev', async () => {
    expect(await createAdminTableFeeProvider(db).quote({ wilayaCode: 9, items })).toEqual(NO);
    expect(await createAdminTableFeeProvider(db, { allowPlaceholderFees: true }).quote({ wilayaCode: 9, items })).toEqual({ available: true, feeDzd: 700, source: 'table' });
    expect(await createAdminTableFeeProvider(db, { allowPlaceholderFees: true }).quote({ wilayaCode: 11, items })).toEqual(NO);
  });

  test('uncached by default: an admin fee edit applies to the very next quote', async () => {
    const p = createAdminTableFeeProvider(db);
    expect((await p.quote({ wilayaCode: 16, items })).feeDzd).toBe(600);
    await exec(d1, 'update delivery_fees set fee_dzd = 650 where wilaya_code = 16');
    expect((await p.quote({ wilayaCode: 16, items })).feeDzd).toBe(650);
  });

  test('optional cache is bounded by TTL and entries', async () => {
    let t = 0;
    const p = createAdminTableFeeProvider(db, { cache: { ttlMs: 1000, maxEntries: 1, now: () => t } });
    expect((await p.quote({ wilayaCode: 16, items })).feeDzd).toBe(600);
    await exec(d1, 'update delivery_fees set fee_dzd = 650 where wilaya_code = 16');
    expect((await p.quote({ wilayaCode: 16, items })).feeDzd).toBe(600); // cached
    t = 1001;
    expect((await p.quote({ wilayaCode: 16, items })).feeDzd).toBe(650); // expired
    await exec(d1, 'update delivery_fees set fee_dzd = 700 where wilaya_code = 16');
    await p.quote({ wilayaCode: 31, items }); // evicts 16 (max 1 entry)
    expect((await p.quote({ wilayaCode: 16, items })).feeDzd).toBe(700);
  });
});

describe('fee provider read retry (DB-6 r1)', () => {
  /** A D1 stub whose first `failures` reads reject, then answers the fee row [600, available 1, placeholder 0]. */
  function flakyD1(failures: number) {
    let calls = 0;
    const read = () => (++calls <= failures ? Promise.reject(new Error('D1_ERROR: Network connection lost')) : Promise.resolve([[600, 1, 0]]));
    const stmt = { bind: () => stmt, raw: read, all: read, first: read, run: read };
    return { d1: { prepare: () => stmt, batch: read } as unknown as AnyD1Database, calls: () => calls };
  }
  test('one transient D1 failure is retried and the quote succeeds', async () => {
    const f = flakyD1(1);
    expect(await createAdminTableFeeProvider(createDb(f.d1), { retry: { backoffMs: 0 } }).quote({ wilayaCode: 16, items })).toEqual({ available: true, feeDzd: 600, source: 'table' });
    expect(f.calls()).toBe(2);
  });
  test('failing on every attempt rejects (never "no delivery"), after exactly 2 attempts by default', async () => {
    const f = flakyD1(99);
    const err = await createAdminTableFeeProvider(createDb(f.d1), { retry: { backoffMs: 0 } }).quote({ wilayaCode: 16, items }).then(
      () => null,
      (e: unknown) => e as Error & { cause?: Error },
    );
    expect(err?.cause?.message ?? err?.message).toMatch(/Network connection lost/); // Drizzle wraps the driver error
    expect(f.calls()).toBe(2);
  });
  test('retry: { attempts: 1 } disables it', async () => {
    const f = flakyD1(1);
    await expect(createAdminTableFeeProvider(createDb(f.d1), { retry: { attempts: 1 } }).quote({ wilayaCode: 16, items })).rejects.toThrow();
    expect(f.calls()).toBe(1);
  });
});

describe('updateOrderContact', () => {
  const owner = { userId: 1, role: 'owner' as const };
  const confirmer = { userId: 2, role: 'confirmer' as const };
  let provider: FeeProvider;
  let seq = 0;

  async function order(phone = '+213560417403') {
    seq++;
    const lines = [{ variantId: 100, productId: 10, nameFr: 'Pack', nameAr: 'طقم', variantLabelFr: null, variantLabelAr: null, sku: 'PACK', unitPriceDzd: 14600, qty: 2, lineTotalDzd: 29200 }];
    const t = computeTotals(lines, 600);
    const r = await createOrder(db, {
      customer: { phoneE164: phone, name: 'Amine' },
      order: { ref: `HB-${String(seq).padStart(5, '0')}`, idempotencyKey: `k${seq}`, lang: 'fr', wilayaCode: 16, communeId: 1601, subtotalDzd: t.subtotalDzd, feeDzd: 600, totalDzd: t.totalDzd, feeSource: 'table', flags: [], turnstile: 'ok', fillMs: 5000, riskScore: 0, ipHash: null },
      lines,
    });
    return (r as { orderId: number }).orderId;
  }
  beforeEach(() => {
    provider = createAdminTableFeeProvider(db);
  });
  const row = async () => d1.prepare('select o.name, o.phone_e164, o.customer_id, o.wilaya_code, o.commune_id, o.fee_dzd, o.total_dzd, o.subtotal_dzd, o.fee_source, o.version from orders o').first();
  const custs = async () => (await d1.prepare('select id, phone_e164, order_count from customers order by id').all()).results;

  test('phone change (any input form) re-links to a new customer and moves the order count', async () => {
    const id = await order();
    const r = await updateOrderContact(db, id, { phone: '٠٦٦١ ٢٣ ٤٥ ٦٧' }, provider, confirmer, 0);
    expect(r).toMatchObject({ ok: true, version: 1, feeDzd: 600 });
    expect(await custs()).toEqual([
      { id: 1, phone_e164: '+213560417403', order_count: 0 },
      { id: 2, phone_e164: '+213661234567', order_count: 1 },
    ]);
    expect(await row()).toMatchObject({ phone_e164: '+213661234567', customer_id: 2 });
    expect(await d1.prepare("select note from order_events where outcome = 'contact_edit'").first()).toEqual({ note: 'changed: phone' });
  });

  test('phone change to an existing customer increments that customer', async () => {
    const a = await order('+213560417403');
    await order('+213661234567');
    await updateOrderContact(db, a, { phone: '0661234567' }, provider, owner, 0);
    expect(await custs()).toEqual([
      { id: 1, phone_e164: '+213560417403', order_count: 0 },
      { id: 2, phone_e164: '+213661234567', order_count: 2 },
    ]);
  });

  test('a blank or too-short name is refused (name_invalid); a blank address is stored as NULL (DB-6 r1)', async () => {
    const id = await order();
    for (const bad of ['   ', 'A', '١٢٣', '\u200f\u200f']) {
      expect(await updateOrderContact(db, id, { name: bad }, provider, owner, 0), JSON.stringify(bad)).toEqual({ ok: false, code: 'name_invalid' });
    }
    expect(await updateOrderContact(db, id, { name: '  Amine   Benali ', address: '   ' }, provider, owner, 0)).toMatchObject({ ok: true });
    expect(await d1.prepare('select name, address from orders').first()).toEqual({ name: 'Amine Benali', address: null });
  });

  test('a buildQuote refusal other than the ceiling is thrown, not reported as area_unavailable (DB-6 r1)', async () => {
    const id = await order();
    await exec(d1, `update order_items set qty = 11, line_total_dzd = unit_price_dzd * 11, stock_taken = 0 where order_id = ${id}; update orders set subtotal_dzd = 160600, total_dzd = 161200 where id = ${id}`);
    await expect(updateOrderContact(db, id, { wilayaCode: 31, communeId: 3101 }, provider, owner, 0)).rejects.toThrow(/buildQuote refused the stored lines \(out_of_stock\)/);
  });

  test('the owner may still edit a confirmed order', async () => {
    const id = await order();
    await exec(d1, `update orders set status = 'confirmed' where id = ${id}`);
    expect(await updateOrderContact(db, id, { name: 'Amine B.' }, provider, owner, 0)).toMatchObject({ ok: true, version: 1 });
  });

  test('re-pricing over MAX_ORDER_TOTAL_DZD is refused (buildQuote contract), nothing written', async () => {
    const id = await order();
    await exec(d1, 'update delivery_fees set fee_dzd = 9999999 where wilaya_code = 31');
    expect(await updateOrderContact(db, id, { wilayaCode: 31, communeId: 3101 }, provider, owner, 0)).toEqual({ ok: false, code: 'order_total_out_of_range' });
    expect(await row()).toMatchObject({ wilaya_code: 16, fee_dzd: 600, version: 0 });
  });

  test('area change re-quotes the fee; total = subtotal + new fee (computeTotals)', async () => {
    const id = await order();
    const r = await updateOrderContact(db, id, { wilayaCode: 31, communeId: 3101 }, provider, confirmer, 0);
    expect(r).toEqual({ ok: true, version: 1, feeDzd: 900, totalDzd: 29200 + 900, feeSource: 'table' });
    expect(await row()).toMatchObject({ wilaya_code: 31, commune_id: 3101, fee_dzd: 900, total_dzd: 30100, subtotal_dzd: 29200, fee_source: 'table' });
  });

  test('refusals write nothing: bad phone, commune outside wilaya, unserved or placeholder area, wrong role, not editable', async () => {
    const id = await order();
    expect(await updateOrderContact(db, id, { phone: '0512345678' }, provider, owner, 0)).toEqual({ ok: false, code: 'phone_invalid' });
    expect(await updateOrderContact(db, id, { wilayaCode: 16, communeId: 3101 }, provider, owner, 0)).toEqual({ ok: false, code: 'commune_invalid' });
    expect(await updateOrderContact(db, id, { wilayaCode: 11, communeId: 1101 }, provider, owner, 0)).toEqual({ ok: false, code: 'area_unavailable' });
    expect(await updateOrderContact(db, id, { wilayaCode: 9, communeId: 901 }, provider, owner, 0)).toEqual({ ok: false, code: 'area_unavailable' });
    expect(await updateOrderContact(db, id, { name: 'X' }, provider, { userId: 3, role: 'logistics' }, 0)).toEqual({ ok: false, code: 'forbidden' });
    expect(await updateOrderContact(db, id, { name: 'Amine' }, provider, owner, 0)).toEqual({ ok: false, code: 'nothing_to_change' });
    await exec(d1, `update orders set status = 'confirmed' where id = ${id}`);
    // AORD-0 §0.4: the confirmer edits contact data only before confirmation; the owner until shipping.
    expect(await updateOrderContact(db, id, { name: 'X' }, provider, confirmer, 0)).toEqual({ ok: false, code: 'forbidden' });
    await exec(d1, `update orders set status = 'shipped' where id = ${id}`);
    expect(await updateOrderContact(db, id, { name: 'X' }, provider, owner, 0)).toEqual({ ok: false, code: 'not_editable' });
    expect(await row()).toMatchObject({ name: 'Amine', wilaya_code: 16, fee_dzd: 600, version: 0 });
  });

  test('stale or concurrent edits: exactly one applies, counts moved once', async () => {
    const id = await order();
    const [a, b] = await Promise.all([
      updateOrderContact(db, id, { phone: '0661234567' }, provider, owner, 0),
      updateOrderContact(db, id, { phone: '0771234567' }, provider, confirmer, 0),
    ]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect([a, b].find((r) => !r.ok)).toEqual({ ok: false, code: 'version_conflict' });
    const counts = (await custs()) as { order_count: number }[];
    expect(counts.reduce((s, c) => s + c.order_count, 0)).toBe(1);
    expect(await updateOrderContact(db, id, { name: 'Late' }, provider, owner, 0)).toEqual({ ok: false, code: 'version_conflict' });
  });
});
