import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

// Mock DB client before importing the route
vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import { connectionRoutes } from '../connections.js'
import { query } from '../../db/client.js'
import type { ConnectionStore } from '../../db/connection-store.js'

const mockQuery = vi.mocked(query)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeConnectionStore(): any {
  return {
    follow: vi.fn().mockResolvedValue({ id: 'c_1', status: 'accepted' }),
    unfollow: vi.fn().mockResolvedValue(true),
    acceptRequest: vi.fn().mockResolvedValue({ id: 'c_1', status: 'accepted' }),
    rejectRequest: vi.fn().mockResolvedValue(true),
    blockAssistant: vi.fn().mockResolvedValue({ id: 'c_1', status: 'blocked' }),
    unblock: vi.fn().mockResolvedValue(true),
    getFollowing: vi.fn().mockResolvedValue([]),
    getPendingOutgoing: vi.fn().mockResolvedValue([]),
    getFollowers: vi.fn().mockResolvedValue([]),
    getMutuals: vi.fn().mockResolvedValue([]),
    getPendingRequests: vi.fn().mockResolvedValue([]),
    isFollowing: vi.fn().mockResolvedValue(false),
    isBlocked: vi.fn().mockResolvedValue(false),
    followerCount: vi.fn().mockResolvedValue(5),
    followingCount: vi.fn().mockResolvedValue(3),
    setCallerNote: vi.fn().mockResolvedValue({ id: 'c_1', callerNote: 'note' }),
  }
}

/**
 * Mock `query` to return a member row for requireAssistantMember,
 * then optionally the target-exists row and sharing_mode row for follow.
 */
function mockMemberQuery() {
  mockQuery.mockResolvedValueOnce({ rows: [{ role: 'owner' }] } as any)
}

function mockFollowQueries(opts: { targetExists?: boolean; sharingMode?: string } = {}) {
  const { targetExists = true, sharingMode = 'public' } = opts
  // 1) member check
  mockQuery.mockResolvedValueOnce({ rows: [{ role: 'owner' }] } as any)
  // 2) target exists
  mockQuery.mockResolvedValueOnce({
    rows: targetExists ? [{ id: 'a_target' }] : [],
  } as any)
  // 3) sharing_mode (only reached if target exists)
  if (targetExists) {
    mockQuery.mockResolvedValueOnce({
      rows: [{ sharing_mode: sharingMode }],
    } as any)
  }
}

