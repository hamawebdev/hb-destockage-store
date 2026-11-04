## Network & Edge: how Algerian visitors reach Cloudflare, and the physical latency budget

### 1. Position

- **Cloudflare serves Algeria from inside the country. The site does not need a hosting region in Europe.** Cloudflare's status API lists four Algerian data centers: Algiers (ALG), Annaba (AAE), Oran (ORN) and Constantine (CZL). The one live RIPE Atlas probe in Algeria is on an Algérie Télécom residential line. From it, traffic to 1.1.1.1 and to cloudflare.com is answered by `AAE`/`aae01`, `alg02` and `orn02`. Round trips are 6–17 ms and the path goes straight from Algérie Télécom's internal routers to Cloudflare. Cloudflare lists no Algerian facility in PeeringDB, so these data centers are most likely hosted inside the ISP networks.
- **The Cloudflare plan matters for Algeria. Do not ship on the Free plan.** From the same probe, two third-party sites on Cloudflare's shared address ranges show two distinct latency groups: about 16–20 ms (in-country) and about 40–45 ms. The 40–45 ms group matches the probe's measured latency to Madrid (44 ms) and Bordeaux (44.6 ms). In October 2026, 13–40% of samples fell in the 40–45 ms group. In the evening (20:00–01:00 local) that rose to 48–63%. Cloudflare's own enterprise site, cloudflare.com, stayed at about 12 ms median with p90 about 16 ms. This matches Cloudflare's published Traffic Manager policy: "We move Free customers first … then Pro, and then Business." **Recommendation:** use the Business plan if the budget allows, Pro as the minimum. Then check the actual data center with a spike that reads the `cf-ray` header from Algerian phones before launch. I could not measure a Pro or Business site specifically, so how much paying more reduces this effect is inferred, not proven.
- **Every storefront HTML page must be served from Cloudflare's edge cache.** If a page goes to an origin, or to a database outside Algeria, it adds at least 45–60 ms per round trip. When a small store's page is missing from the Algiers cache, the request goes to an "upper tier" cache, which will likely be in Europe. So pages need long TTLs, deploy-time pre-warming, and static assets served by the Workers static-asset mechanism.
- **Protocol settings to turn on:** HTTP/3 and 0-RTT (both available on all plans; 0-RTT is off by default and only covers GET/HEAD/OPTIONS), one single origin with no third-party domains, and Speculation Rules. Use our own prerender rules. Cloudflare's "Speed Brain" only prefetches, uses conservative eagerness, and **skips routes that invoke a Worker**. Early Hints (103) does almost nothing for pages already in the edge cache, because the real response is ready immediately.
- **"0.4 s" has to be defined. Proposed contract** for real Algerian visitors, measured with RUM:
  - Time to first byte under 0.2 s at p75 on any visit.
  - Largest Contentful Paint (LCP) under 0.4 s at p75 for repeat visits and navigation within the site.
  - LCP under 0.4 s at the **median** for a first visit. p75 is not reliably achievable for a first visit on mobile.
  - Full page load under 0.4 s is not realistic for a first visit.
- **The Lighthouse score of 100 does not depend on Algerian networks.** Lighthouse simulates a 150 ms round trip, 1.6 Mbps and a 4× slower CPU. Each metric needs about: FCP ≤ 1.07 s, LCP ≤ 1.55 s, Total Blocking Time ≤ 65 ms, layout shift ≤ 0.039, Speed Index ≤ 1.95 s. This is a page-weight and JavaScript problem for the frontend teammates, not a network problem.

### 2. Evidence table

