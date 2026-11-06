/**
 * Quote assembly (SHARED-3): the one place that turns priced lines and a FeeQuote into the
 * `/api/quote` body — and into the fresh `quote` that `/api/order` attaches to `total_changed`,
 * `out_of_stock` and `delivery_unavailable`. Pure maths; `web` owns the D1 reads.
 */

import type { FeeQuote } from './fees.ts';
import type { VariantId } from './ids.ts';
import { MAX_ORDER_TOTAL_DZD, computeTotals, maxQtyFor, type Dzd } from './money.ts';
import type { ApiFailure, QuoteLine, QuoteResponse, QuoteSuccess } from './order-schema.ts';

export interface PricedQuoteLine {
  readonly variantId: VariantId;
  /** Requested quantity, already validated to 1…MAX_QTY_PER_LINE by the request schema. */
  readonly qty: number;
  /** Current `variants.price_dzd` read from D1 (never from the client). */
  readonly unitPriceDzd: Dzd;
  /** `variants.stock`; `null` = untracked. */
  readonly stock: number | null;
}

/**
 * Builds the quote body. Returns `out_of_stock` (with per-line `maxQty`) when a line asks for
 * more than is available, and `order_total_out_of_range` when the total (or the subtotal, if
 * delivery is unavailable) exceeds MAX_ORDER_TOTAL_DZD. The ceiling is enforced here, not in
 * `computeTotals` (pure arithmetic): any code that prices an order — including an admin
 * re-quote — must go through `buildQuote` to get it. Throws `MoneyError` only on corrupt
 * data (non-integer or unsafe amounts), which the Worker maps to `server_error`.
 */
export function buildQuote(lines: readonly PricedQuoteLine[], fee: FeeQuote): QuoteSuccess | ApiFailure {
  const totals = computeTotals(lines, fee.available ? fee.feeDzd : 0);
  const out: QuoteLine[] = totals.lines.map((l) => ({
    variantId: l.variantId,
    qty: l.qty,
    unitPriceDzd: l.unitPriceDzd,
    lineTotalDzd: l.lineTotalDzd,
    maxQty: maxQtyFor(l.stock),
  }));
  if (out.some((l) => l.qty > l.maxQty)) return { ok: false, code: 'out_of_stock', lines: out };
  const ceilingBase = fee.available ? totals.totalDzd : totals.subtotalDzd;
  if (ceilingBase > MAX_ORDER_TOTAL_DZD) return { ok: false, code: 'order_total_out_of_range', lines: out };
  if (!fee.available) {
    return {
      ok: true,
      available: false,
      lines: out,
      subtotalDzd: totals.subtotalDzd,
      feeDzd: null,
      totalDzd: null,
      feeSource: fee.source,
    };
  }
  const base = {
    ok: true,
    available: true,
    lines: out,
    subtotalDzd: totals.subtotalDzd,
    feeDzd: totals.feeDzd,
    totalDzd: totals.totalDzd,
    feeSource: fee.source,
  } as const;
  return fee.etaDays === undefined ? base : { ...base, etaDays: fee.etaDays };
}

/**
 * True only when the quote is deliverable and its total equals what the customer saw.
 * Use `checkOrderQuote` on `/api/order`: it also picks the right failure code.
 */
export function totalMatches(expectedTotalDzd: number, quote: QuoteResponse): boolean {
  return quote.ok && quote.available && quote.totalDzd === expectedTotalDzd;
}

type AvailableQuote = Extract<QuoteSuccess, { available: true }>;

/**
 * `/api/order` decision on the freshly built quote, in this order:
 * - `buildQuote` failed (`out_of_stock`, `order_total_out_of_range`) ⇒ that failure, unchanged;
 * - delivery unavailable ⇒ `delivery_unavailable` with the (available:false) quote;
 * - total ≠ `expectedTotalDzd` ⇒ `total_changed` with the fresh quote (nothing is created);
 * - otherwise `{ ok: true, quote }` and the order may be written.
 * Every failure is a valid `ApiFailure` (its `quote` is always a QuoteSuccess, never a failure).
 */
export function checkOrderQuote(
  expectedTotalDzd: number,
  quote: QuoteSuccess | ApiFailure,
): { readonly ok: true; readonly quote: AvailableQuote } | ApiFailure {
  if (!quote.ok) return quote;
  if (!quote.available) return { ok: false, code: 'delivery_unavailable', quote };
  if (quote.totalDzd !== expectedTotalDzd) return { ok: false, code: 'total_changed', quote };
  return { ok: true, quote };
}
