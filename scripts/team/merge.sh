#!/usr/bin/env bash
# scripts/team/merge.sh <branch> [<sha>] [--dry-run] [--gate]
#
# The lead's only way to merge to main (REVIEW.md §8–9, team/BRIEF.md §6.8). Run from anywhere; it
# acts on the main checkout, which must be on main, clean, with no merge in progress.
#
# Checks every commit in main..<sha> (<sha> defaults to <branch>'s tip and must be on <branch>):
#   non-merge commit  - the full commit-msg format (main's .githooks/commit-msg) and exactly one
#                       "Risk tier: low|high" line
#                     - files within its author's paths, using main's team/owners.json — the backstop
#                       for --no-verify and worktrees without hooks. Author = <branch>'s owner for
#                       commits on its first-parent line; a commit merged in from another team
#                       branch is attributed to the team/* branch(es) whose first-parent line has it
#                     - approved per the lead-only ledger main:team/APPROVALS.md (review files under
#                       artifacts/ are evidence, never authority): the full sha is listed on SOME
#                       ledger line for its ID, and the LATEST line for that ID (highest r<n>) is
#                       APPROVED. Ledger lines are parsed strictly (anchored, full shas, reviewer =
#                       a rev-* teammate in owners.json); a malformed ledger line refuses everything
#                     - effective tier = max(commit's "Risk tier:", tier= of any ledger line for the
#                       ID); high ⇒ main:team/SIGNOFFS.md has "<ID> <full sha> — signed off …"
#   merge commit      - exactly 2 parents (octopus refused), and clean (`git show --remerge-diff`
#                       empty) or listed on a ledger line of an ID whose latest line is APPROVED
# Then: merge --no-ff in a temporary worktree; NET-DIFF ownership on the result (every path it would
# change on main is the author's, or exactly the version a reviewed commit of that path's owner made —
# catches reverts and edits hidden in merges); run scripts/gate.sh there (--base = current main),
# and fast-forward main to the merge only when the gate is green. Main never holds a red merge.
#   --dry-run   checks + a trial merge for conflicts; main untouched; no gate unless --gate
# Exit 0 merged (or dry-run clean), 1 refused/red, 2 usage. Gate command override for tests: HB_GATE_CMD (HB_GATE is measure's lh gate-mode flag).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
main_root="$(dirname "$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)")"
artifacts="${HB_ARTIFACTS_DIR:-$main_root/artifacts}"
gate_cmd="${HB_GATE_CMD:-$here/../gate.sh}"

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
  rm -f "$owners_tmp" "$signoffs_tmp" "${msg_tmp:-}" "${ledger_tmp:-}"
  if [[ -n "$tmp_wt" ]]; then g worktree remove --force "$tmp_wt" >/dev/null 2>&1 || rm -rf "$tmp_wt"; g worktree prune >/dev/null 2>&1 || true; fi
  if [[ -n "$tmp_branch" ]]; then g branch -D "$tmp_branch" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
g show main:team/owners.json >"$owners_tmp" 2>/dev/null || { echo "merge: main has no team/owners.json" >&2; exit 1; }
g show main:team/SIGNOFFS.md >"$signoffs_tmp" 2>/dev/null || : >"$signoffs_tmp"

