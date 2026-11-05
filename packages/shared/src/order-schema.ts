/**
 * Order and quote request schemas (Valibot), response bodies, stable error codes and
 * submission flags. Agreed with `web` (WEB-0 §2–3, §7) and `orderform` (ORDER-0).
 *
 * Error codes are stable API: the storefront shows brand string `order.errors.<code>` in the
 * page language (`orderErrorKey`), the Worker maps them to HTTP status (`ORDER_ERROR_HTTP_STATUS`).
 * Adding a code is a contract change: tell `brand`, `web`, `orderform` and the lead first.
 *
 * Numeric fields accept a JSON number or a decimal string (Eastern Arabic/Persian digits allowed),
 * so the same schema validates `application/json` (JS path) and urlencoded (no-JS path) bodies;
 * `formFieldsToBody` turns flat form fields into the nested shape. Unknown keys are stripped
 * (e.g. Turnstile's own `cf-turnstile-response`).
 */

import * as v from 'valibot';
import type { FeeSource } from './fees.ts';
import { WILAYA_CODE_MAX, WILAYA_CODE_MIN } from './ids.ts';
import { LANGS, type Lang } from './lang.ts';
import { MAX_ORDER_LINES, MAX_QTY_PER_LINE, type Dzd } from './money.ts';
import type { OrderStatus } from './order-state.ts';
import { normalizePhone, toAsciiDigits, type PhoneE164 } from './phone.ts';

// ---------------------------------------------------------------------------------------------
// Error codes

export const ORDER_ERROR_CODES = [
  // Request-level (programming errors or tampering; generic message).
  /** Body not an object/not parseable, or a non-user field (e.g. expectedTotalDzd) malformed. */
  'invalid_request',
  'idempotency_key_invalid',
  /** (server) Cross-site POST (`Sec-Fetch-Site: cross-site`). */
  'forbidden_origin',
  'payload_too_large',
  'unsupported_media_type',
  // Validation: top-level `code` of a 422 whose `errors` carry the field codes below.
  'validation',
  // Field codes (422).
  'lang_invalid',
  /** Name empty after trimming. */
  'name_required',
  /** Name shorter than NAME_MIN_LENGTH, longer than NAME_MAX_LENGTH, without a letter, or with control characters. */
  'name_invalid',
  'phone_required',
  'phone_invalid',
  /** Well-formed Algerian number that is not a mobile (landline, or 050–053 etc.). */
  'phone_not_mobile',
  'wilaya_invalid',
  /** Missing, malformed, or (server check) not a commune of the chosen wilaya. */
  'commune_invalid',
  'items_empty',
  /** Malformed line, duplicate variant, or more than MAX_ORDER_LINES lines. */
  'items_invalid',
  /** No-JS step 1: neither a variant nor a complete option choice was submitted. */
  'variant_required',
  /** Quantity not an integer in 1…MAX_QTY_PER_LINE. */
  'qty_invalid',
  // Business codes (server).
  /** Variant unknown or inactive, product not active, or an impossible option combination. */
  'variant_unavailable',
  /** Not enough stock for the requested quantity (the quote's `lines[i].maxQty` says how many). */
  'out_of_stock',
  /** FeeProvider answered `available: false` for this wilaya/commune. */
  'delivery_unavailable',
  /** Recomputed total ≠ `expectedTotalDzd`; the response carries a fresh `quote`. */
  'total_changed',
  /** Total above MAX_ORDER_TOTAL_DZD (sanity ceiling); the customer is asked to call. */
  'order_total_out_of_range',
  /** Hard rate limit on the phone number; `retryAfterS` says when to retry. */
  'rate_limited',
  /** D1 or FeeProvider failure; retry with the same idempotency key. */
  'server_error',
] as const;
export type OrderErrorCode = (typeof ORDER_ERROR_CODES)[number];

/**
 * Every user-facing error code in @hb/shared (the phone codes are a subset), for brand's
 * string-parity test: each needs `order.errors.<code>` in both languages.
 */
