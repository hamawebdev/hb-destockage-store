// Regression tests for rev-f's ADMIN-1 review r1, fixed as classes (lead, 2026-11-05):
//   F1  deny-by-default holds inside every createRouter router;
//   F2  money input is integer DZD only, never decimals, with a clear error;
//   F3  every control's accessible name contains its visible label (WCAG 2.5.3);
// plus the r2 nit (vOptionalMoneyDzd).
import type { Hono } from 'hono';
import * as v from 'valibot';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createApp } from '../src/app.ts';
import type { AppEnv } from '../src/env.ts';
import { requirePerm } from '../src/auth/require-role.ts';
import { normaliseDzd, validateForm, vMoneyDzd, vOptionalMoneyDzd } from '../src/lib/forms.ts';
import { createRouter } from '../src/lib/router.ts';
import { translator } from '../src/i18n/index.ts';
import dashboard from '../src/routes/dashboard/index.tsx';
import users from '../src/routes/users/index.tsx';
import settings from '../src/routes/settings/index.tsx';
import orders from '../src/routes/orders/index.tsx';
import customers from '../src/routes/customers/index.tsx';
import products from '../src/routes/products/index.tsx';
import categories from '../src/routes/categories/index.tsx';
import fees from '../src/routes/fees/index.tsx';
import content from '../src/routes/content/index.tsx';
import media from '../src/routes/media/index.tsx';
import publish from '../src/routes/publish/index.tsx';
import auditRoutes from '../src/audit/routes.tsx';
import parcels from '../src/routes/parcels/index.tsx';
import { form, harness, postAs, testIdentify, tokenFor, USERS, type Harness } from './helpers.ts';

// Real D1 (workerd) requests take seconds on the loaded shared machine: explicit budgets instead
// of vitest's 5 s default, so the admin gate is not red at random (lead, 2026-11-06).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

let h: Harness;
beforeAll(async () => {
  h = await harness();
}, 120_000);
afterAll(async () => {
  await h?.close();
});

describe('F1: deny-by-default inside every mounted router', () => {
  // Every router app.ts mounts, with its mount point. A probe route WITHOUT requirePerm is added
  // to each real router object before the app is built (app.route copies routes at mount time).
  // Two segments, so no existing `/:id` route can answer first.
  const MOUNTED: [string, Hono<AppEnv>][] = [
    ['/dashboard', dashboard],
    ['/users', users],
    ['/settings', settings],
    ['/orders', orders],
    ['/customers', customers],
    ['/products', products],
    ['/categories', categories],
    ['/fees', fees],
    ['/content', content],
    ['/media', media],
    ['/publish', publish],
    ['/audit', auditRoutes],
    ['/parcels', parcels],
  ];
  let app: Hono<AppEnv>;
  beforeAll(() => {
    for (const [, r] of MOUNTED) {
      r.get('/__probe/no-role-check', (c) => c.text('READ RAN'));
      r.post('/__probe/no-role-check', (c) => c.text('MUTATION RAN'));
    }
    app = createApp({ identify: testIdentify });
  });

  test('the list covers every mount point registered in app.ts', () => {
    const real = createApp({ identify: testIdentify });
    const mounts = new Set(
      real.routes
        .filter((r) => r.method !== 'ALL')
        .map((r) => '/' + (r.path.split('/')[1] ?? ''))
        .filter((p) => p !== '/' && p !== '/assets' && p !== '/__dev'),
    );
    expect([...mounts].sort()).toEqual(MOUNTED.map(([p]) => p).sort());
  });

  for (const [prefix] of MOUNTED) {
    test(`${prefix}: a route with no role check answers 500 to every role allowed into the router`, async () => {
      const tokOwner = await tokenFor(h.db, USERS.owner);
      for (const email of [USERS.owner, USERS.confirmer, USERS.logistics, USERS.content]) {
        const get = await app.request(`${prefix}/__probe/no-role-check`, { headers: { 'x-test-user': email } }, h.env);
        expect([403, 500], `${email} GET`).toContain(get.status);
        expect(await get.text()).not.toContain('READ RAN');
        const tok = email === USERS.owner ? tokOwner : await tokenFor(h.db, email);
        const post = await app.request(`${prefix}/__probe/no-role-check`, { ...form({ _csrf: tok }), headers: { ...(form({}).headers as Record<string, string>), 'x-test-user': email } }, h.env);
        expect([403, 500], `${email} POST`).toContain(post.status);
        expect(await post.text()).not.toContain('MUTATION RAN');
      }
      // The owner passes every floor, so the owner proves the net itself fires (500, not 403).
      expect((await app.request(`${prefix}/__probe/no-role-check`, { headers: { 'x-test-user': USERS.owner } }, h.env)).status).toBe(500);
    });
  }

  test('a fresh createRouter router behaves the same; its floor still answers 403 outside its roles', async () => {
    const a = createApp({ identify: testIdentify });
    const r = createRouter({ roles: ['owner', 'confirmer', 'logistics'] });
    r.get('/ok', requirePerm('orders.view'), (c) => c.text('ok'));
    r.post('/forgot', (c) => c.text('mutated'));
    a.route('/t', r);
    expect((await a.request('/t/ok', { headers: { 'x-test-user': USERS.content } }, h.env)).status).toBe(403);
    expect((await a.request('/t/ok', { headers: { 'x-test-user': USERS.logistics } }, h.env)).status).toBe(200);
    const res = await a.request('/t/forgot', { ...form({ _csrf: await tokenFor(h.db, USERS.confirmer) }), headers: { ...(form({}).headers as Record<string, string>), 'x-test-user': USERS.confirmer } }, h.env);
    expect(res.status).toBe(500);
  });
});

