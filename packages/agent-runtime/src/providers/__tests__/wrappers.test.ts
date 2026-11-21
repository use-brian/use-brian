import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { wrapProvider, wrapIdleTimeout, wrapLog } from '../wrappers.js'
import { collectStream } from '../accumulator.js'
import { markProviderStreamPhase, withProviderStreamTiming } from '../stream-timing.js'
import type { LLMProvider, StreamChunk, ProviderRequest, ProviderSession, SessionOptions, SendOptions, Message } from '../types.js'

function makeChunks(text: string): StreamChunk[] {
  return [
    { type: 'message_start', model: 'fake' },
    { type: 'text_delta', text },
    { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
  ]
}

describe('[COMP:providers/wrappers] stream latency accounting', () => {
  afterEach(() => vi.restoreAllMocks())

  it('separates provider waits from a slow consumer without changing chunks', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const log = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const thinking: StreamChunk = { type: 'thinking_delta', text: 'private reasoning' }
    const text: StreamChunk = { type: 'text_delta', text: 'private reply' }
    const stream = wrapLog()(async function* () {
      now += 100; yield thinking
      now += 300; yield text
    })({ model: 'private-endpoint', systemPrompt: 'private prompt', messages: [] })[Symbol.asyncIterator]()
    expect((await stream.next()).value).toBe(thinking)
    now += 250
    expect((await stream.next()).value).toBe(text)
    now += 50
    expect((await stream.next()).done).toBe(true)
    expect(log).toHaveBeenCalledWith('[stream] complete: 2 chunks in 700ms', {
      model: 'other', upstream_wait_ms: 400, consumer_wait_ms: 300,
      first_chunk_ms: 100, first_thinking_ms: 100, first_text_ms: 650,
    })
    expect(JSON.stringify(log.mock.calls)).not.toContain('private')
  })

  it('reports a provider failure before output and preserves the error', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const log = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const error = new Error('private provider error')
    const stream = wrapLog()(async function* () {
      now += 25; throw error
    })({ model: 'fake', systemPrompt: '', messages: [] })
    await expect(collectStream(stream)).rejects.toBe(error)
    expect(log).toHaveBeenCalledWith('[stream] error: 0 chunks in 25ms', {
      model: 'other', upstream_wait_ms: 25, consumer_wait_ms: 0,
    })
  })

  it('accounts for consumer cancellation while paused on a chunk', async () => {
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const log = vi.spyOn(console, 'debug').mockImplementation(() => {})
    let closed = false
    const stream = wrapLog()(async function* () {
      try { now += 10; yield makeChunks('reply')[0] } finally { closed = true }
    })({ model: 'fake', systemPrompt: '', messages: [] })[Symbol.asyncIterator]()
    await stream.next()
    now += 90
    await stream.return?.()
    expect(closed).toBe(true)
    expect(log).toHaveBeenCalledWith('[stream] cancelled: 1 chunks in 100ms', {
      model: 'other', upstream_wait_ms: 10, consumer_wait_ms: 90, first_chunk_ms: 10,
    })
  })

  it('joins repeated session sends and auxiliary streams to the correct concurrent run', async () => {
    const log = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const provider = wrapProvider(makeFakeProvider({}))
    const options = { model: 'private alias', systemPrompt: 'private prompt' }
    const messages: Message[] = [{ role: 'user', content: 'private request' }]
    const run = () => withProviderStreamTiming(async traceId => {
      await collectStream(provider.stream({ ...options, messages }))
      markProviderStreamPhase('loop')
      const session = provider.createSession(options)
      await collectStream(session.send(messages))
      await collectStream(session.send(messages))
      markProviderStreamPhase('post_loop')
      await collectStream(provider.stream({ ...options, messages }))
      return traceId
    })
    const traces = await Promise.all([run(), run()])
    expect(new Set(traces).size).toBe(2)
    expect(log.mock.calls).toHaveLength(8)
    expect(log.mock.calls.every(args => args.length === 1 && typeof args[0] === 'string' && !args[0].includes('\n'))).toBe(true)
    const parsed = log.mock.calls.map(([line]) => JSON.parse(line))
    for (const trace of traces) {
      expect(trace).toMatch(/^pt-[0-9a-f-]{36}$/)
      const rows = parsed.filter(row => row.provider_trace_id === trace)
      expect(rows.map(row => [row.provider_stream_ordinal, row.provider_phase])).toEqual([
        [1, 'pre_loop'], [2, 'loop'], [3, 'loop'], [4, 'post_loop'],
      ])
      expect(rows.every(row => Number.isInteger(row.upstream_wait_ms) && Number.isInteger(row.consumer_wait_ms))).toBe(true)
    }
    expect(JSON.stringify(log.mock.calls)).not.toContain('private')
  })

  it('keeps the trace on failed and cancelled streams and omits it from detached work after the run', async () => {
    const log = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const providerError = new Error('private error details')
    const request = { model: 'fake', systemPrompt: 'private prompt', messages: [] }
    let startDetached!: () => void
    const gate = new Promise<void>(resolve => { startDetached = resolve })
    let detached!: Promise<unknown>
    let trace!: string
    const stream = wrapLog()(async function* () { yield makeChunks('private text')[0] })
    const failure = wrapLog()(async function* () { throw providerError })
    await expect(withProviderStreamTiming(async traceId => {
      trace = traceId
      detached = gate.then(() => collectStream(stream(request)))
      const iterator = stream(request)[Symbol.asyncIterator]()
      await iterator.next()
      await iterator.return?.()
      await collectStream(failure(request))
    })).rejects.toBe(providerError)
    startDetached()
    await detached
    expect(log.mock.calls).toHaveLength(3)
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
      message: expect.stringContaining('cancelled'),
      provider_trace_id: trace, provider_stream_ordinal: 1, provider_phase: 'pre_loop',
    })
    expect(JSON.parse(log.mock.calls[1][0])).toMatchObject({
      message: expect.stringContaining('error'),
      provider_trace_id: trace, provider_stream_ordinal: 2, provider_phase: 'pre_loop',
    })
    expect(log.mock.calls[2][1]).not.toHaveProperty('provider_trace_id')
    expect(log.mock.calls[2][1]).not.toHaveProperty('provider_stream_ordinal')
    expect(log.mock.calls[2][1]).not.toHaveProperty('provider_phase')
  })
})

