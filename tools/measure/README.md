# tools/measure

The storefront's blocking measurement gates (owner: `measure`). They decide whether work is
"green", so **a false pass is as bad as a false failure**: every rule has a fixture that proves
it fails when it should (`test/`).

| Command | What | Status |
|---|---|---|
| `npm run budget` | Static byte-budget checker over the built site (`apps/storefront/dist`) | MEAS-1 |
| `npm run lh` | Lighthouse 13.6.0, median of 5, every template in `/ar/` and `/fr/` | MEAS-2 (todo) |
| `npm run shots` / `npm run axe` | Screenshots 360/768/1440 × ar/fr, axe WCAG 2.2 AA, keyboard pass | MEAS-3 (todo) |
| `npm run e2e` | Playwright end-to-end specs in `tests/e2e/` | MEAS-4 (todo) |

Everything runs on Node 24 directly from TypeScript sources (`node file.ts`, no build step).
Tests: `npm test -w tools/measure` (vitest). Typecheck: `npm run typecheck -w tools/measure`.

## `npm run budget`

```
npm run budget                          # checks apps/storefront/dist
npm run budget -- --dist path/to/dist   # any built site
npm run budget -- --out artifacts/QA-1/budget --quiet
npm run budget -- --own-origin https://hbdestockage.dz   # absolute URLs on this origin are first-party
# without the root script: node tools/measure/src/budget/cli.ts [same flags]
```

- **Output:** `<out>/budget.json` (full report: per-page metrics, every request on the critical
  path, every AVIF checked, violations) and `<out>/budget.txt` (the table printed to stdout).
  Default `<out>` = `<main checkout>/artifacts/budget/` (resolved through git, so it is the same
  from any worktree; override with `--out` or `HB_ARTIFACTS=<dir>`).
