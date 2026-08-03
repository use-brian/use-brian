import { describe, expect, it } from 'vitest'
import {
  defaultContentDraftTitle,
  getContentDraftTitlePrefix,
  isDefaultContentDraftTitle,
  parseContentDraftReplyTarget,
  platformFromContentDraftTitle,
  seedFirstContentDraftMessage,
  withPlatformTitlePrefix,
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

  it('materializes the private brief with the selected deliverable', () => {
    expect(seedFirstContentDraftMessage({
      kind: 'freeform',
      format: 'article',
      brief: 'Show operators why the workflow changed.',
    })).toBe(
      'Create an article link for LinkedIn.\n\nPrivate brief (not published):\nShow operators why the workflow changed.',
    )
  })
})

describe('[COMP:feed/content-planning-store] platform title prefix', () => {
  // The platform lives in the title prefix, so a caller-supplied title that
  // lacks one makes the session invisible to every platform-scoped list. A
  // plan slot's "Launch recap" vanished from the Threads list exactly this
  // way, so the guarantee is pinned at the chokepoint.
  it('prefixes a caller-supplied title with its platform', () => {
    expect(withPlatformTitlePrefix('threads', 'Launch recap')).toBe(
      '[threads] Launch recap',
    )
    expect(withPlatformTitlePrefix('twitter', '  3 numbers  ')).toBe(
      '[twitter] 3 numbers',
    )
  })

  it('is idempotent when the title already carries a prefix', () => {
    expect(withPlatformTitlePrefix('threads', '[threads] Launch recap')).toBe(
      '[threads] Launch recap',
    )
    // A prefix from another platform is left alone: re-titling must not
    // silently move a session between platforms.
    expect(withPlatformTitlePrefix('threads', '[twitter] Ported')).toBe(
      '[twitter] Ported',
    )
  })

  it('falls back to the platform default when untitled', () => {
    expect(withPlatformTitlePrefix('xhs', '')).toBe('[xhs] New draft')
    expect(withPlatformTitlePrefix('xhs', null)).toBe('[xhs] New draft')
    expect(withPlatformTitlePrefix('xhs', '   ')).toBe('[xhs] New draft')
  })

  it('keeps the seed-derived default title', () => {
    expect(
      withPlatformTitlePrefix('threads', null, {
        kind: 'inspiration-reply',
        candidate: {
          platform: 'threads',
          externalId: 'x1',
          authorHandle: 'acme',
          text: 'hello',
        },
      }),
    ).toBe('[threads] Reply to @acme')
  })

  it('round-trips through the platform parser', () => {
    const title = withPlatformTitlePrefix('twitter', 'Launch recap')
    expect(platformFromContentDraftTitle(title)).toBe('twitter')
  })
})
