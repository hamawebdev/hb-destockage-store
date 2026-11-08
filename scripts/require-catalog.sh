#!/usr/bin/env bash
# Root `npm run build` guard: the seed build needs data/catalog (seed's branch). Fail early and clearly
# instead of a deep ENOENT. Only applies to the seed snapshot (unset = the root default, seed); an
# explicit other snapshot (the gate's fixture, a publish export) is not this script's concern.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ "${HB_SNAPSHOT:-seed}" == seed ]] || exit 0
if [[ ! -f data/catalog/categories.json ]]; then
  echo "data/catalog missing: merge seed or run build:fixture" >&2
  exit 1
fi
