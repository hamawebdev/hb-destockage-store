// ADMIN-3: CSRF enforcement, the unaudited-mutation guard, the audit viewer, response headers.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createApp } from '../src/app.ts';
import { audit, noAudit } from '../src/audit/audit.ts';
import { diffRows, parseAuditFilters } from '../src/audit/routes.tsx';
import { requireRole } from '../src/auth/require-role.ts';
import type { Env } from '../src/env.ts';
import { issueCsrfToken } from '../src/lib/csrf.ts';
import { CSRF_SECRET, csrfFrom, form, harness, postAs, tokenFor, USERS, type Harness } from './helpers.ts';

let h: Harness;
beforeAll(async () => {
  h = await harness();
}, 120_000);
afterAll(async () => {
  await h?.close();
});

const asOwner = () => createApp({ identify: async () => ({ ok: true, email: USERS.owner }) });

function expectHeaders(res: Response) {
  expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(res.headers.get('Referrer-Policy')).toBe('same-origin');
  expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=63072000');
}

describe('CSRF', () => {
  const path = '/settings/language';
  test('valid token from the page + same origin → accepted', async () => {
    const page = await (await h.as(USERS.content, '/dashboard')).text();
    const res = await h.as(USERS.content, path, form({ _csrf: csrfFrom(page), lang: 'fr' }));
    expect(res.status).toBe(303);
  });
  test('missing token → 403 with the explanation', async () => {
    const res = await h.as(USERS.content, path, form({ lang: 'ar' }));
    expect(res.status).toBe(403);
    expectHeaders(res);
    expect(await res.text()).toContain('Le formulaire a expiré');
  });
  test("another user's token → 403", async () => {
    const res = await h.as(USERS.content, path, form({ _csrf: await tokenFor(h.db, USERS.owner), lang: 'ar' }));
    expect(res.status).toBe(403);
  });
  test('expired token (13 h old) → 403', async () => {
    const row = await h.db.prepare('select id from admin_users where email = ?').bind(USERS.content).first<{ id: number }>();
    const old = await issueCsrfToken(CSRF_SECRET, row!.id, Date.now() - 13 * 3600_000);
    expect((await h.as(USERS.content, path, form({ _csrf: old, lang: 'ar' }))).status).toBe(403);
  });
  test('token signed with another secret → 403', async () => {
    const row = await h.db.prepare('select id from admin_users where email = ?').bind(USERS.content).first<{ id: number }>();
    const forged = await issueCsrfToken('x'.repeat(48), row!.id);
    expect((await h.as(USERS.content, path, form({ _csrf: forged, lang: 'ar' }))).status).toBe(403);
  });
  test('cross-site, same-site (sibling subdomain) and missing origin headers → 403 even with a valid token', async () => {
    const tok = await tokenFor(h.db, USERS.content);
    const body = new URLSearchParams({ _csrf: tok, lang: 'ar' }).toString();
    const base = { 'Content-Type': 'application/x-www-form-urlencoded' };
    const cases: Record<string, string>[] = [
      { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' },
      { 'Sec-Fetch-Site': 'same-site', Origin: 'https://shop.hb.example' },
      { 'Sec-Fetch-Site': 'none' },
      { Origin: 'https://evil.example' },
      { Origin: 'null' },
      {},
    ];
    for (const extra of cases) {
      const res = await h.as(USERS.content, path, { method: 'POST', headers: { ...base, ...extra }, body });
      expect(res.status, JSON.stringify(extra)).toBe(403);
    }
    // Origin alone (older browsers without Sec-Fetch-Site) is enough when it matches.
    const ok = await h.as(USERS.content, path, { method: 'POST', headers: { ...base, Origin: 'http://localhost' }, body });
    expect(ok.status).toBe(303);
  });
  test('non-form content types → 415 (JSON, text/plain, none)', async () => {
    const tok = await tokenFor(h.db, USERS.content);
    for (const ct of ['application/json', 'text/plain', '']) {
      const headers: Record<string, string> = { Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin' };
      if (ct) headers['Content-Type'] = ct;
      const res = await h.as(USERS.content, path, { method: 'POST', headers, body: ct === 'application/json' ? JSON.stringify({ _csrf: tok, lang: 'ar' }) : `_csrf=${tok}&lang=ar` });
      expect(res.status, ct || '(none)').toBe(415);
      expectHeaders(res);
    }
  });
  test('multipart forms carry the token too', async () => {
    const fd = new FormData();
    fd.set('_csrf', await tokenFor(h.db, USERS.content));
    fd.set('lang', 'fr');
    const res = await h.as(USERS.content, path, { method: 'POST', headers: { Origin: 'http://localhost', 'Sec-Fetch-Site': 'same-origin' }, body: fd });
    expect(res.status).toBe(303);
  });
  test('other unsafe methods are checked too (PUT/PATCH/DELETE without a token → 415/403, never reach a handler)', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await h.as(USERS.owner, path, { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'http://localhost' }, body: 'lang=ar' });
      expect(res.status, method).toBe(403);
    }
  });
  test('route walk: every registered POST route refuses an authenticated POST without a token', async () => {
    const posts = h.app.routes.filter((r) => r.method === 'POST' && !r.path.startsWith('/__dev'));
    expect(posts.length).toBeGreaterThan(0);
    for (const r of posts) {
      const p = r.path.replace(/:\w+(\{[^}]*\})?/g, '1').replace(/\*/g, 'x');
      const res = await h.as(USERS.owner, p, form({ anything: '1' }));
      expect(res.status, `POST ${r.path}`).toBe(403);
    }
  });
});

