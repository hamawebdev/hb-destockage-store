/**
 * Valibot schemas for the JSON response bodies of `/api/quote` and `/api/order` (SHARED-3).
 * For tests: `web` validates every body it sends, `orderform` validates its fixtures. Strict
 * objects, so a leaked extra field (e.g. customer data) fails. Shapes equal the TS types in
 * `order-schema.ts`; no new codes.
 */

import * as v from 'valibot';
import type { FeeSource } from './fees.ts';
import { MAX_QTY_PER_LINE } from './money.ts';
import { ORDER_ERROR_CODES, ORDER_REF_RE, isOrderRef, type OrderField, type OrderRef } from './order-schema.ts';
import { ORDER_STATUSES } from './order-state.ts';

const DzdSchema = /* @__PURE__ */ v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const PositiveIdSchema = /* @__PURE__ */ v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const FeeSourceSchema = /* @__PURE__ */ v.custom<FeeSource>(
  (x) => typeof x === 'string' && (x === 'table' || /^courier:[a-z0-9_-]+$/.test(x)),
  'invalid feeSource',
);
const ORDER_FIELDS = [
  'lang',
  'name',
  'phone',
  'wilayaCode',
  'communeId',
  'items',
  'idempotencyKey',
  'expectedTotalDzd',
  'form',
] as const satisfies readonly OrderField[];

export const QuoteLineSchema = /* @__PURE__ */ v.pipe(
  v.strictObject({
    variantId: PositiveIdSchema,
    qty: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_QTY_PER_LINE)),
    unitPriceDzd: DzdSchema,
    lineTotalDzd: DzdSchema,
    maxQty: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_QTY_PER_LINE)),
  }),
  v.check((l) => l.lineTotalDzd === l.unitPriceDzd * l.qty, 'lineTotalDzd ≠ unitPriceDzd × qty'),
);

const sumLines = (lines: readonly { lineTotalDzd: number }[]): number => lines.reduce((s, l) => s + l.lineTotalDzd, 0);

export const QuoteSuccessSchema = /* @__PURE__ */ v.pipe(
  v.variant('available', [
    v.strictObject({
      ok: v.literal(true),
      available: v.literal(true),
      lines: v.array(QuoteLineSchema),
      subtotalDzd: DzdSchema,
      feeDzd: DzdSchema,
      totalDzd: DzdSchema,
      feeSource: FeeSourceSchema,
      etaDays: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
    }),
    v.strictObject({
      ok: v.literal(true),
      available: v.literal(false),
      lines: v.array(QuoteLineSchema),
      subtotalDzd: DzdSchema,
      feeDzd: v.null(),
      totalDzd: v.null(),
      feeSource: FeeSourceSchema,
    }),
  ]),
  v.check((q) => q.subtotalDzd === sumLines(q.lines), 'subtotalDzd ≠ sum of lines'),
  v.check((q) => !q.available || q.totalDzd === q.subtotalDzd + q.feeDzd, 'totalDzd ≠ subtotalDzd + feeDzd'),
);

export const OrderFieldErrorSchema = /* @__PURE__ */ v.strictObject({
  field: v.picklist(ORDER_FIELDS),
  code: v.picklist(ORDER_ERROR_CODES),
  index: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

export const ApiFailureSchema = /* @__PURE__ */ v.strictObject({
  ok: v.literal(false),
  code: v.picklist(ORDER_ERROR_CODES),
  errors: v.optional(v.array(OrderFieldErrorSchema)),
  quote: v.optional(QuoteSuccessSchema),
  lines: v.optional(v.array(QuoteLineSchema)),
  retryAfterS: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
});

export const QuoteResponseSchema = /* @__PURE__ */ v.union([QuoteSuccessSchema, ApiFailureSchema]);

const CONFIRMATION_URL_RE = new RegExp(`^/(ar|fr)/order/confirmation/\\?ref=${ORDER_REF_RE.source.slice(1, -1)}$`);

export const OrderSuccessSchema = /* @__PURE__ */ v.pipe(
  v.strictObject({
    ok: v.literal(true),
    ref: v.custom<OrderRef>(isOrderRef, 'invalid ref'),
    status: v.picklist(ORDER_STATUSES),
    duplicate: v.boolean(),
    subtotalDzd: DzdSchema,
    feeDzd: DzdSchema,
    totalDzd: DzdSchema,
    confirmationUrl: v.pipe(v.string(), v.regex(CONFIRMATION_URL_RE)),
  }),
  v.check((o) => o.totalDzd === o.subtotalDzd + o.feeDzd, 'totalDzd ≠ subtotalDzd + feeDzd'),
  v.check((o) => o.confirmationUrl.endsWith(`ref=${o.ref}`), 'confirmationUrl ref ≠ ref'),
);

export const OrderResponseSchema = /* @__PURE__ */ v.union([OrderSuccessSchema, ApiFailureSchema]);
