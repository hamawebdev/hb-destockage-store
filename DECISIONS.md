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
