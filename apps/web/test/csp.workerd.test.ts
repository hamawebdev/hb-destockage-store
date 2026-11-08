// WEB-4 end to end: the generated `_headers` as Workers static assets actually apply it (detach +
// replace gives exactly one CSP per page), on asset pages, on the not-found page, and on the
// Worker-first pages (confirmation, no-JS review) that pass assets through. No cookies anywhere.
import { vi } from 'vitest';
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestHarness, type TestHarness } from 'wrangler';
import { generate, scanHtml, sha256 } from '../scripts/csp.ts';
import type { Env } from '../src/env.ts';
import { WEB_ROOT, TEST_SECRETS } from './support/harness.ts';
import { SEED_SQL } from './support/seed.ts';

let dir: string;
let server: TestHarness;
const PAGES: Record<string, string> = {};

function page(lang: string, tpl: string, style: string, body = ''): string {
  return `<!doctype html><html lang="${lang}" data-tpl="${tpl}"><head><meta charset="utf-8"><style>${style}</style><script type="speculationrules">{"prefetch":[]}</script></head><body>${body}<script>void 0</script></body></html>`;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hb-csp-e2e-'));
  const assets = join(dir, 'assets');
  // The order templates from the WEB-3 fixtures, plus pages per template.
  cpSync(join(WEB_ROOT, 'test/fixtures/assets'), assets, { recursive: true });
  const put = (rel: string, html: string) => {
    mkdirSync(join(assets, rel, '..'), { recursive: true });
    writeFileSync(join(assets, rel), html);
    PAGES[rel] = html;
  };
  for (const lang of ['ar', 'fr']) {
    put(`${lang}/index.html`, page(lang, 'home', `.home-${lang}{}`));
    put(`${lang}/p/pack/index.html`, page(lang, 'product', '.product{}', '<form method="post" action="/api/order"></form>'));
    put(`${lang}/order/confirmation/index.html`, page(lang, 'confirmation', '.conf{}', '<p data-hb-when="has-ref" hidden><bdi data-hb="ref"></bdi></p>'));
    put(`${lang}/404.html`, page(lang, '404', `.nf-${lang}{}`));
    put(`${lang}/order/pack/index.html`, page(lang, 'order-step', '.step{}', '<form method="post" action="/api/order"></form>'));
  }
  put('404.html', page('ar', '404', '.nf{}'));
  // Review templates: orderform's real built pages (ORDER-6), so the slot contract and their inline
  // CSS/scripts are exercised for real.
  for (const lang of ['ar', 'fr']) {
    put(`${lang}/order/review/index.html`, readFileSync(join(WEB_ROOT, `test/fixtures/orderform/review-${lang}.html`), 'utf8'));
  }
  put('_astro/app.AbC123.js', 'export {}');
  generate(assets);

  const config = {
    name: 'hb-web-csp-test',
    main: join(WEB_ROOT, 'src/index.ts'),
    compatibility_date: '2026-11-01',
    assets: {
      directory: './assets',
      binding: 'ASSETS',
      not_found_handling: '404-page',
      html_handling: 'auto-trailing-slash',
      run_worker_first: ['/api/*', '/ar/order/confirmation/*', '/fr/order/confirmation/*'],
    },
    d1_databases: [{ binding: 'DB', database_name: 'hb-destockage', database_id: '00000000-0000-4000-8000-000000000d1b', migrations_dir: join(WEB_ROOT, '../../packages/db/migrations') }],
    queues: { producers: [{ binding: 'ORDERS', queue: 'hb-order-notifications' }] },
    ratelimits: [
      { name: 'ORDER_RL_PHONE', namespace_id: '1001', simple: { limit: 5, period: 60 } },
      { name: 'ORDER_RL_IP', namespace_id: '1002', simple: { limit: 30, period: 60 } },
      { name: 'RUM_RL_IP', namespace_id: '1003', simple: { limit: 60, period: 60 } },
    ],
    vars: { ENV: 'test', SITE_HOSTS: 'localhost', MIN_FILL_MS: '2500', MIN_REVIEW_MS: '1500', RUM_SAMPLE: '1' },
  };
  writeFileSync(join(dir, 'wrangler.json'), JSON.stringify(config));
  server = createTestHarness({ root: dir, workers: [{ configPath: './wrangler.json', secrets: TEST_SECRETS }] });
  await server.listen();
  const worker = server.getWorker<Env>();
  await worker.applyD1Migrations('DB');
  const env = await worker.getEnv();
  await env.DB.batch(SEED_SQL.map((s) => env.DB.prepare(s)));
});

