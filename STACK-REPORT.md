# Tech stack recommendation: COD e-commerce site for Algeria

**Date:** 4 November 2026. **Status:** research only. Nothing has been built for the project. Throwaway spikes were deployed to temporary Cloudflare preview accounts, which have since expired.

**How this was produced:**
- Six researchers each covered one area: network & Algeria latency; frontend rendering; backend, data & Rust; French/Arabic RTL, UI & accessibility; admin, security & anti-fraud; and a deployed spike with measurements.
- Three cross-examiners then attacked the claims where those areas meet.
- Every claim below is tagged with its evidence type. The full team reports, raw measurements and spike source are in [research-evidence/](research-evidence/).

**One finding shaped the whole method.** The research machine is in **Biskra, Algeria, on Djezzy** (AS327931, Optimum Telecom Algérie; most likely a phone hotspot). So the network numbers marked **[M-DZ]** were measured on a real Algerian mobile operator. They are not estimates from Europe.

**Evidence tags:**

| Tag | Meaning |
|---|---|
| **[M-DZ]** | Our measurement from Djezzy, Biskra |
| **[M-AT]** | Our analysis of public RIPE Atlas data from the one live Algérie Télécom probe |
| **[M-lab]** | Our measurement under Lighthouse's simulated network |
| **[F-DZ]** | Field data filtered to Algeria (HTTP Archive / CrUX, StatCounter, caniuse) |
| **[F-global]** | Global field data |
| **[Doc]** | Official documentation, used for hard facts only (limits, prices, features) |

---

## 1. Summary

**The stack.**
- **Storefront pages:** pre-rendered static HTML per language, built with **Astro (static output)** and served from **Cloudflare Workers static assets**. They ship **0 KB of JavaScript before the page renders**, and CSS-only "premium" motion.
- **Server side:** one small **TypeScript Worker (Hono)** for orders, plus a separate **custom admin Worker** behind **Cloudflare Access**.
- **Data:** one **D1** database (location hint `weur`).
- **Anti-fraud:** layered, with **Turnstile loaded only when the visitor touches the order form**.
- **No Rust in the runtime.** It was tested and came out neutral on speed and negative on cost.

**Lighthouse mobile 100 is achievable and was measured:**
- French product page: **100 in 3/3 runs**, deployed on Cloudflare.
- Arabic page: **98–100**, with the web font as the only thing costing points. With the system font it scored **100 in 5/5 runs** (lab).

The score depends on bytes, fonts and JavaScript. It does not depend on the server language or on Algerian network latency.

**"Under 0.4 s" is achievable for some metrics and visit types, not for every visit.**

| Target | Verdict | Evidence |
|---|---|---|
| Time to first byte on a **cold first visit**, at the median | Achievable **only if Cloudflare serves the visitor from inside Algeria** | 232 ms from the Algiers data center vs 390–430 ms from Marseille/Munich, both measured from Djezzy [M-DZ] |
| Page fully shown (LCP) on **repeat visits and clicks within the site** | Achievable | Prefetch/prerender (Speculation Rules) and cached connections |
| LCP on a **cold first visit** | **Not achievable** at the 75th percentile | Only **0.3%** of Algerian websites have a 75th-percentile LCP under 0.6 s [F-DZ] |

**The single biggest unknown.** Which Cloudflare data center ("colo") will actually serve the production domain to Algerian phones. On the same Djezzy line, different Cloudflare address ranges were served from:
- **Algiers:** 30–41 ms connect;
- **Oran:** 34–57 ms;
- **Marseille / Munich / Barcelona:** 60–240 ms.

Even Cloudflare's own website was served from Barcelona. **This must be tested on the real domain, on all four Algerian networks, before the build is committed** (§9).

---

## 2. Recommended stack, layer by layer

