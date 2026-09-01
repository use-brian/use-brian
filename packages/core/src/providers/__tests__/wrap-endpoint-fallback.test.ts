import { describe, it, expect, vi } from 'vitest'
import { wrapEndpointFallback, type EndpointFallbackEvent } from '../wrap-endpoint-fallback.js'
import type {
  LLMProvider,
  Message,
  ProviderRequest,
  ProviderSession,
  SendOptions,
  SessionOptions,
  StreamChunk,
} from '../types.js'

// ── Fixtures ───────────────────────────────────────────────────

const START: StreamChunk = { type: 'message_start', model: 'endpoint-model' }
const END: StreamChunk = { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 0 } }

function textRun(text: string, model: string): StreamChunk[] {
  return [
    { type: 'message_start', model },
    { type: 'text_delta', text },
    { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 4 } },
  ]
}

/**
 * `script` is replayed in order; an entry that is an Error is THROWN at that
 * point, which is what lets a case emit `message_start` and only then fail —
 * the exact shape `streamCompat` produces for an upstream error frame.
 */
function scripted(name: string, script: (StreamChunk | Error)[]): LLMProvider {
  const run = async function* (): AsyncIterable<StreamChunk> {
    for (const step of script) {
      if (step instanceof Error) throw step
      yield step
    }
  }
  return {
    name,
    models: [`${name}-model`],
    stream: () => run(),
    createSession(_opts: SessionOptions): ProviderSession {
      return { send: (_m: Message[], _o?: SendOptions) => run() }
    },
  }
}

function request(model = 'gemini-pro'): ProviderRequest {
  return { model, systemPrompt: 'test', messages: [{ role: 'user', content: 'hi' }] }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

function httpError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number }
  err.status = status
  return err
}

// ── Healthy endpoint ───────────────────────────────────────────

describe('[COMP:providers/endpoint-fallback] endpoint succeeds', () => {
  it('never touches the fallback and replays every chunk in order', async () => {
    const primary = scripted('endpoint', textRun('from endpoint', 'endpoint-model'))
    const fallback = scripted('platform', textRun('from platform', 'gemini-pro'))
    const spy = vi.spyOn(fallback, 'stream')
    const wrapped = wrapEndpointFallback(primary, fallback)

    const chunks = await collect(wrapped.stream(request()))

    expect(spy).not.toHaveBeenCalled()
    expect(chunks).toEqual(textRun('from endpoint', 'endpoint-model'))
  })

  it('does not fall back for a tools-only turn (a tool call is real output)', async () => {
    const primary = scripted('endpoint', [
      START,
      { type: 'tool_use_start', id: 'c1', name: 'webSearch' },
      { type: 'tool_use_delta', id: 'c1', input: '{}' },
      { type: 'tool_use_end', id: 'c1' },
      { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 3, outputTokens: 9 } },
    ])
    const fallback = scripted('platform', textRun('from platform', 'gemini-pro'))
    const spy = vi.spyOn(fallback, 'stream')

    const chunks = await collect(wrapEndpointFallback(primary, fallback).stream(request()))

    expect(spy).not.toHaveBeenCalled()
    expect(chunks.some((c) => c.type === 'tool_use_start')).toBe(true)
  })
})

// ── The four failure shapes ────────────────────────────────────

describe('[COMP:providers/endpoint-fallback] endpoint fails before any visible output', () => {
  it('falls back on HTTP 530 — the Cloudflare tunnel status wrapFallback does not list', async () => {
    // 2026-08-30, Oulu expert: `HTTP 530` / `error code: 1033`. It is absent
    // from DEFAULT_RETRYABLE_STATUS, so the platform wrapper would not have
    // retried it. The whole 5xx range is the predicate here for exactly that
    // reason.
    const primary = scripted('endpoint', [httpError(530, '[openai-compat:workspace-x] HTTP 530')])
    const fallback = scripted('platform', textRun('from platform', 'gemini-pro'))
    const events: EndpointFallbackEvent[] = []

    const chunks = await collect(
      wrapEndpointFallback(primary, fallback, { onFallback: (e) => events.push(e) }).stream(request()),
    )

    expect(chunks).toEqual(textRun('from platform', 'gemini-pro'))
    expect(events).toEqual([{ reason: 'http_status', status: 530, detail: '[openai-compat:workspace-x] HTTP 530' }])
  })

  it('falls back on a status-less transport failure', async () => {
    // A tunnel that is fully down makes fetch REJECT, with no status at all.
    // wrapFallback never retries a null status; for an endpoint someone runs
    // themselves that is the most likely outage of all.
    const primary = scripted('endpoint', [new Error('fetch failed: ECONNREFUSED')])
    const fallback = scripted('platform', textRun('from platform', 'gemini-pro'))
    const events: EndpointFallbackEvent[] = []

    const chunks = await collect(
      wrapEndpointFallback(primary, fallback, { onFallback: (e) => events.push(e) }).stream(request()),
    )

    expect(chunks).toEqual(textRun('from platform', 'gemini-pro'))
    expect(events[0]?.reason).toBe('network')
    expect(events[0]?.status).toBe(null)
  })

  it('falls back on a mid-stream error frame that arrives AFTER message_start', async () => {
    // The regression that motivates this wrapper existing at all. `streamCompat`
    // yields `message_start` before reading a single SSE frame, so a
    // one-chunk peek (wrapFallback) has already committed by the time the
    // error frame throws. Five of the six 2026-08-30 failures had this shape.
    const primary = scripted('endpoint', [
      START,
      new Error('[openai-compat:workspace-x] upstream returned an error mid-stream: Codex attempted a disabled capability: webSearch (porter_error)'),
    ])
    const fallback = scripted('platform', textRun('from platform', 'gemini-pro'))
    const events: EndpointFallbackEvent[] = []

    const chunks = await collect(
      wrapEndpointFallback(primary, fallback, { onFallback: (e) => events.push(e) }).stream(request()),
    )

    expect(chunks).toEqual(textRun('from platform', 'gemini-pro'))
    expect(events[0]?.reason).toBe('stream_error')
    // The dead endpoint's message_start must NOT leak through: the model id
    // the caller records has to be the one that actually answered.
    expect(chunks.filter((c) => c.type === 'message_start')).toEqual([{ type: 'message_start', model: 'gemini-pro' }])
  })

  it('falls back when the endpoint completes having emitted nothing at all', async () => {
    const primary = scripted('endpoint', [START, END])
    const fallback = scripted('platform', textRun('from platform', 'gemini-pro'))
    const events: EndpointFallbackEvent[] = []

    const chunks = await collect(
      wrapEndpointFallback(primary, fallback, { onFallback: (e) => events.push(e) }).stream(request()),
    )

    expect(chunks).toEqual(textRun('from platform', 'gemini-pro'))
    expect(events[0]?.reason).toBe('empty_stream')
  })

  it('passes the request through unchanged, model included', async () => {
    const primary = scripted('endpoint', [httpError(502, 'HTTP 502')])
    const fallback = scripted('platform', textRun('from platform', 'gemini-pro'))
    const spy = vi.spyOn(fallback, 'stream')

    await collect(wrapEndpointFallback(primary, fallback).stream(request('gemini-max')))

    // The custom lane already receives the resolved Brian serving alias, so
    // the platform side routes it correctly with nothing chosen by hand.
    expect(spy.mock.calls[0]?.[0]?.model).toBe('gemini-max')
  })
})

