// Opus 4.7+, Sonnet 5.5, Fable and Haiku 5.5 get no token count from the API, so this reads the exact usage from the transcript.
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const THRESHOLD = 0.85
const TAIL_BYTES = 2 * 1024 * 1024

export function windowFor(model) {
  if (process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1') return 200_000
  const m = /(opus|sonnet|haiku|fable|mythos)-(\d)(?!\d)(?:-(\d)(?!\d))?/.exec(model ?? '')
  if (!m) return 200_000
  const [, family, major, minor = '0'] = m
  const version = Number(major) + Number(minor) / 10
  if (family === 'fable' || family === 'mythos') return 1_000_000
  if (family === 'haiku') return version >= 5.5 ? 1_000_000 : 200_000
  // shortcut: Opus/Sonnet 4.6 reach 1M only via [1m], which the transcript doesn't record, so they count as 200K (warns early, never late).
  return version >= 4.7 ? 1_000_000 : 200_000
}

export function lastUsage(jsonl, sidechain = false) {
  const lines = jsonl.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"usage"')) continue
    let entry
    try { entry = JSON.parse(lines[i]) } catch { continue }
    const { model, usage: u } = entry.message ?? {}
    if (entry.type !== 'assistant' || Boolean(entry.isSidechain) !== sidechain || !u || model === '<synthetic>') continue
    const tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0)
    return { model, tokens }
  }
  return null
}

export function subagentTranscript(sessionPath, agentId) {
  return join(dirname(sessionPath), basename(sessionPath, '.jsonl'), 'subagents', `agent-${agentId}.jsonl`)
}

function tail(path) {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const buf = Buffer.alloc(Math.min(size, TAIL_BYTES))
    readSync(fd, buf, 0, buf.length, size - buf.length)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export function warning(usage, subagent = false) {
  const window = windowFor(usage.model)
  const pct = usage.tokens / window
  if (pct < THRESHOLD) return null
  if (subagent) return `Your context is at ${Math.round(usage.tokens / 1000)}K of ${window / 1000}K tokens `
    + `(${Math.round(pct * 100)}%), past the ${THRESHOLD * 100}% point, and a subagent cannot hand off to a new chat. `
    + `Stop starting new work, finish or safely stop the step you are on, release every lock you hold, and end with a `
    + `report of what is done, what is not and the exact next step (return PARTIAL if your brief asked for DONE or PARTIAL).`
  return `Context is at ${Math.round(usage.tokens / 1000)}K of ${window / 1000}K tokens `
    + `(${Math.round(pct * 100)}%), past the ${THRESHOLD * 100}% handoff point. Stop starting new work, `
    + `follow your handoff rule if you have one (for example in ~/.claude/CLAUDE.md), and otherwise write the state and the exact next step to a handoff file `
    + `and print a prompt the user can paste into a new chat.`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  if (!input.transcript_path) process.exit(0)
  const sub = Boolean(input.agent_id)
  const path = sub ? subagentTranscript(input.transcript_path, input.agent_id) : input.transcript_path
  let usage
  try {
    usage = lastUsage(tail(path), sub) ?? lastUsage(readFileSync(path, 'utf8'), sub)
  } catch {
    process.exit(0)
  }
  const text = usage && warning(usage, sub)
  if (text) {
    console.log(JSON.stringify({
      hookSpecificOutput: { hookEventName: input.hook_event_name, additionalContext: text },
    }))
  }
}