# ledger (lead's ruling 2026-11-05: team/APPROVALS.md on main is the only authority) -------------
ledger_tmp="$(mktemp)"
g show main:team/APPROVALS.md >"$ledger_tmp" 2>/dev/null || : >"$ledger_tmp"
reviewers=" $(node -e 'const o=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).owners;process.stdout.write(Object.keys(o).filter(n=>/^rev-[a-z]$/.test(n)).join(" "))' "$owners_tmp") "
declare -A L_listed=() L_n=() L_verdict=() L_who=() L_review=() L_high=()
ledger_errors=()
id_re='[A-Z]+(-[A-Z]+)?-[0-9]+'
line_re="^($id_re) r([0-9]+) (APPROVED|CHANGES_REQUESTED) tier=(low|high) reviewer=(rev-[a-z]) commits=([0-9a-f]{40}(,[0-9a-f]{40})*) review=([^[:space:]]+)\$"
# Fail closed (rev-d TOOL-5 r2, lead rule): every non-blank line that is not a "#" heading/comment or
# a "`" template line and contains anything that looks like a task ID must match the strict regex
# exactly (no leading/double spaces, tabs, CRLF, lowercase verdicts, short shas, trailing junk);
# otherwise ALL merges are refused, naming the line. Same rule for team/SIGNOFFS.md below.
looks_re="$id_re"
skip_line() { [[ -z "${1//[[:space:]]/}" || "$1" == '#'* || "$1" == '`'* ]]; }
lnum=0
while IFS= read -r line || [[ -n "$line" ]]; do
  lnum=$((lnum + 1))
  skip_line "$line" && continue
  if [[ "$line" =~ $line_re ]]; then
    lid="${BASH_REMATCH[1]}" ln="${BASH_REMATCH[3]}" lv="${BASH_REMATCH[4]}" lt="${BASH_REMATCH[5]}"
    lw="${BASH_REMATCH[6]}" lc="${BASH_REMATCH[7]}" lr="${BASH_REMATCH[9]}"
    if [[ "$reviewers" != *" $lw "* ]]; then ledger_errors+=("team/APPROVALS.md:$lnum reviewer '$lw' is not a reviewer in team/owners.json"); continue; fi
    for x in ${lc//,/ }; do L_listed["$lid $x"]=1; done
    [[ "$lt" == high ]] && L_high[$lid]=1
    if (( ln >= ${L_n[$lid]:--1} )); then L_n[$lid]=$ln L_verdict[$lid]=$lv L_who[$lid]=$lw L_review[$lid]=$lr; fi
  elif [[ "$line" =~ $looks_re ]]; then
    ledger_errors+=("team/APPROVALS.md:$lnum malformed ledger line: $(printf '%q' "$line")")
  fi
done <"$ledger_tmp"

declare -A S_signed=()
sign_re="^($id_re) ([0-9a-f]{40}) — signed off( .*)?\$"
lnum=0
while IFS= read -r line || [[ -n "$line" ]]; do
  lnum=$((lnum + 1))
  skip_line "$line" && continue
  if [[ "$line" =~ $sign_re && "$line" != *$'\r'* ]]; then
    S_signed["${BASH_REMATCH[1]} ${BASH_REMATCH[3]}"]=1
  elif [[ "$line" =~ $looks_re ]]; then
    ledger_errors+=("team/SIGNOFFS.md:$lnum malformed sign-off line: $(printf '%q' "$line")")
  fi
done <"$signoffs_tmp"
if [[ ${#ledger_errors[@]} -gt 0 ]]; then
  echo "merge: REFUSED — the approvals ledger / sign-off log has errors (fix it on main first):" >&2
  printf '  - %s\n' "${ledger_errors[@]}" >&2
  exit 1
fi
merge_covered() { # a merge commit listed on a ledger line of an ID whose latest line is APPROVED
  local k
  for k in "${!L_listed[@]}"; do
    [[ "$k" == *" $1" && "${L_verdict[${k% *}]:-}" == APPROVED ]] && return 0
  done
  return 1
}

# --- attribution: which teammate authored each commit ------------------------------------------
declare -A fp_owners=()   # sha -> space-separated owners whose team/* first-parent line has it
while IFS= read -r ref; do
  o="${ref#refs/heads/team/}"
  while IFS= read -r s; do fp_owners[$s]+="$o "; done < <(g rev-list --first-parent "main..$ref" 2>/dev/null)
done < <(g for-each-ref --format='%(refname)' 'refs/heads/team/')
declare -A on_branch_fp=()
while IFS= read -r s; do on_branch_fp[$s]=1; done < <(g rev-list --first-parent "main..$sha")

msg_tmp="$(mktemp)"
attributed=()   # "sha owner" for commits that passed

# --- per-commit checks ----------------------------------------------------------------------
refusals=()
ids=()
printf '%-9s %-10s %-5s %s\n' sha ID tier result
for c in "${commits[@]}"; do
  short="${c:0:9}"
  parents=$(($(g rev-list --parents -n1 "$c" | wc -w) - 1))
  if ((parents > 2)); then
    printf '%-9s %-10s %-5s %s\n' "$short" merge - REFUSED
    refusals+=("$short octopus merge ($parents parents): not supported; merge one branch at a time")
    continue
  fi
  if ((parents == 2)); then
    if [[ -z "$(g show --remerge-diff --format= "$c")" ]]; then
      printf '%-9s %-10s %-5s %s\n' "$short" merge - "OK (clean merge)"
    elif merge_covered "$c"; then
      printf '%-9s %-10s %-5s %s\n' "$short" merge - "OK (resolution reviewed)"
    else
      printf '%-9s %-10s %-5s %s\n' "$short" merge - REFUSED
      refusals+=("$short merge commit carries conflict-resolution changes (git show --remerge-diff $short) and no APPROVED ledger line lists it")
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

  g log -1 --format=%B "$c" >"$msg_tmp"
  fmt="$(cd "$main_root" && "$here/../../.githooks/commit-msg" "$msg_tmp" 2>&1 | head -n1)" || why+=("message format: $fmt")

  # Candidates: every team whose first-parent line has the commit (a fast-forward merge puts another
  # team's commits on this branch's own first-parent line too), plus this branch's owner.
  cands="${fp_owners[$c]:-}"
  [[ -n "${on_branch_fp[$c]:-}" && " $cands " != *" $author "* ]] && cands="$author $cands"
  owner_ok=""
  own=""
  for o in $cands; do
    if out="$(cd "$main_root" && HB_OWNERS_FILE="$owners_tmp" node "$here/../lib/owners.mjs" check-commit "$o" "$c" 2>&1)"; then owner_ok="$o"; break; fi
    own+="[$o] ${out//$'\n'/ } "
  done
  if [[ -z "$cands" ]]; then
    why+=("ownership: cannot attribute this commit to a team/* branch (merged from a non-team branch?)")
  elif [[ -z "$owner_ok" ]]; then
    why+=("ownership: $own")
  fi

  if [[ -n "$id" ]]; then
    ids+=("$id")
    [[ -n "${L_listed["$id $c"]:-}" ]] || why+=("not listed for $id in team/APPROVALS.md (full sha)")
    relied="no ledger line"
    if [[ -n "${L_n[$id]:-}" ]]; then
      relied="ledger $id r${L_n[$id]} ${L_verdict[$id]} by ${L_who[$id]} (${L_review[$id]})"
      [[ "${L_verdict[$id]}" == APPROVED ]] || why+=("latest ledger line for $id is r${L_n[$id]} ${L_verdict[$id]}")
    else
      why+=("no line for $id in team/APPROVALS.md")
    fi
    # effective tier = max(commit, ledger): a reviewer may raise it, never lower it
    [[ -n "${L_high[$id]:-}" ]] && tier=high
    if [[ "$tier" == high ]]; then
      [[ -n "${S_signed["$id $c"]:-}" ]] || why+=("effective tier high but team/SIGNOFFS.md has no '$id $c — signed off …' line")
    fi
  fi

  if [[ ${#why[@]} -eq 0 ]]; then
    attributed+=("$c $owner_ok")
    printf '%-9s %-10s %-5s %s\n' "$short" "$id" "$tier" "OK (author $owner_ok; $relied)"
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

if ! net="$(cd "$main_root" && printf '%s\n' "${attributed[@]}" | HB_OWNERS_FILE="$owners_tmp" node "$here/../lib/owners.mjs" check-net "$author" "$main_sha" "$merge_sha" 2>&1)"; then
  echo "merge: REFUSED — net-diff ownership on the merge result:" >&2
  printf '%s\n' "$net" | sed 's/^/  - /' >&2
  exit 1
fi

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
