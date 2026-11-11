---
name: parallel-agents-coord
description: Use when facing 2 or more independent tasks (failing tests in different files, separate bugs, several reviews) that subagents could work on at once, when you are about to run several subagents in parallel inside ONE repo or worktree (subagent-driven development, a fix wave), when deciding whether tasks are independent, which run in parallel and how many agents to start, or when the owner asks to dispatch more agents at once. This skill replaces superpowers:dispatching-parallel-agents: if that skill is listed or offered, use this one instead, because it covers shared files, locks, commits and integration, which that one does not. Keeps the speed-up without lost edits, mixed commits, polluted test runs or lost accuracy. Covers the independence test, how to dispatch, what coord can and cannot do between subagents, the filelock helper, the shared-file list, splitting shared files, agent prompts, communication, waiting without burning tokens, integrating results, fix waves, measured costs.
---

# Parallel agents in one worktree

Written from one measured session: Sieve, 2026-11-08, up to six agents live at once in one worktree on one branch, four parallel whole-branch reviewers, one two-agent fix wave. Sieve is the author's Chrome-extension project; its metrics files are not shipped with this skill. "About" marks an agent's own estimate. Revised 2026-11-11 after the claims were re-checked on a second workload ("the S1 check" below: four features, one shared registry file, one shared id counter and one simulated device; one run per mode, so these are single runs, not averages).

## 1. coord does not separate subagents (verified)

Checked in the coord plugin, version 1.0.0 (`bin/coord` and `hooks/hooks.json`; the coord rules injected at session start print its path) and with a live probe on 2026-11-08:

- coord names a holder by Claude session id: the CLI uses `COORD_SID`, else `CLAUDE_CODE_SESSION_ID`; the hooks read `session_id` from their input. A subagent's shell carries its parent's `CLAUDE_CODE_SESSION_ID`. In the probe, a subagent's `coord claim` on a folder the parent already held exited 0 ("you have"), its Write passed the edit hook and was recorded as the parent's "(you)", and `coord wait` returned at once. Between subagents of one session there is no queue, no refused edit and no name to message.
- A made-up `COORD_SID` does not help. coord counts the caller as live during its own call, so the claim succeeds, and the next coord call by anyone else drops it because that id is not in `~/.claude/sessions`.
- The hooks are safe to leave on. The edit hook (Edit, Write, MultiEdit, NotebookEdit) claims each edited file for the session and refuses only when ANOTHER session holds that file or a folder above it. It never refuses a sibling.
- Gap between sessions: the Stop hook runs when the controller's turn ends (no SubagentStop hook is registered) and frees every file the session holds, even while background subagents are still editing them. Another session can take such a file in between. The subagent's next edit is then refused with that session's name. It must stop editing that file and report to the controller, not retry.
- Stop-hook leak (coord 1.0.0 as installed): the Stop hook frees a file claim only if the path still exists when it runs. A claim on a file that was deleted or renamed during the turn, or never created because the write failed, stays until the claiming session closes and refuses every other session's edit of that path (seen live: four such claims, 6 to 100 hours old). The coord source now frees every claim the edit hook made; until that version is installed, after a wave run `coord status` and `coord release <path>` for each path you still hold that no longer exists.
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
| In parallel, staggered | Implementers whose files are disjoint except files on the shared list. At most TWO of them in their shared-file phase at once, when shared-file holds are long (see "Enforcing the cap" below). With four implementers in that phase, README waits reached 9 to about 14.5 minutes; the staggered two-agent fix wave had none for its code agent. |
| Alone | Chrome, perf, device and live-network runs (the run itself: hold the run key for the run, not for the whole task, so a 3-second flash inside a task is a run-key step); a task that needs another task's committed output (an interface, a generated file); tasks that rewrite the same functions. |

How many agents: the tasks that are ready now (their inputs are committed) and fit the table. **Hard ceiling: at most 10 agents alive at once, implementers, reviewers and helpers together.** Do not start an 11th; start it when one finishes. Below that ceiling the table limits apply: at most two in a shared-file phase when holds are long, and one exclusive run. Reviews count toward the 10, so plan them (section 5): review the risky commits only, not every commit. Sieve's first policy (every commit reviewed, scoped re-reviews of every fix) averaged one fix round per task and put about half of one phase's tokens into reviewers.

How to dispatch: send all the Agent calls that may run together in ONE response. They then run concurrently; one call per response runs them one after another. Use fresh agents (`general-purpose`) with a prompt you write, so each starts with exactly the context it needs and your context stays free for coordination. A fork copies your whole context; use one only when the task needs it.

