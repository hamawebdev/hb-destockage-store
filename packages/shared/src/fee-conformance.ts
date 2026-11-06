/**
 * FeeProvider conformance suite (SHARED-3). Every implementation — today's admin-table provider
 * in `apps/web`, later courier APIs — must return no failures:
 *
 *   expect(await checkFeeProviderConformance(provider, fixture)).toEqual([]);
 *
 * Framework-agnostic (no test-runner import), so it runs under Node and workerd.
 */

import { isValidFeeQuote, type FeeProvider, type FeeQuote, type FeeQuoteItem, type FeeQuoteRequest, type FeeSource } from './fees.ts';
import { WILAYA_CODE_MAX, WILAYA_CODE_MIN } from './ids.ts';
import type { Dzd } from './money.ts';

export interface FeeConformanceFixture {
  /** Wilayas the provider serves → the expected fee, or `'any'` when the fee is not known in advance. */
  readonly served: Readonly<Record<number, Dzd | 'any'>>;
  /** Wilayas the provider must answer `available: false` for. */
  readonly unserved: readonly number[];
  /** Expected `source` on every quote. */
  readonly source: FeeSource;
  /** A commune id per served wilaya, used for the with/without-commune check. */
  readonly communes?: Readonly<Record<number, number>> | undefined;
  /** The fee does not depend on the commune (today's table provider). */
  readonly communeIndependent?: boolean | undefined;
  /** The fee does not depend on the items (today's table provider). */
  readonly itemIndependent?: boolean | undefined;
  /** Factory for the same provider with its backend down; it must reject, never answer "no delivery". */
  readonly failing?: (() => FeeProvider) | undefined;
}

export type FeeConformanceCheck =
  | 'resolves'
  | 'valid_quote'
  | 'served'
  | 'served_fee'
  | 'unserved'
  | 'source'
  | 'commune'
  | 'deterministic'
  | 'items'
  | 'concurrency'
  | 'failing_rejects';

export interface FeeConformanceFailure {
  readonly check: FeeConformanceCheck;
  readonly detail: string;
}

const ONE_ITEM: readonly FeeQuoteItem[] = [{ variantId: 1, qty: 1, weightG: 1200, unitPriceDzd: 14600 }];
const ITEM_SETS: readonly (readonly FeeQuoteItem[])[] = [
  ONE_ITEM,
  [{ variantId: 1, qty: 10, weightG: 1200, unitPriceDzd: 14600 }],
  [{ variantId: 2, qty: 1, weightG: null, unitPriceDzd: 500 }],
  [{ variantId: 3, qty: 2, weightG: 25_000, unitPriceDzd: 16500 }],
  [
    { variantId: 1, qty: 1, weightG: 1200, unitPriceDzd: 14600 },
    { variantId: 4, qty: 3, weightG: 300, unitPriceDzd: 2500 },
  ],
];

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function request(wilayaCode: number, items: readonly FeeQuoteItem[], communeId?: number): FeeQuoteRequest {
  const req: FeeQuoteRequest =
    communeId === undefined
      ? { wilayaCode, items: items.map((i) => ({ ...i })) }
      : { wilayaCode, communeId, items: items.map((i) => ({ ...i })) };
  return deepFreeze(req);
}

function same(a: FeeQuote, b: FeeQuote): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function checkFeeProviderConformance(
  provider: FeeProvider,
  fixture: FeeConformanceFixture,
): Promise<FeeConformanceFailure[]> {
  const failures: FeeConformanceFailure[] = [];
  const fail = (check: FeeConformanceCheck, detail: string): void => {
    failures.push({ check, detail });
  };

  async function ask(req: FeeQuoteRequest, label: string): Promise<FeeQuote | null> {
    let q: unknown;
    try {
      q = await provider.quote(req);
    } catch (e) {
      fail('resolves', `${label}: rejected (${e instanceof Error ? e.message : String(e)})`);
      return null;
    }
    if (!isValidFeeQuote(q)) {
      fail('valid_quote', `${label}: ${JSON.stringify(q)}`);
      return null;
    }
    if (q.source !== fixture.source) fail('source', `${label}: ${q.source} ≠ ${fixture.source}`);
    return q;
  }

  // 1–3: every wilaya resolves to a valid quote; served/unserved/source as declared.
  const base = new Map<number, FeeQuote>();
  for (let w = WILAYA_CODE_MIN; w <= WILAYA_CODE_MAX; w++) {
    const q = await ask(request(w, ONE_ITEM), `wilaya ${w}`);
    if (q === null) continue;
    base.set(w, q);
    const expected = fixture.served[w];
    if (expected !== undefined) {
      if (!q.available) fail('served', `wilaya ${w}: available:false`);
      else if (expected !== 'any' && q.feeDzd !== expected) fail('served_fee', `wilaya ${w}: ${q.feeDzd} ≠ ${expected}`);
    }
    if (fixture.unserved.includes(w) && q.available) fail('unserved', `wilaya ${w}: available:true`);
  }

  // 4: with and without a commune.
  for (const [w, communeId] of Object.entries(fixture.communes ?? {})) {
    const code = Number(w);
    const q = await ask(request(code, ONE_ITEM, communeId), `wilaya ${code} commune ${communeId}`);
    const without = base.get(code);
    if (q !== null && without !== undefined && fixture.communeIndependent === true && !same(q, without)) {
      fail('commune', `wilaya ${code}: ${JSON.stringify(q)} ≠ ${JSON.stringify(without)} without commune`);
    }
  }

  // 5: deterministic.
  for (const w of [...Object.keys(fixture.served).map(Number), ...fixture.unserved].slice(0, 10)) {
    const a = await ask(request(w, ONE_ITEM), `wilaya ${w} (repeat)`);
    const b = base.get(w);
    if (a !== null && b !== undefined && !same(a, b)) fail('deterministic', `wilaya ${w}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
  }

  // 7: item shapes (request objects are deeply frozen: a mutating provider rejects → 'resolves').
  for (const w of Object.keys(fixture.served).map(Number).slice(0, 5)) {
    for (const [i, items] of ITEM_SETS.entries()) {
      const q = await ask(request(w, items), `wilaya ${w} item set ${i}`);
      const b = base.get(w);
      // An already-unavailable base quote was reported by 'served'; don't report it again here.
      if (q === null || b === undefined || !b.available) continue;
      if (!q.available) fail('items', `wilaya ${w} item set ${i}: available:false`);
      else if (fixture.itemIndependent === true && !same(q, b)) fail('items', `wilaya ${w} item set ${i}: fee depends on items`);
    }
  }

  // 8: concurrency.
  const all = await Promise.allSettled(
    // Promise.resolve().then(): a provider that throws synchronously is reported, not propagated.
    Array.from({ length: WILAYA_CODE_MAX }, (_, i) => Promise.resolve().then(() => provider.quote(request(i + 1, ONE_ITEM)))),
  );
  all.forEach((r, i) => {
    if (r.status === 'rejected') fail('concurrency', `wilaya ${i + 1}: rejected under concurrency`);
    else {
      const b = base.get(i + 1);
      if (b !== undefined && !same(r.value, b)) fail('concurrency', `wilaya ${i + 1}: differs under concurrency`);
    }
  });

  // 9: backend down ⇒ reject, never "no delivery".
  if (fixture.failing !== undefined) {
    const broken = fixture.failing();
    const w = Number(Object.keys(fixture.served)[0] ?? 16);
    try {
      const q = await broken.quote(request(w, ONE_ITEM));
      fail('failing_rejects', `resolved ${JSON.stringify(q)} instead of rejecting`);
    } catch {
      // expected
    }
  }

  return failures;
}
