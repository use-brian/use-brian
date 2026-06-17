import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPollWorker, isSessionResumeJob, type JobExecutor, type SessionResumeHandler } from '../poll-worker.js'
import type { JobStore, ScheduledJob } from '../types.js'

function makeFakeJobStore(dueJobs: ScheduledJob[] = []): JobStore & {
  updates: Array<{ id: string; updates: unknown }>
  completedCalls: string[]
  failedCalls: string[]
} {
  const updates: Array<{ id: string; updates: unknown }> = []
  const completedCalls: string[] = []
  const failedCalls: string[] = []
  const jobs = [...dueJobs]
  return {
    updates,
    completedCalls,
    failedCalls,
    async create(params) {
      const job: ScheduledJob = {
        id: `j_${jobs.length + 1}`,
        enabled: true,
        lastRunAt: null,
        lastStatus: null,
        ...params,
        mode: params.mode ?? ('local' as const),
        silentUntilFire: params.silentUntilFire ?? false,
        nagIntervalMins: params.nagIntervalMins ?? null,
        nagUntilKeyword: params.nagUntilKeyword ?? null,
        state: {},
        workflowId: params.workflowId ?? null,
        workflowStepRunId: params.workflowStepRunId ?? null,
        viewId: params.viewId ?? null,
      }
      jobs.push(job)
      return job
    },
    async update(id, u) {
      updates.push({ id, updates: u })
      const job = jobs.find((j) => j.id === id)
      if (!job) return null
      Object.assign(job, u)
      return job
    },
    async delete() { return true },
    async get(id) { return jobs.find((j) => j.id === id) ?? null },
    async list() { return jobs },
    async listEnabledByView(userId, viewId) {
      return jobs.filter((j) => j.userId === userId && j.viewId === viewId && j.enabled)
    },
    async getDueJobs() {
      return jobs.filter((j) => j.enabled)
    },
    async markCompleted(id) { completedCalls.push(id) },
    async markFailed(id) { failedCalls.push(id) },
    async setState(id, state) {
      const job = jobs.find((j) => j.id === id)
      if (job) job.state = state
    },
    async listActiveNagsForUser(userId) {
      return jobs.filter((j) => j.userId === userId && j.state.activeNag != null)
    },
    async purgeDisabledOlderThan(_cutoff) { return 0 },
    async countEnabledRecurring(_userId) { return 0 },
    async search() { return { jobs: [], nextCursor: null } },
    async listTriggerJobsForWorkflowSystem() { return [] },
    async listFiringJobsForWorkflowSystem() { return [] },
  }
}

function makeJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    id: 'job_1',
    assistantId: 'a1',
    userId: 'u1',
    schedule: { type: 'daily', time: '09:00' },
    timezone: 'UTC',
    mode: 'local',
    instructions: 'Run daily',
    channelType: 'telegram',
    channelId: 'chat_1',
    enabled: true,
    nextRunAt: new Date(),
    lastRunAt: null,
    lastStatus: null,
    silentUntilFire: false,
    nagIntervalMins: null,
    nagUntilKeyword: null,
    state: {},
    workflowId: null,
    workflowStepRunId: null,
    viewId: null,
    ...overrides,
  }
}

