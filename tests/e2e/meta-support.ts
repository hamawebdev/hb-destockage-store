/// <reference lib="dom" />
/**
 * Shared helpers for the Meta end-to-end specs (META-8). Run them through tests/e2e/meta-run.sh:
 * it builds, seeds and boots the Worker with fake values only. No check here reaches the real Meta:
 * the three hosts are mapped to a closed loopback port by the browser's resolver and are also
 * intercepted by the context's routes.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page, type Request, type Response } from 'playwright';
import { expect } from 'vitest';
import { CHROME, pickPlace, pickVariant, type Pick, type Place } from './flows.ts';
import { d1, DIST } from './harness.ts';

export const MODE = process.env['HB_META_E2E'] ?? '';
export const CONFIGURED = MODE === 'configured';
export const STAND_IN_PORT = 4352;
export const FAKE_PIXEL = '000000000000000';
export const FAKE_TOKEN = 'FAKE_TEST_TOKEN';
export const LANGS = ['ar', 'fr'] as const;
export type Lang = (typeof LANGS)[number];

const META_HOSTS = ['connect.facebook.net', 'www.facebook.com', 'graph.facebook.com'];
const CLOSED_LOOPBACK = '127.0.0.1:4359';
export const RESOLVER_ARG = `--host-resolver-rules=${META_HOSTS.map((h) => `MAP ${h} ${CLOSED_LOOPBACK}`).join(',')}`;

export const launchMeta = (extra: string[] = []): Promise<Browser> =>
  chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', RESOLVER_ARG, ...extra] });

/** Stands in for fbevents.js. Records what the page queued, exercises both of the Pixel's channels, sets no cookie. */
const FAKE_FBEVENTS = `(function(){
  var n=window.fbq,c=window.__fbq=[];
  function rec(a){var x=[].slice.call(a);c.push(x);if(x[0]==='track'){new Image().src='https://www.facebook.com/tr?ev='+encodeURIComponent(x[1]);navigator.sendBeacon('https://www.facebook.com/tr/','');}}
  n.queue.forEach(rec);n.queue=[];n.callMethod=function(){rec(arguments)};
})();`;

const GIF = Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64');

export interface Network {
  /** Every request to a Meta host, as the browser made it. */
  readonly meta: string[];
  /** Any other request that left loopback, except the empty stand-in for Turnstile. */
  readonly unexpected: string[];
}

export interface MetaContext {
  readonly ctx: BrowserContext;
  readonly net: Network;
}

export interface ContextOptions {
  readonly consent?: 'granted' | 'denied';
  readonly javaScript?: boolean;
  readonly viewport?: { width: number; height: number };
}

