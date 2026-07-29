/**
 * Shared segment-corpus coverage disclosure.
 * Component tag: [COMP:brain/segment-coverage].
 *
 * B7 of docs/plans/corpus-substrate-hardening.md §6. The vector arm filters
 * `embedding IS NOT NULL`; with the drain budgeted (D7) a corpus is
 * deliberately never fully embedded, so "no results" and "not all of it is
 * indexed" must not look identical to the model (D9).
 */

import { describe, it, expect } from 'vitest'
import {
  COVERAGE_PROBE_LIMIT,
  FULL_COVERAGE,
  buildSegmentCoverage,
} from '../segment-coverage.js'

describe('[COMP:brain/segment-coverage] buildSegmentCoverage', () => {
  it('says nothing when every row in scope is embedded', () => {
    expect(buildSegmentCoverage(0, 'mailbox archive')).toEqual(FULL_COVERAGE)
    expect(buildSegmentCoverage(0, 'mailbox archive').note).toBeNull()
  })

  it('reports the exact count below the probe cap', () => {
    const coverage = buildSegmentCoverage(42, 'mailbox archive')
    expect(coverage.partial).toBe(true)
    expect(coverage.capped).toBe(false)
    expect(coverage.note).toContain('42 passages')
    expect(coverage.note).toContain('mailbox archive')
  })

  it('says "at least" once the bounded probe hits its cap', () => {
    // The probe stops counting at the cap so it cannot become the expensive
    // part of a cheap search; the note must not then imply an exact figure.
    const coverage = buildSegmentCoverage(COVERAGE_PROBE_LIMIT, 'mailbox archive')
    expect(coverage.capped).toBe(true)
    expect(coverage.note).toContain('at least 5,000')
  })

  it('tells the model what to DO, not just that coverage is partial', () => {
    // A note the model cannot act on is decoration. It has to say that a
    // negative result is inconclusive, or the model still reports an absence
    // it has no basis for.
    const note = buildSegmentCoverage(7, 'recording transcripts').note!
    expect(note).toContain('inconclusive')
    expect(note).toContain('keyword matching still covered everything')
    expect(note).toContain('recording transcripts')
  })
})
