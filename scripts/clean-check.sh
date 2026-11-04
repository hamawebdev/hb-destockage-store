#!/usr/bin/env bash
# scripts/clean-check.sh [ref] — prove a commit builds from a clean checkout.
# Clones the repo at <ref> (default HEAD) into a temp dir, then runs
# npm ci, typecheck, test, build. Stops at the first non-zero exit and exits non-zero.
# Log: <main checkout>/artifacts/TOOL-3/clean-check-<short-sha>.log
set -euo pipefail

ref="${1:-HEAD}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
common="$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)"
main_root="$(dirname "$common")"
sha="$(git -C "$here" rev-parse --verify "${ref}^{commit}")"
short="${sha:0:7}"
logdir="$main_root/artifacts/TOOL-3"
log="$logdir/clean-check-$short.log"
mkdir -p "$logdir"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/hb-clean-check.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

: >"$log"
say() { printf '%s\n' "$*" | tee -a "$log"; }

run_step() {
  local name="$1"; shift
  local t0=$SECONDS rc=0
  say "== $name: $*"
  "$@" >>"$log" 2>&1 || rc=$?
  if [[ $rc -ne 0 ]]; then
    say "RED   $name (exit $rc, $((SECONDS - t0))s)"
    say "clean-check: RED at $name for $short — log: $log"
    exit 1
  fi
  say "GREEN $name ($((SECONDS - t0))s)"
}

say "clean-check $sha ($(date -u +%FT%TZ)) node $(node -v) npm $(npm -v)"
run_step clone git clone --quiet --no-hardlinks "$main_root" "$tmp/repo"
cd "$tmp/repo"
run_step checkout git checkout --quiet --detach "$sha"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
run_step npm-ci npm ci --no-audit --no-fund --fetch-retries=6 --fetch-retry-mintimeout=5000
run_step typecheck npm run typecheck
run_step test npm test
run_step build npm run build
say "clean-check: GREEN $short — log: $log"
