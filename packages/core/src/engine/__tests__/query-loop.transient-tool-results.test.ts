import { describe, expect, it } from 'vitest'
import { NOOP_TURN_LEDGER } from '../turn-ledger.js'
import { z } from 'zod'
import type {
  LLMProvider,
  Message,
  ProviderSession,
  SendOptions,
  SessionOptions,
  StreamChunk,
} from '../../providers/types.js'
import { buildTool } from '../../tools/types.js'
import { queryLoop, type QueryEvent } from '../query-loop.js'

const toolTurn: StreamChunk[] = [
  { type: 'message_start', model: 'mock-model' },
  { type: 'tool_use_start', id: 'maps-1', name: 'googleMapsLookupWeather' },
  { type: 'tool_use_delta', id: 'maps-1', input: '{"location":"Hong Kong"}' },
  { type: 'tool_use_end', id: 'maps-1' },
  { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 4, outputTokens: 2 } },
]

const answerTurn: StreamChunk[] = [
  { type: 'message_start', model: 'mock-model' },
  { type: 'text_delta', text: 'It is warm today.' },
  { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 4 } },
]

function providerWithCapturedSends(sent: Message[][]): LLMProvider {
  let turn = 0
  const session: ProviderSession = {
    send(messages: Message[], _options?: SendOptions) {
      sent.push(messages)
      const chunks = turn++ === 0 ? toolTurn : answerTurn
      return (async function* () {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
  return {
    name: 'scripted',
    models: ['mock-model'],
    stream: () => (async function* () {})(),
    createSession: (_options: SessionOptions) => session,
  }
}

const context = {
  userId: 'user-1',
  assistantId: 'assistant-1',
  sessionId: 'session-1',
  appId: 'test',
  channelType: 'web',
  channelId: 'channel-1',
  abortSignal: new AbortController().signal,
}

describe('[COMP:engine/transient-tool-results] query-loop persistence projection', () => {
  it('feeds transient evidence to the live next turn but persists neither half of the pair', async () => {
    const sent: Message[][] = []
    const tool = buildTool({
      name: 'googleMapsLookupWeather',
      description: 'Look up weather',
      inputSchema: z.object({ location: z.string() }),
      async execute() {
        return {
          data: {
            provider: 'google_maps_grounding_lite',
            result: { temperature: 31 },
            sources: [{ title: 'Google Maps weather', url: 'https://maps.google.com/example' }],
          },
          meta: { transientProviderContent: true },
        }
      },
    })
    const events: QueryEvent[] = []

    for await (const event of queryLoop({ ledger: NOOP_TURN_LEDGER,
      provider: providerWithCapturedSends(sent),
      model: 'mock-model',
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'weather?' }],
      tools: new Map([[tool.name, tool]]),
      context,
      maxTurns: 3,
    })) events.push(event)

    expect(JSON.stringify(sent[1])).toContain('temperature')
    const assistantTurns = events.filter(
      (event): event is Extract<QueryEvent, { type: 'assistant_turn' }> => event.type === 'assistant_turn',
    )
    expect(assistantTurns[0].response.content).toEqual([])
    expect(assistantTurns[0].toolResults).toEqual([])
    expect(JSON.stringify(assistantTurns)).not.toContain('temperature')
    expect(JSON.stringify(assistantTurns[1].response.content)).toContain('It is warm today.')

    const citations = events.filter(
      (event): event is Extract<QueryEvent, { type: 'citation' }> => event.type === 'citation',
    )
    expect(citations).toEqual([{
      type: 'citation',
      sources: [{
        url: 'https://maps.google.com/example',
        title: 'Google Maps weather',
      }],
    }])
  })
})
