#!/usr/bin/env bash
# scripts/team/merge.sh <branch> [<sha>] [--dry-run] [--gate]
#
# The lead's only way to merge to main (REVIEW.md §8–9, team/BRIEF.md §6.8). Run from anywhere; it
# acts on the main checkout, which must be on main, clean, with no merge in progress.
#
# Checks every commit in main..<sha> (<sha> defaults to <branch>'s tip and must be on <branch>):
#   non-merge commit  - subject "<ID>: …" and exactly one "Risk tier: low|high" line
#                     - files within the author's paths (author = team/<name> of <branch>), using
#                       main's team/owners.json — the backstop for worktrees without the hooks
#                     - an artifacts/<ID>/review-r<n>.md with "Verdict: APPROVED" whose "Commits:"
#                       line lists this sha (≥ 7-char prefix)
#                     - the latest round for <ID> is APPROVED and has no open Important finding
#                     - Risk tier: high ⇒ a line "<ID> <sha-prefix> — signed off …" in main's team/SIGNOFFS.md
#   merge commit      - clean (`git show --remerge-diff` empty), or covered by an APPROVED review of
#                       any ID listing its sha
# Then: merge --no-ff in a temporary worktree, run scripts/gate.sh there (--base = current main),
# and fast-forward main to the merge only when the gate is green. Main never holds a red merge.
#   --dry-run   checks + a trial merge for conflicts; main untouched; no gate unless --gate
# Exit 0 merged (or dry-run clean), 1 refused/red, 2 usage. Gate command override for tests: HB_GATE.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
main_root="$(dirname "$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)")"
artifacts="${HB_ARTIFACTS_DIR:-$main_root/artifacts}"
gate_cmd="${HB_GATE:-$here/../gate.sh}"

branch="" sha_arg="" dry=0 dry_gate=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry=1 ;;
    --gate) dry_gate=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    -*) echo "merge: unknown option $1" >&2; exit 2 ;;
    *) if [[ -z "$branch" ]]; then branch="$1"; elif [[ -z "$sha_arg" ]]; then sha_arg="$1"; else echo "merge: too many arguments" >&2; exit 2; fi ;;
  esac
  shift
done
[[ -n "$branch" ]] || { echo "usage: scripts/team/merge.sh <branch> [<sha>] [--dry-run] [--gate]" >&2; exit 2; }

g() { git -C "$main_root" "$@"; }

