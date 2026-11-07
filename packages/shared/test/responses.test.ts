/** SHARED-3 — response-body schemas. */
import * as v from 'valibot';
import { describe, expect, test } from 'vitest';
import type { ApiFailure, OrderSuccess, QuoteSuccess } from '../src/order-schema.ts';
import {
  ApiFailureSchema,
  OrderResponseSchema,
  OrderSuccessSchema,
  QuoteResponseSchema,
  QuoteSuccessSchema,
} from '../src/responses.ts';

// Compile-time: a schema-validated body is assignable to the contract type.
const _q: QuoteSuccess = null as unknown as v.InferOutput<typeof QuoteSuccessSchema>;
const _o: OrderSuccess = null as unknown as v.InferOutput<typeof OrderSuccessSchema>;
const _f: ApiFailure = null as unknown as v.InferOutput<typeof ApiFailureSchema>;
void [_q, _o, _f];

const line = { variantId: 12, qty: 1, unitPriceDzd: 14600, lineTotalDzd: 14600, maxQty: 4 };
const quote = { ok: true, available: true, lines: [line], subtotalDzd: 14600, feeDzd: 600, totalDzd: 15200, feeSource: 'table' };
const order = {
  ok: true,
  ref: 'HB-7K2Q9',
  status: 'new',
  duplicate: false,
  subtotalDzd: 14600,
  feeDzd: 600,
  totalDzd: 15200,
  confirmationUrl: '/ar/order/confirmation/?ref=HB-7K2Q9',
};

describe('quote bodies', () => {
  test('valid', () => {
    expect(v.is(QuoteResponseSchema, quote)).toBe(true);
    expect(v.is(QuoteResponseSchema, { ...quote, available: false, feeDzd: null, totalDzd: null })).toBe(true);
    expect(v.is(QuoteResponseSchema, { ...quote, feeSource: 'courier:yalidine', etaDays: 2 })).toBe(true);
    expect(v.is(QuoteResponseSchema, { ok: false, code: 'out_of_stock', lines: [{ ...line, maxQty: 0 }] })).toBe(true);
  });
  test.each([
    ['inconsistent total', { ...quote, totalDzd: 15201 }],
    ['inconsistent subtotal', { ...quote, subtotalDzd: 1 }],
    ['inconsistent line', { ...quote, lines: [{ ...line, lineTotalDzd: 1 }] }],
    ['fractional fee', { ...quote, feeDzd: 600.5, totalDzd: 15200.5 }],
    ['unavailable with a fee', { ...quote, available: false, totalDzd: null }],
    ['leaked field', { ...quote, phone: '+213560417403' }],
    ['bad source', { ...quote, feeSource: 'yalidine' }],
    ['qty over 10', { ...quote, lines: [{ ...line, qty: 11, lineTotalDzd: 160600 }], subtotalDzd: 160600, totalDzd: 161200 }],
  ])('%s is rejected', (_name, body) => {
    expect(v.is(QuoteResponseSchema, body)).toBe(false);
  });
});

describe('order bodies', () => {
  test('valid', () => {
    expect(v.is(OrderResponseSchema, order)).toBe(true);
    expect(v.is(OrderResponseSchema, { ...order, duplicate: true, status: 'called' })).toBe(true);
    expect(
      v.is(OrderResponseSchema, { ok: false, code: 'validation', errors: [{ field: 'items', code: 'qty_invalid', index: 0 }] }),
    ).toBe(true);
    expect(v.is(OrderResponseSchema, { ok: false, code: 'total_changed', quote })).toBe(true);
    expect(v.is(OrderResponseSchema, { ok: false, code: 'rate_limited', retryAfterS: 60 })).toBe(true);
  });
  test.each([
    ['bad ref', { ...order, ref: 'HB-7K2O9', confirmationUrl: '/ar/order/confirmation/?ref=HB-7K2O9' }],
    ['url for another ref', { ...order, confirmationUrl: '/ar/order/confirmation/?ref=HB-7K2Q8' }],
    ['url with other lang', { ...order, confirmationUrl: '/en/order/confirmation/?ref=HB-7K2Q9' }],
    ['inconsistent total', { ...order, totalDzd: 1 }],
    ['unknown status', { ...order, status: 'paid' }],
    ['leaked name', { ...order, name: 'Amine' }],
    ['unknown code', { ok: false, code: 'price_changed' }],
    ['unknown field', { ok: false, code: 'validation', errors: [{ field: 'email', code: 'name_invalid' }] }],
    ['leak in failure', { ok: false, code: 'server_error', stack: 'at …' }],
  ])('%s is rejected', (_name, body) => {
    expect(v.is(OrderResponseSchema, body)).toBe(false);
  });
});
