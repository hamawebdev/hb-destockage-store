#!/usr/bin/env bash
# Runs the Meta end-to-end specs against a real build, Worker and local D1 (META-8; contract §10–§11).
# Usage: tests/e2e/meta-run.sh <unconfigured|configured|consent-off>   (run unconfigured first: its
# _headers is the control the configured run compares against)
# MSET-6: every Meta value is entered through the admin's /meta screen (tests/e2e/meta-admin.ts), exported
# like a publish (tests/e2e/meta-export.ts) and read by the build from the snapshot and by the Worker
# from D1. No Meta environment variable exists. "unconfigured" = everything entered, then the Pixel ID
# removed (token still stored). Fake values only. The Worker runs with ENV=development, so it can only
# send to the loopback stand-in. Heavy: wrap in scripts/lib/locks.sh heavy --.
set -euo pipefail
MODE="${1:?usage: meta-run.sh unconfigured|configured|consent-off}"
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
REPO="$PWD"
export TMPDIR="${TMPDIR:-/mnt/data/hb-tmp/meta}"
ARTIFACTS="${HB_META_ARTIFACTS:-/mnt/data/ecom website/artifacts/MSET-6/e2e}"
OUT="$ARTIFACTS/$MODE"
rm -rf "$OUT"; mkdir -p "$OUT"
PERSIST="${TMPDIR}/e2e-persist-$MODE"
# meta's port block (scripts/team/port.sh meta): 4490-4499.
ADMIN_PORT=4490
ADMIN_INSPECT=4491
WEB_PORT=4492
INSPECT_PORT=4493
export HB_META_STANDIN_PORT=4494
export HB_META_CLOSED_PORT=4499
STANDIN_PORT=$HB_META_STANDIN_PORT
# Fake values, entered in the admin only (MSET-6, D-017). The token carries a random sentinel so the
# leak greps below, and a git grep of every revision, can only match a real leak.
export HB_META_E2E_PIXEL=100000000000001
export HB_META_E2E_TOKEN="FAKE_TEST_TOKEN_$(openssl rand -hex 16)"
export HB_META_E2E_TEST_CODE=TEST_E2E_4242
FAKE_PIXEL=$HB_META_E2E_PIXEL
FAKE_TOKEN=$HB_META_E2E_TOKEN
SETTINGS_KEY="$(openssl rand -base64 32)"
printf '%s\n' "$FAKE_TOKEN" > "$OUT/sentinel-token.txt"

# No Meta value may come from the environment: record that none is set, and unset any that is.
for v in META_PIXEL_ID META_ACCESS_TOKEN META_TEST_EVENT_CODE META_CONSENT_REQUIRED META_GRAPH_BASE; do unset "$v"; done
{ echo "META_* variables in this run's environment:"; env | grep -c '^META_' || true; } > "$OUT/env-check.txt"

echo "== seed"
rm -rf "$PERSIST"; mkdir -p "$PERSIST"
HB_E2E_PERSIST="$PERSIST" node packages/db/src/seed/cli.ts --persist-to "$PERSIST" --no-photos > "$OUT/seed.log" 2>&1

echo "== admin: the owner enters the Meta settings on /meta"
(cd apps/admin && exec "$REPO/node_modules/.bin/wrangler" dev --ip 127.0.0.1 --port "$ADMIN_PORT" --inspector-port "$ADMIN_INSPECT" --local-upstream "127.0.0.1:$ADMIN_PORT" --persist-to "$PERSIST" --show-interactive-dev-session=false \
  --var ENV:development --var CSRF_SECRET:e2e-csrf-secret-0123456789abcdef0123456789 --var DEV_SESSION_SECRET:e2e-session-secret-0123456789abcdef0123456789 --var "SETTINGS_ENCRYPTION_KEY:$SETTINGS_KEY") > "$OUT/admin.log" 2>&1 &