/**
 * A configurable in-memory provider for testing. Each `stream` and each
 * `session.send` invocation either yields the supplied chunks immediately
 * or hangs forever — caller's choice.
 */
function makeFakeProvider(behaviour: {
  streamChunks?: StreamChunk[]
  sendChunks?: StreamChunk[]
  hangStream?: boolean
  hangSend?: boolean
} = {}): LLMProvider {
  return {
    name: 'fake',
    models: ['fake'],
    async *stream(_request: ProviderRequest): AsyncIterable<StreamChunk> {
      if (behaviour.hangStream) {
        await new Promise(() => { /* hang forever */ })
      }
      for (const chunk of behaviour.streamChunks ?? makeChunks('stream output')) {
        yield chunk
      }
    },
    createSession(_options: SessionOptions): ProviderSession {
      return {
        async *send(_messages: Message[], _opts?: SendOptions): AsyncIterable<StreamChunk> {
          if (behaviour.hangSend) {
            await new Promise(() => { /* hang forever */ })
          }
          for (const chunk of behaviour.sendChunks ?? makeChunks('session output')) {
            yield chunk
          }
        },
      }
    },
  }
}

describe('[COMP:providers/wrappers] wrapProvider', () => {
  it('passes stream chunks through unchanged on the happy path', async () => {
    const wrapped = wrapProvider(makeFakeProvider())
    const response = await collectStream(wrapped.stream({
      model: 'fake',
      systemPrompt: 'sp',
      messages: [],
    }))
    expect(response.content).toEqual([{ type: 'text', text: 'stream output' }])
  })

  it('passes session.send chunks through unchanged on the happy path', async () => {
    const wrapped = wrapProvider(makeFakeProvider())
    const session = wrapped.createSession({ model: 'fake', systemPrompt: 'sp' })
    const response = await collectStream(session.send([]))
    expect(response.content).toEqual([{ type: 'text', text: 'session output' }])
  })

  it('aborts session.send when the inner provider hangs past the idle timeout', async () => {
    // The fake hangs BEFORE its first chunk, so the first-chunk (prefill)
    // window governs — set both windows tight for the test.
    const wrapped = wrapProvider(makeFakeProvider({ hangSend: true }), {
      idleTimeoutMs: 50,
      firstChunkTimeoutMs: 50,
    })
    const session = wrapped.createSession({ model: 'fake', systemPrompt: 'sp' })

    await expect(collectStream(session.send([])))
      .rejects
      .toThrow(/idle for 50ms/)
  })

  it('aborts stream when the inner provider hangs past the idle timeout', async () => {
    const wrapped = wrapProvider(makeFakeProvider({ hangStream: true }), {
      idleTimeoutMs: 50,
      firstChunkTimeoutMs: 50,
    })

    await expect(collectStream(wrapped.stream({
      model: 'fake',
      systemPrompt: 'sp',
      messages: [],
    })))
      .rejects
      .toThrow(/idle for 50ms/)
  })

  it('forwards SessionOptions (incl. signal) at the first checked send', async () => {
    const createSessionSpy = vi.fn((_opts: SessionOptions): ProviderSession => ({
      async *send(): AsyncIterable<StreamChunk> {
        yield { type: 'message_start', model: 'fake' }
      },
    }))
    const base: LLMProvider = {
      name: 'fake', models: ['fake'],
      async *stream(): AsyncIterable<StreamChunk> {
        yield { type: 'message_start', model: 'fake' }
      },
      createSession: createSessionSpy,
    }
    const controller = new AbortController()
    const wrapped = wrapProvider(base)

    const session = wrapped.createSession({
      model: 'fake', systemPrompt: 'sp', signal: controller.signal,
    })
    expect(createSessionSpy).not.toHaveBeenCalled()
    await collectStream(session.send([]))
    expect(createSessionSpy).toHaveBeenCalledWith(expect.objectContaining({
      signal: controller.signal,
    }))
  })

  it('isolates per-call wrapper state — a hang on one send does not poison the next', async () => {
    let hang = true
    const base: LLMProvider = {
      name: 'fake', models: ['fake'],
      async *stream() { /* noop */ },
      createSession() {
        return {
          async *send() {
            if (hang) {
              hang = false
              await new Promise(() => { /* hang first call */ })
            }
            for (const c of makeChunks('recovered')) yield c
          },
        }
      },
    }
    const wrapped = wrapProvider(base, { idleTimeoutMs: 50, firstChunkTimeoutMs: 50 })
    const session = wrapped.createSession({ model: 'fake', systemPrompt: 'sp' })

    await expect(collectStream(session.send([]))).rejects.toThrow(/idle for 50ms/)

    // Second call on the same session should succeed — the idle timer is
    // re-armed per-send, not held over from the previous invocation.
    const ok = await collectStream(session.send([]))
    expect(ok.content).toEqual([{ type: 'text', text: 'recovered' }])
  })
})

