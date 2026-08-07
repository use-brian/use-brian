/**
 * [COMP:feed/post-media-parse]
 *
 * The save-draft body is parsed twice by hand (open + hosted). This module is
 * the single shape both import, so these cases pin the contract for both
 * editions at once -- see `../media.ts` for why the fork is dangerous.
 */

import { describe, expect, it } from 'vitest'
import { MAX_POST_MEDIA, parsePostMedia } from '../media.js'

const FILE_A = '11111111-1111-4111-8111-111111111111'
const FILE_B = '22222222-2222-4222-8222-222222222222'

describe('[COMP:feed/post-media-parse] Draft media payload', () => {
  it('treats an absent field as an empty list, matching the column default', () => {
    // An omitted field must never read as a deletion to one edition and a
    // no-op to the other -- that asymmetry is the whole reason this is shared.
    expect(parsePostMedia(undefined)).toEqual({ ok: true, media: [] })
    expect(parsePostMedia(null)).toEqual({ ok: true, media: [] })
  })

  it('accepts well-formed entries and trims alt text', () => {
    const parsed = parsePostMedia([
      { fileId: FILE_A, mimeType: 'image/png', alt: '  a chart  ' },
      { fileId: FILE_B, mimeType: 'image/jpeg' },
    ])
    expect(parsed).toEqual({
      ok: true,
      media: [
        { fileId: FILE_A, mimeType: 'image/png', alt: 'a chart' },
        { fileId: FILE_B, mimeType: 'image/jpeg' },
      ],
    })
  })

  it('rejects rather than filters, so a post never claims media it will not publish', () => {
    // Dropping the bad entry would leave a two-image post silently publishing
    // one, and the operator cannot tell that from a successful save.
    const parsed = parsePostMedia([
      { fileId: FILE_A, mimeType: 'image/png' },
      { fileId: 'not-a-uuid', mimeType: 'image/png' },
    ])
    expect(parsed.ok).toBe(false)
  })

  it('rejects a non-array, a bad mime, a non-string alt, and an over-long list', () => {
    expect(parsePostMedia('nope').ok).toBe(false)
    expect(parsePostMedia([{ fileId: FILE_A, mimeType: 'video/mp4' }]).ok).toBe(false)
    expect(parsePostMedia([{ fileId: FILE_A, mimeType: 'image/png', alt: 7 }]).ok).toBe(false)
    const tooMany = Array.from({ length: MAX_POST_MEDIA + 1 }, (_, i) => ({
      fileId: `1111111${i}-1111-4111-8111-11111111111${i % 10}`,
      mimeType: 'image/png',
    }))
    expect(parsePostMedia(tooMany).ok).toBe(false)
  })

  it('rejects the same file twice', () => {
    // Platforms render it as two slides of one picture; operators read it as a bug.
    expect(parsePostMedia([
      { fileId: FILE_A, mimeType: 'image/png' },
      { fileId: FILE_A, mimeType: 'image/png' },
    ]).ok).toBe(false)
  })
})
