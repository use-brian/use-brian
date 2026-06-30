import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createWorkflowTools, type WorkflowToolEvent } from '../tools.js'
import type {
  WorkflowDefinition,
  WorkflowRecord,
  WorkflowRunRecord,
  WorkflowRunStore,
  WorkflowStepRunRecord,
  WorkflowStore,
} from '../types.js'
import { buildTool, type Tool, type ToolContext } from '../../tools/types.js'
import type { ConsultRequest, ConsultResponse, ConsultTransport } from '../../a2a/types.js'
import type { JobStore, ScheduledJob } from '../../scheduling/types.js'
import type { DeliverToChannel } from '../executor.js'

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'
const PRIMARY_ASSISTANT_ID = '00000000-0000-0000-0000-000000000002'
const USER_ID = '00000000-0000-0000-0000-000000000003'

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: USER_ID,
    assistantId: PRIMARY_ASSISTANT_ID,
    sessionId: 'sess',
    appId: 'sidanclaw',
    channelType: 'web',
    channelId: 'web',
    workspaceId: WORKSPACE_ID,
    abortSignal: new AbortController().signal,
    ...overrides,
  }
}

function fakeStores() {
  const workflows = new Map<string, WorkflowRecord>()
  const runs = new Map<string, WorkflowRunRecord>()
  const stepRuns: WorkflowStepRunRecord[] = []
  let n = 100
  const id = () => `00000000-0000-0000-0000-${String(n++).padStart(12, '0')}`
  const workflowStore: WorkflowStore = {
    async create(params) {
      const { workspaceId, userId, name, definition, description, trigger, webhookSlug, webhookSecret } = params
      const now = new Date()
      const r: WorkflowRecord = {
        id: id(), workspaceId, createdBy: userId, name, description: description ?? null,
        definition, enabled: true,
        trigger: trigger ?? { kind: 'manual' },
        webhookSlug: webhookSlug ?? null,
        webhookSecret: webhookSecret ?? null,
        modelAlias: params.modelAlias ?? 'standard',
        maxTurns: params.maxTurns ?? null,
        researchMode: params.researchMode ?? false,
        nameManuallySet: false,
        createdAt: now, updatedAt: now,
      }
      workflows.set(r.id, r)
      return r
    },
    async getById(_u, i) { return workflows.get(i) ?? null },
    async list(_u, w) { return [...workflows.values()].filter((x) => x.workspaceId === w) },
    async update(_u, i, fields) {
      const e = workflows.get(i); if (!e) return null
      const u: WorkflowRecord = { ...e, ...fields, updatedAt: new Date() } as WorkflowRecord
      workflows.set(i, u); return u
    },
    async delete(_u, i) { return workflows.delete(i) },
    async findByWebhookSlugSystem(slug) {
      return [...workflows.values()].find((x) => x.webhookSlug === slug && x.enabled) ?? null
    },
    async findByIdSystem(id) {
      return workflows.get(id) ?? null
    },
    async updateAutoName(_u, i, name) {
      const e = workflows.get(i); if (!e || e.nameManuallySet) return false
      workflows.set(i, { ...e, name, updatedAt: new Date() })
      return true
    },
  }
  const runStore: WorkflowRunStore = {
    async createRun({ workflowId, workspaceId, triggeredBy, triggerKind, input }) {
      const now = new Date()
      const r: WorkflowRunRecord = {
        id: id(), workflowId, workspaceId, triggeredBy, triggerKind,
        status: 'pending', input: input ?? {}, vars: {}, currentStepId: null,
        error: null, outcome: null, startedAt: now, finishedAt: null, lastActiveAt: now,
      }
      runs.set(r.id, r); return r
    },
    async getRunById(_u, i) { return runs.get(i) ?? null },
    async getRunSystem(i) { return runs.get(i) ?? null },
    async updateRun(i, fields) {
      const e = runs.get(i); if (!e) return null
      const u = { ...e, ...fields, lastActiveAt: new Date() }
      runs.set(i, u); return u
    },
    async createStepRun({ runId, stepId, stepType, input }) {
      const now = new Date()
      const r: WorkflowStepRunRecord = {
        id: id(), runId, stepId, stepType, status: 'running',
        input: input ?? {}, output: null, error: null,
        startedAt: now, finishedAt: null,
      }
      stepRuns.push(r); return r
    },
    async updateStepRun(i, fields) {
      const idx = stepRuns.findIndex((s) => s.id === i)
      if (idx === -1) return null
      stepRuns[idx] = { ...stepRuns[idx], ...fields }
      return stepRuns[idx]
    },
    async listStepRuns(_u, runId) { return stepRuns.filter((s) => s.runId === runId) },
    async listRunsForWorkflow(_u, workflowId, opts) {
      const filtered = Array.from(runs.values()).filter((r) =>
        r.workflowId === workflowId
        && (!opts?.status || opts.status.includes(r.status)),
      )
      return filtered
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
        .slice(0, opts?.limit ?? 50)
    },
    listRunsForPage: async () => [],
    async getLatestOutcomeForWorkflowSystem(workflowId, excludeRunId) {
      const terminal = Array.from(runs.values())
        .filter(
          (r) =>
            r.workflowId === workflowId &&
            r.id !== excludeRunId &&
            (r.status === 'completed' || r.status === 'failed' || r.status === 'timeout'),
        )
        .sort(
          (a, b) =>
            (b.finishedAt ?? b.startedAt).getTime() - (a.finishedAt ?? a.startedAt).getTime(),
        )
      return terminal[0]?.outcome ?? null
    },
  }
  return { workflowStore, runStore, workflows, runs, stepRuns }
}

function fakeConsultTransport(text = 'response'): ConsultTransport {
  return {
    async send(_req: ConsultRequest): Promise<ConsultResponse> {
      return {
        task: {
          taskId: 't', contextId: 'c',
          status: { state: 'completed', timestamp: new Date().toISOString() },
          artifacts: [],
          history: [{ messageId: 'm', role: 'agent', parts: [{ kind: 'text', text }] }],
        },
      }
    },
  }
}

