import { describe, it, expect, vi } from 'vitest'
import { wrapFallback, extractStatus, type FallbackAnalytics } from '../wrap-fallback.js'
import { collectStream } from '../accumulator.js'
import type {
  LLMProvider,
  Message,
  ProviderRequest,
  ProviderSession,
  SendOptions,
  SessionOptions,
  StreamChunk,
} from '../types.js'

// ── Test fixtures ──────────────────────────────────────────────

function okChunks(text: string, model = 'fake-model'): StreamChunk[] {
  return [
    { type: 'message_start', model },
    { type: 'text_delta', text },
    { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 7 } },
  ]
}

type FakeBehavior = {
  /** Throw on `stream` or `send` (before any chunks yield). */
  throwError?: unknown
  /** Override the chunks emitted on success. */
  chunks?: StreamChunk[]
}

function makeProvider(name: string, behavior: FakeBehavior = {}): LLMProvider {
  const stream = async function* (_request: ProviderRequest): AsyncIterable<StreamChunk> {
    if (behavior.throwError) throw behavior.throwError
    for (const chunk of behavior.chunks ?? okChunks(`${name} output`, name)) {
      yield chunk
    }
  }

  return {
    name,
    models: [`${name}-model`],
    stream,
    createSession(_opts: SessionOptions): ProviderSession {
      return {
        async *send(_messages: Message[], _opts2?: SendOptions): AsyncIterable<StreamChunk> {
          if (behavior.throwError) throw behavior.throwError
          for (const chunk of behavior.chunks ?? okChunks(`${name} session`, name)) {
            yield chunk
          }
        },
      }
    },
  }
}

function makeRequest(model = 'primary-model'): ProviderRequest {
  return {
    model,
    systemPrompt: 'test',
    messages: [{ role: 'user', content: 'hi' }],
  }
}

// ── extractStatus ──────────────────────────────────────────────

describe('[COMP:providers/fallback] extractStatus', () => {
  it('returns numeric status from SDK-shaped errors', () => {
    expect(extractStatus({ status: 429, message: 'rate limited' })).toBe(429)
    expect(extractStatus({ status: 503 })).toBe(503)
  })

  it('parses status from Gemini-style "API error <code>" messages', () => {
    expect(extractStatus(new Error('Gemini API error 429: Quota exceeded'))).toBe(429)
    expect(extractStatus(new Error('Gemini API error 500: server fault'))).toBe(500)
  })

  it('returns null for unclassifiable errors', () => {
    expect(extractStatus(new Error('connection reset'))).toBe(null)
    expect(extractStatus(null)).toBe(null)
    expect(extractStatus('plain string')).toBe(null)
  })
})

// ── Happy paths ────────────────────────────────────────────────

describe('[COMP:providers/fallback] wrapFallback — primary succeeds', () => {
  it('does NOT call fallback when primary succeeds (stream)', async () => {
    const primary = makeProvider('primary')
    const fallback = makeProvider('fallback')
    const fallbackSpy = vi.spyOn(fallback, 'stream')

    const wrapped = wrapFallback(primary, fallback)
    const response = await collectStream(wrapped.stream(makeRequest()))

    expect(response.content).toEqual([{ type: 'text', text: 'primary output' }])
    expect(fallbackSpy).not.toHaveBeenCalled()
  })

  it('does NOT call fallback when primary succeeds (session)', async () => {
    const primary = makeProvider('primary')
    const fallback = makeProvider('fallback')
    const fallbackSpy = vi.spyOn(fallback, 'createSession')

    const wrapped = wrapFallback(primary, fallback)
    const session = wrapped.createSession({ model: 'primary-model', systemPrompt: 'sp' })
    const response = await collectStream(session.send([{ role: 'user', content: 'hi' }]))

    expect(response.content).toEqual([{ type: 'text', text: 'primary session' }])
    expect(fallbackSpy).not.toHaveBeenCalled()
  })

  it('does NOT fire the analytics hook when primary succeeds', async () => {
    const analytics: FallbackAnalytics = { onFallback: vi.fn() }
    const wrapped = wrapFallback(makeProvider('primary'), makeProvider('fallback'), { analytics })
    await collectStream(wrapped.stream(makeRequest()))
    expect(analytics.onFallback).not.toHaveBeenCalled()
  })
})