| # | Claim | Evidence (numbers) | Source / measurement | Source type | Date | Algeria-specific? | Confidence |
|---|---|---|---|---|---|---|---|
| 1 | Cloudflare has 4 Algerian data centers | Components "Algiers (ALG)", "Annaba (AAE)", "Oran (ORN)", "Constantine (CZL)". On 2026-11-04 AAE showed **major_outage**; the others were operational | `curl https://www.cloudflarestatus.com/api/v2/components.json` | Official status API | 2026-11-04 | yes | High |
| 2 | 1.1.1.1 is answered inside Algeria for an Algérie Télécom user | DNS CHAOS `id.server` answers from probe 1001421: Feb–Apr 2026 `AAE` (median 7.6–8.7 ms); May–Aug `aae01`/`alg02` (6.5–9.3 ms); Sep–Nov `alg02`/`orn02` (12.9–17.5 ms, after Annaba went out) | RIPE Atlas measurement 156155976, `.../measurements/156155976/results/?probe_ids=1001421&start=1761955200` | Own analysis of public data | Feb–Nov 2026 | yes (1 fixed-line probe) | High for this probe |
| 3 | The probe is a residential Algérie Télécom line in eastern Algeria | IP 41.111.198.131, prefix 41.111.128.0/17 ("LS RMS"), route object origin AS36947, coordinates 36.30N 7.92E | RIPE Atlas probe API; RIPEstat whois | Registry data | 2026-11-04 | yes | High |
| 4 | Path to Cloudflare stays on Algérie Télécom's network | Traceroute: 4 private hops, then 41.110.36.3 / 41.110.38.13, then the Cloudflare address. cloudflare.com median 11.8 ms (Oct 2026); x.com (172.66.0.227) 12.2 ms | RIPE measurements 117793446, 176906981, 177421189 (probe 1001421) | Own analysis | Aug–Nov 2026 | yes | High |
| 5 | Cloudflare's enterprise site stays local | Ping to 104.16.132/133.229, Oct 2026: median 11.7 ms, p90 16.3 ms; Jun–Aug median 6.2–7.7 ms | RIPE measurement 176906978 | Own analysis | Jun–Nov 2026 | yes | High |
| 6 | Third-party sites on Cloudflare's shared address ranges sometimes leave Algeria | Oct 2026 minimum-RTT buckets: 172.67.142.30 → 110 samples at 15–20 ms, 19 at 40–49 ms (13% far); 104.26.8/9.82 → 431 at 15–24 ms, 280 at 35–90 ms (39.5% far); about 0.7% packet loss | RIPE measurements 48520672, 67966097; script `bimodal.py` | Own analysis | Oct 2026 | yes | Medium. The plan of these sites is **unknown** |
| 7 | Far routing peaks in the evening | Share of samples over 30 ms by local hour (Sep–Oct 2026, measurement 67966097): 27–41% from 09:00 to 19:00; 48–63% from 20:00 to 01:00 | Script `hour.py` (UTC+1) | Own analysis | Sep–Oct 2026 | yes | Medium |
| 8 | The 40–45 ms group is Europe | Same probe in Oct 2026: Madrid anchor median 44.0 ms, Bordeaux 44.6, Frankfurt 51.8 | RIPE measurements 29692049, 10404730, 10103391 | Own analysis | Oct 2026 | yes | Medium-High |
| 9 | Cloudflare moves Free-plan traffic first when a data center is busy | "We move Free customers first … then Pro, and then Business customers if needed"; triggered by CPU thresholds | https://blog.cloudflare.com/meet-traffic-manager/ | Engineering blog describing the mechanism (not marketing claims) | 2023-09-25 | global | Medium-High |
| 10 | Algerian mobile speed and latency (Ookla) | Mobile median, Sep 2026 rolling quarter: 77.67 Mbps down / 19.69 up / **23 ms** latency / 8 ms jitter (Sep 2025: 41.2 Mbps, 26 ms). Fixed: 93.55 / 32.17 / 7 ms | JSON embedded in https://www.speedtest.net/global-index/algeria (fetched with curl) | Field data, people who run speed tests | Sep 2026 | yes | Medium. Upward bias, and latency is to the nearest Ookla server, not Cloudflare |
| 11 | Typical mobile experience is much slower than Ookla's median | Opensignal download speed experience: Djezzy 17.6, Mobilis 15.9, Ooredoo 26.4 Mbps; time on network 96–97% | https://insights.opensignal.com/reports/2026/02/algeria/mobile-network-experience (via search excerpt; direct fetch returned 403) | Field data | Oct–Dec 2025 | yes | Medium (secondhand excerpt) |
| 12 | Waking an idle phone radio adds 50–100 ms to the first packet | 3GPP TR 36.912 analysis: idle→connected ≈ 50 ms target, 76–83 ms in the FDD/TDD analyses | https://itecspec.com/3gpp/36.912/s/16.2.1 | Standards analysis, not field data | Old (Rel-8/10) | global | Low-Medium |
| 13 | HTTP/3 is available on every plan | "HTTP/3 is available to all plans" | https://developers.cloudflare.com/speed/optimization/protocol/http3/ | Official docs | 2026 | global | High |
| 14 | 0-RTT is on every plan, off by default, GET only | All plans "Yes"; not on by default; POST not supported; replay risk; adds an `Early-Data: 1` header | https://developers.cloudflare.com/speed/optimization/protocol/0-rtt-connection-resumption/ | Official docs | 2026 | global | High |
| 15 | Early Hints is on every plan but helps little for cached HTML | Not sent "if the main response header is already available"; HTTP/2 and HTTP/3 only | https://developers.cloudflare.com/cache/advanced-configuration/early-hints/ | Official docs | 2026 | global | High |
| 16 | Speed Brain only prefetches, conservatively, and skips Worker routes | On by default for Free; `prefetch`, `eagerness: conservative`; "Routes that invoke a Worker are not prefetched"; no measured gains published | https://developers.cloudflare.com/speed/optimization/content/speed-brain/ | Official docs | 2026 | global | High |
| 17 | On Free, the only tiered-cache option is Smart Tiered Cache, with one upper tier per origin | Upper tier = closest to the origin; a lower-tier miss asks the upper tier | https://developers.cloudflare.com/cache/how-to/tiered-cache/ | Official docs | 2026 | global | High |
| 18 | Lighthouse mobile throttling | `mobileSlow4G`: rttMs 150, throughputKbps 1638.4, cpuSlowdownMultiplier 4 | `unpkg.com/@paulirish/trace_engine@0.0.68/models/trace/lantern/simulation/Constants.js` (used by Lighthouse 13.6.0) | Source code | 2026 | n/a | High |
| 19 | Lighthouse weights and scoring curves | Weights: TBT 30, LCP 25, CLS 25, FCP 10, SI 10. Mobile p10/median: FCP 1800/3000, LCP 2500/4000, SI 3387/5800, TBT 200/600, CLS 0.1/0.25. Scores above 0.9 get a +0.05×(p−0.9) boost, then are floored to two decimals; the category is rounded to two decimals | GitHub `GoogleChrome/lighthouse` main: `core/audits/metrics/*.js`, `core/config/default-config.js`, `shared/util.js`, `shared/statistics.js`, `core/scoring.js` | Source code | 2026 (v13.6.0) | n/a | High |
| 20 | Per-metric thresholds for a perfect score | Each metric scores 1.00 at: FCP ≤ 1067 ms, SI ≤ 1953 ms, LCP ≤ 1546 ms, TBT ≤ 65 ms, CLS ≤ 0.039 (0.99 at LCP 1792, TBT 92) | Reimplemented the formula in `lhscore.py` | Own calculation | 2026-11-04 | n/a | High |
| 21 | No nationwide shutdown during the 2026 bac exams, but "targeted" cuts were announced | Over 876k candidates from June 7, 2026; minister announced targeted cuts | https://www.tsa-algerie.com/bac-2026-lalgerie-met-fin-aux-coupures-generalisees-dinternet/, https://www.algerie360.com/bac-2026-saadaoui-annonce-des-coupures-dinternet-ciblees | News | Jun 2026 | yes | Medium |
| 22 | Since 2022, exam-day disruption has been content blocking, not full shutdown | Exams June 12–16, 2022; two windows on June 13 (08:30–11:00 and 14:30–17:00 local); evidence from Network Error Logging | https://blog.cloudflare.com/syria-sudan-algeria-exam-internet-shutdown/ | Field data (Radar) | 2022-06-14 (stale) | yes | Medium |
| 23 | Claim that Cloudflare address ranges were blocked in June 2025, forcing Marseille/Milan routing (+30–70 ms) | No primary source linked | https://algeriatech.news/?p=31046 | Low-reliability secondary | 2026-05-24 | yes | **Low: unverified** |
| 24 | International capacity: 5 submarine cables plus a terrestrial link through Tunisia | ALVAL/ORVAL design capacity 40 Tbps (in service since 2020); about 10.2 Tbps installed overall (figures disagree between sources) | https://capacitymedia.com/article/29ot42ikril15nn36mnch/news/algeria-goes-live-with-orval-subsea-cable; algeriatech.news (secondary) | News | 2020–2025 | yes | Low-Medium |
| 25 | Algerian network numbers | AS36947 = Algérie Télécom (fixed); **AS327712 = as-name "ATM" (Algérie Télécom Mobile, i.e. Mobilis)**; AS327931 = Optimum Telecom Algérie (Djezzy); AS33779 = Wataniya Telecom Algérie (Ooredoo) | RIPEstat `as-overview` and `whois` | Registry data | 2026-11-04 | yes | High (the Mobilis = ATM link is inferred from the as-name) |

