# Review rules — HB Destockage

Every commit that reaches `main` has been reviewed under these rules. The spec is
[STACK-REPORT.md](STACK-REPORT.md); rules and budgets are in [CLAUDE.md](CLAUDE.md); deviations are in
[DECISIONS.md](DECISIONS.md); workflow detail is in [team/BRIEF.md](team/BRIEF.md) §6.

## 1. Who reviews, with what

- A **fresh teammate who did not write the change** reviews it: the reviewer named for the author in
  `team/owners.json` (`reviewer`). The author never reviews their own work, and an agent that helped
  write a change (including a subagent the author spawned) does not review it.
- The reviewer gets: the diff (`git diff <base>..<sha>` on the author's branch), the task's stated
  intent (the build task's description and the `REV <ID> r<n> @<sha>` task: intent, risk tier, sha
  range, how to exercise it) and **the whole repo** — read the code around the diff, the contracts it
  builds on (`packages/db/src/schema.ts`, `packages/shared/src/`, `packages/catalog/src/types.ts`),
  STACK-REPORT.md and DECISIONS.md.
- **Routing.** Teammates have no task tools and cannot rely on messaging each other, so every review
  goes through the lead (`team-lead`): the author messages the lead with the sha and intent; the lead
  creates the `REV <ID> r<n> @<sha>` task and forwards it to the reviewer; the reviewer sends the
  verdict (path of the review file) to the lead, who forwards it to the author. Second-confirmation
  requests (§4) also go through the lead.
- Work in your own worktree (`.worktrees/<you>`): one repo, so no fetch; check out the author's sha
  detached (`git checkout --detach <sha>`) or merge it into a scratch branch, `npm ci`, and run
  servers only on **your** ports (`scripts/team/port.sh <you>`, e.g. `PORT=<base> npm run dev -w @hb/web`).

## 2. The seven passes

Run each pass separately, with only that lens. The `review-*` subagents in `.claude/agents/` are one
per pass; spawn them in parallel and merge their findings. A pass that cannot apply is recorded as
`n/a — <reason>` (e.g. "visual: n/a — migration-only change, no rendered output").

| # | Pass | What you actually do |
|---|---|---|
| 1 | **Bugs and correctness** | Read every changed line against the intent and the contracts. Edge cases: empty/zero/max, Arabic and Eastern-Arabic digits, missing optional fields, concurrent requests, retries. Run `npm run typecheck && npm test`; add a failing test case to your notes when you claim a bug. |
| 2 | **Simplification** | Could the diff be smaller or plainer with the same behaviour? Dead code, needless abstraction, a dependency where 10 lines do, duplicated logic that belongs in `packages/shared`. Only findings that change behaviour risk or maintenance cost count — not taste. |
| 3 | **End-to-end** | Exercise the real flow. `npm run build`; `npx wrangler dev` for `apps/web` / `apps/admin` on your ports with local D1 seeded; open the page, **submit the order form** (with and without JS), check the D1 rows, click through the admin (login, order list, status change, fee edit, publish). `npm run e2e` once it is wired. Record what you ran and what you saw. |
| 4 | **Visual** | `npm run shots` → screenshots at **360, 768 and 1440 px**, in **`/ar/` and `/fr/`**, for every template the change touches. Compare with `docs/design-reference/` and the brand guide in `brand/`. Check RTL mirroring: layout, directional icons (arrows, chevrons, breadcrumbs), inline-start/end spacing, phone numbers/SKUs/refs not reversed. Attach paths under `artifacts/<ID>/`. |
| 5 | **Performance** | `npm run budget` and `npm run lh` (never run Lighthouse outside `npm run lh`). Lighthouse 13.6.0 mobile, median of 5, **Performance 100** on every template in both languages; HTML+inline CSS ≤ 14 KiB br; critical path ≤ 45 KiB in ≤ 4 requests; hero AVIF ≤ 25 KB at every width ≤ 960 w; 0 KB JS before LCP, ≤ 10 KB br after; no third-party origin before LCP. Attach the JSON paths. |
| 6 | **Accessibility** | `npm run axe` (zero violations) and Lighthouse Accessibility 100. Then by hand: **keyboard only** through the changed flow (focus visible, order logical in RTL, no trap), tap targets ≥ 44 px, contrast ≥ 4.5:1, labels and errors announced, `lang` on mixed-language spans, `prefers-reduced-motion` honoured. WCAG 2.2 AA. |
| 7 | **Security** | For the order endpoint (`/api/order`, `/api/quote`) and the admin. Input validation (Valibot) on every field; server recomputes totals; idempotency and dedup; rate limit keyed on phone; Turnstile missing ⇒ accept and flag; no secrets in the repo or the static bundle; admin: Access JWT verified (signature, AUD, expiry), role checks on every route and transition, CSRF on state-changing forms, `private, no-store`; SQL only through Drizzle/bound params; CSP hash-based, no `unsafe-inline`; no cookies on the storefront. |

## 3. What failure looks like here

Treat any of these as **Important** unless clearly harmless:

- A storefront page over its byte budget, or **any third-party origin before LCP**.
- **JS before LCP**, or more than 10 KB br of JS after it; a framework runtime (React, Preact
  hydration, i18n runtime) on the storefront.
- Lighthouse Performance or Accessibility **< 100** on any template/language, or **any axe violation**.
- Broken RTL or bidi: phone numbers, SKUs, order refs, Latin brand names reversed or reordered;
  icons not mirrored; layout not mirrored; `dir`/`lang` missing.
- **Physical CSS properties** (`left`, `right`, `margin-left`, `padding-right`, `text-align: left`,
  `float: left`…) instead of logical ones. **Letter-spacing on Arabic.**
- An **order lost or duplicated**: insert not durable before the success response; duplicate submit
  (same `idempotencyKey`) creating a second order; same phone + variant within 30 min not flagged
  `duplicate`; queue failure losing the order.
- A **wrong total**: price, fee or total shown or stored differing from the server's recomputation;
  any non-integer DZD; client-sent totals trusted.
- A **fee not matching the admin-set wilaya fee** (`delivery_fees`), or a quote for an unavailable
  wilaya not marked `available: false`.
- **Stock going negative**; stock not decremented atomically (`UPDATE … WHERE stock >= qty`) or not
  restored on `cancelled`/`returned`; `stock = NULL` treated as zero.
- **Admin reachable without auth**, dev login active outside `ENV=development` + localhost, or a
  role doing what it shouldn't (a transition not allowed for that role in `order-state.ts`).
- **Audit log or order events mutable** (missing/ineffective `ABORT` triggers on UPDATE/DELETE).
- **Turnstile missing or invalid causing a rejected order** (must accept and flag).
- **Phone validation** accepting 050–053 or other non-mobile ranges, or rejecting valid ones
  (national `5(4[0-29]|6[0-4])\d{6}|(55|6\d|7[7-9])\d{7}`); Eastern-Arabic digits not converted;
  rate limits keyed on IP first.
- A **placeholder not marked** (`placeholder: true` in data, `[PLACEHOLDER]` in copy).
- Missing reciprocal hreflang / `x-default`, or any redirect on Accept-Language.
- D1 read on a page-load path (only order/quote POSTs and the admin may read it — D-002).
- A deviation from STACK-REPORT.md without a DECISIONS.md entry in the same commit.
- A file edited outside the author's owned paths (`team/owners.json`).

## 4. Findings

- Every finding cites **file and line** (`apps/web/src/order.ts:42`) or an **artifact path**
  (`artifacts/WEB-2/lh/fr-product.json`). Never a guess from a name: open the file.
- Tag each: **Important** (breaks a rule above, a budget, the spec, or correctness),
  **Nit** (worth fixing, does not block), **Pre-existing** (true, but not introduced by this diff —
  file it as a new task instead of blocking).
- **Drop** findings that are only about style or cleanup.
- **Second confirmation.** An Important finding stands only if a second reviewer independently
  confirms it. Pairs: **rev-a ↔ rev-b, rev-c ↔ rev-d, rev-e ↔ rev-f**. Send the partner (through the
  lead) only the location and the claimed failure (not your reasoning); the partner re-derives it and writes, under
  the finding in the same review file, `confirmed` or `not confirmed` with their evidence. A finding
  marked `not confirmed` is downgraded to Nit.

## 5. The review file

`artifacts/<ID>/review-r<n>.md` (r1, r2, … per round). Exact shape — `scripts/team/merge.sh` and the
`TaskCompleted` hook parse the first lines:

```
Findings: <i> Important, <n> Nit, <p> Pre-existing
Verdict: APPROVED            (or: Verdict: CHANGES REQUESTED)
Commits: <sha> [<sha> …]     (full or ≥ 7-char shas, every commit reviewed in this round)
Reviewer: rev-x · Author: <name> · Risk tier: low|high · Date: YYYY-MM-DD

## 1. Bugs and correctness
…
## 2. Simplification
…
## 3. End-to-end
…   (commands run, what happened)
## 4. Visual
…   (screenshot paths)
## 5. Performance
…   (budget / Lighthouse artifact paths)
## 6. Accessibility
…
## 7. Security
…
## Findings
- [Important] apps/web/src/order.ts:42 — <what fails, how to reproduce> — status: open | fixed in <sha> | answered: <reason>
  - rev-y: confirmed — <evidence>
- [Nit] …
```

When there is nothing to fix, write plainly **"Nothing to fix."** under Findings.

## 6. Author response

- Fix each finding or answer it with a reason, in the review file's finding line (`fixed in <sha>` /
  `answered: …`) and in a new commit `<ID>: address review r<n>` (never amend or rebase a commit under
  review).
