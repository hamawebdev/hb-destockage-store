## Spike & measurement report: same product page as S1 static, S2 Hono TS, S3 Rust workers-rs (FR and AR RTL)

All measurements come from one machine in Biskra on Djezzy (AS327931, 41.200.33.141) on 2026-11-04 between 13:00 and 14:15 UTC. The default gateway is 192.168.43.1, which is the default Android tethering subnet, so the link is probably a Djezzy phone hotspot. That is an inference. The load average was 1.0–3.7 for every run below; Lighthouse runs were gated on a 1-minute load under 4.

**Deployed URLs:** `https://dz-spike-{s1-static,s2-hono,s3-rust}.laced-racer.workers.dev/{fr,ar}/`. The first temporary account (`thankful-servant`) expired at 13:35 UTC and the spikes were redeployed to `laced-racer`. That account expires at 14:40 UTC today, so these links will stop working after that.

### 1. Position

- **All three architectures reach Lighthouse mobile 98–100.** Run against the deployed URLs with default simulated throttling (3 runs, median), the FR page scored 100 on S1, S2 and S3, and the AR page scored 98 to 100. LCP was 0.94–1.09 s, TBT 0–2 ms, CLS ≤ 0.007, and the page weighed 28 KB (FR) or 44 KB (AR). The rendering technology makes no measurable difference to the score. What drives it is page weight, the critical request chain and fonts.
- **The 16 KB Arabic webfont is the only thing below 100.** On AR, Speed Index rises to 2.8–3.9 s and CLS to 0.007. The same AR page with system Arabic fonts (`/ar-sys/`) scored 100 in 5 of 5 runs, with LCP 902 ms and CLS 0.
- **Rust vs TS vs static: no measurable latency difference for SSR at this page size.** Warm uncached render TTFB p50/p75/p90 was 95/117/123 ms for Hono and 100/120/141 ms for Rust, both from the MRS colo. Wrangler reported a startup time of 2 ms for S2 and 3 ms for S3. Rust costs 5× the bundle: 128 KB gzip versus 18 KB.
- **Cache API lookups cost more than re-rendering a page this small.** With a warm connection, the cache-HIT path was about 20 ms slower than rendering fresh: S2 117 vs 95 ms p50, S3 123 vs 100 ms.
- **The colo is the biggest latency lever we control, and it depends on the anycast IP pool, not on geography.** I pinned the same Worker hostname to different Cloudflare IP ranges:
  - The workers.dev and free-zone ranges (188.114.96/97, 104.21, 172.67, 104.26, 104.20) are served from MRS or MUC, with TCP connect times of 60–240 ms.
  - 104.17.x and 104.18.x are served from ORN (Oran), at 34–57 ms.
  - 162.159.140.x and 172.66.0.x land in ALG (Algiers), at 30–41 ms.
  
  With in-country serving (ALG), a cold `cdn-cgi/trace` takes 232 ms at p50, against roughly 400 ms for the spike from MUC.
- **"Under 0.4 s for a real Algerian visitor" is only reachable at p50, and only from an Algerian colo.** From MUC or MRS, cold HTML-only fetches came in at p50 390–430 ms. Across all 210 cold requests, 48.6% finished under 400 ms and 27% took more than 3 s. Every stall over 3 s involved a DNS lookup timing out and retrying at about 5 s. The resolver here is the glibc stub querying 8.8.8.8 and 1.1.1.1 directly. That retry timing is specific to this machine, but the UDP loss behind it is a property of the network.
- **The local baseline is poor.** Popular Algerian commerce sites score 28–54 on Lighthouse mobile, with LCP of 6–45 s. A page that scores 100 would be very different from what Algerian shoppers usually get.

### 2. Evidence table

