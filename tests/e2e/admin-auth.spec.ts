/**
 * The admin refuses access without auth: every admin route answers 401/403 (never a page, never a
 * redirect into the app) with no session, with a garbage Cloudflare Access JWT, and with a forged
 * dev cookie (BRIEF §2: "No auth ⇒ 401/403, never a page").
 *
 * Each test first proves its success path (a real dev login gives 303 + a cookie that is served
 * the dashboard; a loopback Host gets the login page), so a refusal can only mean what it says.
 * The routes come from the admin's own tables: admin-core's mounts in apps/admin/src/app.ts and
 * admin-orders' route table (harness ADMIN_ROUTES), not from a hand-kept list.
 */
import { request } from 'node:http';
import { describe, expect } from 'vitest';
import { ADMIN_ROUTES } from './harness.ts';
import { needs } from './needs.ts';
import { adminLogin, sameOrigin } from './flows.ts';

/** GET /dashboard with a cookie: the success-path control. */
async function dashboard(admin: string, cookie: string): Promise<number> {
  return (await fetch(`${admin}/dashboard`, { headers: { cookie }, redirect: 'manual' })).status;
}

/** A real session's cookie with its HMAC signature replaced: well-formed, unexpired, not authentic. */
function forge(cookie: string): string {
  return cookie.replace(/(hb_dev=[^.;]+\.)([A-Za-z0-9_-]+)/, (_m, head: string, sig: string) => head + (sig.startsWith('A') ? 'B' : 'A') + sig.slice(1));
}

describe('admin without auth', () => {
  const variants: Array<[string, (real: string) => Record<string, string>]> = [
    ['no credentials', () => ({})],
    ['a garbage Cf-Access-Jwt-Assertion', () => ({ 'Cf-Access-Jwt-Assertion': 'eyJhbGciOiJSUzI1NiJ9.e30.c2lnbmF0dXJl' })],
    ['a forged dev session cookie (real payload, wrong signature)', (real) => ({ cookie: forge(real) })],
  ];
  for (const [label, headersFor] of variants) {
    needs('adminAuth', 'seed')(`every route answers 401/403 with ${label}`, async ({ admin }) => {
      const routes = ADMIN_ROUTES();
      expect(routes.length, 'admin routes found in app.ts and the orders route table').toBeGreaterThan(10);
      const real = await adminLogin(admin); // success path first: 303 + cookie…
      expect(await dashboard(admin, real), 'a real dev session is served the dashboard').toBe(200); // …that is served
      const headers = headersFor(real);
      if (headers['cookie']) expect(headers['cookie'], 'the forged cookie differs from the real one').not.toBe(real);
      const bad: string[] = [];
      for (const [method, p] of routes) {
        const r = await fetch(`${admin}${p}`, {
          method, redirect: 'manual', headers: { ...headers, ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded', ...sameOrigin(admin) } : {}) },
          ...(method === 'POST' ? { body: 'x=1' } : {}),
        });
        if (r.status !== 401 && r.status !== 403) bad.push(`${method} ${p} → ${r.status}`);
      }
      expect(bad).toEqual([]);
    });
  }

  needs('adminAuth', 'seed')('an inactive dev user is refused (while an active one, same request, is let in)', async ({ admin }) => {
    const owner = await adminLogin(admin, 'owner@dev.local'); // the same request succeeds for an active user
    expect(await dashboard(admin, owner)).toBe(200);
    await expect(adminLogin(admin, 'inactive@dev.local')).rejects.toThrow(/HTTP 403/);
  });

  needs('adminAuth')('the dev login itself refuses a non-loopback Host (while the loopback Host gets it)', async ({ admin }) => {
    // node:http, because fetch() does not let a caller set Host
    const u = new URL(`${admin}/__dev/login`);
    const get = (host: string): Promise<number> => new Promise<number>((ok, fail) => {
      request({ host: u.hostname, port: u.port, path: u.pathname, headers: { host } }, (res) => { res.resume(); ok(res.statusCode ?? 0); })
        .on('error', fail).end();
    });
    expect(await get(u.host), 'loopback Host').toBe(200);
    expect([401, 403, 404]).toContain(await get('admin.comptoirdeluxe.com'));
  });

  needs('adminAuth', 'seed')('control: each dev role logs in and is served the dashboard', async ({ admin }) => {
    for (const email of ['owner@dev.local', 'confirmer@dev.local', 'logistics@dev.local']) {
      expect(await dashboard(admin, await adminLogin(admin, email)), email).toBe(200);
    }
  });
});
