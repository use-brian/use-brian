import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(() => ({
    connect: vi.fn(() => ({
      query: vi.fn(),
      release: vi.fn(),
    })),
  })),
}))

import { createWorkspaceStore, canMemberDraftRole, resolveReadClearanceSystem, isSoloWorkspaceSystem, resolveReadCompartmentsSystem, effectiveReadCompartments, intersectCompartments } from '../workspace-store.js'
import { query, queryWithRLS, getPool } from '../client.js'

const mockQuery = vi.mocked(query)
const mockQueryWithRLS = vi.mocked(queryWithRLS)
const mockGetPool = vi.mocked(getPool)

beforeEach(() => {
  vi.clearAllMocks()
})

const store = createWorkspaceStore()

describe('[COMP:api/workspace-store] createWorkspaceStore', () => {
  describe('create', () => {
    it('creates workspace + owner + kind=primary assistant + §17 grants in a single transaction', async () => {
      const mockClient = {
        query: vi.fn()
          .mockResolvedValueOnce(undefined) // BEGIN
          .mockResolvedValueOnce({ rows: [{ id: 't_1', name: 'Eng', purpose: 'Backend platform team', ownerUserId: 'u_1', createdAt: new Date(), updatedAt: new Date() }] }) // INSERT workspaces
          .mockResolvedValueOnce(undefined) // INSERT workspace_members
          .mockResolvedValueOnce({ rows: [{ id: 'a_primary' }] }) // INSERT assistants (primary)
          .mockResolvedValueOnce(undefined) // INSERT assistant_capabilities
          .mockResolvedValueOnce(undefined), // COMMIT
        release: vi.fn(),
      }
      mockGetPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(mockClient) } as any)

      const team = await store.create('u_1', 'Eng', 'Backend platform team')

      expect(team.name).toBe('Eng')
      expect(team.purpose).toBe('Backend platform team')
      expect(mockClient.query).toHaveBeenCalledTimes(6)
      expect(mockClient.query.mock.calls[0][0]).toBe('BEGIN')
      expect(mockClient.query.mock.calls[5][0]).toBe('COMMIT')

      // Workspace INSERT carries the purpose
      const wsInsert = mockClient.query.mock.calls[1]
      expect(wsInsert[0]).toContain('INSERT INTO workspaces')
      expect(wsInsert[0]).toContain('purpose')
      expect(wsInsert[1]).toEqual(['Eng', 'Backend platform team', 'u_1', expect.any(Number)])

      // Owner member row — stamped 'confidential' (operator role default,
      // sensitivity.md → User clearance Q18; not left at the 'internal' column
      // default, which would block the owner from confidential channels/pages).
      const memberInsertSql = mockClient.query.mock.calls[2][0] as string
      expect(memberInsertSql).toContain('INSERT INTO workspace_members')
      expect(memberInsertSql).toContain('clearance')
      expect(memberInsertSql).toContain("'confidential'")

      // Primary assistant — kind='primary', owner_user_id NULL, named "<workspace> Primary Assistant"
      const assistantInsertSql = mockClient.query.mock.calls[3][0] as string
      const assistantInsertArgs = mockClient.query.mock.calls[3][1] as unknown[]
      expect(assistantInsertSql).toContain('INSERT INTO assistants')
      expect(assistantInsertSql).toContain("'primary'")
      expect(assistantInsertSql).toContain('NULL')
      expect(assistantInsertArgs).toEqual(['Eng Primary Assistant', 't_1'])

      // §17 Tasks/CRM default-on capability grants
      const capsInsertSql = mockClient.query.mock.calls[4][0] as string
      const capsInsertArgs = mockClient.query.mock.calls[4][1] as unknown[]
      expect(capsInsertSql).toContain('INSERT INTO assistant_capabilities')
      expect(capsInsertSql).toContain("'tasks'")
      expect(capsInsertSql).toContain("'crm'")
      expect(capsInsertArgs).toEqual(['a_primary', 'u_1'])

      expect(mockClient.release).toHaveBeenCalled()
    })

    it('rolls the whole transaction back if the primary insert fails', async () => {
      const mockClient = {
        query: vi.fn()
          .mockResolvedValueOnce(undefined) // BEGIN
          .mockResolvedValueOnce({ rows: [{ id: 't_2', name: 'Ops', purpose: 'Ops & infra', ownerUserId: 'u_1', createdAt: new Date(), updatedAt: new Date() }] }) // INSERT workspaces
          .mockResolvedValueOnce(undefined) // INSERT workspace_members
          .mockRejectedValueOnce(new Error('unique violation on (workspace_id) WHERE kind=primary')) // INSERT assistants FAILS
          .mockResolvedValueOnce(undefined), // ROLLBACK
        release: vi.fn(),
      }
      mockGetPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(mockClient) } as any)

      await expect(store.create('u_1', 'Ops', 'Ops & infra')).rejects.toThrow(/unique violation/)

      // The COMMIT must not have run; ROLLBACK must have.
      const commands = mockClient.query.mock.calls.map((c) => c[0])
      expect(commands).not.toContain('COMMIT')
      expect(commands).toContain('ROLLBACK')
      expect(mockClient.release).toHaveBeenCalled()
    })
  })

  describe('update', () => {
    it('updates name and purpose together', async () => {
      mockQueryWithRLS.mockResolvedValueOnce({
        rows: [{ id: 't_1', name: 'New', purpose: 'New purpose', ownerUserId: 'u_1', createdAt: new Date(), updatedAt: new Date() }],
        rowCount: 1,
      } as never)

      const team = await store.update('u_1', 't_1', { name: 'New', purpose: 'New purpose' })
      expect(team?.name).toBe('New')
      expect(team?.purpose).toBe('New purpose')

      const sql = mockQueryWithRLS.mock.calls[0][1] as string
      expect(sql).toContain('name = $1')
      expect(sql).toContain('purpose = $2')
      const values = mockQueryWithRLS.mock.calls[0][2] as unknown[]
      expect(values).toEqual(['New', 'New purpose', 't_1'])
    })

    it('updates purpose alone without touching name', async () => {
      mockQueryWithRLS.mockResolvedValueOnce({
        rows: [{ id: 't_1', name: 'Existing', purpose: 'Updated', ownerUserId: 'u_1', createdAt: new Date(), updatedAt: new Date() }],
        rowCount: 1,
      } as never)

      await store.update('u_1', 't_1', { purpose: 'Updated' })

      const sql = mockQueryWithRLS.mock.calls[0][1] as string
      expect(sql).toContain('purpose = $1')
      expect(sql).not.toContain('name = $')
    })

    it('returns the current row when no fields are provided (no-op)', async () => {
      mockQueryWithRLS.mockResolvedValueOnce({
        rows: [{ id: 't_1', name: 'Existing', purpose: 'Existing purpose', ownerUserId: 'u_1', createdAt: new Date(), updatedAt: new Date() }],
        rowCount: 1,
      } as never)

      const team = await store.update('u_1', 't_1', {})
      expect(team?.name).toBe('Existing')

      const sql = mockQueryWithRLS.mock.calls[0][1] as string
      expect(sql).toContain('SELECT')
      expect(sql).not.toContain('UPDATE')
    })
  })

  describe('list', () => {
    it('returns teams the user belongs to', async () => {
      mockQueryWithRLS.mockResolvedValueOnce({
        rows: [
          { id: 't_1', name: 'Eng', ownerUserId: 'u_1', createdAt: new Date(), updatedAt: new Date() },
        ],
        rowCount: 1,
      } as never)

      const teams = await store.list('u_1')
      expect(teams).toHaveLength(1)
      expect(teams[0].name).toBe('Eng')
      expect(mockQueryWithRLS.mock.calls[0][0]).toBe('u_1')
    })
  })

  describe('get', () => {
    it('returns null for non-existent team', async () => {
      mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      const team = await store.get('u_1', 't_missing')
      expect(team).toBeNull()
    })
  })

  describe('delete', () => {
    it('only allows the owner to delete', async () => {
      mockQueryWithRLS.mockResolvedValueOnce({ rowCount: 1 } as never)
      const deleted = await store.delete('u_1', 't_1')
      expect(deleted).toBe(true)

      const sql = mockQueryWithRLS.mock.calls[0][1] as string
      expect(sql).toContain('owner_user_id = $2')
    })

    it('returns false when team not found or not owner', async () => {
      mockQueryWithRLS.mockResolvedValueOnce({ rowCount: 0 } as never)
      const deleted = await store.delete('u_2', 't_1')
      expect(deleted).toBe(false)
    })
  })

  describe('addMember', () => {
    it('adds member to team and all team assistants', async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: 'tm_1', workspaceId: 't_1', userId: 'u_2', role: 'member', joinedAt: new Date() }],
          rowCount: 1,
        } as never)
        .mockResolvedValueOnce({ rowCount: 0 } as never) // assistant_members insert

      const member = await store.addMember('u_1', 't_1', 'u_2')
      expect(member.userId).toBe('u_2')
      expect(member.role).toBe('member')

      // Verify assistant_members sync
      expect(mockQuery).toHaveBeenCalledTimes(2)
      const assistantSql = mockQuery.mock.calls[1][0] as string
      expect(assistantSql).toContain('INSERT INTO assistant_members')
      expect(assistantSql).toContain('ON CONFLICT')
    })

    it("stamps a plain member's clearance to 'internal' (role default)", async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: 'tm_1', workspaceId: 't_1', userId: 'u_2', role: 'member', joinedAt: new Date() }],
          rowCount: 1,
        } as never)
        .mockResolvedValueOnce({ rowCount: 0 } as never)

      await store.addMember('u_1', 't_1', 'u_2')

      const memberInsertSql = mockQuery.mock.calls[0][0] as string
      const memberInsertArgs = mockQuery.mock.calls[0][1] as unknown[]
      expect(memberInsertSql).toContain('INSERT INTO workspace_members')
      expect(memberInsertSql).toContain('clearance')
      // [workspaceId, memberUserId, role, clearance]
      expect(memberInsertArgs).toEqual(['t_1', 'u_2', 'member', 'internal'])
    })

    it("stamps an admin's clearance to 'confidential' (operator role default)", async () => {
      mockQuery
        .mockResolvedValueOnce({
          rows: [{ id: 'tm_2', workspaceId: 't_1', userId: 'u_3', role: 'admin', joinedAt: new Date() }],
          rowCount: 1,
        } as never)
        .mockResolvedValueOnce({ rowCount: 0 } as never)

      await store.addMember('u_1', 't_1', 'u_3', 'admin')

      const memberInsertArgs = mockQuery.mock.calls[0][1] as unknown[]
      expect(memberInsertArgs).toEqual(['t_1', 'u_3', 'admin', 'confidential'])
    })
  })

  describe('updateMemberRole', () => {
    // Clearance tracks the role default: promote → confidential, demote →
    // internal (sensitivity.md → User clearance Q18). The owner row is never
    // touched (role <> 'owner' guard).
    it("promoting to admin sets clearance = 'confidential' alongside role", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 } as never)

      const ok = await store.updateMemberRole('u_actor', 't_1', 'u_member', 'admin')
      expect(ok).toBe(true)

      const sql = mockQuery.mock.calls[0][0] as string
      const args = mockQuery.mock.calls[0][1] as unknown[]
      expect(sql).toContain('SET role = $1')
      expect(sql).toContain('clearance = $4')
      expect(sql).toContain("role <> 'owner'")
      // [role, workspaceId, memberUserId, clearance]
      expect(args).toEqual(['admin', 't_1', 'u_member', 'confidential'])
    })

    it("demoting to member sets clearance = 'internal'", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 } as never)

      await store.updateMemberRole('u_actor', 't_1', 'u_admin', 'member')

      const args = mockQuery.mock.calls[0][1] as unknown[]
      expect(args).toEqual(['member', 't_1', 'u_admin', 'internal'])
    })
  })

  describe('removeMember', () => {
    it('removes member from team and team assistants', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 1 } as never) // assistant_members delete
        .mockResolvedValueOnce({ rowCount: 1 } as never) // workspace_members delete

      const removed = await store.removeMember('u_1', 't_1', 'u_2')
      expect(removed).toBe(true)
      expect(mockQuery).toHaveBeenCalledTimes(2)
    })

    it('cannot remove the owner', async () => {
      mockQuery
        .mockResolvedValueOnce({ rowCount: 0 } as never)
        .mockResolvedValueOnce({ rowCount: 0 } as never)

      const removed = await store.removeMember('u_1', 't_1', 'u_owner')
      expect(removed).toBe(false)
    })
  })

  describe('getRole', () => {
    it('returns the role for a team member', async () => {
      mockQueryWithRLS.mockResolvedValueOnce({
        rows: [{ role: 'admin' }],
        rowCount: 1,
      } as never)

      const role = await store.getRole('u_1', 't_1')
      expect(role).toBe('admin')
    })

    it('returns null for non-members', async () => {
      mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      const role = await store.getRole('u_unknown', 't_1')
      expect(role).toBeNull()
    })
  })

  describe('updateMemberDraftPermission', () => {
    // The store's UPDATE filters out role='owner' rows so an owner's
    // effective permission is never represented as a stored boolean.
    // Admins write through but the route layer adds a 400 for that case.
    it('updates can_draft for the target member and returns true on success', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 } as never)

      const ok = await store.updateMemberDraftPermission('u_actor', 't_1', 'u_member', true)
      expect(ok).toBe(true)
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining(`UPDATE workspace_members SET can_draft`),
        [true, 't_1', 'u_member'],
      )
    })

    it("never writes the column on owner rows (role <> 'owner' guard)", async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 } as never)

      const ok = await store.updateMemberDraftPermission('u_actor', 't_1', 'u_owner', true)
      expect(ok).toBe(false)
    })
  })

  describe('adoptAssistant (transfer-of-ownership)', () => {
    /**
     * Stage 5 of the team-connector promotion: adopt is now a single
     * transaction that (a) NULLs owner_user_id + sets workspace_id, and (b)
     * strips assistant_members rows. Fan-out per team member is no longer
     * created — team access flows through workspace_members after migration
     * 089's XOR flip.
     */
    function makeTxClient(rowCounts: number[]): {
      client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }
      setPool: () => void
    } {
      const calls = [...rowCounts]
      const client = {
        query: vi.fn(async (sql: string) => {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return undefined
          const count = calls.shift() ?? 0
          return { rowCount: count, rows: [] }
        }),
        release: vi.fn(),
      }
      return {
        client,
        setPool() {
          mockGetPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client) } as never)
        },
      }
    }

    it('runs the ownership-transfer transaction when caller is the owner', async () => {
      // 1) RLS ownership check — caller is owner
      mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ role: 'owner' }], rowCount: 1 } as never)

      // 2) transactional client: BEGIN → UPDATE → DELETE → COMMIT
      //    rowCounts feed the non-BEGIN/COMMIT queries: [UPDATE, DELETE]
      const { client, setPool } = makeTxClient([1, 0])
      setPool()

      const result = await store.adoptAssistant('u_1', 't_1', 'a_1')
      expect(result).toBe(true)

      // BEGIN + UPDATE + DELETE + COMMIT = 4 calls
      expect(client.query).toHaveBeenCalledTimes(4)
      expect(client.query.mock.calls[0][0]).toBe('BEGIN')
      expect(client.query.mock.calls[3][0]).toBe('COMMIT')

      const updateSql = client.query.mock.calls[1][0] as string
      expect(updateSql).toContain('UPDATE assistants')
      expect(updateSql).toContain('workspace_id = $1')
      expect(updateSql).toContain('owner_user_id = NULL')

      const deleteSql = client.query.mock.calls[2][0] as string
      expect(deleteSql).toContain('DELETE FROM assistant_members')
    })

    it('returns false if user does not own the assistant', async () => {
      mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ role: 'member' }], rowCount: 1 } as never)

      const result = await store.adoptAssistant('u_2', 't_1', 'a_1')
      expect(result).toBe(false)
    })

    it('rolls back if the UPDATE matched zero rows (assistant already in a team)', async () => {
      mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ role: 'owner' }], rowCount: 1 } as never)
      const { client, setPool } = makeTxClient([0])
      setPool()

      const result = await store.adoptAssistant('u_1', 't_1', 'a_1')
      expect(result).toBe(false)

      // BEGIN + UPDATE + ROLLBACK (no DELETE, no COMMIT)
      expect(client.query.mock.calls[0][0]).toBe('BEGIN')
      expect(client.query.mock.calls[2][0]).toBe('ROLLBACK')
    })
  })

  describe('removeAssistant (transfer-of-ownership)', () => {
    it('transfers the assistant into the workspace owner\'s Personal workspace', async () => {
      // 1) workspace lookup — returns owner + their Personal workspace id
      mockQuery.mockResolvedValueOnce({ rows: [{ ownerUserId: 'u_team_owner', personalWorkspaceId: 'w_personal' }], rowCount: 1 } as never)

      // 2) transactional client: BEGIN → UPDATE → DELETE assistant_members → INSERT owner → COMMIT
      const calls = [1, 0, 1]
      const client = {
        query: vi.fn(async (sql: string) => {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return undefined
          const count = calls.shift() ?? 0
          return { rowCount: count, rows: [] }
        }),
        release: vi.fn(),
      }
      mockGetPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client) } as never)

      const result = await store.removeAssistant('u_admin', 't_1', 'a_1')
      expect(result).toBe(true)

      expect(client.query.mock.calls[0][0]).toBe('BEGIN')
      const updateSql = client.query.mock.calls[1][0] as string
      expect(updateSql).toContain('workspace_id = $1')
      expect(updateSql).toContain('owner_user_id = $2')

      const insertSql = client.query.mock.calls[3][0] as string
      expect(insertSql).toContain('INSERT INTO assistant_members')
      expect(insertSql).toContain("VALUES ($1, $2, 'owner')")

      expect(client.query.mock.calls[4][0]).toBe('COMMIT')
    })

    it('returns false if assistant not in the workspace (UPDATE matched 0)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ ownerUserId: 'u_team_owner', personalWorkspaceId: 'w_personal' }], rowCount: 1 } as never)
      const calls = [0]
      const client = {
        query: vi.fn(async (sql: string) => {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return undefined
          const count = calls.shift() ?? 0
          return { rowCount: count, rows: [] }
        }),
        release: vi.fn(),
      }
      mockGetPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client) } as never)

      const result = await store.removeAssistant('u_admin', 't_1', 'a_missing')
      expect(result).toBe(false)
      expect(client.query.mock.calls[2][0]).toBe('ROLLBACK')
    })

    it('returns false if workspace not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

      const result = await store.removeAssistant('u_admin', 't_missing', 'a_1')
      expect(result).toBe(false)
    })
  })
})


