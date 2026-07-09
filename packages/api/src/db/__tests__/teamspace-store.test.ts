import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import {
  createTeamspaceStore,
  ensureDefaultTeamspaceSystem,
  joinDefaultTeamspacesSystem,
  leaveWorkspaceTeamspacesSystem,
} from '../teamspace-store.js'
import { query, queryWithRLS, getPool } from '../client.js'

const mockQuery = vi.mocked(query)
const mockQueryWithRLS = vi.mocked(queryWithRLS)
const mockGetPool = vi.mocked(getPool)

const store = createTeamspaceStore()

const TS_ROW = {
  id: 'ts-1',
  workspaceId: 'w-1',
  name: 'Engineering',
  icon: null,
  description: null,
  sensitivity: 'internal',
  isDefault: false,
  position: 0,
  createdBy: 'u-1',
  createdAt: new Date(),
  updatedAt: new Date(),
}

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) — it also drops queued
  // mockResolvedValueOnce entries, so one test's unconsumed queue can never
  // bleed into the next.
  vi.resetAllMocks()
})

describe('[COMP:api/teamspace-store] create', () => {
  it('inserts the teamspace and auto-joins the creator in one transaction', async () => {
    const mockClient = {
      query: vi.fn()
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [TS_ROW], rowCount: 1 }) // INSERT teamspaces
        .mockResolvedValueOnce({ rowCount: 1 }) // INSERT teamspace_members (creator)
        .mockResolvedValueOnce(undefined), // COMMIT
      release: vi.fn(),
    }
    mockGetPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(mockClient) } as never)

    const created = await store.create({
      workspaceId: 'w-1',
      name: 'Engineering',
      sensitivity: 'internal',
      createdBy: 'u-1',
    })
    expect(created.id).toBe('ts-1')

    const insertSql = mockClient.query.mock.calls[1][0] as string
    expect(insertSql).toContain('INSERT INTO teamspaces')
    // Position appends after the workspace's existing sections.
    expect(insertSql).toContain('COALESCE(MAX(position) + 1, 0)')

    const joinSql = mockClient.query.mock.calls[2][0] as string
    expect(joinSql).toContain('INSERT INTO teamspace_members')
    expect(mockClient.query.mock.calls[3][0]).toBe('COMMIT')
    expect(mockClient.release).toHaveBeenCalled()
  })
})

describe('[COMP:api/teamspace-store] remove', () => {
  it('reassigns the teamspace\'s pages to General BEFORE deleting the row', async () => {
    const mockClient = {
      query: vi.fn()
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ workspaceId: 'w-1', isDefault: false }], rowCount: 1 }) // FOR UPDATE
        .mockResolvedValueOnce({ rowCount: 4 }) // UPDATE saved_views → General
        .mockResolvedValueOnce({ rowCount: 1 }) // DELETE teamspaces
        .mockResolvedValueOnce(undefined), // COMMIT
      release: vi.fn(),
    }
    mockGetPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(mockClient) } as never)

    await expect(store.remove('ts-1')).resolves.toBe(true)

    // Pages are never destroyed by container deletion: the reassignment must
    // run inside the same transaction, ahead of the DELETE (the FK's
    // ON DELETE SET NULL is only the crash-safe fallback).
    const reassignSql = mockClient.query.mock.calls[2][0] as string
    expect(reassignSql).toContain('UPDATE saved_views')
    expect(reassignSql).toContain('is_default = true')
    const deleteSql = mockClient.query.mock.calls[3][0] as string
    expect(deleteSql).toContain('DELETE FROM teamspaces')
  })

  it('refuses to delete the default (General) teamspace', async () => {
    const mockClient = {
      query: vi.fn()
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [{ workspaceId: 'w-1', isDefault: true }], rowCount: 1 }) // FOR UPDATE
        .mockResolvedValueOnce(undefined), // ROLLBACK
      release: vi.fn(),
    }
    mockGetPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(mockClient) } as never)

    await expect(store.remove('ts-default')).resolves.toBe(false)
    // Only BEGIN + FOR UPDATE + ROLLBACK — no page reassignment, no DELETE.
    expect(mockClient.query).toHaveBeenCalledTimes(3)
    expect(mockClient.query.mock.calls[2][0]).toBe('ROLLBACK')
  })
})