| # | Claim | Evidence (numbers) | Source URL / measurement | Source type | Date | Algeria-specific? | Confidence |
|---|---|---|---|---|---|---|---|
| 1 | All three architectures score 98–100 on Lighthouse mobile (deployed URLs) | Median of 3. **S1** fr 100 [100,100,100], LCP 960, TBT 2, 27.9 KB, 3 req; ar 98 [98,100,98], LCP 1094, SI 3856, 44.5 KB, 4 req. **S2** fr 100, LCP 938; ar 100 [98,100,100], LCP 1092, CLS 0.007. **S3** fr 100, LCP 953; ar 98 [98,100,98], LCP 1074, CLS 0.007, SI 3915. a11y 100 on all. benchmarkIndex 2002–2287 | M1 | Own measurement | 2026-11-04 | yes (runs from Djezzy; LH simulates its own network) | High |
| 2 | Kufi webfont is the only thing keeping AR below 100 | `/ar-sys/` (system font, local server, simulated): 100 ×5, LCP 902, CLS 0, 26 KB. `/ar/` with Kufi: 100 ×5 locally but LCP 1053–1207, and 98–100 deployed with SI 2.8–3.9 s | M1, plus earlier `results/lh-local/L-ar*`, `L-ar-sys*` | Own | 2026-11-04 | yes | Medium-high |
| 3 | Real-network Lighthouse (no network throttling, CPU 4×, devtools method) | S1 fr 100 ×3 (LCP 555/625/1501); S1 ar 100 ×3 (LCP 704–922); S3 ar 98/100 (LCP 1821/719). All requests over h3 to the edge; network-rtt 106–127 ms | `results/lh-real/C-*` (earlier run in this session) | Own | 2026-11-04 | **yes, real Djezzy path** | Medium (n=2–3, MUC/MRS colo) |
| 4 | Cold fetch of the spike HTML from MUC/MRS | p50/p75/p90 total in ms: s1-fr 429/611/5358; s1-ar 390/402/426; s2-fr 408/5365/5409; s2-ar 390/2931/8398; s3-fr 406/5396/8429; s3-ar 613/5515/5679. Phase p50: dns 62–117, TCP 83–92, TLS 108–121, request→first byte 117–125 | M2 | Own | 2026-11-04 | **yes** | High for p50, medium for tails |
| 5 | An in-country colo roughly halves the cold page cost | Cold total p50/p75/p90 in ms: ALG `one.one.one.one/cdn-cgi/trace` 232/275/3414 (TCP 38, TLS 67, srv 57); ORN/MRS `radar.cloudflare.com/cdn-cgi/trace` 334/342/422 (TCP 60); BCN `www.cloudflare.com/cdn-cgi/trace` 439/488/589 (TCP 85); spike MRS/MUC trace 369/5078/10478. Warm TTFB p50: ALG 56–58, BCN 72, MRS 99 | M2 | Own | 2026-11-04 | **yes** | High |
| 6 | The colo is set by the anycast IP range | Spike hostname pinned with `--resolve`: 188.114.96.12 gave MRS ×5 (TCP 65–239 ms); 104.18.30.78 gave ORN ×4 and MRS ×1 (TCP 34–58 ms, HTTP 200); 104.17.10.1 gave ORN ×3 and MRS ×1; 162.159.140.220 gave ALG ×4 and ORN ×1 (403, colo visible); 172.66.0.218 gave ALG ×3 and ORN ×2; 104.21, 172.67, 104.26 and 104.20 gave MRS; 104.19 gave BCN | M3 | Own | 2026-11-04 | **yes** | High for the routing fact; unknown how plans map to ranges |
| 7 | Colo assignment moves within an hour | Spike default range: MRS in the first session, then MUC (14/15), then MRS (warm series), with occasional MAD | M2, `results/colo-survey*.txt` | Own | 2026-11-04 | yes | High |
| 8 | DNS loss is the main tail risk on this link | 58/210 cold requests had DNS > 1 s (35 at about 5 s, 6 at about 10 s, 2 at about 15 s). Every request over 3 s involved the DNS phase. Resolver: glibc stub to 8.8.8.8 / 1.1.1.1 over UDP | M2 analysis (`curl-stats.py`, phase split) | Own | 2026-11-04 | yes (Djezzy + this resolver setup) | Medium: a browser's resolver retries faster than glibc's 5 s |
| 9 | Rust vs TS uncached render: no difference | Warm, same connection, unique `?nocache=` per request, n=15: S2 95/117/123 ms, S3 100/120/141 ms (both MRS). Cold server part p50: S2 133, S3 156 ms (both MRS, within noise). Wrangler "Worker Startup Time": S2 2 ms, S3 3 ms | M2; wrangler deploy output | Own | 2026-11-04 | yes (network); render difference is global | Medium-high |
| 10 | First hit after deploy (cold isolate) | ttfb−tls: S3 189 ms vs about 138 warm; S2 179 ms vs about 130 warm. Both connections also had 5–10 s DNS stalls | `results/coldstart.txt` (n=1 each) | Own | 2026-11-04 | yes | **Low** (n=1) |
| 11 | S3 WASM size | `index_bg.wasm` 282,748 B raw (opt-level="z", lto, codegen-units=1, wasm-opt), gzip 118,415, brotli 98,929. Unoptimised cargo output 921,721 B. Upload 312.92 KiB / gzip 127.62 KiB vs S2 64.64 / 17.54 KiB. Worker size limit 3 MB on Free and 10 MB on Paid, after compression | `s3/build/`; wrangler output; https://developers.cloudflare.com/workers/platform/limits/ | Own + official docs | 2026-11-04 | global | High |
| 12 | Cache API hit is slower than rendering this page | Warm p50 TTFB: S2 HIT 117 vs MISS-render 95; S3 HIT 123 vs MISS-render 100 (MRS, n=15 each) | M2 | Own | 2026-11-04 | yes | Medium (colo noise of ±20 ms is the same size as the effect) |
| 13 | Static assets are not faster than a Worker render | Warm TTFB p50: S1 121/148 (fr/ar), S2 HIT 137/117, S3 HIT 116/123 ms | M2 | Own | 2026-11-04 | yes | Medium |
| 14 | Astro adds almost no bytes to this page | Brotli-11 HTML: S1 hand-written 3184 / 3300 B (fr/ar) vs Astro (S4) 3179 / 3289 B | `results/` transcript, S4 dist | Own | 2026-11-04 | global | High (built locally, not deployed) |
| 15 | Algerian commerce baseline (simulated mobile, 2 runs) | ouedkniss.com 45/42, LCP 6.3–6.6 s, 1.8–2.6 MB, 127–192 req. condor.dz 44/39, LCP 15.5–16.3 s, 8–9.4 MB. iris.dz 54/48, LCP 10.5 s, 2.8 MB, CLS 0.055. brandt.dz 30/28, LCP 45.5 s, 64 MB, 79 req. Real-network (1 run): ouedkniss 36, condor 39 | M1b; `results/lh-real/BASE-*` | Own | 2026-11-04 | **yes** | Medium (n=1–2, homepages, not product pages) |
| 16 | Globalping proxies | Probes in Morocco (Fes, Rabat) were served from MAD, Tunis from MRS, France from FRA/CDG. Probes got HTTP 403 from workers.dev (datacenter-ASN bot rule), so only network phases are usable. No Algerian Globalping probe was available | `results/globalping-http*.jsonl` | Own (proxy) | 2026-11-04 | proxy | Low |

