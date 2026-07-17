import { describe, it, expect, vi } from 'vitest'
import type { JobStore, ScheduledJob } from '@use-brian/core'
import { createJobExecutor } from '../executor.js'

/**
 * Post Phase-2 cutover the scheduled-job executor is a thin
 * trigger-orchestration layer: it owns the nag lifecycle (open / roll
 * `activeNag`, advance the parent's own `next_run_at` by `nagIntervalMins`
 * while a cycle is open) and delegates execution to `runWorkflowFromJob`.
 *
 * Post nag-chain collapse (2026-05) the parent re-fires itself runtime-
 * only — no per-tick `once` follow-up rows. The "parent gate" + chain
 * scheduling that used to live here are gone; the test surface flipped
 * accordingly. See docs/architecture/engine/scheduled-jobs.md
 * → "Active-nag lifecycle".
 */

/** Minimal `JobStore` fake — only the methods the runner touches are live. */
function makeJobStore(overrides: Partial<JobStore> = {}): JobStore {
  return {
    get: vi.fn().mockResolvedValue(null),
    create: vi.fn().mockResolvedValue({ id: 'follow_1' }),
    update: vi.fn().mockResolvedValue(null),
    setState: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn(),
    list: vi.fn(),
    getDueJobs: vi.fn(),
    markCompleted: vi.fn(),
    markFailed: vi.fn(),
    listActiveNagsForUser: vi.fn(),
    purgeDisabledOlderThan: vi.fn().mockResolvedValue(0),
    countEnabledRecurring: vi.fn().mockResolvedValue(0),
    ...overrides,
  } as unknown as JobStore
}

const baseJob: ScheduledJob = {
  id: 'job_1',
  assistantId: 'a_1',
  userId: 'u_1',
  schedule: { type: 'cron', expression: '0 9 * * *' },
  timezone: 'Asia/Hong_Kong',
  mode: 'local',
  instructions: 'Check the weather',
  channelType: 'telegram',
  channelId: 'chat_123',
  enabled: true,
  nextRunAt: new Date(),
  lastRunAt: null,
  lastStatus: null,
  silentUntilFire: false,
  nagIntervalMins: null,
  nagUntilKeyword: null,
  state: {},
  workflowId: 'wf_1',
  workflowStepRunId: null,
  viewId: null,
}

