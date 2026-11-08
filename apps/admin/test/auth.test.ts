// ADMIN-2: Cloudflare Access JWT, local dev login, and "every route refuses without auth".
import { exportJWK, generateKeyPair, createLocalJWKSet, SignJWT, type JWK, type JWTVerifyGetKey } from 'jose';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import { app as prodApp } from '../src/index.ts';
import { verifyAccessJwt, MAX_JWT_LENGTH } from '../src/auth/access.ts';
import { createDefaultIdentify } from '../src/auth/authenticate.ts';
import { DEV_COOKIE, readDevSession, signDevSession } from '../src/auth/dev-session.ts';
import type { Env } from '../src/env.ts';
import { harness, seedUsers, testEnv, USERS, type Harness } from './helpers.ts';

// Real D1 (workerd) requests take seconds on the loaded shared machine: explicit budgets instead
// of vitest's 5 s default, so the admin gate is not red at random (lead, 2026-11-06).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

const TEAM = 'https://hbtest.cloudflareaccess.com';
const AUD = 'b'.repeat(64);
const DEV_SECRET = 'dev-secret-for-tests-0123456789abcdef0123';

let h: Harness;
let getKey: JWTVerifyGetKey;
let priv: CryptoKey;
let otherPriv: CryptoKey;
let accessEnv: Env;

const DEV = {
  owner: 'owner@dev.local',
  confirmer: 'confirmer@dev.local',
  inactive: 'inactive@dev.local',
} as const;

beforeAll(async () => {
  h = await harness();
  await h.db.batch([
    h.db.prepare("insert into admin_users (email, name, role, active) values (?, 'Dev owner', 'owner', 1)").bind(DEV.owner),
    h.db.prepare("insert into admin_users (email, name, role, active) values (?, 'Dev confirmer', 'confirmer', 1)").bind(DEV.confirmer),
    h.db.prepare("insert into admin_users (email, name, role, active) values (?, 'Dev inactive', 'owner', 0)").bind(DEV.inactive),
  ]);
  const kp = await generateKeyPair('RS256', { extractable: true });
  priv = kp.privateKey;
  otherPriv = (await generateKeyPair('RS256')).privateKey;
  const jwk: JWK = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  getKey = createLocalJWKSet({ keys: [jwk] });
  accessEnv = { ...h.env, ENV: 'production', ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
}, 120_000);
afterAll(async () => {
  await h?.close();
});

interface TokenOpts {
  email?: string | undefined;
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  type?: string | undefined;
  key?: CryptoKey;
  kid?: string;
  extra?: Record<string, unknown>;
}

async function token(o: TokenOpts = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = { ...(o.extra ?? {}) };
  if (!('email' in o) || o.email !== undefined) claims['email'] = o.email ?? USERS.owner;
  if (!('type' in o) || o.type !== undefined) claims['type'] = o.type ?? 'app';
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: o.kid ?? 'k1' })
    .setIssuer(o.iss ?? TEAM)
    .setAudience(o.aud ?? [AUD])
    .setSubject('user-sub')
    .setIssuedAt(now - 10)
    .setExpirationTime(o.exp ?? now + 3600);
  if (o.nbf !== undefined) jwt.setNotBefore(o.nbf);
  return jwt.sign(o.key ?? priv);
}

function unsigned(header: object, payload: object, sig = ''): string {
  const enc = (x: object) => Buffer.from(JSON.stringify(x)).toString('base64url');
  return `${enc(header)}.${enc(payload)}.${sig}`;
}

const accessApp = () => createApp({ identify: createDefaultIdentify({ getKey }) });

async function withJwt(jwt: string | null, path = '/dashboard', env: Env = accessEnv, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (jwt !== null) headers.set('Cf-Access-Jwt-Assertion', jwt);
  return accessApp().request(`https://admin.hb.example${path}`, { ...init, headers }, env);
}

