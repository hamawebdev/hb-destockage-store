#!/usr/bin/env bash
# Runs one workspace's vitest files one process per file (workerd D1 suites are too heavy for a
# single process). Usage: scripts/ci/test-per-file.sh <workspace dir>. Runs every file, then exits
# non-zero if any failed, so one run reports all failures.
set -uo pipefail
dir="${1:?usage: test-per-file.sh <workspace dir>}"
cd "$dir" || exit 2
mapfile -t files < <(find test src -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) 2>/dev/null | sort)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "no test files in $dir" >&2
  exit 1
fi
failed=()
for f in "${files[@]}"; do
  echo "::group::$f"
  npx vitest run --passWithNoTests "$f"
  rc=$?
  echo "::endgroup::"
  if [[ $rc -ne 0 ]]; then
    failed+=("$f (exit $rc)")
    echo "::error::$dir/$f failed (exit $rc)"
  fi
done
if [[ ${#failed[@]} -gt 0 ]]; then
  printf 'FAILED: %s\n' "${failed[@]}" >&2
  exit 1
fi
