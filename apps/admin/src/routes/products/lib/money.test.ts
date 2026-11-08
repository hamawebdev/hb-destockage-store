import { describe, expect, it } from 'vitest';
import { MAX_ORDER_TOTAL_DZD, orderCeiling } from './money.ts';

describe('orderCeiling', () => {
  it('flags prices that cannot be ordered or cap the quantity', () => {
    expect(orderCeiling(16_500)).toEqual({ kind: 'ok' });
    expect(orderCeiling(MAX_ORDER_TOTAL_DZD + 1)).toEqual({ kind: 'unorderable' });
    expect(orderCeiling(3_000_000)).toEqual({ kind: 'maxQty', maxQty: 3 });
  });
});
