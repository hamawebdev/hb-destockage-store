// CSRF tokens: `<issuedAtMs>.<HMAC(CSRF_SECRET, "csrf|<userId>|<issuedAtMs>")>`, valid 12 h,
// bound to the user. Stateless (no session store in production: identity is the Access JWT).
// Issued for every authenticated request (ADMIN-1); checked on every POST together with the
// Origin / Sec-Fetch-Site check (ADMIN-3).
import { hmacSign, hmacVerify } from './crypto.ts';

export const CSRF_TTL_MS = 12 * 60 * 60 * 1000;
export const CSRF_FIELD = '_csrf';

export async function issueCsrfToken(secret: string, userId: number, now = Date.now()): Promise<string> {
  return `${now}.${await hmacSign(secret, `csrf|${userId}|${now}`)}`;
}

export async function verifyCsrfToken(secret: string, userId: number, token: unknown, now = Date.now()): Promise<boolean> {
  if (typeof token !== 'string' || token.length > 128) return false;
  const m = /^(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return false;
  const issued = Number(m[1]);
  if (!(issued <= now + 60_000 && now - issued <= CSRF_TTL_MS)) return false;
  return hmacVerify(secret, `csrf|${userId}|${issued}`, m[2]!);
}

/**
 * Same-origin check for unsafe methods: `Sec-Fetch-Site: same-origin`, or (when that header is
 * absent) an `Origin` equal to the request's own origin. Both absent → false.
 */
export function isSameOriginRequest(req: Request): boolean {
  const site = req.headers.get('Sec-Fetch-Site');
  if (site !== null) return site === 'same-origin';
  const origin = req.headers.get('Origin');
  if (origin === null) return false;
  try {
    return origin === new URL(req.url).origin;
  } catch {
    return false;
  }
}

const FORM_TYPES = /^(application\/x-www-form-urlencoded|multipart\/form-data)\s*(;|$)/i;
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export type CsrfFailure = 'content-type' | 'origin' | 'token';

/**
 * Checks an unsafe request: form content type, same origin, and the user-bound token in the
 * `_csrf` field. Returns null when the request may proceed. Reads the body through Hono's
 * cached parser, so handlers can parse it again.
 */
export async function checkCsrf(
  req: { method: string; raw: Request; header(name: string): string | undefined; parseBody(): Promise<Record<string, unknown>> },
  secret: string,
  userId: number,
): Promise<CsrfFailure | null> {
  if (SAFE_METHODS.has(req.method)) return null;
  if (!FORM_TYPES.test(req.header('Content-Type') ?? '')) return 'content-type';
  if (!isSameOriginRequest(req.raw)) return 'origin';
  let body: Record<string, unknown>;
  try {
    body = await req.parseBody();
  } catch {
    return 'token';
  }
  return (await verifyCsrfToken(secret, userId, body[CSRF_FIELD])) ? null : 'token';
}