const ECHO_TOOL: Tool = buildTool({
  name: 'echo',
  description: 'echo',
  inputSchema: z.object({}).passthrough(),
  async execute(input) { return { data: input } },
})

function makeJobStore(overrides: Partial<JobStore> = {}): JobStore & { rows: ScheduledJob[] } {
  const rows: ScheduledJob[] = []
  let n = 500
  return {
    rows,
    async create(params) {
      const job: ScheduledJob = {
        id: `00000000-0000-0000-0000-${String(n++).padStart(12, '0')}`,
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
    async get(id) {
      return rows.find((r) => r.id === id) ?? null
    },
    async list() {
      return rows
    },
    async listEnabledByView() {
      return []
    },
    async getDueJobs() {
      return []
    },
    async markCompleted() {},
    async markFailed() {},
    async setState() {},
    async listActiveNagsForUser() {
      return []
    },
    async purgeDisabledOlderThan() {
      return 0
    },
    async countEnabledRecurring() {
      return 0
    },
    async search() {
      return { jobs: [], nextCursor: null }
    },
    async listTriggerJobsForWorkflowSystem(workflowId) {
      return rows.filter(
        (r) => r.workflowId === workflowId && r.channelType === 'workflow' && r.workflowStepRunId === null,
      )
    },
    async listFiringJobsForWorkflowSystem(workflowId) {
      return rows.filter((r) => r.workflowId === workflowId && r.workflowStepRunId === null)
    },
    ...overrides,
  }
}

function makeAllTools(opts?: {
  isKnownTool?: (name: string) => boolean
  resolvePageAnchor?: (
    userId: string,
    pageId: string,
  ) => Promise<{ workspaceId: string; state: 'draft' | 'saved'; name: string } | null>
  deliverToChannel?: DeliverToChannel
  jobStore?: JobStore & { rows: ScheduledJob[] }
  validateDeliveryTarget?: (args: {
    assistantId: string
    channelType: 'telegram' | 'slack' | 'whatsapp'
    channelId: string
  }) => Promise<{ ok: boolean; reason?: string }>
  preflightConnectorTool?: (args: {
    userId: string
    toolName: string
  }) => Promise<{ ok: boolean; provider: string; reason?: string } | null>
}) {
  const events: WorkflowToolEvent[] = []
  const stores = fakeStores()
  const jobStore = opts?.jobStore ?? makeJobStore()
  const tools = createWorkflowTools({
    workflowStore: stores.workflowStore,
    runStore: stores.runStore,
    executorDeps: {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: fakeConsultTransport('hello'),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map([['echo', ECHO_TOOL]]),
    },
    onEvent: (e) => events.push(e),
    resolvePageAnchor: opts?.resolvePageAnchor,
    isKnownTool: opts?.isKnownTool,
    // Scheduling substrate (scheduling-authoring-unification).
    jobStore,
    resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
    deliverToChannel: opts?.deliverToChannel,
    resolveViewWorkspace: async () => WORKSPACE_ID,
    validateDeliveryTarget: opts?.validateDeliveryTarget,
    preflightConnectorTool: opts?.preflightConnectorTool,
  })
  return { tools, stores, events, jobStore }
}

const SIMPLE_DEF: WorkflowDefinition = {
  startStepId: 's1',
  steps: [
    { id: 's1', type: 'tool_call', toolName: 'echo', arguments: { hello: 'world' } },
  ],
}

describe('[COMP:workflow/tools] inline schedule trigger', () => {
  const ASSISTANT_DEF: WorkflowDefinition = {
    startStepId: 's1',
    steps: [
      { id: 's1', type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'Give me a morning brief.' },
    ],
  }

  it('createWorkflow + schedule + delivery makes a private reminder row, stamps step.deliver, and pings', async () => {
    const delivered: Array<{ channelType: string; channelId: string }> = []
    const deliverToChannel: DeliverToChannel = async (p) => {
      delivered.push({ channelType: p.channelType, channelId: p.channelId })
      return { status: 'delivered', channelType: p.channelType, channelId: p.channelId }
    }
    const { tools, stores, jobStore } = makeAllTools({ deliverToChannel })
    const r = await tools.createWorkflow.execute(
      {
        name: 'Morning brief',
        definition: ASSISTANT_DEF,
        trigger: {
          kind: 'schedule',
          schedule: { type: 'daily', time: '08:00' },
          timezone: 'Asia/Hong_Kong',
          delivery: { channel: 'telegram' },
        },
      },
      makeContext({ channelType: 'telegram', channelId: 'tg-chat-1' }),
    )
    expect(r.isError).toBeFalsy()
    const data = r.data as Record<string, unknown>
    expect(data.triggerKind).toBe('schedule')
    expect(data.nextRun).toBeTruthy()
    expect(data.deliveryChannel).toBe('telegram')
    expect(data.confirmationSent).toBe(true)
    // Private reminder row (channelType=messaging), pointing at the workflow.
    expect(jobStore.rows).toHaveLength(1)
    expect(jobStore.rows[0].channelType).toBe('telegram')
    expect(jobStore.rows[0].channelId).toBe('tg-chat-1')
    expect(jobStore.rows[0].workflowId).toBe(data.id)
    // The terminal assistant_call step carries the resolved deliver target.
    const wf = stores.workflows.get(data.id as string)!
    expect((wf.definition.steps[0] as { deliver?: unknown }).deliver).toEqual({
      channelType: 'telegram',
      channelId: 'tg-chat-1',
    })
    // workflows.trigger mirrors the schedule (builder shows "Scheduled").
    expect(wf.trigger.kind).toBe('schedule')
    // The confirmation ping landed in the channel.
    expect(delivered).toEqual([{ channelType: 'telegram', channelId: 'tg-chat-1' }])
  })

  it('createWorkflow + schedule with NO delivery makes a workspace-visible workflow-trigger row', async () => {
    const { tools, jobStore } = makeAllTools()
    const def: WorkflowDefinition = {
      startStepId: 'a',
      steps: [
        { id: 'a', type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'do research', nextStepId: 'b' },
        { id: 'b', type: 'tool_call', toolName: 'echo', arguments: {} },
      ],
    }
    const r = await tools.createWorkflow.execute(
      {
        name: 'Weekly research',
        definition: def,
        trigger: { kind: 'schedule', schedule: { type: 'weekly', days: ['monday'], time: '09:00' } },
      },
      makeContext(),
    )
    expect(r.isError).toBeFalsy()
    expect(jobStore.rows).toHaveLength(1)
    expect(jobStore.rows[0].channelType).toBe('workflow')
    expect(jobStore.rows[0].workflowStepRunId).toBeNull()
  })

  it('createWorkflow carries nag + silent policy onto the trigger row', async () => {
    const { tools, jobStore } = makeAllTools({
      deliverToChannel: async (p) => ({ status: 'delivered', channelType: p.channelType, channelId: p.channelId }),
    })
    await tools.createWorkflow.execute(
      {
        name: 'Nagger',
        definition: ASSISTANT_DEF,
        trigger: {
          kind: 'schedule',
          schedule: { type: 'daily', time: '08:00' },
          delivery: { channel: 'telegram' },
          policy: { silentUntilFire: true, nagIntervalMins: 15, nagUntilKeyword: 'done' },
        },
      },
      makeContext({ channelType: 'telegram', channelId: 'tg' }),
    )
    expect(jobStore.rows[0].silentUntilFire).toBe(true)
    expect(jobStore.rows[0].nagIntervalMins).toBe(15)
    expect(jobStore.rows[0].nagUntilKeyword).toBe('done')
  })

  it('createWorkflow rejects a recurring schedule when over the per-user cap (no orphan workflow)', async () => {
    const jobStore = makeJobStore({ countEnabledRecurring: async () => 100 })
    const { tools, stores } = makeAllTools({ jobStore })
    const r = await tools.createWorkflow.execute(
      {
        name: 'Capped',
        definition: ASSISTANT_DEF,
        trigger: { kind: 'schedule', schedule: { type: 'daily', time: '08:00' }, delivery: { channel: 'telegram' } },
      },
      makeContext({ channelType: 'telegram', channelId: 'tg' }),
    )
    expect(r.isError).toBe(true)
    expect(String(r.data)).toContain('cap of 100')
    expect(stores.workflows.size).toBe(0)
    expect(jobStore.rows).toHaveLength(0)
  })

  it('createWorkflow errors when trigger.delivery is set but there is no assistant_call step', async () => {
    const { tools } = makeAllTools()
    const r = await tools.createWorkflow.execute(
      {
        name: 'No assistant',
        definition: SIMPLE_DEF,
        trigger: { kind: 'schedule', schedule: { type: 'daily', time: '08:00' }, delivery: { channel: 'telegram' } },
      },
      makeContext({ channelType: 'telegram', channelId: 'tg' }),
    )
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.data)).toContain('no assistant_call step')
  })

  it('updateWorkflow attaches a schedule trigger (workflow-trigger row) and clears it on manual', async () => {
    const { tools, jobStore } = makeAllTools()
    const created = await tools.createWorkflow.execute({ name: 'W', definition: ASSISTANT_DEF }, makeContext())
    const id = (created.data as { id: string }).id
    const up = await tools.updateWorkflow.execute(
      { workflowId: id, trigger: { kind: 'schedule', schedule: { type: 'daily', time: '07:00' } } },
      makeContext(),
    )
    expect(up.isError).toBeFalsy()
    expect((up.data as Record<string, unknown>).triggerKind).toBe('schedule')
    expect(jobStore.rows.filter((j) => j.channelType === 'workflow')).toHaveLength(1)

    const back = await tools.updateWorkflow.execute(
      { workflowId: id, trigger: { kind: 'manual' } },
      makeContext(),
    )
    expect(back.isError).toBeFalsy()
    expect(jobStore.rows.filter((j) => j.channelType === 'workflow')).toHaveLength(0)
  })

  it('updateWorkflow reschedules a reminder-backed workflow to exactly one firing row (no double delivery)', async () => {
    // Scheduling is a workflow trigger — there is no separate "scheduled job".
    // A reminder fires from a messaging-channel row that syncWorkflowScheduleTrigger
    // does not own, so updateWorkflow reconciles a reminder reschedule by
    // clearing every firing row for the workflow and re-applying via the proven
    // create path (applyScheduleTrigger). The safety invariant is exactly one
    // firing row afterward — never a second ('workflow') row alongside the
    // reminder row, which would double-deliver. (scheduling-authoring-unification §3.)
    const { tools, jobStore } = makeAllTools({
      deliverToChannel: async (p) => ({ status: 'delivered', channelType: p.channelType, channelId: p.channelId }),
    })
    const created = await tools.createWorkflow.execute(
      {
        name: 'Reminder',
        definition: ASSISTANT_DEF,
        trigger: { kind: 'schedule', schedule: { type: 'daily', time: '08:00' }, delivery: { channel: 'telegram' } },
      },
      makeContext({ channelType: 'telegram', channelId: 'tg' }),
    )
    const id = (created.data as { id: string }).id
    expect(jobStore.rows.filter((r) => r.workflowId === id)).toHaveLength(1)

    const up = await tools.updateWorkflow.execute(
      { workflowId: id, trigger: { kind: 'schedule', schedule: { type: 'daily', time: '09:00' }, delivery: { channel: 'telegram' } } },
      makeContext({ channelType: 'telegram', channelId: 'tg' }),
    )
    expect(up.isError).toBeFalsy()
    // The safety invariant: still exactly one firing row, and it still delivers
    // to the messaging channel (the reminder shape was preserved, not duplicated).
    const firing = jobStore.rows.filter((r) => r.workflowId === id && r.workflowStepRunId == null)
    expect(firing).toHaveLength(1)
    expect(firing[0].channelType).toBe('telegram')
  })

  it('proposeWorkflow warns when trigger.delivery is set on a multi-step workflow', async () => {
    const { tools } = makeAllTools()
    const def: WorkflowDefinition = {
      startStepId: 'a',
      steps: [
        { id: 'a', type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'one', nextStepId: 'b' },
        { id: 'b', type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'two' },
      ],
    }
    const r = await tools.proposeWorkflow.execute(
      {
        name: 'Multi',
        definition: def,
        trigger: { kind: 'schedule', schedule: { type: 'daily', time: '08:00' }, delivery: { channel: 'telegram' } },
      },
      makeContext(),
    )
    const warnings = (r.data as { warnings: string[] }).warnings
    expect(warnings.some((w) => w.includes('LAST assistant_call'))).toBe(true)
  })
})

