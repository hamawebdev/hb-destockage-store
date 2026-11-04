import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { app as prodApp } from '../src/index.ts';
import { createApp } from '../src/app.ts';
import { PERMISSIONS, roleCan, type Permission } from '../src/auth/permissions.ts';
import { requireRole } from '../src/auth/require-role.ts';
import type { Role } from '../src/env.ts';
import { CSP_HTML, CSP_OTHER } from '../src/lib/headers.ts';
import { csrfFrom, form, harness, testEnv, USERS, type Harness } from './helpers.ts';

let h: Harness;
beforeAll(async () => {
  h = await harness();
}, 120_000);
afterAll(async () => {
  await h?.close();
});

const ROLE_USERS: Record<Role, string> = {
  owner: USERS.owner,
  confirmer: USERS.confirmer,
  logistics: USERS.logistics,
  content: USERS.content,
};

/** Mount point → permission of its GET page (must match routes/*). */
const PAGES: Record<string, Permission> = {
  '/dashboard': 'dashboard.view',
  '/orders': 'orders.view',
  '/customers': 'customers.view',
  '/products': 'catalog.view',
  '/categories': 'catalog.view',
  '/fees': 'fees.view',
  '/content': 'content.edit',
  '/media': 'media.edit',
  '/publish': 'publish.run',
  '/users': 'users.manage',
  '/settings': 'settings.edit',
};

function expectSecurityHeaders(res: Response) {
  expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  expect(res.headers.get('Referrer-Policy')).toBe('same-origin');
  expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
}

describe('default app (index.ts) without credentials', () => {
  const env = testEnv({} as D1Database);
  test('no credentials → 401, with security headers, no app chrome', async () => {
    const res = await prodApp.request('/', {}, env);
    expect(res.status).toBe(401);
    expectSecurityHeaders(res);
    expect(await res.text()).not.toContain('nav__link');
  });
  test('a malformed Access header → 403', async () => {
    const res = await prodApp.request('/orders', { headers: { 'Cf-Access-Jwt-Assertion': 'x.y.z' } }, env);
    expect(res.status).toBe(403);
  });
  test('every registered route refuses without auth', async () => {
    expect(prodApp.routes.some((r) => r.path === '/dashboard')).toBe(true);
    const paths = [...new Set(prodApp.routes.map((r) => r.path.replace(/:\w+/g, '1').replace(/\*/g, 'x')))];
    expect(paths.length).toBeGreaterThan(10);
    for (const p of paths) {
      for (const method of ['GET', 'POST']) {
        const res = await prodApp.request(p, { method }, env);
        // /__dev/* does not exist outside local development (404); see auth.test.ts.
        expect(res.status, `${method} ${p}`).toBe(p.startsWith('/__dev') ? 404 : 401);
      }
    }
  });
  test('misconfigured production env → 500 for every request', async () => {
    const res = await prodApp.request('/', {}, testEnv({} as D1Database, { ENV: 'production', ACCESS_AUD: '[PLACEHOLDER]' }));
    expect(res.status).toBe(500);
    expectSecurityHeaders(res);
  });
});

describe('root', () => {
  test('/ redirects to /dashboard for every role, refuses without auth', async () => {
    for (const email of [USERS.owner, USERS.content]) {
      const res = await h.as(email, '/');
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/dashboard');
    }
    expect((await h.as(null, '/')).status).toBe(401);
  });
});

describe('authentication → admin_users', () => {
  test('unknown email → 403', async () => {
    expect((await h.as('nobody@test.local', '/')).status).toBe(403);
  });
  test('inactive user → 403', async () => {
    expect((await h.as(USERS.inactive, '/')).status).toBe(403);
  });
  test('email is matched after trim + lowercase', async () => {
    expect((await h.as(' Owner@Test.Local ', '/dashboard')).status).toBe(200);
  });
});

describe('role matrix on every mounted page', () => {
  for (const [path, perm] of Object.entries(PAGES)) {
    for (const role of Object.keys(ROLE_USERS) as Role[]) {
      const allowed = roleCan(role, perm);
      test(`${role} GET ${path} → ${allowed ? 200 : 403}`, async () => {
        const res = await h.as(ROLE_USERS[role], path);
        expect(res.status).toBe(allowed ? 200 : 403);
        expectSecurityHeaders(res);
      });
    }
  }
  test('approved matrix decisions (ADMIN-0 §0)', () => {
    expect(PERMISSIONS['fees.edit']).toEqual(['owner']);
    expect([...PERMISSIONS['catalog.view']].sort()).toEqual(['confirmer', 'content', 'logistics', 'owner']);
    expect(PERMISSIONS['catalog.edit']).toEqual(['owner', 'content']);
    expect(PERMISSIONS['publish.abandon']).toEqual(['owner']);
    for (const p of ['customers.view', 'orders.view'] as const) expect(PERMISSIONS[p]).not.toContain('content');
    for (const [perm, roles] of Object.entries(PERMISSIONS)) expect(roles, perm).toContain('owner');
  });
});

