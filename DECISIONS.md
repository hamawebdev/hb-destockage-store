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

## D-013 — The courier webhook route reads and writes D1, and signatures are checked in jobs
- Date: 2026-11-09 · Author: shipping · Task: SHIP-4
- Report says: §2 "Data", CLAUDE.md: D1 is touched only on the order and quote POSTs and in the admin (D-002). ADMIN2/BRIEF §5: the webhook route verifies a signature or per-account token.
- We do instead: `/api/courier-hook/:courier/:token` on apps/web looks up the account by the SHA-256 of the URL token (one indexed read) and writes the byte-exact body and filtered headers to `courier_webhook_inbox`. A courier's own signature is verified in apps/jobs, not in this route, so the storefront Worker never holds courier secrets. The token is always enforced in the route. Malformed tokens cost no D1 query; bodies are capped at 32 KiB so a row stays within the daily backup's 90,000-byte statement limit. No rate-limit binding (lead ruling).
- Why: couriers cannot reach the admin behind Cloudflare Access. Webhooks are not visitor page views, so no page depends on D1 here.
- Evidence: artifacts/SHIP-0/contract.md rules 16 and 16a; lead rulings 2026-11-09, artifacts/SHIP-0/approval.md; apps/web/test/couriers/.
- Status: active

## D-016 — ADMIN2 branches may merge without merge.sh's per-merge gate, with one full gate after
- Date: 2026-11-10 · Author: lead (ADMIN2) · Task: ADMIN2
- Report says: CLAUDE.md "How work happens": only the lead merges, through `scripts/team/merge.sh`, which gates every merge result before main moves.
- We do instead: for the remaining ADMIN2 branches (in the end only team/adminui@9440fb6, merged at 3f53b95), the lead runs `merge.sh --dry-run` (approvals ledger, ownership, net-diff, conflicts), merges with `git merge --no-ff` as the lead if it is clean, then runs one full `scripts/gate.sh` on main's merge commit. If that gate is red, the lead fixes or reverts before anything else lands. Never pushed.
- Why: the client's owner authorised it on 2026-11-10. Main is shared by three sessions; each gate takes 1–2 h on the loaded machine, and the per-merge gates kept main busy for a day. One merge.sh run was stopped by another session when main moved under it.
- Evidence: artifacts/ADMIN2/merge-ux-dry.log (dry-run OK; the merge tree equals the dry-run trial 7912d2a7a); the full gate log for 3f53b95 under artifacts/gate/; artifacts/ADMIN2/HANDOFF.md.
- Status: active for ADMIN2 only; every other merge keeps merge.sh.

## D-014 — Meta's Pixel is a scoped exception to "no third-party scripts, no cookies, no analytics"
- Date: 2026-11-08 · Author: growth (for lead, client instruction) · Task: META-1
- Report says: CLAUDE.md "No analytics or chat widgets", "Storefront: no cookies, no third-party scripts, hash-based CSP", "No third-party origin before LCP"; STACK-REPORT.md §2.
- We do instead: the storefront may load Meta's Pixel (`https://connect.facebook.net/en_US/fbevents.js`), accept the cookies Meta's own script sets (`_fbp`, `_fbc`), and send it events. **This covers Meta's Pixel and its own cookies only.** Every other storefront rule still holds: no other third-party script, no cookie of ours, nothing third-party before LCP, a hash-based CSP that grows only by the Pixel's origins and only on pages that carry the Pixel. Until a Pixel ID is set there is no script, no choice shown, no CSP change and no request. With one set, nothing loads or is sent, by browser or server, until the visitor accepts (setting `META_CONSENT_REQUIRED`, on by default).
- Why: client decision, for Meta ad measurement on a cash-on-delivery store.
- Trust boundary: consent reaches the server as the visitor's own browser's claim (`meta.consent === true` in the JSON order body). It cannot be verified without a cookie, which the client ruled out for the choice. A bot posting someone else's phone with `consent:true` sends that hash to Meta, the same exposure as placing a fake order in that person's name. The no-JS path has no consent and never sends.
- Evidence: client instruction, 2026-11-08 (artifacts/META-0/brief.md Part 1, "WHAT IS DECIDED"); contract and lead approval (artifacts/META-0/contract.md, artifacts/META-0/lead-approval.md); `.claude/skills/meta-pixel/SKILL.md` and `references/privacy-and-consent.md`; `.claude/skills/meta-conversions-api/SKILL.md`. Behaviour against the real Meta is not verified by this entry: it needs real credentials (docs/META-GO-LIVE.md).
- Status: active

