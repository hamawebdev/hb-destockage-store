// AORD-6 (high risk) — contact/address edit on a real D1 with DB-6 updateOrderContact and the
// admin-table FeeProvider from @hb/db: role × status rule, review before save, server-side re-quote,
// unavailable wilayas, phone re-normalise + customer re-link, version guard, audit row.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, communes, customers, deliveryFees, orderEvents, orderItems, orders, wilayas } from '@hb/db';
import { formatMoney } from '../../src/ui/format.tsx';
import { harness, USERS, type Harness } from '../helpers.ts';
import { dbOf, insertOrder, postAs, refOf, seedGeoAndCatalog, type CatalogFixture } from './fixtures.ts';

let h: Harness;
let cat: CatalogFixture;
let n = 3000;
const NOW = Date.now();
const SUBTOTAL = 14_600; // one line of variant A

beforeAll(async () => {
  h = await harness();
  const db = dbOf(h.db);
  cat = await seedGeoAndCatalog(db);
  await db.insert(wilayas).values([
    { code: 1, nameFr: 'Adrar', nameAr: 'أدرار' },
    { code: 2, nameFr: 'Chlef', nameAr: 'الشلف' },
    { code: 3, nameFr: 'Laghouat', nameAr: 'الأغواط' },
  ]);
  await db.insert(communes).values([
    { id: 101, wilayaCode: 1, nameFr: 'Adrar', nameAr: 'أدرار' },
    { id: 201, wilayaCode: 2, nameFr: 'Chlef', nameAr: 'الشلف' },
    { id: 301, wilayaCode: 3, nameFr: 'Laghouat', nameAr: 'الأغواط' },
  ]);
  await db.insert(deliveryFees).values([
    { wilayaCode: 16, feeDzd: 600, available: true },
    { wilayaCode: 31, feeDzd: 800, available: true },
    { wilayaCode: 1, feeDzd: 1200, available: true, placeholder: true }, // invented seed fee
    { wilayaCode: 2, feeDzd: 900, available: false },
    { wilayaCode: 3, feeDzd: 20_000, available: true },
  ]);
}, 180_000);

afterAll(async () => {
  await h?.close();
});

const db = () => dbOf(h.db);
async function newOrder(status: 'new' | 'called' | 'unreachable' | 'confirmed' | 'shipped' = 'new', phone?: string, items?: readonly (readonly ['A' | 'B', number])[]) {
  const ref = refOf(n++);
  const id = await insertOrder(db(), cat, { ref, createdAt: NOW - n, status, phone: phone ?? `+2136${String(20_000_000 + n).slice(-8)}`, name: 'Amina', ...(items ? { items } : {}) });
  return { ref, id };
}
const row = async (id: number) => (await db().select().from(orders).where(eq(orders.id, id)))[0]!;
const audits = (id: number) => db().select().from(auditLog).where(and(eq(auditLog.entity, 'orders'), eq(auditLog.entityId, String(id)), eq(auditLog.action, 'order.contact')));
const events = (id: number) => db().select().from(orderEvents).where(eq(orderEvents.orderId, id));
const customerByPhone = async (p: string) => (await db().select().from(customers).where(eq(customers.phoneE164, p)))[0];

/** Form values as the edit page would post them, with overrides. */
const values = (o: { phone?: string; over?: Record<string, string> } = {}) => ({
  version: '0',
  name: 'Amina',
  phone: o.phone ?? '',
  wilaya: '16',
  commune: '1601',
  address: '',
  ...o.over,
});
const submit = (email: string, ref: string, data: Record<string, string>) => postAs(h, email, `/orders/${ref}/contact`, data);

