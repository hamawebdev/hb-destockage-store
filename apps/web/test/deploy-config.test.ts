// What a deploy ships (rev-f / rev-d, WEB-2 r2): wrangler.jsonc read by wrangler itself the way
// `wrangler deploy` and `npm run build` (`deploy --dry-run --env=""`) read it. The top level must be
// production, refuse placeholder (invented, seeded) delivery fees, carry no local hostname, and a
// Worker running it without its required SITE_HOSTS must fail closed on every /api/* route.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { unstable_readConfig } from 'wrangler';
import { app } from '../src/app.ts';
import { ConfigError, readConfig, type Env } from '../src/env.ts';
import { allowPlaceholderFees } from '../src/fees.ts';

const CONFIG = resolve(dirname(fileURLToPath(import.meta.url)), '../wrangler.jsonc');
const read = (env: string | undefined) => unstable_readConfig({ config: CONFIG, ...(env === undefined ? {} : { env }) }, { hideWarnings: true });

describe('the deployed configuration', () => {
  test.each([
    ['wrangler deploy (no --env)', undefined],
    ['npm run build (--env="")', ''],
  ])('%s: ENV=production, placeholder fees refused, no local hostname anywhere', (_l, env) => {
    const c = read(env);
    expect(c.vars['ENV']).toBe('production');
    expect(allowPlaceholderFees({ ENV: c.vars['ENV'] })).toBe(false);
    expect(JSON.stringify(c.vars)).not.toMatch(/localhost|127\.0\.0\.1/);
    // SITE_HOSTS is required at deploy time: absent from the repo, so readConfig refuses to run.
    expect(c.vars['SITE_HOSTS']).toBeUndefined();
    expect(() => readConfig(c.vars as unknown as Env)).toThrow(ConfigError);
  });

  test('a Worker running the repo config as-is answers 500 on every /api/* and logs config_invalid', async () => {
    const vars = read('').vars as Record<string, string>;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (const [path, init] of [
        ['/api/health', {}],
        ['/api/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }],
        ['/api/order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }],
        ['/api/rum', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }],
      ] as const) {
        const res = await app.request(path, init, { ...vars } as unknown as Env);
        expect(res.status, path).toBe(500);
        expect(await res.json()).toEqual({ ok: false, code: 'server_error' });
      }
      expect(log.mock.calls.some((c) => String(c[0]).includes('"evt":"config_invalid"'))).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  test('production with the client hostname set at deploy runs', () => {
    const vars = { ...read('').vars, SITE_HOSTS: 'hbdestockagedz.com,www.hbdestockagedz.com' };
    expect(readConfig(vars as unknown as Env)).toMatchObject({ env: 'production', siteHosts: ['hbdestockagedz.com', 'www.hbdestockagedz.com'] });
  });

  test.each(['localhost', 'shop.dz,127.0.0.1', '::1', 'shop.dz, localhost '])('production with SITE_HOSTS=%j is refused', (hosts) => {
    expect(() => readConfig({ ...read('').vars, SITE_HOSTS: hosts } as unknown as Env)).toThrow(/local hostname|hostnames/);
  });

  test.each(['shop dz', 'https://shop.dz', 'shop.dz/path', '[PLACEHOLDER]'])('SITE_HOSTS=%j (not a hostname) is refused', (hosts) => {
    expect(() => readConfig({ ...read('').vars, SITE_HOSTS: hosts } as unknown as Env)).toThrow(ConfigError);
  });

  test('development values exist only outside the deployed config (dev script --var, env "test")', () => {
    expect(allowPlaceholderFees({ ENV: read('test').vars['ENV'] })).toBe(false);
    expect(readConfig({ ...read('').vars, ENV: 'development', SITE_HOSTS: 'localhost,127.0.0.1' } as unknown as Env).env).toBe('development');
  });

  test('every env keeps the full binding set (bindings are not inherited by named envs)', () => {
    for (const env of [undefined, 'test']) {
      const c = read(env);
      expect(c.d1_databases.map((d: { binding: string }) => d.binding), String(env)).toEqual(['DB']);
      expect(c.queues.producers?.map((q: { binding: string }) => q.binding), String(env)).toEqual(['ORDERS']);
      expect(c.ratelimits.map((r: { name: string }) => r.name).sort(), String(env)).toEqual(['ORDER_RL_IP', 'ORDER_RL_PHONE', 'RUM_RL_IP']);
    }
  });
});
