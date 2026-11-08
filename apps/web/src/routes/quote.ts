/**
 * POST /api/quote — live price / fee / total for the enhanced order form (after LCP, on input).
 * JSON only. Plan: artifacts/WEB-0/plan.md §2.1, §5. Contract: `@hb/shared` QuoteInput / QuoteResponse.
 *
 * Responses (Cache-Control: no-store via the /api/* middleware):
 *   200 QuoteSuccess (available true, or false when the wilaya is not served)
 *   409 variant_unavailable | out_of_stock, with `lines` (per-line maxQty)
 *   422 order_total_out_of_range (sanity ceiling, shared MAX_ORDER_TOTAL_DZD)
 *   422 validation (errors[]), 400 invalid_request, 403/413/415 transport, 503 server_error
 */
import type { Hono } from 'hono';
import { createDb } from '@hb/db';
import { failureCode, parseQuoteInput } from '@hb/shared';
import type { Env } from '../env.ts';
import { readPricing } from '../catalog-reads.ts';
import { feeProvider } from '../fees.ts';
import { log } from '../http.ts';
import { quoteFromReads } from '../quote.ts';
import { failure, parseJsonObject, readBody } from '../request.ts';

export function registerQuote(app: Hono<{ Bindings: Env }>): void {
  app.post('/api/quote', async (c) => {
    const body = await readBody(c.req.raw, ['json']);
    if (!body.ok) return failure(c, { code: body.code });

    const parsed = parseQuoteInput(parseJsonObject(body.text));
    if (!parsed.ok) return failure(c, { code: failureCode(parsed.errors), errors: parsed.errors });
    const input = parsed.value;

    try {
      const db = createDb(c.env.DB);
      const reads = await readPricing(
        db,
        input.items.map((i) => i.variantId),
        input.communeId,
      );
      const result = await quoteFromReads(input, reads, feeProvider(db, c.env));
      if (result.ok) return c.json(result, 200);
      const { ok: _ok, ...rest } = result;
      return failure(c, rest);
    } catch (err) {
      log('quote_error', { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
      return failure(c, { code: 'server_error' });
    }
  });
  app.all('/api/quote', (c) => c.json({ ok: false, code: 'method_not_allowed' }, 405, { Allow: 'POST' }));
}
