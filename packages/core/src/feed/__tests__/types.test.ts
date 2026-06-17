/**
 * Unit tests for the platform-agnostic feed schemas.
 * Component tag: [COMP:feed/types].
 *
 * Verifies the Zod contracts shared by voice-learning and inspiration
 * scanning: the FeedPlatform / InspirationSource enums, VoiceSample
 * (required fields + optional platformMeta), and InspirationCandidate
 * (nested author, the 0..1 score bound).
 */

import { describe, it, expect } from 'vitest'
import {
  FeedPlatform,
  InspirationSource,
  VoiceSample,
  InspirationCandidate,
} from '../types.js'

describe('[COMP:feed/types] FeedPlatform / InspirationSource enums', () => {
  it('FeedPlatform admits twitter + threads only', () => {
    expect(FeedPlatform.safeParse('twitter').success).toBe(true)
    expect(FeedPlatform.safeParse('threads').success).toBe(true)
    expect(FeedPlatform.safeParse('mastodon').success).toBe(false)
  })

  it('InspirationSource admits the four documented sources', () => {
    for (const s of ['timeline', 'list', 'search', 'tracked-user']) {
      expect(InspirationSource.safeParse(s).success).toBe(true)
    }
    expect(InspirationSource.safeParse('webhook').success).toBe(false)
  })
})

describe('[COMP:feed/types] VoiceSample', () => {
  const valid = {
    platform: 'twitter',
    externalId: 't-1',
    text: 'hello world',
    publishedAt: '2026-05-16T00:00:00Z',
    engagement: { likes: 3 },
  }

  it('parses a minimal valid sample and treats platformMeta as optional', () => {
    const parsed = VoiceSample.parse(valid)
    expect(parsed.externalId).toBe('t-1')
    expect(parsed.platformMeta).toBeUndefined()
    expect(VoiceSample.safeParse({ ...valid, platformMeta: { conversationId: 'c-9' } }).success).toBe(
      true,
    )
  })

  it('rejects a sample missing a required field', () => {
    const { text: _omit, ...noText } = valid
    expect(VoiceSample.safeParse(noText).success).toBe(false)
  })
})

describe('[COMP:feed/types] InspirationCandidate', () => {
  const valid = {
    platform: 'threads',
    externalId: 'p-1',
    text: 'interesting take',
    author: { handle: 'alice' },
    publishedAt: '2026-05-16T00:00:00Z',
    engagement: {},
    source: 'list',
  }

  it('parses a valid candidate with a nested author', () => {
    const parsed = InspirationCandidate.parse(valid)
    expect(parsed.author.handle).toBe('alice')
    expect(parsed.score).toBeUndefined()
  })

  it('bounds the score to the 0..1 range', () => {
    expect(InspirationCandidate.safeParse({ ...valid, score: 0.7 }).success).toBe(true)
    expect(InspirationCandidate.safeParse({ ...valid, score: 1.5 }).success).toBe(false)
    expect(InspirationCandidate.safeParse({ ...valid, score: -0.1 }).success).toBe(false)
  })
})