describe('who may edit, when', () => {
  test.each([
    ['confirmer', 'new', 200],
    ['confirmer', 'called', 200],
    ['confirmer', 'unreachable', 200],
    ['confirmer', 'confirmed', 403],
    ['owner', 'confirmed', 200],
    ['owner', 'shipped', 403],
    ['logistics', 'new', 403],
    ['content', 'new', 403],
  ] as const)('%s on %s → %i', async (role, status, code) => {
    const o = await newOrder(status);
    const res = await h.as(USERS[role], `/orders/${o.ref}/contact`);
    expect(res.status).toBe(code);
    const detail = await (await h.as(USERS[role === 'content' ? 'owner' : role], `/orders/${o.ref}`)).text();
    if (role !== 'content') expect(detail.includes(`href="/orders/${o.ref}/contact"`)).toBe(code === 200);
  });
  test('the form is prefilled; phone shown in national form, LTR', async () => {
    const o = await newOrder('new', '+213560417499');
    const html = await (await h.as(USERS.confirmer, `/orders/${o.ref}/contact`)).text();
    expect(html).toContain('value="0560417499"');
    const tel = /<input[^>]*name="phone"[^>]*>/.exec(html)![0];
    for (const attr of ['type="tel"', 'inputmode="tel"', 'dir="ltr"', 'value="0560417499"']) expect(tel).toContain(attr);
    expect(html).toContain('Bab Ezzouar');
  });
});

