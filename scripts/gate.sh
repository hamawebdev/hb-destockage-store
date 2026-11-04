#!/usr/bin/env bash
# scripts/gate.sh [worktree] [--full] [--base <ref>] [--no-cache]
#
# The single gate. Green = every step below exits 0:
#   npm ci            when node_modules is missing or package-lock.json changed since the last ci
#   npm run typecheck, npm test, npm run build
#   npm run budget    when apps/storefront/src/pages has a real (non-placeholder) page
#   npm run lh        when the diff vs <base> (default: merge-base with main) touches a
#                     storefront-affecting path, or with --full
# Once apps/storefront has real pages, a missing or stub ("not wired yet") budget/lh script is RED.
#
# Machine-wide: at most HB_GATE_SLOTS (2) gates run at once (scripts/lib/locks.sh); waits up to
# HB_GATE_WAIT seconds (3600) for a slot. A green run on a clean tree is cached by HEAD^{tree}.
# Log: <main checkout>/artifacts/gate/<branch>/<short-sha>[-dirty].log. Exit 0 green, 1 red, 2 usage.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/locks.sh
. "$here/lib/locks.sh"

wt="" full=0 base="" use_cache=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --full) full=1 ;;
    --base) base="${2:?--base needs a ref}"; shift ;;
    --no-cache) use_cache=0 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    -*) echo "gate: unknown option $1" >&2; exit 2 ;;
    *) [[ -z "$wt" ]] || { echo "gate: one worktree only" >&2; exit 2; }; wt="$1" ;;
  esac
  shift
done

wt="$(git -C "${wt:-$PWD}" rev-parse --show-toplevel)" || { echo "gate: not a git worktree: ${wt:-$PWD}" >&2; exit 2; }
cd "$wt"
main_root="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
branch="$(git symbolic-ref --short -q HEAD || echo detached)"
sha="$(git rev-parse HEAD)"
short="${sha:0:7}"
tree="$(git rev-parse 'HEAD^{tree}')"
clean=0
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] && clean=1

logdir="$main_root/artifacts/gate/${branch//\//_}"
mkdir -p "$logdir" "$main_root/artifacts/gate/cache"
log="$logdir/$short$([[ $clean -eq 1 ]] || echo -dirty).log"
: >"$log"

say() { printf '%s\n' "$*" | tee -a "$log"; }

# --- what this run must cover -------------------------------------------------------------
storefront_paths='^(apps/storefront/|apps/web/public/|packages/ui-tokens/|packages/catalog/|data/catalog/|data/photos/|data/content/|brand/)'

has_real_pages() {
  local d="apps/storefront/src/pages" f
  [[ -d "$d" ]] || return 1
  while IFS= read -r -d '' f; do
    head -n 3 "$f" | grep -q 'Placeholder (TOOL-2)' || return 0
  done < <(find "$d" -type f \( -name '*.astro' -o -name '*.md' -o -name '*.mdx' -o -name '*.html' -o -name '*.ts' -o -name '*.js' \) -print0)
  return 1
}

changed_files() {
  local b="$base"
  if [[ -z "$b" ]]; then
    if git rev-parse -q --verify main >/dev/null; then b="$(git merge-base main HEAD)"; else b="HEAD"; fi
  fi
  { git diff --name-only "$b" HEAD; git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u
}

steps=(typecheck test build)
budget_needed=0 lh_needed=0
if has_real_pages; then budget_needed=1; steps+=(budget); fi
if [[ $full -eq 1 ]] || changed_files | grep -Eq "$storefront_paths"; then lh_needed=1; steps+=(lh); fi

say "gate: $branch @ $short (tree ${tree:0:12}, $([[ $clean -eq 1 ]] && echo clean || echo DIRTY)) in $wt"
say "gate: steps = ${steps[*]}$([[ $full -eq 1 ]] && echo ' (--full)')"

cache="$main_root/artifacts/gate/cache/$tree"
if [[ $use_cache -eq 1 && $clean -eq 1 && -f "$cache" ]]; then
  cached="$(cat "$cache")"
  hit=1
  for s in "${steps[@]}"; do [[ " $cached " == *" $s "* ]] || hit=0; done
  if [[ $hit -eq 1 ]]; then
    say "gate: GREEN (cached for tree ${tree:0:12}: $cached) — log: $log"
    exit 0
  fi
fi

# --- run ----------------------------------------------------------------------------------
hb_acquire_gate_slot "${HB_GATE_WAIT:-3600}" "gate $branch@$short $wt" || { say "gate: RED — could not get a gate slot"; exit 1; }
say "gate: holding gate slot $HB_GATE_SLOT"

summary=()
red=""
run_step() {
  local name="$1"; shift
  local t0=$SECONDS rc=0
  printf '\n===== %s: %s\n' "$name" "$*" >>"$log"
  "$@" >>"$log" 2>&1 </dev/null || rc=$?
  if [[ $rc -eq 0 ]]; then
    summary+=("GREEN $name ($((SECONDS - t0))s)")
  else
    summary+=("RED   $name (exit $rc, $((SECONDS - t0))s)")
    red="$name"
  fi
  return 0
}

script_wired() { # RED when the root script is missing or still the TOOL-2 stub
  node -e 'const s=(require("./package.json").scripts||{})[process.argv[1]]||"";process.exit(!s||/not wired yet/.test(s)?1:0)' "$1"
}

lock_hash="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [[ ! -d node_modules || "$(cat node_modules/.hb-lock-hash 2>/dev/null || true)" != "$lock_hash" ]]; then
  run_step npm-ci env PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund --fetch-retries=6 --fetch-retry-mintimeout=5000
  [[ -z "$red" ]] && printf '%s\n' "$lock_hash" >node_modules/.hb-lock-hash
fi

for s in "${steps[@]}"; do
  [[ -n "$red" ]] && { summary+=("SKIP  $s (after red)"); continue; }
  if [[ "$s" == budget || "$s" == lh ]] && ! script_wired "$s"; then
    summary+=("RED   $s (script missing or a stub: apps/storefront has real pages, so it must be wired — owner: measure)")
    red="$s"
    continue
  fi
  run_step "$s" npm run "$s"
done

say "gate: summary"
for l in "${summary[@]}"; do say "  $l"; done
if [[ -n "$red" ]]; then
  say "gate: RED at $red — log: $log"
  echo "gate: RED at $red — log: $log" >&2
  exit 1
fi
if [[ $clean -eq 1 && -z "$(git status --porcelain --untracked-files=normal)" ]]; then
  printf '%s\n' "${steps[*]}" >"$cache"
fi
say "gate: GREEN — log: $log"
