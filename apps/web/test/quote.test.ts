// Unit tests of the pricing service (no D1): commune, availability, stock, fee, totals. Plan WEB-0 §5.
import { describe, expect, test } from 'vitest';
import { createStaticFeeProvider, QuoteResponseSchema, type FeeProvider } from '@hb/shared';
import * as v from 'valibot';
import type { PricingReads, VariantForSale } from '../src/catalog-reads.ts';
import { FeeProviderError, quoteFromReads } from '../src/quote.ts';

const variant = (id: number, priceDzd: number, stock: number | null, sellable = true): VariantForSale => ({
  id,
  productId: 1,
  priceDzd,
  stock,
  weightG: 1000,
  sellable,
});

function reads(list: VariantForSale[], communeWilaya?: number | null): PricingReads {
  return { variants: new Map(list.map((x) => [x.id, x])), communeWilaya };
}

const fees = createStaticFeeProvider({ 16: 600, 31: null });

/** Every body we send must match shared's strict response schema. */
function wire<T>(body: T): T {
  const r = v.safeParse(QuoteResponseSchema, body);
  if (!r.success) throw new Error(`not a QuoteResponse: ${JSON.stringify(r.issues.map((i) => i.message))}`);
  return body;
}

describe('quoteFromReads', () => {
  test('served wilaya: integer totals from server prices', async () => {
    const out = wire(
      await quoteFromReads(
        { items: [{ variantId: 11, qty: 2 }, { variantId: 21, qty: 1 }], wilayaCode: 16, communeId: 1601 },
        reads([variant(11, 14600, null), variant(21, 15500, 3)], 16),
        fees,
      ),
    );
    expect(out).toEqual({
      ok: true,
      available: true,
      lines: [
        { variantId: 11, qty: 2, unitPriceDzd: 14600, lineTotalDzd: 29200, maxQty: 10 },
        { variantId: 21, qty: 1, unitPriceDzd: 15500, lineTotalDzd: 15500, maxQty: 3 },
      ],
      subtotalDzd: 44700,
      feeDzd: 600,
      totalDzd: 45300,
      feeSource: 'table',
    });
  });

  test('wilaya not served: subtotal only, fee and total null', async () => {
    const out = wire(await quoteFromReads({ items: [{ variantId: 11, qty: 1 }], wilayaCode: 31 }, reads([variant(11, 14600, null)]), fees));
    expect(out).toMatchObject({ ok: true, available: false, subtotalDzd: 14600, feeDzd: null, totalDzd: null });
  });

  test.each([
    ['commune of another wilaya', 31],
    ['unknown commune', null],
  ])('%s → validation/commune_invalid, before anything else', async (_l, communeWilaya) => {
    const out = wire(await quoteFromReads({ items: [{ variantId: 999, qty: 1 }], wilayaCode: 16, communeId: 3101 }, reads([], communeWilaya), fees));
    expect(out).toEqual({ ok: false, code: 'validation', errors: [{ field: 'communeId', code: 'commune_invalid' }] });
  });

  test('unknown or unsellable variant → variant_unavailable with lines (maxQty 0, its price not disclosed), no fee call', async () => {
    let called = false;
    const spy: FeeProvider = { quote: () => ((called = true), Promise.resolve({ available: true, feeDzd: 1, source: 'table' })) };
    const out = wire(
      await quoteFromReads(
        { items: [{ variantId: 11, qty: 1 }, { variantId: 23, qty: 1 }, { variantId: 404, qty: 1 }], wilayaCode: 16 },
        reads([variant(11, 14600, null), variant(23, 16900, 5, false)]),
        spy,
      ),
    );
    expect(called).toBe(false);
    expect(out).toEqual({
      ok: false,
      code: 'variant_unavailable',
      lines: [
        { variantId: 11, qty: 1, unitPriceDzd: 14600, lineTotalDzd: 14600, maxQty: 10 },
        { variantId: 23, qty: 1, unitPriceDzd: 0, lineTotalDzd: 0, maxQty: 0 },
        { variantId: 404, qty: 1, unitPriceDzd: 0, lineTotalDzd: 0, maxQty: 0 },
      ],
    });
  });

  test('qty above stock → out_of_stock with maxQty; stock 0 → out_of_stock', async () => {
    const a = wire(await quoteFromReads({ items: [{ variantId: 21, qty: 4 }], wilayaCode: 16 }, reads([variant(21, 15500, 3)]), fees));
    expect(a).toMatchObject({ ok: false, code: 'out_of_stock', lines: [{ variantId: 21, maxQty: 3 }] });
    const b = wire(await quoteFromReads({ items: [{ variantId: 22, qty: 1 }], wilayaCode: 16 }, reads([variant(22, 16500, 0)]), fees));
    expect(b).toMatchObject({ ok: false, code: 'out_of_stock', lines: [{ variantId: 22, maxQty: 0 }] });
  });

  test('exactly the remaining stock is fine', async () => {
    const out = await quoteFromReads({ items: [{ variantId: 21, qty: 3 }], wilayaCode: 16 }, reads([variant(21, 15500, 3)]), fees);
    expect(out).toMatchObject({ ok: true, available: true, totalDzd: 3 * 15500 + 600 });
  });

  test('a mispriced row above the ceiling → order_total_out_of_range', async () => {
    const out = wire(await quoteFromReads({ items: [{ variantId: 11, qty: 10 }], wilayaCode: 16 }, reads([variant(11, 2_000_000, null)]), fees));
    expect(out).toMatchObject({ ok: false, code: 'order_total_out_of_range' });
  });

  test('the provider receives weight and server price; etaDays passes through', async () => {
    const seen: unknown[] = [];
    const spy: FeeProvider = {
      quote: (req) => {
        seen.push(req);
        return Promise.resolve({ available: true, feeDzd: 450, source: 'courier:test', etaDays: 2 });
      },
    };
    const out = await quoteFromReads(
      { items: [{ variantId: 11, qty: 2 }], wilayaCode: 16, communeId: 1601 },
      reads([variant(11, 14600, null)], 16),
      spy,
    );
    expect(seen).toEqual([{ wilayaCode: 16, communeId: 1601, items: [{ variantId: 11, qty: 2, weightG: 1000, unitPriceDzd: 14600 }] }]);
    expect(out).toMatchObject({ ok: true, feeDzd: 450, totalDzd: 29650, feeSource: 'courier:test', etaDays: 2 });
  });

  test('a provider answering garbage is a server error, not a price', async () => {
    const bad: FeeProvider = { quote: () => Promise.resolve({ available: true, feeDzd: 12.5, source: 'table' }) };
    await expect(quoteFromReads({ items: [{ variantId: 11, qty: 1 }], wilayaCode: 16 }, reads([variant(11, 1, null)]), bad)).rejects.toThrow(
      FeeProviderError,
    );
  });

  test('a provider failure propagates (→ server_error at the route)', async () => {
    const down: FeeProvider = { quote: () => Promise.reject(new Error('D1_ERROR')) };
    await expect(quoteFromReads({ items: [{ variantId: 11, qty: 1 }], wilayaCode: 16 }, reads([variant(11, 1, null)]), down)).rejects.toThrow(
      'D1_ERROR',
    );
  });
});
