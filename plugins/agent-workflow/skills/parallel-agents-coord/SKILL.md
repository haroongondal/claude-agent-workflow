---
name: parallel-agents-coord
description: Use when facing 2 or more independent tasks (failing tests in different files, separate bugs, several reviews) that subagents could work on at once, when you are about to run several subagents in parallel inside ONE repo or worktree (subagent-driven development, a fix wave), when deciding whether tasks are independent, which run in parallel and how many agents to start, or when the owner asks to dispatch more agents at once. Keeps the speed-up without lost edits, mixed commits, polluted test runs or lost accuracy. Covers the independence test, how to dispatch, what coord can and cannot do between subagents, the filelock helper, the shared-file list, splitting shared files, agent prompts, communication, waiting without burning tokens, integrating results, fix waves, measured costs.
---

# Parallel agents in one worktree

Written from one measured session: Sieve, 2026-11-08, up to six agents live at once in one worktree on one branch, four parallel whole-branch reviewers, one two-agent fix wave. Sieve is the author's Chrome-extension project; its metrics files are not shipped with this skill. "About" marks an agent's own estimate.

## 1. coord does not separate subagents (verified)

Checked in the coord plugin, version 1.0.0 (`bin/coord` and `hooks/hooks.json`; the coord rules injected at session start print its path) and with a live probe on 2026-11-08:

- coord names a holder by Claude session id: the CLI uses `COORD_SID`, else `CLAUDE_CODE_SESSION_ID`; the hooks read `session_id` from their input. A subagent's shell carries its parent's `CLAUDE_CODE_SESSION_ID`. In the probe, a subagent's `coord claim` on a folder the parent already held exited 0 ("you have"), its Write passed the edit hook and was recorded as the parent's "(you)", and `coord wait` returned at once. Between subagents of one session there is no queue, no refused edit and no name to message.
- A made-up `COORD_SID` does not help. coord counts the caller as live during its own call, so the claim succeeds, and the next coord call by anyone else drops it because that id is not in `~/.claude/sessions`.
- The hooks are safe to leave on. The edit hook (Edit, Write, MultiEdit, NotebookEdit) claims each edited file for the session and refuses only when ANOTHER session holds that file or a folder above it. It never refuses a sibling.
- Gap between sessions: the Stop hook runs when the controller's turn ends (no SubagentStop hook is registered) and frees every file the session holds, even while background subagents are still editing them. Another session can take such a file in between. The subagent's next edit is then refused with that session's name. It must stop editing that file and report to the controller, not retry.
- Explicit coord commands from subagents are NOT free. Siblings share one queue entry, so one sibling's `coord release KEY` frees the key for all of them. A folder claim stays until someone releases it (only files are freed at Stop) and meanwhile refuses other sessions' edits under that folder. `coord wait` tells a subagent nothing.
- So subagents never run coord commands. The controller alone claims what other sessions must not touch (`coord claim device:<serial>`, an app folder) and releases it at the end. Between subagents, use `scripts/filelock`.

## 2. Plan the run (controller, before any dispatch)

First, is the work independent at all? Give one agent each problem that can be understood without the others' context: different test files with different root causes, separate subsystems, separate bugs. Do not split when:
- the failures are related (fixing one may fix the others: investigate them together first);
- you need the whole system's state to understand any of them;
- you do not yet know what is broken (exploratory debugging stays with one agent);
- the agents would edit the same code or use the same resource, and the table below gives no way to stagger them.

Decide for each task, and record it in the ledger:

| Run it | When |
|---|---|
| In parallel, freely | Read-only work (reviews, audits, read-only measurements) and work whose output is a NEW file (a plan draft, a new module). In Sieve, four whole-branch reviewers and a measurement ran at once with no contention, and a plan drafter finished while implementers queued. |
| In parallel, staggered | Implementers whose files are disjoint except files on the shared list. At most TWO of them in their shared-file phase at once. With four implementers in that phase, README waits reached 9 to about 14.5 minutes; the staggered two-agent fix wave had none for its code agent. |
| Alone | Chrome, perf, device and live-network runs; a task that needs another task's committed output (an interface, a generated file); tasks that rewrite the same functions. |

How many agents: the tasks that are ready now (their inputs are committed) and fit the table, capped at two in shared-file phases and one exclusive run. Count the reviews too: every implementation gets an independent review as its commit lands, and Sieve averaged one fix round per task. Start the rest as slots free.

How to dispatch: send all the Agent calls that may run together in ONE response. They then run concurrently; one call per response runs them one after another. Use fresh agents (`general-purpose`) with a prompt you write, so each starts with exactly the context it needs and your context stays free for coordination. A fork copies your whole context; use one only when the task needs it.

