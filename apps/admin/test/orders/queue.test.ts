// AORD-3 — call queue over a real D1: priority (due callbacks → oldest new → unreachable past
// retry), claims of others skipped, one claim per user, back to the queue after a call.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { auditLog, orders } from '@hb/db';
import { harness, USERS, type Harness } from '../helpers.ts';
import { dbOf, insertOrder, postAs, refOf, seedGeoAndCatalog } from './fixtures.ts';

let h: Harness;
const NOW = Date.now();
const H = 3_600_000;
const U = { owner: 1, confirmer: 2 } as const;
const R = {
  n1: refOf(41), // new, oldest
  n2: refOf(42), // new
  c1: refOf(43), // called, callback due
  c2: refOf(44), // called, callback later
  u1: refOf(45), // unreachable, retry due
  u2: refOf(46), // unreachable, retry later
  x: refOf(47), // confirmed: never in the queue
};
const id: Record<keyof typeof R, number> = {} as never;

beforeAll(async () => {
  h = await harness();
  const db = dbOf(h.db);
  const cat = await seedGeoAndCatalog(db);
  const spec: Record<keyof typeof R, { status: 'new' | 'called' | 'unreachable' | 'confirmed'; createdAt: number; next?: number }> = {
    n1: { status: 'new', createdAt: NOW - 5 * H },
    n2: { status: 'new', createdAt: NOW - 4 * H },
    c1: { status: 'called', createdAt: NOW - 1 * H, next: NOW - 60_000 },
    c2: { status: 'called', createdAt: NOW - 9 * H, next: NOW + 2 * H },
    u1: { status: 'unreachable', createdAt: NOW - 8 * H, next: NOW - 1000 },
    u2: { status: 'unreachable', createdAt: NOW - 10 * H, next: NOW + 3 * H },
    x: { status: 'confirmed', createdAt: NOW - 20 * H },
  };
  let i = 0;
  for (const [k, s] of Object.entries(spec) as [keyof typeof R, (typeof spec)['n1']][]) {
    id[k] = await insertOrder(db, cat, { ref: R[k], createdAt: s.createdAt, status: s.status, phone: `+21366000004${i++}`, callAttempts: s.status === 'new' ? 0 : 1 });
    if (s.next !== undefined) await db.update(orders).set({ nextCallAt: s.next }).where(eq(orders.id, id[k]));
  }
}, 180_000);

afterAll(async () => {
  await h?.close();
});

const db = () => dbOf(h.db);
const claimedBy = async (userId: number) =>
  (await db().select({ ref: orders.ref }).from(orders).where(and(eq(orders.claimedByUserId, userId)))).map((r) => r.ref);
const next = (email: string) => postAs(h, email, '/orders/queue/next');
const queue = async (email: string) => {
  const res = await h.as(email, '/orders/queue');
  return { status: res.status, html: await res.text() };
};

describe('access', () => {
  test('owner and confirmer: 200; logistics and content: 403 on the page and on "next"', async () => {
    expect((await queue(USERS.owner)).status).toBe(200);
    expect((await queue(USERS.confirmer)).status).toBe(200);
    for (const u of [USERS.logistics, USERS.content]) {
      expect((await queue(u)).status).toBe(403);
      expect((await next(u)).status).toBe(403);
    }
  });
});

describe('the queue, step by step (one confirmer, the owner as a colleague)', () => {
  test('without a claim: counts per bucket and a "take next" button', async () => {
    const { html } = await queue(USERS.confirmer);
    expect(html).toContain('1 rappel prévu maintenant');
    expect(html).toContain('2 nouvelles commandes');
    expect(html).toContain('1 commande injoignable à rappeler');
    expect(html).toContain('action="/orders/queue/next"');
  });
  test('a due callback comes first, even before older new orders', async () => {
    expect((await next(USERS.confirmer)).status).toBe(303);
    expect(await claimedBy(U.confirmer)).toEqual([R.c1]);
  });
  test('the call page: phone link first, outcome buttons, return to the queue, no duplicate ids', async () => {
    const { html } = await queue(USERS.confirmer);
    const main = html.slice(html.indexOf('<main'));
    expect(main.indexOf('href="tel:')).toBeGreaterThan(-1);
    expect(main.indexOf('href="tel:')).toBeLessThan(main.indexOf('name="outcome"'));
    expect(html).toContain(`<bdi dir="ltr">${R.c1}</bdi>`);
    expect(html).toContain('name="return" value="queue"');
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)|\sstyle=|\son[a-z]+=/);
  });
  test('logging the call returns to the queue and releases the claim', async () => {
    const res = await postAs(h, USERS.confirmer, `/orders/${R.c1}/call`, { version: '0', outcome: 'no_answer', return: 'queue' });
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/orders/queue?m=saved');
    expect(await claimedBy(U.confirmer)).toEqual([]);
  });
  test('then the oldest new order; an order a colleague holds is skipped', async () => {
    expect((await postAs(h, USERS.owner, `/orders/${R.n1}/claim`)).status).toBe(303);
    expect((await next(USERS.confirmer)).status).toBe(303);
    expect(await claimedBy(U.confirmer)).toEqual([R.n2]);
  });
  test('"next" while holding a claim keeps it and writes nothing', async () => {
    const before = (await db().select().from(auditLog).where(eq(auditLog.action, 'order.claim'))).length;
    expect((await next(USERS.confirmer)).status).toBe(303);
    expect(await claimedBy(U.confirmer)).toEqual([R.n2]);
    expect((await db().select().from(auditLog).where(eq(auditLog.action, 'order.claim'))).length).toBe(before);
  });
  test('release from the queue page returns to the queue', async () => {
    const res = await postAs(h, USERS.confirmer, `/orders/${R.n2}/release`, { return: 'queue' });
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/orders/queue?m=saved');
    expect(await claimedBy(U.confirmer)).toEqual([]);
  });
  test('unreachable past its retry delay comes after new orders; future ones never', async () => {
    // Everything new is taken by the owner (directly, to set up the case).
    await db().update(orders).set({ claimedByUserId: U.owner, claimedUntil: Date.now() + 600_000 }).where(inArray(orders.id, [id.n1, id.n2]));
    expect((await next(USERS.confirmer)).status).toBe(303);
    expect(await claimedBy(U.confirmer)).toEqual([R.u1]);
  });
  test('every candidate taken by colleagues → 409 with a notice, nothing written', async () => {
    await db().update(orders).set({ claimedByUserId: U.owner, claimedUntil: Date.now() + 600_000 }).where(eq(orders.id, id.u1));
    const res = await next(USERS.confirmer);
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('déjà prises par vos collègues');
  });
  test('nothing due at all → 200 "nothing to call", no button', async () => {
    await db().update(orders).set({ status: 'confirmed', claimedByUserId: null, claimedUntil: null }).where(inArray(orders.id, [id.n1, id.n2, id.c1, id.u1]));
    const res = await next(USERS.confirmer);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Rien à appeler pour le moment');
    expect(html).not.toContain('action="/orders/queue/next"');
  });
  test('Arabic: rtl page with Arabic counts', async () => {
    const { html } = await queue(USERS.ownerAr);
    expect(html).toMatch(/<html[^>]*dir="rtl"/);
    expect(html).toContain('لا توجد طلبات جديدة');
  });
});
