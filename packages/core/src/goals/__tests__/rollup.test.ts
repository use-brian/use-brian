import { describe, it, expect } from 'vitest'
import { rollupHost, type RollupDeps } from '../rollup.js'
import type { DoneWhenResolvers } from '../done-when.js'
import type { GoalRecord, GoalStatus } from '../types.js'

function goal(over: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id: 'g1',
    workspaceId: 'w1',
    parentGoalId: null,
    recipeId: null,
    host: { type: 'task', id: 't1' },
    outcome: 'ship it',
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
    ...over,
  }
}

function resolvers(subtasksClosed: boolean): DoneWhenResolvers {
  return {
    subtasksClosed: async () => subtasksClosed,
    query: async () => false,
    tool: async () => false,
  }
}

describe('[COMP:goals/rollup] structural rollup', () => {
  it('completes an active goal whose done_when is met', async () => {
    const completed: string[] = []
    const deps: RollupDeps = {
      goalsForHost: async () => [goal({ id: 'g1' })],
      resolversFor: () => resolvers(true),
      complete: async (g) => {
        completed.push(g.id)
      },
    }
    const out = await rollupHost({ type: 'task', id: 't1' }, deps)
    expect(out).toEqual([{ goalId: 'g1', met: true }])
    expect(completed).toEqual(['g1'])
  })

  it('leaves an active goal whose done_when is not met', async () => {
    const completed: string[] = []
    const deps: RollupDeps = {
      goalsForHost: async () => [goal({ id: 'g1' })],
      resolversFor: () => resolvers(false),
      complete: async (g) => {
        completed.push(g.id)
      },
    }
    const out = await rollupHost({ type: 'task', id: 't1' }, deps)
    expect(out).toEqual([{ goalId: 'g1', met: false }])
    expect(completed).toEqual([])
  })

  it('skips running / blocked / terminal goals (single-flight, §8)', async () => {
    const completed: string[] = []
    const statuses: GoalStatus[] = ['running', 'blocked', 'done', 'abandoned', 'awaiting_approval']
    const deps: RollupDeps = {
      goalsForHost: async () => statuses.map((status, i) => goal({ id: `g${i}`, status })),
      resolversFor: () => resolvers(true), // would be "met" — but none are active
      complete: async (g) => {
        completed.push(g.id)
      },
    }
    const out = await rollupHost({ type: 'task', id: 't1' }, deps)
    expect(out).toEqual([])
    expect(completed).toEqual([])
  })

  it('handles multiple active goals independently', async () => {
    const completed: string[] = []
    const deps: RollupDeps = {
      goalsForHost: async () => [goal({ id: 'a' }), goal({ id: 'b' })],
      resolversFor: (g) => resolvers(g.id === 'a'),
      complete: async (g) => {
        completed.push(g.id)
      },
    }
    const out = await rollupHost({ type: 'task', id: 't1' }, deps)
    expect(out).toEqual([
      { goalId: 'a', met: true },
      { goalId: 'b', met: false },
    ])
    expect(completed).toEqual(['a'])
  })
})