describe('review, then save with a server-side re-quote', () => {
  test('review shows old → new fee and total and writes nothing', async () => {
    const o = await newOrder();
    const res = await submit(USERS.confirmer, o.ref, values({ phone: '+213' + (await row(o.id)).phoneE164.slice(4), over: { wilaya: '31', commune: '3101' } }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(formatMoney('fr', 600));
    expect(html).toContain(formatMoney('fr', 800));
    expect(html).toContain(formatMoney('fr', SUBTOTAL + 800));
    expect(html).toContain('name="previewTotal" value="15400"');
    expect((await row(o.id)).version).toBe(0);
    expect(await audits(o.id)).toHaveLength(0);
  });
  test('save: wilaya/commune, fee 800, total, fee source, version, event, audit with before/after', async () => {
    const o = await newOrder();
    const phone = (await row(o.id)).phoneE164;
    const res = await submit(USERS.confirmer, o.ref, values({ phone, over: { wilaya: '31', commune: '3101', previewTotal: String(SUBTOTAL + 800), step: 'save' } }));
    expect(res.status).toBe(303);
    const r = await row(o.id);
    expect([r.wilayaCode, r.communeId, r.feeDzd, r.totalDzd, r.feeSource, r.version]).toEqual([31, 3101, 800, SUBTOTAL + 800, 'table', 1]);
    expect((await events(o.id)).map((e) => [e.type, e.outcome])).toEqual([['note', 'contact_edit']]);
    const a = await audits(o.id);
    expect(a).toHaveLength(1);
    expect(a[0]!.before).toMatchObject({ wilayaCode: 16, feeDzd: 600, totalDzd: SUBTOTAL + 600 });
    expect(a[0]!.after).toMatchObject({ wilayaCode: 31, communeId: 3101, feeDzd: 800, totalDzd: SUBTOTAL + 800, feeSource: 'table' });
  });
  test('the fee moved between review and save → re-review (409), nothing written', async () => {
    const o = await newOrder();
    const phone = (await row(o.id)).phoneE164;
    const res = await submit(USERS.confirmer, o.ref, values({ phone, over: { wilaya: '31', commune: '3101', previewTotal: String(SUBTOTAL + 700), step: 'save' } }));
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('Le tarif de livraison a changé');
    expect((await row(o.id)).wilayaCode).toBe(16);
    expect(await audits(o.id)).toHaveLength(0);
  });
  test('new wilaya with the old commune (no-JS wilaya change) → 422 with the new wilaya’s communes', async () => {
    const o = await newOrder();
    const phone = (await row(o.id)).phoneE164;
    const res = await submit(USERS.confirmer, o.ref, values({ phone, over: { wilaya: '31', commune: '1601' } }));
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('Choisissez une commune de cette wilaya');
    expect(html).toContain('Bir El Djir');
    expect(html).not.toContain('>Bab Ezzouar<');
  });
  test.each([
    ['1', '101', 'placeholder fee (invented seed) outside development'],
    ['2', '201', 'wilaya marked unavailable'],
  ])('wilaya %s → "delivery unavailable" (%s), nothing written', async (w, cm) => {
    const o = await newOrder();
    const phone = (await row(o.id)).phoneE164;
    for (const step of ['review', 'save']) {
      const res = await submit(USERS.owner, o.ref, values({ phone, over: { wilaya: w, commune: cm, previewTotal: '0', step } }));
      expect(res.status).toBe(422);
      expect(await res.text()).toContain('Livraison indisponible');
    }
    expect((await row(o.id)).version).toBe(0);
    expect(await audits(o.id)).toHaveLength(0);
  });
});

describe('phone, name, address', () => {
  test('phone change (Eastern-Arabic digits) is normalised and re-links the customer', async () => {
    const o = await newOrder('called', '+213661110001');
    const oldCustomer = await customerByPhone('+213661110001');
    const res = await submit(USERS.confirmer, o.ref, values({ phone: '٠٧٧٠١٢٣٤٥٦', over: { previewTotal: String(SUBTOTAL + 600), step: 'save' } }));
    expect(res.status).toBe(303);
    const r = await row(o.id);
    expect(r.phoneE164).toBe('+213770123456');
    const fresh = await customerByPhone('+213770123456');
    expect(fresh?.orderCount).toBe(1);
    expect(r.customerId).toBe(fresh!.id);
    expect((await customerByPhone('+213661110001'))!.orderCount).toBe(Math.max(oldCustomer!.orderCount - 1, 0));
    expect((await audits(o.id))[0]!.after).toMatchObject({ phoneE164: '+213770123456' });
    expect(r.feeDzd).toBe(600);
  });
  test('invalid phone (naive 05x range) → 422, nothing written', async () => {
    const o = await newOrder();
    const res = await submit(USERS.confirmer, o.ref, values({ phone: '0501234567' }));
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('Numéro de mobile algérien invalide');
  });
  test('name and address only: fee untouched', async () => {
    const o = await newOrder();
    const phone = (await row(o.id)).phoneE164;
    const res = await submit(USERS.confirmer, o.ref, values({ phone, over: { name: 'Amina B.', address: 'Cité 200 logts', previewTotal: String(SUBTOTAL + 600), step: 'save' } }));
    expect(res.status).toBe(303);
    const r = await row(o.id);
    expect([r.name, r.address, r.feeDzd, r.totalDzd]).toEqual(['Amina B.', 'Cité 200 logts', 600, SUBTOTAL + 600]);
    const a = (await audits(o.id))[0]!;
    expect(Object.keys(a.after as object).sort()).toEqual(['address', 'name']);
  });
  test('nothing changed → 422', async () => {
    const o = await newOrder();
    const phone = (await row(o.id)).phoneE164;
    expect((await submit(USERS.confirmer, o.ref, values({ phone }))).status).toBe(422);
  });
});

describe('concurrency and steps', () => {
  test('stale version → 409, nothing written', async () => {
    const o = await newOrder();
    const phone = (await row(o.id)).phoneE164;
    await db().update(orders).set({ version: 3 }).where(eq(orders.id, o.id));
    const res = await submit(USERS.confirmer, o.ref, values({ phone, over: { name: 'X', previewTotal: String(SUBTOTAL + 600), step: 'save' } }));
    expect(res.status).toBe(409);
    expect((await row(o.id)).name).toBe('Amina');
    expect(await audits(o.id)).toHaveLength(0);
  });
  test('two saves on the same version: one wins, one 409, one audit row', async () => {
    const o = await newOrder();
    const phone = (await row(o.id)).phoneE164;
    const save = (name: string) => submit(USERS.confirmer, o.ref, values({ phone, over: { name, previewTotal: String(SUBTOTAL + 600), step: 'save' } }));
    const [x, y] = await Promise.all([save('Nom A'), save('Nom B')]);
    expect([x.status, y.status].sort()).toEqual([303, 409]);
    expect(await audits(o.id)).toHaveLength(1);
    expect((await row(o.id)).version).toBe(1);
  });
  test('"Modifier" on the review goes back to the form with the typed values', async () => {
    const o = await newOrder();
    const res = await submit(USERS.confirmer, o.ref, values({ phone: '0770999888', over: { name: 'Typed', step: 'edit' } }));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('value="Typed"');
    expect(html).toContain('value="0770999888"');
  });
  test('an Arabic owner sees Arabic labels and an LTR-isolated ref in the title', async () => {
    const o = await newOrder();
    const html = await (await h.as(USERS.ownerAr, `/orders/${o.ref}/contact`)).text();
    expect(html).toMatch(/<html[^>]*dir="rtl"/);
    expect(html).toContain('البلدية');
    expect(html).toContain(`⁦${o.ref}⁩`);
  });
});

describe('DB-6 follow-up (168fd1f): role rule and total ceiling', () => {
  test('a confirmer cannot save on a confirmed order: 403 with a clear message, nothing written', async () => {
    const o = await newOrder('confirmed');
    const phone = (await row(o.id)).phoneE164;
    const res = await submit(USERS.confirmer, o.ref, values({ phone, over: { name: 'X', previewTotal: String(SUBTOTAL + 600), step: 'save' } }));
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('ne peuvent plus être modifiées');
    expect((await row(o.id)).version).toBe(0);
    expect(await audits(o.id)).toHaveLength(0);
  });
  test('the owner can still save on a confirmed order', async () => {
    const o = await newOrder('confirmed');
    const phone = (await row(o.id)).phoneE164;
    const res = await submit(USERS.owner, o.ref, values({ phone, over: { name: 'Owner edit', previewTotal: String(SUBTOTAL + 600), step: 'save' } }));
    expect(res.status).toBe(303);
  });
  test('a fee that pushes the total over MAX_ORDER_TOTAL_DZD is refused at review and at save', async () => {
    // 10 × 999 000 = 9 990 000 DZD (a line is at most MAX_QTY_PER_LINE = 10); + 20 000 fee > 10 000 000.
    const o = await newOrder('new', undefined, [['A', 10]]);
    await db().update(orderItems).set({ unitPriceDzd: 999_000, lineTotalDzd: 9_990_000 }).where(eq(orderItems.orderId, o.id));
    await db().update(orders).set({ subtotalDzd: 9_990_000, totalDzd: 9_990_600 }).where(eq(orders.id, o.id));
    const phone = (await row(o.id)).phoneE164;
    for (const step of ['review', 'save']) {
      const res = await submit(USERS.owner, o.ref, values({ phone, over: { wilaya: '3', commune: '301', previewTotal: '10010000', step } }));
      expect(res.status, step).toBe(422);
      expect(await res.text()).toContain('dépasserait le plafond');
    }
    const r = await row(o.id);
    expect([r.wilayaCode, r.version]).toEqual([16, 0]);
    expect(await audits(o.id)).toHaveLength(0);
  });
});

describe('name (DB-6 r2 / SHARED-7 normalizeName)', () => {
  test.each([
    ['   ', 'Indiquez le nom du client'],
    ['\u200f\u2066\u2069', 'Indiquez le nom du client'],
    ['12345', 'Nom invalide'],
    ['A', 'Nom invalide'],
    ['Ami\u0007na', 'Nom invalide'],
    ['x'.repeat(81), 'Nom invalide'],
  ])('name %j → 422 "%s" at review and at save, nothing written', async (name, message) => {
    const o = await newOrder();
    const phone = (await row(o.id)).phoneE164;
    for (const step of ['review', 'save']) {
      const res = await submit(USERS.confirmer, o.ref, values({ phone, over: { name, previewTotal: String(SUBTOTAL + 600), step } }));
      expect(res.status, step).toBe(422);
      const html = await res.text();
      expect(html).toContain(message);
      expect(html).toMatch(/field--invalid[^]*?name="name"|name="name"[^>]*aria-invalid="true"/);
    }
    expect((await row(o.id)).version).toBe(0);
    expect(await audits(o.id)).toHaveLength(0);
  });
  test('a messy name is stored and audited in its normalised form', async () => {
    const o = await newOrder();
    const phone = (await row(o.id)).phoneE164;
    const res = await submit(USERS.confirmer, o.ref, values({ phone, over: { name: '  Amina\u200f   Benali\t ', previewTotal: String(SUBTOTAL + 600), step: 'save' } }));
    expect(res.status).toBe(303);
    expect((await row(o.id)).name).toBe('Amina Benali');
    expect((await audits(o.id))[0]!.after).toEqual({ name: 'Amina Benali' });
  });
});
