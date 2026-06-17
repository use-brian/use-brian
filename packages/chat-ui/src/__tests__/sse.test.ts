import { describe, it, expect } from 'vitest'
import { createSSEBuffer, parseSSEStream } from '../sse.js'

describe('[COMP:chat-ui/sse] parseSSEStream', () => {
  it('parses a single complete event', () => {
    const buffer = createSSEBuffer()
    const events = [...parseSSEStream('event: token\ndata: hi\n\n', buffer)]
    expect(events).toEqual([{ event: 'token', data: 'hi' }])
    expect(buffer.text).toBe('')
  })

  it('defaults the event name to "message" when omitted', () => {
    const buffer = createSSEBuffer()
    const events = [...parseSSEStream('data: just-data\n\n', buffer)]
    expect(events).toEqual([{ event: 'message', data: 'just-data' }])
  })

  it('buffers a chunk that ends mid-event', () => {
    const buffer = createSSEBuffer()
    const first = [...parseSSEStream('event: token\ndata: par', buffer)]
    expect(first).toEqual([])
    expect(buffer.text).toBe('event: token\ndata: par')
    const second = [...parseSSEStream('tial\n\n', buffer)]
    expect(second).toEqual([{ event: 'token', data: 'partial' }])
    expect(buffer.text).toBe('')
  })

  it('emits multiple events from one chunk', () => {
    const buffer = createSSEBuffer()
    const events = [
      ...parseSSEStream(
        'event: token\ndata: a\n\nevent: token\ndata: b\n\n',
        buffer,
      ),
    ]
    expect(events).toEqual([
      { event: 'token', data: 'a' },
      { event: 'token', data: 'b' },
    ])
  })

  it('skips events with empty data', () => {
    const buffer = createSSEBuffer()
    const events = [...parseSSEStream('event: ping\n\n', buffer)]
    expect(events).toEqual([])
  })

  it('JSON-parses data when valid, falls back to raw string otherwise', () => {
    const buffer = createSSEBuffer()
    const events = [
      ...parseSSEStream(
        'event: text_delta\ndata: {"text":"hello"}\n\nevent: raw\ndata: not-json\n\n',
        buffer,
      ),
    ]
    expect(events).toEqual([
      { event: 'text_delta', data: { text: 'hello' } },
      { event: 'raw', data: 'not-json' },
    ])
  })
})