ADMIN=$!
WORKER=
trap 'kill $ADMIN $WORKER 2>/dev/null || true; wait $ADMIN $WORKER 2>/dev/null || true' EXIT
for _ in $(seq 1 120); do
  curl -fsS -o /dev/null "http://127.0.0.1:$ADMIN_PORT/__dev/login" 2>/dev/null && break
  sleep 1
done
# Optional (MSET-2 evidence): browser screenshots of /meta, before the run's own values are entered.
if [[ -n "${HB_META_SHOTS:-}" ]]; then
  echo "== admin screenshots"
  mkdir -p "$HB_META_SHOTS"
  node "$HB_META_SHOTS/../shots.mjs" "http://127.0.0.1:$ADMIN_PORT" "$REPO" "$HB_META_SHOTS" > "$HB_META_SHOTS/shots.log" 2>&1 || echo "FAIL: screenshots (see $HB_META_SHOTS/shots.log)"
fi

case "$MODE" in
  # "Removed": everything is entered, then the Pixel ID is removed. The token and test code stay stored.
  unconfigured) steps=(pixel token test-code remove-pixel) ;;
  configured) steps=(pixel token test-code) ;;
  consent-off) steps=(pixel-consent-off token test-code) ;;
  *) echo "unknown mode $MODE" >&2; exit 2 ;;
esac
node tests/e2e/meta-admin.ts "http://127.0.0.1:$ADMIN_PORT" "$OUT/admin-responses" "${steps[@]}" > "$OUT/admin-steps.log" 2>&1
echo "== publish export (D1 -> snapshot) and build ($MODE)"
node tests/e2e/meta-export.ts "$PERSIST" "$OUT" > "$OUT/export.log" 2>&1
kill $ADMIN 2>/dev/null || true; wait $ADMIN 2>/dev/null || true
# A snapshot file makes this a publish build (isPublishBuild), which needs the public https origin; the
# pages are still served by the local Worker below (every asset and /api path is same-origin relative).
env HB_SNAPSHOT="$OUT/snapshot.json" HB_SITE_ORIGIN=https://comptoirdeluxe.com npm run build -w @hb/storefront > "$OUT/build.log" 2>&1

echo "== worker"
# The stand-in URL and the key are set in every mode: with the Pixel ID removed, a stored token and a
# reachable stand-in must still produce no server event.
worker_vars=(--var ENV:development --var SITE_HOSTS:localhost,127.0.0.1 --var ORDER_SIGNING_KEY:e2e-signing-key-1234567890 --var IP_HASH_KEY:e2e-ip-hash-key-1234567890 --var TURNSTILE_SECRET:1x0000000000000000000000000000000AA
  --var "SETTINGS_ENCRYPTION_KEY:$SETTINGS_KEY" --var "CAPI_STANDIN_URL:http://127.0.0.1:$STANDIN_PORT")
(cd apps/web && exec "$REPO/node_modules/.bin/wrangler" dev --env= --ip 127.0.0.1 --port "$WEB_PORT" --inspector-port "$INSPECT_PORT" --persist-to "$PERSIST" --show-interactive-dev-session=false "${worker_vars[@]}") > "$OUT/worker.log" 2>&1 &
WORKER=$!
for _ in $(seq 1 120); do
  curl -fsS "http://127.0.0.1:$WEB_PORT/api/health" > /dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$WEB_PORT/api/health" > /dev/null

echo "== specs"
cp apps/storefront/dist/_headers "$OUT/_headers"
set +e
HB_META_E2E="$MODE" HB_META_ARTIFACTS="$ARTIFACTS" HB_E2E_WEB_URL="http://127.0.0.1:$WEB_PORT" HB_E2E_ADMIN_URL="http://127.0.0.1:$WEB_PORT" HB_E2E_PERSIST="$PERSIST" HB_E2E_OUT="$OUT" \
  npx vitest run --config tests/e2e/vitest.config.ts --reporter=default "${2:-meta-}" > "$OUT/specs.log" 2>&1
