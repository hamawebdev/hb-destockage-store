#!/usr/bin/env bash
# scripts/not-wired.sh <script> — placeholder for a root measurement script that `measure` has not
# wired yet. Before apps/storefront has a real page: prints "not wired yet" and exits 0. Once a real
# (non-"Placeholder (TOOL-2)") page exists: exits 1, so a stub can never pass for a measurement
# (same rule as scripts/gate.sh).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
name="${1:-script}"
real=0
if [[ -d apps/storefront/src/pages ]]; then
  while IFS= read -r -d '' f; do
    head -n 3 "$f" | grep -q 'Placeholder (TOOL-2)' || { real=1; break; }
  done < <(find apps/storefront/src/pages -type f \( -name '*.astro' -o -name '*.md' -o -name '*.mdx' -o -name '*.html' -o -name '*.ts' -o -name '*.js' \) -print0)
fi
if ((real)); then
  echo "$name: not wired yet, and apps/storefront has real pages — this is NOT a pass (owner: measure)" >&2
  exit 1
fi
echo "$name: not wired yet (only TOOL-2 placeholder pages exist)"
