/**
 * The order pipeline (plan WEB-0 §3, §4; lead rulings on WEB-0). Shared by the JSON path and the
 * no-JS confirm step. Layers, cheapest first, after the route's transport guards and schema parse:
 *
 *   3  idempotency: same key ⇒ the original order, 200 (before any rate limit: a retry never counts)
 *   4  phone rate limit (primary key) ⇒ 429 rate_limited; IP rate limit (secondary) ⇒ flag only
 *   5  Turnstile verdict ⇒ flag only (in parallel with 6)
 *   6  fresh D1 reads: prices, stock, status, commune ∈ wilaya, fee; phone history (dedup, velocity, blocked)
 *      ⇒ 422 commune / 409 variant_unavailable | out_of_stock | delivery_unavailable | total_changed (shared checkOrderQuote)
 *   sink: honeypot AND fill-time signal ⇒ decoy success, nothing written
 *   7  dedup (same phone + overlapping variant, 30 min): a genuine double submit (same name, wilaya,
 *      commune and exactly the same lines) ⇒ the existing order, flagged `duplicate`; otherwise a NEW
 *      order flagged `duplicate` (never another order's ref or totals: lead ruling on WEB-3 r1)
 *   8–9 velocity / blocked ⇒ flags
 *   write: createOrder batch (customer upsert, order, items, stock decrement, created event)
 *
 * Returns a decision; the route renders it (JSON or HTML/303) and enqueues `order.created`.
 */
import {
  checkOrderQuote,
  submissionFlags,
  type ApiFailure,
  type FeeProvider,
  type OrderCreatedMessage,
  type OrderInput,
  type OrderRef,
  type OrderSuccess,
  type TurnstileVerdict,
} from '@hb/shared';
import type { PricingReads } from '../catalog-reads.ts';
import { quoteFromReads } from '../quote.ts';
import { assess, shouldSink } from './risk.ts';
import type { ExistingOrder, OrderLineQty, OrderStore } from './store.ts';

export const PHONE_LIMIT_RETRY_AFTER_S = 60;

export interface PlaceRequest {
  readonly input: OrderInput;
  readonly path: 'json' | 'form';
  readonly ip: string | null;
  readonly now: number;
  /** MIN_FILL_MS on the JS path, MIN_REVIEW_MS on the no-JS confirm step (from config). */
  readonly minFillMs: number;
}

export interface PlaceDeps {
  readonly store: OrderStore;
  readonly readPricing: (variantIds: readonly number[], communeId: number) => Promise<PricingReads>;
  readonly fees: FeeProvider;
  readonly rlPhone: RateLimit;
  readonly rlIp: RateLimit;
  readonly ipRateKey: (ip: string) => string;
  readonly turnstile: (token: string | undefined, ip: string | null, idempotencyKey: string) => Promise<TurnstileVerdict>;
  readonly ipHash: (ip: string | null) => Promise<string | null>;
  readonly newRef: () => OrderRef;
  readonly sinkRef: (idempotencyKey: string) => Promise<OrderRef>;
  readonly log: (evt: string, fields?: Record<string, unknown>) => void;
}

export type PlaceOutcome =
  | { readonly kind: 'created'; readonly status: 201; readonly body: OrderSuccess; readonly orderId: number; readonly message: OrderCreatedMessage }
  // Every success is 201: a replay must look exactly like a first submit and like a sunk decoy
  // (rev-d WEB-3 r1 Nit: a bot replaying its key must not learn whether it was sunk).
  | { readonly kind: 'replay' | 'duplicate'; readonly status: 201; readonly body: OrderSuccess }
  | { readonly kind: 'sink'; readonly status: 201; readonly body: OrderSuccess }
  | { readonly kind: 'failure'; readonly failure: Omit<ApiFailure, 'ok'> };

export function confirmationUrl(lang: string, ref: string): string {
  return `/${lang}/order/confirmation/?ref=${ref}`;
}

