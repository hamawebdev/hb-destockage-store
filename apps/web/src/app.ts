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
import { registerQuote } from './routes/quote.ts';

export const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', apiHeaders);

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

// --- Order confirmation page (WEB-3 fills the ref with HTMLRewriter; no D1 here, ever) ----------
app.get('/:lang{ar|fr}/order/confirmation/*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const out = new Response(res.body, res);
  // Per-order URL (`?ref=`): never stored by a shared cache.
  out.headers.set('Cache-Control', 'no-store');
  out.headers.delete('Set-Cookie');
  return out;
});

// --- Fallbacks ----------------------------------------------------------------------------------
app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) return apiError(c, 404, 'not_found');
  // A run_worker_first path with no handler (e.g. POST to the confirmation page): let assets answer.
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((err, c) => {
  log('unhandled_error', { path: c.req.path, error: errorName(err) });
  const status = err instanceof ConfigError ? 500 : 503;
  if (c.req.path.startsWith('/api/')) {
    // The apiHeaders middleware does not run on this path: set the same headers here.
    const res = apiError(c, status, 'server_error', {}, status === 503 ? { 'Retry-After': '5' } : {});
    res.headers.set('Cache-Control', 'no-store');
    res.headers.set('X-Content-Type-Options', 'nosniff');
    return res;
  }
  return c.text('Server error', status, { 'Cache-Control': 'no-store' });
});

function errorName(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
