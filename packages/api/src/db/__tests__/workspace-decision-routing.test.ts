import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import { query, queryWithRLS } from '../client.js'
import { createWorkspaceDecisionRoutingStore } from '../workspace-decision-routing.js'

const mockQuery = vi.mocked(query)
const mockQueryWithRLS = vi.mocked(queryWithRLS)
const store = createWorkspaceDecisionRoutingStore()

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:decisions/workspace-routing] workspace decision routing store', () => {
  it('reads runtime policy through the system query', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{
      workspace_id: 'workspace-fictional',
      mode: 'shadow',
      model_alias: 'typesafe-jev-1.13',
      updated_at: '2026-09-28T00:00:00.000Z',
    }] } as never)

    await expect(store.getSystem('workspace-fictional')).resolves.toMatchObject({
      mode: 'shadow',
      modelAlias: 'typesafe-jev-1.13',
    })
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('workspace_decision_routing'), ['workspace-fictional'])
  })

  it('persists an active decision model through the member-scoped connection', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{
      workspace_id: 'workspace-fictional',
      mode: 'shadow',
      model_alias: 'typesafe-jev-1.13',
      updated_at: '2026-09-28T00:00:00.000Z',
    }] } as never)

    await store.set({
      actingUserId: 'user-fictional',
      workspaceId: 'workspace-fictional',
      mode: 'shadow',
      modelAlias: 'typesafe-jev-1.13',
    })

    expect(mockQueryWithRLS).toHaveBeenCalledWith(
      'user-fictional',
      expect.stringContaining('ON CONFLICT (workspace_id)'),
      ['workspace-fictional', 'shadow', 'typesafe-jev-1.13', 'user-fictional'],
    )
  })

  it('persists a hybrid preference for an active decision model', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{
      workspace_id: 'workspace-fictional',
      mode: 'hybrid',
      model_alias: 'typesafe-jev-1.13',
      updated_at: '2026-09-28T00:00:00.000Z',
    }] } as never)

    await store.set({
      actingUserId: 'user-fictional',
      workspaceId: 'workspace-fictional',
      mode: 'hybrid',
      modelAlias: 'typesafe-jev-1.13',
    })

    expect(mockQueryWithRLS).toHaveBeenCalledWith(
      'user-fictional',
      expect.any(String),
      ['workspace-fictional', 'hybrid', 'typesafe-jev-1.13', 'user-fictional'],
    )
  })

  it('rejects chat models before touching the database', async () => {
    await expect(store.set({
      actingUserId: 'user-fictional',
      workspaceId: 'workspace-fictional',
      mode: 'shadow',
      modelAlias: 'gemini-3-flash-standard',
    })).rejects.toThrow('not an active decision model')
    expect(mockQueryWithRLS).not.toHaveBeenCalled()
  })
})
