import { describe, it, expect } from 'vitest'
import { decodeThreadsShortcode, INSTAGRAM_EPOCH_MS } from '../threads/shortcode.js'

describe('[COMP:feed/threads-shortcode] decodeThreadsShortcode', () => {
  it('returns null for empty / non-alphabet input', () => {
    expect(decodeThreadsShortcode('')).toBeNull()
    expect(decodeThreadsShortcode('hello world')).toBeNull()
    expect(decodeThreadsShortcode('contains.dot')).toBeNull()
    expect(decodeThreadsShortcode('contains/slash')).toBeNull()
  })

  it('rejects characters outside the IG alphabet', () => {
    expect(decodeThreadsShortcode('!')).toBeNull()
    expect(decodeThreadsShortcode('a+b')).toBeNull()
    expect(decodeThreadsShortcode('a/b')).toBeNull()
    expect(decodeThreadsShortcode('a=b')).toBeNull()
  })

  it('accepts every character in the IG alphabet', () => {
    // Single char only — a long string of uppercase letters or digits
    // would decode to a future-shifted timestamp and be rejected by the
    // sanity check. This test just confirms the alphabet table.
    for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_') {
      expect(decodeThreadsShortcode(ch)).not.toBeNull()
    }
  })

  it('decodes a real Threads URL shortcode to a plausible recent timestamp', () => {
    // Shortcode pulled from the original bug report —
    // threads.com/@kiwiiiiiiii.__/post/DX4FjS5Gl5x.
    const decoded = decodeThreadsShortcode('DX4FjS5Gl5x')
    expect(decoded).not.toBeNull()
    // After IG epoch (Aug 2011), before the test runs.
    expect(decoded!.timestampMs).toBeGreaterThan(INSTAGRAM_EPOCH_MS)
    expect(decoded!.timestampMs).toBeLessThanOrEqual(Date.now())
    // Threads launched July 2023 — any real Threads post is after that.
    const threadsLaunch = new Date('2023-07-01T00:00:00Z').getTime()
    expect(decoded!.timestampMs).toBeGreaterThan(threadsLaunch)
  })

  it('rejects shortcodes whose decoded timestamp is in the far future', () => {
    // 12 underscores (max base64 value) decodes to a timestamp tens of
    // thousands of years out — should be rejected.
    expect(decodeThreadsShortcode('____________')).toBeNull()
  })

  it('round-trips: (pk >> 23) + epoch == timestampMs', () => {
    const decoded = decodeThreadsShortcode('DX4FjS5Gl5x')
    expect(decoded).not.toBeNull()
    const sinceEpoch = Number(decoded!.pk >> 23n)
    expect(decoded!.timestampMs).toBe(sinceEpoch + INSTAGRAM_EPOCH_MS)
  })

  it('produces strictly larger pk for a strictly larger encoded value', () => {
    // 'A' (=0) and 'B' (=1) are adjacent alphabet positions; the latter
    // must decode to a strictly larger pk. Catches alphabet-ordering
    // regressions if the table is ever reordered.
    const a = decodeThreadsShortcode('AAAAAAAAAA')
    const b = decodeThreadsShortcode('AAAAAAAAAB')
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(b!.pk).toBeGreaterThan(a!.pk)
  })
})
