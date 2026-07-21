import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import pg from 'pg'
import { randomUUID } from 'node:crypto'
import {
  createWorkflowEventDispatcher,
  type DispatchEvent,
  type EventSubscription,
} from '@use-brian/core'
import { createGoalDriver, type GoalDriverDeps, type GoalLoopState } from '../driver.js'
import { createGoalWorkTools } from '../work-tools.js'

/**
 * Integration test for the goals `until:event` park → dispatch → resume cycle
 * (task-goal-seeker.md §4.11; mig 293). Requires a local PostgreSQL `Use Brian`
 * with the goals migrations applied. Skips silently when the DB is unavailable.
 *
 * Exercises the REAL store (`awaiting_event` read/write/clear + the finder), the
 * REAL `waitForEvent` tool, the REAL acting-loop driver, and the REAL workflow
 * event dispatcher wired as the second subscriber — only the workflow run itself
 * is faked (the agent "parks" by calling `waitForEvent` mid-iteration, mirroring
 * boot's `dispatchRun` reading the marker back).
 *
 * [COMP:workflow/goal-seeker]
 */

let pool: pg.Pool | undefined

async function canConnect(): Promise<boolean> {
  const p = new pg.Pool({ database: 'sidanclaw', connectionTimeoutMillis: 2000 })
  try {
    const client = await p.connect()
    try {
      await client.query('SELECT awaiting_event FROM goals LIMIT 1')
    } finally {
      client.release()
    }
    pool = p
    return true
  } catch {
    await p.end().catch(() => {})
    return false
  }
}

const ok = await canConnect()
const describeIf = ok ? describe : describe.skip

afterAll(async () => {
  if (pool) await pool.end()
})

