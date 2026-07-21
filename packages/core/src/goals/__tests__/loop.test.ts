import { describe, it, expect } from 'vitest'
import { processGoalIteration, type ActingLoopDeps, type IterationOutcome, type LoopState } from '../loop.js'
import type { GoalRecord, GoalResume, GoalStatus } from '../index.js'

const NOW = '2026-06-30T12:00:00.000Z'

function goal(over: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id: 'g1',
    workspaceId: 'w1',
    parentGoalId: null,
    recipeId: null,
    host: { type: 'task', id: 't1' },
    outcome: 'ship it',
    doneWhen: { kind: 'subtasks' },
    means: { workflowId: 'wf-iter' }, // acting by default
    budget: {},
    policy: {},
    status: 'active',
    blockerReason: null,
    createdByUserId: null,
    confirmedAt: null,
    completionClaim: null,
    brief: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  }
}

type Log = {
  ran: boolean
  statuses: GoalStatus[]
  finished: { terminal: string; reason: string | null } | null
  rearmed: GoalResume | null
}

function harness(opts: { metering?: boolean; met?: boolean; outcome?: IterationOutcome }) {
  const log: Log = { ran: false, statuses: [], finished: null, rearmed: null }
  const deps: ActingLoopDeps = {
    meteringAvailable: () => opts.metering ?? true,
    runIteration: async () => {
      log.ran = true
      return opts.outcome ?? { progressed: true, spend: 1 }
    },
    resolversFor: () => ({
      subtasksClosed: async () => opts.met ?? false,
      query: async () => false,
      tool: async () => false,
    }),
    setStatus: async (_id, status) => {
      log.statuses.push(status)
    },
    finish: async (_g, terminal, reason) => {
      log.finished = { terminal, reason }
    },
    rearm: async (_g, resume) => {
      log.rearmed = resume
    },
  }
  return { deps, log }
}

const STATE: LoopState = { iteration: 0, spend: 0, noProgressStreak: 0 }

describe('[COMP:goals/loop] acting loop', () => {
  it('BARRIER: blocks pre-iteration when metering is unavailable — never runs', async () => {
    const { deps, log } = harness({ metering: false })
    const d = await processGoalIteration(goal(), STATE, NOW, deps)
    expect(d).toEqual({ decision: 'blocked', reason: 'metering_unavailable' })
    expect(log.ran).toBe(false) // did not spend a single untracked dollar
    expect(log.finished).toEqual({ terminal: 'blocked', reason: 'metering_unavailable' })
  })

  it('a monitor goal (no means) is exempt from the metering barrier and never runs an iteration', async () => {
    const { deps, log } = harness({ metering: false, met: false })
    const d = await processGoalIteration(goal({ means: {} }), STATE, NOW, deps)
    expect(d.decision).toBe('continue') // not blocked by metering — it doesn't act
    expect(log.ran).toBe(false) // monitor: no iteration ran
    expect(log.finished).toBeNull()
  })

  it('done_when met -> finish done', async () => {
    const { deps, log } = harness({ met: true })
    const d = await processGoalIteration(goal(), STATE, NOW, deps)
    expect(d).toEqual({ decision: 'done' })
    expect(log.ran).toBe(true)
    expect(log.finished).toEqual({ terminal: 'done', reason: null })
    expect(log.rearmed).toBeNull()
  })

  it('progress, not yet met -> running then active, re-arm now', async () => {
    const { deps, log } = harness({ met: false, outcome: { progressed: true, spend: 1 } })
    const d = await processGoalIteration(goal(), STATE, NOW, deps)
    expect(d).toEqual({ decision: 'continue', resume: { kind: 'now' } })
    expect(log.statuses).toEqual(['running', 'active'])
    expect(log.rearmed).toEqual({ kind: 'now' })
    expect(log.finished).toBeNull()
  })

  it('no progress, not met -> re-arm after backoff', async () => {
    const { deps, log } = harness({ met: false, outcome: { progressed: false, spend: 1 } })
    const d = await processGoalIteration(goal(), STATE, NOW, deps)
    expect(d).toEqual({ decision: 'continue', resume: { kind: 'after', seconds: 120 } })
    expect(log.rearmed).toEqual({ kind: 'after', seconds: 120 })
  })

  it('over budget (maxIterations) -> finish blocked with reason', async () => {
    const { deps, log } = harness({ met: false, outcome: { progressed: true, spend: 1 } })
    const d = await processGoalIteration(goal({ budget: { maxIterations: 1 } }), STATE, NOW, deps)
    expect(d).toEqual({ decision: 'blocked', reason: 'max_iterations' })
    expect(log.finished).toEqual({ terminal: 'blocked', reason: 'max_iterations' })
    expect(log.rearmed).toBeNull()
  })
})
