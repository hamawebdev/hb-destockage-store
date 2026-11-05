# Approvals ledger (lead-only)

The authoritative record of review verdicts. Only the lead commits to this file (on `main`, `HB_ROLE=lead`).
Review files under `artifacts/<ID>/review-r<n>.md` hold the evidence; this ledger is what `scripts/team/merge.sh` trusts.

Effective risk tier = the higher of the commit's `Risk tier:` and the tier recorded here (a reviewer can escalate, never lower).
A commit is mergeable iff it is listed in some line for its ID, the latest line for that ID is APPROVED, and — when the effective tier is high — `team/SIGNOFFS.md` has a client sign-off covering it.

One line per review round:
`<ID> r<n> APPROVED|CHANGES_REQUESTED tier=<low|high> reviewer=<rev-x> commits=<full-sha>[,<full-sha>…] review=artifacts/<ID>/review-r<n>.md`