**Exact commands.** All scripts are in `/tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/spike/`.

- **M1** (`lh-final.sh` → `results/lh-final/`, which also holds the M1b baseline JSONs):
  `npx lighthouse@13.6.0 <url> --output=json --only-categories=performance,accessibility --chrome-flags="--headless=new --no-sandbox --disable-gpu"`
  This uses default mobile simulated throttling (150 ms RTT, 1.6 Mbps, CPU 4×), 3 runs per URL, each run gated on load < 4. Summarised with `lh-median.py lh-extract.py results/lh-final/*.json`.
- **M1b:** the same command with `--max-wait-for-load=60000` and 2 runs, on brandt.dz and iris.dz.
- **M2** (`curl-final.sh` → `results/curl-final.tsv`, summarised by `curl-stats.py`):
  - Cold: one curl process per request, which forces a new DNS lookup, TCP connection and TLS handshake. Run as `curl -s -o /dev/null -H 'accept-encoding: br, gzip' -A '<Android Chrome UA>' -w '%{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total} %header{cf-ray} %header{x-s2-cache}' URL`, n=15 per URL.
  - Warm: one curl process with 16 URLs on a reused HTTP/2 connection. The first request is dropped, leaving n=15.
  - Cache-busting uses a unique `?nocache=$RANDOM$RANDOM` per request.
  - curl 8.5.0 has no HTTP/3, so these are TCP+TLS1.3 numbers. The browser runs above used h3.
- **M3:** `curl --resolve dz-spike-s1-static.laced-racer.workers.dev:443:<IP> -w '%{time_connect} %header{cf-ray}' https://.../fr/`, 4–5 runs per IP.

The Lighthouse batch and the curl batch ran at the same time to finish before the account expired. Lighthouse simulation adds its own fixed RTT, so curl noise has little effect on its scores.

### 3. Alternatives rejected (evidence-based)