describe('[COMP:scheduling/poll-worker] createPollWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('start() runs a tick immediately', async () => {
    const job = makeJob()
    const store = makeFakeJobStore([job])
    const executor = vi.fn<JobExecutor>(async () => 'ok')
    const worker = createPollWorker({ store, executor, intervalMs: 60_000 })

    worker.start()
    // Let the immediate tick resolve
    await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(1))
    worker.stop()
  })

  it('marks a successful recurring job as completed and schedules next run', async () => {
    const job = makeJob({ schedule: { type: 'daily', time: '09:00' } })
    const store = makeFakeJobStore([job])
    const executor = vi.fn<JobExecutor>(async () => 'ok')
    const worker = createPollWorker({ store, executor, intervalMs: 60_000 })

    worker.start()
    await vi.waitFor(() => expect(store.completedCalls).toContain('job_1'))
    expect(store.failedCalls).toHaveLength(0)
    worker.stop()
  })

  it('marks a failed recurring job as failed but keeps it enabled for retry', async () => {
    const job = makeJob()
    const store = makeFakeJobStore([job])
    const executor = vi.fn<JobExecutor>(async () => { throw new Error('boom') })
    const worker = createPollWorker({ store, executor, intervalMs: 60_000 })

    worker.start()
    await vi.waitFor(() => expect(store.failedCalls).toContain('job_1'))
    // Recurring jobs stay enabled
    expect(store.updates.some((u) => u.id === 'job_1' && (u.updates as { enabled?: boolean }).enabled === false)).toBe(false)
    worker.stop()
  })

  it('disables a one-time job after it runs (success)', async () => {
    const future = new Date(Date.now() + 1000).toISOString()
    const job = makeJob({
      schedule: { type: 'once', datetime: future },
    })
    const store = makeFakeJobStore([job])
    const executor = vi.fn<JobExecutor>(async () => 'ok')
    const worker = createPollWorker({ store, executor, intervalMs: 60_000 })

    worker.start()
    await vi.waitFor(() => {
      expect(store.updates.some((u) => u.id === 'job_1' && (u.updates as { enabled?: boolean }).enabled === false)).toBe(true)
    })
    worker.stop()
  })

  it('disables a one-time job after it fails too', async () => {
    const future = new Date(Date.now() + 1000).toISOString()
    const job = makeJob({
      schedule: { type: 'once', datetime: future },
    })
    const store = makeFakeJobStore([job])
    const executor = vi.fn<JobExecutor>(async () => { throw new Error('oops') })
    const worker = createPollWorker({ store, executor, intervalMs: 60_000 })

    worker.start()
    await vi.waitFor(() => expect(store.failedCalls).toContain('job_1'))
    expect(store.updates.some((u) => u.id === 'job_1' && (u.updates as { enabled?: boolean }).enabled === false)).toBe(true)
    worker.stop()
  })

  it('is not running after stop()', async () => {
    const worker = createPollWorker({ store: makeFakeJobStore(), executor: async () => '' })
    expect(worker.isRunning).toBe(false)
    worker.start()
    expect(worker.isRunning).toBe(true)
    worker.stop()
    expect(worker.isRunning).toBe(false)
  })

  // ── Auto-disable backstop (moat-workflow runaway, 2026-06) ──────────────

  it('auto-disables a recurring job after N consecutive failures and fires the hook', async () => {
    const job = makeJob() // recurring daily
    const store = makeFakeJobStore([job])
    const executor = vi.fn<JobExecutor>(async () => { throw new Error('boom') })
    const onJobAutoDisabled = vi.fn()
    const worker = createPollWorker({
      store, executor, maxConsecutiveFailures: 3, onJobAutoDisabled, intervalMs: 60_000,
    })

    worker.start()
    await vi.advanceTimersByTimeAsync(0)       // tick 1 (immediate) — fail → 1
    await vi.advanceTimersByTimeAsync(60_000)  // tick 2 — fail → 2
    await vi.advanceTimersByTimeAsync(60_000)  // tick 3 — fail → 3 → disable
    await vi.advanceTimersByTimeAsync(60_000)  // tick 4 — job now disabled → no-op
    worker.stop()

    // Executor stopped firing once the job was disabled at the threshold.
    expect(executor).toHaveBeenCalledTimes(3)
    expect(store.updates.some(
      (u) => u.id === 'job_1' && (u.updates as { enabled?: boolean }).enabled === false,
    )).toBe(true)
    expect(onJobAutoDisabled).toHaveBeenCalledTimes(1)
    expect(onJobAutoDisabled.mock.calls[0][1]).toBe(3) // failure count passed to hook
    expect(job.state.consecutiveFailures).toBe(3)
  })

  it('resets the failure streak after a success (no disable, no clobber)', async () => {
    let calls = 0
    const job = makeJob()
    const store = makeFakeJobStore([job])
    const executor = vi.fn<JobExecutor>(async () => {
      calls++
      if (calls <= 2) throw new Error('transient')
      return 'ok'
    })
    const worker = createPollWorker({ store, executor, maxConsecutiveFailures: 5, intervalMs: 60_000 })

    worker.start()
    await vi.advanceTimersByTimeAsync(0)       // tick 1 — fail → 1
    await vi.advanceTimersByTimeAsync(60_000)  // tick 2 — fail → 2
    await vi.advanceTimersByTimeAsync(60_000)  // tick 3 — success → reset
    worker.stop()

    expect(store.completedCalls).toContain('job_1')
    expect(job.state.consecutiveFailures).toBeUndefined()
    expect(store.updates.some(
      (u) => u.id === 'job_1' && (u.updates as { enabled?: boolean }).enabled === false,
    )).toBe(false)
  })

  it('preserves other state_json keys (activeNag) when bumping the streak', async () => {
    const activeNag = { openedAt: '2026-06-09T00:00:00Z', cycleDate: '2026-06-09' }
    const job = makeJob({ state: { activeNag } })
    const store = makeFakeJobStore([job])
    const executor = vi.fn<JobExecutor>(async () => { throw new Error('boom') })
    const worker = createPollWorker({ store, executor, maxConsecutiveFailures: 10, intervalMs: 60_000 })

    worker.start()
    await vi.advanceTimersByTimeAsync(0) // tick 1 — fail → 1
    worker.stop()

    expect(job.state.activeNag).toEqual(activeNag)
    expect(job.state.consecutiveFailures).toBe(1)
  })

  it('maxConsecutiveFailures=Infinity restores legacy retry-forever behavior', async () => {
    const job = makeJob()
    const store = makeFakeJobStore([job])
    const executor = vi.fn<JobExecutor>(async () => { throw new Error('boom') })
    const worker = createPollWorker({
      store, executor, maxConsecutiveFailures: Infinity, intervalMs: 60_000,
    })

    worker.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    worker.stop()

    expect(store.updates.some(
      (u) => u.id === 'job_1' && (u.updates as { enabled?: boolean }).enabled === false,
    )).toBe(false)
    expect(job.state.consecutiveFailures).toBe(3)
  })
})

