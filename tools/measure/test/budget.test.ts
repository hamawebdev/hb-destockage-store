/**
 * MEAS-1 fixture tests. The good site must pass with zero violations; every mutation must make
 * the expected rule fail, and must not trip any rule outside its `allow` list (so a fixture
 * proves the rule it names, not a side effect).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkSite, RULES, type RuleId, type SiteReport } from '../src/budget/check.ts';
import {
  AVIF_BYTES, FONT, cleanup, edit, fakeAvif, freshSite, manifestJson, noise, noiseText, put, srcset,
} from './fixtures/site.ts';

afterAll(cleanup);

const AR_P = 'ar/p/pack-cuisine/index.html';
const FR_P = 'fr/p/pack-cuisine/index.html';
const AR_H = 'ar/index.html';
const FR_H = 'fr/index.html';
const before = (marker: string, insert: string) => (s: string) => s.replace(marker, `${insert}${marker}`);
const HEAD_END = '</head>';
const BODY_END = '</body>';

const rulesOf = (r: SiteReport): RuleId[] => [...r.siteViolations, ...r.pages.flatMap((p) => p.violations)].map((v) => v.rule);
const dump = (r: SiteReport): string => JSON.stringify([...r.siteViolations, ...r.pages.flatMap((p) => p.violations.map((v) => ({ page: p.url, ...v })))], null, 1);

describe('good site', () => {
  const dir = freshSite();
  const r = checkSite(dir);
  const byUrl = (u: string) => r.pages.find((p) => p.url === u);

  it('passes every rule', () => {
    expect(dump(r)).toBe('[]');
    expect(r.ok).toBe(true);
    expect(r.summary.pages).toBe(4);
  });

  it('computes the critical path it was designed for', () => {
    const ar = byUrl('/ar/p/pack-cuisine/');
    const fr = byUrl('/fr/p/pack-cuisine/');
    expect(ar?.metrics.critical.requests.map((c) => c.kind)).toEqual(['html', 'preload font', 'preload image']);
    expect(ar?.metrics.critical.requests.map((c) => c.url)).toEqual(['/ar/p/pack-cuisine/', FONT, '/img/p1-960.avif']);
    expect(fr?.metrics.critical.count).toBe(2);
    expect(fr?.metrics.critical.bytes).toBeGreaterThan(AVIF_BYTES[960] ?? 0);
  });

  it('follows lazily injected JS and reports the lazy third party without failing', () => {
    const ar = byUrl('/ar/p/pack-cuisine/');
    expect(ar?.metrics.js.files.map((f) => f.path)).toEqual(['/js/order.js', '/js/turnstile.js']);
    expect(ar?.metrics.js.lazyThirdPartyOrigins).toEqual(['https://challenges.cloudflare.com']);
    expect(byUrl('/ar/')?.metrics.js.totalBr).toBe(0);
  });

  it('uses the larger of the measured brotli sizes', () => {
    const p = byUrl('/fr/');
    expect(p?.metrics.htmlBrGate).toBe(Math.max(...Object.values(p?.metrics.htmlBr ?? {})));
  });
});

interface Case { name: string; rule: RuleId; allow?: RuleId[]; mutate: (dir: string) => void }

const CASES: Case[] = [
  // site
  { name: 'empty dist', rule: 'site', mutate: (d) => { rmSync(d, { recursive: true }); } },
  { name: 'no /fr/ pages', rule: 'site', mutate: (d) => { rmSync(path.join(d, 'fr'), { recursive: true }); } },

  // html-size (QA: 20 KiB-br inline CSS)
  {
    name: 'HTML with ~20 KiB brotli of inline CSS', rule: 'html-size', allow: ['critical-path'],
    mutate: (d) => edit(d, AR_P, (s) => s.replace('<style>', `<style>/*${noiseText(27000)}*/`)),
  },

  // css-inline
  {
    name: 'external stylesheet', rule: 'css-inline',
    mutate: (d) => { put(d, 'css/x.css', 'a{color:red}'); edit(d, FR_P, before(HEAD_END, '<link rel="stylesheet" href="/css/x.css">')); },
  },
  { name: 'two <style> elements', rule: 'css-inline', mutate: (d) => edit(d, FR_H, before(HEAD_END, '<style>p{margin:0}</style>')) },
  { name: 'no <style>', rule: 'css-inline', mutate: (d) => edit(d, FR_H, (s) => s.replace(/<style>[\s\S]*?<\/style>/, '')) },
  {
    name: '@import in the inline sheet', rule: 'css-inline',
    mutate: (d) => { put(d, 'css/x.css', 'a{color:red}'); edit(d, FR_H, (s) => s.replace('<style>', '<style>@import "/css/x.css";')); },
  },
  {
    name: 'stylesheet preload', rule: 'css-inline',
    mutate: (d) => { put(d, 'css/x.css', 'a{color:red}'); edit(d, FR_H, before(HEAD_END, '<link rel="preload" as="style" href="/css/x.css">')); },
  },

  // js-before-lcp
  { name: '<script src defer> in <head> (QA)', rule: 'js-before-lcp', mutate: (d) => edit(d, FR_P, before(HEAD_END, '<script src="/js/order.js" defer></script>')) },
  { name: 'inline script before the <h1> on a page without LCP image', rule: 'js-before-lcp', mutate: (d) => edit(d, FR_H, before(HEAD_END, '<script>document.documentElement.className="js"</script>')) },
  { name: 'async script after the LCP element', rule: 'js-before-lcp', mutate: (d) => edit(d, FR_P, (s) => s.replace('<script type="module" src="/js/order.js">', '<script type="module" async src="/js/order.js">')) },
  { name: 'parser-blocking script after the LCP element', rule: 'js-before-lcp', mutate: (d) => edit(d, FR_P, (s) => s.replace('<script type="module" src="/js/order.js">', '<script src="/js/order.js">')) },
  { name: 'modulepreload', rule: 'js-before-lcp', mutate: (d) => edit(d, FR_P, before(HEAD_END, '<link rel="modulepreload" href="/js/order.js">')) },
  { name: 'script preload', rule: 'js-before-lcp', mutate: (d) => edit(d, FR_P, before(HEAD_END, '<link rel="preload" as="script" href="/js/order.js">')) },

  // js-inline-handler
  { name: 'onclick attribute', rule: 'js-inline-handler', mutate: (d) => edit(d, FR_P, (s) => s.replace('<button type="submit">', '<button type="submit" onclick="go()">')) },
  { name: 'javascript: URL', rule: 'js-inline-handler', mutate: (d) => edit(d, FR_H, (s) => s.replace('</footer>', '<a href="javascript:void 0">x</a></footer>')) },

  // speculation-rules
  { name: 'invalid speculation rules JSON', rule: 'speculation-rules', mutate: (d) => edit(d, FR_H, (s) => s.replace('"eagerness":"moderate"}]}', '"eagerness":"moderate"}]')) },
  { name: 'external speculation rules', rule: 'speculation-rules', allow: ['missing-asset'], mutate: (d) => edit(d, FR_H, before(HEAD_END, '<script type="speculationrules" src="/rules.json"></script>')) },

  // js-after-lcp
  { name: 'order.js over 10 KB brotli', rule: 'js-after-lcp', mutate: (d) => put(d, 'js/order.js', `const k="${noiseText(14000)}";`) },
  {
    name: 'lazily injected first-party JS over budget (closure)', rule: 'js-after-lcp',
    mutate: (d) => put(d, 'js/turnstile.js', `const k="${noiseText(14000)}";`),
  },
  {
    name: 'dynamic import() chain over budget', rule: 'js-after-lcp',
    mutate: (d) => { put(d, 'js/extra.js', `export const k="${noiseText(14000)}";`); edit(d, 'js/order.js', (s) => `${s}\nimport('./extra.js');\n`); },
  },
  {
    name: 'modules listed in a data-js attribute (storefront LOADER) count', rule: 'js-after-lcp',
    mutate: (d) => { put(d, 'js/search.js', `export const k="${noiseText(14000)}";`); edit(d, FR_H, (s) => s.replace('<main id="main">', '<main id="main" data-js="/js/search.js">')); },
  },
  {
    name: 'inline scripts count too', rule: 'js-after-lcp',
    mutate: (d) => edit(d, FR_H, before(BODY_END, `<script>const k="${noiseText(14000)}"</script>`)),
  },

  // critical-path (QA: 5 requests via extra preloads)
  {
    name: '5 critical requests (two extra preloads)', rule: 'critical-path',
    mutate: (d) => {
      put(d, 'data/a.json', '{}'); put(d, 'data/b.json', '{}');
      edit(d, AR_P, before(HEAD_END, '<link rel="preload" as="fetch" href="/data/a.json" crossorigin><link rel="preload" as="fetch" href="/data/b.json" crossorigin>'));
    },
  },
  {
    name: 'non-lazy image before the LCP pushes bytes over 45 KiB', rule: 'critical-path', allow: ['avif'],
    mutate: (d) => { put(d, 'img/banner.png', noise(16000, 9)); edit(d, AR_P, (s) => s.replace('</header>', '<img src="/img/banner.png" width="10" height="10" alt=""></header>')); },
  },
  {
    name: 'external CSS url() counts', rule: 'critical-path',
    mutate: (d) => {
      put(d, 'img/bg.svg', noise(100, 4)); put(d, 'img/bg2.svg', noise(100, 5));
      edit(d, AR_P, (s) => s.replace('<style>', '<style>.a{background:url(/img/bg.svg)}.b{background:url("/img/bg2.svg")}'));
    },
  },

  // lcp-image
  { name: 'two fetchpriority=high images', rule: 'lcp-image', mutate: (d) => edit(d, FR_P, (s) => s.replace('</h1>', `</h1><img src="/img/p1-360.avif" srcset="${srcset('p1')}" width="360" height="360" alt="" fetchpriority="high">`)) },
  { name: 'LCP image is lazy', rule: 'lcp-image', mutate: (d) => edit(d, FR_P, (s) => s.replace('alt="Pack cuisine" fetchpriority="high">', 'alt="Pack cuisine" fetchpriority="high" loading="lazy">')) },
  {
    name: 'image preload matching no image', rule: 'lcp-image',
    mutate: (d) => {
      for (const w of [360, 480, 720, 960, 1200]) put(d, `img/o-${w}.avif`, fakeAvif(w, 2000));
      put(d, 'image-manifest.json', manifestJson({ p1: 1600, c1: 1600, o: 1600 }));
      edit(d, FR_P, before(HEAD_END, `<link rel="preload" as="image" imagesrcset="${srcset('o')}" imagesizes="100vw">`));
    },
  },

  // avif (QA: 30 KB at 720w; missing 960w)
  { name: 'AVIF at 720w is 30 KB', rule: 'avif', mutate: (d) => put(d, 'img/p1-720.avif', fakeAvif(720, 30000)) },
  {
    name: 'srcset lacks 960w', rule: 'avif', allow: ['critical-path'],
    mutate: (d) => edit(d, FR_P, (s) => s.split(srcset('p1')).join(srcset('p1', [360, 480, 720, 1200]))),
  },
  { name: 'descriptor does not match the file width', rule: 'avif', mutate: (d) => put(d, 'img/c1-480.avif', fakeAvif(500, 4000)) },
  { name: '.avif that is not an AVIF', rule: 'avif', mutate: (d) => put(d, 'img/c1-360.avif', Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), noise(3000)])) },
  { name: 'density descriptors on an AVIF srcset', rule: 'avif', mutate: (d) => edit(d, FR_H, (s) => s.replace(srcset('c1'), `${srcset('c1')}, /img/c1-1200.avif 2x`)) },
  { name: 'AVIF over budget behind a plain <img src>', rule: 'avif', mutate: (d) => { put(d, 'img/x.avif', fakeAvif(800, 26000)); edit(d, FR_H, (s) => s.replace('</main>', '<img src="/img/x.avif" loading="lazy" alt=""></main>')); } },

  // third-party (QA: preconnect + image from another origin)
  { name: 'preconnect to Turnstile', rule: 'third-party', mutate: (d) => edit(d, FR_P, before(HEAD_END, '<link rel="preconnect" href="https://challenges.cloudflare.com">')) },
  { name: 'dns-prefetch', rule: 'third-party', mutate: (d) => edit(d, FR_P, before(HEAD_END, '<link rel="dns-prefetch" href="//challenges.cloudflare.com">')) },
  { name: 'image from a CDN', rule: 'third-party', allow: ['avif'], mutate: (d) => edit(d, FR_H, (s) => s.replace('</main>', '<img src="https://cdn.example.com/x.avif" loading="lazy" alt=""></main>')) },
  { name: 'srcset candidate on another origin', rule: 'third-party', mutate: (d) => edit(d, FR_H, (s) => s.replace(srcset('c1'), `${srcset('c1')}, https://cdn.example.com/c-1600.avif 1600w`)) },
  { name: 'static Turnstile <script src>', rule: 'third-party', mutate: (d) => edit(d, FR_P, before(BODY_END, '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" defer></script>')) },
  { name: 'third-party URL in an inline script', rule: 'third-party', mutate: (d) => edit(d, FR_P, before(BODY_END, '<script type="module">import("https://challenges.cloudflare.com/turnstile/v0/api.js")</script>')) },
  { name: 'third-party url() in CSS', rule: 'third-party', allow: ['critical-path', 'avif'], mutate: (d) => edit(d, FR_H, (s) => s.replace('<style>', '<style>.h{background:url(https://cdn.example.com/bg.avif)}')) },
  { name: 'third-party url() in a style attribute', rule: 'third-party', allow: ['avif'], mutate: (d) => edit(d, FR_H, (s) => s.replace('<footer>', '<footer style="background:url(\'https://cdn.example.com/f.png\')">')) },
  { name: 'tracker in <noscript>', rule: 'third-party', allow: ['avif'], mutate: (d) => edit(d, FR_H, before(BODY_END, '<noscript><img src="https://tracker.example/p.gif" alt=""></noscript>')) },
  { name: 'third-party favicon', rule: 'third-party', mutate: (d) => edit(d, FR_H, before(HEAD_END, '<link rel="icon" href="https://cdn.example.com/favicon.ico">')) },
  { name: 'iframe widget', rule: 'third-party', mutate: (d) => edit(d, FR_H, (s) => s.replace('</main>', '<iframe src="https://widget.example/chat" title="chat" loading="lazy"></iframe></main>')) },

  // fr-font
  { name: '/fr/ preloads the Arabic font', rule: 'fr-font', mutate: (d) => edit(d, FR_P, before(HEAD_END, `<link rel="preload" href="${FONT}" as="font" type="font/woff2" crossorigin>`)) },
  { name: '/fr/ prefetches the Arabic font', rule: 'fr-font', mutate: (d) => edit(d, FR_H, before(HEAD_END, `<link rel="prefetch" href="${FONT}">`)) },
  { name: '/fr/ preloads a Latin web font', rule: 'fr-font', allow: ['critical-path'], mutate: (d) => { put(d, 'font/inter.woff2', noise(20000, 2)); edit(d, FR_H, before(HEAD_END, '<link rel="preload" href="/font/inter.woff2" as="font" crossorigin>')); } },

  // ar-font (QA: Arabic page without font preload)
  { name: '/ar/ font not preloaded', rule: 'ar-font', mutate: (d) => edit(d, AR_P, (s) => s.replace(/<link rel="preload" href="\/font[^>]*>/, '')) },
  { name: 'font-display: swap', rule: 'ar-font', mutate: (d) => edit(d, AR_H, (s) => s.replace('font-display:optional', 'font-display:swap')) },
  { name: 'font-display unset', rule: 'ar-font', mutate: (d) => edit(d, AR_H, (s) => s.replace('font-display:optional;', '')) },
  { name: 'font preload without crossorigin', rule: 'ar-font', mutate: (d) => edit(d, AR_H, (s) => s.replace('type="font/woff2" crossorigin>', 'type="font/woff2">')) },
  {
    name: 'second Arabic font file (bold)', rule: 'ar-font', allow: ['critical-path'],
    mutate: (d) => {
      put(d, 'font/noto-sans-arabic-700.woff2', noise(11800, 8));
      edit(d, AR_H, (s) => s.replace('<style>', '<style>@font-face{font-family:"Noto Sans Arabic";src:url(/font/noto-sans-arabic-700.woff2) format("woff2");font-weight:700;font-display:optional}'));
    },
  },
  { name: 'unused font preload', rule: 'ar-font', allow: ['critical-path'], mutate: (d) => { put(d, 'font/x.woff2', noise(100, 6)); edit(d, AR_H, before(HEAD_END, '<link rel="preload" href="/font/x.woff2" as="font" crossorigin>')); } },

  // html-lang-dir
  { name: 'ar page with dir="ltr"', rule: 'html-lang-dir', mutate: (d) => edit(d, AR_H, (s) => s.replace('dir="rtl"', 'dir="ltr"')) },
  { name: 'fr page with lang="ar"', rule: 'html-lang-dir', mutate: (d) => edit(d, FR_H, (s) => s.replace('lang="fr-DZ"', 'lang="ar"')) },
  { name: 'fr page without dir', rule: 'html-lang-dir', mutate: (d) => edit(d, FR_H, (s) => s.replace(' dir="ltr"', '')) },
  { name: 'page outside /ar/ /fr/ without lang', rule: 'html-lang-dir', allow: ['css-inline'], mutate: (d) => put(d, '404.html', '<!doctype html><html><head><title>404</title></head><body><h1>404</h1></body></html>') },

  // missing-asset
  { name: 'LCP image file missing', rule: 'missing-asset', mutate: (d) => rmSync(path.join(d, 'img/p1-960.avif')) },
  { name: 'lazily referenced script missing', rule: 'missing-asset', mutate: (d) => edit(d, 'js/order.js', (s) => `${s}\nconst x = '/js/nope.js';\n`) },
  { name: 'data-js module missing', rule: 'missing-asset', mutate: (d) => edit(d, FR_H, (s) => s.replace('<main id="main">', '<main id="main" data-js="/js/order.js /js/nope.js">')) },
  { name: 'Arabic font file missing', rule: 'missing-asset', mutate: (d) => rmSync(path.join(d, FONT.slice(1))) },

  // ---- r2: every raster image is an AVIF srcset (rev-c Important 1; one fixture per escape route)
  {
    name: 'JPEG hero with two widths (rev-c probe)', rule: 'avif',
    mutate: (d) => {
      put(d, 'img/h-360.jpg', noise(9000, 21)); put(d, 'img/h-960.jpg', noise(30000, 22));
      edit(d, FR_P, (s) => s.replace(/<picture>[\s\S]*?<\/picture>/, '<img src="/img/h-960.jpg" srcset="/img/h-360.jpg 360w, /img/h-960.jpg 960w" sizes="100vw" width="960" height="960" alt="x" fetchpriority="high">')
        .replace(/<link rel="preload" as="image"[^>]*>/, ''));
    },
  },
  {
    name: 'single 1200 px AVIF hero without srcset (rev-c probe)', rule: 'avif',
    mutate: (d) => edit(d, FR_P, (s) => s.replace(/<picture>[\s\S]*?<\/picture>/, '<img src="/img/p1-1200.avif" width="1200" height="1200" alt="x" fetchpriority="high">')
      .replace(/<link rel="preload" as="image"[^>]*>/, '<link rel="preload" as="image" href="/img/p1-1200.avif" fetchpriority="high">')),
  },
  {
    name: '<picture> without an AVIF source', rule: 'avif',
    mutate: (d) => { put(d, 'img/h.webp', noise(9000, 23)); edit(d, FR_P, (s) => s.replace('<source type="image/avif"', '<source type="image/webp" srcset="/img/h.webp 720w"><source type="image/x-none"')); },
  },
  { name: 'plain <img src> card image without srcset', rule: 'avif', mutate: (d) => edit(d, FR_H, (s) => s.replace('</main>', '<img src="/img/c1-360.avif" loading="lazy" width="360" height="360" alt=""></main>')) },
  { name: 'PNG card image', rule: 'avif', mutate: (d) => { put(d, 'img/c.png', noise(3000, 24)); edit(d, FR_H, (s) => s.replace('</main>', '<img src="/img/c.png" loading="lazy" width="10" height="10" alt=""></main>')); } },
  { name: 'raster data: URI image', rule: 'avif', mutate: (d) => edit(d, FR_H, (s) => s.replace('</main>', `<img src="data:image/png;base64,${noise(300, 25).toString('base64')}" alt=""></main>`)) },
  { name: 'raster CSS background (url)', rule: 'avif', mutate: (d) => edit(d, FR_H, (s) => s.replace('<style>', '<style>.h{background:url(/img/c1-720.avif)}')) },
  { name: 'raster CSS background (image-set string)', rule: 'avif', mutate: (d) => edit(d, FR_H, (s) => s.replace('<style>', '<style>.h{background-image:image-set("/img/c1-720.avif" type("image/avif"))}')) },
  { name: 'raster data: URI in CSS', rule: 'avif', mutate: (d) => edit(d, FR_H, (s) => s.replace('<style>', `<style>.h{background:url(data:image/png;base64,${noise(60, 26).toString('base64')})}`)) },
  { name: 'raster style="" background', rule: 'avif', mutate: (d) => edit(d, FR_H, (s) => s.replace('<footer>', '<footer style="background:url(/img/c1-480.avif)">')) },
  { name: 'raster <video poster>', rule: 'avif', mutate: (d) => edit(d, FR_H, (s) => s.replace('</main>', '<video poster="/img/c1-720.avif" controls></video></main>')) },
  { name: 'raster <input type=image>', rule: 'avif', mutate: (d) => edit(d, FR_P, (s) => s.replace('<button type="submit">', '<input type="image" src="/img/c1-360.avif" alt="ok"><button type="submit">')) },
  { name: 'image preload without imagesrcset', rule: 'avif', mutate: (d) => edit(d, FR_P, before(HEAD_END, '<link rel="preload" as="image" href="/img/p1-960.avif">')) },
  {
    name: 'non-AVIF fallback inside <picture> over 25 KB at ≤ 960 w', rule: 'avif',
    mutate: (d) => { put(d, 'img/p1-720.jpg', noise(30000, 27)); edit(d, FR_P, (s) => s.replace('<img src="/img/p1-720.avif"', '<img src="/img/p1-720.jpg"')); },
  },

  // ---- r2: never upscaled (lead ruling from rev-c's CAT-4 review): widths come from the original
  {
    name: 'original ≥ 1200 px but 1200w missing', rule: 'avif', allow: ['critical-path'],
    mutate: (d) => edit(d, FR_P, (s) => s.split(srcset('p1')).join(srcset('p1', [360, 480, 720, 960]))),
  },
  {
    name: '960 px original: a 1200w candidate is an upscale', rule: 'avif',
    mutate: (d) => put(d, 'image-manifest.json', manifestJson({ p1: 1600, c1: 960 })),
  },
  {
    name: '1000 px original: the 1000w (original-width) candidate is missing', rule: 'avif',
    mutate: (d) => { put(d, 'image-manifest.json', manifestJson({ p1: 1600, c1: 1000 })); edit(d, FR_H, (s) => s.replace(srcset('c1'), srcset('c1', [360, 480, 720, 960]))); },
  },
  { name: 'no image manifest', rule: 'avif', mutate: (d) => rmSync(path.join(d, 'image-manifest.json')) },
  { name: 'image missing from the manifest', rule: 'avif', mutate: (d) => put(d, 'image-manifest.json', manifestJson({ p1: 1600 })) },
  { name: 'manifest entry without an original width', rule: 'avif', mutate: (d) => put(d, 'image-manifest.json', manifestJson({ p1: 1600, c1: null })) },

  // ---- r2: nits and qa BUG-3..8 ("anything that can fetch or reference a URL must be seen")
  { name: 'bare-relative .js literal over budget (rev-c Nit 1)', rule: 'js-after-lcp', mutate: (d) => { put(d, 'js/big.js', `const k="${noiseText(14000)}";`); edit(d, 'js/order.js', (s) => `${s}\nconst x = document.createElement('script'); x.src = 'big.js';\n`); } },
  { name: 'new Worker(new URL("w.js", import.meta.url)) over budget', rule: 'js-after-lcp', mutate: (d) => { put(d, 'js/w.js', `const k="${noiseText(14000)}";`); edit(d, 'js/order.js', (s) => `${s}\nnew Worker(new URL('w.js', import.meta.url));\n`); } },
  { name: 'formaction="javascript:" (rev-c Nit 2)', rule: 'js-inline-handler', mutate: (d) => edit(d, FR_P, (s) => s.replace('<button type="submit">', '<button type="submit" formaction="javascript:go()">')) },
  { name: 'SVG xlink:href="javascript:"', rule: 'js-inline-handler', mutate: (d) => edit(d, FR_H, (s) => s.replace('</main>', '<svg><a xlink:href="javascript:go()"><text>x</text></a></svg></main>')) },
  { name: 'java&#x09;script: (qa BUG-7)', rule: 'js-inline-handler', mutate: (d) => edit(d, FR_H, (s) => s.replace('</footer>', '<a href="java&#x09;script:go()">x</a></footer>')) },
  {
    name: '<video poster> before the LCP counts (rev-c Nit 3)', rule: 'critical-path',
    mutate: (d) => { put(d, 'img/poster.svg', `<svg xmlns="http://www.w3.org/2000/svg"><!--${noiseText(40000)}--></svg>`); edit(d, FR_P, (s) => s.replace('</header>', '<video poster="/img/poster.svg"></video></header>')); },
  },
  {
    name: '<input type=image> before the LCP counts', rule: 'critical-path',
    mutate: (d) => { put(d, 'img/i.svg', `<svg xmlns="http://www.w3.org/2000/svg"><!--${noiseText(40000)}--></svg>`); edit(d, FR_P, (s) => s.replace('</header>', '<input type="image" src="/img/i.svg" alt="go"></header>')); },
  },
  {
    name: 'style="" url() before the LCP counts (qa BUG-8)', rule: 'critical-path',
    mutate: (d) => { put(d, 'img/s.svg', `<svg xmlns="http://www.w3.org/2000/svg"><!--${noiseText(40000)}--></svg>`); edit(d, FR_P, (s) => s.replace('</header>', '<div style="background:url(/img/s.svg)">.</div></header>')); },
  },
  { name: '<template shadowrootmode> renders (rev-c Nit 4, qa BUG-4)', rule: 'third-party', allow: ['avif'], mutate: (d) => edit(d, FR_H, (s) => s.replace('</main>', '<div><template shadowrootmode="open"><img src="https://cdn.example.com/x.avif" alt=""></template></div></main>')) },
  { name: '<iframe srcdoc> content', rule: 'third-party', mutate: (d) => edit(d, FR_H, (s) => s.replace('</main>', '<iframe title="x" srcdoc="&lt;img src=https://cdn.example.com/x.png&gt;"></iframe></main>')) },
  { name: 'CSS image-set() string URL (qa BUG-3)', rule: 'third-party', allow: ['avif', 'critical-path'], mutate: (d) => edit(d, FR_H, (s) => s.replace('<style>', '<style>.h{background-image:-webkit-image-set("https://cdn.example.com/a.avif" 1x)}')) },
  { name: 'CSS escaped url', rule: 'third-party', allow: ['avif', 'critical-path'], mutate: (d) => edit(d, FR_H, (s) => s.replace('<style>', '<style>.h{background:url("\\68ttps://cdn.example.com/a.png")}')) },
  { name: '<a ping> to another origin', rule: 'third-party', mutate: (d) => edit(d, FR_H, (s) => s.replace('rel="noopener">WhatsApp', 'rel="noopener" ping="https://track.example/p">WhatsApp')) },
  { name: 'script after a comment closed by --!> (qa BUG-5)', rule: 'js-before-lcp', mutate: (d) => edit(d, FR_H, before(HEAD_END, '<!--x--!><script>var a=1</script>')) },
  { name: 'font-display: optional only inside a CSS comment (qa BUG-6)', rule: 'ar-font', mutate: (d) => edit(d, AR_H, (s) => s.replace('font-display:optional', '/* font-display: optional */font-display:swap')) },
];

describe('each rule fails on its fixture', () => {
  it('covers every rule', () => {
    // 'runtime' (page fails to load in Chrome) has its failing fixture in test/runtime.test.ts
    const covered = new Set<RuleId>([...CASES.map((c) => c.rule), 'runtime']);
    expect(Object.keys(RULES).filter((r) => !covered.has(r as RuleId))).toEqual([]);
  });

  for (const c of CASES) {
    it(`${c.rule}: ${c.name}`, () => {
      const dir = freshSite();
      c.mutate(dir);
      const r = checkSite(dir);
      const rules = rulesOf(r);
      expect(r.ok).toBe(false);
      expect(rules, dump(r)).toContain(c.rule);
      const allowed = new Set<RuleId>([c.rule, ...(c.allow ?? [])]);
      expect(rules.filter((x) => !allowed.has(x)), dump(r)).toEqual([]);
    });
  }
});

describe('positive controls (things that must NOT fail)', () => {
  const ok = (name: string, mutate: (d: string) => void) => it(name, () => {
    const dir = freshSite();
    mutate(dir);
    const r = checkSite(dir);
    expect(dump(r)).toBe('[]');
  });
  it('absolute URLs on the own origin pass only when the origin is declared', () => {
    const dir = freshSite();
    edit(dir, FR_H, (s) => s.replace('</main>', `<img src="https://hbdestockage.dz/img/c1-360.avif" srcset="${srcset('c1').replaceAll('/img/', 'https://hbdestockage.dz/img/')}" loading="lazy" alt=""></main>`));
    expect([...new Set(rulesOf(checkSite(dir)))]).toEqual(['third-party']);
    expect(checkSite(dir, { ownOrigins: ['https://hbdestockage.dz'] }).ok).toBe(true);
  });
  ok('navigation links to other origins (wa.me, tel:) are fine', (d) => edit(d, FR_H, (s) => s.replace('</footer>', '<a href="https://www.facebook.com/hbdestockage">Facebook</a></footer>')));
  ok('JSON-LD with absolute URLs is fine', (d) => edit(d, FR_H, before(HEAD_END, '<script type="application/ld+json">{"@context":"https://schema.org","url":"https://example.com/"}</script>')));
  ok('third-party URLs inside <template> are inert', (d) => edit(d, FR_H, before(BODY_END, '<template><img src="https://cdn.example.com/t.avif" alt=""></template>')));
  ok('inline module script after the LCP element is fine', (d) => edit(d, FR_P, before(BODY_END, '<script type="module">document.body.dataset.ready="1"</script>')));
  ok('the shared sheet may declare the Arabic @font-face on /fr/ (lead ruling F2; runtime pass checks the download)', (d) => edit(d, FR_H, (s) => s.replace('<style>', `<style>@font-face{font-family:"Noto Sans Arabic";src:url(${FONT}) format("woff2");font-display:optional;unicode-range:U+0600-06FF}`)));
  ok('SVG images are exempt from the AVIF rule (logos, icons)', (d) => { put(d, 'img/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'); edit(d, FR_H, (s) => s.replace('</header>', '<img src="/img/logo.svg" width="10" height="10" alt="HB"></header>')); });
  ok('<!--> empty comments do not hide what follows... and a commented-out script is ignored', (d) => edit(d, FR_H, before(HEAD_END, '<!-- <script src="/js/order.js"></script> -->')));
  ok('<source> inside <video> is not an image', (d) => { put(d, 'v.mp4', noise(100, 30)); edit(d, FR_H, (s) => s.replace('</main>', '<video controls preload="none"><source src="/v.mp4" type="video/mp4"></video></main>')); });
  ok('a 960 px original needs only 360/480/720/960 w', (d) => {
    put(d, 'image-manifest.json', manifestJson({ p1: 1600, c1: 960 }));
    edit(d, FR_H, (s) => s.replace(srcset('c1'), srcset('c1', [360, 480, 720, 960])));
    edit(d, AR_H, (s) => s.replace(srcset('c1'), srcset('c1', [360, 480, 720, 960])));
    edit(d, FR_P, (s) => s.replace(srcset('c1'), srcset('c1', [360, 480, 720, 960])));
    edit(d, AR_P, (s) => s.replace(srcset('c1'), srcset('c1', [360, 480, 720, 960])));
  });
  ok('a 1000 px original: 360/480/720/960 + 1000 w', (d) => {
    put(d, 'image-manifest.json', manifestJson({ p1: 1600, c1: 1000 }));
    put(d, 'img/c1-1000.avif', fakeAvif(1000, 15000));
    for (const f of [FR_H, AR_H, FR_P, AR_P]) edit(d, f, (s) => s.replace(srcset('c1'), `${srcset('c1', [360, 480, 720, 960])}, /img/c1-1000.avif 1000w`));
  });
  ok('data: URIs are fine', (d) => edit(d, FR_H, (s) => s.replace('<style>', '<style>.i{background:url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E")}')));
});

describe('cli', () => {
  const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/budget/cli.ts');
  const run = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

  it('exits 0 and writes JSON + table for the good site (static + Chrome runtime pass)', { timeout: 240_000 }, () => {
    const dir = freshSite();
    const out = mkdtempSync(path.join(tmpdir(), 'hb-budget-out-'));
    const res = run(['--dist', dir, '--out', out]);
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toContain('BUDGET OK');
    const json = JSON.parse(readFileSync(path.join(out, 'budget.json'), 'utf8')) as SiteReport & { runtime: { ran: boolean; results: unknown[] } };
    expect(json.ok).toBe(true);
    expect(json.runtime.ran).toBe(true);
    expect(json.runtime.results.length).toBeGreaterThan(4);
    expect(existsSync(path.join(out, 'budget.txt'))).toBe(true);
    rmSync(out, { recursive: true });
  });

  it('exits 1 on a violation and names it', () => {
    const dir = freshSite();
    put(dir, 'img/p1-720.avif', fakeAvif(720, 30000));
    const out = mkdtempSync(path.join(tmpdir(), 'hb-budget-out-'));
    const res = run(['--dist', dir, '--out', out, '--quiet', '--static-only']);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('not valid for the gate');
    expect(res.stdout).toMatch(/\[avif\] \/img\/p1-720\.avif: 30000 B/);
    expect(res.stdout).toContain('BUDGET FAILED');
    rmSync(out, { recursive: true });
  });

  it('exits non-zero when dist does not exist', () => {
    const out = mkdtempSync(path.join(tmpdir(), 'hb-budget-out-'));
    const res = run(['--dist', path.join(out, 'nope'), '--out', out]);
    expect(res.status).toBe(1);
    expect(res.stdout).toContain('[site] dist not found');
    rmSync(out, { recursive: true });
  });

  it('exits 2 on an unknown flag', () => {
    expect(run(['--bogus']).status).toBe(2);
  });
});