SPECS=$?
if [[ "$MODE" == configured ]]; then
  HB_E2E_WEB_URL="http://127.0.0.1:$WEB_PORT" HB_E2E_ADMIN_URL="http://127.0.0.1:$WEB_PORT" HB_E2E_PERSIST="$PERSIST" HB_E2E_OUT="$OUT" \
    npx vitest run --config tests/e2e/vitest.config.ts --reporter=default nojs >> "$OUT/specs.log" 2>&1
  NOJS=$?
else
  NOJS=0
fi
set -e

echo "== checks"
FAILS=0
# The token must never reach a Worker log, in any mode.
if grep -q "$FAKE_TOKEN" "$OUT/worker.log"; then echo "FAIL: token in worker log"; FAILS=1; fi
# Sentinel grep (M-12): the token entered in the admin appears in no page, admin response, log or snapshot.
{
  echo "sentinel: see sentinel-token.txt (random per run)"
  for target in apps/storefront/dist "$OUT/admin-responses" "$OUT/admin.log" "$OUT/worker.log" "$OUT/d1-export.json" "$OUT/snapshot.json" "$OUT/build.log" "$OUT/specs.log"; do
    if grep -rIlF "$FAKE_TOKEN" "$target" > /dev/null 2>&1; then echo "LEAK   $target"; FAILS=1; else echo "clean  $target"; fi
  done
  if grep -rIlE 'metaAccessTokenEnc|metaTestEventCode' "$OUT/d1-export.json" "$OUT/snapshot.json" apps/storefront/dist > /dev/null 2>&1; then echo "LEAK   server-only key name in snapshot or dist"; FAILS=1; else echo "clean  no server-only key in snapshot or dist"; fi
  if grep -rIlF "$HB_META_E2E_TEST_CODE" "$OUT/d1-export.json" "$OUT/snapshot.json" apps/storefront/dist > /dev/null 2>&1; then echo "LEAK   test code in snapshot or dist"; FAILS=1; else echo "clean  test code not in snapshot or dist"; fi
  if git grep -qF "$FAKE_TOKEN" $(git rev-list --all) -- . 2>/dev/null; then echo "LEAK   git (some revision)"; FAILS=1; else echo "clean  git grep over $(git rev-list --all | wc -l) revisions"; fi
} > "$OUT/sentinel-grep.txt"
cat "$OUT/sentinel-grep.txt"
if [[ "$MODE" == unconfigured ]]; then
  if [[ -e apps/storefront/dist/js/meta.js || -e apps/storefront/dist/js/meta-full.js ]]; then echo "FAIL: meta*.js in the dist with the Pixel ID removed"; FAILS=1; fi
  if grep -rIlE 'fbq|fbevents|connect\.facebook|hb\.meta|data-meta-|meta-full' apps/storefront/dist > "$OUT/dist-matches.txt"; then echo "FAIL: Meta strings in the unconfigured dist"; cat "$OUT/dist-matches.txt"; FAILS=1; fi
  if grep -rIlE "$FAKE_PIXEL|$FAKE_TOKEN" apps/storefront/dist > "$OUT/fake-matches.txt"; then echo "FAIL: fake values in dist"; FAILS=1; fi
  BUNDLE="$TMPDIR/meta-bundle-$$"; rm -rf "$BUNDLE"
  (cd apps/web && "$REPO/node_modules/.bin/wrangler" deploy --dry-run --env= --outdir "$BUNDLE") > "$OUT/bundle.log" 2>&1
  if grep -rIlE "$FAKE_PIXEL|$FAKE_TOKEN|127\.0\.0\.1:$STANDIN_PORT" "$BUNDLE" > "$OUT/bundle-matches.txt"; then echo "FAIL: fake value or stand-in port in the Worker bundle"; FAILS=1; fi
  rm -rf "$BUNDLE"
fi
grep -E "Test Files|Tests  |FAIL" "$OUT/specs.log" || true
echo "specs=$SPECS nojs=$NOJS checks=$FAILS"
exit $(( SPECS || NOJS || FAILS ))
