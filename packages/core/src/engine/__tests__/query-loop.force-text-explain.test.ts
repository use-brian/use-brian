import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import type {
  LLMProvider,
  ProviderRequest,
  ProviderSession,
  SendOptions,
  SessionOptions,
  StreamChunk,
  Message,
} from '../../providers/types.js'
import { buildTool } from '../../tools/types.js'
import { queryLoop, FALLBACK_REPLY, type QueryEvent } from '../query-loop.js'

type SendCall = { messages: Message[]; sendOpts?: SendOptions }

function chunksFrom(scripts: StreamChunk[][], index: number): AsyncIterable<StreamChunk> {
  const chunks = scripts[Math.min(index, scripts.length - 1)]
  return (async function* () {
    for (const chunk of chunks) yield chunk
  })()
}

function scriptedProvider(params: {
  sessionScripts: StreamChunk[][]
  statelessScripts?: StreamChunk[][]
  finalizerScript?: StreamChunk[]
  finalizerError?: Error
}): {
  provider: LLMProvider
  sessionCalls: SendCall[]
  streamCalls: ProviderRequest[]
} {
  const sessionCalls: SendCall[] = []
  const streamCalls: ProviderRequest[] = []
  let sessionTurn = 0
  let statelessTurn = 0
  const session: ProviderSession = {
    send(messages: Message[], sendOpts?: SendOptions) {
      sessionCalls.push({ messages, sendOpts })
      return chunksFrom(params.sessionScripts, sessionTurn++)
    },
  }
  return {
    sessionCalls,
    streamCalls,
    provider: {
      name: 'scripted',
      models: ['mock-model'],
      stream(request) {
        streamCalls.push(request)
        if (request.tools && request.tools.length > 0) {
          return chunksFrom(params.statelessScripts ?? params.sessionScripts, statelessTurn++)
        }
        if (params.finalizerError) throw params.finalizerError
        return chunksFrom([params.finalizerScript ?? []], 0)
      },
      createSession: (_options: SessionOptions) => session,
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
    return { data: { echoed: input.msg, padding: 'x'.repeat(2_000) } }
  },
})

