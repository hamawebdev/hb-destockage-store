# Frontend rendering: Cloudflare storefront for Algeria (finished from the interrupted teammate's saved work)

## 1. Position

- **Serve every storefront page as pre-rendered static HTML with almost no JavaScript.** Pages ship 0 KB of JS by default. One small island (6 KB or less, Preact-sized or plain JS) handles the cash-on-delivery order form. Pages are served from Workers static assets, which are free and unlimited and do not invoke the Worker. On this machine, the zero-JS product-page spike scored **100** with LCP **752 ms in French and 1052 ms in Arabic** (Lighthouse 13.6 mobile, median of 3, quiet CPU).
- **Use Astro in static output mode, with a Worker endpoint or server island for the few dynamic parts.** Among the frameworks tested, it has the best evidence:
  - its default build shipped 0 KB of JS and scored 100;
  - in HTTP Archive it has the highest CrUX mobile pass rate of any mainstream framework, both globally (71%) and in Algeria (45%; only Hugo is higher at 65%).
  - **SvelteKit is the runner-up.** Its template shipped 35 KB of JS and still scored 100, and `csr=false` ships no JS at all.
  - **The real lever is "no hydration framework on the product page", not the framework name.** A hand-written Hono or Rust template produces the same bytes.
- **Do not use React-hydrated frameworks for the storefront** (Next.js via OpenNext, React Router, Remix).
  - The Next.js 16.4.5 default page ships 140 KB of JS. That gives TBT of 136–215 ms and a score of **96–99 even on a quiet CPU**. A perfect TBT score needs 65 ms or less.
  - In Algeria, these frameworks pass CWV on only **7–19%** of mobile origins.