async function makeUser(client: pg.PoolClient): Promise<string> {
  const r = await client.query(
    `INSERT INTO users (id, auth_provider, auth_provider_id)
     VALUES (gen_random_uuid(), 'test', 'goals-evt-' || gen_random_uuid()) RETURNING id`,
  )
  return r.rows[0].id
}
async function makeWorkspace(client: pg.PoolClient, ownerId: string): Promise<string> {
  const r = await client.query(
    `INSERT INTO workspaces (id, name, purpose, owner_user_id, is_personal)
     VALUES (gen_random_uuid(), 'goals-evt-ws', 'test', $1, false) RETURNING id`,
    [ownerId],
  )
  return r.rows[0].id
}
async function addMember(client: pg.PoolClient, workspaceId: string, userId: string): Promise<void> {
  await client.query(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role)
     VALUES (gen_random_uuid(), $1, $2, 'owner')`,
    [workspaceId, userId],
  )
}

const NOW = new Date('2026-07-01T12:00:00.000Z')
const SUB: EventSubscription = {
  source: { type: 'channel', channelIntegrationId: 'ci1', channel: 'slack' },
}

describeIf('[COMP:workflow/goal-seeker] until:event park → dispatch → resume (integration)', () => {
  let goals: typeof import('../../db/goals.js')
  let goalStoreMod: typeof import('../../db/goals-store.js')
  beforeAll(async () => {
    process.env.DATABASE_URL ??= 'postgres:///sidanclaw'
    goals = await import('../../db/goals.js')
    goalStoreMod = await import('../../db/goals-store.js')
  })

  let userId: string
  let workspaceId: string
  beforeEach(async () => {
    const c = await pool!.connect()
    try {
      userId = await makeUser(c)
      workspaceId = await makeWorkspace(c, userId)
      await addMember(c, workspaceId, userId)
    } finally {
      c.release()
    }
  })

  /** A driver wired to the real store, a recording `scheduleGoalTick`, and a fake
   *  `dispatchRun` whose agent parks the goal on `SUB` via the real waitForEvent
   *  tool — then the dispatcher resumes it. */
  function wire() {
    const ticks: Array<{ goalId: string; fireAt: Date; state: GoalLoopState }> = []
    const delivered: Array<{ terminal: string; reason: string | null }> = []

    const { waitForEvent } = createGoalWorkTools({
      createCompletionWorkflow: async () => '',
      kickoffGoal: async () => {},
    })

    const deps: GoalDriverDeps = {
      goalStore: goalStoreMod.createDbGoalStore(),
      tryClaim: goals.tryClaimGoalForTick,
      sessionCostUsd: async () => 0,
      meteringAvailable: () => true,
      dispatchRun: async ({ goal }) => {
        // The agent, mid-iteration, parks the goal on an external event (the real
        // tool writes `{ subscriptions: [SUB] }`).
        await waitForEvent.execute({ goal_id: goal.id, event: SUB }, { workspaceId, userId } as never)
        // Mirror boot: read the marker back to surface the park to the driver.
        const parked = await goals.getGoalAwaitingEventSystem(goal.id)
        return {
          runId: `run-${goal.id}`,
          terminal: true,
          completed: true,
          eventSubscriptions: parked?.subscriptions ?? null,
        }
      },
      deliver: async (_g, terminal, reason) => {
        delivered.push({ terminal, reason })
      },
      scheduleGoalTick: async (goal, fireAt, state) => {
        ticks.push({ goalId: goal.id, fireAt, state })
      },
      getAwaitingEvent: async (goalId) => {
        const m = await goals.getGoalAwaitingEventSystem(goalId)
        return m ? { subscriptions: m.subscriptions, state: m.state as GoalLoopState | undefined } : null
      },
      setAwaitingEvent: (goalId, marker) => goals.setGoalAwaitingEventSystem(goalId, marker),
      clearAwaitingEvent: (goalId) => goals.clearGoalAwaitingEventSystem(goalId),
      now: () => NOW,
    }
    const driver = createGoalDriver(deps)
    const dispatcher = createWorkflowEventDispatcher({
      findEventTriggeredWorkflows: async () => [],
      startWorkflowRun: async () => {},
      findEventWaitingGoals: async ({ workspaceId: ws }) => {
        const rows = await goals.findEventWaitingGoalsSystem(ws)
        return rows.map((r) => ({ goalId: r.goalId, workspaceId: ws, sources: r.subscriptions }))
      },
      resumeEventWaitingGoal: ({ goalId }) => driver.resumeOnEvent(goalId),
    })
    return { driver, dispatcher, ticks, delivered }
  }

  it('parks on waitForEvent, ignores a non-matching event, and resumes on a matching one (state preserved)', async () => {
    const { driver, dispatcher, ticks, delivered } = wire()

    // A confirmed, acting goal (workflow means). `verify` done_when is never met
    // here (no completion_claim) → the iteration continues, so the park drives.
    const goal = await goals.createGoal({
      workspaceId,
      outcome: 'Get the contract signed by the customer',
      doneWhen: { kind: 'verify' },
      means: { workflowId: randomUUID() },
      createdByUserId: userId,
    })

    // ── 1. Drive a tick → the agent parks the goal on SUB ──
    await driver.tickGoal(goal.id, { iteration: 0, spend: 0, noProgressStreak: 0, runId: null })

    // Durable marker holds BOTH the subscriptions and the loop-state handoff.
    const parked = await goals.getGoalAwaitingEventSystem(goal.id)
    expect(parked?.subscriptions).toEqual([SUB])
    expect(parked?.state).toEqual({ iteration: 1, spend: 0, noProgressStreak: 0, runId: null })

    // Continue (not terminal): status active, the re-arm is the FAR safety net
    // (now + 1h), NOT the 60s paused-run poll, and nothing was delivered.
    expect((await goals.getGoalByIdSystem(goal.id))?.status).toBe('active')
    expect(ticks).toHaveLength(1)
    expect(ticks[0].fireAt.getTime()).toBe(NOW.getTime() + 3600_000)
    expect(delivered).toHaveLength(0)

    // The finder surfaces it as an event-waiting goal for the dispatcher.
    const waiting = await goals.findEventWaitingGoalsSystem(workspaceId)
    expect(waiting).toEqual([{ goalId: goal.id, subscriptions: [SUB] }])

    // ── 2. A NON-matching event (different channel) → still parked ──
    const nonMatching: DispatchEvent = {
      workspaceId,
      source: { type: 'channel', channelIntegrationId: 'ci-OTHER', channel: 'slack' },
      text: 'unrelated chatter',
      actorId: null,
      channelId: null,
      mentions: [],
      isBot: false,
      payload: {},
    }
    await dispatcher.dispatch(nonMatching)
    expect(await goals.getGoalAwaitingEventSystem(goal.id)).not.toBeNull() // still parked
    expect(ticks).toHaveLength(1) // no resume tick scheduled

    // ── 3. A MATCHING event → resumed ──
    const matching: DispatchEvent = {
      workspaceId,
      source: { type: 'channel', channelIntegrationId: 'ci1', channel: 'slack' },
      text: 'the customer approved and signed',
      actorId: 'U123',
      channelId: 'C1',
      mentions: [],
      isBot: false,
      payload: { messageId: 'm1' },
    }
    await dispatcher.dispatch(matching)

    // Marker cleared (out of the waiting set) + an immediate tick scheduled
    // carrying the PRESERVED loop state (budget counters survived the wait).
    expect(await goals.getGoalAwaitingEventSystem(goal.id)).toBeNull()
    expect(ticks).toHaveLength(2)
    expect(ticks[1].goalId).toBe(goal.id)
    expect(ticks[1].fireAt.getTime()).toBe(NOW.getTime()) // immediate
    expect(ticks[1].state).toEqual({ iteration: 1, spend: 0, noProgressStreak: 0, runId: null })
  })

  it('findEventWaitingGoalsSystem excludes terminal goals and other workspaces', async () => {
    // A parked-but-DONE goal must not be resumable; a parked goal in another
    // workspace must not leak into this workspace's finder.
    const live = await goals.createGoal({
      workspaceId,
      outcome: 'live',
      doneWhen: { kind: 'verify' },
      means: { workflowId: randomUUID() },
      createdByUserId: userId,
    })
    await goals.setGoalAwaitingEventSystem(live.id, { subscriptions: [SUB] })

    const doneGoal = await goals.createGoal({
      workspaceId,
      outcome: 'already done',
      doneWhen: { kind: 'verify' },
      means: { workflowId: randomUUID() },
      createdByUserId: userId,
    })
    await goals.setGoalAwaitingEventSystem(doneGoal.id, { subscriptions: [SUB] })
    await goals.setGoalStatusSystem(doneGoal.id, 'done')

    const found = await goals.findEventWaitingGoalsSystem(workspaceId)
    expect(found).toEqual([{ goalId: live.id, subscriptions: [SUB] }])
  })

  it('clearGoalAwaitingEventSystem is single-shot (returns true once, then false)', async () => {
    const goal = await goals.createGoal({
      workspaceId,
      outcome: 'x',
      doneWhen: { kind: 'verify' },
      means: { workflowId: randomUUID() },
      createdByUserId: userId,
    })
    await goals.setGoalAwaitingEventSystem(goal.id, { subscriptions: [SUB] })
    expect(await goals.clearGoalAwaitingEventSystem(goal.id)).toBe(true)
    expect(await goals.clearGoalAwaitingEventSystem(goal.id)).toBe(false)
    expect(await goals.getGoalAwaitingEventSystem(goal.id)).toBeNull()
  })
})
