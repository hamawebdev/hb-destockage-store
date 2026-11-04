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