### 3. Alternatives considered and rejected

- **Cloudflare Free plan for production.** Rejected. Measured: 13–40% of samples on Free-type address ranges took the 40–45 ms European path in October 2026, rising to as much as 63% in the evening (rows 6–7). That matches Cloudflare's stated "move Free first" policy (row 9). On a phone, every extra round trip costs about 25–30 ms more, and a first visit needs 4–6 round trips.
- **Serving HTML from a server or Worker in Europe** (dynamic page rendering in a Paris or Frankfurt region, or a database such as a single-primary D1/Postgres in the EU on the page-load path). Rejected for storefront pages. Each round trip to Europe from the Algerian probe is 44–52 ms (row 8) versus 12–16 ms to the local Cloudflare data center. One database call on the page-load path costs more than the whole in-country handshake.
- **Another CDN (CloudFront, Akamai, Fastly, Bunny) in front of or instead of Cloudflare.** Out of scope because the brief fixes Cloudflare. For the record, PeeringDB shows no public internet exchange or facility in Algeria, and my traceroutes show Cloudflare is reached on-net. I found **no** measured evidence that any other CDN has nodes in Algeria. The only claim of that kind comes from a low-reliability source.
- **Counting on Early Hints or Speed Brain as the main speed levers.** Rejected. Early Hints is skipped when the cached response is immediately available. Speed Brain is prefetch-only, conservative, and does not apply to Worker routes (rows 15–16). Our own Speculation Rules with prerender are the useful version.
- **Promising "0.4 s full load".** Rejected. See the budget below.