export const ERROR_CODES: readonly OrderErrorCode[] = ORDER_ERROR_CODES;
export type ErrorCode = OrderErrorCode;

export function isOrderErrorCode(value: unknown): value is OrderErrorCode {
  return typeof value === 'string' && (ORDER_ERROR_CODES as readonly string[]).includes(value);
}

/** Brand-string key holding the localized message, e.g. `order.errors.phone_not_mobile`. */
export function orderErrorKey(code: OrderErrorCode): `order.errors.${OrderErrorCode}` {
  return `order.errors.${code}`;
}

export type OrderErrorHttpStatus = 400 | 403 | 409 | 413 | 415 | 422 | 429 | 503;

/** HTTP status for a failure response with this top-level `code`. */
export const ORDER_ERROR_HTTP_STATUS: { readonly [C in OrderErrorCode]: OrderErrorHttpStatus } = {
  invalid_request: 400,
  idempotency_key_invalid: 400,
  forbidden_origin: 403,
  payload_too_large: 413,
  unsupported_media_type: 415,
  validation: 422,
  lang_invalid: 422,
  name_required: 422,
  name_invalid: 422,
  phone_required: 422,
  phone_invalid: 422,
  phone_not_mobile: 422,
  wilaya_invalid: 422,
  commune_invalid: 422,
  items_empty: 422,
  items_invalid: 422,
  variant_required: 422,
  qty_invalid: 422,
  variant_unavailable: 409,
  out_of_stock: 409,
  delivery_unavailable: 409,
  total_changed: 409,
  order_total_out_of_range: 422,
  rate_limited: 429,
  server_error: 503,
};

/** Form field an error belongs to; `form` = not tied to one field. */
export type OrderField =
  | 'lang'
  | 'name'
  | 'phone'
  | 'wilayaCode'
  | 'communeId'
  | 'items'
  | 'idempotencyKey'
  | 'expectedTotalDzd'
  | 'form';

export interface OrderFieldError {
  readonly field: OrderField;
  readonly code: OrderErrorCode;
  /** Index into `items` when the error is about one line. */
  readonly index?: number | undefined;
}

// ---------------------------------------------------------------------------------------------
// Field schemas

/** Name of the honeypot input. Hidden from humans; any non-empty value flags the order. */
export const HONEYPOT_FIELD = 'website';

export const NAME_MIN_LENGTH = 2;
export const NAME_MAX_LENGTH = 80;
/** Upper bound for `fillMs` (24 h); larger or malformed values count as missing. */
export const MAX_FILL_MS = 86_400_000;

/** Integer field from a JSON number or a decimal string (Eastern Arabic/Persian digits accepted); every failure reports `code`. */
function intField(code: OrderErrorCode, min: number, max: number) {
  return v.pipe(
    v.union(
      [v.number(), v.pipe(v.string(), v.transform(toAsciiDigits), v.trim(), v.regex(/^\d{1,15}$/), v.transform(Number))],
      code,
    ),
    v.integer(code),
    v.minValue(min, code),
    v.maxValue(max, code),
  );
}

