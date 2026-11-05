#!/usr/bin/env bash
# Machine-wide locks for the shared build machine (team/BRIEF.md §7).
#
# Source it:            . scripts/lib/locks.sh
#   hb_acquire_gate_slot <wait-seconds> <label>   take one of HB_GATE_SLOTS (default 2) gate slots;
#                                                 held until the calling shell exits
#   hb_acquire_heavy_slot <wait-seconds> <label>  take one of HB_HEAVY_SLOTS (default 3) heavy slots
#   hb_lock_exclusive <name> <wait-seconds> <cmd…> run <cmd> holding the exclusive lock <name>
# Or run it:
#   scripts/lib/locks.sh heavy [--wait <s>] -- <cmd…>        (same slots as /tmp/hb-locks/heavy.sh)
#   scripts/lib/locks.sh exclusive <name> [--wait <s>] -- <cmd…>
#   e.g. "lh": "scripts/lib/locks.sh exclusive lighthouse -- node tools/measure/src/lh/cli.ts"
#
# Locks are flock(1) files under HB_LOCK_DIR (default /tmp/hb-locks); a sidecar .owner file says
# who holds each one. A lock is released when its holder exits, even on a crash.

HB_LOCK_DIR="${HB_LOCK_DIR:-/tmp/hb-locks}"

hb__owner_note() { printf '%s pid=%s %s\n' "$(date -u +%FT%TZ)" "$$" "$1"; }

# Two pools in one directory:
#   gate-slot-1..HB_GATE_SLOTS (2)   at most 2 gates at once
#   heavy-1..HB_HEAVY_SLOTS (3)      every heavy job on the machine: builds, vitest, wrangler dev,
#                                    Playwright/Chrome (`scripts/lib/locks.sh heavy -- <cmd…>`, same
#                                    files as the lead's interim /tmp/hb-locks/heavy.sh)
# A gate holds one gate slot AND one heavy slot for its whole run, so gates and other heavy jobs share
# the same 3-slot budget and never double-book.
hb__try_pool() { # hb__try_pool <prefix> <count> <label> → sets HB__FD / HB__IDX
  local prefix="$1" n="$2" label="$3" i fd
  for ((i = 1; i <= n; i++)); do
    exec {fd}>"$HB_LOCK_DIR/$prefix-$i.lock"
    if flock -n "$fd"; then
      hb__owner_note "$label" >"$HB_LOCK_DIR/$prefix-$i.owner"
      HB__FD=$fd HB__IDX=$i
      return 0
    fi
    exec {fd}>&-
  done
  return 1
}

hb_acquire_heavy_slot() {
  local wait="${1:-3600}" label="${2:-heavy}" announced=0
  local deadline=$((SECONDS + wait))
  mkdir -p "$HB_LOCK_DIR"
  while ! hb__try_pool heavy "${HB_HEAVY_SLOTS:-3}" "$label"; do
    if ((SECONDS >= deadline)); then echo "locks: no heavy slot free after ${wait}s" >&2; return 75; fi
    if ((announced == 0)); then
      echo "locks: all ${HB_HEAVY_SLOTS:-3} heavy slots busy, waiting. Holders:" >&2
      cat "$HB_LOCK_DIR"/heavy-*.owner >&2 2>/dev/null || true
      announced=1
    fi
    sleep 5
  done
  HB_HEAVY_SLOT_FD=$HB__FD HB_HEAVY_SLOT=$HB__IDX
}

hb_acquire_gate_slot() {
  local wait="${1:-3600}" label="${2:-gate}" slots="${HB_GATE_SLOTS:-2}" announced=0
  local deadline=$((SECONDS + wait))
  mkdir -p "$HB_LOCK_DIR"
  while :; do
    if hb__try_pool gate-slot "$slots" "$label"; then
      HB_GATE_SLOT_FD=$HB__FD HB_GATE_SLOT=$HB__IDX
      hb_acquire_heavy_slot $((deadline - SECONDS > 0 ? deadline - SECONDS : 1)) "$label" || return $?
      return 0
    fi
    if ((SECONDS >= deadline)); then
      echo "locks: no gate slot free after ${wait}s; holders:" >&2
      cat "$HB_LOCK_DIR"/gate-slot-*.owner >&2 2>/dev/null || true
      return 75
    fi
    if ((announced == 0)); then
      echo "locks: all $slots gate slots busy, waiting (up to ${wait}s). Holders:" >&2
      cat "$HB_LOCK_DIR"/gate-slot-*.owner >&2 2>/dev/null || true
      announced=1
    fi
    sleep 5
  done
}

