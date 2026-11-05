/**
 * Order form view model (ORDER-1). Pure: everything `OrderForm.astro` renders is computed here so it
 * can be unit-tested without compiling Astro. Plan: artifacts/ORDER-0/plan.md §2.
 *
 * Invariants (tested):
 *  - No idempotency key, no timestamp and nothing per-visitor in the output (static HTML is shared by
 *    every visitor; the key is made by order.js, or by the Worker's review step without JS).
 *  - The phone pattern is `@hb/shared`'s libphonenumber NSN pattern, never `^0[567]…`.
 *  - Field names are the urlencoded no-JS contract (WEB-0 §2.3): lang, productId, variantId | opt.*,
 *    qty, name, phone, wilayaCode, communeId, website, step.
 * Owner: orderform.
 */
import type { ContactProps, Lang, OrderFormProps, StringTable, VariantProps } from '@hb/catalog';
import { DZ_MOBILE_NSN_PATTERN } from '@hb/shared/phone';
import { HONEYPOT_FIELD, NAME_MIN_LENGTH } from '@hb/shared/order-schema';
import { ltr, str } from './str.ts';

/**
 * Raw phone input cap = @hb/shared `PHONE_INPUT_MAX_LENGTH` (SHARED-2, 64; not yet on this branch's shared copy:
 * switch to the import when SHARED-2 is on main). Never lower: `maxlength` silently truncates spellings the server
 * accepts, e.g. "00213 (0) 555 12 34 56" (ORDER-1 review r1 F1). The name field has no raw cap at all: the server
 * trims and collapses whitespace before checking NAME_MAX_LENGTH, so a raw cap could cut a valid name.
 */
export const PHONE_INPUT_MAX_LENGTH = 64;

export interface OrderFormInput {
  readonly lang: Lang;
  readonly form: OrderFormProps;
  readonly productName: string;
  readonly brandLatin: string | null;
  /** `LayoutProps.strings`. */
  readonly strings: StringTable;
  /** `LayoutProps.contact` (unavailable state, error messages with {phone}). */
  readonly contact: ContactProps;
  /** Privacy page (`LayoutProps.footerLinks` key `privacy`); null hides the link. */
  readonly privacyHref?: string | null;
  /** `?v=` content hash of /js/order.js; null ⇒ no `data-js` (script not built yet). */
  readonly jsVersion?: string | null;
  /** `?v=` content hash of /js/order-ts.js (lazy Turnstile loader, ORDER-3). */
  readonly tsJsVersion?: string | null;
}

/** Messages order.js needs at runtime, keyed by the code it looks up. Values are brand keys. */
export const CLIENT_MESSAGE_KEYS = {
  name_required: 'order.errors.name_required',
  wilaya_required: 'order.errors.wilaya_required',
  commune_required: 'order.errors.commune_required',
  name_invalid: 'order.errors.name_invalid',
  phone_required: 'order.errors.phone_required',
  phone_invalid: 'order.errors.phone_invalid',
  phone_not_mobile: 'order.errors.phone_not_mobile',
  wilaya_invalid: 'order.errors.wilaya_invalid',
  commune_invalid: 'order.errors.commune_invalid',
  qty_invalid: 'order.errors.qty_invalid',
  items_invalid: 'order.errors.items_invalid',
  variant_required: 'product.option.choose',
  variant_unavailable: 'order.errors.variant_unavailable',
  out_of_stock: 'order.errors.out_of_stock',
  delivery_unavailable: 'order.errors.delivery_unavailable',
  rate_limited: 'order.errors.rate_limited',
  server_error: 'order.errors.server_error',
  invalid_request: 'order.errors.invalid_request',
  network_error: 'order.errors.network_error',
  quote_failed: 'order.errors.quote_failed',
  total_changed: 'order.errors.total_changed',
  check_total: 'order.summary.check',
  calculating: 'order.summary.calculating',
  updated: 'order.summary.updated',
  delivery_to: 'order.summary.deliveryTo',
  delivery_pending: 'order.summary.deliveryPending',
  submitting: 'order.submitting',
  submit: 'order.submit',
  commune_placeholder: 'order.commune.placeholder',
  commune_waiting: 'order.commune.waiting',
  loading: 'common.loading',
  retry: 'common.retry',
  count_zero: 'order.errors.count.zero',
  count_one: 'order.errors.count.one',
  count_two: 'order.errors.count.two',
  count_few: 'order.errors.count.few',
  count_many: 'order.errors.count.many',
  count_other: 'order.errors.count.other',
} as const;

export type ClientMessageCode = keyof typeof CLIENT_MESSAGE_KEYS;