describe('audit guard', () => {
  async function count(action: string): Promise<number> {
    return (await h.db.prepare('select count(*) as n from audit_log where action = ?').bind(action).first<{ n: number }>())!.n;
  }
  function appWith(env: Env) {
    const app = asOwner();
    app.post('/t/unaudited', requireRole('owner'), async (c) => {
      await c.var.db.run(`update admin_users set name = name where id = ${c.var.user.id}`);
      return c.redirect('/dashboard', 303);
    });
    app.post('/t/audited', requireRole('owner'), async (c) => {
      await c.var.db.batch([audit(c, { action: 'test.audited', entity: 'admin_users', entityId: c.var.user.id })]);
      return c.redirect('/dashboard', 303);
    });
    app.post('/t/declared', requireRole('owner'), (c) => {
      noAudit(c, 'read-only search form');
      return c.text('ok');
    });
    app.post('/t/refused', requireRole('owner'), (c) => c.text('nope', 409));
    return (p: string) => (async () => app.request(p, form({ _csrf: await tokenFor(h.db, USERS.owner) }), env))();
  }
  test('test/development: a successful POST without an audit row is answered 500 — this is what fails a builder test suite', async () => {
    for (const ENV of ['test', 'development'] as const) {
      const res = await appWith({ ...h.env, ENV })('/t/unaudited');
      expect(res.status, ENV).toBe(500);
      expectHeaders(res);
      expect(res.headers.get('Location')).toBeNull();
    }
  });
  test('audited, noAudit-declared and refused (4xx) POSTs pass', async () => {
    const post = appWith(h.env);
    expect((await post('/t/audited')).status).toBe(303);
    expect(await count('test.audited')).toBe(1);
    expect((await post('/t/declared')).status).toBe(200);
    expect((await post('/t/refused')).status).toBe(409);
  });
  test('production: the response stands, and a system.unauditedMutation row is written', async () => {
    const before = await count('system.unauditedMutation');
    const res = await appWith({ ...h.env, ENV: 'production', ACCESS_TEAM_DOMAIN: 'https://t.cloudflareaccess.com', ACCESS_AUD: 'a'.repeat(64) })('/t/unaudited');
    expect(res.status).toBe(303);
    expect(await count('system.unauditedMutation')).toBe(before + 1);
    const row = await h.db.prepare("select entity, entity_id, actor_email from audit_log where action = 'system.unauditedMutation' order by id desc").first<Record<string, string>>();
    expect(row).toEqual({ entity: 'request', entity_id: 'POST /t/unaudited', actor_email: USERS.owner });
  });
  test('noAudit needs a reason', () => {
    expect(() => noAudit({ set() {} } as never, '')).toThrow();
  });
});

