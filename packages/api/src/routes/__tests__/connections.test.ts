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

const mockQuery = vi.mocked(query)

// The discovery/social write surface (follow, block/unblock, remove-follower,
// note, mutuals, pending-outgoing) was removed with the sharing_mode teardown.
// Only the A2A follow-graph read/manage routes consumed by the Studio Network
// tab survive. See docs/plans/network-feature-teardown.md.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeConnectionStore(): any {
  return {
    unfollow: vi.fn().mockResolvedValue(true),
    acceptRequest: vi.fn().mockResolvedValue({ id: 'c_1', status: 'accepted' }),
    rejectRequest: vi.fn().mockResolvedValue(true),
    getFollowing: vi.fn().mockResolvedValue([]),
    getFollowers: vi.fn().mockResolvedValue([]),
    getPendingRequests: vi.fn().mockResolvedValue([]),
    isFollowing: vi.fn().mockResolvedValue(false),
    followerCount: vi.fn().mockResolvedValue(5),
    followingCount: vi.fn().mockResolvedValue(3),
  }
}

/** Mock `query` to return an owner member row for requireAssistantMember. */
function mockMemberQuery() {
  mockQuery.mockResolvedValueOnce({ rows: [{ role: 'owner' }] } as any)
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
      // accept binds an optional mode_id; default = null (free mode).
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
