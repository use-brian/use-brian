import { describe, it, expect, vi } from 'vitest'
import type { GoalRecord, GoalStore } from '@sidanclaw/core'
import { createGoalDriver, type DispatchRunResult, type GoalDriverDeps, type GoalLoopState } from '../driver.js'

/**
 * [COMP:workflow/goal-seeker] The acting-loop driver tick.
 *
 * Self-hosted goals (host null, `subtasks` done_when over the sub-goal count)
 * keep these unit tests DB-free: `buildGoalResolvers` reads `countOpenSubGoals`
 * and `finishGoal` skips the host write-back, so no host adapter / DB is hit.
 */

const NOW = new Date('2026-06-30T12:00:00.000Z')

function makeGoal(over: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id: 'g1',
    workspaceId: 'w1',
    parentGoalId: null,
    recipeId: null,
    host: null, // self-hosted → DB-free resolvers/write-back
    outcome: 'ship it',
    doneWhen: { kind: 'subtasks' },
    means: { workflowId: 'wf1' }, // acting
    budget: {},
    policy: {},
    status: 'active',
    blockerReason: null,
    createdByUserId: 'u1',
    confirmedAt: new Date(0), // confirmed → the acting loop may run it
    completionClaim: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  }
}

type Harness = {
  statuses: Array<{ status: string; reason: string | null }>
  delivered: Array<{ terminal: string; reason: string | null }>
  ticks: Array<{ fireAt: Date; state: GoalLoopState }>
  dispatch: ReturnType<typeof vi.fn>
}

function makeDriver(opts: {
  goal?: GoalRecord | null
  openSubGoals?: number
  claim?: boolean
  metering?: boolean
  workspaceBudgetOk?: boolean
  dispatch?: DispatchRunResult
  runSpend?: number
  overrides?: Partial<GoalDriverDeps>
}) {
  const h: Harness = { statuses: [], delivered: [], ticks: [], dispatch: vi.fn() }
  let openSubGoals = opts.openSubGoals ?? 1

  const goalStore = {
    getByIdSystem: async () => (opts.goal === undefined ? makeGoal() : opts.goal),
    setStatusSystem: async (_id: string, status: string, reason: string | null = null) => {
      h.statuses.push({ status, reason })
      return null
    },
    countOpenSubGoalsSystem: async () => openSubGoals,
    // unused by the driver
    create: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(),
    listByHostSystem: vi.fn(),
  } as unknown as GoalStore

  h.dispatch.mockResolvedValue(
    opts.dispatch ?? { runId: 'r1', terminal: true, completed: true },
  )

  const deps: GoalDriverDeps = {
    goalStore,
    tryClaim: async () => opts.claim ?? true,
    sessionCostUsd: async () => opts.runSpend ?? 0,
    meteringAvailable: () => opts.metering ?? true,
    workspaceBudgetOk: opts.workspaceBudgetOk === undefined ? undefined : async () => opts.workspaceBudgetOk!,
    dispatchRun: h.dispatch,
    deliver: async (_g, terminal, reason) => {
      h.delivered.push({ terminal, reason })
    },
    scheduleGoalTick: async (_g, fireAt, state) => {
      h.ticks.push({ fireAt, state })
    },
    now: () => NOW,
    ...opts.overrides,
  }
  return { driver: createGoalDriver(deps), h, setOpenSubGoals: (n: number) => (openSubGoals = n) }
}

