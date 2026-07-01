import { describe, it, expect } from 'vitest'
import { createSchedulingTools } from '../tools.js'
import type { JobStore, ScheduledJob } from '../types.js'
import type { StructuredSchedule } from '../schedule.js'
import type { WorkflowStore, WorkflowRecord } from '../../workflow/types.js'

function makeFakeJobStore(): JobStore & { rows: ScheduledJob[] } {
  const rows: ScheduledJob[] = []
  let nextId = 1
  return {
    rows,
    async create(params) {
      const job: ScheduledJob = {
        id: `job_${nextId++}`,
        ...params,
        mode: params.mode ?? 'local',
        enabled: true,
        lastRunAt: null,
        lastStatus: null,
        silentUntilFire: params.silentUntilFire ?? false,
        nagIntervalMins: params.nagIntervalMins ?? null,
        nagUntilKeyword: params.nagUntilKeyword ?? null,
        state: {},
        workflowId: params.workflowId ?? null,
        workflowStepRunId: params.workflowStepRunId ?? null,
        viewId: params.viewId ?? null,
      }
      rows.push(job)
      return job
    },
    async update(id, updates) {
      const job = rows.find((r) => r.id === id)
      if (!job) return null
      Object.assign(job, updates)
      return job
    },
    async delete(id) {
      const idx = rows.findIndex((r) => r.id === id)
      if (idx >= 0) {
        rows.splice(idx, 1)
        return true
      }
      return false
    },
    async get(id) {
      return rows.find((r) => r.id === id) ?? null
    },
    async list(assistantId, userId) {
      return rows.filter((r) => r.assistantId === assistantId && r.userId === userId)
    },
    async listEnabledByView(userId, viewId) {
      return rows
        .filter((r) => r.userId === userId && r.viewId === viewId && r.enabled)
        .sort((a, b) => a.nextRunAt.getTime() - b.nextRunAt.getTime())
    },
    async getDueJobs() {
      return rows.filter((r) => r.enabled && r.nextRunAt.getTime() <= Date.now())
    },
    async markCompleted() {},
    async markFailed() {},
    async setState(id, state) {
      const job = rows.find((r) => r.id === id)
      if (job) job.state = state
    },
    async listActiveNagsForUser(userId) {
      return rows.filter((r) => r.userId === userId && r.state.activeNag != null)
    },
    async purgeDisabledOlderThan(cutoff) {
      const before = rows.length
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i]
        // The fake uses Date.now() as the implicit "updated_at" — close
        // enough for cap / GC behaviour tests; production lives in
        // packages/api/src/db/job-store.ts.
        if (!r.enabled) {
          rows.splice(i, 1)
        }
      }
      void cutoff
      return before - rows.length
    },
    async countEnabledRecurring(userId) {
      return rows.filter((r) => r.userId === userId && r.enabled && r.schedule.type !== 'once').length
    },
    async search(params) {
      // Mirrors the SQL: own jobs, plus (workspace arm) every scheduled
      // workflow-trigger row. The fake skips the workflows-workspace
      // subquery — fixture data never carries foreign-workspace triggers.
      let matched = rows.filter(
        (r) =>
          (r.assistantId === params.assistantId && r.userId === params.userId) ||
          (params.workspaceId !== undefined &&
            r.workflowId !== null &&
            r.channelType === 'workflow' &&
            r.workflowStepRunId === null),
      )
      if (params.enabled !== undefined) {
        matched = matched.filter((r) => r.enabled === params.enabled)
      }
      if (params.text !== undefined && params.text.trim() !== '') {
        const needle = params.text.toLowerCase()
        matched = matched.filter((r) => r.instructions.toLowerCase().includes(needle))
      }
      if (params.scheduleType === 'once') {
        matched = matched.filter((r) => r.schedule.type === 'once')
      } else if (params.scheduleType === 'recurring') {
        matched = matched.filter((r) => r.schedule.type !== 'once')
      }
      // Newest first — deterministic by id (since insertion order ~= id order).
      matched.sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0))

      let startIdx = 0
      if (params.cursor) {
        const parsed = JSON.parse(
          Buffer.from(params.cursor, 'base64').toString('utf8'),
        ) as { i?: string }
        if (parsed.i) {
          const cursorIdx = matched.findIndex((r) => r.id === parsed.i)
          if (cursorIdx >= 0) startIdx = cursorIdx + 1
        }
      }

      const slice = matched.slice(startIdx, startIdx + params.limit + 1)
      let nextCursor: string | null = null
      if (slice.length > params.limit) {
        const lastIncluded = slice[params.limit - 1]
        nextCursor = Buffer.from(
          JSON.stringify({ c: new Date().toISOString(), i: lastIncluded.id }),
          'utf8',
        ).toString('base64')
        slice.length = params.limit
      }

      return { jobs: slice, nextCursor }
    },
    async listTriggerJobsForWorkflowSystem(workflowId) {
      return rows.filter(
        (r) => r.workflowId === workflowId && r.channelType === 'workflow' && r.workflowStepRunId === null,
      )
    },
    async listFiringJobsForWorkflowSystem(workflowId) {
      return rows.filter((r) => r.workflowId === workflowId && r.workflowStepRunId === null)
    },
  }
}

/**
 * Post Phase-2 cutover `createSchedulingTools` also builds a one-step
 * workflow per job. This fake tracks the `workflows` rows so tests can
 * assert the trigger-row ↔ workflow pairing.
 */