describe('[COMP:providers/wrappers] wrapIdleTimeout — first-deliverable vs inter-chunk windows', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  /** Inner stream that waits `delays[i]` ms before yielding chunk i. */
  function timedStream(delays: number[]) {
    return async function* (_req: ProviderRequest): AsyncIterable<StreamChunk> {
      for (const d of delays) {
        await sleep(d)
        yield { type: 'text_delta', text: 'x' }
      }
    }
  }

  const req = { model: 'fake', messages: [], systemPrompt: '' } as unknown as ProviderRequest

  async function drain(fn: (r: ProviderRequest) => AsyncIterable<StreamChunk>) {
    const out: StreamChunk[] = []
    for await (const c of fn(req)) out.push(c)
    return out
  }

  it('allows a slow first chunk inside the prefill window, then enforces the tighter inter-chunk window', async () => {
    // First chunk after 120ms — over the 40ms inter-chunk window, but well
    // inside the 400ms prefill window. Later gaps are tiny.
    const fn = wrapIdleTimeout(40, 400)(timedStream([120, 5, 5]))
    const out = await drain(fn)
    expect(out).toHaveLength(3)
  })

  it('allows Argon initial reasoning beyond the ordinary prefill window', async () => {
    const fn = wrapIdleTimeout(20, 30)(timedStream([80]))
    const chunks = []
    for await (const chunk of fn({ ...req, model: 'gemini-4-argon-research' })) chunks.push(chunk)
    expect(chunks).toHaveLength(1)
  })

  it('still aborts Argon gaps after output starts', async () => {
    const fn = wrapIdleTimeout(20, 30)(timedStream([1, 100]))
    const drainArgon = async () => { for await (const _ of fn({ ...req, model: 'gemini-4-argon-research' })) { /* drain */ } }
    await expect(drainArgon()).rejects.toThrow('Stream idle for 20ms')
  })

  it('keeps the legacy single-window behaviour when firstChunkTimeoutMs is omitted', async () => {
    const fn = wrapIdleTimeout(40)(timedStream([200]))
    await expect(drain(fn)).rejects.toThrow(/Stream idle for 40ms/)
  })

  it('aborts a never-starting stream at the prefill window, tagged as a first-deliverable stall', async () => {
    const fn = wrapIdleTimeout(20, 60)(timedStream([500]))
    await expect(drain(fn)).rejects.toThrow(/Stream idle for 60ms \(no deliverable chunk/)
  })

  it('aborts a mid-stream hang at the inter-chunk window even when the prefill window is generous', async () => {
    const fn = wrapIdleTimeout(30, 1000)(timedStream([5, 400]))
    let err: unknown
    try {
      await drain(fn)
    } catch (e) {
      err = e
    }
    expect(String(err)).toMatch(/Stream idle for 30ms/)
    expect(String(err)).not.toMatch(/no deliverable chunk/)
  })

  /** Real adapter shape: synthetic message_start yielded before the first
   *  network byte, then a prefill-length wait before the first deliverable chunk
   *  (gemini.ts convertStreamChunks / anthropic.ts both do this). */
  function adapterShapedStream(prefillMs: number, laterGaps: number[] = []) {
    return async function* (_req: ProviderRequest): AsyncIterable<StreamChunk> {
      yield { type: 'message_start', model: 'fake' }
      await sleep(prefillMs)
      yield { type: 'text_delta', text: 'x' }
      for (const d of laterGaps) {
        await sleep(d)
        yield { type: 'text_delta', text: 'x' }
      }
    }
  }

  it('keeps the prefill window armed through the synthetic message_start (prod 2026-07-16)', async () => {
    // Prefill (120ms) exceeds the 40ms inter-chunk window but sits inside the
    // 400ms prefill window. Before the fix, the eager message_start flipped
    // sawFirstChunk and this aborted at 40ms — the 2026-07-16 Telegram stall.
    const fn = wrapIdleTimeout(40, 400)(adapterShapedStream(120, [5]))
    const out = await drain(fn)
    expect(out).toHaveLength(3)
  })

  it('aborts a prefill overrun after message_start with the first-deliverable tag', async () => {
    const fn = wrapIdleTimeout(20, 60)(adapterShapedStream(500))
    await expect(drain(fn)).rejects.toThrow(/Stream idle for 60ms \(no deliverable chunk/)
  })

  /** Max can stream a short thought summary, then spend longer than the
   *  inter-chunk window reasoning before it commits reply text or a tool call. */
  function reasoningShapedStream(reasoningGapMs: number) {
    return async function* (_req: ProviderRequest): AsyncIterable<StreamChunk> {
      yield { type: 'message_start', model: 'fake' }
      await sleep(5)
      yield { type: 'thinking_delta', text: 'Considering the workflow change.' }
      await sleep(reasoningGapMs)
      yield { type: 'text_delta', text: 'Done.' }
    }
  }

  it('keeps the generous window armed through display-only reasoning (prod 2026-08-10)', async () => {
    // The 80ms reasoning gap exceeds the 30ms inter-chunk window but remains
    // inside the 160ms first-deliverable window.
    const fn = wrapIdleTimeout(30, 160)(reasoningShapedStream(80))
    const out = await drain(fn)
    expect(out.map((chunk) => chunk.type)).toEqual([
      'message_start',
      'thinking_delta',
      'text_delta',
    ])
  })

  it('reports a reasoning-phase overrun at the first-deliverable window', async () => {
    const fn = wrapIdleTimeout(20, 60)(reasoningShapedStream(500))
    await expect(drain(fn)).rejects.toThrow(
      /Stream idle for 60ms \(reasoning window — no deliverable chunk\)/,
    )
  })

  it('still enforces the inter-chunk window after the first deliverable chunk', async () => {
    const fn = wrapIdleTimeout(30, 1000)(adapterShapedStream(5, [400]))
    let err: unknown
    try {
      await drain(fn)
    } catch (e) {
      err = e
    }
    expect(String(err)).toMatch(/Stream idle for 30ms/)
    expect(String(err)).not.toMatch(/no deliverable chunk/)
  })
})


describe('[COMP:providers/wrappers] stream timing attribution', () => {
  it('separates slow consumer work from upstream waits without changing chunks', async () => {
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const log = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const chunks: StreamChunk[] = [{ type: 'text_delta', text: 'Fictional reply' },
      { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }]
    try {
      const wrapped = wrapLog()(async function* () {
        for (const chunk of chunks) { now += 15; yield chunk }
        now += 5
      })
      const received: StreamChunk[] = []
      for await (const chunk of wrapped({ model: 'fake', systemPrompt: '', messages: [] })) {
        received.push(chunk)
        now += 40
      }
      expect(received).toEqual(chunks)
      expect(log).toHaveBeenLastCalledWith('[stream] complete: 2 chunks in 115ms', { model: 'other', upstream_wait_ms: 35, consumer_wait_ms: 80, first_chunk_ms: 15, first_text_ms: 15 })
    } finally { clock.mockRestore(); log.mockRestore() }
  })
})