Then make the partition table: agent, OWNER name, owned files (only this agent edits them), shared files (two or more agents edit them, such as README, the main test runner, the build script, the manifest, `package.json` test lists, index files and handoff docs), pre-assigned ids, slots and sequence numbers (next paragraph), and order (lock-free work first, shared edits last). Write the shared list to `<workspace>/shared-files.txt`, one absolute path per line, outside the lock folder, and give every agent its path.

Ids, slots and sequence numbers. A counter that every task bumps (`nextId` in a manifest, a migration number), a device slot or a port is a shared resource that no file split removes. Where the values are known at dispatch, put them in the partition table and give each agent its own block (agent A ids 6-8 and slot 1, agent B ids 9-11 and slot 2): then no lock is needed for them. Only when they cannot be known in advance take a lock, and hold it for the read, the bump and the commit, nothing else. (S1 check: unassigned ids and slots worked under locks, and the manifest lock was the longest queue.)

Enforcing the cap of two. The number comes from Sieve's README holds of minutes. To enforce it, use two slot locks, `phase-slot-1` and `phase-slot-2`: before locking any shared file an agent tries each with WAIT_S 0, does other work if both are taken, then blocks; it releases the slot after releasing its shared-file locks. Slots add waiting: in the S1 check shared-file holds were 3 to 22 s (once 73 s), and two agents queued 61 s and 86 s for a slot while the file locks themselves were free. Use the cap when `filelock status` shows shared-file holds over about a minute; otherwise leave it out and rely on short holds (section 4, rule 2).

If a file becomes shared mid-run (a second agent turns out to need a file that is not on the list), the controller appends it and messages every running agent whose task can touch it: "<path> is now shared; lock it before editing". An agent that needs a file on neither its own list nor the shared list stops and works on something else; it reaches the controller by message if it has a way to, otherwise by ending its turn with `BLOCKED: need <file>` (a subagent may have no address for the controller).

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
- A registry can need two edit sites (an import line at the top and an entry in the object): make both in the same locked batch. A counter cannot be split into per-task files: pre-assign blocks (section 2), or let each task leave a fragment file and have the controller merge them after the wave.
- Edit a shared structured file (JSON, config) in place with the smallest text change; never regenerate or reformat it. In the S1 check 5 of 8 agents rewrote the whole manifest, which reformatted it for everyone, and 2 of them had to undo it.

## 4. Locks (`scripts/filelock`)

The commands are `filelock acquire KEY OWNER [WAIT_S, default 100]` (exit 0 = yours, 3 = timed out; it prints the holder and age), `release KEY OWNER` (exit 4 = not yours), `break KEY` (controller only) and `status`. A lock is one symlink, made by one atomic call, whose target is the owner and start time. Two agents can never both win, and a killed acquire cannot leave a lock without an owner. (The earlier mkdir version reportedly left 43 ownerless locks in 300 `kill -9` tries; that script is not shipped, so the figure is unchecked. In the S1 check a reconstructed mkdir lock left 30 in 300, and this symlink version left 0 in 300 and 0 in 200 after the key changes below. A kill after the symlink call still leaves a lock held by a dead owner; that one needs `break`.) Set `FILELOCK_ROOT=<workspace>/locks`. `scripts/filelock.test.sh` is the self-check.

KEY is an absolute file path or a plain name without `/` (`chrome`, `device:<serial>`). The script normalises `//`, `.`, `..` and symlinked directories to one key, refuses a relative path that contains `/` (exit 2), hashes keys over 200 characters, and `status` prints the real key. Before this, `/x/a/b` and `/x/a_b` shared one lock, `/x/y/../a` and `/x/a` shared none, and in the S1 check an agent locked the manifest under the relative key `assets/manifest.json`, which excluded nobody. Give every agent its own OWNER: two agents with the same OWNER do not exclude each other. The script is `scripts/filelock` in this skill's folder (the skill loader prints the base directory); give agents its absolute path.

