#!/usr/bin/env bash
# CART-5: the cart-off storefront end to end (ledger C-6..C-9, C-11). Builds the site from the seed with
# settings.cartEnabled = false, seeds a local D1, starts the web Worker (its build step writes _headers) and the admin
# Worker on cart's ports, scans dist for cart traces, runs tests/e2e/cart-switch.spec.ts and the budget.
# Usage: [HB_CART_SKIP_BUILD=1] [HB_CART_SKIP_REPORTS=1] [HB_CART_AFTER=<cmd>] tests/e2e/cart-run.sh [out dir]   Heavy: wrap in scripts/lib/locks.sh heavy --. Fake values only.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
REPO="$PWD"
export TMPDIR="${TMPDIR:-/mnt/data/hb-tmp/cart}"
OUT="${1:-/mnt/data/ecom website/artifacts/CART-5/cart-off}"
mkdir -p "$OUT"
PERSIST="$TMPDIR/e2e-persist-cart-off"
SNAP="$TMPDIR/snapshot-cart-off.json"
WEB_PORT=4483; WEB_INSPECT=4484; ADMIN_PORT=4485; ADMIN_INSPECT=4486
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1793836800}"

if [[ "${HB_CART_SKIP_BUILD:-0}" == 1 ]]; then
  echo "== reusing apps/storefront/dist (HB_CART_SKIP_BUILD=1)"
else
  echo "== snapshot + build (cart off)"
  node tests/e2e/cart-snapshot.ts "$SNAP" off > "$OUT/snapshot.log" 2>&1
  # An export-file snapshot is a publish build: it needs a public https origin (pages use root-relative URLs, so the
  # local Worker serves it all the same).
  HB_SNAPSHOT="$SNAP" HB_SITE_ORIGIN="https://comptoirdeluxe.com" npm run build -w @hb/storefront > "$OUT/build.log" 2>&1
  grep -E "cart off:|minified\)|violation" "$OUT/build.log" > "$OUT/build-cart-lines.txt" || true
fi

echo "== seed"
rm -rf "$PERSIST"; mkdir -p "$PERSIST"
node packages/db/src/seed/cli.ts --persist-to "$PERSIST" --no-photos > "$OUT/seed.log" 2>&1

echo "== workers"
(cd apps/web && exec "$REPO/node_modules/.bin/wrangler" dev --env= --ip 127.0.0.1 --port "$WEB_PORT" --inspector-port "$WEB_INSPECT" --persist-to "$PERSIST" --show-interactive-dev-session=false \
  --var ENV:development --var SITE_HOSTS:localhost,127.0.0.1 --var ORDER_SIGNING_KEY:e2e-signing-key-1234567890 --var IP_HASH_KEY:e2e-ip-hash-key-1234567890 --var TURNSTILE_SECRET:1x0000000000000000000000000000000AA) > "$OUT/web.log" 2>&1 &
WEB=$!
trap 'kill $WEB ${ADMIN:-} 2>/dev/null || true; wait $WEB ${ADMIN:-} 2>/dev/null || true' EXIT
# One Worker at a time: two opening the same fresh SQLite file at once fail with SQLITE_BUSY.
for _ in $(seq 1 180); do curl -fsS "http://127.0.0.1:$WEB_PORT/api/health" > /dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:$WEB_PORT/api/health" > /dev/null
(cd apps/admin && exec "$REPO/node_modules/.bin/wrangler" dev --ip 127.0.0.1 --port "$ADMIN_PORT" --inspector-port "$ADMIN_INSPECT" --local-upstream "127.0.0.1:$ADMIN_PORT" --persist-to "$PERSIST" --show-interactive-dev-session=false \
  --var ENV:development --var CSRF_SECRET:e2e-only-csrf-secret-0123456789abcdef0123456789 --var DEV_SESSION_SECRET:e2e-only-dev-session-secret-0123456789abcdef) > "$OUT/admin.log" 2>&1 &
ADMIN=$!
for _ in $(seq 1 180); do curl -fsS -o /dev/null "http://127.0.0.1:$ADMIN_PORT/__dev/login" 2>/dev/null && break; sleep 1; done
curl -fsS -o /dev/null "http://127.0.0.1:$ADMIN_PORT/__dev/login"

echo "== cart-off scan (C-8, C-9): dist incl. the generated _headers"
cp apps/storefront/dist/_headers "$OUT/_headers"
set +e
node apps/storefront/scripts/cart-off-check.mjs apps/storefront/dist > "$OUT/cart-off-scan.log" 2>&1; SCAN=$?
(cd apps/storefront/dist && find . -type f | sort) > "$OUT/dist-files.txt"
grep -rIlE 'cart\.js|cart-sheet\.js|/cart/|/checkout/|data-cart-|hd-cart|cat-add-cart' apps/storefront/dist > "$OUT/grep-cart-refs.txt"; GREP=$?
grep -c 'class="cat-card-buy"' -r apps/storefront/dist --include=index.html | grep -v ':0$' > "$OUT/buy-links-per-page.txt"

echo "== specs"
HB_CART_E2E=off HB_E2E_WEB_URL="http://127.0.0.1:$WEB_PORT" HB_E2E_ADMIN_URL="http://127.0.0.1:$ADMIN_PORT" HB_E2E_PERSIST="$PERSIST" HB_E2E_OUT="$OUT" \
  npx vitest run --config tests/e2e/vitest.config.ts --reporter=default cart-switch > "$OUT/specs.log" 2>&1; SPECS=$?

AXE=0; BUDGET=0
if [[ "${HB_CART_SKIP_REPORTS:-0}" != 1 ]]; then
echo "== axe (home, category, search templates, ar+fr, 360/768/1440)"
npm run axe -- --base-url "http://127.0.0.1:$WEB_PORT" --template home --template category --template search --out "$OUT/axe" > "$OUT/axe.log" 2>&1; AXE=$?

echo "== budget (report only)"
npm run budget -- --dist apps/storefront/dist --out "$OUT/budget" > "$OUT/budget.log" 2>&1; BUDGET=$?
fi
# HB_CART_AFTER: a command to run while the Workers are still up (e.g. a live-check script against the local build).
if [[ -n "${HB_CART_AFTER:-}" ]]; then echo "== after: $HB_CART_AFTER"; bash -c "$HB_CART_AFTER" > "$OUT/after.log" 2>&1; echo "after exit $?"; fi
set -e
grep -E "Test Files|Tests  |FAIL" "$OUT/specs.log" || true
echo "scan=$SCAN grep-matches=$([[ $GREP == 1 ]] && echo none || echo FOUND) specs=$SPECS axe=$AXE budget=$BUDGET"
exit $(( SCAN || (GREP == 0) || SPECS || AXE ))
