import { describe, expect, test } from 'vitest';
import { MoneyError, computeTotals, isDzd } from '../src/money.ts';

describe('computeTotals', () => {
  test('sums integer lines and fee, carrying extra fields', () => {
    const t = computeTotals(
      [
        { variantId: 1, unitPriceDzd: 14600, qty: 2 },
        { variantId: 2, unitPriceDzd: 16500, qty: 1 },
      ],
      600,
    );
    expect(t.lines.map((l) => [l.variantId, l.lineTotalDzd])).toEqual([
      [1, 29200],
      [2, 16500],
    ]);
    expect(t.subtotalDzd).toBe(45700);
    expect(t.feeDzd).toBe(600);
    expect(t.totalDzd).toBe(46300);
  });

  test('empty lines', () => {
    expect(computeTotals([], 0)).toEqual({ lines: [], subtotalDzd: 0, feeDzd: 0, totalDzd: 0 });
  });

  test.each([
    [[{ unitPriceDzd: 10.5, qty: 1 }], 0, 'not_integer'],
    [[{ unitPriceDzd: 10, qty: 1.5 }], 0, 'not_integer'],
    [[{ unitPriceDzd: -1, qty: 1 }], 0, 'negative'],
    [[{ unitPriceDzd: 10, qty: 0 }], 0, 'negative'],
    [[{ unitPriceDzd: 10, qty: 1 }], -5, 'negative'],
    [[{ unitPriceDzd: 10, qty: 1 }], 0.5, 'not_integer'],
    [[{ unitPriceDzd: Number.NaN, qty: 1 }], 0, 'not_integer'],
    [[{ unitPriceDzd: Number.MAX_SAFE_INTEGER, qty: 2 }], 0, 'overflow'],
    [[{ unitPriceDzd: Number.MAX_SAFE_INTEGER, qty: 1 }, { unitPriceDzd: 1, qty: 1 }], 0, 'overflow'],
    [[{ unitPriceDzd: Number.MAX_SAFE_INTEGER, qty: 1 }], 1, 'overflow'],
    [[{ unitPriceDzd: 2 ** 60, qty: 1 }], 0, 'overflow'],
  ])('rejects %j fee %d with %s', (lines, fee, code) => {
    expect(() => computeTotals(lines, fee)).toThrow(MoneyError);
    try {
      computeTotals(lines, fee);
    } catch (e) {
      expect((e as MoneyError).code).toBe(code);
    }
  });
});

test('isDzd', () => {
  expect(isDzd(0)).toBe(true);
  expect(isDzd(16500)).toBe(true);
  for (const x of [-1, 1.5, Number.NaN, Infinity, 2 ** 53, '1', null]) expect(isDzd(x)).toBe(false);
});