# hb_run_group <cmd…>: run <cmd> in a new process group (setsid) with every inherited fd above 2
# closed (so no descendant can keep a lock alive), wait for it, then kill whatever is left in that
# group (a wrangler/workerd or Chrome a test forgot). TERM/INT kill the group too.
# HB_RUN_TIMEOUT (seconds, 0 = none): hard limit; the command is TERMed, then KILLed 30 s later, exit 124.
hb_run_group() {
  local rc=0 pid
  setsid bash -c 'for f in /proc/$$/fd/*; do n=${f##*/}; [[ $n =~ ^[0-9]+$ ]] && ((n > 2)) && eval "exec $n>&-"; done
    t="${HB_RUN_TIMEOUT:-0}"; if [[ "$t" != 0 ]]; then exec timeout --kill-after=30s "$t" "$@"; fi; exec "$@"' hb-step "$@" &
  pid=$!
  HB_GROUP_PID=$pid
  trap 'kill -TERM -- "-$HB_GROUP_PID" 2>/dev/null; exit 143' TERM INT
  wait "$pid" || rc=$?
  kill -TERM -- "-$pid" 2>/dev/null || true
  trap - TERM INT
  HB_GROUP_PID=""
  return $rc
}

hb_lock_exclusive() {
  local name="$1" wait="$2"
  shift 2
  mkdir -p "$HB_LOCK_DIR"
  (
    exec {fd}>"$HB_LOCK_DIR/$name.lock"
    if ! flock -n "$fd"; then
      echo "locks: waiting for the '$name' lock (up to ${wait}s), held by: $(cat "$HB_LOCK_DIR/$name.owner" 2>/dev/null || echo unknown)" >&2
      flock -w "$wait" "$fd" || { echo "locks: timed out waiting for '$name'" >&2; exit 75; }
    fi
    hb__owner_note "$name $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?') $PWD" >"$HB_LOCK_DIR/$name.owner"
    # Only this subshell holds the lock: the command runs in its own process group without the
    # lock fd, and whatever it leaves behind is killed when it returns.
    hb_run_group "$@"
    rc=$?
    flock -u "$fd"
    exit $rc
  )
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  usage() { echo "usage: scripts/lib/locks.sh exclusive <name> [--wait <s>] -- <cmd…> | heavy [--wait <s>] -- <cmd…>" >&2; exit 2; }
  mode="${1:-}"; shift || true
  case "$mode" in
    exclusive) name="${1:-}"; [[ -n "$name" ]] || usage; shift ;;
    heavy) ;;
    *) usage ;;
  esac
  wait=3600
  if [[ "${1:-}" == "--wait" ]]; then wait="$2"; shift 2; fi
  [[ "${1:-}" == "--" ]] && shift
  [[ $# -gt 0 ]] || { echo "locks: no command given" >&2; exit 2; }
  if [[ "$mode" == heavy ]]; then
    hb_acquire_heavy_slot "$wait" "heavy $* ($PWD)"
    rc=0
    # like /tmp/hb-locks/heavy.sh: a hung command cannot hold a slot forever
    HB_RUN_TIMEOUT="${HB_HEAVY_TIMEOUT:-2700}" hb_run_group "$@" || rc=$?
    [[ $rc -eq 124 ]] && echo "locks: command exceeded ${HB_HEAVY_TIMEOUT:-2700}s and was killed (slot released)" >&2
    flock -u "$HB_HEAVY_SLOT_FD"
    exit $rc
  else
    hb_lock_exclusive "$name" "$wait" "$@"
  fi
fi
