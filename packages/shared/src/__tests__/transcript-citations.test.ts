/**
 * [COMP:media/transcript-citations] — prose citations → typed pointers.
 *
 * The behaviours that decide whether a citation is trustworthy: an invented
 * moment must not become a pointer, and a real one must land on the segment that
 * actually covers it rather than near it.
 */

import { describe, expect, it } from 'vitest'
import { buildCitationIndex, extractCitations } from '../transcript-citations.js'

// A 4-segment recording ending at 60s.
const SEGMENTS = [
  { segmentIndex: 0, startMs: 0, endMs: 10_000, speaker: 'Ken' },
  { segmentIndex: 1, startMs: 10_000, endMs: 20_000, speaker: 'Priya' },
  { segmentIndex: 2, startMs: 20_000, endMs: 45_000, speaker: 'Ken' },
  { segmentIndex: 3, startMs: 45_000, endMs: 60_000, speaker: 'Priya' },
]
const INDEX = buildCitationIndex(SEGMENTS, 60_000)

describe('[COMP:media/transcript-citations] extractCitations', () => {
  it('resolves a cited moment to the segment covering it, with its speaker', () => {
    const cites = extractCitations('We ship in Q3 [0:00:30].', INDEX)
    expect(cites).toEqual([
      { startMs: 30_000, segmentIndex: 2, speaker: 'Ken', confidence: 'parsed' },
    ])
  })

  it('snaps to the covering segment, not the nearest boundary', () => {
    // 44s is late in segment 2 and closer to segment 3's start (45s) than to
    // segment 2's (20s). "Nearest start" would answer 3 — and be wrong: the words
    // spoken at 44s are segment 2's.
    expect(extractCitations('[0:00:44]', INDEX)[0].segmentIndex).toBe(2)
  })

  it('takes a moment exactly on a boundary as the segment that starts there', () => {
    expect(extractCitations('[0:00:45]', INDEX)[0].segmentIndex).toBe(3)
  })

  it('drops a moment past the end of the transcript — the model invented it', () => {
    // Well-formed, parseable, and impossible: the recording ends at 60s.
    expect(extractCitations('As agreed [0:01:30].', INDEX)).toEqual([])
  })

  it('drops an impossible stamp without dropping the real one beside it', () => {
    // [00:85] is not 85 seconds — `parseStamp` rejects it. The valid citation in
    // the same sentence must still survive.
    const cites = extractCitations('Priced [00:85] and shipped [0:00:15].', INDEX)
    expect(cites.map((c) => c.startMs)).toEqual([15_000])
  })

  it('finds every citation in a multi-claim field, in order', () => {
    const cites = extractCitations(
      'Ship Cantonese in Q3 [0:00:05]. Defer billing [0:00:50].',
      INDEX,
    )
    expect(cites.map((c) => [c.startMs, c.segmentIndex])).toEqual([
      [5_000, 0],
      [50_000, 3],
    ])
  })

  it('deduplicates a moment cited twice in one field', () => {
    const cites = extractCitations('Ken said [0:00:05]. And again [0:00:05].', INDEX)
    expect(cites).toHaveLength(1)
  })

  it('accepts the [MM:SS] short form', () => {
    expect(extractCitations('[00:30]', INDEX)[0].startMs).toBe(30_000)
  })

  it('returns nothing for prose with no citations', () => {
    expect(extractCitations('We agreed to ship.', INDEX)).toEqual([])
  })

  it('snaps a moment before the first segment forward rather than reporting none', () => {
    const late = buildCitationIndex([{ segmentIndex: 7, startMs: 30_000, endMs: 40_000 }], 40_000)
    expect(extractCitations('[0:00:10]', late)[0].segmentIndex).toBe(7)
  })

  it('carries a null speaker through when diarization produced none', () => {
    const undiarized = buildCitationIndex([{ segmentIndex: 0, startMs: 0, endMs: 10_000 }], 10_000)
    expect(extractCitations('[0:00:05]', undiarized)[0].speaker).toBeNull()
  })
})

describe('[COMP:media/transcript-citations] buildCitationIndex', () => {
  it('sorts unordered segments — the snap is a binary search', () => {
    // Unsorted input would make the search return a plausible WRONG segment
    // rather than fail, so the index sorts defensively.
    const shuffled = buildCitationIndex([SEGMENTS[3], SEGMENTS[0], SEGMENTS[2], SEGMENTS[1]], 60_000)
    expect(extractCitations('[0:00:30]', shuffled)[0].segmentIndex).toBe(2)
  })

  it('does not mutate the caller’s array', () => {
    const input = [SEGMENTS[3], SEGMENTS[0]]
    buildCitationIndex(input, 60_000)
    expect(input[0].segmentIndex).toBe(3)
  })

  it('skips the range check when the duration is unknown', () => {
    // No duration ⇒ nothing to validate against; a citation is kept rather than
    // silently dropped on a technicality.
    const noDuration = buildCitationIndex(SEGMENTS, 0)
    expect(extractCitations('[9:00:00]', noDuration)).toHaveLength(1)
  })
})
