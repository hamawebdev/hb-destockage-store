/**
 * Storefront byte budgets. Every number comes from CLAUDE.md "Storefront budgets" /
 * STACK-REPORT.md §2. Change them only with a DECISIONS.md entry.
 */
export interface Budgets {
  htmlBrMax: number;
  htmlBrTarget: readonly [number, number];
  jsBrMax: number;
  criticalBytesMax: number;
  criticalRequestsMax: number;
  avifMaxBytes: number;
  avifCheckMaxWidth: number;
  avifWidths: readonly number[];
  brotliQualities: readonly number[];
  lcpViewport: { readonly width: number; readonly dpr: number };
}

export const BUDGETS: Readonly<Budgets> = Object.freeze({
  /** HTML document incl. inline CSS, brotli (CLAUDE.md: ≤ 14 KiB; target ≈ 4–6 KiB). */
  htmlBrMax: 14 * 1024,
  htmlBrTarget: [4 * 1024, 6 * 1024] as const,
  /** JS the page can load after LCP, brotli. CLAUDE.md says "10 KB", the task says "10 KiB";
   *  we gate on the stricter 10,000 B. */
  jsBrMax: 10_000,
  /** Critical path: HTML + preloads + LCP image + font (≤ 45 KiB in ≤ 4 requests). */
  criticalBytesMax: 45 * 1024,
  criticalRequestsMax: 4,
  /** AVIF: every candidate ≤ 960 w must be ≤ 25 KB (25,000 B, the stricter reading). */
  avifMaxBytes: 25_000,
  avifCheckMaxWidth: 960,
  avifWidths: Object.freeze([360, 480, 720, 960, 1200]),
  /**
   * Brotli qualities measured for text. The gate uses the LARGEST result: a static pipeline
   * may pre-compress at 11, but an edge compressing on the fly uses a low level, and we do
   * not know which one production uses (no deploy allowed). Never a false pass on wire size.
   */
  brotliQualities: Object.freeze([11, 4]),
  /**
   * Viewport used to decide which srcset candidate is the LCP image: Lighthouse 13 mobile
   * emulation (Moto G Power: 412 × 823 CSS px, DPR 1.75).
   */
  lcpViewport: Object.freeze({ width: 412, dpr: 1.75 }),
});

/**
 * `<link rel>` values that never fetch anything. Every other rel on a `<link>` is treated as a
 * fetch (stylesheet, preload, modulepreload, prefetch, preconnect, dns-prefetch, icon, manifest…).
 */
export const NON_FETCHING_RELS: ReadonlySet<string> = new Set([
  'canonical', 'alternate', 'author', 'help', 'license', 'me', 'next', 'prev', 'bookmark',
  'external', 'nofollow', 'noopener', 'noreferrer', 'opener', 'tag', 'privacy-policy', 'terms-of-service',
]);

/** Script `type` values that execute as JavaScript. Empty string = no type attribute. */
export const JS_TYPES: ReadonlySet<string> = new Set([
  '', 'module', 'text/javascript', 'application/javascript', 'application/ecmascript',
  'text/ecmascript', 'application/x-javascript', 'text/jscript', 'text/livescript',
  'text/x-javascript', 'text/x-ecmascript', 'text/javascript1.0', 'text/javascript1.1',
  'text/javascript1.2', 'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5',
]);

