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

export interface Loaded { page: Page; status: number; error?: string }

/**
 * Load a page so its rendering is stable: load → fonts settled → reload (a `font-display:
 * optional` face is then served from cache, as on a repeat visit, instead of racing the first
 * paint) → load → fonts and images complete → motion frozen.
 */
export async function loadStable(ctx: BrowserContext, url: string, opts: { freeze?: boolean } = {}): Promise<Loaded> {
  const page = await ctx.newPage();
  try {
    let resp = await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
    await page.evaluate('document.fonts.ready');
    resp = await page.reload({ waitUntil: 'load', timeout: 45_000 });
    await page.evaluate(`Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }))])`);
    if (opts.freeze !== false) await page.addStyleTag({ content: FREEZE });
    await page.waitForTimeout(150);
    return { page, status: resp?.status() ?? 0 };
  } catch (e) {
    return { page, status: 0, error: (e as Error).message.split('\n')[0] ?? 'error' };
  }
}