describe('audit viewer', () => {
  beforeAll(async () => {
    // Seed a few rows through the real helper so the viewer has data with known shapes.
    const app = asOwner();
    app.post('/t/seed', requireRole('owner'), async (c) => {
      await c.var.db.batch([
        audit(c, { action: 'product.update', entity: 'products', entityId: 41, before: { price_dzd: 14600, name_fr: 'Pack' }, after: { price_dzd: 15600, name_fr: 'Pack' } }),
        audit(c, { action: 'product.update', entity: 'products', entityId: 42, before: { name_fr: '<script>alert(1)</script>' }, after: { name_fr: 'ok' } }),
        audit(c, { action: 'fee.update', entity: 'delivery_fees', entityId: 16, before: { fee_dzd: 400 }, after: { fee_dzd: 500 } }),
      ]);
      return c.text('ok');
    });
    expect((await app.request('/t/seed', form({ _csrf: await tokenFor(h.db, USERS.owner) }), h.env)).status).toBe(200);
  });

  test('owner only', async () => {
    expect((await h.as(USERS.owner, '/audit')).status).toBe(200);
    for (const u of [USERS.confirmer, USERS.logistics, USERS.content]) {
      expect((await h.as(u, '/audit')).status, u).toBe(403);
      expect((await h.as(u, '/audit/1')).status, u).toBe(403);
    }
    expect((await h.as(null, '/audit')).status).toBe(401);
  });
  test('nav shows the audit link to the owner only', async () => {
    expect(await (await h.as(USERS.owner, '/dashboard')).text()).toContain('href="/audit"');
    expect(await (await h.as(USERS.confirmer, '/dashboard')).text()).not.toContain('href="/audit"');
  });
  test('filters: entity, entity id, action prefix, actor, dates', async () => {
    const page = async (q: string) => (await (await h.as(USERS.owner, `/audit${q}`)).text());
    const rows = (html: string) => (html.match(/<tr data-key=/g) ?? []).length;
    expect(rows(await page('?entity=delivery_fees'))).toBe(1);
    expect(rows(await page('?entity=products&entity_id=42'))).toBe(1);
    expect(rows(await page('?action=product.'))).toBe(2);
    const owner = await h.db.prepare('select id from admin_users where email = ?').bind(USERS.owner).first<{ id: number }>();
    const confirmer = await h.db.prepare('select id from admin_users where email = ?').bind(USERS.confirmer).first<{ id: number }>();
    expect(rows(await page(`?actor=${owner!.id}&entity=products`))).toBe(2);
    expect(rows(await page(`?actor=${confirmer!.id}`))).toBe(0);
    expect(rows(await page('?to=2000-01-01'))).toBe(0);
    expect(rows(await page('?from=2000-01-01&entity=products'))).toBe(2);
    // Invalid filters are ignored, never echoed into SQL.
    expect((await h.as(USERS.owner, "/audit?entity=x'%20or%201=1--&actor=abc&from=2026-13-40")).status).toBe(200);
  });
  test('keyset pagination: 50 per page, next cursor, no overlap', async () => {
    const app = asOwner();
    app.post('/t/many', requireRole('owner'), async (c) => {
      await c.var.db.batch(Array.from({ length: 60 }, (_, i) => audit(c, { action: 'bulk.row', entity: 'bulk', entityId: i })) as [ReturnType<typeof audit>]);
      return c.text('ok');
    });
    await app.request('/t/many', form({ _csrf: await tokenFor(h.db, USERS.owner) }), h.env);
    const first = await (await h.as(USERS.owner, '/audit?entity=bulk')).text();
    const keys1 = [...first.matchAll(/<tr data-key="(\d+)"/g)].map((m) => m[1]);
    expect(keys1).toHaveLength(50);
    const next = /href="(\/audit\?[^"]*after=[^"]+)"/.exec(first)?.[1]?.replaceAll('&amp;', '&');
    expect(next).toBeDefined();
    expect(next).toContain('entity=bulk');
    const second = await (await h.as(USERS.owner, next!)).text();
    const keys2 = [...second.matchAll(/<tr data-key="(\d+)"/g)].map((m) => m[1]);
    expect(keys2).toHaveLength(10);
    expect(keys1.filter((k) => keys2.includes(k))).toEqual([]);
  });
  test('detail: field diff, escaped values, 404s', async () => {
    const id = (await h.db.prepare("select id from audit_log where entity = 'products' and entity_id = '42'").first<{ id: number }>())!.id;
    const html = await (await h.as(USERS.owner, `/audit/${id}`)).text();
    expect(html).toContain('name_fr');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('badge--warning');
    expect((await h.as(USERS.owner, '/audit/999999')).status).toBe(404);
    expect((await h.as(USERS.owner, '/audit/abc')).status).toBe(404);
    expect((await h.as(USERS.owner, '/audit/0')).status).toBe(404);
  });
  test('the viewer cannot write: no POST route under /audit', () => {
    expect(h.app.routes.filter((r) => r.path.startsWith('/audit') && r.method !== 'GET' && r.method !== 'ALL')).toEqual([]);
  });
  test('diffRows / parseAuditFilters units', () => {
    expect(diffRows({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 })).toEqual([
      { field: 'a', before: '1', after: '1', changed: false },
      { field: 'b', before: '2', after: '3', changed: true },
      { field: 'c', before: undefined, after: '4', changed: true },
    ]);
    expect(diffRows(null, null)).toEqual([]);
    const { filters } = parseAuditFilters((k) => ({ actor: '7', entity: 'Products', from: '2026-11-05', to: '2026-11-05', action: 'x%' } as Record<string, string>)[k]);
    expect(filters.actor).toBe(7);
    expect(filters.entity).toBeUndefined();
    expect(filters.action).toBeUndefined();
    expect(filters.toExclusive! - filters.from!).toBe(24 * 3600_000);
  });
});

