/**
 * The admin refuses access without auth: every admin route answers 401/403 (never a page, never a
 * redirect into the app) with no session, with a garbage Cloudflare Access JWT, and with a forged
 * dev cookie (BRIEF §2: "No auth ⇒ 401/403, never a page").
 */
import { request } from 'node:http';
import { describe, expect } from 'vitest';
import { needs } from './needs.ts';
import { adminLogin } from './flows.ts';

/** Every route the admin mounts (apps/admin/src/app.ts + routes/*); extend when areas add routes. */
export const ADMIN_ROUTES: Array<[method: 'GET' | 'POST', path: string]> = [
  ['GET', '/'], ['GET', '/dashboard'], ['GET', '/orders'], ['GET', '/orders/1'], ['GET', '/customers'],
  ['GET', '/products'], ['GET', '/categories'], ['GET', '/fees'], ['GET', '/content'], ['GET', '/media'],
  ['GET', '/publish'], ['GET', '/users'], ['GET', '/settings'], ['GET', '/assets/admin.css'],
  ['POST', '/settings/language'], ['POST', '/orders/1/transition'], ['POST', '/fees'], ['POST', '/publish'],
];

describe('admin without auth', () => {
  const variants: Array<[string, Record<string, string>]> = [
    ['no credentials', {}],
    ['a garbage Cf-Access-Jwt-Assertion', { 'Cf-Access-Jwt-Assertion': 'eyJhbGciOiJSUzI1NiJ9.e30.c2lnbmF0dXJl' }],
    ['a forged dev session cookie', { cookie: 'hb_dev=owner%40dev.local.forged' }],
  ];
  for (const [label, headers] of variants) {
    needs('adminAuth')(`every route answers 401/403 with ${label}`, async ({ admin }) => {
      const bad: string[] = [];
      for (const [method, p] of ADMIN_ROUTES) {
        const r = await fetch(`${admin}${p}`, {
          method, redirect: 'manual', headers: { ...headers, ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded', origin: admin } : {}) },
          ...(method === 'POST' ? { body: 'x=1' } : {}),
        });
        if (r.status !== 401 && r.status !== 403) bad.push(`${method} ${p} → ${r.status}`);
      }
      expect(bad).toEqual([]);
    });
  }

  needs('adminAuth', 'seed')('an inactive dev user is refused', async ({ admin }) => {
    await expect(adminLogin(admin, 'inactive@dev.local')).rejects.toThrow(/HTTP 403/);
  });

  needs('adminAuth')('the dev login itself refuses a non-loopback Host', async ({ admin }) => {
    // node:http, because fetch() does not let a caller set Host
    const u = new URL(`${admin}/__dev/login`);
    const status = await new Promise<number>((ok, fail) => {
      request({ host: u.hostname, port: u.port, path: u.pathname, headers: { host: 'admin.hbdestockage.dz' } }, (res) => { res.resume(); ok(res.statusCode ?? 0); })
        .on('error', fail).end();
    });
    expect([401, 403, 404]).toContain(status);
  });

  needs('adminAuth', 'seed')('control: with a dev session the dashboard is served (so the 401/403s above mean something)', async ({ admin }) => {
    const cookie = await adminLogin(admin);
    const r = await fetch(`${admin}/dashboard`, { headers: { cookie } });
    expect(r.status).toBe(200);
  });
});
