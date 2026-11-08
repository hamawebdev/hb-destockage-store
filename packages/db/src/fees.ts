// DB-6 — `@hb/db/fees`: today's FeeProvider, the admin-set home-delivery fee per wilaya
// (`delivery_fees`). Hono-free, Drizzle only. Imported by web (/api/quote, /api/order), the admin
// fee-editor preview (ACAT-4) and the admin re-quote on contact edits (AORD-2 / updateOrderContact).
// Started from web's apps/web/src/fees/admin-table.ts @7a9b783 (lead ruling).
//
// Semantics (`@hb/shared` FeeProvider contract, checked by its conformance suite in tests):
// - wilaya outside 1–69, no row, or `available = 0` ⇒ `{available:false, feeDzd:null}`;
// - `placeholder = 1` (an invented seed fee) ⇒ unavailable, unless the caller passes
//   `allowPlaceholderFees: true` (local development only). No invented fee is ever charged.
// - a D1 failure rejects (the Worker maps it to `server_error`);
// - no cache by default: an admin fee edit applies to the very next quote (D-002). An optional
//   cache must be bounded (entries and TTL).
// The commune is accepted but not used: today's fee is per wilaya.
import { eq } from 'drizzle-orm';
import { isWilayaCode, type FeeProvider, type FeeQuote, type FeeSource } from '@hb/shared';
import { deliveryFees } from './schema.ts';
import type { Db } from './index.ts';

export const ADMIN_TABLE_FEE_SOURCE: FeeSource = 'table';

const UNAVAILABLE: FeeQuote = { available: false, feeDzd: null, source: ADMIN_TABLE_FEE_SOURCE };

export interface AdminTableFeeProviderOptions {
  /** Serve fees marked `placeholder` (seeded, invented). Local development only. Default false. */
  readonly allowPlaceholderFees?: boolean;
  /**
   * Read attempts on a D1 error (default 2: one retry) and the pause between them (default 25 ms,
   * kept short: /api/order waits on it). If every attempt fails the quote REJECTS (server_error),
   * never "no delivery" (DB-6 r1: transient D1 read failures; D1 docs recommend retrying reads).
   */
  readonly retry?: { readonly attempts?: number; readonly backoffMs?: number };
  /** Optional bounded cache. Omitted = no cache (the default and what /api/order must use). */
  readonly cache?: { readonly ttlMs: number; readonly maxEntries?: number; readonly now?: () => number };
}

export function createAdminTableFeeProvider(db: Db, opts: AdminTableFeeProviderOptions = {}): FeeProvider {
  const allowPlaceholder = opts.allowPlaceholderFees === true;
  const cache = opts.cache;
  const entries = new Map<number, { at: number; quote: FeeQuote }>();
  const maxEntries = Math.min(Math.max(1, cache?.maxEntries ?? 69), 69);
  const clock = cache?.now ?? Date.now;

  const attempts = Math.min(Math.max(1, Math.trunc(opts.retry?.attempts ?? 2)), 3);
  const backoffMs = Math.min(Math.max(0, opts.retry?.backoffMs ?? 25), 100);

  async function read(wilayaCode: number): Promise<FeeQuote> {
    for (let i = 1; ; i++) {
      try {
        return await readOnce(wilayaCode);
      } catch (err) {
        if (i >= attempts) throw err;
        if (backoffMs > 0) await new Promise((r) => setTimeout(r, backoffMs * i));
      }
    }
  }

  async function readOnce(wilayaCode: number): Promise<FeeQuote> {
    const row = await db
      .select({ feeDzd: deliveryFees.feeDzd, available: deliveryFees.available, placeholder: deliveryFees.placeholder })
      .from(deliveryFees)
      .where(eq(deliveryFees.wilayaCode, wilayaCode))
      .get();
    if (row === undefined || !row.available) return UNAVAILABLE;
    if (row.placeholder && !allowPlaceholder) return UNAVAILABLE;
    return { available: true, feeDzd: row.feeDzd, source: ADMIN_TABLE_FEE_SOURCE };
  }

  return {
    async quote(req) {
      if (!isWilayaCode(req.wilayaCode)) return UNAVAILABLE;
      if (!cache) return read(req.wilayaCode);
      const hit = entries.get(req.wilayaCode);
      if (hit && clock() - hit.at < cache.ttlMs) return hit.quote;
      const quote = await read(req.wilayaCode);
      entries.delete(req.wilayaCode);
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
      entries.set(req.wilayaCode, { at: clock(), quote });
      return quote;
    },
  };
}
