import { beforeEach, describe, expect, it, vi } from 'vitest'
import { query } from '../client.js'
import { createDbContextScopeStore } from '../context-scope-store.js'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getAppPool: vi.fn(),
  applyRLSGucs: vi.fn(),
  rollbackAndRelease: vi.fn(),
}))

describe('[COMP:api/context-scope-store] trusted principal grants', () => {
  beforeEach(() => vi.mocked(query).mockReset())

  it('gives owner/admin the universe member grant', async () => {
    vi.mocked(query).mockResolvedValueOnce({
      rows: [{ role: 'owner', mode: 'assigned', compartments: [] }],
    } as never)
    await expect(
      createDbContextScopeStore().resolveMemberTeamPrincipalSystem('u-1', 'w-1'),
    ).resolves.toEqual({ role: 'owner', mode: 'assigned', grant: null })
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('unions assigned member Teams and treats read_all as the sole wildcard', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({
        rows: [{ role: 'member', mode: 'assigned', compartments: null }],
      } as never)
      .mockResolvedValueOnce({
        rows: [
          { readAll: false, compartmentKey: 'team:sales' },
          { readAll: false, compartmentKey: 'team:strategy' },
          { readAll: false, compartmentKey: 'team:sales' },
        ],
      } as never)
    await expect(
      createDbContextScopeStore().resolveMemberTeamPrincipalSystem('u-1', 'w-1'),
    ).resolves.toMatchObject({ grant: ['team:sales', 'team:strategy'] })

    vi.mocked(query)
      .mockResolvedValueOnce({
        rows: [{ role: 'member', mode: 'assigned', compartments: [] }],
      } as never)
      .mockResolvedValueOnce({
        rows: [{ readAll: true, compartmentKey: 'team:management' }],
      } as never)
    await expect(
      createDbContextScopeStore().resolveMemberTeamPrincipalSystem('u-1', 'w-1'),
    ).resolves.toMatchObject({ grant: null })
  })

  it('preserves legacy assistant compartments and assigned Project ids', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({
        rows: [{
          teamMode: 'legacy',
          compartments: ['legacy'],
          projectMode: 'assigned',
          defaultGroupId: null,
          defaultProjectId: 'p-1',
        }],
      } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'p-2' }, { id: 'p-1' }] } as never)
    await expect(
      createDbContextScopeStore().resolveAssistantPrincipalSystem('a-1', 'w-1'),
    ).resolves.toEqual({
      teamMode: 'legacy',
      teamGrant: ['legacy'],
      projectMode: 'assigned',
      projectGrant: ['p-1', 'p-2'],
      defaultGroupId: null,
      defaultProjectId: 'p-1',
    })
  })
})