describe('[COMP:workflow/tools] createWorkflowTools', () => {
  it('proposeWorkflow validates and returns a summary', async () => {
    const { tools } = makeAllTools()
    const r = await tools.proposeWorkflow.execute({ name: 'X', definition: SIMPLE_DEF }, makeContext())
    expect(r.isError).toBeFalsy()
    const data = r.data as Record<string, unknown>
    expect(data.ok).toBe(true)
    expect(data.proposedName).toBe('X')
    expect(data.summary).toContain('echo')
    expect(data.warnings).toEqual([])
  })

  it('proposeWorkflow surfaces a wait warning in Phase A', async () => {
    const { tools } = makeAllTools()
    const r = await tools.proposeWorkflow.execute({
      name: 'W',
      definition: {
        startStepId: 's',
        steps: [{ id: 's', type: 'wait', until: { duration: { minutes: 5 } } }],
      },
    }, makeContext())
    const data = r.data as Record<string, unknown>
    const warnings = data.warnings as string[]
    expect(warnings.some((w) => w.includes('Phase B'))).toBe(true)
  })

  it('proposeWorkflow warns when an assistant_call delivers to the web channel', async () => {
    const { tools } = makeAllTools()
    const r = await tools.proposeWorkflow.execute({
      name: 'W',
      definition: {
        startStepId: 's',
        steps: [
          {
            id: 's',
            type: 'assistant_call',
            target: { assistantId: 'primary' },
            prompt: 'brief me',
            deliver: { channelType: 'web', channelId: 'notifications' },
          },
        ],
      },
    }, makeContext())
    const warnings = (r.data as Record<string, unknown>).warnings as string[]
    expect(warnings.some((w) => w.includes('`web`') && w.includes('not'))).toBe(true)
  })

  it('proposeWorkflow warns when a non-recurring workflow stores into a reserved cross-run var name', async () => {
    const { tools } = makeAllTools()
    const r = await tools.proposeWorkflow.execute({
      name: 'W',
      definition: {
        startStepId: 's',
        steps: [{ id: 's', type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'summarize', storeOutputAs: 'summary' }],
      },
      // manual (default) trigger — one-shot, so the capture has no next run to reach.
    }, makeContext())
    const warnings = (r.data as { warnings: string[] }).warnings
    expect(warnings.some((w) => w.includes('reserved cross-run hand-off') && w.includes('summary'))).toBe(true)
  })

  it('proposeWorkflow stays quiet about a reserved var name on a recurring workflow (intended hand-off)', async () => {
    const { tools } = makeAllTools()
    const r = await tools.proposeWorkflow.execute({
      name: 'W',
      definition: {
        startStepId: 's',
        steps: [{ id: 's', type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'summarize', storeOutputAs: 'todo' }],
      },
      trigger: { kind: 'schedule', schedule: { type: 'daily', time: '08:00' } },
    }, makeContext())
    const warnings = (r.data as { warnings: string[] }).warnings
    expect(warnings.some((w) => w.includes('reserved cross-run hand-off'))).toBe(false)
  })

  it('proposeWorkflow warns on doc-editing prose with no page anchor', async () => {
    const { tools } = makeAllTools()
    const r = await tools.proposeWorkflow.execute({
      name: 'W',
      definition: {
        startStepId: 's',
        steps: [
          {
            id: 's',
            type: 'assistant_call',
            target: { assistantId: 'primary' },
            // The 888df1ae moat-research failure shape: tells the callee to
            // patch a page in prose, but no `page` anchor → no doc tools.
            prompt: 'Review the page 1677641b-6034-4dde-aa94-49cdd82b6b07 and use patchPage to update it.',
          },
        ],
      },
    }, makeContext())
    const warnings = (r.data as Record<string, unknown>).warnings as string[]
    expect(warnings.some((w) => w.includes('page') && w.includes('anchor'))).toBe(true)
  })

  it('proposeWorkflow does NOT warn about doc work when a page anchor is present', async () => {
    const { tools } = makeAllTools()
    const r = await tools.proposeWorkflow.execute({
      name: 'W',
      definition: {
        startStepId: 's',
        steps: [
          {
            id: 's',
            type: 'assistant_call',
            target: { assistantId: 'primary' },
            prompt: 'Use patchPage to update the page.',
            page: { id: '1677641b-6034-4dde-aa94-49cdd82b6b07' },
          },
        ],
      },
    }, makeContext())
    const warnings = (r.data as Record<string, unknown>).warnings as string[]
    expect(warnings.some((w) => w.includes('no `page` anchor'))).toBe(false)
  })

  it('proposeWorkflow warns on a tool_call naming an unknown tool', async () => {
    const { tools } = makeAllTools({ isKnownTool: (n) => n === 'echo' })
    const r = await tools.proposeWorkflow.execute({
      name: 'W',
      definition: {
        startStepId: 's',
        steps: [{ id: 's', type: 'tool_call', toolName: 'search', arguments: {} }],
      },
    }, makeContext())
    const warnings = (r.data as Record<string, unknown>).warnings as string[]
    expect(warnings.some((w) => w.includes('search') && w.includes('tool_not_found'))).toBe(true)
  })

  it('proposeWorkflow does NOT warn on a tool_call naming a known tool', async () => {
    const { tools } = makeAllTools({ isKnownTool: (n) => n === 'echo' })
    const r = await tools.proposeWorkflow.execute({ name: 'X', definition: SIMPLE_DEF }, makeContext())
    const warnings = (r.data as Record<string, unknown>).warnings as string[]
    expect(warnings.some((w) => w.includes('tool_not_found'))).toBe(false)
  })

  it('proposeWorkflow rejects malformed definitions', async () => {
    const { tools } = makeAllTools()
    const r = await tools.proposeWorkflow.execute({
      name: 'bad',
      definition: { startStepId: 'x', steps: [] },
    }, makeContext())
    expect(r.isError).toBe(true)
  })

  it('createWorkflow persists, emits event, and returns id', async () => {
    const { tools, events, stores } = makeAllTools()
    const r = await tools.createWorkflow.execute(
      { name: 'briefing', definition: SIMPLE_DEF },
      makeContext(),
    )
    expect(r.isError).toBeFalsy()
    const data = r.data as Record<string, unknown>
    expect(typeof data.id).toBe('string')
    expect(events.find((e) => e.type === 'workflow_created')).toBeTruthy()
    expect(stores.workflows.size).toBe(1)
  })

  it('createWorkflow rejects when no workspace is in context', async () => {
    const { tools } = makeAllTools()
    const r = await tools.createWorkflow.execute(
      { name: 'x', definition: SIMPLE_DEF },
      makeContext({ workspaceId: null }),
    )
    expect(r.isError).toBe(true)
  })

  it('runWorkflow executes the workflow synchronously and returns step trail', async () => {
    const { tools, events } = makeAllTools()
    const created = await tools.createWorkflow.execute(
      { name: 'briefing', definition: SIMPLE_DEF },
      makeContext(),
    )
    const wf = created.data as { id: string }

    const r = await tools.runWorkflow.execute({ workflowId: wf.id }, makeContext())
    expect(r.isError).toBeFalsy()
    const data = r.data as Record<string, unknown>
    expect(data.status).toBe('completed')
    expect(data.workflowName).toBe('briefing')
    expect((data.steps as unknown[]).length).toBe(1)
    expect(events.find((e) => e.type === 'workflow_run_started')).toBeTruthy()
  })

  it('runWorkflow returns isError + failed status when a step fails', async () => {
    const stores = fakeStores()
    const failingTool: Tool = buildTool({
      name: 'fail',
      description: 'fail',
      inputSchema: z.object({}).passthrough(),
      async execute() { return { data: 'nope', isError: true } },
    })
    const tools = createWorkflowTools({
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      executorDeps: {
        workflowStore: stores.workflowStore,
        runStore: stores.runStore,
        consultTransport: fakeConsultTransport(),
        resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
        buildToolRegistry: async () => new Map([['fail', failingTool]]),
      },
    })
    const created = await tools.createWorkflow.execute(
      {
        name: 'bad',
        definition: {
          startStepId: 's', steps: [{ id: 's', type: 'tool_call', toolName: 'fail', arguments: {} }],
        },
      },
      makeContext(),
    )
    const wf = created.data as { id: string }
    const r = await tools.runWorkflow.execute({ workflowId: wf.id }, makeContext())
    expect(r.isError).toBe(true)
    const data = r.data as Record<string, unknown>
    expect(data.status).toBe('failed')
  })

  it('listWorkflows is workspace-scoped', async () => {
    const { tools } = makeAllTools()
    await tools.createWorkflow.execute({ name: 'one', definition: SIMPLE_DEF }, makeContext())
    await tools.createWorkflow.execute({ name: 'two', definition: SIMPLE_DEF }, makeContext())
    const r = await tools.listWorkflows.execute({}, makeContext())
    const data = r.data as Array<{ name: string }>
    expect(data.length).toBe(2)
    expect(data.map((d) => d.name).sort()).toEqual(['one', 'two'])
  })

  it('getWorkflowRun returns the step trail for a run', async () => {
    const { tools } = makeAllTools()
    const created = await tools.createWorkflow.execute(
      { name: 'x', definition: SIMPLE_DEF },
      makeContext(),
    )
    const wf = created.data as { id: string }
    const ran = await tools.runWorkflow.execute({ workflowId: wf.id }, makeContext())
    const runData = ran.data as { runId: string }

    const r = await tools.getWorkflowRun.execute({ runId: runData.runId }, makeContext())
    expect(r.isError).toBeFalsy()
    const data = r.data as Record<string, unknown>
    expect(data.workflowName).toBe('x')
    expect(data.status).toBe('completed')
    expect((data.steps as unknown[]).length).toBe(1)
  })

  it('getWorkflow returns the full definition (read before edit)', async () => {
    const { tools } = makeAllTools()
    const created = await tools.createWorkflow.execute(
      { name: 'editable', definition: SIMPLE_DEF },
      makeContext(),
    )
    const wf = created.data as { id: string }

    const r = await tools.getWorkflow.execute({ workflowId: wf.id }, makeContext())
    expect(r.isError).toBeFalsy()
    const data = r.data as Record<string, unknown>
    expect(data.name).toBe('editable')
    expect(data.enabled).toBe(true)
    expect(data.triggerKind).toBe('manual')
    expect((data.definition as WorkflowDefinition).steps.length).toBe(1)
    // Secrets are never returned.
    expect(data).not.toHaveProperty('webhookSecret')
  })

  it('getWorkflow is workspace-scoped (not visible from another workspace)', async () => {
    const { tools } = makeAllTools()
    const created = await tools.createWorkflow.execute(
      { name: 'mine', definition: SIMPLE_DEF },
      makeContext(),
    )
    const wf = created.data as { id: string }
    const r = await tools.getWorkflow.execute(
      { workflowId: wf.id },
      makeContext({ workspaceId: '00000000-0000-0000-0000-0000000000ff' }),
    )
    expect(r.isError).toBe(true)
  })

  it('updateWorkflow replaces the definition (add + reorder a step) and emits workflow_updated', async () => {
    const { tools, events, stores } = makeAllTools()
    const created = await tools.createWorkflow.execute(
      { name: 'grow', definition: SIMPLE_DEF },
      makeContext(),
    )
    const wf = created.data as { id: string }

    // Add a second step in front of the original — exercises both add and reorder.
    const edited: WorkflowDefinition = {
      startStepId: 's0',
      steps: [
        { id: 's0', type: 'tool_call', toolName: 'echo', arguments: { first: true } },
        { id: 's1', type: 'tool_call', toolName: 'echo', arguments: { hello: 'world' } },
      ],
    }
    const r = await tools.updateWorkflow.execute({ workflowId: wf.id, definition: edited }, makeContext())
    expect(r.isError).toBeFalsy()
    const data = r.data as Record<string, unknown>
    expect(data.stepCount).toBe(2)
    expect(events.find((e) => e.type === 'workflow_updated')).toBeTruthy()
    expect(stores.workflows.get(wf.id)?.definition.startStepId).toBe('s0')
  })

  it('updateWorkflow patches name only (definition untouched, rename pins the title)', async () => {
    const { tools, stores } = makeAllTools()
    const created = await tools.createWorkflow.execute(
      { name: 'old name', definition: SIMPLE_DEF },
      makeContext(),
    )
    const wf = created.data as { id: string }

    const r = await tools.updateWorkflow.execute({ workflowId: wf.id, name: 'new name' }, makeContext())
    expect(r.isError).toBeFalsy()
    const row = stores.workflows.get(wf.id)!
    expect(row.name).toBe('new name')
    expect(row.nameManuallySet).toBe(true)
    expect(row.definition.steps.length).toBe(1) // unchanged
  })

  it('updateWorkflow can disable a workflow', async () => {
    const { tools, stores } = makeAllTools()
    const created = await tools.createWorkflow.execute(
      { name: 'toggle', definition: SIMPLE_DEF },
      makeContext(),
    )
    const wf = created.data as { id: string }
    await tools.updateWorkflow.execute({ workflowId: wf.id, enabled: false }, makeContext())
    expect(stores.workflows.get(wf.id)?.enabled).toBe(false)
  })

  it('updateWorkflow rejects a malformed definition', async () => {
    const { tools } = makeAllTools()
    const created = await tools.createWorkflow.execute(
      { name: 'x', definition: SIMPLE_DEF },
      makeContext(),
    )
    const wf = created.data as { id: string }
    const r = await tools.updateWorkflow.execute(
      { workflowId: wf.id, definition: { startStepId: 'nope', steps: [] } },
      makeContext(),
    )
    expect(r.isError).toBe(true)
  })

  it('updateWorkflow rejects an empty patch', async () => {
    const { tools } = makeAllTools()
    const created = await tools.createWorkflow.execute(
      { name: 'x', definition: SIMPLE_DEF },
      makeContext(),
    )
    const wf = created.data as { id: string }
    const r = await tools.updateWorkflow.execute({ workflowId: wf.id }, makeContext())
    expect(r.isError).toBe(true)
  })

  it('updateWorkflow rejects an unknown workflow', async () => {
    const { tools } = makeAllTools()
    const r = await tools.updateWorkflow.execute(
      { workflowId: '00000000-0000-0000-0000-0000000009ff', name: 'x' },
      makeContext(),
    )
    expect(r.isError).toBe(true)
  })
})

