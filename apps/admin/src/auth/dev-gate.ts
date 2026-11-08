// The ONLY place that decides whether the local dev login exists for a request.
// Both conditions, nothing else: ENV === 'development' (only `npm run dev` sets it; wrangler.jsonc
// defaults to production) AND the request URL's hostname is a loopback name.
//
// Caveat (review ADMIN-2 r1 nit): the URL's hostname comes from the Host header the client sent.
// No *other* header is read (X-Forwarded-Host, X-Dev-*, …), and in production Cloudflare routes
// by hostname, so a request carrying Host: localhost never reaches this Worker. Locally, safety
// rests on `npm run dev` binding 127.0.0.1 (wrangler.jsonc dev.ip, --ip 127.0.0.1): NEVER run the
// admin with ENV=development on 0.0.0.0 or any non-loopback interface: anyone on the network
// could then send `Host: localhost` and reach the dev login (runbook §6).
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
