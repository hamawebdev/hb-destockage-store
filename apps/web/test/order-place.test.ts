// Unit tests of the order pipeline (every anti-fraud layer, replay, dedup, races, totals) with an
// in-memory OrderStore. Real-D1 integration of the writes waits for DB-4. Plan: WEB-0 §3, §4, §10.
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  MIN_FILL_MS,
  MIN_REVIEW_MS,
  OrderResponseSchema,
  OrderCreatedMessageSchema,
  createStaticFeeProvider,
  parseOrderInput,
  type OrderInput,
  type OrderRef,
  type TurnstileVerdict,
} from '@hb/shared';
import * as v from 'valibot';
import type { PricingReads, VariantForSale, VariantSnapshot } from '../src/catalog-reads.ts';
import { ipRateKey, sinkRef } from '../src/order/crypto.ts';
import { placeOrder, type PlaceDeps, type PlaceOutcome } from '../src/order/place.ts';
import type { CreateOrderInput, CreateOrderResult, DuplicateAttempt, ExistingOrder, OrderStore, PhoneHistory } from '../src/order/store.ts';

const NOW = 1_793_800_000_000;
const KEY = '6f1c2a4e-8b3d-4c5e-9f6a-7b8c9d0e1f2a';

// --- Fixtures -----------------------------------------------------------------------------------

const VARIANTS: Record<number, VariantForSale> = {
  11: { id: 11, productId: 1, priceDzd: 14600, stock: null, weightG: 4000, sellable: true },
  21: { id: 21, productId: 2, priceDzd: 15500, stock: 3, weightG: 3000, sellable: true },
  22: { id: 22, productId: 2, priceDzd: 16500, stock: 0, weightG: 3500, sellable: true },
};
const snap = (productId: number, sku: string): VariantSnapshot => ({
  productId,
  sku,
  nameFr: `P${productId}`,
  nameAr: `م${productId}`,
  variantLabelFr: null,
  variantLabelAr: null,
  slugFr: `p${productId}`,
  slugAr: `p${productId}`,
});
const SNAPS = new Map<number, VariantSnapshot>([
  [11, snap(1, 'PK-CUI')],
  [21, snap(2, 'PK-BAIN-S')],
  [22, snap(2, 'PK-BAIN-M')],
]);
const COMMUNE_WILAYA: Record<number, number> = { 1601: 16, 3101: 31 };

