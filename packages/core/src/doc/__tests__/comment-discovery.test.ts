import { describe, it, expect } from 'vitest'
import { formatThreadDiscovery } from '../comment-discovery.js'
import type { CommentThreadSummary } from '../comment-types.js'

const NOW = new Date('2026-01-02T00:00:00.000Z')

function summary(over: Partial<CommentThreadSummary> = {}): CommentThreadSummary {
  return {
    id: 't-1',
    pageId: 'p-1',
    workspaceId: 'w-1',
    sessionId: 's-1',
    anchorKind: 'ai_block',
    anchorBlockId: 'blk-1',
    quote: 'group by status',
    resolvedAt: null,
    resolvedBy: null,
    createdBy: 'u-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    messageCount: 2,
    lastActivityAt: '2026-01-01T23:00:00.000Z', // 1h before NOW
    ...over,
  }
}

describe('[COMP:doc/comment-discovery] formatThreadDiscovery', () => {
  it('returns empty string when there are no threads', () => {
    expect(formatThreadDiscovery([], { variant: 'chat', now: NOW })).toBe('')
  })

  it('returns empty string when the only thread is the current one (thread variant)', () => {
    const out = formatThreadDiscovery([summary({ sessionId: 's-self' })], {
      variant: 'thread',
      currentSessionId: 's-self',
      now: NOW,
    })
    expect(out).toBe('')
  })

  it('chat variant lists every thread, grouped open then resolved', () => {
    const out = formatThreadDiscovery(
      [
        summary({ id: 't-open', sessionId: 's-a' }),
        summary({
          id: 't-done',
          sessionId: 's-b',
          resolvedAt: '2026-01-01T12:00:00.000Z',
          messageCount: 4,
        }),
      ],
      { variant: 'chat', now: NOW },
    )
    expect(out).toContain('# Comment threads on this page')
    expect(out).toContain('Open:')
    expect(out).toContain('Resolved (latest 10):')
    expect(out).toContain('t-open')
    expect(out).toContain('t-done')
    expect(out).toContain('getCommentThread')
  })

  it('thread variant excludes the current thread and uses the "Other" header', () => {
    const out = formatThreadDiscovery(
      [
        summary({ id: 't-self', sessionId: 's-self' }),
        summary({ id: 't-other', sessionId: 's-other' }),
      ],
      { variant: 'thread', currentSessionId: 's-self', now: NOW },
    )
    expect(out).toContain('# Other comment threads on this page')
    expect(out).toContain('t-other')
    expect(out).not.toContain('t-self')
  })

  it('labels scope (block vs page-level) and quote', () => {
    const block = formatThreadDiscovery([summary({ anchorBlockId: 'blk-9', quote: 'Q3 close' })], {
      variant: 'chat',
      now: NOW,
    })
    expect(block).toContain('block blk-9 "Q3 close"')

    const pageLevel = formatThreadDiscovery(
      [summary({ anchorBlockId: null, quote: null, sessionId: 's-z' })],
      { variant: 'chat', now: NOW },
    )
    expect(pageLevel).toContain('page-level')
  })

  it('pluralizes message count and renders relative activity', () => {
    const one = formatThreadDiscovery([summary({ messageCount: 1 })], { variant: 'chat', now: NOW })
    expect(one).toContain('1 msg ·')
    expect(one).toContain('last 1h ago')

    const many = formatThreadDiscovery([summary({ messageCount: 3 })], { variant: 'chat', now: NOW })
    expect(many).toContain('3 msgs')
  })

  it('omits the activity suffix when lastActivityAt is null', () => {
    const out = formatThreadDiscovery([summary({ lastActivityAt: null })], {
      variant: 'chat',
      now: NOW,
    })
    expect(out).not.toContain('last ')
  })

  it('caps the open list at 30 and notes the remainder', () => {
    const many = Array.from({ length: 35 }, (_, i) =>
      summary({ id: `t-${i}`, sessionId: `s-${i}` }),
    )
    const out = formatThreadDiscovery(many, { variant: 'chat', now: NOW })
    expect(out).toContain('…and 5 more open')
    // 30 rendered rows + the remainder note
    expect(out.match(/^- /gm)?.length).toBe(31)
  })
})