// ── What must NOT fall back ────────────────────────────────────

describe('[COMP:providers/endpoint-fallback] failures that stay failures', () => {
  it('rethrows a 4xx rather than hiding a misconfigured endpoint', async () => {
    // A bad key or a wrong model id is the endpoint answering correctly that
    // the REQUEST is wrong. Serving it elsewhere would hide a configuration
    // error the admin has to fix, permanently.
    const primary = scripted('endpoint', [httpError(401, 'HTTP 401')])
    const fallback = scripted('platform', textRun('from platform', 'gemini-pro'))
    const spy = vi.spyOn(fallback, 'stream')

    await expect(collect(wrapEndpointFallback(primary, fallback).stream(request())))
      .rejects.toThrow('HTTP 401')
    expect(spy).not.toHaveBeenCalled()
  })

  it('does not swap after the endpoint has emitted user-visible text', async () => {
    const primary = scripted('endpoint', [
      START,
      { type: 'text_delta', text: 'half an answer' },
      new Error('[openai-compat:workspace-x] upstream returned an error mid-stream: boom'),
    ])
    const fallback = scripted('platform', textRun('from platform', 'gemini-pro'))
    const spy = vi.spyOn(fallback, 'stream')

    await expect(collect(wrapEndpointFallback(primary, fallback).stream(request())))
      .rejects.toThrow('mid-stream')
    expect(spy).not.toHaveBeenCalled()
  })

  it('treats thinking as committed output', async () => {
    // Reasoning already streamed to the web UI. Swapping now would show one
    // model's reasoning followed by another model's answer.
    const primary = scripted('endpoint', [
      START,
      { type: 'thinking_delta', text: 'considering...' },
      new Error('[openai-compat:workspace-x] upstream returned an error mid-stream: boom'),
    ])
    const fallback = scripted('platform', textRun('from platform', 'gemini-pro'))
    const spy = vi.spyOn(fallback, 'stream')

    await expect(collect(wrapEndpointFallback(primary, fallback).stream(request())))
      .rejects.toThrow('mid-stream')
    expect(spy).not.toHaveBeenCalled()
  })

  it('reports the ENDPOINT error when the fallback fails too', async () => {
    const primary = scripted('endpoint', [httpError(530, 'HTTP 530')])
    const fallback = scripted('platform', [new Error('gemini exploded')])

    await expect(collect(wrapEndpointFallback(primary, fallback).stream(request())))
      .rejects.toThrow('HTTP 530')
  })

  it('does not report a fallback that produced nothing', async () => {
    const primary = scripted('endpoint', [httpError(503, 'HTTP 503')])
    const fallback = scripted('platform', [])
    const events: EndpointFallbackEvent[] = []

    await expect(collect(
      wrapEndpointFallback(primary, fallback, { onFallback: (e) => events.push(e) }).stream(request()),
    )).rejects.toThrow('HTTP 503')
    expect(events).toEqual([])
  })
})

// ── Session lane ───────────────────────────────────────────────

describe('[COMP:providers/endpoint-fallback] createSession', () => {
  it('falls back on the session lane too', async () => {
    const primary = scripted('endpoint', [START, httpError(500, 'HTTP 500')])
    const fallback = scripted('platform', textRun('from platform', 'gemini-pro'))

    const session = wrapEndpointFallback(primary, fallback).createSession({ model: 'gemini-pro', systemPrompt: 'x' })
    const chunks = await collect(session.send([{ role: 'user', content: 'hi' }]))

    expect(chunks).toEqual(textRun('from platform', 'gemini-pro'))
  })
})
