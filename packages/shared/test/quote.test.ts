/** SHARED-3 — quote assembly. */
import * as v from 'valibot';
import { describe, expect, test } from 'vitest';
import type { FeeQuote } from '../src/fees.ts';
import { MAX_ORDER_TOTAL_DZD } from '../src/money.ts';
import { buildQuote, checkOrderQuote, totalMatches, type PricedQuoteLine } from '../src/quote.ts';
import { ApiFailureSchema, QuoteResponseSchema } from '../src/responses.ts';

const line: PricedQuoteLine = { variantId: 12, qty: 2, unitPriceDzd: 14600, stock: null };
const served: FeeQuote = { available: true, feeDzd: 600, source: 'table' };
const unserved: FeeQuote = { available: false, feeDzd: null, source: 'table' };

describe('buildQuote', () => {
  test('served wilaya', () => {
    const q = buildQuote([line], served);
    expect(q).toEqual({
      ok: true,
      available: true,
      lines: [{ variantId: 12, qty: 2, unitPriceDzd: 14600, lineTotalDzd: 29200, maxQty: 10 }],
      subtotalDzd: 29200,
      feeDzd: 600,
      totalDzd: 29800,
      feeSource: 'table',
    });
    expect(v.is(QuoteResponseSchema, q)).toBe(true);
  });

  test('etaDays passed through only when present', () => {
    expect(buildQuote([line], { ...served, source: 'courier:yalidine', etaDays: 2 })).toMatchObject({
      feeSource: 'courier:yalidine',
      etaDays: 2,
    });
    expect('etaDays' in buildQuote([line], served)).toBe(false);
  });

  test('unserved wilaya: subtotal only, totals null', () => {
    const q = buildQuote([line], unserved);
    expect(q).toMatchObject({ ok: true, available: false, subtotalDzd: 29200, feeDzd: null, totalDzd: null });
    expect(v.is(QuoteResponseSchema, q)).toBe(true);
  });

  test('stock limits maxQty; over stock ⇒ out_of_stock with lines', () => {
    expect(buildQuote([{ ...line, stock: 5 }], served)).toMatchObject({ ok: true, lines: [{ maxQty: 5 }] });
    const q = buildQuote([{ ...line, qty: 3, stock: 2 }, { ...line, variantId: 13, qty: 1, stock: 0 }], served);
    expect(q).toMatchObject({ ok: false, code: 'out_of_stock', lines: [{ maxQty: 2 }, { maxQty: 0 }] });
    expect(v.is(QuoteResponseSchema, q)).toBe(true);
  });

  test('ceiling: order_total_out_of_range on total, or subtotal when unserved', () => {
    const atCeiling: PricedQuoteLine = { variantId: 1, qty: 10, unitPriceDzd: (MAX_ORDER_TOTAL_DZD - 600) / 10, stock: null };
    expect(buildQuote([atCeiling], served)).toMatchObject({ ok: true, totalDzd: MAX_ORDER_TOTAL_DZD });
    expect(buildQuote([{ ...atCeiling, unitPriceDzd: atCeiling.unitPriceDzd + 1 }], served)).toMatchObject({
      ok: false,
      code: 'order_total_out_of_range',
    });
    expect(buildQuote([{ ...atCeiling, unitPriceDzd: 1_000_001 }], unserved)).toMatchObject({
      ok: false,
      code: 'order_total_out_of_range',
    });
  });

  test('corrupt price throws MoneyError (Worker ⇒ server_error)', () => {
    expect(() => buildQuote([{ ...line, unitPriceDzd: 10.5 }], served)).toThrow('not_integer');
  });
});

test('totalMatches', () => {
  const q = buildQuote([line], served);
  expect(totalMatches(29800, q)).toBe(true);
  expect(totalMatches(29799, q)).toBe(false);
  expect(totalMatches(29200, buildQuote([line], unserved))).toBe(false);
  expect(totalMatches(29800, { ok: false, code: 'out_of_stock' })).toBe(false);
});

describe('checkOrderQuote (review r1 nit 1)', () => {
  test('match ⇒ ok with the quote', () => {
    const q = buildQuote([line], served);
    expect(checkOrderQuote(29800, q)).toEqual({ ok: true, quote: q });
  });
  test('each failure is a schema-valid ApiFailure with the right code', () => {
    const cases = [
      [checkOrderQuote(1, buildQuote([line], served)), 'total_changed'],
      [checkOrderQuote(29800, buildQuote([line], unserved)), 'delivery_unavailable'],
      [checkOrderQuote(29800, buildQuote([{ ...line, stock: 1 }], served)), 'out_of_stock'],
      [checkOrderQuote(29800, buildQuote([{ ...line, unitPriceDzd: 5_000_000 }], served)), 'order_total_out_of_range'],
    ] as const;
    for (const [res, code] of cases) {
      expect(res).toMatchObject({ ok: false, code });
      expect(v.is(ApiFailureSchema, res)).toBe(true);
    }
  });
});
