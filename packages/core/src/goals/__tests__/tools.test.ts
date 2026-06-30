import { describe, it, expect, vi } from 'vitest'
import { createGoalTools } from '../tools.js'
import type { GoalRecord, GoalStore } from '../types.js'

function fakeStore(over: Partial<GoalStore> = {}): GoalStore {
  const rec = (id: string, outcome: string): GoalRecord => ({
    id,
    workspaceId: 'w1',
    parentGoalId: null,
    recipeId: null,
    host: null,
    outcome,
    doneWhen: { kind: 'subtasks' },
    means: {},
    budget: {},
    policy: {},
    status: 'active',
    blockerReason: null,
    createdByUserId: null,
    confirmedAt: null,
    completionClaim: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  })
  return {
    create: async (p) => ({ ...rec('g1', p.outcome), host: p.host ?? null, doneWhen: p.doneWhen, means: p.means ?? {}, budget: p.budget ?? {} }),
    getById: async () => null,
    getByIdSystem: async () => null,
    list: async () => [rec('g1', 'ship it')],
    listByHostSystem: async () => [],
    setStatusSystem: async () => null,
    countOpenSubGoalsSystem: async () => 0,
    ...over,
  }
}

const CTX = { workspaceId: 'w1', userId: 'u1', assistantId: 'a1', sessionId: 's1', channelType: 'web' }
type Ctx = Parameters<ReturnType<typeof createGoalTools>['setGoal']['execute']>[1]

describe('[COMP:goals/tools] goal chat tools', () => {
  it('setGoal creates a self-hosted goal and emits goal_created', async () => {
    const create = vi.fn(fakeStore().create)
    const onEvent = vi.fn()
    const { setGoal } = createGoalTools(fakeStore({ create }), { onEvent })
    const res = await setGoal.execute(
      { outcome: 'ship it', done_when: { kind: 'subtasks' } },
      CTX as Ctx,
    )
    expect(res.isError).toBeFalsy()
    expect(res.data).toContain('Set goal [g1]')
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'w1', outcome: 'ship it', host: null, createdByUserId: 'u1' }),
    )
    expect(onEvent).toHaveBeenCalledWith({ type: 'goal_created', goalId: 'g1' }, expect.objectContaining({ userId: 'u1' }))
  })

  it('setGoal binds a host + workflow means when given', async () => {
    const create = vi.fn(fakeStore().create)
    const { setGoal } = createGoalTools(fakeStore({ create }))
    await setGoal.execute(
      {
        outcome: 'close deal',
        done_when: { kind: 'query', query: { predicate: { stage: 'closed-won' } } },
        host_type: 'entity',
        host_id: '00000000-0000-0000-0000-0000000000aa',
        workflow_id: '00000000-0000-0000-0000-0000000000bb',
      },
      CTX as Ctx,
    )
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        host: { type: 'entity', id: '00000000-0000-0000-0000-0000000000aa' },
        means: { workflowId: '00000000-0000-0000-0000-0000000000bb' },
      }),
    )
  })

  it('setGoal threads max_spend / max_iterations / deadline into the budget', async () => {
    const create = vi.fn(fakeStore().create)
    const { setGoal } = createGoalTools(fakeStore({ create }))
    await setGoal.execute(
      { outcome: 'close acme', done_when: { kind: 'subtasks' }, max_spend: 5, max_iterations: 20 },
      CTX as Ctx,
    )
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        budget: expect.objectContaining({ maxSpend: 5, maxIterations: 20 }),
      }),
    )
  })

  it('setGoal rejects a half-specified host', async () => {
    const { setGoal } = createGoalTools(fakeStore())
    const res = await setGoal.execute(
      { outcome: 'x', done_when: { kind: 'subtasks' }, host_type: 'task' },
      CTX as Ctx,
    )
    expect(res.isError).toBe(true)
    expect(res.data).toMatch(/together/)
  })

  it('setGoal errors without a workspace', async () => {
    const { setGoal } = createGoalTools(fakeStore())
    const res = await setGoal.execute(
      { outcome: 'x', done_when: { kind: 'subtasks' } },
      { ...CTX, workspaceId: undefined } as Ctx,
    )
    expect(res.isError).toBe(true)
  })

  it('listGoals threads filters to the store', async () => {
    const list = vi.fn(fakeStore().list)
    const { listGoals } = createGoalTools(fakeStore({ list }))
    const res = await listGoals.execute({ status: 'blocked', include_terminal: true }, CTX as Ctx)
    expect(list).toHaveBeenCalledWith('u1', 'w1', expect.objectContaining({ status: 'blocked', includeTerminal: true }))
    expect(res.data).toContain('ship it')
  })
})
