/**
 * Smoke test — one end-to-end query-loop turn against a mock provider.
 *
 * Why this exists: Vitest suites are great for per-component regressions, but
 * the query loop has enough moving parts (provider → stream chunks → tool
 * executor → result accumulation → second turn) that a "the whole thing still
 * runs" signal is its own category. This script is the fastest way to tell
 * whether the engine is fundamentally alive. No DB, no network, no API keys.
 *
 * If this prints `OK` in under a second, the query loop is still wired up.
 * If it prints a failure, the trace points directly at the break.
 *
 * Run: pnpm smoke
 */

import { strict as assert } from 'node:assert'
import { z } from 'zod'
import { queryLoop, type QueryEvent } from '../src/engine/query-loop.js'
import { buildTool } from '../src/tools/types.js'
import type { Tool } from '../src/tools/types.js'
import type {
  LLMProvider,
  ProviderSession,
  SessionOptions,
  StreamChunk,
  Message,
} from '../src/providers/types.js'

// ── Scripted stream sequences ──────────────────────────────────
//
// Turn 1: model asks to call the `echo` tool once, then ends.
// Turn 2: model responds with text after seeing the tool result.

const TOOL_CALL_ID = 'call_1'

const turn1Chunks: StreamChunk[] = [
  { type: 'message_start', model: 'mock-model' },
  { type: 'text_delta', text: 'Looking it up' },
  { type: 'tool_use_start', id: TOOL_CALL_ID, name: 'echo' },
  { type: 'tool_use_delta', id: TOOL_CALL_ID, input: '{"message":"hello"}' },
  { type: 'tool_use_end', id: TOOL_CALL_ID },
  { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
]

const turn2Chunks: StreamChunk[] = [
  { type: 'message_start', model: 'mock-model' },
  { type: 'text_delta', text: 'The echo said hello.' },
  { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 15, outputTokens: 6 } },
]

// ── Mock provider ──────────────────────────────────────────────

function mockProvider(): LLMProvider {
  let turn = 0

  function makeStream(): AsyncIterable<StreamChunk> {
    const chunks = turn === 0 ? turn1Chunks : turn2Chunks
    turn++
    return (async function* () {
      for (const chunk of chunks) yield chunk
    })()
  }

  const session: ProviderSession = {
    send(_messages: Message[]) {
      return makeStream()
    },
  }

  return {
    name: 'mock',
    models: ['mock-model'],
    stream: () => makeStream(),
    createSession: (_options: SessionOptions) => session,
  }
}

// ── Stub tool ──────────────────────────────────────────────────

let echoCallCount = 0

const echoTool: Tool = buildTool({
  name: 'echo',
  description: 'Return the message that was passed in.',
  inputSchema: z.object({
    message: z.string(),
  }),
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(input) {
    echoCallCount++
    return { data: `echo: ${input.message}` }
  },
})

// ── Runner ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const abortController = new AbortController()
  const events: QueryEvent[] = []

  for await (const event of queryLoop({
    provider: mockProvider(),
    model: 'mock-model',
    systemPrompt: 'You are a smoke test assistant.',
    messages: [{ role: 'user', content: 'say hello' }],
    tools: new Map([['echo', echoTool]]),
    context: {
      userId: 'smoke-user',
      assistantId: 'smoke-assistant',
      sessionId: 'smoke-session',
      appId: 'smoke',
      channelType: 'web',
      channelId: 'smoke-channel',
      abortSignal: abortController.signal,
    },
    maxTurns: 5,
  })) {
    events.push(event)
  }

  // ── Assertions ───────────────────────────────────────────────

  const textEvents = events.filter((e) => e.type === 'text_delta')
  const toolStarts = events.filter((e) => e.type === 'tool_start')
  const toolResults = events.filter((e) => e.type === 'tool_result')
  const turnCompletes = events.filter((e) => e.type === 'turn_complete')

  assert.ok(textEvents.length >= 2, `expected ≥2 text deltas, got ${textEvents.length}`)
  assert.equal(toolStarts.length, 1, `expected 1 tool start, got ${toolStarts.length}`)
  assert.ok(toolResults.length >= 1, `expected ≥1 tool result, got ${toolResults.length}`)
  assert.equal(turnCompletes.length, 1, `expected 1 turn_complete, got ${turnCompletes.length}`)
  assert.equal(echoCallCount, 1, `expected echo tool to execute once, got ${echoCallCount}`)

  // The final text should have propagated
  const combinedText = textEvents
    .map((e) => (e.type === 'text_delta' ? e.text : ''))
    .join('')
  assert.ok(
    combinedText.includes('The echo said hello.'),
    `expected final text to contain second-turn response, got: ${combinedText}`,
  )

  // Total usage should reflect both turns
  const complete = turnCompletes[0]
  if (complete?.type !== 'turn_complete') throw new Error('turn_complete missing')
  assert.equal(complete.totalUsage.inputTokens, 25, 'input tokens should sum across turns')
  assert.equal(complete.totalUsage.outputTokens, 11, 'output tokens should sum across turns')

  console.log('OK')
}

main().catch((err: unknown) => {
  console.error('SMOKE FAILED:')
  console.error(err)
  process.exit(1)
})