describe('[COMP:workflow/goal-seeker] goal driver tick', () => {
  it('completes the goal when done_when holds after the iteration (no re-arm)', async () => {
    const { driver, h } = makeDriver({ openSubGoals: 0, dispatch: { runId: 'r1', terminal: true, completed: true } })
    await driver.tickGoal('g1')
    expect(h.dispatch).toHaveBeenCalledOnce()
    expect(h.statuses.at(-1)).toEqual({ status: 'done', reason: null })
    expect(h.delivered).toEqual([{ terminal: 'done', reason: null }])
    expect(h.ticks).toHaveLength(0) // terminal → no re-arm
  })

  it('re-arms NOW when the run made progress but done_when is not yet met', async () => {
    const { driver, h } = makeDriver({ openSubGoals: 1, dispatch: { runId: 'r1', terminal: true, completed: true } })
    await driver.tickGoal('g1', { iteration: 0, spend: 0, noProgressStreak: 0, runId: null })
    expect(h.statuses.at(-1)).toEqual({ status: 'active', reason: null }) // continue → active
    expect(h.ticks).toHaveLength(1)
    expect(h.ticks[0].fireAt).toEqual(NOW) // now
    expect(h.ticks[0].state).toEqual({ iteration: 1, spend: 0, noProgressStreak: 0, runId: null })
    expect(h.delivered).toHaveLength(0)
  })

  it('re-arms with BACKOFF when the run failed (no progress)', async () => {
    const { driver, h } = makeDriver({ openSubGoals: 1, dispatch: { runId: 'r1', terminal: true, completed: false } })
    await driver.tickGoal('g1', { iteration: 0, spend: 0, noProgressStreak: 0, runId: null })
    expect(h.ticks).toHaveLength(1)
    expect(h.ticks[0].fireAt.getTime()).toBeGreaterThan(NOW.getTime()) // backoff, not now
    expect(h.ticks[0].state.noProgressStreak).toBe(1)
    expect(h.ticks[0].state.runId).toBeNull() // terminal run → fresh next time
  })

  it('advances the in-flight run (paused) next tick rather than stacking a new one', async () => {
    const { driver, h } = makeDriver({ openSubGoals: 1, dispatch: { runId: 'r1', terminal: false, completed: false } })
    await driver.tickGoal('g1', { iteration: 0, spend: 0, noProgressStreak: 0, runId: 'r1' })
    // dispatchRun was asked to advance the carried run id, not start fresh.
    expect(h.dispatch).toHaveBeenCalledWith({ goal: expect.objectContaining({ id: 'g1' }), runId: 'r1' })
    expect(h.ticks).toHaveLength(1)
    expect(h.ticks[0].fireAt.getTime()).toBe(NOW.getTime() + 60_000) // until:event poll cadence
    expect(h.ticks[0].state.runId).toBe('r1') // keep advancing the same run
  })

  it('accumulates spend across the handoff and blocks when maxSpend is exhausted', async () => {
    const { driver, h } = makeDriver({
      openSubGoals: 1,
      runSpend: 0.6,
      goal: makeGoal({ budget: { maxSpend: 1 } }),
    })
    // Prior spend 0.5 + this run 0.6 = 1.1 >= maxSpend 1 → blocked.
    await driver.tickGoal('g1', { iteration: 3, spend: 0.5, noProgressStreak: 0, runId: null })
    expect(h.statuses.at(-1)).toEqual({ status: 'blocked', reason: 'max_spend' })
    expect(h.delivered).toEqual([{ terminal: 'blocked', reason: 'max_spend' }])
    expect(h.ticks).toHaveLength(0)
  })

  it('blocks an acting goal when metering is unavailable, WITHOUT running a costly iteration', async () => {
    const { driver, h } = makeDriver({ metering: false })
    await driver.tickGoal('g1')
    expect(h.dispatch).not.toHaveBeenCalled() // never ran cost-blind
    expect(h.statuses.at(-1)).toEqual({ status: 'blocked', reason: 'metering_unavailable' })
    expect(h.delivered).toEqual([{ terminal: 'blocked', reason: 'metering_unavailable' }])
  })

  it('blocks an unconfirmed goal and asks for clarification, without running work — autopilot enforcement', async () => {
    const { driver, h } = makeDriver({ goal: makeGoal({ confirmedAt: null }) })
    await driver.tickGoal('g1')
    expect(h.dispatch).not.toHaveBeenCalled() // never starts autonomous work on an unconfirmed goal
    expect(h.statuses.at(-1)).toEqual({ status: 'blocked', reason: 'unconfirmed_needs_clarification' })
    expect(h.delivered).toEqual([{ terminal: 'blocked', reason: 'unconfirmed_needs_clarification' }])
  })

  it('is single-flight: a lost claim returns without dispatching', async () => {
    const { driver, h } = makeDriver({ claim: false })
    await driver.tickGoal('g1')
    expect(h.dispatch).not.toHaveBeenCalled()
    expect(h.statuses).toHaveLength(0)
  })

  it('blocks when the workspace is over its budget (no iteration)', async () => {
    const { driver, h } = makeDriver({ metering: true, workspaceBudgetOk: false })
    await driver.tickGoal('g1')
    expect(h.dispatch).not.toHaveBeenCalled()
    expect(h.statuses.at(-1)).toEqual({ status: 'blocked', reason: 'workspace_over_budget' })
  })

  it('kickoff arms the first tick for an acting goal, and skips a no-means monitor goal', async () => {
    const acting = makeDriver({ goal: makeGoal({ means: { workflowId: 'wf1' } }) })
    await acting.driver.kickoffGoal('g1')
    expect(acting.h.ticks).toHaveLength(1)
    expect(acting.h.ticks[0].state).toEqual({ iteration: 0, spend: 0, noProgressStreak: 0, runId: null })

    const monitor = makeDriver({ goal: makeGoal({ means: {} }) })
    await monitor.driver.kickoffGoal('g1')
    expect(monitor.h.ticks).toHaveLength(0) // no workflowId → rollup's job, not the loop's
  })
})
