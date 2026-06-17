import { describe, it, expect } from 'vitest'
import { createAccumulator, collectStream } from '../accumulator.js'
import type { StreamChunk } from '../types.js'

describe('[COMP:providers/accumulator] createAccumulator', () => {
  it('returns an empty response when nothing is pushed', () => {
    const acc = createAccumulator()
    const res = acc.finish()
    expect(res.content).toEqual([])
    expect(res.stopReason).toBe('end_turn')
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('captures model from message_start', () => {
    const acc = createAccumulator()
    acc.push({ type: 'message_start', model: 'gemini-flash' })
    acc.push({
      type: 'message_end',
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5 },
    })
    const res = acc.finish()
    expect(res.model).toBe('gemini-flash')
  })

  it('concatenates text_delta chunks into a single text block', () => {
    const acc = createAccumulator()
    acc.push({ type: 'text_delta', text: 'Hello, ' })
    acc.push({ type: 'text_delta', text: 'world' })
    acc.push({ type: 'text_delta', text: '!' })
    acc.push({
      type: 'message_end',
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 3 },
    })
    const res = acc.finish()
    expect(res.content).toEqual([{ type: 'text', text: 'Hello, world!' }])
  })

  it('assembles a tool_use block from streamed argument deltas', () => {
    const acc = createAccumulator()
    acc.push({ type: 'tool_use_start', id: 'call_1', name: 'weather' })
    acc.push({ type: 'tool_use_delta', id: 'call_1', input: '{"city":' })
    acc.push({ type: 'tool_use_delta', id: 'call_1', input: '"Tokyo"}' })
    acc.push({ type: 'tool_use_end', id: 'call_1' })
    acc.push({
      type: 'message_end',
      stopReason: 'tool_use',
      usage: { inputTokens: 0, outputTokens: 10 },
    })
    const res = acc.finish()
    expect(res.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'weather', input: { city: 'Tokyo' } },
    ])
    expect(res.stopReason).toBe('tool_use')
  })

  it('flushes accumulated text before emitting a tool_use block', () => {
    const acc = createAccumulator()
    acc.push({ type: 'text_delta', text: 'Let me check the weather.' })
    acc.push({ type: 'tool_use_start', id: 'call_1', name: 'weather' })
    acc.push({ type: 'tool_use_delta', id: 'call_1', input: '{"city":"Tokyo"}' })
    acc.push({ type: 'tool_use_end', id: 'call_1' })
    acc.push({
      type: 'message_end',
      stopReason: 'tool_use',
      usage: { inputTokens: 0, outputTokens: 15 },
    })
    const res = acc.finish()
    expect(res.content).toHaveLength(2)
    expect(res.content[0]).toEqual({ type: 'text', text: 'Let me check the weather.' })
    expect(res.content[1].type).toBe('tool_use')
  })

  it('preserves providerSignature on tool_use blocks when present', () => {
    const acc = createAccumulator()
    acc.push({ type: 'tool_use_start', id: 'call_1', name: 'weather' })
    acc.push({ type: 'tool_use_delta', id: 'call_1', input: '{}' })
    acc.push({ type: 'tool_use_end', id: 'call_1', providerSignature: 'sig_abc' })
    acc.push({
      type: 'message_end',
      stopReason: 'tool_use',
      usage: { inputTokens: 0, outputTokens: 5 },
    })
    const res = acc.finish()
    expect(res.content[0]).toMatchObject({
      type: 'tool_use',
      providerSignature: 'sig_abc',
    })
  })

  it('uses empty input object on malformed JSON instead of throwing', () => {
    const acc = createAccumulator()
    acc.push({ type: 'tool_use_start', id: 'call_1', name: 'weather' })
    acc.push({ type: 'tool_use_delta', id: 'call_1', input: '{bad json' })
    acc.push({ type: 'tool_use_end', id: 'call_1' })
    acc.push({
      type: 'message_end',
      stopReason: 'tool_use',
      usage: { inputTokens: 0, outputTokens: 5 },
    })
    const res = acc.finish()
    expect(res.content[0]).toMatchObject({
      type: 'tool_use',
      input: {},
    })
  })

  it('carries stopReason and usage through message_end', () => {
    const acc = createAccumulator()
    acc.push({
      type: 'message_end',
      stopReason: 'max_tokens',
      usage: { inputTokens: 500, outputTokens: 1000, cacheReadTokens: 100 },
    })
    const res = acc.finish()
    expect(res.stopReason).toBe('max_tokens')
    expect(res.usage.inputTokens).toBe(500)
    expect(res.usage.outputTokens).toBe(1000)
    expect(res.usage.cacheReadTokens).toBe(100)
  })
})

describe('[COMP:providers/accumulator] collectStream', () => {
  async function* chunks(list: StreamChunk[]): AsyncIterable<StreamChunk> {
    for (const c of list) yield c
  }

  it('drains an async iterable and returns the assembled response', async () => {
    const res = await collectStream(
      chunks([
        { type: 'message_start', model: 'gemini-flash' },
        { type: 'text_delta', text: 'Hi' },
        { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
      ]),
    )
    expect(res.model).toBe('gemini-flash')
    expect(res.content).toEqual([{ type: 'text', text: 'Hi' }])
  })
})
