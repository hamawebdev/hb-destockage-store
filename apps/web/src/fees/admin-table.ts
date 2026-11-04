/**
 * Today's FeeProvider: the admin-set home-delivery fee per wilaya (`delivery_fees` in D1).
 * BRIEF §2 "Fees are swappable": a courier-API provider replaces this later without touching the
 * storefront or the order flow. Plan: artifacts/WEB-0/plan.md §5.
 *
 * Hono-free on purpose: the admin (`@hb/web/fees`) imports it so its fee-editor preview runs the
 * same code as `/api/quote`.
 *
 * Semantics (shared `FeeProvider` contract):
 * - no row, or `available = 0`, or a code outside 1–69 ⇒ `{available:false, feeDzd:null}`;
 * - a D1 failure rejects (the Worker maps it to `server_error`);
 * - **no caching**: an admin fee edit applies to the very next quote (WEB-2 latency note:
 *   artifacts/WEB-2/latency.md, DECISIONS.md D-002).
 * The commune is accepted but not used: today's fee is per wilaya.
 */
import { eq } from 'drizzle-orm';
import { deliveryFees, type Db } from '@hb/db';
import { isWilayaCode, type FeeProvider, type FeeQuote, type FeeSource } from '@hb/shared';

export const ADMIN_TABLE_FEE_SOURCE: FeeSource = 'table';

const UNAVAILABLE: FeeQuote = { available: false, feeDzd: null, source: ADMIN_TABLE_FEE_SOURCE };

export function createAdminTableFeeProvider(db: Db): FeeProvider {
  return {
    async quote(req) {
      if (!isWilayaCode(req.wilayaCode)) return UNAVAILABLE;
      const row = await db
        .select({ feeDzd: deliveryFees.feeDzd, available: deliveryFees.available })
        .from(deliveryFees)
        .where(eq(deliveryFees.wilayaCode, req.wilayaCode))
        .get();
      if (row === undefined || !row.available) return UNAVAILABLE;
      return { available: true, feeDzd: row.feeDzd, source: ADMIN_TABLE_FEE_SOURCE };
    },
  };
}