// ── 429 fallback ───────────────────────────────────────────────

describe('[COMP:providers/fallback] wrapFallback — 429 rate-limit retry', () => {
  it('falls back when primary throws a 429 (SDK shape)', async () => {
    const primaryErr = Object.assign(new Error('rate limited'), { status: 429 })
    const primary = makeProvider('primary', { throwError: primaryErr })
    const fallback = makeProvider('fallback')

    const wrapped = wrapFallback(primary, fallback)
    const response = await collectStream(wrapped.stream(makeRequest()))

    expect(response.content).toEqual([{ type: 'text', text: 'fallback output' }])
  })

  it('falls back when primary throws a 429 (Gemini-style message)', async () => {
    const primaryErr = new Error('Gemini API error 429: Quota exceeded')
    const primary = makeProvider('primary', { throwError: primaryErr })
    const fallback = makeProvider('fallback')

    const wrapped = wrapFallback(primary, fallback)
    const response = await collectStream(wrapped.stream(makeRequest()))

    expect(response.content).toEqual([{ type: 'text', text: 'fallback output' }])
  })

  it('fires the analytics hook with the rate-limit classification', async () => {
    const primaryErr = Object.assign(new Error('429'), { status: 429 })
    const onFallback = vi.fn()
    const wrapped = wrapFallback(
      makeProvider('primary', { throwError: primaryErr }),
      makeProvider('fallback'),
      { analytics: { onFallback } },
    )

    await collectStream(wrapped.stream(makeRequest()))

    expect(onFallback).toHaveBeenCalledOnce()
    expect(onFallback).toHaveBeenCalledWith({
      primaryModel: 'primary-model',
      fallbackModel: 'fallback-model',
      errorKind: 'rate_limited',
      errorStatus: 429,
    })
  })
})

// ── 5xx fallback ───────────────────────────────────────────────

describe('[COMP:providers/fallback] wrapFallback — 5xx server-error retry', () => {
  it('falls back on 500', async () => {
    const primaryErr = Object.assign(new Error('server fault'), { status: 500 })
    const wrapped = wrapFallback(
      makeProvider('primary', { throwError: primaryErr }),
      makeProvider('fallback'),
    )
    const response = await collectStream(wrapped.stream(makeRequest()))
    expect(response.content).toEqual([{ type: 'text', text: 'fallback output' }])
  })

  it('falls back on 502 / 503 / 504', async () => {
    for (const status of [502, 503, 504]) {
      const wrapped = wrapFallback(
        makeProvider('primary', { throwError: Object.assign(new Error(`${status}`), { status }) }),
        makeProvider('fallback'),
      )
      const response = await collectStream(wrapped.stream(makeRequest()))
      expect(response.content).toEqual([{ type: 'text', text: 'fallback output' }])
    }
  })

  it('fires the analytics hook with server_error classification on a 503', async () => {
    const primaryErr = Object.assign(new Error('upstream'), { status: 503 })
    const onFallback = vi.fn()
    const wrapped = wrapFallback(
      makeProvider('primary', { throwError: primaryErr }),
      makeProvider('fallback'),
      { analytics: { onFallback } },
    )
    await collectStream(wrapped.stream(makeRequest()))
    expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({
      errorKind: 'server_error',
      errorStatus: 503,
    }))
  })

  it('falls back on session.send 500s', async () => {
    const primaryErr = Object.assign(new Error('500'), { status: 500 })
    const wrapped = wrapFallback(
      makeProvider('primary', { throwError: primaryErr }),
      makeProvider('fallback'),
    )
    const session = wrapped.createSession({ model: 'primary-model', systemPrompt: 'sp' })
    const response = await collectStream(session.send([{ role: 'user', content: 'hi' }]))
    expect(response.content).toEqual([{ type: 'text', text: 'fallback session' }])
  })
})