- **Rust is not a lever for the frontend.** Client-side Rust/WASM frameworks ship 49 KB (Leptos) and 115 KB (Dioxus) compressed, against 5.9 KB for Preact (js-framework-benchmark). For server-rendered HTML, the bytes reaching the phone do not depend on the server language. If Rust has a place, it is behind the HTML (that is the backend teammate's question).
- **Images:**
  - AVIF hero in a `srcset` with 360, 480, 720, 960 and 1200 px widths;
  - `<link rel=preload … fetchpriority=high>` on the hero, from the same origin.
  - At 720 px the measured sizes were AVIF 11.3 KB, WebP 16.8 KB and JPEG 37.9 KB.
  - 96.4% of Algerian browsers support AVIF.
- **Navigation:** plain multi-page app plus Speculation Rules (prefetch, moderate) plus cross-document View Transitions as an optional enhancement. 90.9% of Algerian browsers support prefetch and 83.2% support cross-document View Transitions. Do not build an SPA.
- **Arabic web fonts cost about 300 ms of Lighthouse LCP** (Arabic 1052 ms vs French 752 ms) and caused a 0.049 layout shift in 5 of 11 runs.
  - Use one subset weight (about 10.5 KB), preload it, and use metric-override descriptors.
  - With only one weight preloaded, CLS was 0 in all runs.
  - With the system font only, LCP was 861–918 ms.

## 2. Evidence table

**Shared method for the Lighthouse rows ("Own LH"):**
- Lighthouse 13.6.0, headless Chrome 143, mobile preset. Simulated throttling: 150 ms round trip, 1.6 Mbps, 4× CPU slowdown.
- Pages served from localhost by `/tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/serve.js` (gzip) or the framework's own preview server.
- **"Quiet"** = runs at 15:04–15:12 local on 2026-11-04 with load average 1.0–2.4 on 8 cores, each figure a median of 3. Results are `R-Q-*.json` in `/tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/lh/`.
- **"Contended"** = earlier runs at load 9–24. Their TBT is inflated, so they are used only for LCP and bytes.
- In the HTTP Archive rows, "pass" means the share of mobile origins passing all three Core Web Vitals in CrUX, crawl of 2026-09-01.

| # | Claim | Evidence (numbers) | Source URL / measurement | Source type | Date | Algeria-specific? | Confidence |
|---|---|---|---|---|---|---|---|
| 1 | Zero-JS product page scores 100 | French: perf 100, FCP 717, LCP 752, TBT 0, CLS 0, 20.7 KB total (HTML 4.2 KB, AVIF 11.5 + 5.3 KB). Arabic: perf 100, FCP 797, LCP 1052, TBT 0, CLS 0.049 in 2 of 3, 42.5 KB (fonts 22.1 KB) | Own LH, quiet, `R-Q-spikefr-*`, `R-Q-spikear-*` | Own measurement | 2026-11-04 | Lab (simulated network) | High |
| 2 | Next.js default template cannot reliably reach 100 | Next 16.4.5 / React 19.3.0, `next start`: perf 99/98/96, TBT 136/161/215 ms, LCP 920, JS 140.2 KB transferred, 214.8 KB total, bootup 371–439 ms | Own LH, quiet, `R-Q-next-*`; JS sizes from `jsbytes.py` (180 KB gzipped across 7 files) | Own measurement | 2026-11-04 | Lab | High |
| 3 | SvelteKit template reaches 100 with 35 KB of JS | SvelteKit 3.1.1 / Svelte 5.57.3: perf 100 ×3, FCP/LCP 968, TBT 0, JS 35.3 KB. Contended runs showed TBT 64–466, which confirms contention | Own LH, `R-Q-sk-*` vs `R-sk-tpl-*` | Own measurement | 2026-11-04 | Lab | High |
| 4 | Astro default build ships 0 JS | Astro 7.4.5 static: 2.0 KB total, perf 100, LCP 617–753, TBT 0. js-framework-benchmark: Astro 1.0 KB compressed | Own LH `R-Q-astro-*`; krausest js-framework-benchmark `results.ts` (2026-11-02) | Own measurement + benchmark | 2026-11 | Lab | High |
| 5 | React Router template is slow because of render-blocking third-party fonts, not its JS | RR 8.5.1 / React 19.3.1: perf 89–90, FCP/LCP 2843–2904, TBT 0, JS 115 KB. Render blockers: fonts.googleapis.com CSS plus 73.6 KB Inter woff2 | Own LH `R-Q-rr-*`, `render-blocking-insight` audit | Own measurement | 2026-11-04 | Lab | High (template artefact; not a fair framework verdict) |
| 6 | A React island costs LCP; Preact does not | Same page plus counter island. React 19: JS 68.0 KB, LCP 1278–1348, TBT 2–16, bootup 150 ms. Preact: JS 6.0 KB, LCP 902–972, TBT 0. Both score 100 | Own LH `R-Q-react-*`, `R-Q-preact-*`; bundles built with esbuild in `/tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/island` | Own measurement | 2026-11-04 | Lab | High |
| 7 | Hero image weight vs LCP | JPEG 38 KB: LCP 978–1203. 61 KB: 1277. 92 KB: 1427. 204 KB (q92): 1804–1951, score 99. AVIF 11.5 KB: 752 (all 100 except the 204 KB run) | Own LH `R-img*` (contended, so only LCP and bytes are used) | Own measurement | 2026-11-04 | Lab | Medium-high |
| 8 | AVIF is 3.4× smaller than JPEG at the same width | 720 px: AVIF 11,296 B (libaom crf 26), WebP 16,826 B, JPEG 37,902 B. 960 px: 15,614 / 24,626 / 61,004 B | `ffmpeg -c:v libaom-av1 -crf 26`, ImageMagick `convert`; files in `/tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/spike/site/img` | Own measurement | 2026-11-04 | n/a | High (one image) |
| 9 | Perfect-score thresholds | 1.00 needs FCP ≤ 1067, LCP ≤ 1546, TBT ≤ 65, CLS ≤ 0.039, SI ≤ 1953 ms | Lighthouse scoring curves reimplemented in `/tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/lhscore.py` (cross-checked by network teammate) | Own calculation | 2026-11-04 | n/a | High |
| 10 | CWV pass rate by framework, global | Astro 71% (47,277 origins), Qwik 62%, Preact 56%, Htmx 51%, SvelteKit 48%, ALL 53%, Next.js 36%, Remix 32%, Nuxt 29%, React Router 24%. Shopify 76%, WooCommerce 39% | `https://cdn.httparchive.org/v1/cwv?technology=<T>&geo=ALL&rank=ALL&start=latest`, via `cwv.py` | Field (CrUX via HTTP Archive) | 2026-09 crawl | Global | Medium (confounded by site type) |
| 11 | CWV pass rate by framework, Algeria | Hugo 65% (69 origins), Astro 45% (535), Qwik 41% (22), ALL 32% (70,124), SvelteKit 30% (198), Htmx 30%, Shopify 23%, Preact 22%, Remix 19%, Next.js 17% (6,168), Nuxt 16%, React Router 7%, YouCan 5% | Same API with `geo=Algeria` | Field | 2026-09 | **Yes** | Medium (small n for Hugo and Qwik) |
| 12 | Almost no Algerian origin has p75 LCP under 0.6 s | p75 LCP < 600 ms: ALL 0.3%, Astro 0.0%. < 1200 ms: ALL 6.6%, Astro 10.1%, Hugo 14.1%. < 2500 ms: ALL 49.9%, Astro 71.3%, Next.js 37.7%, Shopify 34.1% | `https://cdn.httparchive.org/v1/cwv-distribution?technology=<T>&date=2026-09-01&geo=Algeria` (mobile only), `dist2.py`, `fine.py` | Field | 2026-09 | **Yes** | High |
| 13 | Same distribution, global, for comparison | Astro p75 LCP < 1200 ms: 28.2%. Shopify 25.1%. Next.js median origin p75 LCP about 2.4–2.5 s | Same, `geo=ALL` | Field | 2026-09 | Global | High |
| 14 | Algerian browsers support AVIF, prefetch and View Transitions | AVIF 96.4%, WebP 97.9%, link prefetch 90.9%, View Transitions (same-document) 89.5%, cross-document VT 83.2%, `:has()` 95.6%, logical properties 98.0% | caniuse `data.json` joined with `region-usage-json/DZ.json` (Oct 2026); Android Chrome "0" treated as the current version | StatCounter-derived usage | 2026-10 | **Yes** | High |
| 15 | Phone mix in Algeria | Mobile 55.5% / desktop 43.6%. Chrome 81.1%, Safari 8.0%. Vendors: Samsung 24.1%, Apple 15.8%, Xiaomi 15.2%, Oppo 12.7%, Realme 8.2%, Infinix 7.8% | https://gs.statcounter.com/platform-market-share/desktop-mobile-tablet/algeria, `/browser-market-share/all/algeria`, `/vendor-market-share/mobile/algeria` | StatCounter | 2026-10 | **Yes** | High |
| 16 | Client-side Rust/WASM is heavy | Compressed size: Leptos 0.7 48.8 KB, Dioxus 0.7 114.9 KB, Sycamore 47.2 KB vs Preact 5.9, Solid 4.5, Svelte 9.7, Qwik 30.5, React 51.4 KB. First paint: Leptos 236 ms, Dioxus 537 ms, vanilla 42 ms | js-framework-benchmark `webdriver-ts-results/src/results.ts` (run 2026-11-02), parsed by `jfb.js` | Benchmark with methodology | 2026-11 | Global | High (for a client-side app; no SSR measured) |
| 17 | Library weights for "minimal-JS" options | htmx 2.0.4: 16.3 KB gz. Alpine 3.14.9: 16.2 KB. Turbo 8.0.13: 44.9 KB | jsDelivr files, `gzip -9` | Own measurement | 2026-11-04 | n/a | High |
| 18 | Static assets are free and skip the Worker | "Requests to static assets are free and unlimited." Default `Cache-Control: public, max-age=0, must-revalidate` with ETag; override with a `_headers` file. 20,000 files on Free, 100,000 on Paid; 25 MiB per file | https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/, https://developers.cloudflare.com/workers/static-assets/headers/, https://developers.cloudflare.com/workers/platform/limits/ | Official docs | 2026 | n/a | High |
| 19 | Worker limits that matter for SSR | Free plan: 10 ms CPU per request. Paid: 30 s default. 128 MB memory, 1 s startup, 64 MiB script | https://developers.cloudflare.com/workers/platform/limits/ | Official docs | 2026 | n/a | High |
| 20 | Next.js on Workers has known CPU overhead | 10–25% of request time spent in garbage collection, partly traced to OpenNext and Next.js/React | https://blog.cloudflare.com/unpacking-cloudflare-workers-cpu-performance-benchmarks/ | Vendor engineering post with profiling | 2025-10-14 | Global | Medium |
| 21 | Cloudflare image transformations: cost and AVIF behaviour | 5,000 unique transformations per month free, then $0.50 per 1,000. Format or quality changes count as the same transformation. Quality default 85. "AVIF encoding can be an order of magnitude slower"; large images fall back to WebP or JPEG | https://developers.cloudflare.com/images/pricing/, https://developers.cloudflare.com/images/optimization/features | Official docs | 2026 | n/a | High |
| 22 | Astro server islands | `server:defer` replaces the component with a small script that fetches its HTML by GET (cacheable). It switches to POST (not cacheable) above 2048-byte URLs. Requires an adapter | https://docs.astro.build/en/guides/server-islands/ | Official docs | 2026 | n/a | High |
| 23 | SvelteKit `csr=false` | "Disabling CSR does not ship any JavaScript to the client" | github.com/sveltejs/kit `documentation/docs/20-core-concepts/40-page-options.md` | Official docs | 2026 | n/a | High |
| 24 | Prerendering product pages helps in the field | Ray-Ban PDP, CrUX URL-level, mobile LCP 4.69 → 2.66 s (−43%), desktop 3.03 → 1.74 s. Prerender rate 29% on mobile | https://web.dev/case-studies/rayban-speculation-rules | Case study (CrUX) | 2025-01-28 | Global | Medium-high |
| 25 | Platform-wide prefetch helps modestly | Shopify reports about 180 ms average improvement on mobile across loading metrics. Shopify's docs give a median of about 20 ms on mobile and 220 ms on desktop | [Speculation Rules at Shopify](https://performance.shopify.com/blogs/blog/speculation-rules-at-shopify), [shopify.dev docs](https://shopify.dev/docs/storefronts/themes/best-practices/performance/use-speculation-rules) | Vendor RUM (figures disagree) | 2025 | Global | Medium |
| 26 | Speed Brain is prefetch only | Speed Brain adds a `Speculation-Rules` header with prefetch and conservative eagerness. On by default on the Free plan. Does not help the first page | https://developers.cloudflare.com/speed/optimization/content/speed-brain/ | Official docs | 2026 | n/a | High |
| 27 | The zero-JS spike also scores 100 when served from a real Cloudflare edge, measured from Djezzy, Biskra | `dz-spike-s1-static…workers.dev/fr/` (served from colo MRS): perf 100 ×3, LCP 918–1019 ms, server response 118–154 ms, 27.9 KB. Rust Worker `s3-rust/ar/`: perf 98–100 | `/tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/spike/results/lh-final`, `lh-real` (network/backend teammate's runs) | Own measurement (teammate) | 2026-11-04 | **Yes** (Djezzy, Biskra) | Medium-high |
| 28 | Arabic font strategy affects LCP and CLS | IBM Plex Sans Arabic: 33.5 KB full, 10.5 KB subset (400) and 11.2 KB (600). Both weights preloaded: LCP 1052, CLS 0.049 in about half the runs. One weight: LCP 1053–1055, CLS 0 in 6 of 6. System font: LCP 861–918 | `pyftsubset` via `python3 -m fontTools.subset`, then `R-ar-opt-*`, `R-ar-sys-*`, `ar-*` (contended, so LCP and CLS only) | Own measurement | 2026-11-04 | Lab | Medium |

**Byte budget for a Lighthouse-100 product page.** This is derived from rows 1–9 and checked against the thresholds in row 9.

| Item | Budget |
|---|---|
| HTML (critical CSS inline) | ≤ 14 KB compressed (measured 3.7–4.5 KB) |
| Hero AVIF | ≤ 25 KB (measured 11.5 KB). A 92 KB JPEG still scored 100 (LCP 1427 ms) but used 80% of the LCP margin |
| Fonts before LCP | ≤ 1 subset woff2 of about 11 KB, or none |
| JS before LCP | 0 KB. ≤ 10 KB gzipped after LCP: order-form enhancement, Speculation Rules inline |
| Total before LCP | ≤ 60 KB (measured 20–43 KB) |
| Third-party origins before LCP | 0 |

Hard ceilings:
- **TBT:** 68 KB of React stayed at TBT ≤ 16 ms, but 140 KB of Next.js reached 136–215 ms. Keep hydrated JS on the product page well under about 60 KB.
- **LCP:** about 1.5 s simulated, which at 1.6 Mbps is roughly 150 KB of critical bytes.

## 3. Alternatives rejected

- **Next.js via OpenNext**
  - Measured 96–99, never a steady 100, because of 140 KB of JS (row 2).
  - Algeria pass rate 17%; only 0.3% of Algerian Next.js origins have p75 LCP under 1.2 s (rows 11–12).
  - On Workers, extra CPU spent in garbage collection (row 20), and the Free plan allows only 10 ms CPU per request (row 19).
- **React Router v7 / Remix**
  - Pass rate in Algeria 7% and 19%; globally 24% and 32% (rows 10–11).
  - 115 KB of JS on a bare template.
  - Its slow FCP (2.9 s) was caused by the starter template's Google Fonts. I do not count that against the framework itself.
- **Nuxt**
  - Not measured: the install hit npm ETIMEDOUT here (`/tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/build_fw2.log`).
  - Field data only: Algeria 16%, global 29%.
  - Vue's runtime alone is 23.3 KB compressed (row 16). No evidence it beats zero-JS output.
- **SPA (any framework)**
  - The first paint waits for JS.
  - Ray-Ban and Shopify show the multi-page app plus speculation approach gets navigation gains without an SPA (rows 24–25).
  - Cross-document View Transitions cover the "app-like" feel for 83% of Algerian browsers (row 14).
- **Leptos, Dioxus or Sycamore for the client**
  - 47–115 KB compressed WASM and slower first paint than vanilla or Preact (row 16).
  - Leptos had only 3 origins in HTTP Archive, so no field evidence exists.
  - Running Rust or askama/maud on the server is not rejected, but it does not change client bytes (row 27: Rust Worker 98–100, same as static).
- **Qwik**
  - Built (1.20.3), but the starter had no deployment adapter, so it was not tested in Lighthouse.
  - Field data is respectable (global 62%) but only 22 origins in Algeria.
  - A resumable runtime is unnecessary when the page needs no JS. More exotic, with no evidence of an advantage.
- **SolidStart:** only 10 origins worldwide in HTTP Archive and not built. Too little evidence.
- **htmx, Alpine or Turbo:** 16–45 KB gzipped (row 17) to do what one form POST plus about 2 KB of vanilla JS does. HTTP Archive shows Htmx at 51% global and 30% Algeria pass rates, no better than Astro.
- **SvelteKit is the runner-up, not rejected.** It scored 100 with 35 KB of JS (row 3) and can ship zero JS per route (row 23). Its Algeria field pass rate is lower (30%) and its sample small (198 origins).

## 4. Interface assumptions for other teammates

- **Backend:**
  - The storefront's product, category and content pages are static HTML files under `/fr/…` and `/ar/…`, served from Workers static assets with no Worker invocation.
  - When an admin publishes, the site rebuilds and redeploys, or a Worker writes rendered HTML to R2/KV. Either way the product page is never server-rendered per request.
  - Orders are a plain HTML `<form method=post action=/api/order>` that works with no JS. The Worker responds with a redirect or HTML. The JS enhancement (validation, wilaya→commune list) loads after LCP.
  - Dynamic stock or price, if ever needed, comes from a cacheable GET fragment fetched after LCP, Astro server-island style.
- **Network/CDN:**
  - Everything on one origin. Long-lived immutable cache for hashed assets via `_headers`. HTML revalidated with ETag.
  - A Speculation Rules `<script type=speculationrules>` with moderate prefetch on product links. Prerender only for the order page from a product page.
- **i18n/UI:**
  - `dir=rtl` with CSS logical properties (98% support).
  - Arabic font: one subset weight with metric overrides, or the system font. Font budget 11 KB or less.
  - Cross-document View Transitions only through `@view-transition` CSS. No JS router.
- **Images:**
  - Originals in R2. Variants pre-generated at build time: AVIF crf around 26 at 360/480/720/960/1200 px, with WebP or JPEG fallback through `<picture>`.
  - Cloudflare transformations only as a fallback: they hit a 5,000/month free cap, and AVIF can fall back to WebP or JPEG for large images.
- **Admin and security:**
  - The admin is a separate app or route set with no performance constraint; any framework works there.
  - Anti-spam widgets such as Turnstile must load on form focus or submit, never before LCP, because a third-party origin before LCP breaks the budget.

## 5. Risks and thin evidence

- **Lab vs field.** All framework Lighthouse runs used simulated throttling on localhost. The real-edge check (row 27) covers only the static spike, not framework templates.
- **The 0.4 s target is not supported by field data.** Only 0.3% of Algerian origins have p75 LCP under 600 ms (row 12). Treat 0.4 s as a goal for repeat visits and prefetched navigation, not first-visit p75.
- **The framework comparison uses starter templates, not equal product pages.** Template content differs, for example React Router's Google Fonts. The like-for-like comparison is the React vs Preact island test on the same page (row 6).
- **Not measured:** Nuxt (install failed), Qwik in Lighthouse (no adapter), SolidStart, and Leptos/Dioxus server-side rendering.
- **HTTP Archive pass rates are confounded** by site type, hosting and audience. Algerian samples for Hugo (69), Qwik (22) and Remix (42) are small. Hono (58 origins, 0%) and Leptos (3) are meaningless.
- **Contended runs.** Runs before 15:00 had load 9–24. All TBT conclusions use only the quiet re-runs (rows 2, 3, 6), which confirmed that the earlier TBT figures for Astro (up to 1434 ms) and SvelteKit (up to 466 ms) were contention.
- **The spike page downloads both the 720 px and 360 px AVIF** (about 5 KB wasted). Fix the `srcset` and preload before reusing it.
- **Shopify's prefetch figures disagree between its blog and its docs** (row 25). Cloudflare acquired Astro in January 2026 ([BusinessWire](https://www.businesswire.com/news/home/20260116386991/en/Cloudflare-Acquires-Astro-to-Accelerate-the-Future-of-High-Performance-Web-Development)). That is vendor news, not performance evidence, but it bears on how long Workers support will last.

**Commands to reproduce** (paths relative to `/tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad`):
- Start the spike server: `node serve.js spike/site 8081`
- Quiet Lighthouse round: `./lhround.sh 3 Q-next=http://localhost:8085/ Q-sk=http://localhost:8083/ Q-rr=http://localhost:8082/ Q-astro=http://localhost:8084/ Q-react=http://localhost:8081/fr-react/ Q-preact=http://localhost:8081/fr-preact/ Q-spikefr=http://localhost:8081/fr/ Q-spikear=http://localhost:8081/ar/`
  - It wraps `lighthouse <url> --only-categories=performance --output=json --chrome-flags="--headless=new --no-sandbox"`.
  - Log: `/tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/lhround_quiet.log`
- Summaries: `python3 -I lhsum.py lh`
- HTTP Archive pass rates: `python3 -I cwv.py Algeria "Astro|SvelteKit|Qwik|Next.js|Nuxt.js|React Router|Remix|Htmx|Hugo|Shopify"`
- HTTP Archive LCP/TTFB distributions: `python3 -I dist2.py dist`

Other sources: [fudge.ai guide](https://www.fudge.ai/guides/speculation-rules-shopify/) (vendor, not relied on), [corewebvitals.io speculation explorer](https://www.corewebvitals.io/state-of-cwv/explorer/metrics.speculation.posture).