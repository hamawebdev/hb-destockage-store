// Integration: the real Worker in workerd (wrangler test harness), with the bindings from
// wrangler.jsonc env "test" (local D1, queue producer, rate limiters) and fixture static assets.
// Plan: artifacts/WEB-0/plan.md §1.1, §10.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestHarness, type TestHarness } from 'wrangler';
import type { Env } from '../src/env.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let server: TestHarness;

beforeAll(async () => {
  server = createTestHarness({ root, workers: [{ configPath: './wrangler.jsonc', env: 'test' }] });
  await server.listen();
}, 60_000);

afterAll(async () => {
  await server?.close();
});

describe('worker in workerd', () => {
  test('/api/health answers with API headers', async () => {
    const res = await server.fetch('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, env: 'test' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('/api/health?db=1 reaches the local D1', async () => {
    const res = await server.fetch('/api/health?db=1');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, db: 'ok' });
  });

  test('unknown /api/* is a JSON 404 from the Worker, not the asset 404 page', async () => {
    const res = await server.fetch('/api/missing');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, code: 'not_found' });
  });

  test('pages are static assets (Worker not involved)', async () => {
    const res = await server.fetch('/ar/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('fixture-ar-home');
    expect(res.headers.get('cache-control')).not.toBe('no-store');
  });

  test('root uses _redirects (never Accept-Language)', async () => {
    const res = await server.fetch('/', { redirect: 'manual', headers: { 'Accept-Language': 'fr' } });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location') ?? '', 'http://x').pathname).toBe('/ar/');
  });

  test('not_found_handling serves the 404 page', async () => {
    const res = await server.fetch('/ar/does-not-exist/');
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('fixture-404');
  });

  test.each(['ar', 'fr'])('/%s/order/confirmation/ runs the Worker first (no-store)', async (lang) => {
    const res = await server.fetch(`/${lang}/order/confirmation/?ref=HB-7K2Q9`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`fixture-${lang}-confirmation`);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('bindings exist: D1, queue producer, both rate limiters', async () => {
    const env = await server.getWorker<Env>().getEnv();
    expect(typeof env.DB.prepare).toBe('function');
    expect(typeof env.ORDERS.send).toBe('function');
    const key = `test-${Date.now()}`;
    const outcomes: boolean[] = [];
    for (let i = 0; i < 6; i++) outcomes.push((await env.ORDER_RL_PHONE.limit({ key })).success);
    // limit 5 per 60 s: the sixth call in the window is refused.
    expect(outcomes).toEqual([true, true, true, true, true, false]);
    expect((await env.ORDER_RL_IP.limit({ key })).success).toBe(true);
  }, 30_000);
});
