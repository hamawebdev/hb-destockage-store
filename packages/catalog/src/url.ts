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

/** DNS label: lowercase letters/digits/hyphens, 1–63 chars, no leading/trailing hyphen. */
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
/** Public origin shape: `https://` + dotted hostname, nothing else (no port, path, query, user). */
const PUBLIC_ORIGIN = new RegExp(`^https://(${LABEL}(?:\\.${LABEL})+)$`);
/** Names that never resolve to the public site (RFC 6761/6762, common internal suffixes). */
const NON_PUBLIC_HOST = /(?:^|\.)(?:localhost|local|internal|test)$/;
/**
 * RFC 2606/6761 names for documentation and invalid use: `.example`, `.invalid`, `example.com|net|org`
 * (and subdomains). Never a real site: refused for publish builds; non-publish builds keep them
 * (the fixture's origin is https://hbdestockage.example).
 */
const RESERVED_DOC_HOST = /(?:^|\.)(?:example|invalid|example\.com|example\.net|example\.org)$/;
/** Local development origin: plain http on loopback, optional port (non-publish builds only). */
const LOCAL_DEV_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?$/;

export const isSameOriginPath = (s: string): boolean => SAME_ORIGIN_PATH.test(s) && !s.split('/').includes('..');
export const isAllowedExternalHref = (s: string): boolean => TEL.test(s) || WHATSAPP.test(s);
/** Content-block links: same-origin path, `tel:` or `https://wa.me/<digits>`. */
export const isContentLinkHref = (s: string): boolean => isSameOriginPath(s) || isAllowedExternalHref(s);
export const isImageKey = (s: string): boolean => s.length <= 300 && IMAGE_KEY.test(s) && !s.split('/').includes('..');
export type SiteOriginResult = { readonly ok: true; readonly origin: string } | { readonly ok: false; readonly reason: string };

/**
 * The one site-origin rule (canonical, hreflang, og:url, sitemap, robots). A trailing `/` is
 * dropped. Publish builds (`publish: true`) accept only a public origin: `https://` + a dotted
 * hostname, refusing IPv4/IPv6 literals, `localhost`, `*.localhost`, `*.local`, `*.internal`,
 * `*.test`, the RFC 2606/6761 names `*.example`, `*.invalid`, `example.com|net|org`, ports, paths,
 * queries and credentials. Non-publish builds also accept a local dev
 * origin (`http://localhost[:port]`, `http://127.0.0.1[:port]`). Pure; jobs' publish script and
 * `siteOriginFromEnv` both call it.
 */
export function parseSiteOrigin(input: string, opts: { readonly publish: boolean }): SiteOriginResult {
  const s = input.trim().replace(/\/+$/, '');
  if (!opts.publish && LOCAL_DEV_ORIGIN.test(s)) return { ok: true, origin: s };
  if (!s.startsWith('https://')) return { ok: false, reason: `not https: ${JSON.stringify(s)}` };
  const m = PUBLIC_ORIGIN.exec(s);
  if (!m) return { ok: false, reason: `not an origin of the form https://host.tld (no port, path, query or credentials): ${JSON.stringify(s)}` };
  const host = m[1]!;
  // All-numeric last label ⇒ an IP literal (127.0.0.1, 10.1); IPv6 literals ([…]) never match LABEL.
  if (/^[0-9]+$/.test(host.split('.').at(-1)!)) return { ok: false, reason: `IP literal not allowed: ${host}` };
  if (NON_PUBLIC_HOST.test(host)) return { ok: false, reason: `non-public hostname: ${host}` };
  if (opts.publish && RESERVED_DOC_HOST.test(host)) return { ok: false, reason: `reserved documentation/invalid hostname (RFC 2606/6761): ${host}` };
  return { ok: true, origin: s };
}

/** A public origin (what publish builds require). */
export const isPublicSiteOrigin = (s: string): boolean => parseSiteOrigin(s, { publish: true }).ok;
/** Any origin a build may use: public, or a local dev origin (non-publish builds). */
export const isSiteOrigin = (s: string): boolean => parseSiteOrigin(s, { publish: false }).ok && s === s.trim().replace(/\/+$/, '');
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