describe('F2: money input is integer DZD only', () => {
  const accepted: [string, string, number][] = [
    ['plain digits', '14600', 14600],
    ['zero', '0', 0],
    ['spaces around', '  14600 ', 14600],
    ['space thousands', '14 600', 14600],
    ['space thousands (millions)', '1 234 567', 1234567],
    ['NBSP thousands (as fr-DZ formats)', '14 600', 14600],
    ['narrow NBSP thousands', '14 600', 14600],
    ['thin space thousands', '14 600', 14600],
    ['dot thousands', '14.600', 14600],
    ['dot thousands (millions)', '1.234.567', 1234567],
    ['Eastern-Arabic digits', '١٤٦٠٠', 14600],
    ['Persian digits', '۱۶۵۰۰', 16500],
    ['Arabic thousands separator', '١٤٬٦٠٠', 14600],
    ['Eastern-Arabic digits with dot grouping', '١٤.٦٠٠', 14600],
    ['dot grouping 1.500', '1.500', 1500],
    ['zero centimes with comma', '600,00', 600],
    ['zero centimes with dot', '1500.00', 1500],
    ['grouped + zero centimes', '14.600,00', 14600],
    ['space-grouped + zero centimes', '14 600.00', 14600],
    ['Arabic decimal separator + zero centimes (Arabic digits)', '١٥٠٠٫٠٠', 1500],
    ['Arabic decimal separator + zero centimes (Latin digits)', '1500٫00', 1500],
    ['Arabic grouping + Arabic zero centimes', '١٤٬٦٠٠٫٠٠', 14600],
  ];
  for (const [name, input, out] of accepted) {
    test(`accepts ${name}: ${JSON.stringify(input)} → ${out}`, () => {
      expect(v.parse(vMoneyDzd(), input)).toBe(out);
    });
  }
  const rejected: [string, string][] = [
    ['one decimal (would read as 15)', '1.5'],
    ['two-digit tail', '14.60'],
    ['non-zero centimes', '1500.50'],
    ['non-zero centimes, comma', '600,50'],
    ['one zero centime', '1500.0'],
    ['grouping and centimes with the same separator', '14.600.00'],
    ['single-digit decimal', '1500.5'],
    ['comma decimal', '1,5'],
    ['leading decimal', '0.5'],
    ['two-digit group', '1.50'],
    ['comma thousands (ambiguous in French)', '1,500'],
    ['apostrophe thousands', '14’600'],
    ['Arabic decimal separator with non-zero centimes', '١٥٠٠٫٥٠'],
    ['Arabic decimal separator, one digit', '1500٫5'],
    ['Arabic decimal separator, one zero', '1500٫0'],
    ['short last group', '14 60'],
    ['long group', '1.2345'],
    ['mixed separators', '1.234 567'],
    ['currency suffix', '14 600 DA'],
    ['negative', '-5'],
    ['letters', '12a'],
    ['separator first', '.500'],
    ['double separator', '1..500'],
    ['empty', ''],
  ];
  for (const [name, input] of rejected) {
    test(`rejects ${name}: ${JSON.stringify(input)}`, () => {
      expect(v.safeParse(vMoneyDzd(), input).success).toBe(false);
      expect(normaliseDzd(input) === null || input === '').toBe(true);
    });
  }
  test('lead spec 2026-11-05: every listed case', () => {
    const parse = (x: string) => {
      const r = v.safeParse(vMoneyDzd(), x);
      return r.success ? r.output : 'error';
    };
    expect(parse('1.5')).toBe('error');
    expect(parse('1,5')).toBe('error');
    expect(parse('1.500')).toBe(1500);
    expect(parse('600,00')).toBe(600);
    expect(parse('14.600')).toBe(14600);
    expect(parse('14 600')).toBe(14600);
    expect(parse('1.000.000')).toBe(1000000);
    expect(parse('14.60')).toBe('error');
    expect(parse('١٤.٦٠٠')).toBe(14600);
  });
  test('the error explains the rule in both languages (form.moneyInteger)', async () => {
    const app = createApp({ identify: testIdentify });
    let fr = '';
    let ar = '';
    app.get('/t/money', requirePerm('dashboard.view'), (c) => {
      const r = validateForm(c, v.object({ price: vMoneyDzd() }), { price: c.req.query('p') ?? '' });
      const msg = r.ok ? '' : (r.errors['price'] ?? '');
      if (c.var.lang === 'fr') fr = msg;
      else ar = msg;
      return c.text(msg);
    });
    await app.request('/t/money?p=1.5', { headers: { 'x-test-user': USERS.owner } }, h.env);
    await app.request('/t/money?p=1%2C5', { headers: { 'x-test-user': USERS.ownerAr } }, h.env);
    expect(fr).toBe(translator('fr')('form.moneyInteger'));
    expect(fr).toContain('sans centimes');
    expect(ar).toBe(translator('ar')('form.moneyInteger'));
    // Empty stays "required", not "integer".
    let empty = '';
    const app2 = createApp({ identify: testIdentify });
    app2.get('/t/empty', requirePerm('dashboard.view'), (c) => {
      const r = validateForm(c, v.object({ price: vMoneyDzd() }), {});
      empty = r.ok ? '' : (r.errors['price'] ?? '');
      return c.text(empty);
    });
    await app2.request('/t/empty', { headers: { 'x-test-user': USERS.owner } }, h.env);
    expect(empty).toBe(translator('fr')('form.required'));
  });
  test('r2 nit: vOptionalMoneyDzd — absent/empty/spaces → null, values parsed, decimals rejected', () => {
    const S = v.strictObject({ compare: vOptionalMoneyDzd() });
    expect(v.parse(S, {})).toEqual({ compare: null });
    expect(v.parse(S, { compare: '' })).toEqual({ compare: null });
    expect(v.parse(S, { compare: '  ' })).toEqual({ compare: null });
    expect(v.parse(S, { compare: '16.500' })).toEqual({ compare: 16500 });
    expect(v.parse(S, { compare: '600,00' })).toEqual({ compare: 600 });
    const bad = v.safeParse(S, { compare: '1.5' });
    expect(bad.success).toBe(false);
    expect(bad.issues?.[0]?.message).toBe('form.moneyInteger');
  });
});