// ─────────────────────────────────────────────────────────────────────
// Path B durable chat resume — `state.triggerKind='session_resume'`
// dispatch branch (WU-6.4, Q22 RESOLVED).
//
// These tests simulate the Cloud Run restart-loss case the
// session_resume_points table covers: a paused chat turn whose in-memory
// promise is gone, an approval that has since been resolved, and a
// scheduled-jobs row that the resolution endpoint enqueued to drive the
// resume worker. We don't exercise the full resume replay (that lives in
// chat.ts/runSessionResume and is tested separately) — only the dispatch
// contract this file owns.
// ─────────────────────────────────────────────────────────────────────

function makeResumeJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return makeJob({
    id: 'resume_job_1',
    schedule: { type: 'once', datetime: new Date(Date.now() + 1000).toISOString() },
    instructions: '__session_resume__',
    state: {
      triggerKind: 'session_resume',
      resume: {
        sessionId: 'session-uuid-1',
        approvalId: 'approval-uuid-1',
      },
    },
    ...overrides,
  })
}

describe('[COMP:brain/session-resume-worker] poll worker dispatch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('isSessionResumeJob recognizes the trigger marker', () => {
    expect(isSessionResumeJob(makeResumeJob())).toBe(true)
    expect(isSessionResumeJob(makeJob())).toBe(false)
    expect(isSessionResumeJob(makeJob({ state: { activeNag: { openedAt: 'x', cycleDate: 'y' } } }))).toBe(false)
  })

  it('routes a session_resume job to the injected resumeHandler instead of the executor', async () => {
    const job = makeResumeJob()
    const store = makeFakeJobStore([job])
    const executor = vi.fn<JobExecutor>(async () => 'should-not-fire')
    const resumeHandler = vi.fn<SessionResumeHandler>(async () => {})
    const worker = createPollWorker({ store, executor, resumeHandler, intervalMs: 60_000 })

    worker.start()
    await vi.waitFor(() => expect(resumeHandler).toHaveBeenCalledTimes(1))
    expect(executor).not.toHaveBeenCalled()
    const handledJob = resumeHandler.mock.calls[0][0]
    expect(handledJob.id).toBe('resume_job_1')
    expect(handledJob.state.resume).toEqual({
      sessionId: 'session-uuid-1',
      approvalId: 'approval-uuid-1',
    })
    worker.stop()
  })

  it('on successful resume, disables the job and marks completed (one-shot semantics)', async () => {
    const job = makeResumeJob()
    const store = makeFakeJobStore([job])
    const executor = vi.fn<JobExecutor>(async () => 'unused')
    const resumeHandler = vi.fn<SessionResumeHandler>(async () => {})
    const worker = createPollWorker({ store, executor, resumeHandler, intervalMs: 60_000 })

    worker.start()
    await vi.waitFor(() => {
      expect(store.completedCalls).toContain('resume_job_1')
      expect(store.updates.some(
        (u) => u.id === 'resume_job_1' && (u.updates as { enabled?: boolean }).enabled === false,
      )).toBe(true)
    })
    expect(store.failedCalls).toHaveLength(0)
    worker.stop()
  })

  it('on resumeHandler throw, marks failed and disables (does not re-fire)', async () => {
    const job = makeResumeJob()
    const store = makeFakeJobStore([job])
    const executor = vi.fn<JobExecutor>(async () => 'unused')
    const resumeHandler = vi.fn<SessionResumeHandler>(async () => {
      throw new Error('replay blew up')
    })
    const worker = createPollWorker({ store, executor, resumeHandler, intervalMs: 60_000 })

    worker.start()
    await vi.waitFor(() => {
      expect(store.failedCalls).toContain('resume_job_1')
      expect(store.updates.some(
        (u) => u.id === 'resume_job_1' && (u.updates as { enabled?: boolean }).enabled === false,
      )).toBe(true)
    })
    expect(store.completedCalls).toHaveLength(0)
    worker.stop()
  })

  it('without a resumeHandler, the job is failed-and-disabled (does NOT fall through to executor)', async () => {
    // Regression guard: if a resume sentinel ever got handed to the
    // standard executor, it would mis-fire as a fresh user-channel turn
    // carrying the placeholder `__session_resume__` instructions. The
    // dispatch must short-circuit instead.
    const job = makeResumeJob()
    const store = makeFakeJobStore([job])
    const executor = vi.fn<JobExecutor>(async () => 'must-not-run')
    const worker = createPollWorker({ store, executor, intervalMs: 60_000 })

    worker.start()
    await vi.waitFor(() => {
      expect(store.failedCalls).toContain('resume_job_1')
      expect(store.updates.some(
        (u) => u.id === 'resume_job_1' && (u.updates as { enabled?: boolean }).enabled === false,
      )).toBe(true)
    })
    expect(executor).not.toHaveBeenCalled()
    worker.stop()
  })

  it('non-resume jobs in the same tick still go to the standard executor', async () => {
    const resumeJob = makeResumeJob({ id: 'resume_a' })
    const normalJob = makeJob({ id: 'normal_b' })
    const store = makeFakeJobStore([resumeJob, normalJob])
    const executor = vi.fn<JobExecutor>(async () => 'ok')
    const resumeHandler = vi.fn<SessionResumeHandler>(async () => {})
    const worker = createPollWorker({ store, executor, resumeHandler, intervalMs: 60_000 })

    worker.start()
    await vi.waitFor(() => {
      expect(resumeHandler).toHaveBeenCalledTimes(1)
      expect(executor).toHaveBeenCalledTimes(1)
    })
    expect(resumeHandler.mock.calls[0][0].id).toBe('resume_a')
    expect(executor.mock.calls[0][0].id).toBe('normal_b')
    worker.stop()
  })
})
