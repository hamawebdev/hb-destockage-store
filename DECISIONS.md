# Decisions — deviations from STACK-REPORT.md

[STACK-REPORT.md](STACK-REPORT.md) is the spec. Any change that departs from it needs an entry here
**in the same commit as the change**, with its evidence: a measurement (path under `artifacts/`) or a
cited source (link, or the client instruction with its date). A change that deviates without an
entry is a review finding (Important).

Rules:
- **Append-only.** Anyone may add an entry through their own commit; the pre-commit hook accepts a
  `DECISIONS.md` change from any teammate only if it adds lines at the end and removes none.
  To revise a decision, append a new entry that supersedes the old one (`Supersedes: D-NNN`).
- Numbering: next free `D-NNN`. If two branches pick the same number, the second to merge renumbers
  its entry before merging.
- Format:

```
## D-NNN — <short title>
- Date: YYYY-MM-DD · Author: <teammate> · Task: <ID>
- Report says: <section and what it says>
- We do instead: <what>
- Why: <reason>
- Evidence: <artifact path or cited source>
- Status: active | superseded by D-NNN
```

---

## D-001 — Courier (58-wilaya) codes move to the future courier integration
- Date: 2026-11-04 · Author: tooling (for lead) · Task: TOOL-1
- Report says: §6 / data plan — store both wilaya codes (69-wilaya administrative code and the
  58-wilaya courier code) with the geo dataset and order-form data.
- We do instead: the order form, geo dataset and seed carry only the 69 wilayas / 1,541 communes.
  The 58-wilaya courier code is deferred to the courier integration; the column
  `wilayas.courier_code` stays in the schema, **nullable**, filled by that integration.
- Why: the client wants the courier mapping owned by the courier integration, not hand-maintained
  in the storefront data.
- Evidence: client instruction, 2026-11-04 (relayed by the lead; team/BRIEF.md §2, §4 DB-1).
- Status: active

## D-002 — Fee quote endpoint `POST /api/quote` reads D1 outside the order POST
- Date: 2026-11-04 · Author: tooling (for lead) · Task: TOOL-1
- Report says: §2 "Data" — D1 is never read while a visitor waits for a page: only on the order
  POST and in the admin.
- We do instead: the order form calls `POST /api/quote` `{items, wilaya, commune}` →
  `{subtotalDzd, feeDzd, totalDzd, available, feeSource}`. The Worker answers through the
  `FeeProvider` interface (`packages/shared/src/fees.ts`); today's provider reads the admin-set fee
  per wilaya (`delivery_fees`) from D1.
- Why: client requirement that the fee source be swappable for a courier API without changing the
  storefront or the order flow. The quote runs after the visitor picks a wilaya, not on page load:
  0 bytes and 0 requests before LCP, so page budgets are unaffected. `/api/order` still recomputes
  every amount server-side.
- Evidence: client requirement, 2026-11-04 (team/BRIEF.md §2 "Fees are swappable"). Quote latency
  to be measured by `web` in WEB-2 and linked here as an appended note entry.
- Status: active

## D-002 addendum — `/api/quote` latency and no fee cache (WEB-2)
- Date: 2026-11-05 · Author: web · Task: WEB-2
- Report says: §2 "Data" — D1 latency 22–28 ms p50 per read from Marseille to Paris.
- We do instead: `/api/quote` makes 2 sequential D1 round trips (variants + commune `batch()`, then the
  `delivery_fees` read through the FeeProvider) with **no in-isolate cache**, so a fee, price or stock edit applies
  to the next quote. Expected production server time ≈ 50–60 ms p50; quotes run after LCP on user input.
- Why: a cache would save one round trip (≈ 25 ms p50, below user perception off the LCP path) at the cost of up to
  60 s of stale fees; `/api/order` recomputes from D1 anyway and answers `total_changed` on drift.
- Evidence: artifacts/WEB-2/latency.md (local p50/p90 with load average), research-evidence/team-reports/research_backend.md row 6.
- Status: active

