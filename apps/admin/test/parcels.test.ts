// UX-8 delayed parcels and UX-10 delivery success rate, over real D1 with SHIP-1's tables.
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { courierAccounts, orders, shipments, type Db } from '@hb/db';
import { successRate } from '../src/routes/parcels/data.ts';
import { harness, postAs, USERS, type Harness } from './helpers.ts';
import { dbOf, GEO, insertOrder, refOf, seedGeoAndCatalog, type CatalogFixture } from './orders/fixtures.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

const DAY = 24 * 3_600_000;
const NOW = Date.now();
let h: Harness;
let db: Db;
let cat: CatalogFixture;
let accounts: Record<'alpha' | 'beta', number>;
let n = 400;

interface ParcelSpec {
  courier: 'alpha' | 'beta';
  status?: 'pending' | 'in_transit' | 'delivered' | 'returning' | 'returned' | 'exception' | 'unknown' | null;
  statusAt?: number | null;
  acceptedAt: number;
  state?: 'accepted' | 'draft' | 'failed';
  orderStatus?: 'shipped' | 'delivered' | 'returned';
  wilaya?: 'alger' | 'oran';
}

async function parcel(s: ParcelSpec): Promise<string> {
  const ref = refOf(n++);
  const orderId = await insertOrder(db, cat, { ref, createdAt: s.acceptedAt - DAY, status: s.orderStatus ?? 'shipped', wilaya: s.wilaya ?? 'alger', phone: '+213770001122', name: 'Leila' });
  const oran = s.wilaya === 'oran';
  await db.insert(shipments).values({
    orderId,
    courier: s.courier,
    accountId: accounts[s.courier],
    state: s.state ?? 'accepted',
    reference: ref,
    tracking: s.state === 'failed' ? null : `TRK-${ref}`,
    courierStatus: s.status ?? null,
    courierStatusRaw: s.status ? `raw ${s.status}` : null,
    courierStatusAt: s.statusAt ?? null,
    acceptedAt: s.acceptedAt,
    appliedAt: s.acceptedAt,
    codAmountDzd: 1000,
    feeDzd: 400,
    wilayaCode: oran ? GEO.oran.code : GEO.alger.code,
    communeId: oran ? GEO.communes.birElDjir.id : GEO.communes.babEzzouar.id,
    createdBy: 1,
  });
  return ref;
}

const P: Record<string, string> = {};

beforeAll(async () => {
  h = await harness();
  db = dbOf(h.db);
  cat = await seedGeoAndCatalog(db);
  const rows = await db.insert(courierAccounts).values([{ courier: 'alpha' }, { courier: 'beta' }]).returning({ id: courierAccounts.id, courier: courierAccounts.courier });
  accounts = { alpha: rows.find((r) => r.courier === 'alpha')!.id, beta: rows.find((r) => r.courier === 'beta')!.id };
  P.silent5 = await parcel({ courier: 'alpha', status: 'in_transit', statusAt: NOW - 5 * DAY, acceptedAt: NOW - 8 * DAY });
  P.silent10 = await parcel({ courier: 'beta', status: 'exception', statusAt: NOW - 10 * DAY, acceptedAt: NOW - 12 * DAY, wilaya: 'oran' });
  P.neverHeard = await parcel({ courier: 'alpha', status: null, acceptedAt: NOW - 4 * DAY });
  P.returning = await parcel({ courier: 'beta', status: 'returning', statusAt: NOW - 6 * DAY, acceptedAt: NOW - 9 * DAY });
  P.fresh = await parcel({ courier: 'alpha', status: 'in_transit', statusAt: NOW - DAY, acceptedAt: NOW - 6 * DAY });
  P.delivered = await parcel({ courier: 'alpha', status: 'delivered', statusAt: NOW - 20 * DAY, acceptedAt: NOW - 22 * DAY, orderStatus: 'delivered' });
  P.returned = await parcel({ courier: 'beta', status: 'returned', statusAt: NOW - 20 * DAY, acceptedAt: NOW - 25 * DAY, orderStatus: 'returned', wilaya: 'oran' });
  P.failed = await parcel({ courier: 'alpha', state: 'failed', acceptedAt: NOW - 30 * DAY });
  // Shipped by hand before the integration (no shipment row): counts in the success rate only.
  const manualDelivered = await insertOrder(db, cat, { ref: refOf(n++), createdAt: NOW - 10 * DAY, status: 'delivered', phone: '+213770001133' });
  const manualReturned = await insertOrder(db, cat, { ref: refOf(n++), createdAt: NOW - 10 * DAY, status: 'returned', phone: '+213770001133' });
  await db.update(orders).set({ courierName: ' Livreur Ali ' }).where(eq(orders.id, manualDelivered));
  await db.update(orders).set({ courierName: 'livreur ali' }).where(eq(orders.id, manualReturned));
}, 180_000);

afterAll(async () => {
  await h?.close();
});

const get = async (email: string, path: string) => {
  const res = await h.as(email, path);
  return { status: res.status, html: await res.text() };
};

