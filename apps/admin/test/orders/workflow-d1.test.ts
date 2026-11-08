// AORD-2 (high risk) — the confirmation workflow end to end on a real D1 with the real DB-4 writer:
// HTTP → role → form → plan → DB-4 guarded batch + audit row. Oracles are hand-written (AORD-0 §0/§4).
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, customers, orderEvents, orders, variants } from '@hb/db';
import { ADMIN_ROLES, CALL_OUTCOMES, type AdminRole, type CallOutcome, type OrderStatus } from '@hb/shared';
import { toAlgiersInput } from '../../src/lib/time.ts';
import { harness, USERS, type Harness } from '../helpers.ts';
import { dbOf, insertOrder, postAs, refOf, seedGeoAndCatalog, type CatalogFixture } from './fixtures.ts';

// Real D1 (Miniflare) on a shared, loaded host: explicit budgets so the gate does not time out at random.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

let h: Harness;
let cat: CatalogFixture;
let n = 1000;
const NOW = Date.now();
const EMAIL: Record<AdminRole, string> = { owner: USERS.owner, confirmer: USERS.confirmer, logistics: USERS.logistics, content: USERS.content };

beforeAll(async () => {
  h = await harness();
  cat = await seedGeoAndCatalog(dbOf(h.db));
}, 180_000);

afterAll(async () => {
  await h?.close();
});

const db = () => dbOf(h.db);

async function newOrder(status: OrderStatus, over: { items?: readonly (readonly ['A' | 'B', number])[]; flags?: string[]; callAttempts?: number } = {}) {
  const ref = refOf(n++);
  const id = await insertOrder(db(), cat, { ref, createdAt: NOW - n, status, phone: `+2136${String(10_000_000 + n).slice(-8)}`, ...over });
  return { ref, id };
}
const orderRow = async (id: number) => (await db().select().from(orders).where(eq(orders.id, id)))[0]!;
const events = (id: number) => db().select().from(orderEvents).where(eq(orderEvents.orderId, id)).orderBy(orderEvents.id);
const audits = (id: number) => db().select().from(auditLog).where(and(eq(auditLog.entity, 'orders'), eq(auditLog.entityId, String(id))));
const stockOf = async (vid: number) => (await db().select({ s: variants.stock }).from(variants).where(eq(variants.id, vid)))[0]!.s;
const setStock = (vid: number, s: number | null) => db().update(variants).set({ stock: s }).where(eq(variants.id, vid));
const customerOf = async (orderId: number) => {
  const o = await orderRow(orderId);
  return (await db().select().from(customers).where(eq(customers.id, o.customerId)))[0]!;
};
const post = (role: AdminRole | string, ref: string, action: string, data: Record<string, string>) =>
  postAs(h, role in EMAIL ? EMAIL[role as AdminRole] : role, `/orders/${ref}/${action}`, data);

const EXTRA: Partial<Record<CallOutcome, Record<string, string>>> = {
  callback: { callbackAt: toAlgiersInput(NOW + 3 * 3_600_000) },
  cancelled: { reason: 'customer_refused' },
};
/** Hand-written: final status of one call from `new` (streak 0, max 3). */
const FROM_NEW: Record<CallOutcome, OrderStatus> = {
  no_answer: 'called',
  busy: 'called',
  callback: 'called',
  confirmed: 'confirmed',
  cancelled: 'cancelled',
  wrong_number: 'cancelled',
};
const CALLERS: readonly AdminRole[] = ['owner', 'confirmer'];

describe('call outcome × role on D1 (from new)', () => {
  for (const outcome of CALL_OUTCOMES) {
    for (const role of ADMIN_ROLES) {
      test(`${outcome} by ${role}`, async () => {
        const o = await newOrder('new');
        const res = await post(role, o.ref, 'call', { version: '0', outcome, ...EXTRA[outcome] });
        const row = await orderRow(o.id);
        if (!CALLERS.includes(role)) {
          expect(res.status).toBe(403);
          expect(row.status).toBe('new');
          expect(row.version).toBe(0);
          expect(await events(o.id)).toHaveLength(0);
          expect(await audits(o.id)).toHaveLength(0);
          return;
        }
        expect(res.status).toBe(303);
        const expected = FROM_NEW[outcome];
        expect(row.status).toBe(expected);
        expect(row.version).toBe(1);
        expect(row.callAttempts).toBe(1);
        const ev = await events(o.id);
        expect(ev.filter((e) => e.type === 'call_attempt').map((e) => e.outcome)).toEqual([outcome]);
        const hops = ev.filter((e) => e.type === 'status_change').map((e) => [e.fromStatus, e.toStatus]);
        expect(hops[0]).toEqual(['new', 'called']);
        expect(hops.at(-1)![1]).toBe(expected);
        expect(new Set(ev.map((e) => e.at)).size).toBe(1);
        const a = await audits(o.id);
        expect(a).toHaveLength(1);
        expect(a[0]!.action).toBe('order.call');
        expect(a[0]!.after).toMatchObject({ status: expected, outcome });
      });
    }
  }
});

