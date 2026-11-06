# Edge operations for the storefront Worker (`hb-web`) — WEB-6

Documented configuration only. Nothing here is applied from this repo: no Cloudflare login and no deploy
(CLAUDE.md non-goals). The client's engineer applies these in the client's account. Sources:
STACK-REPORT.md §6 and §7 (risks 7 and 8), research-evidence/team-reports/research_admin_security.md rows 20–24,
challenge_trust_ops.md D5. Plan: artifacts/WEB-0/plan.md §3.

## 1. Order of defences (cheapest first)

| Layer | Where | On trigger |
|---|---|---|
| WAF rate-limit rule (below) | Cloudflare edge, before the Worker | block 10 s, per IP, high threshold: flood guard only |
| Honeypot + minimum fill time | Worker | flag; sink only when both fire |
| Exact DZ mobile validation | Worker (`@hb/shared`) | 422 |
| Idempotency (same key) | Worker + D1 | the original order (201) |
| Dedup: same phone + variant within 30 min | Worker + D1 | existing order returned **only** for a genuine double submit (same name, wilaya and commune too); otherwise a new order flagged `duplicate`, never another order's ref or totals |
| Rate limit **by phone** (`ORDER_RL_PHONE`, 5 / 60 s) | Worker binding | 429 + Retry-After |
| Rate limit by IP (`ORDER_RL_IP`, 30 / 60 s) | Worker binding | flag only, never reject (CGNAT) |
| Turnstile (lazy, invisible) | Worker siteverify | missing / invalid ⇒ accept and flag |
| Confirmation phone call | admin | the real filter |

## 2. The one WAF rate-limiting rule

