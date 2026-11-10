import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lastUsage, subagentTranscript, warning, windowFor } from './context-handoff.mjs'

test('windowFor maps model ids to their context window', () => {
  for (const id of ['claude-opus-5-5', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-sonnet-5-5',
    'claude-haiku-5-5', 'claude-fable-5-1', 'claude-mythos-5']) assert.equal(windowFor(id), 1_000_000, id)
  for (const id of ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001',
    'claude-opus-4-20250514', 'claude-3-5-sonnet-20241022', 'claude-3-sonnet-20240229', 'gateway-alias', undefined])
    assert.equal(windowFor(id), 200_000, String(id))
})

test('lastUsage sums the last main-chat assistant usage and skips the rest', () => {
  const line = (o) => JSON.stringify(o)
  const usage = { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: 849_000, output_tokens: 300 }
  const jsonl = [
    line({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 5 } } }),
    line({ type: 'assistant', message: { model: 'claude-opus-5-5', usage } }),
    line({ type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-5-5', usage: { input_tokens: 9 } } }),
    line({ type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 0 } } }),
    line({ type: 'user', message: { content: 'has "usage" in text' } }),
    '{"type":"assistant","message":{"usage"', // a line cut off by the tail read
  ].join('\n')
  assert.deepEqual(lastUsage(jsonl), { model: 'claude-opus-5-5', tokens: 850_302 })
  assert.equal(lastUsage('{"type":"user"}'), null)
})

test('lastUsage reads only subagent entries when asked, and subagentTranscript finds the file', () => {
  const line = (o) => JSON.stringify(o)
  const jsonl = [
    line({ type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-5-5', usage: { input_tokens: 4, cache_read_input_tokens: 700 } } }),
    line({ type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-5-5', usage: { input_tokens: 5, cache_read_input_tokens: 900, output_tokens: 1 } } }),
    line({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 99 } } }),
  ].join('\n')
  assert.deepEqual(lastUsage(jsonl, true), { model: 'claude-haiku-5-5', tokens: 906 })
  assert.deepEqual(lastUsage(jsonl), { model: 'claude-opus-5-5', tokens: 99 })
  assert.equal(subagentTranscript('/p/proj/abc-123.jsonl', 'a1b2'), '/p/proj/abc-123/subagents/agent-a1b2.jsonl')
})

test('a subagent warning says it cannot hand off and asks for a report', () => {
  assert.equal(warning({ model: 'claude-haiku-5-5', tokens: 849_999 }, true), null)
  const text = warning({ model: 'claude-haiku-5-5', tokens: 900_000 }, true)
  assert.match(text, /900K of 1000K tokens \(90%\)/)
  assert.match(text, /cannot hand off/)
  assert.match(text, /release every lock/)
  assert.doesNotMatch(text, /CLAUDE\.md/)
})

test('warning fires at 85% of the window only', () => {
  assert.equal(warning({ model: 'claude-opus-5-5', tokens: 849_999 }), null)
  assert.match(warning({ model: 'claude-opus-5-5', tokens: 850_000 }), /850K of 1000K tokens \(85%\)/)
  assert.match(warning({ model: 'claude-sonnet-4-5', tokens: 180_000 }), /180K of 200K tokens \(90%\)/)
})