describe('layout', () => {
  test('French user: lang=fr dir=ltr, nav filtered by role, CSRF token, email in <bdi>', async () => {
    const html = await (await h.as(USERS.confirmer, '/dashboard')).text();
    expect(html).toContain('<html lang="fr" dir="ltr">');
    expect(html).toContain('href="/orders"');
    expect(html).toContain('href="/products"');
    expect(html).not.toContain('href="/users"');
    expect(html).not.toContain('href="/audit"');
    expect(csrfFrom(html)).toMatch(/^\d{13}\./);
    expect(html).toContain('<bdi dir="ltr">confirmer@test.local</bdi>');
  });
  test('Arabic user: lang=ar dir=rtl and Arabic chrome', async () => {
    const html = await (await h.as(USERS.ownerAr, '/dashboard')).text();
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).toContain('لوحة التحكم');
  });
  test('no inline script, inline style or event-handler attributes on any page', async () => {
    for (const p of Object.keys(PAGES)) {
      const html = await (await h.as(USERS.owner, p)).text();
      expect(html, p).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
      expect(html, p).not.toMatch(/\sstyle=/i);
      expect(html, p).not.toMatch(/\son[a-z]+=/i);
      expect(html, p).not.toContain('<style');
    }
  });
  test('flash only renders whitelisted codes', async () => {
    expect(await (await h.as(USERS.owner, '/dashboard?m=saved')).text()).toContain('flash--success');
    const bad = await (await h.as(USERS.owner, '/dashboard?m=%3Cscript%3E')).text();
    expect(bad).not.toContain('flash--');
    expect(bad).not.toContain('<script>');
  });
});

describe('static assets (behind auth)', () => {
  test('tokens.css from @hb/ui-tokens, sandboxed CSP', async () => {
    const res = await h.as(USERS.content, '/assets/tokens.css');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/css');
    expect(await res.text()).toContain('--color-accent');
    expect(res.headers.get('Content-Security-Policy')).toBe(CSP_OTHER);
  });
  test('ASSETS files: no-store, no ETag, sandboxed', async () => {
    const res = await h.as(USERS.content, '/assets/admin.css');
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
    expect(res.headers.get('ETag')).toBeNull();
    expect(res.headers.get('Content-Security-Policy')).toBe(CSP_OTHER);
  });
  test('assets refuse without auth', async () => {
    expect((await h.as(null, '/assets/admin.css')).status).toBe(401);
  });
  test('HTML pages get the strict CSP', async () => {
    expect((await h.as(USERS.owner, '/dashboard')).headers.get('Content-Security-Policy')).toBe(CSP_HTML);
  });
});

describe('deny by default', () => {
  test('a route without requireRole answers 500 and leaks nothing', async () => {
    const app = createApp({ identify: async () => ({ ok: true, email: USERS.owner }) });
    app.get('/unguarded', (c) => c.text('secret'));
    app.get('/guarded', requireRole('owner'), (c) => c.text('ok'));
    const bad = await app.request('/unguarded', {}, h.env);
    expect(bad.status).toBe(500);
    expect(await bad.text()).not.toContain('secret');
    expect((await app.request('/guarded', {}, h.env)).status).toBe(200);
  });
  test('a redirect without requireRole loses its Location', async () => {
    const app = createApp({ identify: async () => ({ ok: true, email: USERS.owner }) });
    app.get('/r', (c) => c.redirect('/elsewhere'));
    const res = await app.request('/r', {}, h.env);
    expect(res.status).toBe(500);
    expect(res.headers.get('Location')).toBeNull();
  });
  test('errors render a generic 500 without internals', async () => {
    const app = createApp({ identify: async () => ({ ok: true, email: USERS.owner }) });
    app.get('/boom', requireRole('owner'), () => {
      throw new Error('SQLITE_CONSTRAINT secret detail');
    });
    const res = await app.request('/boom', {}, h.env);
    expect(res.status).toBe(500);
    expectSecurityHeaders(res);
    expect(await res.text()).not.toContain('SQLITE');
  });
  test('404 for unknown paths (after auth)', async () => {
    const res = await h.as(USERS.owner, '/nope');
    expect(res.status).toBe(404);
    expectSecurityHeaders(res);
  });
});

