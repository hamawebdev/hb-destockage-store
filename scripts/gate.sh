#!/usr/bin/env bash
# scripts/gate.sh [worktree] [--full] [--base <ref>] [--no-cache]
#
# The single gate. Green = every step below exits 0:
#   npm ci            when node_modules is missing or package-lock.json changed since the last ci
#   npm run typecheck, npm test
#   data-geo / data-catalog-validate / data-catalog-test   node --test data/geo/**/*.test.mjs,
#                     node data/catalog/validate.mjs, node --test data/catalog/test/*.test.mjs (when present)
#   npm run build
#   npm run budget    when apps/storefront/src/pages has a real (non-placeholder) page
#   check-tap         `npm run check:tap` in apps/storefront (tap targets ≥ 44 px) under the lh rule
#                     below, when apps/storefront/scripts/tap-targets.mjs exists
#   npm run axe       (zero violations + keyboard pass) under the lh rule below
#   npm run lh        when real pages exist, unless EVERY path changed vs <base> (default: merge-base
#                     with main) is known not to affect the built storefront or its server
#                     (admin, jobs, db, docs, team, tooling scripts/hooks, tests, *.md); --full forces it
# REPORT-ONLY (client rule: done = typecheck, tests, build): budget, axe, check-tap and lh run and are
# reported, but never fail the gate — nor does a missing or stub ("not wired yet") script for them.
# @hb/db and @hb/admin test files run one process per file (limit HB_TEST_FILE_TIMEOUT, 1800 s), the
# other workspaces together in the `test` step.
# Refuses (RED "hooks") unless core.hooksPath is the ABSOLUTE path of the main checkout's .githooks.
# Disk rule: TMPDIR/TEMP/TMP default to /mnt/data/hb-tmp/gate-<branch> (unless already on /mnt/data);
# RED "disk" when / has under HB_MIN_ROOT_FREE_GB (3) GB free.
# Each step runs in its own process group without lock fds; leftovers are killed when it ends; each
# step has a hard limit (HB_STEP_TIMEOUT 2700 s, lh HB_LH_TIMEOUT 14400 s); a timeout is RED (exit 124).
#
# Machine-wide: at most HB_GATE_SLOTS (2) gates at once, each also holding one of the HB_HEAVY_SLOTS (3)
# heavy slots shared with every other heavy job (scripts/lib/locks.sh); waits up to
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

hb_use_data_tmp "gate-${branch}" || { echo "gate: cannot create a temp dir under ${HB_TMP_ROOT:-/mnt/data/hb-tmp}" >&2; exit 1; }
logdir="$main_root/artifacts/gate/${branch//\//_}"
mkdir -p "$logdir" "$main_root/artifacts/gate/cache"
log="$logdir/$short$([[ $clean -eq 1 ]] || echo -dirty).log"
: >"$log"

say() { printf '%s\n' "$*" | tee -a "$log"; }

# --- what this run must cover -------------------------------------------------------------
# Paths that cannot change what the storefront builds or how apps/web serves it. Anything else
# (lockfile, package.json, apps/storefront, apps/web, packages/{shared,catalog,ui-tokens}, data/,
# brand/, tools/measure, …) makes Lighthouse run.
# Test exemptions are package-level test dirs / *.test.* files only; anything under a public/ dir is
# served, so it always counts (rev-a TOOL-1 r2 Nit).
no_lh_effect='^(apps/admin/|apps/jobs/|packages/db/|docs/|research-evidence/|team/|artifacts/|\.claude/|\.githooks/|scripts/|tests/e2e/|[^/]+\.md$|\.gitignore$|\.nvmrc$)|^(apps|packages|tools)/[^/]+/test/|^data/[^/]+/test/|\.test\.(ts|mjs)$'
affects_storefront() { # some changed path is served or can change the build
  local files; files="$(changed_files)"
  printf '%s\n' "$files" | grep -q '/public/' && return 0
  printf '%s\n' "$files" | grep -Evq "$no_lh_effect"
}

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

