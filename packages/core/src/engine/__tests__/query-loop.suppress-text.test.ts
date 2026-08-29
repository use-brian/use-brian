import { describe, it, expect } from 'vitest'
import { NOOP_TURN_LEDGER } from '../turn-ledger.js'
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
import { queryLoop, type QueryEvent } from '../query-loop.js'

function scriptedProvider(scripts: StreamChunk[][]): LLMProvider {
  let turn = 0

  function streamNext(): AsyncIterable<StreamChunk> {
    const chunks = scripts[Math.min(turn, scripts.length - 1)]
    turn++
    return (async function* () {
      for (const chunk of chunks) yield chunk
    })()
  }

  const session: ProviderSession = {
    send(_messages: Message[], _opts?: SendOptions) {
      return streamNext()
    },
  }

  return {
    name: 'scripted',
    models: ['mock-model'],
    stream: () => streamNext(),
    createSession: (_o: SessionOptions) => session,
  }
}

const spawnWorkerTool = buildTool({
  name: 'spawnWorker',
  description: 'Spawn a research worker',
  inputSchema: z.object({ prompt: z.string() }),
  async execute() {
    return { data: 'Worker w1 spawned.' }
  },
})

const lookupTool = buildTool({
  name: 'lookup',
  description: 'Look something up',
  inputSchema: z.object({ query: z.string() }),
  async execute() {
    return { data: 'found' }
  },
})

const baseContext = {
  userId: 'u',
  assistantId: 'a',
  sessionId: 's',
  appId: 'test',
  channelType: 'web',
  channelId: 'c',
  abortSignal: new AbortController().signal,
}

// Turn 0: model emits a thinking-style preamble as text BEFORE the spawnWorker
// tool call (Gemini's part order: [text, functionCall]). This is the leak
// vector — the reactive `suppressText` flip in queryLoop happens after the
// text chunk has already been yielded.
const preambleThenSpawn: StreamChunk[] = [
  { type: 'message_start', model: 'mock-model' },
  { type: 'text_delta', text: 'Be concise (1–3 sentences). Check brand voice rules.' },
  { type: 'tool_use_start', id: 'call_1', name: 'spawnWorker' },
  { type: 'tool_use_delta', id: 'call_1', input: '{"prompt":"search HK trending topics"}' },
  { type: 'tool_use_end', id: 'call_1' },
  { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
]

// Turn 1: synthesis turn — final answer streams normally.
const synthesisAnswer: StreamChunk[] = [
  { type: 'message_start', model: 'mock-model' },
  { type: 'text_delta', text: 'The Labor Day long weekend is driving HK conversation.' },
  { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 8 } },
]

describe('[COMP:engine/query-loop] suppressIntermediateText', () => {
  it('aggregates length-tiered cost per provider request', async () => {
    const first: StreamChunk[] = [
      { type: 'message_start', model: 'gemini-3.1-pro-preview' },
      { type: 'tool_use_start', id: 'call_1', name: 'lookup' },
      { type: 'tool_use_delta', id: 'call_1', input: '{"query":"pricing"}' },
      { type: 'tool_use_end', id: 'call_1' },
      { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 150_000, outputTokens: 1_000 } },
    ]
    const second: StreamChunk[] = [
      { type: 'message_start', model: 'gemini-3.1-pro-preview' },
      { type: 'text_delta', text: 'Final answer.' },
      { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 150_000, outputTokens: 1_000 } },
    ]
    const events: QueryEvent[] = []

    for await (const event of queryLoop({ ledger: NOOP_TURN_LEDGER,
      provider: scriptedProvider([first, second]),
      model: 'gemini-3.1-pro-preview',
      systemPrompt: 'sp',
      messages: [{ role: 'user', content: 'hi' }],
      tools: new Map([['lookup', lookupTool]]),
      context: baseContext,
      maxTurns: 3,
    })) {
      events.push(event)
    }

    const complete = events.find((event) => event.type === 'turn_complete')
    if (complete?.type !== 'turn_complete') throw new Error('expected turn_complete')
    expect(complete.totalUsage.inputTokens).toBe(300_000)
    expect(complete.totalUsage.calculatedCostUsd).toBeCloseTo(0.624, 10)
  })

  it('LEAK BASELINE: without the option, pre-spawnWorker text leaks to the consumer', async () => {
    const provider = scriptedProvider([preambleThenSpawn, synthesisAnswer])
    const events: QueryEvent[] = []
    for await (const ev of queryLoop({ ledger: NOOP_TURN_LEDGER,
      provider,
      model: 'mock-model',
      systemPrompt: 'sp',
      messages: [{ role: 'user', content: 'hi' }],
      tools: new Map([['spawnWorker', spawnWorkerTool]]),
      context: baseContext,
      maxTurns: 3,
    })) {
      events.push(ev)
    }
    const streamedText = events
      .filter((e): e is { type: 'text_delta'; text: string } => e.type === 'text_delta')
      .map((e) => e.text)
      .join('')
    // The bug: leaked preamble appears in the streamed text.
    expect(streamedText).toContain('Be concise')
  })

  it('FIX: with suppressIntermediateText=true, pre-spawnWorker text is dropped from BOTH the stream and the persisted turn', async () => {
    const provider = scriptedProvider([preambleThenSpawn, synthesisAnswer])
    const events: QueryEvent[] = []
    for await (const ev of queryLoop({ ledger: NOOP_TURN_LEDGER,
      provider,
      model: 'mock-model',
      systemPrompt: 'sp',
      messages: [{ role: 'user', content: 'hi' }],
      tools: new Map([['spawnWorker', spawnWorkerTool]]),
      context: baseContext,
      maxTurns: 3,
      suppressIntermediateText: true,
    })) {
      events.push(ev)
    }
    const streamedText = events
      .filter((e): e is { type: 'text_delta'; text: string } => e.type === 'text_delta')
      .map((e) => e.text)
      .join('')
    expect(streamedText).not.toContain('Be concise')

    // The preamble must also be absent from the persisted turn 0 — otherwise
    // it surfaces on session reload even though it was suppressed live.
    const assistantTurns = events.filter((e) => e.type === 'assistant_turn')
    expect(assistantTurns.length).toBeGreaterThan(0)
    const turn0 = assistantTurns[0]
    if (turn0.type !== 'assistant_turn') throw new Error('expected assistant_turn')
    const turn0Text = turn0.response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
    expect(turn0Text).not.toContain('Be concise')
  })
})