describe('[COMP:workflow/tools] page anchor authoring checks', () => {
  const PAGE_ID = '00000000-0000-0000-0000-00000000aaaa'

  const anchoredDef = (page: unknown, extra: Record<string, unknown> = {}): WorkflowDefinition =>
    ({
      startStepId: 's1',
      steps: [
        {
          id: 's1',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'edit the page',
          page,
          ...extra,
        },
      ],
    }) as WorkflowDefinition

  it('proposeWorkflow fails on a page anchor the resolver cannot find', async () => {
    const { tools } = makeAllTools({ resolvePageAnchor: async () => null })
    const r = await tools.proposeWorkflow.execute(
      { name: 'X', definition: anchoredDef({ id: PAGE_ID }) },
      makeContext(),
    )
    expect(r.isError).toBe(true)
    const data = r.data as { ok: boolean; errors: string[] }
    expect(data.ok).toBe(false)
    expect(data.errors.some((e) => e.startsWith('steps.0.page.id:'))).toBe(true)
  })

  it('proposeWorkflow fails on a cross-workspace page anchor', async () => {
    const { tools } = makeAllTools({
      resolvePageAnchor: async () => ({
        workspaceId: '00000000-0000-0000-0000-00000000ffff',
        state: 'saved',
        name: 'Other workspace page',
      }),
    })
    const r = await tools.proposeWorkflow.execute(
      { name: 'X', definition: anchoredDef({ id: PAGE_ID }) },
      makeContext(),
    )
    expect(r.isError).toBe(true)
    const data = r.data as { errors: string[] }
    expect(data.errors.some((e) => e.includes('not found in this workspace'))).toBe(true)
  })

  it('proposeWorkflow warns (not fails) on a draft page anchor', async () => {
    const { tools } = makeAllTools({
      resolvePageAnchor: async () => ({
        workspaceId: WORKSPACE_ID,
        state: 'draft',
        name: 'My draft',
      }),
    })
    const r = await tools.proposeWorkflow.execute(
      { name: 'X', definition: anchoredDef({ id: PAGE_ID }) },
      makeContext(),
    )
    expect(r.isError).toBeFalsy()
    const data = r.data as { ok: boolean; warnings: string[] }
    expect(data.ok).toBe(true)
    expect(data.warnings.some((w) => w.includes('draft') && w.includes('My draft'))).toBe(true)
  })

  it('proposeWorkflow warns when an anchored step pins a tools allow-list with no doc tool', async () => {
    const { tools } = makeAllTools({
      resolvePageAnchor: async () => ({ workspaceId: WORKSPACE_ID, state: 'saved', name: 'P' }),
    })
    const r = await tools.proposeWorkflow.execute(
      { name: 'X', definition: anchoredDef({ id: PAGE_ID }, { tools: ['webSearch'] }) },
      makeContext(),
    )
    expect(r.isError).toBeFalsy()
    const data = r.data as { warnings: string[] }
    expect(data.warnings.some((w) => w.includes('allow-list'))).toBe(true)
  })

  it('skips the existence check for a template anchor and warns instead (Phase B)', async () => {
    const resolver = vi.fn().mockResolvedValue(null) // would 404 anything it is asked
    const { tools } = makeAllTools({ resolvePageAnchor: resolver })
    const r = await tools.proposeWorkflow.execute(
      { name: 'X', definition: anchoredDef({ id: '{{input.pageId}}' }) },
      makeContext(),
    )
    expect(r.isError).toBeFalsy()
    const data = r.data as { ok: boolean; warnings: string[] }
    expect(data.ok).toBe(true)
    expect(resolver).not.toHaveBeenCalled()
    expect(data.warnings.some((w) => w.includes('resolved at run time'))).toBe(true)
  })

  it('checks nestUnder on create anchors', async () => {
    const { tools } = makeAllTools({ resolvePageAnchor: async () => null })
    const r = await tools.proposeWorkflow.execute(
      { name: 'X', definition: anchoredDef({ create: true, nestUnder: PAGE_ID }) },
      makeContext(),
    )
    expect(r.isError).toBe(true)
    const data = r.data as { errors: string[] }
    expect(data.errors.some((e) => e.startsWith('steps.0.page.nestUnder:'))).toBe(true)
  })

  it('skips store-backed checks when the resolver dep is absent (runtime gate stays authoritative)', async () => {
    const { tools } = makeAllTools()
    const r = await tools.proposeWorkflow.execute(
      { name: 'X', definition: anchoredDef({ id: PAGE_ID }) },
      makeContext(),
    )
    expect(r.isError).toBeFalsy()
    const data = r.data as { ok: boolean; summary: string }
    expect(data.ok).toBe(true)
    // The summary still names the anchor so the user sees the bound intent.
    expect(data.summary).toContain(`edits page ${PAGE_ID}`)
  })

  it('getWorkflow surfaces the ACTUAL trigger jobs with ownedByMe (drift visibility)', async () => {
    // The 2026-06-10 incident shape: workflows.trigger said "manual" while
    // two hourly cron jobs (a teammate's) fired. getWorkflow must show the
    // firing rows so the drift is visible in one read.
    const { tools, stores } = makeAllTools()
    const created = await tools.createWorkflow.execute(
      { name: 'researcher', definition: SIMPLE_DEF },
      makeContext(),
    )
    const wf = created.data as { id: string }
    const toolsWithJobs = createWorkflowTools({
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      executorDeps: {
        workflowStore: stores.workflowStore,
        runStore: stores.runStore,
        consultTransport: fakeConsultTransport('hello'),
        resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
        buildToolRegistry: async () => new Map(),
      },
      listTriggerJobs: async (workflowId) => [
        {
          id: 'job-1',
          schedule: { type: 'cron', expression: '0 * * * *' },
          timezone: 'UTC',
          enabled: true,
          nextRunAt: new Date('2026-06-10T05:00:00Z'),
          lastStatus: 'failed',
          userId: 'u2', // the teammate's
        },
      ],
    })
    const r = await toolsWithJobs.getWorkflow.execute({ workflowId: wf.id }, makeContext())
    expect(r.isError).toBeFalsy()
    const data = r.data as {
      triggerKind: string
      triggerJobs: Array<{ id: string; enabled: boolean; ownedByMe: boolean; nextRun: string }>
    }
    expect(data.triggerKind).toBe('manual') // the drifted display column
    expect(data.triggerJobs).toHaveLength(1) // ...vs the firing reality
    expect(data.triggerJobs[0]).toMatchObject({
      id: 'job-1',
      enabled: true,
      ownedByMe: false,
      nextRun: '2026-06-10T05:00:00.000Z',
    })
  })

  it('createWorkflow and updateWorkflow run the same anchor checks', async () => {
    const { tools } = makeAllTools({ resolvePageAnchor: async () => null })
    const created = await tools.createWorkflow.execute(
      { name: 'X', definition: anchoredDef({ id: PAGE_ID }) },
      makeContext(),
    )
    expect(created.isError).toBe(true)

    // Seed a valid workflow, then try to patch in a dangling anchor.
    const ok = await tools.createWorkflow.execute(
      { name: 'Y', definition: SIMPLE_DEF },
      makeContext(),
    )
    const wf = ok.data as { id: string }
    const updated = await tools.updateWorkflow.execute(
      { workflowId: wf.id, definition: anchoredDef({ id: PAGE_ID }) },
      makeContext(),
    )
    expect(updated.isError).toBe(true)
  })
})

