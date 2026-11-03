import { describe, expect, it, vi } from 'vitest'
import { bufferProviderStream } from '../stream-backpressure.js'
import type { StreamChunk } from '../types.js'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

describe('[COMP:providers/stream-backpressure] bounded provider read-ahead', () => {
  it('delivers immediately, then merges queued text without changing an emitted chunk or crossing boundaries', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    async function* source(): AsyncGenerator<StreamChunk> {
      yield { type: 'text_delta', text: 'first' }
      await blocked
      for (let i = 0; i < 100; i++) yield { type: 'text_delta', text: 'x'.repeat(100) }
      yield { type: 'thinking_delta', text: 'reason' }
      yield { type: 'thinking_delta', text: 'ing' }
      yield { type: 'tool_use_start', id: 'call', name: 'read' }
      yield { type: 'tool_use_delta', id: 'call', input: '{}' }
      yield { type: 'tool_use_end', id: 'call', providerSignature: 'signature' }
      yield { type: 'text_delta', text: 'last' }
    }
    const stream = bufferProviderStream(source)
    const first = (await stream.next()).value
    expect(first).toEqual({ type: 'text_delta', text: 'first' })
    release()
    await tick()
    const chunks: StreamChunk[] = []
    for await (const chunk of stream) chunks.push(chunk)
    expect(first).toEqual({ type: 'text_delta', text: 'first' })
    expect(chunks.slice(0, 3)).toEqual([4000, 4000, 2000].map(length => ({ type: 'text_delta', text: 'x'.repeat(length) })))
    expect(chunks.slice(3)).toEqual([
      { type: 'thinking_delta', text: 'reasoning' },
      { type: 'tool_use_start', id: 'call', name: 'read' },
      { type: 'tool_use_delta', id: 'call', input: '{}' },
      { type: 'tool_use_end', id: 'call', providerSignature: 'signature' },
      { type: 'text_delta', text: 'last' },
    ])
  })

  it.each(['events', 'characters'] as const)('bounds queued %s and resumes without losing chunks', async kind => {
    let produced = 0
    async function* source(): AsyncGenerator<StreamChunk> {
      for (let i = 0; i < 100; i++) {
        produced++
        yield kind === 'events' ? { type: 'tool_use_delta', id: 'call', input: String(i) }
          : { type: 'text_delta', text: String(i).padEnd(8192, '.') }
      }
    }
    const stream = bufferProviderStream(source)
    const first = (await stream.next()).value
    await tick()
    expect(produced).toBeLessThanOrEqual(kind === 'events' ? 33 : 9)
    const chunks = [first]
    for await (const chunk of stream) chunks.push(chunk)
    expect(chunks).toHaveLength(100)
    expect(produced).toBe(100)
  })

  it('delivers queued content before preserving the original provider error', async () => {
    const error = new Error('upstream unavailable')
    async function* source(): AsyncGenerator<StreamChunk> {
      yield { type: 'text_delta', text: 'partial' }
      throw error
    }
    const stream = bufferProviderStream(source)
    expect((await stream.next()).value).toEqual({ type: 'text_delta', text: 'partial' })
    await expect(stream.next()).rejects.toBe(error)
  })

  it('does not advance stateful history past an unconsumed terminal marker', async () => {
    const committed = vi.fn()
    async function* source(): AsyncGenerator<StreamChunk> {
      yield { type: 'text_delta', text: 'answer' }
      yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
      committed()
    }
    const parent = new AbortController()
    const stream = bufferProviderStream(source, parent.signal)
    await stream.next()
    await tick()
    expect(committed).not.toHaveBeenCalled()
    expect((await stream.next()).value?.type).toBe('message_end')
    await tick()
    expect(committed).not.toHaveBeenCalled()
    expect((await stream.next()).done).toBe(true)
    expect(committed).toHaveBeenCalledOnce()
    expect(parent.signal.aborted).toBe(false)
  })

  it('closes a producer paused by a full queue', async () => {
    const closed = vi.fn()
    async function* source(): AsyncGenerator<StreamChunk> {
      try {
        for (let i = 0; i < 100; i++) yield { type: 'tool_use_delta', id: 'call', input: 'x' }
      } finally { closed() }
    }
    const stream = bufferProviderStream(source)
    await stream.next()
    await tick()
    await stream.return(undefined)
    expect(closed).toHaveBeenCalledOnce()
  })

  it('does not commit stateful history when returned at the terminal marker', async () => {
    const committed = vi.fn()
    async function* source(): AsyncGenerator<StreamChunk> {
      yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
      committed()
    }
    const stream = bufferProviderStream(source)
    await stream.next()
    await stream.return(undefined)
    expect(committed).not.toHaveBeenCalled()
  })

  it.each(['return', 'abort'] as const)('cancels pending provider input on %s and closes it', async mode => {
    const parent = new AbortController()
    const closed = vi.fn()
    let observed!: AbortSignal
    async function* source(signal: AbortSignal): AsyncGenerator<StreamChunk> {
      observed = signal
      try {
        yield { type: 'text_delta', text: 'first' }
        await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      } finally { closed() }
    }
    const stream = bufferProviderStream(source, parent.signal)
    await stream.next()
    await tick()
    if (mode === 'return') await stream.return(undefined)
    else {
      parent.abort(new Error('cancelled'))
      await expect(stream.next()).rejects.toThrow('cancelled')
    }
    expect(observed.aborted).toBe(true)
    expect(closed).toHaveBeenCalledOnce()
  })
})