/** Names compared as people type them: NFC, case-insensitive, whitespace collapsed. */
export function sameName(a: string, b: string): boolean {
  const n = (s: string) => s.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
  return n(a) === n(b);
}

/** A genuine double submit: same person and delivery address as the recent order. */
export function sameSubmitter(o: ExistingOrder, input: Pick<OrderInput, 'name' | 'wilayaCode' | 'communeId'>): boolean {
  return sameName(o.name, input.name) && o.wilayaCode === input.wilayaCode && o.communeId === input.communeId;
}

/** The same variants at the same quantities, in any order. */
export function sameLines(a: readonly OrderLineQty[], b: readonly OrderLineQty[]): boolean {
  const key = (lines: readonly OrderLineQty[]) => lines.map((l) => `${l.variantId}x${l.qty}`).sort().join();
  return key(a) === key(b);
}

function existingBody(o: ExistingOrder, duplicate: boolean): OrderSuccess {
  return {
    ok: true,
    ref: o.ref,
    status: o.status,
    duplicate,
    subtotalDzd: o.subtotalDzd,
    feeDzd: o.feeDzd,
    totalDzd: o.totalDzd,
    confirmationUrl: confirmationUrl(o.lang, o.ref),
  };
}

/** Counts sink events per isolate (lead: log them with counts, no PII). */
let sinkCount = 0;

