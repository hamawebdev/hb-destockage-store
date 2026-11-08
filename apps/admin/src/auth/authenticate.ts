// Authentication: an identity provider turns the request into a verified email (or a refusal);
// this middleware maps the email to an ACTIVE admin_users row, re-read on every request (so a
// deactivation takes effect immediately).
//
// Default provider (`createDefaultIdentify`):
//   1. local dev login — only if isDevAuthAllowed(c) (ENV=development AND loopback host), from
//      the signed `hb_dev` cookie; otherwise the cookie is never read;
//   2. Cloudflare Access JWT from `Cf-Access-Jwt-Assertion` (access.ts).
// Tests inject their own provider through `createApp({ identify })`.
import { and, eq } from 'drizzle-orm';
import { adminUsers } from '@hb/db';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { JWTVerifyGetKey } from 'jose';
import { toCurrentUser, type AppEnv } from '../env.ts';
import { issueCsrfToken } from '../lib/csrf.ts';
import { renderError } from '../ui/error-page.tsx';
import { ACCESS_JWT_HEADER, accessConfig, verifyAccessJwt } from './access.ts';
import { isDevAuthAllowed } from './dev-gate.ts';
import { DEV_COOKIE, readDevSession } from './dev-session.ts';

export { ACCESS_JWT_HEADER };

export type IdentityResult = { ok: true; email: string } | { ok: false; status: 401 | 403 | 503 };
export type IdentifyFn = (c: Context<AppEnv>) => Promise<IdentityResult>;

/** Refuses everyone: 401 without credentials, 403 with. */
export const refuseAll: IdentifyFn = async (c) =>
  c.req.header(ACCESS_JWT_HEADER) ? { ok: false, status: 403 } : { ok: false, status: 401 };

export interface DefaultIdentifyOptions {
  /** Key resolver override (tests: a local JWKS). Defaults to the team's remote JWKS. */
  getKey?: JWTVerifyGetKey;
}

export function createDefaultIdentify(opts: DefaultIdentifyOptions = {}): IdentifyFn {
  return async (c) => {
    if (isDevAuthAllowed(c)) {
      const email = await readDevSession(c.env.DEV_SESSION_SECRET!, getCookie(c, DEV_COOKIE));
      if (email) return { ok: true, email };
    }
    const token = c.req.header(ACCESS_JWT_HEADER);
    if (token === undefined || token === '') return { ok: false, status: 401 };
    const cfg = accessConfig(c);
    if (!cfg) return { ok: false, status: 403 };
    return opts.getKey ? verifyAccessJwt(token, cfg, opts.getKey) : verifyAccessJwt(token, cfg);
  };
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function authenticate(identify: IdentifyFn) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const id = await identify(c);
    if (!id.ok) return renderError(c, id.status);
    const row = await c.var.db
      .select({ id: adminUsers.id, email: adminUsers.email, name: adminUsers.name, role: adminUsers.role, uiLang: adminUsers.uiLang })
      .from(adminUsers)
      .where(and(eq(adminUsers.email, normaliseEmail(id.email)), eq(adminUsers.active, true)))
      .get();
    if (!row) return renderError(c, 403);
    c.set('user', toCurrentUser(row));
    c.set('csrfToken', await issueCsrfToken(c.env.CSRF_SECRET, row.id));
    return next();
  });
}
