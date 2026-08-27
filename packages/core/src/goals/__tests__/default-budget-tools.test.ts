import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../../tools/types.js'
import {
  createGoalDefaultBudgetTools,
  type GoalDefaultBudgetStorePort,
} from '../default-budget-tools.js'

const context = (workspaceId?: string): ToolContext =>
  ({
    userId: 'user-1',
    assistantId: 'assistant-1',
    sessionId: 'session-1',
    appId: 'Use Brian',
    channelType: 'web',
    channelId: 'channel-1',
    ...(workspaceId ? { workspaceId } : {}),
  }) as ToolContext

function makeStore(overrides: Partial<GoalDefaultBudgetStorePort> = {}): GoalDefaultBudgetStorePort {
  return {
    get: vi.fn(async () => ({
      budget: { maxIterations: 30, maxSpend: 5 },
      source: 'built_in' as const,
    })),
    set: vi.fn(async (_userId, _workspaceId, patch) => ({
      ok: true as const,
      budget: {
        maxIterations: patch.maxIterations ?? 30,
        maxSpend: patch.maxSpend ?? 5,
      },
      source: patch.reset ? ('built_in' as const) : ('workspace' as const),
    })),
    ...overrides,
  }
}

describe('[COMP:goals/default-budget] configureGoalDefaultBudget', () => {
  it('reads the effective default with no arguments', async () => {
    const store = makeStore()
    const tool = createGoalDefaultBudgetTools(store).configureGoalDefaultBudget

    const result = await tool.execute({}, context('workspace-1'))

    expect(store.get).toHaveBeenCalledWith('workspace-1')
    expect(store.set).not.toHaveBeenCalled()
    expect(result.data).toMatchObject({
      budget: { maxIterations: 30, maxSpend: 5 },
      source: 'built_in',
    })
  })

  it('partially updates the workspace override', async () => {
    const store = makeStore()
    const tool = createGoalDefaultBudgetTools(store).configureGoalDefaultBudget

    const result = await tool.execute({ max_iterations: 12 }, context('workspace-1'))

    expect(store.set).toHaveBeenCalledWith('user-1', 'workspace-1', {
      maxIterations: 12,
      maxSpend: undefined,
      reset: undefined,
    })
    expect(result.data).toMatchObject({
      budget: { maxIterations: 12, maxSpend: 5 },
      source: 'workspace',
    })
  })

  it('resets to the built-in fallback', async () => {
    const store = makeStore()
    const tool = createGoalDefaultBudgetTools(store).configureGoalDefaultBudget

    const result = await tool.execute({ reset: true }, context('workspace-1'))

    expect(store.set).toHaveBeenCalledWith('user-1', 'workspace-1', {
      maxIterations: undefined,
      maxSpend: undefined,
      reset: true,
    })
    expect(result.data).toMatchObject({ source: 'built_in' })
  })

  it('surfaces the owner/admin authority gate', async () => {
    const store = makeStore({
      set: vi.fn(async () => ({
        ok: false as const,
        reason: 'not_admin' as const,
        message: 'Only a workspace owner or admin can change the default goal budget.',
      })),
    })
    const tool = createGoalDefaultBudgetTools(store).configureGoalDefaultBudget

    const result = await tool.execute({ max_spend: 10 }, context('workspace-1'))

    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('owner or admin')
    expect(String(result.data)).toContain('will keep failing')
  })

  it('fails honestly outside a workspace-scoped chat', async () => {
    const store = makeStore()
    const tool = createGoalDefaultBudgetTools(store).configureGoalDefaultBudget

    const result = await tool.execute({}, context())

    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('workspace-scoped chat')
    expect(store.get).not.toHaveBeenCalled()
  })
})
