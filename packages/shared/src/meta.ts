/**
 * Meta Conversions API: consent signals from the JSON order body, and the one server event shape
 * (META-0 contract §3, §4). Used only by apps/web. Rules: artifacts/META-0/contract.md and the
 * meta-conversions-api skill: customer data is normalised then SHA-256'd; fbp, fbc, IP and user
 * agent are sent raw; an empty value is omitted, never hashed.
 */
import * as v from 'valibot';
import type { Lang } from './lang.ts';
import type { PhoneE164 } from './phone.ts';

/** A Meta Pixel ID: 15 or 16 digits. `isMetaPixelId` also refuses all zeros (a test value, never real). */
export const META_PIXEL_ID_RE = /^\d{15,16}$/;

/** The one Pixel ID rule (admin, Worker; `apps/storefront/src/lib/meta.mjs` carries the same, parity test). */
export function isMetaPixelId(value: unknown): value is string {
  return typeof value === 'string' && META_PIXEL_ID_RE.test(value) && !/^0+$/.test(value);
}

/** Shape of the `_fbp`/`_fbc` values we accept. `public/js/meta.js` carries the same pattern (parity test). */
export const META_ID_RE = /^fb\.\d\.\d{10,16}\.[\w.-]{1,480}$/;

const MetaIdSchema = /* @__PURE__ */ v.fallback(v.optional(v.pipe(v.string(), v.regex(META_ID_RE))), undefined);

const MetaSignalsSchema = /* @__PURE__ */ v.object({
  meta: v.object({
    // Literally `true`: the string "true" is not consent.
    consent: v.literal(true),
    // The Pixel ID of the page the order was placed from (its `data-meta-pixel`). The server sends
    // only when it equals the Pixel ID stored in D1 (MSET-3, D-017): a page built without Meta, or
    // with another Pixel, never causes a server event.
    pixel: v.pipe(v.string(), v.regex(META_PIXEL_ID_RE)),
    fbp: MetaIdSchema,
    fbc: MetaIdSchema,
  }),
});

export interface MetaSignals {
  /** The page's Pixel ID, as the browser reported it. */
  readonly pixel: string;
  readonly fbp?: string;
  readonly fbc?: string;
}

/**
 * Consent, the page's Pixel ID and browser IDs from a parsed JSON order body. Null unless
 * `meta.consent === true` and `meta.pixel` is a Pixel ID: nothing else counts. A malformed fbp or
 * fbc is dropped on its own. Never throws.
 */
export function parseMetaSignals(rawJson: unknown): MetaSignals | null {
  const r = v.safeParse(MetaSignalsSchema, rawJson);
  if (!r.success) return null;
  const { pixel, fbp, fbc } = r.output.meta;
  return { pixel, ...(fbp === undefined ? {} : { fbp }), ...(fbc === undefined ? {} : { fbc }) };
}

/** `+213770123456` → `213770123456`: country code, digits only, as Meta's `ph` requires. */
export function metaPhoneDigits(e164: PhoneE164): string {
  return e164.replace(/\D/g, '');
}

/** SHA-256 of the UTF-8 bytes, lowercase hex. Refuses an empty string: its digest is a valid-looking constant. */
export async function sha256Hex(text: string): Promise<string> {
  if (text === '') throw new RangeError('sha256Hex: refusing to hash an empty string');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface PurchaseEventInput {
  readonly ref: string;
  /** Order creation time in ms (`order.created.createdAt`), never the send time. */
  readonly createdAtMs: number;
  readonly lang: Lang;
  /** Production storefront hostname, from the Worker's config. Never from the client. */
  readonly siteHost: string;
  readonly phoneE164: PhoneE164;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly signals: MetaSignals;
  readonly totalDzd: number;
  readonly items: readonly { readonly variantId: number; readonly qty: number }[];
}

/** The `Purchase` server event, or null when a website event's required user agent is missing. */
export async function buildPurchaseEvent(input: PurchaseEventInput) {
  const userAgent = input.userAgent ?? '';
  if (userAgent === '') return null;
  const { ref, signals } = input;
  return {
    event_name: 'Purchase',
    event_time: Math.floor(input.createdAtMs / 1000),
    event_id: ref,
    event_source_url: `https://${input.siteHost}/${input.lang}/order/confirmation/`,
    action_source: 'website',
    user_data: {
      ph: [await sha256Hex(metaPhoneDigits(input.phoneE164))],
      country: [await sha256Hex('dz')],
      client_user_agent: userAgent,
      ...(input.ip ? { client_ip_address: input.ip } : {}),
      ...(signals.fbp === undefined ? {} : { fbp: signals.fbp }),
      ...(signals.fbc === undefined ? {} : { fbc: signals.fbc }),
    },
    custom_data: {
      currency: 'DZD',
      value: input.totalDzd,
      content_type: 'product',
      contents: input.items.map((i) => ({ id: String(i.variantId), quantity: i.qty })),
      order_id: ref,
    },
  };
}

export type MetaPurchaseEvent = NonNullable<Awaited<ReturnType<typeof buildPurchaseEvent>>>;