// Bidi marks, embeddings, overrides, isolates, zero-width space, word joiner and BOM: invisible,
// never part of a name. ZWNJ/ZWJ (U+200C/U+200D) are kept: they shape Arabic-script text.
const INVISIBLE_RE = /[\u200B\u200E\u200F\u061C\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;
// Anything still left that is a control, surrogate, private-use or other format character.
const FORBIDDEN_IN_NAME_RE = /[\p{Cc}\p{Cs}\p{Co}]|(?![\u200C\u200D])\p{Cf}/u;

export const LangSchema = /* @__PURE__ */ v.picklist(LANGS, 'lang_invalid');

/**
 * NFC, invisible marks removed, whitespace collapsed; 2–80 characters with at least one letter;
 * no remaining control/format characters except ZWNJ/ZWJ.
 */
export const NameSchema = /* @__PURE__ */ v.pipe(
  v.string('name_required'),
  v.normalize('NFC'),
  v.transform((s) => s.replace(INVISIBLE_RE, '').replace(/\s+/gu, ' ').trim()),
  v.nonEmpty('name_required'),
  v.check((s) => !FORBIDDEN_IN_NAME_RE.test(s), 'name_invalid'),
  v.regex(/\p{L}/u, 'name_invalid'),
  v.minLength(NAME_MIN_LENGTH, 'name_invalid'),
  v.maxLength(NAME_MAX_LENGTH, 'name_invalid'),
);

/** Validates and normalises an Algerian mobile; output `{ e164, national }`. */
export const PhoneSchema = /* @__PURE__ */ v.pipe(
  v.string('phone_required'),
  v.rawTransform(({ dataset, addIssue, NEVER }) => {
    const r = normalizePhone(dataset.value);
    if (!r.ok) {
      addIssue({ message: r.code });
      return NEVER;
    }
    return { e164: r.e164, national: r.national } as { readonly e164: PhoneE164; readonly national: string };
  }),
);

export const WilayaCodeSchema = /* @__PURE__ */ intField('wilaya_invalid', WILAYA_CODE_MIN, WILAYA_CODE_MAX);
export const CommuneIdSchema = /* @__PURE__ */ intField('commune_invalid', 1, Number.MAX_SAFE_INTEGER);
export const QtySchema = /* @__PURE__ */ intField('qty_invalid', 1, MAX_QTY_PER_LINE);

export const OrderItemSchema = /* @__PURE__ */ v.object(
  {
    variantId: intField('items_invalid', 1, Number.MAX_SAFE_INTEGER),
    qty: QtySchema,
  },
  'items_invalid',
);

export const OrderItemsSchema = /* @__PURE__ */ v.pipe(
  v.array(OrderItemSchema, 'items_invalid'),
  v.minLength(1, 'items_empty'),
  v.maxLength(MAX_ORDER_LINES, 'items_invalid'),
  v.check(
    (items) => new Set(items.map((i) => i.variantId)).size === items.length,
    'items_invalid',
  ),
);

/**
 * UUID made by JS at runtime (`crypto.randomUUID()`, once per form instance, kept across retries),
 * never in static HTML; on the no-JS path the Worker issues it on the review step. Lowercased.
 */
export const IdempotencyKeySchema = /* @__PURE__ */ v.pipe(
  v.string('idempotency_key_invalid'),
  v.trim(),
  v.uuid('idempotency_key_invalid'),
  v.toLowerCase(),
);

const HoneypotSchema = /* @__PURE__ */ v.fallback(v.optional(v.string(), ''), '');

// ---------------------------------------------------------------------------------------------
// Request schemas

/** `POST /api/quote` body: live price/fee/total while the customer fills the form. */
export const QuoteInputSchema = /* @__PURE__ */ v.object(
  {
    items: OrderItemsSchema,
    wilayaCode: WilayaCodeSchema,
    communeId: v.optional(CommuneIdSchema),
  },
  'invalid_request',
);
export type QuoteInput = v.InferOutput<typeof QuoteInputSchema>;

/** `POST /api/order` body: JSON (JS path) or the no-JS review page's confirm step. Totals are never priced from the client. */
export const OrderInputSchema = /* @__PURE__ */ v.object(
  {
    lang: LangSchema,
    items: OrderItemsSchema,
    name: NameSchema,
    phone: PhoneSchema,
    wilayaCode: WilayaCodeSchema,
    communeId: CommuneIdSchema,
    idempotencyKey: IdempotencyKeySchema,
    /** Total the customer saw (quote or review page). Only compared: ≠ recomputed total ⇒ 409 `total_changed` (fresh quote, nothing created). */
    expectedTotalDzd: intField('invalid_request', 0, Number.MAX_SAFE_INTEGER),
    /** Honeypot; never rejects, only flags (`honeypot`). Always a string in the output. */
    [HONEYPOT_FIELD]: HoneypotSchema,
    /**
     * Elapsed ms from the form's first interaction to submit (`performance.now()` on the client;
     * the Worker sets it from the signed review token on the no-JS path). Malformed ⇒ missing.
     */
    fillMs: /* @__PURE__ */ v.fallback(v.optional(intField('invalid_request', 0, MAX_FILL_MS)), undefined),
    /** Turnstile token; missing/invalid ⇒ accept and flag, never reject. */
    turnstileToken: /* @__PURE__ */ v.fallback(v.optional(v.pipe(v.string(), v.maxLength(4096))), undefined),
  },
  'invalid_request',
);
export type OrderInput = v.InferOutput<typeof OrderInputSchema>;
/** Raw input accepted by `OrderInputSchema` (before coercion/normalisation). */
export type OrderInputRaw = v.InferInput<typeof OrderInputSchema>;

/**
 * No-JS step 1 (product page form → server-rendered review). One line, given either as
 * `items: [{variantId, qty}]` or, for size × colour radios, `productId` + `options` + `qty`
 * (the Worker resolves the combination to a variant). `communeId` is optional: the review page
 * adds the commune select. No idempotency key (the review page issues it) and no total.
 */
export const OrderDraftSchema = /* @__PURE__ */ v.object(
  {
    lang: LangSchema,
    name: NameSchema,
    phone: PhoneSchema,
    wilayaCode: WilayaCodeSchema,
    communeId: v.optional(CommuneIdSchema),
    [HONEYPOT_FIELD]: HoneypotSchema,
    items: v.optional(v.pipe(OrderItemsSchema, v.maxLength(1, 'items_invalid'))),
    productId: v.optional(intField('items_invalid', 1, Number.MAX_SAFE_INTEGER)),
    /** optionId → optionValueId. */
    options: v.optional(
      v.record(
        v.pipe(v.string(), v.regex(/^[1-9]\d{0,14}$/)),
        intField('items_invalid', 1, Number.MAX_SAFE_INTEGER),
        'items_invalid',
      ),
    ),
    qty: v.optional(QtySchema),
  },
  'invalid_request',
);

export type DraftSelection =
  | { readonly kind: 'variant'; readonly variantId: number; readonly qty: number }
  | {
      readonly kind: 'options';
      readonly productId: number;
      /** optionId → optionValueId. */
      readonly options: Readonly<Record<number, number>>;
      readonly qty: number;
    };

export interface OrderDraft {
  readonly lang: Lang;
  readonly name: string;
  readonly phone: { readonly e164: PhoneE164; readonly national: string };
  readonly wilayaCode: number;
  readonly communeId?: number | undefined;
  readonly [HONEYPOT_FIELD]: string;
  readonly selection: DraftSelection;
}

/**
 * Flat urlencoded fields → the shape the schemas take: `variantId` + `qty` → `items: [{variantId, qty}]`;
 * `opt.<optionId>=<optionValueId>` → `options`. Other fields pass through unchanged (repeated
 * keys: the first value wins). Use with `parseOrderDraft` (step 1) and `parseOrderInput` (confirm).
 */
export function formFieldsToBody(
  fields: Iterable<readonly [string, string]> | Readonly<Record<string, string>>,
): Record<string, unknown> {
  const entries: Iterable<readonly [string, string]> =
    Symbol.iterator in fields
      ? (fields as Iterable<readonly [string, string]>)
      : Object.entries(fields as Readonly<Record<string, string>>);
  const body: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let options: Record<string, string> | undefined;
  for (const [key, value] of entries) {
    if (key.startsWith('opt.')) {
      options ??= Object.create(null) as Record<string, string>;
      const id = key.slice(4);
      if (!(id in options)) options[id] = value;
    } else if (!(key in body)) {
      body[key] = value;
    }
  }
  if (options !== undefined) body['options'] = { ...options };
  if (body['variantId'] !== undefined) {
    body['items'] = [{ variantId: body['variantId'], qty: body['qty'] }];
    delete body['variantId'];
    delete body['qty'];
  }
  return { ...body };
}

// ---------------------------------------------------------------------------------------------
// Parsing helpers

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly OrderFieldError[] };