describe('Cloudflare Access JWT', () => {
  test('valid token for an active user → 200', async () => {
    expect((await withJwt(await token())).status).toBe(200);
  });
  test('email claim is normalised (case, spaces)', async () => {
    expect((await withJwt(await token({ email: 'Owner@Test.Local' }))).status).toBe(200);
  });
  test('no header → 401; empty header → 401', async () => {
    expect((await withJwt(null)).status).toBe(401);
    expect((await withJwt('')).status).toBe(401);
  });
  test('the CF_Authorization cookie alone is not accepted', async () => {
    const res = await withJwt(null, '/dashboard', accessEnv, { headers: { Cookie: `CF_Authorization=${await token()}` } });
    expect(res.status).toBe(401);
  });
  const now = () => Math.floor(Date.now() / 1000);
  const bad: [string, () => Promise<string>][] = [
    ['malformed (not a JWT)', async () => 'not-a-jwt'],
    ['malformed (3 junk segments)', async () => 'a.b.c'],
    ['oversized', async () => 'a'.repeat(MAX_JWT_LENGTH + 1) + '.b.c'],
    ['signed by another key', () => token({ key: otherPriv })],
    ['unknown kid', () => token({ kid: 'nope' })],
    ['expired', () => token({ exp: now() - 120 })],
    ['not yet valid (nbf in the future)', () => token({ nbf: now() + 600 })],
    ['wrong audience', () => token({ aud: ['c'.repeat(64)] })],
    ['wrong issuer', () => token({ iss: 'https://evil.cloudflareaccess.com' })],
    ['issuer with trailing slash', () => token({ iss: `${TEAM}/` })],
    ['service token (no email, common_name)', () => token({ email: undefined, extra: { common_name: 'svc.access' } })],
    ['type is not "app"', () => token({ type: 'org' })],
    ['type missing', () => token({ type: undefined })],
    ['alg none', async () => unsigned({ alg: 'none', kid: 'k1' }, { email: USERS.owner, aud: [AUD], iss: TEAM, exp: now() + 60, iat: now(), sub: 's', type: 'app' })],
    ['HS256 with the public key as secret', async () => {
      const jwk = await exportJWK(priv);
      const secret = new TextEncoder().encode(JSON.stringify(jwk));
      return new SignJWT({ email: USERS.owner, type: 'app' })
        .setProtectedHeader({ alg: 'HS256', kid: 'k1' })
        .setIssuer(TEAM).setAudience([AUD]).setSubject('s').setIssuedAt().setExpirationTime('1h')
        .sign(secret);
    }],
    ['tampered payload', async () => {
      const t = await token();
      const [hdr, , sig] = t.split('.');
      const payload = Buffer.from(JSON.stringify({ email: USERS.owner, type: 'app', iss: TEAM, aud: [AUD], sub: 's', iat: now(), exp: now() + 9999, role: 'owner' })).toString('base64url');
      return `${hdr}.${payload}.${sig}`;
    }],
  ];
  for (const [name, make] of bad) {
    test(`${name} → 403`, async () => {
      const res = await withJwt(await make());
      expect(res.status).toBe(403);
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    });
  }
  test('unknown email → 403; inactive user → 403 (same body as a bad token)', async () => {
    const unknown = await withJwt(await token({ email: 'stranger@example.com' }));
    const inactive = await withJwt(await token({ email: USERS.inactive }));
    const badTok = await withJwt('a.b.c');
    expect(unknown.status).toBe(403);
    expect(inactive.status).toBe(403);
    const strip = (s: string) => s.replace(/<bdi dir="ltr">[^<]*<\/bdi>/g, '');
    const ref = strip(await badTok.text());
    expect(strip(await unknown.text())).toBe(ref);
    expect(strip(await inactive.text())).toBe(ref);
  });
  test('deactivation takes effect on the next request', async () => {
    const jwt = await token({ email: USERS.confirmer });
    expect((await withJwt(jwt)).status).toBe(200);
    await h.db.prepare('update admin_users set active = 0 where email = ?').bind(USERS.confirmer).run();
    expect((await withJwt(jwt)).status).toBe(403);
    await h.db.prepare('update admin_users set active = 1 where email = ?').bind(USERS.confirmer).run();
  });
  test('certs unreachable → 503 (fail closed)', async () => {
    const app = createApp({
      identify: createDefaultIdentify({
        getKey: async () => {
          throw new TypeError('fetch failed');
        },
      }),
    });
    const res = await app.request('https://admin.hb.example/dashboard', { headers: { 'Cf-Access-Jwt-Assertion': await token() } }, accessEnv);
    expect(res.status).toBe(503);
  });
  test('Access not configured → a token is refused (403), never trusted', async () => {
    const env = { ...accessEnv, ENV: 'development' as const, ACCESS_AUD: '' };
    expect((await withJwt(await token(), '/dashboard', env)).status).toBe(403);
  });
  test('verifyAccessJwt honours the 60 s clock tolerance', async () => {
    const cfg = { teamDomain: TEAM, aud: AUD };
    const exp = Math.floor(Date.now() / 1000) + 10;
    const t = await token({ exp });
    expect((await verifyAccessJwt(t, cfg, getKey, new Date((exp + 30) * 1000))).ok).toBe(true);
    expect((await verifyAccessJwt(t, cfg, getKey, new Date((exp + 90) * 1000))).ok).toBe(false);
  });
});

