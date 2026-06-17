/**
 * Phase B — `scheduleWorkflow` chat tool integration.
 *
 * [COMP:workflow/scheduled-trigger]
 */

import { describe, it, expect } from 'vitest'
import { createScheduleWorkflowTool, syncWorkflowScheduleTrigger } from '../scheduled-trigger.js'
import type { JobStore, ScheduledJob } from '../../scheduling/types.js'
import type { WorkflowRecord, WorkflowStore } from '../types.js'
import type { ToolContext } from '../../tools/types.js'

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'
const PRIMARY_ASSISTANT_ID = '00000000-0000-0000-0000-000000000002'
const USER_ID = '00000000-0000-0000-0000-000000000003'

function makeWorkflowStore(seed: WorkflowRecord[]): WorkflowStore {
  const map = new Map(seed.map((s) => [s.id, s]))
  return {
    async create() { throw new Error('not used in this test') },
    async getById(_u, id) { return map.get(id) ?? null },
    async list() { return [...map.values()] },
    async update(_u, id, fields) {
      const existing = map.get(id)
      if (!existing) return null
      const updated = { ...existing, ...fields }
      map.set(id, updated)
      return updated
    },
    async delete() { throw new Error('not used in this test') },
    async findByWebhookSlugSystem() { return null },
    async findByIdSystem(id) { return map.get(id) ?? null },
    async updateAutoName() { return false },
  }
}

function makeJobStore(): JobStore & { rows: ScheduledJob[] } {
  const rows: ScheduledJob[] = []
  return {
    rows,
    async create(params) {
      const job: ScheduledJob = {
        id: `00000000-0000-0000-0000-${String(rows.length + 100).padStart(12, '0')}`,
        assistantId: params.assistantId,
        userId: params.userId,
        schedule: params.schedule,
        timezone: params.timezone,
        mode: params.mode ?? 'local',
        instructions: params.instructions,
        channelType: params.channelType,
        channelId: params.channelId,
        enabled: true,
        nextRunAt: params.nextRunAt,
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
      if (idx === -1) return false
      rows.splice(idx, 1)
      return true
    },
    async get() { return null },
    async list() { return rows },
    async listEnabledByView() { return [] },
    async getDueJobs() { return [] },
    async markCompleted() {},
    async markFailed() {},
    async setState() {},
    async listActiveNagsForUser() { return [] },
    async purgeDisabledOlderThan() { return 0 },
    async countEnabledRecurring() { return 0 },
    async search() { return { jobs: [], nextCursor: null } },
    async listTriggerJobsForWorkflowSystem(workflowId) {
      // Mirrors the SQL structural filter: scheduled triggers only.
      return rows.filter(
        (r) => r.workflowId === workflowId && r.channelType === 'workflow' && r.workflowStepRunId === null,
      )
    },
    async listFiringJobsForWorkflowSystem(workflowId) {
      // All firing rows, any channel (includes messaging/doc reminder rows).
      return rows.filter((r) => r.workflowId === workflowId && r.workflowStepRunId === null)
    },
  }
}

function makeContext(over: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: USER_ID,
    assistantId: PRIMARY_ASSISTANT_ID,
    sessionId: 'sess',
    appId: 'sidanclaw',
    channelType: 'web',
    channelId: 'web',
    workspaceId: WORKSPACE_ID,
    abortSignal: new AbortController().signal,
    ...over,
  }
}

