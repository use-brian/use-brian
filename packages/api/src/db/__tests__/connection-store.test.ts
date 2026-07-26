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

// The follow/accept/reject/mode write surface was pruned with the network
// teardown (2026-07-24): the only writer is the intra-workspace seed and the
// only readers are the A2A tools. See docs/architecture/channels/inter-assistant.md.
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
})
