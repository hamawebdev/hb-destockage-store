/** The consent choice does not delay, shift or block anything (contract §11 row 14; lead Addendum 2). */
import { AxeBuilder } from '@axe-core/playwright';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { expectPreselected, fillCustomer, openOrderStep } from './flows.ts';
import { CONFIGURED, LANGS, launchMeta, metaContext, place, showChoice, templateUrls, until, variant } from './meta-support.ts';

const web = () => inject('webUrl') as string;
const SMALL = { width: 360, height: 800 };

const hits = (page: Page, sel: string) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!at && (el === at || el.contains(at));
  }, sel);

describe.runIf(CONFIGURED)('the consent bar', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchMeta();
  });
  afterAll(async () => {
    await browser?.close();
  });

  describe.each(LANGS)('/%s/ at 360 px', (lang) => {
    it('every template: bar visible, no layout shift from it, and it is never the LCP element', async () => {
      const { ctx } = await metaContext(browser, { viewport: SMALL });
      for (const { url, template } of templateUrls(lang)) {
        const page = await ctx.newPage();
        await page.goto(`${web()}${url}`);
        await page.waitForLoadState('load');
        const before = await page.evaluate(() => (window as unknown as { __shifts: number[] }).__shifts.length);
        await showChoice(page);
        await until(() => page.locator('.mc').isVisible(), `bar visible on ${template}`);
        await new Promise((ok) => setTimeout(ok, 300));
        const after = await page.evaluate(() => (window as unknown as { __shifts: number[] }).__shifts.length);
        expect(after, `${template}: layout shift entries added with the bar`).toBe(before);
        const lcpInBar = await page.evaluate(() => {
          const el = (window as unknown as { __lcpElement?: Element | null }).__lcpElement;
          return !!el && !!el.closest('.mc');
        });
        expect(lcpInBar, `${template}: the LCP element is the bar`).toBe(false);
        await page.close();
      }
      await ctx.close();
    });

    it('is at most 128 px tall with the privacy link, tap targets ≥ 44 px, and nothing is covered', async () => {
      const { ctx } = await metaContext(browser, { viewport: SMALL });
      const page = await ctx.newPage();
      await page.goto(`${web()}/${lang}/p/${variant(lang).slug}/`);
      await page.waitForLoadState('load');
      await showChoice(page);
      // Scrolling to bring up the choice can carry the page past the point where the buy bar fades out.
      await page.evaluate(() => window.scrollTo(0, 0));
      await new Promise((ok) => setTimeout(ok, 300));
      const m = await page.evaluate(() => {
        const el = document.querySelector('.mc') as HTMLElement;
        const link = el.querySelector('a') as HTMLElement | null;
        const buttons = [...el.querySelectorAll('button')];
        return {
          barHeight: el.getBoundingClientRect().height,
          linkPresent: !!link,
          linkHeight: link ? link.getBoundingClientRect().height : 0,
          buttonHeights: buttons.map((b) => b.getBoundingClientRect().height),
          stacksAbove: (() => {
            const buy = document.querySelector('.cat-buybar');
            if (!buy || getComputedStyle(buy).display === 'none') return true;
            return el.getBoundingClientRect().bottom <= buy.getBoundingClientRect().top + 1;
          })(),
        };
      });
      expect(m.linkPresent, 'the privacy link is rendered').toBe(true);
      expect(m.barHeight).toBeLessThanOrEqual(128);
      expect(m.linkHeight).toBeGreaterThanOrEqual(44);
      for (const h of m.buttonHeights) expect(h).toBeGreaterThanOrEqual(44);
      expect(m.stacksAbove).toBe(true);
      expect(await hits(page, '.mc-a button:first-child')).toBe(true);
      expect(await hits(page, '.mc-a button:last-child')).toBe(true);
      expect(await hits(page, '.mc a')).toBe(true);
      expect(await hits(page, '.cat-buybar-cta:not([hidden])')).toBe(true);
      // A control near the bottom of the page, focused: scroll-padding keeps it clear of the bar.
      const covered = await page.evaluate(() => {
        const all = [...document.querySelectorAll('main a[href], main button')].filter((e) => (e as HTMLElement).offsetParent !== null);
        const last = all.at(-1) as HTMLElement;
        last.focus();
        const r = last.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !(at && (at === last || last.contains(at)));
      });
      expect(covered, 'the focused control is covered').toBe(false);
      await ctx.close();
    });

    it('no bar on the order step or checkout, confirm control reachable', async () => {
      const { ctx } = await metaContext(browser, { viewport: SMALL });
      const page = await ctx.newPage();
      const v = variant(lang);
      await openOrderStep(page, web(), lang, v);
      await expectPreselected(page, v);
      await fillCustomer(page, place(), 7, 1);
      await page.mouse.wheel(0, 300);
      await new Promise((ok) => setTimeout(ok, 800));
      expect(await page.locator('.mc').count()).toBe(0);
      expect(await hits(page, '#of-submit')).toBe(true);
      await page.goto(`${web()}/${lang}/checkout/`);
      await page.mouse.wheel(0, 200);
      await new Promise((ok) => setTimeout(ok, 800));
      expect(await page.locator('.mc').count()).toBe(0);
      await ctx.close();
    });

    it.each([360, 768, 1440])('axe finds nothing in the bar at %i px', async (width) => {
      const { ctx } = await metaContext(browser, { viewport: { width, height: 800 } });
      const page = await ctx.newPage();
      await page.goto(`${web()}/${lang}/`);
      await page.waitForLoadState('load');
      await showChoice(page);
      const r = await new AxeBuilder({ page }).include('.mc').analyze();
      expect(r.violations.map((v) => v.id)).toEqual([]);
      await ctx.close();
    });
  });
});