const SAMPLE_WORKFLOW: WorkflowRecord = {
  id: '00000000-0000-0000-0000-000000000099',
  workspaceId: WORKSPACE_ID,
  createdBy: USER_ID,
  name: 'morning briefing',
  description: null,
  definition: {
    startStepId: 'a',
    steps: [{ id: 'a', type: 'tool_call', toolName: 'noop', arguments: {} }],
  },
  enabled: true,
  trigger: { kind: 'manual' },
  webhookSlug: null,
  webhookSecret: null,
  modelAlias: 'standard',
  maxTurns: null,
  researchMode: false,
  nameManuallySet: false,
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe('[COMP:workflow/scheduled-trigger] scheduleWorkflow tool', () => {
  it('creates a scheduled_jobs row with workflow_id set + workflow_step_run_id null', async () => {
    const jobStore = makeJobStore()
    const tool = createScheduleWorkflowTool({
      workflowStore: makeWorkflowStore([SAMPLE_WORKFLOW]),
      jobStore,
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
    })
    const result = await tool.execute(
      {
        workflowId: SAMPLE_WORKFLOW.id,
        schedule: { type: 'daily', time: '08:00' },
        timezone: 'Asia/Hong_Kong',
        input: { topic: 'today' },
      },
      makeContext(),
    )
    expect(result.isError).toBeFalsy()
    expect(jobStore.rows).toHaveLength(1)
    const job = jobStore.rows[0]
    expect(job.workflowId).toBe(SAMPLE_WORKFLOW.id)
    expect(job.workflowStepRunId).toBeNull()
    expect(job.channelType).toBe('workflow')
    expect(job.assistantId).toBe(PRIMARY_ASSISTANT_ID)
    // Trigger payload encoded into instructions JSON.
    const parsed = JSON.parse(job.instructions)
    expect(parsed.kind).toBe('workflow_trigger')
    expect(parsed.workflowId).toBe(SAMPLE_WORKFLOW.id)
    expect(parsed.input).toEqual({ topic: 'today' })
  })

  it('mirrors the schedule onto workflows.trigger so the builder shows "Scheduled"', async () => {
    const jobStore = makeJobStore()
    const workflowStore = makeWorkflowStore([SAMPLE_WORKFLOW])
    const tool = createScheduleWorkflowTool({
      workflowStore,
      jobStore,
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
    })
    const result = await tool.execute(
      {
        workflowId: SAMPLE_WORKFLOW.id,
        schedule: { type: 'cron', expression: '0 * * * *' },
        timezone: 'Asia/Hong_Kong',
      },
      makeContext(),
    )
    expect(result.isError).toBeFalsy()
    const updated = await workflowStore.getById(USER_ID, SAMPLE_WORKFLOW.id)
    expect(updated?.trigger).toEqual({
      kind: 'schedule',
      schedule: { type: 'cron', expression: '0 * * * *' },
      timezone: 'Asia/Hong_Kong',
    })
  })

  it('is idempotent — re-scheduling replaces the existing job instead of stacking a duplicate', async () => {
    const jobStore = makeJobStore()
    const tool = createScheduleWorkflowTool({
      workflowStore: makeWorkflowStore([SAMPLE_WORKFLOW]),
      jobStore,
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
    })
    const call = (expression: string) =>
      tool.execute(
        { workflowId: SAMPLE_WORKFLOW.id, schedule: { type: 'cron', expression } },
        makeContext(),
      )
    await call('0 * * * *')
    await call('0 9 * * *')
    // Two calls → still one job row, carrying the latest schedule.
    expect(jobStore.rows).toHaveLength(1)
    expect(jobStore.rows[0].schedule).toEqual({ type: 'cron', expression: '0 9 * * *' })
  })

  it('idempotency is cross-member — a teammate re-scheduling replaces another member\'s trigger', async () => {
    // The pre-fix guard listed only the CALLER's jobs, so member B
    // re-scheduling a workflow whose trigger member A created stacked a
    // second hourly fire (the 2026-06-10 incident's duplicate pair).
    const jobStore = makeJobStore()
    const tool = createScheduleWorkflowTool({
      workflowStore: makeWorkflowStore([SAMPLE_WORKFLOW]),
      jobStore,
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
    })
    // Member A creates the trigger.
    await tool.execute(
      { workflowId: SAMPLE_WORKFLOW.id, schedule: { type: 'cron', expression: '0 * * * *' } },
      makeContext(),
    )
    // Member B (different userId, same workspace) re-schedules it daily.
    await tool.execute(
      { workflowId: SAMPLE_WORKFLOW.id, schedule: { type: 'daily', time: '09:00' } },
      makeContext({ userId: '00000000-0000-0000-0000-00000000beef' }),
    )
    expect(jobStore.rows).toHaveLength(1)
    expect(jobStore.rows[0].schedule).toEqual({ type: 'daily', time: '09:00' })
  })

  it('reaps pre-existing duplicate jobs left by calls before the idempotency guard', async () => {
    const jobStore = makeJobStore()
    // Seed two duplicate scheduled-trigger rows (the prod state this fixes).
    for (let i = 0; i < 2; i++) {
      await jobStore.create({
        assistantId: PRIMARY_ASSISTANT_ID,
        userId: USER_ID,
        schedule: { type: 'cron', expression: '0 * * * *' },
        timezone: 'Asia/Hong_Kong',
        instructions: '{}',
        channelType: 'workflow',
        channelId: SAMPLE_WORKFLOW.id,
        nextRunAt: new Date(),
        workflowId: SAMPLE_WORKFLOW.id,
        workflowStepRunId: null,
      })
    }
    expect(jobStore.rows).toHaveLength(2)
    const tool = createScheduleWorkflowTool({
      workflowStore: makeWorkflowStore([SAMPLE_WORKFLOW]),
      jobStore,
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
    })
    await tool.execute(
      { workflowId: SAMPLE_WORKFLOW.id, schedule: { type: 'daily', time: '08:00' } },
      makeContext(),
    )
    // Collapsed back to a single job row.
    expect(jobStore.rows).toHaveLength(1)
    expect(jobStore.rows[0].schedule).toEqual({ type: 'daily', time: '08:00' })
  })

  it('rejects when workflow is not in workspace', async () => {
    const jobStore = makeJobStore()
    const tool = createScheduleWorkflowTool({
      workflowStore: makeWorkflowStore([SAMPLE_WORKFLOW]),
      jobStore,
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
    })
    const result = await tool.execute(
      {
        workflowId: SAMPLE_WORKFLOW.id,
        schedule: { type: 'daily', time: '08:00' },
      },
      makeContext({ workspaceId: '00000000-0000-0000-0000-000000000088' }),
    )
    expect(result.isError).toBe(true)
    expect(jobStore.rows).toHaveLength(0)
  })

  it('rejects when workspace has no primary assistant', async () => {
    const jobStore = makeJobStore()
    const tool = createScheduleWorkflowTool({
      workflowStore: makeWorkflowStore([SAMPLE_WORKFLOW]),
      jobStore,
      resolvePrimary: async () => null,
    })
    const result = await tool.execute(
      {
        workflowId: SAMPLE_WORKFLOW.id,
        schedule: { type: 'once', datetime: '2030-01-01T00:00:00' },
      },
      makeContext(),
    )
    expect(result.isError).toBe(true)
  })
})

describe('[COMP:workflow/scheduled-trigger] syncWorkflowScheduleTrigger policy pass-through', () => {
  it('writes mode / silent / nag / viewId onto a new trigger row', async () => {
    const jobStore = makeJobStore()
    const res = await syncWorkflowScheduleTrigger(
      { jobStore, resolvePrimary: async () => PRIMARY_ASSISTANT_ID },
      {
        workflowId: SAMPLE_WORKFLOW.id,
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        schedule: { type: 'daily', time: '08:00' },
        timezone: 'Asia/Hong_Kong',
        mode: 'user',
        silentUntilFire: true,
        nagIntervalMins: 15,
        nagUntilKeyword: 'done',
        viewId: '00000000-0000-0000-0000-0000000000aa',
      },
    )
    expect('jobId' in res).toBe(true)
    expect(jobStore.rows).toHaveLength(1)
    const job = jobStore.rows[0]
    expect(job.mode).toBe('user')
    expect(job.silentUntilFire).toBe(true)
    expect(job.nagIntervalMins).toBe(15)
    expect(job.nagUntilKeyword).toBe('done')
    expect(job.viewId).toBe('00000000-0000-0000-0000-0000000000aa')
    expect(job.channelType).toBe('workflow')
  })

  it('does not clobber existing policy on a plain reschedule (omitted fields preserved)', async () => {
    const jobStore = makeJobStore()
    const deps = { jobStore, resolvePrimary: async () => PRIMARY_ASSISTANT_ID }
    await syncWorkflowScheduleTrigger(deps, {
      workflowId: SAMPLE_WORKFLOW.id,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      schedule: { type: 'daily', time: '08:00' },
      timezone: 'Asia/Hong_Kong',
      mode: 'user',
      silentUntilFire: true,
    })
    // Reschedule only — no policy fields passed. mode + silent must survive.
    await syncWorkflowScheduleTrigger(deps, {
      workflowId: SAMPLE_WORKFLOW.id,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      schedule: { type: 'daily', time: '09:00' },
      timezone: 'Asia/Hong_Kong',
    })
    expect(jobStore.rows).toHaveLength(1)
    expect(jobStore.rows[0].mode).toBe('user')
    expect(jobStore.rows[0].silentUntilFire).toBe(true)
    expect(jobStore.rows[0].schedule).toEqual({ type: 'daily', time: '09:00' })
  })
})