describe('body limit', () => {
  test('> 1 MiB POST → 413', async () => {
    const body = 'x='.concat('a'.repeat(1024 * 1024 + 10));
    const res = await h.as(USERS.owner, '/settings/language', { ...form({}), body });
    expect(res.status).toBe(413);
  });
});

describe('language toggle (audited mutation)', () => {
  test('switches ui_lang, writes one audit row, redirects to a same-site path', async () => {
    const page = await (await h.as(USERS.logistics, '/orders')).text();
    expect(page).toContain('action="/settings/language"');
    const res = await h.as(USERS.logistics, '/settings/language', form({ lang: 'ar', return_to: '/orders', _csrf: csrfFrom(page) }));
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/orders');
    const row = await h.db.prepare('select ui_lang from admin_users where email = ?').bind(USERS.logistics).first<{ ui_lang: string }>();
    expect(row?.ui_lang).toBe('ar');
    const audit = await h.db
      .prepare("select actor_type, actor_email, action, entity, entity_id, before, after, request_id from audit_log where action = 'adminUser.setLanguage'")
      .all<Record<string, string>>();
    expect(audit.results).toHaveLength(1);
    const a = audit.results[0]!;
    expect(a).toMatchObject({ actor_type: 'admin', actor_email: USERS.logistics, entity: 'admin_users' });
    expect(JSON.parse(a.before!)).toEqual({ uiLang: 'fr' });
    expect(JSON.parse(a.after!)).toEqual({ uiLang: 'ar' });
    expect(a.request_id).toBeTruthy();
    const html = await (await h.as(USERS.logistics, '/orders')).text();
    expect(html).toContain('<html lang="ar" dir="rtl">');
  });
  test('open redirect is neutralised', async () => {
    for (const evil of ['//evil.example', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)']) {
      const res = await h.as(USERS.content, '/settings/language', form({ lang: 'fr', return_to: evil }));
      expect(res.headers.get('Location'), evil).toBe('/');
    }
  });
  test('invalid language is refused', async () => {
    expect((await h.as(USERS.content, '/settings/language', form({ lang: 'en' }))).status).toBe(403);
  });
});

describe('audit() contract', () => {
  async function auditRows(action: string) {
    return (await h.db.prepare('select entity_id, before, after, actor_email from audit_log where action = ?').bind(action).all<Record<string, string | null>>()).results;
  }
  test('when-guard false writes nothing; true writes one row; SQL entityId resolves in the batch', async () => {
    const { sql } = await import('drizzle-orm');
    const { audit } = await import('../src/audit/audit.ts');
    const app = createApp({ identify: async () => ({ ok: true, email: USERS.owner }) });
    app.post('/t/guard/:ok', requireRole('owner'), async (c) => {
      const ok = c.req.param('ok') === '1';
      await c.var.db.batch([audit(c, { action: 'test.guarded', entity: 'admin_users', entityId: 1, after: { ok } }, { when: ok ? sql`1` : sql`0` })]);
      return c.text('done');
    });
    app.post('/t/expr', requireRole('owner'), async (c) => {
      await c.var.db.batch([
        audit(c, { action: 'test.expr', entity: 'admin_users', entityId: sql`(select id from admin_users where email = ${USERS.content})` }),
      ]);
      return c.text('done');
    });
    expect((await app.request('/t/guard/0', { method: 'POST' }, h.env)).status).toBe(200);
    expect(await auditRows('test.guarded')).toHaveLength(0);
    expect((await app.request('/t/guard/1', { method: 'POST' }, h.env)).status).toBe(200);
    expect(await auditRows('test.guarded')).toEqual([{ entity_id: '1', before: null, after: '{"ok":true}', actor_email: USERS.owner }]);
    expect((await app.request('/t/expr', { method: 'POST' }, h.env)).status).toBe(200);
    const contentId = await h.db.prepare('select id from admin_users where email = ?').bind(USERS.content).first<{ id: number }>();
    expect((await auditRows('test.expr'))[0]?.entity_id).toBe(String(contentId?.id));
  });
  test('bad action / entity names are rejected before writing', async () => {
    const { audit } = await import('../src/audit/audit.ts');
    const app = createApp({ identify: async () => ({ ok: true, email: USERS.owner }) });
    app.post('/t/bad', requireRole('owner'), async (c) => {
      audit(c, { action: 'Drop Table', entity: 'x;--', entityId: null });
      return c.text('unreachable');
    });
    expect((await app.request('/t/bad', { method: 'POST' }, h.env)).status).toBe(500);
  });
});
