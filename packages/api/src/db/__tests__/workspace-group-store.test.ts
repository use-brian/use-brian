/**
 * Unit tests for the workspace-group store.
 * Component tag: [COMP:api/workspace-group-store].
 *
 * Named sets of workspace members a doc page can be shared with at a role
 * (migration 252). Every op goes through `queryWithRLS`, so the
 * `workspace_groups` / `workspace_group_members` RLS policies gate the
 * caller's workspace. We mock the client and assert the SQL shape,
 * parameterization, and the row → domain mapping (memberCount coercion,
 * ISO createdAt, delete-returns-boolean) without a database.
 *
 * Spec: docs/architecture/features/doc.md.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({ queryWithRLS: vi.fn() }))

import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { queryWithRLS } from '../client.js'

const mockQuery = vi.mocked(queryWithRLS)
const store = createDbWorkspaceGroupStore()

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:api/workspace-group-store] createGroup', () => {
  it('inserts and returns a group with memberCount 0 + ISO createdAt', async () => {
    const createdAt = new Date('2026-07-07T00:00:00.000Z')
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'g1', workspaceId: 'w1', name: 'Leads', createdAt }],
    } as never)
    const group = await store.createGroup('u1', 'w1', 'Leads')
    expect(group).toEqual({
      id: 'g1',
      workspaceId: 'w1',
      name: 'Leads',
      kind: 'sharing',
      key: null,
      description: null,
      color: null,
      status: 'active',
      compartmentKey: null,
      readAll: false,
      memberCount: 0,
      createdAt: '2026-07-07T00:00:00.000Z',
    })
    const [userId, sql, params] = mockQuery.mock.calls[0] as [string, string, unknown[]]
    expect(userId).toBe('u1')
    expect(sql).toContain('INSERT INTO workspace_groups')
    // created_by is stamped with the acting user.
    expect(params).toEqual(['w1', 'Leads', 'u1'])
  })
})

describe('[COMP:api/workspace-group-store] listGroups', () => {
  it('coerces the aggregate memberCount to a number and maps rows', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'g1', workspaceId: 'w1', name: 'Leads', createdAt: new Date('2026-07-01T00:00:00.000Z'), memberCount: 3 },
        { id: 'g2', workspaceId: 'w1', name: 'Ops', createdAt: new Date('2026-07-02T00:00:00.000Z'), memberCount: 0 },
      ],
    } as never)
    const groups = await store.listGroups('u1', 'w1')
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ id: 'g1', memberCount: 3, createdAt: '2026-07-01T00:00:00.000Z' })
    expect(groups[1].memberCount).toBe(0)
    const [, sql, params] = mockQuery.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain('FROM workspace_groups')
    expect(sql).toContain('LEFT JOIN workspace_group_members')
    expect(params).toEqual(['w1'])
  })
})

describe('[COMP:api/workspace-group-store] addMember', () => {
  it('inserts ON CONFLICT DO NOTHING (idempotent add)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    await store.addMember('u1', 'g1', 'u2')
    const [userId, sql, params] = mockQuery.mock.calls[0] as [string, string, unknown[]]
    expect(userId).toBe('u1')
    expect(sql).toContain('INSERT INTO workspace_group_members')
    expect(sql).toContain('ON CONFLICT (group_id, user_id) DO NOTHING')
    expect(params).toEqual(['g1', 'u2'])
  })
})

describe('[COMP:api/workspace-group-store] removeMember', () => {
  it('returns true when a row was deleted', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'gm1' }] } as never)
    expect(await store.removeMember('u1', 'g1', 'u2')).toBe(true)
  })

  it('returns false when nothing matched', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    expect(await store.removeMember('u1', 'g1', 'u2')).toBe(false)
  })
})

describe('[COMP:api/workspace-group-store] listMembers', () => {
  it('joins users and returns the member rows', async () => {
    const rows = [
      { userId: 'u2', name: 'Jane', email: 'jane@example.com' },
      { userId: 'u3', name: null, email: null },
    ]
    mockQuery.mockResolvedValueOnce({ rows } as never)
    const members = await store.listMembers('u1', 'g1')
    expect(members).toEqual(rows)
    const [, sql, params] = mockQuery.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain('FROM workspace_group_members')
    expect(sql).toContain('JOIN users')
    expect(params).toEqual(['g1'])
  })
})
