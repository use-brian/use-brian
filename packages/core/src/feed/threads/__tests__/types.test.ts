/**
 * Unit tests for the Threads API Zod schemas.
 * Component tag: [COMP:distribution/threads-types].
 *
 * Regression cover for the `CAROUSEL_ALBUM` media-type Meta returns on
 * `GET /{media-id}` for legacy multi-image posts — the
 * `ThreadsMediaType` preprocess flattens it to `CAROUSEL` so downstream
 * comparisons stay valid.
 */

import { describe, it, expect } from 'vitest'
import { ThreadsMediaType, ThreadsMediaDetails } from '../types.js'

describe('[COMP:distribution/threads-types] ThreadsMediaType', () => {
  it('accepts the five documented values', () => {
    for (const v of ['TEXT', 'IMAGE', 'VIDEO', 'CAROUSEL', 'AUDIO']) {
      expect(ThreadsMediaType.parse(v)).toBe(v)
    }
  })

  it('normalizes CAROUSEL_ALBUM → CAROUSEL', () => {
    expect(ThreadsMediaType.parse('CAROUSEL_ALBUM')).toBe('CAROUSEL')
  })

  it('still rejects unknown values', () => {
    expect(() => ThreadsMediaType.parse('REEL')).toThrow()
  })

  it('flows through ThreadsMediaDetails as CAROUSEL', () => {
    const parsed = ThreadsMediaDetails.parse({
      id: 'm-1',
      media_type: 'CAROUSEL_ALBUM',
    })
    expect(parsed.media_type).toBe('CAROUSEL')
  })
})
