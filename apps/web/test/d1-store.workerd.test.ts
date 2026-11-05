// The D1 adapter's own reads (idempotency lookup, phone history for dedup/velocity/blocked) and
// the enqueue-failure note, against a real local D1. The DB-4 writes are injected and not used here.
import { vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000, hookTimeout: 90_000 });
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDb } from '@hb/db';
import { createD1OrderStore, DB_WRITES, describeAttempt } from '../src/order/d1-store.ts';
import type { OrderStore } from '../src/order/store.ts';
import { startSeeded, type Started } from './support/harness.ts';

let h: Started;
let store: OrderStore;
const NOW = Date.now();
const MIN = 60_000;
const P1 = '+213555000001';
const P2 = '+213555000002';

async function addOrder(o: { id: number; ref: string; key: string; phone: string; at: number; status?: string; variant: number; lang?: string }) {
  await h.env.DB.batch([
    h.env.DB.prepare(`insert into customers (phone_e164, name) values (?, 'X') on conflict(phone_e164) do nothing`).bind(o.phone),
    h.env.DB.prepare(
      `insert into orders (id, ref, idempotency_key, customer_id, name, phone_e164, wilaya_code, commune_id, lang, status,
         subtotal_dzd, fee_dzd, total_dzd, fee_source, created_at)
       values (?, ?, ?, (select id from customers where phone_e164 = ?), 'X', ?, 16, 1601, ?, ?, 14600, 600, 15200, 'table', ?)`,
    ).bind(o.id, o.ref, o.key, o.phone, o.phone, o.lang ?? 'ar', o.status ?? 'new', o.at),
    h.env.DB.prepare(
      `insert into order_items (order_id, variant_id, product_id, name_fr, name_ar, sku, unit_price_dzd, qty, line_total_dzd)
       values (?, ?, (select product_id from variants where id = ?), 'n', 'n', 's', 14600, 1, 14600)`,
    ).bind(o.id, o.variant, o.variant),
  ]);
}

beforeAll(async () => {
  h = await startSeeded();
  store = createD1OrderStore(createDb(h.env.DB), DB_WRITES);
  await addOrder({ id: 1, ref: 'HB-00001', key: '00000000-0000-4000-8000-000000000001', phone: P1, at: NOW - 10 * MIN, variant: 11, lang: 'fr' });
  await addOrder({ id: 2, ref: 'HB-00002', key: '00000000-0000-4000-8000-000000000002', phone: P1, at: NOW - 40 * MIN, variant: 21 });
  await addOrder({ id: 3, ref: 'HB-00003', key: '00000000-0000-4000-8000-000000000003', phone: P1, at: NOW - 5 * MIN, variant: 21, status: 'cancelled' });
  await addOrder({ id: 4, ref: 'HB-00004', key: '00000000-0000-4000-8000-000000000004', phone: P1, at: NOW - 25 * 60 * MIN, variant: 11 });
  await addOrder({ id: 5, ref: 'HB-00005', key: '00000000-0000-4000-8000-000000000005', phone: P2, at: NOW - 1 * MIN, variant: 11 });
  await h.env.DB.prepare(`update customers set blocked = 1 where phone_e164 = ?`).bind(P2).run();
});
afterAll(async () => {
  await h?.server.close();
});

describe('D1 order store reads', () => {
  test('findByIdempotencyKey returns the stored order for the response body', async () => {
    expect(await store.findByIdempotencyKey('00000000-0000-4000-8000-000000000001')).toEqual({
      id: 1,
      ref: 'HB-00001',
      status: 'new',
      lang: 'fr',
      subtotalDzd: 14600,
      feeDzd: 600,
      totalDzd: 15200,
    });
    expect(await store.findByIdempotencyKey('00000000-0000-4000-8000-0000000000ff')).toBeNull();
    expect((await store.getOrder(2))?.ref).toBe('HB-00002');
  });

  test('dedup: same phone + overlapping variant within 30 min, not cancelled', async () => {
    expect((await store.phoneHistory(P1, [11], NOW)).duplicate?.ref).toBe('HB-00001');
    expect((await store.phoneHistory(P1, [21, 11], NOW)).duplicate?.ref).toBe('HB-00001');
    // Variant 21: order 2 is 40 min old, order 3 is cancelled ⇒ no duplicate.
    expect((await store.phoneHistory(P1, [21], NOW)).duplicate).toBeNull();
    expect((await store.phoneHistory('+213555000099', [11], NOW)).duplicate).toBeNull();
    // 31 min later, order 1 is out of the window.
    expect((await store.phoneHistory(P1, [11], NOW + 21 * MIN)).duplicate).toBeNull();
  });

  test('velocity counts non-cancelled orders of the last 24 h; blocked comes from customers', async () => {
    expect(await store.phoneHistory(P1, [22], NOW)).toEqual({ duplicate: null, ordersLast24h: 2, blocked: false });
    expect(await store.phoneHistory(P2, [22], NOW)).toMatchObject({ ordersLast24h: 1, blocked: true });
    expect(await store.phoneHistory('+213555000099', [22], NOW)).toEqual({ duplicate: null, ordersLast24h: 0, blocked: false });
  });

  test('noteEnqueueFailed appends a system note event, no PII', async () => {
    await store.noteEnqueueFailed(1, NOW);
    const row = await h.env.DB.prepare(`select type, actor_type, note, at from order_events where order_id = 1`).first<{ type: string; actor_type: string; note: string; at: number }>();
    expect(row).toMatchObject({ type: 'note', actor_type: 'system', at: NOW });
    expect(row?.note).not.toMatch(/\+213|555/);
  });

  test('markDuplicate (DB-4) flags the existing order once and notes the attempt without PII', async () => {
    const real = createD1OrderStore(createDb(h.env.DB), DB_WRITES);
    const attempt = { items: [{ variantId: 11, qty: 2 }], wilayaCode: 16, communeId: 1602 };
    await real.markDuplicate(1, attempt, NOW);
    await real.markDuplicate(1, attempt, NOW + 1);
    const o = await h.env.DB.prepare(`select flags from orders where id = 1`).first<{ flags: string }>();
    expect(JSON.parse(o!.flags)).toEqual(['duplicate']);
    const notes = await h.env.DB.prepare(`select note from order_events where order_id = 1 and outcome = 'duplicate_submit'`).all<{ note: string }>();
    expect(notes.results.map((r) => r.note)).toEqual([describeAttempt(attempt), describeAttempt(attempt)]);
    expect(describeAttempt(attempt)).toBe('duplicate submit: items=11x2 wilaya=16 commune=1602');
  });
});
