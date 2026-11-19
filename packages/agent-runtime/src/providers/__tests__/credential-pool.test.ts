import { describe, expect, it, vi } from 'vitest'
import { wrapCredentialPoolProvider, type ExternalCredentialPool } from '../credential-pool.js'
import { authorizeGoogleRequest, credentialPoolAiStudioTransport } from '../google-transport.js'
import { registeredToolDefinitions } from '../tool-registration.js'
import type {
  LLMProvider, Message, SendOptions, SessionOptions, StreamChunk,
  ToolDefinition, ToolSchemaRegistration, ToolSchemaRegistrationMode,
} from '../types.js'

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function providerFor(secret: string): LLMProvider {
  return {
    name: 'fixture',
    models: [],
    async *stream(request) {
      yield { type: 'message_start', model: request.model }
      yield { type: 'text_delta', text: secret }
      yield {
        type: 'message_end',
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5, calculatedCostUsd: 0.25 },
      }
    },
    createSession(options) {
      return {
        send: (messages) => this.stream({
          model: options.model,
          systemPrompt: options.systemPrompt,
          messages,
        }),
      }
    },
  }
}

describe('[COMP:providers/credential-pool] credential-resolving provider', () => {
  it('forwards model-aware schema modes on the existing template without selecting credentials', () => {
    const recordSpend = vi.fn()
    const pool: ExternalCredentialPool = {
      resolve: vi.fn().mockResolvedValue({
        credentialId: 'selected', provider: 'fixture', secret: 'selected-key', source: 'managed', recordSpend,
      }),
    }
    const assertInputAuthority = vi.fn()
    const template = providerFor('template')
    const stream = vi.spyOn(template, 'stream')
    const createSession = vi.spyOn(template, 'createSession')
    const mode = vi.fn(function (this: LLMProvider, model: string): ToolSchemaRegistrationMode {
      expect(this).toBe(template)
      if (model === 'gemini-fixture') return 'dynamic'
      if (model === 'codex-fixture') return 'native-deferred'
      return 'eager'
    })
    template.toolSchemaMode = mode
    template.supportedThinkingLevels = function (model) {
      expect(this).toBe(template)
      return model === 'low-fixture' ? ['low', 'high'] : []
    }
    const create = vi.fn(() => template)
    const provider = wrapCredentialPoolProvider({
      providerId: 'fixture', pool, systemFallback: 'template', create,
    })
    const session = provider.createSession({ model: 'gemini-fixture', systemPrompt: '', assertInputAuthority })

    expect(provider.toolSchemaMode?.('gemini-fixture')).toBe('dynamic')
    expect(provider.toolSchemaMode?.('codex-fixture')).toBe('native-deferred')
    expect(provider.toolSchemaMode?.('legacy-fixture')).toBe('eager')
    expect(provider.toolSchemaMode?.('gemini-fixture')).toBe('dynamic')
    expect(mode.mock.calls.map(([model]) => model)).toEqual([
      'gemini-fixture', 'codex-fixture', 'legacy-fixture', 'gemini-fixture',
    ])
    const captured = provider.supportedThinkingLevels!
    template.supportedThinkingLevels = () => []
    expect(captured('low-fixture')).toEqual(['low', 'high'])
    expect(captured('unknown')).toEqual([])
    expect(session).toBeDefined()
    expect(create).toHaveBeenCalledExactlyOnceWith('template')
    expect(pool.resolve).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()
    expect(createSession).not.toHaveBeenCalled()
    expect(assertInputAuthority).not.toHaveBeenCalled()
    expect(recordSpend).not.toHaveBeenCalled()
  })

  it('defaults legacy templates to eager without selecting credentials or creating another provider', () => {
    const pool: ExternalCredentialPool = { resolve: vi.fn() }
    const create = vi.fn(providerFor)
    const provider = wrapCredentialPoolProvider({ providerId: 'fixture', pool, create })

    expect(provider.toolSchemaMode?.('any-model')).toBe('eager')
    expect(provider.toolSchemaMode?.('another-model')).toBe('eager')
    expect(create).toHaveBeenCalledExactlyOnceWith('')
    expect(pool.resolve).not.toHaveBeenCalled()
  })

  it.each([
    ['stateless', 'eager'], ['stateless', 'dynamic'], ['stateless', 'native-deferred'],
    ['stateful', 'eager'], ['stateful', 'dynamic'], ['stateful', 'native-deferred'],
  ] as const)('preserves tool carriers, canonical chunks and usage for %s %s calls', async (kind, mode) => {
    const tool = (name: string): ToolDefinition => ({
      name, description: name, parameters: { type: 'object', properties: {} },
    })
    const canonical = tool('files.read')
    const tools = [canonical, tool('files.write')]
    const active = [tool('tool_search')]
    const catalog = [...tools]
    const toolRegistration: ToolSchemaRegistration = { mode: 'deferred', catalog, active }
    const controller = new AbortController()
    const assertInputAuthority = vi.fn(async () => {})
    const options: SessionOptions = {
      model: 'fixture-model', systemPrompt: '', tools, toolRegistration,
      signal: controller.signal, assertInputAuthority,
    }
    const sendOptions: SendOptions = { signal: controller.signal, assertInputAuthority }
    const recordSpend = vi.fn(async () => {})
    const pool: ExternalCredentialPool = {
      resolve: vi.fn().mockResolvedValue({
        credentialId: 'selected', provider: 'fixture', secret: 'selected-key', source: 'managed', recordSpend,
      }),
    }
    const chunks: StreamChunk[] = [
      { type: 'message_start', model: options.model },
      { type: 'tool_use_start', id: 'call-1', name: canonical.name },
      { type: 'tool_use_delta', id: 'call-1', input: '{}' },
      { type: 'tool_use_end', id: 'call-1', providerSignature: 'signature' },
      { type: 'message_end', stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 5, calculatedCostUsd: 0.25 } },
    ]
    const seenMessages: Message[][] = []
    const inspect = (received: SessionOptions) => {
      expect(received.tools).toBe(tools)
      expect(received.toolRegistration).toBe(toolRegistration)
      expect(received.toolRegistration?.catalog).toBe(catalog)
      expect(received.toolRegistration?.active).toBe(active)
      expect(received.signal).toBe(controller.signal)
      expect(received.assertInputAuthority).toBe(assertInputAuthority)
      expect(registeredToolDefinitions(received, mode)).toBe(
        mode === 'dynamic' ? active : mode === 'native-deferred' ? catalog : tools,
      )
    }
    const childCreateSession = vi.fn((received: SessionOptions) => {
      expect(received).toBe(options)
      inspect(received)
      return {
        async *send(messages: Message[], receivedSendOptions?: SendOptions) {
          inspect(received)
          expect(receivedSendOptions).toBe(sendOptions)
          seenMessages.push(messages)
          yield* chunks
        },
      }
    })
    const create = vi.fn((secret: string): LLMProvider => ({
      name: 'fixture', models: [], toolSchemaMode: () => mode,
      async *stream(request) {
        expect(secret).toBe('selected-key')
        inspect(request)
        seenMessages.push(request.messages)
        yield* chunks
      },
      createSession: childCreateSession,
    }))
    const provider = wrapCredentialPoolProvider({ providerId: 'fixture', pool, create })
    const session = kind === 'stateful' ? provider.createSession(options) : undefined
    expect(provider.toolSchemaMode?.(options.model)).toBe(mode)
    expect(pool.resolve).not.toHaveBeenCalled()
    const firstMessages: Message[] = [{ role: 'user', content: 'read the file' }]
    const nextMessages: Message[] = [{ role: 'user', content: [
      { type: 'tool_result', toolUseId: 'call-1', name: canonical.name, content: 'file contents' },
    ] }]
    for (const messages of [firstMessages, nextMessages]) {
      const result = await drain(session
        ? session.send(messages, sendOptions)
        : provider.stream({ ...options, messages }))
      expect(result).toEqual(chunks)
      result.forEach((chunk, index) => expect(chunk).toBe(chunks[index]))
      if (messages === firstMessages) active.push(canonical)
    }

    expect(seenMessages[0]).toBe(firstMessages)
    expect(seenMessages[1]).toBe(nextMessages)
    expect(active).toEqual([tool('tool_search'), canonical])
    expect(tools).toEqual([canonical, tool('files.write')])
    expect(catalog).toEqual(tools)
    expect(pool.resolve).toHaveBeenCalledTimes(session ? 1 : 2)
    expect(create).toHaveBeenCalledTimes(session ? 2 : 3)
    expect(childCreateSession).toHaveBeenCalledTimes(session ? 1 : 0)
    expect(assertInputAuthority).toHaveBeenCalledTimes(2)
    expect(recordSpend).toHaveBeenCalledTimes(2)
    expect(recordSpend).toHaveBeenNthCalledWith(1, 0.25)
    expect(recordSpend).toHaveBeenNthCalledWith(2, 0.25)
  })

  it('resolves each stateless call live and records reported spend on its lease', async () => {
    const recordFirst = vi.fn(async () => {})
    const recordSecond = vi.fn(async () => {})
    const pool: ExternalCredentialPool = {
      resolve: vi.fn()
        .mockResolvedValueOnce({
          credentialId: 'first', provider: 'gemini', secret: 'promo-one', source: 'managed',
          recordSpend: recordFirst,
        })
        .mockResolvedValueOnce({
          credentialId: 'second', provider: 'gemini', secret: 'promo-two', source: 'managed',
          recordSpend: recordSecond,
        }),
    }
    const provider = wrapCredentialPoolProvider({
      providerId: 'gemini', pool, systemFallback: 'stable', create: providerFor,
    })

    const request = { model: 'fixture-model', systemPrompt: '', messages: [] }
    const first = await drain(provider.stream(request))
    const second = await drain(provider.stream(request))

    expect(first).toContainEqual({ type: 'text_delta', text: 'promo-one' })
    expect(second).toContainEqual({ type: 'text_delta', text: 'promo-two' })
    expect(recordFirst).toHaveBeenCalledWith(0.25)
    expect(recordSecond).toHaveBeenCalledWith(0.25)
  })

  it('keeps one lease for every turn in a stateful provider session', async () => {
    const recordSpend = vi.fn(async () => {})
    const pool: ExternalCredentialPool = {
      resolve: vi.fn().mockResolvedValue({
        credentialId: 'first', provider: 'gemini', secret: 'session-key', source: 'managed',
        recordSpend,
      }),
    }
    const provider = wrapCredentialPoolProvider({
      providerId: 'gemini', pool, create: providerFor,
    })
    const session = provider.createSession({ model: 'fixture-model', systemPrompt: '' })

    await drain(session.send([{ role: 'user', content: 'one' }]))
    await drain(session.send([{ role: 'user', content: 'two' }]))

    expect(pool.resolve).toHaveBeenCalledTimes(1)
    expect(recordSpend).toHaveBeenCalledTimes(2)
  })

  it('binds Google spend to the same lease that produced the request headers', async () => {
    const recordFirst = vi.fn(async () => {})
    const recordSecond = vi.fn(async () => {})
    const pool: ExternalCredentialPool = {
      resolve: vi.fn()
        .mockResolvedValueOnce({
          credentialId: 'first', provider: 'gemini', secret: 'first-key', source: 'managed',
          recordSpend: recordFirst,
        })
        .mockResolvedValueOnce({
          credentialId: 'second', provider: 'gemini', secret: 'second-key', source: 'managed',
          recordSpend: recordSecond,
        }),
    }
    const transport = credentialPoolAiStudioTransport(pool, 'stable-key')

    const first = await authorizeGoogleRequest(transport)
    const second = await authorizeGoogleRequest(transport)
    await first.recordSpend?.('fixture', {
      inputTokens: 1,
      outputTokens: 1,
      calculatedCostUsd: 0.4,
    })

    expect(first.headers['x-goog-api-key']).toBe('first-key')
    expect(second.headers['x-goog-api-key']).toBe('second-key')
    expect(recordFirst).toHaveBeenCalledWith(0.4)
    expect(recordSecond).not.toHaveBeenCalled()
  })
})
