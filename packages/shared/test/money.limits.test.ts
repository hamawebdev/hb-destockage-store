/** SHARED-3 — quantity limits, total ceiling and computeTotals against a BigInt reference. */
import { describe, expect, test } from 'vitest';
import {
  MAX_ORDER_TOTAL_DZD,
  MAX_QTY_PER_LINE,
  MoneyError,
  checkLineQty,
  computeTotals,
  maxQtyFor,
} from '../src/money.ts';

test('constants (lead decisions)', () => {
  expect(MAX_QTY_PER_LINE).toBe(10);
  expect(MAX_ORDER_TOTAL_DZD).toBe(10_000_000);
});

test.each([
  [null, 10],
  [0, 0],
  [1, 1],
  [4, 4],
  [10, 10],
  [11, 10],
  [1_000_000, 10],
  [-3, 0],
  [2.7, 2],
  [Number.NaN, 0],
  [Number.POSITIVE_INFINITY, 0],
  [-0, 0],
])('maxQtyFor(%s) = %s', (stock, max) => {
  expect(maxQtyFor(stock)).toBe(max);
});

test.each([
  [1, null, 'ok'],
  [10, null, 'ok'],
  [11, null, 'qty_invalid'],
  [0, null, 'qty_invalid'],
  [-1, 5, 'qty_invalid'],
  [1.5, 5, 'qty_invalid'],
  [Number.NaN, 5, 'qty_invalid'],
  [3, 3, 'ok'],
  [4, 3, 'out_of_stock'],
  [1, 0, 'out_of_stock'],
  [10, 20, 'ok'],
  [11, 20, 'qty_invalid'],
])('checkLineQty(%s, stock %s) = %s', (qty, stock, want) => {
  expect(checkLineQty(qty, stock)).toBe(want);
});

describe('computeTotals', () => {
  test.each([
    [0, 'ok'],
    [1, 'ok'],
    [-0, 'ok'],
    [Number.MAX_SAFE_INTEGER, 'ok'],
    [Number.NaN, 'not_integer'],
    [Number.POSITIVE_INFINITY, 'not_integer'],
    [Number.NEGATIVE_INFINITY, 'not_integer'],
    [1e21, 'overflow'],
    [-1, 'negative'],
    ['5' as unknown as number, 'not_integer'],
  ])('fee %s → %s', (fee, want) => {
    if (want === 'ok') expect(computeTotals([], fee).totalDzd === fee).toBe(true); // -0 === 0
    else {
      try {
        computeTotals([], fee);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(MoneyError);
        expect((e as MoneyError).code).toBe(want);
      }
    }
  });

  test('2,000 seeded random orders agree with a BigInt reference, including near-overflow', () => {
    let a = 20261104 >>> 0;
    const next = (): number => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let ok = 0;
    let overflow = 0;
    for (let i = 0; i < 2000; i++) {
      const big = i % 10 === 0;
      const n = 1 + Math.floor(next() * 10);
      const lines = Array.from({ length: n }, (_, j) => ({
        variantId: j + 1,
        qty: 1 + Math.floor(next() * 10),
        unitPriceDzd: big ? Math.floor(next() * Number.MAX_SAFE_INTEGER) : Math.floor(next() * 200_000),
      }));
      const fee = Math.floor(next() * 2000);
      const ref = lines.reduce((s, l) => s + BigInt(l.unitPriceDzd) * BigInt(l.qty), 0n) + BigInt(fee);
      if (ref > BigInt(Number.MAX_SAFE_INTEGER)) {
        expect(() => computeTotals(lines, fee)).toThrow(MoneyError);
        overflow++;
      } else {
        const t = computeTotals(lines, fee);
        expect(BigInt(t.totalDzd)).toBe(ref);
        expect(t.lines.every((l) => l.lineTotalDzd === l.unitPriceDzd * l.qty)).toBe(true);
        ok++;
      }
    }
    expect(ok).toBeGreaterThan(1500);
    expect(overflow).toBeGreaterThan(50);
  });
});
