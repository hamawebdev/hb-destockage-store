## Cross-examination: rendering, data layer, fonts and Rust, checked against the spike measurements

All checks below were run from the Djezzy line in Biskra on 2026-11-04 (load average 0.7–1.1). Doc copies and HTTP Archive JSON are in `/tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/xexam/`.

### 1. Disputes

**D1. Arabic font: how big, and does `font-display: optional` remove the LCP cost?**
- **Claims.** The i18n teammate wants Noto Sans Arabic as a variable font (21 KiB) with `optional` and says it "cannot delay rendering". Frontend says one weight of about 11 KB or less. The spike says use the system font, or a subset under about 8 KB.
- **Challenge.** All three are partly wrong about what was actually measured:
  - The spike's "Kufi is the only thing below 100" result used `font-display:swap` (16,032 B; checked with `grep font-display spike/s1/public/ar/index.html`). So `optional` was never tested in the deployed runs.
  - The frontend teammate did test `optional`. Running `lh/R-ar-opt-*.json` and `lh/ar-opt-*.json` through a Python extraction gives:
    - LCP 1053–1056 ms, compared with 861–918 ms for the system font;
    - CLS 0;
    - Speed Index 844–3551 ms, with two runs scoring 99 because Speed Index reached about 3.5 s. Those runs were contended.
  - So `optional` with a preload still costs about 150–190 ms of lab LCP. The i18n claim that it "cannot delay rendering" is false.
- **Resolution.** Every measured font size from 10.5 to 16 KB keeps LCP far under the 1546 ms limit. The metric that actually costs points on Arabic pages is **Speed Index**:
  - spike deployed runs: 2.8–3.9 s;
  - frontend contended runs: 3.5 s.
  
  The 21 KiB variable font has not been measured at all. The best-supported pick is **one static weight of Noto Sans Arabic 400 at 11.6 KiB**. It is the only small option that covers ڨ/ڢ/ڧ (i18n rows 13–14). Fall back to the system font if Speed Index stays unstable.
- **Confidence:** medium.

**D2. Is the Cache API a no-op on workers.dev?**
- **Claims.** Backend row 19 says yes. The spike says a cache HIT is about 20 ms slower than rendering.
- **Verification.** `awk -F'\t' '{print $2,$14,$15}' spike/results/curl-final.tsv` shows S2 x-s2-cache=HIT in 29 of 31 requests and S3 HIT in 59 of 62. The current Cache API doc talks about how `.workers.dev` cache keys behave, which implies it works there (`xexam/workers_runtime-apis_cache_.md`, line 133).
- **Resolution.** Backend's claim is wrong for this setup. The spike's "HIT is slower" holds, but the 20 ms difference is inside the ±20 ms colo noise. Either way, a cache lookup buys nothing for a page that renders in under 1 ms.
- **Confidence:** high that the Cache API works; low on the size of the latency effect.

**D3. Workers Cache (backend) vs static assets (frontend)**
- **Docs.** `developers.cloudflare.com/workers/cache/index.md` lines 530–541: turning on Workers Cache makes **every** request billable, including static-asset requests that are otherwise free. `/workers/static-assets/billing-and-limitations/` line 21: static assets are "free and unlimited".
- **Measurements.**
  - Backend: cache HIT 126 ms vs plain Worker 127 ms.
  - Spike row 13: static assets 121/148 ms vs Worker 116–137 ms.
- **Resolution.** No speed difference, but static is free. **Use static assets for the storefront and skip Workers Cache.** Keep Workers Cache in reserve only if per-request SSR is ever needed.
- **Confidence:** high.

**D4. Worker size limit**
- The spike says 3 MB on Free and 10 MB on Paid, compressed. Backend says 64 MiB uncompressed.
- The limits doc (lines 276–278) says "64 MiB… There is no compressed size limit."
- **Resolution:** the spike's figure is out of date. Bundle size does not rule Rust out; it is only a cost.
- **Confidence:** high.