# data/ is not a workspace: its checks are named gate steps of their own (each can go RED).
data_files() { find "$1" -name '*.test.mjs' -not -path '*/node_modules/*' -print0 2>/dev/null | sort -z | tr '\0' '\n'; }
data_steps=()
[[ -d data/geo && -n "$(data_files data/geo)" ]] && data_steps+=(data-geo)
[[ -f data/catalog/validate.mjs ]] && data_steps+=(data-catalog-validate)
[[ -d data/catalog/test && -n "$(data_files data/catalog/test)" ]] && data_steps+=(data-catalog-test)

# Suites too slow on workerd D1 for one hold run file by file (lead); fake/older trees keep plain `npm test`.
mapfile -t workspaces < <(node -e 'for (const w of (require("./package.json").workspaces||[])) console.log(w)')
test_files_in() { (cd "$1" && find test src -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) 2>/dev/null | sort); }
per_file_dirs=() per_file_steps=()
for d in packages/db apps/admin; do
  if printf '%s\n' "${workspaces[@]:-}" | grep -qx "$d" && [[ -n "$(test_files_in "$d")" ]]; then
    per_file_dirs+=("$d"); per_file_steps+=("test-files:$d")
  fi
done

steps=(typecheck test "${per_file_steps[@]}" "${data_steps[@]}" build)
real_pages=0
if has_real_pages; then real_pages=1; steps+=(budget); fi
storefront_affected=0
if [[ $full -eq 1 ]] || { [[ $real_pages -eq 1 ]] && affects_storefront; }; then storefront_affected=1; fi
# Tap targets ≥ 44 px (shell's check, needs dist/ + Chrome; runs inside this gate's heavy slot).
if [[ $storefront_affected -eq 1 && -f apps/storefront/scripts/tap-targets.mjs ]]; then steps+=(check-tap); fi
# axe: zero violations + keyboard pass (measure MEAS-3) — blocking, same rule as lh (stub ⇒ RED with real pages)
[[ $storefront_affected -eq 1 ]] && steps+=(axe lh)

hooks_ok=1
[[ "$(git config --get core.hooksPath || true)" == "$main_root/.githooks" && -x "$main_root/.githooks/pre-commit" ]] || hooks_ok=0

# The storefront build needs an explicit catalogue snapshot (lead ruling, CAT-2): the gate builds the fixture.
export HB_SNAPSHOT="${HB_SNAPSHOT:-fixture}"

say "gate: $branch @ $short (tree ${tree:0:12}, $([[ $clean -eq 1 ]] && echo clean || echo DIRTY)) in $wt — HB_SNAPSHOT=$HB_SNAPSHOT TMPDIR=$TMPDIR"
if [[ -n "$(git stash list 2>/dev/null | head -n1)" ]]; then
  say "gate: WARNING — the shared git stash is not empty; never use git stash (BRIEF §9), use WIP commits. Entries:"
  git stash list 2>/dev/null | head -n 5 | sed 's/^/         /' | tee -a "$log"
fi
say "gate: steps = ${steps[*]}$([[ $full -eq 1 ]] && echo ' (--full)')"

if ! root_free="$(hb_root_free_ok)"; then
  say "gate: RED at disk — / has ${root_free} GB free, under the ${HB_MIN_ROOT_FREE_GB:-3} GB minimum (BRIEF §9 disk rule)."
  say "       Free space first (your /tmp leftovers, old dist/ and .wrangler/ state); temp files go to $TMPDIR — log: $log"
  echo "gate: RED at disk — log: $log" >&2
  exit 1
fi

if [[ $hooks_ok -eq 0 ]]; then
  say "gate: RED at hooks — core.hooksPath is '$(git config --get core.hooksPath || true)', must be the absolute '$main_root/.githooks'"
  say "       (the lead activates it once: git config core.hooksPath \"$main_root/.githooks\") — log: $log"
  echo "gate: RED at hooks — log: $log" >&2
  exit 1
fi

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
say "gate: holding gate slot $HB_GATE_SLOT and heavy slot $HB_HEAVY_SLOT (shared with scripts/lib/locks.sh heavy and /tmp/hb-locks/heavy.sh)"
release_slots() {
  flock -u "$HB_GATE_SLOT_FD" 2>/dev/null || true
  flock -u "$HB_HEAVY_SLOT_FD" 2>/dev/null || true
}
trap release_slots EXIT

