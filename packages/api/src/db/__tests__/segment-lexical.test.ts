/**
 * Shared segment-corpus lexical arm.
 * Component tag: [COMP:brain/segment-lexical].
 *
 * B6 of docs/plans/corpus-substrate-hardening.md §6. The arm this replaces
 * bound `%<whole query>%`, so a natural-language question matched only when
 * all of its characters appeared verbatim — the vector arm was doing all the
 * work, which is untenable once the embed budget makes partial embedding a
 * designed steady state.
 */

import { describe, it, expect } from 'vitest'
import {
  buildLexicalMatch,
  fuseByReciprocalRank,
  tokenizeSearchTerms,
} from '../segment-lexical.js'

describe('[COMP:brain/segment-lexical] tokenizeSearchTerms', () => {
  it('splits a natural-language question into content terms, dropping stopwords', () => {
    expect(
      tokenizeSearchTerms('what did the supplier say about the delayed shipment'),
    ).toEqual(['supplier', 'delayed', 'shipment'])
  })

  it('drops terms below the trigram index floor', () => {
    // pg_trgm indexes 3-grams: a shorter `%x%` pattern cannot be served by the
    // index and would degrade the arm into a scan.
    expect(tokenizeSearchTerms('is it ok to go')).toEqual([])
    expect(tokenizeSearchTerms('Q3 revenue')).toEqual(['revenue'])
  })

  it('lowercases and de-duplicates while preserving order', () => {
    expect(tokenizeSearchTerms('Invoice invoice INVOICE overdue')).toEqual([
      'invoice',
      'overdue',
    ])
  })

  it('keeps email addresses and hyphenated words whole', () => {
    expect(tokenizeSearchTerms('mail ada@harborlane.example re follow-up')).toEqual([
      'mail',
      'ada@harborlane.example',
      'follow-up',
    ])
  })

  it('shingles CJK runs into 3-character windows', () => {
    // Chinese has no word delimiters, so whitespace tokenization yields one
    // giant term. Bigrams would be the linguistically natural unit but cannot
    // use a trigram index, so the window is three.
    expect(tokenizeSearchTerms('供应商延迟发货')).toEqual([
      '供应商',
      '应商延',
      '商延迟',
      '延迟发',
      '迟发货',
    ])
  })

  it('drops a too-short CJK run when indexable terms exist alongside it', () => {
    // `发票` is 2 characters, so `%发票%` cannot use the trigram index. One
    // unindexed term in an OR forces the whole predicate to scan, which would
    // undo the index for the terms that CAN use it.
    expect(tokenizeSearchTerms('发票 invoice overdue')).toEqual(['invoice', 'overdue'])
  })

  it('falls back to a short CJK run when it is the entire query', () => {
    // Returning nothing for a two-character Chinese query is a silent failure;
    // here a bounded scan is the better of two bad options.
    expect(tokenizeSearchTerms('发票')).toEqual(['发票'])
    expect(tokenizeSearchTerms('发票 的')).toEqual(['发票'])
  })

  it('caps the term count so the predicate cannot grow unbounded', () => {
    const long = Array.from({ length: 40 }, (_, i) => `term${i}`).join(' ')
    expect(tokenizeSearchTerms(long)).toHaveLength(8)
  })

  it('returns nothing for an empty or whitespace query', () => {
    expect(tokenizeSearchTerms('')).toEqual([])
    expect(tokenizeSearchTerms('   ')).toEqual([])
  })
})

describe('[COMP:brain/segment-lexical] buildLexicalMatch', () => {
  it('matches each term against every column and counts DISTINCT term hits', () => {
    const values: unknown[] = ['owner-1']
    const match = buildLexicalMatch({
      terms: ['deposit', 'refund'],
      columns: ['es.segment_text', 'm.subject'],
      values,
    })!
    expect(values).toEqual(['owner-1', '%deposit%', '%refund%'])
    // Placeholders continue the caller's numbering.
    expect(match.where).toBe(
      '((es.segment_text ILIKE $2 OR m.subject ILIKE $2) OR (es.segment_text ILIKE $3 OR m.subject ILIKE $3))',
    )
    // Counting terms rather than occurrences: a passage repeating one word
    // must not outrank one covering the whole query.
    expect(match.hits).toContain('CASE WHEN')
    expect(match.hits.split('CASE WHEN')).toHaveLength(3)
  })

  it('returns null when there is nothing to match, so the caller can skip the arm', () => {
    expect(buildLexicalMatch({ terms: [], columns: ['a'], values: [] })).toBeNull()
    expect(buildLexicalMatch({ terms: ['x'], columns: [], values: [] })).toBeNull()
  })
})

describe('[COMP:brain/segment-lexical] fuseByReciprocalRank', () => {
  const id = (x: { id: string }) => x.id

  it('ranks a document found by both arms above one found by either alone', () => {
    const vector = [{ id: 'a' }, { id: 'b' }]
    const lexical = [{ id: 'c' }, { id: 'a' }]
    expect(fuseByReciprocalRank([vector, lexical], id).map(id)).toEqual(['a', 'c', 'b'])
  })

  it('preserves a single arm order when the other is empty', () => {
    const only = [{ id: 'x' }, { id: 'y' }, { id: 'z' }]
    expect(fuseByReciprocalRank([only, []], id).map(id)).toEqual(['x', 'y', 'z'])
  })

  it('de-duplicates across arms', () => {
    const arm = [{ id: 'dup' }]
    expect(fuseByReciprocalRank([arm, arm, arm], id)).toHaveLength(1)
  })

  it('returns nothing when every arm is empty', () => {
    expect(fuseByReciprocalRank([[], []], id)).toEqual([])
  })
})