**D5. Cold time to first byte (TTFB) from Djezzy**
- **Claims.** Backend: cold first byte p50 643–707 ms (TLS p50 about 360 ms) in its session A. Spike: 390–430 ms.
- **Re-check.** One fresh curl per request, 3 per host, which includes DNS:
  - BCN: 248–326 ms;
  - ORN (radar, 104.18.x): 212–228 ms;
  - ALG: 375–777 ms (TCP connect 170–410 ms in this sample).
- **Resolution.** Both reports are honest samples of a very variable link. Even the in-country ALG colo was not reliably fast in my sample. No single cold-TTFB figure is reliable; quote ranges only.
- **Confidence:** high that the variance is real.

**D6. Where Cloudflare serves Djezzy from: IP range or plan?**
- **Claim.** Spike: the IP range decides the colo.
- **Re-check.** Same domain, different ranges:
  - radar on 104.18.30/31 → ORN in 2 of 3 runs, MRS in 1;
  - www, workers and developers on 104.16.x → BCN in 9 of 9.
- **Resolution.** This confirms that the anycast range decides the colo. **What we cannot know** is which range a production zone gets.
- **Confidence:** high for the routing fact; unknown for production.

**D7. How much of Algeria supports cross-document View Transitions?**
- Frontend says 83.2% (all platforms). i18n says 95.6% (mobile-weighted).
- **Resolution.** Both are right for their own denominator. It does not matter, because the feature is progressive enhancement.

**D8. Rust**
- **Measurements.**
  - Spike: Hono uncached render p50 95 ms, Rust 100 ms.
  - Backend: Rust had the lower minimum (114 vs 129 ms, and 120 vs 152 ms), but the p50s ranged 163–370 ms, which is pure noise. D1 wait time was the same (26 vs 28 ms).
  - Both teams agree on bundle size: 127.6 KiB gzip vs 2.6–18 KiB.
  - Wrangler startup: 3–4 ms vs 1–2 ms.
  - Release builds took 2.5–7 min.
  - Extra cost from i18n: `Intl` is not available in Rust, so `ar-DZ` number and date formatting would need ICU4X.
- **Resolution.** **No measurement justifies Rust anywhere in this stack.** The hypothesis was tested and comes out neutral on latency and negative on cost. CPU time per request was never measured (`performance.now()` is frozen during CPU work), so Rust stays allowed only for a future CPU-heavy module, and only with its own benchmark.
- **Confidence:** medium-high.

**D9. Is the framework choice backed by field data or by popularity?**
- **Re-checked the HTTP Archive API** (`cdn.httparchive.org/v1/cwv?technology=…&geo=Algeria&start=2026-09-01`), mobile origins passing all Core Web Vitals:
  - Astro 239 of 535 = 44.7%;
  - Next.js 1054 of 6168 = 17.1%;
  - all origins 22578 of 70124 = 32.2%.
  
  The frontend's figures check out exactly.
- **But** this is a correlation between frameworks, confounded by site type (Astro sites are mostly content sites).
- The causal evidence is the lab work:
  - Astro and hand-written HTML produce the same bytes (spike row 14: 3179 vs 3184 B brotli);
  - Next.js ships 140 KB of JS with TBT 136–215 ms.
- **Resolution.** Choose "zero-JS static HTML" on measurement. Astro is chosen for developer experience, not speed. Cloudflare owning Astro is not performance evidence.
- **Confidence:** high for the zero-JS model; low for Astro over SvelteKit or Hugo.