describe('local dev login', () => {
  const devEnv = (): Env => ({ ...h.env, ENV: 'development', DEV_SESSION_SECRET: DEV_SECRET });
  const app = () => createApp({ identify: createDefaultIdentify({ getKey }) });
  const post = (origin: string, data: Record<string, string>, extra: Record<string, string> = {}): RequestInit => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, ...extra },
    body: new URLSearchParams(data).toString(),
  });

  async function login(base: string, email: string, env = devEnv()) {
    return app().request(`${base}/__dev/login`, post(base, { email }), env);
  }
  function cookieOf(res: Response): string {
    const sc = res.headers.get('Set-Cookie') ?? '';
    const m = new RegExp(`${DEV_COOKIE}=([^;]+)`).exec(sc);
    if (!m) throw new Error(`no ${DEV_COOKIE} cookie: ${sc}`);
    return m[1]!;
  }

  for (const base of ['http://localhost:4240', 'http://127.0.0.1:4240', 'http://[::1]:4240']) {
    test(`works on ${base}: list, login, session, logout`, async () => {
      const page = await app().request(`${base}/__dev/login`, {}, devEnv());
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain(DEV.owner);
      expect(html).toContain(DEV.confirmer);
      expect(html).not.toContain(DEV.inactive);
      expect(html).not.toContain(USERS.owner); // non-dev accounts are never offered
      const res = await login(base, DEV.confirmer);
      expect(res.status).toBe(303);
      const sc = res.headers.get('Set-Cookie')!;
      expect(sc).toMatch(/HttpOnly/i);
      expect(sc).toMatch(/SameSite=Strict/i);
      const cookie = cookieOf(res);
      const dash = await app().request(`${base}/dashboard`, { headers: { Cookie: `${DEV_COOKIE}=${cookie}` } }, devEnv());
      expect(dash.status).toBe(200);
      expect(await dash.text()).toContain(DEV.confirmer);
      const out = await app().request(`${base}/__dev/logout`, post(base, {}), devEnv());
      expect(out.status).toBe(303);
      expect(out.headers.get('Set-Cookie')).toMatch(new RegExp(`${DEV_COOKIE}=;.*Max-Age=0`, 'i'));
    });
  }

  test('without a session, dev gets 401 with a link to the dev login', async () => {
    const res = await app().request('http://localhost:4240/dashboard', {}, devEnv());
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('/__dev/login');
  });

  const refusedEnvs: [string, string, () => Env][] = [
    ['ENV=production on localhost', 'http://localhost:4240', () => ({ ...h.env, ENV: 'production', DEV_SESSION_SECRET: DEV_SECRET, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD })],
    ['ENV=test on localhost', 'http://localhost:4240', () => ({ ...h.env, ENV: 'test', DEV_SESSION_SECRET: DEV_SECRET })],
    ['ENV=development on the real host', 'https://admin.hb.example', devEnv],
    ['ENV=development on a host that merely starts with localhost', 'http://localhost.evil.example', devEnv],
    ['ENV=development without DEV_SESSION_SECRET', 'http://localhost:4240', () => ({ ...h.env, ENV: 'development' })],
    ['ENV=development with a short secret', 'http://localhost:4240', () => ({ ...h.env, ENV: 'development', DEV_SESSION_SECRET: 'short' })],
  ];
  for (const [name, base, env] of refusedEnvs) {
    test(`refused: ${name} → /__dev/* 404 and the cookie is ignored`, async () => {
      const valid = await signDevSession(DEV_SECRET, DEV.owner);
      expect((await app().request(`${base}/__dev/login`, {}, env())).status).toBe(404);
      expect((await app().request(`${base}/__dev/login`, post(base, { email: DEV.owner }), env())).status).toBe(404);
      expect((await app().request(`${base}/__dev/logout`, post(base, {}), env())).status).toBe(404);
      const res = await app().request(`${base}/dashboard`, { headers: { Cookie: `${DEV_COOKIE}=${valid}` } }, env());
      expect(res.status).toBe(401);
    });
  }

  test('no header can enable it (Host / X-Forwarded-Host / X-Dev-* on the real host)', async () => {
    const headers = {
      Host: 'localhost',
      'X-Forwarded-Host': 'localhost',
      'X-Forwarded-For': '127.0.0.1',
      'X-Dev-Auth': '1',
      'X-Original-URL': 'http://localhost/__dev/login',
      'CF-Connecting-IP': '127.0.0.1',
    };
    const res = await app().request('https://admin.hb.example/__dev/login', { headers }, devEnv());
    expect(res.status).toBe(404);
    const cookie = await signDevSession(DEV_SECRET, DEV.owner);
    const dash = await app().request('https://admin.hb.example/dashboard', { headers: { ...headers, Cookie: `${DEV_COOKIE}=${cookie}` } }, devEnv());
    expect(dash.status).toBe(401);
  });

  test('login only for active @dev.local accounts', async () => {
    for (const email of [USERS.owner, DEV.inactive, 'ghost@dev.local', '']) {
      expect((await login('http://localhost:4240', email)).status, email).toBe(403);
    }
  });

  test('cross-site login POST → 403; missing Origin and Sec-Fetch-Site → 403', async () => {
    const app1 = app();
    expect((await app1.request('http://localhost:4240/__dev/login', post('http://evil.example', { email: DEV.owner }), devEnv())).status).toBe(403);
    expect(
      (await app1.request('http://localhost:4240/__dev/login', post('http://localhost:4240', { email: DEV.owner }, { 'Sec-Fetch-Site': 'cross-site' }), devEnv())).status,
    ).toBe(403);
    const noOrigin: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `email=${DEV.owner}` };
    expect((await app1.request('http://localhost:4240/__dev/login', noOrigin, devEnv())).status).toBe(403);
  });

  test('forged, tampered, expired or foreign cookies are refused', async () => {
    const now = Date.now();
    const good = await signDevSession(DEV_SECRET, DEV.owner, now);
    const [payload, sig] = good.split('.') as [string, string];
    const forgedPayload = Buffer.from(JSON.stringify({ email: DEV.owner, exp: 9_999_999_999 })).toString('base64url');
    const cases = [
      `${forgedPayload}.${sig}`,
      `${payload}.${sig.slice(0, -2)}xx`,
      await signDevSession('another-secret-0123456789abcdef0123456789', DEV.owner, now),
      await signDevSession(DEV_SECRET, DEV.owner, now - 13 * 60 * 60 * 1000),
      await signDevSession(DEV_SECRET, USERS.owner, now), // not a dev account
      'garbage',
      '',
    ];
    for (const c of cases) {
      const res = await app().request('http://localhost:4240/dashboard', { headers: { Cookie: `${DEV_COOKIE}=${c}` } }, devEnv());
      expect(res.status, c).toBe(401);
    }
    expect(await readDevSession(DEV_SECRET, good, now)).toBe(DEV.owner);
  });

  test('a dev cookie for an account that was deactivated → 403', async () => {
    const cookie = await signDevSession(DEV_SECRET, DEV.inactive);
    const res = await app().request('http://localhost:4240/dashboard', { headers: { Cookie: `${DEV_COOKIE}=${cookie}` } }, devEnv());
    expect(res.status).toBe(403);
  });
});

