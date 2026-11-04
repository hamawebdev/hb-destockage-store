#!/usr/bin/env bash
# Root `npm run test:data`: tests for data/ (not a workspace). node:test only, no dependencies.
#   - every data/**/*.test.mjs (geo, catalog, …) under `node --test`
#   - data/catalog/validate.mjs when present (seed's catalogue validator)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
mapfile -d '' tests < <(find data -name '*.test.mjs' -not -path '*/node_modules/*' -print0 2>/dev/null | sort -z)
if [[ ${#tests[@]} -gt 0 ]]; then
  node --test "${tests[@]}"
else
  echo "test:data: no data/**/*.test.mjs yet"
fi
if [[ -f data/catalog/validate.mjs ]]; then
  node data/catalog/validate.mjs
fi
