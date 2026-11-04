/**
 * The one allow-list for every URL, href or file key that comes from data or ends up in props
 * (content links, image keys and URLs, alternates, canonical, search results, sitemap).
 * Allow-lists, not deny-lists: anything not matching exactly is rejected, which covers
 * protocol-relative (`//x`), backslash (`/\x`), whitespace and control characters (`/\t/x`),
 * percent-encoding, `javascript:`, mixed-case schemes and `..` segments.
 * Pure, no I/O (bundles into the admin Worker).
 */

/** One path segment: lowercase ASCII letters/digits, then letters/digits/`.`/`_`/`-` (never starts with `.`). */
const SEGMENT = '[a-z0-9][a-z0-9._-]*';

/**
 * Same-origin root-relative path, optionally ending in `/` and an optional `#fragment`:
 * `/`, `/ar/p/pack-luxe/`, `/img/0a1b-360.avif`, `/fr/livraison/#frais`.
 */
const SAME_ORIGIN_PATH = new RegExp(`^/(?:${SEGMENT}(?:/${SEGMENT})*/?)?(?:#[a-z0-9-]+)?$`);

/** `tel:` with an optional `+` and 6–15 digits. */
const TEL = /^tel:\+?[0-9]{6,15}$/;

/** WhatsApp click-to-chat, digits only, optional pre-filled text (percent-encoded, unreserved chars). */
const WHATSAPP = /^https:\/\/wa\.me\/[0-9]{6,15}(?:\?text=[A-Za-z0-9%._~-]*)?$/;

/** Original-photo key: relative path of lowercase segments, no `..`, no leading `/`. */
const IMAGE_KEY = new RegExp(`^${SEGMENT}(?:/${SEGMENT})*$`);

/** Site origin: `https://host[:port]` (or `http://localhost|127.0.0.1[:port]` for local builds). */
const SITE_ORIGIN = /^(?:https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+|http:\/\/(?:localhost|127\.0\.0\.1))(?::[0-9]{1,5})?$/;

export const isSameOriginPath = (s: string): boolean => SAME_ORIGIN_PATH.test(s) && !s.split('/').includes('..');
export const isAllowedExternalHref = (s: string): boolean => TEL.test(s) || WHATSAPP.test(s);
/** Content-block links: same-origin path, `tel:` or `https://wa.me/<digits>`. */
export const isContentLinkHref = (s: string): boolean => isSameOriginPath(s) || isAllowedExternalHref(s);
export const isImageKey = (s: string): boolean => s.length <= 300 && IMAGE_KEY.test(s) && !s.split('/').includes('..');
export const isSiteOrigin = (s: string): boolean => SITE_ORIGIN.test(s);
/** Absolute URL on the site: `<siteOrigin><same-origin path>`. */
export const isSiteUrl = (s: string, siteOrigin: string): boolean =>
  isSiteOrigin(siteOrigin) && s.startsWith(siteOrigin + '/') && isSameOriginPath(s.slice(siteOrigin.length));

export class UnsafeUrlError extends Error {
  override name = 'UnsafeUrlError';
}

/** Throws unless `s` is a safe same-origin path. Used on every path the builders emit. */
export function assertSameOriginPath(s: string, what: string): string {
  if (!isSameOriginPath(s)) throw new UnsafeUrlError(`${what}: not a same-origin path: ${JSON.stringify(s)}`);
  return s;
}
