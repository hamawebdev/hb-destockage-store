/**
 * Order and quote request schemas (Valibot), response types, stable error codes and
 * submission flags.
 *
 * Error codes are stable API: the storefront shows brand string `order.errors.<code>` in the
 * page language (`orderErrorKey`), the Worker maps them to HTTP status (`ORDER_ERROR_HTTP_STATUS`).
 * Adding a code is a contract change: tell `brand`, `web`, `orderform` and the lead first.
 *
 * Numeric fields accept a JSON number or a decimal ASCII string, so the same schema validates
 * `application/json` (JS path) and `application/x-www-form-urlencoded` (no-JS path) bodies.
 * Unknown keys are stripped (e.g. Turnstile's own `cf-turnstile-response`).
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
  /** Body is not an object / not parseable. */
  'invalid_request',
  'lang_invalid',
  'name_invalid',
  'phone_required',
  'phone_invalid',
  /** Well-formed Algerian number that is not a mobile (landline, or 050–053 etc.). */
  'phone_not_mobile',
  'wilaya_invalid',
  /** Missing, malformed, or (server check) not a commune of the chosen wilaya. */
  'commune_invalid',
  'items_empty',
  /** Malformed line, unknown key shape, duplicate variant, or more than MAX_ORDER_LINES lines. */
  'items_invalid',
  /** Quantity not an integer in 1…MAX_QTY_PER_LINE. */
  'qty_invalid',
  /** (server) Variant unknown, inactive, or its product not active. */
  'variant_unavailable',
  /** (server) Not enough stock for the requested quantity. */
  'out_of_stock',
  /** (server) FeeProvider answered `available: false` for this wilaya/commune. */
  'delivery_unavailable',
  'idempotency_key_invalid',
  /** (server) Rate limit on phone (primary key) or IP (secondary). */
  'rate_limited',
  /** (server) Unexpected failure, including a FeeProvider rejection. */
  'server_error',
] as const;
export type OrderErrorCode = (typeof ORDER_ERROR_CODES)[number];

export function isOrderErrorCode(value: unknown): value is OrderErrorCode {
  return typeof value === 'string' && (ORDER_ERROR_CODES as readonly string[]).includes(value);
}

/** Brand-string key holding the localized message, e.g. `order.errors.phone_not_mobile`. */
export function orderErrorKey(code: OrderErrorCode): `order.errors.${OrderErrorCode}` {
  return `order.errors.${code}`;
}

