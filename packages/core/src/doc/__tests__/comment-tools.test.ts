import { describe, it, expect, vi } from 'vitest'
import {
  createPostCommentTool,
  createResolveCommentTool,
  createGetCommentThreadTool,
} from '../comment-tools.js'
import type { CommentMessage, CommentThread, CommentThreadStore } from '../comment-types.js'

const WS = '00000000-0000-0000-0000-0000000000a1'
const USER = '00000000-0000-0000-0000-0000000000a2'
const PAGE = '00000000-0000-0000-0000-0000000000a3'
const ASSIST = 'asst-1'

function ctx(over: { workspaceId?: string | null } = {}) {
  return {
    userId: USER,
    assistantId: ASSIST,
    sessionId: 'sess-page',
    appId: 'Use Brian',
    channelType: 'web',
    channelId: 'c-1',
    workspaceId: over.workspaceId === undefined ? WS : over.workspaceId,
    abortSignal: new AbortController().signal,
  }
}

function fakeThread(over: Partial<CommentThread> = {}): CommentThread {
  return {
    id: 't-1',
    pageId: PAGE,
    workspaceId: WS,
    sessionId: 'sess-thread',
    anchorKind: 'ai_block',
    anchorBlockId: 'blk-1',
    quote: null,
    resolvedAt: null,
    resolvedBy: null,
    createdBy: USER,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function fakeStore(over: Partial<CommentThreadStore> = {}): CommentThreadStore {
  return {
    createThread: vi.fn().mockResolvedValue(fakeThread()),
    addComment: vi.fn().mockResolvedValue({
      id: 'm-1',
      threadId: 't-1',
      role: 'assistant',
      body: 'x',
      senderUserId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
    getThread: vi.fn().mockResolvedValue(fakeThread()),
    listThreadsForPage: vi.fn().mockResolvedValue([]),
    listThreadSummariesForPage: vi.fn().mockResolvedValue([]),
    listThreadComments: vi.fn().mockResolvedValue([]),
    listEmptyThreadIdsForPage: vi.fn().mockResolvedValue([]),
    setResolved: vi.fn().mockResolvedValue(fakeThread({ resolvedAt: '2026-01-02T00:00:00.000Z' })),
    listPendingRepliesForUser: vi.fn().mockResolvedValue([]),
    ...over,
  }
}

function fakeComment(over: Partial<CommentMessage> = {}): CommentMessage {
  return {
    id: 'm-1',
    threadId: 't-1',
    role: 'user',
    body: 'Should this be owner-grouped?',
    senderUserId: USER,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

describe('[COMP:doc/comment-tools] postComment', () => {
  it('starts a new ai_block thread and returns comment_posted (isNew)', async () => {
    const store = fakeStore()
    const tool = createPostCommentTool({ commentThreadStore: store })
    const res = await tool.execute(
      { pageId: PAGE, anchorBlockId: 'blk-1', body: 'Grouped by status — want owner instead?' },
      ctx(),
    )
    expect(res.isError).toBeUndefined()
    expect(res.data).toMatchObject({ kind: 'comment_posted', isNew: true, anchorBlockId: 'blk-1' })
    expect(store.createThread).toHaveBeenCalledTimes(1)
    expect(store.createThread).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: PAGE, anchorKind: 'ai_block', assistantId: ASSIST }),
    )
  })

  it('appends to an existing thread when threadId is given (not isNew)', async () => {
    const store = fakeStore()
    const tool = createPostCommentTool({ commentThreadStore: store })
    const res = await tool.execute({ pageId: PAGE, threadId: 't-1', body: 'follow-up' }, ctx())
    expect(res.data).toMatchObject({ kind: 'comment_posted', isNew: false, threadId: 't-1' })
    expect(store.addComment).toHaveBeenCalledTimes(1)
    expect(store.createThread).not.toHaveBeenCalled()
  })

  it('dedupes a near-identical fan-out comment on the same block (no new thread)', async () => {
    const existing = fakeThread({ id: 't-dup', anchorBlockId: 'blk-1', quote: 'Pick top 5' })
    const store = fakeStore({ listThreadsForPage: vi.fn().mockResolvedValue([existing]) })
    const tool = createPostCommentTool({ commentThreadStore: store })
    const res = await tool.execute(
      { pageId: PAGE, anchorBlockId: 'blk-1', quote: 'pick top 5', body: 'x' },
      ctx(),
    )
    expect(res.data).toMatchObject({ kind: 'comment_posted', isNew: false, threadId: 't-dup' })
    expect(store.createThread).not.toHaveBeenCalled()
  })

  it('errors without a workspace', async () => {
    const tool = createPostCommentTool({ commentThreadStore: fakeStore() })
    const res = await tool.execute({ pageId: PAGE, body: 'x' }, ctx({ workspaceId: null }))
    expect(res.isError).toBe(true)
  })
})

describe('[COMP:doc/comment-tools] resolveComment', () => {
  it('resolves a thread and returns thread_resolved', async () => {
    const store = fakeStore()
    const tool = createResolveCommentTool({ commentThreadStore: store })
    const res = await tool.execute({ threadId: 't-1' }, ctx())
    expect(res.data).toMatchObject({ kind: 'thread_resolved', threadId: 't-1' })
    expect(store.setResolved).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 't-1', resolved: true }),
    )
  })

  it('errors when the thread is not found', async () => {
    const store = fakeStore({ setResolved: vi.fn().mockResolvedValue(null) })
    const tool = createResolveCommentTool({ commentThreadStore: store })
    const res = await tool.execute({ threadId: 'missing' }, ctx())
    expect(res.isError).toBe(true)
  })
})

describe('[COMP:doc/comment-tools] getCommentThread', () => {
  it('returns the thread metadata plus its messages in order', async () => {
    const store = fakeStore({
      getThread: vi.fn().mockResolvedValue(fakeThread({ id: 't-7', quote: 'top 5' })),
      listThreadComments: vi
        .fn()
        .mockResolvedValue([
          fakeComment({ id: 'm-1', role: 'user', body: 'why top 5?' }),
          fakeComment({ id: 'm-2', role: 'assistant', body: 'pulled the leaders' }),
        ]),
    })
    const tool = createGetCommentThreadTool({ commentThreadStore: store })
    const res = await tool.execute({ threadId: 't-7' }, ctx())
    expect(res.isError).toBeUndefined()
    expect(res.data).toMatchObject({
      kind: 'comment_thread',
      threadId: 't-7',
      quote: 'top 5',
      resolved: false,
    })
    expect((res.data as { messages: unknown[] }).messages).toHaveLength(2)
    expect(store.listThreadComments).toHaveBeenCalledWith(USER, 't-7')
  })

  it('errors when the thread is absent or inaccessible', async () => {
    const store = fakeStore({ getThread: vi.fn().mockResolvedValue(null) })
    const tool = createGetCommentThreadTool({ commentThreadStore: store })
    const res = await tool.execute({ threadId: 'missing' }, ctx())
    expect(res.isError).toBe(true)
    expect(store.listThreadComments).not.toHaveBeenCalled()
  })

  it('tolerates a thread with no messages', async () => {
    const store = fakeStore({ listThreadComments: vi.fn().mockResolvedValue(null) })
    const tool = createGetCommentThreadTool({ commentThreadStore: store })
    const res = await tool.execute({ threadId: 't-1' }, ctx())
    expect(res.isError).toBeUndefined()
    expect((res.data as { messages: unknown[] }).messages).toEqual([])
  })
})
