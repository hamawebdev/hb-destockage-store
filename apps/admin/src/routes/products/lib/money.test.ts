import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { MAX_ORDER_TOTAL_DZD, orderCeiling, parseDzd, vDzd, vOptionalDzd } from './money.ts';

describe('parseDzd', () => {
  it.each([
    ['2500', 2500],
    ['0', 0],
    [' 600 ', 600],
    ['14.600', 14600],
    ['14 600', 14600],
    ['14 600', 14600],
    ['1,500,000', 1500000],
    ['٢٥٠٠', 2500],
    ['۶۰۰', 600],
    ['١٤.٦٠٠', 14600],
  ])('%j → %d', (input, out) => {
    expect(parseDzd(input, 10_000_000)).toBe(out);
  });

  it.each(['', '1.5', '1500.00', '14.60', '-1', '+5', '1e3', '0x10', '9007199254740993', '1.500,000', '12 34', 'abc', '١٫٥', '10000001'])('rejects %j', (input) => {
    expect(parseDzd(input, 10_000_000)).toBeNull();
  });
});

describe('valibot fields', () => {
  it('vDzd: required, integer', () => {
    expect(v.safeParse(vDzd(100), '50').output).toBe(50);
    const empty = v.safeParse(vDzd(100), '');
    expect(empty.success).toBe(false);
    expect(empty.issues?.[0]?.message).toBe('form.required');
    expect(v.safeParse(vDzd(100), '1.5').success).toBe(false);
    expect(v.safeParse(vDzd(100), '101').success).toBe(false);
  });
  it('vOptionalDzd: blank → null, invalid refused', () => {
    expect(v.safeParse(vOptionalDzd(100), '').output).toBeNull();
    expect(v.safeParse(vOptionalDzd(100), undefined).output).toBeNull();
    expect(v.safeParse(vOptionalDzd(100), '40').output).toBe(40);
    expect(v.safeParse(vOptionalDzd(100), '1.5').success).toBe(false);
  });
});

describe('orderCeiling', () => {
  it('flags prices that cannot be ordered or cap the quantity', () => {
    expect(orderCeiling(16_500)).toEqual({ kind: 'ok' });
    expect(orderCeiling(MAX_ORDER_TOTAL_DZD + 1)).toEqual({ kind: 'unorderable' });
    expect(orderCeiling(3_000_000)).toEqual({ kind: 'maxQty', maxQty: 3 });
  });
});
