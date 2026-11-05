/**
 * qa's 62 false-pass probes for the budget checker (artifacts/qa/scripts/meas-probes.mjs, QA-1
 * dry run artifacts/QA-1/meas1-dryrun/results.md), adopted as tests (lead, MEAS-1 r2). Each probe
 * mutates qa's own baseline site; a probe passes when its expected rule fires (other rules may
 * fire too), or, for 'PASS', when the site has no violation at all.
 * Changes from qa's table: 19 → avif (r2: raster CSS backgrounds fail the AVIF rule);
 * 36 → PASS (lead ruling F2: an unused Arabic @font-face on /fr/ is not a static violation).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkSite } from '../src/budget/check.ts';
import { fakeAvif as avif, noise } from './fixtures/site.ts';

type Probe = [string, string, (d: string) => void];

const W = [360, 480, 720, 960, 1200];
const SZ: Record<number, number> = { 360: 5000, 480: 8000, 720: 12000, 960: 18000, 1200: 28000 };
const FONT = '/f/ar.woff2';
const ss = (stem: string, ext = '.avif'): string => W.map((w) => `/img/${stem}-${w}${ext} ${w}w`).join(', ');
const css = (lang: string): string => `${lang === 'ar' ? `@font-face{font-family:A;src:url(${FONT}) format("woff2");font-display:optional}` : ''}body{margin:0;font:16px/1.6 system-ui}.w{margin-inline:auto;max-inline-size:1200px}/*STYLE*/`;
const page = (lang: string): string => `<!doctype html>
<html lang="${lang}" dir="${lang === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>T</title>
${lang === 'ar' ? `<link rel="preload" href="${FONT}" as="font" type="font/woff2" crossorigin>` : ''}
<style>${css(lang)}</style>
<!--HEAD-->
</head><body BODYATTR><a href="/${lang}/" HREFATTR>home</a>
<!--PRE-->
<picture><source type="image/avif" srcset="${ss('h')}" sizes="100vw"><img src="/img/h-720.avif" width="720" height="720" alt="x" fetchpriority="high"></picture>
<h1>Titre</h1>
<!--POST-->
<script type="module" src="/js/o.js"></script>
</body></html>`;
function base(dir: string, { onlyAr = false } = {}): void {
  const w = (rel: string, data: string | Buffer): void => { const p = join(dir, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); };
  for (const l of onlyAr ? ['ar'] : ['ar', 'fr']) w(`${l}/index.html`, page(l));
  for (const x of W) w(`img/h-${x}.avif`, avif(x, SZ[x] ?? 0));
  w(FONT.slice(1), Buffer.concat([Buffer.from('wOF2'), noise(11000, 3)]));
  w('js/o.js', 'document.querySelector("h1").dataset.x=1;\n');
  w('js/a.js', 'console.log(1);\n');
  w('s.css', 'body{color:red}');
}
const edit = (dir: string, rel: string, fn: (s: string) => string): void => { const p = join(dir, rel); const b = readFileSync(p, 'utf8'); const a = fn(b); if (a === b) throw new Error('no change ' + rel); writeFileSync(p, a); };
const both = (dir: string, fn: (s: string) => string): void => { for (const l of ['ar', 'fr']) edit(dir, `${l}/index.html`, fn); };
const at = (marker: string, s: string) => (h: string): string => h.replace(`<!--${marker}-->`, s);
const css2 = (s: string) => (h: string): string => h.replace('/*STYLE*/', s);
const EV = 'https://evil.example';
const bigJs = (d: string, exp = ''): void => writeFileSync(join(d, 'js/big.js'), `${exp}const s="${noise(15000, 9).toString('base64')}";\n`);

const P: Probe[] = [
  ['00-baseline', 'PASS', () => {}],
  ['01-uppercase-script-before-lcp', 'js-before-lcp', (d) => both(d, at('PRE', '<SCRIPT SRC=/js/a.js></SCRIPT>'))],
  ['02-unquoted-defer-before-lcp', 'js-before-lcp', (d) => both(d, at('PRE', '<script src=/js/a.js defer></script>'))],
  ['03a-type-x-javascript', 'js-before-lcp', (d) => both(d, at('PRE', '<script type="application/x-javascript">var a=1</script>'))],
  ['03b-type-uppercase', 'js-before-lcp', (d) => both(d, at('PRE', '<script type="TEXT/JAVASCRIPT">var a=1</script>'))],
  ['03c-type-ecmascript', 'js-before-lcp', (d) => both(d, at('PRE', '<script type="text/ecmascript">var a=1</script>'))],
  ['03d-language-attr', 'js-before-lcp', (d) => both(d, at('PRE', '<script language="javascript">var a=1</script>'))],
  ['03e-type-padded-module', 'js-before-lcp', (d) => both(d, at('PRE', '<script type=" module ">var a=1</script>'))],
  ['04-svg-script-href', 'js-before-lcp', (d) => both(d, at('PRE', '<svg><script href="/js/a.js"></script></svg>'))],
  ['05-svg-script-third-party', 'third-party', (d) => both(d, at('POST', `<svg><script href="${EV}/x.js"></script></svg>`))],
  ['06-svg-image-xlink', 'third-party', (d) => both(d, at('POST', `<svg><image xlink:href="${EV}/x.png"/></svg>`))],
  ['07-declarative-shadow-dom', 'third-party', (d) => both(d, at('POST', `<div><template shadowrootmode="open"><img src="${EV}/x.png" alt=""></template></div>`))],
  ['08-a-ping', 'third-party', (d) => both(d, (h) => h.replace('HREFATTR', `ping="${EV}/p"`))],
  ['09-body-background', 'third-party', (d) => both(d, (h) => h.replace('BODYATTR', `background="${EV}/bg.png"`))],
  ['10a-src-leading-space', 'third-party', (d) => both(d, at('POST', `<img src=" ${EV}/x.png" alt="" loading="lazy">`))],
  ['10b-src-uppercase-scheme', 'third-party', (d) => both(d, at('POST', `<img src="HTTPS://EVIL.EXAMPLE/x.png" alt="" loading="lazy">`))],
  ['10c-src-backslashes', 'third-party', (d) => both(d, at('POST', `<img src="\\\\evil.example/x.png" alt="" loading="lazy">`))],
  ['10d-src-entity-colon', 'third-party', (d) => both(d, at('POST', `<img src="https&#58;//evil.example/x.png" alt="" loading="lazy">`))],
  ['10e-src-tab-in-scheme', 'third-party', (d) => both(d, at('POST', `<img src="ht&#9;tps://evil.example/x.png" alt="" loading="lazy">`))],
  ['11a-css-URL-uppercase', 'third-party', (d) => both(d, css2(`.w{background:URL(${EV}/a.png)}`))],
  ['11b-css-image-set-string', 'third-party', (d) => both(d, css2(`.w{background-image:image-set("${EV}/a.avif" type("image/avif"))}`))],
  ['11c-css-webkit-image-set', 'third-party', (d) => both(d, css2(`.w{background-image:-webkit-image-set("${EV}/a.avif" 1x)}`))],
  ['11d-css-escaped-url', 'third-party', (d) => both(d, css2(`.w{background:url("\\68ttps://evil.example/a.png")}`))],
  ['12-iframe-srcdoc', 'third-party', (d) => both(d, at('POST', `<iframe title="x" srcdoc="&lt;img src=${EV}/x.png&gt;"></iframe>`))],
  ['13-noscript-stylesheet', 'css-inline', (d) => both(d, at('HEAD', '<noscript><link rel=stylesheet href=/s.css></noscript>'))],
  ['14a-rel-STYLESHEET', 'css-inline', (d) => both(d, at('HEAD', '<link rel="STYLESHEET" href=/s.css>'))],
  ['14b-alternate-stylesheet', 'css-inline', (d) => both(d, at('HEAD', '<link rel="alternate stylesheet" href=/s.css title=x>'))],
  ['15a-IMPORT-uppercase', 'css-inline', (d) => both(d, css2('@IMPORT url(/s.css);'))],
  ['15b-import-string', 'css-inline', (d) => both(d, css2('@import "/s.css";'))],
  ['15c-svg-style-element', 'css-inline', (d) => both(d, at('POST', '<svg><style>.q{fill:red}</style></svg>'))],
  ['16-font-display-in-comment', 'ar-font', (d) => edit(d, 'ar/index.html', (h) => h.replace('font-display:optional', '/* font-display: optional */font-display:swap'))],
  ['17a-javascript-url-spaced-case', 'js-inline-handler', (d) => both(d, (h) => h.replace(' HREFATTR', '').replace(/<a href="\//, '<a href="  JaVaScRiPt:alert(1)" data-x="/'))],
  ['17b-javascript-url-tab-entity', 'js-inline-handler', (d) => both(d, (h) => h.replace(' HREFATTR', '').replace(/<a href="\//, '<a href="java&#x09;script:alert(1)" data-x="/'))],
  ['17c-ONCLICK-uppercase', 'js-inline-handler', (d) => both(d, (h) => h.replace('HREFATTR', 'ONCLICK="x()"'))],
  ['17d-svg-onbegin', 'js-inline-handler', (d) => both(d, at('POST', '<svg><animate onbegin="x()" attributeName="x" dur="1s"/></svg>'))],
  ['18-avif-no-extension-oversize', 'avif', (d) => { for (const x of W) writeFileSync(join(d, `img/n-${x}`), avif(x, x <= 960 ? 30000 : 40000)); both(d, at('POST', `<picture><source type="image/avif" srcset="${ss('n', '')}" sizes="100vw"><img src="/img/n-720" alt="" loading="lazy" width="720" height="720"></picture>`)); }],
  ['19-css-background-avif-oversize', 'avif' /* r2: any raster CSS background fails avif */, (d) => { writeFileSync(join(d, 'img/bg-720.avif'), avif(720, 30000)); both(d, css2('.w{background:url(/img/bg-720.avif)}')); }],
  ['20a-img-src-query-oversize', 'avif', (d) => { writeFileSync(join(d, 'img/q-720.avif'), avif(720, 30000)); both(d, at('POST', '<img src="/img/q-720.avif?v=2" alt="" loading="lazy" width="720" height="720">')); }],
  ['20b-module-js-query-oversize', 'js-after-lcp', (d) => { bigJs(d); both(d, at('POST', '<script type=module src="/js/big.js?v=1"></script>')); }],
  ['20c-worker-js-new-URL', 'js-after-lcp', (d) => { bigJs(d); edit(d, 'js/o.js', (s) => s + 'new Worker(new URL("./big.js", import.meta.url));\n'); }],
  ['20d-relative-import-oversize', 'js-after-lcp', (d) => { bigJs(d, 'export '); edit(d, 'js/o.js', (s) => 'import "./big.js";\n' + s); }],
  ['21-only-ar-pages', 'site', () => {}],
  ['22a-dir-RTL-uppercase', 'PASS', (d) => edit(d, 'ar/index.html', (h) => h.replace('dir="rtl"', 'dir="RTL"'))],
  ['22b-ar-dir-ltr', 'html-lang-dir', (d) => edit(d, 'ar/index.html', (h) => h.replace('dir="rtl"', 'dir="ltr"'))],
  ['22c-fr-page-lang-ar', 'html-lang-dir', (d) => edit(d, 'fr/index.html', (h) => h.replace('lang="fr" dir="ltr"', 'lang="ar" dir="rtl"'))],
  ['23-five-critical-requests', 'critical-path', (d) => { for (const n of ['a', 'b', 'c', 'e']) writeFileSync(join(d, `img/${n}.png`), noise(500, 5)); both(d, at('PRE', ['a', 'b', 'c', 'e'].map((n) => `<img src="/img/${n}.png" alt="" width="10" height="10">`).join(''))); }],
  ['24-style-attr-bg-requests', 'critical-path', (d) => { for (const n of ['a', 'b', 'c', 'e']) writeFileSync(join(d, `img/${n}.png`), noise(500, 5)); both(d, at('PRE', ['a', 'b', 'c', 'e'].map((n) => `<div style="background:url(/img/${n}.png)">.</div>`).join(''))); }],
  ['25-lcp-LAZY-uppercase', 'lcp-image', (d) => both(d, (h) => h.replace('fetchpriority="high"', 'FETCHPRIORITY="HIGH" LOADING="LAZY"'))],
  ['26-inline-script-protocol-relative', 'third-party', (d) => both(d, at('POST', '<script>fetch("//evil.example/x")</script>'))],
  ['27a-commented-script-before-lcp', 'PASS', (d) => both(d, at('PRE', '<!-- <script src=/js/a.js></script> -->'))],
  ['27b-text-plain-script-before-lcp', 'PASS', (d) => both(d, at('PRE', '<script type="text/plain">x</script>'))],
  ['27c-script-in-title-text', 'PASS', (d) => both(d, (h) => h.replace('<title>T</title>', '<title>&lt;script src=/js/a.js&gt;</title>'))],
  ['28-textarea-then-script', 'js-before-lcp', (d) => both(d, at('PRE', '<textarea aria-label="x"></textarea><script>var a=1</script>'))],
  ['29-comment-closed-by--!>', 'js-before-lcp', (d) => both(d, at('PRE', '<!--x--!><script>var a=1</script>'))],
  ['30-empty-comment', 'js-before-lcp', (d) => both(d, at('PRE', '<!----><script>var a=1</script>'))],
  ['31-attr-with-gt-in-value', 'js-before-lcp', (d) => both(d, at('PRE', '<div title="a>b"><script>var a=1</script></div>'))],
  ['32-preload-third-party-font', 'third-party', (d) => both(d, at('HEAD', `<link rel="PRELOAD" as="font" href="${EV}/f.woff2" crossorigin>`))],
  ['33-meta-refresh-third', 'third-party', (d) => both(d, at('HEAD', `<meta http-equiv="Refresh" content="5; URL='${EV}/'">`))],
  ['34-link-icon-third', 'third-party', (d) => both(d, at('HEAD', `<link rel="icon" href="${EV}/i.png">`))],
  ['35-embed', 'third-party', (d) => both(d, at('POST', `<embed src="${EV}/x.svg" type="image/svg+xml">`))],
  ['36-fr-font-via-local-and-url', 'PASS' /* lead ruling F2: an unused @font-face on /fr/ is allowed statically; runtime.test.ts proves downloads fail */, (d) => edit(d, 'fr/index.html', css2(`@font-face{font-family:B;src:local("Noto Sans Arabic"),url(/f/ar.woff2) format("woff2")}`))],
  ['37-ar-two-font-files', 'ar-font', (d) => { writeFileSync(join(d, 'f/ar2.woff2'), Buffer.concat([Buffer.from('wOF2'), noise(3000, 4)])); edit(d, 'ar/index.html', css2('@font-face{font-family:C;src:url(/f/ar2.woff2) format("woff2");font-display:optional}')); }],
  ['38-html-over-14k', 'html-size', (d) => both(d, at('POST', `<p hidden>${noise(16000, 11).toString('base64')}</p>`))],
];

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

describe("qa's false-pass probes (artifacts/qa/scripts/meas-probes.mjs)", () => {
  it("has all of qa's probes (62 + baseline)", () => { expect(P.length).toBe(63); });
  for (const [id, want, mut] of P) {
    it(`${id} → ${want}`, () => {
      const dir = mkdtempSync(join(tmpdir(), `hb-qa-${id.slice(0, 3)}-`));
      temps.push(dir);
      base(dir, { onlyAr: id.startsWith('21') });
      mut(dir);
      for (const l of ['ar', 'fr']) {
        try { edit(dir, `${l}/index.html`, (h) => h.replace(/<!--(HEAD|PRE|POST)-->/g, '').replace(/ (BODYATTR|HREFATTR)/g, '')); } catch { /* page absent or nothing left */ }
      }
      const r = checkSite(dir);
      const all = [...r.siteViolations, ...r.pages.flatMap((p) => p.violations)];
      const dump = JSON.stringify(all.map((v) => `${v.rule}: ${v.message}`), null, 1);
      if (want === 'PASS') expect(dump).toBe('[]');
      else expect(all.map((v) => v.rule), dump).toContain(want);
    });
  }
});
