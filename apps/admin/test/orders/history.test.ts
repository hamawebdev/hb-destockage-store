// UX-7 — customer history on every order: the returner rule, and the order page over real D1.
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { customers } from '@hb/db';
import { deliveryRate, HISTORY_LIMIT, returnerLevel } from '../../src/routes/orders/history.ts';
import { harness, USERS, type Harness } from '../helpers.ts';
import { dbOf, insertOrder, refOf, seedGeoAndCatalog } from './fixtures.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

describe('returnerLevel', () => {
  test.each([
    [0, 0, 'none'],
    [5, 0, 'none'],
    [3, 1, 'some'],
    [0, 1, 'some'], // one return is not "frequent" yet
    [3, 2, 'some'], // 2 of 5 returned: below half
    [2, 2, 'frequent'],
    [1, 3, 'frequent'],
    [0, 2, 'frequent'],
  ] as const)('delivered %i, returned %i → %s', (d, r, level) => {
    expect(returnerLevel(d, r)).toBe(level);
  });
  test('deliveryRate', () => {
    expect(deliveryRate(0, 0)).toBeNull();
    expect(deliveryRate(3, 1)).toBe(75);
    expect(deliveryRate(1, 2)).toBe(33);
  });
});

let h: Harness;
const NOW = Date.now();
const HOUR = 3_600_000;
const PHONE = '+213661112233';
const R = {
  current: refOf(301),
  returnedA: refOf(302),
  returnedB: refOf(303),
  delivered: refOf(304),
  first: refOf(310), // another phone, first order
};
const older = Array.from({ length: HISTORY_LIMIT }, (_, i) => refOf(320 + i));

beforeAll(async () => {
  h = await harness();
  const db = dbOf(h.db);
  const cat = await seedGeoAndCatalog(db);
  await insertOrder(db, cat, { ref: R.current, createdAt: NOW - HOUR, status: 'new', phone: PHONE, name: 'Samir' });
  await insertOrder(db, cat, { ref: R.returnedA, createdAt: NOW - 10 * HOUR, status: 'returned', phone: PHONE });
  await insertOrder(db, cat, { ref: R.returnedB, createdAt: NOW - 20 * HOUR, status: 'returned', phone: PHONE });
  await insertOrder(db, cat, { ref: R.delivered, createdAt: NOW - 30 * HOUR, status: 'delivered', phone: PHONE });
  for (const [i, ref] of older.entries()) {
    await insertOrder(db, cat, { ref, createdAt: NOW - (100 + i) * HOUR, status: 'cancelled', phone: PHONE });
  }
  // Counters as applyOrderChange keeps them (the fixtures insert orders directly).
  await db.update(customers).set({ orderCount: 4 + older.length, deliveredCount: 1, returnedCount: 2, cancelledCount: older.length }).where(eq(customers.phoneE164, PHONE));
  await insertOrder(db, cat, { ref: R.first, createdAt: NOW - HOUR, status: 'new', phone: '+213770009999' });
}, 180_000);

afterAll(async () => {
  await h?.close();
});

const page = async (email: string, ref: string) => {
  const res = await h.as(email, `/orders/${ref}`);
  return { status: res.status, html: await res.text() };
};

describe('order page history', () => {
  test('owner (fr): frequent-returner warning, badge, counts and the latest other orders', async () => {
    const { status, html } = await page(USERS.owner, R.current);
    expect(status).toBe(200);
    expect(html).toContain('Historique de ce numéro');
    expect(html).toContain('Retours fréquents');
    expect(html).toContain('Colis retournés : 2 · livrés : 1');
    expect(html).toContain('33 % des colis terminés ont été livrés.');
    // The badge in the order head and the callout in the card.
    expect(html.match(/badge--danger">Retours fréquents/g)?.length).toBe(1);
    for (const ref of [R.returnedA, R.returnedB, R.delivered]) expect(html).toContain(`href="/orders/${ref}"`);
    expect(html).not.toContain(`href="/orders/${R.current}"`);
    // Five shown, newest first: the oldest cancelled order is past the limit, and "all orders" links the customer.
    expect(html).not.toContain(`href="/orders/${older[older.length - 1]}"`);
    expect(html).toContain('Toutes ses commandes');
    expect(html.indexOf(R.returnedA)).toBeLessThan(html.indexOf(R.delivered));
  });
  test('owner (ar): the same warning in Arabic', async () => {
    const { html } = await page(USERS.ownerAr, R.current);
    expect(html).toContain('سجل هذا الرقم');
    expect(html).toContain('مرتجعات متكررة');
  });
  test('confirmer sees it too', async () => {
    expect((await page(USERS.confirmer, R.current)).html).toContain('Retours fréquents');
  });
  test('logistics (no customers.sensitive): no history read, no warning, the customer link only', async () => {
    const { status, html } = await page(USERS.logistics, R.current);
    expect(status).toBe(200);
    expect(html).not.toContain('Historique de ce numéro');
    expect(html).not.toContain('Retours fréquents');
    expect(html).not.toContain(`href="/orders/${R.returnedA}"`);
    expect(html).toContain('Fiche client');
  });
  test('first order of a phone says so, without warning', async () => {
    const { html } = await page(USERS.owner, R.first);
    expect(html).toContain('Première commande de ce numéro.');
    expect(html).not.toContain('Retours fréquents');
    expect(html).not.toContain('Toutes ses commandes');
  });
});
