# tools/measure

The storefront's blocking measurement gates (owner: `measure`). They decide whether work is
"green", so **a false pass is as bad as a false failure**: every rule has a fixture that proves
it fails when it should (`test/`).

| Command | What | Status |
|---|---|---|
| `npm run budget` | Static byte-budget checker over the built site (`apps/storefront/dist`) | MEAS-1 |
| `npm run lh` | Lighthouse 13.6.0, median of 5, every template in `/ar/` and `/fr/` | MEAS-2 |
| `npm run shots` / `npm run axe` | Screenshots 360/768/1440 × ar/fr, axe WCAG 2.2 AA, keyboard pass | MEAS-3 |
| `npm run e2e` | End-to-end specs in `tests/e2e/` (Playwright + vitest) | MEAS-4 |
| `node tools/measure/src/timings/cli.ts` | Local TTFB per template, `/api/quote` and `/api/order` latency, p50/p90 | MEAS-5 |

Everything runs on Node 24 directly from TypeScript sources (`node file.ts`, no build step).
Tests: `npm test -w tools/measure` (vitest). Typecheck: `npm run typecheck -w tools/measure`.

## `npm run budget`

```
npm run budget                          # checks apps/storefront/dist
npm run budget -- --dist path/to/dist   # any built site
npm run budget -- --out artifacts/QA-1/budget --quiet
npm run budget -- --own-origin https://hbdestockage.dz   # absolute URLs on this origin are first-party
npm run budget -- --static-only         # skip the Chrome runtime pass (quick local check; NOT valid for the gate)
# without the root script: node tools/measure/src/budget/cli.ts [same flags]
```

- **Output:** `<out>/budget.json` (full report: per-page metrics, every request on the critical
  path, every AVIF checked, violations) and `<out>/budget.txt` (the table printed to stdout).
  Default `<out>` = `<main checkout>/artifacts/budget/` (resolved through git, so it is the same
  from any worktree; override with `--out` or `HB_ARTIFACTS=<dir>`).
