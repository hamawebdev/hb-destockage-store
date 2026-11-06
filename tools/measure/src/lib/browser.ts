/**
 * Deterministic page loading for screenshots, axe and the keyboard pass (MEAS-3).
 * System Chrome (/usr/bin/google-chrome) via Playwright; no browser download.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

export const CHROME = '/usr/bin/google-chrome';
export const WIDTHS = [360, 768, 1440] as const;
export const HEIGHT: Record<number, number> = { 360: 800, 768: 1024, 1440: 900 };

/** Freeze motion: no animations, transitions, smooth scrolling or blinking caret. */
const FREEZE = '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important}';

export function launch(): Promise<Browser> {
  return chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--font-render-hinting=none', '--hide-scrollbars'] });
}

export async function newContext(browser: Browser, width: number): Promise<BrowserContext> {
  return browser.newContext({
    viewport: { width, height: HEIGHT[width] ?? 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce', colorScheme: 'light',
    locale: 'fr-DZ', timezoneId: 'Africa/Algiers', bypassCSP: true, // the freeze style is injected
  });
}

/** Longest wait for fonts and images after the reload. */
export const IMAGE_WAIT_MS = 20_000;

export interface Loaded { page: Page; status: number; error?: string }

/**
 * Load a page so its rendering is stable: load → fonts settled → reload (a `font-display:
 * optional` face is then served from cache, as on a repeat visit, instead of racing the first
 * paint) → load → lazy images switched to eager → fonts and images complete (≤ 20 s, else an
 * error) → motion frozen.
 */
export async function loadStable(ctx: BrowserContext, url: string, opts: { freeze?: boolean } = {}): Promise<Loaded> {
  const page = await ctx.newPage();
  try {
    let resp = await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
    await page.evaluate('document.fonts.ready');
    resp = await page.reload({ waitUntil: 'load', timeout: 45_000 });
    // Lazy images below the fold would never load (and the wait would never end): load them all,
    // then wait at most IMAGE_WAIT_MS; images still pending then are a load error, not a hang.
    const pending = await page.evaluate(`(() => {
      for (const i of document.images) if (i.loading === 'lazy') i.loading = 'eager';
      const all = Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.complete ? null : new Promise((r) => { i.addEventListener('load', r); i.addEventListener('error', r); }))]);
      return Promise.race([all.then(() => []), new Promise((r) => setTimeout(() => r([...document.images].filter((i) => !i.complete).map((i) => i.currentSrc || i.src)), ${IMAGE_WAIT_MS}))]);
    })()`) as string[];
    if (pending.length) throw new Error(`${pending.length} image(s) still loading after ${IMAGE_WAIT_MS / 1000} s: ${pending.slice(0, 3).join(', ')}`);
    if (opts.freeze !== false) await page.addStyleTag({ content: FREEZE });
    await page.waitForTimeout(150);
    return { page, status: resp?.status() ?? 0 };
  } catch (e) {
    return { page, status: 0, error: (e as Error).message.split('\n')[0] ?? 'error' };
  }
}
