import { describe, expect, it, vi } from 'vitest'
import { wrapCredentialPoolProvider, type ExternalCredentialPool } from '../credential-pool.js'
import { authorizeGoogleRequest, credentialPoolAiStudioTransport } from '../google-transport.js'
import type { LLMProvider, StreamChunk } from '../types.js'

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

describe('native credential spend provenance', () => {
  const knownActual = 'claude-haiku-4-5-20251001'
  type Metadata = Extract<StreamChunk, { type: 'message_end' }>['nativeMetadata']
  async function run(metadata: Metadata) {
    const recordSpend = vi.fn(async (_cost: number) => {})
    const pool: ExternalCredentialPool = {
      resolve: vi.fn().mockResolvedValue({ credentialId: 'native', provider: 'fixture', secret: 'secret', source: 'managed', recordSpend }),
    }
    const terminal: StreamChunk = {
      type: 'message_end', stopReason: 'end_turn',
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, calculatedCostUsd: 999 },
      ...(metadata === undefined ? {} : { nativeMetadata: metadata }),
    }
    const provider = wrapCredentialPoolProvider({
      providerId: 'fixture', pool,
      create: () => ({
        ...providerFor('secret'),
        async *stream() {
          yield { type: 'message_start', model: 'claude-sonnet-4-6' } as const
          yield terminal
        },
      }),
    })
    const chunks = await drain(provider.stream({ nativeStrict: true, model: 'claude-sonnet-4-6', systemPrompt: '', messages: [] }))
    expect(chunks.at(-1)).toBe(terminal) // accounting does not rewrite billing evidence
    expect(pool.resolve).toHaveBeenCalledTimes(1)
    return recordSpend
  }

  it.each([undefined, { actualModel: null, usage: { inputTokens: 10, outputTokens: 5 } },
    { actualModel: 'unknown-actual', usage: { inputTokens: 10, outputTokens: 5, calculatedCostUsd: 999 } },
    { actualModel: knownActual, usage: null }])('does not price missing or unpriced evidence: %j', async metadata => {
    expect(await run(metadata)).not.toHaveBeenCalled()
  })

  it('uses known actual-model rates rather than requested or synthetic-start models', async () => {
    const spend = await run({ actualModel: knownActual, usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 } })
    expect(spend).toHaveBeenCalledExactlyOnceWith(7.35) // Haiku: 1 + 5 + 0.10 + 1.25
  })

  it.each([999, 0, -1, NaN, Infinity])('ignores adapter calculatedCostUsd=%s', async calculatedCostUsd => {
    const spend = await run({ actualModel: knownActual, usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, calculatedCostUsd } })
    expect(spend).toHaveBeenCalledExactlyOnceWith(6)
  })

  it('accepts explicit zero without manufacturing positive spend from an override', async () => {
    expect(await run({ actualModel: knownActual, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calculatedCostUsd: 999 } })).not.toHaveBeenCalled()
    expect(await run({ actualModel: knownActual, usage: { inputTokens: 0, outputTokens: 1_000_000 } })).toHaveBeenCalledExactlyOnceWith(5)
  })

  it.each(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'])('rejects malformed %s at the credential boundary', async field => {
    for (const value of [null, -1, 0.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const usage = { inputTokens: 10, outputTokens: 5, [field]: value }
      expect(await run({ actualModel: knownActual, usage } as Metadata)).not.toHaveBeenCalled()
    }
  })

  it('rejects missing required counters and unsafe prompt totals', async () => {
    for (const usage of [{ inputTokens: 0 }, { outputTokens: 0 }, { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, cacheReadTokens: 1 }]) {
      expect(await run({ actualModel: knownActual, usage } as Metadata)).not.toHaveBeenCalled()
    }
  })
})
