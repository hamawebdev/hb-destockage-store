// DB-4 on real D1 (workerd via getPlatformProxy): createOrder, replay, dedup, order changes.
// Lead guards: precise error mapping (each mapping tested + an unexpected error), ref collisions
// retried inside createOrder (forced collision), replay after commit, last-unit race, NULL stock.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// workerd D1 per test: generous timeout on a loaded shared machine.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import { sql } from 'drizzle-orm';
import { computeTotals } from '@hb/shared';
import {
  applyOrderChange,
  classifyConstraintError,
  createOrder,
  findRecentDuplicate,
  markDuplicate,
  guardedInsertSelect,
  orderGuard,
  recentDuplicateQuery,
  transitionOrder,
  type CreateOrderInput,
  type OrderLineInput,
} from '../src/orders.ts';
import { auditLog, orders, type Db } from '../src/index.ts';
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
     insert into products (id, category_id, slug_fr, slug_ar, name_fr, name_ar, status) values (10, 1, 'p', 'p-ar', 'Pack', 'طقم', 'active'), (20, 1, 'q', 'q-ar', 'Mitigeur', 'خلاط', 'active');
     insert into variants (id, product_id, sku, price_dzd, stock, is_default) values (100, 10, 'PACK', 14600, 5, 1), (101, 20, 'MIT', 3200, 1, 1);
     insert into variants (id, product_id, sku, price_dzd, stock) values (102, 20, 'MIT-NULL', 3000, null);
     insert into wilayas (code, name_fr, name_ar) values (16, 'Alger', 'الجزائر'), (31, 'Oran', 'وهران');
     insert into communes (id, wilaya_code, name_fr, name_ar) values (1601, 16, 'Alger Centre', 'الجزائر الوسطى'), (3101, 31, 'Oran', 'وهران')`,
  );
}, 60_000);
afterEach(async () => dispose?.());

const line = (variantId: number, qty: number, unit = variantId === 100 ? 14600 : variantId === 101 ? 3200 : 3000): OrderLineInput => ({
  variantId,
  productId: variantId === 100 ? 10 : 20,
  nameFr: 'n',
  nameAr: 'ن',
  variantLabelFr: null,
  variantLabelAr: null,
  sku: variantId === 100 ? 'PACK' : variantId === 101 ? 'MIT' : 'MIT-NULL',
  unitPriceDzd: unit,
  qty,
  lineTotalDzd: unit * qty,
});

let seq = 0;
function input(lines: OrderLineInput[], over: Partial<{ key: string; ref: string; phone: string; feeDzd: number; communeId: number; wilayaCode: number }> = {}): CreateOrderInput {
  seq++;
  const fee = over.feeDzd ?? 400;
  const t = computeTotals(lines, fee);
  return {
    customer: { phoneE164: over.phone ?? '+213560417403', name: 'Amine' },
    order: {
      ref: over.ref ?? `HB-${String(seq).padStart(5, '0')}`,
      idempotencyKey: over.key ?? `key-${seq}`,
      lang: 'ar',
      wilayaCode: over.wilayaCode ?? 16,
      communeId: over.communeId ?? 1601,
      subtotalDzd: t.subtotalDzd,
      feeDzd: fee,
      totalDzd: t.totalDzd,
      feeSource: 'table',
      flags: [],
      turnstile: 'ok',
      fillMs: 9000,
      riskScore: 0,
      ipHash: 'abc',
    },
    lines,
  };
}

const count = async (table: string, where = '1=1') => (await d1.prepare(`select count(*) n from ${table} where ${where}`).first<{ n: number }>())!.n;
const stock = async (id: number) => (await d1.prepare('select stock from variants where id = ?').bind(id).first<{ stock: number | null }>())!.stock;

describe('createOrder', () => {
  test('writes customer, order, items, stock and a created event; totals exactly as computeTotals', async () => {
    const inp = input([line(100, 2), line(102, 1)], { feeDzd: 600 });
    const r = await createOrder(db, inp);
    expect(r).toMatchObject({ ok: true, replayed: false, ref: inp.order.ref });
    const o = await d1.prepare('select * from orders').first<Record<string, unknown>>();
    const t = computeTotals(inp.lines, 600);
    expect(o).toMatchObject({ status: 'new', version: 0, subtotal_dzd: t.subtotalDzd, fee_dzd: 600, total_dzd: t.totalDzd, flags: '[]', fee_source: 'table' });
    const items = (await d1.prepare('select variant_id, unit_price_dzd, qty, line_total_dzd from order_items order by id').all()).results;
    expect(items).toEqual(t.lines.map((l) => ({ variant_id: l.variantId, unit_price_dzd: l.unitPriceDzd, qty: l.qty, line_total_dzd: l.lineTotalDzd })));
    expect(await stock(100)).toBe(3);
    expect(await d1.prepare("select type, to_status, actor_type from order_events").first()).toEqual({ type: 'created', to_status: 'new', actor_type: 'customer' });
    expect(await d1.prepare('select order_count, name from customers').first()).toEqual({ order_count: 1, name: 'Amine' });
  });

  test('customer upsert increments order_count and never touches blocked/notes/flags', async () => {
    await exec(d1, `insert into customers (phone_e164, name, blocked, notes, flags, order_count) values ('+213560417403', 'Old', 1, 'note', '["frequent_returns"]', 4)`);
    await createOrder(db, input([line(100, 1)]));
    expect(await d1.prepare('select name, blocked, notes, flags, order_count from customers').first()).toEqual({ name: 'Amine', blocked: 1, notes: 'note', flags: '["frequent_returns"]', order_count: 5 });
  });

  test('NULL stock is orderable and never decremented', async () => {
    const r = await createOrder(db, input([line(102, 10)]));
    expect(r.ok).toBe(true);
    expect(await stock(102)).toBeNull();
  });

  test('replay after commit returns the original order (same id and ref), stock decremented once', async () => {
    const first = await createOrder(db, input([line(100, 1)], { key: 'same' }));
    const again = await createOrder(db, input([line(100, 1)], { key: 'same' })); // new ref, same key
    expect(again).toEqual({ ok: true, orderId: (first as { orderId: number }).orderId, ref: (first as { ref: string }).ref, replayed: true });
    expect(await count('orders')).toBe(1);
    expect(await stock(100)).toBe(4);
    expect(await d1.prepare('select order_count from customers').first()).toEqual({ order_count: 1 });
  });

  test('20 concurrent submits with one key: one row, every caller gets the same ref', async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, () => createOrder(db, input([line(100, 1)], { key: 'burst' }))));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(new Set(rs.map((r) => (r as { ref: string }).ref)).size).toBe(1);
    expect(rs.filter((r) => !(r as { replayed: boolean }).replayed)).toHaveLength(1);
    expect(await count('orders')).toBe(1);
    expect(await stock(100)).toBe(4);
  });

  test('last unit, 2 concurrent orders from different phones: exactly one wins', async () => {
    const [a, b] = await Promise.all([
      createOrder(db, input([line(101, 1)], { phone: '+213560417403' })),
      createOrder(db, input([line(101, 1)], { phone: '+213661234567' })),
    ]);
    const wins = [a, b].filter((r) => r.ok);
    expect(wins).toHaveLength(1);
    expect([a, b].find((r) => !r.ok)).toEqual({ ok: false, reason: 'out_of_stock', variantIds: [101] });
    expect(await stock(101)).toBe(0);
    expect(await count('order_items', 'variant_id = 101')).toBe(1);
    expect(await count('orders')).toBe(1);
  });

  test('last unit, 20 concurrent orders: one order, stock 0 (never -1)', async () => {
    const phones = Array.from({ length: 20 }, (_, i) => `+21366${String(1000000 + i).padStart(7, '0')}`);
    const rs = await Promise.all(phones.map((phone) => createOrder(db, input([line(101, 1)], { phone }))));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.filter((r) => !r.ok).every((r) => (r as { reason: string }).reason === 'out_of_stock')).toBe(true);
    expect(await stock(101)).toBe(0);
    expect(await count('orders')).toBe(1);
    expect(await count('customers')).toBe(1); // losers' customer upserts rolled back too
  });

  test('two lines of the same variant: the combined quantity is enforced', async () => {
    const r = await createOrder(db, input([line(100, 3), line(100, 3)]));
    expect(r).toEqual({ ok: false, reason: 'out_of_stock', variantIds: [100] });
    expect(await stock(100)).toBe(5);
    expect(await count('orders')).toBe(0);
  });

  test('forced ref collision is retried inside createOrder with a new ref', async () => {
    await createOrder(db, input([line(100, 1)], { ref: 'HB-AAAAA' }));
    const r = await createOrder(db, input([line(100, 1)], { ref: 'HB-AAAAA' }), { newRef: () => 'HB-BBBBB' });
    expect(r).toMatchObject({ ok: true, ref: 'HB-BBBBB', replayed: false });
    expect(await count('orders')).toBe(2);
    expect(await stock(100)).toBe(3);
  });

  test('ref collisions on every attempt: ref_collision after the bounded attempts, nothing written', async () => {
    await createOrder(db, input([line(100, 1)], { ref: 'HB-AAAAA' }));
    let calls = 0;
    const r = await createOrder(db, input([line(100, 1)], { ref: 'HB-AAAAA' }), { newRef: () => (calls++, 'HB-AAAAA'), maxRefAttempts: 3 });
    expect(r).toEqual({ ok: false, reason: 'ref_collision' });
    expect(calls).toBe(2);
    expect(await count('orders')).toBe(1);
    expect(await stock(100)).toBe(4);
  });

  test('unexpected error (commune not in wilaya) is thrown, never mapped; nothing written', async () => {
    await expect(createOrder(db, input([line(100, 1)], { communeId: 3101, wilayaCode: 16 }))).rejects.toThrow(/commune_id is not in orders.wilaya_code/);
    expect(await count('orders')).toBe(0);
    expect(await count('customers')).toBe(0);
    expect(await stock(100)).toBe(5);
  });

  test('unexpected error (unknown variant FK) is thrown, not out_of_stock', async () => {
    await expect(createOrder(db, input([{ ...line(100, 1), variantId: 999 }]))).rejects.toThrow(/FOREIGN KEY/);
    expect(await count('orders')).toBe(0);
  });

  test('totals that differ from computeTotals throw before any I/O', async () => {
    const bad = input([line(100, 1)]);
    await expect(createOrder(db, { ...bad, order: { ...bad.order, totalDzd: bad.order.totalDzd + 1 } })).rejects.toThrow(TypeError);
    await expect(createOrder(db, { ...bad, lines: [{ ...bad.lines[0]!, lineTotalDzd: 1 }] })).rejects.toThrow(TypeError);
    await expect(createOrder(db, { ...bad, order: { ...bad.order, flags: ['nope' as 'duplicate'] } })).rejects.toThrow(TypeError);
    expect(await count('orders')).toBe(0);
  });
});

describe('classifyConstraintError (precise mapping)', () => {
  const wrap = (msg: string) => Object.assign(new Error('Failed query: insert into orders ... orders.ref ... variants_stock_nonneg'), { cause: new Error(msg) });
  test.each([
    ['D1_ERROR: UNIQUE constraint failed: orders.idempotency_key: SQLITE_CONSTRAINT', 'idempotency_key'],
    ['UNIQUE constraint failed: orders.ref', 'ref'],
    ['D1_ERROR: CHECK constraint failed: variants_stock_nonneg: SQLITE_CONSTRAINT', 'stock'],
    ['UNIQUE constraint failed: orders.reference', null],
    ['UNIQUE constraint failed: orders.idempotency_key_v2', null],
    ['CHECK constraint failed: variants_stock_nonneg_extra', null],
    ['CHECK constraint failed: variants_price_nonneg', null],
    ['FOREIGN KEY constraint failed', null],
    ['UNIQUE constraint failed: customers.phone_e164', null],
  ])('%s → %s', (msg, want) => {
    expect(classifyConstraintError(wrap(msg))).toBe(want);
  });
  test("Drizzle's wrapper text alone (SQL that mentions orders.ref) is not a match", () => {
    expect(classifyConstraintError(new Error('Failed query: UNIQUE constraint failed: orders.ref'))).toBeNull();
    expect(classifyConstraintError('UNIQUE constraint failed: orders.ref')).toBeNull();
  });
});

describe('dedup', () => {
  test('same phone + overlapping variant within 30 min is found; otherwise not', async () => {
    const now = Date.now();
    const r = await createOrder(db, { ...input([line(100, 1), line(102, 1)]), now });
    const id = (r as { orderId: number }).orderId;
    expect(await findRecentDuplicate(db, { phoneE164: '+213560417403', variantIds: [102], now: now + 60_000 })).toMatchObject({ id });
    expect(await findRecentDuplicate(db, { phoneE164: '+213560417403', variantIds: [101], now })).toBeNull();
    expect(await findRecentDuplicate(db, { phoneE164: '+213661234567', variantIds: [100], now })).toBeNull();
    expect(await findRecentDuplicate(db, { phoneE164: '+213560417403', variantIds: [100], now: now + 31 * 60_000 })).toBeNull();
    await exec(d1, `update orders set status = 'cancelled' where id = ${id}`);
    expect(await findRecentDuplicate(db, { phoneE164: '+213560417403', variantIds: [100], now })).toBeNull();
  });

  test('recentDuplicateQuery is batch-safe (web folds it into its read batch)', async () => {
    const now = Date.now();
    const r = await createOrder(db, { ...input([line(100, 1)]), now });
    const [dup, fee] = await db.batch([
      recentDuplicateQuery(db, { phoneE164: '+213560417403', variantIds: [100], now }),
      db.select().from(orders).where(sql`1 = 0`),
    ]);
    expect(dup).toEqual([{ id: (r as { orderId: number }).orderId, ref: (r as { ref: string }).ref, version: 0 }]);
    expect(fee).toEqual([]);
  });

  test('markDuplicate adds the flag once, logs a note, bumps version', async () => {
    const r = await createOrder(db, input([line(100, 1)]));
    const id = (r as { orderId: number }).orderId;
    await markDuplicate(db, id, 'second submit: qty 1, wilaya 16');
    await markDuplicate(db, id, 'third submit');
    expect(await d1.prepare('select flags, version from orders').first()).toEqual({ flags: '["duplicate"]', version: 2 });
    expect(await count('order_events', "type = 'note'")).toBe(2);
  });
});

describe('order changes (version-guarded, composable)', () => {
  async function newOrder(lines = [line(100, 2), line(102, 1)]) {
    const r = await createOrder(db, input(lines));
    return (r as { orderId: number }).orderId;
  }
  const confirmer = { userId: 2, role: 'confirmer' as const };
  const logistics = { userId: 3, role: 'logistics' as const };
  const owner = { userId: 1, role: 'owner' as const };

  test('legal hop by an allowed role: status, version, event', async () => {
    const id = await newOrder();
    expect(await transitionOrder(db, id, 'called', confirmer, null, 0)).toEqual({ ok: true, version: 1, status: 'called' });
    expect(await d1.prepare("select from_status, to_status, actor_type, actor_user_id from order_events where type = 'status_change'").first()).toEqual({
      from_status: 'new',
      to_status: 'called',
      actor_type: 'admin',
      actor_user_id: 2,
    });
  });

  test('illegal hop and wrong role are refused with no writes', async () => {
    const id = await newOrder();
    expect(await transitionOrder(db, id, 'shipped', owner, null, 0)).toEqual({ ok: false, code: 'illegal_transition' });
    expect(await transitionOrder(db, id, 'called', logistics, null, 0)).toEqual({ ok: false, code: 'forbidden' });
    expect(await d1.prepare('select status, version from orders').first()).toEqual({ status: 'new', version: 0 });
    expect(await count('order_events')).toBe(1);
  });

  test('stale version: version_conflict and zero rows changed anywhere (incl. extra items)', async () => {
    const id = await newOrder();
    await transitionOrder(db, id, 'called', confirmer, null, 0);
    const extra = [guardedInsertSelect(db, auditLog, { actor_type: 'admin', actor_user_id: 2, action: 'order.transition', entity: 'orders', entity_id: String(id), at: Date.now() }, sql`WHERE ${orderGuard(id, 0)}`)];
    expect(await applyOrderChange(db, { orderId: id, expectedVersion: 0, actor: confirmer, hops: [['called', 'cancelled']] }, extra)).toEqual({ ok: false, code: 'version_conflict' });
    expect(await count('audit_log')).toBe(0);
    expect(await stock(100)).toBe(3);
  });

  test('a concurrent change between read and batch writes nothing (guard inside the batch)', async () => {
    const id = await newOrder();
    await transitionOrder(db, id, 'called', confirmer, null, 0);
    // Two admins cancel at once from version 1: exactly one applies, stock restored once.
    const [a, b] = await Promise.all([
      transitionOrder(db, id, 'cancelled', confirmer, 'customer_refused', 1),
      transitionOrder(db, id, 'cancelled', owner, 'customer_refused', 1),
    ]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect(await stock(100)).toBe(5);
    expect(await count('order_events', "to_status = 'cancelled'")).toBe(1);
    expect(await d1.prepare('select cancelled_count from customers').first()).toEqual({ cancelled_count: 1 });
  });

  test('cancel restores tracked stock once, NULL stays NULL, sets stock_restored_at; terminal afterwards', async () => {
    const id = await newOrder();
    await transitionOrder(db, id, 'called', confirmer, null, 0);
    expect(await stock(100)).toBe(3);
    const r = await transitionOrder(db, id, 'cancelled', confirmer, 'customer_refused', 1);
    expect(r).toEqual({ ok: true, version: 2, status: 'cancelled' });
    expect(await stock(100)).toBe(5);
    expect(await stock(102)).toBeNull();
    expect((await d1.prepare('select stock_restored_at from orders').first<{ stock_restored_at: number | null }>())!.stock_restored_at).not.toBeNull();
    expect(await transitionOrder(db, id, 'cancelled', owner, null, 2)).toEqual({ ok: false, code: 'illegal_transition' });
    expect(await stock(100)).toBe(5);
  });

  test('shipped → returned restores stock and counts the return; delivered counts delivery', async () => {
    const a = await newOrder([line(100, 1)]);
    const b = await newOrder([line(100, 1)]);
    for (const id of [a, b]) {
      await applyOrderChange(db, { orderId: id, expectedVersion: 0, actor: confirmer, hops: [['new', 'called'], ['called', 'confirmed']] });
      await transitionOrder(db, id, 'shipped', logistics, null, 1);
    }
    expect(await stock(100)).toBe(3);
    await transitionOrder(db, a, 'returned', logistics, null, 2);
    await transitionOrder(db, b, 'delivered', logistics, null, 2);
    expect(await stock(100)).toBe(4);
    expect(await d1.prepare('select returned_count, delivered_count from customers').first()).toEqual({ returned_count: 1, delivered_count: 1 });
  });

  test('call attempt without status change: call_attempts + 1, one event, claim cleared, patch applied', async () => {
    const id = await newOrder();
    await transitionOrder(db, id, 'called', confirmer, null, 0);
    await exec(d1, `update orders set claimed_by_user_id = 2, claimed_until = 9999999999999, version = version where id = ${id}`);
    const v = (await d1.prepare('select version from orders').first<{ version: number }>())!.version;
    const r = await applyOrderChange(db, { orderId: id, expectedVersion: v, actor: confirmer, callAttempt: { outcome: 'no_answer' }, patch: { nextCallAt: 123, address: null } });
    expect(r).toEqual({ ok: true, version: v + 1, status: 'called' });
    expect(await d1.prepare('select call_attempts, claimed_by_user_id, claimed_until, next_call_at, address from orders').first()).toEqual({
      call_attempts: 1,
      claimed_by_user_id: null,
      claimed_until: null,
      next_call_at: 123,
      address: null,
    });
    expect(await count('order_events', "type = 'call_attempt' and outcome = 'no_answer'")).toBe(1);
  });

  test('call attempt on a non-callable order or by logistics is refused', async () => {
    const id = await newOrder();
    expect(await applyOrderChange(db, { orderId: id, expectedVersion: 0, actor: logistics, callAttempt: { outcome: 'busy' } })).toEqual({ ok: false, code: 'forbidden' });
    await applyOrderChange(db, { orderId: id, expectedVersion: 0, actor: confirmer, hops: [['new', 'called'], ['called', 'confirmed']] });
    expect(await applyOrderChange(db, { orderId: id, expectedVersion: 1, actor: confirmer, callAttempt: { outcome: 'busy' } })).toEqual({ ok: false, code: 'not_callable' });
  });

  test('a raw db.run() extra item is the drizzle 0.45 D1 trap: documented, builders required', async () => {
    const id = await newOrder();
    const raw = db.run(sql`INSERT INTO audit_log (actor_type, action, entity) SELECT 'admin', 'x', ${'orders'} WHERE ${orderGuard(id, 0)}`);
    await expect(transitionOrder(db, id, 'called', confirmer, null, 0, [raw])).rejects.toThrow(/reading 'bind'/);
    expect(await d1.prepare('select status, version from orders').first()).toEqual({ status: 'new', version: 0 });
  });

  // DB-4 r1 (rev-d Important): restore exactly what was taken, only while the variant is tracked.
  test('stock_taken records qty for tracked lines and 0 for untracked lines', async () => {
    await newOrder([line(100, 2), line(102, 3)]);
    expect((await d1.prepare('select variant_id, qty, stock_taken from order_items order by variant_id').all()).results).toEqual([
      { variant_id: 100, qty: 2, stock_taken: 2 },
      { variant_id: 102, qty: 3, stock_taken: 0 },
    ]);
  });

  test('untracked at order time, tracked later, then cancelled: stock unchanged (nothing was taken)', async () => {
    const id = await newOrder([line(102, 3)]);
    await exec(d1, 'update variants set stock = 5 where id = 102');
    await transitionOrder(db, id, 'called', confirmer, null, 0);
    expect((await transitionOrder(db, id, 'cancelled', confirmer, 'customer_refused', 1)).ok).toBe(true);
    expect(await stock(102)).toBe(5);
  });

  test('tracked at order time, untracked later, then cancelled: stays untracked (NULL), nothing restored', async () => {
    const id = await newOrder([line(100, 2)]);
    await exec(d1, 'update variants set stock = null where id = 100');
    await transitionOrder(db, id, 'called', confirmer, null, 0);
    expect((await transitionOrder(db, id, 'cancelled', confirmer, null, 1)).ok).toBe(true);
    expect(await stock(100)).toBeNull();
  });

  test('tracked at order time, stock edited since, then returned: adds back exactly the qty taken', async () => {
    const id = await newOrder([line(100, 2), line(100, 1), line(102, 4)]);
    expect(await stock(100)).toBe(2);
    await exec(d1, 'update variants set stock = 10 where id = 100; update variants set stock = 7 where id = 102');
    await applyOrderChange(db, { orderId: id, expectedVersion: 0, actor: confirmer, hops: [['new', 'called'], ['called', 'confirmed']] });
    await transitionOrder(db, id, 'shipped', logistics, null, 1);
    await transitionOrder(db, id, 'returned', logistics, null, 2);
    expect(await stock(100)).toBe(13); // 10 + (2 + 1) taken
    expect(await stock(102)).toBe(7); // untracked at order time: nothing taken, nothing added
  });

  test('extra items run in the same batch on success', async () => {
    const id = await newOrder();
    const extra = [guardedInsertSelect(db, auditLog, { actor_type: 'admin', actor_user_id: 2, action: 'order.transition', entity: 'orders', entity_id: String(id), at: Date.now() }, sql`WHERE ${orderGuard(id, 0)}`)];
    expect((await transitionOrder(db, id, 'called', confirmer, null, 0, extra)).ok).toBe(true);
    expect(await count('audit_log')).toBe(1);
  });

  test('unknown order: not_found', async () => {
    expect(await transitionOrder(db, 999, 'called', confirmer, null, 0)).toEqual({ ok: false, code: 'not_found' });
  });
});
