import { describe, it, expect, vi, afterEach } from 'vitest'
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

// ── Scripted provider ──────────────────────────────────────────

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

// Echo tool — used by older tests that staged a tool_use on turn 0 to
// reach turn 1 before triggering the empty-response branch. Retries now
// fire on any turn including turn 0 (cgov public-API regression).
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

// Chunk factories ──
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

function nudgeTextOf(messages: Message[]): string {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'user') return ''
  const content = last.content
  if (typeof content === 'string') return content
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

async function runLoop(provider: LLMProvider): Promise<QueryEvent[]> {
  const events: QueryEvent[] = []
  for await (const e of queryLoop({
    provider,
    model: 'mock-model',
    systemPrompt: 'sys',
    messages: [{ role: 'user', content: 'hello' }],
    tools: new Map([['echo', echoTool]]),
    context: baseContext,
    maxTurns: 10,
  })) {
    events.push(e)
  }
  return events
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('[COMP:engine/query-loop] Empty-response recovery', () => {
  it('recovers on turn 0 when the very first response is empty (cgov regression)', async () => {
    // Repro: Gemini Flash thinking-burns the user's question into silence
    // on turn 0 (no text, no tool_use, stopReason=STOP). Pre-fix this
    // exited the loop with `[]` content; the public-API route persisted
    // the empty assistant row and the embedded chat UI hung.
    const { provider, calls } = scriptedProvider([
      emptyChunks,                 // turn 0 — fresh user q → empty
      textChunks('back from silence'), // turn 1 — retry 1 produces text
    ])

    const events = await runLoop(provider)
    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e.type === 'text_delta' ? e.text : ''))
      .join('')

    expect(text).toBe('back from silence')
    // 2 send() calls: initial empty, retry 1 with the nudge.
    expect(calls).toHaveLength(2)
    expect(calls[1].sendOpts?.thinkingLevel).toBeUndefined()
  })

  it('recovers on retry 1 — step-1 keeps provider-default thinking', async () => {
    const { provider, calls } = scriptedProvider([
      toolUseChunks('t1'), // turn 0 — tool_use (so turn > 0 gate unlocks)
      emptyChunks,          // turn 1 — empty → triggers retry 1
      textChunks('recovered'), // turn 2 — retry attempt produces text
    ])

    const events = await runLoop(provider)
    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e.type === 'text_delta' ? e.text : ''))
      .join('')

    expect(text).toBe('recovered')
    // 3 send() calls: initial, tool_results, empty-retry nudge
    expect(calls).toHaveLength(3)
    // First retry keeps thinkingLevel undefined (provider default).
    expect(calls[2].sendOpts?.thinkingLevel).toBeUndefined()
  })

  it('escalates to retry 2 with thinkingLevel=low when retry 1 also empty', async () => {
    const { provider, calls } = scriptedProvider([
      toolUseChunks('t1'),
      emptyChunks,              // turn 1 → retry 1 (default thinking)
      emptyChunks,              // turn 2 → retry 2 (thinkingLevel=low)
      textChunks('finally'),    // turn 3 → success
    ])

    const events = await runLoop(provider)
    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e.type === 'text_delta' ? e.text : ''))
      .join('')

    expect(text).toBe('finally')
    // 4 send() calls: initial, tool_results, retry 1, retry 2
    expect(calls).toHaveLength(4)
    expect(calls[2].sendOpts?.thinkingLevel).toBeUndefined()
    expect(calls[3].sendOpts?.thinkingLevel).toBe('low')
  })

  it('gives up quietly after both retries fail (turn_complete with empty content)', async () => {
    const { provider, calls } = scriptedProvider([
      toolUseChunks('t1'),
      emptyChunks, // retry 1
      emptyChunks, // retry 2
      emptyChunks, // third empty — no more retries, exits
    ])

    const events = await runLoop(provider)
    const complete = events.find((e) => e.type === 'turn_complete')
    expect(complete).toBeDefined()

    const text = events
      .filter((e) => e.type === 'text_delta')
      .map((e) => (e.type === 'text_delta' ? e.text : ''))
      .join('')
    expect(text).toBe('') // empty ⇒ channel route will render a loud-fail message
    // Retries were attempted: initial + tool_results + 2 retries = 4 calls
    expect(calls).toHaveLength(4)
  })

  it('turn-0 empty retry permits tool use; after-tool empty retry forbids it', async () => {
    // Turn 0 empty with no prior tool calls — the BEFORE_TOOLS plan must
    // NOT tell the model to stop calling tools (regression: tool-heavy
    // prompts like "research X and save to brain" used to be forced into a
    // refusal because the retry nudge said "Do not call any tools").
    const { provider: providerBefore, calls: callsBefore } = scriptedProvider([
      emptyChunks,
      textChunks('ok'),
    ])
    await runLoop(providerBefore)
    const beforeNudge = nudgeTextOf(callsBefore[1].messages)
    expect(beforeNudge.toLowerCase()).not.toContain('do not call')

    // After a tool ran, the AFTER_TOOLS plan kicks in and DOES forbid
    // further tool calls so the model commits to synthesis.
    const { provider: providerAfter, calls: callsAfter } = scriptedProvider([
      toolUseChunks('t1'),
      emptyChunks,
      textChunks('ok'),
    ])
    await runLoop(providerAfter)
    const afterNudge = nudgeTextOf(callsAfter[2].messages)
    expect(afterNudge.toLowerCase()).toContain('do not call')
  })

  it('skips remaining retries when wall-clock budget is exhausted', async () => {
    const { provider, calls } = scriptedProvider([
      toolUseChunks('t1'),
      emptyChunks,
      emptyChunks,
      emptyChunks,
    ])

    // Fake clock: start at 0. Bump to 200_000 ms (past the 90s cap) right
    // before the empty-retry check runs on turn 1. Query loop uses Date.now()
    // only for the wall-clock guard, so spying on it is safe and surgical.
    let nowCallCount = 0
    const realNow = Date.now.bind(Date)
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => {
      nowCallCount++
      // First call captures loopStartTime. All subsequent calls return a
      // timestamp well past EMPTY_RETRY_WALL_MS.
      return nowCallCount === 1 ? 0 : 200_000
    })

    const events = await runLoop(provider)
    expect(events.find((e) => e.type === 'turn_complete')).toBeDefined()
    // No retries attempted — only initial + tool_results = 2 calls.
    expect(calls).toHaveLength(2)

    spy.mockRestore()
    // Sanity: Date.now still works after restore.
    expect(realNow()).toBeGreaterThan(0)
  })
})
