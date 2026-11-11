---
name: phased-orchestration
description: Use when a build is split into big phases that each fill most of one context window (for example three phases of about 95% of a 1M window), when the main session should hand each phase to a phase agent that dispatches its own implementers and reviewers, or when asked whether subagents can spawn subagents. Covers how deep nesting goes, the main session, phase agent and worker layout, the per-run task cap with PARTIAL and resume, and a phase-brief template. For the locks, shared files and commit rules inside a phase, it points to the parallel-agents-coord skill.
---

# Phases too big for one context: phase agents

Inside a phase, the phase agent follows the `parallel-agents-coord` skill (sections 1 to 10) as its controller. This skill only adds the layer above it: main session, phase agent, workers.

Verified with a probe on 2026-11-08:
- Agents the main session spawns (level 1) and their children (level 2) have the Agent tool. Level 3 has none: it can work but cannot spawn. That allows main session → phase agent → implementers and reviewers → leaf helpers, and no deeper.
- A child's result comes back as a hand-back message. The parent waits for it without spending tokens. The main session is notified when a phase agent stops with no live children of its own.
- Every level shares the main session's id, so coord sees one holder. Use `filelock` at every level, with one FILELOCK_ROOT per phase.
- Each agent pays a fixed start-up cost: three trivial probe agents used 70,392, 72,239 and 73,560 tokens for 3 to 6 tool calls each.
- Write prompts at run time and use `subagent_type: general-purpose`; no agent .md files are needed. Never use a fork as a phase agent, because a fork copies the parent's whole context.

Layout:
- **Main session.** Writes the phase brief to a file and starts ONE phase agent. It waits for that agent's report, then checks the phase itself (a clean-export gate, section 5) and updates `docs/handoffs/<app>.md` before starting the next phase. Its context holds only briefs and reports.
- **Phase agent.** Orchestrates only: it never implements and never reads whole diffs or logs. It is "the controller" in sections 2 to 10, keeps its ledger in a file, and returns a short report.
- **Implementers and reviewers (level 2).** They do the work, and may spawn level-3 helpers for searches or narrow checks.

A phase agent's context still grows with every brief it writes and every report it reads; Sieve's orchestrator, working this way, needed four sessions for one plan. A subagent also cannot use the owner's new-chat handoff. The 85% warning comes from the `context-handoff` hook (PostToolUse and UserPromptSubmit), which ships in this plugin as `hooks/context-handoff.mjs`. Without that hook, only the task cap protects a phase agent. The hook covers subagents too: it reads the subagent's own transcript, `<session>/subagents/agent-<agent_id>.jsonl` (the hook's `transcript_path` is the parent's file), and sends a subagent-specific text: stop new work, release locks, end with a report of done, not done and the exact next step. Tested with the threshold set to 1%: an agent making sequential tool calls got the text after its second and third calls. Limits: it arrives one call late, was not seen for two tool calls sent in parallel in one turn, and is advice the agent may ignore. The task cap below stays the main guard. The main session follows its own handoff rule (handoff file, resume prompt, new chat); phase ledgers plus `docs/handoffs/<app>.md` make that cheap. So:
1. The brief caps each run: "dispatch at most N tasks, then stop". Choose N so that each task's cycle (brief, implementer report, review, fix, re-review) fits in the context several times over.
2. At the cap, when blocked, or when finished, the phase agent returns DONE or PARTIAL, with the ledger path, the exact next step, and the locks it still holds (none).
3. On PARTIAL, the main session starts a fresh phase agent: "Resume from <ledger>. Trust its verified facts, do not redo them, and continue from its next step."

Agent ceiling: no controller keeps more than 10 agents alive at once. When the main session runs several phase agents together, it gives each phase its share (<K> in the brief) so the total stays within the owner's limit; the owner's number wins over 10.

Phase brief template. The main session fills it in, saves it as `<workspace>/phase-N-brief.md`, and passes the path:

"You orchestrate Phase N of <app>. You implement nothing yourself. Read <plan path>, section <X>, and the handoff <path>. Hard rules: <AGENTS.md path and key constraints>. Load the `parallel-agents-coord` skill with the Skill tool, read sections 1 to 10, and follow it as the controller; paste its section 9 paragraph into every implementer prompt. Decide which tasks run in parallel, staggered or alone; keep the shared-file list at <workspace>/shared-files.txt and locks at FILELOCK_ROOT=<workspace>/locks; spawn general-purpose implementers and reviewers with briefs you write to files, with at most <K> agents alive at once (10 at most, reviewers included); review only risky commits, batched, as section 5 says (everything else is accepted on its tests and a diff-stat check). Keep your ledger at <workspace>/progress.md and update it after every agent report. Dispatch at most <N> tasks in this run. Return DONE when every task in the phase is committed and reviewed and the clean-export gate passes; return PARTIAL when you reach the cap or are blocked. Final report, as text: DONE or PARTIAL; commits; the gate result with its command; open findings; the ledger path; the exact next step; locks held (must be none)."

Not verified: whether a subagent compacts automatically when its window fills (the task cap is the safeguard), and how permission prompts behave for agents two levels down running in the background. Run a small phase first.
