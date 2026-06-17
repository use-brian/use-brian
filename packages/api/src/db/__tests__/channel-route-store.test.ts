/**
 * Unit tests for channel-route store (Stage 3 of the team-connector
 * promotion). Routing-only half of the user_linked_accounts split.
 *
 * Component tag: [COMP:api/channel-route-store].
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
}))

import { createChannelRouteStore } from '../channel-route-store.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)

beforeEach(() => {
  vi.clearAllMocks()
})

const store = createChannelRouteStore()

describe('[COMP:api/channel-route-store] createChannelRouteStore', () => {
  describe('findByProvider', () => {
    it('system-level lookup returns the routed assistant', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'cr_1',
          assistantId: 'a_1',
          provider: 'telegram',
          providerId: '42',
          createdAt: new Date(),
        }],
        rowCount: 1,
      } as never)

      const route = await store.findByProvider('telegram', '42')

      expect(route?.assistantId).toBe('a_1')
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
      expect(sql).toContain('FROM channel_routes')
      expect(params).toEqual(['telegram', '42'])
    })

    it('returns null when no route exists', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      expect(await store.findByProvider('telegram', '42')).toBeNull()
    })
  })

  describe('upsert', () => {
    it('ON CONFLICT (provider, provider_id) re-points assistant', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'cr_1', assistantId: 'a_new', provider: 'telegram', providerId: '42', createdAt: new Date() }],
        rowCount: 1,
      } as never)

      await store.upsert({ assistantId: 'a_new', provider: 'telegram', providerId: '42' })

      const [sql] = mockQuery.mock.calls[0] as [string, unknown[]]
      expect(sql).toContain('INSERT INTO channel_routes')
      expect(sql).toContain('ON CONFLICT (provider, provider_id)')
      expect(sql).toContain('assistant_id = EXCLUDED.assistant_id')
    })
  })

  describe('deleteSystem', () => {
    it('deletes exactly the (provider, provider_id, assistant_id) row', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

      const ok = await store.deleteSystem('telegram', '42', 'a_1')
      expect(ok).toBe(true)

      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
      expect(sql).toContain('DELETE FROM channel_routes')
      expect(sql).toContain('assistant_id = $3')
      expect(params).toEqual(['telegram', '42', 'a_1'])
    })
  })

  describe('deleteAllForAssistantSystem', () => {
    it('returns count of deleted rows', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 3 } as never)
      const n = await store.deleteAllForAssistantSystem('a_1')
      expect(n).toBe(3)
    })
  })

  describe('listForAssistantSystem', () => {
    it('returns all routes for an assistant', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          { id: 'cr_a', assistantId: 'a_1', provider: 'telegram', providerId: '42', createdAt: new Date() },
          { id: 'cr_b', assistantId: 'a_1', provider: 'slack', providerId: 'U42', createdAt: new Date() },
        ],
        rowCount: 2,
      } as never)

      const routes = await store.listForAssistantSystem('a_1')
      expect(routes).toHaveLength(2)
      expect(routes.map(r => r.provider)).toEqual(['telegram', 'slack'])
    })
  })
})
