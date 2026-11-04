# Cross-examination: the Algeria latency budget seam

All checks ran from the Djezzy machine in Biskra (AS327931) at 15:17 local on 2026-11-04, with load 0.66. I ran no Lighthouse, builds or deploys. My re-runs and fetched docs are in `/tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/xexam/`.

## 1. Disputes

**D1. Ping times do not show which colo serves the page.** (Network rows 4–8 and the budget's R inputs; Backend row 3.)
- **Challenge:** Network's in-country, bimodal and "Free moves to Europe" analysis rests mostly on ICMP pings from RIPE Atlas. Backend reads a 32.7 ms ping as "the round trip to the Workers edge".
- **Verification:** ping and TCP connect disagree on the same IPs.
  - 188.114.96.12 (spike, served from MRS): `ping -c5` gives min/avg 34/39 ms, but `curl --resolve … -w %{time_connect}` gives 72–76 ms TCP.
  - 104.16.132.229 (cloudflare.com, which Network calls "local, 12 ms"): ping min 32.7 ms, but TCP 51–58 ms, and `cf-ray` says **BCN**.
  - This fits the Traffic Manager blog (https://blog.cloudflare.com/meet-traffic-manager/). Its "move Free first" quote checks out, and it says traffic is moved "through Plurimog/Duomog", meaning it enters at one data center and is forwarded to another. That is an inference about the mechanism; the evidence is that ICMP and TCP latencies diverge.
- **Resolution:** ICMP RTT is not evidence of the HTTP serving colo. The DNS CHAOS `id.server` result (1.1.1.1 answered from AAE/ALG/ORN, Network row 2) still holds, because it identifies the server that answered. "cloudflare.com stays local" holds only as ping data from Algérie Télécom. On Djezzy, cloudflare.com's HTTP is served from BCN.
- **Confidence:** High that ICMP ≠ serving colo. Medium for the mechanism.

**D2. Does the plan decide the colo, or the IP range?** (Network: "Business, Pro minimum". Spike: "set by the anycast IP range".)
- **Verification:** I re-ran Spike's pins and every result reproduced:
  - 104.18.30.78 → ORN (TCP 39–44 ms)
  - 162.159.140.220 and 172.66.0.218 → ALG (TCP 31–56 ms)
  - 188.114.96.12 → MRS (72–76 ms)
  - Unpinned: one.one.one.one → ALG, radar → ORN, www.cloudflare.com → BCN, spike → MRS. Same `cf-ray` colos as Spike's report.
- **Resolution:** Cloudflare's own top-tier property goes to Spain from Djezzy, so "a paid plan keeps you in Algeria" is **not supported on Djezzy**. The serving colo depends on the IP prefix and on the ISP's routing, and possibly on plan through Traffic Manager. The evidence cannot separate these effects. The plan recommendation is a hypothesis to test, not a finding.
- **Confidence:** High for the routing facts. Evidence is insufficient on the effect of plan.

**D3. Mobile RTT in the budget.** (Network: R = 30–40 ms local and 55–65 ms in Europe.)
- **Verification:** Spike measured TCP connect at 30–41 ms to ALG and 83–92 ms to MUC/MRS; my re-run gave 72–90 ms to MRS.
- **Resolution:** The in-country figure holds. The Europe case is underestimated by about 20–30 ms per round trip, so Network's "R=60" column is optimistic for Djezzy.
- **Confidence:** Medium-high, from one vantage point.

**D4. Assumed TTFB vs measured TTFB, cold.** Network's model gives 110–290 ms in-country.
- **Measured:**
  - ALG `cdn-cgi/trace`, cold total: p50 232 ms (Spike). My re-run: 212–265 ms, n=3.
  - ORN radar: 237–315 ms.
  - MRS spike: 399–417 ms (mine) and p50 390–430 ms (Spike).
  - Backend's session A reached p50 643–707 ms when TLS swung to 360 ms.
- **Resolution:** The in-country model is roughly right for p50 and too optimistic for the tails. curl measures TCP+TLS, so HTTP/3 would remove about one round trip (about 35 ms in-country, about 80 ms to MRS). Nobody measured that with curl. Spike's browser runs did use h3.
- **Confidence:** Medium.

**D5. Worker size limit.** (Spike row 11: 3 MB on Free, 10 MB on Paid, compressed. Backend row 1: 64 MiB, no compressed limit.)
- **Verification:** `curl https://developers.cloudflare.com/workers/platform/limits/index.md` says "Worker size (uncompressed) 64 MiB | 64 MiB … There is no compressed size limit."
- **Resolution:** Backend is right and Spike's figure is stale. This has no effect on the Rust verdict.

**D6. Does the Cache API work on workers.dev?** (Backend row 19: "does nothing on workers.dev". Spike row 12: cache hits measured.)
- **Verification:**
  - `curl -sI https://dz-spike-s2-hono.laced-racer.workers.dev/fr/` returned `x-s2-cache: HIT`, `cf-cache-status: HIT` and `age: 389`.
  - In `curl-final.tsv`, S2 and S3 returned HIT on 14–16 of 15–16 requests.
  - The Cache API doc mentions `.workers.dev` only in a query-string cache-key note, not as a no-op.
- **Resolution:** Backend row 19 is wrong. Both teams agree on the conclusion that matters: a cache hit gives no TTFB gain over rendering a trivial page (backend 126 vs 127 ms, spike +20 ms). Caching matters only where it removes the +40 ms D1 render (Backend row 5).
- **Confidence:** High.

**D7. Is static faster than Worker SSR?** (Frontend: "static assets skip the Worker".)
- **Evidence:** Spike row 13 shows S1 static warm TTFB p50 of 121–148 ms against 95–137 ms for S2/S3.
- **Resolution:** Static is free and simpler, but it is not faster. Choose it for cost and maintainability, not speed.
- **Confidence:** Medium.

**D8. Lighthouse 100: is it robust for Arabic?** Frontend says 100. Spike says the Arabic page scores 98–100.
- **Evidence:**
  - Frontend's AR page had CLS 0.049 in 2 of 3 quiet runs, above the 0.039 threshold for a perfect score.
  - Spike's deployed AR page scored 98 in 2 of 3 runs on S1 and S3.
  - The system-font AR page scored 100 in 5 of 5 runs, with CLS 0.
- **Resolution:** 100 is robust for FR. For AR it is robust only with system fonts or one preloaded subset weight with metric overrides (Frontend: CLS 0 in 6 of 6, but measured under contended load). The `font-display: optional` variant has not been measured.
- **Confidence:** Medium-high.

**D9. Data location.** Network: "no EU database on the page path". Backend: D1 in `weur` (CDG).
- **Resolution:** The two do not actually conflict. Backend keeps D1 off the page path, and both treat the order POST cost as acceptable: 21–39 ms per query from MRS to CDG. One gap remains. If production is served from ALG, the Worker-to-CDG round trip will be longer than the MRS-to-CDG figure that was measured, and that has not been measured.

## 2. Verified claims that survived

- Cloudflare has 4 Algerian colos on its status API (ALG, AAE, ORN, CZL); AAE was in outage today. *(Network row 1, official.)*
- From Djezzy, the HTTP serving colo is decided per IP prefix: ALG and ORN are reachable, but the workers.dev and free ranges go to MRS/MUC. *(Re-run reproduced.)*
- An in-country cold HTML-only fetch takes about 210–265 ms; from MRS it takes about 400–420 ms. *(Re-run.)*
- Lighthouse 100 does not depend on server language or Algerian network latency; the drivers are bytes, fonts and JS. Supported by:
  - S1, S2 and S3 all scoring 98–100;
  - Next.js scoring 96–99 with TBT 136–215 ms;
  - the threshold math (FCP ≤ 1067, LCP ≤ 1546, TBT ≤ 65, CLS ≤ 0.039).
- Rust shows no measurable TTFB difference, with a 5–49× larger bundle. Two independent spikes agree: Spike row 9 measured 95 vs 100 ms p50, and Backend row 10 found the difference smaller than the noise.
- A D1 render adds about +40 ms TTFB, so the storefront must not query D1 per request. *(Backend row 5.)*
- The Traffic Manager quote ("We move Free customers first …") is verbatim from the blog.
- The 10 ms CPU limit on Free is confirmed in the limits doc.
- Only 0.3% of Algerian origins have p75 LCP under 600 ms. *(Frontend row 12, HTTP Archive. Algeria-specific field data.)*

## 3. Claims to drop or downgrade

- **Drop:** Backend row 3, "ICMP 32.7 ms = round trip to the Workers edge". ICMP does not reflect the serving colo (D1).
- **Drop:** Backend row 19, "Cache API is a no-op on workers.dev" (D6).
- **Drop:** Spike row 11's "3 MB / 10 MB compressed" limit (D5).
- **Downgrade to hypothesis:** Network's "Business, Pro minimum keeps you in Algeria". cloudflare.com itself is served from BCN for Djezzy. The plan effect is unproven, and Network's bimodal RIPE data is ICMP-only, from 1 fixed Algérie Télécom probe, on sites whose plan is unknown.
- **Downgrade:** Network's "R=55–65 ms for Europe". The measured Djezzy figure is 75–92 ms.
- **Downgrade:** Spike's "27% of requests over 3 s". This comes from glibc retrying direct queries to 8.8.8.8/1.1.1.1 after 5 s, which is not how phones resolve. Some UDP loss is real, but its size for real users is unknown.
- **Global or proxy, not Algeria-specific:** Ookla's 23 ms mobile latency is measured to Ookla servers, and the 3GPP radio-wake figure is a standards analysis, not field data.
- **Algeria-specific but weak:** the Opensignal figures are search excerpts only.

## 4. Resolved joint recommendation for this seam

1. **Treat colo as the first launch gate.** Before committing to a plan:
   - Put the production custom domain on the intended plan (Pro first).
   - Record its assigned IPs and the `cf-ray` colo from Djezzy, Mobilis, Ooredoo and Algérie Télécom, at midday and at 22:00.
   - Target ALG or ORN. If the zone lands in MRS, MUC or BCN, escalate: try a different plan, or ask Cloudflare about address assignment.
   - My recollection is that choosing specific IP ranges is an Enterprise feature (BYOIP or static IPs), but I did not verify this.
   - Do not pay for Business on the strength of the current evidence.
2. **Storefront architecture:** static assets or cached HTML, one origin, no third parties before LCP, at most about 30–45 KB critical and at most 4 requests. Use system Arabic fonts, or one subset weight with metric overrides. Use TS/Hono for Workers. Rust stays off the page path, which both spikes found neutral.
3. **Define 0.4 s precisely:**
   - **TTFB p50 under 0.4 s on a cold first visit:** achievable only in-country (measured about 232 ms). Not achievable at p50 from MRS (measured about 400 ms).
   - **LCP under 0.4 s:** achievable for warm, repeat and prefetched or prerendered navigations, through Speculation Rules.
   - **Cold-visit LCP under 0.4 s:** at best a median target, in-country only, and unproven end to end.
   - **p75 for every visit:** not achievable. Field data puts 0.3% of Algerian origins under 600 ms p75 LCP.
4. **Lighthouse mobile 100:** achievable and robust for FR at the byte budget above. For AR, it holds only with the font fix, and it must be re-verified (gate on load under 4, median of 5). Lighthouse uses a simulated network, so a score of 100 says nothing about the 0.4 s goal.

## 5. Unknowns only an Algerian production pilot can answer

- The serving colo and its stability for the real zone and plan, on Mobilis (AS327712), Ooredoo (AS33779), Algérie Télécom and Djezzy, at peak hours.
- The real-user DNS failure and tail rate with carrier resolvers and Android Private DNS. This needs RUM: Cloudflare Web Analytics plus a `cf.colo` beacon.
- HTTP/3 and 0-RTT gains on Algerian mobile; nobody measured h3 with curl.
- Edge cache retention for a low-traffic store at ALG/ORN, how often misses go to an upper tier in Europe, and how long those misses take.
- Order POST latency from the ALG colo to D1 in CDG.
- Bot or challenge false positives behind carrier-grade NAT. Backend saw `cf-mitigated: challenge` after about 300 requests.
- Field p75 LCP and INP by device mix. Samsung, Xiaomi, Oppo, Realme and Infinix make up about 68% of phones; CPU cost was not measured on a real phone.
- Behaviour during June exam-period network restrictions.