function makeFakeWorkflowStore(): WorkflowStore & { rows: WorkflowRecord[] } {
  const rows: WorkflowRecord[] = []
  let nextId = 1
  return {
    rows,
    async create(params) {
      const wf: WorkflowRecord = {
        id: `wf_${nextId++}`,
        workspaceId: params.workspaceId,
        createdBy: params.userId,
        name: params.name,
        description: params.description ?? null,
        definition: params.definition,
        enabled: true,
        trigger: params.trigger ?? { kind: 'manual' },
        webhookSlug: params.webhookSlug ?? null,
        webhookSecret: params.webhookSecret ?? null,
        modelAlias: params.modelAlias ?? 'pro',
        maxTurns: params.maxTurns ?? null,
        researchMode: params.researchMode ?? false,
        nameManuallySet: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      }
      rows.push(wf)
      return wf
    },
    async getById(_userId, id) {
      return rows.find((r) => r.id === id) ?? null
    },
    async list(_userId, workspaceId) {
      return rows.filter((r) => r.workspaceId === workspaceId)
    },
    async update(_userId, id, fields) {
      const wf = rows.find((r) => r.id === id)
      if (!wf) return null
      Object.assign(wf, fields)
      return wf
    },
    async delete(_userId, id) {
      const idx = rows.findIndex((r) => r.id === id)
      if (idx >= 0) {
        rows.splice(idx, 1)
        return true
      }
      return false
    },
    async findByWebhookSlugSystem() {
      return null
    },
    async findByIdSystem(id) {
      return rows.find((w) => w.id === id) ?? null
    },
    async updateAutoName(_userId, id, name) {
      const wf = rows.find((r) => r.id === id)
      if (!wf || wf.nameManuallySet) return false
      wf.name = name
      wf.updatedAt = new Date()
      return true
    },
  }
}

const ctx = {
  assistantId: 'a1',
  userId: 'u1',
  workspaceId: 'w1',
  sessionId: 's1',
  appId: 'sidanclaw',
  channelType: 'telegram',
  channelId: 'chat_123',
  preferredChannel: undefined,
  abortSignal: new AbortController().signal,
}