describe('[COMP:api/teamspace-store] listForUser', () => {
  it('reads RLS-scoped (membership is the visibility boundary), General first', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [TS_ROW], rowCount: 1 } as never)
    await store.listForUser('u-1', 'w-1')
    const [userId, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(userId).toBe('u-1')
    expect(sql).toContain('ORDER BY is_default DESC')
    expect(params).toEqual(['w-1'])
  })
})

describe('[COMP:api/teamspace-store] hasMemberBelowSystem (raise-sensitivity gate)', () => {
  it('compares each member\'s ROLE-BUMPED clearance against the candidate tier', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }], rowCount: 1 } as never)
    await expect(store.hasMemberBelowSystem('ts-1', 'confidential')).resolves.toBe(true)
    const sql = mockQuery.mock.calls[0][0] as string
    // Owners/admins bump to 'confidential' regardless of the stored column —
    // raising a tier must never be blocked by an operator's stale column.
    expect(sql).toContain("wm.role IN ('owner', 'admin') THEN 'confidential'")
    expect(sql).toContain('sensitivity_rank')
  })
})

describe('[COMP:api/teamspace-store] default-teamspace seams (mig 313)', () => {
  it('ensureDefaultTeamspaceSystem early-returns the existing General id (one cheap SELECT)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'ts-general' }], rowCount: 1 } as never) // SELECT default
    await expect(ensureDefaultTeamspaceSystem('w-1')).resolves.toBe('ts-general')
    // The common path costs one indexed SELECT — no member re-join sweep
    // (the per-caller join is joinDefaultTeamspacesSystem's job).
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('ensureDefaultTeamspaceSystem heals a missing General (deploy-window workspace)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // SELECT default — missing
      .mockResolvedValueOnce({ rows: [{ id: 'ts-new' }], rowCount: 1 } as never) // INSERT General
      .mockResolvedValueOnce({ rowCount: 2 } as never) // join all members
    await expect(ensureDefaultTeamspaceSystem('w-1')).resolves.toBe('ts-new')
    const createSql = mockQuery.mock.calls[1][0] as string
    expect(createSql).toContain("'General'")
    expect(createSql).toContain('is_default')
  })

  it('ensureDefaultTeamspaceSystem converges on the 23505 race by re-reading the winner', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // SELECT default — missing
      .mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' })) // INSERT loses the race
      .mockResolvedValueOnce({ rows: [{ id: 'ts-winner' }], rowCount: 1 } as never) // re-read the winner
      .mockResolvedValueOnce({ rowCount: 0 } as never) // member join
    await expect(ensureDefaultTeamspaceSystem('w-1')).resolves.toBe('ts-winner')
  })

  it('joinDefaultTeamspacesSystem heals first, then joins the one user', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: 'ts-general' }], rowCount: 1 } as never) // ensure: SELECT default (early return)
      .mockResolvedValueOnce({ rowCount: 1 } as never) // the user's join
    await joinDefaultTeamspacesSystem('w-1', 'u-9')
    const joinSql = mockQuery.mock.calls[1][0] as string
    expect(joinSql).toContain('is_default = true')
    expect(mockQuery.mock.calls[1][1]).toEqual(['w-1', 'u-9'])
  })

  it('leaveWorkspaceTeamspacesSystem drops every membership the user holds in the workspace', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 2 } as never)
    await leaveWorkspaceTeamspacesSystem('w-1', 'u-9')
    const sql = mockQuery.mock.calls[0][0] as string
    expect(sql).toContain('DELETE FROM teamspace_members')
    expect(mockQuery.mock.calls[0][1]).toEqual(['w-1', 'u-9'])
  })
})
