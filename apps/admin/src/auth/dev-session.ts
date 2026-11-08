// Dev-login session cookie (local development only; see dev-gate.ts).
// Value: base64url(JSON {email, exp}) "." HMAC-SHA256(DEV_SESSION_SECRET, "dev|" + payload).
// Never parsed unless isDevAuthAllowed(c).
import { b64url, fromB64url, hmacSign, hmacVerify } from '../lib/crypto.ts';

export const DEV_COOKIE = 'hb_dev';
export const DEV_SESSION_TTL_S = 12 * 60 * 60;
/** Only these accounts can use the dev login (seeded by DB-3, never real people). */
export const DEV_EMAIL_SUFFIX = '@dev.local';

export async function signDevSession(secret: string, email: string, nowMs = Date.now()): Promise<string> {
  const payload = b64url(new TextEncoder().encode(JSON.stringify({ email, exp: Math.floor(nowMs / 1000) + DEV_SESSION_TTL_S })));
  return `${payload}.${await hmacSign(secret, `dev|${payload}`)}`;
}

/** Returns the email if the cookie is authentic, unexpired and for a dev account; else null. */
export async function readDevSession(secret: string, value: string | undefined, nowMs = Date.now()): Promise<string | null> {
  if (value === undefined || value.length > 512) return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  if (!(await hmacVerify(secret, `dev|${payload}`, value.slice(dot + 1)))) return null;
  const bytes = fromB64url(payload);
  if (!bytes) return null;
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const { email, exp } = data as { email?: unknown; exp?: unknown };
  if (typeof email !== 'string' || !email.endsWith(DEV_EMAIL_SUFFIX)) return null;
  if (typeof exp !== 'number' || exp * 1000 <= nowMs) return null;
  return email;
}
