import { describe, it, expect, vi } from 'vitest'
import type { EventSubscription, GoalRecord, GoalStore } from '@use-brian/core'
import {
  createGoalDriver,
  DEFAULT_GOAL_BUDGET,
  type DispatchRunResult,
  type GoalAwaitingEvent,
  type GoalDriverDeps,
  type GoalLoopState,
} from '../driver.js'

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

const SUB: EventSubscription = {
  source: { type: 'channel', channelIntegrationId: 'ci1', channel: 'slack' },
}

type Harness = {
  statuses: Array<{ status: string; reason: string | null }>
  delivered: Array<{ terminal: string; reason: string | null }>
  ticks: Array<{ fireAt: Date; state: GoalLoopState }>
  dispatch: ReturnType<typeof vi.fn>
  /** In-memory `goals.awaiting_event` marker store (the until:event park). */
  awaiting: Map<string, GoalAwaitingEvent>
}

function makeDriver(opts: {
  goal?: GoalRecord | null
  openSubGoals?: number
  claim?: boolean
  metering?: boolean
  workspaceBudgetOk?: boolean
  dispatch?: DispatchRunResult
  runSpend?: number
  /** Seed the event-park marker (the resume / clear-after-claim paths). */
  awaitingSeed?: Record<string, GoalAwaitingEvent>
  overrides?: Partial<GoalDriverDeps>
}) {
  const h: Harness = {
    statuses: [],
    delivered: [],
    ticks: [],
    dispatch: vi.fn(),
    awaiting: new Map(Object.entries(opts.awaitingSeed ?? {})),
  }
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
    getAwaitingEvent: async (goalId) => h.awaiting.get(goalId) ?? null,
    setAwaitingEvent: async (goalId, marker) => {
      h.awaiting.set(goalId, marker)
    },
    clearAwaitingEvent: async (goalId) => h.awaiting.delete(goalId),
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
    expect(h.ticks[0].state).toEqual({ iteration: 1, spend: 0, noProgressStreak: 0, runId: null, errorStreak: 0 })
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

  it('blocks when the workspace is over its budget (no iteration), and escalates', async () => {
    const { driver, h } = makeDriver({ metering: true, workspaceBudgetOk: false })
    await driver.tickGoal('g1')
    expect(h.dispatch).not.toHaveBeenCalled() // never ran a costly iteration over-cap
    expect(h.statuses.at(-1)).toEqual({ status: 'blocked', reason: 'workspace_over_budget' })
    // No silent termination (§7): the over-budget block is delivered.
    expect(h.delivered).toEqual([{ terminal: 'blocked', reason: 'workspace_over_budget' }])
    expect(h.ticks).toHaveLength(0) // blocked → no re-arm
  })

  it('runs the iteration when the workspace is UNDER its budget', async () => {
    const { driver, h } = makeDriver({
      metering: true,
      workspaceBudgetOk: true,
      openSubGoals: 0,
      dispatch: { runId: 'r1', terminal: true, completed: true },
    })
    await driver.tickGoal('g1')
    expect(h.dispatch).toHaveBeenCalledOnce() // gate passed → the loop ran
    expect(h.statuses.at(-1)).toEqual({ status: 'done', reason: null })
  })

  it('skips the workspace-budget gate entirely when no gate is wired (OSS)', async () => {
    // workspaceBudgetOk omitted → the driver never cap-checks; the loop runs.
    const { driver, h } = makeDriver({ metering: true, openSubGoals: 0 })
    await driver.tickGoal('g1')
    expect(h.dispatch).toHaveBeenCalledOnce()
    expect(h.statuses.at(-1)).toEqual({ status: 'done', reason: null })
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

  // ── until:event external park (mig 293) ──────────────────────────────────

  it('parks on an EXTERNAL event: persists the full marker (subscriptions + state) and arms a far safety-net tick, not the 60s poll', async () => {
    const { driver, h } = makeDriver({
      openSubGoals: 1, // done_when not met → continue
      dispatch: { runId: 'r1', terminal: true, completed: true, eventSubscriptions: [SUB] },
    })
    await driver.tickGoal('g1', { iteration: 0, spend: 0, noProgressStreak: 0, runId: null })

    // Marker persisted with BOTH the subscriptions (for the dispatcher) and the
    // loop state (so the budget counters survive the wait).
    const marker = h.awaiting.get('g1')
    expect(marker?.subscriptions).toEqual([SUB])
    expect(marker?.state).toEqual({ iteration: 1, spend: 0, noProgressStreak: 0, runId: null, errorStreak: 0 })

    // Status active (continue), and the re-arm is the FAR safety net (now + 1h),
    // NOT the 60s paused-run poll.
    expect(h.statuses.at(-1)).toEqual({ status: 'active', reason: null })
    expect(h.ticks).toHaveLength(1)
    expect(h.ticks[0].fireAt.getTime()).toBe(NOW.getTime() + 3600_000)
    expect(h.delivered).toHaveLength(0)
  })

  it('uses the goal deadline as the safety-net fire time when one is set', async () => {
    const deadline = '2026-07-15T00:00:00.000Z'
    const { driver, h } = makeDriver({
      openSubGoals: 1,
      goal: makeGoal({ budget: { deadline } }),
      dispatch: { runId: 'r1', terminal: true, completed: true, eventSubscriptions: [SUB] },
    })
    await driver.tickGoal('g1', { iteration: 0, spend: 0, noProgressStreak: 0, runId: null })
    expect(h.ticks).toHaveLength(1)
    expect(h.ticks[0].fireAt.toISOString()).toBe(deadline)
  })

  it('distinguishes a paused run (60s poll, no marker) from an event park (safety tick + marker)', async () => {
    // Paused run → {runId} awaitingEvent → 60s poll, and NO durable marker written.
    const paused = makeDriver({ openSubGoals: 1, dispatch: { runId: 'r1', terminal: false, completed: false } })
    await paused.driver.tickGoal('g1', { iteration: 0, spend: 0, noProgressStreak: 0, runId: 'r1' })
    expect(paused.h.ticks[0].fireAt.getTime()).toBe(NOW.getTime() + 60_000)
    expect(paused.h.awaiting.has('g1')).toBe(false) // paused-run park is in-memory only
  })

  it('clears a stale event-park marker after claiming the tick (the goal is acting now)', async () => {
    // A goal whose safety net fired (its event never came): the marker is still
    // set on entry; the claim drops it, the iteration completes the goal.
    const seed = { subscriptions: [SUB], state: { iteration: 2, spend: 0.1, noProgressStreak: 0, runId: null } }
    const { driver, h } = makeDriver({
      openSubGoals: 0, // done_when met → done
      awaitingSeed: { g1: seed },
      dispatch: { runId: 'r2', terminal: true, completed: true },
    })
    await driver.tickGoal('g1', seed.state)
    expect(h.awaiting.has('g1')).toBe(false) // stale marker dropped at claim time
    expect(h.statuses.at(-1)).toEqual({ status: 'done', reason: null })
  })

  it('resumeOnEvent clears the marker and schedules an immediate tick restoring the preserved loop state', async () => {
    const state: GoalLoopState = { iteration: 5, spend: 2.5, noProgressStreak: 1, runId: null }
    const { driver, h } = makeDriver({ awaitingSeed: { g1: { subscriptions: [SUB], state } } })

    await driver.resumeOnEvent('g1')

    expect(h.awaiting.has('g1')).toBe(false) // marker cleared (out of the waiting set)
    expect(h.ticks).toHaveLength(1)
    expect(h.ticks[0].fireAt).toEqual(NOW) // immediate
    expect(h.ticks[0].state).toEqual(state) // budget counters preserved across the wait
    expect(h.dispatch).not.toHaveBeenCalled() // resume only SCHEDULES the tick
  })

  it('resumeOnEvent is a no-op when the goal already un-parked (marker gone) — concurrent events resume once', async () => {
    const { driver, h } = makeDriver({ awaitingSeed: {} }) // no marker
    await driver.resumeOnEvent('g1')
    expect(h.ticks).toHaveLength(0) // nothing scheduled — a concurrent tick already owns it
  })
})

describe('[COMP:goals/tick-resilience] tick error resilience + default budget', () => {
  const boom = new Error('provider exploded')

  it('an errored tick releases the claim (active) and re-arms with backoff carrying errorStreak — never a dead chain', async () => {
    const { driver, h } = makeDriver({
      overrides: { dispatchRun: async () => { throw boom } },
    })
    await expect(driver.tickGoal('g1', { iteration: 2, spend: 0.3, noProgressStreak: 1, runId: null })).resolves.toBeUndefined()
    // Claim released — the goal is claimable again, never wedged in `running`.
    expect(h.statuses.at(-1)).toEqual({ status: 'active', reason: null })
    // Re-armed on the error backoff (streak 1 → 60s), iteration/spend/streak carried unchanged.
    expect(h.ticks).toHaveLength(1)
    expect(h.ticks[0].fireAt.getTime()).toBe(NOW.getTime() + 60_000)
    expect(h.ticks[0].state).toEqual({ iteration: 2, spend: 0.3, noProgressStreak: 1, runId: null, errorStreak: 1 })
    expect(h.delivered).toHaveLength(0) // not terminal — no message
  })

  it('backoff doubles with the carried errorStreak (capped at 15 min)', async () => {
    const { driver, h } = makeDriver({ overrides: { dispatchRun: async () => { throw boom } } })
    await driver.tickGoal('g1', { iteration: 0, spend: 0, noProgressStreak: 0, runId: null, errorStreak: 2 })
    // streak 3 → 60 * 2^2 = 240s
    expect(h.ticks[0].fireAt.getTime()).toBe(NOW.getTime() + 240_000)
    expect(h.ticks[0].state.errorStreak).toBe(3)
  })

  it('gives up LOUDLY at the consecutive-error ceiling: blocked (tick_error) + delivered, no re-arm', async () => {
    const { driver, h } = makeDriver({ overrides: { dispatchRun: async () => { throw boom } } })
    await driver.tickGoal('g1', { iteration: 9, spend: 1, noProgressStreak: 4, runId: null, errorStreak: 4 })
    expect(h.statuses.at(-1)?.status).toBe('blocked')
    expect(h.statuses.at(-1)?.reason).toMatch(/^tick_error: provider exploded/)
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0].terminal).toBe('blocked')
    expect(h.ticks).toHaveLength(0)
  })

  it('fires onTickError with willRetry on both paths', async () => {
    const seen: Array<{ willRetry: boolean }> = []
    const overrides = {
      dispatchRun: async () => { throw boom },
      onTickError: (_g: GoalRecord, _e: unknown, willRetry: boolean) => { seen.push({ willRetry }) },
    }
    const retry = makeDriver({ overrides })
    await retry.driver.tickGoal('g1')
    const giveUp = makeDriver({ overrides })
    await giveUp.driver.tickGoal('g1', { iteration: 0, spend: 0, noProgressStreak: 0, runId: null, errorStreak: 4 })
    expect(seen).toEqual([{ willRetry: true }, { willRetry: false }])
  })

  it('a completed iteration resets the carried errorStreak to 0', async () => {
    const { driver, h } = makeDriver({ openSubGoals: 1, dispatch: { runId: 'r1', terminal: true, completed: true } })
    await driver.tickGoal('g1', { iteration: 0, spend: 0, noProgressStreak: 0, runId: null, errorStreak: 3 })
    expect(h.ticks[0].state.errorStreak).toBe(0)
  })

  it('rethrows the ORIGINAL error when the recovery itself fails (the reaper is the backstop)', async () => {
    const { driver } = makeDriver({
      overrides: {
        dispatchRun: async () => { throw boom },
        scheduleGoalTick: async () => { throw new Error('db down') },
      },
    })
    await expect(driver.tickGoal('g1')).rejects.toBe(boom)
  })

  it('kickoff applies DEFAULT_GOAL_BUDGET to a budget-less acting goal, and leaves an authored budget alone', async () => {
    const applied: Array<{ goalId: string; budget: unknown }> = []
    const budgeted = makeGoal({ budget: {}, outcome: 'defaulted' })
    const bare = makeDriver({
      goal: budgeted,
      overrides: {
        applyDefaultBudget: async (goalId, budget) => {
          applied.push({ goalId, budget })
          return { ...budgeted, budget }
        },
      },
    })
    await bare.driver.kickoffGoal('g1')
    expect(applied).toEqual([{ goalId: 'g1', budget: DEFAULT_GOAL_BUDGET }])
    expect(bare.h.ticks).toHaveLength(1)

    const authored = makeDriver({
      goal: makeGoal({ budget: { maxSpend: 2 } }),
      overrides: { applyDefaultBudget: async () => { throw new Error('must not be called') } },
    })
    await authored.driver.kickoffGoal('g1')
    expect(authored.h.ticks).toHaveLength(1) // armed without touching the budget
  })
})