# --- preconditions --------------------------------------------------------------------------
[[ "$(g symbolic-ref --short -q HEAD || true)" == main ]] || { echo "merge: the main checkout ($main_root) must be on main" >&2; exit 1; }
[[ -z "$(g status --porcelain --untracked-files=no)" ]] || { echo "merge: the main checkout has uncommitted changes" >&2; exit 1; }
[[ ! -e "$(g rev-parse --git-path MERGE_HEAD)" ]] || { echo "merge: a merge is in progress in the main checkout" >&2; exit 1; }
g rev-parse -q --verify "refs/heads/$branch" >/dev/null || { echo "merge: no branch $branch" >&2; exit 1; }
sha="$(g rev-parse --verify "${sha_arg:-$branch}^{commit}")"
g merge-base --is-ancestor "$sha" "$branch" || { echo "merge: $sha is not on $branch" >&2; exit 1; }
main_sha="$(g rev-parse main)"
[[ "$branch" == team/* ]] || { echo "merge: branch must be team/<name> (author identity for the ownership check)" >&2; exit 1; }
author="${branch#team/}"

commits=()
while IFS= read -r c; do [[ -n "$c" ]] && commits+=("$c"); done < <(g rev-list --reverse "main..$sha")
[[ ${#commits[@]} -gt 0 ]] || { echo "merge: nothing to merge ($sha is already on main)"; exit 0; }

owners_tmp="$(mktemp)"; signoffs_tmp="$(mktemp)"
tmp_wt="" tmp_branch=""
cleanup() {
  rm -f "$owners_tmp" "$signoffs_tmp"
  if [[ -n "$tmp_wt" ]]; then g worktree remove --force "$tmp_wt" >/dev/null 2>&1 || rm -rf "$tmp_wt"; g worktree prune >/dev/null 2>&1 || true; fi
  if [[ -n "$tmp_branch" ]]; then g branch -D "$tmp_branch" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
g show main:team/owners.json >"$owners_tmp" 2>/dev/null || { echo "merge: main has no team/owners.json" >&2; exit 1; }
g show main:team/SIGNOFFS.md >"$signoffs_tmp" 2>/dev/null || : >"$signoffs_tmp"

# review helpers ----------------------------------------------------------------------------
covers() { # covers <review-file> <sha>: APPROVED and the Commits: line lists a prefix of sha
  local f="$1" s="$2" t
  grep -Eq '^Verdict: APPROVED[[:space:]]*$' "$f" || return 1
  for t in $(sed -n 's/^Commits:[[:space:]]*//p' "$f" | head -n1 | tr ',' ' '); do
    [[ ${#t} -ge 7 && "$s" == "$t"* ]] && return 0
  done
  return 1
}
covered_by_any_id() { # an APPROVED review of any ID covering sha
  local f
  for f in "$artifacts"/*/review-r*.md; do [[ -f "$f" ]] && covers "$f" "$1" && return 0; done
  return 1
}
latest_round() { # latest_round <ID> → path of the highest r<n>
  local id="$1" f best="" bn=-1 n
  for f in "$artifacts/$id"/review-r*.md; do
    [[ -f "$f" ]] || continue
    n="${f##*/review-r}"; n="${n%.md}"
    [[ "$n" =~ ^[0-9]+$ ]] && ((n > bn)) && { bn=$n; best="$f"; }
  done
  printf '%s' "$best"
}
open_importants() { # print open Important finding lines (not downgraded by "not confirmed")
  awk '
    function flush() { if (blk != "" && blk ~ /status:[[:space:]]*open/ && blk !~ /not confirmed/) print first }
    /^[[:space:]]*-[[:space:]]*\[Important\]/ { flush(); blk=$0; first=$0; next }
    /^[[:space:]]*-[[:space:]]*\[/ { flush(); blk=""; next }
    /^[[:space:]]+/ { if (blk != "") blk = blk "\n" $0; next }
    { flush(); blk="" }
    END { flush() }' "$1"
}

# --- per-commit checks ----------------------------------------------------------------------
refusals=()
ids=()
printf '%-9s %-10s %-5s %s\n' sha ID tier result
for c in "${commits[@]}"; do
  short="${c:0:9}"
  parents=$(($(g rev-list --parents -n1 "$c" | wc -w) - 1))
  if ((parents > 1)); then
    if [[ -z "$(g show --remerge-diff --format= "$c")" ]]; then
      printf '%-9s %-10s %-5s %s\n' "$short" merge - "OK (clean merge)"
    elif covered_by_any_id "$c"; then
      printf '%-9s %-10s %-5s %s\n' "$short" merge - "OK (resolution reviewed)"
    else
      printf '%-9s %-10s %-5s %s\n' "$short" merge - REFUSED
      refusals+=("$short merge commit carries conflict-resolution changes (git show --remerge-diff $short) and no APPROVED review lists it")
    fi
    continue
  fi

  subject="$(g log -1 --format=%s "$c")"
  body="$(g log -1 --format=%b "$c")"
  why=()
  id=""
  if [[ "$subject" =~ ^([A-Z]+(-[A-Z]+)?-[0-9]+):\  ]]; then id="${BASH_REMATCH[1]}"; else why+=("subject has no '<ID>: ' prefix"); fi
  tier_lines="$(printf '%s\n' "$body" | grep -E '^Risk tier:' || true)"
  tier=""
  if [[ "$(printf '%s' "$tier_lines" | grep -c '^Risk tier:' || true)" -ne 1 ]]; then
    why+=("needs exactly one 'Risk tier: low|high' line")
  elif [[ "$tier_lines" =~ ^Risk\ tier:\ (low|high)[[:space:]]*$ ]]; then
    tier="${BASH_REMATCH[1]}"
  else
    why+=("malformed '$tier_lines' (must be 'Risk tier: low' or 'Risk tier: high')")
  fi

  own="$(cd "$main_root" && HB_OWNERS_FILE="$owners_tmp" node "$here/../lib/owners.mjs" check-commit "$author" "$c" 2>&1)" || why+=("ownership: ${own//$'\n'/ }")

  if [[ -n "$id" ]]; then
    ids+=("$id")
    approved=0
    for f in "$artifacts/$id"/review-r*.md; do [[ -f "$f" ]] && covers "$f" "$c" && { approved=1; break; }; done
    ((approved)) || why+=("no APPROVED review in artifacts/$id/ lists this sha on its Commits: line")
    latest="$(latest_round "$id")"
    if [[ -n "$latest" ]]; then
      grep -Eq '^Verdict: APPROVED[[:space:]]*$' "$latest" || why+=("latest round ${latest##*/} is not APPROVED")
      oi="$(open_importants "$latest")"
      [[ -z "$oi" ]] || why+=("open Important finding(s) in ${latest##*/}: ${oi//$'\n'/ | }")
    fi
    if [[ "$tier" == high ]]; then
      signed=0
      while read -r sid spre _; do
        [[ "$sid" == "$id" && ${#spre} -ge 7 && "$c" == "$spre"* ]] && { signed=1; break; }
      done <"$signoffs_tmp"
      ((signed)) || why+=("Risk tier: high but no '$id <sha> — signed off …' line in team/SIGNOFFS.md")
    fi
  fi

  if [[ ${#why[@]} -eq 0 ]]; then
    printf '%-9s %-10s %-5s %s\n' "$short" "$id" "$tier" OK
  else
    printf '%-9s %-10s %-5s %s\n' "$short" "${id:-?}" "${tier:-?}" REFUSED
    for w in "${why[@]}"; do refusals+=("$short ${id:-?}: $w"); done
  fi
done

if [[ ${#refusals[@]} -gt 0 ]]; then
  echo "merge: REFUSED — ${#refusals[@]} problem(s):" >&2
  printf '  - %s\n' "${refusals[@]}" >&2
  exit 1
fi

# --- merge in a temporary worktree, gate, fast-forward ----------------------------------------
uniq_ids="$(printf '%s\n' "${ids[@]}" | awk '!s[$0]++' | paste -sd, -)"
tmp_branch="hb-merge/${author}-${sha:0:7}"
tmp_wt="$(mktemp -d "${TMPDIR:-/tmp}/hb-merge.XXXXXX")"
rmdir "$tmp_wt"
g worktree add -q -b "$tmp_branch" "$tmp_wt" "$main_sha"
if ! git -C "$tmp_wt" -c core.hooksPath=/dev/null merge -q --no-ff --no-edit -m "Merge $branch @${sha:0:7} (${uniq_ids})" "$sha" >/dev/null 2>&1; then
  git -C "$tmp_wt" merge --abort >/dev/null 2>&1 || true
  echo "merge: REFUSED — $branch @${sha:0:7} conflicts with main; the author merges main, resolves, and asks for review of the resolution" >&2
  exit 1
fi
merge_sha="$(git -C "$tmp_wt" rev-parse HEAD)"

if ((dry)) && ! ((dry_gate)); then
  echo "merge: DRY-RUN OK — all commits approved, merges cleanly (trial ${merge_sha:0:9}); main untouched"
  exit 0
fi

echo "merge: gating ${merge_sha:0:9} in $tmp_wt (base ${main_sha:0:9}) …"
if ! "$gate_cmd" "$tmp_wt" --base "$main_sha"; then
  echo "merge: RED — gate failed on the merge result; main untouched (still ${main_sha:0:9})" >&2
  exit 1
fi
if ((dry)); then
  echo "merge: DRY-RUN OK — approved, merges cleanly, gate GREEN on ${merge_sha:0:9}; main untouched"
  exit 0
fi

[[ "$(g rev-parse main)" == "$main_sha" ]] || { echo "merge: main moved during the gate; run merge.sh again" >&2; exit 1; }
g merge -q --ff-only "$merge_sha"
mkdir -p "$artifacts"
printf '%s %s %s@%s ids=%s\n' "$(date -u +%FT%TZ)" "${merge_sha:0:9}" "$branch" "${sha:0:9}" "$uniq_ids" >>"$artifacts/merges.log"
echo "merge: MERGED $branch @${sha:0:9} → main ${merge_sha:0:9} (${uniq_ids})"