describe('[COMP:feed/draft-permission] canMemberDraftRole', () => {
  it('returns true unconditionally for owner and admin roles', () => {
    expect(canMemberDraftRole('owner', false)).toBe(true)
    expect(canMemberDraftRole('admin', false)).toBe(true)
    expect(canMemberDraftRole('owner', true)).toBe(true)
    expect(canMemberDraftRole('admin', true)).toBe(true)
  })

  it('for member role, follows the can_draft column', () => {
    expect(canMemberDraftRole('member', true)).toBe(true)
    expect(canMemberDraftRole('member', false)).toBe(false)
  })
})

describe('[COMP:api/workspace-store] resolveReadClearanceSystem', () => {
  function mockMembership(role: string | null, clearance?: string) {
    // getWorkspaceMembershipWithClearanceSystem uses bare query()
    mockQuery.mockResolvedValueOnce(
      (role === null
        ? { rows: [], rowCount: 0 }
        : { rows: [{ role, clearance }], rowCount: 1 }) as never,
    )
  }

  it('no workspace → returns the assistant clearance unchanged (no member concept)', async () => {
    expect(await resolveReadClearanceSystem('u-1', null, 'confidential')).toBe('confidential')
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('plain member below the assistant → min caps reads at the member tier (the leak fix)', async () => {
    mockMembership('member', 'internal')
    expect(await resolveReadClearanceSystem('u-1', 'ws-1', 'confidential')).toBe('internal')
  })

  it('owner/admin → effectively confidential (mig-153 intent), so min leaves the assistant clearance', async () => {
    // Even when the column reads 'internal' (post-backfill default), an owner
    // is not restricted — avoids regressing operators.
    mockMembership('owner', 'internal')
    expect(await resolveReadClearanceSystem('u-1', 'ws-1', 'confidential')).toBe('confidential')
    mockMembership('admin', 'internal')
    expect(await resolveReadClearanceSystem('u-2', 'ws-1', 'confidential')).toBe('confidential')
  })

  it('non-member (e.g. channel participant, no workspace_members row) → public (most restrictive)', async () => {
    mockMembership(null)
    expect(await resolveReadClearanceSystem('shadow', 'ws-1', 'confidential')).toBe('public')
  })

  it('member at or above the assistant clearance → assistant clearance (no widening)', async () => {
    mockMembership('member', 'confidential')
    expect(await resolveReadClearanceSystem('u-1', 'ws-1', 'internal')).toBe('internal')
  })
})

describe('[COMP:api/workspace-store] resolveReadCompartmentsSystem', () => {
  function mockMembership(role: string | null, compartments?: string[] | null) {
    // getWorkspaceMembershipWithCompartmentsSystem uses bare query()
    mockQuery.mockResolvedValueOnce(
      (role === null
        ? { rows: [], rowCount: 0 }
        : { rows: [{ role, compartments }], rowCount: 1 }) as never,
    )
  }

  it('no workspace → returns the assistant grant unchanged (no member concept)', async () => {
    expect(await resolveReadCompartmentsSystem('u-1', null, ['sales'])).toEqual(['sales'])
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('plain member grant ∩ assistant universe → the member grant', async () => {
    mockMembership('member', ['sales'])
    expect(await resolveReadCompartmentsSystem('u-1', 'ws-1', null)).toEqual(['sales'])
  })

  it('plain member grant ∩ assistant grant → the intersection', async () => {
    mockMembership('member', ['sales', 'eng'])
    expect(await resolveReadCompartmentsSystem('u-1', 'ws-1', ['sales', 'finance'])).toEqual(['sales'])
  })

  it('plain member with NULL column (inert default = universe) → the assistant grant', async () => {
    mockMembership('member', null)
    expect(await resolveReadCompartmentsSystem('u-1', 'ws-1', ['sales'])).toEqual(['sales'])
  })

  it('plain member with an explicit empty grant → empty (only uncompartmented rows), NOT the assistant grant', async () => {
    mockMembership('member', [])
    expect(await resolveReadCompartmentsSystem('u-1', 'ws-1', ['sales'])).toEqual([])
  })

  it('owner/admin → universe member grant, so the effective grant is the assistant grant', async () => {
    mockMembership('owner', ['sales']) // column ignored for operators
    expect(await resolveReadCompartmentsSystem('u-1', 'ws-1', ['sales', 'finance'])).toEqual(['sales', 'finance'])
    mockMembership('admin', null)
    expect(await resolveReadCompartmentsSystem('u-2', 'ws-1', null)).toBeNull()
  })

  it('non-member (no workspace_members row) → empty grant (only uncompartmented rows)', async () => {
    mockMembership(null)
    expect(await resolveReadCompartmentsSystem('shadow', 'ws-1', null)).toEqual([])
  })
})

describe('[COMP:api/workspace-store] effectiveReadCompartments / intersectCompartments', () => {
  it('intersect treats null as the universe (identity element)', () => {
    expect(intersectCompartments(null, null)).toBeNull()
    expect(intersectCompartments(null, ['a'])).toEqual(['a'])
    expect(intersectCompartments(['a'], null)).toEqual(['a'])
  })

  it('intersect of two finite grants keeps only common compartments', () => {
    expect(intersectCompartments(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual(['b', 'c'])
    expect(intersectCompartments(['a'], ['b'])).toEqual([])
  })

  it('owner/admin member resolves to the universe before intersecting', () => {
    expect(effectiveReadCompartments('owner', ['x'], ['sales'])).toEqual(['sales'])
    expect(effectiveReadCompartments('admin', ['x'], null)).toBeNull()
  })

  it('non-member resolves to the empty grant (most restrictive)', () => {
    expect(effectiveReadCompartments(null, null, null)).toEqual([])
    expect(effectiveReadCompartments(null, ['x'], ['sales'])).toEqual([])
  })

  it('plain member uses the column grant; null column = universe', () => {
    expect(effectiveReadCompartments('member', ['sales'], null)).toEqual(['sales'])
    expect(effectiveReadCompartments('member', null, ['sales'])).toEqual(['sales'])
  })

  it('plain member with an explicit empty grant is cleared into nothing (distinct from null=universe)', () => {
    // The security-load-bearing distinction: [] (granted nothing → only
    // uncompartmented rows) must NOT collapse to null (universe).
    expect(effectiveReadCompartments('member', [], ['sales'])).toEqual([])
    expect(effectiveReadCompartments('member', [], null)).toEqual([])
  })
})

describe('[COMP:api/workspace-store] isSoloWorkspaceSystem (connector base-load gate)', () => {
  // The DB computes `solo = member_count <= 1`, keyed purely on the live
  // workspace_members count and NEVER on is_personal (the flag is only a label;
  // gating on it caused the 2026-06-02 regression where a 3-member is_personal
  // workspace leaked the owner's connectors). These tests assert (a) the boolean
  // is passed through, (b) the SQL counts workspace_members and does NOT branch
  // on is_personal, and (c) fail-closed behavior.
  it('returns true when the DB says the workspace is solo (member count <= 1)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ solo: true }], rowCount: 1 } as never)
    expect(await isSoloWorkspaceSystem('ws-1')).toBe(true)

    // The query gates on the live member count, never on is_personal.
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('count(*)')
    expect(sql).toContain('workspace_members')
    expect(sql).not.toContain('is_personal')
  })

  it('returns false when the workspace has teammates (count > 1), any kind', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ solo: false }], rowCount: 1 } as never)
    expect(await isSoloWorkspaceSystem('ws-multi')).toBe(false)
  })

  it('returns false (fail-closed) when the workspace row is missing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await isSoloWorkspaceSystem('ws-missing')).toBe(false)
  })

  it('returns false (fail-closed) when the lookup throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection reset'))
    expect(await isSoloWorkspaceSystem('ws-err')).toBe(false)
  })
})