There is no automatic expiry, on purpose. There is no process to check: acquire exits at once, and all subagents share one Claude process. And legitimate holds ran about 16 minutes in Sieve. Agents can die mid-task (Sieve's Task 0.3 implementer died on an API error). When `status` shows a lock whose owner has returned or died, the controller runs `filelock break KEY`. `status` ages are in seconds under two minutes and whole minutes after, and cannot tell a dead owner from a slow one: decide from the completion notices. After a session crash or restart the locks of the killed agents stay (S1 attempt 1 left `device:s1-sim` and `phase-slot-1` held for 53 minutes): run `status`, then `break` each one you know is dead.

Rules for every agent:
1. Lock shared files by absolute path, one at a time, in alphabetical order (opposite orders deadlock). Keep WAIT_S at 100 or less. A longer wait needs the Bash call run with `timeout: 600000` (the maximum) and WAIT_S at 540 or less: the Bash tool's default timeout is 120 s, and a foreground acquire that outlasts it is moved to the background, keeps polling, and can win the lock later without the agent noticing.
2. Hold a shared-file lock only for the edit, a test of that edit and the pathspec commit. Release it right after the commit. If you are still holding after about 60 s, commit or undo your edit, release, and queue again. Report how long you held each lock.
3. **Never run a long Chrome, perf, device or live run (over about a minute) while holding a shared-file lock.** Commit and release the shared files first, then take only the run lock. In Sieve one agent held README, e2e.mjs and six other files through an 8-minute-plus live YouTube run while three agents queued behind it.
4. For run locks, use the app folder as the KEY for anything that writes build output (`dist/`), and a separate key such as `chrome` or `device:<serial>` for runs that need the machine to themselves. If you need a run lock and file locks, take the run lock first.
5. Before ending your turn, or stopping to wait for a message, release every lock you hold (`filelock status` lists them). A lock held by a finished agent blocks everyone until the controller breaks it.

**Don't idle on a lock.** Try first: `filelock acquire KEY OWNER 0` (returns at once). If it exits 3, note the key and carry on with work that does not depend on that file's final content: other files, tests in your own modules, reading, the report draft. Try again at the next natural break, and block with the full wait only when nothing else is left or the rest depends on the file. A try does not hold a place in line, so blocking waiters (they poll every 5 s) usually win. That costs only time you were using anyway.

## 5. Commits, reviews, gates

- Commit by pathspec only: `git add -- <your new paths>` first (a pathspec commit fails on a path git does not know yet), then `git commit -m "..." -- <your paths>`. Never use `git add -A`, and never commit a path you do not own or hold. Retry on `index.lock`. Every parallel commit in Sieve contained only its own agent's paths.
- In the shared tree never run `git checkout`, `git restore`, `git stash`, `git reset` or `git clean` on a shared path or the whole tree: they throw away other agents' uncommitted edits. Undo your own edit by editing it back. (S1 check: one agent ran `git checkout` on the shared manifest to drop its own bad rewrite; it was safe only because the others' entries were already committed.)
- Reviews are the biggest avoidable cost, so spend them where they pay. Review a commit as `<sha>^..<sha>`, never `BASE..HEAD`, because commits interleave.
  1. Default: no per-task reviewer. Accept a task when its own tests pass and the controller has checked `git show --stat <sha>` (only its files changed) and re-run the tests named in its report.
  2. Review only risky commits: data loss or completeness logic, security or privacy code, code that reads page data or runs in a trusted context, and any gate or test whose job is to be able to fail. Use the strongest model for those and a cheaper one for the rest.
  3. Batch: one reviewer per wave, given all the shas that need review together, with the plan text, the reports and the rule "Important or Minor only; correctness, contract breaks, security, tests that cannot fail". Minors go to the ledger and are fixed in one batch at phase close, never per task.
  4. At most one fix round per task, for Important findings only; resume the same implementer by SendMessage and require a test that fails without the fix.
  5. Re-review only a fix that touches a risky area (item 2); scoped, read-only, one re-reviewer per wave. Otherwise the controller checks the diff stat and the named tests. Do not drop this for a gate or test fix: in Sieve a fix round that "passed" still let the perf gate pass on an early-exit path, and only the re-review caught it.
  6. Keep the clean-export gate and one whole-branch review at phase close (two lenses are enough: core and runtime, and UI); the Sieve whole-branch reviewers found three Important bugs that every per-task review had missed.
  7. Log each review as reviewed, controller-checked or skipped, with its tokens, and report reviewer tokens as a share of the phase total. Sieve Phase 2 under the earlier every-commit policy: 19 review runs, about 2.47M of about 4.9M phase tokens (about half; about 35% if the resumed-agent notices are not cumulative). These are the controller's own sums from completion notices, not an audit.
- When agents return: read each report, check that no two edited the same code, run the full suite once everything is committed, and spot-check the changes. An agent can make a systematic error, and "I fixed it" is a claim, not evidence.
- The shared tree is a shared test environment. Three Sieve runs failed or flickered because of other agents' uncommitted edits: a unit-test run, and two e2e gates at 148/149 and 156/157. A red or green result in the shared tree is a hint, not evidence.
- Run the final gate from a clean export of the committed HEAD, after every agent has committed: `git archive HEAD | tar -x -C <empty dir>`, install from the lockfile, then run the full gate there under the run lock, with nothing else using Chrome or the device. The Sieve gate ran this way alongside a read-only re-review; its one e2e flake (170/171) was not caused by anyone's uncommitted edits. Never build into the shared `dist/` while a gate or perf run reads it.

