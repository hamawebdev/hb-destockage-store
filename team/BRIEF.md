# Team brief — HB Destockage build

Owner: lead. Teammates read this in full before starting. It overrides the "How work happens"
section of CLAUDE.md until the tooling change (TOOL-1) rewrites that section.
Spec = STACK-REPORT.md. Rules and budgets = CLAUDE.md. Review = REVIEW.md (written in TOOL-1).

## 1. What we are building

A cash-on-delivery store for HB Destockage that sells **any kind of product**: categories and
sub-categories, variants (size, colour, other), multiple photos, stock, and packs. Arabic (`/ar/`,
RTL, primary) and French (`/fr/`). Seed catalogue = the client's real products from
https://hbdestockagedz.com/ plus clearly marked placeholders in a few other categories.

Storefront templates (each in `/ar/` and `/fr/`): **home, category listing, search, product page
(with order form), order confirmation, content pages** (about, delivery, returns, contact, legal),
plus 404. Order form fields = current site: **name, phone, wilaya, commune, quantity** (+ variant
choice when the product has variants). It shows **product price, delivery fee and total before the
customer confirms**.

## 2. Architecture decisions the lead has made (binding)

- **Workspaces** (npm workspaces, one root lockfile): `apps/storefront`, `apps/web`, `apps/admin`,
  `apps/jobs`, `packages/db`, `packages/shared`, `packages/ui-tokens`, `packages/catalog`,
  `tools/measure`, plus `data/`, `brand/`, `scripts/`.
- **Dependencies:** `tooling` owns every `package.json` and `package-lock.json`. To add a dependency,
  message `tooling` with package, exact version, workspace and why. Do not run `npm install <pkg>`
  in your worktree and commit it. `npm ci` / `npm install` with no args is fine.
- **Build-time catalogue:** the storefront never talks to D1. `packages/catalog` turns a
  **catalogue snapshot** (JSON: from `data/` seed, or exported from D1 by the publish pipeline)
  into typed **page props** for each template, AVIF image variants, per-language search indexes and
  per-wilaya commune JSON. The storefront renders props to HTML. Contract: `packages/catalog/src/types.ts`.
- **Fees are swappable.** The storefront asks `POST /api/quote` `{items:[{variantId,qty}], wilaya,
  commune}` → `{subtotalDzd, feeDzd, totalDzd, available, feeSource}`. The Worker answers through a
  `FeeProvider` interface (`packages/shared/src/fees.ts`). Today's implementation reads the
  admin-set fee per wilaya from D1; a courier-API provider replaces it later without touching the
  storefront or the order flow. `/api/order` recomputes everything server-side and never trusts a
  client total. (Deviation from "D1 only on order POST": recorded in DECISIONS.md as D-002 by tooling. D-001 = courier wilaya codes move to the courier integration. Later entries take the next free number.)
- **Every product has ≥ 1 variant.** A simple product has one default variant. Order lines always
  reference `variantId`. A pack is a product (`kind='pack'`) with its own variant/price/stock and a
  list of contained variants (`pack_items`) shown on the page.
- **Stock** is decremented atomically when the order is created (`UPDATE … WHERE stock >= qty`),
  restored on `cancelled` / `returned`. `stock = NULL` means untracked.
- **Order states** (shared state machine): `new → called(attempt n) → confirmed | unreachable |
  cancelled`; `confirmed → shipped → delivered | returned`; `unreachable → called` allowed;
  `cancelled` terminal. Each transition lists the roles allowed to make it.
- **Admin roles:** `owner`, `confirmer`, `logistics`, `content`. Production auth = Cloudflare Access
  JWT (`Cf-Access-Jwt-Assertion`, verified against team certs + AUD) mapped to `admin_users` by email.
  Dev auth = local login, only when `ENV === "development"` and the request host is localhost.
  No auth ⇒ 401/403, never a page. **Audit log and order events are append-only, enforced in SQL
  (triggers that ABORT on UPDATE/DELETE).** Admin UI language: French and Arabic (per-user toggle),
  dictionary in `apps/admin/src/i18n/`.
- **Duplicate submit:** client sends an `idempotencyKey` (UUID made at form render); unique in D1;
  a repeat returns the original order (same ref, HTTP 200). Separate dedup: same phone + variant
  within 30 min ⇒ return existing order, flagged `duplicate`.