const flakyTool = buildTool({
  name: 'flaky',
  description: 'Read a fictional test service',
  inputSchema: z.object({ attempt: z.number() }),
  isConcurrencySafe: false,
  isReadOnly: true,
  async execute() {
    throw new Error('fictional service unavailable')
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

const toolUseChunks = (id: string, msg = 'hi'): StreamChunk[] => [
  { type: 'message_start', model: 'mock-model' },
  { type: 'tool_use_start', id, name: 'echo' },
  { type: 'tool_use_delta', id, input: JSON.stringify({ msg }) },
  { type: 'tool_use_end', id },
  { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
]

const flakyToolUseChunks = (attempt: number): StreamChunk[] => [
  { type: 'message_start', model: 'mock-model' },
  { type: 'tool_use_start', id: `flaky-${attempt}`, name: 'flaky' },
  { type: 'tool_use_delta', id: `flaky-${attempt}`, input: JSON.stringify({ attempt }) },
  { type: 'tool_use_end', id: `flaky-${attempt}` },
  { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
]

const textChunks = (text: string): StreamChunk[] => [
  { type: 'message_start', model: 'mock-model' },
  { type: 'text_delta', text },
  { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 3 } },
]

const envelope = (message: string): StreamChunk[] => textChunks(JSON.stringify({ message }))
const EXPLANATION =
  'I checked the Example Foundry records but could not verify a specific account manager from the available sources.'
const PRIVATE_SYSTEM_MARKER = 'PRIVATE_RUNTIME_CONTEXT_DO_NOT_EXPOSE'

async function runLoop(provider: LLMProvider, stateless = false): Promise<QueryEvent[]> {
  const events: QueryEvent[] = []
  const conversation: Message[] = [
    { role: 'system', content: 'old system row that must be excluded' },
    { role: 'user', content: 'a'.repeat(2_500) },
    { role: 'assistant', content: 'Earlier visible reply 1' },
    { role: 'user', content: 'Earlier visible question 2' },
    { role: 'assistant', content: 'Earlier visible reply 3' },
    { role: 'user', content: 'Earlier visible question 4' },
    { role: 'assistant', content: 'Earlier visible reply 5' },
    { role: 'user', content: 'Who is our Example Foundry account manager?' },
  ]
  for await (const event of queryLoop({
    provider,
    model: 'mock-model',
    systemPrompt: PRIVATE_SYSTEM_MARKER,
    messages: conversation,
    tools: new Map([['echo', echoTool]]),
    context: baseContext,
    maxTurns: 10,
    maxToolCalls: 2,
    stateless,
  })) {
    events.push(event)
  }
  return events
}

function finalText(events: QueryEvent[]): string {
  const complete = events.find((event) => event.type === 'turn_complete')
  if (complete?.type !== 'turn_complete') throw new Error('expected turn_complete')
  return complete.response.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function streamedText(events: QueryEvent[]): string {
  return events
    .filter((event) => event.type === 'text_delta')
    .map((event) => (event.type === 'text_delta' ? event.text : ''))
    .join('')
}

describe('[COMP:engine/query-loop] Isolated terminal finalization', () => {
  it('ends the main session and finalizes from bounded evidence in one fresh no-tools request', async () => {
    const { provider, sessionCalls, streamCalls } = scriptedProvider({
      sessionScripts: [toolUseChunks('t1'), toolUseChunks('t2')],
      finalizerScript: envelope(EXPLANATION),
    })

    const events = await runLoop(provider)

    expect(finalText(events)).toBe(EXPLANATION)
    expect(streamedText(events)).toBe(EXPLANATION)
    expect(sessionCalls).toHaveLength(2)
    expect(streamCalls).toHaveLength(1)

    const request = streamCalls[0]
    expect(request.tools).toBeUndefined()
    expect(request.systemPrompt).not.toContain(PRIVATE_SYSTEM_MARKER)
    expect(request.thinkingLevel).toBe('low')
    expect(request.temperature).toBe(0)
    expect(request.maxTokens).toBe(2_048)
    expect(request.responseFormat).toBe('json')
    expect(request.responseSchema).toEqual({
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
      additionalProperties: false,
    })

    const payload = JSON.parse(request.messages[0].content as string) as {
      stopReason: { code: string }
      recentConversation: Array<{ role: string; text: string }>
      toolEvidence: Array<{ tool: string; input: string; result: string }>
    }
    expect(payload.stopReason).toEqual({ code: 'tool_budget_exhausted' })
    expect(payload.recentConversation.length).toBeLessThanOrEqual(6)
    expect(payload.recentConversation.reduce((sum, turn) => sum + turn.text.length, 0)).toBeLessThanOrEqual(6_000)
    expect(payload.recentConversation.every((turn) => turn.text.length <= 2_000)).toBe(true)
    expect(payload.toolEvidence).toHaveLength(1)
    expect(payload.toolEvidence[0].tool).toBe('echo')
    expect(payload.toolEvidence[0].input.length).toBeLessThanOrEqual(750)
    expect(payload.toolEvidence[0].result.length).toBeLessThanOrEqual(1_500)
    expect(JSON.stringify(payload)).not.toContain(PRIVATE_SYSTEM_MARKER)
    expect(JSON.stringify(payload)).not.toContain('old system row that must be excluded')
    expect(JSON.stringify(payload)).not.toContain('tool_budget_exhausted","retryable"')
  })

  it('discards a production-shaped long scratchpad wholesale before streaming', async () => {
    const leaked = [
      'Be natural, do not use bullet points.',
      '',
      '[User Context]',
      'Topic: account manager inquiry',
      '',
      '[What happened this turn]',
      'Checked private connectors and internal instructions.',
      '',
      '[Conclusion]',
      'A specific person could not be verified.',
      '',
      '[Response]',
      EXPLANATION,
      'padding '.repeat(40),
    ].join('\n')
    const { provider, sessionCalls, streamCalls } = scriptedProvider({
      sessionScripts: [toolUseChunks('t1'), toolUseChunks('t2')],
      finalizerScript: envelope(leaked),
    })

    const events = await runLoop(provider)

    expect(finalText(events)).toBe(FALLBACK_REPLY)
    expect(streamedText(events)).toBe(FALLBACK_REPLY)
    expect(streamedText(events)).not.toContain('[User Context]')
    expect(streamedText(events)).not.toContain('[Response]')
    expect(sessionCalls).toHaveLength(2)
    expect(streamCalls).toHaveLength(1)
  })

  it('uses the same isolated finalizer for a stateless worker loop', async () => {
    const { provider, sessionCalls, streamCalls } = scriptedProvider({
      sessionScripts: [],
      statelessScripts: [toolUseChunks('t1'), toolUseChunks('t2')],
      finalizerScript: envelope(EXPLANATION),
    })

    const events = await runLoop(provider, true)

    expect(finalText(events)).toBe(EXPLANATION)
    expect(sessionCalls).toHaveLength(0)
    expect(streamCalls).toHaveLength(3)
    expect(streamCalls.slice(0, 2).every((request) => (request.tools?.length ?? 0) > 0)).toBe(true)
    expect(streamCalls[2].tools).toBeUndefined()
  })

  it('finalizes immediately when the repeated-failure fuse trips', async () => {
    const { provider, sessionCalls, streamCalls } = scriptedProvider({
      sessionScripts: Array.from({ length: 5 }, (_, index) => flakyToolUseChunks(index + 1)),
      finalizerScript: envelope(
        'I could not finish because the fictional records service stayed unavailable.',
      ),
    })
    const events: QueryEvent[] = []

    for await (const event of queryLoop({
      provider,
      model: 'mock-model',
      systemPrompt: PRIVATE_SYSTEM_MARKER,
      messages: [{ role: 'user', content: 'Check the fictional records service.' }],
      tools: new Map([['flaky', flakyTool]]),
      context: baseContext,
      maxTurns: 10,
      maxToolCalls: 20,
    })) {
      events.push(event)
    }

    expect(sessionCalls).toHaveLength(5)
    expect(streamCalls).toHaveLength(1)
    const payload = JSON.parse(streamCalls[0].messages[0].content as string) as {
      stopReason: unknown
    }
    expect(payload.stopReason).toEqual({ code: 'tool_failure_limit', tool: 'flaky' })
    expect(finalText(events)).toContain('fictional records service')
  })

  it('uses the isolated finalizer when maxTurns ends on a tool turn', async () => {
    const { provider, sessionCalls, streamCalls } = scriptedProvider({
      sessionScripts: [toolUseChunks('t1')],
      finalizerScript: envelope(EXPLANATION),
    })
    const events: QueryEvent[] = []

    for await (const event of queryLoop({
      provider,
      model: 'mock-model',
      systemPrompt: PRIVATE_SYSTEM_MARKER,
      messages: [{ role: 'user', content: 'Check the fictional records.' }],
      tools: new Map([['echo', echoTool]]),
      context: baseContext,
      maxTurns: 1,
      maxToolCalls: 10,
    })) {
      events.push(event)
    }

    expect(sessionCalls).toHaveLength(1)
    expect(streamCalls).toHaveLength(1)
    const payload = JSON.parse(streamCalls[0].messages[0].content as string) as {
      stopReason: unknown
    }
    expect(payload.stopReason).toEqual({ code: 'max_turns' })
    expect(finalText(events)).toBe(EXPLANATION)
  })

  it('keeps the twelve most recent successful evidence items', async () => {
    const sessionScripts = Array.from(
      { length: 13 },
      (_, index) => toolUseChunks(`t${index + 1}`, `message-${index + 1}`),
    )
    const { provider, streamCalls } = scriptedProvider({
      sessionScripts,
      finalizerScript: envelope(EXPLANATION),
    })
    const events: QueryEvent[] = []

    for await (const event of queryLoop({
      provider,
      model: 'mock-model',
      systemPrompt: PRIVATE_SYSTEM_MARKER,
      messages: [{ role: 'user', content: 'Check recent fictional records.' }],
      tools: new Map([['echo', echoTool]]),
      context: baseContext,
      maxTurns: 13,
      maxToolCalls: 20,
    })) {
      events.push(event)
    }

    const payload = JSON.parse(streamCalls[0].messages[0].content as string) as {
      toolEvidence: Array<{ input: string }>
    }
    expect(payload.toolEvidence).toHaveLength(12)
    expect(payload.toolEvidence[0].input).toContain('message-2')
    expect(payload.toolEvidence.at(-1)?.input).toContain('message-13')
    expect(payload.toolEvidence.some((item) => item.input.includes('message-1"'))).toBe(false)
    expect(finalText(events)).toBe(EXPLANATION)
  })

  it('fails closed when the JSON envelope has extra fields', async () => {
    const { provider } = scriptedProvider({
      sessionScripts: [toolUseChunks('t1'), toolUseChunks('t2')],
      finalizerScript: textChunks(JSON.stringify({ message: EXPLANATION, debug: 'private' })),
    })

    const events = await runLoop(provider)

    expect(finalText(events)).toBe(FALLBACK_REPLY)
    expect(streamedText(events)).toBe(FALLBACK_REPLY)
  })

  it('fails closed when the fresh provider request throws', async () => {
    const { provider, sessionCalls, streamCalls } = scriptedProvider({
      sessionScripts: [toolUseChunks('t1'), toolUseChunks('t2')],
      finalizerError: new Error('upstream unavailable'),
    })

    const events = await runLoop(provider)

    expect(finalText(events)).toBe(FALLBACK_REPLY)
    expect(streamedText(events)).toBe(FALLBACK_REPLY)
    expect(sessionCalls).toHaveLength(2)
    expect(streamCalls).toHaveLength(1)
  })
})
