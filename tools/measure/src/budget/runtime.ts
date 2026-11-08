/**
 * Runtime half of `npm run budget` (MEAS-1 r2): a real Chrome load of every page, because some
 * budget rules are about what the browser actually fetches, which static analysis can only
 * approximate:
 *
 *  - `fr-font` (runtime): a /fr/ page must make zero font requests. The shared stylesheet may
 *    declare the Arabic @font-face (lead ruling on SHELL-1 F2 / QA BUG-2), but no French text may
 *    use it (STACK-REPORT §5: "give its «العربية» label a system font; otherwise French pages
 *    download the Arabic font"). Checked at 360 and 1440 px, after load + idle, and again after
 *    focusing and hovering every link (a :focus/:hover rule could pull the font in).
 *  - `third-party` (runtime): no request to another origin while the page loads and idles without
 *    user interaction (Turnstile may load only on the order form's first focusin/pointerdown).
 *
 * Method from qa's live-checks.mjs (artifacts/qa/scripts/): Playwright + system Chrome,
 * `page.on('request')`, resourceType 'font', `document.fonts` loaded/loading entries.
 */
import { chromium, type Browser, type Page } from 'playwright';
import { startStatic } from '../serve.ts';
import type { Violation } from './check.ts';

export interface RuntimePage { url: string; lang: string }
export interface RuntimeResult {
  url: string;
  width: number;
  fontRequests: string[];
  fontsInUse: string[];
  thirdPartyRequests: string[];
  error?: string;
}

const CHROME = '/usr/bin/google-chrome';
/** Let the storefront LOADER's load → requestIdleCallback → import() chain run (it is what could inject a third party). */
const IDLE_MS = 1500;

async function loadOnce(browser: Browser, base: string, p: RuntimePage, width: number, interact: boolean): Promise<RuntimeResult> {
  const ctx = await browser.newContext({ viewport: { width, height: width < 768 ? 800 : 900 }, reducedMotion: 'reduce' });
  const page: Page = await ctx.newPage();
  const origin = new URL(base).origin;
  const fontRequests: string[] = [];
  const thirdPartyRequests: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.startsWith('data:') || u.startsWith('blob:')) return;
    let o = '';
    try { o = new URL(u).origin; } catch { /* about: etc. */ }
    if (o && o !== origin) thirdPartyRequests.push(u);
    if (r.resourceType() === 'font' || /\.(woff2?|ttf|otf)(?:[?#]|$)/i.test(u)) fontRequests.push(u.startsWith(origin) ? u.slice(origin.length) : u);
  });
  try {
    const resp = await page.goto(base + p.url, { waitUntil: 'load', timeout: 30_000 });
    if (!resp || resp.status() >= 400) throw new Error(`HTTP ${resp?.status() ?? 'no response'} for ${p.url}`);
    await page.waitForTimeout(IDLE_MS);
    if (interact) {
      // focus + hover every link and button (language switch included); still no form interaction
      const n = await page.locator('a[href], button').count();
      for (let i = 0; i < Math.min(n, 80); i++) {
        const el = page.locator('a[href], button').nth(i);
        await el.focus().catch(() => {});
        await el.hover({ timeout: 500, force: true }).catch(() => {});
      }
      await page.waitForTimeout(400);
    }
    // runs in the page; typed loosely because this workspace has no DOM lib
    const fontsInUse = await page.evaluate(`[...document.fonts].filter((f) => f.status === 'loaded' || f.status === 'loading').map((f) => f.family + ' ' + f.status)`) as string[];
    return { url: p.url, width, fontRequests, fontsInUse, thirdPartyRequests };
  } catch (e) {
    return { url: p.url, width, fontRequests, fontsInUse: [], thirdPartyRequests, error: (e as Error).message.split('\n')[0] ?? 'error' };
  } finally {
    await ctx.close();
  }
}

/**
 * Load every page in Chrome over a local static server of `dist`. Returns violations per page URL
 * plus the raw observations (written to the report).
 */
export async function runtimeChecks(dist: string, pages: RuntimePage[]): Promise<{ violations: Map<string, Violation[]>; results: RuntimeResult[] }> {
  const server = await startStatic(dist, 0);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
  const violations = new Map<string, Violation[]>();
  const results: RuntimeResult[] = [];
  const add = (url: string, v: Violation): void => { const l = violations.get(url) ?? []; l.push(v); violations.set(url, l); };
  try {
    for (const p of pages) {
      const widths = p.lang === 'fr' ? [360, 1440] : [360];
      for (const w of widths) {
        // first pass: no interaction (third parties, fonts); fr second pass adds focus/hover
        const r = await loadOnce(browser, server.baseUrl, p, w, false);
        results.push(r);
        if (r.error) add(p.url, { rule: 'runtime', message: `page did not load in Chrome at ${w} px: ${r.error}` });
        for (const u of new Set(r.thirdPartyRequests)) add(p.url, { rule: 'third-party', message: `(runtime) Chrome requested ${u} without any user interaction (${w} px)` });
        if (p.lang === 'fr') {
          const ri = await loadOnce(browser, server.baseUrl, p, w, true);
          results.push({ ...ri, url: `${p.url} (focus/hover)` });
          const fonts = [...new Set([...r.fontRequests, ...ri.fontRequests])];
          const inUse = [...new Set([...r.fontsInUse, ...ri.fontsInUse])];
          if (inUse.length && !fonts.length) fonts.push(...inUse.map((f) => `document.fonts: ${f}`));
          if (fonts.length) add(p.url, { rule: 'fr-font', message: `(runtime) French page downloaded ${fonts.join(', ')} at ${w} px (French uses the system stack; something on the page uses the Arabic font face: give it a system font)` });
        }
      }
    }
  } finally {
    await browser.close();
    await server.stop();
  }
  // de-duplicate identical messages across widths
  for (const [k, l] of violations) violations.set(k, l.filter((x, i) => l.findIndex((y) => y.rule === x.rule && y.message === x.message) === i));
  return { violations, results };
}
