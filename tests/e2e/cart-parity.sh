#!/usr/bin/env bash
# CART-5 (ledger C-12): cart back on = today's build. Builds the baseline checkout and this checkout from the same
# seed snapshot with the same SOURCE_DATE_EPOCH and site origin, then diffs dist recursively (and the budget report).
# Usage: tests/e2e/cart-parity.sh <baseline checkout> [out dir]   (both checkouts need node_modules)
# Heavy: wrap in scripts/lib/locks.sh heavy --.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
TIP="$PWD"
BASE="${1:?usage: cart-parity.sh <baseline checkout> [out dir]}"
OUT="${2:-/mnt/data/ecom website/artifacts/CART-5/parity}"
export TMPDIR="${TMPDIR:-/mnt/data/hb-tmp/cart}"
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1793836800}"
mkdir -p "$OUT"
build() { # <checkout> <name>
  (cd "$1" && HB_SNAPSHOT=seed HB_SITE_ORIGIN=http://localhost:4483 npm run build -w @hb/storefront) > "$OUT/build-$2.log" 2>&1
  rm -rf "$OUT/dist-$2"; cp -a "$1/apps/storefront/dist" "$OUT/dist-$2"
  git -C "$1" rev-parse HEAD > "$OUT/sha-$2.txt"
}
echo "== baseline $(git -C "$BASE" rev-parse --short HEAD)"; build "$BASE" base
echo "== tip $(git -C "$TIP" rev-parse --short HEAD) (seed settings: cartEnabled true)"; build "$TIP" tip
set +e
diff -r "$OUT/dist-base" "$OUT/dist-tip" > "$OUT/dist.diff"; D=$?
diff -rq "$OUT/dist-base" "$OUT/dist-tip" > "$OUT/dist-files.diff"
npm run budget -- --dist "$OUT/dist-tip" --out "$OUT/budget-cart-on" > "$OUT/budget-cart-on.log" 2>&1
set -e
echo "files differing: $(wc -l < "$OUT/dist-files.diff")  (diff exit $D; full diff $OUT/dist.diff)"
cat "$OUT/dist-files.diff"
