// customers.sensitive (lead decision; AORD-1 F1 / AORD-2 F1): logistics receives delivery fields
// only. The real list and detail pages are rendered as logistics and the raw HTML is searched for
// every sensitive value; the same values are shown to a confirmer (so the markers are real).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { customers, orders } from '@hb/db';
import { harness, USERS, type Harness } from '../helpers.ts';
import { dbOf, insertEvent, insertOrder, postAs, refOf, seedGeoAndCatalog } from './fixtures.ts';

let h: Harness;
const NOW = Date.now();
const REF = refOf(61);
const SHIPPED = refOf(62);
let orderId = 0;

/** Values that must never reach a logistics page. */
const SECRETS = {
  customerNote: 'CUSTNOTE-private-5521',
  callNote: 'CALLNOTE-private-8813',
  orderNote: 'ORDERNOTE-private-4417',
  cancelReasonOnTimeline: 'Motif :',
  customerFlag: 'CUSTFLAG-frequent-returns',
  ipHash: 'IPHASH-9f8e7d6c5b4a',
  idempotencyKey: 'IDEMKEY-3c2b1a00-aaaa-bbbb-cccc-000000000001',
  claimer: 'Owner',
};
const FLAG_TEXT = ['honeypot', 'fast_fill', 'duplicate', 'Piège anti-robot', 'Remplie trop vite', 'anti-robot', 'Doublon'];

beforeAll(async () => {
  h = await harness();
  const db = dbOf(h.db);
  const cat = await seedGeoAndCatalog(db);
  orderId = await insertOrder(db, cat, {
    ref: REF,
    createdAt: NOW - 3_600_000,
    status: 'confirmed',
    phone: '+213661000061',
    name: 'Samir',
    flags: ['honeypot', 'fast_fill'],
    callAttempts: 4,
    blockedCustomer: true,
  });
  await insertOrder(db, cat, { ref: SHIPPED, createdAt: NOW - 1_800_000, status: 'shipped', phone: '+213661000061', name: 'Samir', flags: ['duplicate'] });
  await db
    .update(orders)
    .set({ riskScore: 87, ipHash: SECRETS.ipHash, turnstile: 'invalid', fillMs: 1234, nextCallAt: NOW + 7_200_000, claimedByUserId: 1, claimedUntil: NOW + 600_000, idempotencyKey: SECRETS.idempotencyKey })
    .where(eq(orders.id, orderId));
  const [o] = await db.select({ customerId: orders.customerId }).from(orders).where(eq(orders.id, orderId));
  await db
    .update(customers)
    .set({ notes: SECRETS.customerNote, flags: [SECRETS.customerFlag], orderCount: 7, deliveredCount: 3, returnedCount: 2, cancelledCount: 1 })
    .where(eq(customers.id, o!.customerId));
  await insertEvent(db, orderId, { type: 'call_attempt', at: NOW - 3_000_000, outcome: 'busy', note: SECRETS.callNote, actorUserId: 2 });
  await insertEvent(db, orderId, { type: 'status_change', at: NOW - 2_000_000, from: 'called', to: 'confirmed', outcome: 'other', actorUserId: 2 });
  await insertEvent(db, orderId, { type: 'note', at: NOW - 1_000_000, note: SECRETS.orderNote, actorUserId: 1 });
}, 180_000);

afterAll(async () => {
  await h?.close();
});

const html = async (email: string, path: string) => {
  const res = await h.as(email, path);
  expect(res.status, `${email} ${path}`).toBe(200);
  return res.text();
};

function expectNoSensitive(page: string, where: string) {
  for (const s of Object.values(SECRETS)) expect(page, `${where}: ${s}`).not.toContain(s);
  for (const s of FLAG_TEXT) expect(page, `${where}: ${s}`).not.toContain(s);
  for (const s of [
    'tentative', // attempt counter
    'Client bloqué', // blocked badge / banner
    'Prochain appel', // next call
    'appelle cette commande', // claim banner
    'Appel : Occupé', // call outcome in the timeline
    '7 commandes', // customer history counts
    'Alertes', // flags column / section
    'name="flagged"',
    'name="duplicate"',
    'name="blocked"',
    'name="flagsChecked"',
    '>87<',
  ]) {
    expect(page, `${where}: ${s}`).not.toContain(s);
  }
}

describe('logistics receives delivery fields only', () => {
  test('orders list (default view, every status, and a search)', async () => {
    for (const q of ['', '?status=any', `?q=${REF}`]) {
      const page = await html(USERS.logistics, `/orders${q}`);
      expect(page).toContain(REF); // the order itself is there…
      expectNoSensitive(page, `list ${q}`); // …without any risk data
    }
  });
  test('risk filters are refused for logistics (reported, not applied)', async () => {
    const page = await html(USERS.logistics, '/orders?status=any&flagged=1&duplicate=1&blocked=1');
    expect(page).toContain('filtres d’alerte (réservés à la confirmation)');
    expect(page).toContain(REF); // not filtered on flags
    expectNoSensitive(page, 'list with risk filters');
  });
  test('order detail: delivery fields present, every sensitive value absent', async () => {
    const page = await html(USERS.logistics, `/orders/${REF}`);
    for (const ok of ['Samir', 'tel:+213661000061', 'Bab Ezzouar', 'Total à encaisser', 'PK-CUI-01']) expect(page).toContain(ok);
    expectNoSensitive(page, 'detail');
    // Status history stays (delivery needs it); the call attempt with its note does not.
    expect(page).toContain('Confirmée');
  });
  test('after a logistics action the re-rendered page leaks nothing either (422 path)', async () => {
    const res = await postAs(h, USERS.logistics, `/orders/${REF}/transition`, { version: '0', to: 'shipped' });
    expect(res.status).toBe(422);
    expectNoSensitive(await res.text(), 'detail 422');
  });
  test('a shipped order of the same (blocked, flagged) customer', async () => {
    expectNoSensitive(await html(USERS.logistics, `/orders/${SHIPPED}`), 'detail shipped');
  });
});

describe('the same values are shown to a confirmer (the markers are real)', () => {
  test('detail', async () => {
    const page = await html(USERS.confirmer, `/orders/${REF}`);
    for (const s of ['Piège anti-robot', 'Remplie trop vite', 'tentative 4', 'Client bloqué', 'Prochain appel', SECRETS.callNote, SECRETS.orderNote, 'Motif :', '7 commandes', 'Owner appelle cette commande']) {
      expect(page, s).toContain(s);
    }
  });
  test('list', async () => {
    const page = await html(USERS.confirmer, '/orders?status=any');
    for (const s of ['Piège anti-robot', 'Client bloqué', 'name="flagged"']) expect(page, s).toContain(s);
  });
});
