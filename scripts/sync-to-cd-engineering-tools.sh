#!/bin/bash
# usage: sync-to-cd-engineering-tools.sh <path to the cd-engineering-tools plugin folder>
set -e
src="$(cd "$(dirname "$0")/../plugins/agent-workflow" && pwd)"; dst="$1"
[ -f "$dst/.claude-plugin/plugin.json" ] || { echo "not a plugin folder: $dst" >&2; exit 2; }
for s in parallel-agents-coord phased-orchestration; do rm -rf "$dst/skills/$s"; cp -R "$src/skills/$s" "$dst/skills/$s"; done
mkdir -p "$dst/hooks"; cp "$src/hooks/context-handoff.mjs" "$src/hooks/context-handoff.test.mjs" "$src/hooks/hooks.json" "$dst/hooks/"
echo "copied 2 skills and the context-handoff hook into $dst; bump its plugin.json version, then publish"
