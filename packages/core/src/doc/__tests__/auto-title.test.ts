import { describe, it, expect } from 'vitest'
import {
  AUTO_TITLE_AI_MIN_CHARS,
  AUTO_TITLE_MIN_CHARS,
  deriveCommentTitle,
  extractLeadingEmoji,
  generatePageTitle,
  sanitizeTitle,
} from '../auto-title.js'
import type { LLMProvider, StreamChunk } from '../../providers/types.js'

/**
 * Mock provider whose stream emits `response` as one text_delta, then a
 * message_end carrying `usage`. Exercises generatePageTitle without a model.
 */
function mockProvider(response: string): LLMProvider {
  return {
    createSession() {
      return { thoughtSignature: undefined } as never
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: 'text_delta', text: response } as StreamChunk
      yield {
        type: 'message_end',
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 5 },
      } as StreamChunk
    },
  } as unknown as LLMProvider
}

describe('[COMP:doc/auto-title] sanitizeTitle', () => {
  it('strips markdown, quotes, and trailing punctuation', () => {
    expect(sanitizeTitle('**Q3 Revenue** Review.')).toBe('Q3 Revenue Review')
    expect(sanitizeTitle('## `pipeline` notes')).toBe('pipeline notes')
    expect(sanitizeTitle('"Offsite plans"')).toBe('Offsite plans')
  })

  it('keeps only the first line and trims at a word boundary', () => {
    expect(sanitizeTitle('A title\nand an explanation')).toBe('A title')
    const long = 'This is a very long generated title that should be word boundary trimmed'
    const out = sanitizeTitle(long, 40)
    expect(out.length).toBeLessThanOrEqual(40)
    expect(long.startsWith(out)).toBe(true)
    expect(out.endsWith(' ')).toBe(false)
  })

  it('preserves non-latin titles', () => {
    expect(sanitizeTitle('星期五同朋友食飯')).toBe('星期五同朋友食飯')
  })
})

describe('[COMP:doc/auto-title] deriveCommentTitle', () => {
  it('labels a thread from its first comment, stripping markdown + trailing punctuation', () => {
    expect(deriveCommentTitle('**Group by owner** instead?')).toBe('Group by owner instead')
    expect(deriveCommentTitle('Can you confirm the Q3 dates')).toBe('Can you confirm the Q3 dates')
  })

  it('keeps only the first line of a multi-line comment', () => {
    expect(deriveCommentTitle('Fix the totals\nthe sum is off by 3')).toBe('Fix the totals')
  })

  it('trims a long comment to a word boundary', () => {
    const long = 'Please restructure the entire pricing section so enterprise comes first'
    const out = deriveCommentTitle(long, 40)!
    expect(out).not.toBeNull()
    expect(out.length).toBeLessThanOrEqual(40)
    expect(long.startsWith(out)).toBe(true)
    expect(out.endsWith(' ')).toBe(false)
  })

  it('returns null for an empty / whitespace body so the caller uses the generic label', () => {
    expect(deriveCommentTitle('')).toBeNull()
    expect(deriveCommentTitle('   \n  ')).toBeNull()
  })

  it('preserves a non-latin comment', () => {
    expect(deriveCommentTitle('幫我改成用負責人分組')).toBe('幫我改成用負責人分組')
  })
})

describe('[COMP:doc/auto-title] extractLeadingEmoji', () => {
  it('peels a simple leading emoji', () => {
    expect(extractLeadingEmoji('📈 Q3 Revenue Review')).toEqual({
      icon: '📈',
      rest: 'Q3 Revenue Review',
    })
  })

  it('handles a VS16-presentation emoji', () => {
    const out = extractLeadingEmoji('🗒️ Offsite Planning Notes')
    expect(out.icon).toBe('🗒️')
    expect(out.rest).toBe('Offsite Planning Notes')
  })

  it('handles a ZWJ-sequence emoji as one cluster', () => {
    const out = extractLeadingEmoji('👨‍👩‍👧 Family Budget')
    expect(out.icon).toBe('👨‍👩‍👧')
    expect(out.rest).toBe('Family Budget')
  })

  it('returns icon null and the input untouched when there is no leading emoji', () => {
    expect(extractLeadingEmoji('Q3 Revenue Review')).toEqual({
      icon: null,
      rest: 'Q3 Revenue Review',
    })
    // A leading non-emoji symbol (e.g. a heading hash) is not an icon.
    expect(extractLeadingEmoji('# Heading').icon).toBeNull()
  })
})

describe('[COMP:doc/auto-title] generatePageTitle', () => {
  it('returns a sanitized title + usage for real content', async () => {
    const result = await generatePageTitle(
      mockProvider('Q3 Revenue Growth Review'),
      'Q3 revenue is up 14% driven by enterprise renewals and net expansion.',
    )
    expect(result.title).toBe('Q3 Revenue Growth Review')
    expect(result.model).toBe('gemini-3.1-flash-lite')
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 5 })
  })

  it('peels the leading emoji into `icon` and keeps the clean title', async () => {
    const result = await generatePageTitle(
      mockProvider('📈 Q3 Revenue Growth Review'),
      'Q3 revenue is up 14% driven by enterprise renewals and net expansion.',
    )
    expect(result.icon).toBe('📈')
    expect(result.title).toBe('Q3 Revenue Growth Review')
  })

  it('leaves `icon` null when the model emits no emoji', async () => {
    const result = await generatePageTitle(
      mockProvider('Q3 Revenue Growth Review'),
      'Q3 revenue is up 14% driven by enterprise renewals.',
    )
    expect(result.icon).toBeNull()
  })

  it('returns null (and no model call) for empty plaintext', async () => {
    const result = await generatePageTitle(mockProvider('whatever'), '   \n  ')
    expect(result.title).toBeNull()
    expect(result.icon).toBeNull()
    expect(result.model).toBeNull()
    expect(result.usage).toBeNull()
  })

  it('falls back to the document opening when the model returns too few words', async () => {
    // Model emits a 1-word title → derive from the excerpt instead.
    const result = await generatePageTitle(
      mockProvider('Notes'),
      'Hiring plan for the new growth team across three regions next quarter.',
    )
    expect(result.title).not.toBeNull()
    expect(result.title!.split(/\s+/).length).toBeGreaterThanOrEqual(2)
    // Capitalized first letter from the fallback path.
    expect(result.title![0]).toBe(result.title![0].toUpperCase())
  })

  it('returns null when neither the model nor the excerpt yields ≥2 words', async () => {
    const result = await generatePageTitle(mockProvider('x'), 'hi')
    expect(result.title).toBeNull()
  })
})

describe('[COMP:doc/auto-title] thresholds', () => {
  it('the human floor is higher than the AI floor', () => {
    // Human edits need a developed page; the AI's first edit is intentional.
    expect(AUTO_TITLE_MIN_CHARS).toBeGreaterThan(AUTO_TITLE_AI_MIN_CHARS)
    expect(AUTO_TITLE_MIN_CHARS).toBe(500)
    expect(AUTO_TITLE_AI_MIN_CHARS).toBeGreaterThanOrEqual(1)
  })
})