export async function metaContext(browser: Browser, opts: ContextOptions = {}): Promise<MetaContext> {
  const ctx = await browser.newContext({
    javaScriptEnabled: opts.javaScript !== false,
    ...(opts.viewport ? { viewport: opts.viewport } : {}),
  });
  const net: Network = { meta: [], unexpected: [] };
  await ctx.route('**/*', async (route) => {
    const { protocol, hostname, pathname } = new URL(route.request().url());
    if (protocol === 'data:' || protocol === 'blob:' || hostname === '127.0.0.1' || hostname === 'localhost') return route.continue();
    if (META_HOSTS.includes(hostname)) {
      net.meta.push(route.request().url());
      if (hostname === 'connect.facebook.net' && pathname.endsWith('/fbevents.js')) return route.fulfill({ contentType: 'text/javascript', body: FAKE_FBEVENTS });
      if (hostname === 'www.facebook.com') return route.fulfill({ contentType: 'image/gif', body: GIF });
      return route.fulfill({ contentType: 'text/javascript', body: '' });
    }
    if (hostname === 'challenges.cloudflare.com') return route.fulfill({ contentType: 'text/javascript', body: '' });
    net.unexpected.push(route.request().url());
    return route.abort();
  });
  await ctx.addInitScript(([choice]) => {
    const w = window as unknown as Record<string, unknown>;
    w['__csp'] = [];
    w['__shifts'] = [];
    document.addEventListener('securitypolicyviolation', (e) => (w['__csp'] as string[]).push(`${e.violatedDirective} ${e.blockedURI}`));
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) (w['__shifts'] as number[]).push((e as unknown as { value: number }).value);
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((l) => {
      const e = l.getEntries().at(-1) as unknown as { element?: Element; startTime: number };
      w['__lcpElement'] = e?.element ?? null;
      w['__lcpTime'] = e?.startTime ?? 0;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    if (choice) {
      try {
        localStorage.setItem('hb.meta.consent.v1', choice);
      } catch {}
    }
  }, [opts.consent ?? null] as const);
  return { ctx, net };
}

/** Records console errors and page errors for a page. */
export function watchPage(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

export const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 15_000): Promise<void> => {
  const end = Date.now() + ms;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

type Call = unknown[];

/** Calls the page made to fbq: recorded by the fake script, or still queued if it has not run. */
export const fbqCalls = (page: Page): Promise<Call[]> =>
  page.evaluate(() => {
    const w = window as unknown as { __fbq?: unknown[][]; fbq?: { queue?: IArguments[] } };
    if (w.__fbq) return w.__fbq.map((c) => [...c]);
    return (w.fbq?.queue ?? []).map((c) => [...c]);
  });

export const tracked = async (page: Page, event: string): Promise<Call[]> => (await fbqCalls(page)).filter((c) => c[0] === 'track' && c[1] === event);

export const waitTracked = (page: Page, event: string, count = 1): Promise<void> =>
  until(async () => (await tracked(page, event)).length >= count, `${count} ${event} at ${page.url()}`);

export const cspViolations = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);

/** Contract row 9: every recorded track call has the right parameter shape. */
export function expectShape(calls: Call[]): void {
  for (const c of calls) {
    if (c[0] !== 'track' || c[1] === 'PageView') continue;
    const p = c[2] as { value?: unknown; currency?: unknown; contents?: { id?: unknown; quantity?: unknown }[]; content_type?: unknown; content_ids?: unknown[] };
    const name = String(c[1]);
    expect(p.content_type, name).toBe('product');
    if (p.value !== undefined) {
      expect(typeof p.value, `${name} value`).toBe('number');
      expect(p.currency, `${name} currency`).toBe('DZD');
    }
    if (name === 'Purchase') expect(typeof p.value, 'Purchase value').toBe('number');
    for (const line of p.contents ?? []) {
      expect(typeof line.id, `${name} id`).toBe('string');
      expect(typeof line.quantity, `${name} quantity`).toBe('number');
    }
  }
}

/** Scrolls and presses keys until the choice appears: an input before meta.js has its listeners is missed. */
export async function showChoice(page: Page): Promise<void> {
  await until(async () => {
    await page.mouse.wheel(0, 30);
    await page.keyboard.press('ArrowDown').catch(() => {});
    return (await page.locator('.mc').count()) > 0 && page.locator('.mc').isVisible();
  }, `the consent choice at ${page.url()}`, 10_000);
}

export const place = (): Place => pickPlace();
export const variant = (lang: Lang): Pick => pickVariant(lang);

/** A unique seed per call, so phone numbers never collide across specs or runs. */
let counter = 0;
export const uniqueSeed = (): number => (Date.now() % 1_000_000) * 10 + (counter++ % 10);

/** Two sellable single-variant products, for cart orders. */
export function simpleProducts(lang: Lang): { id: number; slug: string; variantId: number; price: number }[] {
  const rows = d1<{ id: number; slug: string; vid: number; price: number }>(
    `SELECT p.id AS id, p.slug_${lang} AS slug, v.id AS vid, v.price_dzd AS price FROM products p JOIN variants v ON v.product_id = p.id
     WHERE p.kind = 'simple' AND p.status = 'active' AND v.active = 1 AND (v.stock IS NULL OR v.stock >= 5) ORDER BY p.id LIMIT 2`);
  if (rows.length < 2) throw new Error('the seed has fewer than two sellable simple products');
  return rows.map((r) => ({ id: r.id, slug: r.slug, variantId: r.vid, price: r.price }));
}

/** One URL per template with the Pixel, in one language (the order pages are added by the specs that need them). */
export function templateUrls(lang: Lang): { template: string; url: string }[] {
  const categories = readdirSync(path.join(DIST, lang, 'c'));
  const privacy = lang === 'ar' ? 'al-khususiya' : 'confidentialite';
  return [
    { template: 'home', url: `/${lang}/` },
    { template: 'category', url: `/${lang}/c/${categories[0]}/` },
    { template: 'product', url: `/${lang}/p/${variant(lang).slug}/` },
    { template: 'search', url: `/${lang}/search/` },
    { template: 'content', url: `/${lang}/${privacy}/` },
    { template: 'order-confirmed', url: `/${lang}/order/confirmation/?ref=HB-AAAAA` },
  ];
}

export const scanForToken = (r: Request | Response, text: string): void => {
  expect(text.includes(FAKE_TOKEN), `token leaked in ${r.url()}`).toBe(false);
};
