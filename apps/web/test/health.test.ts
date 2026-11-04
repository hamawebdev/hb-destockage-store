// Unit tests of the Hono app with fake bindings (no workerd). Plan: artifacts/WEB-0/plan.md §1, §10.
import { describe, expect, test, vi } from 'vitest';
import { app } from '../src/index.ts';
import { ConfigError, readConfig, type Env } from '../src/env.ts';

function fakeEnv(over: Partial<Record<keyof Env, unknown>> = {}): Env {
  const assets = { fetch: vi.fn(async () => new Response('asset', { status: 200, headers: { 'Content-Type': 'text/html' } })) };
  const db = {
    prepare: vi.fn(() => ({ first: vi.fn(async () => ({ one: 1 })) })),
  };
  return {
    ASSETS: assets,
    DB: db,
    ORDERS: { send: vi.fn() },
    ORDER_RL_PHONE: { limit: vi.fn(async () => ({ success: true })) },
    ORDER_RL_IP: { limit: vi.fn(async () => ({ success: true })) },
    ENV: 'test',
    SITE_HOSTS: 'localhost',
    MIN_FILL_MS: '2500',
    MIN_REVIEW_MS: '1500',
    RUM_SAMPLE: '1',
    ...over,
  } as unknown as Env;
}

const API_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
};

function expectApiHeaders(res: Response): void {
  for (const [k, v] of Object.entries(API_HEADERS)) expect(res.headers.get(k), k).toBe(v);
  expect(res.headers.get('set-cookie')).toBeNull();
}

describe('/api/health', () => {
  test('GET answers ok with the env name and API headers, without touching D1', async () => {
    const env = fakeEnv();
    const res = await app.request('/api/health', {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, env: 'test' });
    expectApiHeaders(res);
    expect((env.DB as unknown as { prepare: ReturnType<typeof vi.fn> }).prepare).not.toHaveBeenCalled();
  });

  test('?db=1 runs select 1', async () => {
    const res = await app.request('/api/health?db=1', {}, fakeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, db: 'ok' });
  });

  test('?db=1 with a failing D1 answers 503 server_error + Retry-After, API headers kept', async () => {
    const env = fakeEnv({
      DB: { prepare: () => ({ first: async () => { throw new Error('D1_ERROR: boom'); } }) },
    });
    const res = await app.request('/api/health?db=1', {}, env);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await res.json()).toEqual({ ok: false, code: 'server_error', db: 'error' });
    expectApiHeaders(res);
  });

  test('POST is 405 with Allow', async () => {
    const res = await app.request('/api/health', { method: 'POST' }, fakeEnv());
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
    expect(await res.json()).toEqual({ ok: false, code: 'method_not_allowed' });
    expectApiHeaders(res);
  });

  test('a bad var fails loudly: 500 server_error, no stack in the body, API headers kept', async () => {
    const res = await app.request('/api/health', {}, fakeEnv({ MIN_FILL_MS: 'soon' }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, code: 'server_error' });
    expectApiHeaders(res);
  });
});

describe('fallbacks', () => {
  test('unknown /api/* is a JSON 404 with API headers', async () => {
    const res = await app.request('/api/nope', { method: 'POST' }, fakeEnv());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, code: 'not_found' });
    expectApiHeaders(res);
  });

  test('confirmation page is served from assets with no-store', async () => {
    const env = fakeEnv();
    const res = await app.request('/ar/order/confirmation/?ref=HB-7K2Q9', {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((env.ASSETS as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch).toHaveBeenCalledOnce();
  });

  test('a non-GET to a worker-first page path falls through to assets', async () => {
    const env = fakeEnv();
    const res = await app.request('/fr/order/confirmation/', { method: 'POST' }, env);
    expect(res.status).toBe(200);
    expect((env.ASSETS as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch).toHaveBeenCalledOnce();
  });
});

describe('readConfig', () => {
  test('parses vars', () => {
    expect(readConfig(fakeEnv({ SITE_HOSTS: ' Example.com , localhost ', RUM_SAMPLE: '0.25' }))).toEqual({
      env: 'test',
      siteHosts: ['example.com', 'localhost'],
      minFillMs: 2500,
      minReviewMs: 1500,
      rumSample: 0.25,
    });
  });

  test.each([
    ['ENV', 'staging'],
    ['SITE_HOSTS', ' , '],
    ['MIN_FILL_MS', '-1'],
    ['MIN_FILL_MS', '1e3'],
    ['MIN_REVIEW_MS', '999999'],
    ['RUM_SAMPLE', '2'],
    ['RUM_SAMPLE', 'x'],
  ] as const)('%s=%j is rejected, without echoing the value', (key, value) => {
    expect(() => readConfig(fakeEnv({ [key]: value }))).toThrow(ConfigError);
    try {
      readConfig(fakeEnv({ [key]: value }));
    } catch (err) {
      expect((err as Error).message).toContain(key);
      if (value.trim() !== '') expect((err as Error).message).not.toContain(value);
    }
  });
});
