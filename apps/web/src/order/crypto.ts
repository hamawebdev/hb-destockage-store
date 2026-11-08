/**
 * Small WebCrypto helpers for the order flow (plan WEB-0 §2.3, §3.1, §4.4):
 * - the no-JS review token (HMAC, gives a server-measured review → confirm time; no cookies);
 * - the IP rate-limit key (/64 for IPv6) and the salted IP hash stored in `orders.ip_hash`;
 * - the deterministic decoy ref for a sunk submission.
 */
import { MAX_FILL_MS, makeOrderRef, type Lang, type OrderRef } from '@hb/shared';

const enc = new TextEncoder();

async function hmac(key: string, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison (both ASCII). */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// --- Review token -------------------------------------------------------------------------------

const TOKEN_RE = /^(\d{1,15})\.([A-Za-z0-9_-]{22})$/;

/** `<issuedAtMs>.<base64url(HMAC(issuedAt|idempotencyKey|lang))[:16 bytes]>`. */
export async function signReviewToken(key: string, issuedAt: number, idempotencyKey: string, lang: Lang): Promise<string> {
  const mac = await hmac(key, `review|${issuedAt}|${idempotencyKey}|${lang}`);
  return `${issuedAt}.${b64url(mac.slice(0, 16))}`;
}

/**
 * Review → confirm time in ms when the token is ours, matches this key/lang and is not from the
 * future or older than MAX_FILL_MS; otherwise `undefined` (⇒ flag `fill_time_missing`, never reject).
 */
export async function reviewFillMs(
  key: string | undefined,
  token: unknown,
  idempotencyKey: string,
  lang: Lang,
  now: number,
): Promise<number | undefined> {
  if (key === undefined || key === '' || typeof token !== 'string') return undefined;
  const m = TOKEN_RE.exec(token);
  if (m === null) return undefined;
  const issuedAt = Number(m[1]);
  const expected = await signReviewToken(key, issuedAt, idempotencyKey, lang);
  if (!same(expected, token)) return undefined;
  const elapsed = now - issuedAt;
  return elapsed >= 0 && elapsed <= MAX_FILL_MS ? elapsed : undefined;
}

// --- IP -----------------------------------------------------------------------------------------

/** Rate-limit key: the IPv4 address, or the IPv6 /64 prefix (one subscriber), lower-cased. */
export function ipRateKey(ip: string): string {
  if (!ip.includes(':')) return ip;
  const [head = '', tail = ''] = ip.toLowerCase().split('::', 2);
  const left = head === '' ? [] : head.split(':');
  const right = tail === '' ? [] : tail.split(':');
  const missing = Math.max(0, 8 - left.length - right.length);
  const full = ip.includes('::') ? [...left, ...Array<string>(missing).fill('0'), ...right] : left;
  return `${full
    .slice(0, 4)
    .map((h) => h.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/** Salted hash of the client IP for `orders.ip_hash` (never the IP itself). Null without a key. */
export async function ipHash(key: string | undefined, ip: string | null): Promise<string | null> {
  if (key === undefined || key === '' || ip === null) return null;
  return hex((await hmac(key, `ip|${ip}`)).slice(0, 16));
}

// --- Sink ---------------------------------------------------------------------------------------

/** Decoy ref for a sunk submission: stable for one idempotency key, never inserted. */
export async function sinkRef(idempotencyKey: string): Promise<OrderRef> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`sink|${idempotencyKey}`)));
  return makeOrderRef(digest.slice(0, 5));
}
