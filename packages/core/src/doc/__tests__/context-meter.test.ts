/**
 * [COMP:doc/context-meter] Doc turn-context meter — Phase 0
 * instrumentation. Pure projection of an assembled doc turn into a
 * per-component token tally for the `doc_context_composition` event.
 *
 * Spec: docs/plans/doc-turn-context-optimization.md → Phase 0.
 */

import { describe, expect, it } from 'vitest'
import type { Message } from '../../providers/types.js'
import {
  measureDocContext,
  LARGE_DOC_RESULT_TOKENS,
} from '../context-meter.js'

/** A doc page-state tool_result carrying a body of `chars` ASCII chars. */
function docResult(name: string, chars: number, isError = false): Message {
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        toolUseId: `t-${name}-${chars}`,
        name,
        content: 'x'.repeat(chars),
        ...(isError ? { isError: true } : {}),
      },
    ],
  }
}

describe('[COMP:doc/context-meter] measureDocContext', () => {
  it('measures each provided component and zeroes the absent ones', () => {
    const c = measureDocContext({
      systemPrompt: 'a'.repeat(40), // ~10 tokens
      messages: [],
    })
    expect(c.systemPromptTokens).toBeGreaterThan(0)
    // Components not supplied report 0, never NaN/undefined.
    expect(c.skillBlockTokens).toBe(0)
    expect(c.liveOutlineTokens).toBe(0)
    expect(c.memoryContextTokens).toBe(0)
    expect(c.outlineBlockCount).toBe(0)
    expect(c.pageBlockCount).toBe(0)
    expect(c.pageVersion).toBe(0)
    expect(c.docHistoryTokens).toBe(0)
    expect(c.maxDocResultTokens).toBe(0)
    expect(c.largeDocResultCount).toBe(0)
  })

  it('sums doc page-state tool_result bodies into docHistoryTokens', () => {
    const c = measureDocContext({
      systemPrompt: '',
      messages: [docResult('patchPage', 400), docResult('getBlock', 400)],
    })
    // 400 ASCII chars ≈ 100 tokens each → ~200 total.
    expect(c.docHistoryTokens).toBeGreaterThanOrEqual(190)
    expect(c.maxDocResultTokens).toBeGreaterThan(0)
    // The whole-history estimate must dominate the doc-only subset.
    expect(c.messageHistoryTokens).toBeGreaterThan(0)
    expect(c.messageHistoryTokens).toBeGreaterThanOrEqual(c.docHistoryTokens)
  })

  it('ignores non-doc tool_results in the history walk', () => {
    const c = measureDocContext({
      systemPrompt: '',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 's1', name: 'searchBrain', content: 'y'.repeat(4000) },
          ],
        },
      ],
    })
    expect(c.docHistoryTokens).toBe(0)
    expect(c.largeDocResultCount).toBe(0)
  })

  it('counts a body over the large-snapshot threshold (incl. error/invalid_ops bodies)', () => {
    // (LARGE_DOC_RESULT_TOKENS + a margin) tokens ≈ chars * 4 for ASCII.
    const bigChars = (LARGE_DOC_RESULT_TOKENS + 100) * 4
    const c = measureDocContext({
      systemPrompt: '',
      // An error result (an invalid_ops full outline) must count — that is the
      // leak the elision change is meant to bound.
      messages: [docResult('patchPage', bigChars, true), docResult('getCurrentPage', 40)],
    })
    expect(c.largeDocResultCount).toBe(1)
    expect(c.maxDocResultTokens).toBeGreaterThanOrEqual(LARGE_DOC_RESULT_TOKENS)
  })

  it('echoes provider usage for correlation with the usage_tracking row', () => {
    const c = measureDocContext({
      systemPrompt: '',
      messages: [],
      usage: { inputTokens: 1234, outputTokens: 56, cacheReadTokens: 7890 },
    })
    expect(c.inputTokens).toBe(1234)
    expect(c.outputTokens).toBe(56)
    expect(c.cacheReadTokens).toBe(7890)
  })

  it('passes through page + outline counts and measures the live outline string', () => {
    const c = measureDocContext({
      systemPrompt: 'sys',
      skillBlock: 'k'.repeat(40),
      liveOutline: 'o'.repeat(80),
      outlineBlockCount: 12,
      memoryContext: 'm'.repeat(40),
      messages: [],
      pageBlockCount: 30,
      pageVersion: 5,
    })
    expect(c.skillBlockTokens).toBeGreaterThan(0)
    expect(c.liveOutlineTokens).toBeGreaterThan(0)
    expect(c.memoryContextTokens).toBeGreaterThan(0)
    expect(c.outlineBlockCount).toBe(12)
    expect(c.pageBlockCount).toBe(30)
    expect(c.pageVersion).toBe(5)
  })
})