summary=()
red=""
run_step() {
  local name="$1"; shift
  local t0=$SECONDS rc=0
  printf '\n===== %s: %s\n' "$name" "$*" >>"$log"
  # Hang-proof: every step has a hard limit, so a hung step cannot hold the gate and heavy slots.
  local limit="${HB_STEP_TIMEOUT:-2700}"
  [[ "$name" == lh ]] && limit="${HB_LH_TIMEOUT:-14400}"
  [[ "$name" == test:* ]] && limit="${HB_TEST_FILE_TIMEOUT:-1800}"
  HB_RUN_TIMEOUT="$limit" hb_run_group "$@" >>"$log" 2>&1 </dev/null || rc=$?
  local timed_out=""
  if [[ $rc -ne 0 ]] && (( SECONDS - t0 >= limit )); then
    timed_out=", TIMED OUT after ${limit}s"
    printf '\n===== %s: TIMED OUT after %ss (exit %s; killed with its process group)\n' "$name" "$limit" "$rc" >>"$log"
  fi
  if [[ $rc -eq 0 ]]; then
    summary+=("GREEN $name ($((SECONDS - t0))s)")
  else
    summary+=("RED   $name (exit $rc$timed_out, $((SECONDS - t0))s)")
    red="$name"
  fi
  return 0
}

script_wired() { # RED when the root script is missing or still the TOOL-2 stub
  node -e 'const s=(require("./package.json").scripts||{})[process.argv[1]]||"";process.exit(!s||/not wired yet|scripts\/not-wired\.sh/.test(s)?1:0)' "$1"
}

lock_hash="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [[ ! -d node_modules || "$(cat node_modules/.hb-lock-hash 2>/dev/null || true)" != "$lock_hash" ]]; then
  run_step npm-ci env PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund --fetch-retries=6 --fetch-retry-mintimeout=5000
  [[ -z "$red" ]] && printf '%s\n' "$lock_hash" >node_modules/.hb-lock-hash
fi

for s in "${steps[@]}"; do
  [[ -n "$red" ]] && { summary+=("SKIP  $s (after red)"); continue; }
  report_only=0
  case "$s" in budget | lh | axe | check-tap) report_only=1 ;; esac
  if [[ "$s" == budget || "$s" == lh || "$s" == axe ]] && ! script_wired "$s"; then
    summary+=("REPORT $s (not wired yet; report only, does not block)")
    continue
  fi
  case "$s" in
    test-files:*)
      dir="${s#test-files:}"
      vitest_cmd="${HB_VITEST_CMD:-npx vitest run}"
      while IFS= read -r rel; do
        run_step "test:${dir##*/}:$rel" env -C "$dir" bash -c "$vitest_cmd --passWithNoTests \"\$1\"" _ "$rel"
      done < <(test_files_in "$dir")
      continue
      ;;
    data-geo) mapfile -t f < <(data_files data/geo); run_step "$s" node --test "${f[@]}" ;;
    data-catalog-validate) run_step "$s" node data/catalog/validate.mjs ;;
    data-catalog-test) mapfile -t f < <(data_files data/catalog/test); run_step "$s" node --test "${f[@]}" ;;
    check-tap) run_step "$s" npm --prefix apps/storefront run check:tap ;;
    # measure's gate mode: refuses any option that narrows or relaxes the run (--runs, --url, …)
    lh) run_step "$s" env HB_GATE=1 npm run lh ;;
    # root `npm test` chains `npm run test:data` (rev-e); the gate runs those as named data-* steps
    test)
      if [[ ${#per_file_dirs[@]} -gt 0 ]]; then
        rest=()
        for w in "${workspaces[@]}"; do [[ " ${per_file_dirs[*]} " == *" $w "* ]] || rest+=("$w"); done
        run_step "$s" env HB_SKIP_DATA_TESTS=1 bash -c 'set -e; for w in "$@"; do npm run test -w "$w" --if-present; done; if [[ -f scripts/vitest.config.ts ]]; then npx vitest run --config scripts/vitest.config.ts; fi' _ "${rest[@]}"
      else
        run_step "$s" env HB_SKIP_DATA_TESTS=1 npm run test
      fi
      ;;
    *) run_step "$s" npm run "$s" ;;
  esac
  if [[ $report_only -eq 1 && "$red" == "$s" ]]; then
    red=""
    summary[-1]="REPORT ${summary[-1]#RED   } — report only, does not block"
  fi
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
