#!/usr/bin/env bash
# Runs the Meta end-to-end specs against a real build, Worker and local D1 (META-8; contract §10–§11).
# Usage: tests/e2e/meta-run.sh <unconfigured|configured|consent-off>
# Fake values only, in this file and the specs. The Worker runs with ENV=development, so it can only send
# to the loopback stand-in. Heavy: wrap in scripts/lib/locks.sh heavy --.
set -euo pipefail
MODE="${1:?usage: meta-run.sh unconfigured|configured|consent-off}"
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
REPO="$PWD"
export TMPDIR="${TMPDIR:-/mnt/data/hb-tmp/growth}"
ARTIFACTS="/mnt/data/ecom website/artifacts/META-0/e2e"
OUT="$ARTIFACTS/$MODE"
mkdir -p "$OUT"
PERSIST="${TMPDIR}/e2e-persist-$MODE"
WEB_PORT=4351
INSPECT_PORT=4354
STANDIN_PORT=4352
FAKE_PIXEL=000000000000000
FAKE_TOKEN=FAKE_TEST_TOKEN

build_env=(HB_SNAPSHOT=seed "HB_SITE_ORIGIN=http://localhost:$WEB_PORT")
case "$MODE" in
  unconfigured) ;;
  configured) build_env+=("META_PIXEL_ID=$FAKE_PIXEL") ;;
  consent-off) build_env+=("META_PIXEL_ID=$FAKE_PIXEL" META_CONSENT_REQUIRED=0) ;;
  *) echo "unknown mode $MODE" >&2; exit 2 ;;
esac

echo "== build ($MODE)"
env "${build_env[@]}" npm run build -w @hb/storefront > "$OUT/build.log" 2>&1

echo "== seed"
rm -rf "$PERSIST"; mkdir -p "$PERSIST"
HB_E2E_PERSIST="$PERSIST" node packages/db/src/seed/cli.ts --persist-to "$PERSIST" --no-photos > "$OUT/seed.log" 2>&1

echo "== worker"
worker_vars=(--var ENV:development --var SITE_HOSTS:localhost,127.0.0.1 --var ORDER_SIGNING_KEY:e2e-signing-key-1234567890 --var IP_HASH_KEY:e2e-ip-hash-key-1234567890 --var TURNSTILE_SECRET:1x0000000000000000000000000000000AA)
if [[ "$MODE" != unconfigured ]]; then
  worker_vars+=(--var "META_PIXEL_ID:$FAKE_PIXEL" --var "META_ACCESS_TOKEN:$FAKE_TOKEN" --var "META_GRAPH_BASE:http://127.0.0.1:$STANDIN_PORT")
fi
(cd apps/web && exec "$REPO/node_modules/.bin/wrangler" dev --env= --ip 127.0.0.1 --port "$WEB_PORT" --inspector-port "$INSPECT_PORT" --persist-to "$PERSIST" --show-interactive-dev-session=false "${worker_vars[@]}") > "$OUT/worker.log" 2>&1 &
WORKER=$!
trap 'kill $WORKER 2>/dev/null || true; wait $WORKER 2>/dev/null || true' EXIT
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
if [[ "$MODE" == unconfigured ]]; then
  if grep -rIlE 'fbq|fbevents|connect\.facebook|hb\.meta' apps/storefront/dist > "$OUT/dist-matches.txt"; then echo "FAIL: Meta strings in the unconfigured dist"; cat "$OUT/dist-matches.txt"; FAILS=1; fi
  if grep -rIlE "$FAKE_PIXEL|$FAKE_TOKEN" apps/storefront/dist > "$OUT/fake-matches.txt"; then echo "FAIL: fake values in dist"; FAILS=1; fi
  BUNDLE="$TMPDIR/meta-bundle-$$"; rm -rf "$BUNDLE"
  (cd apps/web && "$REPO/node_modules/.bin/wrangler" deploy --dry-run --env= --outdir "$BUNDLE") > "$OUT/bundle.log" 2>&1
  if grep -rIlE "$FAKE_PIXEL|$FAKE_TOKEN|127\.0\.0\.1:$STANDIN_PORT" "$BUNDLE" > "$OUT/bundle-matches.txt"; then echo "FAIL: fake value or stand-in port in the Worker bundle"; FAILS=1; fi
  rm -rf "$BUNDLE"
fi
grep -E "Test Files|Tests  |FAIL" "$OUT/specs.log" || true
echo "specs=$SPECS nojs=$NOJS checks=$FAILS"
exit $(( SPECS || NOJS || FAILS ))