/** Hand-written: manual transitions and who may make them. */
const MANUAL: [OrderStatus, OrderStatus, readonly AdminRole[]][] = [
  ['unreachable', 'cancelled', ['owner', 'confirmer']],
  ['confirmed', 'cancelled', ['owner', 'confirmer']],
  ['confirmed', 'shipped', ['owner', 'logistics']],
  ['shipped', 'delivered', ['owner', 'logistics']],
  ['shipped', 'returned', ['owner', 'logistics']],
];

describe('manual transition × role on D1', () => {
  for (const [from, to, allowed] of MANUAL) {
    for (const role of ADMIN_ROLES) {
      test(`${from} → ${to} by ${role}`, async () => {
        const o = await newOrder(from);
        const res = await post(role, o.ref, 'transition', {
          version: '0',
          to,
          reason: from === 'unreachable' ? 'unreachable' : 'customer_refused',
          courierName: 'Yalidine',
          courierTracking: 'YAL-1',
        });
        const row = await orderRow(o.id);
        if (!allowed.includes(role)) {
          expect(res.status).toBe(403);
          expect(row.status).toBe(from);
          expect(row.version).toBe(0);
          expect(await events(o.id)).toHaveLength(0);
          expect(await audits(o.id)).toHaveLength(0);
          return;
        }
        expect(res.status).toBe(303);
        expect(row.status).toBe(to);
        expect(row.version).toBe(1);
        expect((await events(o.id)).map((e) => [e.type, e.fromStatus, e.toStatus])).toEqual([['status_change', from, to]]);
        expect(await audits(o.id)).toHaveLength(1);
        if (to === 'shipped') expect([row.courierName, row.courierTracking]).toEqual(['Yalidine', 'YAL-1']);
      });
    }
  }
  test('every other status pair is refused for the owner with nothing written', async () => {
    for (const [from, to] of [['new', 'confirmed'], ['called', 'confirmed'], ['delivered', 'returned'], ['cancelled', 'new'], ['returned', 'shipped']] as const) {
      const o = await newOrder(from);
      const res = await post('owner', o.ref, 'transition', { version: '0', to, reason: 'other', courierName: 'x' });
      expect(res.status, `${from}→${to}`).toBe(409);
      expect((await orderRow(o.id)).version).toBe(0);
      expect(await events(o.id)).toHaveLength(0);
      expect(await audits(o.id)).toHaveLength(0);
    }
  });
});

describe('optimistic concurrency', () => {
  test('stale version → 409, nothing written', async () => {
    const o = await newOrder('called');
    expect((await post('confirmer', o.ref, 'call', { version: '0', outcome: 'busy' })).status).toBe(303);
    const res = await post('confirmer', o.ref, 'call', { version: '0', outcome: 'no_answer' });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('Commande modifiée entre-temps');
    expect((await orderRow(o.id)).version).toBe(1);
    expect((await events(o.id)).filter((e) => e.type === 'call_attempt')).toHaveLength(1);
    expect(await audits(o.id)).toHaveLength(1);
  });
  test('two confirmers submit at once on the same version: one wins, one 409, one set of rows', async () => {
    const o = await newOrder('called');
    const [x, y] = await Promise.all([
      post('confirmer', o.ref, 'call', { version: '0', outcome: 'confirmed' }),
      post('owner', o.ref, 'call', { version: '0', outcome: 'cancelled', reason: 'customer_refused' }),
    ]);
    expect([x.status, y.status].sort()).toEqual([303, 409]);
    const row = await orderRow(o.id);
    expect(row.version).toBe(1);
    expect((await events(o.id)).filter((e) => e.type === 'call_attempt')).toHaveLength(1);
    expect(await audits(o.id)).toHaveLength(1);
  });
});

