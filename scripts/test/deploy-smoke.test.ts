import { describe, expect, it } from 'vitest';
import { checkAdmin, checkOrderRefusal, checkQuote, checkStorefront, runSmoke, runSmokeOnce, sellableVariant, type Fetcher, type SmokeSnapshot } from '../deploy/smoke.ts';

const snapshot: SmokeSnapshot = {
  products: [
    { status: 'draft', slug: { ar: 'مسودة', fr: 'brouillon' }, variants: [{ id: 1, priceDzd: 100, stock: 5, active: true }] },
    { status: 'active', slug: { ar: 'طقم', fr: 'pack-luxe' }, variants: [{ id: 2, priceDzd: 0, stock: 5, active: true }, { id: 3, priceDzd: 14600, stock: null, active: true }] },
  ],
};
const page = (lang: string, dir: string, href: string): string => `<!doctype html><html lang="${lang}" dir="${dir}"><body><a href="${href}">x</a></body></html>`;
const targets = { siteOrigin: 'https://shop.test', adminOrigin: 'https://admin.shop.test' };

describe('checkStorefront', () => {
  it('passes a good page', () => expect(checkStorefront('fr', 200, page('fr', 'ltr', '/fr/p/pack-luxe/'), snapshot)).toEqual([]));
  it('needs 200', () => expect(checkStorefront('fr', 503, page('fr', 'ltr', '/fr/p/pack-luxe/'), snapshot)).toHaveLength(1));
  it('needs the right dir', () => expect(checkStorefront('ar', 200, page('ar', 'ltr', '/ar/p/طقم/'), snapshot).join()).toMatch(/dir/));
  it('needs the right lang', () => expect(checkStorefront('ar', 200, page('fr', 'rtl', '/ar/p/طقم/'), snapshot).join()).toMatch(/lang/));
  it('ignores links to drafts', () => expect(checkStorefront('fr', 200, page('fr', 'ltr', '/fr/p/brouillon/'), snapshot).join()).toMatch(/product/));
});

it('picks a variant that is on sale', () => expect(sellableVariant(snapshot)).toBe(3));

describe('checkQuote', () => {
  const good = { ok: true, available: true, lines: [{ lineTotalDzd: 14600 }], subtotalDzd: 14600, feeDzd: 400, totalDzd: 15000 };
  it('passes sane totals', () => expect(checkQuote(200, good)).toEqual([]));
  it('fails a wrong total', () => expect(checkQuote(200, { ...good, totalDzd: 1 })).toHaveLength(1));
  it('fails a wrong subtotal', () => expect(checkQuote(200, { ...good, subtotalDzd: 14000, totalDzd: 14400 })).toHaveLength(1));
  it('fails fractional amounts', () => expect(checkQuote(200, { ...good, feeDzd: 0.5 })).toHaveLength(1));
  it('fails an error status', () => expect((checkQuote(503, { code: 'server_error' }) as string[])[0]).toMatch(/503/));
  it('reports an unserved wilaya', () => expect(checkQuote(200, { ok: true, available: false })).toBe('unavailable'));
});

describe('checkOrderRefusal', () => {
  it.each([400, 422])('accepts %i', (s) => expect(checkOrderRefusal(s)).toEqual([]));
  it.each([200, 201, 403, 429, 500, 503])('rejects %i', (s) => expect(checkOrderRefusal(s)).toHaveLength(1));
});

describe('checkAdmin', () => {
  it('accepts a redirect to the Access login', () => expect(checkAdmin(302, 'https://team.cloudflareaccess.com/cdn-cgi/access/login/x')).toEqual([]));
  it.each([401, 403])('accepts %i', (s) => expect(checkAdmin(s, null)).toEqual([]));
  it('rejects the admin UI', () => expect(checkAdmin(200, null)).toHaveLength(1));
  it('rejects a redirect elsewhere', () => expect(checkAdmin(302, 'https://evil.test/')).toHaveLength(1));
  it('rejects a lookalike host', () => expect(checkAdmin(302, 'https://cloudflareaccess.com.evil.test/')).toHaveLength(1));
  it('rejects a server error', () => expect(checkAdmin(500, null)).toHaveLength(1));
});

function fetcher(overrides: Record<string, () => Response> = {}): { get: Fetcher; calls: { url: string; init: RequestInit | undefined }[] } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const get: Fetcher = async (url, init) => {
    calls.push({ url, init });
    const path = url.replace(/^https:\/\/[^/]+/, '');
    const key = url.startsWith(targets.adminOrigin) ? 'admin' : path;
    if (overrides[key]) return overrides[key]();
    if (key === '/ar/') return new Response(page('ar', 'rtl', '/ar/p/طقم/'));
    if (key === '/fr/') return new Response(page('fr', 'ltr', '/fr/p/pack-luxe/'));
    if (key === '/api/quote') return Response.json({ ok: true, available: true, lines: [{ lineTotalDzd: 14600 }], subtotalDzd: 14600, feeDzd: 400, totalDzd: 15000 });
    if (key === '/api/order') return new Response('{}', { status: 422 });
    if (key === 'admin') return new Response(null, { status: 302, headers: { location: 'https://team.cloudflareaccess.com/login' } });
    return new Response('', { status: 404 });
  };
  return { get, calls };
}

describe('runSmokeOnce', () => {
  it('passes a healthy site and sends only a harmless order body', async () => {
    const { get, calls } = fetcher();
    expect(await runSmokeOnce(targets, snapshot, get, 'all')).toEqual([]);
    expect(calls.find((c) => c.url.endsWith('/api/order'))?.init?.body).toBe('{}');
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith('/api/quote'))?.init?.body))).toEqual({ items: [{ variantId: 3, qty: 1 }], wilayaCode: 16 });
  });

  it('publish scope leaves the admin alone', async () => {
    const { get, calls } = fetcher();
    await runSmokeOnce(targets, snapshot, get, 'site');
    expect(calls.some((c) => c.url.startsWith(targets.adminOrigin))).toBe(false);
  });

  it('tries another wilaya, then reports missing fees', async () => {
    const { get, calls } = fetcher({ '/api/quote': () => Response.json({ ok: true, available: false }) });
    const problems = await runSmokeOnce(targets, snapshot, get, 'site');
    expect(calls.filter((c) => c.url.endsWith('/api/quote')).length).toBe(3);
    expect(problems.join()).toMatch(/not available/);
  });

  it('reports a thrown network error as a problem', async () => {
    const { get } = fetcher({ '/ar/': () => { throw new Error('connection reset'); } });
    expect((await runSmokeOnce(targets, snapshot, get, 'site')).join()).toMatch(/connection reset/);
  });
});

it('runSmoke retries until the new version answers', async () => {
  let n = 0;
  const { get } = fetcher({ '/api/order': () => new Response('{}', { status: ++n < 3 ? 500 : 422 }) });
  const sleeps: number[] = [];
  const problems = await runSmoke(targets, snapshot, get, 'site', { attempts: 5, delayMs: 7, sleep: async (ms) => void sleeps.push(ms), log: () => {} });
  expect(problems).toEqual([]);
  expect(sleeps).toEqual([7, 7]);
});

it('runSmoke gives up after the attempts and returns the last problems', async () => {
  const { get } = fetcher({ '/api/order': () => new Response('{}', { status: 500 }) });
  const problems = await runSmoke(targets, snapshot, get, 'site', { attempts: 2, delayMs: 0, sleep: async () => {}, log: () => {} });
  expect(problems.join()).toMatch(/500/);
});
