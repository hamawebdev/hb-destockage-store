## Cross-examination: admin, anti-fraud and security vs data layer vs storefront performance

I checked these claims on 2026-11-04 from the Djezzy line in Biskra (load average 0.66, no Lighthouse runs). Raw outputs are in `/tmp/claude-1000/-mnt-data-ecom-website/7c4de3cb-26c7-4c11-ad65-446883326dd9/scratchpad/xexam/`.

### 1. Disputes

**D1. Does Turnstile break the byte budget or the Lighthouse 100?** (admin_security vs frontend)
- **Claim:**
  - Admin_security says eager Turnstile adds about 250 KB and lowered the score in all 5 paired runs (base median 99, eager median 76).
  - Frontend says Turnstile must load on interaction.
- **Challenge:** the "lowered in every run" result rests on a contended baseline. I re-read `adminsec/lh2_*.json`:
  - Base runs scored 100/99/99/**88/74**, with TBT 0–1510 ms and benchmarkIndex 281–2071.
  - Eager runs scored 99/76/87/75/67, and LCP did not change (678–1120 ms).
  - So the score drop is mostly host contention. The real Turnstile cost on TBT is unmeasured.
  - The bytes hold up. In eager_1 the transfers were api.js 28,323 B, a challenge iframe document of 214,706 B and a 267 B redirect, about 243 KB in total.
- **New measurement:**
  - Command: `curl -4 -sL -H 'Accept-Encoding: br' -w … https://challenges.cloudflare.com/turnstile/v0/api.js` ×6.
  - Results: 28,091 B; total time 0.33–0.86 s (cold DNS 62–97 ms, TLS done at 183–490 ms).
  - Turnstile is served from **colo BCN** (`/cdn-cgi/trace` gives `colo=BCN`), so it is a separate third-party origin.
- **Resolution:**
  - Eager Turnstile breaks the budget's "0 third-party origins before LCP" rule. On bytes alone it is about 5–10× the measured page weight (20–43 KB). Ban it.
  - Lazy loading on interaction adds 0 bytes while Lighthouse runs, because Lighthouse never interacts with the page.
  - What stays unknown is its effect on field INP: a 215 KB iframe document loads on the first focus.
- **Confidence:** high on bytes; low on the eager score figures; insufficient on INP.

**D2. Payload rejection rationale** (admin_security)
- **Verification with the GitHub API:**
  - #15070 (D1 DELETE silently does nothing): **open**. Last comment is "Any update?" on 2026-06-23.
  - #18274 (PBKDF2): closed 2026-10-29 17:46. The maintainer wrote "The fix is not in a release yet". The newest releases (v3.92.1 on 10-27, v4.0.0-beta.6 on 10-29 15:45) predate the fix. **Confirmed.**
  - #15012 (TTFB of 2–6 s): **closed 2025-12-24**. Its root cause was where the D1 database was placed, not Payload. **Drop it as a rejection reason.**
  - "Needs paid plan (3 MB bundle)" is **stale**. The Workers limits page now says "64 MiB… There is no compressed size limit." The backend report has this right. Payload still needs the Paid plan, but because of CPU time, not bundle size.
- **Resolution:** the rejection stands on the open DELETE bug, the unreleased auth fix, and the OpenNext/Next.js GC overhead (frontend row 20). The COD confirmation workflow is custom work in every option anyway.
- **Confidence:** high.

**D3. How storefront pages get refreshed: static assets vs Workers Cache** (frontend vs backend)
- **The two positions:**
  - Frontend: product pages are static assets, and an admin publish triggers a rebuild.
  - Backend: Worker-rendered pages plus Workers Cache with `ctx.cache.purge({tags})`.
- **Verified on the Workers Cache docs:** "When caching is enabled, every request to your Worker is charged… including… static asset requests." Static assets are otherwise "free and unlimited".
- **Speed is a tie on current data:**
  - Static spike from Djezzy: server response 118–154 ms.
  - Workers Cache hit: request-to-first-byte p50 126 ms.
  - Nobody measured both on the same run.
- **Resolution:**
  - There is no performance reason to pick either. Choose on operations.
  - Static assets need a build pipeline triggered by the admin (CI). Every price or stock edit then waits for a build and deploy; that duration was not measured.
  - Workers Cache gives purges within seconds, but it is new (docs dated 2026-10-30) and makes every request billable.
  - **Recommendation:** use static assets for product and content pages. Always re-validate price and stock server-side from D1 when an order is POSTed. Workers Cache is the fallback if build-on-publish turns out too slow.
- **Confidence:** medium.

**D4. Where the data sits vs the users** (backend vs everyone)
- **The facts:**
  - D1 accepts only the hints wnam, enam, weur, eeur, apac and oc; there is no `afr` (backend row 14, admin row 11).
  - Djezzy reaches Workers mostly through MRS.
  - D1 reads cost 22–28 ms p50 and writes 21–39 ms p50.
- **Resolution:** this does not conflict with the storefront, because D1 is only on the order POST and admin paths, never on the LCP path. Nobody claims the data is near users. **Agreed; no dispute.**

**D5. Rate limiting under CGNAT** (admin_security vs backend)
- **The two positions:**
  - Admin: rate-limit on phone combined with IP, never on IP alone.
  - Backend: key on phone plus IP prefix.
- **Challenge:**
  - The rate-limit binding is "approximate and counted per location".
  - Djezzy traffic was split between MRS (78/80) and ORN (2/80), so counters will split too. The impact is small.
  - More important: the backend teammate was served `cf-mitigated: challenge` (403) from this Algerian IP after about 300 scripted requests. A managed challenge on `/api/order` would make a plain form POST fail silently for real shoppers behind a shared IP.
- **Resolution:**
  - Keep Bot Fight Mode off. The docs say it "cannot be bypassed" by WAF rules.
  - Do not put managed challenges on the order path.
  - Use the WAF IP rule only as a coarse flood guard with a high threshold.
- **Confidence:** medium. The challenge was seen once, from a scripted client.

**D6. Rust anywhere in this seam** (all three teammates)
- **Evidence:**
  - Rust bundle 127.6 KiB gzip vs 2.6 KiB for the same TypeScript Worker.
  - Startup 4 ms vs 1 ms.
  - The time the Worker waits on D1 is the same: p50 26 ms (TS) vs 28 ms (Rust).
  - Admin and anti-fraud work (validation, dedup, comparing values to a regex) is I/O-bound.
  - Rust does not get around the WebCrypto PBKDF2 limit of 100k iterations unless it hashes inside WASM, and Cloudflare Access makes stored admin passwords unnecessary anyway.
- **Resolution:** the hypothesis is rejected for this seam. CPU time per request was not measured, but no CPU-bound path exists here.
- **Confidence:** medium-high.

### 2. Verified claims that survived

- **Turnstile api.js:** 28,034 B with brotli. The 302 redirect has `cache-control: max-age=300`. Re-measured.
- **Payload issues:** #15070 is open; the #18274 fix is unreleased (GitHub API).
- **Workers size limit:** 64 MiB uncompressed, no compressed limit (limits docs).
- **Static assets free vs Workers Cache billable:** both quoted from the docs.
- **DZ mobile number pattern:** libphonenumber master gives `5(?:4[0-29]|6[0-4])\d{6}|(?:55|6\d|7[7-9])\d{7}` with 9 digits nationally. This matches admin row 15, and a naive `^0[567]\d{8}$` is indeed too loose.
- **Lazy Turnstile adds 0 bytes at load:** the lazy runs have 0 B from challenges.cloudflare.com.

### 3. Claims to drop or downgrade

- **Drop:**
  - "Payload needs paid plan (3 MB bundle)": stale.
  - Payload #15012 as a rejection reason: closed, and the cause was D1 placement.
  - Admin_security §1, the Art. 8 / hosting discussion: out of scope per the brief.
- **Downgrade:**
  - "Eager Turnstile lowered the score in all 5 runs, median 76": the paired baseline itself ranged 74–100. Keep the bytes and drop the score delta.
  - Admin rows 33 (WhatsApp pricing), 35 (COD refusal rate 8–40%) and 36 (blacklists) are vendor or secondary sources and Low confidence. They are not inputs to the stack decision.
  - Access MFA on the free tier: unconfirmed in docs (admin row 25). Verify in the dashboard before relying on it.
- **Note:** admin_security ran Lighthouse 12.6.1 and frontend ran 13.6.0, so their scores are not comparable.

### 4. Joint recommendation for this seam

1. **Storefront:**
   - Static HTML, 0 KB JS before LCP, no third-party origin before LCP.
   - Order form is a plain POST that works without JS.
   - Turnstile in invisible mode, injected on the form's first `focusin` or `pointerdown`.
   - The server fails open: if the token is missing or invalid, the order is flagged for review, not rejected, because a cold fetch can take 0.33–0.86 s plus the 215 KB iframe on a slow link.
   - Security headers with a hash-based CSP (about 650 B).
2. **Anti-fraud, in order:**
   - honeypot plus minimum fill time;
   - libphonenumber-exact phone validation;
   - D1 unique key on phone + product + time window;
   - Workers rate-limit binding keyed on phone (plus IP as a secondary key);
   - one coarse WAF rule;
   - the human confirmation call.
   
   Bot Fight Mode stays off and there are no managed challenges on `/api/order`. SMS OTP is used only for flagged orders.
3. **Admin:**
   - A custom, server-rendered TS/Hono Worker on `admin.` behind Cloudflare Access, with Drizzle and Valibot over one D1 database (weur).
   - Ships zero code to the storefront.
   - Responses are `private, no-store`.
   - Append-only audit log table; daily D1 export to R2 (Time Travel keeps only 30 days).
   - Workers Paid plan at $5/month.
   - It runs reliably on Workers: 30 s CPU limit, D1 single-threaded at about 1,000 queries/s, which is far beyond admin load. Use `batch()` for imports.
   - **Maintenance cost:** the team owns CRUD, role-based access (RBAC), the audit log, the publish→build pipeline and compatibility_date bumps.
   - No evidence quantifies this in hours; it is a judgement call. Payload would not remove the COD workflow work, and it adds unreleased and open bugs today.
   - Revisit Payload once #15070 closes and a release ships the PBKDF2 option.
4. **Publish path:**
   - An admin save writes to D1, then triggers a storefront rebuild and deploy.
   - Order POSTs re-check price and stock against D1.
   - Workers Cache with tag purge is the fallback.
5. **Rust:** none in this seam.
6. **Law 18-07 (briefly):** D1 in the EU makes every stored order a transfer abroad (primary-text Arts. 44–45; Law 25-11 adds an automated log of operations). The audit log above serves that requirement. Counsel must confirm the derogation or authorisation before launch.

### 5. Unknowns only a production pilot in Algeria can answer

- Turnstile's solve rate, false positives, time-to-token and INP impact on Djezzy, Mobilis, Ooredoo and Algérie Télécom phones, plus its accessibility under WCAG 2.2 AA.
- How often Cloudflare's own bot systems challenge real Algerian CGNAT users on the order POST.
- The real fake-order and refusal rate, and which layer actually catches them. No credible Algerian data exists.
- Publish-to-live latency for build-on-publish vs Workers Cache purge, and whether operators accept it.
- How Algerian mobile carriers are routed to Cloudflare edge locations (MRS/BCN/ORN/ALG) on a custom domain.
- Whether order-POST latency to the Paris D1 database matters for conversion.
- Real admin maintenance hours per month.