describe('[COMP:scheduling/tools] createScheduledJob', () => {
  it('creates a daily job and returns the id + next run', async () => {
    const store = makeFakeJobStore()
    const { createScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    const result = await createScheduledJob.execute(
      {
        schedule: { type: 'daily', time: '09:00' },
        timezone: 'Asia/Tokyo',
        instructions: 'Send daily weather',
      },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    expect(store.rows).toHaveLength(1)
    const data = result.data as { id: string; nextRun: string }
    expect(data.id).toBe('job_1')
    expect(data.nextRun).toBeDefined()
  })

  it('builds the reminder workflow on the Pro tier by default', async () => {
    const store = makeFakeJobStore()
    const wfStore = makeFakeWorkflowStore()
    const { createScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: wfStore })
    await createScheduledJob.execute(
      {
        schedule: { type: 'daily', time: '09:00' },
        timezone: 'UTC',
        instructions: 'Daily market scan',
      },
      ctx,
    )
    expect(wfStore.rows).toHaveLength(1)
    const step = wfStore.rows[0].definition.steps[0]
    expect(step.type).toBe('assistant_call')
    expect((step as { modelAlias?: string }).modelAlias).toBe('pro')
  })

  it('mirrors the schedule onto the workflow trigger (no "manual but scheduled" drift)', async () => {
    const store = makeFakeJobStore()
    const wfStore = makeFakeWorkflowStore()
    const { createScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: wfStore })
    await createScheduledJob.execute(
      {
        schedule: { type: 'daily', time: '09:00' },
        timezone: 'Asia/Tokyo',
        instructions: 'Daily market scan',
        deliveryChannel: 'telegram',
      },
      ctx,
    )
    // The workflow row a scheduled job creates must say it is scheduled, so the
    // builder shows "Scheduled" instead of a misleading "Manual".
    const wf = wfStore.rows[0]
    expect(wf.trigger).toEqual({
      kind: 'schedule',
      schedule: { type: 'daily', time: '09:00' },
      timezone: 'Asia/Tokyo',
    })
  })

  it('honors an explicit modelAlias override on the reminder step', async () => {
    const store = makeFakeJobStore()
    const wfStore = makeFakeWorkflowStore()
    const { createScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: wfStore })
    await createScheduledJob.execute(
      {
        schedule: { type: 'daily', time: '09:00' },
        timezone: 'UTC',
        instructions: 'Trivial reminder',
        modelAlias: 'standard',
      },
      ctx,
    )
    const step = wfStore.rows[0].definition.steps[0]
    expect((step as { modelAlias?: string }).modelAlias).toBe('standard')
  })

  it('creates a one-time job with future datetime', async () => {
    const store = makeFakeJobStore()
    const { createScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const result = await createScheduledJob.execute(
      {
        schedule: { type: 'once', datetime: future } as StructuredSchedule,
        timezone: 'UTC',
        instructions: 'Remind in 1 hour',
      },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0].schedule.type).toBe('once')
  })

  it('honors explicit deliveryChannel override', async () => {
    const store = makeFakeJobStore()
    const { createScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    await createScheduledJob.execute(
      {
        schedule: { type: 'daily', time: '09:00' },
        timezone: 'UTC',
        instructions: 'ping',
        deliveryChannel: 'slack',
      },
      // Slack must be resolvable for the override to land — the user's preferred
      // channel is a Slack channel. (A cross-type request with no matching
      // channel is rejected, not cross-wired onto the telegram session id.)
      { ...ctx, preferredChannel: { channelType: 'slack', channelId: 'C_SLACK' } },
    )
    expect(store.rows[0].channelType).toBe('slack')
    expect(store.rows[0].channelId).toBe('C_SLACK')
  })

  it('rejects an explicit deliveryChannel that the session cannot resolve (no cross-wiring)', async () => {
    const store = makeFakeJobStore()
    const { createScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    // ctx is a Telegram session with no preferred Slack channel → 'slack' has no
    // real id; the job must be rejected rather than stamped with the telegram id.
    const r = await createScheduledJob.execute(
      { schedule: { type: 'daily', time: '09:00' }, timezone: 'UTC', instructions: 'ping', deliveryChannel: 'slack' },
      ctx,
    )
    expect(r.isError).toBe(true)
    expect(store.rows).toHaveLength(0)
  })

  it('falls back to context.channelType when no override', async () => {
    const store = makeFakeJobStore()
    const { createScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    await createScheduledJob.execute(
      {
        schedule: { type: 'daily', time: '09:00' },
        timezone: 'UTC',
        instructions: 'ping',
      },
      ctx,
    )
    expect(store.rows[0].channelType).toBe('telegram')
  })

  it('does not require confirmation (always allow)', () => {
    const { createScheduledJob } = createSchedulingTools({ jobStore: makeFakeJobStore(), workflowStore: makeFakeWorkflowStore() })
    expect(createScheduledJob.requiresConfirmation).toBe(false)
  })

  it('defaults timezone to context.userTimezone when the model omits it', async () => {
    // Matches the common case: "remind me at 2pm" with no explicit tz.
    // The tool should bind to the user's current timezone from context,
    // not fall through to UTC.
    const store = makeFakeJobStore()
    const { createScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    await createScheduledJob.execute(
      {
        schedule: { type: 'daily', time: '14:00' },
        instructions: 'pill',
      },
      { ...ctx, userTimezone: 'Asia/Hong_Kong' },
    )
    expect(store.rows[0].timezone).toBe('Asia/Hong_Kong')
  })

  it('falls back to UTC when neither input.timezone nor context.userTimezone is set', async () => {
    const store = makeFakeJobStore()
    const { createScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    await createScheduledJob.execute(
      {
        schedule: { type: 'daily', time: '09:00' },
        instructions: 'x',
      },
      ctx,
    )
    expect(store.rows[0].timezone).toBe('UTC')
  })

  it('creates every new job as mode="local"', async () => {
    const store = makeFakeJobStore()
    const { createScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    await createScheduledJob.execute(
      {
        schedule: { type: 'daily', time: '09:00' },
        timezone: 'UTC',
        instructions: 'x',
      },
      ctx,
    )
    expect(store.rows[0].mode).toBe('local')
  })

  // ── Doc page link (migration 229) ──────────────────────────────
  const VIEW_A = '11111111-1111-1111-1111-111111111111'
  const VIEW_B = '22222222-2222-2222-2222-222222222222'

  it('captures the anchored doc page (context.docViewId) as the job viewId', async () => {
    const store = makeFakeJobStore()
    const { createScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    const result = await createScheduledJob.execute(
      {
        schedule: { type: 'daily', time: '07:00' },
        timezone: 'UTC',
        instructions: 'Research competitors and update this page',
      },
      { ...ctx, docViewId: VIEW_A },
    )
    expect(store.rows[0].viewId).toBe(VIEW_A)
    expect((result.data as { targetViewId: string | null }).targetViewId).toBe(VIEW_A)
  })

  it('leaves viewId null when the turn is not anchored to a page', async () => {
    const store = makeFakeJobStore()
    const { createScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    await createScheduledJob.execute(
      { schedule: { type: 'daily', time: '07:00' }, timezone: 'UTC', instructions: 'x' },
      ctx,
    )
    expect(store.rows[0].viewId).toBeNull()
  })

  it('an explicit targetViewId overrides the anchored page', async () => {
    const store = makeFakeJobStore()
    const { createScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    await createScheduledJob.execute(
      {
        schedule: { type: 'daily', time: '07:00' },
        timezone: 'UTC',
        instructions: 'x',
        targetViewId: VIEW_B,
      },
      { ...ctx, docViewId: VIEW_A },
    )
    expect(store.rows[0].viewId).toBe(VIEW_B)
  })

  it('drops the view link when the resolver reports a different workspace', async () => {
    const store = makeFakeJobStore()
    const { createScheduledJob } = createSchedulingTools({
      jobStore: store,
      workflowStore: makeFakeWorkflowStore(),
      // The page resolves, but to a workspace the scheduling context isn't in.
      resolveViewWorkspace: async () => 'other-workspace',
    })
    await createScheduledJob.execute(
      { schedule: { type: 'daily', time: '07:00' }, timezone: 'UTC', instructions: 'x' },
      { ...ctx, docViewId: VIEW_A },
    )
    expect(store.rows[0].viewId).toBeNull()
  })

  it('keeps the view link when the resolver confirms the same workspace', async () => {
    const store = makeFakeJobStore()
    const { createScheduledJob } = createSchedulingTools({
      jobStore: store,
      workflowStore: makeFakeWorkflowStore(),
      resolveViewWorkspace: async () => ctx.workspaceId,
    })
    await createScheduledJob.execute(
      { schedule: { type: 'daily', time: '07:00' }, timezone: 'UTC', instructions: 'x' },
      { ...ctx, docViewId: VIEW_A },
    )
    expect(store.rows[0].viewId).toBe(VIEW_A)
  })

  // ── Web is not a delivery target ───────────────────────────────────
  it('rejects a web-context job with no messaging channel and no doc page', async () => {
    // A user on web with no preferred messaging channel can't schedule output
    // into the main chat anymore — they must connect a channel first.
    const store = makeFakeJobStore()
    const wfStore = makeFakeWorkflowStore()
    const { createScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: wfStore })
    const result = await createScheduledJob.execute(
      { schedule: { type: 'daily', time: '09:00' }, timezone: 'UTC', instructions: 'daily brief' },
      { ...ctx, channelType: 'web', channelId: 'web_sess' },
    )
    expect(result.isError).toBe(true)
    expect(String((result.data as string))).toMatch(/messaging channel|doc page/i)
    // Nothing is persisted — neither the trigger row nor its workflow.
    expect(store.rows).toHaveLength(0)
    expect(wfStore.rows).toHaveLength(0)
  })

  it('allows a web-context doc job: no channel delivery, stores the doc sentinel', async () => {
    // Scheduling "update this page daily" from a doc page is the one path
    // a web-context job survives: it runs silently and patches the page, with
    // no `deliver` on the workflow step.
    const store = makeFakeJobStore()
    const wfStore = makeFakeWorkflowStore()
    const { createScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: wfStore })
    const result = await createScheduledJob.execute(
      { schedule: { type: 'daily', time: '07:00' }, timezone: 'UTC', instructions: 'Refresh this page' },
      { ...ctx, channelType: 'web', channelId: 'web_sess', docViewId: VIEW_A },
    )
    expect(result.isError).toBeFalsy()
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0].channelType).toBe('doc')
    expect(store.rows[0].viewId).toBe(VIEW_A)
    // The one-step workflow omits `deliver` — nothing is pushed to a channel.
    const step = wfStore.rows[0].definition.steps[0]
    expect((step as { deliver?: unknown }).deliver).toBeUndefined()
    // The result reports the doc page, not a web channel.
    expect((result.data as { deliveryChannel: string }).deliveryChannel).toBe('doc')
  })
})

describe('[COMP:scheduling/tools] updateScheduledJob', () => {
  it('updates instructions on an existing job', async () => {
    const store = makeFakeJobStore()
    const { createScheduledJob, updateScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    await createScheduledJob.execute(
      {
        schedule: { type: 'daily', time: '09:00' },
        timezone: 'UTC',
        instructions: 'Old',
      },
      ctx,
    )
    const result = await updateScheduledJob.execute(
      { jobId: 'job_1', instructions: 'New' },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    expect(store.rows[0].instructions).toBe('New')
  })

  it('returns an error for unknown job id', async () => {
    const store = makeFakeJobStore()
    const { updateScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    const result = await updateScheduledJob.execute(
      { jobId: 'job_missing', enabled: false },
      ctx,
    )
    expect(result.isError).toBe(true)
  })

  it('preserves the stored timezone when only the schedule time is changed', async () => {
    // Regression: previously, updating just the schedule caused nextRunAt to be
    // recomputed with a UTC fallback — discarding the job's timezone and making
    // "change to 12:40" resolve to 12:40 UTC instead of 12:40 local.
    const store = makeFakeJobStore()
    const { createScheduledJob, updateScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    await createScheduledJob.execute(
      {
        schedule: { type: 'daily', time: '09:00' },
        timezone: 'Asia/Hong_Kong',
        instructions: 'daily recap',
      },
      ctx,
    )
    await updateScheduledJob.execute(
      { jobId: 'job_1', schedule: { type: 'daily', time: '12:40' } },
      ctx,
    )
    const job = store.rows[0]
    expect(job.timezone).toBe('Asia/Hong_Kong')

    // Build expected UTC instant for "next 12:40 Asia/Hong_Kong" and compare.
    const hkOffsetHours = 8
    const nowUtcMs = Date.now()
    const hkNow = new Date(nowUtcMs + hkOffsetHours * 3600_000)
    const y = hkNow.getUTCFullYear()
    const m = hkNow.getUTCMonth()
    const d = hkNow.getUTCDate()
    let expectedUtc = Date.UTC(y, m, d, 12 - hkOffsetHours, 40)
    if (expectedUtc <= nowUtcMs) expectedUtc += 24 * 3600_000
    expect(job.nextRunAt.getTime()).toBe(expectedUtc)
  })

  it('recomputes next_run_at when only the timezone changes', async () => {
    const store = makeFakeJobStore()
    const { createScheduledJob, updateScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    await createScheduledJob.execute(
      {
        schedule: { type: 'daily', time: '09:00' },
        timezone: 'UTC',
        instructions: 'x',
      },
      ctx,
    )
    const beforeUtc = store.rows[0].nextRunAt.getTime()
    await updateScheduledJob.execute(
      { jobId: 'job_1', timezone: 'Asia/Hong_Kong' },
      ctx,
    )
    expect(store.rows[0].timezone).toBe('Asia/Hong_Kong')
    expect(store.rows[0].nextRunAt.getTime()).not.toBe(beforeUtc)
  })

  it('can disable a job via enabled=false', async () => {
    const store = makeFakeJobStore()
    const { createScheduledJob, updateScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    await createScheduledJob.execute(
      {
        schedule: { type: 'daily', time: '09:00' },
        timezone: 'UTC',
        instructions: 'x',
      },
      ctx,
    )
    await updateScheduledJob.execute({ jobId: 'job_1', enabled: false }, ctx)
    expect(store.rows[0].enabled).toBe(false)
  })

  it('flipping to mode="user" syncs timezone to context.userTimezone', async () => {
    // The travel-nudge "Follow me" path: the model calls updateScheduledJob
    // with mode='user' and no explicit tz; the tool should sync the job's
    // timezone to the user's current tz so next_run_at is correct.
    const store = makeFakeJobStore()
    const { createScheduledJob, updateScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    await createScheduledJob.execute(
      {
        schedule: { type: 'daily', time: '09:00' },
        timezone: 'Asia/Hong_Kong',
        instructions: 'morning standup',
      },
      ctx,
    )
    const beforeNextRun = store.rows[0].nextRunAt.getTime()
    await updateScheduledJob.execute(
      { jobId: 'job_1', mode: 'user' },
      { ...ctx, userTimezone: 'Asia/Tokyo' },
    )
    expect(store.rows[0].mode).toBe('user')
    expect(store.rows[0].timezone).toBe('Asia/Tokyo')
    // next_run_at should move because 09:00 Tokyo is a different UTC instant.
    expect(store.rows[0].nextRunAt.getTime()).not.toBe(beforeNextRun)
  })

  it('flipping to mode="local" without a timezone keeps the existing tz', async () => {
    const store = makeFakeJobStore()
    const { createScheduledJob, updateScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    await createScheduledJob.execute(
      {
        schedule: { type: 'daily', time: '09:00' },
        timezone: 'Asia/Hong_Kong',
        instructions: 'x',
      },
      ctx,
    )
    // Pretend the job had been flipped to user mode earlier.
    await updateScheduledJob.execute(
      { jobId: 'job_1', mode: 'user' },
      { ...ctx, userTimezone: 'Asia/Tokyo' },
    )
    // Now pin back to local — model omits tz, so we keep whatever's there (Tokyo).
    await updateScheduledJob.execute({ jobId: 'job_1', mode: 'local' }, ctx)
    expect(store.rows[0].mode).toBe('local')
    expect(store.rows[0].timezone).toBe('Asia/Tokyo')
  })
})

describe('[COMP:scheduling/tools] searchScheduledJobs', () => {
  it('returns an empty result when no jobs match', async () => {
    const store = makeFakeJobStore()
    const { searchScheduledJobs } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    const result = await searchScheduledJobs.execute({}, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.data).toEqual({ jobs: [], nextCursor: null })
  })

  it('returns matching jobs in a structured envelope', async () => {
    const store = makeFakeJobStore()
    const { createScheduledJob, searchScheduledJobs } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    await createScheduledJob.execute(
      {
        schedule: { type: 'daily', time: '09:00' },
        timezone: 'UTC',
        instructions: 'Ping daily',
      },
      ctx,
    )
    const result = await searchScheduledJobs.execute({}, ctx)
    const data = result.data as { jobs: unknown[]; nextCursor: string | null }
    expect(data.jobs).toHaveLength(1)
    expect(data.nextCursor).toBeNull()
  })

  it('defaults to enabled-only — disabled rows are excluded', async () => {
    const store = makeFakeJobStore()
    const { createScheduledJob, updateScheduledJob, searchScheduledJobs } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    await createScheduledJob.execute(
      { schedule: { type: 'daily', time: '09:00' }, timezone: 'UTC', instructions: 'enabled job' },
      ctx,
    )
    await createScheduledJob.execute(
      { schedule: { type: 'daily', time: '10:00' }, timezone: 'UTC', instructions: 'paused job' },
      ctx,
    )
    await updateScheduledJob.execute({ jobId: 'job_2', enabled: false }, ctx)

    const onlyEnabled = await searchScheduledJobs.execute({}, ctx)
    const enabledJobs = (onlyEnabled.data as { jobs: Array<{ id: string }> }).jobs
    expect(enabledJobs).toHaveLength(1)
    expect(enabledJobs[0].id).toBe('job_1')

    // Explicit `enabled: false` returns only the paused row.
    const onlyDisabled = await searchScheduledJobs.execute({ enabled: false }, ctx)
    const disabledJobs = (onlyDisabled.data as { jobs: Array<{ id: string }> }).jobs
    expect(disabledJobs).toHaveLength(1)
    expect(disabledJobs[0].id).toBe('job_2')
  })

  it('filters by text substring against instructions (case-insensitive)', async () => {
    const store = makeFakeJobStore()
    const { createScheduledJob, searchScheduledJobs } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    await createScheduledJob.execute(
      { schedule: { type: 'daily', time: '09:00' }, timezone: 'UTC', instructions: 'Pill reminder — Asia/Hong_Kong' },
      ctx,
    )
    await createScheduledJob.execute(
      { schedule: { type: 'daily', time: '11:00' }, timezone: 'UTC', instructions: 'Stand-up notes' },
      ctx,
    )

    const result = await searchScheduledJobs.execute({ text: 'PILL' }, ctx)
    const jobs = (result.data as { jobs: Array<{ id: string }> }).jobs
    expect(jobs).toHaveLength(1)
    expect(jobs[0].id).toBe('job_1')
  })

  it('filters by schedule="recurring" and schedule="once"', async () => {
    const store = makeFakeJobStore()
    const { createScheduledJob, searchScheduledJobs } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    await createScheduledJob.execute(
      { schedule: { type: 'daily', time: '09:00' }, timezone: 'UTC', instructions: 'recurring' },
      ctx,
    )
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    await createScheduledJob.execute(
      { schedule: { type: 'once', datetime: future }, timezone: 'UTC', instructions: 'one-shot' },
      ctx,
    )

    const recurring = await searchScheduledJobs.execute({ schedule: 'recurring' }, ctx)
    const recurringJobs = (recurring.data as { jobs: Array<{ id: string }> }).jobs
    expect(recurringJobs.map((j) => j.id)).toEqual(['job_1'])

    const once = await searchScheduledJobs.execute({ schedule: 'once' }, ctx)
    const onceJobs = (once.data as { jobs: Array<{ id: string }> }).jobs
    expect(onceJobs.map((j) => j.id)).toEqual(['job_2'])
  })

  it('clamps limit at 50 (the hard cap)', async () => {
    // We can't easily verify the clamp on the fake without a JSONSchema
    // validator (Zod rejects > 50 at parse), so prove the schema's max is 50.
    const { searchScheduledJobs } = createSchedulingTools({ jobStore: makeFakeJobStore(), workflowStore: makeFakeWorkflowStore() })
    const parseResult = searchScheduledJobs.inputSchema.safeParse({ limit: 51 })
    expect(parseResult.success).toBe(false)
    const okResult = searchScheduledJobs.inputSchema.safeParse({ limit: 50 })
    expect(okResult.success).toBe(true)
  })

  it('cursor round-trip — first page returns nextCursor, second page returns the rest', async () => {
    const store = makeFakeJobStore()
    const { createScheduledJob, searchScheduledJobs } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    // 3 jobs, limit of 2 — first page should yield 2 with a cursor.
    for (let i = 0; i < 3; i++) {
      await createScheduledJob.execute(
        { schedule: { type: 'daily', time: `0${i + 1}:00` }, timezone: 'UTC', instructions: `job ${i}` },
        ctx,
      )
    }
    const first = await searchScheduledJobs.execute({ limit: 2 }, ctx)
    const firstData = first.data as { jobs: Array<{ id: string }>; nextCursor: string | null }
    expect(firstData.jobs).toHaveLength(2)
    expect(firstData.nextCursor).toBeTruthy()

    const second = await searchScheduledJobs.execute({ limit: 2, cursor: firstData.nextCursor! }, ctx)
    const secondData = second.data as { jobs: Array<{ id: string }>; nextCursor: string | null }
    expect(secondData.jobs).toHaveLength(1)
    expect(secondData.nextCursor).toBeNull()
    // The pages combined contain every distinct job id.
    const allIds = [...firstData.jobs.map((j) => j.id), ...secondData.jobs.map((j) => j.id)]
    expect(new Set(allIds).size).toBe(3)
  })

  it('is read-only and concurrency-safe', () => {
    const { searchScheduledJobs } = createSchedulingTools({ jobStore: makeFakeJobStore(), workflowStore: makeFakeWorkflowStore() })
    expect(searchScheduledJobs.isReadOnly).toBe(true)
    expect(searchScheduledJobs.isConcurrencySafe).toBe(true)
  })
})

describe('[COMP:scheduling/tools] deleteScheduledJob', () => {
  it('deletes an existing job', async () => {
    const store = makeFakeJobStore()
    const { createScheduledJob, deleteScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    await createScheduledJob.execute(
      {
        schedule: { type: 'daily', time: '09:00' },
        timezone: 'UTC',
        instructions: 'x',
      },
      ctx,
    )
    const result = await deleteScheduledJob.execute({ jobId: 'job_1' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(store.rows).toHaveLength(0)
  })

  it('returns an error for unknown job id', async () => {
    const store = makeFakeJobStore()
    const { deleteScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: makeFakeWorkflowStore() })
    const result = await deleteScheduledJob.execute({ jobId: 'job_missing' }, ctx)
    expect(result.isError).toBe(true)
  })

  it('does not require confirmation (always allow)', () => {
    const { deleteScheduledJob } = createSchedulingTools({ jobStore: makeFakeJobStore(), workflowStore: makeFakeWorkflowStore() })
    expect(deleteScheduledJob.requiresConfirmation).toBe(false)
  })
})

describe('[COMP:scheduling/tools] delivery target resolution + confirmation ping', () => {
  // A resolver that names the exact Telegram group + topic, mirroring the
  // API-side seen-chats label. Records its calls so tests can assert wiring.
  function makeFakeResolver() {
    const calls: Array<{ assistantId: string; channelType: string; channelId: string }> = []
    const resolver = async (args: { assistantId: string; channelType: string; channelId: string }) => {
      calls.push(args)
      if (args.channelType === 'telegram') {
        return { label: 'Telegram · group "GM Bro" · topic "GM Bro"', topicId: 42 }
      }
      if (args.channelType === 'web') return { label: 'Web chat' }
      return { label: args.channelType }
    }
    return { resolver, calls }
  }

  function makeFakeDeliver() {
    const sends: Array<{ channelType: string; channelId: string; text: string }> = []
    const deliverToChannel = async (params: { channelType: string; channelId: string; text: string }) => {
      sends.push({ channelType: params.channelType, channelId: params.channelId, text: params.text })
      return { status: 'delivered' as const, channelType: params.channelType, channelId: params.channelId }
    }
    return { deliverToChannel, sends }
  }

  const tgCtx = { ...ctx, channelType: 'telegram', channelId: '-100123:topic:42' }

  it('echoes a resolved deliveryTarget label on create', async () => {
    const { resolver } = makeFakeResolver()
    const { createScheduledJob } = createSchedulingTools({
      jobStore: makeFakeJobStore(),
      workflowStore: makeFakeWorkflowStore(),
      resolveDeliveryTarget: resolver,
    })
    const result = await createScheduledJob.execute(
      { schedule: { type: 'daily', time: '09:00' }, timezone: 'UTC', instructions: 'morning brief' },
      tgCtx,
    )
    const data = result.data as { deliveryTarget?: { label: string; topicId?: number; channelType: string } }
    expect(data.deliveryTarget?.label).toBe('Telegram · group "GM Bro" · topic "GM Bro"')
    expect(data.deliveryTarget?.topicId).toBe(42)
    expect(data.deliveryTarget?.channelType).toBe('telegram')
  })

  it('falls back to bare deliveryChannel when no resolver is wired', async () => {
    const { createScheduledJob } = createSchedulingTools({
      jobStore: makeFakeJobStore(),
      workflowStore: makeFakeWorkflowStore(),
    })
    const result = await createScheduledJob.execute(
      { schedule: { type: 'daily', time: '09:00' }, timezone: 'UTC', instructions: 'x' },
      tgCtx,
    )
    const data = result.data as { deliveryChannel: string; deliveryTarget?: unknown }
    expect(data.deliveryChannel).toBe('telegram')
    expect(data.deliveryTarget).toBeUndefined()
  })

  it('never throws when the resolver rejects (degrades to type-only)', async () => {
    const { createScheduledJob } = createSchedulingTools({
      jobStore: makeFakeJobStore(),
      workflowStore: makeFakeWorkflowStore(),
      resolveDeliveryTarget: async () => {
        throw new Error('seen-chats lookup failed')
      },
    })
    const result = await createScheduledJob.execute(
      { schedule: { type: 'daily', time: '09:00' }, timezone: 'UTC', instructions: 'x' },
      tgCtx,
    )
    const data = result.data as { deliveryChannel: string; deliveryTarget?: unknown }
    expect(result.isError).toBeFalsy()
    expect(data.deliveryChannel).toBe('telegram')
    expect(data.deliveryTarget).toBeUndefined()
  })

  it('posts a confirmation ping into the exact channel/topic when retargeting via updateScheduledJob', async () => {
    const store = makeFakeJobStore()
    const { resolver } = makeFakeResolver()
    const { deliverToChannel, sends } = makeFakeDeliver()
    const { createScheduledJob, updateScheduledJob } = createSchedulingTools({
      jobStore: store,
      workflowStore: makeFakeWorkflowStore(),
      resolveDeliveryTarget: resolver,
      deliverToChannel,
    })
    // Job starts on Slack (no explicit deliveryChannel, so no create-time
    // ping); user then retargets it to the Telegram topic.
    await createScheduledJob.execute(
      { schedule: { type: 'daily', time: '09:00' }, timezone: 'UTC', instructions: 'brief' },
      { ...ctx, channelType: 'slack', channelId: 'C123' },
    )
    const result = await updateScheduledJob.execute({ jobId: 'job_1', deliveryChannel: 'telegram' }, tgCtx)
    const data = result.data as { confirmationSent: boolean; deliveryTarget?: { label: string } }
    expect(data.confirmationSent).toBe(true)
    expect(data.deliveryTarget?.label).toContain('topic "GM Bro"')
    // The ping must go to the job's stored topic-encoded channelId — the same
    // path the job uses on fire — not the bare chat id.
    expect(sends).toHaveLength(1)
    expect(sends[0].channelType).toBe('telegram')
    expect(sends[0].channelId).toBe('-100123:topic:42')
  })

  it('rejects "web" as a deliveryChannel on both create and update (schema)', async () => {
    // Web is no longer a delivery target — the enum must not accept it, so the
    // model cannot route scheduled output back into the web chat.
    const { createScheduledJob, updateScheduledJob } = createSchedulingTools({
      jobStore: makeFakeJobStore(),
      workflowStore: makeFakeWorkflowStore(),
    })
    const createParse = createScheduledJob.inputSchema.safeParse({
      schedule: { type: 'daily', time: '09:00' },
      instructions: 'x',
      deliveryChannel: 'web',
    })
    expect(createParse.success).toBe(false)
    const updateParse = updateScheduledJob.inputSchema.safeParse({
      jobId: 'job_1',
      deliveryChannel: 'web',
    })
    expect(updateParse.success).toBe(false)
  })

  it('does not ping on a plain "remind me here" create (no explicit deliveryChannel)', async () => {
    const { deliverToChannel, sends } = makeFakeDeliver()
    const { createScheduledJob } = createSchedulingTools({
      jobStore: makeFakeJobStore(),
      workflowStore: makeFakeWorkflowStore(),
      resolveDeliveryTarget: makeFakeResolver().resolver,
      deliverToChannel,
    })
    const result = await createScheduledJob.execute(
      { schedule: { type: 'once', datetime: new Date(Date.now() + 5 * 60_000).toISOString() } as StructuredSchedule, timezone: 'UTC', instructions: 'ping me' },
      tgCtx,
    )
    const data = result.data as { confirmationSent: boolean }
    expect(data.confirmationSent).toBe(false)
    expect(sends).toHaveLength(0)
  })

  it('pings on create when the user explicitly routes to a messaging channel', async () => {
    const { deliverToChannel, sends } = makeFakeDeliver()
    const { createScheduledJob } = createSchedulingTools({
      jobStore: makeFakeJobStore(),
      workflowStore: makeFakeWorkflowStore(),
      resolveDeliveryTarget: makeFakeResolver().resolver,
      deliverToChannel,
    })
    const result = await createScheduledJob.execute(
      { schedule: { type: 'daily', time: '09:00' }, timezone: 'UTC', instructions: 'brief', deliveryChannel: 'telegram' },
      tgCtx,
    )
    const data = result.data as { confirmationSent: boolean }
    expect(data.confirmationSent).toBe(true)
    expect(sends).toHaveLength(1)
    expect(sends[0].text).toContain('📍')
  })

  it('surfaces deliveryTarget per job in searchScheduledJobs', async () => {
    const store = makeFakeJobStore()
    const { resolver, calls } = makeFakeResolver()
    const { createScheduledJob, searchScheduledJobs } = createSchedulingTools({
      jobStore: store,
      workflowStore: makeFakeWorkflowStore(),
      resolveDeliveryTarget: resolver,
    })
    // Two jobs sharing the same telegram topic → resolver deduped to one call.
    await createScheduledJob.execute({ schedule: { type: 'daily', time: '09:00' }, timezone: 'UTC', instructions: 'a' }, tgCtx)
    await createScheduledJob.execute({ schedule: { type: 'daily', time: '10:00' }, timezone: 'UTC', instructions: 'b' }, tgCtx)
    const before = calls.length
    const result = await searchScheduledJobs.execute({}, tgCtx)
    const data = result.data as { jobs: Array<{ deliveryTarget?: { label: string } }> }
    expect(data.jobs).toHaveLength(2)
    expect(data.jobs[0].deliveryTarget?.label).toContain('topic "GM Bro"')
    // Both jobs share (telegram, -100123:topic:42) → exactly one extra resolve.
    expect(calls.length - before).toBe(1)
  })

  it('does not ping when deliverToChannel is unavailable (returns confirmationSent=false)', async () => {
    const { createScheduledJob } = createSchedulingTools({
      jobStore: makeFakeJobStore(),
      workflowStore: makeFakeWorkflowStore(),
      resolveDeliveryTarget: makeFakeResolver().resolver,
      // no deliverToChannel
    })
    const result = await createScheduledJob.execute(
      { schedule: { type: 'daily', time: '09:00' }, timezone: 'UTC', instructions: 'x', deliveryChannel: 'telegram' },
      tgCtx,
    )
    const data = result.data as { confirmationSent: boolean }
    expect(data.confirmationSent).toBe(false)
  })
})

describe('[COMP:scheduling/tools] workspace visibility + cross-member management', () => {
  // Two members of workspace w1: u1 (the session) and u2 (the teammate who
  // created the runaway trigger). The incident shape (2026-06-10): u2's
  // hourly workflow triggers were invisible to u1, and the workspace had no
  // self-recovery path.
  function seed() {
    const store = makeFakeJobStore()
    const wfStore = makeFakeWorkflowStore()
    return { store, wfStore }
  }

  async function seedTeammateTrigger(
    store: ReturnType<typeof makeFakeJobStore>,
    wfStore: ReturnType<typeof makeFakeWorkflowStore>,
    opts: { workspaceId?: string } = {},
  ) {
    const wf = await wfStore.create({
      userId: 'u2',
      workspaceId: opts.workspaceId ?? 'w1',
      name: 'moat strategy research',
      definition: { startStepId: 's', steps: [{ id: 's', type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'go' }] },
    })
    const job = await store.create({
      assistantId: 'a1',
      userId: 'u2', // the OTHER member
      schedule: { type: 'cron', expression: '0 * * * *' },
      timezone: 'UTC',
      instructions: JSON.stringify({ kind: 'workflow_trigger', workflowId: wf.id, input: {} }),
      channelType: 'workflow',
      channelId: wf.id,
      nextRunAt: new Date(Date.now() + 60_000),
      workflowId: wf.id,
    })
    return { wf, job }
  }

  it("search surfaces a teammate's workflow trigger with ownedByMe=false + workflowId", async () => {
    const { store, wfStore } = seed()
    const { wf, job } = await seedTeammateTrigger(store, wfStore)
    // Plus one personal reminder of u1's own, for the ownedByMe contrast.
    await store.create({
      assistantId: 'a1', userId: 'u1',
      schedule: { type: 'daily', time: '09:00' }, timezone: 'UTC',
      instructions: 'my own reminder', channelType: 'telegram', channelId: 'c1',
      nextRunAt: new Date(Date.now() + 60_000),
    })
    const { searchScheduledJobs } = createSchedulingTools({ jobStore: store, workflowStore: wfStore })

    const result = await searchScheduledJobs.execute({}, ctx)
    const data = result.data as { jobs: Array<{ id: string; ownedByMe: boolean; workflowId?: string; title: string | null }> }
    const trigger = data.jobs.find((j) => j.id === job.id)
    expect(trigger).toBeDefined()
    expect(trigger!.ownedByMe).toBe(false)
    expect(trigger!.workflowId).toBe(wf.id)
    // Title resolves from the teammate's workflow (workspace-scoped read).
    expect(trigger!.title).toBe('moat strategy research')
    const own = data.jobs.find((j) => j.id !== job.id)
    expect(own!.ownedByMe).toBe(true)
    expect(own!.workflowId).toBeUndefined()
  })

  it("a teammate's PERSONAL reminder stays invisible without the workspace arm match", async () => {
    const { store, wfStore } = seed()
    await store.create({
      assistantId: 'a1', userId: 'u2',
      schedule: { type: 'daily', time: '08:00' }, timezone: 'UTC',
      instructions: 'take the pill', channelType: 'telegram', channelId: 'c9',
      nextRunAt: new Date(Date.now() + 60_000),
    })
    const { searchScheduledJobs } = createSchedulingTools({ jobStore: store, workflowStore: wfStore })
    const result = await searchScheduledJobs.execute({}, ctx)
    const data = result.data as { jobs: unknown[] }
    expect(data.jobs).toEqual([])
  })

  it("a member can disable and delete a teammate's workflow trigger", async () => {
    const { store, wfStore } = seed()
    const { job } = await seedTeammateTrigger(store, wfStore)
    const { updateScheduledJob, deleteScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: wfStore })

    const updated = await updateScheduledJob.execute({ jobId: job.id, enabled: false }, ctx)
    expect(updated.isError).toBeFalsy()
    expect(store.rows.find((r) => r.id === job.id)?.enabled).toBe(false)

    const deleted = await deleteScheduledJob.execute({ jobId: job.id }, ctx)
    expect(deleted.isError).toBeFalsy()
    expect(store.rows.find((r) => r.id === job.id)).toBeUndefined()
    // The user-authored workflow it fired stays intact (no reminder cascade).
    expect(wfStore.rows).toHaveLength(1)
  })

  it("a teammate's personal reminder cannot be updated or deleted (not-found, no existence leak)", async () => {
    const { store, wfStore } = seed()
    const reminder = await store.create({
      assistantId: 'a1', userId: 'u2',
      schedule: { type: 'daily', time: '08:00' }, timezone: 'UTC',
      instructions: 'take the pill', channelType: 'telegram', channelId: 'c9',
      nextRunAt: new Date(Date.now() + 60_000),
    })
    const { updateScheduledJob, deleteScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: wfStore })

    const updated = await updateScheduledJob.execute({ jobId: reminder.id, enabled: false }, ctx)
    expect(updated.isError).toBe(true)
    expect(updated.data).toContain('not found')

    const deleted = await deleteScheduledJob.execute({ jobId: reminder.id }, ctx)
    expect(deleted.isError).toBe(true)
    expect(store.rows.find((r) => r.id === reminder.id)).toBeDefined()
  })

  it('a trigger whose workflow lives in ANOTHER workspace is not manageable', async () => {
    const { store, wfStore } = seed()
    const { job } = await seedTeammateTrigger(store, wfStore, { workspaceId: 'w-other' })
    const { deleteScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: wfStore })
    const deleted = await deleteScheduledJob.execute({ jobId: job.id }, ctx)
    expect(deleted.isError).toBe(true)
    expect(store.rows.find((r) => r.id === job.id)).toBeDefined()
  })

  it('without a workspace context, only owned jobs are manageable (the pre-fix gap is closed, not widened)', async () => {
    const { store, wfStore } = seed()
    const { job } = await seedTeammateTrigger(store, wfStore)
    const { deleteScheduledJob } = createSchedulingTools({ jobStore: store, workflowStore: wfStore })
    const noWorkspaceCtx = { ...ctx, workspaceId: undefined }
    const deleted = await deleteScheduledJob.execute({ jobId: job.id }, noWorkspaceCtx)
    expect(deleted.isError).toBe(true)
    expect(store.rows.find((r) => r.id === job.id)).toBeDefined()
  })
})
