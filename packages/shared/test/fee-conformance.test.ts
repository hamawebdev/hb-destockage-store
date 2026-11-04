/** SHARED-3 — the conformance suite passes a correct provider and catches each class of defect. */
import { describe, expect, test } from 'vitest';
import { checkFeeProviderConformance, type FeeConformanceFixture } from '../src/fee-conformance.ts';
import { createStaticFeeProvider, type FeeProvider, type FeeQuote } from '../src/fees.ts';

const fees: Record<number, number | null> = { 16: 400, 31: 700, 9: 500, 11: null };
const fixture: FeeConformanceFixture = {
  served: { 16: 400, 31: 700, 9: 'any' },
  unserved: [11, 69],
  source: 'table',
  communes: { 16: 1601, 31: 3101 },
  communeIndependent: true,
  itemIndependent: true,
  failing: () => ({ quote: () => Promise.reject(new Error('D1 down')) }),
};
const good = (): FeeProvider => createStaticFeeProvider(fees);
const wrap = (f: (q: FeeQuote, req: Parameters<FeeProvider['quote']>[0]) => unknown): FeeProvider => {
  const inner = good();
  return { quote: async (req) => f(await inner.quote(req), req) as FeeQuote };
};
const checks = async (p: FeeProvider, fx: FeeConformanceFixture = fixture) =>
  [...new Set((await checkFeeProviderConformance(p, fx)).map((f) => f.check))].sort();

describe('checkFeeProviderConformance', () => {
  test('the static provider conforms', async () => {
    expect(await checkFeeProviderConformance(good(), fixture)).toEqual([]);
  });

  test('throws for an unserved wilaya ⇒ resolves', async () => {
    const p: FeeProvider = { quote: (req) => (fees[req.wilayaCode] == null ? Promise.reject(new Error('no')) : good().quote(req)) };
    expect(await checks(p)).toContain('resolves');
  });

  test('fractional fee ⇒ valid_quote', async () => {
    expect(await checks(wrap((q) => (q.available ? { ...q, feeDzd: 400.5 } : q)))).toContain('valid_quote');
  });

  test('wrong fee ⇒ served_fee; wrong availability ⇒ served/unserved', async () => {
    expect(await checks(wrap((q) => (q.available ? { ...q, feeDzd: q.feeDzd + 1 } : q)))).toEqual(['served_fee']);
    expect(await checks(createStaticFeeProvider({ ...fees, 11: 300, 16: null }))).toEqual(['served', 'unserved']);
  });

  test('wrong source ⇒ source', async () => {
    expect(await checks(createStaticFeeProvider(fees, 'courier:x'))).toEqual(['source']);
  });

  test('fee depends on commune or items when declared independent', async () => {
    expect(await checks(wrap((q, req) => (q.available && req.communeId ? { ...q, feeDzd: q.feeDzd + 50 } : q)))).toEqual([
      'commune',
    ]);
    expect(await checks(wrap((q, req) => (q.available && req.items.length > 1 ? { ...q, feeDzd: 0 } : q)))).toEqual([
      'items',
    ]);
  });

  test('non-deterministic ⇒ deterministic', async () => {
    let n = 0;
    expect(await checks(wrap((q) => (q.available ? { ...q, feeDzd: q.feeDzd + (n++ % 2) } : q)))).toContain('deterministic');
  });

  test('mutating the request ⇒ resolves (request is frozen)', async () => {
    const p: FeeProvider = {
      quote: (req) => {
        (req as { wilayaCode: number }).wilayaCode = 16;
        return good().quote(req);
      },
    };
    expect(await checks(p)).toContain('resolves');
  });

  test('fails under concurrency ⇒ concurrency', async () => {
    let inFlight = 0;
    const p: FeeProvider = {
      quote: async (req) => {
        inFlight++;
        await Promise.resolve();
        const busy = inFlight > 5;
        inFlight--;
        if (busy) throw new Error('pool exhausted');
        return good().quote(req);
      },
    };
    expect(await checks(p)).toEqual(['concurrency']);
  });

  test('backend down answers "no delivery" instead of rejecting ⇒ failing_rejects', async () => {
    const fx = { ...fixture, failing: () => createStaticFeeProvider({}) };
    expect(await checks(good(), fx)).toEqual(['failing_rejects']);
  });
});