describe('[COMP:scheduling/trigger-orchestration] Trigger-orchestration runner', () => {
  it('delegates a workflow-backed job to runWorkflowFromJob and returns its result', async () => {
    const runWorkflowFromJob = vi.fn().mockResolvedValue('workflow scheduled trigger: completed')
    const executor = createJobExecutor({ jobStore: makeJobStore(), runWorkflowFromJob })

    const result = await executor(baseJob)

    expect(runWorkflowFromJob).toHaveBeenCalledWith(baseJob)
    expect(result).toBe('workflow scheduled trigger: completed')
  })

  it('emits scheduled_job.started then scheduled_job.completed on success', async () => {
    const logEvent = vi.fn()
    const executor = createJobExecutor({
      jobStore: makeJobStore(),
      analytics: { logEvent } as never,
      runWorkflowFromJob: vi.fn().mockResolvedValue('ok'),
    })

    await executor(baseJob)

    const names = logEvent.mock.calls.map((c) => c[0].eventName)
    expect(names).toEqual(['scheduled_job.started', 'scheduled_job.completed'])
    expect(logEvent.mock.calls[0][0]).toMatchObject({
      userId: 'u_1',
      assistantId: 'a_1',
      metadata: { schedule_type: 'cron', mode: 'local' },
    })
    expect(typeof logEvent.mock.calls[1][0].metadata.duration_ms).toBe('number')
  })

  it('emits scheduled_job.failed and re-throws when runWorkflowFromJob throws', async () => {
    const logEvent = vi.fn()
    const executor = createJobExecutor({
      jobStore: makeJobStore(),
      analytics: { logEvent } as never,
      runWorkflowFromJob: vi.fn().mockRejectedValue(new Error('advance exploded')),
    })

    await expect(executor(baseJob)).rejects.toThrow('advance exploded')

    const events = logEvent.mock.calls.map((c) => c[0])
    expect(events.find((e) => e.eventName === 'scheduled_job.failed')).toBeDefined()
    expect(events.find((e) => e.eventName === 'scheduled_job.completed')).toBeUndefined()
  })

  it('fails loudly (no delegation) when a job carries no workflow_id', async () => {
    const runWorkflowFromJob = vi.fn()
    const executor = createJobExecutor({ jobStore: makeJobStore(), runWorkflowFromJob })

    const result = await executor({ ...baseJob, workflowId: null })

    expect(result).toContain('post-cutover invariant violation')
    expect(runWorkflowFromJob).not.toHaveBeenCalled()
  })

  it('delegates a goal-tick job (no workflow_id, exempted) instead of failing the invariant', async () => {
    // Regression for the 2026-07-13 autopilot stall: a goal tick carries no
    // workflow_id by design (the goal's means.workflowId drives each
    // iteration). The `isDelegateHandledWithoutWorkflow` exemption must let it
    // reach the delegate rather than dying at the straggler invariant.
    const logEvent = vi.fn()
    const runWorkflowFromJob = vi.fn().mockResolvedValue('goal tick: g_1')
    const executor = createJobExecutor({
      jobStore: makeJobStore(),
      analytics: { logEvent } as never,
      runWorkflowFromJob,
      isDelegateHandledWithoutWorkflow: (job) => {
        try {
          return (JSON.parse(job.instructions) as { kind?: string }).kind === 'goal_tick'
        } catch {
          return false
        }
      },
    })

    const goalTickJob: ScheduledJob = {
      ...baseJob,
      workflowId: null,
      schedule: { type: 'once', datetime: '2026-07-13T16:22:58' },
      instructions: JSON.stringify({ kind: 'goal_tick', goalId: 'g_1' }),
      channelType: 'workflow',
      channelId: 'g_1',
    }
    const result = await executor(goalTickJob)

    expect(runWorkflowFromJob).toHaveBeenCalledWith(goalTickJob)
    expect(result).toBe('goal tick: g_1')
    // It ran the delegate to completion — no invariant failure was emitted.
    const failed = logEvent.mock.calls.find(([e]) => e?.eventName === 'scheduled_job.failed')
    expect(failed).toBeUndefined()
  })

  it('still fails loudly for a no-workflow_id straggler the exemption rejects', async () => {
    // The exemption is narrow: a row that is NOT a goal tick still trips the
    // invariant, preserving the loud-fail for genuine pre-migration stragglers.
    const runWorkflowFromJob = vi.fn()
    const executor = createJobExecutor({
      jobStore: makeJobStore(),
      runWorkflowFromJob,
      isDelegateHandledWithoutWorkflow: () => false,
    })

    const result = await executor({ ...baseJob, workflowId: null, instructions: 'Check the weather' })

    expect(result).toContain('post-cutover invariant violation')
    expect(runWorkflowFromJob).not.toHaveBeenCalled()
  })

  it('opens activeNag on a nag-enabled parent and advances its own next_run_at by nagIntervalMins (no follow-up row)', async () => {
    const jobStore = makeJobStore()
    const executor = createJobExecutor({
      jobStore,
      runWorkflowFromJob: vi.fn().mockResolvedValue('ok'),
    })

    const parentJob: ScheduledJob = {
      ...baseJob,
      nagIntervalMins: 15,
      nagUntilKeyword: 'done',
    }
    const before = Date.now()
    await executor(parentJob)
    const after = Date.now()

    // activeNag opened on the parent.
    expect(jobStore.setState).toHaveBeenCalledWith(
      'job_1',
      expect.objectContaining({
        activeNag: expect.objectContaining({
          cycleDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        }),
      }),
    )

    // Parent's own next_run_at advanced by nagIntervalMins. No new `once`
    // follow-up row is created — the chain is now runtime-only state on
    // the parent.
    expect(jobStore.create).not.toHaveBeenCalled()
    const updateCalls = vi.mocked(jobStore.update).mock.calls.filter(
      ([id, fields]) => id === 'job_1' && (fields as { nextRunAt?: Date }).nextRunAt instanceof Date,
    )
    expect(updateCalls.length).toBe(1)
    const written = (updateCalls[0][1] as { nextRunAt: Date }).nextRunAt
    expect(written.getTime()).toBeGreaterThanOrEqual(before + 15 * 60_000 - 200)
    expect(written.getTime()).toBeLessThanOrEqual(after + 15 * 60_000 + 200)
  })

  it('does not open activeNag or advance next_run_at for a single-fire job (no nagIntervalMins)', async () => {
    const jobStore = makeJobStore()
    const executor = createJobExecutor({
      jobStore,
      runWorkflowFromJob: vi.fn().mockResolvedValue('ok'),
    })

    await executor(baseJob) // baseJob has nagIntervalMins: null

    expect(jobStore.setState).not.toHaveBeenCalled()
    expect(jobStore.update).not.toHaveBeenCalled()
    expect(jobStore.create).not.toHaveBeenCalled()
  })
})