describe('F3: every control’s accessible name contains its visible label (WCAG 2.5.3)', () => {
  const CONTROL = /<(a|button|summary|input|select|textarea)\b([^>]*)>/gi;
  function controlsWithAriaLabel(html: string): string[] {
    return [...html.matchAll(CONTROL)].filter((m) => /\saria-label(ledby)?=/i.test(m[2] ?? '')).map((m) => m[0]);
  }
  const pages = ['/dashboard', '/orders', '/customers', '/products', '/categories', '/fees', '/content', '/media', '/publish', '/users', '/settings', '/audit', '/audit?entity=x'];
  for (const email of [USERS.owner, USERS.ownerAr]) {
    test(`no control overrides its visible label with aria-label/labelledby (${email})`, async () => {
      for (const p of pages) {
        const html = await (await h.as(email, p)).text();
        expect(controlsWithAriaLabel(html), `${email} ${p}`).toEqual([]);
      }
    });
  }
  test('error and dev-login pages too', async () => {
    const env = { ...h.env, ENV: 'development' as const, DEV_SESSION_SECRET: 'dev-secret-for-tests-0123456789abcdef0123' };
    const app = createApp({ identify: testIdentify });
    for (const [url, e] of [
      ['http://localhost/__dev/login', env],
      ['http://localhost/nope', h.env],
    ] as const) {
      const html = await (await app.request(url, { headers: { 'x-test-user': USERS.owner } }, e)).text();
      expect(controlsWithAriaLabel(html), url).toEqual([]);
    }
    expect(controlsWithAriaLabel(await (await h.as(null, '/dashboard')).text())).toEqual([]);
  });
  test('every input/select/textarea has a <label for> (form kit)', async () => {
    const html = await (await h.as(USERS.owner, '/audit')).text();
    const ids = [...html.matchAll(/<(?:input|select|textarea)\b(?![^>]*type="(?:hidden|submit)")[^>]*\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(html, id).toContain(`for="${id}"`);
  });
  test('language toggle: visible native word with its lang, hidden explanation, returns to the page', async () => {
    for (const [email, word, wordLang] of [
      [USERS.owner, 'العربية', 'ar'],
      [USERS.ownerAr, 'Français', 'fr'],
    ] as const) {
      const html = await (await h.as(email, '/orders')).text();
      const f = /<form method="post" action="\/settings\/language"[\s\S]*?<\/form>/.exec(html)?.[0] ?? '';
      expect(f).not.toMatch(/aria-label/);
      expect(f).toContain(`<span lang="${wordLang}">${word}</span>`);
      expect(f).toContain('class="visually-hidden"');
      expect(f).toContain('name="return_to" value="/orders"');
      expect(f).not.toMatch(/<button[^>]*\slang=/); // lang only on the word, not the whole name
    }
    const res = await postAs(h, USERS.owner, '/settings/language', { lang: 'fr', return_to: '/orders' });
    expect(res.headers.get('Location')).toBe('/orders');
  });
});
