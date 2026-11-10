# Comptoir de Luxe storefront — project rules

Cash-on-delivery store for Comptoir de Luxe (Arabic كونتوار دو لوكس, formerly HB Destockage, on comptoirdeluxe.com), customers in Algeria. It sells **any kind of product**: categories and sub-categories, variants (size, colour…), multiple photos, stock, packs.
Arabic (`/ar/`, RTL, primary) and French (`/fr/`). Hosted on Cloudflare. **The spec is [STACK-REPORT.md](STACK-REPORT.md).**
Any deviation from it needs a measurement or a cited source, recorded in [DECISIONS.md](DECISIONS.md) before the change is reviewed.

## Stack (from the report, §2)
- `apps/storefront` — **Astro 7 static output**. Pre-rendered HTML per language. 0 KB JS before LCP; ≤ 10 KB br JS after LCP (order-form enhancement, plain JS). Speculation Rules inline, cross-document View Transitions, CSS-only motion.
- `apps/web` — **one TypeScript Worker (Hono)** serving the storefront's static assets (Workers static assets) plus `/api/order`, `/api/quote` and `/api/rum`. Valibot for validation, Drizzle for D1. Queues for order notifications.
- `apps/admin` — **custom server-rendered Hono Worker** on `admin.<domain>`, Cloudflare Access in production, local auth in development only. Drizzle + Valibot over the shared D1. Responses `private, no-store`.
- `apps/jobs` — scheduled Worker: daily D1 → R2 export.
- `packages/db` — Drizzle schema, D1 migrations, seed. `packages/shared` — phone rules, order schema, fee/total maths, `Intl` formatters, order state machine. `packages/ui-tokens` — brand tokens, icons, Arabic font.
- `data/` — geo dataset (69 wilayas / 1,541 communes), seed catalogue, original photos.
- `brand/` — brand guide, logo, copy (tone of voice, FR/AR strings).
- **One D1 database**, location hint `weur`. Never read while a visitor waits for a page: only on the order and quote POSTs and in the admin (D-002).
- **No Rust in the runtime. No React/Next/SPA. No i18n runtime. No analytics or chat widgets.**
- Versions measured in the report: Astro 7.4, Hono 4.13, Drizzle 0.45, Valibot 1.5, Tailwind 4.3, Wrangler 4.x, Lighthouse **13.6.0 (pinned)**.

## Storefront budgets (report-only since 2026-11-08, see D-004 — `npm run budget` and `npm run lh` run and report; they do not block)
- Lighthouse mobile (13.6.0, default simulated throttling) **Performance 100 and Accessibility 100**, median of 5, on every template in `/ar/` and `/fr/`. Zero axe violations.
- HTML document incl. inline CSS ≤ 14 KiB brotli (target ≈ 4–6 KiB). One stylesheet for both directions, inlined.
- Critical path (HTML + preloads + LCP image + font) **≤ 45 KiB in ≤ 4 requests**.
- LCP/hero AVIF ≤ 25 KB at every candidate width ≤ 960 w. AVIF generated at 360/480/720/960/1200 w with `srcset`, same origin.
- **No third-party origin before LCP.** Turnstile is injected only on the order form's first `focusin`/`pointerdown`. WhatsApp is a plain `https://wa.me/213779942022` link, never a widget.
- Fonts: French = system stack (`system-ui, -apple-system, "Segoe UI", Roboto, …`, 0 bytes). Arabic = **one static Noto Sans Arabic 400 subset** (~11.6 KiB), preloaded on `/ar/` only, `font-display: optional`, explicit unitless line-height (1.6–1.8). The «العربية» switch label on French pages uses a system font. Fallback rule: if deployed Speed Index ≥ 1.95 s, switch to the system Arabic font (record it in DECISIONS.md).

