#!/usr/bin/env bash
# scripts/team/port.sh <name> — print the teammate's port base (10 ports: base … base+9).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ $# -eq 1 ]] || { echo "usage: scripts/team/port.sh <name>" >&2; exit 2; }
cd "$here/../.." && exec node scripts/lib/owners.mjs port "$1"