## D-003 — Content-only publishes run the static byte budget; the runtime pass runs on image/template changes, every 20th publish and nightly
- Date: 2026-11-07 · Author: jobs (lead ruling on JOBS-3 timing) · Task: JOBS-7
- Report says: CLAUDE.md "Storefront budgets (blocking — enforced by `npm run budget` …)"; report §2
  "Publishing" (admin save → rebuild and redeploy; if too slow, fall back to Workers Cache with tag
  purge) and §11 (publish-to-live never measured).
- We do instead: the publish pipeline (`apps/jobs/scripts/publish.ts`) decides the budget mode
  from the build's own fingerprint against the last good build's (`.wrangler/publish/last-good.json`
  at the repo root on the build machine, gitignored; never an admin flag). The fingerprint is the image-manifest
  digest plus a hash of the git blob ids of apps/storefront, apps/web, packages/catalog/src,
  packages/ui-tokens, packages/shared/src, brand, tools/measure (budget config and thresholds) and
  the root package.json/package-lock.json.
  - **Content-only** (text, price, stock, settings) → measure's **static pass only**, still
    **blocking**: HTML ≤ 14 KiB br, critical path bytes and requests, AVIF ceilings, third-party
    origins in markup. The Chrome runtime pass is skipped.
  - **Any image or template/code/budget-config change**, a dirty tree, an absent, unreadable or
    malformed last-good, a fingerprint schema change, or **20 static-only publishes in a row** →
    the **full** budget, static + runtime, blocking, as before. The reason is logged on the run.
  - **Nightly** (`apps/jobs/scripts/budget-nightly.ts`, started by the build machine's scheduler,
    because a Worker cron cannot launch Chrome): the full budget on the last good build. Its result
    goes to D1 `settings['jobs.runtime_budget']` = {at, ok, summary, publishRunId, fingerprint} for
    the ADMIN-5 tile (red when `ok` is false or `at` is older than 26 h). Only jobs writes it; the
    admin settings form writes a fixed key list. It never deploys and never touches last-good.
  - The report's fallback (Workers Cache + tag purge) stays off.
- Why: a warm (content-only) publish took 801 s on the shared machine, 640 s of it the Chrome
  runtime pass, too slow for "fix a price and see it live". Content-only changes cannot change
  fonts, scripts or third-party requests, which are what the runtime pass checks. They can only move
  HTML size, which the static pass still blocks. Prices and stock are re-checked by `/api/order`
  and `/api/quote` regardless.
- Evidence: `artifacts/JOBS-3/timing.md` (cold 926 s / warm 801 s at 1-min load 4–15; budget 80 %;
  shas and slot waits recorded). Open items:
  1. Re-measure a warm and a cold publish when the 1-min load is ≤ 4, and append the result here
     as a note entry.
  2. Measure on the real build machine. Not available to the team; to be done by the client's
     operator.
- Status: active
- Amended (JOBS-7 review r1, 2026-11-07): the fingerprint also covers packages/db/src and the
  package.json files of packages/db, packages/catalog and packages/shared (the D1 → snapshot
  mapping and dependency manifests), plus the publish pipeline itself (apps/jobs/scripts/publish.ts,
  apps/jobs/scripts/lib, apps/jobs/src/publish). A pass on a dirty tree is never recorded as last
  good, so a later clean build of that commit still gets its own full (runtime) pass.

## D-004 — Lighter process: only typecheck, tests and build block; narrow review
- Date: 2026-11-08 · Author: lead (client instruction) · Task: BOOT-0
- Report says: CLAUDE.md budgets were blocking (Lighthouse 100, byte budgets); REVIEW.md required seven review passes,
  a second-reviewer confirmation on Important findings, and client sign-off on high-risk changes.
- We do instead: a task is done when typecheck, tests and build pass. Lighthouse, byte budgets, axe and tap targets still
  run but only report. Review is one pass, bugs and security only, only for the order path, totals and fees, and admin
  login and roles (`team/REVIEW-REQUIRED.txt`); everything else merges once green. No second-reviewer confirmation. No
  client sign-off except for deploying, which stays out of scope.
- Why: client decision; the goal is a working store on main.
- Evidence: client instruction, 2026-11-08; CLAUDE.md and REVIEW.md updated to match.
- Status: active

