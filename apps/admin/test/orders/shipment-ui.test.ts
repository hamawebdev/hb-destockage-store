// UX-11 — shipping's pieces placed in the orders UI, over real D1 and the real writer:
// send entry points (order page, list and shipping bulk bars), the shipment panel, and the 409 from
// the open-slot guard (shipment_in_progress) for a status change and for a contact edit.
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { courierAccounts, deliveryFees, shipments, type Db } from '@hb/db';
import { harness, postAs, USERS, type Harness } from '../helpers.ts';
import { dbOf, GEO, insertOrder, refOf, seedGeoAndCatalog } from './fixtures.ts';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

let h: Harness;
let db: Db;
const NOW = Date.now();
const R = { ready: refOf(501), sending: refOf(502), shipped: refOf(503), fresh: refOf(504) };

beforeAll(async () => {
  h = await harness();
  db = dbOf(h.db);
  const cat = await seedGeoAndCatalog(db);
  await insertOrder(db, cat, { ref: R.ready, createdAt: NOW - 3_600_000, status: 'confirmed', phone: '+213770001201' });
  const sendingId = await insertOrder(db, cat, { ref: R.sending, createdAt: NOW - 3_600_000, status: 'confirmed', phone: '+213770001202' });
  const shippedId = await insertOrder(db, cat, { ref: R.shipped, createdAt: NOW - 3_600_000, status: 'shipped', phone: '+213770001203' });
  await insertOrder(db, cat, { ref: R.fresh, createdAt: NOW - 3_600_000, status: 'new', phone: '+213770001204' });
  await db.insert(deliveryFees).values({ wilayaCode: GEO.alger.code, feeDzd: 600, available: true });
  const [acc] = await db.insert(courierAccounts).values({ courier: 'yalidine' }).returning({ id: courierAccounts.id });
  const base = { courier: 'yalidine', accountId: acc!.id, codAmountDzd: 1000, feeDzd: 400, wilayaCode: GEO.alger.code, communeId: GEO.communes.babEzzouar.id, createdBy: 1 };
  // A parcel being sent: the open slot refuses any status or contact change of the order.
  await db.insert(shipments).values({ ...base, orderId: sendingId, state: 'reserved', reference: R.sending });
  await db.insert(shipments).values({ ...base, orderId: shippedId, state: 'accepted', reference: R.shipped, tracking: 'YAL-123', acceptedAt: NOW - 86_400_000, appliedAt: NOW - 86_400_000, courierStatus: 'in_transit', courierStatusRaw: 'En transit' });
}, 180_000);

afterAll(async () => {
  await h?.close();
});

const html = async (email: string, path: string) => (await h.as(email, path)).text();

describe('send entry points', () => {
  test('order page: a confirmed order without a parcel offers "send" to owner and logistics, posting ref + version', async () => {
    for (const u of [USERS.owner, USERS.logistics]) {
      const page = await html(u, `/orders/${R.ready}`);
      const form = /<form[^>]*action="\/delivery\/send"[\s\S]*?<\/form>/.exec(page)?.[0] ?? '';
      expect(form, u).toContain(`name="ref" value="${R.ready}"`);
      expect(form, u).toContain(`name="version_${R.ready}" value="0"`);
      expect(form, u).toContain('name="_csrf"');
    }
    // Confirmer has delivery.view but not delivery.send.
    expect(await html(USERS.confirmer, `/orders/${R.ready}`)).not.toContain('action="/delivery/send"');
  });
  test('no send button while a parcel is live, nor for a new order', async () => {
    expect(await html(USERS.owner, `/orders/${R.sending}`)).not.toContain('action="/delivery/send"');
    expect(await html(USERS.owner, `/orders/${R.shipped}`)).not.toContain('action="/delivery/send"');
    expect(await html(USERS.owner, `/orders/${R.fresh}`)).not.toContain('action="/delivery/send"');
  });
  test('orders list and shipping page bulk bars post the ticked orders to /delivery/send', async () => {
    expect(await html(USERS.owner, '/orders?status=confirmed')).toContain('formaction="/delivery/send"');
    expect(await html(USERS.logistics, '/orders/shipping')).toContain('formaction="/delivery/send"');
    // The bulk form carries a version per ticked order for the send page.
    expect(await html(USERS.owner, '/orders?status=confirmed')).toContain(`name="version_${R.ready}"`);
  });
});

describe('shipment panel', () => {
  test('a shipped order shows its parcel (courier, tracking, courier status) in the #shipment card', async () => {
    const page = await html(USERS.owner, `/orders/${R.shipped}`);
    expect(page).toMatch(/<section class="card" id="shipment"/);
    expect(page).toContain('YAL-123');
  });
  test('a new order shows no panel; logistics sees the panel; content cannot open orders', async () => {
    expect(await html(USERS.owner, `/orders/${R.fresh}`)).not.toContain('id="shipment"');
    expect(await html(USERS.logistics, `/orders/${R.shipped}`)).toContain('id="shipment"');
    expect((await h.as(USERS.content, `/orders/${R.shipped}`)).status).toBe(403);
  });
});

describe('409 shipment_in_progress', () => {
  test('cancelling an order whose parcel is being sent: 409, the banner links to the panel on the same page', async () => {
    const res = await postAs(h, USERS.owner, `/orders/${R.sending}/transition`, { version: '0', to: 'cancelled', reason: 'other' });
    expect(res.status).toBe(409);
    const page = await res.text();
    expect(page).toContain('href="#shipment"');
    expect(page).toMatch(/id="shipment"/);
  });
  test('editing its contact (name only, same total): 409 with the same banner, nothing changed', async () => {
    const res = await postAs(h, USERS.owner, `/orders/${R.sending}/contact`, {
      version: '0', name: 'Nouveau Nom', phone: '0770001202', wilaya: '16', commune: '1601', address: '', previewTotal: String(14_600 + 600), step: 'save',
    });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('href="#shipment"');
    expect(await html(USERS.owner, `/orders/${R.sending}`)).not.toContain('Nouveau Nom');
  });
});

describe('navigation to delivery and Sheets pages', () => {
  test('owner: sidebar and settings link courier settings, exceptions and the Google Sheet', async () => {
    const dash = await html(USERS.owner, '/dashboard');
    for (const href of ['/delivery/exceptions', '/delivery/settings', '/sheets', '/parcels/delayed', '/parcels/performance', '/products/stock/alerts']) {
      expect(dash, href).toContain(`href="${href}"`);
    }
    const settings = await html(USERS.owner, '/settings');
    expect(settings).toContain('href="/sheets"');
    expect(settings).toContain('href="/delivery/settings"');
  });
  test('logistics: exceptions and parcels, no owner-only settings links', async () => {
    const dash = await html(USERS.logistics, '/dashboard');
    expect(dash).toContain('href="/delivery/exceptions"');
    expect(dash).not.toContain('href="/sheets"');
    expect(dash).not.toContain('href="/delivery/settings"');
  });
  test('every linked destination answers 200 for the owner', async () => {
    for (const path of ['/delivery/exceptions', '/delivery/settings', '/sheets', '/parcels/delayed', '/parcels/performance', '/products/stock/alerts']) {
      expect((await h.as(USERS.owner, path)).status, path).toBe(200);
    }
  });
});