- **No-JS path:** the order form works without JS (server review step rendered by the Worker,
  then confirm). With JS: live price/fee/total summary from `/api/quote`, then confirm.
- **Publish:** admin "Publish" → `publish_runs` row; `apps/jobs` publish script exports D1 → snapshot
  → `packages/catalog` → `astro build`. No deploy (non-goal); the script stops after build and prints
  the deploy command. Measure and record build time.
- **Notifications:** `/api/order` enqueues `order.created` on a Queue; `apps/jobs` consumes (Telegram
  and email providers present but disabled without secrets).
- **CSP:** hash-based, generated at build from the built HTML into the Workers static-assets
  `_headers` file (owner `web`). No nonces, no `unsafe-inline`.

## 3. Ownership (enforced at commit by `team/owners.json` + pre-commit hook)

| Teammate | Owns (write access) | Reviewer |
|---|---|---|
| `tooling` | `package.json`, `package-lock.json`, `**/package.json`, `tsconfig*.json` (root + workspaces), `.githooks/`, `scripts/`, `.claude/settings.json`, `.claude/agents/`, `team/owners.json`, `CLAUDE.md`, `REVIEW.md`, `DECISIONS.md` (create + structure; anyone may append an entry via their own commit — see §6), `.gitignore`, `.nvmrc`, `vitest.workspace.*` | `rev-a` |
| `measure` | `tools/measure/`, `tests/e2e/` | `rev-a` |
| `jobs` | `apps/jobs/` (except package.json) | `rev-a` |
| `brand` | `brand/`, `data/content/` (content-page copy) | `rev-b` |
| `tokens` | `packages/ui-tokens/` | `rev-b` |
| `shell` | `apps/storefront/` **except** the paths owned by `pages` and `orderform` | `rev-b` |
| `geo` | `data/geo/` | `rev-c` |
| `seed` | `data/catalog/`, `data/photos/` | `rev-c` |
| `pagedata` | `packages/catalog/` | `rev-c` |
| `db` | `packages/db/` | `rev-d` |
| `shared` | `packages/shared/` | `rev-d` |
| `web` | `apps/web/` | `rev-d` |
| `pages` | `apps/storefront/src/pages/{ar,fr}/{c,p,search}/**`, `apps/storefront/src/components/catalog/**`, `apps/storefront/public/js/search*.js`, `apps/storefront/public/js/variant*.js` | `rev-e` |
| `orderform` | `apps/storefront/src/components/order/**`, `apps/storefront/src/pages/{ar,fr}/order/**` (confirmation), `apps/storefront/public/js/order*.js` | `rev-e` |
| `admin-core` | `apps/admin/src/{app.ts,index.ts,env.ts}`, `apps/admin/src/{auth,audit,ui,i18n,lib}/**`, `apps/admin/src/routes/{dashboard,users,settings}/**`, `apps/admin/wrangler.jsonc`, `apps/admin/public/**`, `apps/admin/test/**` except `test/{orders,catalog}/**`, `apps/admin/.dev.vars.example`, all other top-level files in `apps/admin/` | `rev-f` |
| `admin-orders` | `apps/admin/src/routes/{orders,customers}/**`, `apps/admin/test/orders/**` | `rev-f` |
| `admin-catalog` | `apps/admin/src/routes/{products,categories,fees,content,media,publish}/**`, `apps/admin/test/catalog/**` | `rev-f` |
| `qa` | nothing in source; writes `artifacts/QA-*/` and files tasks | — |
| reviewers `rev-a`…`rev-f` | nothing in source; write `artifacts/<ID>/review-r<n>.md` | — |
| `lead` | `team/BRIEF.md`; merges to `main` | — |

Every area may add its own tests inside its own paths. Files outside your paths: ask the owner.
Second-confirmation pairs for Important findings: `rev-a↔rev-b`, `rev-c↔rev-d`, `rev-e↔rev-f`.

## 4. Contracts (land first, everything else builds against them)

Contract tasks: **DB-1, SHARED-1, TOKENS-1, CAT-1, ADMIN-1, SHELL-1**. Each is small, typed, tested,
and reviewed before the fan-out depends on it. Until a contract is on `main`, build against the
contract branch's latest commit and tell its owner what you need.