File: [`waf-rate-limit-rule.json`](waf-rate-limit-rule.json).
- Expression: **path only**, `(http.request.uri.path eq "/api/order") or (http.request.uri.path eq "/api/quote")`.
  Quote shares the one D1 database with orders (rev-d, WEB-2 r1). There is no method condition: on the Free
  plan, rate-limiting expressions may use only *Path* and *Verified Bot*. Method needs Business or above
  ([Cloudflare: Rate limiting rules, Availability](https://developers.cloudflare.com/waf/rate-limiting-rules/#availability)).
  Both endpoints answer only POST (other methods get 405 from the Worker), so nothing is lost.
- Threshold: **30 requests per 10 s per IP**, then block for 10 s. A real shopper sends 1 order and a few
  quotes. The threshold is high on purpose: Algerian mobile carriers put many users behind one IP (CGNAT,
  [Cloudflare, Oct 2025](https://blog.cloudflare.com/detecting-cgn-to-reduce-collateral-damage/)).
  Never lower it to catch individual spammers; the per-phone binding does that.
- Free plan: 1 rule, path and verified-bot fields only, IP counting, 10 s period, 10 s timeout. This rule fits
  inside those limits (same page). On Pro and above, keep the same rule; don't add an IP-only rule with a lower
  threshold.
- `characteristics` must include `cf.colo.id` (required by the API for IP counting). Counting is per data center.
- **Do not add `/api/rum` to this rule.** The rule has one counter per IP across every path it matches. Page-view
  beacons from a busy CGNAT address would then use up that address's budget and block its real orders. RUM has
  its own Worker binding (`RUM_RL_IP`, below), which only drops beacons.
- Watch **Security → Events** for this rule in the first weeks. If real shoppers appear there, raise the threshold.

## 3. Bot and challenge settings: no challenge on the order path

- **Bot Fight Mode: OFF.** It injects JavaScript into every HTML page (breaks the hash CSP and the 0 KB JS
  budget) and "cannot be bypassed or skipped using WAF custom rules"
  ([docs](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/)). During research, Cloudflare
  challenged our Djezzy IP after ~300 scripted requests. A challenge on a form POST makes a real order fail
  silently (STACK-REPORT §7 risk 8).
- **Super Bot Fight Mode** (Pro+): if enabled, set "Definitely automated" and "Likely automated" to *Allow*
  for `/api/*`, or leave it off.
- **No managed challenge, JS challenge or interactive challenge** in any WAF custom rule that matches
  `/api/*` or the storefront HTML.
- **Browser Integrity Check: off for `/api/*`** (Configuration Rule: `starts_with(http.request.uri.path, "/api/")`
  → Browser Integrity Check Off). Basic HTTP clients on shared IPs must not get a 403 on the order POST.
- **Security Level** for `/api/*`: *Essentially Off* (Configuration Rule), so IP reputation never challenges
  an order.
- Turnstile is the only challenge. It loads only after the shopper touches the form, and its failure only
  flags the order.

## 4. Workers Rate Limiting bindings (in `wrangler.jsonc`)

| Binding | namespace_id | Limit | Key | Action |
|---|---|---|---|---|
| `ORDER_RL_PHONE` | 1001 | 5 per 60 s | E.164 phone (`+2135…`) after normalisation | 429 `rate_limited`, `Retry-After: 60` |
| `ORDER_RL_IP` | 1002 | 30 per 60 s | IPv4 address or IPv6 /64 | flag `rate_limited` (never reject) |
| `RUM_RL_IP` | 1003 | 60 per 60 s | IPv4 address or IPv6 /64 | RUM beacon dropped (still 204); orders unaffected |

- Idempotent replays are answered before either limit is consulted, so a retry never counts.
- The binding is approximate and counted per Cloudflare location
  ([docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)). Period must be 10 or 60 s.
- `namespace_id` values must be unique per account; change them if they collide with another Worker.

## 5. Bindings and secrets to create before a real deploy

- D1: `wrangler d1 create hb-destockage --location weur`. Put the returned id in `wrangler.jsonc`, then
  apply the migrations: `wrangler d1 migrations apply hb-destockage --remote`.
- Queue: `hb-order-notifications` (consumer and DLQ: `apps/jobs`).
- Vars: `ENV=production` is already the top level of `wrangler.jsonc`. Placeholder (invented, seeded)
  delivery fees are served only when ENV is exactly `development`, which only the dev script sets.
- **`SITE_HOSTS` — required, [PLACEHOLDER] for the client's storefront domain(s)**, e.g.
  `wrangler deploy --var SITE_HOSTS:<shop domain>,www.<shop domain>` or a dashboard variable. It is the
  list of hostnames a Turnstile verdict must come from. It is deliberately absent from the repo. Missing,
  not a hostname list, or containing localhost / 127.0.0.1 ⇒ every `/api/*` answers 500 and the logs show
  `config_invalid` (the Worker fails closed instead of flagging every order `turnstile_invalid`).
- Secrets (`wrangler secret put …`, never in the repo):
  - `TURNSTILE_SECRET`: the Turnstile widget secret. Missing ⇒ every token verifies as `error` (flagged).
  - `ORDER_SIGNING_KEY`: ≥ 32 random bytes; signs the no-JS review token. Rotating it only flags in-flight
    reviews as `fill_time_missing`.
  - `IP_HASH_KEY`: ≥ 32 random bytes; salts `orders.ip_hash`. Rotating it breaks the "same IP as order X"
    link for older orders only.

## 6. Things only a real deployment can confirm

- That `_headers` rules (CSP etc.) are kept on responses the Worker passes through from `env.ASSETS`
  (confirmation page, no-JS review). Verified in local workerd (test/csp.workerd.test.ts); re-check once with
  `wrangler deploy --temporary` (rev-d's WEB-1 note).
- The WAF rule's effect on real CGNAT traffic (Security Events) and the Turnstile solve rate. RUM and the order
  log will show them.

## 7. Bundle size

`npm run build -w @hb/web` (= `wrangler deploy --dry-run --env=""`, the production top level).
Measured at abfc3f6 (wrangler 4.157.0, minify on): **170.55 KiB upload / 51.60 KiB gzip** (index.js
174,645 B minified, 52,523 B gzip -9). This covers Hono, Valibot, Drizzle, the schema, `@hb/shared` and the order
pipeline. It is far below the 64 MiB Worker limit (no compressed limit; research_backend.md row 1), and startup
stays in the 1–2 ms range measured for this stack. The same run shows the shipped bindings and `env.ENV ("production")`
with no `SITE_HOSTS`. Full output: `artifacts/WEB-6/bundle.txt`.

Pages are static assets: their bytes and CSP are budgeted by the storefront gates and WEB-4, not by this
bundle.
