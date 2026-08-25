/**
 * Unit tests for linked-identity store (Stage 3 of the team-connector
 * promotion). Auth-only half of the user_linked_accounts split.
 *
 * Component tag: [COMP:api/linked-identity-store].
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import { createLinkedIdentityStore } from '../linked-identity-store.js'
import { query, queryWithRLS } from '../client.js'

const mockQuery = vi.mocked(query)
const mockQueryWithRLS = vi.mocked(queryWithRLS)

beforeEach(() => {
  vi.clearAllMocks()
})

const store = createLinkedIdentityStore()

describe('[COMP:api/linked-identity-store] createLinkedIdentityStore', () => {
  describe('findByProvider', () => {
    it('system-level lookup by (provider, provider_id)', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'li_1',
          userId: 'u_1',
          provider: 'telegram',
          providerId: '42',
          metadata: null,
          linkedAt: new Date(),
        }],
        rowCount: 1,
      } as never)

      const row = await store.findByProvider('telegram', '42')

      expect(row?.userId).toBe('u_1')
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
      expect(sql).toContain('FROM linked_identities')
      expect(sql).toContain('provider = $1')
      expect(sql).toContain('provider_id = $2')
      expect(params).toEqual(['telegram', '42'])
    })

    it('returns null when no identity exists', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      const row = await store.findByProvider('telegram', '42')
      expect(row).toBeNull()
    })
  })

  describe('findUniqueVerifiedApiClientByEmail', () => {
    it('binds the lookup to the exact active external chat key and assistant', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ providerId: 'studio-client:abc123' }],
        rowCount: 1,
      } as never)

      const externalUserId = await store.findUniqueVerifiedApiClientByEmail({
        apiKeyId: '00000000-0000-4000-8000-000000000010',
        assistantId: '00000000-0000-4000-8000-000000000011',
        email: ' Buyer@Customer.Example ',
      })

      expect(externalUserId).toBe('studio-client:abc123')
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
      expect(sql).toContain("li.provider = 'api:' || k.id::text")
      expect(sql).toContain("k.status = 'active'")
      expect(sql).toContain("k.audience = 'external'")
      expect(sql).toContain("k.scope = 'chat'")
      expect(sql).toContain("lower(li.metadata->>'email') = $3")
      expect(sql).not.toContain('DELETE FROM linked_identities')
      expect(sql).not.toContain('UPDATE linked_identities')
      expect(sql).not.toContain('FROM entities')
      expect(params).toEqual([
        '00000000-0000-4000-8000-000000000010',
        '00000000-0000-4000-8000-000000000011',
        'buyer@customer.example',
      ])
    })

    it('fails closed for zero or ambiguous distinct pairings', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      expect(await store.findUniqueVerifiedApiClientByEmail({
        apiKeyId: '00000000-0000-4000-8000-000000000010',
        assistantId: '00000000-0000-4000-8000-000000000011',
        email: 'buyer@customer.example',
      })).toBeNull()

      mockQuery.mockResolvedValueOnce({ rows: [{ providerId: null }], rowCount: 1 } as never)
      expect(await store.findUniqueVerifiedApiClientByEmail({
        apiKeyId: '00000000-0000-4000-8000-000000000010',
        assistantId: '00000000-0000-4000-8000-000000000011',
        email: 'buyer@customer.example',
      })).toBeNull()
    })

    it('selects only a same-user/entity historical Studio canonical id without mutating rows', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ providerId: 'studio-client:canonical' }],
        rowCount: 1,
      } as never)

      expect(await store.findUniqueVerifiedApiClientByEmail({
        apiKeyId: '00000000-0000-4000-8000-000000000010',
        assistantId: '00000000-0000-4000-8000-000000000011',
        email: 'buyer@customer.example',
      })).toBe('studio-client:canonical')

      const [sql] = mockQuery.mock.calls[0] as [string, unknown[]]
      expect(sql).toContain("provider_id LIKE 'studio-client:%'")
      expect(sql).toContain("provider_id NOT LIKE 'studio-demo:%'")
      expect(sql).toContain('COUNT(DISTINCT user_id) AS user_count')
      expect(sql).toContain('COUNT(*) FILTER (WHERE entity_id IS NULL) AS missing_entity_count')
      expect(sql).toContain('COUNT(DISTINCT entity_id) AS entity_count')
      expect(sql).not.toContain('DELETE FROM linked_identities')
      expect(sql).not.toContain('UPDATE linked_identities')
    })
  })

  describe('upsert', () => {
    it('INSERT ... ON CONFLICT on (provider, provider_id), refreshes user_id + metadata', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'li_1',
          userId: 'u_1',
          provider: 'telegram',
          providerId: '42',
          metadata: { first_name: 'Alice' },
          linkedAt: new Date(),
        }],
        rowCount: 1,
      } as never)

      await store.upsert({
        userId: 'u_1',
        provider: 'telegram',
        providerId: '42',
        metadata: { first_name: 'Alice' },
      })

      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
      expect(sql).toContain('INSERT INTO linked_identities')
      expect(sql).toContain('ON CONFLICT (provider, provider_id)')
      expect(sql).toContain('user_id = EXCLUDED.user_id')
      expect(params).toEqual(['u_1', 'telegram', '42', JSON.stringify({ first_name: 'Alice' })])
    })

    it('passes null metadata when none provided', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'li_1', userId: 'u_1', provider: 'telegram', providerId: '42', metadata: null, linkedAt: new Date() }],
        rowCount: 1,
      } as never)

      await store.upsert({ userId: 'u_1', provider: 'telegram', providerId: '42' })

      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]]
      expect(params[3]).toBeNull()
    })
  })

  describe('listForUser / deleteForUser', () => {
    it('listForUser goes through RLS', async () => {
      mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

      await store.listForUser('u_1')

      const [actingUserId, sql] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
      expect(actingUserId).toBe('u_1')
      expect(sql).toContain('FROM linked_identities')
      expect(sql).toContain('ORDER BY linked_at DESC')
    })

    it('deleteForUser returns true on match and false on miss', async () => {
      mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      expect(await store.deleteForUser('u_1', 'li_1')).toBe(true)

      mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      expect(await store.deleteForUser('u_1', 'li_missing')).toBe(false)
    })
  })
})