function input(over: Record<string, unknown> = {}): OrderInput {
  const r = parseOrderInput({
    idempotencyKey: KEY,
    lang: 'ar',
    items: [{ variantId: 11, qty: 1 }],
    name: 'محمد أمين',
    phone: '٠٥٥٥ ١٢ ٣٤ ٥٦',
    wilayaCode: 16,
    communeId: 1601,
    expectedTotalDzd: 15200,
    turnstileToken: 'tok',
    website: '',
    fillMs: 9000,
    ...over,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

class FakeStore implements OrderStore {
  byKey = new Map<string, ExistingOrder>();
  byId = new Map<number, ExistingOrder>();
  history: PhoneHistory = { duplicate: null, ordersLast24h: 0, blocked: false };
  created: CreateOrderInput[] = [];
  duplicates: { orderId: number; attempt: DuplicateAttempt }[] = [];
  enqueueNotes: number[] = [];
  results: CreateOrderResult[] = [];
  nextId = 100;

  findByIdempotencyKey = vi.fn(async (k: string) => this.byKey.get(k) ?? null);
  getOrder = vi.fn(async (id: number) => this.byId.get(id) ?? null);
  phoneHistory = vi.fn(async () => this.history);
  markDuplicate = vi.fn(async (orderId: number, attempt: DuplicateAttempt) => {
    this.duplicates.push({ orderId, attempt });
  });
  createOrder = vi.fn(async (inp: CreateOrderInput): Promise<CreateOrderResult> => {
    this.created.push(inp);
    const scripted = this.results.shift();
    if (scripted !== undefined) return scripted;
    const id = this.nextId++;
    const o: ExistingOrder = {
      id,
      ref: inp.order.ref,
      status: 'new',
      lang: inp.order.lang,
      subtotalDzd: inp.order.subtotalDzd,
      feeDzd: inp.order.feeDzd,
      totalDzd: inp.order.totalDzd,
    };
    this.byKey.set(inp.order.idempotencyKey, o);
    this.byId.set(id, o);
    return { ok: true, orderId: id, ref: inp.order.ref, replayed: false };
  });
  noteEnqueueFailed = vi.fn(async (id: number) => {
    this.enqueueNotes.push(id);
  });
}

function limiter(allow: boolean) {
  return { limit: vi.fn(async (_o: RateLimitOptions) => ({ success: allow })) };
}

let store: FakeStore;
let deps: PlaceDeps & { rlPhone: ReturnType<typeof limiter>; rlIp: ReturnType<typeof limiter> };
let refs: OrderRef[];
let verdict: TurnstileVerdict;
let variants: Record<number, VariantForSale>;
const logs: { evt: string; fields?: Record<string, unknown> | undefined }[] = [];

beforeEach(() => {
  store = new FakeStore();
  refs = ['HB-AAAAA', 'HB-BBBBB', 'HB-CCCCC', 'HB-DDDDD'] as OrderRef[];
  verdict = 'ok';
  variants = { ...VARIANTS };
  logs.length = 0;
  deps = {
    store,
    readPricing: vi.fn(async (ids: readonly number[], communeId: number): Promise<PricingReads> => ({
      variants: new Map(ids.filter((id) => variants[id] !== undefined).map((id) => [id, variants[id]!])),
      communeWilaya: COMMUNE_WILAYA[communeId] ?? null,
      snapshots: SNAPS,
    })),
    fees: createStaticFeeProvider({ 16: 600, 31: null }),
    rlPhone: limiter(true),
    rlIp: limiter(true),
    ipRateKey,
    turnstile: vi.fn(async () => verdict),
    ipHash: vi.fn(async (ip: string | null) => (ip === null ? null : 'hash-of-ip')),
    newRef: vi.fn(() => refs.shift()!),
    sinkRef,
    log: (evt, fields) => void logs.push({ evt, fields }),
  };
});

function place(over: Record<string, unknown> = {}, opts: { path?: 'json' | 'form'; ip?: string | null; minFillMs?: number } = {}): Promise<PlaceOutcome> {
  const path = opts.path ?? 'json';
  return placeOrder(
    {
      input: input(over),
      path,
      ip: opts.ip === undefined ? '105.98.1.2' : opts.ip,
      now: NOW,
      minFillMs: opts.minFillMs ?? (path === 'form' ? MIN_REVIEW_MS : MIN_FILL_MS),
    },
    deps,
  );
}

/** Every body the API would send must match shared's strict OrderResponse schema. */
function wire(o: PlaceOutcome): PlaceOutcome {
  const body = o.kind === 'failure' ? { ok: false, ...o.failure } : o.body;
  const r = v.safeParse(OrderResponseSchema, body);
  if (!r.success) throw new Error(`not an OrderResponse: ${JSON.stringify(body)}`);
  return o;
}

// --- Tests --------------------------------------------------------------------------------------

describe('happy path', () => {
  test('201 with server totals; createOrder gets snapshots, normalised phone and no client price', async () => {
    const out = wire(await place());
    expect(out).toMatchObject({
      kind: 'created',
      status: 201,
      body: { ok: true, ref: 'HB-AAAAA', status: 'new', duplicate: false, subtotalDzd: 14600, feeDzd: 600, totalDzd: 15200, confirmationUrl: '/ar/order/confirmation/?ref=HB-AAAAA' },
    });
    const c = store.created[0]!;
    expect(c.customer).toEqual({ phoneE164: '+213555123456', name: 'محمد أمين' });
    expect(c.order).toMatchObject({
      ref: 'HB-AAAAA',
      idempotencyKey: KEY,
      lang: 'ar',
      wilayaCode: 16,
      communeId: 1601,
      subtotalDzd: 14600,
      feeDzd: 600,
      totalDzd: 15200,
      feeSource: 'table',
      flags: [],
      turnstile: 'ok',
      fillMs: 9000,
      riskScore: 0,
      ipHash: 'hash-of-ip',
    });
    expect(c.lines).toEqual([
      { variantId: 11, productId: 1, nameFr: 'P1', nameAr: 'م1', variantLabelFr: null, variantLabelAr: null, sku: 'PK-CUI', unitPriceDzd: 14600, qty: 1, lineTotalDzd: 14600 },
    ]);
    expect(c.now).toBe(NOW);
  });

  test('the queue message is order.created v1 with no PII', async () => {
    const out = await place();
    if (out.kind !== 'created') throw new Error(out.kind);
    expect(v.safeParse(OrderCreatedMessageSchema, out.message).success).toBe(true);
    expect(out.message).toEqual({ type: 'order.created', v: 1, orderId: 100, ref: 'HB-AAAAA', totalDzd: 15200, wilayaCode: 16, lang: 'ar', flags: [], createdAt: NOW });
    const s = JSON.stringify(out.message);
    expect(s).not.toContain('555123456');
    expect(s).not.toContain('محمد');
  });

  test('multi-line totals are Σ(unit × qty) + fee from D1 prices', async () => {
    const out = await place({ items: [{ variantId: 11, qty: 2 }, { variantId: 21, qty: 3 }], expectedTotalDzd: 2 * 14600 + 3 * 15500 + 600 });
    expect(out).toMatchObject({ kind: 'created', body: { subtotalDzd: 75700, feeDzd: 600, totalDzd: 76300 } });
  });
});

describe('layer 3: idempotency', () => {
  test('same key returns the original order (200) before any rate limit or read', async () => {
    const first = await place();
    expect(first.kind).toBe('created');
    deps.rlPhone.limit.mockClear();
    const again = wire(await place());
    expect(again).toEqual({ kind: 'replay', status: 200, body: (first as Extract<PlaceOutcome, { kind: 'created' }>).body });
    expect(deps.rlPhone.limit).not.toHaveBeenCalled();
    expect(deps.readPricing).toHaveBeenCalledTimes(1);
    expect(store.created).toHaveLength(1);
  });

  test('a replay is answered even when the phone is over its limit', async () => {
    await place();
    deps.rlPhone.limit.mockResolvedValue({ success: false });
    expect((await place()).kind).toBe('replay');
  });

  test('lost same-key race inside createOrder (replayed:true) answers like a replay', async () => {
    store.byId.set(7, { id: 7, ref: 'HB-77777' as OrderRef, status: 'called', lang: 'fr', subtotalDzd: 1, feeDzd: 2, totalDzd: 3 });
    store.results.push({ ok: true, orderId: 7, ref: 'HB-77777', replayed: true });
    const out = wire(await place());
    expect(out).toEqual({
      kind: 'replay',
      status: 200,
      body: { ok: true, ref: 'HB-77777', status: 'called', duplicate: false, subtotalDzd: 1, feeDzd: 2, totalDzd: 3, confirmationUrl: '/fr/order/confirmation/?ref=HB-77777' },
    });
  });
});

describe('layer 4: rate limits', () => {
  test('phone over limit → 429 rate_limited, keyed on E.164, nothing read or written', async () => {
    deps.rlPhone.limit.mockResolvedValue({ success: false });
    const out = wire(await place({ phone: '+213 555 12 34 56' }));
    expect(out).toEqual({ kind: 'failure', failure: { code: 'rate_limited', retryAfterS: 60 } });
    expect(deps.rlPhone.limit).toHaveBeenCalledWith({ key: '+213555123456' });
    expect(deps.readPricing).not.toHaveBeenCalled();
    expect(store.created).toHaveLength(0);
  });

  test('every spelling of one phone hits the same key', async () => {
    for (const phone of ['0555123456', '+213555123456', '00213555123456', '٠٥٥٥١٢٣٤٥٦', '۰۵۵۵۱۲۳۴۵۶']) {
      await place({ phone, idempotencyKey: crypto.randomUUID() });
    }
    expect(new Set(deps.rlPhone.limit.mock.calls.map((c) => c[0].key))).toEqual(new Set(['+213555123456']));
  });

  test('IP over limit never rejects: accepted and flagged rate_limited (IPv6 keyed on /64)', async () => {
    deps.rlIp.limit.mockResolvedValue({ success: false });
    const out = await place({}, { ip: '2001:db8:aa:bb:1:2:3:4' });
    expect(out.kind).toBe('created');
    expect(deps.rlIp.limit).toHaveBeenCalledWith({ key: '2001:db8:aa:bb::/64' });
    expect(store.created[0]!.order.flags).toEqual(['rate_limited']);
    expect(store.created[0]!.order.riskScore).toBe(20);
  });

  test('no client IP: IP limiter skipped, ip_hash null', async () => {
    await place({}, { ip: null });
    expect(deps.rlIp.limit).not.toHaveBeenCalled();
    expect(store.created[0]!.order.ipHash).toBeNull();
  });
});

describe('layer 5: Turnstile never rejects', () => {
  test.each([
    ['ok', [], 0],
    ['missing', ['turnstile_missing'], 20],
    ['invalid', ['turnstile_invalid'], 40],
    ['error', ['turnstile_invalid'], 0],
  ] as const)('verdict %s → accepted, flags %j, risk %i', async (v_, flags, risk) => {
    verdict = v_;
    const out = await place();
    expect(out.kind).toBe('created');
    expect(store.created[0]!.order).toMatchObject({ turnstile: v_, flags, riskScore: risk });
  });
});

describe('layer 6: server-side recompute', () => {
  test('client total differs → 409 total_changed with the fresh quote; nothing created', async () => {
    const out = wire(await place({ expectedTotalDzd: 15000 }));
    expect(out).toMatchObject({ kind: 'failure', failure: { code: 'total_changed', quote: { ok: true, available: true, totalDzd: 15200 } } });
    expect(store.created).toHaveLength(0);
  });

  test('out of stock answers out_of_stock, not total_changed, even with a wrong total', async () => {
    const out = wire(await place({ items: [{ variantId: 21, qty: 4 }], expectedTotalDzd: 1 }));
    expect(out).toMatchObject({ kind: 'failure', failure: { code: 'out_of_stock', lines: [{ variantId: 21, maxQty: 3 }] } });
    expect(store.created).toHaveLength(0);
  });

  test('stock 0 → out_of_stock', async () => {
    expect(await place({ items: [{ variantId: 22, qty: 1 }], expectedTotalDzd: 17100 })).toMatchObject({ failure: { code: 'out_of_stock' } });
  });

  test('wilaya not served → 409 delivery_unavailable with the available:false quote', async () => {
    const out = wire(await place({ wilayaCode: 31, communeId: 3101 }));
    expect(out).toMatchObject({ kind: 'failure', failure: { code: 'delivery_unavailable', quote: { available: false, feeDzd: null } } });
  });

  test('commune of another wilaya → 422 validation/commune_invalid', async () => {
    const out = wire(await place({ communeId: 3101 }));
    expect(out).toEqual({ kind: 'failure', failure: { code: 'validation', errors: [{ field: 'communeId', code: 'commune_invalid' }] } });
  });

  test('unknown / unsellable variant → 409 variant_unavailable', async () => {
    variants[11] = { ...VARIANTS[11]!, sellable: false };
    expect(wire(await place())).toMatchObject({ kind: 'failure', failure: { code: 'variant_unavailable' } });
    expect(wire(await place({ items: [{ variantId: 999, qty: 1 }] }))).toMatchObject({ failure: { code: 'variant_unavailable' } });
  });

  test('a price edit after the quote → total_changed (the client total is never charged)', async () => {
    variants[11] = { ...VARIANTS[11]!, priceDzd: 15000 };
    expect(await place()).toMatchObject({ kind: 'failure', failure: { code: 'total_changed', quote: { totalDzd: 15600 } } });
  });

  test('D1 failure propagates (route maps it to 503 server_error)', async () => {
    deps = { ...deps, readPricing: vi.fn(() => Promise.reject(new Error('D1_ERROR'))) };
    await expect(place()).rejects.toThrow('D1_ERROR');
  });
});

describe('layer 1: honeypot and fill time', () => {
  test('honeypot alone → accepted and flagged (autofill must not lose a real order)', async () => {
    const out = await place({ website: 'http://spam' });
    expect(out.kind).toBe('created');
    expect(store.created[0]!.order).toMatchObject({ flags: ['honeypot'], riskScore: 60 });
  });

  test('fast fill alone → accepted and flagged fast_fill', async () => {
    await place({ fillMs: 800 });
    expect(store.created[0]!.order).toMatchObject({ flags: ['fast_fill'], riskScore: 30, fillMs: 800 });
  });

  test('missing fillMs (JS) → fill_time_missing', async () => {
    await place({ fillMs: undefined });
    expect(store.created[0]!.order).toMatchObject({ flags: ['fill_time_missing'], fillMs: null });
  });

  test('honeypot + fast fill → sink: decoy 201, nothing written, nothing enqueued, logged without PII', async () => {
    const out = wire(await place({ website: 'x', fillMs: 300 }));
    expect(out.kind).toBe('sink');
    if (out.kind !== 'sink') return;
    expect(out.status).toBe(201);
    expect(out.body).toMatchObject({ ok: true, status: 'new', duplicate: false, totalDzd: 15200 });
    expect(out.body.ref).toBe(await sinkRef(KEY));
    expect(store.created).toHaveLength(0);
    expect(store.markDuplicate).not.toHaveBeenCalled();
    const ev = logs.find((l) => l.evt === 'order_sink');
    expect(ev?.fields).toMatchObject({ path: 'json' });
    expect(JSON.stringify(ev)).not.toContain('555');
    // Stable decoy for a retry with the same key.
    const again = await place({ website: 'x', fillMs: 300 });
    expect(again.kind === 'sink' && again.body.ref).toBe(out.body.ref);
  });

  test('no-JS: honeypot + missing review token → sink; JS: honeypot + missing fillMs → flagged, not sunk', async () => {
    expect((await place({ website: 'x', fillMs: undefined }, { path: 'form' })).kind).toBe('sink');
    expect((await place({ website: 'x', fillMs: undefined, idempotencyKey: crypto.randomUUID() }, { path: 'json' })).kind).toBe('created');
  });

  test('no-JS uses the review threshold (1.5 s): 2 s review → not fast', async () => {
    await place({ fillMs: 2000 }, { path: 'form' });
    expect(store.created[0]!.order.flags).toEqual([]);
  });

  test('sink still answers business failures first (a bot gets the same 409 as anyone)', async () => {
    expect(await place({ website: 'x', fillMs: 1, expectedTotalDzd: 1 })).toMatchObject({ kind: 'failure', failure: { code: 'total_changed' } });
  });
});

describe('layer 7: dedup', () => {
  const existing: ExistingOrder = { id: 42, ref: 'HB-42424' as OrderRef, status: 'new', lang: 'ar', subtotalDzd: 14600, feeDzd: 600, totalDzd: 15200 };

  test('same phone + variant within the window → the existing order, 200, duplicate:true, attempt noted', async () => {
    store.history = { duplicate: existing, ordersLast24h: 1, blocked: false };
    const out = wire(await place({ items: [{ variantId: 11, qty: 2 }], expectedTotalDzd: 29800 }));
    expect(out).toEqual({
      kind: 'duplicate',
      status: 200,
      body: { ok: true, ref: 'HB-42424', status: 'new', duplicate: true, subtotalDzd: 14600, feeDzd: 600, totalDzd: 15200, confirmationUrl: '/ar/order/confirmation/?ref=HB-42424' },
    });
    expect(store.duplicates).toEqual([{ orderId: 42, attempt: { items: [{ variantId: 11, qty: 2 }], wilayaCode: 16, communeId: 1601 } }]);
    expect(store.created).toHaveLength(0);
    expect(store.phoneHistory).toHaveBeenCalledWith('+213555123456', [11], NOW);
  });
});

describe('layers 8–9: velocity and blocked customers (flags only)', () => {
  test('3 orders in 24 h already → the next is accepted and flagged rate_limited', async () => {
    store.history = { duplicate: null, ordersLast24h: 3, blocked: false };
    await place();
    expect(store.created[0]!.order).toMatchObject({ flags: ['rate_limited'], riskScore: 30 });
  });

  test('2 orders in 24 h → no flag', async () => {
    store.history = { duplicate: null, ordersLast24h: 2, blocked: false };
    await place();
    expect(store.created[0]!.order.flags).toEqual([]);
  });

  test('blocked customer → accepted silently, flagged, risk 100 (capped)', async () => {
    store.history = { duplicate: null, ordersLast24h: 5, blocked: true };
    verdict = 'invalid';
    const out = await place({ website: 'x' });
    expect(out.kind).toBe('created');
    expect(store.created[0]!.order.flags).toEqual(['honeypot', 'turnstile_invalid', 'rate_limited', 'blocked_customer']);
    expect(store.created[0]!.order.riskScore).toBe(100);
  });
});

describe('write races', () => {
  test('lost the last unit between read and write → 409 out_of_stock with current availability', async () => {
    store.results.push({ ok: false, reason: 'out_of_stock', variantIds: [21] });
    let calls = 0;
    deps = {
      ...deps,
      readPricing: vi.fn(async (ids: readonly number[], communeId: number) => {
        calls += 1;
        const stock = calls === 1 ? 1 : 0; // someone else took it in between
        return {
          variants: new Map(ids.map((id) => [id, { ...VARIANTS[21]!, stock }])),
          communeWilaya: COMMUNE_WILAYA[communeId] ?? null,
          snapshots: SNAPS,
        };
      }),
    };
    const out = wire(await place({ items: [{ variantId: 21, qty: 1 }], expectedTotalDzd: 16100 }));
    expect(out).toMatchObject({ kind: 'failure', failure: { code: 'out_of_stock', lines: [{ variantId: 21, maxQty: 0 }] } });
  });

  test('the body and message carry the ref the store stored (DB-4 retries collisions itself)', async () => {
    store.results.push({ ok: true, orderId: 9, ref: 'HB-ZZZZZ', replayed: false });
    const out = await place();
    expect(out).toMatchObject({ kind: 'created', body: { ref: 'HB-ZZZZZ', confirmationUrl: '/ar/order/confirmation/?ref=HB-ZZZZZ' }, message: { ref: 'HB-ZZZZZ', orderId: 9 } });
    expect(store.created[0]!.order.ref).toBe('HB-AAAAA');
  });

  test('store gave up on ref collisions → error (503 at the route), never a silent success', async () => {
    store.results.push({ ok: false, reason: 'ref_collision' });
    await expect(place()).rejects.toThrow(/unique order ref/);
  });
});