## Conventions
- Design from **360 px** up; check 768 and 1440. CSS **logical properties only** (`margin-inline-start`, `inset-inline-*`, `text-align: start`); `<html lang dir>`; directional icons mirror in RTL.
- Bidi: wrap phone numbers, Latin names, SKUs, order refs in `<bdi>` or `dir="ltr"`. Phone input `type="tel" inputmode="tel" dir="ltr"`. Server converts Eastern Arabic digits to ASCII.
- **No letter-spacing on Arabic.** `Intl` `ar-DZ` / `fr-DZ` for numbers/dates; prices are integer DZD.
- URLs: `/ar/…` and `/fr/…` with reciprocal hreflang + `x-default` (→ `/ar/`). **Never redirect on Accept-Language.**
- Every content field is bilingual (`*_fr`, `*_ar`), per-language slugs, a Latin brand-name field.
- WCAG 2.2 AA: tap targets ≥ 44 px, `scroll-padding` under sticky bars, contrast ≥ 4.5:1, `lang` on mixed-language spans, `prefers-reduced-motion`, no auto-advancing carousel, no cognitive CAPTCHA.
- Phone validation = libphonenumber Algerian mobile pattern: national `5(4[0-29]|6[0-4])\d{6}|(55|6\d|7[7-9])\d{7}`. Never `^0[567]\d{8}$`.
- Rate limits key on **phone**, IP only as a secondary key. Turnstile missing/invalid ⇒ **accept and flag**, never reject.
- Storefront: no cookies, no third-party scripts, hash-based CSP (no nonces).
- Contact: phone `0560417403`, WhatsApp `+213 779 942 022`.
- Clearly mark every placeholder (content, photo, translation) with `placeholder: true` in data and `[PLACEHOLDER]` in copy files.

## How work happens (detail: [team/BRIEF.md](team/BRIEF.md))
- Agent-team task list, subjects `<AREA>-<n>: …` (`-0` = plan). The lead (`team-lead`) creates and closes tasks and routes reviews and requests.
- One worktree + branch per teammate (`.worktrees/<name>`, `team/<name>`). Edit only your paths in `team/owners.json`, enforced by main's hooks (`git config core.hooksPath "/mnt/data/ecom website/.githooks"`, absolute). Dependencies: ask `tooling`.
- One commit per task (`commit-msg` enforces `<ID>: <title>`, blank, `What changed:`, `Testing:`, `Risk tier: low|high`, `Revert:`). Review fixes = new commits; `git merge main`, never rebase.
- A task is done when typecheck, tests and build pass. `scripts/gate.sh` runs in the `TaskCompleted` hook and fails only on typecheck, tests, build and the hook/disk safety checks; byte budget, Lighthouse, axe and tap targets run and report only.
- Review per [REVIEW.md](REVIEW.md): one pass, bugs and security only, and only for the order path, totals and fees, and admin login and roles (`team/REVIEW-REQUIRED.txt`). Only the lead merges (`scripts/team/merge.sh`); everything else merges once green. No client sign-off is needed except for deploying, which stays out of scope (see Non-goals).
- Outputs in `artifacts/<ID>/` (main checkout); report paths. Heavy jobs (build, vitest, wrangler dev, Chrome) via `scripts/lib/locks.sh heavy -- <cmd>` (3 slots; a gate holds one, max 2 gates); Lighthouse exclusive; ports: `scripts/team/port.sh <name>`.

## Non-goals
- Production deploys go only through the GitHub Actions pipeline (`.github/workflows/pipeline.yml`, how-to in `docs/DEPLOY.md`), under the client's sign-off of 2026-11-08 (D-007). Never run `wrangler deploy`, `wrangler d1 … --remote` or any other command that reaches the production account by hand, except the one-time first setup recorded in D-007. Never run seed data against production.
- No Law 18-05 hosting/.dz analysis (client accepted Cloudflare). No Rust, no CMS (Payload etc.), no SPA, no KV catalogue, no page rendering from D1.
- No SMS provider integration beyond a disabled stub (OTP only for flagged orders, later). Courier API integration, **including the 58-wilaya courier codes**, comes later (D-001).
