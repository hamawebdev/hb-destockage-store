# Backend, Data and Rust: findings (BACKEND/DATA/RUST teammate)

Research date: 2026-11-04. I deployed a throwaway spike to a temporary Cloudflare preview account using `wrangler deploy --temporary`. It was never claimed and expires on its own. I measured it from a real Algerian connection: this machine is on **AS327931 Optimum Telecom Algérie (Djezzy)**, and `cdn-cgi/trace` reports `loc=DZ`. The access type (4G or fixed) is unknown. Raw data and code are in `/tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/meas/`, `/tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/spike-ts/src/index.ts` and `/tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/spike-rs/src/lib.rs`.

## 1. Position

- **Runtime: TypeScript on Cloudflare Workers, not Rust.** For this workload Rust measurably costs more and gains nothing I could measure:
  - The bundle was 127.6 KiB gzip against 2.6 KiB.
  - Wrangler reported startup of 4 ms against 1 ms.
  - The time spent waiting on D1 inside the Worker was the same (p50 28 ms against 26 ms).
  - The time from sending the request to the first byte (client side, "request to first byte" below) differed by less than the network noise.

  The store's work is waiting on I/O, not computing. I found no published, method-documented benchmark showing Rust beats JavaScript on Workers.
- **The storefront HTML should never touch the database while a visitor waits.** Serve pages either as prebuilt static assets or from the new **Workers Cache**. Workers Cache runs in front of the Worker, is tiered, collapses identical requests, honours `Cache-Control` including `stale-while-revalidate`, and can be purged by tag from code with `ctx.cache.purge({tags})`.
  - Measured from Djezzy, the request-to-first-byte time was the same for a cache hit (p50 126 ms) and a plain Worker (127 ms).
  - A page rendered from D1 was about 40 ms slower (p50 169 ms).
- **Data: one D1 database with location hint `weur`.** In my spike the primary landed in Paris (`served_by_colo: CDG`). One database holds the catalog, orders, customers and content.
  - 3,000 products took 2.16 MB, against a 10 GB limit.
  - Hundreds of orders a day fit easily inside the Workers Paid plan's included 50M rows written and 25B rows read per month.
  - Plan on Workers Paid at $5/month. The free plan's 10 ms CPU limit and daily caps are too tight.
