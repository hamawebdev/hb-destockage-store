// POST /api/quote and AdminTableFeeProvider against a real local D1 in workerd. Plan WEB-0 §2.1, §5.
import { vi } from 'vitest';
// workerd round trips are slow on a loaded shared host: a timeout here is not a failure of the code.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 90_000 });
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as v from 'valibot';
import { createDb } from '@hb/db';
import { checkFeeProviderConformance, QuoteResponseSchema, WILAYA_CODE_MAX } from '@hb/shared';
import { createAdminTableFeeProvider } from '../src/fees/admin-table.ts';
import { postJson, startSeeded, type Started } from './support/harness.ts';

let h: Started;
beforeAll(async () => {
  h = await startSeeded();
}, 60_000);
afterAll(async () => {
  await h?.server.close();
});

/** POST /api/quote; every JSON body must match shared's strict QuoteResponse schema. */
async function quote(body: unknown, headers?: Record<string, string>) {
  const res = await postJson(h.server, '/api/quote', body, headers);
  const json: unknown = await res.clone().json();
  const r = v.safeParse(QuoteResponseSchema, json);
  if (!r.success) throw new Error(`not a QuoteResponse (${res.status}): ${JSON.stringify(json)}`);
  return res;
}

describe('POST /api/quote', () => {
  test('200 with server prices, admin fee and total; no-store, no cookie', async () => {
    const res = await quote({ items: [{ variantId: 11, qty: 1 }], wilayaCode: 16, communeId: 1601 });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.json()).toEqual({
      ok: true,
      available: true,
      lines: [{ variantId: 11, qty: 1, unitPriceDzd: 14600, lineTotalDzd: 14600, maxQty: 10 }],
      subtotalDzd: 14600,
      feeDzd: 600,
      totalDzd: 15200,
      feeSource: 'table',
    });
  });

  test('communeId is optional (wilaya picked, commune not yet)', async () => {
    const res = await quote({ items: [{ variantId: 21, qty: 2 }], wilayaCode: 16 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ totalDzd: 2 * 15500 + 600, lines: [{ maxQty: 3 }] });
  });

  test.each([
    ['row with available=0', 31, 3101],
    ['no fee row', 59, 5901],
  ])('wilaya not served (%s) → 200 available:false', async (_label, wilayaCode, communeId) => {
    const res = await quote({ items: [{ variantId: 11, qty: 1 }], wilayaCode, communeId });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ available: false, subtotalDzd: 14600, feeDzd: null, totalDzd: null });
  });

  test.each([
    ['inactive variant', 23],
    ['draft product', 31],
    ['archived product', 41],
    ['unknown variant', 999],
  ])('%s → 409 variant_unavailable with lines', async (_label, variantId) => {
    const res = await quote({ items: [{ variantId, qty: 1 }], wilayaCode: 16 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: 'variant_unavailable', lines: [{ variantId, maxQty: 0, unitPriceDzd: 0, lineTotalDzd: 0 }] });
  });

  test('more than the stock → 409 out_of_stock with maxQty', async () => {
    const res = await quote({ items: [{ variantId: 21, qty: 4 }], wilayaCode: 16 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: 'out_of_stock', lines: [{ variantId: 21, maxQty: 3 }] });
  });

  test('commune of another wilaya → 422 validation on communeId', async () => {
    const res = await quote({ items: [{ variantId: 11, qty: 1 }], wilayaCode: 16, communeId: 3101 });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, code: 'validation', errors: [{ field: 'communeId', code: 'commune_invalid' }] });
  });

  test('schema errors → 422 with field codes (Arabic digits accepted as numbers)', async () => {
    const ok = await quote({ items: [{ variantId: '١١', qty: '٢' }], wilayaCode: '١٦' });
    expect(ok.status).toBe(200);
    const bad = await quote({ items: [{ variantId: 11, qty: 11 }], wilayaCode: 70 });
    expect(bad.status).toBe(422);
    const body = (await bad.json()) as { code: string; errors: { field: string; code: string }[] };
    expect(body.code).toBe('validation');
    expect(body.errors).toEqual(expect.arrayContaining([{ field: 'wilayaCode', code: 'wilaya_invalid' }]));
    expect(body.errors.some((e) => e.field === 'items')).toBe(true);
  });

  test('transport guards: 400 bad JSON, 415 type, 413 size, 403 cross-site, 405 GET', async () => {
    expect((await quote('{nope')).status).toBe(400);
    expect((await quote('[1]')).status).toBe(400);
    const form = await h.server.fetch('/api/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'wilayaCode=16',
    });
    expect(form.status).toBe(415);
    const big = await quote({ items: [{ variantId: 11, qty: 1 }], wilayaCode: 16, pad: 'x'.repeat(9000) });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ ok: false, code: 'payload_too_large' });
    const cross = await quote({ items: [{ variantId: 11, qty: 1 }], wilayaCode: 16 }, { 'Sec-Fetch-Site': 'cross-site' });
    expect(cross.status).toBe(403);
    expect((await h.server.fetch('/api/quote')).status).toBe(405);
  });

  test('a fee edit applies to the very next quote (no cache)', async () => {
    await h.env.DB.prepare('update delivery_fees set fee_dzd = 750 where wilaya_code = 16').run();
    const res = await quote({ items: [{ variantId: 11, qty: 1 }], wilayaCode: 16 });
    expect(await res.json()).toMatchObject({ feeDzd: 750, totalDzd: 15350 });
    await h.env.DB.prepare('update delivery_fees set available = 0 where wilaya_code = 16').run();
    expect(await (await quote({ items: [{ variantId: 11, qty: 1 }], wilayaCode: 16 })).json()).toMatchObject({ available: false });
    await h.env.DB.prepare('update delivery_fees set fee_dzd = 600, available = 1 where wilaya_code = 16').run();
  });

  test('a price or stock edit applies to the very next quote', async () => {
    await h.env.DB.prepare('update variants set price_dzd = 15000, stock = 1 where id = 21').run();
    const res = await quote({ items: [{ variantId: 21, qty: 1 }], wilayaCode: 16 });
    expect(await res.json()).toMatchObject({ subtotalDzd: 15000, lines: [{ maxQty: 1 }] });
    await h.env.DB.prepare('update variants set price_dzd = 15500, stock = 3 where id = 21').run();
  });
});

