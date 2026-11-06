/**
 * Order ceiling for prices (ACAT-2). Price inputs are parsed by admin-core's `vMoneyDzd` /
 * `vOptionalMoneyDzd` (lib/forms.ts, the single money parser).
 *
 * @hb/shared SHARED-3 adds `MAX_ORDER_TOTAL_DZD` (10,000,000) and the order flow refuses totals above
 * it. SHARED-3 is not on main yet, so the same value is declared here.
 * TODO(SHARED-3): replace with `import { MAX_ORDER_TOTAL_DZD } from '@hb/shared'` in the first commit
 * after SHARED-3 is on main.
 */
import { MAX_QTY_PER_LINE } from '@hb/shared';

export const MAX_ORDER_TOTAL_DZD = 10_000_000;

/** How a unit price interacts with the order ceiling (warnings on the variant grid). */
export function orderCeiling(priceDzd: number): { kind: 'ok' } | { kind: 'unorderable' } | { kind: 'maxQty'; maxQty: number } {
  if (priceDzd > MAX_ORDER_TOTAL_DZD) return { kind: 'unorderable' };
  const maxQty = Math.floor(MAX_ORDER_TOTAL_DZD / Math.max(priceDzd, 1));
  return maxQty < MAX_QTY_PER_LINE ? { kind: 'maxQty', maxQty } : { kind: 'ok' };
}
