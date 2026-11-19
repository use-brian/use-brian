import { describe, expect, it } from 'vitest'
import { NOOP_TURN_LEDGER } from '../turn-ledger.js'
import type {
  LLMProvider,
  Message,
  ProviderSession,
  SendOptions,
  SessionOptions,
  StopReason,
  StreamChunk,
} from '../../providers/types.js'
import { queryLoop, type QueryEvent } from '../query-loop.js'

function responseChunks(text: string, stopReason: StopReason): StreamChunk[] {
  return [
    { type: 'message_start', model: 'mock-model' },
    { type: 'text_delta', text },
    { type: 'message_end', stopReason, usage: { inputTokens: 10, outputTokens: 5 } },
  ]
}

function scriptedProvider(scripts: StreamChunk[][]): {
  provider: LLMProvider
  calls: Message[][]
} {
  let attempt = 0
  const calls: Message[][] = []

  function next(messages: Message[]): AsyncIterable<StreamChunk> {
    calls.push(messages)
    const chunks = scripts[Math.min(attempt, scripts.length - 1)]
    attempt++
    return (async function* () {
      for (const chunk of chunks) yield chunk
    })()
  }

  const session: ProviderSession = {
    send(messages: Message[], _opts?: SendOptions) {
      return next(messages)
    },
  }

  return {
    calls,
    provider: {
      name: 'scripted',
      models: ['mock-model'],
      stream(request) {
        return next(request.messages)
      },
      createSession(_options: SessionOptions) {
        return session
      },
    },
  }
}

const baseContext = {
  userId: 'user-example',
  assistantId: 'assistant-example',
  sessionId: 'session-example',
  appId: 'test',
  channelType: 'web',
  channelId: 'channel-example',
  abortSignal: new AbortController().signal,
}

async function runLoop(provider: LLMProvider, channelType: string): Promise<QueryEvent[]> {
  const events: QueryEvent[] = []
  for await (const event of queryLoop({ ledger: NOOP_TURN_LEDGER,
    provider,
    model: 'mock-model',
    systemPrompt: 'sys',
    messages: [{ role: 'user', content: 'List the IT costs' }],
    tools: new Map(),
    context: { ...baseContext, channelType },
    channelType,
    maxTurns: 5,
  })) {
    events.push(event)
  }
  return events
}

describe('[COMP:engine/query-loop] Truncation recovery', () => {
  it.each<StopReason>(['max_tokens', 'incomplete'])(
    'auto-continues a web reply stopped by %s',
    async (stopReason) => {
      const { provider, calls } = scriptedProvider([
        responseChunks('IT Staff Payroll: HKD 600,', stopReason),
        responseChunks('000 for FY2025.', 'end_turn'),
      ])

      const events = await runLoop(provider, 'web')

      expect(calls).toHaveLength(2)
      expect(calls[1]).toEqual([{ role: 'user', content: 'Continue from where you left off.' }])
      expect(
        events
          .filter((event) => event.type === 'text_delta')
          .map((event) => event.type === 'text_delta' ? event.text : '')
          .join(''),
      ).toBe('IT Staff Payroll: HKD 600,000 for FY2025.')
      expect(events.filter((event) => event.type === 'turn_complete')).toHaveLength(1)
    },
  )

  it.each<StopReason>(['max_tokens', 'incomplete'])(
    'auto-continues an unattended workflow reply stopped by %s',
    async (stopReason) => {
      const { provider, calls } = scriptedProvider([
        responseChunks('3 | Use Brian: absent | Competitors:', stopReason),
        responseChunks(' #1 example.com\n4 | Use Brian: present', 'end_turn'),
      ])

      const events = await runLoop(provider, 'workflow')

      expect(calls).toHaveLength(2)
      expect(calls[1]).toEqual([{ role: 'user', content: 'Continue from where you left off.' }])
      expect(
        events
          .filter((event) => event.type === 'text_delta')
          .map((event) => event.type === 'text_delta' ? event.text : '')
          .join(''),
      ).toBe('3 | Use Brian: absent | Competitors: #1 example.com\n4 | Use Brian: present')
      expect(events.filter((event) => event.type === 'turn_complete')).toHaveLength(1)
    },
  )

  // Regression: the 2026-08-25 Telegram truncation. Recovery used to be gated
  // to web + workflow on the reasoning that an "attended messaging channel may
  // already have surfaced the partial text". Telegram is a FINAL-ONLY channel
  // - it leaves `onTextDelta` unimplemented and receives one
  // `sendResponse(fullText)` at `turn_complete` - so it surfaces nothing early
  // and had no way to recover. The gate excluded exactly the channels that
  // needed it. This reply left the user cut off at a half-typed bracket.
  it.each<StopReason>(['max_tokens', 'incomplete'])(
    'auto-continues a final-only messaging reply stopped by %s',
    async (stopReason) => {
      const { provider, calls } = scriptedProvider([
        responseChunks('### 3. Delta Life - Kaupunki syntyy suistoon (', stopReason),
        responseChunks('三角洲之生) is a free outdoor art event.', 'end_turn'),
      ])

      const events = await runLoop(provider, 'telegram')

      expect(calls).toHaveLength(2)
      expect(calls[1]).toEqual([{ role: 'user', content: 'Continue from where you left off.' }])
      expect(
        events
          .filter((event) => event.type === 'text_delta')
          .map((event) => event.type === 'text_delta' ? event.text : '')
          .join(''),
      ).toBe('### 3. Delta Life - Kaupunki syntyy suistoon (三角洲之生) is a free outdoor art event.')
      expect(events.filter((event) => event.type === 'turn_complete')).toHaveLength(1)
    },
  )

  // The budget is what keeps a provider that halts every time from looping.
  // A halt that repeats delivers both fragments and stops asking.
  it('spends its continuation budget exactly once when the retry also truncates', async () => {
    const { provider, calls } = scriptedProvider([
      responseChunks('First fragment', 'incomplete'),
      responseChunks(' second fragment', 'incomplete'),
      responseChunks(' must never be reached', 'end_turn'),
    ])

    const events = await runLoop(provider, 'telegram')

    expect(calls).toHaveLength(2)
    expect(events.filter((event) => event.type === 'turn_complete')).toHaveLength(1)
  })
})