describe('stock restore (exactly once)', () => {
  test('cancel during a call restores tracked stock once; a replay changes nothing', async () => {
    await setStock(cat.variantA, 8); // as after createOrder decremented 2
    const o = await newOrder('called', { items: [['A', 2], ['B', 1]] });
    await setStock(cat.variantB, null);
    expect((await post('confirmer', o.ref, 'call', { version: '0', outcome: 'cancelled', reason: 'out_of_stock' })).status).toBe(303);
    expect(await stockOf(cat.variantA)).toBe(10);
    expect(await stockOf(cat.variantB)).toBeNull();
    const row = await orderRow(o.id);
    expect(row.status).toBe('cancelled');
    expect(row.stockRestoredAt).not.toBeNull();
    expect((await customerOf(o.id)).cancelledCount).toBe(1);
    const ev = await events(o.id);
    expect(ev.find((e) => e.toStatus === 'cancelled')!.outcome).toBe('out_of_stock');
    // Replay with the old version, and a fresh-version attempt on a terminal order.
    expect((await post('confirmer', o.ref, 'call', { version: '0', outcome: 'cancelled', reason: 'out_of_stock' })).status).toBe(409);
    expect((await post('owner', o.ref, 'transition', { version: '1', to: 'cancelled', reason: 'other' })).status).toBe(409);
    expect(await stockOf(cat.variantA)).toBe(10);
    expect((await customerOf(o.id)).cancelledCount).toBe(1);
  });
  test('wrong number cancels with reason wrong_number and restores stock', async () => {
    await setStock(cat.variantA, 5);
    const o = await newOrder('new', { items: [['A', 1]] });
    expect((await post('confirmer', o.ref, 'call', { version: '0', outcome: 'wrong_number' })).status).toBe(303);
    expect(await stockOf(cat.variantA)).toBe(6);
    expect((await events(o.id)).find((e) => e.toStatus === 'cancelled')!.outcome).toBe('wrong_number');
  });
  test('confirmed → cancelled and unreachable → cancelled restore stock', async () => {
    await setStock(cat.variantA, 0);
    const c1 = await newOrder('confirmed', { items: [['A', 1]] });
    const c2 = await newOrder('unreachable', { items: [['A', 3]] });
    expect((await post('confirmer', c1.ref, 'transition', { version: '0', to: 'cancelled', reason: 'customer_refused' })).status).toBe(303);
    expect((await post('confirmer', c2.ref, 'transition', { version: '0', to: 'cancelled', reason: 'unreachable' })).status).toBe(303);
    expect(await stockOf(cat.variantA)).toBe(4);
  });
  test('returned restores stock and counts; delivered counts and restores nothing', async () => {
    await setStock(cat.variantA, 2);
    const r = await newOrder('shipped', { items: [['A', 1]] });
    const d = await newOrder('shipped', { items: [['A', 1]] });
    expect((await post('logistics', r.ref, 'transition', { version: '0', to: 'returned' })).status).toBe(303);
    expect((await post('logistics', d.ref, 'transition', { version: '0', to: 'delivered' })).status).toBe(303);
    expect(await stockOf(cat.variantA)).toBe(3);
    expect((await customerOf(r.id)).returnedCount).toBe(1);
    expect((await customerOf(d.id)).deliveredCount).toBe(1);
    expect((await orderRow(d.id)).stockRestoredAt).toBeNull();
  });
});

describe('call details on D1', () => {
  test('three unanswered calls in a row → unreachable, retry scheduled 4 h later', async () => {
    const o = await newOrder('new');
    for (let v = 0; v < 3; v++) {
      expect((await post('confirmer', o.ref, 'call', { version: String(v), outcome: v === 1 ? 'busy' : 'no_answer' })).status).toBe(303);
    }
    const row = await orderRow(o.id);
    expect(row.status).toBe('unreachable');
    expect(row.callAttempts).toBe(3);
    expect(row.nextCallAt! - Date.now()).toBeGreaterThan(239 * 60_000);
  });
  test('confirm stores the address and clears the next call and the claim', async () => {
    const o = await newOrder('called');
    await db().update(orders).set({ nextCallAt: NOW, claimedByUserId: 2, claimedUntil: NOW + 600_000 }).where(eq(orders.id, o.id));
    expect((await post('confirmer', o.ref, 'call', { version: '0', outcome: 'confirmed', address: 'Lot 12, Bab Ezzouar' })).status).toBe(303);
    const row = await orderRow(o.id);
    expect([row.status, row.address, row.nextCallAt, row.claimedByUserId, row.claimedUntil]).toEqual(['confirmed', 'Lot 12, Bab Ezzouar', null, null, null]);
  });
  test('confirming a flagged order needs the box; with it the audit says flags were checked', async () => {
    const o = await newOrder('called', { flags: ['turnstile_missing'] });
    expect((await post('confirmer', o.ref, 'call', { version: '0', outcome: 'confirmed' })).status).toBe(422);
    expect((await orderRow(o.id)).version).toBe(0);
    expect((await post('confirmer', o.ref, 'call', { version: '0', outcome: 'confirmed', flagsChecked: '1' })).status).toBe(303);
    expect((await audits(o.id))[0]!.after).toMatchObject({ flagsChecked: true });
  });
  test('note: one note event, version bumped, audited; text stored verbatim', async () => {
    const o = await newOrder('shipped');
    expect((await post('logistics', o.ref, 'note', { version: '0', text: 'Livreur : client absent' })).status).toBe(303);
    const ev = await events(o.id);
    expect(ev.map((e) => [e.type, e.note, e.actorUserId])).toEqual([['note', 'Livreur : client absent', 3]]);
    expect((await orderRow(o.id)).version).toBe(1);
    expect((await audits(o.id))[0]!.action).toBe('order.note');
  });
  test('order_events stay append-only (DB-2 trigger)', async () => {
    const o = await newOrder('shipped');
    await post('logistics', o.ref, 'note', { version: '0', text: 'x' });
    await expect(db().update(orderEvents).set({ note: 'y' }).where(eq(orderEvents.orderId, o.id))).rejects.toThrow();
    await expect(db().delete(orderEvents).where(eq(orderEvents.orderId, o.id))).rejects.toThrow();
  });
});
