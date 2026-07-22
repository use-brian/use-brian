import { describe, it, expect } from 'vitest'
import { buildImapSearchQuery, compileKeywordOrTree, hasNonAsciiTerm } from '../search-criteria.js'

describe('[COMP:api/mailbox-imap-client] IMAP search criteria compilation', () => {
  it('compiles one keyword to a bare TEXT term', () => {
    expect(compileKeywordOrTree(['invoice'])).toEqual({ text: 'invoice' })
  })

  it('compiles two keywords to one OR pair', () => {
    expect(compileKeywordOrTree(['invoice', 'receipt'])).toEqual({
      or: [{ text: 'invoice' }, { text: 'receipt' }],
    })
  })

  it('compiles N keywords to a right-nested OR tree (one round trip — D12 #2)', () => {
    expect(compileKeywordOrTree(['a', 'b', 'c', 'd'])).toEqual({
      or: [
        { text: 'a' },
        { or: [{ text: 'b' }, { or: [{ text: 'c' }, { text: 'd' }] }] },
      ],
    })
  })

  it('drops empty/blank terms and returns null when nothing remains', () => {
    expect(compileKeywordOrTree(['', '  '])).toBeNull()
    expect(compileKeywordOrTree(['  x  '])).toEqual({ text: 'x' })
  })

  it('maps window bounds, from, and subject onto the query', () => {
    const q = buildImapSearchQuery({
      keywords: ['invoice', 'receipt'],
      from: 'ada@acme.com',
      subject: 'Q3',
      since: '2026-04-23',
      before: '2026-07-01',
      limit: 20,
    })
    expect(q.since).toEqual(new Date('2026-04-23T00:00:00Z'))
    expect(q.before).toEqual(new Date('2026-07-01T00:00:00Z'))
    expect(q.from).toBe('ada@acme.com')
    expect(q.subject).toBe('Q3')
    expect(q.or).toEqual([{ text: 'invoice' }, { text: 'receipt' }])
  })

  it('places a single keyword as a top-level TEXT criterion', () => {
    const q = buildImapSearchQuery({ keywords: ['发票'], since: '2026-04-23', limit: 20 })
    expect(q.text).toBe('发票')
    expect(q.or).toBeUndefined()
  })

  it('detects non-ASCII terms (the BADCHARSET-fallback trigger)', () => {
    expect(hasNonAsciiTerm({ keywords: ['发票'] })).toBe(true)
    expect(hasNonAsciiTerm({ keywords: ['invoice'], from: '陈小姐' })).toBe(true)
    expect(hasNonAsciiTerm({ keywords: ['invoice'], subject: 'Q3' })).toBe(false)
  })
})
