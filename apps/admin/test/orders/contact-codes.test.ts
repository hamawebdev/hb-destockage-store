// AORD-6 — every DB-6 updateOrderContact result code maps to a page, never a 500. The admin's
// own checks (review step) normally catch most of them first, so the write is stubbed here to
// return each code directly; everything else (auth, CSRF, order, form, preview) is real, on D1.
// The switch is also exhaustive at compile time (never-check in routes/orders/index.tsx).
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { UpdateOrderContactResult } from '@hb/db';
import { harness, USERS, type Harness } from '../helpers.ts';
import { dbOf, insertOrder, postAs, refOf, seedGeoAndCatalog } from './fixtures.ts';

const stub = vi.hoisted(() => ({ result: { ok: false, code: 'not_found' } as UpdateOrderContactResult, calls: 0 }));
vi.mock('@hb/db', async (orig) => {
  const real = await orig<typeof import('@hb/db')>();
  return {
    ...real,
    updateOrderContact: async () => {
      stub.calls++;
      return stub.result;
    },
  };
});

let h: Harness;
const REF = refOf(9101);
let phone = '';
beforeAll(async () => {
  h = await harness();
  const db = dbOf(h.db);
  const cat = await seedGeoAndCatalog(db);
  await insertOrder(db, cat, { ref: REF, createdAt: Date.now(), status: 'new', phone: '+213661009101', name: 'Amina' });
  phone = '0661009101';
}, 300_000);
afterAll(async () => {
  await h?.close();
});
beforeEach(() => {
  stub.calls = 0;
});

const save = () =>
  postAs(h, USERS.owner, `/orders/${REF}/contact`, { version: '0', name: 'Amina B', phone, wilaya: '16', commune: '1601', address: '', previewTotal: '15200', step: 'save' });

describe('DB-6 result code → response', () => {
  test.each([
    ['name_required', 422, 'Indiquez le nom du client'],
    ['name_invalid', 422, 'Nom invalide'],
    ['phone_invalid', 422, 'Numéro de mobile algérien invalide'],
    ['commune_invalid', 422, 'Choisissez une commune de cette wilaya'],
    ['area_unavailable', 422, 'Livraison indisponible'],
    ['order_total_out_of_range', 422, 'dépasserait le plafond'],
    ['nothing_to_change', 422, 'Aucun changement'],
    ['forbidden', 403, 'ne peuvent plus être modifiées'],
    ['not_editable', 403, 'ne peuvent plus être modifiées'],
    ['version_conflict', 409, 'Commande modifiée entre-temps'],
    ['not_found', 404, ''],
  ] as const)('%s → %i', async (code, status, message) => {
    stub.result = { ok: false, code };
    const res = await save();
    expect(stub.calls).toBe(1);
    expect(res.status).toBe(status);
    if (message) expect(await res.text()).toContain(message);
  });
  test('name codes put the error on the name field (aria-invalid), in Arabic too', async () => {
    stub.result = { ok: false, code: 'name_invalid' };
    const html = await (await save()).text();
    expect(html).toMatch(/name="name"[^>]*aria-invalid="true"/);
    stub.result = { ok: false, code: 'name_required' };
    const ar = await (await postAs(h, USERS.ownerAr, `/orders/${REF}/contact`, { version: '0', name: 'Amina B', phone, wilaya: '16', commune: '1601', address: '', previewTotal: '15200', step: 'save' })).text();
    expect(ar).toContain('اكتب اسم الزبون');
  });
});