export interface Option {
  readonly value: string;
  readonly label: string;
}

export interface OrderFormModel {
  readonly lang: Lang;
  readonly orderable: boolean;
  /** `data-*` attributes on `<form>`, in render order. */
  readonly dataAttrs: Readonly<Record<string, string>>;
  readonly hidden: readonly { readonly name: string; readonly value: string }[];
  readonly wilayas: readonly Option[];
  readonly qty: { readonly min: number; readonly max: number; readonly value: number };
  readonly name: { readonly minLength: number };
  readonly phone: { readonly maxLength: number };
  readonly honeypotName: string;
  readonly messages: readonly { readonly code: ClientMessageCode; readonly text: string }[];
  readonly summary: {
    readonly product: string;
    readonly variantLabel: string;
    readonly unitPrice: string;
    readonly qty: string;
    readonly subtotal: string;
    readonly delivery: string;
    readonly total: string;
  };
  /** Every visible string, resolved (missing keys appear as `[PLACEHOLDER] key`). */
  readonly t: (key: string) => string;
  readonly contact: ContactProps;
  readonly privacyHref: string | null;
}

/** `id:priceDzd:maxQty` per available-or-not variant, comma-separated (order.js local display/clamp only). */
export function variantsAttr(variants: readonly VariantProps[]): string {
  return variants.map((v) => `${v.id}:${v.price.amountDzd}:${v.maxQty}`).join(',');
}

export function defaultVariant(form: OrderFormProps): VariantProps | undefined {
  return form.variants.find((v) => v.id === form.defaultVariantId) ?? form.variants[0];
}

export function orderFormModel(input: OrderFormInput): OrderFormModel {
  const { lang, form, strings, contact } = input;
  const t = (key: string): string => str(strings, key);
  const phone = ltr(contact.phoneDisplay);
  const optionNames = form.options.map((o) => o.name).join(' / ') || t('order.variant.label');

  const messages = (Object.keys(CLIENT_MESSAGE_KEYS) as ClientMessageCode[]).map((code) => ({
    code,
    // {phone} and {option} are known at build; {max}, {total}, {wilaya}, {count} are filled by order.js.
    text: str(strings, CLIENT_MESSAGE_KEYS[code], { phone, option: optionNames }),
  }));

  const dv = defaultVariant(form);
  const maxQty = Math.max(1, Math.min(form.qty.max, dv?.maxQty ?? form.qty.max));

  const dataAttrs: Record<string, string> = {};
  if (input.jsVersion) dataAttrs['data-js'] = `/js/order.js?v=${input.jsVersion}`;
  dataAttrs['data-lang'] = lang;
  dataAttrs['data-quote'] = form.quoteEndpoint;
  dataAttrs['data-communes'] = form.communesUrlTemplate;
  dataAttrs['data-confirm'] = form.confirmationHref;
  dataAttrs['data-variants'] = variantsAttr(form.variants);
  dataAttrs['data-phone-re'] = DZ_MOBILE_NSN_PATTERN;
  // Turnstile: first-party loader imported by order.js on the first interaction; never a third-party URL here.
  if (form.turnstileSiteKey && input.tsJsVersion) {
    dataAttrs['data-ts-key'] = form.turnstileSiteKey;
    dataAttrs['data-ts-js'] = `/js/order-ts.js?v=${input.tsJsVersion}`;
  }

  const hidden = [
    { name: 'lang', value: lang },
    { name: 'productId', value: String(form.productId) },
    // No-JS first POST renders the server review step; order.js sends JSON instead (WEB-0 §2.2–2.3).
    { name: 'step', value: 'review' },
  ];
  // Multi-variant products: pages renders `variantId` (radios or a hidden input) with form="order-form".
  if (form.singleVariant) hidden.push({ name: 'variantId', value: String(form.defaultVariantId) });

  return {
    lang,
    orderable: form.orderable,
    dataAttrs,
    hidden,
    wilayas: form.wilayas.map((w) => ({ value: String(w.code), label: w.label })),
    qty: { min: 1, max: maxQty, value: 1 },
    name: { minLength: NAME_MIN_LENGTH },
    phone: { maxLength: PHONE_INPUT_MAX_LENGTH },
    honeypotName: HONEYPOT_FIELD,
    messages,
    summary: {
      product: input.productName,
      variantLabel: form.singleVariant ? '' : (dv?.label ?? ''),
      unitPrice: dv?.price.label ?? '',
      qty: '1',
      subtotal: dv?.price.label ?? '',
      delivery: t('order.summary.deliveryPending'),
      total: '—',
    },
    t,
    contact,
    privacyHref: input.privacyHref ?? null,
  };
}