- **Rust (workers-rs) for page SSR.** It gave no TTFB benefit (row 9: a 5 ms p50 difference in TS's favour, within noise), and the bundle is 5–7× larger (128 KB vs 18 KB gzip, row 11). The page work is string templating that takes under 1 ms, so the network and colo dominate: 85–90 ms RTT to MUC. Rust is still worth testing for genuinely CPU-heavy endpoints, such as image work or anti-fraud scoring, but this spike gives no evidence for it on the storefront path. The hypothesis was tested and found neutral, not harmful. One practical cost showed up in the spike itself: an S3 cache-HIT bug in `Response` header handling needed a fix and a 2.5-minute release build per iteration.
- **Cache API in front of SSR, for small pages.** It was slower than rendering (row 12). Rely on CDN edge caching of HTML (Cache Rules / `s-maxage`) or on plain re-rendering. Do not add `caches.default.match` inside the Worker for pages that render in under 1 ms.
- **A 16 KB Arabic webfont on the critical path.** It is the only measured cause of a score below 100 (row 2). Rejected in its current form. Use system Arabic fonts, or a subset under about 8 KB with `font-display: optional` and size-adjusted fallback metrics. Re-test this; the alternative has not been measured yet.
- **Astro vs hand-written static, judged on bytes alone.** There is no difference (row 14), so the choice can be made on developer experience. Neither option is rejected.
- **Pure static (S1) as the only model.** It was not faster than Worker SSR (row 13), and orders and admin need a Worker anyway. Static does not win on speed.
- **batolis.com as a baseline.** Rejected as invalid: it returned a 47-byte body with 2 requests, which looks like a placeholder or bot wall.

### 4. Interface assumptions for other teammates

- **Page budget that held 98–100.** HTML about 3.2–3.3 KB brotli. One hero AVIF at 960w is 22.9 KB (640w is 14.9 KB, 400w is 9.2 KB). No render-blocking JS, CSS inline, and a maximum of 3–4 requests on the critical path. The FR page totals 28 KB and the AR page 44 KB, the extra being the font. Design and frontend should treat **under 30 KB critical / under 4 requests** as the 100-score envelope.
- **A single origin hostname for everything:** HTML, images, fonts and the `/api/order` POST. Every extra hostname is another DNS lookup, and on this link DNS is the dominant tail risk (row 8). That means no third-party fonts, analytics or CDNs on the storefront path.
- **The colo is a deployment and plan decision, not a code decision.** Infra or hosting must verify the production zone's IPs and its `cf-ray` colo from Djezzy, Mobilis and Ooredoo before launch. The target is ALG or ORN. MRS, MUC or MAD costs about 50 ms more RTT per round trip and about 170 ms more on a cold page (row 5).
- **SSR vs static is free to choose on maintainability.** TS/Hono is the default for Worker code. Rust is only for isolated CPU-bound modules, and only with a benchmark.
- **For RTL/AR:** use `dir="rtl"`, `lang="ar"` and `hreflang` pairs, as the spike does. a11y scored 100 on all spike pages.
- **Measurement harness to reuse:** the four scripts listed under M1–M3. The deployed spike URLs die at 14:40 UTC today. To re-test, redeploy with `npx wrangler deploy --temporary` from `s1/`, `s2/` or `s3/`.

### 5. Risks and thin evidence

- **Whether a production plan gets an ALG/ORN IP range is unknown.** I proved routing differs by range (row 6) but found no documentation mapping plans to ranges. Cloudflare-owned properties land in ALG/ORN, and free-plan and workers.dev ranges land in MRS/MUC. This is the single largest unknown for the 0.4 s goal, and it can only be settled by testing the real zone.
- **One vantage point:** one ISP (Djezzy), one city (Biskra), one device, probably a phone hotspot. There is no Mobilis or Ooredoo data, and no RIPE Atlas or Globalping probe in Algeria was usable. All non-DZ proxies (Morocco to MAD, Tunisia to MRS) were 403'd by workers.dev.
- **The DNS stall rate (27% over 3 s) is inflated by glibc's 5 s retry.** Chrome on Android and Android's own resolver retry sooner, and the OS cache hides repeat lookups. The real-user tail will be smaller, but the UDP loss behind it is real. Field data (CrUX for DZ origins) would be needed to size it.
- **"Under 0.4 s" with n=15 per URL:** p50 is just at the limit from MUC and comfortably under it from ALG (232 ms). p75 and p90 are dominated by stalls. The 0.4 s target as stated (every visit) is not reachable on this network with any architecture. At p50 it is plausible with an Algerian colo.
- **Rust vs TS cold start** rests on n=1 per stack (row 10), and the colos moved between series (MUC → MRS), which adds ±20–40 ms of noise. That noise is larger than any render difference.
- **The Lighthouse baselines are homepages** with 1–2 runs each, not product pages. ouedkniss is a classifieds site, not a direct competitor. brandt.dz's 64 MB comes mostly from media; I did not check whether it is a one-off.
- **Lighthouse simulated throttling** uses a fixed 150 ms RTT and ignores the real colo, so scores of 100 do not prove that real-user speed is good. Rows 4 and 5 are the real-network evidence.

**Housekeeping.** I killed the spike's leftover local server (`node localserve.mjs` on :8790) and an orphaned Lighthouse Chrome left by the interrupted run. Nothing I started is still running. Nothing new was deployed.

**Result files:**
- `/tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/spike/results/lh-final/`
- `/tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/spike/results/curl-final.tsv`
- `/tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/spike/results/lh-real/`
- `/tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/spike/results/lh-local/`
- `/tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/spike/s3/build/index_bg.wasm`