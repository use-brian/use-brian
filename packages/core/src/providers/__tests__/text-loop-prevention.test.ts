import { describe, it, expect } from 'vitest'
import { composeWrappers, wrapTextLoopPrevention, detectBlockRestart } from '../wrappers.js'
import type { StreamChunk, StreamFn } from '../types.js'
import { collectStream } from '../accumulator.js'

/** Create a mock StreamFn that yields the given chunks */
function mockStream(chunks: StreamChunk[]): StreamFn {
  return async function* () {
    for (const chunk of chunks) {
      yield chunk
    }
  }
}

function textChunks(texts: string[]): StreamChunk[] {
  return [
    { type: 'message_start', model: 'test' },
    ...texts.map((t): StreamChunk => ({ type: 'text_delta', text: t })),
    { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } },
  ]
}

describe('[COMP:providers/text-loop] Text loop prevention', () => {
  it('passes through normal text without interference', async () => {
    const stream = composeWrappers(
      mockStream(textChunks(['Hello, ', 'how are you ', 'doing today?'])),
      wrapTextLoopPrevention(),
    )

    const response = await collectStream(stream({
      model: 'test',
      messages: [],
      systemPrompt: 'test',
    }))

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.type === 'text' ? b.text : '')
      .join('')

    expect(text).toBe('Hello, how are you doing today?')
    expect(response.stopReason).toBe('end_turn')
  })

  it('detects degenerate backspace spam', async () => {
    const stream = composeWrappers(
      mockStream(textChunks(['Good answer. ', '\b\b\b\b\b\b\b\b\b\b'])),
      wrapTextLoopPrevention(),
    )

    const response = await collectStream(stream({
      model: 'test',
      messages: [],
      systemPrompt: 'test',
    }))

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.type === 'text' ? b.text : '')
      .join('')

    // Should have clean text only (the retry also loops, so we get truncated)
    // Since the mock stream always produces the same output, both attempts loop
    expect(text).toContain('Good answer.')
    expect(text).not.toContain('\b')
  })

  it('detects zero-width character spam', async () => {
    const zwj = '\u200B\u200C\u200D'
    const stream = composeWrappers(
      mockStream(textChunks(['Start. ', zwj.repeat(5)])),
      wrapTextLoopPrevention(),
    )

    const response = await collectStream(stream({
      model: 'test',
      messages: [],
      systemPrompt: 'test',
    }))

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.type === 'text' ? b.text : '')
      .join('')

    expect(text).toContain('Start.')
    expect(text).not.toContain('\u200B')
  })

  it('detects single character infinite repetition', async () => {
    const stream = composeWrappers(
      mockStream(textChunks(['Hello ', 'aaaaaaaaaa'])),
      wrapTextLoopPrevention(),
    )

    const response = await collectStream(stream({
      model: 'test',
      messages: [],
      systemPrompt: 'test',
    }))

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.type === 'text' ? b.text : '')
      .join('')

    expect(text).toContain('Hello')
  })

  it('detects n-gram repetition (4-gram appearing 3+ times)', async () => {
    // Build text where "the quick brown fox" repeats 3+ times
    const repeatedPhrase = 'the quick brown fox '
    const normalText = 'This is a perfectly normal introduction to the topic. '
    const loopingText = normalText + repeatedPhrase.repeat(4)

    // Split into streaming chunks (word by word)
    const words = loopingText.split(' ').filter(Boolean)
    const chunks = words.map((w) => w + ' ')

    const stream = composeWrappers(
      mockStream(textChunks(chunks)),
      wrapTextLoopPrevention(),
    )

    const response = await collectStream(stream({
      model: 'test',
      messages: [],
      systemPrompt: 'test',
    }))

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.type === 'text' ? b.text : '')
      .join('')

    // Should contain the normal text but stop before/during the loop
    expect(text).toContain('normal introduction')
  })

  it('detects a whole-answer restart the n-gram window misses (block-restart)', () => {
    // A ~130-word answer with a distinctive opening, repeated 3×. The repeat
    // period exceeds the 100-word n-gram window, so detectNgramRepetition is
    // blind to it; the opening fingerprint reappears verbatim, so the
    // block-restart detector catches it.
    const answer =
      'I found the issue with the failing workflow configuration after a careful review. ' +
      'The steps were pointed at an assistant name instead of a valid identifier, which ' +
      'is why every run rejected at validation time before any work could begin. The fix ' +
      'I propose repoints all four steps at the primary assistant so the run can proceed ' +
      'cleanly from start to finish without any further manual intervention required here. '
    const looping = answer + answer + answer

    const { looping: detected, cleanEnd } = detectBlockRestart(looping)
    expect(detected).toBe(true)
    // Trims to the first clean copy — the second occurrence starts at answer.length.
    expect(cleanEnd).toBe(answer.length)
    expect(looping.slice(0, cleanEnd)).toBe(answer)
  })

  it('block-restart does not flag normal long-form prose', () => {
    const prose =
      'The company brain grows more useful the longer a team relies on it every day. ' +
      'Memory accumulates around people, customers, deals, and the decisions that shaped them. ' +
      'Retrieval surfaces the right context at the moment a question is actually asked aloud. ' +
      'None of these sentences share an opening fingerprint with the first, so nothing trips. '
    const { looping } = detectBlockRestart(prose)
    expect(looping).toBe(false)
  })

  it('block-restart stays off for short answers (under the min buffer)', () => {
    const { looping } = detectBlockRestart('Short reply. Short reply. Short reply.')
    expect(looping).toBe(false)
  })

  it('converts a token-capped restart loop into a clean end_turn (the prod incident)', async () => {
    // Reproduces session abab9918: the model restarted its whole answer until
    // the output-token cap and the stream ended on `max_tokens` mid-sentence.
    // The repeat period (~65 words) exceeds the 100-word n-gram window, so only
    // the block-restart detector fires. With it, the wrapper aborts the loop and
    // synthesizes a clean `end_turn` instead of passing the truncated cap through.
    const answer =
      'I found the issue with the failing workflow configuration after a careful review. ' +
      'The steps were pointed at an assistant name instead of a valid identifier, which ' +
      'is why every run rejected at validation time before any work could begin. The fix ' +
      'I propose repoints all four steps at the primary assistant so the run can proceed ' +
      'cleanly from start to finish without any further manual intervention required here. '
    const words = (answer + answer + answer).split(' ').filter(Boolean)
    const chunks: StreamChunk[] = [
      { type: 'message_start', model: 'test' },
      ...words.map((w): StreamChunk => ({ type: 'text_delta', text: w + ' ' })),
      // The model ran to the cap mid-loop, like the real turn (output_tokens 4186).
      { type: 'message_end', stopReason: 'max_tokens', usage: { inputTokens: 0, outputTokens: 4186 } },
    ]

    const stream = composeWrappers(
      mockStream(chunks),
      wrapTextLoopPrevention(),
    )

    const response = await collectStream(stream({
      model: 'test',
      messages: [],
      systemPrompt: 'test',
    }))

    // Pre-fix this passed straight through as `max_tokens`; the block-restart
    // detector fires (both attempts loop) and synthesizes a clean terminus.
    expect(response.stopReason).toBe('end_turn')
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.type === 'text' ? b.text : '')
      .join('')
    expect(text).toContain('I found the issue')
  })

  it('does not interfere with tool use chunks', async () => {
    const chunks: StreamChunk[] = [
      { type: 'message_start', model: 'test' },
      { type: 'text_delta', text: 'Let me check. ' },
      { type: 'tool_use_start', id: 'call_1', name: 'weather' },
      { type: 'tool_use_delta', id: 'call_1', input: '{"city":"Tokyo"}' },
      { type: 'tool_use_end', id: 'call_1' },
      { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
    ]

    const stream = composeWrappers(
      mockStream(chunks),
      wrapTextLoopPrevention(),
    )

    const response = await collectStream(stream({
      model: 'test',
      messages: [],
      systemPrompt: 'test',
    }))

    expect(response.stopReason).toBe('tool_use')
    expect(response.content.some((b) => b.type === 'tool_use')).toBe(true)
  })
})
