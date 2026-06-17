import { describe, it, expect } from 'vitest'
import {
  fitMessagesToBudget,
  resolveInputTokenLimit,
  MAX_TOOL_RESULT_TOKENS,
  TOOL_RESULT_TRUNCATION_MARKER,
} from '../context-budget.js'
import { wrapContextBudget } from '../wrappers.js'
import { collectStream } from '../accumulator.js'
import { estimateStringTokens, estimateTokens } from '../../compaction/index.js'
import type { Message, StreamChunk, StreamFn } from '../types.js'

function makeChunks(text: string): StreamChunk[] {
  return [
    { type: 'message_start', model: 'fake' },
    { type: 'text_delta', text },
    { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
  ]
}

/** A plain ASCII string of roughly `tokens` tokens (~4 chars/token). */
function ascii(tokens: number): string {
  return 'x'.repeat(tokens * 4)
}

function hasToolResult(m: Message): boolean {
  return Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result')
}

describe('[COMP:providers/context-budget] resolveInputTokenLimit', () => {
  it('maps Gemini ids to the 1M window', () => {
    expect(resolveInputTokenLimit('gemini-flash')).toBe(1_048_576)
    expect(resolveInputTokenLimit('gemini-3.1-pro-preview')).toBe(1_048_576)
  })

  it('maps Claude fallback ids to the 200K window', () => {
    expect(resolveInputTokenLimit('claude-haiku-4-5')).toBe(200_000)
  })

  it('falls back to the default for unknown models', () => {
    expect(resolveInputTokenLimit('mystery-model')).toBe(1_048_576)
  })
})

describe('[COMP:providers/context-budget] fitMessagesToBudget', () => {
  it('passes through untouched when already under budget', () => {
    const messages: Message[] = [{ role: 'user', content: 'hello' }]
    const result = fitMessagesToBudget(messages, 10_000)
    expect(result.trimmed).toBe(false)
    expect(result.messages).toBe(messages) // same reference — cheap hot path
    expect(result.dropped).toBe(0)
  })

  it('clamps an oversized tool_result block (read-time twin of the write cap)', () => {
    const huge = ascii(50_000) // ~50k tokens, over MAX_TOOL_RESULT_TOKENS (25k)
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', name: 'foo', content: huge }] },
    ]
    // Budget below the pre-clamp size so stage 1 runs, but above the clamped size.
    const result = fitMessagesToBudget(messages, 30_000)
    expect(result.trimmed).toBe(true)
    expect(result.dropped).toBe(0) // clamping alone sufficed — no eviction
    const block = (result.messages[0]!.content as Extract<Message['content'], unknown[]>)[0]!
    expect(block.type).toBe('tool_result')
    if (block.type === 'tool_result') {
      expect(block.content.endsWith(TOOL_RESULT_TRUNCATION_MARKER)).toBe(true)
      expect(estimateStringTokens(block.content)).toBeLessThanOrEqual(MAX_TOOL_RESULT_TOKENS + 50)
    }
  })

  it('reproduces the incident — two giant tool_results fit after clamping alone', () => {
    // Cynthia's session: two ~570k-token listScheduledJobs results dwarf the
    // rest. Scaled down here; the shape (clamp brings it under) is identical.
    const big = ascii(50_000)
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'a', name: 'listScheduledJobs', content: big }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'b', name: 'listScheduledJobs', content: big }] },
      { role: 'user', content: 'Done' },
    ]
    const budget = 60_000 // < pre (~100k) but > post-clamp (~50k)
    expect(estimateTokens(messages)).toBeGreaterThan(budget)
    const result = fitMessagesToBudget(messages, budget)
    expect(result.trimmed).toBe(true)
    expect(result.dropped).toBe(0)
    expect(result.tokensAfter).toBeLessThanOrEqual(budget)
    expect(result.messages.length).toBe(messages.length) // nothing evicted
  })

  it('evicts oldest messages, keeps the system prefix + latest, adds a breadcrumb', () => {
    const messages: Message[] = [
      { role: 'system', content: 'SYSTEM' },
      ...Array.from({ length: 20 }, (_, i): Message => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg-${i}` })),
      { role: 'user', content: 'the latest question' },
    ]
    const result = fitMessagesToBudget(messages, 30) // tiny — forces eviction
    expect(result.trimmed).toBe(true)
    expect(result.dropped).toBeGreaterThan(0)
    expect(result.messages[0]).toEqual({ role: 'system', content: 'SYSTEM' }) // prefix preserved
    expect(result.messages[1]!.role).toBe('system') // breadcrumb
    expect(String(result.messages[1]!.content)).toMatch(/omitted to fit/)
    const last = result.messages[result.messages.length - 1]!
    expect(last.content).toBe('the latest question') // current turn never dropped
    expect(result.messages.length).toBeLessThan(messages.length)
  })

  it('never leaves an orphan tool_result at the head after eviction', () => {
    const messages: Message[] = [
      { role: 'user', content: 'old' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'f', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'a', name: 'f', content: 'r' }] },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'latest' },
    ]
    // Budget keeps a recent suffix but drops the assistant tool_use, which would
    // orphan the tool_result — it must be stripped, not sent to the provider.
    const result = fitMessagesToBudget(messages, 6)
    expect(result.trimmed).toBe(true)
    expect(result.messages.some(hasToolResult)).toBe(false)
    expect(result.messages[result.messages.length - 1]!.content).toBe('latest')
  })
})

describe('[COMP:providers/context-budget] wrapContextBudget', () => {
  it('passes through unchanged when under budget', async () => {
    let seen: Message[] | undefined
    const inner: StreamFn = async function* (req) {
      seen = req.messages
      yield* makeChunks('ok')
    }
    const wrapped = wrapContextBudget()(inner)
    const messages: Message[] = [{ role: 'user', content: 'hi' }]
    const res = await collectStream(wrapped({ model: 'gemini-flash', systemPrompt: 'sp', messages }))
    expect(res.content).toEqual([{ type: 'text', text: 'ok' }])
    expect(seen).toBe(messages) // not re-allocated when under budget
  })

  it('trims the request the provider receives when over the model window', async () => {
    let seenTokens = Number.POSITIVE_INFINITY
    const inner: StreamFn = async function* (req) {
      seenTokens = estimateTokens(req.messages)
      yield* makeChunks('ok')
    }
    const wrapped = wrapContextBudget()(inner)
    // claude-haiku → 200K window. One 300k-token tool_result blows past it;
    // the wrapper must clamp it before the provider sees it.
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't', name: 'big', content: ascii(300_000) }] },
    ]
    await collectStream(wrapped({ model: 'claude-haiku-4-5', systemPrompt: 'sp', messages }))
    expect(seenTokens).toBeLessThan(200_000)
  })

  it('trims harder and retries once on an overflow 400 from the provider', async () => {
    let calls = 0
    const inner: StreamFn = async function* (req) {
      void req
      calls++
      if (calls === 1) {
        throw new Error('Gemini API error 400: {"error":{"message":"The input token count exceeds the maximum number of tokens allowed 1048576."}}')
      }
      yield* makeChunks('recovered')
    }
    const wrapped = wrapContextBudget()(inner)
    const res = await collectStream(wrapped({ model: 'gemini-flash', systemPrompt: 'sp', messages: [{ role: 'user', content: 'hi' }] }))
    expect(calls).toBe(2)
    expect(res.content).toEqual([{ type: 'text', text: 'recovered' }])
  })

  it('does NOT retry on a non-overflow error', async () => {
    let calls = 0
    const inner: StreamFn = async function* () {
      calls++
      throw new Error('boom — unrelated 500')
    }
    const wrapped = wrapContextBudget()(inner)
    await expect(collectStream(wrapped({ model: 'gemini-flash', systemPrompt: 'sp', messages: [{ role: 'user', content: 'hi' }] })))
      .rejects.toThrow('boom')
    expect(calls).toBe(1)
  })

  it('does NOT retry once a chunk has already streamed', async () => {
    let calls = 0
    const inner: StreamFn = async function* () {
      calls++
      yield { type: 'text_delta', text: 'partial' } as StreamChunk
      throw new Error('exceeds the maximum number of tokens')
    }
    const wrapped = wrapContextBudget()(inner)
    await expect(collectStream(wrapped({ model: 'gemini-flash', systemPrompt: 'sp', messages: [{ role: 'user', content: 'hi' }] })))
      .rejects.toThrow(/exceeds the maximum/)
    expect(calls).toBe(1)
  })
})