**D10. Anti-spam vs the byte budget (new finding)**
- **Re-check.** `curl -sL -H 'accept-encoding: br' https://challenges.cloudflare.com/turnstile/v0/api.js` gives 28,091 B on the wire. It redirects via a 302 and is served from BCN, a separate origin.
- That is more than the whole French product page (27.9 KB) and adds a DNS lookup on a link where DNS is the main source of slow outliers.
- **Resolution.** Load it only on focus or submit of the order form (frontend's rule). Turnstile's effect on order-page INP and real form completion has not been measured.

### 2. Verified claims that survived

- Zero-JS static HTML scores 100 in the lab and when served from a real edge (spike M1, frontend rows 1 and 27). The rendering technology (static, Hono or Rust) does not change the score.
- Static assets are free and do not invoke the Worker; Workers Cache makes them billable (docs above).
- Worker limits: 64 MiB with no compressed limit; CPU 10 ms on Free and 30 s by default on Paid (`limits/index.md` lines 22, 73, 276).
- HTTP Archive Algeria pass rates (re-queried, exact match).
- The colo depends on the anycast range (re-verified: 104.18 → ORN, 104.16 → BCN).
- RTL costs almost no CSS (Tailwind 3.9 KiB brotli for both directions). Google Fonts serves Noto Sans Arabic at 162 KiB; self-hosting is required.
- D1 has no location hint for Africa. The storefront never queries D1 while a visitor waits, so having the database in Europe does not affect page loads. It costs about 21–39 ms only on the order POST.

### 3. Claims to drop or downgrade

- **Drop:**
  - spike's "Worker size limit 3 MB / 10 MB compressed" (out of date);
  - backend's "Cache API does nothing on workers.dev" (the spike's HITs disprove it);
  - i18n's "`optional` font cannot delay rendering or shift layout" (it measured +150–190 ms LCP).
- **Downgrade:**
  - spike's "the 16 KB webfont is the only thing below 100". It was tested with `swap` only, and Speed Index was unstable with `optional` too.
  - "Cache HIT is slower than rendering" (an effect the size of the noise).
  - The HTTP Archive framework rankings, from causal evidence to correlation only.
  - Backend's cold first-byte figure of 643–707 ms, and the spike's 390–430 ms. Each is one session's snapshot; I measured 212–777 ms.
  - Frontend's "Hugo 65%" (n=69), Qwik (n=22), and any Shopify comparison.
- **Out-of-date or weak sources:** the Rust-vs-JS speed test from about 2020; the SF Arabic forum posts from 2017–2020.

### 4. Joint recommendation for this seam

1. **Storefront pages:** pre-rendered static HTML per language (`/fr/`, `/ar/`), served from Workers static assets. Astro static or hand-written templates both work; pick on developer experience. Ship 0 KB of JS before LCP. No Workers Cache and no Cache API on the page path.
2. **Byte envelope:**
   - HTML with inline CSS about 4 KB brotli, CSS 5 KiB or less;
   - hero image as AVIF, 25 KB or less, preloaded from the same origin;
   - critical path 45 KB or less in 4 requests or fewer (French about 28 KB);
   - no third-party origin before LCP.
3. **Arabic font:**
   - one static Noto Sans Arabic 400 subset (11.6 KiB);
   - `optional`, with a preload on `/ar/` only;
   - set an explicit line-height;
   - no faux-bold-heavy design.
   
   Re-test with Speed Index as the deciding metric. If Speed Index does not stay under about 1.95 s on deployed runs, switch to the system font.
4. **Worker in TypeScript with Hono**, used only for `/api/order`, admin, and the rebuild trigger on publish. D1 with the `weur` hint, plus Queues for side effects.
5. **Rust:** none. Revisit only for a CPU-heavy module that is backed by a CPU-time benchmark.
6. **Turnstile:** about 28 KB from a third-party origin, loaded only on focus or submit of the order form.

### 5. Unknowns only a production pilot in Algeria can answer

- Which anycast range and colo (ALG, ORN, MRS or BCN) the real production zone and custom domain get on Djezzy, Mobilis, Ooredoo and Algérie Télécom fixed lines, and whether that stays stable over a week.
- Real-user p75 LCP and TTFB from RUM or CrUX. In particular, how much the DNS loss we saw (27% of requests over 3 s with the glibc resolver) affects Chrome on Android.
- How often an `optional` Arabic font actually renders on first visit, and what OEM skins (Samsung, Xiaomi, Infinix) show instead.
- Turnstile's effect on order completion, and false positives for Algerian mobile users behind carrier-grade NAT (backend saw a `cf-mitigated` challenge after about 300 requests).
- How long it takes for a published edit to go live (rebuild plus deploy), versus a purge, under real admin workflows.
- Real CPU time per request on Paid, which is the last open input for the Rust question.