## D-015 — Meta's code is exempted from `js-after-lcp` on a build with Meta configured
- Date: 2026-11-09 · Author: growth (for lead, client decision) · Task: META-9
- Report says: CLAUDE.md "≤ 10 KB br JS after LCP"; `npm run budget` rule `js-after-lcp` (every same-origin JS file a page can reach, at the larger of brotli q11 and q4).
- We do instead: on a build with `META_PIXEL_ID` set, `js-after-lcp` may flag pages for the Meta code they can reach. **This covers only `js-after-lcp`, only on a build with Meta configured, and only the Meta files below.** Every other budget stays strict, and every build without Meta configured stays strict and unchanged.
- What the tool counts against what a visitor downloads: the tool adds every file a page can reach, so splitting code cannot lower its number. It counts `/js/meta.js` 478 B plus `/js/meta-full.js` 3,250 B = 3,728 B on every marked page. A visitor with no stored `granted` downloads only the stub, 478 B, before any input. `meta-full.js` loads after the first input (to show the choice), never after a stored decline, and at once for a stored `granted` or with consent off and no stored decline.
- The bound that blocks instead: on every page that passed `js-after-lcp` before Meta, the page's previous total plus the stub stays within 10,000 B. Worst case 8,327 B (`/fr/search/`) + 478 B = 8,805 B. In real Chrome with no input and no consent, no Meta file other than the stub is requested. The file reference stays visible to the tool; the flagged pages are reported, not hidden: of the 107 pages that passed before, the tool flags 102 when Meta is configured. The other five carry no Pixel and are not flagged: the three 404 pages (`/404.html`, `/ar/404.html`, `/fr/404.html`) and the two review pages (`/ar/order/review/`, `/fr/order/review/`).
- Why: client decision. The Pixel's code cannot fit in the room the budget leaves (1,673 B on the 48 product and search pages), and a visitor who has not accepted does not download it before acting.
- Evidence: client's choice of 2026-11-09 (artifacts/META-0/lead-approval.md Addendum 7); artifacts/META-0/measure/summary.md; sizes measured the budget tool's way on a seed build of this change.
- Status: active

