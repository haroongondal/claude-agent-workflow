# claude-agent-workflow

Tools for running several Claude Code sessions and subagents at once. A marketplace with two plugins.

## coord

Several Claude Code sessions on one machine take turns on the same file, folder, app or device, using one queue per resource in `~/.claude/coord/queues.json`. A `PreToolUse` hook claims each file a session edits and refuses the edit when another session holds it. A `Stop` hook frees the files when the turn ends, and a `SessionStart` hook injects the rules ([PROTOCOL.md](plugins/coord/PROTOCOL.md)). Devices, apps and folders are claimed with `coord claim`. Subagents of one session share the session's id, so coord cannot separate them; use the filelock helper below between subagents.

| Command | What it does |
| --- | --- |
| `coord claim KEY [note]` | Take KEY, or join its queue. Exit 0 means it is yours; exit 3 means you are queued. |
| `coord wait KEY` | Block until KEY is yours. Run it in the background. |
| `coord release KEY` | Leave KEY's queue and say who has it next. |
| `coord lend KEY [note]` | Let the next session borrow KEY while you wait on it. |
| `coord back KEY` | End the loan, then `coord wait KEY` until the borrower gives it back. |
| `coord yield KEY` | Give a borrowed KEY back and rejoin the end of the queue. |
| `coord status [KEY]` | Show the queues. |

KEY is a path, `device:<id>` or `app:<package>`. Limits: macOS and Linux only (`fcntl`), needs `python3`, reads Claude Code's internal `~/.claude/sessions/*.json` (if that format changes, coord stops refusing instead of blocking every edit), and does not check `adb` or `xcrun` commands.

## agent-workflow

- **`parallel-agents-coord` skill.** Running several subagents in one repo: what coord cannot do between subagents, planning and the shared-file list, splitting shared files, the dispatch paragraph, fix waves, measured costs. Ships `scripts/filelock`, an atomic symlink lock (`acquire`, `release`, `break`, `status`).
- **`phased-orchestration` skill.** A build split into phases that each fill a context window: main session, phase agent, workers, a per-run task cap with PARTIAL and resume, and a phase-brief template.
- **`context-handoff` hook.** Warns at 85% of the context window, for the main session and for subagents (it reads the subagent's own transcript).

## Install

```bash
claude plugin marketplace add haroongondal/claude-agent-workflow
claude plugin install coord@claude-agent-workflow --scope user
```

`agent-workflow@claude-agent-workflow` installs the skills and hook the same way. Do not install `agent-workflow` if the same skills and hook already come from another plugin: they would run twice.

The skills and hook are also published in the CD Engineering Tools plugin. After changing them here, run `scripts/sync-to-cd-engineering-tools.sh <that plugin's folder>`, bump its version and publish it.

## Tests

```bash
python3 plugins/coord/bin/coord_test.py
node --test plugins/agent-workflow/hooks/context-handoff.test.mjs
```

## License

MIT
