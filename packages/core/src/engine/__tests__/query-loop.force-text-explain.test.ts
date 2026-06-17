import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import type {
  LLMProvider,
  ProviderSession,
  SendOptions,
  SessionOptions,
  StreamChunk,
  Message,
} from '../../providers/types.js'
import { buildTool } from '../../tools/types.js'
import { queryLoop, FALLBACK_REPLY, type QueryEvent } from '../query-loop.js'

// ── Scripted provider ──────────────────────────────────────────
// Same shape as query-loop.empty-retry.test.ts: each send() consumes the
// next script and clamps to the last once exhausted.
type SendCall = { messages: Message[]; sendOpts?: SendOptions }

function scriptedProvider(scripts: StreamChunk[][]): {
  provider: LLMProvider
  calls: SendCall[]
} {
  const calls: SendCall[] = []
  let turn = 0
  function streamNext(): AsyncIterable<StreamChunk> {
    const chunks = scripts[Math.min(turn, scripts.length - 1)]
    turn++
    return (async function* () {
      for (const chunk of chunks) yield chunk
    })()
  }
  const session: ProviderSession = {
    send(messages: Message[], opts?: SendOptions) {
      calls.push({ messages, sendOpts: opts })
      return streamNext()
    },
  }
  return {
    calls,
    provider: {
      name: 'scripted',
      models: ['mock-model'],
      stream: () => streamNext(),
      createSession: (_o: SessionOptions) => session,
    },
  }
}

const echoTool = buildTool({
  name: 'echo',
  description: 'Echo input back',
  inputSchema: z.object({ msg: z.string() }),
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(input) {
    return { data: { echoed: input.msg } }
  },
})

const baseContext = {
  userId: 'u',
  assistantId: 'a',
  sessionId: 's',
  appId: 'test',
  channelType: 'telegram',
  channelId: 'c',
  abortSignal: new AbortController().signal,
}

const toolUseChunks = (id: string): StreamChunk[] => [
  { type: 'message_start', model: 'mock-model' },
  { type: 'tool_use_start', id, name: 'echo' },
  { type: 'tool_use_delta', id, input: '{"msg":"hi"}' },
  { type: 'tool_use_end', id },
  { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
]
const emptyChunks: StreamChunk[] = [
  { type: 'message_start', model: 'mock-model' },
  { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 1 } },
]
const textChunks = (text: string): StreamChunk[] => [
  { type: 'message_start', model: 'mock-model' },
  { type: 'text_delta', text },
  { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 3 } },
]

// A recap that trips looksLikeInstructionLeak (third-person "respond to the
// user") — the exact failure mode that used to collapse to the canned line.
const LEAK = 'Respond to the user with what you found.'
// A clean, contextual explanation — must NOT trip the leak detector
// (second-person, starts with subject+verb, no "the user").
const EXPLANATION =
  'I pulled your calendar — nothing is scheduled today — but Google Tasks did not respond, so your task list could not be included.'

async function runLoop(provider: LLMProvider): Promise<QueryEvent[]> {
  const events: QueryEvent[] = []
  for await (const e of queryLoop({
    provider,
    model: 'mock-model',
    systemPrompt: 'sys',
    messages: [{ role: 'user', content: 'daily summary' }],
    tools: new Map([['echo', echoTool]]),
    context: baseContext,
    maxTurns: 10,
    maxToolCalls: 2, // turn 0 executes echo, turn 1 is hard-stopped → forceTextResponse
  })) {
    events.push(e)
  }
  return events
}

function finalText(events: QueryEvent[]): string {
  const complete = events.find((e) => e.type === 'turn_complete')
  if (complete?.type !== 'turn_complete') throw new Error('expected turn_complete')
  return complete.response.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

function streamedText(events: QueryEvent[]): string {
  return events
    .filter((e) => e.type === 'text_delta')
    .map((e) => (e.type === 'text_delta' ? e.text : ''))
    .join('')
}

describe('[COMP:engine/query-loop] Forced-text fallback — explain-what-happened escalation', () => {
  it('escalates a leaked recap to a contextual explanation instead of the canned line', async () => {
    const { provider, calls } = scriptedProvider([
      toolUseChunks('t1'), // turn 0 — executes echo (totalCalls=1)
      toolUseChunks('t2'), // turn 1 — hard-stopped (totalCalls=2 >= maxToolCalls)
      textChunks(LEAK), // forceTextResponse recap → leaks → suppressed
      textChunks(EXPLANATION), // explainFailure → clean message
    ])

    const events = await runLoop(provider)

    // The user gets the real explanation, never the canned generic line.
    expect(finalText(events)).toBe(EXPLANATION)
    expect(streamedText(events)).toBe(EXPLANATION)
    expect(finalText(events)).not.toContain('more specific request')
    // 4 sends: initial, tool-results turn, recap, explanation.
    expect(calls).toHaveLength(4)
    // The escalation call commits at low thinking.
    expect(calls[3].sendOpts?.thinkingLevel).toBe('low')
  })

  it('escalates an empty recap to a contextual explanation', async () => {
    const { provider, calls } = scriptedProvider([
      toolUseChunks('t1'),
      toolUseChunks('t2'),
      emptyChunks, // recap produces no text → escalate
      textChunks(EXPLANATION),
    ])

    const events = await runLoop(provider)

    expect(finalText(events)).toBe(EXPLANATION)
    expect(calls).toHaveLength(4)
    expect(calls[3].sendOpts?.thinkingLevel).toBe('low')
  })

  it('falls back to the canned line only when the explanation also fails', async () => {
    const { provider, calls } = scriptedProvider([
      toolUseChunks('t1'),
      toolUseChunks('t2'),
      textChunks(LEAK), // recap leaks → escalate
      textChunks(LEAK), // explanation ALSO leaks → last-resort canned line
    ])

    const events = await runLoop(provider)

    expect(finalText(events)).toBe(FALLBACK_REPLY)
    expect(calls).toHaveLength(4)
  })

  it('delivers a clean recap directly without an extra escalation call', async () => {
    const { provider, calls } = scriptedProvider([
      toolUseChunks('t1'),
      toolUseChunks('t2'),
      textChunks('Here is what I found: your calendar is clear today.'),
    ])

    const events = await runLoop(provider)

    expect(finalText(events)).toBe('Here is what I found: your calendar is clear today.')
    // 3 sends only — no escalation needed.
    expect(calls).toHaveLength(3)
  })
})
