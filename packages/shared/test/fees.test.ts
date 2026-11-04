import { expect, test } from 'vitest';
import { createStaticFeeProvider, isValidFeeQuote } from '../src/fees.ts';

const items = [{ variantId: 1, qty: 1, weightG: 1200, unitPriceDzd: 14600 }];

test('static provider: served, unserved and missing wilayas', async () => {
  const p = createStaticFeeProvider({ 16: 400, 31: 700, 11: null });
  expect(await p.quote({ wilayaCode: 16, items })).toEqual({ available: true, feeDzd: 400, source: 'table' });
  expect(await p.quote({ wilayaCode: 31, communeId: 3101, items })).toEqual({ available: true, feeDzd: 700, source: 'table' });
  expect(await p.quote({ wilayaCode: 11, items })).toEqual({ available: false, feeDzd: null, source: 'table' });
  expect(await p.quote({ wilayaCode: 69, items })).toEqual({ available: false, feeDzd: null, source: 'table' });
});

test('isValidFeeQuote', () => {
  expect(isValidFeeQuote({ available: true, feeDzd: 0, source: 'table' })).toBe(true);
  expect(isValidFeeQuote({ available: true, feeDzd: 500, source: 'courier:yalidine', etaDays: 2 })).toBe(true);
  expect(isValidFeeQuote({ available: false, feeDzd: null, source: 'table' })).toBe(true);
  for (const bad of [
    null,
    {},
    { available: true, feeDzd: 500.5, source: 'table' },
    { available: true, feeDzd: -1, source: 'table' },
    { available: true, feeDzd: null, source: 'table' },
    { available: false, feeDzd: 0, source: 'table' },
    { available: true, feeDzd: 500, source: 'yalidine' },
    { available: true, feeDzd: 500, source: 'table', etaDays: 1.5 },
  ]) {
    expect(isValidFeeQuote(bad)).toBe(false);
  }
});