**DB-1 `packages/db/src/schema.ts` (Drizzle, D1/SQLite).** Tables (all money = integer DZD; all
content bilingual `*_fr`/`*_ar`; timestamps integer ms):
`categories` (tree via `parent_id`, per-language slugs, sort, active, placeholder) ·
`products` (kind simple|variable|pack, category_id, slugs fr/ar, names, `brand_latin`, summary,
description, status draft|active|archived, placeholder) · `product_options` (size|colour|other,
names, position) · `option_values` (values fr/ar, `swatch_hex`, position) · `variants` (sku unique,
price_dzd, compare_at_dzd, stock nullable, weight_g, active, is_default) · `variant_option_values` ·
`pack_items` (pack_product_id, variant_id, qty) · `images` (product_id, variant_id nullable,
r2_key, width, height, alt fr/ar, position, placeholder) · `wilayas` (code 1–69 PK, names,
`courier_code` nullable — filled by the future courier integration) · `communes` (id, wilaya_code,
names, postal_code) · `delivery_fees` (wilaya_code PK, fee_dzd, available, updated_by, updated_at) ·
`customers` (phone_e164 unique, name, counts, flags, blocked, notes) · `orders` (ref unique like
`HB-7K2Q9`, idempotency_key unique, customer_id, name, phone_e164, wilaya_code, commune_id, lang,
status, call_attempts, subtotal/fee/total, fee_source, flags JSON, risk fields, ip_hash, created/
updated) · `order_items` (variant_id, product_id, name/sku snapshots, unit_price, qty, line_total) ·
`order_events` (append-only: status_change | call_attempt | note; outcome; actor; at) ·
`content_pages` · `settings` (key/value JSON) · `admin_users` (email unique, role, active) ·
`audit_log` (append-only: actor, action, entity, entity_id, before/after JSON, at) · `publish_runs` ·
`rum_events`. Exports inferred types. Migrations in `packages/db/migrations/`. A seed command loads
`data/` into local D1.

**SHARED-1 `packages/shared/src/`.** `lang.ts` (`Lang`, `Localized<T>`), `phone.ts`
(`normalizePhone` — Eastern-Arabic → ASCII digits, accepts `0…`, `+213…`, `213…`; Algerian mobile
pattern from CLAUDE.md; returns `{ok, e164, national}`), `money.ts` (`computeTotals`, integer only),
`order-schema.ts` (Valibot `OrderInput`, `QuoteInput`, result types, error codes), `fees.ts`
(`FeeProvider`, `FeeQuoteRequest`, `FeeQuote`), `order-state.ts` (statuses, transitions, roles per
transition, `canTransition`), `format.ts` (`Intl` `ar-DZ`/`fr-DZ` price + date). Zero runtime deps
except Valibot. Usable in Workers, Node and the browser (tree-shakeable; the order-form JS imports
only what it needs).

**TOKENS-1 `packages/ui-tokens/`.** `tokens.css` (CSS custom properties: colour, type scale for
Latin and Arabic, spacing, radius, motion, z-index, breakpoints) with values from `brand`'s
palette decision; `icons/` (SVG, `currentColor`, mirrored flag for directional ones); the Noto Sans
Arabic 400 subset (`.woff2`) + its `@font-face`; a TS export of the same tokens for the admin.

**CAT-1 `packages/catalog/src/types.ts`.** `CatalogSnapshot` (what seed/D1 export produce) and the
props each template receives: `LayoutProps` (lang, dir, alternate URLs, nav categories, contact),
`HomeProps`, `CategoryProps` (category, breadcrumbs, sub-categories, product cards, pagination),
`ProductProps` (product, variants + option matrix, images with srcset, pack contents, price,
stock state, related), `SearchProps`, `ContentProps`, `OrderConfirmationProps`. Plus the route map
(per-language slugs → URL) and image `srcset` descriptor type.

**ADMIN-1** admin app skeleton: Hono app, env/bindings type, auth middleware interface
(`requireRole`), audit helper signature, layout + form/table UI kit, router mounting so
`admin-orders` and `admin-catalog` each export a Hono router from their own folder.

**SHELL-1** storefront skeleton: Astro static config, base layout consuming `LayoutProps`, CSS
pipeline (one inlined sheet both directions), route map wired to `packages/catalog`, empty pages
for every template so `pages` and `orderform` drop components into a running site.