describe('AdminTableFeeProvider (D1)', () => {
  test('passes shared conformance suite against local D1', async () => {
    const all = Array.from({ length: WILAYA_CODE_MAX }, (_, i) => i + 1);
    const failures = await checkFeeProviderConformance(createAdminTableFeeProvider(createDb(h.env.DB)), {
      served: { 16: 600 },
      unserved: all.filter((w) => w !== 16),
      source: 'table',
      communes: { 16: 1601 },
      communeIndependent: true,
      itemIndependent: true,
      failing: () => createAdminTableFeeProvider(createDb(brokenD1())),
    });
    expect(failures).toEqual([]);
  });


  test('served, unserved, missing row, out-of-range code', async () => {
    const p = createAdminTableFeeProvider(createDb(h.env.DB));
    const items = [{ variantId: 11, qty: 1, weightG: null, unitPriceDzd: 14600 }];
    expect(await p.quote({ wilayaCode: 16, communeId: 1601, items })).toEqual({ available: true, feeDzd: 600, source: 'table' });
    expect(await p.quote({ wilayaCode: 31, items })).toEqual({ available: false, feeDzd: null, source: 'table' });
    expect(await p.quote({ wilayaCode: 59, items })).toEqual({ available: false, feeDzd: null, source: 'table' });
    expect(await p.quote({ wilayaCode: 0, items })).toEqual({ available: false, feeDzd: null, source: 'table' });
    expect(await p.quote({ wilayaCode: 70, items })).toEqual({ available: false, feeDzd: null, source: 'table' });
  });
});

/** A D1 binding whose every query rejects (database down). */
function brokenD1(): D1Database {
  const down = () => Promise.reject(new Error('D1_ERROR: database unavailable'));
  const stmt = { bind: () => stmt, first: down, all: down, raw: down, run: down };
  return { prepare: () => stmt, batch: down, exec: down, dump: down, withSession: () => { throw new Error('unused'); } } as unknown as D1Database;
}