const FIELD_DEFAULT_CODE: { readonly [F in Exclude<OrderField, 'form'>]: OrderErrorCode } = {
  lang: 'lang_invalid',
  name: 'name_required',
  phone: 'phone_required',
  wilayaCode: 'wilaya_invalid',
  communeId: 'commune_invalid',
  items: 'items_invalid',
  idempotencyKey: 'idempotency_key_invalid',
  expectedTotalDzd: 'invalid_request',
};

/** Draft-only keys reported on the `items` field. */
const FIELD_ALIAS: Readonly<Record<string, OrderField>> = { productId: 'items', options: 'items', qty: 'items' };

function fieldOf(key: unknown): OrderField {
  if (typeof key !== 'string') return 'form';
  if (Object.hasOwn(FIELD_DEFAULT_CODE, key)) return key as OrderField;
  return FIELD_ALIAS[key] ?? 'form';
}

function toFieldErrors(issues: readonly v.BaseIssue<unknown>[]): OrderFieldError[] {
  const out: OrderFieldError[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    const rootKey = issue.path?.[0]?.key;
    const field = fieldOf(rootKey);
    let code: OrderErrorCode;
    if (isOrderErrorCode(issue.message)) code = issue.message;
    else if (field === 'form') code = 'invalid_request';
    else if (rootKey === 'qty') code = 'qty_invalid';
    else code = FIELD_DEFAULT_CODE[field];
    const idx = rootKey === 'items' ? issue.path?.[1]?.key : undefined;
    const index = typeof idx === 'number' ? idx : undefined;
    // One error per field (per line for items): the first issue is the most basic one.
    const dedupe = `${field}|${index ?? ''}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(index === undefined ? { field, code } : { field, code, index });
  }
  return out;
}

const INVALID_REQUEST: ParseResult<never> = { ok: false, errors: [{ field: 'form', code: 'invalid_request' }] };

function isPlainBody(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function parseWith<S extends v.GenericSchema>(schema: S, input: unknown): ParseResult<v.InferOutput<S>> {
  if (!isPlainBody(input)) return INVALID_REQUEST;
  const r = v.safeParse(schema, input);
  return r.success ? { ok: true, value: r.output } : { ok: false, errors: toFieldErrors(r.issues) };
}

export function parseOrderInput(input: unknown): ParseResult<OrderInput> {
  return parseWith(OrderInputSchema, input);
}

export function parseQuoteInput(input: unknown): ParseResult<QuoteInput> {
  return parseWith(QuoteInputSchema, input);
}

/** Parses no-JS step 1 (after `formFieldsToBody`). Missing selection ⇒ `variant_required` on `items`. */
export function parseOrderDraft(input: unknown): ParseResult<OrderDraft> {
  if (!isPlainBody(input)) return INVALID_REQUEST;
  const hasVariant = input['items'] !== undefined;
  const hasOptions =
    input['productId'] !== undefined &&
    isPlainBody(input['options']) &&
    Object.keys(input['options']).length > 0 &&
    input['qty'] !== undefined;
  const missing: OrderFieldError[] =
    hasVariant || hasOptions ? [] : [{ field: 'items', code: 'variant_required' }];
  const r = v.safeParse(OrderDraftSchema, input);
  if (!r.success) {
    const errors = toFieldErrors(r.issues);
    return { ok: false, errors: missing.length > 0 && !errors.some((e) => e.field === 'items') ? [...errors, ...missing] : errors };
  }
  if (missing.length > 0) return { ok: false, errors: missing };
  const o = r.output;
  const line = o.items?.[0];
  // Check the parsed options, not the raw ones: v.record drops keys such as `__proto__`.
  if (line === undefined && Object.keys(o.options ?? {}).length === 0) {
    return { ok: false, errors: [{ field: 'items', code: 'variant_required' }] };
  }
  const selection: DraftSelection =
    line !== undefined
      ? { kind: 'variant', variantId: line.variantId, qty: line.qty }
      : {
          kind: 'options',
          productId: o.productId as number,
          options: Object.fromEntries(Object.entries(o.options ?? {}).map(([k, val]) => [Number(k), val])),
          qty: o.qty as number,
        };
  const draft: OrderDraft = {
    lang: o.lang,
    name: o.name,
    phone: o.phone,
    wilayaCode: o.wilayaCode,
    [HONEYPOT_FIELD]: o[HONEYPOT_FIELD],
    selection,
    ...(o.communeId === undefined ? {} : { communeId: o.communeId }),
  };
  return { ok: true, value: draft };
}

/**
 * Top-level `code` for a failed parse: a request-level code when one is present (400),
 * otherwise `validation` (422).
 */
export function failureCode(errors: readonly OrderFieldError[]): OrderErrorCode {
  const req = errors.find((e) => e.code === 'invalid_request' || e.code === 'idempotency_key_invalid');
  return req === undefined ? 'validation' : req.code;
}

// ---------------------------------------------------------------------------------------------
// Responses (JSON bodies of /api/quote and /api/order; `Cache-Control: no-store`)

export interface QuoteLine {
  readonly variantId: number;
  readonly qty: number;
  readonly unitPriceDzd: Dzd;
  readonly lineTotalDzd: Dzd;
  /** Most the customer can order now: min(tracked stock, MAX_QTY_PER_LINE); 0 = unavailable. */
  readonly maxQty: number;
}

export type QuoteSuccess =
  | {
      readonly ok: true;
      readonly available: true;
      readonly lines: readonly QuoteLine[];
      readonly subtotalDzd: Dzd;
      readonly feeDzd: Dzd;
      readonly totalDzd: Dzd;
      readonly feeSource: FeeSource;
      readonly etaDays?: number | undefined;
    }
  | {
      /** Delivery not available to this wilaya/commune: show subtotal, block confirmation. */
      readonly ok: true;
      readonly available: false;
      readonly lines: readonly QuoteLine[];
      readonly subtotalDzd: Dzd;
      readonly feeDzd: null;
      readonly totalDzd: null;
      readonly feeSource: FeeSource;
    };

/** Every non-2xx JSON body of /api/quote and /api/order. HTTP status = `ORDER_ERROR_HTTP_STATUS[code]`. */
export interface ApiFailure {
  readonly ok: false;
  readonly code: OrderErrorCode;
  /** Field errors (with `code: 'validation'`, or a 400 request-level code). */
  readonly errors?: readonly OrderFieldError[] | undefined;
  /** Fresh quote with `total_changed`, `out_of_stock`, `variant_unavailable`, `delivery_unavailable` on /api/order. */
  readonly quote?: QuoteSuccess | undefined;
  /** Per-line availability with `out_of_stock` / `variant_unavailable` on /api/quote. */
  readonly lines?: readonly QuoteLine[] | undefined;
  /** With `rate_limited` and `server_error` (mirrors the `Retry-After` header). */
  readonly retryAfterS?: number | undefined;
}

export type QuoteResponse = QuoteSuccess | ApiFailure;

/** Public order reference, e.g. `HB-7K2Q9`. Render inside `<bdi>`. */
export type OrderRef = `HB-${string}`;

export interface OrderSuccess {
  readonly ok: true;
  readonly ref: OrderRef;
  /** `new` for a fresh order; the stored status when an existing order is returned. */
  readonly status: OrderStatus;
  /**
   * True when the existing order for the same phone + variant (within DUPLICATE_WINDOW_MS) is
   * returned instead of creating one. An idempotent replay returns the original body unchanged.
   * HTTP 201 for a new order, 200 for a replay or a duplicate.
   */
  readonly duplicate: boolean;
  readonly subtotalDzd: Dzd;
  readonly feeDzd: Dzd;
  readonly totalDzd: Dzd;
  /** `/{lang}/order/confirmation/?ref=HB-XXXXX`. */
  readonly confirmationUrl: string;
}

export type OrderResponse = OrderSuccess | ApiFailure;

// ---------------------------------------------------------------------------------------------
// Order reference

/** Crockford-style alphabet without I, L, O, U (no 0/O or 1/I confusion when read on the phone). */
export const ORDER_REF_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ORDER_REF_RE = /^HB-[0-9A-HJKMNP-TV-Z]{5}$/;

export function isOrderRef(value: unknown): value is OrderRef {
  return typeof value === 'string' && ORDER_REF_RE.test(value);
}

/**
 * Builds a reference from ≥ 5 random bytes (`crypto.getRandomValues(new Uint8Array(5))`).
 * 32⁵ ≈ 33.5 M values; the caller retries on a unique-constraint collision.
 */
export function makeOrderRef(random: Uint8Array): OrderRef {
  if (random.length < 5) throw new RangeError('makeOrderRef needs at least 5 random bytes');
  let s = '';
  for (let i = 0; i < 5; i++) s += ORDER_REF_ALPHABET[(random[i] as number) % 32];
  return `HB-${s}`;
}

// ---------------------------------------------------------------------------------------------
// Anti-spam flags (STACK-REPORT §6). Flags never reject an order; they mark it for review.
// Canonical vocabulary (lead ruling): stored as a JSON array in `orders.flags`; `web` sets them,
// the admin displays them. Adding a flag is a contract change (tell db, web, admin-orders).

export const ORDER_FLAGS = [
  /** Honeypot field was filled. */
  'honeypot',
  /** `fillMs` below the minimum (MIN_FILL_MS with JS, MIN_REVIEW_MS review → confirm without JS). */
  'fast_fill',
  /** `fillMs` missing or malformed (JS path), or review token missing/invalid (no-JS path). */
  'fill_time_missing',
  'turnstile_missing',
  /** siteverify said no, wrong hostname/action, or siteverify failed (`orders.turnstile` keeps the precise verdict). */
  'turnstile_invalid',
  /** Same phone + variant within DUPLICATE_WINDOW_MS of an existing order. */
  'duplicate',
  /** Soft limits: IP secondary limit or per-phone 24 h velocity. The hard phone limit answers error `rate_limited`. */
  'rate_limited',
  /** Customer is marked blocked in the admin. Accepted silently, flagged for review. */
  'blocked_customer',
] as const;
export type OrderFlag = (typeof ORDER_FLAGS)[number];

export function isOrderFlag(value: unknown): value is OrderFlag {
  return typeof value === 'string' && (ORDER_FLAGS as readonly string[]).includes(value);
}

/** Minimum `fillMs` on the JS path (first interaction → submit). */
export const MIN_FILL_MS = 2_500;
/** Minimum review → confirm time on the no-JS path (server-measured from the review token). */
export const MIN_REVIEW_MS = 1_500;
export const DUPLICATE_WINDOW_MS = 30 * 60 * 1000;

/**
 * Result of the server-side Turnstile check, as stored in `orders.turnstile` (DB-1 values);
 * `error` = siteverify timeout/network failure.
 */
export type TurnstileVerdict = 'ok' | 'invalid' | 'missing' | 'error';

/**
 * Flags derived from the submission itself. The Worker adds `duplicate`, `rate_limited` and
 * `blocked_customer` from its own checks. Pass `MIN_REVIEW_MS` as `minFillMs` on the no-JS path.
 */
export function submissionFlags(
  input: Pick<OrderInput, typeof HONEYPOT_FIELD | 'fillMs'>,
  turnstile: TurnstileVerdict,
  minFillMs: number = MIN_FILL_MS,
): OrderFlag[] {
  const flags: OrderFlag[] = [];
  if (input[HONEYPOT_FIELD].trim() !== '') flags.push('honeypot');
  if (input.fillMs === undefined) flags.push('fill_time_missing');
  else if (input.fillMs < minFillMs) flags.push('fast_fill');
  if (turnstile === 'missing') flags.push('turnstile_missing');
  else if (turnstile === 'invalid' || turnstile === 'error') flags.push('turnstile_invalid');
  return flags;
}
