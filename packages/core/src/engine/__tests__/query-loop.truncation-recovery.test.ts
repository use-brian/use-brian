import { describe, expect, it } from 'vitest'
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
  for await (const event of queryLoop({
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

  it('does not auto-continue an incomplete messaging-channel reply', async () => {
    const { provider, calls } = scriptedProvider([
      responseChunks('Partial reply', 'incomplete'),
      responseChunks(' should not be reached', 'end_turn'),
    ])

    const events = await runLoop(provider, 'telegram')

    expect(calls).toHaveLength(1)
    expect(events.filter((event) => event.type === 'turn_complete')).toHaveLength(1)
  })
})
