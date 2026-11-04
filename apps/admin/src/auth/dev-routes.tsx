// Local dev login: GET/POST /__dev/login, POST /__dev/logout. Every route answers 404 unless
// isDevAuthAllowed(c) (ENV=development AND loopback host). Mounted BEFORE authenticate in app.ts.
import { and, asc, eq, like } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { adminUsers } from '@hb/db';
import type { AppEnv } from '../env.ts';
import { translator } from '../i18n/index.ts';
import { isSameOriginRequest } from '../lib/csrf.ts';
import { renderError } from '../ui/error-page.tsx';
import { isDevAuthAllowed } from './dev-gate.ts';
import { DEV_COOKIE, DEV_EMAIL_SUFFIX, DEV_SESSION_TTL_S, signDevSession } from './dev-session.ts';

export const DEV_PREFIX = '/__dev';

const r = new Hono<AppEnv>();

r.use(
  '*',
  createMiddleware<AppEnv>(async (c, next) => {
    if (!isDevAuthAllowed(c)) return renderError(c, 404);
    if (c.req.method === 'POST' && !isSameOriginRequest(c.req.raw)) return renderError(c, 403);
    c.set('roleChecked', true); // public by design, only in local development
    return next();
  }),
);

async function devUsers(c: Context<AppEnv>) {
  return c.var.db
    .select({ email: adminUsers.email, name: adminUsers.name, role: adminUsers.role })
    .from(adminUsers)
    .where(and(eq(adminUsers.active, true), like(adminUsers.email, `%${DEV_EMAIL_SUFFIX}`)))
    .orderBy(asc(adminUsers.email))
    .all();
}

r.get('/login', async (c) => {
  const users = await devUsers(c);
  const t = translator('fr');
  return c.html(
    '<!doctype html>' +
      (
        <html lang="fr" dir="ltr">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <meta name="robots" content="noindex, nofollow" />
            <title>Dev login · {t('app.name')}</title>
          </head>
          <body>
            <main>
              <h1>Connexion locale (développement) · <span lang="ar" dir="rtl">دخول محلي (تطوير)</span></h1>
              <p>Local development only. Production uses Cloudflare Access.</p>
              {users.length === 0 ? (
                <p>No active <bdi dir="ltr">{DEV_EMAIL_SUFFIX}</bdi> users: run the DB-3 seed.</p>
              ) : (
                <ul>
                  {users.map((u) => (
                    <li>
                      <form method="post" action={`${DEV_PREFIX}/login`}>
                        <input type="hidden" name="email" value={u.email} />
                        <button type="submit">
                          <bdi dir="ltr">{u.email}</bdi> ({t(`role.${u.role}` as const)})
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
            </main>
          </body>
        </html>
      ).toString(),
  );
});

r.post('/login', async (c) => {
  const body = await c.req.parseBody();
  const email = typeof body['email'] === 'string' ? body['email'].trim().toLowerCase() : '';
  const allowed = (await devUsers(c)).some((u) => u.email === email);
  if (!allowed) return renderError(c, 403);
  setCookie(c, DEV_COOKIE, await signDevSession(c.env.DEV_SESSION_SECRET!, email), {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: DEV_SESSION_TTL_S,
  });
  return c.redirect('/dashboard', 303);
});

r.post('/logout', (c) => {
  deleteCookie(c, DEV_COOKIE, { path: '/' });
  return c.redirect(`${DEV_PREFIX}/login`, 303);
});

export default r;