describe('delayed parcels', () => {
  test('default (3 days): silent parcels only, longest silence first; delivered, returned, failed and fresh ones excluded', async () => {
    const { status, html } = await get(USERS.owner, '/parcels/delayed');
    expect(status).toBe(200);
    const order = [P.silent10!, P.returning!, P.silent5!, P.neverHeard!].map((r) => html.indexOf(`href="/orders/${r}"`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const r of [P.fresh, P.delivered, P.returned, P.failed]) expect(html).not.toContain(`href="/orders/${r}"`);
    expect(html).toContain('il y a 10 jours');
    expect(html).toContain('Problème signalé');
    expect(html).toContain('raw exception');
    expect(html).toContain('Pas encore de nouvelle'); // never heard: counted from acceptance
  });
  test('?days=7 narrows; an out-of-range value falls back to the setting', async () => {
    const seven = (await get(USERS.owner, '/parcels/delayed?days=7')).html;
    expect(seven).toContain(`href="/orders/${P.silent10}"`);
    expect(seven).not.toContain(`href="/orders/${P.silent5}"`);
    const bad = (await get(USERS.owner, '/parcels/delayed?days=99')).html;
    expect(bad).toContain(`href="/orders/${P.silent5}"`);
  });
  test('courier filter; an unknown courier is dropped', async () => {
    const beta = (await get(USERS.owner, '/parcels/delayed?courier=beta')).html;
    expect(beta).toContain(`href="/orders/${P.silent10}"`);
    expect(beta).not.toContain(`href="/orders/${P.silent5}"`);
    expect((await get(USERS.owner, '/parcels/delayed?courier=__proto__')).html).toContain(`href="/orders/${P.silent5}"`);
  });
  test('nothing delayed past 30 days: the empty state, in Arabic too', async () => {
    expect((await get(USERS.owner, '/parcels/delayed?days=30')).html).toContain('Aucun colis en retard');
    expect((await get(USERS.ownerAr, '/parcels/delayed?days=30')).html).toContain('لا طرود متأخرة');
  });
  test('roles: confirmer and logistics see it; content gets 403', async () => {
    expect((await get(USERS.confirmer, '/parcels/delayed')).status).toBe(200);
    expect((await get(USERS.logistics, '/parcels/delayed')).status).toBe(200);
    expect((await get(USERS.content, '/parcels/delayed')).status).toBe(403);
  });
  test('the store setting moves the default, and the dashboard tile follows it', async () => {
    const before = (await get(USERS.owner, '/dashboard')).html;
    expect(before).toMatch(/data-tile="delayed"[\s\S]*?\+3 jours[\s\S]*?tile__value[^>]*>(<[^>]+>)*4</);
    const form = { storeName_fr: 'HB', storeName_ar: 'HB', contactPhone: '0560417403', whatsapp: '+213779942022', contactEmail: '', orderMaxUnanswered: '3', callRetryMinutes: '30', unreachableRetryMinutes: '240', lowStockThreshold: '3' };
    const res = await postAs(h, USERS.owner, '/settings', { ...form, delayedParcelDays: '7' });
    expect(res.status).toBe(303);
    const after = (await get(USERS.owner, '/parcels/delayed')).html;
    expect(after).not.toContain(`href="/orders/${P.silent5}"`);
    expect(after).toContain(`href="/orders/${P.silent10}"`);
    expect((await get(USERS.owner, '/dashboard')).html).toContain('+7 jours');
    const invalid = await postAs(h, USERS.owner, '/settings', { ...form, delayedParcelDays: '0' });
    expect(invalid.status).toBe(422);
  });
});

describe('delivery success rate', () => {
  test('successRate', () => {
    expect(successRate({ delivered: 0, returned: 0 })).toBeNull();
    expect(successRate({ delivered: 3, returned: 1 })).toBe(75);
  });
  test('by courier: tracked couriers by id, hand-typed names merged case- and space-insensitively', async () => {
    const { status, html } = await get(USERS.owner, '/parcels/performance');
    expect(status).toBe(200);
    expect(html).toContain('livreur ali (saisi à la main)');
    // alpha: 1 delivered, 3 in transit (silent5, neverHeard, fresh); beta: 1 returned, 2 in transit; manual: 1 + 1.
    expect(html).toContain('100 % livrées');
    expect(html).toContain('0 % livrées');
    expect(html).toContain('50 % livrées');
    expect(html).toContain('Trop peu de colis pour juger');
  });
  test('by wilaya for one courier; an unknown courier key shows every courier', async () => {
    const beta = (await get(USERS.owner, '/parcels/performance?courier=beta')).html;
    expect(beta).toContain('Par wilaya — beta');
    const all = (await get(USERS.owner, '/parcels/performance?courier=nope')).html;
    expect(all).not.toContain('Par wilaya —');
  });
  test('period 30 days; Arabic page', async () => {
    expect((await get(USERS.owner, '/parcels/performance?period=30')).html).toContain('100 % livrées');
    expect((await get(USERS.ownerAr, '/parcels/performance')).html).toContain('نسبة التسليم');
  });
  test('roles', async () => {
    expect((await get(USERS.logistics, '/parcels/performance')).status).toBe(200);
    expect((await get(USERS.content, '/parcels/performance')).status).toBe(403);
  });
});
