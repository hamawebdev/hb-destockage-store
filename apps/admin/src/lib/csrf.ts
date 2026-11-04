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
