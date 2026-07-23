import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import { createConnectionStore } from '../connection-store.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)

beforeEach(() => {
  vi.clearAllMocks()
})

const store = createConnectionStore()

const now = new Date()

// The discovery/social write surface (follow, block/unblock, mutuals,
// pending-outgoing, caller-note) was pruned with the sharing_mode teardown.
// Only the A2A-load-bearing + Network-tab-consumed methods remain. See
// docs/plans/network-feature-teardown.md.
describe('[COMP:api/connection-store] createConnectionStore', () => {
  describe('seedWorkspacePrimaryFollows', () => {
    it('issues a set-based primary→sibling upsert scoped to the workspace, DO NOTHING on conflict', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 3 } as never)

      const created = await store.seedWorkspacePrimaryFollows('ws_1')

      expect(created).toBe(3)
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain('INSERT INTO assistant_connections')
      expect(sql).toContain("'accepted', 'workspace'")
      expect(sql).toContain("p.kind = 'primary'")
      expect(sql).toContain('a.id <> p.id')
      // Never downgrades a user follow / unblocks a blocked edge.
      expect(sql).toContain('ON CONFLICT (follower_assistant_id, following_assistant_id) DO NOTHING')
      expect(mockQuery.mock.calls[0][1]).toEqual(['ws_1'])
    })

    it('returns 0 when the workspace has no primary or no siblings', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      const created = await store.seedWorkspacePrimaryFollows('ws_empty')
      expect(created).toBe(0)
    })
  })

  describe('unfollow', () => {
    it('deletes the connection and returns true', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 } as never)

      const result = await store.unfollow('a_1', 'a_2')

      expect(result).toBe(true)
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain('DELETE FROM assistant_connections')
      expect(sql).toContain("status != 'blocked'")
      expect(mockQuery.mock.calls[0][1]).toEqual(['a_1', 'a_2'])
    })

    it('returns false when no matching connection exists', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 } as never)

      const result = await store.unfollow('a_1', 'a_unknown')
      expect(result).toBe(false)
    })

    it('does not delete blocked connections', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 } as never)

      const result = await store.unfollow('a_1', 'a_2')
      expect(result).toBe(false)

      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain("status != 'blocked'")
    })
  })

  describe('acceptRequest', () => {
    it('updates pending connection to accepted and returns it', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'c_1',
          followerAssistantId: 'a_1',
          followingAssistantId: 'a_2',
          status: 'accepted',
          createdAt: now,
          updatedAt: now,
        }],
        rowCount: 1,
      } as never)

      const conn = await store.acceptRequest('c_1')

      expect(conn).not.toBeNull()
      expect(conn!.status).toBe('accepted')

      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain("SET status = 'accepted'")
      expect(sql).toContain("status = 'pending'")
      // Migration 111 added mode_id binding at acceptance time; null = free mode.
      expect(mockQuery.mock.calls[0][1]).toEqual(['c_1', null])
    })

    it('returns null when connection not found or not pending', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

      const conn = await store.acceptRequest('c_missing')
      expect(conn).toBeNull()
    })
  })

  describe('rejectRequest', () => {
    it('deletes pending connection and returns true', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 } as never)

      const result = await store.rejectRequest('c_1')

      expect(result).toBe(true)
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain('DELETE FROM assistant_connections')
      expect(sql).toContain("status = 'pending'")
      expect(mockQuery.mock.calls[0][1]).toEqual(['c_1'])
    })

    it('returns false when connection not found or not pending', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 } as never)

      const result = await store.rejectRequest('c_missing')
      expect(result).toBe(false)
    })
  })

  describe('getFollowing', () => {
    it('returns accepted outgoing connections with details', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 'c_1', followerAssistantId: 'a_me', followingAssistantId: 'a_2', status: 'accepted', followingAssistantName: 'Bot2' },
          { id: 'c_2', followerAssistantId: 'a_me', followingAssistantId: 'a_3', status: 'accepted', followingAssistantName: 'Bot3' },
        ],
        rowCount: 2,
      } as never)

      const rows = await store.getFollowing('a_me')

      expect(rows).toHaveLength(2)
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain('follower_assistant_id = $1')
      expect(sql).toContain("status = 'accepted'")
      expect(sql).toContain('JOIN assistants')
      expect(mockQuery.mock.calls[0][1]).toEqual(['a_me'])
    })
  })

  describe('getFollowers', () => {
    it('returns accepted incoming connections', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'c_f1', followerAssistantId: 'a_other', followingAssistantId: 'a_me', status: 'accepted' }],
        rowCount: 1,
      } as never)

      const rows = await store.getFollowers('a_me')

      expect(rows).toHaveLength(1)
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain('following_assistant_id = $1')
      expect(sql).toContain("status = 'accepted'")
      expect(mockQuery.mock.calls[0][1]).toEqual(['a_me'])
    })
  })

  describe('getPendingRequests', () => {
    it('returns pending incoming requests', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'c_pr1', followerAssistantId: 'a_requester', followingAssistantId: 'a_me', status: 'pending' }],
        rowCount: 1,
      } as never)

      const rows = await store.getPendingRequests('a_me')

      expect(rows).toHaveLength(1)
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain('following_assistant_id = $1')
      expect(sql).toContain("status = 'pending'")
      expect(mockQuery.mock.calls[0][1]).toEqual(['a_me'])
    })
  })

  describe('isFollowing', () => {
    it('returns true when an accepted connection exists', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ exists: true }],
        rowCount: 1,
      } as never)

      const result = await store.isFollowing('a_1', 'a_2')

      expect(result).toBe(true)
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain('EXISTS')
      expect(sql).toContain("status = 'accepted'")
      expect(mockQuery.mock.calls[0][1]).toEqual(['a_1', 'a_2'])
    })

    it('returns false when no accepted connection exists', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ exists: false }],
        rowCount: 1,
      } as never)

      const result = await store.isFollowing('a_1', 'a_unknown')
      expect(result).toBe(false)
    })
  })

  describe('followerCount', () => {
    it('returns parsed integer count of accepted followers', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ count: '42' }],
        rowCount: 1,
      } as never)

      const count = await store.followerCount('a_popular')

      expect(count).toBe(42)
      expect(typeof count).toBe('number')
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain('COUNT(*)')
      expect(sql).toContain('following_assistant_id = $1')
      expect(sql).toContain("status = 'accepted'")
      expect(mockQuery.mock.calls[0][1]).toEqual(['a_popular'])
    })
  })

  describe('followingCount', () => {
    it('returns parsed integer count of accepted following', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ count: '7' }],
        rowCount: 1,
      } as never)

      const count = await store.followingCount('a_me')

      expect(count).toBe(7)
      expect(typeof count).toBe('number')
      const sql = mockQuery.mock.calls[0][0] as string
      expect(sql).toContain('COUNT(*)')
      expect(sql).toContain('follower_assistant_id = $1')
      expect(sql).toContain("status = 'accepted'")
      expect(mockQuery.mock.calls[0][1]).toEqual(['a_me'])
    })
  })
})
