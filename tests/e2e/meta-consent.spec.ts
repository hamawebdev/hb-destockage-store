/**
 * Consent, timing and CSP in a real browser against the real Worker (contract §11 rows 3d, 5, 5b, 7, 10, 12, 13, 15; lead conditions).
 * Times come from the page's own performance entries, on one clock.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { startMetaStandIn, type MetaStandIn } from '../../apps/web/test/support/meta-stand-in.ts';
import { TURNSTILE_ORIGIN, META_PIXEL_ORIGIN, META_SCRIPT_ORIGIN, patternMatches, scanHtml } from '../../apps/web/scripts/csp.ts';
import { chooseVariant, expectNumbersShown, expectPreselected, fillCustomer, openOrderStep, pickPlace, pickVariant, submitUntilConfirmed } from './flows.ts';
import { DIST } from './harness.ts';
import { CONFIGURED, LANGS, MODE, STAND_IN_PORT, cspViolations, expectShape, fbqCalls, launchMeta, metaContext, place, showChoice, templateUrls, uniqueSeed, until, variant, waitTracked, watchPage, type Lang } from './meta-support.ts';

const web = () => inject('webUrl') as string;
const stored = (page: Page) => page.evaluate(() => localStorage.getItem('hb.meta.consent.v1'));
const fbqDefined = (page: Page) => page.evaluate(() => typeof (window as unknown as { fbq?: unknown }).fbq !== 'undefined');

async function metaTiming(page: Page) {
  return page.evaluate(() => {
    const entries = performance.getEntriesByType('resource').filter((r) => /facebook\.(net|com)/.test(r.name));
    return {
      firstMeta: entries.length ? Math.min(...entries.map((e) => e.startTime)) : null,
      lcp: (window as unknown as { __lcpTime?: number }).__lcpTime ?? 0,
    };
  });
}

describe.runIf(CONFIGURED)('Meta consent', () => {
  let browser: Browser;
  let standIn: MetaStandIn;
  beforeAll(async () => {
    browser = await launchMeta();
    standIn = await startMetaStandIn(STAND_IN_PORT);
  });
  afterAll(async () => {
    await browser?.close();
    await standIn?.close().catch(() => {});
  });
  beforeEach(() => standIn.reset());

  /** Places an order through the browser and returns its ref. */
  async function order(page: Page, lang: Lang) {
    const v = variant(lang);
    const where = place();
    await openOrderStep(page, web(), lang, v);
    await expectPreselected(page, v);
    await fillCustomer(page, where, uniqueSeed(), 1);
    await expectNumbersShown(page, [where.fee, v.price + where.fee]);
    return submitUntilConfirmed(page);
  }

  /** A consenting order last: every send before it has had its waitUntil run. Returns the event ids before it. */
  async function idsBeforeSentinel(lang: Lang): Promise<string[]> {
    const { ctx } = await metaContext(browser, { consent: 'granted' });
    const ref = await order(await ctx.newPage(), lang);
    await until(() => standIn.events().some((e) => e.event_id === ref), 'the sentinel event');
    await ctx.close();
    const ids = standIn.events().map((e) => e.event_id);
    expect(ids.at(-1)).toBe(ref);
    return ids.slice(0, -1);
  }

  describe.each(LANGS)('/%s/', (lang) => {
    it('no choice made: no Meta request or script from browser or server, and no cookie', async () => {
      const { ctx, net } = await metaContext(browser);
      const page = await ctx.newPage();
      await page.goto(`${web()}/${lang}/`);
      const before = await page.evaluate(() => document.cookie);
      await showChoice(page);
      await new Promise((ok) => setTimeout(ok, 500));
      expect(net.meta).toEqual([]);
      expect(await fbqDefined(page)).toBe(false);
      expect(await page.evaluate(() => document.cookie)).toBe(before);
      expect(await stored(page)).toBeNull();
      await order(page, lang);
      expect(net.meta).toEqual([]);
      expect(await idsBeforeSentinel(lang)).toEqual([]);
      await ctx.close();
    });

    it('declined: stored without a cookie, nothing from browser or server, no choice shown again', async () => {
      const { ctx, net } = await metaContext(browser);
      const page = await ctx.newPage();
      await page.goto(`${web()}/${lang}/`);
      await showChoice(page);
      await page.locator('.mc-a button').last().click();
      await until(async () => (await page.locator('.mc').count()) === 0, 'the choice to close');
      expect(await stored(page)).toBe('denied');
      expect(await page.evaluate(() => document.cookie)).toBe('');
      await page.reload();
      await page.mouse.wheel(0, 200);
      await new Promise((ok) => setTimeout(ok, 1000));
      expect(await page.locator('.mc').count()).toBe(0);
      expect(net.meta).toEqual([]);
      expect(await fbqDefined(page)).toBe(false);
      await order(page, lang);
      expect(net.meta).toEqual([]);
      expect(await idsBeforeSentinel(lang)).toEqual([]);
      await ctx.close();
    });

    it('accepted: the Pixel starts, autoConfig off before init, and our code sets no cookie', async () => {
      const { ctx } = await metaContext(browser);
      const page = await ctx.newPage();
      await page.goto(`${web()}/${lang}/`);
      await showChoice(page);
      await page.locator('.mc-a button').first().click();
      await waitTracked(page, 'PageView');
      expect(await stored(page)).toBe('granted');
      // The fake fbevents.js writes no cookie, so this proves our own code writes none.
      expect(await page.evaluate(() => document.cookie)).toBe('');
      const calls = await fbqCalls(page);
      expect(calls.findIndex((c) => c[0] === 'set' && c[1] === 'autoConfig' && c[2] === false)).toBeGreaterThanOrEqual(0);
      expect(calls.findIndex((c) => c[0] === 'set' && c[1] === 'autoConfig')).toBeLessThan(calls.findIndex((c) => c[0] === 'init'));
      await ctx.close();
    });

    it('every template: no Meta request before LCP, no CSP violation, no console error', async () => {
      const { ctx, net } = await metaContext(browser, { consent: 'granted' });
      for (const { url, template } of templateUrls(lang)) {
        const page = await ctx.newPage();
        const errors = watchPage(page);
        await page.goto(`${web()}${url}`);
        await waitTracked(page, 'PageView');
        await until(async () => (await metaTiming(page)).firstMeta !== null, `Meta timing on ${url}`);
        await new Promise((ok) => setTimeout(ok, 500)); // a later, larger paint would still update the final LCP entry
        const t = await metaTiming(page);
        expect(t.firstMeta!, template).toBeGreaterThan(t.lcp);
        expect(t.lcp, `${template} has an LCP`).toBeGreaterThan(0);
        expect(await cspViolations(page), template).toEqual([]);
        expect(errors, template).toEqual([]);
        expectShape(await fbqCalls(page));
        await page.close();
      }
      expect(net.unexpected).toEqual([]);
      await ctx.close();
    });

    it('name and phone never reach Meta, on the order step and checkout, and autoConfig stays off', async () => {
      const { ctx, net } = await metaContext(browser, { consent: 'granted' });
      for (const path_ of ['order', 'checkout'] as const) {
        const page = await ctx.newPage();
        const v = variant(lang);
        const where = place();
        const typedName = `Nom Essai ${path_}`;
        const typedPhone = '0770555123';
        if (path_ === 'order') {
          await openOrderStep(page, web(), lang, v);
        } else {
          await page.goto(`${web()}/${lang}/checkout/`);
        }
        const form = page.locator('form[action="/api/order"]');
        if (await form.isVisible()) {
          await form.locator('[name="name"]').fill(typedName);
          await form.locator('[name="phone"]').fill(typedPhone);
          await form.locator('select[name="wilayaCode"]').selectOption(String(where.wilaya));
        }
        await waitTracked(page, 'PageView');
        await new Promise((ok) => setTimeout(ok, 300));
        const calls = await fbqCalls(page);
        expect(calls.findIndex((c) => c[0] === 'set' && c[1] === 'autoConfig' && c[2] === false)).toBeLessThan(calls.findIndex((c) => c[0] === 'init'));
        const all = JSON.stringify(calls) + net.meta.join(' ');
        expect(all, path_).not.toContain(typedName);
        expect(all, path_).not.toContain(typedPhone);
        expect(all, path_).not.toContain('770555123');
        await page.close();
      }
      await ctx.close();
    });

    it('the real Worker-served confirmation page and the review page, with no CSP violation', async () => {
      const { ctx } = await metaContext(browser, { consent: 'granted' });
      const page = await ctx.newPage();
      const response = await page.goto(`${web()}/${lang}/order/confirmation/?ref=HB-AAAAA`);
      const csp = response!.headers()['content-security-policy'] ?? '';
      expect(csp).toContain(`script-src 'self'`);
      expect(csp).toContain(META_SCRIPT_ORIGIN);
      expect(csp).toContain(`connect-src 'self' ${META_PIXEL_ORIGIN}`);
      expect(csp).toContain(`img-src 'self' ${META_PIXEL_ORIGIN}`);
      await waitTracked(page, 'PageView');
      expect(await cspViolations(page)).toEqual([]);
      await ctx.close();
    });

    it('the no-JS review page and its confirmation: no CSP violation, with JS off and with JS on and no order.js', async () => {
      const v = pickVariant(lang);
      const where = pickPlace();
      for (const javaScript of [false, true]) {
        const { ctx } = await metaContext(browser, { consent: 'granted', javaScript });
        const messages: string[] = [];
        const page = await ctx.newPage();
        page.on('console', (m) => messages.push(m.text()));
        if (javaScript) await page.route('**/js/order.js*', (r) => r.abort());
        await openOrderStep(page, web(), lang, v, { js: javaScript });
        if (!javaScript) await chooseVariant(page, v); // with JS the step preselects it from ?v=
        const form = page.locator('form[action="/api/order"]');
        await form.locator('[name="name"]').fill(`Sans JS ${lang} ${javaScript}`);
        await form.locator('[name="phone"]').fill(lang === 'ar' ? '0661234999' : '0771234999');
        await form.locator('select[name="wilayaCode"]').selectOption(String(where.wilaya));
        const reviewResponse = page.waitForResponse((r) => r.url().endsWith('/api/order') && r.request().method() === 'POST');
        await Promise.all([page.waitForURL(/\/api\/order/, { timeout: 20_000 }), form.locator('button[type="submit"], input[type="submit"]').last().click()]);
        const reviewCsp = (await reviewResponse).headers()['content-security-policy'] ?? '';
        // Review has no Pixel: its CSP must carry no Meta origin.
        expect(reviewCsp).toContain("default-src 'none'");
        expect(reviewCsp).not.toContain('facebook');
        if (javaScript) expect(await cspViolations(page)).toEqual([]);
        expect(messages.join('\n')).not.toMatch(/Content Security Policy/i);
        if (await page.locator('[name="communeId"]').count()) await page.locator('[name="communeId"]').selectOption(String(where.communeId));
        await new Promise((ok) => setTimeout(ok, 1700));
        const ref = await submitUntilConfirmed(page);
        expect(ref).toMatch(/^HB-/);
        if (javaScript) expect(await cspViolations(page)).toEqual([]);
        expect(messages.join('\n')).not.toMatch(/Content Security Policy/i);
        await ctx.close();
      }
    });
  });

  it('under CPU and network throttling, still no Meta request before LCP (/ar/)', async () => {
    const { ctx } = await metaContext(browser, { consent: 'granted' });
    for (const url of ['/ar/', `/ar/p/${variant('ar').slug}/`]) {
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
      await page.goto(`${web()}${url}`, { timeout: 60_000 });
      await until(async () => (await metaTiming(page)).firstMeta !== null, `Meta timing on ${url}`, 40_000);
      await new Promise((ok) => setTimeout(ok, 500));
      const t = await metaTiming(page);
      expect(t.firstMeta!, url).toBeGreaterThan(t.lcp);
      expect(t.lcp, url).toBeGreaterThan(0);
      await page.close();
    }
    await ctx.close();
  }, 180_000);

  // Not run (lead Addendum 3): under automation Chrome refuses every prerender with
  // PrerenderingDisabledByDevTools, even with Page.setPrerenderingAllowed. The unit test in
  // apps/storefront/test/meta-js.test.ts covers document.prerendering; the by-hand check is in docs/META-GO-LIVE.md.
  it.skip('a real Chrome prerender: not runnable under automation (PrerenderingDisabledByDevTools)', () => {});

  it('the generated CSP grows only by the three origins; review and confirmation lose only tokens their HTML does not use', () => {
    const offFile = path.join(process.env['HB_META_ARTIFACTS'] ?? '', 'unconfigured', '_headers');
    const off = readFileSync(offFile, 'utf8');
    const on = readFileSync(path.join(DIST, '_headers'), 'utf8');
    const cspFor = (headers: string, p: string): Map<string, Set<string>> => {
      let csp = '';
      let match = false;
      for (const line of headers.split('\n')) {
        if (line.startsWith('#') || line === '') continue;
        if (!line.startsWith(' ')) match = patternMatches(line, p);
        else if (match) {
          const t = line.trim();
          if (t === '! Content-Security-Policy') csp = '';
          else if (t.startsWith('Content-Security-Policy: ')) csp = t.slice('Content-Security-Policy: '.length);
        }
      }
      return new Map(csp.split('; ').map((d) => { const [name, ...values] = d.split(' '); return [name!, new Set(values)]; }));
    };
    for (const lang of LANGS) {
      const paths = [...templateUrls(lang).map((t) => t.url.split('?')[0]!), `/${lang}/checkout/`, `/${lang}/order/${variant(lang).slug}/`, `/${lang}/order/review/`, `/${lang}/404.html`];
      for (const p of paths) {
        const a = cspFor(off, p);
        const b = cspFor(on, p);
        const review = p.endsWith('/order/review/');
        const notFound = p.endsWith('404.html');
        const marked = !review && !notFound;
        const loses = review || p.endsWith('/order/confirmation/');
        const file = p.endsWith('/') ? `${p.slice(1)}index.html` : p.slice(1);
        const scan = scanHtml(readFileSync(path.join(DIST, file), 'utf8'), p);
        for (const [dir, offValues] of a) {
          const onValues = b.get(dir) ?? new Set<string>();
          const added = [...onValues].filter((v) => !offValues.has(v));
          const allowed = marked && dir === 'script-src' ? [META_SCRIPT_ORIGIN] : marked && (dir === 'img-src' || dir === 'connect-src') ? [META_PIXEL_ORIGIN] : [];
          expect(added.filter((v) => !allowed.includes(v)), `${p} ${dir} added`).toEqual([]);
          const lost = [...offValues].filter((v) => !onValues.has(v));
          if (!loses) expect(lost, `${p} ${dir} lost`).toEqual([]);
          for (const v of lost) {
            const used = scan.scriptHashes.includes(v) || scan.styleHashes.includes(v) || (v === TURNSTILE_ORIGIN && scan.hasOrderForm);
            expect(used, `${p} lost ${v}, which its HTML uses`).toBe(false);
          }
        }
        if (marked) {
          expect(b.get('script-src')?.has(META_SCRIPT_ORIGIN), `${p} script-src`).toBe(true);
          expect(b.get('connect-src')?.has(META_PIXEL_ORIGIN), `${p} connect-src`).toBe(true);
          expect(b.get('img-src')?.has(META_PIXEL_ORIGIN), `${p} img-src`).toBe(true);
        }
      }
    }
  });
});

describe.runIf(MODE === 'consent-off')('META_CONSENT_REQUIRED=0', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchMeta();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it.each(LANGS)('/%s/: no choice is shown and the Pixel is active', async (lang) => {
    const { ctx } = await metaContext(browser);
    const page = await ctx.newPage();
    await page.goto(`${web()}/${lang}/`);
    await waitTracked(page, 'PageView');
    await page.mouse.wheel(0, 200);
    await new Promise((ok) => setTimeout(ok, 800));
    expect(await page.locator('.mc').count()).toBe(0);
    await ctx.close();
  });

  it.each(LANGS)('/%s/: a stored decline still stops everything', async (lang) => {
    const { ctx, net } = await metaContext(browser, { consent: 'denied' });
    const page = await ctx.newPage();
    await page.goto(`${web()}/${lang}/`);
    await page.mouse.wheel(0, 200);
    await new Promise((ok) => setTimeout(ok, 1200));
    expect(net.meta).toEqual([]);
    expect(await page.evaluate(() => typeof (window as unknown as { fbq?: unknown }).fbq)).toBe('undefined');
    await ctx.close();
  });
});