describe('[COMP:workflow/tools] external-dependency authoring checks', () => {
  const deliverDef = (channelType: 'slack' | 'telegram', channelId: string): WorkflowDefinition => ({
    startStepId: 's1',
    steps: [
      {
        id: 's1',
        type: 'assistant_call',
        target: { assistantId: 'primary' },
        prompt: 'Summarize and send.',
        deliver: { channelType, channelId },
      },
    ],
  })

  it('proposeWorkflow blocks an unreachable Slack delivery target (the channel_not_found incident)', async () => {
    const validateDeliveryTarget = vi.fn(async () => ({ ok: false, reason: 'Slack: channel_not_found' }))
    const { tools } = makeAllTools({ validateDeliveryTarget })
    const r = await tools.proposeWorkflow.execute(
      { name: 'X', definition: deliverDef('slack', 'web-session-123') },
      makeContext(),
    )
    expect(r.isError).toBe(true)
    const data = r.data as { ok: boolean; errors: string[] }
    expect(data.ok).toBe(false)
    expect(data.errors.join(' ')).toContain('channel_not_found')
    expect(validateDeliveryTarget).toHaveBeenCalledWith({
      assistantId: PRIMARY_ASSISTANT_ID,
      channelType: 'slack',
      channelId: 'web-session-123',
    })
  })

  it('createWorkflow refuses to persist an unreachable delivery target', async () => {
    const validateDeliveryTarget = vi.fn(async () => ({ ok: false, reason: 'Slack: channel_not_found' }))
    const { tools, stores } = makeAllTools({ validateDeliveryTarget })
    const r = await tools.createWorkflow.execute(
      { name: 'X', definition: deliverDef('slack', 'nope') },
      makeContext(),
    )
    expect(r.isError).toBe(true)
    expect([...(await stores.workflowStore.list(USER_ID, WORKSPACE_ID))]).toHaveLength(0)
  })

  it('validates the resolved schedule trigger delivery target, not just explicit step.deliver', async () => {
    const validateDeliveryTarget = vi.fn(async () => ({ ok: false, reason: 'Slack: channel_not_found' }))
    const def: WorkflowDefinition = {
      startStepId: 's1',
      steps: [{ id: 's1', type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'Brief.' }],
    }
    const { tools } = makeAllTools({ validateDeliveryTarget })
    const r = await tools.createWorkflow.execute(
      {
        name: 'X',
        definition: def,
        trigger: { kind: 'schedule', schedule: { type: 'daily', time: '09:00' }, delivery: { channel: 'slack' } },
      },
      // A non-Slack (web) session — resolveDeliveryChannel stamps the web
      // channelId as the Slack target, which the validator rejects.
      makeContext(),
    )
    expect(r.isError).toBe(true)
    expect(validateDeliveryTarget).toHaveBeenCalled()
  })

  it('allows a reachable delivery target', async () => {
    const validateDeliveryTarget = vi.fn(async () => ({ ok: true }))
    const { tools } = makeAllTools({ validateDeliveryTarget })
    const r = await tools.proposeWorkflow.execute(
      { name: 'X', definition: deliverDef('telegram', 'tg-123') },
      makeContext(),
    )
    expect(r.isError).toBeFalsy()
    expect((r.data as { ok: boolean }).ok).toBe(true)
  })

  it('blocks a tool_call against a connector whose preflight fails (the Bad credentials incident)', async () => {
    const preflightConnectorTool = vi.fn(async () => ({
      ok: false,
      provider: 'GitHub',
      reason: 'its access token is invalid or revoked',
    }))
    const def: WorkflowDefinition = {
      startStepId: 's1',
      steps: [{ id: 's1', type: 'tool_call', toolName: 'githubListPullRequests', arguments: {} }],
    }
    const { tools } = makeAllTools({ preflightConnectorTool, isKnownTool: () => true })
    const r = await tools.createWorkflow.execute({ name: 'X', definition: def }, makeContext())
    expect(r.isError).toBe(true)
    expect((r.data as { errors: string[] }).errors.join(' ')).toContain('GitHub')
    expect(preflightConnectorTool).toHaveBeenCalledWith({ userId: USER_ID, toolName: 'githubListPullRequests' })
  })

  it('skips preflight for a tool that is not a connector tool (returns null)', async () => {
    const preflightConnectorTool = vi.fn(async () => null)
    const { tools } = makeAllTools({ preflightConnectorTool })
    const r = await tools.createWorkflow.execute({ name: 'X', definition: SIMPLE_DEF }, makeContext())
    expect(r.isError).toBeFalsy()
    expect(preflightConnectorTool).toHaveBeenCalled()
  })

  it('warns (fix D) when an assistant_call fetches connector data with no pinned tool', async () => {
    const def: WorkflowDefinition = {
      startStepId: 's1',
      steps: [
        {
          id: 's1',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'Summarize the GitHub pull requests merged in the last 24 hours.',
        },
      ],
    }
    const { tools } = makeAllTools({})
    const r = await tools.proposeWorkflow.execute({ name: 'X', definition: def }, makeContext())
    const warnings = (r.data as { warnings: string[] }).warnings
    expect(warnings.some((w) => /tool_call/.test(w) && /fabricate/.test(w))).toBe(true)
  })

  it('does NOT warn (fix D) when a dedicated tool_call already fetches the data', async () => {
    const def: WorkflowDefinition = {
      startStepId: 's1',
      steps: [
        { id: 's1', type: 'tool_call', toolName: 'githubListPullRequests', arguments: {}, storeOutputAs: 'prs', nextStepId: 's2' },
        { id: 's2', type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'Summarize the GitHub PRs in {{vars.prs}}.' },
      ],
    }
    const { tools } = makeAllTools({ isKnownTool: () => true })
    const r = await tools.proposeWorkflow.execute({ name: 'X', definition: def }, makeContext())
    const warnings = (r.data as { warnings: string[] }).warnings
    expect(warnings.some((w) => /fabricate/.test(w))).toBe(false)
  })

  it('skips all external checks when validators are not wired (tests / minimal boots)', async () => {
    const { tools } = makeAllTools({})
    const r = await tools.createWorkflow.execute(
      { name: 'X', definition: deliverDef('slack', 'anything') },
      makeContext(),
    )
    expect(r.isError).toBeFalsy()
  })
})