| Layer | Choice | Why (evidence) |
|---|---|---|
| **Cloudflare zone and plan** | Workers **Paid** ($5/month, required). Zone plan (Free / Pro / Business) **chosen by the data-center test in §9**, not bought in advance. | Free Workers allow only 10 ms of CPU per request [Doc]. Cloudflare says it moves Free customers off busy data centers first ([Traffic Manager blog](https://blog.cloudflare.com/meet-traffic-manager/)). But Cloudflare's own top-tier site is served from Barcelona on Djezzy [M-DZ], so a higher plan is **not proven** to keep traffic in Algeria. |
| **Storefront rendering** | **Pre-rendered static HTML** per language (`/fr/…`, `/ar/…`), built with **Astro 7 static output**, served by **Workers static assets** | The zero-JS spike scored **100** deployed on Cloudflare and measured from Djezzy (LCP 918–1019 ms simulated) [M-DZ]. Static assets are "free and unlimited" and do not run the Worker [Doc]. Astro and hand-written HTML produced **identical bytes** (3,179 vs 3,184 B brotli) [M-lab], so Astro is chosen for developer experience, not speed. Its field record is also the best of the mainstream frameworks (§4.1). |
| **JavaScript on the storefront** | **0 KB before LCP.** At most about 10 KB after LCP: order-form enhancement and inline Speculation Rules. Plain JS or a Preact-sized island. | A React island cost 68 KB and added **+350 ms LCP**. The Preact equivalent cost 6 KB with no LCP cost [M-lab]. Next.js's 140 KB of JS gave TBT 136–215 ms and a score of 96–99 even on a quiet CPU [M-lab]; a perfect TBT score needs ≤ 65 ms. |
| **Navigation** | Normal multi-page site, plus Speculation Rules (prefetch, moderate; prerender from the product page to the order step), plus cross-document View Transitions for the app-like feel | Ray-Ban's product pages: mobile LCP **4.69 → 2.66 s** with prerender, CrUX data ([web.dev case study](https://web.dev/case-studies/rayban-speculation-rules)) [F-global]. In Algeria, 90.9% of browsers support prefetch and 83–96% support cross-document View Transitions [F-DZ]. |
| **CSS / UI** | Tailwind v4 (or hand-written) with **CSS logical properties**. One stylesheet for both directions, **inlined** (about 4 KB br). CSS-only motion. | Measured 3.9 KiB brotli for a full storefront sheet serving LTR and RTL [M-lab]. GSAP is 25–41 KiB br, and `motion` 24.5 KiB (+43 KiB with React) [M-lab]. |
| **Fonts** | French: **system fonts** (0 bytes). Arabic: **one static weight of Noto Sans Arabic 400, subset (11.6 KiB)**, preloaded on `/ar/` only, `font-display: optional`, explicit line-height. If deployed Lighthouse runs show Speed Index ≥ 1.95 s: **system Arabic font** instead. | Google Fonts serves 162 KiB for this family; self-hosting it costs 11.6–21 KiB [M-lab]. It is the only small font covering the Algerian letters ڨ ڢ ڧ [M-lab]. Details in §5. |
| **Images** | AVIF product photos generated at build time (360/480/720/960/1200 w), `srcset`, preload with `fetchpriority=high`, same origin. Originals in R2. | At 720 px: AVIF 11.3 KB, WebP 16.8 KB, JPEG 37.9 KB [M-lab]. A 204 KB hero alone dropped the score to 99 [M-lab]. 96.4% of Algerian browsers support AVIF [F-DZ]. Cloudflare's own image resizing is a fallback only: 5,000 free transformations per month, and AVIF can fall back to WebP or JPEG [Doc]. |
| **Order API and server code** | **TypeScript Worker + Hono**, Valibot validation, Drizzle ORM | Hono is 8 KB gz; Valibot adds 1.4 KB vs 92 KB for Zod 4 classic; Drizzle adds 18 KB [M-lab]. |
| **Rust** | **Not in the runtime.** It is already present indirectly in the build toolchain (Tailwind v4's engine). | Measured from Djezzy: render p50 95 ms (TypeScript) vs 100 ms (Rust), and the Worker's wait on D1 was the same (26 vs 28 ms). Rust's bundle was **127.6 KiB gz vs 2.6–18 KiB**, startup 3–4 ms vs 1–2 ms, and release builds took 2.5–7 min [M-DZ]. Full analysis in §4.2. |
| **Data** | **One D1 database** (SQLite), location hint `weur` (it landed in Paris). It is **never read while a visitor waits for a page**: only on the order POST and in the admin. | A page rendered from D1 adds about +40 ms time to first byte (169 vs 127 ms p50) [M-DZ]. D1 reads take 22–28 ms p50 and inserts 21–39 ms p50, from Marseille to Paris [M-DZ]. D1 has no Africa location [Doc]. 3,000 products take 2.2 MB of its 10 GB limit [M-lab]. |
| **Side effects** | Cloudflare **Queues** for order notifications (Telegram bot, email) | Retries and a dead-letter queue; 1M operations per month included [Doc]. The order is durable as soon as the D1 insert succeeds. |
| **Publishing** | Admin save → D1 → **rebuild and redeploy the static site**. The order POST **re-checks price and stock** against D1. | Keeps pages free and static. **Not measured:** how long a rebuild takes. If it is too slow for the client's workflow, fall back to Worker-rendered pages behind **Workers Cache** with tag purge. That is the same speed (126 vs 121–148 ms p50) [M-DZ], but makes every request billable [Doc] and is new (docs dated Oct 2026). |
| **Admin** | **Custom, server-rendered TypeScript/Hono Worker** on `admin.<domain>`, behind **Cloudflare Access** (free up to 50 users), shared D1, append-only audit log | The COD confirmation workflow (call attempts, statuses, courier hand-off) is custom work on every option. Payload on Workers has an **open** bug where DELETE silently does nothing on D1 ([#15070](https://github.com/payloadcms/payload/issues/15070)) and an **unreleased** login fix ([#18274](https://github.com/payloadcms/payload/issues/18274)) [Doc, verified via GitHub API]. |
| **Anti-fraud** | Honeypot + minimum fill time; exact Algerian phone validation; dedup; per-phone rate limit; **Turnstile loaded on the first touch of the form**; one coarse WAF rule; the confirmation call. SMS OTP only for orders flagged as risky. | Turnstile loaded with the page adds **about 243 KB** and a third-party origin. Its main script alone (28 KB br) is **as large as the whole French product page** (27.9 KB) [M-DZ]. Details in §6. |
| **Measurement** | Lighthouse CI on every change (French + Arabic templates, median of 5) and our own real-user monitoring (RUM) beacon, posted to the same origin **after page load** | Lighthouse uses a simulated network and cannot see the Algeria-specific problems (data-center choice, DNS loss). Only RUM can. |

**Page budget that held 98–100 in every measurement:**
- HTML with inline CSS: about 4 KB brotli.
- Hero AVIF: 25 KB or less.
- Critical path: **45 KB or less in 4 requests or fewer** (French measured 28 KB, Arabic 44 KB).
- **No third-party origin before LCP.**

On this Djezzy line, every extra domain means another DNS lookup, and DNS was the main source of slow outliers [M-DZ].

---

## 3. Load times for Algerian mobile visitors

### 3.1 What was measured

**From Djezzy, Biskra, 2026-11-04** [M-DZ]. Method:
- curl over TCP + TLS 1.3. Our curl build had no HTTP/3; browsers use HTTP/3, which saves about one round trip on a cold connection.
- "Cold" means a new DNS lookup, TCP connection and TLS handshake.
- n = 15 per row unless noted.

| What | p50 | p75 | p90 | Data center that answered |
|---|---|---|---|---|
| Cold fetch, **in-country data center** (`one.one.one.one/cdn-cgi/trace`) | **232 ms** | 275 ms | 3.4 s* | ALG (Algiers) |
| Cold fetch, Oran-served Cloudflare property (radar) | 334 ms | 342 ms | 422 ms | ORN (Oran) / MRS (Marseille) |
| Cold fetch, `www.cloudflare.com` | 439 ms | 488 ms | 589 ms | **BCN (Barcelona)** |
| Cold fetch, **our spike page** (free / workers.dev address range) | **390–430 ms** | 400 ms – 5.4 s* | up to 8 s* | MRS / MUC (Munich) |
| Warm time to first byte (connection reused) | ALG 56–58 ms · BCN 72 ms · MRS 99 ms | | | |
| Warm time to first byte, spike: static / Hono / Rust | 121–148 / 95–117 / 100–123 ms | | | MRS |
| TCP connect by Cloudflare address range | **ALG 30–41 ms** · ORN 34–57 ms · MRS/MUC 60–240 ms | | | |

\* **About the slow tail.** Every request over 3 s involved a DNS lookup that timed out and retried. That retry used the Linux default of 5 s, querying 8.8.8.8 and 1.1.1.1 directly. Android's resolver retries sooner, so the real-user tail will be smaller. But the packet loss behind it is real.

**The spread is large.** Independent re-runs on the same day measured cold first byte anywhere from **212 ms to 777 ms**. That includes Algiers-served samples between 375 and 777 ms, and a session where the TLS handshake alone took a median of about 360 ms. **Quote ranges, not single numbers.**

**From the one live Algérie Télécom RIPE Atlas probe (fixed line, eastern Algeria)** [M-AT]:
- Cloudflare's 1.1.1.1 was answered **in-country** (Annaba / Algiers / Oran) at 6–17 ms, across Feb–Nov 2026.
- Ping round trip to Madrid / Bordeaux / Frankfurt: 44 / 45 / 52 ms.
- **Caveat:** ping times do not reliably show which data center serves web pages. On Djezzy, cloudflare.com pings like a local server, but its pages come from Barcelona.

**Lighthouse mobile, the same product page in 3 architectures, deployed on Cloudflare** (median of 3, quiet CPU) [M-DZ / M-lab]:

| Page | Static (S1) | TypeScript / Hono SSR (S2) | Rust / workers-rs SSR (S3) |
|---|---|---|---|
| French | **100** · LCP 960 ms | **100** · LCP 938 ms | **100** · LCP 953 ms |
| Arabic, web font with `swap` | 98 · LCP 1094 ms | 100 · LCP 1092 ms | 98 · LCP 1074 ms |
| Arabic, system font (local) | **100 in 5 of 5** · LCP 902 ms · CLS 0 | | |

**Real-network Lighthouse:** no simulated network, real Djezzy path, CPU slowed 4×.
- French static page: 100 in 3 of 3, LCP 555 / 625 / 1501 ms.
- Arabic page: 100 in 3 of 3, LCP 704–922 ms.

These are n = 3 samples, served from Marseille/Munich [M-DZ].

**Field data for the whole Algerian web** (HTTP Archive / CrUX, mobile, Sep 2026) [F-DZ]:

| | Origins | Pass all Core Web Vitals | p75 LCP under 1.2 s | p75 LCP under 0.6 s |
|---|---|---|---|---|
| All origins in Algeria | 70,124 | 32% (global: 53%) | 6.6% | **0.3%** |
| Astro sites in Algeria | 535 | **45%** | 10.1% | 0.0% |
| Next.js sites in Algeria | 6,168 | 17% | n/a | n/a |
| Shopify / YouCan stores in Algeria | 2,699 / 401 | 23% / 5% | n/a | n/a |

Source: `cdn.httparchive.org/v1/cwv` and `cwv-distribution` with `geo=Algeria`, re-queried by a cross-examiner with an exact match. **Caveat:** these are correlations; Astro sites are mostly content sites.

**Local baseline (Lighthouse mobile, homepages)** [M-DZ]:

| Site | Score | LCP |
|---|---|---|
| ouedkniss.com | 42–45 | 6.3–6.6 s |
| condor.dz | 39–44 | 15.5–16.3 s |
| iris.dz | 48–54 | 10.5 s |
| brandt.dz | 28–30 | 45.5 s |

A store scoring 100 would be in a different class from what Algerian shoppers usually get.

### 3.2 How close we can get

| Target | Realistic? | Basis |
|---|---|---|
| **Lighthouse mobile 100, French** | **Yes, robustly** | 100 on every French run across all architectures [M-DZ] |
| **Lighthouse mobile 100, Arabic** | **Yes, with the font decision in §5.** Must be gated in CI. | 98–100 with a `swap` web font; 100 in 5 of 5 with the system font [M-lab] |
| Cold first-visit **time to first byte under 0.4 s, median** | **Yes, if served from ALG/ORN** (about 230 ms). **Borderline from MRS/MUC** (about 390–430 ms). | §3.1 table [M-DZ] |
| Cold first-visit **LCP under 0.4 s, median** | **Only in-country, best case, and not proven end to end.** Model: about 210–560 ms when in-country [M-AT inputs]. From Marseille: no; real-network LCP was 555–1501 ms. | Network model (network report §4) + [M-DZ] |
| **LCP under 0.4 s on repeat visits and clicks within the site** | **Yes.** Prerendered pages show almost instantly; warm connections remove DNS, TCP and TLS. | Warm first byte 56–99 ms [M-DZ]; Ray-Ban prerender result [F-global] |
| **Any metric under 0.4 s at the 75th percentile for every visit** | **No.** No architecture achieves this on Algerian networks today. | 0.3% of Algerian origins are under 0.6 s p75 LCP [F-DZ]; DNS and TLS tail [M-DZ] |

**Proposed acceptance contract for the client.** It replaces "0.4 s for a real visitor", which cannot be tested as stated.
1. Lighthouse mobile **100** on every storefront template, in French and Arabic. Median of 5 runs, quiet machine, blocking in CI.
2. RUM (field data), Algerian visitors:
   - **time to first byte p50 ≤ 0.3 s**;
   - **LCP p50 ≤ 0.4 s for clicks within the site** (prerendered or prefetched pages);
   - **LCP p75 ≤ 1.2 s for first visits**. That would put the store in the top 7% of Algerian websites [F-DZ].
3. Re-baseline these numbers after the data-center test (§9). If production lands in-country, tighten the first-visit target.

---

## 4. Alternatives rejected

### 4.1 Rendering and frontend

| Alternative | Why rejected |
|---|---|
| **Next.js (via OpenNext on Workers)**, the popular default | Ships **140 KB of JS**: TBT 136–215 ms, score **96–99, never a steady 100** [M-lab]. Algeria Core Web Vitals pass rate **17%** [F-DZ]. Cloudflare's own profiling found 10–25% of request time spent in garbage collection, partly traced to OpenNext and Next.js ([Cloudflare blog, Oct 2025](https://blog.cloudflare.com/unpacking-cloudflare-workers-cpu-performance-benchmarks/)). |
| **React Router v7 / Remix** | Algeria pass rate **7% / 19%** [F-DZ]. The bare template ships 115 KB of JS [M-lab]. |
| **Nuxt** | Algeria pass rate 16% [F-DZ]. Vue's runtime alone is 23 KB compressed. *Not measured locally: the install timed out.* |
| **SvelteKit** | **Runner-up, not rejected.** Its template scored 100 with 35 KB of JS, and `csr=false` ships none [M-lab]. Its Algerian field sample is smaller (198 origins, 30% pass) [F-DZ]. A sound choice if the team prefers Svelte. |
| **Qwik, SolidStart** | Little field evidence (22 and 10 origins). Their resumability or fine-grained runtime solves a problem a 0-JS page does not have. Qwik's starter had no deployment adapter, so it was not measured. |
| **Leptos / Dioxus / Sycamore (client-side Rust/WASM)** | 47–115 KB of compressed WASM vs 5.9 KB for Preact. First paint 236–537 ms vs 42 ms for vanilla JS ([js-framework-benchmark](https://github.com/krausest/js-framework-benchmark), Nov 2026 run). Leptos has 3 origins in HTTP Archive, so no field evidence. |
| **htmx / Alpine / Turbo** | 16–45 KB gz [M-lab] to do what a form POST plus about 2 KB of plain JS does. No field advantage over Astro. |
| **Single-page app (any framework)** | The first paint waits for JS. MPA plus Speculation Rules gets the navigation gains without it (Ray-Ban, Shopify). |
| **Shopify / YouCan / similar SaaS** | Algeria pass rate **23% / 5%** [F-DZ]. No control over the JS shipped to the storefront. COD needs third-party form apps. |

### 4.2 Rust (the hypothesis, tested)

We tested Rust where it could plausibly help: rendering pages on the server and serving the order API on Workers. Two independent spikes built the same page in TypeScript and in Rust (`workers-rs` 0.8.7, optimised build) and measured from Djezzy.

| Measure | TypeScript (Hono) | Rust (workers-rs) | Source |
|---|---|---|---|
| Uncached render, time to first byte p50 / p75 / p90 | 95 / 117 / 123 ms | 100 / 120 / 141 ms | [M-DZ], n = 15 |
| Time the Worker waits on D1, p50 | 26 ms | 28 ms | [M-DZ] |
| Bundle (gzip) | 2.6–18 KiB | **127.6 KiB** | [M-lab] |
| Startup time reported by Wrangler | 1–2 ms | 3–4 ms | [Doc output] |
| Release build | seconds | **2.5–7 min** | [M-lab] |
| Lighthouse | 100 | 98–100 | [M-DZ] |

**Verdict: neutral on speed, negative on cost.**
- The workload waits on I/O. Running the SQL took 0.23 ms out of a 22 ms database round trip, and building the HTML takes under 1 ms.
- Rust also lacks JavaScript's `Intl`, so Algerian number, currency and date formatting (`ar-DZ` / `fr-DZ`) would need ICU4X.
- `workers-rs` is pre-1.0 and has breaking minor releases. Queues support is still behind a beta flag.
- **No published, current, method-documented benchmark shows Rust beating JavaScript on Workers.** The only one found dates from about 2020 and is invalid.

**Where Rust could still earn a place:** a future CPU-heavy module, such as in-Worker image processing or heavy fraud scoring, and only with a CPU-time benchmark. CPU time per request could not be measured in the spikes, because `performance.now()` is frozen during CPU work on Workers. That is the one open gap in this verdict.

### 4.3 Data, caching and admin

| Alternative | Why rejected |
|---|---|
| Rendering pages from D1 on each request | +40 ms time to first byte [M-DZ], more with several queries in sequence. Smart Placement would move the Worker toward Paris, which makes things worse for Algeria. |
| KV as the catalog store | Updates can take "up to 60 seconds or more" to reach other locations [Doc]. That risks showing a stale price. |
| Durable Objects as the primary store | No faster than D1 (11–28 ms), with a **225–372 ms first call** [M-DZ]. |
| Hyperdrive + Postgres, Turso | An extra network hop and a second vendor, with no Algeria-relevant gain. Little evidence either way. |
| Cache API / Workers Cache in front of tiny pages | No speed gain: cache hit 117–126 ms vs render 95–127 ms [M-DZ]. Workers Cache makes free static-asset requests billable [Doc]. Kept only as the fallback publish path. |
| **Payload CMS on Workers** | The two open/unreleased bugs above; it also runs Next.js through OpenNext. Revisit once #15070 is closed and a release ships the login fix. |
| Directus / Strapi / Medusa / Saleor / Vendure | Need a Node/Python server plus Postgres (Medusa also Redis and ≥ 2 GB RAM) [Doc]. That means an off-Cloudflare server to run and patch. |
| Paying for Cloudflare Business up front | It is not shown to keep Djezzy traffic in Algeria: Cloudflare's own site is served from Barcelona [M-DZ]. Decide by the test in §9. |

---

## 5. What the French/Arabic RTL requirement costs

**RTL layout itself costs about nothing. The Arabic font is the only real cost: about 150–190 ms of lab LCP and some Lighthouse score stability, on Arabic pages only.**

| Item | Measured cost | How the stack handles it |
|---|---|---|
| RTL CSS | One Tailwind v4.3.4 storefront sheet: **3.9 KiB brotli, serving both directions**. RTL-only rules: 246 B. `rtlcss` on the output changed nothing [M-lab]. | CSS logical properties (`margin-inline-start`, `inset-inline-*`, `text-align: start`), `<html lang="ar" dir="rtl">`. One inlined stylesheet. |
| Arabic font bytes | Google Fonts serves **162.3 KiB** for Noto Sans Arabic's Arabic subset. Self-hosted subset: variable 400–700 is 21.0 KiB; **static 400 is 11.6 KiB** [M-lab]. Readex Pro, Alexandria, Cairo, Tajawal and Almarai are smaller but **lack ڨ ڢ ڧ** [M-lab]. | Self-host **one static weight of Noto Sans Arabic 400**, subset to Arabic + Maghrebi letters + ASCII digits and punctuation. Preload on `/ar/` only. |
| Arabic font effect on speed | With `font-display: optional` + preload: LCP 1053–1056 ms vs **861–918 ms with the system font** (+150–190 ms), CLS 0. Speed Index was unstable: two runs reached about 3.5 s and scored 99 [M-lab]. With `swap` (deployed): 98–100, Speed Index 2.8–3.9 s [M-DZ]. | The deciding metric is **Speed Index ≤ 1.95 s on deployed runs**. If the font fails it, use the **system Arabic font** (Android's default is Noto Naskh Arabic [Doc: AOSP fonts.xml]), which scored 100 in 5 of 5. |
| Line height | Default Arabic line height ranges 1.20–2.11 em across candidate fonts [M-lab] | Set an explicit unitless line height (about 1.6–1.8). This prevents layout shift when the font swaps. |
| Text shaping | Arabic costs about 1.2–2× Latin per character (HarfBuzz, desktop) [M-lab] | Negligible at storefront text volumes. **Not measured on a real phone.** |
| i18n runtime | i18next alone is 14.4 KiB br [M-lab] | None. Pages are built per language. `Intl` `ar-DZ` / `fr-DZ` gives Western digits, `.`-grouped DZD (`189.000 د.ج.`) and Algerian month names (جانفي). Verified on the Workers runtime [M-lab]. |
| Bidirectional text bugs | Without isolation, `+213 555 12 34 56` renders as `56 34 12 555 213+` in Arabic text [M-lab] | Wrap phone numbers, Latin product names and SKUs in `<bdi>` or `dir="ltr"`. Phone input: `type="tel" inputmode="tel" dir="ltr"`. Convert Eastern Arabic digits to ASCII on the server. |

**Other rules that follow from the evidence:**
- **URLs and SEO.** Use `/fr/` and `/ar/` with reciprocal hreflang and `x-default`. **Never auto-redirect on Accept-Language.** Google advises against it and Googlebot sends no Accept-Language [Doc].
- **Language switch.** A plain link. Give its «العربية» label a system font; otherwise French pages download the Arabic font through `unicode-range`.
- **No letter-spacing on Arabic.** It breaks the joins between letters.
- **Premium motion uses only CSS:**
  - cross-document View Transitions, `@starting-style`, scroll-driven animations, `popover`, `<dialog>`;
  - each reaches **95–98% of Algerian mobile traffic** [F-DZ: caniuse × Algeria usage];
  - browsers without support get no animation; nothing breaks.
- **Screens and devices** [F-DZ: StatCounter, Oct 2026]:
  - Design from 360 CSS px: 360×800 is the most common Algerian mobile resolution (19%).
  - Android is 84% of mobile and Chrome 83%.
  - Desktop is still 43.6% of traffic, so the desktop layout matters too.
  - Assume Helio G85 / Unisoc T606-class CPUs.
- **Accessibility, WCAG 2.2 AA.** No runtime cost. It is enforced through CSS and markup:
  - tap targets ≥ 44 px (AA minimum 24 px, criterion 2.5.8);
  - `scroll-padding` under sticky bars (2.4.11);
  - contrast checked at 4.5:1;
  - `lang` on mixed-language spans (3.1.2);
  - `prefers-reduced-motion`;
  - no carousel that auto-advances without a pause control (2.2.2);
  - no cognitive CAPTCHA (3.3.8).
  
  The spike pages scored **100 on Lighthouse accessibility** [M-DZ].

**Thin evidence (RTL).** All of these need a real-device pass before launch:
- what Arabic font Samsung, Xiaomi and Infinix skins actually render;
- whether TalkBack switches voice on inline `lang` spans;
- how often an `optional` font appears on a first visit on Algerian networks;
- Arabic text-shaping cost on a real low-end phone.

---

## 6. Admin, security and fake-order protection

**Admin.**
- **Hosting and stack:** a custom TypeScript/Hono server-rendered Worker on `admin.<domain>`, with Drizzle + Valibot over the shared D1. Responses are `private, no-store`.
- **Access:** **Cloudflare Access** in front (Zero Trust free tier, up to 50 users), with security-key or TOTP MFA. The app stores no admin passwords. *Confirm in the dashboard that independent MFA is included on the free tier; the docs do not say.*
- **Roles:** owner, confirmer, logistics, content.
- **Order statuses:** new → called (attempt n) → confirmed / unreachable / cancelled → shipped → delivered / returned.
- **Product and content fields:** bilingual (`*_fr`, `*_ar`), with per-language slugs and a "Latin brand name" field.
- **Audit log:** append-only.
- **Backups:** daily D1 export to R2. Time Travel keeps only 30 days [Doc].
- **Capacity:** D1 handles about 1,000 queries/s per database [Doc], far above admin load. Use `batch()` for bulk imports.

**Fake and spam COD orders.** Layered, cheapest first, with nothing loaded on the page at first paint:
1. **Honeypot field and a minimum fill time.**
2. **Exact phone validation** using libphonenumber's Algerian mobile pattern (national: `5(4[0-29]|6[0-4])\d{6}|(55|6\d|7[7-9])\d{7}`). A naive `^0[567]\d{8}$` accepts invalid ranges such as 050–053 [Doc, verified].
3. **Deduplication** in D1, on phone + product + time window.
4. **Rate limit** with the Workers Rate Limiting binding, keyed on **phone number**, with IP as a secondary key. Never IP alone: Cloudflare's own research shows Africa has some of the highest numbers of users per IP address, because mobile carriers share IPs ([CGN blog, Oct 2025](https://blog.cloudflare.com/detecting-cgn-to-reduce-collateral-damage/)).
5. **Turnstile in invisible mode, injected on the order form's first `focusin` or `pointerdown`.**
   - Loaded eagerly, it costs api.js (28 KB br) + a 215 KB challenge iframe + a redirect: **about 243 KB from a third-party origin** served from Barcelona [M-DZ].
   - Loaded lazily, it adds 0 bytes at page load.
   - **If the Turnstile token is missing or invalid, accept the order and flag it for review**, rather than rejecting it.
6. **One coarse WAF rate-limit rule** on `/api/order`, with a high threshold.
7. **The confirmation phone call**, which is the real filter for COD.
8. **SMS OTP only for flagged orders.** Twilio charges $0.273 per SMS to Algeria, and Mobilis requires a pre-registered alphanumeric sender ID [Doc].

**Keep Bot Fight Mode OFF**, and put no managed challenges on the order path.
- Bot Fight Mode injects JavaScript into every HTML page and "cannot be bypassed" with WAF rules [Doc].
- During this research, Cloudflare began challenging scripted requests from our Algerian Djezzy IP after about 300 requests [M-DZ]. A challenge on a plain form POST would make a real shopper's order fail silently.

**There is no credible published COD refusal rate for Algeria.** Every figure found (8–40%) comes from vendor blogs. Measure it from the client's own order log from day one.

**Order form data.**
- Use the **69 wilayas / 1,541 communes** of Law 26-06 (JO n°25, 5 April 2026) and Decree 26-206 (codes 59–69) [Doc: Journal Officiel].
- Courier APIs may still use 58 wilayas until the transfer completes (31 Dec 2026), so store both codes.
- Load the commune list for the selected wilaya after LCP, as a small same-origin JSON file. *The byte size of the commune data has not been measured.*

**Couriers.** Yalidine, ZR Express and Ecotrack-based couriers have live, authenticated APIs (endpoints verified). Their field-level documentation is behind logins, so get credentials and docs from the chosen courier before committing.

**Storefront security at no speed cost.**
- **Headers:** HSTS, a **hash-based** CSP (nonce-based would stop the HTML being cached), nosniff, Referrer-Policy, Permissions-Policy and COOP. About 650 bytes, compressed by HTTP/2 / HTTP/3 after the first response.
- **Surface:** no cookies and no third-party scripts on the storefront.
- **Verification targets:** OWASP ASVS Level 2 for the admin; Level 1 plus the anti-automation controls above for the storefront.

**Personal data, one note.**
- Orders (name, phone, address) will be stored in D1 in the EU, because D1 has no Africa location.
- Algeria's personal-data law (Law 18-07, as amended by Law 25-11 in July 2025) requires:
  - a declaration to the data protection authority (ANPDP) before processing starts;
  - authorisation for transfers abroad, unless a consent or contract-performance exception applies;
  - a data protection officer;
  - an automated log of operations.
- This is paperwork plus the admin's audit log, not a stack change. The client should have it checked before launch.

---

## 7. Main risks

| # | Risk | Likelihood / impact | Mitigation |
|---|---|---|---|
| 1 | **The production domain is served from Marseille, Munich or Barcelona instead of Algiers or Oran.** Measured from Djezzy: +170 ms on a cold page, and about 50 ms more per round trip. | Likely for at least some networks / **high**: it decides whether 0.4 s is possible on first visits | Test before committing (§9). Track the serving data center in RUM. If it stays out of Algeria, lean on prerender and repeat-visit speed, and set the first-visit contract accordingly. |
| 2 | **Only one Algerian network was measured** (Djezzy, one city, one device). Mobilis, Ooredoo and Algérie Télécom mobile are untested. | Certain gap / high | Same test on SIM cards from all four networks; RUM by network (ASN). |
| 3 | **Network variance and DNS packet loss** (cold first byte 212–777 ms across sessions; DNS stalls) | Certain / medium | One origin and no third-party domains; prerender; HTTP/3 + 0-RTT for GET requests (both available on every plan [Doc]); field monitoring. |
| 4 | **Arabic font hurts Lighthouse score stability** (98 vs 100) | Medium / medium | Speed Index gate in CI; fallback to the system font, already measured at 100 in 5 of 5. |
| 5 | **Design creep**: large hero images, extra font weights, animation libraries, chat widgets, analytics tags | High over time / high | Byte budgets and Lighthouse CI blocking merges; "no third-party origin before LCP" as a written rule. |
| 6 | **Publish-to-live delay** with build-on-publish (not measured) | Medium / medium | Measure it in the first sprint. Fallback: Workers Cache with tag purge (same speed, billable, new). |
| 7 | **Turnstile**: solve rate, false positives, cost to form responsiveness (INP) and accessibility on Algerian networks are unmeasured | Medium / medium | Lazy load; accept-and-flag when it fails; the order flow never depends on it alone. |
| 8 | **Cloudflare bot systems challenging real shoppers** behind shared mobile IPs | Medium / high (lost orders) | Bot Fight Mode off; no managed challenge on `/api/order`; watch WAF events. |
| 9 | **Exam-period network restrictions (June)** | Certain yearly / medium | No launches or campaigns during the bac. "Targeted" cuts were announced for 2026 [news: TSA, Algérie360]. |
| 10 | **Single-vendor concentration**: D1 single region in Paris; one Algerian Cloudflare data center was in "major outage" on the research day | Low–medium / medium | D1 Time Travel + daily R2 export. Static pages keep serving even if D1 is down; only orders and the admin depend on it. |
| 11 | **Lighthouse version drift** changes scores (the team ran 12.6 and 13.6; scores are not comparable across versions) | Medium / low | Pin the Lighthouse version in CI and re-baseline when upgrading. |
| 12 | **Wilaya reform transition** (58 → 69) across couriers | Certain until end of 2026 / low | Store official and courier codes. |
| 13 | **Personal-data compliance** (Law 18-07 / 25-11) | Unknown / medium | Declaration filed and audit log in place before launch. |

---

## 8. Long-term maintenance

**What the team owns.**
- **One language: TypeScript.** No Rust toolchain, no Node server, no Postgres server, no Redis.
- **Components and versions measured:** Astro 7.4, Hono 4.13, Drizzle 0.45, Valibot 1.5, Tailwind 4.3, Wrangler 4.x.
- **Custom code:** the admin (CRUD, roles, audit log, COD workflow), the courier integration, and the publish → build pipeline. This is the largest ongoing cost. **No evidence quantifies it in hours.** Payload would not remove the COD workflow work.

**Routine work.**

| Cadence | Task |
|---|---|
| Every change | Lighthouse CI (French + Arabic, median of 5, pinned version) and byte budgets. Merges blocked on regressions. |
| Monthly | Read the RUM dashboard: time to first byte, LCP and INP by Algerian network, plus which Cloudflare data center served each visit. Check that the serving data center has not drifted. |
| Quarterly | Bump Wrangler's `compatibility_date`. Update Astro, Hono and Drizzle; Drizzle is pre-1.0, so expect breaking changes. Refresh the Algerian browser and device shares (caniuse and StatCounter). |
| On content change | Re-run font subsetting if new characters appear (about 1 minute). Image variants are generated on build. |
| Ongoing | Daily D1 → R2 export (cron). Review Access policies and rotate secrets (Workers secrets). Track courier API changes. |

**Running costs** (from the docs):
- Workers Paid: $5/month, which includes D1 (25 billion rows read and 50 million written per month), Queues (1M operations) and static assets (free).
- Turnstile: free.
- Cloudflare Access: free up to 50 users.
- Zone plan: depends on §9.
- SMS OTP: per message, used only for flagged orders.

**Ecosystem note.** Cloudflare acquired Astro in January 2026 ([BusinessWire](https://www.businesswire.com/news/home/20260116386991/en/Cloudflare-Acquires-Astro-to-Accelerate-the-Future-of-High-Performance-Web-Development)). This is not performance evidence. It does make long-term Workers support for Astro more likely. Because Astro and hand-written HTML produce the same bytes, leaving Astro later would cost developer time, not speed.

---

## 9. Before committing: the 1-day data-center test

This is the one measurement that can change the recommendation, and it is cheap.

1. Put the production domain on Cloudflare (Free plan first) with a 5-line Worker. It returns `request.cf.colo`, the client's ASN and timing, and serves one copy of the spike page.
2. Open it from real SIM cards on **Djezzy, Mobilis, Ooredoo and an Algérie Télécom 4G/fixed line**, at midday and at 22:00, in at least two cities. Record the `cf-ray` data center, the IPs the domain resolves to, and cold and warm timings. The scripts are in [research-evidence/spike-source/](research-evidence/spike-source/).
3. **If it is served from ALG or ORN:** keep the plan, and tighten the first-visit target in §3.2.
4. **If it is served from MRS, MUC or BCN:** repeat on Pro (one month, cancellable). If it is still served abroad, ask Cloudflare about address assignment. Choosing specific IP ranges is believed to be an Enterprise feature, but this was not verified. If nothing changes, accept it and set the first-visit contract from the measured numbers.

The test uses the existing spike code and does not affect the stack choice. It only changes the plan and the load-time promise.

---

## 10. Questions the client's engineer is likely to ask

**"Everyone uses Next.js. Why not?"**
- Measured: 140 KB of JS, Lighthouse 96–99, never a steady 100 [M-lab].
- In Algeria, 17% of Next.js sites pass Core Web Vitals, against 45% for Astro [F-DZ].
- Next.js is also the case where Cloudflare's own engineers measured garbage-collection overhead on Workers.

**"Isn't static HTML a step backwards?"**
- On this network it is not slower than server rendering: static first byte 121–148 ms vs 95–137 ms for a Worker [M-DZ]. Both are dominated by the network.
- It is free (static assets are not billed) and it has nothing to break at request time.
- Server rendering stays available for the order and admin paths.

**"Rust is faster. Why not use it?"**
- Measured on the real path, it was not faster: 100 vs 95 ms p50, and the same wait on D1.
- It cost 5–49× the bundle size, slower builds, and no `Intl`.
- The workload waits on I/O. See §4.2.

**"Can you guarantee 0.4 s?"**
- Not for every visit on Algerian networks: no website in Algeria achieves it at the 75th percentile [F-DZ].
- We can measure and promise the contract in §3.2.
- The data-center test in §9 decides how tight the first-visit number can be.

**"Will the Arabic version be slower?"**
- Layout: no (same CSS).
- Font: yes, about +150–190 ms lab LCP if a web font is used. The system-font fallback is measured at Lighthouse 100.

**"Why not pay for Business and be done with it?"**
- Cloudflare's own site is served from Barcelona on Djezzy.
- Plan level is not proven to fix routing. Test first (§9).

---

## 11. Where the evidence is thin

Said plainly:
- **Mobile networks other than Djezzy:** not measured.
- **Device CPU:** no real-phone CPU traces (Helio G85-class); chipset benchmarks are used as proxies.
- **Field data limits:** the HTTP Archive framework comparisons are correlations. Small Algerian samples (Hugo 69 origins, Qwik 22) are not used for decisions.
- **Never measured:**
  - HTTP/3 timings with curl (browsers did use h3 in the real-network runs);
  - edge cache retention for a low-traffic store;
  - time from order POST to D1 when served from Algiers;
  - Workers Cache purge timing;
  - publish-to-live time;
  - Turnstile's effect on form responsiveness (INP);
  - the size of the commune data.
- **COD fraud and refusal rates, and shared courier blacklists:** no credible Algerian data exists.
- **Lighthouse noise:** runs before 15:00 on 4 Nov were made on a heavily loaded CPU. Every TBT and score conclusion in this report uses only the quiet re-runs.

---

## Appendix A: Evidence files

All of these are in [research-evidence/](research-evidence/). The spike URLs were on temporary preview accounts and have expired; redeploy with `npx wrangler deploy --temporary` from `spike-source/s1|s2|s3`.

| What | Where |
|---|---|
| Full team reports (6) and cross-examinations (3) | [research-evidence/team-reports/](research-evidence/team-reports/) |
| Spike source: S1 static, S2 Hono, S3 Rust, compiled WASM, and the Lighthouse and curl harness scripts (`lh-final.sh`, `curl-final.sh`, `curl-stats.py`, `lh-median.py`) | [research-evidence/spike-source/](research-evidence/spike-source/) |
| Raw Lighthouse JSON, curl TSV, data-center surveys, cross-examiner re-runs | [research-evidence/measurements/raw-lighthouse-and-curl.tar.gz](research-evidence/measurements/raw-lighthouse-and-curl.tar.gz) |
| HTTP Archive Algeria queries (`cwv.py`, `dist2.py`, `cwv_dz.txt`), Lighthouse scoring math (`lhscore.py`), RIPE Atlas analysis (`bimodal.py`, `hour.py`, `parse_id.py`) | [research-evidence/measurements/](research-evidence/measurements/) |
| Backend D1, KV, DO and Rust-vs-TS measurements | [research-evidence/measurements/backend-meas/](research-evidence/measurements/backend-meas/) |
| Font subsetting, text shaping and browser-support scripts | [research-evidence/measurements/i18n-scripts/](research-evidence/measurements/i18n-scripts/) |

**Note:** the admin/security team report includes an analysis of e-commerce Law 18-05 (hosting and `.dz` domain). That topic is out of scope, because the client has accepted Cloudflare hosting, and it did not influence any recommendation.

## Appendix B: Key external sources

**Cloudflare documentation and blog**
- Workers limits: https://developers.cloudflare.com/workers/platform/limits/ (64 MiB, no compressed limit; 10 ms CPU on Free)
- Static assets billing: https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- Workers Cache: https://developers.cloudflare.com/workers/cache/
- D1 data location: https://developers.cloudflare.com/d1/configuration/data-location/ (no Africa location)
- D1 read replication: https://developers.cloudflare.com/d1/best-practices/read-replication/
- KV consistency: https://developers.cloudflare.com/kv/concepts/how-kv-works/
- Traffic Manager: https://blog.cloudflare.com/meet-traffic-manager/
- Workers CPU benchmarks: https://blog.cloudflare.com/unpacking-cloudflare-workers-cpu-performance-benchmarks/
- Carrier-grade NAT: https://blog.cloudflare.com/detecting-cgn-to-reduce-collateral-damage/
- Bot Fight Mode: https://developers.cloudflare.com/bots/get-started/bot-fight-mode/
- Turnstile client-side rendering: https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/
- HTTP/3: https://developers.cloudflare.com/speed/optimization/protocol/http3/
- 0-RTT: https://developers.cloudflare.com/speed/optimization/protocol/0-rtt-connection-resumption/
- Speed Brain: https://developers.cloudflare.com/speed/optimization/content/speed-brain/
- Status API (Algerian data centers ALG, ORN, AAE, CZL): https://www.cloudflarestatus.com/api/v2/components.json

**Field data and benchmarks**
- HTTP Archive Core Web Vitals API (Algeria): `https://cdn.httparchive.org/v1/cwv?technology=<T>&geo=Algeria`
- StatCounter Algeria: https://gs.statcounter.com/os-market-share/mobile/algeria (and the vendor, browser and screen-resolution pages)
- Ookla Algeria: https://www.speedtest.net/global-index/algeria
- RIPE Atlas probe 1001421 and measurements 156155976, 176906978, 48520672, 67966097: https://atlas.ripe.net/
- js-framework-benchmark: https://github.com/krausest/js-framework-benchmark
- Ray-Ban Speculation Rules case study: https://web.dev/case-studies/rayban-speculation-rules
- Lighthouse scoring source: https://github.com/GoogleChrome/lighthouse (`core/scoring.js`, `core/audits/metrics/*`)

**Platforms and libraries**
- Payload issues: https://github.com/payloadcms/payload/issues/15070 and https://github.com/payloadcms/payload/issues/18274
- workers-rs releases: https://github.com/cloudflare/workers-rs/releases
- libphonenumber metadata (Algeria): https://github.com/google/libphonenumber

**Algerian law and standards**
- Algerian Journal Officiel (Law 26-06 wilayas, Decree 26-206, Laws 18-07 / 25-11): https://www.joradp.dz/
- W3C Arabic layout requirements: https://www.w3.org/TR/alreq/
- WCAG 2.2: https://www.w3.org/TR/WCAG22/
