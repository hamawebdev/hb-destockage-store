// MSET-6 (M-9): a network log of the published build, Meta configured in the admin only. For /ar/ and /fr/,
// every request the browser makes is written to <HB_E2E_OUT>/netlog-<lang>.txt with its time and phase
// (before the visitor's choice, after "accept"). Nothing goes to a Meta host before the choice; the Pixel
// (fbevents.js, init with the Pixel ID entered in the admin, PageView) starts only after "accept".
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import type { Browser } from 'playwright';
import { expectNoUnexpectedRequests, CONFIGURED, FAKE_PIXEL, LANGS, fbqCalls, launchMeta, metaContext, showChoice, waitTracked } from './meta-support.ts';

const web = () => inject('webUrl') as string;
const META = /^https:\/\/(connect\.facebook\.net|www\.facebook\.com|graph\.facebook\.com)\//;

describe.runIf(CONFIGURED)('Meta network log (admin-configured build)', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchMeta();
  });
  afterAll(async () => {
    await browser?.close();
  });
  afterEach(expectNoUnexpectedRequests);

  it.each(LANGS)('/%s/: no Meta request before the choice, the Pixel after "accept"', async (lang) => {
    const { ctx } = await metaContext(browser);
    const page = await ctx.newPage();
    const t0 = Date.now();
    let phase = 'before-choice';
    const log: { t: number; phase: string; method: string; url: string }[] = [];
    page.on('request', (r) => log.push({ t: Date.now() - t0, phase, method: r.method(), url: r.url() }));
    await page.goto(`${web()}/${lang}/`);
    await page.waitForLoadState('load');
    await showChoice(page);
    await new Promise((ok) => setTimeout(ok, 1000));
    const before = log.filter((l) => META.test(l.url));
    phase = 'after-accept';
    await page.locator('.mc-a button').first().click();
    await waitTracked(page, 'PageView');
    await new Promise((ok) => setTimeout(ok, 500));
    const after = log.filter((l) => l.phase === 'after-accept' && META.test(l.url));
    const init = (await fbqCalls(page)).find((c) => c[0] === 'init');
    const lines = [
      `# ${web()}/${lang}/ (Meta configured in the admin only; Meta hosts are answered by the test's stand-in)`,
      `# Meta requests before the choice: ${before.length}; after "accept": ${after.length}; fbq init Pixel ID: ${String(init?.[1])}`,
      ...log.map((l) => `${String(l.t).padStart(6)} ms  ${l.phase.padEnd(13)}  ${l.method.padEnd(4)}  ${META.test(l.url) ? 'META  ' : '      '}${l.url}`),
    ];
    writeFileSync(path.join(process.env['HB_E2E_OUT'] ?? '.', `netlog-${lang}.txt`), `${lines.join('\n')}\n`);
    expect(before).toEqual([]);
    expect(after.some((l) => l.url.startsWith('https://connect.facebook.net/') && l.url.endsWith('/fbevents.js'))).toBe(true);
    expect(init?.[1]).toBe(FAKE_PIXEL);
    await ctx.close();
  });
});