## D-005 — The order form lives on a separate static order step
- Date: 2026-11-08 · Author: lead · Task: ORDER-STEP
- Report says: §2 Navigation: "prerender from the product page to the order step"; CLAUDE.md product-page budgets.
- We do instead: one static, noindex order page per product and language at `/{lang}/order/<slug>/`; the product page
  carries the picker and a GET button to it. Prerendering the step is deferred.
- Why: the form inline on the product page projected 14,370 B HTML (limit 14,336) and 44,930 B critical path on the
  worst /ar/ pack page. Without JavaScript the customer confirms the size again on the order step.
- Evidence: artifacts/PAGES-2/wire/checks.log, artifacts/ORDER-STEP/plan.md.
- Status: active

## D-006 — Rulings recorded during the build
- Date: 2026-11-08 · Author: lead · Task: BOOT-0
- Report says: the budgets and data plan in CLAUDE.md / STACK-REPORT.md.
- We do instead / why, one line each (evidence in the named artifacts folders):
  - Never upscale photos: an original narrower than 1200 px gets the standard widths up to its own width, plus its own
    width (artifacts/CAT-4/upscale.md).
  - AVIF candidates up to 960 w target 20 KB, hard ceiling 25,000 B (artifacts/BUG-12/).
  - The French "no webfont" rule is checked at runtime as zero font requests, not by a static @font-face check (BUG-2).
  - axe runs its default rules, best-practice included (artifacts/MEAS-3/).
  - Only the LCP image is eager; every other image stays lazy, even in the first viewport (BUG-17), and images below the
    fold on product pages are deferred until after load (artifacts/BUG-18/).
  - Product-page HTML target 10 KiB brotli; measured about 12.3 KiB on the worst /ar/ pack page, under the 14 KiB limit
    (artifacts/BUG-18/qa/summary.md).
  - Geo data: the Algeria-Cities dataset pinned, then wilaya and commune names verified against the Journal Officiel
    scans (artifacts/GEO-1/, GEO-6/, GEO-7/).
- Status: active

## D-007 — Production deploys go through the GitHub Actions pipeline
- Date: 2026-11-08 · Author: lead (client instruction) · Task: TOOL-8
- Report says: CLAUDE.md "no deploy to the client's Cloudflare account and no Cloudflare login".
- We do instead: the client signed off production deployment and lifted that rule for it. Every production deploy goes
  through `.github/workflows/pipeline.yml`, with the token held in the protected GitHub environment. The Cloudflare
  resources (database, buckets, queues, Access, Turnstile, runtime secrets) and the first catalogue load were one-time
  setup from the CLI. Production account: 78a79deed8832af7d1b4378ef361fb81; domain comptoirdeluxe.com.
- Why: client decision.
- Evidence: client instruction, 2026-11-08; docs/DEPLOY.md.
- Status: active

## D-008 — Cart orders use one order page and one fee; the sheet's CSS is not inlined
- Date: 2026-11-08 · Author: shell (for lead) · Task: CART-0
- Report says: one stylesheet for both directions, inlined; D-005 one order page per product.
- We do instead: (1) the cart orders through one page, `/{lang}/checkout/`, and becomes one order with one delivery fee via `items[]` in `/api/quote` and `/api/order`; D-005's one-page-per-product stays for direct orders. (2) The cart sheet's CSS travels in `public/js/cart-sheet.js` as a constructable stylesheet, loaded after LCP on first use of a cart control, instead of being inlined. hb-postbuild keeps the tokens the sheet reads (`pruneCustomProperties` also scans the client JS).
- Why: client request, 2026-11-08 (artifacts/CART-0/plan.md): first paint must not pay for a sheet most visitors never open. A constructable stylesheet needs no change to the hash-based `style-src`; a `<link>` would have needed `'self'`.
- Evidence: measured on the seed build of this commit: sheet CSS 5,544 B raw, 1,318 B brotli (inside cart-sheet.js, 3,978 B brotli in all); cart.js 1,431 B brotli on every page after LCP. The sheet is tested in Chrome under the served CSP (no violations). Per-template byte and Lighthouse deltas are in the CART proof run.
- Status: active

