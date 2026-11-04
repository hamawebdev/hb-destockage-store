/**
 * Server-side pricing from D1 values (never from the client), used by `/api/quote` and, with
 * fresh reads, by `/api/order`. Plan: artifacts/WEB-0/plan.md §2.1, §3 layer 6, §5.
 *
 * Checks owned here (they need the D1 reads): the commune belongs to the wilaya, and every variant
 * exists, is active and belongs to an active product. Stock, totals, the order-total ceiling and
 * the body shape are `@hb/shared` `buildQuote` (one implementation for quote and order).
 */
import {
  buildQuote,
  isValidFeeQuote,
  maxQtyFor,
  type ApiFailure,
  type FeeProvider,
  type QuoteLine,
  type QuoteSuccess,
} from '@hb/shared';
import type { PricingReads } from './catalog-reads.ts';

export interface QuoteRequest {
  readonly items: readonly { readonly variantId: number; readonly qty: number }[];
  readonly wilayaCode: number;
  readonly communeId?: number | undefined;
}

export class FeeProviderError extends Error {
  override readonly name = 'FeeProviderError';
}

export async function quoteFromReads(
  req: QuoteRequest,
  reads: PricingReads,
  fees: FeeProvider,
): Promise<QuoteSuccess | ApiFailure> {
  if (req.communeId !== undefined && reads.communeWilaya !== req.wilayaCode) {
    return { ok: false, code: 'validation', errors: [{ field: 'communeId', code: 'commune_invalid' }] };
  }

  if (req.items.some(({ variantId }) => reads.variants.get(variantId)?.sellable !== true)) {
    const lines: QuoteLine[] = req.items.map(({ variantId, qty }) => {
      const v = reads.variants.get(variantId);
      const unitPriceDzd = v?.priceDzd ?? 0;
      const maxQty = v?.sellable === true ? maxQtyFor(v.stock) : 0;
      return { variantId, qty, unitPriceDzd, lineTotalDzd: unitPriceDzd * qty, maxQty };
    });
    return { ok: false, code: 'variant_unavailable', lines };
  }

  const priced = req.items.map(({ variantId, qty }) => {
    const v = reads.variants.get(variantId)!;
    return { variantId, qty, unitPriceDzd: v.priceDzd, stock: v.stock, weightG: v.weightG };
  });
  const fee = await fees.quote({
    wilayaCode: req.wilayaCode,
    communeId: req.communeId,
    items: priced.map(({ variantId, qty, weightG, unitPriceDzd }) => ({ variantId, qty, weightG, unitPriceDzd })),
  });
  // A provider answering garbage is an infrastructure fault, never a price.
  if (!isValidFeeQuote(fee)) throw new FeeProviderError('FeeProvider returned an invalid quote');
  return buildQuote(priced, fee);
}