// ── Non-retryable errors ───────────────────────────────────────

describe('[COMP:providers/fallback] wrapFallback — non-retryable errors', () => {
  it('does NOT fall back on 400', async () => {
    const primaryErr = Object.assign(new Error('bad request'), { status: 400 })
    const fallback = makeProvider('fallback')
    const fallbackSpy = vi.spyOn(fallback, 'stream')
    const wrapped = wrapFallback(makeProvider('primary', { throwError: primaryErr }), fallback)
    await expect(collectStream(wrapped.stream(makeRequest()))).rejects.toThrow('bad request')
    expect(fallbackSpy).not.toHaveBeenCalled()
  })

  it('does NOT fall back on 401', async () => {
    const primaryErr = Object.assign(new Error('unauthorized'), { status: 401 })
    const fallback = makeProvider('fallback')
    const fallbackSpy = vi.spyOn(fallback, 'stream')
    const wrapped = wrapFallback(makeProvider('primary', { throwError: primaryErr }), fallback)
    await expect(collectStream(wrapped.stream(makeRequest()))).rejects.toThrow('unauthorized')
    expect(fallbackSpy).not.toHaveBeenCalled()
  })

  it('does NOT fall back on unclassifiable errors', async () => {
    const primaryErr = new Error('connection reset')
    const fallback = makeProvider('fallback')
    const fallbackSpy = vi.spyOn(fallback, 'stream')
    const wrapped = wrapFallback(makeProvider('primary', { throwError: primaryErr }), fallback)
    await expect(collectStream(wrapped.stream(makeRequest()))).rejects.toThrow('connection reset')
    expect(fallbackSpy).not.toHaveBeenCalled()
  })
})

// ── Both providers fail ────────────────────────────────────────

describe('[COMP:providers/fallback] wrapFallback — both providers fail', () => {
  it('rethrows the ORIGINAL primary error when both fail', async () => {
    const primaryErr = Object.assign(new Error('primary 429'), { status: 429 })
    const fallbackErr = Object.assign(new Error('fallback 503'), { status: 503 })
    const wrapped = wrapFallback(
      makeProvider('primary', { throwError: primaryErr }),
      makeProvider('fallback', { throwError: fallbackErr }),
    )
    // Caller sees the primary error — the recovery cascade should not
    // mutate the shape downstream code observes.
    await expect(collectStream(wrapped.stream(makeRequest()))).rejects.toThrow('primary 429')
  })

  it('does NOT fire the analytics hook when fallback also fails', async () => {
    const onFallback = vi.fn()
    const wrapped = wrapFallback(
      makeProvider('primary', { throwError: Object.assign(new Error('p'), { status: 429 }) }),
      makeProvider('fallback', { throwError: Object.assign(new Error('f'), { status: 500 }) }),
      { analytics: { onFallback } },
    )
    await expect(collectStream(wrapped.stream(makeRequest()))).rejects.toThrow()
    expect(onFallback).not.toHaveBeenCalled()
  })
})

// ── Custom retryable status list ───────────────────────────────

describe('[COMP:providers/fallback] wrapFallback — custom retryableStatus', () => {
  it('honors a narrowed retryableStatus list', async () => {
    const primaryErr = Object.assign(new Error('500'), { status: 500 })
    const fallback = makeProvider('fallback')
    const fallbackSpy = vi.spyOn(fallback, 'stream')
    // Caller restricts fallback to 429 only — 500 should pass through.
    const wrapped = wrapFallback(
      makeProvider('primary', { throwError: primaryErr }),
      fallback,
      { retryableStatus: [429] },
    )
    await expect(collectStream(wrapped.stream(makeRequest()))).rejects.toThrow('500')
    expect(fallbackSpy).not.toHaveBeenCalled()
  })
})
