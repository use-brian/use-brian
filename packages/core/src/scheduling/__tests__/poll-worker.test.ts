import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPollWorker, isSessionResumeJob, type JobExecutor, type SessionResumeHandler } from '../poll-worker.js'
import type { JobStore, ScheduledJob } from '../types.js'
import { backgroundLaneStats, configureBackgroundLane, runInBackgroundLane } from '../background-lane.js'

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


describe('pinned schedule dispatch claims', () => {
  it('claims just before each sequential dispatch, even after an earlier job takes over ten minutes', async () => {
    vi.useFakeTimers()
    const first = makeJob({ id: 'first',requiresScheduleClaim: true }), second = makeJob({ id: 'second',requiresScheduleClaim: true,schedule: { type: 'once',datetime: '2099-01-01T00:00:00Z' } })
    const store = makeFakeJobStore([first,second])
    const claimedAt: number[] = []
    store.claimDueJob = vi.fn(async id => { claimedAt.push(Date.now()); return { ...(id === 'first' ? first : second),scheduleClaimId: `${id}-claim` } })
    store.finishScheduleClaim = vi.fn(async () => ({ applied: true,disabled: false,failures: 0 }))
    const executor = vi.fn(async job => { if (job.id === 'first') vi.setSystemTime(Date.now()+11*60_000); return 'ok' })
    const worker = createPollWorker({ store,executor })
    try {
      worker.start()
      await vi.waitFor(() => expect(store.finishScheduleClaim).toHaveBeenCalledTimes(2))
      expect(claimedAt[1]-claimedAt[0]).toBeGreaterThanOrEqual(11*60_000)
      expect(store.finishScheduleClaim).toHaveBeenLastCalledWith('second','second-claim',expect.objectContaining({ success: true,nextRunAt: new Date(0) }))
      expect(executor).toHaveBeenCalledTimes(2)
      expect(store.completedCalls).toEqual([])
      expect(store.failedCalls).toEqual([])
      expect(store.updates).toEqual([])
    } finally { worker.stop();vi.useRealTimers() }
  })
  it.each(['workflow_schedule_claim_unavailable','workflow_schedule_authority_unavailable'])('does not disable or count %s as a failed one-shot', async code => {
    const job = makeJob({ requiresScheduleClaim: true,schedule: { type: 'once',datetime: '2099-01-01T00:00:00Z' } })
    const store = makeFakeJobStore([job])
    store.claimDueJob = vi.fn(async () => ({ ...job,scheduleClaimId: 'claim' }))
    store.finishScheduleClaim = vi.fn(async () => ({ applied: false,disabled: false,failures: 0 }))
    const executor = vi.fn(async () => { throw Object.assign(new Error(code),{ code }) })
    const worker = createPollWorker({ store,executor })
    try {
      worker.start()
      await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(1))
      expect(store.finishScheduleClaim).not.toHaveBeenCalled()
      expect(store.failedCalls).toEqual([])
      expect(store.updates).toEqual([])
    } finally { worker.stop() }
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('[COMP:scheduling/poll-worker] stop and restart admission', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it.each(['discovery', 'claim'] as const)('stops a queued background-lane %s before its database call', async boundary => {
    const previousLimit = backgroundLaneStats().limit
    expect(backgroundLaneStats().inFlight).toBe(0)
    configureBackgroundLane({ limit: 1 })
    const job = makeJob({ requiresScheduleClaim: true }), store = makeFakeJobStore([job])
    const entered = deferred<void>(), release = deferred<void>()
    let blocker: Promise<void> | undefined
    const holdLane = () => { blocker = runInBackgroundLane(async () => { entered.resolve(); await release.promise }) }
    store.getDueJobs = vi.fn(async () => {
      if (boundary === 'claim') holdLane()
      return [job]
    })
    store.claimDueJob = vi.fn(async () => ({ ...job, scheduleClaimId: 'claim' }))
    store.finishScheduleClaim = vi.fn(async () => ({ applied: true, disabled: false, failures: 0 }))
    const executor = vi.fn(async () => 'ok'), worker = createPollWorker({ store, executor })
    try {
      if (boundary === 'discovery') holdLane()
      worker.start(); await entered.promise; await vi.advanceTimersByTimeAsync(0)
      expect(backgroundLaneStats().queued).toBe(1)
      worker.stop(); release.resolve(); await blocker; await vi.advanceTimersByTimeAsync(0)
      if (boundary === 'discovery') expect(store.getDueJobs).not.toHaveBeenCalled()
      expect(store.claimDueJob).not.toHaveBeenCalled()
      expect(executor).not.toHaveBeenCalled()
      expect(backgroundLaneStats()).toMatchObject({ inFlight: 0, queued: 0 })
    } finally {
      worker.stop(); release.resolve(); await blocker; await vi.advanceTimersByTimeAsync(0)
      configureBackgroundLane({ limit: previousLimit })
    }
  })

  it.each(['executor', 'resume'] as const)('stops %s dispatch after a delayed due-list read', async kind => {
    const job = kind === 'resume' ? makeResumeJob() : makeJob()
    const store = makeFakeJobStore([job]), entered = deferred<void>(), release = deferred<void>()
    store.getDueJobs = vi.fn(async () => { entered.resolve(); await release.promise; return [job] })
    const executor = vi.fn(async () => 'ok'), resumeHandler = vi.fn(async () => {})
    const worker = createPollWorker({ store, executor, resumeHandler })
    try {
      worker.start(); await entered.promise; worker.stop(); release.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(executor).not.toHaveBeenCalled()
      expect(resumeHandler).not.toHaveBeenCalled()
      expect(store.completedCalls).toEqual([])
      expect(store.failedCalls).toEqual([])
      expect(store.updates).toEqual([])
    } finally { release.resolve(); worker.stop() }
  })

  it('leaves a stopped native claim unconsumed without dispatch or outcome writes', async () => {
    const job = makeJob({ requiresScheduleClaim: true }), store = makeFakeJobStore([job])
    const entered = deferred<void>(), release = deferred<void>()
    store.claimDueJob = vi.fn(async () => { entered.resolve(); await release.promise; return { ...job, scheduleClaimId: 'old-claim' } })
    store.finishScheduleClaim = vi.fn(async () => ({ applied: true, disabled: false, failures: 0 }))
    const executor = vi.fn(async () => 'ok'), worker = createPollWorker({ store, executor })
    try {
      worker.start(); await entered.promise; worker.stop(); release.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(executor).not.toHaveBeenCalled()
      expect(store.finishScheduleClaim).not.toHaveBeenCalled()
    } finally { release.resolve(); worker.stop() }
  })

  it.each(['native', 'legacy', 'resume'] as const)('finishes dispatched %s bookkeeping but stops the next candidate', async kind => {
    const job = kind === 'resume' ? makeResumeJob() : makeJob({ requiresScheduleClaim: kind === 'native' })
    const second = makeJob({ id: 'next-job', requiresScheduleClaim: kind === 'native' })
    const store = makeFakeJobStore([job, second]), entered = deferred<void>(), release = deferred<void>()
    store.claimDueJob = vi.fn(async id => ({ ...(id === job.id ? job : second), scheduleClaimId: id + '-claim' }))
    store.finishScheduleClaim = vi.fn(async () => ({ applied: true, disabled: false, failures: 0 }))
    const executor = vi.fn(async () => { entered.resolve(); await release.promise; return 'ok' })
    const resumeHandler = vi.fn(async () => { entered.resolve(); await release.promise })
    const worker = createPollWorker({ store, executor, resumeHandler })
    try {
      worker.start(); await entered.promise; worker.stop(); release.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(executor).toHaveBeenCalledTimes(kind === 'resume' ? 0 : 1)
      expect(resumeHandler).toHaveBeenCalledTimes(kind === 'resume' ? 1 : 0)
      if (kind === 'native') {
        expect(store.claimDueJob).toHaveBeenCalledTimes(1)
        expect(store.finishScheduleClaim).toHaveBeenCalledExactlyOnceWith(job.id, job.id + '-claim', expect.objectContaining({ success: true }))
      } else expect(store.completedCalls).toEqual([job.id])
    } finally { release.resolve(); worker.stop() }
  })

  it('drains an old claim before a fresh immediate restart pass without dispatching the old result', async () => {
    const old = makeJob({ id: 'old-job', requiresScheduleClaim: true })
    const fresh = makeJob({ id: 'fresh-job', requiresScheduleClaim: true })
    const store = makeFakeJobStore(), entered = deferred<void>(), release = deferred<void>()
    store.getDueJobs = vi.fn().mockResolvedValueOnce([old]).mockResolvedValue([fresh])
    store.claimDueJob = vi.fn(async id => {
      if (id === old.id) { entered.resolve(); await release.promise }
      return { ...(id === old.id ? old : fresh), scheduleClaimId: id + '-claim' }
    })
    store.finishScheduleClaim = vi.fn(async () => ({ applied: true, disabled: false, failures: 0 }))
    const executor = vi.fn(async () => 'ok'), worker = createPollWorker({ store, executor })
    try {
      worker.start(); await entered.promise; worker.stop(); worker.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(store.getDueJobs).toHaveBeenCalledTimes(1)
      expect(executor).not.toHaveBeenCalled()
      release.resolve(); await vi.advanceTimersByTimeAsync(0)
      expect(store.getDueJobs).toHaveBeenCalledTimes(2)
      expect(executor).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: fresh.id }))
      expect(store.finishScheduleClaim).toHaveBeenCalledExactlyOnceWith(fresh.id, fresh.id + '-claim', expect.objectContaining({ success: true }))
    } finally { release.resolve(); worker.stop() }
  })
})
