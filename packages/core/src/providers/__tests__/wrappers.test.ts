import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { wrapProvider, wrapIdleTimeout } from '../wrappers.js'
import { collectStream } from '../accumulator.js'
import type { LLMProvider, StreamChunk, ProviderRequest, ProviderSession, SessionOptions, SendOptions, Message } from '../types.js'

function makeChunks(text: string): StreamChunk[] {
  return [
    { type: 'message_start', model: 'fake' },
    { type: 'text_delta', text },
    { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
  ]
}

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

  it('forwards SessionOptions (incl. signal) to the underlying provider', () => {
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

    wrapped.createSession({
      model: 'fake', systemPrompt: 'sp', signal: controller.signal,
    })

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

describe('[COMP:providers/wrappers] wrapIdleTimeout — first-chunk vs inter-chunk windows', () => {
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

  it('keeps the legacy single-window behaviour when firstChunkTimeoutMs is omitted', async () => {
    const fn = wrapIdleTimeout(40)(timedStream([200]))
    await expect(drain(fn)).rejects.toThrow(/Stream idle for 40ms/)
  })

  it('aborts a never-starting stream at the prefill window, tagged as a first-chunk stall', async () => {
    const fn = wrapIdleTimeout(20, 60)(timedStream([500]))
    await expect(drain(fn)).rejects.toThrow(/Stream idle for 60ms \(no first chunk/)
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
    expect(String(err)).not.toMatch(/no first chunk/)
  })
})
