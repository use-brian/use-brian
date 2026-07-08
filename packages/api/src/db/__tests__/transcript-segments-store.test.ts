import { describe, it, expect } from 'vitest'
import { segmentTranscript, type Utterance } from '../transcript-segments-store.js'

/**
 * Pure unit tests for the transcript segmenter (recording-to-brain Phase 3).
 * No DB. Component tag: [COMP:brain/transcript-segments-store].
 *
 * Spec: docs/architecture/media/transcription.md §"Segment granularity + timestamp model".
 */
describe('[COMP:brain/transcript-segments-store] segmentTranscript', () => {
  it('packs consecutive same-speaker utterances into one segment', () => {
    const u: Utterance[] = [
      { startMs: 0, endMs: 3000, speaker: 'A', text: 'Hello there.' },
      { startMs: 3000, endMs: 6000, speaker: 'A', text: 'How are you today?' },
    ]
    const segs = segmentTranscript(u)
    expect(segs).toHaveLength(1)
    expect(segs[0].text).toBe('Hello there. How are you today?')
    expect(segs[0].speaker).toBe('A')
    expect(segs[0].startMs).toBe(0)
    expect(segs[0].endMs).toBe(6000)
    expect(segs[0].segmentIndex).toBe(0)
    expect(segs[0].utteranceRefs).toHaveLength(2)
  })

  it('never merges two speakers — breaks on speaker change', () => {
    const u: Utterance[] = [
      { startMs: 0, endMs: 3000, speaker: 'A', text: 'I think we should ship it.' },
      { startMs: 3000, endMs: 6000, speaker: 'B', text: 'I disagree, it needs more testing.' },
    ]
    const segs = segmentTranscript(u)
    expect(segs).toHaveLength(2)
    expect(segs[0].speaker).toBe('A')
    expect(segs[1].speaker).toBe('B')
    expect(segs.map((s) => s.segmentIndex)).toEqual([0, 1])
  })

  it('with no diarization (null speaker) segments by size, never one giant blob', () => {
    const chunk = 'This is a sentence about the quarterly numbers and the pipeline. '.repeat(8) // ~520 chars
    const u: Utterance[] = Array.from({ length: 6 }, (_, i) => ({
      startMs: i * 4000,
      endMs: (i + 1) * 4000,
      speaker: null,
      text: chunk,
    }))
    const segs = segmentTranscript(u)
    expect(segs.length).toBeGreaterThan(1)
    for (const s of segs) {
      expect(s.text.length).toBeLessThanOrEqual(1500)
      expect(s.speaker).toBeNull()
    }
    // segment_index is dense + monotonic
    expect(segs.map((s) => s.segmentIndex)).toEqual(segs.map((_, i) => i))
  })

  it('sentence-splits a single over-long utterance into multiple segments', () => {
    const long = 'word '.repeat(800).trim() // ~3999 chars, no sentence punctuation
    const u: Utterance[] = [{ startMs: 0, endMs: 60000, speaker: 'A', text: long }]
    const segs = segmentTranscript(u)
    expect(segs.length).toBeGreaterThan(1)
    for (const s of segs) expect(s.text.length).toBeLessThanOrEqual(1500)
    // timestamps are apportioned across the pieces and stay ordered
    expect(segs[0].startMs).toBe(0)
    expect(segs[segs.length - 1].endMs).toBe(60000)
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i].startMs).toBeGreaterThanOrEqual(segs[i - 1].startMs)
    }
  })

  it('merges a trailing sub-200-char fragment back into the previous same-speaker segment', () => {
    const big = 'We reviewed the entire deployment plan in detail today. '.repeat(24).trim() // ~1300 chars
    const u: Utterance[] = [
      { startMs: 0, endMs: 80000, speaker: 'A', text: big },
      { startMs: 80000, endMs: 82000, speaker: 'A', text: 'Okay.' },
    ]
    const segs = segmentTranscript(u)
    // The tiny "Okay." tail is merged, so no scrap segment survives.
    expect(segs.every((s) => s.text.length >= 200 || segs.length === 1)).toBe(true)
    expect(segs[segs.length - 1].text.endsWith('Okay.')).toBe(true)
  })

  it('drops whitespace/empty utterances rather than emitting empty segments', () => {
    const u: Utterance[] = [
      { startMs: 0, endMs: 1000, speaker: 'A', text: '   ' },
      { startMs: 1000, endMs: 2000, speaker: 'A', text: 'Real content here.' },
    ]
    const segs = segmentTranscript(u)
    expect(segs).toHaveLength(1)
    expect(segs[0].text).toBe('Real content here.')
  })
})