- **No KV, Hyperdrive or Turso for core data.** KV is eventually consistent ("up to 60 seconds or more"), which is wrong for stock and price. The others add an extra network hop and their own vendor, with no Algeria-relevant gain.
- **Order write path:**
  1. Validate the order with Valibot.
  2. Check the anti-spam token and rate limit (security teammate's area).
  3. Write the order to D1 synchronously, with a unique idempotency key and `ON CONFLICT DO NOTHING`. This measured 21–39 ms p50 from Marseille (MRS) to Paris.
  4. Return the confirmation to the customer.
  5. Push a message to Cloudflare Queues for side effects: the Telegram bot alert, and email through Cloudflare Email Service (public beta). Queues gives retries and a dead-letter queue.

  The order is durable once step 3 succeeds. The queue only handles notifications.
- **Router:** use Hono (8.0 KB gzip) for the admin and API side, which needs middleware. Keep the storefront fetch path minimal.
- **ORM and validation:** use Drizzle (+18 KB gzip on top of Hono) or raw prepared statements. Use Valibot (+1.4 KB) rather than Zod 4 classic (+92 KB).
- **Possible legal blocker: customer data stored in the EU.** D1 offers no Africa location (`afr` is unsupported). Law 18-07, as amended by Law 25-11, requires prior authorisation from the ANPDP (Algeria's data protection authority) for transfers abroad. The legal/admin teammate must clear this before the build. Details in section 5.

## 2. Evidence table

M = my own measurement. The commands are in the scratchpad: `curl -4 -s -o /dev/null -w "%{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer}"` with fresh connections, run 10–20 times per endpoint. In-Worker timings use `performance.now()` around awaited I/O, which does advance across I/O in Workers. The Worker runs a D1 query n times and reports the samples.

| # | Claim | Evidence (numbers) | Source URL / measurement | Source type | Date | Algeria-specific? | Confidence |
|---|---|---|---|---|---|---|---|
| 1 | The Worker size limit is 64 MiB uncompressed on both plans, with no compressed limit. The old 3 MB / 10 MB figures are out of date. | "There is no compressed size limit." Startup must finish within 1 s. Memory is 128 MB per isolate. CPU is 10 ms on Free and up to 5 min on Paid. | https://developers.cloudflare.com/workers/platform/limits/ | Official docs (hard limits) | fetched 2026-11-04 | global | High |
| 2 | Algerian Djezzy traffic to Workers runs mostly in Marseille, not Algiers | workers.dev: 78 of 80 requests `cf-ray …-MRS`, 2 of 80 `ORN` (Oran). `www.cloudflare.com` → BCN. `1.1.1.1` → ALG. | M: `curl -s https://<host>/cdn-cgi/trace`, cf-ray headers | Measurement | 2026-11-04 | **yes** (one ISP, one vantage) | Medium |
| 3 | Network round trip from Djezzy to the Workers edge | ICMP to the workers.dev IPv4 address: min 32.7, avg 40.7, max 50.5 ms. To 1.1.1.1 (ALG): min 27.7, avg 39.8 ms. | M: `ping -c 15` | Measurement | 2026-11-04 | **yes** | Medium |
| 4 | Cold-connection phases vary a lot on the same line | Session A (15 runs): DNS p50 67–78, TCP 66–77, **TLS p50 ~360 ms** (min 138), first-byte total p50 643–707 ms (min 391). Session B, ~30 min later: TLS p50 118 ms (Google 103, 1.1.1.1 83). | M: `meas/client4_*.txt`, `meas/tls_interleaved.txt` | Measurement | 2026-11-04 | **yes** | Medium (n is small, one ISP) |
| 5 | A Workers Cache hit is no faster than a plain Worker; a D1-backed render adds about 40 ms | Request to first byte p50: cache HIT 126 (min 88), plain Worker 127 (min 96), D1 render 169 (min 128). Session B cache HIT: 129 (min 102). | M: `/cached`, `/plain`, `/render` endpoints | Measurement | 2026-11-04 | **yes** | Medium |
| 6 | D1 latency from a Marseille Worker to a WEUR primary (Paris) | Point read: p50 22–28 ms (min 18). SQL engine time 0.23 ms. 24-row list: p50 11–30 ms. INSERT: p50 21–39 ms (max 102). | M: `meas/inworker.txt`, `meta.served_by_colo=CDG` | Measurement | 2026-11-04 | **yes** (Worker colo chosen for an Algerian client) | Medium |
| 7 | A Durable Object (SQLite, weur) is no faster than D1 and is slow on first contact | RPC p50 11–28 ms; first call 225–372 ms | M: `/do` | Measurement | 2026-11-04 | yes | Medium |
| 8 | A hot KV read is fast, but KV is eventually consistent | Hot `get` p50 4–7 ms, first 36 ms. Docs: changes "may take up to 60 seconds or more" to reach other locations. | M: `/kv`; https://developers.cloudflare.com/kv/concepts/how-kv-works/ | Measurement + docs | 2026-04-21 docs | yes / global | High |
| 9 | Rust (workers-rs) bundle and startup cost | Rust: 312.46 KiB / **127.58 KiB gzip**, startup **4 ms**. Same-scope TS: 7.35 KiB / 2.59 KiB gzip, startup 1 ms. Rust release build took 7 min 17 s. | M: `worker-build 0.8.7 --release`, wrangler deploy output | Measurement | 2026-11-04 | global | High |
| 10 | Rust gives no measurable latency gain for this workload | Interleaved, 20 runs each. Request-to-first-byte min: TS plain 129 / RS 114, TS render 152 / RS 120. p50s swamped by noise (TS 269/370, RS 163/208, max up to 4.8 s). In-Worker D1 p50: TS 26, RS 28 ms. | M: `meas/ts_vs_rs.txt` | Measurement | 2026-11-04 | yes | Low–Medium (network noise is larger than any runtime difference) |
| 11 | No current, rigorous Rust-vs-JS benchmark on Workers exists | Only data found is an old test: JS 84 ms against Rust/WASM 127–540 ms, since invalidated by runtime changes | https://github.com/samuelcolvin/cloudflare-worker-speed-test | Benchmark | ~2020, **stale** | global | Low |
| 12 | The main Workers CPU performance gaps were platform issues, now fixed | Up to 3.5× slower than Node at first. After fixes: "on par… except Next.js". GC tuning gave about 25%. | https://blog.cloudflare.com/unpacking-cloudflare-workers-cpu-performance-benchmarks/ | Vendor benchmark write-up with methodology | 2025-10-14 | global | Medium |
| 13 | workers-rs is actively maintained | 12 releases from v0.7.1 (2025-12-01) to v0.8.7 (2026-09-25). 3.8k stars, 204 open issues. Queues still behind a "beta" feature flag. | GitHub API `/repos/cloudflare/workers-rs/releases`; README | Repository data | 2026-11-04 | n/a | High |
| 14 | D1 location hints and residency options | Hints: wnam/enam/weur/eeur/apac/oc. **afr and me are not supported.** Jurisdictions: eu/fedramp/us. | https://developers.cloudflare.com/d1/configuration/data-location/ | Docs | fetched 2026-11-04 | global | High |
| 15 | D1 read replication: replicas in ENAM/WNAM/WEUR/EEUR/APAC/OC only, at no extra cost; Sessions API with bookmarks | No Africa replica, so no latency gain for Algeria with a WEUR primary. Public beta since 2025-04-10. | https://developers.cloudflare.com/d1/best-practices/read-replication/ (updated 2026-08-10) | Docs | 2026 | global | High |
| 16 | Each D1 database is single-threaded | About 1,000 queries per second at 1 ms per query. 10 GB max. `batch()` counts as one query. | https://developers.cloudflare.com/d1/platform/limits/ | Docs | 2026 | global | High |
| 17 | D1 cost for this store is effectively $0 beyond the plan | Paid plan includes 25B rows read and 50M rows written per month, then $0.001 per million reads and $1 per million writes. No egress charges. | https://developers.cloudflare.com/d1/platform/pricing/ | Docs | 2026 | global | High |
| 18 | Workers Cache: tiered by default, collapses identical requests, purge by tag or path prefix from code, no separate price | Cache hits are billed as requests ($0.30 per million after 10M) with no CPU charge. Enabling it makes otherwise-free static asset requests billable. | https://developers.cloudflare.com/workers/cache/ and https://developers.cloudflare.com/workers/cache/purge/ | Docs | 2026-10-30 | global | High (feature exists); Medium (newness) |
| 19 | The Cache API does nothing on workers.dev | Every `/cacheapi` first match was a miss; documented behaviour | M + Cache API docs | Measurement + docs | 2026-11-04 | n/a | High |
| 20 | Server-side bundle sizes (esbuild, minified, gzip -9) | Plain fetch handler 0.2 KB, itty-router 1.1 KB, Hono 8.0 KB, Hono+Drizzle 26.5 KB, Hono+Kysely 38.2 KB, Hono+Valibot 9.5 KB, Hono+Zod 4 (classic) 100.4 KB | M: `esbuild --bundle --minify --format=esm` (hono 4.13.16, drizzle 0.45.4, kysely 0.29.8, zod 4.6.7, valibot 1.5.0) | Measurement | 2026-11-04 | global | High |
| 21 | Queues limits and pricing are ample | 1M operations per month included (about 3 per message), 128 KB per message, 100 retries, DLQ, 5,000 messages per second | https://developers.cloudflare.com/queues/platform/limits/ and https://developers.cloudflare.com/queues/platform/pricing/ | Docs | 2026-10-30 | global | High |
| 22 | Email from Workers is available but in beta | Email Service public beta since 2026-04-16, `env.EMAIL.send()` | https://developers.cloudflare.com/changelog/product/email-service/ | Docs / changelog | 2026 | global | Medium |
| 23 | Hyperdrive + Postgres latency | Only a single-region measurement exists: about 27–40 ms per transaction, us-east-1. No 2025–26 EU or Africa data. | https://www.lirbank.com/liberate-yourself-from-infrastructure-over-planning (via search) | Independent benchmark | older | global | Low |
| 24 | Law 18-07 (as amended by Law 25-11 of 2025-07-24): transfers abroad need prior ANPDP authorisation; penalties up to 5 years and 500,000 DZD | — | https://www.gide.com/en/news-insights/protection-of-personal-data-focus-on-algerian-regulations/ | Law-firm analysis | 2025–26 | **yes** | Medium (not legal advice) |

## 3. Alternatives considered and rejected

- **Rust (workers-rs) for the whole server:**
  - It is 49 times larger gzipped (127.6 KiB against 2.6 KiB) and takes 4 ms to start against 1 ms (rows 9–10).
  - It made no measurable difference to D1 wait time.
  - It adds a JS↔WASM boundary on every binding call.
  - A release build took 7 minutes, against seconds for TypeScript.
  - Queues support is still flagged beta.

  The workload is I/O-bound: SQL took 0.23 ms out of a 22 ms round trip. **Where Rust could help:** a CPU-heavy, isolated task such as image transforms or heavy cryptography. None is in scope, and Cloudflare Images covers image work. I did not measure CPU time per request: `performance.now()` is frozen during CPU work in Workers, and the temporary account gave me no analytics. That gap remains open.
- **Rust for selected hot paths only (WASM module called from TS):** rejected for the same reason. There is no CPU-bound hot path, and each call adds boundary overhead.
- **Durable Objects SQLite as the primary store:** no faster than D1 (row 7), a 225–372 ms first call, and you have to shard and route by hand. DO stays an option for future needs such as per-phone order rate counters, but the rate-limit binding probably covers that.
- **KV as the catalog store:** reads are fast (4–7 ms hot), but eventual consistency of up to 60 s or more risks showing a stale price or stock level. Workers Cache with tag purge gives the same zero-database page views with an explicit purge.
- **Hyperdrive + Neon/Supabase Postgres:** adds a Worker→pool→database hop to a non-Cloudflare region, plus a second vendor. Evidence is thin and not from Africa (row 23). Reconsider it only if the legal review forces an Algeria-hosted database.
- **Turso / libSQL:** an external hop, and embedded replicas need a filesystem, which Workers lack. I did not measure it, so this is an inference.
- **Rendering pages from D1 on each request:** about +40 ms request-to-first-byte at p50 (row 5), and more when a page runs several queries one after another. Smart Placement does not help: it moves the Worker toward Paris, which adds the Algeria→Paris network leg.
- **Zod 4 classic:** 92 KB gzip more than Valibot. Zod Mini may close the gap but I did not measure it.
- **Kysely:** about 12 KB gzip more than Drizzle and no migration tooling on D1. Drizzle provides schema, migrations and D1 support.
- **itty-router for everything:** the smallest option (1.1 KB), but the admin side needs security headers, CSRF, JWT/session and validator middleware, which Hono includes. 7 KB of server code made no measurable difference to startup (1 ms).

## 4. Interface assumptions (for other teammates to challenge)

1. **Frontend:** the storefront is either prebuilt static HTML/assets, or Worker-rendered HTML that is cacheable (`public, s-maxage, stale-while-revalidate`, `Cache-Tag: product-<id>,cat-<id>,home`). Nothing that varies per visitor goes in the HTML: no cookies and no `Set-Cookie`, because `Set-Cookie` bypasses the cache. The cart can live in client storage until checkout. Language goes in the URL path (`/fr/…`, `/ar/…`), not in `Vary: Accept-Language`, so each language and direction is its own cached entry.
2. **Frontend/network:** the 0.4 s target is mostly a network problem, not a backend one.
   - On this line, a cold connection cost DNS 67–78 + TCP 66–77 + TLS 118–360 + request-to-first-byte about 126 ms (p50s from rows 4–5). That puts the first byte of a cached page at roughly 380–700 ms before any rendering.
   - A sub-0.4 s full load looks reachable only on a reused connection, a repeat visit, or a prefetched or prerendered navigation.
   - The network teammate should check whether a custom domain on a paid zone gets served from ALG/ORN rather than MRS, and test HTTP/3. My curl had no HTTP/3 support.
3. **Security/anti-spam:** the order endpoint receives a token from the spam-protection layer (e.g. Turnstile, decided by the security teammate) and uses the Workers rate-limit binding, keyed on phone number plus IP prefix. Turnstile, the rate limit and validation all run before the D1 write.
4. **Admin:** the admin is a separate entry point or route under `/admin`, never cached (`private, no-store`). It sits behind Cloudflare Access or strong authentication. Every product, content or price save calls `ctx.cache.purge({tags})` from the same entry point that served the cached pages, because purges only apply to the entry point that calls them (Workers Cache docs).
5. **Legal:** whether the D1 primary in Paris is acceptable under Laws 18-07 and 25-11 is for legal to decide. My design assumes it is, or that ANPDP authorisation is obtained.

## 5. Risks and open questions

- **Data residency could block the design.** Cloudflare cannot store D1, DO or KV data in Algeria (row 14). If legal requires order PII to stay in Algeria:
  - Keep the catalog on Cloudflare.
  - Write orders to an Algeria-hosted Postgres or API through Hyperdrive or Cloudflare Tunnel.
  - Only the order-submit request would pay that latency. I did not measure it.
  - A middle option is data minimisation, for example short retention for phone numbers. Legal must judge it.
- **Workers Cache is new** (docs dated 2026-10-30). I found no production case studies. Purge propagation time is not documented with numbers. If it misbehaves, fall back to static assets plus Cache Rules or the Cache API on a custom domain. Note that enabling Workers Cache makes static asset requests billable; the cost is negligible at this scale.
- **Edge location for Algerian users:** my data covers one ISP (Djezzy), served from MRS, with occasional ORN. Mobilis, Ooredoo and Algérie Télécom are untested. I did not test whether a custom domain on a Pro or Business plan is served in-country.
- **Network variance is large:** TLS p50 swung between about 360 and 118 ms within 30 minutes, and some requests took over 3–5 s. Field data (CrUX/RUM) must confirm any p75 claim. My numbers are lab samples, n=10–20.
- **Bot challenge seen:** after about 300 scripted requests, Cloudflare started returning `cf-mitigated: challenge` (403) to my curl client from this Algerian IP. One observation and a bot-like pattern, but the security teammate should check false positives for Algerian mobile carrier-grade NAT, where many users share an IP, before turning on aggressive bot rules for real shoppers.
- **Not measured, evidence thin:**
  - Static-asset request-to-first-byte versus a Workers Cache hit (the challenge stopped my runs).
  - Real CPU time per request for TS against Rust.
  - D1 read-replica behaviour (not enabled on the temporary account).
  - Cold start of D1 after long idle.
  - Workers Cache tag-purge latency.
  - Hyperdrive or Turso from Marseille.
- **D1 is single-threaded** at about 1,000 queries per second per database. That is fine for hundreds of orders a day, but admin bulk imports should use `batch()` and off-peak cron jobs.
- **Long-term maintenance:**
  - TypeScript, Hono, Drizzle and Valibot are mainstream, with active repos (Hono: 32.8k stars, pushed 2026-11-04).
  - Wrangler's `compatibility_date` needs periodic bumps.
  - D1 schema changes go through Drizzle or Wrangler migrations.
  - workers-rs ships often (12 releases in 10 months), but it is pre-1.0 with breaking minor versions. Another maintenance argument against Rust.
- **Spike cleanup:** the temporary preview account ("Thankful Servant") was never claimed. Per the claim-deployments docs, it can only be claimed within 60 minutes. Nothing was written to `/mnt/data/ecom website`.