afterAll(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

function oneCsp(res: { headers: { get(name: string): string | null } }): string {
  const v = res.headers.get('content-security-policy');
  expect(v, 'CSP present').not.toBeNull();
  // Two CSP headers would be joined with ", " and both enforced: there must be exactly one policy.
  expect(v!.split("default-src 'none'").length - 1, `one policy: ${v}`).toBe(1);
  return v!;
}

function covers(csp: string, html: string, path: string): void {
  const s = scanHtml(html, path);
  for (const h of s.scriptHashes) expect(csp, `${path} script`).toContain(h);
  for (const h of s.styleHashes) expect(csp, `${path} style`).toContain(h);
  expect(csp).not.toMatch(/unsafe-inline|nonce-/);
}

describe('static assets with the generated _headers', () => {
  test.each([
    ['/ar/', 'ar/index.html'],
    ['/fr/', 'fr/index.html'],
    ['/fr/p/pack/', 'fr/p/pack/index.html'],
  ])('%s: exactly one CSP covering its inline code; security headers; no cookie', async (path, rel) => {
    const res = await server.fetch(path);
    expect(res.status).toBe(200);
    covers(oneCsp(res), PAGES[rel]!, path);
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(res.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('home policy does not carry the product page hashes nor Turnstile; product does', async () => {
    const home = oneCsp(await server.fetch('/ar/'));
    expect(home).not.toContain(sha256('.product{}'));
    expect(home).not.toContain('challenges.cloudflare.com');
    expect(oneCsp(await server.fetch('/ar/p/pack/'))).toContain('frame-src https://challenges.cloudflare.com');
  });

  test('unknown URL → 404 page with the not-found policy', async () => {
    const res = await server.fetch('/ar/nothing-here/');
    expect(res.status).toBe(404);
    const csp = oneCsp(res);
    expect(csp).toContain(sha256('.nf-ar{}'));
  });

  test('order step: No-Vary-Search params=("v"), also for ?v=; never on confirmation or the no-JS review', async () => {
    for (const lang of ['ar', 'fr']) {
      const step = await server.fetch(`/${lang}/order/pack/`);
      expect(step.status).toBe(200);
      expect(step.headers.get('no-vary-search')).toBe('params=("v")');
      oneCsp(step);
      expect((await server.fetch(`/${lang}/order/pack/?v=21`)).headers.get('no-vary-search')).toBe('params=("v")');
      expect((await server.fetch(`/${lang}/order/confirmation/?ref=HB-7K2Q9`)).headers.get('no-vary-search')).toBeNull();
      expect((await server.fetch(`/${lang}/p/pack/`)).headers.get('no-vary-search')).toBeNull();
    }
    const review = await server.fetch('/api/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ lang: 'fr', variantId: '11', qty: '1', name: 'Amine', phone: '0555123456', wilayaCode: '16' }).toString(),
    });
    expect(review.headers.get('no-vary-search')).toBeNull();
  });

  test('hashed assets are immutable (one Cache-Control value)', async () => {
    const res = await server.fetch('/_astro/app.AbC123.js');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });
});

describe('Worker-first pages keep the page policy', () => {
  test('confirmation (HTMLRewriter over ASSETS) carries its own CSP and no-store', async () => {
    const res = await server.fetch('/fr/order/confirmation/?ref=HB-7K2Q9');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<bdi data-hb="ref">HB-7K2Q9</bdi>');
    covers(oneCsp(res), PAGES['fr/order/confirmation/index.html']!, '/fr/order/confirmation/');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('strict-transport-security')).toBe('max-age=31536000; includeSubDomains');
  });

  test('no-JS review page (POST /api/order) carries the review template policy, not the API one', async () => {
    const res = await server.fetch('/api/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ lang: 'ar', variantId: '11', qty: '1', name: 'أمين', phone: '0555123456', wilayaCode: '16' }).toString(),
    });
    expect(res.status).toBe(200);
    const csp = oneCsp(res);
    covers(csp, PAGES['ar/order/review/index.html']!, '/ar/order/review/');
    expect(csp).toContain("form-action 'self'");
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test("orderform's real review template: slots filled, both can-confirm blocks shown, nothing else changed", async () => {
    const res = await server.fetch('/api/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ lang: 'fr', variantId: '11', qty: '2', name: 'Amine', phone: '0555123456', wilayaCode: '16' }).toString(),
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<span class="of-line-name">Pack cuisine</span>');
    expect(html.match(/data-hb-when="can-confirm"(?![^>]*hidden)/g)).toHaveLength(2);
    expect(html).toMatch(/data-hb-when="has-errors"[^>]*hidden/);
    expect(html).toContain('<option value="1601">');
    expect(html).toMatch(/<input type="hidden" name="idempotencyKey" value="[0-9a-f-]{36}">/);
    expect(html).toMatch(/data-hb="name"[^>]*value="Amine"|value="Amine"[^>]*data-hb="name"/);
  });

  test("orderform's real review template: an invalid phone un-hides every matching message and marks the field", async () => {
    const res = await server.fetch('/api/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ lang: 'ar', variantId: '11', qty: '1', name: 'أمين', phone: '0512345678', wilayaCode: '16' }).toString(),
    });
    expect(res.status).toBe(422);
    const html = await res.text();
    const tags = html.match(/<[^>]*data-hb-error="phone_not_mobile"[^>]*>/g) ?? [];
    expect(tags).toHaveLength(2);
    for (const t of tags) expect(t).not.toMatch(/\shidden/);
    expect(html.match(/<[^>]*data-hb-error="phone_invalid"[^>]*>/g)!.every((t) => /\shidden/.test(t))).toBe(true);
    expect(html).toMatch(/<[^>]*data-hb-field="phone"[^>]*aria-invalid="true"/);
    expect(html.match(/data-hb-when="can-confirm"[^>]*hidden/g)).toHaveLength(2);
  });

  test('API JSON keeps the strict API policy', async () => {
    const res = await server.fetch('/api/health');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
