/**
 * Delivery-fee contract (BRIEF §2 "Fees are swappable").
 *
 * The Worker answers `/api/quote` and `/api/order` through a `FeeProvider`. Today's provider
 * (in `apps/web`) reads the admin-set fee per wilaya from D1 (`delivery_fees`); a courier-API
 * provider replaces it later without touching the storefront or the order flow.
 * Every implementation must pass `runFeeProviderConformance` (SHARED-3).
 */

import type { CommuneId, VariantId, WilayaCode } from './ids.ts';
import { isDzd, type Dzd } from './money.ts';

/**
 * Where a fee came from; stored in `orders.fee_source`.
 * `table` = admin fee table in D1; `courier:<name>` = a courier API (e.g. `courier:yalidine`).
 */
export type FeeSource = 'table' | `courier:${string}`;

export interface FeeQuoteItem {
  readonly variantId: VariantId;
  readonly qty: number;
  /** `variants.weight_g`; null when unknown. Courier providers may price by weight. */
  readonly weightG: number | null;
  readonly unitPriceDzd: Dzd;
}

export interface FeeQuoteRequest {
  readonly wilayaCode: WilayaCode;
  /** Absent while the customer has picked a wilaya but not yet a commune (live quote). */
  readonly communeId?: CommuneId | undefined;
  readonly items: readonly FeeQuoteItem[];
}

export type FeeQuote =
  | {
      readonly available: true;
      readonly feeDzd: Dzd;
      readonly source: FeeSource;
      /** Estimated delivery time in days, when the provider knows it. */
      readonly etaDays?: number | undefined;
    }
  | {
      /** No delivery to this wilaya/commune: the order form must not let the customer confirm. */
      readonly available: false;
      readonly feeDzd: null;
      readonly source: FeeSource;
    };

export interface FeeProvider {
  /**
   * Quotes the delivery fee. Must not throw for an unknown or unserved wilaya/commune
   * (return `available: false`); may throw (reject) only on infrastructure failure, which the
   * Worker maps to error code `server_error`.
   */
  quote(req: FeeQuoteRequest): Promise<FeeQuote>;
}

/** Runtime check of a provider's answer (integer DZD, consistent `available`/`feeDzd`). */
export function isValidFeeQuote(value: unknown): value is FeeQuote {
  if (typeof value !== 'object' || value === null) return false;
  const q = value as Record<string, unknown>;
  if (q['source'] !== 'table' && !(typeof q['source'] === 'string' && /^courier:[a-z0-9_-]+$/.test(q['source']))) {
    return false;
  }
  if (q['available'] === true) {
    const eta = q['etaDays'];
    return isDzd(q['feeDzd']) && (eta === undefined || (typeof eta === 'number' && Number.isInteger(eta) && eta >= 0));
  }
  return q['available'] === false && q['feeDzd'] === null;
}

/**
 * In-memory provider for tests and local fixtures: one fee per wilaya, `null`/missing = not served.
 * Not used in production (the D1-backed provider lives in `apps/web`).
 */
export function createStaticFeeProvider(
  fees: Readonly<Partial<Record<WilayaCode, Dzd | null>>>,
  source: FeeSource = 'table',
): FeeProvider {
  return {
    quote(req) {
      const fee = fees[req.wilayaCode];
      return Promise.resolve(
        fee === undefined || fee === null
          ? { available: false, feeDzd: null, source }
          : { available: true, feeDzd: fee, source },
      );
    },
  };
}
