// WEB-5: /api/rum validation, path cleaning, server-side time, prerender shift, ratings, sampling,
// the RUM flood guard, and no cookies. Unit level with fake bindings (D1 insert is captured).
import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../src/env.ts';
import { apiHeaders } from '../src/http.ts';
import { cleanPath, MINUTE_MS, minuteOf, rate, registerRum, toRows } from '../src/routes/rum.ts';

const BEACON = {
  v: 1,
  lang: 'ar',
  tpl: 'product',
  path: '/ar/p/pack/?utm_source=fb&phone=0555123456#x',
  navType: 'navigate',
  prerendered: false,
  proto: 'h3',
  ttfb: 412.34,
  lcp: 1890,
  dns: 70,
  connect: 66,
  tls: 118,
  activationStart: 0,
};

function setup(opts: { sample?: string; random?: number; ipAllowed?: boolean } = {}) {
  const inserted: unknown[][] = [];
  const waits: Promise<unknown>[] = [];
  const rl = { limit: vi.fn(async () => ({ success: opts.ipAllowed ?? true })) };
  // Minimal D1 stand-in that records the bound values of the INSERT drizzle issues.
  const stmt = (sql: string) => ({
    bind: (...vals: unknown[]) => ({
      run: async () => {
        if (/insert into "rum_events"/i.test(sql)) inserted.push(vals);
        return { success: true, meta: {}, results: [] };
      },
      all: async () => ({ results: [] }),
      raw: async () => [],
    }),
  });
  const env = {
    DB: { prepare: stmt },
    RUM_RL_IP: rl,
    ENV: 'test',
    SITE_HOSTS: 'localhost',
    MIN_FILL_MS: '2500',
    MIN_REVIEW_MS: '1500',
    RUM_SAMPLE: opts.sample ?? '1',
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.use('/api/*', apiHeaders);
  registerRum(app, () => opts.random ?? 0);
  const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const send = async (body: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(
      '/api/rum',
      { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) },
      env,
      ctx,
    );
    await Promise.all(waits);
    return res;
  };
  return { send, inserted, rl, app, env, ctx };
}

describe('pure helpers', () => {
  test.each([
    ['/ar/p/pack/?utm=1#x', '/ar/p/pack/'],
    ['https://evil.example/fr/c/x/?a=b', '/fr/c/x/'],
    ['/404.html', '/404.html'],
    ['/ar/c/cuisine/2/', '/ar/c/cuisine/2/'],
    ['/fr/order/confirmation/?ref=HB-7K2Q9', '/fr/order/confirmation/'],
    ['/fr/livraison/', '/fr/livraison/'],
    ['/api/order', null],
    ['/', null],
    ['/en/', null],
    ['/ar/%3Fphone%3D0555123456/', null], // a client string under /ar/ that is not a site URL
    ['/ar/p/pack/extra/', null],
    ['/ar/p/Pack/', null],
    ['/ar/0555123456@x/', null],
    [`/ar/${'x'.repeat(300)}/`, null],
  ])('cleanPath(%j) = %j', (raw, out) => {
    expect(cleanPath(raw)).toBe(out);
  });

  test('ratings: LCP and TTFB by web.dev thresholds, network phases unrated', () => {
    expect(rate('LCP', 2500)).toBe('good');
    expect(rate('LCP', 2501)).toBe('needs-improvement');
    expect(rate('LCP', 4001)).toBe('poor');
    expect(rate('TTFB', 800)).toBe('good');
    expect(rate('TTFB', 1801)).toBe('poor');
    expect(rate('DNS', 9999)).toBeNull();
  });

  test('prerendered pages: LCP and TTFB measured from activation, never negative', () => {
    const rows = toRows({ ...BEACON, v: 1, lang: 'ar', prerendered: true, activationStart: 1500, ttfb: 300, lcp: 1800 } as never, '/ar/', 1, undefined);
    expect(rows.find((r) => r.metric === 'LCP')?.value).toBe(300);
    expect(rows.find((r) => r.metric === 'TTFB')?.value).toBe(0);
    expect(rows[0]?.prerendered).toBe(true);
  });
});

