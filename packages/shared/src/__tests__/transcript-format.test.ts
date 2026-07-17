import { describe, it, expect } from 'vitest'
import {
  formatStamp,
  parseStamp,
  scanStamps,
  formatTranscriptLine,
  formatTranscript,
} from '../transcript-format.js'

/**
 * The transcript wire format. Writer and reader must agree exactly: the model
 * cites what the prompt showed it, and the UI can only linkify what it parses.
 * Component tag: [COMP:media/transcript-format].
 */

describe('[COMP:media/transcript-format] formatStamp', () => {
  it('pads minutes and seconds but not hours', () => {
    expect(formatStamp(0)).toBe('0:00:00')
    expect(formatStamp(2_841_000)).toBe('0:47:21')
    expect(formatStamp(4_324_000)).toBe('1:12:04')
    expect(formatStamp(36_000_000)).toBe('10:00:00')
  })

  it('floors sub-second and clamps negatives', () => {
    expect(formatStamp(1_999)).toBe('0:00:01')
    expect(formatStamp(-5)).toBe('0:00:00')
  })
})

describe('[COMP:media/transcript-format] parseStamp', () => {
  it('round-trips the formatter — the property that matters', () => {
    for (const ms of [0, 1_000, 61_000, 2_841_000, 4_324_000, 36_000_000]) {
      expect(parseStamp(`[${formatStamp(ms)}]`)).toBe(ms)
    }
  })

  it('accepts the MM:SS short form the transcriber also emits', () => {
    expect(parseStamp('[47:21]')).toBe(2_841_000)
  })

  it('rejects an impossible timestamp instead of coercing it', () => {
    // `[00:85]` is not 85 seconds — it is a model inventing a citation. The
    // synthesis prompt warns about exactly this; accepting it would point a
    // citation at a moment that never existed.
    expect(parseStamp('[00:85]')).toBeNull()
    expect(parseStamp('[0:99:00]')).toBeNull()
  })

  it('returns null for non-citations', () => {
    expect(parseStamp('no stamp here')).toBeNull()
    expect(parseStamp('[not a stamp]')).toBeNull()
  })

  it('finds a citation embedded mid-sentence (how the model actually writes)', () => {
    expect(parseStamp('They pushed back on pricing [0:47:21] before the demo.')).toBe(2_841_000)
  })
})

describe('[COMP:media/transcript-format] scanStamps', () => {
  it('reports the offsets a citation occupies, so a link can be placed on it', () => {
    const text = 'Ship it [0:47:21] now.'
    expect(scanStamps(text)).toEqual([
      { index: 8, length: 9, ms: 2_841_000, text: '[0:47:21]' },
    ])
    expect(text.slice(8, 8 + 9)).toBe('[0:47:21]')
  })

  it('skips an impossible stamp — it agrees with parseStamp by construction', () => {
    expect(scanStamps('[00:85] then [0:00:15]').map((m) => m.ms)).toEqual([15_000])
  })

  it('does not carry lastIndex between calls', () => {
    // A module-level /g regex would make the second call start mid-string and
    // return nothing — results must not depend on call order.
    const text = 'a [0:00:05] b'
    expect(scanStamps(text)).toHaveLength(1)
    expect(scanStamps(text)).toHaveLength(1)
  })

  it('finds nothing in prose', () => {
    expect(scanStamps('no stamps here')).toEqual([])
  })
})

describe('[COMP:media/transcript-format] formatTranscript', () => {
  it('renders [H:MM:SS] Speaker: text', () => {
    expect(formatTranscriptLine({ startMs: 2_841_000, speaker: 'Priya', text: 'hi' })).toBe(
      '[0:47:21] Priya: hi',
    )
  })

  it('falls back to a placeholder when diarization gave no speaker', () => {
    expect(formatTranscriptLine({ startMs: 0, speaker: null, text: 'hi' })).toBe('[0:00:00] Speaker: hi')
    expect(formatTranscriptLine({ startMs: 0, speaker: '', text: 'hi' })).toBe('[0:00:00] Speaker: hi')
    expect(formatTranscriptLine({ startMs: 0, text: 'hi' })).toBe('[0:00:00] Speaker: hi')
  })

  it('joins lines with newlines and stays parseable end to end', () => {
    const out = formatTranscript([
      { startMs: 0, speaker: 'Ken', text: 'start' },
      { startMs: 2_841_000, speaker: 'Priya', text: 'pricing' },
    ])
    expect(out).toBe('[0:00:00] Ken: start\n[0:47:21] Priya: pricing')
    // Every emitted line must survive the reader.
    for (const line of out.split('\n')) expect(parseStamp(line)).not.toBeNull()
  })

  it('preserves CJK text verbatim', () => {
    expect(formatTranscriptLine({ startMs: 0, speaker: '陳生', text: '我哋傾下個價錢' })).toBe(
      '[0:00:00] 陳生: 我哋傾下個價錢',
    )
  })
})