- **Exit code:** `0` all rules green · `1` at least one violation (including "dist missing / empty /
  no `/ar/` or `/fr/` pages") · `2` bad flags or internal error.
- No network, no browser, no dependencies beyond Node built-ins; takes a second or two.

### What counts as a page, and its language

Every `*.html` file under dist. Language = first path segment (`ar/…`, `fr/…`); for any other
page (e.g. a root `404.html`) the `<html lang>` attribute. A page whose language cannot be told
fails `html-lang-dir`.

### Budget rules

Numbers live in `src/budget/config.ts` (from CLAUDE.md "Storefront budgets"). Where CLAUDE.md
and the task text differ in units we take the stricter reading: **JS ≤ 10,000 B** (not 10 KiB),
**AVIF ≤ 25,000 B** (not 25 KiB). HTML ≤ 14 KiB = 14,336 B; critical path ≤ 45 KiB = 46,080 B.

**Brotli.** Text (HTML, JS, SVG, CSS, JSON) is compressed at brotli quality 11 *and* 4; the gate
uses the larger. Production may serve pre-compressed q11 or on-the-fly low-level brotli, and we
cannot check which without a deploy, so we never assume the better one. Fonts and images count
raw.

| Rule | Fails when |
|---|---|
| `site` | dist does not exist, has no HTML, or has no page under `/ar/` or `/fr/`. |
| `html-size` | the HTML document (incl. inline CSS and inline scripts) is > 14,336 B brotli. Above the 4–6 KiB target is reported as a non-blocking warning. |
| `css-inline` | not exactly one inline `<style>`; any `<link rel=stylesheet>`, `<link rel=preload as=style>` or `@import`. |
| `js-before-lcp` | see "JS before LCP" below. |
| `js-inline-handler` | any `on*=` attribute or `javascript:` URL (hash-based CSP cannot allow them). |
| `speculation-rules` | `<script type=speculationrules>` with `src`, or whose body is not valid JSON. |
| `js-after-lcp` | the page can load > 10,000 B brotli of JS in total (see "JS after LCP"). |
| `critical-path` | critical bytes > 46,080 B or > 4 requests (see "Critical path"). |
| `lcp-image` | more than one `<img fetchpriority=high>`; the LCP image is `loading=lazy`; an image preload matches no `<img>`/`<source>` on the page. |
| `avif` | an AVIF `srcset` lacks any of 360/480/720/960/1200 `w`, or uses `x` descriptors; a `w` descriptor differs from the file's real width (read from the AVIF `ispe` box); an AVIF at ≤ 960 px wide (declared or real) is > 25,000 B; a `.avif` file is not a readable AVIF. Checked for every `srcset`, `imagesrcset`, `<img src>` and image preload on every page, not only the hero. |
| `third-party` | see "Third-party origins". |
| `fr-font` | a `/fr/` page has any `@font-face`, font preload or font URL (French = system stack, 0 bytes); the message names the Arabic font when it is the one referenced. |
| `ar-font` | an `/ar/` page uses more than one font file; an `@font-face` lacks `font-display: optional`; the font is not preloaded with `<link rel=preload as=font crossorigin>`; a font preload is not used by any `@font-face`. A page with no web font (system-Arabic fallback) passes. |
| `html-lang-dir` | `<html>` missing; `lang` not `ar`/`ar-DZ` on `/ar/` or `fr`/`fr-DZ` on `/fr/`; `dir` not `rtl` / `ltr` respectively (explicit `dir` is required on both). |
| `missing-asset` | a first-party script, preload, font, image candidate or CSS `url()` that a page references does not exist in dist (an unmeasurable file never passes silently). |

#### The LCP element

Determined statically, in this order: the `<img fetchpriority="high">`; else the first `<h1>`;
else the end of the document (everything counts as "before LCP").

#### JS before LCP (`js-before-lcp`)

"0 bytes of JS before LCP" is enforced as:
1. No executable `<script>` (inline or external, any type that runs as JS) appears in document
   order **before the LCP element**.
2. **Anywhere** in the page: no `async` script (it may execute before LCP), no parser-blocking
   external classic script (must be `defer` or `type="module"`), no `<link rel=modulepreload>` and
   no `<link rel=preload as=script>` (they fetch JS at high priority during the critical path).
3. Allowed: inline `<script type="speculationrules">` anywhere; non-JS data blocks
   (`application/ld+json`, `application/json`) and import maps anywhere; after the LCP element,
   inline scripts and external `defer` / `type="module"` scripts.

Lighthouse (MEAS-2: TBT, LCP) is the runtime check of the same property.

#### JS after LCP (`js-after-lcp`)

Sum, per page, of brotli bytes of: every inline executable script + every first-party JS file
reachable from the page. Reachability follows `<script src>`, module preloads, static
`import`/`export … from`, `import()`, and **any string literal naming a `.js`/`.mjs` path**
(`s.src = '/js/turnstile-loader.js'`), recursively. So a lazily injected first-party file counts.
JSON fetched at runtime (commune lists, search index) is not JS and is not counted.

Third-party URLs found inside first-party JS are not violations (that is how Turnstile is
injected on the form's first `focusin`/`pointerdown`); they are listed per page as
`metrics.js.lazyThirdPartyOrigins` in the JSON. Any **static** reference to Turnstile in the
HTML (script, preconnect, dns-prefetch, inline script) fails `third-party`. Consequence for the
order form: the Turnstile loader must live in an external first-party `.js` file, not in an
inline script. Whether the injection really waits for interaction is checked at runtime by
MEAS-3/4 (no third-party request before interaction).

#### Critical path (`critical-path`)

Requests counted, deduplicated by URL:
- the HTML document (brotli bytes, as above);
- every `<link rel=preload>` (any `as`), `modulepreload` and `stylesheet`; an image preload with
  `imagesrcset` counts the candidate the device below would pick;
- the LCP image: the candidate a browser picks from `<picture><source>`/`srcset`/`sizes` at
  **Lighthouse mobile emulation, 412 CSS px × DPR 1.75** (first candidate with density ≥ 1.75;
  Chromium may sometimes pick one smaller, so this errs on the larger file; an unparseable
  `sizes` → the largest candidate);
- every font in an `@font-face` (first `src` URL);
- every external `url()` in the inline CSS other than fonts (static analysis cannot tell which
  rules apply above the fold; use inline SVG or `data:` for decoration);
- every non-lazy `<img>` and external `<script>` before the LCP element.

`<link rel=icon>`, `prefetch`, `preconnect` are not counted as critical requests
(preconnect/dns-prefetch to another origin fails `third-party` anyway).

#### Third-party origins (`third-party`)

Any absolute (`https://…` or `//…`) URL whose origin is not the page's own (or one passed with
`--own-origin`) in: `src`, `srcset`, `imagesrcset`, `poster`, `data` of any element; `href` of a
`<link>` whose `rel` fetches (everything except canonical, alternate, author, license, me,
next, prev, …); SVG `<use>/<image>` `href`; `<base href>`; `<meta http-equiv=refresh>`;
CSS `url()`/`@import` in `<style>` and `style=""`; absolute URLs inside inline executable
scripts, speculation rules and import maps. `<noscript>` content is scanned (no-JS browsers load
it); `<template>` content is not.

Allowed: navigation and submission targets (`<a href>`, `<area href>`, `<form action>`, e.g.
`https://wa.me/213779942022`), `<link rel=canonical|alternate>` with absolute URLs, JSON-LD.

### Adding or changing a rule

1. Change `src/budget/check.ts` (and `RULES`), numbers only in `src/budget/config.ts`
   (with a DECISIONS.md entry if it departs from CLAUDE.md / STACK-REPORT.md).
2. Add a failing case to `CASES` in `test/budget.test.ts` (the test "covers every rule" fails if a
   rule has none) and, if the rule could misfire, a positive control.
3. `npm test -w tools/measure`.

The good fixture site (`test/fixtures/site.ts`) is generated in a temp dir: 4 pages, synthetic
AVIFs with real `ftyp`/`ispe` boxes, a fake woff2, order-form JS that lazily injects a Turnstile
loader. `test/fixtures/real-480x320.avif` is a real AVIF (ffmpeg + libaom) for the parser.