describe('every registered route refuses without auth (route walk over the production app)', () => {
  const routes = prodApp.routes.filter((r) => r.method !== 'ALL');
  const concrete = (p: string) => p.replace(/:(\w+)\{[^}]*\}/g, '1').replace(/:\w+/g, '1').replace(/\*/g, 'x');

  test('the router has the expected mount points', () => {
    const paths = new Set(routes.map((r) => r.path));
    for (const p of ['/dashboard', '/users', '/settings', '/orders', '/customers', '/products', '/categories', '/fees', '/content', '/media', '/publish', '/settings/language', '/__dev/login']) {
      expect(paths, p).toContain(p);
    }
  });

  test('production env, no credentials → 401 on every route and method (dev routes → 404)', async () => {
    const env = { ...testEnv({} as D1Database), ENV: 'production' as const, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
    for (const r of routes) {
      const path = concrete(r.path);
      const res = await prodApp.request(`https://admin.hb.example${path}`, { method: r.method }, env);
      expect(res.status, `${r.method} ${r.path}`).toBe(r.path.startsWith('/__dev') ? 404 : 401);
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    }
  }, 180_000);

  test('production env, malformed token → 403 on every route and method', async () => {
    const env = { ...testEnv({} as D1Database), ENV: 'production' as const, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
    for (const r of routes) {
      if (r.path.startsWith('/__dev')) continue;
      const res = await prodApp.request(`https://admin.hb.example${concrete(r.path)}`, { method: r.method, headers: { 'Cf-Access-Jwt-Assertion': 'x.y.z' } }, env);
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
    }
  }, 180_000);

  test('production env, valid token for an unknown email → 403 on every route', async () => {
    const jwt = await token({ email: 'stranger@example.com' });
    for (const r of routes) {
      if (r.path.startsWith('/__dev')) continue;
      const res = await withJwt(jwt, concrete(r.path), accessEnv, { method: r.method });
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
    }
  }, 180_000);

  test('development env on localhost, no session → 401 everywhere except the dev login itself', async () => {
    const env: Env = { ...h.env, ENV: 'development', DEV_SESSION_SECRET: DEV_SECRET };
    for (const r of routes) {
      const path = concrete(r.path);
      const res = await prodApp.request(`http://localhost:4240${path}`, { method: r.method }, env);
      if (r.path.startsWith('/__dev')) {
        expect([200, 303, 403], `${r.method} ${r.path}`).toContain(res.status); // POST without Origin → 403
      } else {
        expect(res.status, `${r.method} ${r.path}`).toBe(401);
      }
    }
  }, 180_000);
});

// seedUsers is re-exported for builders' tests; keep the import used.
void seedUsers;