Then make the partition table: agent, OWNER name, owned files (only this agent edits them), shared files (two or more agents edit them, such as README, the main test runner, the build script, the manifest, `package.json` test lists, index files and handoff docs), and order (lock-free work first, shared edits last). Write the shared list to `<workspace>/shared-files.txt`, one absolute path per line, outside the lock folder, and give every agent its path.

If a file becomes shared mid-run (a second agent turns out to need a file that is not on the list), the controller appends it and messages every running agent whose task can touch it: "<path> is now shared; lock it before editing". An agent that needs a file on neither its own list nor the shared list stops, messages the controller, and works on something else until the answer comes.

## 3. Split shared files so locks last seconds

Whole-file locks on README.md and the main e2e file serialised the Sieve critical path; a 15-line README fix waited about 14.5 minutes. Turn each shared file into a registry that takes one line per task, and put the content in a file that task owns:

- Test runner. This is the pattern Sieve used (`apps/sieve/test/e2e.mjs:1593`). Each task adds `test/<feature>.mjs` exporting `run(ctx)`, and the only change to the shared runner is one line, added last under the lock:
  ```js
  for (const m of ['./ai-injection.mjs', './my-filters-regex.mjs']) await (await import(m)).run({ servers });
  ```
  The next task appends its module name to that array, so the lock is held for seconds, not for a whole task.