### 4. Latency budget for an Algerian mobile visitor

**Inputs:**
- Fixed-line round trip to the local Cloudflare data center: 10–16 ms (measured).
- Extra round-trip time on mobile: about +16 ms (Ookla mobile 23 ms vs fixed 7 ms). This is a proxy.
- Resulting mobile round trip R: about **30–40 ms local**, about **55–65 ms when routed to Europe**. Not measured directly: there are no Algerian mobile probes.
- Realistic bandwidth: 15–25 Mbps (Opensignal).
- Assumed page: HTML ≤ 14 KB compressed and already in the edge cache, critical CSS inline, LCP image ≤ 40–60 KB AVIF on the same origin.

| Step | Cold first visit, R=35 | Cold, R=60 (Europe) | Warm repeat / in-site |
|---|---|---|---|
| Waking an idle radio | 0–100 | 0–100 | 0–100 (0 if the user is browsing) |
| DNS (resolver hit or miss) | 35–80 | 60–110 | 0 (cached) |
| Handshake (QUIC 1 round trip; TCP+TLS 1.3 2 round trips) | 35–70 | 60–120 | 0 (connection reused or 0-RTT) |
| Request to first byte (edge hit, a few ms) | ~40 | ~65 | ~40 |
| **TTFB subtotal** | **~110–290** | **~185–395** | **~40–140** |
| Rest of the HTML (more than 14 KB costs one more round trip) | 0–35 | 0–60 | 0 |
| LCP image (round trip + transfer + slow start) | 50–90 | 75–140 | 0 (cached or prerendered) |
| Rendering on a mid-range Android (not measured: frontend teammate's area) | 50–150 | 50–150 | 30–100 |
| **LCP estimate** | **~210–560 (about 350 typical)** | **~310–745** | **~70–240; ~0–50 with prerender** |

These are calculated from measured inputs. They are not measured end to end.

**Conclusion:** 0.4 s is physically achievable as:
- TTFB at p75 on every visit type, provided the visitor is served in-country;
- LCP on repeat visits and in-site navigation;
- LCP for a first visit at around the median, only when the visitor is served in-country and the phone's radio is already awake.

### 5. Interface assumptions (for the other teammates to challenge)

- **Frontend:**
  - Critical HTML about 14 KB compressed or less.
  - CSS inlined.
  - **No third-party domains** on the critical path. Each one costs DNS plus a handshake, which is 3–4 simulated round trips of 150 ms in Lighthouse, or about 100 ms or more on Algerian mobile.
  - Arabic and Latin fonts self-hosted, subset and preloaded.
  - LCP image 60 KB or less.
  - Total Blocking Time ≤ 65 ms with a 4× CPU slowdown, which leaves almost no budget for hydration JavaScript.
  - Rough budget at Lighthouse's 1.6 Mbps: about 150 KB of total bytes before LCP. This is my calculation, not a measurement.
- **Backend / rendering:**
  - Storefront HTML is the same for every user and cacheable at the edge, using "cache everything" and purge on publish.
  - Anything personal (cart, user state) loads after LCP.
  - If storefront pages are produced by a Worker (Rust/WASM or JS), its output must be cached. Otherwise Speed Brain skips those routes and every miss pays Worker plus data-fetch time.
  - Whether the Worker is written in Rust has negligible effect on network latency. CPU time per request matters only on a cache miss.
- **Data:** the database location only matters for order submission and admin. An Algerian visitor's order POST to a database in Europe adds about 50–120 ms, which is acceptable.
- **Security:**
  - Do not use bot or challenge pages on the storefront.
  - Load the Turnstile script (challenges.cloudflare.com, a third-party domain) only when the order form is opened.
  - WAF rules on the order endpoint and the admin.
  - 0-RTT is safe only because orders are POSTs, which 0-RTT does not cover.
- **Plan and budget:** this assumes the client pays for Pro or Business. If the decision is Free, treat 40–60 ms evening round trips as the planning case.

### 6. Risks and open questions (where evidence is thin)

1. **No mobile measurements.** Every Algerian network measurement comes from **one** fixed-line Algérie Télécom probe in the east (RIPE probe 1001421). All 39 other Algerian probes are abandoned or written off, the last ones in June 2024. No Globalping probe exists in Algeria; the nearest are in Tunis, Rabat and Fes. Whether Mobilis (AS327712), Djezzy (AS327931) and Ooredoo (AS33779) reach the in-country Cloudflare data centers is **unknown**. **Action:** before deciding, run a spike: a Worker on a zone on the intended plan that returns `request.cf.colo` and timing data, opened from real SIM cards on all three operators, at midday and at 22:00. Track ongoing results with Cloudflare Web Analytics RUM.
2. **Pro vs Business is unverified.** The plan of the two "free-like" sites I measured is unknown, and I have no measurements for Pro or Business sites.
3. **Single-data-center outages.** Annaba is in "major_outage" today. When it went out in Sep–Oct, the probe's median round trip to 1.1.1.1 rose from about 8 ms to 13–17 ms: still in-country, but higher.
4. **Exam season (June).** No nationwide shutdown in 2025 or 2026, but "targeted" cuts were announced. The claim that Cloudflare ranges were blocked in 2025 is unverified. Plan for degraded traffic and orders during the exam days, and do not schedule launches or campaigns then.
5. **Low cache hit rate for a small store.** The Algerian data centers may evict rarely-requested pages. A miss then goes to an upper tier that is probably in Europe. I have not measured this.
6. **Data I could not get.** Cloudflare Radar pages for Algeria returned 403 to my scripts, and the Radar API needs a token, so Algeria's HTTP/3 share, mobile share and IPv6 share are **missing**. CrUX country-level data (country_dz) needs BigQuery. Opensignal returned 403, so I used search excerpts. The Ookla figures are tester medians and are biased upward.
7. **The radio wake-up cost** comes from 3GPP analysis, not Algerian field data.
8. **Lighthouse modelling of HTTP/3.** I believe Lighthouse's simulator models connections as TCP, so HTTP/3, 0-RTT and Early Hints probably will not raise the lab score. I did not verify this in the source.
9. **Spike not run.** A temporary Wrangler preview account exists on this machine. I did not use it, because I have no Algerian vantage point to measure from and the account was not created for me.

Raw data and scripts are in `/tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/`: `r_idserver.json`, `parse_id.py`, `pingsum.py`, `trsum.py`, `bimodal.py`, `hour.py`, `anch_*.json`, `ookla.html`, `cfcomp.json`, `lhscore.py`.