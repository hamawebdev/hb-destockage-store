// AORD-2 — call claims over a real D1: soft lock, one claim per user, audit row exactly when the
// change happens, version never bumped.
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, orders } from '@hb/db';
import { harness, USERS, type Harness } from '../helpers.ts';
import { dbOf, insertOrder, postAs, refOf, seedGeoAndCatalog } from './fixtures.ts';

// Real D1 (Miniflare) on a shared, loaded host: explicit budgets so the gate does not time out at random.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

let h: Harness;
const NOW = Date.now();
const U = { owner: 1, confirmer: 2 } as const;
const R = { a: refOf(21), b: refOf(22), c: refOf(23), confirmed: refOf(24), race: refOf(25), expired: refOf(26) };
const id: Record<keyof typeof R, number> = {} as never;

beforeAll(async () => {
  h = await harness();
  const db = dbOf(h.db);
  const cat = await seedGeoAndCatalog(db);
  let i = 0;
  for (const [k, ref] of Object.entries(R) as [keyof typeof R, string][]) {
    id[k] = await insertOrder(db, cat, { ref, createdAt: NOW - 1_000_000 + i++, status: k === 'confirmed' ? 'confirmed' : 'new', phone: `+21377000010${i}` });
  }
  // Someone else's claim that ran out a minute ago.
  await db.update(orders).set({ claimedByUserId: U.owner, claimedUntil: NOW - 60_000 }).where(eq(orders.id, id.expired));
}, 180_000);

afterAll(async () => {
  await h?.close();
});

const db = () => dbOf(h.db);
const row = async (orderId: number) => (await db().select().from(orders).where(eq(orders.id, orderId)))[0]!;
const audits = async (orderId: number, action: string) =>
  db().select().from(auditLog).where(and(eq(auditLog.entityId, String(orderId)), eq(auditLog.action, action)));
const post = (email: string, ref: string, action: 'claim' | 'release') => postAs(h, email, `/orders/${ref}/${action}`);

describe('claim', () => {
  test('confirmer claims a new order: 303, 10 min lock, version unchanged, one audit row', async () => {
    const before = await row(id.a);
    const res = await post(USERS.confirmer, R.a, 'claim');
    expect(res.status).toBe(303);
    const after = await row(id.a);
    expect(after.claimedByUserId).toBe(U.confirmer);
    expect(after.claimedUntil! - Date.now()).toBeGreaterThan(9 * 60_000);
    expect(after.version).toBe(before.version);
    expect(await audits(id.a, 'order.claim')).toHaveLength(1);
  });
  test('the detail page shows the claim to its holder and to others', async () => {
    expect(await (await h.as(USERS.confirmer, `/orders/${R.a}`)).text()).toContain('Vous appelez cette commande');
    expect(await (await h.as(USERS.owner, `/orders/${R.a}`)).text()).toContain('Confirmer appelle cette commande');
  });
  test('someone else cannot take a running claim: 409, nothing written', async () => {
    const res = await post(USERS.owner, R.a, 'claim');
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('appelle déjà cette commande');
    expect((await row(id.a)).claimedByUserId).toBe(U.confirmer);
    expect(await audits(id.a, 'order.claim')).toHaveLength(1);
  });
  test('claiming another order releases my previous claim in the same batch, both audited', async () => {
    const res = await post(USERS.confirmer, R.b, 'claim');
    expect(res.status).toBe(303);
    expect((await row(id.a)).claimedByUserId).toBeNull();
    expect((await row(id.b)).claimedByUserId).toBe(U.confirmer);
    const rel = await audits(id.a, 'order.release');
    expect(rel).toHaveLength(1);
    expect(rel[0]!.after).toMatchObject({ reason: 'claimed_other' });
  });
  test('an expired claim can be taken', async () => {
    expect((await post(USERS.confirmer, R.expired, 'claim')).status).toBe(303);
    expect((await row(id.expired)).claimedByUserId).toBe(U.confirmer);
  });
  test('a confirmed order cannot be claimed (not callable)', async () => {
    expect((await post(USERS.owner, R.confirmed, 'claim')).status).toBe(409);
    expect(await audits(id.confirmed, 'order.claim')).toHaveLength(0);
  });
  test('logistics and content: 403', async () => {
    expect((await post(USERS.logistics, R.c, 'claim')).status).toBe(403);
    expect((await post(USERS.content, R.c, 'claim')).status).toBe(403);
    expect((await row(id.c)).claimedByUserId).toBeNull();
  });
  test('two users racing for the same order: exactly one wins, exactly one audit row', async () => {
    const [x, y] = await Promise.all([post(USERS.confirmer, R.race, 'claim'), post(USERS.owner, R.race, 'claim')]);
    expect([x.status, y.status].sort()).toEqual([303, 409]);
    expect(await audits(id.race, 'order.claim')).toHaveLength(1);
  });
});

describe('release', () => {
  test('a confirmer cannot release the owner’s claim', async () => {
    await db().update(orders).set({ claimedByUserId: U.owner, claimedUntil: Date.now() + 600_000 }).where(eq(orders.id, id.c));
    expect((await post(USERS.confirmer, R.c, 'release')).status).toBe(409);
    expect((await row(id.c)).claimedByUserId).toBe(U.owner);
    expect(await audits(id.c, 'order.release')).toHaveLength(0);
  });
  test('the owner releases anyone’s claim; audited', async () => {
    await db().update(orders).set({ claimedByUserId: U.confirmer }).where(eq(orders.id, id.c));
    expect((await post(USERS.owner, R.c, 'release')).status).toBe(303);
    expect((await row(id.c)).claimedByUserId).toBeNull();
    expect(await audits(id.c, 'order.release')).toHaveLength(1);
  });
  test('releasing an unclaimed order: 409, no audit row', async () => {
    expect((await post(USERS.confirmer, R.c, 'release')).status).toBe(409);
    expect(await audits(id.c, 'order.release')).toHaveLength(1);
  });
});
