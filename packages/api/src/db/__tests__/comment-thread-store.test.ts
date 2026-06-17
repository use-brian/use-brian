/**
 * [COMP:api/comment-thread-store] Comment-thread store.
 *
 * Mocks the pg client + the session helpers and verifies the store mints a
 * `doc_thread` session, RLS-inserts the thread row, seeds the first
 * comment, and emits the expected SQL shapes for list/resolve.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  queryWithRLS: vi.fn(),
  query: vi.fn(),
}))
vi.mock('../sessions.js', () => ({
  findOrCreateSession: vi.fn(),
  addSessionMessage: vi.fn(),
  getSessionMessages: vi.fn(),
}))

import { createDbCommentThreadStore } from '../comment-thread-store.js'
import { query, queryWithRLS } from '../client.js'
import { findOrCreateSession, addSessionMessage, getSessionMessages } from '../sessions.js'

const mockQuery = vi.mocked(queryWithRLS)
const mockBareQuery = vi.mocked(query)
const mockFindOrCreateSession = vi.mocked(findOrCreateSession)
const mockAddMessage = vi.mocked(addSessionMessage)
const mockGetSessionMessages = vi.mocked(getSessionMessages)

const USER = '00000000-0000-0000-0000-0000000000c1'
const WS = '00000000-0000-0000-0000-0000000000c2'
const PAGE = '00000000-0000-0000-0000-0000000000c3'

function threadRow(over: Record<string, unknown> = {}) {
  return {
    id: 't-1',
    pageId: PAGE,
    workspaceId: WS,
    sessionId: 'sess-1',
    anchorKind: 'ai_block',
    anchorBlockId: 'blk-1',
    quote: null,
    resolvedAt: null,
    resolvedBy: null,
    createdBy: USER,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFindOrCreateSession.mockResolvedValue({ id: 'sess-1' } as never)
  mockAddMessage.mockResolvedValue({ id: 'm-1', createdAt: new Date() } as never)
  // createThread reads the owning assistant's clearance system-side (bare
  // query, migration 224) before minting the session — default it so the
  // store doesn't crash; tests that care about the aggregate override it.
  mockBareQuery.mockResolvedValue({ rows: [{ clearance: 'internal' }] } as never)
})

describe('[COMP:api/comment-thread-store] createDbCommentThreadStore', () => {
  it('createThread mints a doc_thread session, inserts the row, seeds the first comment', async () => {
    mockQuery.mockResolvedValue({ rows: [threadRow()] } as never)
    const store = createDbCommentThreadStore()

    const thread = await store.createThread({
      userId: USER,
      workspaceId: WS,
      pageId: PAGE,
      assistantId: 'a-1',
      anchorKind: 'ai_block',
      anchorBlockId: 'blk-1',
      quote: 'Q3 dates?',
      firstComment: { role: 'assistant', body: 'Assumed Q3 — confirm?' },
    })

    // The thread's read-clearance = the owning assistant's clearance
    // (migration 224): read system-side, stamped on the session AND the row.
    expect(mockBareQuery.mock.calls[0][0]).toContain('SELECT clearance FROM assistants')
    expect(mockFindOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        channelType: 'doc_thread',
        userId: USER,
        assistantId: 'a-1',
        visibility: 'workspace',
        effectiveClearance: 'internal',
      }),
    )
    const [, sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('INSERT INTO comment_threads')
    expect(sql).toContain('effective_clearance')
    expect(params).toEqual(
      expect.arrayContaining([PAGE, WS, 'sess-1', 'ai_block', 'blk-1', 'Q3 dates?', USER, 'internal']),
    )
    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-1', role: 'assistant', content: 'Assumed Q3 — confirm?' }),
    )
    // Date columns are returned as ISO strings.
    expect(thread.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(thread.resolvedAt).toBeNull()
  })

  it('derives the quote from the anchored block when the caller supplies none', async () => {
    mockQuery
      // deriveQuote: SELECT the page snapshot
      .mockResolvedValueOnce({
        rows: [
          { page: { blocks: [{ id: 'blk-9', text: 'Technical Infrastructure & Repositories' }] } },
        ],
      } as never)
      // INSERT comment_threads
      .mockResolvedValueOnce({
        rows: [threadRow({ anchorBlockId: 'blk-9', quote: 'Technical Infrastructure & Repositories' })],
      } as never)
    const store = createDbCommentThreadStore()
    await store.createThread({
      userId: USER,
      workspaceId: WS,
      pageId: PAGE,
      assistantId: 'a-1',
      anchorKind: 'ai_block',
      anchorBlockId: 'blk-9',
    })
    expect(mockQuery.mock.calls[0][1]).toContain('COALESCE(cd.snapshot_json')
    // The INSERT (2nd call) carries the derived quote in its params.
    expect(mockQuery.mock.calls[1][2]).toContain('Technical Infrastructure & Repositories')
  })

  it('skips quote derivation when the caller already supplied one', async () => {
    mockQuery.mockResolvedValue({ rows: [threadRow({ quote: 'given' })] } as never)
    const store = createDbCommentThreadStore()
    await store.createThread({
      userId: USER,
      workspaceId: WS,
      pageId: PAGE,
      assistantId: 'a-1',
      anchorKind: 'ai_block',
      anchorBlockId: 'blk-9',
      quote: 'given',
    })
    // Only the INSERT — no snapshot SELECT.
    expect(mockQuery).toHaveBeenCalledTimes(1)
    expect(mockQuery.mock.calls[0][1]).toContain('INSERT INTO comment_threads')
  })

  it('addComment resolves the thread session then appends', async () => {
    mockQuery.mockResolvedValue({ rows: [{ sessionId: 'sess-1' }] } as never)
    const store = createDbCommentThreadStore()
    await store.addComment({ userId: USER, threadId: 't-1', role: 'user', body: 'reply', senderUserId: USER })
    expect(mockQuery.mock.calls[0][1]).toContain('SELECT session_id')
    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-1', role: 'user', senderUserId: USER }),
    )
  })

  it('listThreadsForPage filters to open threads by default', async () => {
    mockQuery.mockResolvedValue({ rows: [] } as never)
    const store = createDbCommentThreadStore()
    await store.listThreadsForPage(USER, PAGE)
    expect(mockQuery.mock.calls[0][1]).toContain('resolved_at IS NULL')
  })

  it('listThreadsForPage includes resolved when asked', async () => {
    mockQuery.mockResolvedValue({ rows: [] } as never)
    const store = createDbCommentThreadStore()
    await store.listThreadsForPage(USER, PAGE, { includeResolved: true })
    expect(mockQuery.mock.calls[0][1]).not.toContain('resolved_at IS NULL')
  })

  it('listThreadsForPage drops empty threads (the first comment never landed)', async () => {
    // RLS returns two accessible threads; only one has comments.
    mockQuery.mockResolvedValueOnce({
      rows: [
        threadRow({ id: 't-full', sessionId: 'sess-full' }),
        threadRow({ id: 't-empty', sessionId: 'sess-empty' }),
      ],
    } as never)
    // System-side count (owner-only session_messages RLS would under-count a
    // teammate's thread): only sess-full has user/assistant messages.
    mockBareQuery.mockResolvedValueOnce({ rows: [{ sessionId: 'sess-full' }] } as never)

    const store = createDbCommentThreadStore()
    const out = await store.listThreadsForPage(USER, PAGE)

    expect(mockBareQuery.mock.calls[0][0]).toContain('FROM session_messages')
    expect(out.map((t) => t.id)).toEqual(['t-full'])
  })

  it('listThreadsForPage attaches a title derived from each thread\'s first comment', async () => {
    // A page-level (quote-less) thread + an anchored thread (has a quote).
    mockQuery.mockResolvedValueOnce({
      rows: [
        threadRow({ id: 't-page', sessionId: 'sess-page', anchorBlockId: null, quote: null }),
        threadRow({ id: 't-anchor', sessionId: 'sess-anchor', quote: 'Q3 revenue' }),
      ],
    } as never)
    // System-side first-comment read (DISTINCT ON … sequence_num ASC). Content
    // is the JSONB shape session_messages stores — a string seed or block array.
    mockBareQuery.mockResolvedValueOnce({
      rows: [
        { sessionId: 'sess-page', content: '**Group by owner** instead?' },
        { sessionId: 'sess-anchor', content: [{ type: 'text', text: 'is this number right' }] },
      ],
    } as never)

    const store = createDbCommentThreadStore()
    const out = await store.listThreadsForPage(USER, PAGE)

    // Pulls the opening message per session, oldest first.
    expect(mockBareQuery.mock.calls[0][0]).toContain('DISTINCT ON (session_id)')
    expect(mockBareQuery.mock.calls[0][0]).toContain('sequence_num ASC')
    const byId = new Map(out.map((t) => [t.id, t]))
    // Markdown stripped, trailing '?' trimmed; block-array content coerced.
    expect(byId.get('t-page')?.title).toBe('Group by owner instead')
    expect(byId.get('t-anchor')?.title).toBe('is this number right')
  })

  it('listThreadsForPage gives a body-less comment a null title but keeps the thread', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [threadRow({ id: 't-1', sessionId: 'sess-1' })],
    } as never)
    // A row exists (so the thread is non-empty) but its content coerces to ''
    // (e.g. an attachment-only message) → title null, thread retained.
    mockBareQuery.mockResolvedValueOnce({ rows: [{ sessionId: 'sess-1', content: [] }] } as never)

    const store = createDbCommentThreadStore()
    const out = await store.listThreadsForPage(USER, PAGE)
    expect(out).toHaveLength(1)
    expect(out[0].title).toBeNull()
  })

  it('listThreadsForPage attaches the backing session status (live-turn reconnect)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [threadRow({ id: 't-1', sessionId: 'sess-1' })],
    } as never)
    // attachFirstCommentTitles read (keeps the thread non-empty)…
    mockBareQuery.mockResolvedValueOnce({
      rows: [{ sessionId: 'sess-1', content: 'flatten the subpages' }],
    } as never)
    // …then the system-side session-status read.
    mockBareQuery.mockResolvedValueOnce({ rows: [{ id: 'sess-1', status: 'running' }] } as never)

    const store = createDbCommentThreadStore()
    const out = await store.listThreadsForPage(USER, PAGE)

    // Status is read system-side AFTER the first-comment read (calls[0]).
    expect(mockBareQuery.mock.calls[1][0]).toContain('FROM sessions')
    expect(mockBareQuery.mock.calls[1][1]).toEqual([['sess-1']])
    expect(out[0].sessionStatus).toBe('running')
  })

  it('setResolved stamps resolved_at + resolved_by', async () => {
    mockQuery.mockResolvedValue({ rows: [threadRow({ resolvedAt: new Date(), resolvedBy: USER })] } as never)
    const store = createDbCommentThreadStore()
    const updated = await store.setResolved({ userId: USER, threadId: 't-1', resolved: true })
    expect(mockQuery.mock.calls[0][1]).toContain('resolved_at = now()')
    expect(updated?.resolvedAt).not.toBeNull()
  })

  it('listThreadSummariesForPage returns open + latest-10 resolved with message aggregates', async () => {
    // Two RLS queries (open, then resolved), fired via Promise.all in order.
    mockQuery
      .mockResolvedValueOnce({ rows: [threadRow({ id: 't-open', sessionId: 'sess-open' })] } as never)
      .mockResolvedValueOnce({
        rows: [threadRow({ id: 't-done', sessionId: 'sess-done', resolvedAt: new Date('2026-01-02T00:00:00.000Z') })],
      } as never)
    // Then the system-side aggregate over both sessions.
    mockBareQuery.mockResolvedValue({
      rows: [
        { sessionId: 'sess-open', messageCount: 3, lastActivityAt: new Date('2026-01-01T05:00:00.000Z') },
        { sessionId: 'sess-done', messageCount: 5, lastActivityAt: new Date('2026-01-02T00:00:00.000Z') },
      ],
    } as never)

    const store = createDbCommentThreadStore()
    const out = await store.listThreadSummariesForPage(USER, PAGE)

    // Open query has no LIMIT; resolved query caps at 10 and filters resolved.
    expect(mockQuery.mock.calls[0][1]).toContain('resolved_at IS NULL')
    expect(mockQuery.mock.calls[1][1]).toContain('resolved_at IS NOT NULL')
    expect(mockQuery.mock.calls[1][1]).toContain('LIMIT 10')
    // Aggregate is a system-side read over session_messages.
    expect(mockBareQuery.mock.calls[0][0]).toContain('FROM session_messages')
    expect(mockBareQuery.mock.calls[0][1]).toEqual([['sess-open', 'sess-done']])

    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ id: 't-open', messageCount: 3, lastActivityAt: '2026-01-01T05:00:00.000Z' })
    expect(out[1]).toMatchObject({ id: 't-done', messageCount: 5 })
    expect(out[1].resolvedAt).toBe('2026-01-02T00:00:00.000Z')
  })

  it('listThreadSummariesForPage short-circuits (no aggregate) when the page has no threads', async () => {
    mockQuery.mockResolvedValue({ rows: [] } as never)
    const store = createDbCommentThreadStore()
    const out = await store.listThreadSummariesForPage(USER, PAGE)
    expect(out).toEqual([])
    expect(mockBareQuery).not.toHaveBeenCalled()
  })

  it('listThreadSummariesForPage drops empty threads from the discovery index', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [threadRow({ id: 't-open', sessionId: 'sess-open' })] } as never)
      .mockResolvedValueOnce({
        rows: [threadRow({ id: 't-empty', sessionId: 'sess-empty', resolvedAt: new Date() })],
      } as never)
    // Only sess-open has comments; the empty thread is absent from the aggregate
    // → messageCount 0 → filtered out (no "0 msgs" noise for the AI to read).
    mockBareQuery.mockResolvedValue({
      rows: [{ sessionId: 'sess-open', messageCount: 2, lastActivityAt: new Date('2026-01-01T00:00:00.000Z') }],
    } as never)

    const store = createDbCommentThreadStore()
    const out = await store.listThreadSummariesForPage(USER, PAGE)

    expect(out.map((t) => t.id)).toEqual(['t-open'])
  })

  it('listEmptyThreadIdsForPage returns the page threads with no comments (page-gated, system-side)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: 1 }] } as never) // saved_views RLS gate passes
    mockBareQuery.mockResolvedValueOnce({ rows: [{ id: 't-empty-1' }, { id: 't-empty-2' }] } as never)

    const store = createDbCommentThreadStore()
    const out = await store.listEmptyThreadIdsForPage(USER, PAGE)

    // Access gated via saved_views RLS; emptiness read system-side (NOT EXISTS).
    expect(mockQuery.mock.calls[0][1]).toContain('FROM saved_views')
    expect(mockBareQuery.mock.calls[0][0]).toContain('NOT EXISTS')
    expect(out).toEqual(['t-empty-1', 't-empty-2'])
  })

  it('listEmptyThreadIdsForPage returns [] without a system-side read when the page is inaccessible', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never) // saved_views RLS gate denies
    const store = createDbCommentThreadStore()
    const out = await store.listEmptyThreadIdsForPage(USER, PAGE)
    expect(out).toEqual([])
    expect(mockBareQuery).not.toHaveBeenCalled()
  })

  it('listThreadComments RLS-resolves the session then maps user/assistant messages (coercing content)', async () => {
    mockQuery.mockResolvedValue({ rows: [{ sessionId: 'sess-1' }] } as never)
    mockGetSessionMessages.mockResolvedValue([
      { id: 'm-1', role: 'user', content: 'why top 5?', senderUserId: USER, createdAt: new Date('2026-01-01T00:00:00.000Z') },
      { id: 'm-2', role: 'assistant', content: [{ type: 'text', text: 'pulled the leaders' }], senderUserId: null, createdAt: new Date('2026-01-01T00:01:00.000Z') },
      { id: 'm-3', role: 'tool', content: 'ignored', senderUserId: null, createdAt: new Date() },
    ] as never)

    const store = createDbCommentThreadStore()
    const msgs = await store.listThreadComments(USER, 't-1')

    expect(mockQuery.mock.calls[0][1]).toContain('SELECT session_id')
    expect(mockGetSessionMessages).toHaveBeenCalledWith('sess-1')
    expect(msgs).toHaveLength(2) // the 'tool' row is dropped
    expect(msgs?.[0]).toMatchObject({ id: 'm-1', role: 'user', body: 'why top 5?' })
    expect(msgs?.[1]).toMatchObject({ id: 'm-2', role: 'assistant', body: 'pulled the leaders' })
  })

  it('listThreadComments returns null when the thread is absent or inaccessible', async () => {
    mockQuery.mockResolvedValue({ rows: [] } as never)
    const store = createDbCommentThreadStore()
    const msgs = await store.listThreadComments(USER, 'missing')
    expect(msgs).toBeNull()
    expect(mockGetSessionMessages).not.toHaveBeenCalled()
  })

  it('listPendingRepliesForUser keeps only threads whose latest comment is the assistant', async () => {
    // RLS thread query: two open threads the user started.
    mockQuery.mockResolvedValue({
      rows: [
        { threadId: 't-1', pageId: PAGE, sessionId: 'sess-1', pageTitle: 'Weekly', quote: 'Q3 dates?' },
        { threadId: 't-2', pageId: PAGE, sessionId: 'sess-2', pageTitle: 'Roadmap', quote: null },
      ],
    } as never)
    // System-side latest-comment-per-session: sess-1 → AI replied (pending),
    // sess-2 → the user spoke last (not pending).
    mockBareQuery.mockResolvedValueOnce({
      rows: [
        { sessionId: 'sess-1', role: 'assistant', createdAt: new Date('2026-01-02T00:00:00.000Z') },
        { sessionId: 'sess-2', role: 'user', createdAt: new Date('2026-01-03T00:00:00.000Z') },
      ],
    } as never)

    const store = createDbCommentThreadStore()
    const pending = await store.listPendingRepliesForUser(USER, WS)

    // RLS thread query is scoped to the initiator + open threads.
    expect(mockQuery.mock.calls[0][1]).toContain('created_by = $1')
    expect(mockQuery.mock.calls[0][1]).toContain('resolved_at IS NULL')
    // Only the AI-latest thread survives.
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      threadId: 't-1',
      pageId: PAGE,
      pageTitle: 'Weekly',
      quote: 'Q3 dates?',
      lastActivityAt: '2026-01-02T00:00:00.000Z',
    })
  })

  it('listPendingRepliesForUser short-circuits (no message read) when you started no open threads', async () => {
    mockQuery.mockResolvedValue({ rows: [] } as never)
    const store = createDbCommentThreadStore()
    const pending = await store.listPendingRepliesForUser(USER, WS)
    expect(pending).toEqual([])
    // No system-side latest-message read when there are no threads.
    expect(mockBareQuery).not.toHaveBeenCalled()
  })
})
