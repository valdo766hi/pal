#!/usr/bin/env bash
# Install Pal's local Git protections: private-file excludes plus pre-commit/commit-msg guards.
# It never stages, commits, downloads, or touches remotes. Hooks are local; rerun in every clone.
set -euo pipefail

marker=pal-local-guard
die() {
	printf 'prepare-local: %s\n' "$*" >&2
	exit 1
}

root=$(git rev-parse --show-toplevel)
hooks_dir=$(git rev-parse --path-format=absolute --git-path hooks)
exclude=$(git rev-parse --path-format=absolute --git-path info/exclude)

hooks_path=$(git config --get core.hooksPath || true)
[[ -z $hooks_path ]] || die "core.hooksPath is set to '$hooks_path'; merge scripts/git-hooks into that hook manager manually"

tracked=$(git ls-files | grep -iE '(^|/)(stack|plan|claude\.local)\.md$|^\.design/' || true)
[[ -z $tracked ]] || die "private files are in the index; untrack them with 'git rm --cached -- <path>' first:
$tracked"

hooks=(pre-commit commit-msg)
for hook in "${hooks[@]}"; do
	target="$hooks_dir/$hook"
	if [[ -e $target ]] && ! grep -q "$marker" "$target"; then
		die "$target already exists and is not Pal's guard; merge scripts/git-hooks/$hook into it manually"
	fi
done

mkdir -p "$hooks_dir" "$(dirname "$exclude")"
for hook in "${hooks[@]}"; do
	install -m 0755 "$root/scripts/git-hooks/$hook" "$hooks_dir/$hook"
done

block="# >>> $marker
[Ss][Tt][Aa][Cc][Kk].[Mm][Dd]
[Pp][Ll][Aa][Nn].[Mm][Dd]
CLAUDE.local.md
/.design/
/.claude/settings.local.json
/.mcp.json
# <<< $marker"

touch "$exclude"
kept=$(awk -v start="# >>> $marker" -v end="# <<< $marker" \
	'$0 == start { skip = 1; next } $0 == end { skip = 0; next } !skip' "$exclude")
printf '%s\n%s\n' "$kept" "$block" | sed '/./,$!d' >"$exclude.tmp"
mv "$exclude.tmp" "$exclude"

printf 'prepare-local: installed %s hooks and private-file excludes\n' "${hooks[*]}"
