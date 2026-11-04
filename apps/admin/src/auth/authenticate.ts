// Authentication: an identity provider turns the request into a verified email (or a refusal);
// this middleware maps the email to an ACTIVE admin_users row, re-read on every request.
//
// Providers:
//   - Cloudflare Access JWT (production) and the localhost-only dev login: ADMIN-2.
//   - `refuseAll` (ADMIN-1 default): nobody gets in.
//   - tests inject their own provider through `createApp({ identify })`.
import { and, eq } from 'drizzle-orm';
import { adminUsers } from '@hb/db';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { toCurrentUser, type AppEnv } from '../env.ts';
import { issueCsrfToken } from '../lib/csrf.ts';
import { renderError } from '../ui/error-page.tsx';

export const ACCESS_JWT_HEADER = 'Cf-Access-Jwt-Assertion';

export type IdentityResult = { ok: true; email: string } | { ok: false; status: 401 | 403 | 503 };
export type IdentifyFn = (c: Context<AppEnv>) => Promise<IdentityResult>;

/** Refuses everyone: 401 without credentials, 403 with (unverifiable) credentials. */
export const refuseAll: IdentifyFn = async (c) =>
  c.req.header(ACCESS_JWT_HEADER) ? { ok: false, status: 403 } : { ok: false, status: 401 };

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
