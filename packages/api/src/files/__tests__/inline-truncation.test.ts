import { describe, it, expect } from 'vitest'
import { truncateForInline, INLINE_TRUNCATION_CHAR_LIMIT } from '../inline-truncation.js'

// Regression guard for the 2026-08-02 incident: a 4,159-row CSV reached the
// model as its first 331 rows carrying only `... [truncated]`, and the model
// reported the fragment's date range as the whole file's.
// See docs/plans/channel-attachment-truncation.md.
describe('[COMP:files/inline-truncation] truncateForInline', () => {
  it('returns text under the limit untouched', () => {
    const text = 'a,b,c\n'.repeat(10)
    expect(truncateForInline(text)).toBe(text)
  })

  it('returns text exactly at the limit untouched', () => {
    const text = 'x'.repeat(INLINE_TRUNCATION_CHAR_LIMIT)
    expect(truncateForInline(text)).toBe(text)
  })

  it('preserves exactly the limit of original characters', () => {
    const text = 'x'.repeat(INLINE_TRUNCATION_CHAR_LIMIT * 3)
    const out = truncateForInline(text)
    expect(out.slice(0, INLINE_TRUNCATION_CHAR_LIMIT)).toBe(
      text.slice(0, INLINE_TRUNCATION_CHAR_LIMIT),
    )
    expect(out.length).toBeGreaterThan(INLINE_TRUNCATION_CHAR_LIMIT)
  })

  it('states how much was withheld, in characters and percent', () => {
    const text = 'y'.repeat(INLINE_TRUNCATION_CHAR_LIMIT * 4)
    const out = truncateForInline(text)
    expect(out).toContain('20,000')
    expect(out).toContain('80,000')
    expect(out).toContain('25%')
    expect(out).toContain('75%')
  })

  it('reports line counts for line-oriented text', () => {
    const row = 'a,b,c,d,e,f,g,h\n' // 16 chars
    const text = row.repeat(5000) // 80,000 chars across 5,000 lines
    const out = truncateForInline(text)
    expect(out).toContain('of 5,000 lines')
    expect(out).toMatch(/first 1,2\d{2} of 5,000 lines/)
  })

  it('omits the line clause for single-line text', () => {
    const out = truncateForInline('z'.repeat(INLINE_TRUNCATION_CHAR_LIMIT + 500))
    expect(out).not.toContain('lines')
  })

  it('forbids describing the file from the surviving fragment', () => {
    const out = truncateForInline('q'.repeat(INLINE_TRUNCATION_CHAR_LIMIT + 1))
    expect(out).toContain('TRUNCATED')
    expect(out).toMatch(/date range/i)
    expect(out).toMatch(/tell the user/i)
  })

  it('no longer emits the bare marker that caused the incident', () => {
    const out = truncateForInline('w'.repeat(INLINE_TRUNCATION_CHAR_LIMIT + 1))
    expect(out).not.toMatch(/\.\.\. \[truncated\]$/)
  })

  it('never floors the shown percentage to 0 on a huge file', () => {
    const out = truncateForInline('c'.repeat(INLINE_TRUNCATION_CHAR_LIMIT * 5000))
    expect(out).toContain('about 1%')
    expect(out).toContain('99%')
  })

  it('uses no em dash (transcript text can surface in user-facing renders)', () => {
    const out = truncateForInline('m'.repeat(INLINE_TRUNCATION_CHAR_LIMIT + 1))
    expect(out).not.toContain('—')
  })
})