/** HTTP status the Worker answers for a response whose first error has this code. */
export const ORDER_ERROR_HTTP_STATUS: { readonly [C in OrderErrorCode]: 400 | 409 | 422 | 429 | 500 } = {
  invalid_request: 400,
  lang_invalid: 422,
  name_invalid: 422,
  phone_required: 422,
  phone_invalid: 422,
  phone_not_mobile: 422,
  wilaya_invalid: 422,
  commune_invalid: 422,
  items_empty: 422,
  items_invalid: 422,
  qty_invalid: 422,
  variant_unavailable: 409,
  out_of_stock: 409,
  delivery_unavailable: 422,
  idempotency_key_invalid: 422,
  rate_limited: 429,
  server_error: 500,
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

export const LangSchema = /* @__PURE__ */ v.picklist(LANGS, 'lang_invalid');

export const NameSchema = /* @__PURE__ */ v.pipe(
  v.string('name_invalid'),
  v.normalize('NFC'),
  v.transform((s) => s.replace(/\s+/gu, ' ').trim()),
  v.regex(/^[^\p{Cc}\p{Cs}\p{Co}]*$/u, 'name_invalid'),
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

export const OrderItemSchema = /* @__PURE__ */ v.object(
  {
    variantId: intField('items_invalid', 1, Number.MAX_SAFE_INTEGER),
    qty: intField('qty_invalid', 1, MAX_QTY_PER_LINE),
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

export const IdempotencyKeySchema = /* @__PURE__ */ v.pipe(
  v.string('idempotency_key_invalid'),
  v.trim(),
  v.uuid('idempotency_key_invalid'),
  v.toLowerCase(),
);

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

/** `POST /api/order` body (and the no-JS confirm step). Totals are never accepted from the client. */
export const OrderInputSchema = /* @__PURE__ */ v.object(
  {
    lang: LangSchema,
    items: OrderItemsSchema,
    name: NameSchema,
    phone: PhoneSchema,
    wilayaCode: WilayaCodeSchema,
    communeId: CommuneIdSchema,
    /** UUID made when the form is rendered (JS) or by the Worker's review step (no-JS). Unique in D1. */
    idempotencyKey: IdempotencyKeySchema,
    /** Honeypot; never rejects, only flags (`honeypot`). Always a string in the output. */
    [HONEYPOT_FIELD]: /* @__PURE__ */ v.fallback(v.optional(v.string(), ''), ''),
    /** Epoch ms when the form became interactive; malformed ⇒ treated as missing. */
    formStartedAt: /* @__PURE__ */ v.fallback(
      v.optional(intField('invalid_request', 0, Number.MAX_SAFE_INTEGER)),
      undefined,
    ),
    /** Turnstile token; missing/invalid ⇒ accept and flag, never reject. */
    turnstileToken: /* @__PURE__ */ v.fallback(v.optional(v.pipe(v.string(), v.maxLength(4096))), undefined),
  },
  'invalid_request',
);
export type OrderInput = v.InferOutput<typeof OrderInputSchema>;
/** Raw input accepted by `OrderInputSchema` (before coercion/normalisation). */
export type OrderInputRaw = v.InferInput<typeof OrderInputSchema>;

/** No-JS first step (server-rendered review): everything except the idempotency key, which the review page mints. */
export const OrderDraftSchema = /* @__PURE__ */ v.omit(OrderInputSchema, ['idempotencyKey']);
export type OrderDraft = v.InferOutput<typeof OrderDraftSchema>;

// ---------------------------------------------------------------------------------------------
// Parsing helpers

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly OrderFieldError[] };

const FIELD_DEFAULT_CODE: { readonly [F in Exclude<OrderField, 'form'>]: OrderErrorCode } = {
  lang: 'lang_invalid',
  name: 'name_invalid',
  phone: 'phone_required',
  wilayaCode: 'wilaya_invalid',
  communeId: 'commune_invalid',
  items: 'items_invalid',
  idempotencyKey: 'idempotency_key_invalid',
};

function toFieldErrors(issues: readonly v.BaseIssue<unknown>[]): OrderFieldError[] {
  const out: OrderFieldError[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    const key = issue.path?.[0]?.key;
    const field: OrderField =
      typeof key === 'string' && Object.hasOwn(FIELD_DEFAULT_CODE, key) ? (key as OrderField) : 'form';
    const code: OrderErrorCode = isOrderErrorCode(issue.message)
      ? issue.message
      : field === 'form'
        ? 'invalid_request'
        : FIELD_DEFAULT_CODE[field];
    const idx = field === 'items' ? issue.path?.[1]?.key : undefined;
    const index = typeof idx === 'number' ? idx : undefined;
    const dedupe = `${field}|${code}|${index ?? ''}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(index === undefined ? { field, code } : { field, code, index });
  }
  return out;
}

const INVALID_REQUEST: ParseResult<never> = { ok: false, errors: [{ field: 'form', code: 'invalid_request' }] };

function parseWith<S extends v.GenericSchema>(schema: S, input: unknown): ParseResult<v.InferOutput<S>> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return INVALID_REQUEST;
  const r = v.safeParse(schema, input);
  return r.success ? { ok: true, value: r.output } : { ok: false, errors: toFieldErrors(r.issues) };
}

export function parseOrderInput(input: unknown): ParseResult<OrderInput> {
  return parseWith(OrderInputSchema, input);
}
export function parseOrderDraft(input: unknown): ParseResult<OrderDraft> {
  return parseWith(OrderDraftSchema, input);
}
export function parseQuoteInput(input: unknown): ParseResult<QuoteInput> {
  return parseWith(QuoteInputSchema, input);
}

// ---------------------------------------------------------------------------------------------
// Responses (JSON bodies of /api/quote and /api/order)

export interface QuoteLine {
  readonly variantId: number;
  readonly qty: number;
  readonly unitPriceDzd: Dzd;
  readonly lineTotalDzd: Dzd;
}

export type QuoteResponse =
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
    }
  | { readonly ok: false; readonly errors: readonly OrderFieldError[] };

/** Public order reference, e.g. `HB-7K2Q9`. Render inside `<bdi>`. */
export type OrderRef = `HB-${string}`;

export type OrderResponse =
  | {
      readonly ok: true;
      readonly ref: OrderRef;
      /** `new` for a fresh order; the current status when an existing order is returned. */
      readonly status: OrderStatus;
      readonly lang: Lang;
      readonly subtotalDzd: Dzd;
      readonly feeDzd: Dzd;
      readonly totalDzd: Dzd;
      /**
       * Set when an existing order is returned instead of creating one (HTTP 200 either way):
       * `idempotency` = same idempotencyKey replayed; `duplicate` = same phone + variant within
       * DUPLICATE_WINDOW_MS (that order gets flag `duplicate`).
       */
      readonly reused?: 'idempotency' | 'duplicate' | undefined;
    }
  | { readonly ok: false; readonly errors: readonly OrderFieldError[] };

// ---------------------------------------------------------------------------------------------
// Order reference

/** Crockford-style alphabet without I, L, O, U (no 0/O or 1/I confusion when read on the phone). */
export const ORDER_REF_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ORDER_REF_RE = /^HB-[0-9A-HJKMNP-TV-Z]{5}$/;

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
  /** Submitted less than MIN_FILL_MS after formStartedAt. */
  'fast_fill',
  /** formStartedAt missing or malformed. */
  'fill_time_missing',
  'turnstile_missing',
  'turnstile_invalid',
  /** Same phone + variant within DUPLICATE_WINDOW_MS of an existing order. */
  'duplicate',
  /** Soft rate limit (phone first, IP second) exceeded; the hard limit answers error `rate_limited`. */
  'rate_limited',
  /** Customer is marked blocked in the admin. Accepted silently, flagged for review. */
  'blocked_customer',
] as const;
export type OrderFlag = (typeof ORDER_FLAGS)[number];

export function isOrderFlag(value: unknown): value is OrderFlag {
  return typeof value === 'string' && (ORDER_FLAGS as readonly string[]).includes(value);
}

export const MIN_FILL_MS = 3_000;
export const DUPLICATE_WINDOW_MS = 30 * 60 * 1000;

export type TurnstileVerdict = 'valid' | 'invalid' | 'missing';

/**
 * Flags derived from the submission itself. The Worker adds `duplicate`, `rate_limited` and
 * `blocked_customer` from its own checks.
 */
export function submissionFlags(
  input: Pick<OrderInput, typeof HONEYPOT_FIELD | 'formStartedAt'>,
  turnstile: TurnstileVerdict,
  nowMs: number,
): OrderFlag[] {
  const flags: OrderFlag[] = [];
  if (input[HONEYPOT_FIELD].trim() !== '') flags.push('honeypot');
  if (input.formStartedAt === undefined) flags.push('fill_time_missing');
  else if (nowMs - input.formStartedAt < MIN_FILL_MS) flags.push('fast_fill');
  if (turnstile === 'missing') flags.push('turnstile_missing');
  else if (turnstile === 'invalid') flags.push('turnstile_invalid');
  return flags;
}