describe('headers on every kind of response', () => {
  test('200, 302, 303, 401, 403, 404, 413, 415, 500', async () => {
    const tok = await tokenFor(h.db, USERS.owner);
    const responses: [string, Response][] = [
      ['200', await h.as(USERS.owner, '/dashboard')],
      ['302', await h.as(USERS.owner, '/')],
      ['303', await postAs(h, USERS.owner, '/settings/language', { lang: 'fr' })],
      ['401', await h.as(null, '/dashboard')],
      ['403', await h.as(USERS.content, '/users')],
      ['404', await h.as(USERS.owner, '/nope')],
      ['413', await h.as(USERS.owner, '/settings/language', { ...form({}), body: `_csrf=${tok}&x=${'a'.repeat(1024 * 1024 + 1)}` })],
      ['415', await h.as(USERS.owner, '/settings/language', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })],
      ['asset', await h.as(USERS.owner, '/assets/admin.css')],
    ];
    const boom = asOwner();
    boom.get('/boom', requireRole('owner'), () => {
      throw new Error('x');
    });
    responses.push(['500', await boom.request('/boom', {}, h.env)]);
    for (const [name, res] of responses) {
      expect(String(res.status), name).toBe(name === 'asset' ? '200' : name);
      expectHeaders(res);
    }
  });
});

describe('errors after a response was produced', () => {
  test('a throw after c.redirect() yields a 500 without the Location header', async () => {
    const app = asOwner();
    app.get('/t/throw-after-redirect', requireRole('owner'), async (c, next) => {
      c.res = c.redirect('/elsewhere');
      await next();
      throw new Error('late failure');
    });
    const res = await app.request('/t/throw-after-redirect', {}, h.env);
    expect(res.status).toBe(500);
    expect(res.headers.get('Location')).toBeNull();
  });
});
