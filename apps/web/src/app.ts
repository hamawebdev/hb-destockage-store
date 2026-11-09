/**
 * The storefront Worker's Hono app. Plan: artifacts/WEB-0/plan.md §1.
 *
 * Static assets are served by Workers static assets before this code runs. The Worker only sees
 * the `run_worker_first` paths (wrangler.jsonc): `/api/*` and `/{ar,fr}/order/confirmation/*`.
 * D1 is touched only by POST /api/* handlers (and /api/health?db=1), never for a page view.
 */
import { Hono } from 'hono';
import { ConfigError, readConfig, type Env } from './env.ts';
import { apiError, apiHeaders, log } from './http.ts';
import { COURIER_HOOK_PREFIX, registerCourierWebhook } from './routes/courier-webhook.ts';
import { registerOrder } from './routes/order.ts';
import { registerQuote } from './routes/quote.ts';
import { registerRum } from './routes/rum.ts';

export const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', apiHeaders);
// Fail closed on a misconfigured deploy: no /api/* runs with invalid vars (e.g. production without
// its SITE_HOSTS), so orders are never accepted half-configured or silently mis-flagged.
app.use('/api/*', async (c, next) => {
  try {
    readConfig(c.env);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    log('config_invalid', { error: err.message });
    return apiError(c, 500, 'server_error');
  }
  await next();
  return undefined;
});

// --- /api/health --------------------------------------------------------------------------------
app.get('/api/health', async (c) => {
  const config = readConfig(c.env);
  if (c.req.query('db') === undefined) return c.json({ ok: true, env: config.env });
  const t0 = Date.now();
  try {
    const row = await c.env.DB.prepare('select 1 as one').first<{ one: number }>();
    if (row?.one !== 1) throw new Error('unexpected result');
    return c.json({ ok: true, env: config.env, db: 'ok', dbMs: Date.now() - t0 });
  } catch (err) {
    log('health_db_error', { error: errorName(err) });
    return apiError(c, 503, 'server_error', { db: 'error' }, { 'Retry-After': '5' });
  }
});
app.all('/api/health', (c) => apiError(c, 405, 'method_not_allowed', {}, { Allow: 'GET, HEAD' }));

// --- /api/quote (WEB-2) -------------------------------------------------------------------------
registerQuote(app);

// --- /api/order + the order confirmation page (WEB-3) ------------------------------------------
registerOrder(app);

// --- /api/rum (WEB-5) ---------------------------------------------------------------------------
registerRum(app);

// --- /api/courier-hook (SHIP-4) -------------------------------------------------------------------
registerCourierWebhook(app);

// --- Fallbacks ----------------------------------------------------------------------------------
app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) return apiError(c, 404, 'not_found');
  // A run_worker_first path with no handler (e.g. POST to the confirmation page): let assets answer.
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((err, c) => {
  // The webhook path carries a secret token, and Drizzle's or D1's message can carry bound values.
  if (c.req.path.startsWith(COURIER_HOOK_PREFIX)) log('unhandled_error', { path: `${COURIER_HOOK_PREFIX}[redacted]`, error: err instanceof Error ? err.name : 'unknown' });
  else log('unhandled_error', { path: c.req.path, error: errorName(err) });
  const status = err instanceof ConfigError ? 500 : 503;
  if (c.req.path.startsWith('/api/')) {
    // The apiHeaders middleware still wraps this response (Hono runs onError inside the chain).
    return apiError(c, status, 'server_error', {}, status === 503 ? { 'Retry-After': '5' } : {});
  }
  return c.text('Server error', status, { 'Cache-Control': 'no-store' });
});

function errorName(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
