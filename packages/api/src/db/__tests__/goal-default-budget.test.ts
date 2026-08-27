import { readFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../client.js', () => ({ query: vi.fn() }))

import { query } from '../client.js'
import {
  getWorkspaceGoalDefaultBudgetSystem,
  setWorkspaceGoalDefaultBudget,
} from '../goal-default-budget.js'

const mockQuery = vi.mocked(query)

beforeEach(() => mockQuery.mockReset())

describe('[COMP:goals/default-budget] workspace default budget store', () => {
  it('returns the built-in fallback when no override exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

    await expect(getWorkspaceGoalDefaultBudgetSystem('workspace-1')).resolves.toEqual({
      budget: { maxIterations: 30, maxSpend: 5 },
      source: 'built_in',
    })
  })

  it('reads and converts a persisted numeric override', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ max_iterations: 18, max_spend_usd: '9.5000000000' }],
      rowCount: 1,
    } as never)

    await expect(getWorkspaceGoalDefaultBudgetSystem('workspace-1')).resolves.toEqual({
      budget: { maxIterations: 18, maxSpend: 9.5 },
      source: 'workspace',
    })
  })

  it('owner/admin partial updates preserve the other current field', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ role: 'admin', workspace_exists: true }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [{ max_iterations: 12, max_spend_usd: '5.0000000000' }],
        rowCount: 1,
      } as never)

    const result = await setWorkspaceGoalDefaultBudget('user-1', 'workspace-1', {
      maxIterations: 12,
    })

    expect(result).toEqual({
      ok: true,
      budget: { maxIterations: 12, maxSpend: 5 },
      source: 'workspace',
    })
    const [sql, params] = mockQuery.mock.calls[1] as [string, unknown[]]
    expect(sql).toContain('ON CONFLICT (workspace_id) DO UPDATE')
    expect(params).toEqual(['workspace-1', 12, null, 30, 5, 'user-1'])
  })

  it('rejects a plain member before any write', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ role: 'member', workspace_exists: true }],
      rowCount: 1,
    } as never)

    const result = await setWorkspaceGoalDefaultBudget('user-1', 'workspace-1', {
      maxSpend: 10,
    })

    expect(result).toMatchObject({ ok: false, reason: 'not_admin' })
    expect(mockQuery).toHaveBeenCalledOnce()
  })

  it('reset deletes the override and returns the built-in fallback', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ role: 'owner', workspace_exists: true }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

    await expect(
      setWorkspaceGoalDefaultBudget('user-1', 'workspace-1', { reset: true }),
    ).resolves.toEqual({
      ok: true,
      budget: { maxIterations: 30, maxSpend: 5 },
      source: 'built_in',
    })
    expect(String(mockQuery.mock.calls[1]?.[0])).toContain('DELETE FROM workspace_goal_defaults')
  })

  it('validates again at the persistence boundary', async () => {
    const result = await setWorkspaceGoalDefaultBudget('user-1', 'workspace-1', {
      maxIterations: 0,
    })
    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('migration constrains the reusable default and cascades with the workspace', async () => {
    const sql = await readFile(
      new URL('../../../migrations/478_workspace_goal_defaults.sql', import.meta.url),
      'utf8',
    )
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.workspace_goal_defaults')
    expect(sql).toContain('max_iterations > 0 AND max_iterations <= 1000')
    expect(sql).toContain('max_spend_usd > 0')
    expect(sql).toContain('ON DELETE CASCADE')
  })
})