describe('POST /api/rum', () => {
  test('204, no body, no cookie; one row per metric with server time and a cleaned path', async () => {
    const { send, inserted } = setup();
    const before = Date.now();
    const res = await send({ ...BEACON, at: 1, timestamp: 4102444800000 }); // client times are ignored
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(inserted).toHaveLength(1);
    const vals = inserted[0]!;
    // 5 metrics × the row's columns
    const json = JSON.stringify(vals);
    expect(json).toContain('"/ar/p/pack/"');
    expect(json).not.toContain('utm_source');
    expect(json).not.toContain('0555123456');
    expect(json).not.toContain('4102444800000');
    // `at` = server receive time truncated to the minute (no linking to an order's created_at).
    const ats = vals.filter((x) => typeof x === 'number' && x % MINUTE_MS === 0 && x >= minuteOf(before) && x <= Date.now());
    expect(ats.length).toBeGreaterThanOrEqual(5);
    expect(vals.some((x) => typeof x === 'number' && x > 1e12 && x % MINUTE_MS !== 0)).toBe(false);
    for (const m of ['TTFB', 'LCP', 'DNS', 'CONNECT', 'TLS']) expect(vals).toContain(m);
  });

  test('a chunked body with no Content-Length is cut off at 1 KiB (413), never buffered whole', async () => {
    const { app, env, ctx, inserted } = setup();
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 512;
        if (pulled > 64 * 1024) return c.close();
        c.enqueue(new Uint8Array(512).fill(0x20));
      },
    });
    const res = await app.request('/api/rum', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: stream, duplex: 'half' } as RequestInit, env, ctx);
    expect(res.status).toBe(413);
    expect(pulled).toBeLessThan(4096);
    expect(inserted).toHaveLength(0);
  });

  test('an understated Content-Length does not get past the cap', async () => {
    const { send, inserted } = setup();
    expect((await send({ ...BEACON, pad: 'x'.repeat(2000) }, { 'Content-Length': '10' })).status).toBe(413);
    expect(inserted).toHaveLength(0);
  });

  test('application/json is accepted too (sendBeacon with a Blob)', async () => {
    const { send } = setup();
    expect((await send(BEACON, { 'Content-Type': 'application/json' })).status).toBe(204);
  });

  test.each([
    ['not JSON', '{nope', 400],
    ['wrong version', { ...BEACON, v: 2 }, 400],
    ['unknown lang', { ...BEACON, lang: 'en' }, 400],
    ['bad template id', { ...BEACON, tpl: 'Product Page' }, 400],
    ['path outside the storefront', { ...BEACON, path: '/api/order' }, 400],
    ['negative metric', { ...BEACON, lcp: -1 }, 400],
    ['absurd metric', { ...BEACON, lcp: 9e9 }, 400],
    ['NaN as string', { ...BEACON, lcp: 'NaN' }, 400],
    ['no metric at all', { v: 1, lang: 'fr', tpl: 'home', path: '/fr/' }, 400],
    ['oversized', { ...BEACON, pad: 'x'.repeat(2000) }, 413],
  ])('%s → %i, nothing stored', async (_l, body, status) => {
    const { send, inserted } = setup();
    expect((await send(body)).status).toBe(status);
    expect(inserted).toHaveLength(0);
  });

  test('wrong type → 415, cross-site → 403, GET → 405', async () => {
    const { send, app, env, ctx } = setup();
    expect((await send(BEACON, { 'Content-Type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    expect((await send(BEACON, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await app.request('/api/rum', {}, env, ctx)).status).toBe(405);
  });

  test('sampling: outside the sample → 204 and nothing stored', async () => {
    const { send, inserted } = setup({ sample: '0.25', random: 0.5 });
    expect((await send(BEACON)).status).toBe(204);
    expect(inserted).toHaveLength(0);
    const kept = setup({ sample: '0.25', random: 0.1 });
    await kept.send(BEACON);
    expect(kept.inserted).toHaveLength(1);
  });

  test('flood guard: an IP over its RUM limit is dropped silently (204), keyed on /64 for IPv6', async () => {
    const { send, inserted, rl } = setup({ ipAllowed: false });
    expect((await send(BEACON, { 'CF-Connecting-IP': '2001:db8:1:2:3:4:5:6' })).status).toBe(204);
    expect(rl.limit).toHaveBeenCalledWith({ key: '2001:db8:1:2::/64' });
    expect(inserted).toHaveLength(0);
  });
});