## 6. Communication

- At dispatch, give every agent: its OWNER name, its owned files, the shared-list path, the lock script path, the OWNER names of the other running agents (their agent ids do not exist yet when all Agent calls go out in one response; send ids later only if an agent has to message one), its block of ids and slots, its place in the stagger if you use one, and the report format. It must return the report as text: the harness refused a subagent's report-file write in Sieve ("subagents should return findings as text").
- A subagent may have no way to message the controller. Then it ends its turn with `BLOCKED: need <file>` (or the reason) and the controller answers by resuming it. Where messaging works, message the controller when you need a file on neither list, when a run lock has been held for over 25 minutes (`status` shows the age), when your plan would change the shared list, or when you broke something another agent owns.
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
- The real cost of waiting is wall-clock time: per-agent lock waits of 6 to about 14.5 minutes were measured in Sieve.
- Tokens in a completion notice are not money. They leave out cache reads, and every extra turn (a retry, a lock poll, a re-check) re-reads the whole context from cache. In the S1 check the skill rules cost +3.4% notice tokens but +91% turns, 1.97 times the tokens actually processed and +40% dollars. Compare modes in dollars or total tokens including cache reads.

## 8. Fix wave while other agents still hold locks

Sieve's final fix wave started while a 31-minute YouTube measurement still held its folder lock. The wave's code agent had zero lock waits. Checklist:
1. Run `filelock status`. For each live holder, note what it is doing and when it expects to commit. Break only the locks of agents that have returned or died.
2. Group findings by file. A finding in a file that a running agent owns or holds goes to that agent by SendMessage, or waits for its commit. Do not give it to a new agent.
3. Split the remaining findings among fix agents with disjoint owned files. Add any file two of them need to the shared list, and message the running agents if that changes their list.
4. Base every fix agent on the latest commit, and tell it which running agents may still commit underneath it.
5. Lock-free fixes go first. Shared-file edits go last, in one short batch each, and new test checks go into new module files (section 3).
6. Count the running agents toward the ceiling of 10 alive at once, and toward the limits of two agents in a shared-file phase and one exclusive run.
7. Run no gate in the shared tree while anyone has uncommitted work. The gate waits for the last commit and runs from a clean export.
8. Re-review a fix commit by its sha only when it touches a risky area (section 5); otherwise check its diff stat and tests.

## 9. Dispatch paragraph (paste into every parallel implementer prompt; fill the blanks)

Besides this paragraph, each prompt needs four things, or the agent gets lost or wanders:
- One specific scope ("fix `agent-tool-abort.test.ts`", not "fix all the tests"), and the context pasted in: the failing test names and error messages, the files, what the code should do.
- A clear goal and the method you want ("find the root cause; do not just raise timeouts").
- Constraints ("change production code only in `src/abort/`", "do not touch other tests").
- The output you expect: a text report with the root cause, what changed and the commit shas.

"Other agents edit this same worktree and branch right now. Do not run coord commands: coord cannot tell subagents of one session apart. Lock helper: <ABS PATH>/filelock, with FILELOCK_ROOT=<LOCK DIR>. `filelock acquire KEY OWNER [WAIT_S, default 100; for a wait over 100 run the Bash call with timeout 600000 and use at most 540]` (exit 0 = yours, 3 = timed out, prints the holder), `filelock release KEY OWNER`, `filelock status`. KEY is always the absolute path exactly as in the shared list, never a relative path. Your OWNER is <name>; it is unique to you. Your files: <owned>. Your ids and slots: <block, or: take them under the lock>. Shared files, which you must lock before editing, are listed in <shared-files.txt>; re-read it before editing any file not in your list, and if you need a file that is on neither list, stop and end your turn with 'BLOCKED: need <file>'. Do lock-free work first. Edit shared files last, in one short batch, locking them in alphabetical order and holding each lock only until your pathspec commit (`git add -- <your new paths>`, then `git commit -m '...' -- <paths>`), at most about 60 s. Edit shared JSON or config in place with the smallest text change; never regenerate or reformat it. Never run git checkout, restore, stash, reset or clean in this shared tree. If a lock is busy, retry with WAIT_S 0 and keep working on other things; block only when nothing else is left. Never hold a shared-file lock during a Chrome, perf, device or live run: commit and release first, then take only <RUN KEY>. [Only if you use the cap of two: before locking any shared file take `phase-slot-1` or `phase-slot-2` (try each with WAIT_S 0, then block) and release it after releasing your shared-file locks.] Put new checks in new module files registered by one line. Other agents (OWNER): <list>. Release every lock before you end your turn. If you are blocked on another agent and have nothing else to do, end your turn with 'BLOCKED: <what> from <whom>'. Return the report as text, with commits, files touched, shared files touched, how long you waited for and held each lock, and locks held (none)."