- **Exit code:** `0` all rules green · `1` at least one violation (including "dist missing / empty /
  no `/ar/` or `/fr/` pages") · `2` bad flags or internal error.
- Two passes. **Static** (Node built-ins only, about 2 s): every rule below. **Runtime** (system
  Chrome via Playwright over a local static server of dist): every `/ar/` and `/fr/` page is loaded
  and its real requests recorded (see "Runtime pass"). The runtime pass is part of the gate.

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
| `js-inline-handler` | any `on*=` attribute, or any attribute whose value is a `javascript:` URL after the URL parser's preprocessing (`java&#x09;script:`, `formaction`, SVG `xlink:href`…). Hash-based CSP cannot allow them. |
| `speculation-rules` | `<script type=speculationrules>` with `src`, or whose body is not valid JSON. |
| `js-after-lcp` | the page can load > 10,000 B brotli of JS in total (see "JS after LCP"). |
| `critical-path` | critical bytes > 46,080 B or > 4 requests (see "Critical path"). |
| `lcp-image` | more than one `<img fetchpriority=high>`; the LCP image is `loading=lazy`; an image preload matches no `<img>`/`<source>` on the page. |
| `avif` | see "Images" below: every raster image the page can show must be a same-origin AVIF `srcset` at 360/480/720/960/1200 `w`. |
| `third-party` | see "Third-party origins". |
| `fr-font` | static: a `/fr/` page preloads, prefetches or prerenders a font. Runtime: a `/fr/` page downloads any font (at 360 or 1440 px, after load + idle, or after focusing/hovering every link and button). The shared stylesheet may declare the Arabic `@font-face` on `/fr/` (lead ruling on SHELL-1 F2 / qa BUG-2: one stylesheet for both languages is mandated); STACK-REPORT §5: "give its «العربية» label a system font; otherwise French pages download the Arabic font". |
| `ar-font` | an `/ar/` page uses more than one font file; an `@font-face` lacks `font-display: optional`; the font is not preloaded with `<link rel=preload as=font crossorigin>`; a font preload is not used by any `@font-face`. A page with no web font (system-Arabic fallback) passes. |
| `html-lang-dir` | `<html>` missing; `lang` not `ar`/`ar-DZ` on `/ar/` or `fr`/`fr-DZ` on `/fr/`; `dir` not `rtl` / `ltr` respectively (explicit `dir` is required on both). |
| `missing-asset` | a first-party script, preload, font, image candidate or CSS `url()` that a page references does not exist in dist (an unmeasurable file never passes silently). |
| `runtime` | a page does not load in Chrome (HTTP ≥ 400, timeout) during the runtime pass. |

#### Images (`avif`)

For every `<img>` (also inside `<noscript>` and declarative shadow DOM):
- the AVIF set is the `<picture>`'s `<source type="image/avif">`, else the `<img srcset>` if it is
  AVIF; it must use `w` descriptors and every file must be a real AVIF (ftyp brand + `ispe`) whose
  width equals its descriptor;
- **widths, never upscaled** (lead ruling from rev-c's CAT-4 review): the original's width comes
  from the CAT-4 image manifest (`entry.original.width`, entry found by `hash` = the file stem in
  `/img/<hash>-<w>.avif`). Original ≥ 1200 px → all of 360/480/720/960/1200 w; smaller → every
  standard width ≤ the original plus the original-width candidate; any candidate wider than the
  original fails. A missing manifest, entry or original width fails. Manifest:
  `--image-manifest <file>`, else `<dist>/image-manifest.json`, else
  `apps/storefront/.catalog/image-manifest.json`;
- every candidate the browser could pick, **in any format** (AVIF set, other `<source>`s, the
  `<img>`'s own `srcset` and `src`), at ≤ 960 w or of unknown width must be ≤ 25,000 B;
- failures by escape route: `<img src>` without `srcset`, a non-AVIF `srcset`, `<picture>`
  without an AVIF `<source>`, raster `data:` URIs.
Also failing: `<link rel=preload as=image>` without `imagesrcset` (its `imagesrcset` gets the same
AVIF-set check); raster images in CSS (`url()`, `image-set()`, in `<style>` or `style=""`),
`<video poster>`, `<input type=image>`, SVG `<image>`, `background=""`. Use an `<img>` with an AVIF
srcset for photos and SVG for decoration. Exempt: SVG files and `data:image/svg+xml` (vector:
logos, icons), `<link rel=icon|apple-touch-icon|manifest>`, `<source>` of `<video>`/`<audio>`.

#### What the parser sees

CSS is read after removing comments and decoding escapes (`url("\68ttps://…")` is `https://…`;
`/* font-display: optional */` is not a declaration). URLs go through the URL parser's
preprocessing (tab/newline removed, C0/space trimmed). HTML comments end at `-->` or `--!>`;
`<!-->` and `<!--->` are empty comments. `<template shadowrootmode>` content renders (scanned as
live); `<template>` content is inert; `<noscript>` content is scanned for third parties and
images. `<iframe srcdoc>` is scanned for absolute URLs; `<a ping>` / `<area ping>` targets count
as third-party references.

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
`import`/`export … from`, `import()`, **any string literal naming a `.js`/`.mjs` file**
(`s.src = '/js/turnstile-loader.js'`; bare names like `'big.js'` or
`new Worker(new URL('w.js', import.meta.url))` are followed when such a file exists, relative to
the script or the document), and every `.js` token in a `data-*` attribute (the storefront LOADER
imports the modules listed in `[data-js]`), recursively. So a lazily injected first-party file counts.
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
  `sizes` → the largest candidate). `sizes` understands `(min-width)`/`(max-width)` conditions
  and lengths in px, vw, em, rem, including `calc()` with + − × ÷ and parentheses, `min()`,
  `max()`, `clamp()`, nested. At 412 × 1.75 the pick is tested equal to Chrome's own
  `currentSrc` (test/browser.test.ts), and never smaller than Chrome's elsewhere;
- on `/ar/` (and pages outside `/fr/`), every font in an `@font-face` (first `src` URL); on
  `/fr/` only preloaded fonts (the shared sheet's Arabic face must stay unused, which the runtime
  pass proves);
- every external `url()` in the inline CSS other than fonts (static analysis cannot tell which
  rules apply above the fold; use inline SVG or `data:` for decoration);
- every non-lazy `<img>`, external `<script>`, `<video poster>`, `<input type=image>`, SVG
  `<image>`, `background=""` and `style=""` `url()` before the LCP element.

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

## `npm run lh`

```
npm run lh                                    # every template in /ar/ and /fr/ of apps/storefront/dist, 5 runs each
npm run lh -- --template product --runs 5     # one template
npm run lh -- --url /ar/ --url /fr/p/x/       # explicit paths (or --urls <file>, one per line)
npm run lh -- --base-url http://127.0.0.1:4270 --urls my-urls.txt   # an already running server (QA)
npm run lh -- --serve static --port 4114      # server choice / port (measure block 4110–4119)
# without the root script: node tools/measure/src/lh/cli.ts [same flags]
```

- **Lighthouse:** exactly 13.6.0 (`node_modules/lighthouse`, checked before running and in every
  result), mobile defaults only: formFactor mobile, screen 412 × 823 @ 1.75, simulated throttling
  150 ms RTT / 1,638.4 kbps / 4× CPU. Any result with another version, preset, throttling or a
  redirect, or with mobile emulation disabled (`screenEmulation.disabled`), is a failure, not a
  data point. Categories run: performance, accessibility, best-practices, seo (the last two are
  recorded per run, not gated: they are not CLAUDE.md budgets). System Chrome
  (`/usr/bin/google-chrome`, headless).
- **Lock:** runs under the machine-wide exclusive `lighthouse` lock (`scripts/lib/locks.sh`,
  flock fallback). If the root script already wraps it, the CLI sees its ancestor holds the lock;
  otherwise it re-executes itself under the lock. Waits up to an hour for the lock.
- **Server:** `--serve auto` = `wrangler dev` of `apps/web` (Workers static assets + the Worker,
  brotli, production-like) when it exists and the dist is the default one; otherwise a Node static
  server over `--dist` (brotli q11, `_headers` applied, trailing-slash redirects, nearest
  `404.html` with status 404). `--base-url` skips starting a server. The server is stopped at the
  end, even on failure. Reusable: `node tools/measure/src/serve.ts [--mode] [--dist] [--port]`.
- **Templates:** discovered from the built site (`src/templates.ts`): every page is classified by
  `<html data-tpl>` (else the CAT-1 URL scheme). One URL per template and language (the shortest
  path, so page 1 of a category), and **every** content page. A page whose template cannot be
  told, an unknown `data-tpl`, a `data-tpl` that contradicts its URL, or a template missing in one
  language **fails the run** (never silently skipped). The page measured for a template is its
  **heaviest** HTML (worst case), ties → shortest URL. Pages not measured are listed in the
  summary with the reason. The not-found template is measured at its file URL
  (`/{lang}/404.html`, HTTP 200): Lighthouse refuses to score a document answered with 404.
  **Variants (MEAS-5):** the layout writes `<html data-tpl-kind>` (contract with shell and
  pagedata): product → `simple` | `variable` | `pack`, category → `top` | `sub`. When a build
  declares kinds, each (template, kind) is its own target in both languages (`product-pack-ar`,
  `category-sub-fr`, shots in `product/ar-pack-360.png`). It fails the run when a page of that
  template has no kind, a kind is missing in one language, a value is not a kind of its
  template, or a kind is on another template. A build without the attribute keeps one target per
  template (noted in the summary's skipped list). The registry serves lh, shots, axe and timings.
- **Machine load (lead's rule, 2026-11-05):** before every run the CLI waits (up to
  `--quiet-wait`, default 900 s, within a total budget `--quiet-wait-total`, default 1800 s per
  invocation, so the gate's wall time stays bounded) for the 1-minute load average to drop to
  `--max-load` (default 4).
  A run is **contended** if it started with load > 4 or its `benchmarkIndex` is < 1,500 (this
  machine's quiet spike runs: 1,843–2,347; loaded: 117–1,505). A contended run is retried once,
  and the summary records both attempts with their load and benchmarkIndex.
- **Rules per URL** (5 runs, `--runs` only for manual checks):
  - every run must produce a valid result: a crash, runtime error or missing score is a
    **failure** (never "median of 4");
  - the main document returns the expected status (200);
  - **Performance 100**: the median run by performance score (Lighthouse rounding,
    `Math.round(score × 100)`) must be 100;
  - **Accessibility 100 in every run**;
  - **no browser console errors** in any run (Lighthouse `errors-in-console`);
  - **Arabic pages: median Speed Index < 1,950 ms**, else fail with the CLAUDE.md font fallback
    message (switch to the system Arabic font, record it in DECISIONS.md).
  - Medians of FCP, LCP, TBT, CLS and SI are reported for every URL.
- **Verdict:** `pass`; `fail`; or `inconclusive`. Only the performance score and its timing
  metrics (median Performance, Arabic Speed Index) are load-sensitive: when those are the only
  failures and at least one run was contended after the retry, the URL is `inconclusive`.
  Everything else is deterministic and a clean `fail` whatever the load: accessibility, HTTP
  status, console errors, crashes, configuration problems. A pass under load stands (load only
  worsens simulated metrics).
- **Gate mode** (`--gate` or `HB_GATE=1`, for `scripts/gate.sh`): refuses every option that
  narrows or relaxes the run (`--url`, `--urls`, `--template`, `--runs`, `--min-benchmark`,
  `--max-load`, `--base-url`, `--dist`) with exit 2.
- **Exit code:** `0` all pass · `1` any failure or registry error · `2` setup error (Lighthouse
  version, Chrome, server, flags) · `3` inconclusive only (rerun when the machine is quiet). The
  gate treats every non-zero code as red.
- **Output** (`--out`, default `<main checkout>/artifacts/lh/`): `runs/<template>-<lang>-<n>[-retry].json`
  (raw Lighthouse JSON, re-created on every invocation), `summary.json` (per-URL verdict,
  failures, notes, median run, per-metric medians, benchmarkIndex and load per run, every run
  record, skipped pages, server mode), `summary.txt` (the printed table), `server.log` (wrangler).
- Time: about 30–50 s per run on this machine, so 16 URLs × 5 runs ≈ 45–70 min without retries.

#### Runtime pass (`src/budget/runtime.ts`)

Method from qa (`artifacts/qa/scripts/live-checks.mjs`): Playwright with `/usr/bin/google-chrome`,
`page.on('request')`, `document.fonts` entries loaded/loading. Every page under `/ar/` and `/fr/`:
- loaded at 360 px (and 1440 px for `/fr/`), `waitUntil: 'load'` + 1.5 s idle (the storefront
  LOADER imports its modules on load → `requestIdleCallback`), no interaction:
  **any request to another origin fails `third-party`** (Turnstile must wait for interaction);
- `/fr/` again with every link and button focused and hovered (a `:focus`/`:hover` rule could pull
  the Arabic font in): **any font request or font in use fails `fr-font`**;
- a page that does not load (HTTP ≥ 400, timeout) fails `runtime`.
Observations (font requests, fonts in use, third-party requests per page × width) are in
`budget.json` under `runtime.results`.

## `npm run shots` and `npm run axe`

```
npm run shots                                   # every template × ar/fr × 360/768/1440 px
npm run axe                                     # axe + keyboard pass, every template × ar/fr × 360/768/1440 px
npm run shots -- --template product --out /tmp/s
npm run axe -- --base-url http://127.0.0.1:4270 --urls my-urls.txt   # an already running server
# without root scripts: node tools/measure/src/shots/cli.ts | node tools/measure/src/axe/cli.ts [same flags]
```

Same target and server options as `lh` (`--dist`, `--base-url`, `--serve`, `--port`, `--url`,
`--urls`, `--template`): templates are discovered from the build, and an unclassifiable page or a
template missing in one language fails the run. Playwright drives system Chrome
(`/usr/bin/google-chrome`, no browser download). Default ports: shots 4114, axe 4116.

**Deterministic pages** (`src/lib/browser.ts`): viewport 360×800 / 768×1024 / 1440×900 at DPR 1,
`prefers-reduced-motion: reduce`, light scheme, `fr-DZ` locale, Africa/Algiers time zone; load →
`document.fonts.ready` → **reload** (so the `font-display: optional` Arabic face is used from
cache, as on a repeat visit, instead of racing first paint) → load → `loading="lazy"` images
switched to eager → fonts and every image complete (at most 20 s, else a page error, never a
hang) → animations, transitions, smooth scrolling and the caret frozen. Two runs over the same
build give byte-identical PNGs (tested).

**shots** → `<out>/shots/<template>/<lang>-<width>.png` (viewport) and `…-full.png` (full page);
content pages, one per page: `<out>/shots/content/<lang>-<slug>-<width>[-full].png`;
`<out>/shots/index.html` contact sheet (rows = templates, columns = lang × width);
`<out>/shots.json`. Default `<out>` = `<main checkout>/artifacts/shots-run`. Exit 1 if a page does
not load with its expected status or the registry has errors.

**axe** → axe-core 4.14 with **every rule it runs by default**, at 360, 768 and 1440 px: the
WCAG 2.0/2.1/2.2 A/AA rules and the best-practice ones (`region`, `landmark-unique`,
`heading-order`, …), lead ruling 2026-11-06. **Zero violations** required. An exception is a rule
id in `AXE_DISABLED_RULES` (`src/axe/cli.ts`) citing a DECISIONS.md entry that names the rule in
backticks with its reason; otherwise the run refuses to start (exit 2). Other `incomplete` items
are counted in the JSON.
**Contrast axe cannot compute** (`incomplete` `color-contrast`: text over an image or gradient,
overlapping elements) is **measured from pixels and gated**. Three shots of the element's box:
text forced to pure black, to pure white, and transparent. The **glyph mask** is every pixel
where the black and white shots differ by at least half, so glyphs are found whatever their
colour, including text drawn in the background's own colour (white on the white part of a
photo). The transparent shot is the background behind each glyph. Per mask pixel, contrast =
the computed text colour (alpha-composited) vs that background; the **worst 2 %** of mask pixels
must reach 4.5:1 (3:1 for ≥ 24 px, or ≥ 18.66 px bold). Results in `axe.json` (`contrast`, with
min/median). A mask under 30 px, or an item inside an iframe or shadow root, is listed in
`axe.txt` as `CHECK BY HAND`, never passed.
**Keyboard pass** on the same loads, two walks: **Tab** from the top of the page, then
**Shift+Tab** from the bottom, each until focus leaves the page. Each forward stop records the
element, its text, its box, and two checks, both blocking:
- **focus visible** (WCAG 2.4.7): a screenshot of the element's box ± 8 px with focus differs from
  the same box after `blur()` (focus is then restored, keeping keyboard modality);
- **not obscured** (WCAG 2.4.11): the element at the box centre is the focused element (or inside
  it / contains it), e.g. not under a sticky header.
**Traps** (WCAG 2.1.2), in both directions and whatever causes them (a keydown handler, a
focusout handler pulling focus back, a widget's focus loop): a full cycle is focus leaving the
page, or wrapping to the first stop once every tabbable element was visited. Focus returning to
any other earlier stop, or not moving, fails with the loop and the elements it never reaches;
so do more than max(150, 2 × tabbable + 20) presses without a full cycle, and more than 30
presses inside one iframe or media element. **Unreachable** (WCAG 2.1.1): after a full cycle,
every tabbable element must have been a stop. Tabbable = focusable, `tabIndex ≥ 0`, enabled, not
`inert`, rendered (not `display:none` / `visibility:hidden` / in a closed `<details>`), only the
open modal `<dialog>`'s content while one is open; a radio group is one stop. Fixtures proving
each failure: `test/fixtures/a11y.ts` (`trap` is rev-c's review fixture).
No focusable element also fails. Output: `axe.json`, `keyboard.json` (focus order both ways per
template × width, how each walk ended: `left`/`wrapped`/`trap`/`limit`), `axe.txt`; default `<out>` =
`<main checkout>/artifacts/axe-run`. Exit 0 / 1 / 2 as everywhere.

## `npm run e2e`

```
npm run e2e                                    # = node tools/measure/src/e2e/cli.ts (root script: tooling 22a6def)
npm run e2e -- admin-auth                      # extra args go to vitest (here: one spec)
HB_E2E_STRICT=1 npm run e2e                    # acceptance: a missing feature FAILS instead of skipping
HB_E2E_ALLOW_SKIP=1 npm run e2e                # a partial checkout: skipped specs do not fail the run
HB_E2E_WEB_URL=http://127.0.0.1:4270 HB_E2E_ADMIN_URL=http://127.0.0.1:4278 HB_E2E_PERSIST=<dir> npm run e2e   # running servers
```

The entry point (`src/e2e/cli.ts`) runs the checkout's vitest with `tests/e2e/vitest.config.ts`
from the checkout root and writes results to `<main checkout>/artifacts/e2e/` (`HB_E2E_OUT`
overrides). Afterwards it lists every skipped spec with what it waits for, and **a run with
skips exits 1** unless `HB_E2E_ALLOW_SKIP=1`: green never means "nothing ran".

The global setup (`tests/e2e/setup.ts`) builds one fresh local D1 in `.wrangler/e2e` (seed command
of DB-3 when `data/catalog` and `data/geo` are present, else migrations only), then boots with
`wrangler dev` (local, test secrets via `--var`, never real ones):
- the **web Worker** (`apps/web`: storefront static assets + `/api/*`) on **4110** (inspector 4111),
  when `apps/storefront/dist` exists, with the dev script's vars (`ENV=development`,
  `SITE_HOSTS=localhost,127.0.0.1`: its wrangler.jsonc top level is production). For the order
  specs, build the storefront from the same data the D1 was seeded from (`HB_SNAPSHOT=seed`);
- the **admin Worker** (`apps/admin`, `ENV=development` for the dev login) on **4118** (inspector 4119).
Before starting a Worker the harness checks that its ports are free (another checkout's run
answering there would otherwise be tested against this run's D1); ready = our child alive and
the URL answering < 500. A Worker answering `config_invalid` fails at once with the vars to add.
A Worker that fails to boot makes every spec that needs it **fail** (not skip). Worker logs:
`<out>/logs/`; JSON results: `<out>/e2e-results.json`.

**Specs, written against the contracts** (form field names from `packages/shared` order-schema,
D1 columns from `packages/db` migrations; admin: admin-core's dev login, CSRF and `postAs` test
pattern, admin-orders' route table and detail-page forms). Each spec declares the features it
needs (`tests/e2e/harness.ts` `FEATURES`: files and route tables in the checkout) and is skipped
with the reason in its name until they exist, e.g. `[waiting: POST /api/order not in this
checkout (WEB order route)]`. Once it runs, a 403/404/409/422 from any step fails it.

| Spec | What it proves |
|---|---|
| `order.spec.ts` | per language: a **variant** (non-default variant of a variable product) order shows the wilaya's fee and the correct total (price × 2 + fee) before confirming, creates the order with those amounts and that variant in D1; a duplicate JSON submit with the same idempotency key returns 200 and the same ref, and D1 holds one order; the order appears in the admin's list and detail page; in the admin (admin-orders' contract: forms read from the detail page, `_csrf` and `version` included, each POST must answer 303) a confirmer logs a call with a callback (new → called) and a confirmed call (called → confirmed), logistics ships it with a courier (→ shipped), and order_events grows by ≥ 3 |
| `nojs.spec.ts` | per language, JavaScript disabled: the form posts to the Worker's review page, which shows fee and total; confirm (after the 1.5 s minimum review time) → 303 to the confirmation page and the order in D1 |
| `geo.spec.ts` | per language: the wilaya picker lists 69 wilayas (codes 1–69); `/geo/communes/<lang>/<code>.json` totals 1,541 distinct communes; the seeded D1 holds 69 wilayas and 1,541 communes |
| `admin-auth.spec.ts` | each test proves its success path first (a real dev login → 303 + cookie served the dashboard). Then every admin route (admin-core's mounts from `app.ts` + admin-orders' route table, GET and POST) answers 401/403 with no credentials, a garbage Access JWT, or a forged dev cookie (real payload, wrong signature); an inactive dev user is refused where the owner, same request, is let in; the dev login answers a loopback Host and refuses another; every dev role is served the dashboard |

## Timings (MEAS-5)

```
node tools/measure/src/timings/cli.ts                       # fresh seeded D1 + web Worker (as e2e), 30 runs after 3 warm-up
node tools/measure/src/timings/cli.ts --runs 50 --no-api    # pages only
node tools/measure/src/timings/cli.ts --base-url http://127.0.0.1:4210 --persist .wrangler/hb-local   # a running server and its D1
node tools/measure/src/timings/cli.ts --base-url https://hb-x.<acct>.workers.dev --allow-write-host hb-x.<acct>.workers.dev --variant 12 --wilaya 16 --commune 1601   # a temporary deploy
```

**The API series writes real orders** (stock, staff notifications), so it runs only against the
Worker the harness started, a loopback host (`127.0.0.1`, `::1`, `localhost`), or a
`*.workers.dev` host named exactly by `--allow-write-host` (our `wrangler deploy --temporary`
measurements; that host also needs `--variant/--wilaya/--commune` from its own D1). Any other host
(the live site): the API series is refused with the reason in `timings.txt`, and the pages are
still timed with GET only.

For the closing report: **TTFB** (ms to the response headers, as the client sees them) of every
registry target, and the latency of **POST /api/quote** and **POST /api/order**, each as p50 / p90
/ min / max over N sequential runs after warm-up runs that are not counted. Orders use a fresh
phone and idempotency key per run (the phone rate limit never trips) and the active variant with
the most stock (the run refuses when stock < orders to place); ids come from the D1, or
`--variant/--wilaya/--commune`. Every counted request must answer its expected status (page 200,
quote 200, order 201; not-found is timed on a missing URL, 404): a wrong status is a failure, never a sample (exit 1). Output:
`timings.json` and `timings.txt` in `<main checkout>/artifacts/timings-run` (`--out`). These are
**local** numbers (wrangler dev on this machine), for comparing builds, not production latency.

### Adding or changing a rule

1. Change `src/budget/check.ts` (and `RULES`), numbers only in `src/budget/config.ts`
   (with a DECISIONS.md entry if it departs from CLAUDE.md / STACK-REPORT.md).
2. Add a failing case to `CASES` in `test/budget.test.ts` (the test "covers every rule" fails if a
   rule has none) and, if the rule could misfire, a positive control. Runtime behaviour:
   `test/runtime.test.ts` (real Chrome). qa's 62 probes: `test/qa-probes.test.ts`.
3. `npm test -w tools/measure`.

The good fixture site (`test/fixtures/site.ts`) is generated in a temp dir: 4 pages, synthetic
AVIFs with real `ftyp`/`ispe` boxes, a fake woff2, order-form JS that lazily injects a Turnstile
loader. `test/fixtures/real-480x320.avif` is a real AVIF (ffmpeg + libaom) for the parser.
