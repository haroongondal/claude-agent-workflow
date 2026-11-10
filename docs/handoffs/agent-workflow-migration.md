# Handoff: moving coord, the parallel-agent skills and the context hook to their own project

Last updated 2026-11-10.

## Resume prompt

Read this file completely first. Trust the verified facts below and do not redo that work. Follow the handoff rule in `~/.claude/CLAUDE.md`. Then continue from "Current state and next step".

## Goal and fixed constraints

- Skills `parallel-agents-coord` and `phased-orchestration`, the `context-handoff` hook and the `coord` plugin live in this repo (`~/Documents/claude-agent-workflow`, private GitHub `haroongondal/claude-agent-workflow`), not in `~/.claude` and not in apps-hub.
- The skills and hook reach teammates through the CD Engineering Tools plugin. coord stays out of that plugin: its hooks refuse other sessions' edits.
- No attribution lines in commits. Commit or push only when the owner asks.
- Several Claude sessions run against apps-hub at once. Do not delete a plugin cache directory a live session may use.

## Decisions

- Two plugins in one marketplace (`claude-agent-workflow`): `coord` and `agent-workflow` (skills plus hook). Install only `coord` locally. `agent-workflow` is the source for the CD Engineering Tools copy, and installing it too would run the skills and hook twice.
- Repo is private. apps-hub is public, so a clone of apps-hub cannot fetch this marketplace unless the repo is made public.
- The hook's main-session warning no longer points at `~/.claude/CLAUDE.md` alone, because teammates do not have it.

## Verified facts

- `coord@claude-agent-workflow` is installed at user scope and project scope (apps-hub). Queues in `~/.claude/coord/queues.json` carried over.
- `cd-engineering-tools@claudeai-organization-library` is installed at user scope and takes precedence over the old `cd-engineering-tools@synced` copy. It contains both skills, the hook and `filelock` with its executable bit.
- Synced plugins from claude.ai cannot be uninstalled by the CLI. `cas-integration@synced` and `channel-dynamics-design@synced` are disabled on this machine. CD Engineering Tools provides `integrating-with-cas` and `channel-dynamics-ui`.
- Deleted by owner's request: superpowers `dispatching-parallel-agents` in the 7.0.0 and 6.4.1 caches. A superpowers update restores it. Its useful content (independence test, one-response dispatch, prompt checklist, integration step) is now in `parallel-agents-coord` sections 2, 5 and 9.
- Tests: `python3 plugins/coord/bin/coord_test.py` (5), `node --test plugins/agent-workflow/hooks/context-handoff.test.mjs` (5).

## File map

- `plugins/coord/` coord CLI, protocol, hooks, tests.
- `plugins/agent-workflow/skills/` the two skills. `plugins/agent-workflow/hooks/` hook, test, `hooks.json`.
- `scripts/sync-to-cd-engineering-tools.sh <folder>` copies skills and hook into the plugin folder.
- Published copy: `~/Documents/cd-engineering-tools` (no git).

## Session log

- 2026-11-10: moved everything here, published CD Engineering Tools 0.2.0, switched coord to the new marketplace, removed the global skill and hook copies. Then added the missing instructions to `parallel-agents-coord` (agent-workflow 1.0.1, CD Engineering Tools 0.2.1).

## Current state and next step

- Old GitHub repo `haroongondal/claude-coord` still exists. The token lacks `delete_repo`. Owner runs `gh auth refresh -h github.com -s delete_repo && gh repo delete haroongondal/claude-coord --yes`.
- Open question for the owner: whether apps-hub's own `.claude/agents` (11), `.claude/skills` (7) and `.claude/rules` (2) should also move here. They are written for apps-hub (its AGENTS.md rules). Not moved.
- Old coord cache `~/.claude/plugins/cache/claude-coord/` is left for Claude Code to clean up once live sessions end.
- To change the skills or hook: edit here, run the tests, run the sync script, bump both plugin versions, publish `~/Documents/cd-engineering-tools` with PublishPlugin (`replace: true`), then `claude plugin update cd-engineering-tools@claudeai-organization-library`.