export async function placeOrder(req: PlaceRequest, deps: PlaceDeps): Promise<PlaceOutcome> {
  const { input, now } = req;
  const phone = input.phone.e164;
  const variantIds = input.items.map((i) => i.variantId);

  // 3. Idempotency.
  const replay = await deps.store.findByIdempotencyKey(input.idempotencyKey);
  if (replay !== null) return { kind: 'replay', status: 201, body: existingBody(replay, false) };

  // 4. Rate limits: phone is the primary key (reject); IP is secondary (flag only).
  if (!(await deps.rlPhone.limit({ key: phone })).success) {
    return { kind: 'failure', failure: { code: 'rate_limited', retryAfterS: PHONE_LIMIT_RETRY_AFTER_S } };
  }
  const ipOverLimit = req.ip === null ? false : !(await deps.rlIp.limit({ key: deps.ipRateKey(req.ip) })).success;

  // 5 + 6. Turnstile in parallel with the fresh D1 reads.
  const [verdict, reads, history] = await Promise.all([
    deps.turnstile(input.turnstileToken, req.ip, input.idempotencyKey),
    deps.readPricing(variantIds, input.communeId),
    deps.store.phoneHistory(phone, variantIds, now),
  ]);

  const quote = await quoteFromReads(input, reads, deps.fees);
  const checked = checkOrderQuote(input.expectedTotalDzd, quote);
  if (!checked.ok) {
    const { ok: _ok, ...failure } = checked;
    return { kind: 'failure', failure };
  }

  // Sink: two bot signals at once. Decide on the submission alone (not on Turnstile).
  const minFill = req.minFillMs;
  if (shouldSink(submissionFlags(input, 'ok', minFill), req.path)) {
    sinkCount += 1;
    deps.log('order_sink', { path: req.path, isolateCount: sinkCount });
    const ref = await deps.sinkRef(input.idempotencyKey);
    const q = checked.quote;
    return {
      kind: 'sink',
      status: 201,
      body: {
        ok: true,
        ref,
        status: 'new',
        duplicate: false,
        subtotalDzd: q.subtotalDzd,
        feeDzd: q.feeDzd,
        totalDzd: q.totalDzd,
        confirmationUrl: confirmationUrl(input.lang, ref),
      },
    };
  }

  // 7. Dedup. Only a genuine double submit (same phone within the window AND the same name, wilaya,
  // commune and exactly the same lines) gets the existing order back: sharing a variant is not
  // enough, or a cart that adds to an earlier order would lose its new lines. Anything else is a
  // new order, flagged. Every recent order is checked, so the match may be older than the newest.
  const same = history.recent.find((o) => sameSubmitter(o, input) && sameLines(o.lines, input.items));
  if (same !== undefined) {
    await deps.store.markDuplicate(same.id, { items: input.items, wilayaCode: input.wilayaCode, communeId: input.communeId }, now);
    return { kind: 'duplicate', status: 201, body: existingBody(same, true) };
  }

  // 8–9 + submission flags.
  const { flags, riskScore } = assess(input, verdict, minFill, {
    ipOverLimit,
    ordersLast24h: history.ordersLast24h,
    blockedCustomer: history.blocked,
    possibleDuplicate: history.recent.length > 0,
  });

  const snapshots = reads.snapshots;
  if (snapshots === undefined) throw new Error('readPricing must return snapshots on the order path');
  const q = checked.quote;
  const lines = q.lines.map((l) => {
    const s = snapshots.get(l.variantId);
    if (s === undefined) throw new Error('missing snapshot for a priced line');
    return {
      variantId: l.variantId,
      productId: s.productId,
      nameFr: s.nameFr,
      nameAr: s.nameAr,
      variantLabelFr: s.variantLabelFr,
      variantLabelAr: s.variantLabelAr,
      sku: s.sku,
      unitPriceDzd: l.unitPriceDzd,
      qty: l.qty,
      lineTotalDzd: l.lineTotalDzd,
    };
  });
  const ipHashed = await deps.ipHash(req.ip);

  // createOrder retries ref collisions itself (DB-4) and returns the ref it actually stored.
  const result = await deps.store.createOrder({
    customer: { phoneE164: phone, name: input.name },
    order: {
      ref: deps.newRef(),
      idempotencyKey: input.idempotencyKey,
      lang: input.lang,
      wilayaCode: input.wilayaCode,
      communeId: input.communeId,
      feeDzd: q.feeDzd,
      subtotalDzd: q.subtotalDzd,
      totalDzd: q.totalDzd,
      feeSource: q.feeSource,
      flags,
      turnstile: verdict,
      fillMs: input.fillMs ?? null,
      riskScore,
      ipHash: ipHashed,
    },
    lines,
    now,
  });
  if (result.ok && result.replayed) {
    // Lost a same-key race: answer exactly like a sequential replay.
    const original = await deps.store.getOrder(result.orderId);
    if (original === null) throw new Error('replayed order not found');
    return { kind: 'replay', status: 201, body: existingBody(original, false) };
  }
  if (result.ok) {
    const ref = result.ref as OrderRef;
    const body: OrderSuccess = {
      ok: true,
      ref,
      status: 'new',
      duplicate: false,
      subtotalDzd: q.subtotalDzd,
      feeDzd: q.feeDzd,
      totalDzd: q.totalDzd,
      confirmationUrl: confirmationUrl(input.lang, ref),
    };
    const message: OrderCreatedMessage = {
      type: 'order.created',
      v: 1,
      orderId: result.orderId,
      ref,
      totalDzd: q.totalDzd,
      wilayaCode: input.wilayaCode,
      lang: input.lang,
      flags: [...flags],
      createdAt: now,
    };
    deps.log('order_created', { ref, flags, riskScore, turnstile: verdict, path: req.path });
    return { kind: 'created', status: 201, body, orderId: result.orderId, message };
  }
  if (result.reason === 'out_of_stock') {
    // Lost the last unit between our read and the write: answer with the current availability.
    const fresh = await quoteFromReads(input, await deps.readPricing(variantIds, input.communeId), deps.fees);
    if (!fresh.ok) {
      const { ok: _ok, ...failure } = fresh;
      return { kind: 'failure', failure };
    }
    return { kind: 'failure', failure: { code: 'out_of_stock', lines: fresh.lines } };
  }
  throw new Error('could not allocate a unique order ref');
}
