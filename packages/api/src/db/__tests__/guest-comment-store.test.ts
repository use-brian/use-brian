import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the DB + session helpers so the store's authoring/privacy contract can
// be asserted without a live database.
const query = vi.fn()
const findOrCreateSession = vi.fn()
const addSessionMessage = vi.fn()

vi.mock('../client.js', () => ({ query: (...a: unknown[]) => query(...a) }))
vi.mock('../sessions.js', () => ({
  findOrCreateSession: (...a: unknown[]) => findOrCreateSession(...a),
  addSessionMessage: (...a: unknown[]) => addSessionMessage(...a),
}))
vi.mock('../comment-thread-store.js', () => ({ COMMENT_THREAD_CHANNEL_TYPE: 'doc_thread' }))

const { createGuestThread, addGuestComment, SENTINEL_GUEST_USER_ID } = await import('../guest-comment-store.js')

describe('[COMP:doc/guest-comment] Guest comment store', () => {
  beforeEach(() => {
    query.mockReset()
    findOrCreateSession.mockReset()
    addSessionMessage.mockReset()
    findOrCreateSession.mockResolvedValue({ id: 'sess-1' })
    addSessionMessage.mockResolvedValue({ id: 'msg-1', createdAt: new Date() })
  })

  it('authors a guest thread as the sentinel user, name only on the thread row', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: 'assistant-1' }] }) // primary assistant lookup
      .mockResolvedValueOnce({ rows: [] }) // UPDATE sessions guest_session_token
      .mockResolvedValueOnce({ rows: [{ id: 'thread-1' }] }) // INSERT comment_threads

    const out = await createGuestThread({
      pageId: 'p1',
      workspaceId: 'w1',
      guestName: 'Alice External',
      guestSessionToken: 'gtok',
      body: 'looks great',
    })
    expect(out.threadId).toBe('thread-1')

    // Session minted under the sentinel — never a member id.
    expect(findOrCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({ userId: SENTINEL_GUEST_USER_ID, visibility: 'workspace', effectiveClearance: 'public' }),
    )
    // The first comment is authored by the sentinel (privacy: no member id).
    expect(addSessionMessage).toHaveBeenCalledWith(
      expect.objectContaining({ senderUserId: SENTINEL_GUEST_USER_ID, role: 'user' }),
    )
    // The INSERT stamps created_by=sentinel + the display name (3rd query call).
    const insertArgs = query.mock.calls[2]
    expect(insertArgs[0]).toContain('INSERT INTO comment_threads')
    expect(insertArgs[1]).toContain(SENTINEL_GUEST_USER_ID)
    expect(insertArgs[1]).toContain('Alice External')
  })

  it('rejects a reply when the token does not own the thread', async () => {
    query.mockResolvedValueOnce({ rows: [] }) // ownership lookup → no match
    const ok = await addGuestComment({ threadId: 't1', pageId: 'p1', guestSessionToken: 'wrong', body: 'x' })
    expect(ok).toBe(false)
    expect(addSessionMessage).not.toHaveBeenCalled()
  })

  it('appends a reply (as the sentinel) when the token owns the thread', async () => {
    query.mockResolvedValueOnce({ rows: [{ sessionId: 'sess-1' }] }) // ownership lookup → match
    const ok = await addGuestComment({ threadId: 't1', pageId: 'p1', guestSessionToken: 'gtok', body: 'reply' })
    expect(ok).toBe(true)
    expect(addSessionMessage).toHaveBeenCalledWith(
      expect.objectContaining({ senderUserId: SENTINEL_GUEST_USER_ID, sessionId: 'sess-1' }),
    )
  })
})
