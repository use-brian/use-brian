import type { Pool, PoolClient } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { createWorkspaceModulesStore, lockWorkspaceModule, requireWorkspaceModuleAdmission } from '../workspace-modules-store.js'
const registry = { fixture: { key: 'fixture', defaultState: 'disabled' as const } }
const lockFixtureModule = (client: PoolClient, workspaceId: string) => lockWorkspaceModule(client, workspaceId, 'fixture', registry)

describe('[COMP:api/workspace-modules] Admission failures', () => {
  it('treats missing state as disabled and locks its parent before re-reading', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 })
    const module = await lockFixtureModule({ query } as unknown as PoolClient, 'workspace')
    expect(module).toMatchObject({ state: 'disabled', version: 0 })
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      expect.stringContaining('module_key=$2 FOR SHARE'),
      'SELECT id FROM workspaces WHERE id=$1 FOR SHARE',
      expect.stringContaining('module_key=$2 FOR SHARE'),
    ])
    expect(() => requireWorkspaceModuleAdmission(module, 'new_work')).toThrow(expect.objectContaining({ code: 'module_disabled' }))
  })

  it('does not turn database failure into permission or a fake disabled result', async () => {
    const query = vi.fn().mockRejectedValue(new Error('database unavailable'))
    const pool = { query } as unknown as Pool
    await expect(createWorkspaceModulesStore(pool, pool, { registry }).get('workspace', 'fixture')).rejects.toThrow('database unavailable')
    await expect(lockFixtureModule({ query } as unknown as PoolClient, 'workspace')).rejects.toThrow('database unavailable')
  })

  it('rejects malformed lifecycle commands without opening a transaction', async () => {
    const pool = { connect: vi.fn() } as unknown as Pool
    const store = createWorkspaceModulesStore(pool, pool, { registry })
    await expect(store.act('workspace', 'user', 'fixture', { action: 'enable', expectedVersion: -1 }))
      .rejects.toMatchObject({ code: 'invalid_input' })
    expect(pool.connect).not.toHaveBeenCalled()
  })
})