## D-020 — Takeover of ADMIN2 and Meta: merge without merge.sh's gate, verify once on final main, then deploy
- Date: 2026-11-10 · Author: lead (takeover session ecom-website-f6) · Task: BOOT-25
- Report says: CLAUDE.md "How work happens": only the lead merges, through `scripts/team/merge.sh`, which gates every merge result. D-016 limited the gate-free path to ADMIN2. Main had no green full gate at 317dba2 (r1 red only on the 1800 s time limit of `packages/db` `orders.test.ts` on a loaded machine).
- We do instead: the owner handed the ADMIN2 lead's and the Meta/SEO lead's work to one session with a one-hour deadline and a live deploy. That session stops both sessions, merges team/growth@142b574 with `git merge --no-ff` as the lead, and runs typecheck, tests and build once on the final main (locally and in the pipeline's own checks). Order-path, totals/fees and admin login/roles changes get one bugs-and-security pass from the takeover lead before merging. Then main is pushed, which deploys through the pipeline (D-007). SEO (SEO-1..4) and META-10 are not started and stay out. D-017 to D-019 stay reserved for the CLX session.
- Why: the owner authorised it on 2026-11-10 ("merge without it and run typecheck, tests and build once on the final main"); a per-merge gate takes 1–2 h on this machine.
- Evidence: artifacts/TAKEOVER/ (process trees of the stopped sessions, review note, check logs); team/APPROVALS.md META-0 r3 and META-9 r3 (rev-g); the pipeline run for the pushed commit.
- Status: one use, for this takeover only; every later merge keeps merge.sh.

## D-019 — Cart switch: merge without merge.sh's gate, one review pass, verify once on final main, then deploy
- Date: 2026-11-10 · Author: lead (CLX session ecom-website-c8) · Task: BOOT-27
- Report says: CLAUDE.md "How work happens": only the lead merges, through `scripts/team/merge.sh`, which gates every merge result; deploying is a non-goal outside the pipeline's sign-off (D-007). D-016 and D-020 limited the gate-free path to ADMIN2 and the takeover.
- We do instead: for the cart on/off switch only (team/cart, CART-1 to CART-5), the lead merges with `git merge --no-ff`, without the per-merge gate, and runs typecheck, tests and build once on the final main. The order-path and admin-role changes get one bugs-and-security review pass by a reviewer who did not write them (rev-l), recorded in team/APPROVALS.md, before the merge. Main is then pushed, which deploys through the pipeline (D-007), and the live site is checked. The switch itself needs no deviation from STACK-REPORT.md: pages stay static, the switch is a build input read from the published snapshot, the Worker never reads it.
- Why: the owner authorised it on 2026-11-10 with a three-hour deadline ("merge without it and run typecheck, tests and build once on the final main … those changes get one review pass for bugs and security before they merge … then deploy through the normal pipeline"); a per-merge gate takes 1–2 h on this machine.
- Evidence: artifacts/CART-4/review-r1.md and review-r2.md (rev-l); artifacts/CLX/cart-requirements.md (each requirement and its proof); artifacts/CLX/final/ (typecheck, test and build logs on main); the pipeline run for the pushed commit.
- Status: one use, for the cart switch only; every later merge keeps merge.sh. D-017 and D-018 stay reserved for the Meta settings and the rename.

## D-021 — COURIER_KEYS_KEY was generated and set by hand on hb-admin and hb-jobs, once
- Date: 2026-11-10 · Author: lead (session ecom-website-f6) · Task: BOOT-27
- Report says: CLAUDE.md Non-goals and D-007: nothing reaches the production account by hand; runtime secrets live in Cloudflare and the pipeline never reads or sets them (docs/DEPLOY.md).
- We do instead: one exception. The key was generated with `openssl rand -base64 32` into a file outside the repo (owner-only, read-only) and set with `wrangler secret put COURIER_KEYS_KEY --name <worker>` on `hb-admin` and `hb-jobs`, the same value on both, as docs/DEPLOY.md "Shared key (once)" says. `hb-web` does not read it and did not get it. Nothing else was changed in production: no deploy, no D1 command, no other secret.
- Why: the owner authorised it on 2026-11-10. The key was never set, so the live courier page showed "COURIER_KEYS_KEY n'est pas configurée" and no courier key could be saved. Nothing had been sealed before, so no stored value was affected.
- Evidence: `wrangler secret list` shows the name on both Workers (it was on neither before); the file's value imports as a 32-byte key and seals and opens with packages/db/src/secret-box.ts. The live page behind Cloudflare Access was not opened by this session: the owner checks it.
- Status: done, one use. The value must never change while couriers or Sheets are connected; it is not in the repo, a log or a commit.

## D-018 — Rename and Meta settings: merge without merge.sh's gate, one review pass, pipeline verification, deploy tonight
- Date: 2026-11-10 · Author: lead (CLX session ecom-website-c8) · Task: BOOT-32
- Report says: CLAUDE.md "How work happens": only the lead merges, through `scripts/team/merge.sh`, which gates every merge result. D-019 limited the gate-free path to the cart switch.
- We do instead: for the rename to Comptoir de Luxe (team/rebrand, REBR-1 to REBR-7, including migration 0013) and the Meta credentials in the admin (team/meta, MSET-1 to MSET-6, design in D-017), the lead merges with `git merge --no-ff` without the per-merge gate. Each branch gets one bugs-and-security review pass by a reviewer who did not write it (rev-l for the rename, with migration 0013 also applied to a real local D1; rev-m for Meta), recorded in team/APPROVALS.md; small review fixes after that pass are read by the lead or the reviewer and recorded too. Authors run the scoped tests and typecheck of what they touch. The full typecheck, tests and build run in the pipeline's own checks on every push, and nothing deploys when they are red. Migration 0013 is two plain UPDATEs that the pipeline classes as destructive, so the deploy halts and the lead starts the approval run (`approve_destructive_migrations=<hash>`) under the owner's instruction. `SETTINGS_ENCRYPTION_KEY` was generated straight into the GitHub production environment, never printed or stored elsewhere.
- Why: the owner asked on 2026-11-10 to finish Meta and the rename and deploy them before midnight, the approach left to the lead; a per-merge gate takes 1–2 h and a full local test run about 65 min on this machine.
- Evidence: artifacts/REBR-4/review-r1.md, artifacts/REBR-6/review-r1.md, artifacts/MSET-5/review-r1.md; artifacts/CLX/lead-log.md; the pipeline runs for the pushed commits; the live checks under artifacts/CLX/live/.
- Status: one use, for these two branches tonight; every later merge keeps merge.sh.

## D-017 — Meta's settings come from the admin (D1), not from deployment variables
- Date: 2026-11-10 · Author: meta (for lead, client instruction) · Tasks: MSET-0 … MSET-6
- Report says: D-014 and D-015 as written, which took the Pixel ID, consent setting, access token and test event code from deployment variables (`META_PIXEL_ID`, `META_CONSENT_REQUIRED` as GitHub repository variables; `META_ACCESS_TOKEN` as a production secret passed to hb-web; `META_TEST_EVENT_CODE`).
- We do instead: the admin is the only source. The owner (permission `meta.settings`, owner only) enters, changes and removes them on `/meta`. They are rows in the existing `settings` table: `metaPixelId` (15–16 digits, not all zeros), `metaConsentRequired` (boolean, missing ⇒ true), `metaAccessTokenEnc`, `metaTestEventCode`. The four deployment variables are gone from the code, the pipeline, the deploy scripts, the wrangler configs and the tests (the go-live doc lists them as things to delete).
- Where each value is read: **browser** values (Pixel ID, consent) from the published snapshot (`settings.metaPixel`, exported through the storefront allowlist), so they change at the next publish; **server** values (Pixel ID, token, test code) from D1 when hb-web sends, inside the existing `waitUntil` after the order is answered (one statement, only for a new order with the consent signal). The server sends only when the page's Pixel ID, carried in the consent signal (`meta.pixel`), equals the stored one: removing the Pixel ID stops server events at once, and a page built without Meta never causes one. The token and the test code are never exported, never in the snapshot or the catalogue artifact (the production export also refuses them by name).
- The token: AES-256-GCM (WebCrypto), stored as one JSON string = base64(version byte ‖ random 96-bit IV per write ‖ ciphertext and tag), additional data bound to the key name and version. Key: Worker secret `SETTINGS_ENCRYPTION_KEY` (32 random bytes, base64) on hb-admin (encrypts) and hb-web (decrypts), never in D1; the pipeline uploads it from a GitHub production secret with `wrangler deploy --secrets-file` on the "Deploy Workers" step only, argv unchanged when it is not set. Missing key: the admin refuses to save a token, the Worker sends nothing. Wrong key or tampered value: no event, no secret logged, the order unaffected. The admin shows at most the token's last 4 characters, never sends it to the browser, and audits only `set`/`change`/`remove` markers. Known limits: no key rotation (a new key makes the stored token unreadable until it is entered again); the nightly backup holds the ciphertext.
- **D-014 and D-015 limits are unchanged.** Only the source of the values moved. Guarded by the same tests, migrated without loosening an assertion: nothing Meta loads or is sent before consent or before LCP (`tests/e2e/meta-consent.spec.ts`, `apps/storefront/test/meta-stub.test.ts`, `meta-js.test.ts`); the CSP grows only by the Pixel origins and only on pages with the marker (`apps/web/test/csp-meta.test.ts`, the `_headers` diff in `meta-consent.spec.ts`); server events only with consent, JSON path only, once per created order (`apps/web/test/meta-order.workerd.test.ts`, `packages/shared/test/meta.test.ts`); an unconfigured build carries nothing (`tests/e2e/meta-unconfigured.spec.ts`); the D-015 bound on `js-after-lcp`.
- Why: client instruction (artifacts/CLX/briefs/meta.md, "Objective"): the owner manages Meta without a deployment, and the token never sits in GitHub or the Worker's plain configuration.
- Evidence: artifacts/MSET-0/plan.md (lead approval §12); artifacts/MSET-1 … MSET-6 (tests, screenshots, end-to-end run against the local stand-in, sentinel-token greps). Behaviour against the real Meta is not verified: docs/META-GO-LIVE.md.
- Status: active

## D-022 — Order messages to Telegram carry the customer's details the owner ticks; Telegram is set up in the admin
- Date: 2026-11-16 · Author: lead (client instruction) · Tasks: TGS-1 … TGS-4
- Report says: the queue contract (`packages/shared/src/messages.ts`) and `apps/jobs/src/notify/format.ts`: a staff message carries the order ref, total and wilaya only; the name, phone, address and items never leave the admin. The bot token and chat were Worker secrets (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`).
- We do instead: the client reverses that rule for Telegram. The owner (permission `telegram.settings`, owner only) pastes the bot token on `/telegram`, confirms the chats the page finds through `getUpdates`, and ticks which details each message carries: ref, name, phone, wilaya and commune, address, products with variant and quantity, delivery fee, total, note. The message holds exactly the ticked ones, read from D1 at send time, so a change applies from the next message. Email keeps the old minimal text, and the queue message itself still carries no personal data. The two secrets are gone; the admin is the only source (the same move as D-017). The token is sealed with `COURIER_KEYS_KEY` (already on hb-admin and hb-jobs, D-021), shown only as the bot's @username and last 4 characters, and never logged, audited or exported; `telegram`, `telegramBotTokenEnc` and `jobs.telegram_status` are internal settings keys the snapshot and the production export refuse.
- Lead choices the client left open: (1) a missed message is retried by a per-minute sweep for 72 hours, not by the queue, whose retries end after about four hours and would also have tied Telegram to email; a Telegram failure never retries or dead-letters an order message. (2) Orders created while Telegram is switched off, or before a chat was confirmed, are not sent later. (3) The order form has no customer note, so the note tick shows a line only when a note exists; no field was added to the checkout. (4) The full controls are on their own owner-only page, with a Telegram card and a Google Sheets card on the settings page. (5) At most 10 confirmed chats. (6) Outside production, Telegram traffic is held to a loopback address like courier and Google traffic; the local acceptance run reaches the real services through `tools/standins/live-proxy.mjs`, which is never deployed.
- Why: client instruction, 2026-11-16: the owner wants each order's details in the Telegram message itself, in the chats he chooses, managed without a deployment.
- Trust boundary: whoever is in a confirmed chat reads the ticked details of every order, and Telegram stores them. The page lists every confirmed chat and removes one in one tap; chat titles come from Telegram users and are shown escaped.
- Evidence: client instruction, 2026-11-16; artifacts/TGS/brief.md (contract); tests in packages/shared/test/telegram*.test.ts, packages/db/test/telegram-settings.test.ts, apps/jobs/test/notify-telegram.d1.test.ts, apps/admin/test/telegram/; the local run recorded in artifacts/TGS/acceptance.md.
- Status: active. Reverses the "never reach Telegram" rule for Telegram only.

## D-023 — Telegram and Sheets switch-on: merge without merge.sh's gate, verify once on final main, then deploy
- Date: 2026-11-16 · Author: lead · Task: BOOT-35
- Report says: CLAUDE.md "How work happens": only the lead merges, through `scripts/team/merge.sh`, which gates every merge result. D-016, D-018, D-019 and D-020 limited the gate-free path to their own branches.
- We do instead: for team/notify only (TGS-1 to TGS-4, merged at 7f367f6), the lead merges with `git merge --no-ff` without the per-merge gate and runs typecheck, tests and build once on the final main. The lead read the jobs and admin changes for bugs, the token and personal data before merging; no separate reviewer was used. Main is then pushed, which deploys through the pipeline (D-007).
- Why: the owner authorised it on 2026-11-16 with a four-hour deadline ("merge without it and run typecheck, tests and build once on the final main"); a per-merge gate takes 1–2 h on this machine.
- Evidence: artifacts/TGS/final/ (typecheck, test and build logs on main); the pipeline run for the pushed commit.
- Status: one use, for this branch only; every later merge keeps merge.sh.

## D-024 — The Google client values were set by hand on hb-admin and hb-jobs, once
- Date: 2026-11-16 · Author: lead · Task: BOOT-36
- Report says: CLAUDE.md Non-goals and D-007: nothing reaches the production account by hand; runtime secrets live in Cloudflare and the pipeline never reads or sets them (docs/DEPLOY.md "Google Sheets").
- We do instead: one exception, as D-021 was for the courier key. The Google Cloud project `comptoirdeluxe-orders` (number 328628747241) was created with the Google CLI in the client's own Google account, with the Sheets and Drive APIs enabled. Google allows the consent screen and the OAuth client only in its web console (the CLI's `iap oauth-brands create` answers "Project must belong to an organization"), so the owner created them there: a Web client with the redirect URI `https://admin.comptoirdeluxe.com/sheets/callback` and two loopback ones for the local run. Its values were then set with `wrangler secret put`: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on `hb-admin` and `hb-jobs`, `GOOGLE_REDIRECT_URI` on `hb-admin`. Nothing else was changed in production: no deploy, no D1 command, no other secret. `hb-web` holds none of them.
- Why: the owner authorised it on 2026-11-16 ("if the Google values have to be set as secrets on the production Workers by hand, I authorise that as the owner, as a one-time exception"). The sync was built on 2026-11-09 and never switched on because no Google project existed.
- Evidence: `wrangler secret list` shows the three names on hb-admin and the two on hb-jobs (none before); the same client connected the client's Google account on a local run and wrote three orders to a sheet in his Drive (artifacts/TGS/acceptance.md). The downloaded client file is kept outside the repo, owner-only; its secret is in no commit, log or artifact.
- Status: done, one use. The consent screen must stay "In production": in "Testing", Google ends the connection after 7 days.
