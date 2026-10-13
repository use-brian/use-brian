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

// ── Coordinator turns while workers run ──────────────────────────────
// Spec: docs/architecture/engine/coordinator-pattern.md → "Waiting on
// workers" (empty turn = wait, no empty-response retry; askQuestion strip
// restores suppression; held text released when no worker is busy).

function countingProvider(scripts: StreamChunk[][]): { provider: LLMProvider; calls: () => number } {
  let n = 0
  const inner = scriptedProvider(scripts)
  const wrap = <T>(fn: () => T): T => { n++; return fn() }
  const innerSession = inner.createSession!({} as SessionOptions)
  return {
    provider: {
      ...inner,
      stream: (...args: Parameters<LLMProvider['stream']>) => wrap(() => inner.stream(...args)),
      createSession: () => ({
        send: (m: Message[], o?: SendOptions) => wrap(() => innerSession.send(m, o)),
      }),
    },
    calls: () => n,
  }
}

/** Worker-manager stub: one pending worker that settles on the first wait. */
function pendingWorkerManager() {
  let pending = 1
  let notified = false
  return {
    pendingCountFor: () => pending,
    hasNotificationsFor: () => notified,
    waitForNext: async () => { pending = 0; notified = true },
    drainNotifications: () => {
      if (!notified) return []
      notified = false
      return [{ workerId: 'w1', description: 'research', result: 'worker found X', status: 'completed' }]
    },
    formatNotification: () => '<worker w1>worker found X</worker>',
  }
}

const emptyTurn: StreamChunk[] = [
  { type: 'message_start', model: 'mock-model' },
  { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 0 } },
]

const spawnOnly: StreamChunk[] = [
  { type: 'message_start', model: 'mock-model' },
  { type: 'tool_use_start', id: 'call_1', name: 'spawnWorker' },
  { type: 'tool_use_delta', id: 'call_1', input: '{"prompt":"research X"}' },
  { type: 'tool_use_end', id: 'call_1' },
  { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
]

function streamed(events: QueryEvent[]): string {
  return events
    .filter((e): e is { type: 'text_delta'; text: string } => e.type === 'text_delta')
    .map((e) => e.text)
    .join('')
}

function persistedTexts(events: QueryEvent[]): string[] {
  return events
    .filter((e) => e.type === 'assistant_turn')
    .map((e) => (e.type === 'assistant_turn'
      ? e.response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('')
      : ''))
    .filter((t) => t.length > 0)
}

async function runCoordinator(
  provider: LLMProvider,
  wm: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Map<string, any>,
): Promise<QueryEvent[]> {
  const events: QueryEvent[] = []
  for await (const ev of queryLoop({ ledger: NOOP_TURN_LEDGER,
    provider,
    model: 'mock-model',
    systemPrompt: 'sp',
    messages: [{ role: 'user', content: 'hi' }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools: tools as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    context: { ...baseContext, workerManager: wm as any },
    maxTurns: 8,
    suppressIntermediateText: true,
  })) {
    events.push(ev)
  }
  return events
}

describe('[COMP:engine/query-loop] coordinator turns while workers run', () => {
  it('an empty turn while a worker is pending waits in Phase 4b instead of firing the empty-response retry', async () => {
    const { provider, calls } = countingProvider([spawnOnly, emptyTurn, synthesisAnswer])
    const events = await runCoordinator(
      provider,
      pendingWorkerManager(),
      new Map([['spawnWorker', spawnWorkerTool]]),
    )
    // spawn turn + the empty feedback turn + ONE synthesis turn. A retry
    // would have added 1-2 nudged calls between the empty turn and the drain.
    expect(calls()).toBe(3)
    expect(streamed(events)).toBe('The Labor Day long weekend is driving HK conversation.')
    expect(events.some((e) => e.type === 'turn_complete')).toBe(true)
  })

  it('a stripped askQuestion restores suppression, so a pre-drain answer is not streamed or persisted beside the synthesis', async () => {
    const askAlongsideLookup: StreamChunk[] = [
      { type: 'message_start', model: 'mock-model' },
      { type: 'tool_use_start', id: 'call_q', name: 'askQuestion' },
      { type: 'tool_use_delta', id: 'call_q', input: '{"question":"Please wait"}' },
      { type: 'tool_use_end', id: 'call_q' },
      { type: 'tool_use_start', id: 'call_l', name: 'lookup' },
      { type: 'tool_use_delta', id: 'call_l', input: '{"query":"files"}' },
      { type: 'tool_use_end', id: 'call_l' },
      { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 5, outputTokens: 5 } },
    ]
    const prematureAnswer: StreamChunk[] = [
      { type: 'message_start', model: 'mock-model' },
      { type: 'text_delta', text: 'Premature answer from file titles.' },
      { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 5 } },
    ]
    const { askQuestionTool } = await import('../../tools/base/ask-question.js')
    const { provider } = countingProvider([spawnOnly, askAlongsideLookup, prematureAnswer, synthesisAnswer])
    const events = await runCoordinator(
      provider,
      pendingWorkerManager(),
      new Map<string, unknown>([
        ['spawnWorker', spawnWorkerTool],
        ['lookup', lookupTool],
        ['askQuestion', askQuestionTool],
      ]),
    )
    expect(events.some((e) => e.type === 'tool_dropped')).toBe(true)
    expect(streamed(events)).not.toContain('Premature')
    expect(persistedTexts(events)).toEqual(['The Labor Day long weekend is driving HK conversation.'])
  })

  it('releases held text when a coordinator turn answers directly and no worker is busy', async () => {
    const directAnswer: StreamChunk[] = [
      { type: 'message_start', model: 'mock-model' },
      { type: 'text_delta', text: 'Here is the direct answer.' },
      { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 5 } },
    ]
    const idle = {
      pendingCountFor: () => 0,
      hasNotificationsFor: () => false,
      waitForNext: async () => {},
      drainNotifications: () => [],
      formatNotification: () => '',
    }
    const { provider, calls } = countingProvider([directAnswer])
    const events = await runCoordinator(provider, idle, new Map([['spawnWorker', spawnWorkerTool]]))
    // One call: no empty-response retry, no empty-turn fallback.
    expect(calls()).toBe(1)
    expect(streamed(events)).toBe('Here is the direct answer.')
    const complete = events.find((e) => e.type === 'turn_complete')
    if (complete?.type !== 'turn_complete') throw new Error('expected turn_complete')
    expect(complete.response.content).toEqual([{ type: 'text', text: 'Here is the direct answer.' }])
  })
})
