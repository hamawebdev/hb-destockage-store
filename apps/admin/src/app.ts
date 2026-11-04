// The admin Worker app. Owner: admin-core.
//
// RULES FOR ROUTERS (admin-orders, admin-catalog, admin-core):
//  1. Build routers with `createRouter({ roles })` (lib/router.ts) and gate every route with
//     `requirePerm(...)` (auth/require-role.ts). A route with no role check returns 500.
//  2. Every mutation is a POST and writes its audit row in the same batch: `withAudit` / `audit`
//     (audit/audit.ts). Read-only POSTs call `noAudit(c, reason)`.
//  3. Validate every input with Valibot via `parseForm` (lib/forms.ts); ids via `paramId`.
//  4. Render with `c.render(<Page/>, { title })` and the UI kit (ui/). No inline <script>, no
//     `style=` attributes, no `on*=` handlers, no `raw()` / `dangerouslySetInnerHTML` outside ui/.
//  5. Drizzle query builders or `sql\`\`` with bound values only; never concatenate SQL.
//  6. Phones, order refs, SKUs, emails and Latin names in `<Bdi>`.
//  7. Your strings: `defineMessages({ fr, ar })` in your own folder.
//
// Pipeline (order matters): security headers → request id → env check → body limit →
// db → [dev login, local only] → authenticate → language/renderer → role guard → routes.

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';
import { createDb } from '@hb/db';
import { tokensCss } from '@hb/ui-tokens';
import { authenticate, createDefaultIdentify, type IdentifyFn } from './auth/authenticate.ts';
import devRoutes, { DEV_PREFIX } from './auth/dev-routes.tsx';
import { requirePerm, roleGuard } from './auth/require-role.ts';
import { checkEnv, type AppEnv } from './env.ts';
import { dirOf, translator } from './i18n/index.ts';
import { securityHeaders } from './lib/headers.ts';
import { setLayoutRenderer } from './ui/layout.tsx';
import { renderError } from './ui/error-page.tsx';
import { ASSET } from './ui/assets.ts';

import dashboard from './routes/dashboard/index.tsx';
import users from './routes/users/index.tsx';
import settings from './routes/settings/index.tsx';
import orders from './routes/orders/index.tsx';
import customers from './routes/customers/index.tsx';
import products from './routes/products/index.tsx';
import categories from './routes/categories/index.tsx';
import fees from './routes/fees/index.tsx';
import content from './routes/content/index.tsx';
import media from './routes/media/index.tsx';
import publish from './routes/publish/index.tsx';

export const MAX_BODY_BYTES = 1024 * 1024;
export const LARGE_BODY_BYTES = 10 * 1024 * 1024;
/** POST paths allowed the large body limit (media uploads). */
export const LARGE_BODY_PATHS: ReadonlySet<string> = new Set(['/media/upload']);

export interface AppOptions {
  /** Identity provider. Defaults to dev login (local only) + Cloudflare Access JWT. */
  identify?: IdentifyFn;
}

const requestId = createMiddleware<AppEnv>(async (c, next) => {
  c.set('requestId', c.req.header('cf-ray') ?? crypto.randomUUID());
  c.set('roleChecked', false);
  c.set('audited', false);
  await next();
});

let envProblemsLogged = false;
const envGuard = createMiddleware<AppEnv>(async (c, next) => {
  const problems = checkEnv(c.env);
  if (problems.length > 0) {
    if (!envProblemsLogged) {
      console.error(JSON.stringify({ level: 'error', msg: 'admin misconfigured', keys: problems }));
      envProblemsLogged = true;
    }
    return renderError(c, 500);
  }
  return next();
});

const limitBody = createMiddleware<AppEnv>(async (c, next) => {
  const maxSize = LARGE_BODY_PATHS.has(c.req.path) ? LARGE_BODY_BYTES : MAX_BODY_BYTES;
  return bodyLimit({ maxSize, onError: (c) => c.text('Payload Too Large', 413) })(c, next);
});

const withDb = createMiddleware<AppEnv>(async (c, next) => {
  c.set('db', createDb(c.env.DB));
  await next();
});

const withLang = createMiddleware<AppEnv>(async (c, next) => {
  const lang = c.var.user.uiLang;
  c.set('lang', lang);
  c.set('dir', dirOf(lang));
  c.set('t', translator(lang));
  setLayoutRenderer(c);
  await next();
});

export function createApp(opts: AppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', securityHeaders, requestId, envGuard, limitBody, withDb);
  // Local dev login: registered before authenticate; 404 unless ENV=development on a loopback host.
  app.route(DEV_PREFIX, devRoutes);
  app.use('*', authenticate(opts.identify ?? createDefaultIdentify()), withLang, roleGuard);

  // Static assets (after auth; `run_worker_first: true` in wrangler.jsonc).
  app.get(ASSET.tokens, requirePerm('dashboard.view'), (c) =>
    c.body(tokensCss, 200, { 'Content-Type': 'text/css; charset=utf-8' }),
  );
  app.get('/assets/*', requirePerm('dashboard.view'), (c) => c.env.ASSETS.fetch(c.req.raw));

  // Mounted under a prefix: a router mounted at '/' would apply its router-wide role check to
  // every path and defeat roleGuard.
  app.get('/', requirePerm('dashboard.view'), (c) => c.redirect('/dashboard', 302));
  app.route('/dashboard', dashboard);
  app.route('/users', users);
  app.route('/settings', settings);
  app.route('/orders', orders);
  app.route('/customers', customers);
  app.route('/products', products);
  app.route('/categories', categories);
  app.route('/fees', fees);
  app.route('/content', content);
  app.route('/media', media);
  app.route('/publish', publish);

  app.notFound((c) => renderError(c, 404));
  app.onError((err, c) => {
    console.error(JSON.stringify({ level: 'error', msg: 'unhandled', error: err.name, requestId: c.get('requestId') }));
    return renderError(c, 500);
  });

  return app;
}
