#!/usr/bin/env bash
# Machine-wide locks for the shared build machine (team/BRIEF.md §7).
#
# Source it:            . scripts/lib/locks.sh
#   hb_acquire_gate_slot <wait-seconds> <label>   take one of HB_GATE_SLOTS (default 2) gate slots;
#                                                 held until the calling shell exits
#   hb_lock_exclusive <name> <wait-seconds> <cmd…> run <cmd> holding the exclusive lock <name>
# Or run it:
#   scripts/lib/locks.sh exclusive <name> [--wait <s>] -- <cmd…>
#   e.g. "lh": "scripts/lib/locks.sh exclusive lighthouse -- node tools/measure/src/lh/cli.ts"
#
# Locks are flock(1) files under HB_LOCK_DIR (default /tmp/hb-locks); a sidecar .owner file says
# who holds each one. A lock is released when its holder exits, even on a crash.

HB_LOCK_DIR="${HB_LOCK_DIR:-/tmp/hb-locks}"

hb__owner_note() { printf '%s pid=%s %s\n' "$(date -u +%FT%TZ)" "$$" "$1"; }

hb_acquire_gate_slot() {
  local wait="${1:-3600}" label="${2:-gate}" slots="${HB_GATE_SLOTS:-2}" i fd announced=0
  local deadline=$((SECONDS + wait))
  mkdir -p "$HB_LOCK_DIR"
  while :; do
    for ((i = 1; i <= slots; i++)); do
      exec {fd}>"$HB_LOCK_DIR/gate-slot-$i.lock"
      if flock -n "$fd"; then
        hb__owner_note "$label" >"$HB_LOCK_DIR/gate-slot-$i.owner"
        HB_GATE_SLOT_FD=$fd
        HB_GATE_SLOT=$i
        return 0
      fi
      exec {fd}>&-
    done
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
    "$@"
  )
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  [[ "${1:-}" == "exclusive" && -n "${2:-}" ]] || { echo "usage: scripts/lib/locks.sh exclusive <name> [--wait <s>] -- <cmd…>" >&2; exit 2; }
  name="$2"; shift 2
  wait=3600
  if [[ "${1:-}" == "--wait" ]]; then wait="$2"; shift 2; fi
  [[ "${1:-}" == "--" ]] && shift
  [[ $# -gt 0 ]] || { echo "locks: no command given" >&2; exit 2; }
  hb_lock_exclusive "$name" "$wait" "$@"
fi