- A fix covers **every instance of that class of bug**, not just the cited line (grep for the
  pattern; say what you searched).
- Then message the lead (`team-lead`) the new sha; the lead opens round n+1 (`REV <ID> r<n+1> @<sha>`).

## 7. Re-review

- Round n+1 looks **only at the new diff** (`<last reviewed sha>..<new sha>`) and whether the open
  findings are resolved. It never repeats earlier findings and does not open new lines of inquiry on
  code already approved.
- **After three rounds on the same change**, the author stops patching and reconsiders the approach
  with the lead.

## 8. Approval by risk

Approval depends on **what the change touches**, not on who wrote it.

- **Low risk:** the fresh reviewer approves when every pass is green (or `n/a`) and no Important
  finding is open.
- **High risk** — the order write path (`/api/order`, stock decrement, idempotency, dedup), totals
  and fees (`money.ts`, `fees.ts`, `/api/quote`, `delivery_fees`), anti-fraud logic (rate limits,
  Turnstile, honeypot, flags), admin auth and roles (Access JWT, dev login, `requireRole`, state
  transitions), anything that deletes or exports customer data (D1 → R2 export, customer deletion),
  security headers and CSP, deploy configuration, CI/gate and hook configuration
  (`.githooks/`, `scripts/gate.sh`, `scripts/team/`, `.claude/settings.json`, `team/owners.json`):
  reviewer approval is required, **then** the lead takes it to the client with the evidence and
  waits for the client's sign-off, recorded by the lead in `team/SIGNOFFS.md`. An agent's approval
  never stands in for the client's.
- The author states the risk tier in the commit (`Risk tier:`); the reviewer may raise it (never
  lower it) and says so in the review file.

## 9. Approval is per commit

An approval covers exactly the shas on its `Commits:` line. Any new commit after approval — even a
one-line fix — needs its own approval (a new round on that diff). `scripts/team/merge.sh` refuses
any commit not covered by an `APPROVED` review (and, for high risk, a `team/SIGNOFFS.md` line).
