#!/usr/bin/env bash
# TeammateIdle hook (.claude/settings.json). Stdin JSON: {teammate_name?, cwd, …}.
# Exit 2 only when the teammate's worktree has modified/untracked files outside its owned paths
# (an ownership slip), and only once per distinct state, so it can never loop. Otherwise exit 0.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
main_root="$(dirname "$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)")"
cache_dir="${HB_LOCK_DIR:-/tmp/hb-locks}/idle-cache"

input="$(cat)"
name="$(HB_JSON="$input" node -e 'let v;try{v=JSON.parse(process.env.HB_JSON).teammate_name}catch{};process.stdout.write(v?String(v):"")')"
[[ -n "$name" ]] || exit 0
wt="$main_root/.worktrees/$name"
[[ -d "$wt" ]] || exit 0

paths="$(git -C "$wt" status --porcelain --untracked-files=all | sed -E 's/^.{3}//; s/^.* -> //; s/^"(.*)"$/\1/')"
[[ -n "$paths" ]] || exit 0

owners="$wt/team/owners.json"
[[ -f "$owners" ]] || owners="$main_root/team/owners.json"
[[ -f "$owners" ]] || exit 0
bad="$(printf '%s\n' "$paths" | (cd "$wt" && HB_OWNERS_FILE="$owners" node "$here/../lib/owners.mjs" violations "$name"))"
[[ -n "$bad" ]] || exit 0

key="$(printf '%s\n%s\n' "$name" "$bad" | while IFS= read -r p; do printf '%s ' "$p"; [[ -f "$wt/$p" ]] && sha1sum <"$wt/$p" | cut -c1-12; echo; done | sha256sum | cut -c1-32)"
mkdir -p "$cache_dir"
[[ -e "$cache_dir/$key" ]] && exit 0
: >"$cache_dir/$key"

{
  echo "Ownership slip in $wt — these changed files are outside your paths (team/owners.json):"
  printf '%s\n' "$bad" | sed 's/^/  - /'
  echo "Revert them (git restore / rm), or ask their owner to make the change."
} >&2
exit 2
