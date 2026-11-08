#!/usr/bin/env bash
# TaskCompleted hook (.claude/settings.json). Reads the hook JSON on stdin:
#   {task_id, task_subject, task_description?, teammate_name?, cwd, …}
# Exit 0 = allow completion; exit 2 = refuse (reason on stderr, shown to the agent).
#
#   "REV <ID> r<n> …"       artifacts/<ID>/review-r<n>.md must exist with a "Verdict: APPROVED"
#                           or "Verdict: CHANGES REQUESTED" line
#   "QA-<n>: …", "<AREA>-0: …" (plans)   artifacts/<ID>/ must be non-empty
#   "<ID>: …" (build task)  worktree = .worktrees/<teammate_name>, else the "Worktree: <name>" line
#                           of the task description; else refuse. Then: clean tree, a commit whose
#                           subject starts with "<ID>: " on main..HEAD or on main, and scripts/gate.sh green.
#   anything else           allowed (free-form task)
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
main_root="$(dirname "$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)")"
artifacts="${HB_ARTIFACTS_DIR:-$main_root/artifacts}"

input="$(cat)"
field() { # field <name> → value from the hook JSON ("" if absent)
  HB_JSON="$input" node -e 'let v;try{v=JSON.parse(process.env.HB_JSON)[process.argv[1]]}catch{};process.stdout.write(v==null?"":String(v))' "$1"
}
task_id="$(field task_id)"
subject="$(field task_subject)"
description="$(field task_description)"
teammate="$(field teammate_name)"

refuse() { echo "TaskCompleted refused for \"$subject\": $*" >&2; exit 2; }

id_re='[A-Z]+(-[A-Z]+)?-[0-9]+'

# --- review tasks ---------------------------------------------------------------------------
if [[ "$subject" =~ ^REV\ ($id_re)\ r([0-9]+) ]]; then
  id="${BASH_REMATCH[1]}" n="${BASH_REMATCH[3]}"
  f="$artifacts/$id/review-r$n.md"
  [[ -f "$f" ]] || refuse "review file missing: $f (see REVIEW.md §5)"
  grep -Eq '^Verdict: (APPROVED|CHANGES REQUESTED)[[:space:]]*$' "$f" \
    || refuse "$f has no line 'Verdict: APPROVED' or 'Verdict: CHANGES REQUESTED' (REVIEW.md §5)"
  exit 0
fi

# --- plans and QA: artifact only ------------------------------------------------------------
if [[ "$subject" =~ ^(QA-[0-9]+): || "$subject" =~ ^([A-Z]+(-[A-Z]+)?-0): ]]; then
  id="${BASH_REMATCH[1]}"
  d="$artifacts/$id"
  [[ -d "$d" && -n "$(ls -A "$d" 2>/dev/null)" ]] || refuse "no artifact in $d/ (plans and QA tasks complete with their artifact)"
  exit 0
fi

# --- build tasks ----------------------------------------------------------------------------
if [[ ! "$subject" =~ ^($id_re):\  ]]; then
  exit 0 # free-form task: nothing to check
fi
id="${BASH_REMATCH[1]}"

# The description may be missing from the hook input; fall back to the task file.
if [[ -z "$description" && -n "$task_id" ]]; then
  for f in "$HOME"/.claude/tasks/*/"$task_id".json; do
    [[ -f "$f" ]] || continue
    d="$(HB_SUBJ="$subject" node -e 'try{const t=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(t.subject===process.env.HB_SUBJ)process.stdout.write(t.description||"")}catch{}' "$f")"
    [[ -n "$d" ]] && { description="$d"; break; }
  done
fi

wt=""
if [[ -n "$teammate" && -d "$main_root/.worktrees/$teammate" ]]; then
  wt="$main_root/.worktrees/$teammate"
else
  name="$(printf '%s\n' "$description" | sed -n 's/^[[:space:]]*Worktree:[[:space:]]*\([A-Za-z0-9._-]*\).*/\1/p' | head -n1)"
  [[ -n "$name" && -d "$main_root/.worktrees/$name" ]] && wt="$main_root/.worktrees/$name"
fi
[[ -n "$wt" ]] || refuse "cannot resolve worktree: no teammate_name and no 'Worktree: <name>' line naming an existing .worktrees/<name> in the task description"

[[ -z "$(git -C "$wt" status --porcelain --untracked-files=normal)" ]] \
  || refuse "worktree $wt has uncommitted changes (git -C '$wt' status); commit or stash them first"

has_commit() { git -C "$wt" log --format=%s "$@" 2>/dev/null | awk -v p="$id: " 'index($0,p)==1{f=1}END{exit !f}'; }
has_commit main..HEAD || has_commit main \
  || refuse "no commit with subject starting '$id: ' in main..HEAD of $wt or on main"

# --- gate: detached, fail closed ------------------------------------------------------------
# The hook has a hard timeout (.claude/settings.json); a hook killed at its timeout renders no
# decision and the task would complete. So the gate runs detached (its own session) and this hook
# waits at most HB_HOOK_BUDGET seconds (default 1500, under the 1800 s timeout). Still running ⇒
# exit 2 "gate still running"; the next completion attempt for the same tree picks up the result.
gate_cmd="${HB_GATE_CMD:-$here/../gate.sh}"
# Disk rule: the detached gate and everything it starts keep temp files on /mnt/data.
# shellcheck source=../lib/locks.sh
. "$here/../lib/locks.sh"
hb_use_data_tmp "hook-$(basename "$wt")" || refuse "cannot create a temp dir under ${HB_TMP_ROOT:-/mnt/data/hb-tmp}"
budget="${HB_HOOK_BUDGET:-1500}"
tree="$(git -C "$wt" rev-parse 'HEAD^{tree}')"
runs="$main_root/artifacts/gate/runs"
mkdir -p "$runs"
run="$runs/$tree"

alive() { [[ -f "$run.pid" ]] && kill -0 "$(cat "$run.pid")" 2>/dev/null; }

if [[ ! -f "$run.result" ]] && ! alive; then
  rm -f "$run.out"
  setsid bash -c '"$1" "$2" >"$3.out" 2>&1; echo $? >"$3.result.tmp"; mv "$3.result.tmp" "$3.result"' \
    hb-gate "$gate_cmd" "$wt" "$run" </dev/null >/dev/null 2>&1 &
  echo $! >"$run.pid"
fi

deadline=$((SECONDS + budget))
while [[ ! -f "$run.result" ]] && alive && ((SECONDS < deadline)); do sleep 2; done

gate_log="$(sed -n 's/.*log: \(.*\.log\)$/\1/p' "$run.out" 2>/dev/null | tail -n1)"
if [[ ! -f "$run.result" ]]; then
  if alive; then
    refuse "gate still running for $wt (tree ${tree:0:12}) — log ${gate_log:-$run.out}. Complete the task again when it has finished; the result is picked up then."
  fi
  refuse "gate stopped without a result for $wt — output $run.out"
fi

rc="$(cat "$run.result")"
rm -f "$run.result" "$run.pid"
if [[ "$rc" != 0 ]]; then
  tail -n 15 "$run.out" >&2
  refuse "scripts/gate.sh is RED for $wt — log ${gate_log:-$run.out}"
fi
tail -n 1 "$run.out"
exit 0
