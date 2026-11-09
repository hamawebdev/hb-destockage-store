/**
 * Meta orders through the real browser, Worker, D1 and local stand-in (contract §11 rows 3a–3c, 6, 11, 16; lead conditions).
 * Phone digests are computed here with node:crypto, independently of the code under test.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { startMetaStandIn, type MetaStandIn } from '../../apps/web/test/support/meta-stand-in.ts';
import { expectNumbersShown, expectPreselected, fillCustomer, openOrderStep, orderByRef, submitUntilConfirmed } from './flows.ts';
import { CONFIGURED, LANGS, STAND_IN_PORT, cspViolations, expectShape, fbqCalls, launchMeta, metaContext, place, scanForToken, tracked, uniqueSeed, until, variant, waitTracked, watchPage, type Lang } from './meta-support.ts';

const FBP = 'fb.1.1596403881668.1116446470';
const digest = (phone: string) => createHash('sha256').update(`213${phone.slice(1)}`, 'utf8').digest('hex');

describe.runIf(CONFIGURED)('Meta order, consent given', () => {
  let browser: Browser;
  let standIn: MetaStandIn;
  const web = () => inject('webUrl') as string;

  beforeAll(async () => {
    browser = await launchMeta();
    standIn = await startMetaStandIn(STAND_IN_PORT);
  });
  afterAll(async () => {
    await browser?.close();
    await standIn?.close().catch(() => {});
  });
  beforeEach(() => standIn.reset());

  async function order(page: Page, lang: Lang, seed: number, v = variant(lang)) {
    const where = place();
    await openOrderStep(page, web(), lang, v);
    await expectPreselected(page, v);
    const { phone, name } = await fillCustomer(page, where, seed, 1);
    await expectNumbersShown(page, [where.fee, v.price + where.fee]);
    const ref = await submitUntilConfirmed(page);
    return { ref, phone, name, total: v.price + where.fee, variantId: v.variantId };
  }

  describe.each(LANGS)('/%s/', (lang) => {
    it('one correct server event with the same ID as the browser event, once across a reload', async () => {
      const { ctx } = await metaContext(browser, { consent: 'granted' });
      await ctx.addCookies([{ name: '_fbp', value: FBP, url: web() }]);
      const page = await ctx.newPage();
      const errors = watchPage(page);
      const r = await order(page, lang, uniqueSeed());
      await until(() => standIn.events().length === 1, 'one server event');
      await waitTracked(page, 'Purchase');

      const e = standIn.events()[0]!;
      const row = orderByRef(r.ref);
      expect(e).toMatchObject({ event_name: 'Purchase', event_id: r.ref, action_source: 'website', event_source_url: `https://localhost/${lang}/order/confirmation/` });
      expect(e.custom_data).toEqual({ currency: 'DZD', value: row.total_dzd, content_type: 'product', contents: [{ id: String(r.variantId), quantity: 1 }], order_id: r.ref });
      expect(e.custom_data['value']).toBe(r.total);
      expect(e.user_data['ph']).toEqual([digest(r.phone)]);
      // The fake fbevents.js writes no cookie, so the test seeds _fbp: this proves the value is carried unchanged.
      expect(e.user_data['fbp']).toBe(FBP);
      expect(e.user_data['client_user_agent']).toBeTruthy();
      expect(standIn.hits()[0]).toMatchObject({ hasToken: true, tokenInUrl: false });

      const [purchase] = await tracked(page, 'Purchase');
      expect((purchase![3] as { eventID: string }).eventID).toBe(r.ref);
      expect(purchase![2]).toEqual({ currency: 'DZD', value: r.total, content_type: 'product', contents: [{ id: String(r.variantId), quantity: 1 }] });
      expectShape(await fbqCalls(page));

      await page.reload();
      await waitTracked(page, 'PageView');
      await new Promise((ok) => setTimeout(ok, 500));
      expect(await tracked(page, 'Purchase')).toHaveLength(0); // a fresh document: nothing fired again
      expect(standIn.events()).toHaveLength(1);

      expect(await cspViolations(page)).toEqual([]);
      expect(errors).toEqual([]);
      await ctx.close();
    });

    it('a genuine double submit adds no server event and no browser Purchase', async () => {
      const seed = uniqueSeed();
      const v = variant(lang); // once: an order can drop this variant below the stock pickVariant asks for
      const first = await metaContext(browser, { consent: 'granted' });
      const p1 = await first.ctx.newPage();
      const r1 = await order(p1, lang, seed, v);
      await until(() => standIn.events().length === 1, 'first server event');
      await first.ctx.close();

      const second = await metaContext(browser, { consent: 'granted' });
      const p2 = await second.ctx.newPage();
      const r2 = await order(p2, lang, seed, v);
      expect(r2.ref).toBe(r1.ref);
      await new Promise((ok) => setTimeout(ok, 800));
      expect(await tracked(p2, 'Purchase')).toHaveLength(0);
      expect(standIn.events()).toHaveLength(1);
      await second.ctx.close();
    });

    it('stand-in down: the order still succeeds', async () => {
      await standIn.close();
      try {
        const { ctx } = await metaContext(browser, { consent: 'granted' });
        const page = await ctx.newPage();
        const r = await order(page, lang, uniqueSeed());
        expect(orderByRef(r.ref).total_dzd).toBe(r.total);
        await ctx.close();
      } finally {
        standIn = await startMetaStandIn(STAND_IN_PORT);
      }
    });

    it('oversized _fbp and _fbc cannot fail an order, and never reach the body', async () => {
      const long = `fb.1.1596403881668.${'a'.repeat(3900)}`;
      const { ctx } = await metaContext(browser, { consent: 'granted' });
      await ctx.addCookies([{ name: '_fbp', value: long, url: web() }, { name: '_fbc', value: long, url: web() }]);
      const page = await ctx.newPage();
      const sent = page.waitForRequest((r) => r.url().endsWith('/api/order') && r.method() === 'POST' && (r.headers()['content-type'] ?? '').includes('json'), { timeout: 180_000 });
      const r = await order(page, lang, uniqueSeed());
      const body = (await sent).postDataJSON() as { meta?: Record<string, unknown> };
      expect(body.meta).toEqual({ consent: true });
      expect(orderByRef(r.ref).total_dzd).toBe(r.total);
      await ctx.close();
    });

    it('the access token never reaches the browser', async () => {
      const { ctx } = await metaContext(browser, { consent: 'granted' });
      const page = await ctx.newPage();
      const pending: Promise<void>[] = [];
      page.on('request', (q) => scanForToken(q, `${q.url()} ${q.postData() ?? ''} ${JSON.stringify(q.headers())}`));
      page.on('response', (s) => {
        if (s.url().includes('/api/') || s.request().resourceType() === 'document') pending.push(s.text().then((t) => scanForToken(s, `${t} ${JSON.stringify(s.headers())}`), () => {}));
      });
      await order(page, lang, uniqueSeed());
      await Promise.all(pending);
      expect(pending.length).toBeGreaterThan(0);
      await ctx.close();
    });
  });
});
