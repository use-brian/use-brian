/**
 * Unit tests for connector-grant store (Stage 4 of the team-connector
 * promotion). Member-exposure grants.
 *
 * Component tag: [COMP:api/connector-grant-store].
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import { createConnectorGrantStore } from '../connector-grant-store.js'
import { query, queryWithRLS } from '../client.js'

const mockQuery = vi.mocked(query)
const mockQueryWithRLS = vi.mocked(queryWithRLS)

beforeEach(() => {
  vi.clearAllMocks()
})

const store = createConnectorGrantStore()

function baseGrant(overrides = {}) {
  return {
    id: 'cg_1',
    connectorInstanceId: 'ci_1',
    targetType: 'workspace' as const,
    targetId: 't_1',
    grantedByUserId: 'u_alice',
    grantedAt: new Date(),
    ...overrides,
  }
}

describe('[COMP:api/connector-grant-store] createConnectorGrantStore', () => {
  describe('create', () => {
    it('inserts a grant when the instance is user-scoped and owned by grantor', async () => {
      // 1) validation lookup
      mockQuery.mockResolvedValueOnce({
        rows: [{ scope: 'user', userId: 'u_alice' }],
        rowCount: 1,
      } as never)
      // 2) INSERT ... RETURNING
      mockQueryWithRLS.mockResolvedValueOnce({
        rows: [baseGrant()],
        rowCount: 1,
      } as never)

      const grant = await store.create({
        actingUserId: 'u_alice',
        connectorInstanceId: 'ci_1',
        targetType: 'workspace',
        targetId: 't_1',
      })

      expect(grant.id).toBe('cg_1')
      const [, sql] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
      expect(sql).toContain('INSERT INTO connector_grant')
      expect(sql).toContain('ON CONFLICT (connector_instance_id, target_type, target_id) DO NOTHING')
    })

    it('refuses to grant a team-scoped instance', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ scope: 'workspace', userId: null }],
        rowCount: 1,
      } as never)

      await expect(
        store.create({
          actingUserId: 'u_alice',
          connectorInstanceId: 'ci_team',
          targetType: 'workspace',
          targetId: 't_1',
        }),
      ).rejects.toThrow(/workspace-scoped/i)
    })

    it('refuses when acting user is not the instance owner', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ scope: 'user', userId: 'u_bob' }],
        rowCount: 1,
      } as never)

      await expect(
        store.create({
          actingUserId: 'u_alice',
          connectorInstanceId: 'ci_bobs',
          targetType: 'workspace',
          targetId: 't_1',
        }),
      ).rejects.toThrow(/instance owner/i)
    })

    it('returns existing grant when ON CONFLICT DO NOTHING swallowed the insert', async () => {
      // validation
      mockQuery.mockResolvedValueOnce({
        rows: [{ scope: 'user', userId: 'u_alice' }],
        rowCount: 1,
      } as never)
      // INSERT returned no rows (conflict)
      mockQueryWithRLS.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      } as never)
      // SELECT to fetch existing
      mockQueryWithRLS.mockResolvedValueOnce({
        rows: [baseGrant({ id: 'cg_existing' })],
        rowCount: 1,
      } as never)

      const grant = await store.create({
        actingUserId: 'u_alice',
        connectorInstanceId: 'ci_1',
        targetType: 'workspace',
        targetId: 't_1',
      })

      expect(grant.id).toBe('cg_existing')
    })
  })

  describe('revoke', () => {
    it('deletes through RLS — succeeds for grantor or team member', async () => {
      mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      expect(await store.revoke('u_alice', 'cg_1')).toBe(true)
    })

    it('returns false when RLS hides the row from the caller', async () => {
      mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      expect(await store.revoke('u_stranger', 'cg_1')).toBe(false)
    })
  })

  describe('listForTargetSystem', () => {
    it('joins connector_instance and returns shaped grant+instance', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: 'cg_1',
          connectorInstanceId: 'ci_1',
          targetType: 'workspace',
          targetId: 't_1',
          grantedByUserId: 'u_alice',
          grantedAt: new Date(),
          instance_id: 'ci_1',
          instance_scope: 'user',
          instance_userId: 'u_alice',
          instance_workspaceId: null,
          instance_provider: 'gcal',
          instance_label: "Alice's Calendar",
          instance_connectedEmail: 'alice@example.com',
          instance_url: null,
          instance_custom: false,
          instance_config: {},
          instance_sensitivity: 'internal',
          instance_connected: true,
          instance_createdBy: 'u_alice',
          instance_createdAt: new Date(),
          instance_updatedAt: new Date(),
        }],
        rowCount: 1,
      } as never)

      const rows = await store.listForTargetSystem('workspace', 't_1')

      expect(rows).toHaveLength(1)
      expect(rows[0].instance.provider).toBe('gcal')
      expect(rows[0].instance.label).toBe("Alice's Calendar")
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
      expect(sql).toContain('JOIN connector_instance ci')
      expect(params).toEqual(['workspace', 't_1'])
    })
  })

  describe('listByGrantor', () => {
    it('lists by grantor through RLS', async () => {
      mockQueryWithRLS.mockResolvedValueOnce({
        rows: [baseGrant()],
        rowCount: 1,
      } as never)

      await store.listByGrantor('u_alice')

      const [actingUserId, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
      expect(actingUserId).toBe('u_alice')
      expect(sql).toContain('granted_by_user_id = $1')
      expect(params).toEqual(['u_alice'])
    })
  })

  describe('deleteByGrantorAndTargetSystem', () => {
    it('cascade on team-member removal — deletes all grants from user to team', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 3 } as never)
      const n = await store.deleteByGrantorAndTargetSystem('u_alice', 'workspace', 't_1')
      expect(n).toBe(3)

      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
      expect(sql).toContain('DELETE FROM connector_grant')
      expect(params).toEqual(['u_alice', 'workspace', 't_1'])
    })
  })

  describe('findGrantedInstanceByProviderSystem', () => {
    it('joins grant→instance, scoped to user-scoped connected instances of the provider', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 'ci_gh', scope: 'user', provider: 'github', connected: true }],
        rowCount: 1,
      } as never)

      const instance = await store.findGrantedInstanceByProviderSystem('workspace', 't_1', 'github')

      expect(instance?.id).toBe('ci_gh')
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
      expect(sql).toContain('JOIN connector_instance ci')
      expect(sql).toContain("ci.scope = 'user'")
      expect(sql).toContain('ci.connected = true')
      expect(params).toEqual(['workspace', 't_1', 'github'])
    })

    it('returns null when no exposed instance of the provider exists', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      const instance = await store.findGrantedInstanceByProviderSystem('workspace', 't_1', 'github')
      expect(instance).toBeNull()
    })
  })
})