## 5. Areas and tasks

Task IDs are `<AREA>-<n>`. `-0` tasks are plans (artifact only). **(H)** = high risk: plan first
(write `artifacts/<ID>/plan.md`, message the lead (`team-lead`), wait for OK), then after reviewer approval the lead
takes it to the client for sign-off. Each builder's list is in its spawn prompt and in the shared
task list. A task too big for one reviewable commit: split it (tell the lead (`team-lead`)).

## 6. Workflow

1. **Worktree.** You work only in `/mnt/data/ecom website/.worktrees/<your-name>` on branch
   `team/<your-name>` (lead creates it). Your shell starts in the main checkout: **every Bash call
   starts with `cd "/mnt/data/ecom website/.worktrees/<name>" &&`**, and every Edit/Write path is
   absolute inside your worktree. Never edit the main checkout.
2. **Claim** your next task in the shared list (TaskUpdate owner=you, in_progress).
3. **Implement** within your owned paths. Use subagents for independent pieces. Run
   `scripts/gate.sh` before asking for review.
4. **Commit**: one commit per task (squash your WIP with `git reset --soft` before committing).
   Format, enforced by `commit-msg`:
   ```
   <ID>: <title>

   What changed: …
   Testing: …
   Risk tier: low|high
   Revert: …

   Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
   ```
   Review fixes are new commits `<ID>: address review r<n>`. Never rewrite a commit that is under
   review or approved. To pick up upstream work: `git merge main` (no rebase).
5. **Ask for review**: TaskCreate `REV <ID> r<n> @<short-sha>` (owner = your reviewer, description =
   intent, risk tier, sha range, how to exercise it), then message your reviewer. Keep working on
   your next task meanwhile.
6. **Reviewer** follows REVIEW.md, writes `artifacts/<ID>/review-r<n>.md` (starts with a findings
   count and `Verdict: APPROVED` or `Verdict: CHANGES REQUESTED`), messages the author and `lead`.
7. **Complete** the build task (TaskUpdate completed) as soon as its commit exists and the gate is
   green — do not wait for review. The `TaskCompleted` hook runs `scripts/gate.sh` in your worktree
   and refuses while anything is red (it also fires when you go idle with a task in progress).
   Review state lives in the `REV …` tasks and `artifacts/<ID>/review-r<n>.md`.
8. **Merge**: only `lead` merges, with `scripts/team/merge.sh`, which refuses any commit without an
   `APPROVED` review covering it (and, for high risk, the client's sign-off in `team/SIGNOFFS.md`). High-risk commits wait for the client's
   sign-off; keep working on other tasks meanwhile.
9. **DECISIONS.md**: any deviation from STACK-REPORT.md gets an entry (`D-NNN`, what, why, evidence:
   measurement artifact path or cited source) **in the same commit** as the change. `DECISIONS.md`
   is append-only for everyone.
10. **Report** to `lead` with file paths, not summaries: `artifacts/<ID>/…`. Artifacts live in the
    main checkout at `/mnt/data/ecom website/artifacts/` (gitignored, shared by everyone).

## 7. Shared machine (8 cores, 19 GB RAM — 20+ agents)

- `scripts/gate.sh` holds a machine-wide semaphore (2 concurrent gates) and Lighthouse holds an
  exclusive lock, so scores are not distorted by other builds. Never run Lighthouse outside
  `npm run lh`. Do not leave dev servers running when you are idle.
- Ports: each teammate has a port block in `team/owners.json` (`portBase`, 10 ports). Read it with
  `scripts/team/port.sh <name>`; never use default ports (4321, 8787) in a shared worktree.
- Local Cloudflare only: `wrangler dev` / local D1 / local R2 / `wrangler deploy --dry-run`.
  No Cloudflare login, no real deploy.

## 8. Done (whole project)

See the lead's acceptance list: every budget and gate green on every template in both languages;
screenshots 360/768/1440 × ar/fr per template, visually reviewed; brand guide followed; a variant
order in each language shows the wilaya's fee and correct total, reaches the admin, survives a
duplicate submit, and moves to `shipped`; pickers list 69 wilayas and 1,541 communes in both
languages; admin refuses access without auth; tests/typecheck/build green from a clean checkout;
every change approved at its tier with no open Important finding.
