import { describe, expect, it } from 'vitest'
import {
  defaultContentDraftTitle,
  getContentDraftTitlePrefix,
  isDefaultContentDraftTitle,
  parseContentDraftReplyTarget,
  platformFromContentDraftTitle,
  seedFirstContentDraftMessage,
} from '../content-planning-store.js'

describe('[COMP:feed/content-planning-store] pure planning helpers', () => {
  it('builds and recognizes placeholders for every planning target', () => {
    expect(defaultContentDraftTitle('instagram')).toBe('[instagram] New draft')
    expect(defaultContentDraftTitle('xhs')).toBe('[xhs] New draft')
    expect(isDefaultContentDraftTitle('[twitter] New draft')).toBe(true)
    expect(isDefaultContentDraftTitle('Launch announcement')).toBe(false)
    expect(getContentDraftTitlePrefix('[threads] Reply to @brian')).toBe('[threads]')
    expect(platformFromContentDraftTitle('[xhs] From example.com')).toBe('xhs')
  })

  it('materializes and recovers reply seed context without provider calls', () => {
    const message = seedFirstContentDraftMessage({
      kind: 'freeform-reply',
      candidate: {
        platform: 'threads',
        externalId: 'post-1',
        authorHandle: 'alice',
        text: 'A useful public observation.',
        permalink: 'https://www.threads.com/@alice/post/post-1',
      },
    })
    expect(message).toContain('Source: https://www.threads.com/@alice/post/post-1')
    expect(parseContentDraftReplyTarget(message)).toEqual({
      authorHandle: 'alice',
      text: 'A useful public observation.',
      permalink: 'https://www.threads.com/@alice/post/post-1',
    })
  })

  it('turns a source link into a seeded planning message and hostname title', () => {
    const seed = { kind: 'freeform' as const, link: 'https://www.example.com/launch' }
    expect(defaultContentDraftTitle('instagram', seed)).toBe(
      '[instagram] From example.com',
    )
    expect(seedFirstContentDraftMessage(seed)).toBe(
      'Draft posts from this link: https://www.example.com/launch',
    )
  })
})
