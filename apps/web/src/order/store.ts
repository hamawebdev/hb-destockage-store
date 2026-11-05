/**
 * The order flow's persistence port. Signatures follow db's DB-4 plan (artifacts/DB-4/plan.md §2–3,
 * approved): `createOrder` and the dedup helpers are implemented in `@hb/db`; the reads web needs
 * for the response body live in the D1 adapter (`d1-store.ts`). Tests use an in-memory fake.
 */
import type { Lang, OrderFlag, OrderRef, OrderStatus, TurnstileVerdict } from '@hb/shared';

/** What the API returns for an order that already exists (replay or duplicate). */
export interface ExistingOrder {
  readonly id: number;
  readonly ref: OrderRef;
  readonly status: OrderStatus;
  readonly lang: Lang;
  readonly subtotalDzd: number;
  readonly feeDzd: number;
  readonly totalDzd: number;
}

export interface CreateOrderLine {
  readonly variantId: number;
  readonly productId: number;
  readonly nameFr: string;
  readonly nameAr: string;
  readonly variantLabelFr: string | null;
  readonly variantLabelAr: string | null;
  readonly sku: string;
  readonly unitPriceDzd: number;
  readonly qty: number;
  readonly lineTotalDzd: number;
}

export interface CreateOrderInput {
  readonly customer: { readonly phoneE164: string; readonly name: string };
  readonly order: {
    readonly ref: OrderRef;
    readonly idempotencyKey: string;
    readonly lang: Lang;
    readonly wilayaCode: number;
    readonly communeId: number;
    readonly feeDzd: number;
    readonly subtotalDzd: number;
    readonly totalDzd: number;
    readonly feeSource: string;
    readonly flags: readonly OrderFlag[];
    readonly turnstile: TurnstileVerdict | null;
    readonly fillMs: number | null;
    readonly riskScore: number | null;
    readonly ipHash: string | null;
  };
  readonly lines: readonly CreateOrderLine[];
  readonly now?: number;
}

export type CreateOrderResult =
  | { readonly ok: true; readonly orderId: number; readonly ref: string; readonly replayed: boolean }
  | { readonly ok: false; readonly reason: 'out_of_stock'; readonly variantIds: readonly number[] }
  | { readonly ok: false; readonly reason: 'ref_collision' };

/** The phone's recent history, read in one round trip before deciding dedup / velocity / blocked. */
export interface PhoneHistory {
  /** Most recent non-cancelled order for this phone with an overlapping variant inside the dedup window. */
  readonly duplicate: ExistingOrder | null;
  /** Non-cancelled orders for this phone in the last 24 h. */
  readonly ordersLast24h: number;
  readonly blocked: boolean;
}

/** What the second (duplicate) submission asked for, kept as an order_events note for the confirmer. */
export interface DuplicateAttempt {
  readonly items: readonly { readonly variantId: number; readonly qty: number }[];
  readonly wilayaCode: number;
  readonly communeId: number;
}

export interface OrderStore {
  findByIdempotencyKey(key: string): Promise<ExistingOrder | null>;
  getOrder(id: number): Promise<ExistingOrder | null>;
  phoneHistory(phoneE164: string, variantIds: readonly number[], now: number): Promise<PhoneHistory>;
  markDuplicate(orderId: number, attempt: DuplicateAttempt, now: number): Promise<void>;
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  /** Append-only trace that the `order.created` notification could not be enqueued (no PII). */
  noteEnqueueFailed(orderId: number, now: number): Promise<void>;
}
