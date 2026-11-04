// The ONLY place that decides whether the local dev login exists for a request.
// Both conditions, nothing else: ENV === 'development' (only `npm run dev` sets it; wrangler.jsonc
// defaults to production) AND the request URL's hostname is a loopback name. No header is read
// (X-Forwarded-Host, Host overrides, custom headers): nothing a client sends can enable it.
import type { Context } from 'hono';
import type { AppEnv } from '../env.ts';

export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

export const DEV_SECRET_MIN = 32;

export function isDevAuthAllowed(c: Context<AppEnv>): boolean {
  if (c.env.ENV !== 'development') return false;
  const secret = c.env.DEV_SESSION_SECRET;
  if (typeof secret !== 'string' || secret.length < DEV_SECRET_MIN) return false;
  let host: string;
  try {
    host = new URL(c.req.url).hostname;
  } catch {
    return false;
  }
  return LOOPBACK_HOSTS.has(host);
}