## D-009 — Launch: placeholders withdrawn, not relabelled
- Date: 2026-11-09 · Author: lead (client gave full ownership of the decision) · Task: LAUNCH-0
- Report says: CLAUDE.md "clearly mark every placeholder"; D-006 no invented fees in production.
- We do instead: production migration 0010 archives the demo products, hides empty categories, makes the 69 delivery fees live, cancels the two test orders and rewrites the content pages to what the store can stand behind. Nothing is deleted. Seed data keeps its placeholder marks for development.
- Why: client instruction "remove the placeholders... fully ready". Fake products cannot be sold. Fees are the distance-based schedule from data/geo, not courier quotes: the owner chose to open with them, editable in the admin, because the store cannot take orders without fees.
- Evidence: artifacts/LAUNCH-0/, approved through the pipeline's destructive-migration hash.
- Status: active

## D-010 — Courier integration, status sync and Sheets start now; D-001 lifted
- Date: 2026-11-09 · Author: lead (client instruction) · Task: BOOT-6
- Report says: CLAUDE.md Non-goals "Courier API integration, including the 58-wilaya courier codes, comes later (D-001)".
- We do instead: the client lifts D-001. The admin sends confirmed orders to couriers directly (Yalidine and the EcoTrack family first, then ZR Express, NOEST and Maystro), with no third-party relay. `wilayas.courier_code` is filled by that integration: orders keep the 69 wilayas, and each courier adapter maps them to the code set that courier uses, so wilayas 59–69 ship through their parent code where the courier still uses 58. Review scope grows to courier, status-sync and Sheets code (REVIEW.md, team/REVIEW-REQUIRED.txt). Delivery fees stay set by the admin; the storefront order form does not change.
- Why: client instruction, 2026-11-09. Delivery is the admin's largest missing function.
- Evidence: client instruction, 2026-11-09. Courier references: artifacts/delivery-research/.
- Status: active. Supersedes: D-001.

## D-011 — An order with a parcel in progress cannot be changed; order changes take an extra guard
- Date: 2026-11-09 · Author: shipping · Task: SHIP-1
- Report says: §2 order states and team/BRIEF §2: `confirmed → cancelled | shipped`, each listing only the roles allowed; contact edits allowed to the owner until the parcel leaves (AORD-0).
- We do instead: while a shipment is reserved, sending, draft, uncertain, or accepted but not yet applied to the order, SQL triggers on `orders` (migration 0012) refuse leaving `confirmed` and changing the wilaya, commune, fee, total, phone, name or address. `buildOrderChange` and `applyOrderChange` also take an optional extra guard on every statement they write, and a new system actor, `courier_sync`, may make only `confirmed→shipped`, `shipped→delivered` and `shipped→returned`. Existing callers pass no guard and behave as before.
- Why: a parcel already handed to a courier collects the amount it was created with. Without the guard an owner could change the fee during a send, or cancel an order whose parcel may exist, and nothing would flag it. A 0-row update does not abort a D1 batch, so a lost compare-and-swap needs the extra guard to write nothing.
- Evidence: artifacts/SHIP-0/contract.md (revision 3), artifacts/SHIP-0/contract-challenge.md M1, M2, M4, artifacts/SHIP-0/contract-challenge-r2.md N1, N2 (trigger behaviour measured on local D1); lead rulings 2026-11-09, artifacts/SHIP-0/approval.md; tests in packages/db/test/shipping.test.ts.
- Status: active

## D-012 — Connecting Google Sheets exports every existing order
- Date: 2026-11-09 · Author: sheets · Task: SHEET-2
- Report says: nothing about Google Sheets; ADMIN2 brief §5 specifies one row per order and automatic catch-up without saying whether older orders are included.
- We do instead: connecting exports every existing order to the owner's own Google Drive, oldest first, in batches of 300 per run. That includes customer names, phones and addresses. Notes, flags, risk score and IP hash are not exported.
- Why: lead ruling on the client's request for each order as one row; the data stays in the account of the admin who connects it.
- Evidence: artifacts/SHEET-0/approval.md; artifacts/SHEET-0/contract.md §2 and §3; apps/jobs/test/sheets/sync.d1.test.ts (check 23).
- Status: active