describe('[COMP:api/connections-route] Connection routes', () => {
  let connectionStore: ReturnType<typeof makeConnectionStore>

  beforeEach(() => {
    vi.clearAllMocks()
    connectionStore = makeConnectionStore()
  })

  function app() {
    return createTestApp(
      '/api/connections',
      connectionRoutes({ connectionStore }),
      { userId: 'u_1' },
    )
  }

  // ── POST /follow ─────────────────────────────────────────

  describe('POST /follow', () => {
    it('returns 400 when followerAssistantId is missing', async () => {
      const res = await request(app())
        .post('/api/connections/follow')
        .send({ followingAssistantId: 'a_2' })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/required/)
    })

    it('returns 400 when followingAssistantId is missing', async () => {
      const res = await request(app())
        .post('/api/connections/follow')
        .send({ followerAssistantId: 'a_1' })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/required/)
    })

    it('returns 400 when trying to self-follow', async () => {
      const res = await request(app())
        .post('/api/connections/follow')
        .send({ followerAssistantId: 'a_1', followingAssistantId: 'a_1' })
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/yourself/)
    })

    it('returns 403 when user is not a member of follower assistant', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] } as any) // no member row
      const res = await request(app())
        .post('/api/connections/follow')
        .send({ followerAssistantId: 'a_1', followingAssistantId: 'a_2' })
      expect(res.status).toBe(403)
      expect(res.body.error).toMatch(/Not a member/)
    })

    it('returns 404 when target assistant does not exist', async () => {
      mockFollowQueries({ targetExists: false })
      const res = await request(app())
        .post('/api/connections/follow')
        .send({ followerAssistantId: 'a_1', followingAssistantId: 'a_2' })
      expect(res.status).toBe(404)
      expect(res.body.error).toMatch(/not found/)
    })

    it('returns 403 when target sharing_mode is off', async () => {
      mockFollowQueries({ sharingMode: 'off' })
      const res = await request(app())
        .post('/api/connections/follow')
        .send({ followerAssistantId: 'a_1', followingAssistantId: 'a_2' })
      expect(res.status).toBe(403)
      expect(res.body.error).toMatch(/not accepting/)
    })

    it('auto-accepts when target is public', async () => {
      mockFollowQueries({ sharingMode: 'public' })
      const res = await request(app())
        .post('/api/connections/follow')
        .send({ followerAssistantId: 'a_1', followingAssistantId: 'a_2' })
      expect(res.status).toBe(201)
      expect(connectionStore.follow).toHaveBeenCalledWith('a_1', 'a_2', true)
    })

    it('creates pending request when target is private', async () => {
      mockFollowQueries({ sharingMode: 'private' })
      const res = await request(app())
        .post('/api/connections/follow')
        .send({ followerAssistantId: 'a_1', followingAssistantId: 'a_2' })
      expect(res.status).toBe(201)
      expect(connectionStore.follow).toHaveBeenCalledWith('a_1', 'a_2', false)
    })

    it('returns 403 when blocked by target', async () => {
      mockFollowQueries({ sharingMode: 'public' })
      connectionStore.follow.mockRejectedValueOnce(new Error('blocked'))
      const res = await request(app())
        .post('/api/connections/follow')
        .send({ followerAssistantId: 'a_1', followingAssistantId: 'a_2' })
      expect(res.status).toBe(403)
      expect(res.body.error).toMatch(/blocked/)
    })

    it('returns 500 on unexpected error', async () => {
      mockFollowQueries({ sharingMode: 'public' })
      connectionStore.follow.mockRejectedValueOnce(new Error('db crash'))
      const res = await request(app())
        .post('/api/connections/follow')
        .send({ followerAssistantId: 'a_1', followingAssistantId: 'a_2' })
      expect(res.status).toBe(500)
    })
  })

  // ── POST /unfollow ───────────────────────────────────────

  describe('POST /unfollow', () => {
    it('returns 400 when IDs are missing', async () => {
      const res = await request(app())
        .post('/api/connections/unfollow')
        .send({})
      expect(res.status).toBe(400)
    })

    it('returns 403 when user is not a member', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] } as any)
      const res = await request(app())
        .post('/api/connections/unfollow')
        .send({ followerAssistantId: 'a_1', followingAssistantId: 'a_2' })
      expect(res.status).toBe(403)
    })

    it('unfollows successfully', async () => {
      mockMemberQuery()
      const res = await request(app())
        .post('/api/connections/unfollow')
        .send({ followerAssistantId: 'a_1', followingAssistantId: 'a_2' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })
      expect(connectionStore.unfollow).toHaveBeenCalledWith('a_1', 'a_2')
    })
  })

  // ── POST /remove-follower ────────────────────────────────

  describe('POST /remove-follower', () => {
    it('returns 400 when IDs are missing', async () => {
      const res = await request(app())
        .post('/api/connections/remove-follower')
        .send({})
      expect(res.status).toBe(400)
    })

    it('returns 403 when user is not a member of myAssistantId', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] } as any)
      const res = await request(app())
        .post('/api/connections/remove-follower')
        .send({ myAssistantId: 'a_1', followerAssistantId: 'a_2' })
      expect(res.status).toBe(403)
    })

    it('removes follower successfully', async () => {
      mockMemberQuery()
      const res = await request(app())
        .post('/api/connections/remove-follower')
        .send({ myAssistantId: 'a_1', followerAssistantId: 'a_2' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })
      // unfollow is called with (follower, following) — i.e. (a_2, a_1)
      expect(connectionStore.unfollow).toHaveBeenCalledWith('a_2', 'a_1')
    })
  })

  // ── POST /:id/accept ────────────────────────────────────

  describe('POST /:id/accept', () => {
    it('accepts a pending request', async () => {
      // 1) ownership lookup (following_assistant_id), 2) requireAssistantMember
      mockQuery.mockResolvedValueOnce({ rows: [{ followingAssistantId: 'a_target' }] } as any)
      mockMemberQuery()
      const res = await request(app())
        .post('/api/connections/c_1/accept')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ id: 'c_1', status: 'accepted' })
      // Migration 111: accept binds an optional mode_id; default = null (free mode).
      expect(connectionStore.acceptRequest).toHaveBeenCalledWith('c_1', null)
    })

    it('returns 404 when request not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] } as any) // ownership lookup → not found
      const res = await request(app())
        .post('/api/connections/c_999/accept')
      expect(res.status).toBe(404)
      expect(res.body.error).toMatch(/not found/)
      expect(connectionStore.acceptRequest).not.toHaveBeenCalled()
    })

    it('returns 403 when the caller does not own the assistant being followed', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ followingAssistantId: 'a_target' }] } as any)
      mockQuery.mockResolvedValueOnce({ rows: [] } as any) // requireAssistantMember → not a member
      const res = await request(app())
        .post('/api/connections/c_1/accept')
      expect(res.status).toBe(403)
      expect(connectionStore.acceptRequest).not.toHaveBeenCalled()
    })
  })

  // ── POST /:id/reject ────────────────────────────────────

  describe('POST /:id/reject', () => {
    it('rejects a pending request', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ followingAssistantId: 'a_target' }] } as any)
      mockMemberQuery()
      const res = await request(app())
        .post('/api/connections/c_1/reject')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })
      expect(connectionStore.rejectRequest).toHaveBeenCalledWith('c_1')
    })

    it('returns 404 when request not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] } as any) // ownership lookup → not found
      const res = await request(app())
        .post('/api/connections/c_999/reject')
      expect(res.status).toBe(404)
      expect(res.body.error).toMatch(/not found/)
      expect(connectionStore.rejectRequest).not.toHaveBeenCalled()
    })

    it('returns 403 when the caller does not own the assistant being followed', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ followingAssistantId: 'a_target' }] } as any)
      mockQuery.mockResolvedValueOnce({ rows: [] } as any) // not a member
      const res = await request(app())
        .post('/api/connections/c_1/reject')
      expect(res.status).toBe(403)
      expect(connectionStore.rejectRequest).not.toHaveBeenCalled()
    })
  })

  // ── POST /:id/note ───────────────────────────────────────

  describe('POST /:id/note', () => {
    it('returns 400 when note is not string or null', async () => {
      const res = await request(app())
        .post('/api/connections/c_1/note')
        .send({ note: 123 })
      expect(res.status).toBe(400)
    })

    it('returns 404 when the connection does not exist', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] } as any)
      const res = await request(app())
        .post('/api/connections/c_missing/note')
        .send({ note: 'restaurant picks' })
      expect(res.status).toBe(404)
    })

    it('returns 403 when the caller does not own the follower assistant', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ followerAssistantId: 'a_other' }] } as any)
      mockQuery.mockResolvedValueOnce({ rows: [] } as any) // member check fails
      const res = await request(app())
        .post('/api/connections/c_1/note')
        .send({ note: 'restaurant picks' })
      expect(res.status).toBe(403)
    })

    it('updates the note when the caller owns the follower assistant', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ followerAssistantId: 'a_me' }] } as any)
      mockQuery.mockResolvedValueOnce({ rows: [{ role: 'owner' }] } as any)
      const res = await request(app())
        .post('/api/connections/c_1/note')
        .send({ note: 'restaurant picks' })
      expect(res.status).toBe(200)
      expect(connectionStore.setCallerNote).toHaveBeenCalledWith('c_1', 'restaurant picks')
    })

    it('clears the note when null is passed', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ followerAssistantId: 'a_me' }] } as any)
      mockQuery.mockResolvedValueOnce({ rows: [{ role: 'owner' }] } as any)
      const res = await request(app())
        .post('/api/connections/c_1/note')
        .send({ note: null })
      expect(res.status).toBe(200)
      expect(connectionStore.setCallerNote).toHaveBeenCalledWith('c_1', null)
    })
  })

  // ── POST /block ──────────────────────────────────────────

  describe('POST /block', () => {
    it('returns 400 when IDs are missing', async () => {
      const res = await request(app())
        .post('/api/connections/block')
        .send({})
      expect(res.status).toBe(400)
    })

    it('returns 403 when user is not a member', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] } as any)
      const res = await request(app())
        .post('/api/connections/block')
        .send({ myAssistantId: 'a_1', blockedAssistantId: 'a_2' })
      expect(res.status).toBe(403)
    })

    it('blocks an assistant', async () => {
      mockMemberQuery()
      const res = await request(app())
        .post('/api/connections/block')
        .send({ myAssistantId: 'a_1', blockedAssistantId: 'a_2' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ id: 'c_1', status: 'blocked' })
      expect(connectionStore.blockAssistant).toHaveBeenCalledWith('a_1', 'a_2')
    })
  })

  // ── POST /unblock ────────────────────────────────────────

  describe('POST /unblock', () => {
    it('returns 400 when IDs are missing', async () => {
      const res = await request(app())
        .post('/api/connections/unblock')
        .send({})
      expect(res.status).toBe(400)
    })

    it('returns 403 when user is not a member', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] } as any)
      const res = await request(app())
        .post('/api/connections/unblock')
        .send({ myAssistantId: 'a_1', blockedAssistantId: 'a_2' })
      expect(res.status).toBe(403)
    })

    it('unblocks an assistant', async () => {
      mockMemberQuery()
      const res = await request(app())
        .post('/api/connections/unblock')
        .send({ myAssistantId: 'a_1', blockedAssistantId: 'a_2' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ ok: true })
      expect(connectionStore.unblock).toHaveBeenCalledWith('a_1', 'a_2')
    })
  })

  // ── GET /following ───────────────────────────────────────

  describe('GET /following', () => {
    it('returns 400 without assistantId', async () => {
      const res = await request(app())
        .get('/api/connections/following')
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/assistantId/)
    })

    it('returns 403 when user is not a member', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] } as any)
      const res = await request(app())
        .get('/api/connections/following?assistantId=a_1')
      expect(res.status).toBe(403)
    })

    it('returns connections array', async () => {
      mockMemberQuery()
      connectionStore.getFollowing.mockResolvedValueOnce([{ id: 'c_1' }])
      const res = await request(app())
        .get('/api/connections/following?assistantId=a_1')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ connections: [{ id: 'c_1' }] })
    })
  })

  // ── GET /pending-outgoing ─────────────────────────────────

  describe('GET /pending-outgoing', () => {
    it('returns 400 without assistantId', async () => {
      const res = await request(app())
        .get('/api/connections/pending-outgoing')
      expect(res.status).toBe(400)
    })

    it('returns connections array', async () => {
      mockMemberQuery()
      connectionStore.getPendingOutgoing.mockResolvedValueOnce([{ id: 'c_2' }])
      const res = await request(app())
        .get('/api/connections/pending-outgoing?assistantId=a_1')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ connections: [{ id: 'c_2' }] })
    })
  })

  // ── GET /followers ───────────────────────────────────────

  describe('GET /followers', () => {
    it('returns 400 without assistantId', async () => {
      const res = await request(app())
        .get('/api/connections/followers')
      expect(res.status).toBe(400)
    })

    it('returns 403 when user is not a member', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] } as any)
      const res = await request(app())
        .get('/api/connections/followers?assistantId=a_1')
      expect(res.status).toBe(403)
    })

    it('returns connections array', async () => {
      mockMemberQuery()
      connectionStore.getFollowers.mockResolvedValueOnce([{ id: 'c_2' }])
      const res = await request(app())
        .get('/api/connections/followers?assistantId=a_1')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ connections: [{ id: 'c_2' }] })
    })
  })

  // ── GET /mutuals ─────────────────────────────────────────

  describe('GET /mutuals', () => {
    it('returns 400 without assistantId', async () => {
      const res = await request(app())
        .get('/api/connections/mutuals')
      expect(res.status).toBe(400)
    })

    it('returns 403 when user is not a member', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] } as any)
      const res = await request(app())
        .get('/api/connections/mutuals?assistantId=a_1')
      expect(res.status).toBe(403)
    })

    it('returns connections array', async () => {
      mockMemberQuery()
      connectionStore.getMutuals.mockResolvedValueOnce([{ id: 'c_3' }])
      const res = await request(app())
        .get('/api/connections/mutuals?assistantId=a_1')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ connections: [{ id: 'c_3' }] })
    })
  })

  // ── GET /pending ─────────────────────────────────────────

  describe('GET /pending', () => {
    it('returns 400 without assistantId', async () => {
      const res = await request(app())
        .get('/api/connections/pending')
      expect(res.status).toBe(400)
    })

    it('returns 403 when user is not a member', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] } as any)
      const res = await request(app())
        .get('/api/connections/pending?assistantId=a_1')
      expect(res.status).toBe(403)
    })

    it('returns connections array', async () => {
      mockMemberQuery()
      connectionStore.getPendingRequests.mockResolvedValueOnce([{ id: 'c_4' }])
      const res = await request(app())
        .get('/api/connections/pending?assistantId=a_1')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ connections: [{ id: 'c_4' }] })
    })
  })

  // ── GET /counts ──────────────────────────────────────────

  describe('GET /counts', () => {
    it('returns 400 without assistantId', async () => {
      const res = await request(app())
        .get('/api/connections/counts')
      expect(res.status).toBe(400)
    })

    it('returns follower and following counts', async () => {
      const res = await request(app())
        .get('/api/connections/counts?assistantId=a_1')
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ followers: 5, following: 3 })
    })
  })

  // ── GET /activity ────────────────────────────────────────

  describe('GET /activity', () => {
    it('returns 400 without assistantId', async () => {
      const res = await request(app())
        .get('/api/connections/activity')
      expect(res.status).toBe(400)
    })

    it('returns 403 when user is not a member', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] } as any)
      const res = await request(app())
        .get('/api/connections/activity?assistantId=a_1')
      expect(res.status).toBe(403)
    })

    it('returns activity grouped by session', async () => {
      // member check
      mockMemberQuery()
      // activity query
      mockQuery.mockResolvedValueOnce({
        rows: [
          { sessionId: 's_1', channelId: 'a_caller:123', role: 'user', text: 'hello', createdAt: '2026-01-01' },
          { sessionId: 's_1', channelId: 'a_caller:123', role: 'assistant', text: 'hi', createdAt: '2026-01-02' },
        ],
      } as any)
      // caller name lookup
      mockQuery.mockResolvedValueOnce({
        rows: [{ name: 'Caller Bot', handle: 'callerbot' }],
      } as any)

      const res = await request(app())
        .get('/api/connections/activity?assistantId=a_1')
      expect(res.status).toBe(200)
      expect(res.body.activity).toHaveLength(1)
      expect(res.body.activity[0].callerName).toBe('Caller Bot')
      expect(res.body.activity[0].callerHandle).toBe('callerbot')
      expect(res.body.activity[0].messages).toHaveLength(2)
    })
  })

  // ── Auth: no userId ──────────────────────────────────────

  describe('unauthenticated requests', () => {
    function unauthApp() {
      return createTestApp(
        '/api/connections',
        connectionRoutes({ connectionStore }),
        // no userId
      )
    }

    it('POST /follow returns 401', async () => {
      const res = await request(unauthApp())
        .post('/api/connections/follow')
        .send({ followerAssistantId: 'a_1', followingAssistantId: 'a_2' })
      expect(res.status).toBe(401)
    })

    it('POST /unfollow returns 401', async () => {
      const res = await request(unauthApp())
        .post('/api/connections/unfollow')
        .send({ followerAssistantId: 'a_1', followingAssistantId: 'a_2' })
      expect(res.status).toBe(401)
    })

    it('GET /following returns 401', async () => {
      const res = await request(unauthApp())
        .get('/api/connections/following?assistantId=a_1')
      expect(res.status).toBe(401)
    })

    it('GET /counts returns 401', async () => {
      const res = await request(unauthApp())
        .get('/api/connections/counts?assistantId=a_1')
      expect(res.status).toBe(401)
    })
  })
})