## 10. Controller ledger

- Record each agent's id, OWNER, dispatch time and commit sha, the tokens and duration from each completion notice, the lock waits agents report, rulings, and changes to the shared list.
- A completion notice fires each time an agent stops, so one task can notify more than once. Wait for the actual report.
- When something is slow, check `filelock status`. A long hold usually means a long run under shared-file locks.

## 11. Measured

### Sieve (unverified: the metrics files are not shipped; one Mac, Opus and Sonnet subagents; tokens are subagent_tokens from completion notices, which leave out cache reads)

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
- Waiting stretched time, and in notice tokens not obviously tokens (in dollars it does cost: section 7 and the S1 check below). Measured waits: 1.12 waited 9 minutes on README behind 1.10. 1.12's fix round waited about 14.5 minutes for a 15-line README edit. 1.10's fix round waited about 11 minutes. The perf fix round waited 6 min 21 s on the folder lock behind a live YouTube run.
- Total spend rose because of the extra reviews, and they found real defects. The four whole-branch reviewers found three Important bugs that the per-task reviews missed: an allowlisted page entry switched off blocking for its whole site; the notification blocker denied sites the owner had allowed; and the settings page claimed a rebuild refreshes the lists. They also found unsupported claims in the docs. On the perf script, each review round found a real gate hole.
- Accuracy held: every task and every fix round was reviewed independently in both modes. Tasks needed one fix round in both modes, except the perf script (2) and the polish batch (0).
- Discovering the coord gap and switching to filelock cost the controller about 4 tool rounds and 4 messages.

### S1 check (2026-11-11; one run per arm, Sonnet 5.5 subagents, four features in one repo; single runs, not averages)

Four agents, one feature each, all started in one response. Shared: a registry file, a manifest with a `nextId` counter, one simulated device (3 s flash, a second concurrent flash is refused). Arm 1: plain subagents, no rules. Arm 2: this skill's rules (filelock on the registry and the manifest, device run key, pathspec commits) plus a cap of two in the shared phase.

| | plain | skill rules |
|---|---|---|
| grader score | 74/74 | 74/74 |
| slowest agent (about the wall time) | 74.5 s | 171.1 s |
| duplicate asset ids, final | 0 | 0 |
| lost edits | 1 (a registry import, repaired by the agent) | 0 seen |
| broken shared state seen between writes | registry entry without its import for about 4 s; manifest id gap for about 18 s | none |
| device BUSY refusals | 3 | 0 |
| agent commits | 0 (all left uncommitted) | 10, pathspec |
| turns | 32 | 61 |
| notice tokens | 294,545 | 304,438 (+3.4%) |
| tokens processed incl. cache reads | 2,153,733 | 4,244,439 |
| model cost | $1.28 | $1.80 (+40%) |

Lock waits in arm 2: slot 61 s and 86 s, manifest 80 s and 20 s, registry 5 s, device 0; holds 3 to 22 s except one agent's 73 s on the manifest and registry. The final result was the same; the rules bought clean intermediate states and per-agent commits for about 2.3 times the wall time and 1.4 times the cost on this short task. Whether that trade pays on a longer task is not measured.

## 12. Pitfalls seen

- A controller's instruction can be wrong; let implementers and reviewers check claims against the code. In Sieve, the controller's README wording about which list switch brings YouTube ads back was wrong, and the implementer's was right.
- Keep empirical checks in fix rounds. The polish implementer disproved a reviewer's claim by testing in real Chromium.
- The worktree guard refused compound shell lines, so run plain commands and write files with the Write tool. While this skill was being revised, a comment-count hook (at most 2 comment lines per edit) refused a script edit.
- For stronger isolation, when many files overlap or runs are long, give each agent its own git worktree on its own branch and merge in order: no lock waits and no contamination, at the price of merge conflicts in append-mostly files. Or use separate top-level sessions, where coord works as designed. Neither was measured in Sieve.

## 13. Phases too big for one context

If the work is split into phases that each fill most of a context window, use the `phased-orchestration` skill. A phase agent is the controller for sections 2 to 10 of this skill.
