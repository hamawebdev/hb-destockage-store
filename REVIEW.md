# Review rules — HB Destockage

Simplified by the client on 2026-11-08 (DECISIONS.md D-004). The spec is [STACK-REPORT.md](STACK-REPORT.md); rules and
budgets are in [CLAUDE.md](CLAUDE.md); deviations are in [DECISIONS.md](DECISIONS.md).

## 1. What needs a review

Only changes to **the order path, totals and fees, admin login and roles, and courier delivery, parcel-status sync and
Google Sheets** (added 2026-11-09, D-010): the paths listed in `team/REVIEW-REQUIRED.txt`. Everything else merges once typecheck, tests and build are green.

## 2. The review

- One reviewer, who did not write the change. **One pass, bugs and security only.** No visual, performance or
  accessibility pass, and no second-reviewer confirmation.
- Read the changed code against its intent and the contracts it builds on, and run it where you can.
- Treat as blocking: an order lost or duplicated; a wrong price, fee or total, or client-sent totals trusted; stock going
  negative or not restored; a wrong fee for a wilaya; Turnstile problems rejecting an order (must accept and flag); phone
  validation accepting non-mobile ranges or rejecting valid ones; admin reachable without login, a role doing what it
  should not, dev login outside local development; missing input validation or an exploitable input; a parcel created
  twice; a courier status that moves an order wrongly or an unknown status that moves it at all; a returned parcel restocked
  more or less than once; courier or Google keys reaching the repo, logs or browser; a real courier or Google host reachable
  outside production; Google or a courier being down blocking or slowing an order or an admin action.
- Tag findings **Important** (blocks) or **Nit** (does not). Cite file and line. Drop anything about style.

- Admin UI work needs no ledger approval, but gets one click-through by its reviewer: Arabic and French, phone and desktop,
  failure and empty states, written up the same way.

## 3. The review file

`artifacts/<ID>/review-r<n>.md`, starting with these lines:

```
Findings: <i> Important, <n> Nit
Verdict: APPROVED            (or: Verdict: CHANGES REQUESTED)
Commits: <sha> [<sha> …]
Reviewer: rev-x · Author: <name> · Date: YYYY-MM-DD
```

## 4. Merging

- Only the lead merges to `main`, with `scripts/team/merge.sh`. The lead records approvals in `team/APPROVALS.md`.
- An approval covers exactly the shas on its `Commits:` line. A fix after approval on a listed path needs its own pass, on
  the new diff only.
- No client sign-off is needed, except for deploying. Deploying stays out of scope (CLAUDE.md, Non-goals).