- Package test lists (this repo names each test file in the package's `package.json`): put a task's tests in a new `*.test.ts` and add its name in one final batch, or have the controller add all new names after the wave.
- README and handoff docs: each task writes its own `docs/parts/<task>.md`, and the controller merges the parts into README in one commit after the wave. (Untried in Sieve; only the test split was used.)
- Do not split a big existing file during a wave; that is a restructure with regression risk. Sieve's ruling R28 kept the 1,603-line e2e.mjs whole and sent only NEW checks to modules.

## 4. Locks (`scripts/filelock`)

The commands are `filelock acquire KEY OWNER [WAIT_S]` (exit 0 = yours, 3 = timed out; it prints the holder and age), `release KEY OWNER` (exit 4 = not yours), `break KEY` (controller only) and `status`. A lock is one symlink, made by one atomic call, whose target is the owner and start time. Two agents can never both win, and a killed acquire cannot leave a lock without an owner. (The earlier mkdir version left 43 ownerless locks in 300 `kill -9` tries, and each one blocked every later acquire forever.) Set `FILELOCK_ROOT=<workspace>/locks`. The script is `scripts/filelock` in this skill's folder (the skill loader prints the base directory); give agents its absolute path.

There is no automatic expiry, on purpose. There is no process to check: acquire exits at once, and all subagents share one Claude process. And legitimate holds ran about 16 minutes in Sieve. Agents can die mid-task (Sieve's Task 0.3 implementer died on an API error). When `status` shows a lock whose owner has returned or died, the controller runs `filelock break KEY`.

Rules for every agent:
1. Lock shared files by absolute path, one at a time, in alphabetical order (opposite orders deadlock). Keep WAIT_S at 540 or less, so the acquire returns exit 3 before the Bash tool's 600-second limit kills it.
2. Hold a shared-file lock only for the edit, a test of that edit and the pathspec commit. Release it right after the commit.
3. **Never run a long Chrome, perf, device or live run (over about a minute) while holding a shared-file lock.** Commit and release the shared files first, then take only the run lock. In Sieve one agent held README, e2e.mjs and six other files through an 8-minute-plus live YouTube run while three agents queued behind it.
4. For run locks, use the app folder as the KEY for anything that writes build output (`dist/`), and a separate key such as `chrome` or `device:<serial>` for runs that need the machine to themselves. If you need a run lock and file locks, take the run lock first.
5. Before ending your turn, or stopping to wait for a message, release every lock you hold (`filelock status` lists them). A lock held by a finished agent blocks everyone until the controller breaks it.

**Don't idle on a lock.** Try first: `filelock acquire KEY OWNER 1`. If it exits 3, note the key and carry on with work that does not depend on that file's final content: other files, tests in your own modules, reading, the report draft. Try again at the next natural break, and block with the full wait only when nothing else is left or the rest depends on the file. A try does not hold a place in line, so blocking waiters (they poll every 5 s) usually win. That costs only time you were using anyway.

## 5. Commits, reviews, gates

- Commit by pathspec only: `git commit -m "..." -- <your paths>`. Never use `git add -A`, and never commit a path you do not own or hold. Retry on `index.lock`. Every parallel commit in Sieve contained only its own agent's paths.
- Review each commit as `<sha>^..<sha>`, never `BASE..HEAD`, because commits interleave. Fix rounds resume the same implementer by SendMessage. Scoped re-reviews are read-only and run alongside the next implementer. Do not skip them: in Sieve a fix round that "passed" still let the perf gate pass on an early-exit path, and only the re-review caught it.
- When agents return: read each report, check that no two edited the same code, run the full suite once everything is committed, and spot-check the changes. An agent can make a systematic error, and "I fixed it" is a claim, not evidence.
- The shared tree is a shared test environment. Three Sieve runs failed or flickered because of other agents' uncommitted edits: a unit-test run, and two e2e gates at 148/149 and 156/157. A red or green result in the shared tree is a hint, not evidence.
- Run the final gate from a clean export of the committed HEAD, after every agent has committed: `git archive HEAD | tar -x -C <empty dir>`, install from the lockfile, then run the full gate there under the run lock, with nothing else using Chrome or the device. The Sieve gate ran this way alongside a read-only re-review; its one e2e flake (170/171) was not caused by anyone's uncommitted edits. Never build into the shared `dist/` while a gate or perf run reads it.

## 6. Communication

- At dispatch, give every agent: its OWNER name, its owned files, the shared-list path, the lock script path, the ids and OWNER names of the other running agents, its place in the stagger, and the report format. It must return the report as text: the harness refused a subagent's report-file write in Sieve ("subagents should return findings as text").
- Message the controller when you need a file on neither list, when a lock has been held for over 25 minutes (`status` shows the age), when your plan would change the shared list, or when you broke something another agent owns.
- Message another agent directly when you depend on its work. In Sieve, an implementer diagnosed a failing e2e check by asking the agent whose uncommitted files caused it. Say what you need and what you will do in the meantime.
- Running agents receive messages; Sieve sent the lock protocol to four running agents this way. A message to an agent that has finished resumes it with its whole context, which costs at least one turn, so only the controller resumes finished agents.
- No message is needed when you release a lock: blocking waiters pick it up within 5 s.
- End every report with: commit shas, files touched, shared files touched, locks still held (should be none), and anything still blocked and on whom.

## 7. Waiting and tokens

Tokens are spent per model turn, not per minute of waiting. Each turn re-reads the agent's context. In this skill's own check, a probe subagent with 6 tool calls reported 70,392 tokens, about 10k per turn.
- An agent blocked inside one tool call (a `filelock acquire` with a wait, a foreground build) spends nothing while it blocks, then one turn when the call returns.
- Polling (sleep, check, repeat, or repeated `status` calls) costs a full turn per check. Don't poll.
- Waiting for a message with nothing else to do: release your locks, then end your turn with `BLOCKED: waiting for <what> from <agent>`. That costs nothing until someone resumes you with SendMessage.
- After a pause longer than the prompt-cache lifetime (5 minutes by default), the first turn re-reads the context uncached, which costs more than a cached read. This was not measured in Sieve. It is a reason to batch waits, not to poll.
- The real cost of waiting is wall-clock time: per-agent lock waits of 6 to about 14.5 minutes were measured.

## 8. Fix wave while other agents still hold locks

Sieve's final fix wave started while a 31-minute YouTube measurement still held its folder lock. The wave's code agent had zero lock waits. Checklist:
1. Run `filelock status`. For each live holder, note what it is doing and when it expects to commit. Break only the locks of agents that have returned or died.
2. Group findings by file. A finding in a file that a running agent owns or holds goes to that agent by SendMessage, or waits for its commit. Do not give it to a new agent.
3. Split the remaining findings among fix agents with disjoint owned files. Add any file two of them need to the shared list, and message the running agents if that changes their list.
4. Base every fix agent on the latest commit, and tell it which running agents may still commit underneath it.
5. Lock-free fixes go first. Shared-file edits go last, in one short batch each, and new test checks go into new module files (section 3).
6. Count the running agents toward the limits of two agents in a shared-file phase and one exclusive run.
7. Run no gate in the shared tree while anyone has uncommitted work. The gate waits for the last commit and runs from a clean export.
8. Re-review each fix commit by its sha.

## 9. Dispatch paragraph (paste into every parallel implementer prompt; fill the blanks)

Besides this paragraph, each prompt needs four things, or the agent gets lost or wanders:
- One specific scope ("fix `agent-tool-abort.test.ts`", not "fix all the tests"), and the context pasted in: the failing test names and error messages, the files, what the code should do.
- A clear goal and the method you want ("find the root cause; do not just raise timeouts").
- Constraints ("change production code only in `src/abort/`", "do not touch other tests").
- The output you expect: a text report with the root cause, what changed and the commit shas.

"Other agents edit this same worktree and branch right now. Do not run coord commands: coord cannot tell subagents of one session apart. Lock helper: <ABS PATH>/filelock, with FILELOCK_ROOT=<LOCK DIR>. `filelock acquire KEY OWNER [WAIT_S, at most 540]` (exit 0 = yours, 3 = timed out, prints the holder), `filelock release KEY OWNER`, `filelock status`. Your OWNER is <name>. Your files: <owned>. Shared files, which you must lock before editing, are listed in <shared-files.txt>; re-read it before editing any file not in your list, and message the controller (<id>) before editing a file that is on neither list. Do lock-free work first. Edit shared files last, in one short batch, locking them in alphabetical order and holding each lock only until your pathspec commit (`git commit -m '...' -- <paths>`). If a lock is busy, retry with WAIT_S 1 and keep working on other things; block only when nothing else is left. Never hold a shared-file lock during a Chrome, perf, device or live run: commit and release first, then take only <RUN KEY>. Put new checks in new module files registered by one line. Other agents (id, OWNER): <list>. Release every lock before you end your turn. If you are blocked on another agent and have nothing else to do, end your turn with 'BLOCKED: <what> from <whom>'. Return the report as text, with commits, files touched, shared files touched and locks held (none)."

## 10. Controller ledger

- Record each agent's id, OWNER, dispatch time and commit sha, the tokens and duration from each completion notice, the lock waits agents report, rulings, and changes to the shared list.
- A completion notice fires each time an agent stops, so one task can notify more than once. Wait for the actual report.
- When something is slow, check `filelock status`. A long hold usually means a long run under shared-file locks.

## 11. Measured (Sieve, one Mac, Opus and Sonnet subagents; tokens are subagent_tokens from completion notices)

| What | Tokens | Agent time |
|---|---|---|
| Sequential Tasks 1.7 to 1.9 (implement, review, one fix round and re-review each) | 3,003,682 | 9,108 s |
| Task 1.7, implementer, sequential | 261,766 | 1,081 s |
| Task 1.10, implementer, parallel with three others | 274,698 | 1,170 s |
| Task 1.11, implementer (about 10 min of it waiting for README) | 288,065 | 1,934 s |
| Polish batch (about 10 min waiting for README and e2e.mjs) | 211,170 | 1,451 s |
| Fix wave A (code), staggered, zero lock waits | 325,653 | 1,394 s |
| Fix wave B (docs and tests) | 240,773 | 1,753 s |
| Four parallel whole-branch reviewers | 970,906 | |
| Perf script: 3 reviews and 2 fix rounds | 868,176 | |

- The sequential row is the sum of the metrics file's table. That file's own summary line ("about 2.80M, about 6,900 s") does not match its table.
- Cost per task did not visibly rise: compare 1.10 (parallel) with 1.7 (sequential). That is one pair, and "similar size" is the controller's judgement.
- Waiting stretched time, not obviously tokens. Measured waits: 1.12 waited 9 minutes on README behind 1.10. 1.12's fix round waited about 14.5 minutes for a 15-line README edit. 1.10's fix round waited about 11 minutes. The perf fix round waited 6 min 21 s on the folder lock behind a live YouTube run.
- Total spend rose because of the extra reviews, and they found real defects. The four whole-branch reviewers found three Important bugs that the per-task reviews missed: an allowlisted page entry switched off blocking for its whole site; the notification blocker denied sites the owner had allowed; and the settings page claimed a rebuild refreshes the lists. They also found unsupported claims in the docs. On the perf script, each review round found a real gate hole.
- Accuracy held: every task and every fix round was reviewed independently in both modes. Tasks needed one fix round in both modes, except the perf script (2) and the polish batch (0).
- Discovering the coord gap and switching to filelock cost the controller about 4 tool rounds and 4 messages.

## 12. Pitfalls seen

- A controller's instruction can be wrong; let implementers and reviewers check claims against the code. In Sieve, the controller's README wording about which list switch brings YouTube ads back was wrong, and the implementer's was right.
- Keep empirical checks in fix rounds. The polish implementer disproved a reviewer's claim by testing in real Chromium.
- The worktree guard refused compound shell lines, so run plain commands and write files with the Write tool. While this skill was being revised, a comment-count hook (at most 2 comment lines per edit) refused a script edit.
- For stronger isolation, when many files overlap or runs are long, give each agent its own git worktree on its own branch and merge in order: no lock waits and no contamination, at the price of merge conflicts in append-mostly files. Or use separate top-level sessions, where coord works as designed. Neither was measured in Sieve.

## 13. Phases too big for one context

If the work is split into phases that each fill most of a context window, use the `phased-orchestration` skill. A phase agent is the controller for sections 2 to 10 of this skill.
