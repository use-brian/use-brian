import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { advanceWorkflowRun, type ExecutorDeps, type WorkflowAuditEvent } from '../executor.js'
import type {
  WorkflowDefinition,
  WorkflowRecord,
  WorkflowRunRecord,
  WorkflowRunStore,
  WorkflowStepRunRecord,
  WorkflowStore,
  WorkflowTriggerKind,
} from '../types.js'
import { buildTool, type Tool } from '../../tools/types.js'
import type { ConsultRequest, ConsultResponse, ConsultTransport, Task } from '../../a2a/types.js'

// ── Fakes ────────────────────────────────────────────────────────────────

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'
const PRIMARY_ASSISTANT_ID = '00000000-0000-0000-0000-000000000002'
const USER_ID = '00000000-0000-0000-0000-000000000003'

function makeFakeStores() {
  const workflows = new Map<string, WorkflowRecord>()
  const runs = new Map<string, WorkflowRunRecord>()
  const stepRuns: WorkflowStepRunRecord[] = []
  let nextWorkflow = 100
  let nextRun = 200
  let nextStep = 300

  const workflowStore: WorkflowStore = {
    async create(params) {
      const { workspaceId, userId, name, definition, description, trigger, webhookSlug, webhookSecret } = params
      const now = new Date()
      const record: WorkflowRecord = {
        id: `00000000-0000-0000-0000-${String(nextWorkflow++).padStart(12, '0')}`,
        workspaceId,
        createdBy: userId,
        name,
        description: description ?? null,
        definition,
        enabled: true,
        trigger: trigger ?? { kind: 'manual' },
        webhookSlug: webhookSlug ?? null,
        webhookSecret: webhookSecret ?? null,
        modelAlias: params.modelAlias ?? 'pro',
        maxTurns: params.maxTurns ?? null,
        researchMode: params.researchMode ?? false,
        nameManuallySet: false,
        createdAt: now,
        updatedAt: now,
      }
      workflows.set(record.id, record)
      return record
    },
    async getById(_userId, id) {
      return workflows.get(id) ?? null
    },
    async list(_userId, workspaceId) {
      return [...workflows.values()].filter((w) => w.workspaceId === workspaceId)
    },
    async update(_userId, id, fields) {
      const existing = workflows.get(id)
      if (!existing) return null
      const updated: WorkflowRecord = {
        ...existing,
        ...(fields.name !== undefined ? { name: fields.name } : {}),
        ...(fields.description !== undefined ? { description: fields.description } : {}),
        ...(fields.definition !== undefined ? { definition: fields.definition } : {}),
        ...(fields.enabled !== undefined ? { enabled: fields.enabled } : {}),
        ...(fields.trigger !== undefined ? { trigger: fields.trigger } : {}),
        ...(fields.webhookSlug !== undefined ? { webhookSlug: fields.webhookSlug } : {}),
        ...(fields.webhookSecret !== undefined ? { webhookSecret: fields.webhookSecret } : {}),
        updatedAt: new Date(),
      }
      workflows.set(id, updated)
      return updated
    },
    async delete(_userId, id) {
      return workflows.delete(id)
    },
    async findByWebhookSlugSystem(slug) {
      return [...workflows.values()].find((w) => w.webhookSlug === slug && w.enabled) ?? null
    },
    async findByIdSystem(id) {
      return workflows.get(id) ?? null
    },
    async updateAutoName(_userId, id, name) {
      const existing = workflows.get(id)
      if (!existing || existing.nameManuallySet) return false
      workflows.set(id, { ...existing, name, updatedAt: new Date() })
      return true
    },
  }

  const runStore: WorkflowRunStore = {
    async createRun({ workflowId, workspaceId, triggeredBy, triggerKind, input }) {
      // Monotonic per-run timestamp so `listRunsForWorkflow`'s ORDER BY
      // started_at DESC is deterministic. A plain `new Date()` ties when
      // several runs are created within one millisecond (the dead-anchor
      // streak tests fire 5 runs synchronously), making the trailing-failure
      // window order-unstable whenever a ms boundary was crossed mid-test.
      // Prod runs are seconds/minutes apart, so this only ever bit the fake.
      const now = new Date(1_700_000_000_000 + nextRun)
      const record: WorkflowRunRecord = {
        id: `00000000-0000-0000-0000-${String(nextRun++).padStart(12, '0')}`,
        workflowId,
        workspaceId,
        triggeredBy,
        triggerKind,
        status: 'pending',
        input: input ?? {},
        vars: {},
        currentStepId: null,
        error: null,
        outcome: null,
        startedAt: now,
        finishedAt: null,
        lastActiveAt: now,
      }
      runs.set(record.id, record)
      return record
    },
    async getRunById(_userId, id) {
      return runs.get(id) ?? null
    },
    async getRunSystem(id) {
      return runs.get(id) ?? null
    },
    async updateRun(id, fields) {
      const existing = runs.get(id)
      if (!existing) return null
      const updated: WorkflowRunRecord = {
        ...existing,
        ...fields,
        lastActiveAt: new Date(),
      }
      runs.set(id, updated)
      return updated
    },
    async createStepRun({ runId, stepId, stepType, input }) {
      const now = new Date()
      const record: WorkflowStepRunRecord = {
        id: `00000000-0000-0000-0000-${String(nextStep++).padStart(12, '0')}`,
        runId,
        stepId,
        stepType,
        status: 'running',
        input: input ?? {},
        output: null,
        error: null,
        startedAt: now,
        finishedAt: null,
      }
      stepRuns.push(record)
      return record
    },
    async updateStepRun(id, fields) {
      const idx = stepRuns.findIndex((s) => s.id === id)
      if (idx === -1) return null
      stepRuns[idx] = { ...stepRuns[idx], ...fields }
      return stepRuns[idx]
    },
    async listStepRuns(_userId, runId) {
      return stepRuns.filter((s) => s.runId === runId)
    },
    async listRunsForWorkflow(_userId, workflowId, opts) {
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

function makeConsultTransport(opts?: {
  responseText?: string
  responseJson?: Record<string, unknown>
  fail?: string
}): ConsultTransport {
  return {
    async send(_request: ConsultRequest): Promise<ConsultResponse> {
      const taskId = `task_${Math.random().toString(36).slice(2)}`
      const contextId = `ctx_${taskId}`
      if (opts?.fail) {
        const task: Task = {
          taskId,
          contextId,
          status: {
            state: 'failed',
            timestamp: new Date().toISOString(),
            message: {
              messageId: 'm',
              role: 'agent',
              parts: [{ kind: 'text', text: opts.fail }],
            },
          },
          artifacts: [],
        }
        return { task }
      }
      const text = opts?.responseJson ? JSON.stringify(opts.responseJson) : opts?.responseText ?? 'ok'
      const task: Task = {
        taskId,
        contextId,
        status: { state: 'completed', timestamp: new Date().toISOString() },
        artifacts: [],
        history: [
          { messageId: 'm', role: 'agent', parts: [{ kind: 'text', text }] },
        ],
      }
      return { task }
    },
  }
}

function makeFakeTool(name: string, opts?: { fail?: boolean; capture?: (input: unknown) => void }): Tool {
  return buildTool({
    name,
    description: `fake tool ${name}`,
    inputSchema: z.object({}).passthrough(),
    async execute(input) {
      opts?.capture?.(input)
      if (opts?.fail) return { data: 'forced failure', isError: true }
      return { data: { ok: true, echoed: input } }
    },
  })
}

function makeDeps(overrides: Partial<ExecutorDeps>): ExecutorDeps {
  const stores = makeFakeStores()
  return {
    workflowStore: stores.workflowStore,
    runStore: stores.runStore,
    consultTransport: makeConsultTransport(),
    resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
    buildToolRegistry: async () => new Map(),
    ...overrides,
  }
}

async function seedWorkflowAndRun(
  deps: ExecutorDeps,
  definition: WorkflowDefinition,
  triggerKind: WorkflowTriggerKind = 'manual',
  input: Record<string, unknown> = {},
): Promise<{ workflow: WorkflowRecord; run: WorkflowRunRecord }> {
  const workflow = await deps.workflowStore.create({
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    name: 'test workflow',
    definition,
  })
  const run = await deps.runStore.createRun({
    workflowId: workflow.id,
    workspaceId: WORKSPACE_ID,
    triggeredBy: triggerKind === 'manual' ? USER_ID : null,
    triggerKind,
    input,
  })
  return { workflow, run }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('[COMP:workflow/executor] advanceWorkflowRun', () => {
  it('runs a linear assistant_call → tool_call to completion', async () => {
    let capturedToolInput: unknown = null
    const stores = makeFakeStores()
    const audits: WorkflowAuditEvent[] = []
    const tools = new Map<string, Tool>([
      ['saveMemory', makeFakeTool('saveMemory', { capture: (i) => (capturedToolInput = i) })],
    ])
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport({ responseText: 'summary text' }),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => tools,
      emitAudit: async (e) => { audits.push(e) },
    }

    const definition: WorkflowDefinition = {
      startStepId: 's1',
      steps: [
        {
          id: 's1',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'summarize',
          storeOutputAs: 'summary',
        },
        {
          id: 's2',
          type: 'tool_call',
          toolName: 'saveMemory',
          arguments: { content: '{{vars.summary}}' },
        },
      ],
    }

    const { run } = await seedWorkflowAndRun(deps, definition)
    const outcome = await advanceWorkflowRun(deps, run.id)

    expect(outcome.kind).toBe('completed')
    if (outcome.kind === 'completed') {
      expect(outcome.stepCount).toBe(2)
    }
    expect(capturedToolInput).toEqual({ content: 'summary text' })
    expect(audits.map((a) => a.type)).toEqual(['workflow.run_started', 'workflow.run_completed'])

    const updated = stores.runs.get(run.id)
    expect(updated?.status).toBe('completed')
    expect(updated?.finishedAt).toBeInstanceOf(Date)
  })

  it('[COMP:integrations/connector-health] a completed run names a dead connector in its outcome and notifies the owner', async () => {
    // The dead-GitHub-token incident: the run COMPLETES (the model apologizes),
    // so the surfacing must key off persisted connector health, not run failure.
    const delivered: Array<{ channelId: string; text: string }> = []
    const stores = makeFakeStores()
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport({ responseText: 'I could not fetch GitHub activity.' }),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
      deliverToChannel: async (p) => {
        delivered.push({ channelId: p.channelId, text: p.text })
        return { status: 'delivered' as const, channelType: p.channelType, channelId: p.channelId }
      },
      getAuthFailedConnectors: async () => [{ provider: 'github', label: 'sidanclaw' }],
    }
    const definition: WorkflowDefinition = {
      startStepId: 's1',
      steps: [
        {
          id: 's1',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'summarize github',
          deliver: { channelType: 'slack', channelId: 'C123' },
        },
      ],
    }

    const { run } = await seedWorkflowAndRun(deps, definition)
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('completed')

    const updated = stores.runs.get(run.id)
    expect(
      updated?.outcome?.blockers.some((b) => b.includes('sidanclaw') && b.includes('github')),
    ).toBe(true)
    // A reconnect notification reached the deliver channel (distinct from the
    // step's own output delivery, which has no "reconnect" text).
    expect(delivered.some((d) => d.channelId === 'C123' && /reconnect/i.test(d.text))).toBe(true)
  })

  it('fails an assistant_call with a non-UUID target before reaching the consult', async () => {
    // Regression: a definition persisted before the schema enforced
    // `uuid | 'primary'` (e.g. a model-authored "product-assistant" slug)
    // must fail with a legible error, NOT the opaque Postgres
    // "invalid input syntax for type uuid" from the assistant-by-id lookup.
    const stores = makeFakeStores()
    let consultCalled = false
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: {
        async send() {
          consultCalled = true
          throw new Error('consult should never be reached for an invalid target')
        },
      },
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
    }

    const definition: WorkflowDefinition = {
      startStepId: 's1',
      steps: [
        {
          id: 's1',
          type: 'assistant_call',
          target: { assistantId: 'product-assistant' },
          prompt: 'review the logs',
        },
      ],
    }

    const { run } = await seedWorkflowAndRun(deps, definition)
    const outcome = await advanceWorkflowRun(deps, run.id)

    expect(consultCalled).toBe(false)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.stepId).toBe('s1')
      expect(outcome.error.reason).toBe('invalid_assistant_target')
      expect(outcome.error.message).toContain('product-assistant')
    }
    expect(stores.runs.get(run.id)?.status).toBe('failed')
  })

  it('loads the workflow via the SYSTEM read for a scheduled (null-triggeredBy) run — workflow_not_found regression', async () => {
    // The migration-159 incident: scheduled fires have `run.triggeredBy = null`,
    // so an RLS-gated `getById(null, …)` matched no workspace_members row and
    // every recurring reminder failed with `workflow_not_found` (91% of all
    // failures in prod). `loadWorkflowForRun` MUST use `findByIdSystem`. Here
    // the RLS `getById` is forced to return null (the deny condition); the run
    // must still complete via the system read.
    const stores = makeFakeStores()
    stores.workflowStore.getById = async () => null
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport({ responseText: 'ok' }),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
    }
    const definition: WorkflowDefinition = {
      startStepId: 's1',
      steps: [{ id: 's1', type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'go' }],
    }
    const { run } = await seedWorkflowAndRun(deps, definition, 'schedule')
    expect(run.triggeredBy).toBeNull()
    const outcome = await advanceWorkflowRun(deps, run.id)
    // Would be 'failed' with reason 'workflow_not_found' if the load regressed to getById.
    expect(outcome.kind).toBe('completed')
  })

  it('delivers an assistant_call step output to the channel when `deliver` is set', async () => {
    const stores = makeFakeStores()
    const delivered: Array<{
      assistantId: string
      channelType: string
      channelId: string
      text: string
    }> = []
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport({ responseText: 'your morning briefing' }),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
      deliverToChannel: async (p) => {
        delivered.push({
          assistantId: p.assistantId,
          channelType: p.channelType,
          channelId: p.channelId,
          text: p.text,
        })
        return { status: 'delivered' as const, channelType: p.channelType, channelId: p.channelId }
      },
    }

    const definition: WorkflowDefinition = {
      startStepId: 's1',
      steps: [
        {
          id: 's1',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'brief me',
          deliver: { channelType: 'telegram', channelId: 'chat-42' },
        },
      ],
    }

    const { run } = await seedWorkflowAndRun(deps, definition)
    const outcome = await advanceWorkflowRun(deps, run.id)

    expect(outcome.kind).toBe('completed')
    // `primary` resolves to the workspace primary; raw text is delivered.
    expect(delivered).toEqual([
      {
        assistantId: PRIMARY_ASSISTANT_ID,
        channelType: 'telegram',
        channelId: 'chat-42',
        text: 'your morning briefing',
      },
    ])
  })

  it('does not fail the step when channel delivery throws', async () => {
    const stores = makeFakeStores()
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport({ responseText: 'briefing' }),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
      deliverToChannel: async () => {
        throw new Error('telegram down')
      },
    }

    const definition: WorkflowDefinition = {
      startStepId: 's1',
      steps: [
        {
          id: 's1',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'brief me',
          deliver: { channelType: 'web', channelId: 'notifications' },
        },
      ],
    }

    const { run } = await seedWorkflowAndRun(deps, definition)
    const outcome = await advanceWorkflowRun(deps, run.id)
    // Delivery is best-effort — a push failure must not fail the run.
    expect(outcome.kind).toBe('completed')
  })

  it('records a non-delivered outcome on the step run and audits it (observability)', async () => {
    const stores = makeFakeStores()
    const audits: WorkflowAuditEvent[] = []
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport({ responseText: 'briefing' }),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
      emitAudit: async (e) => {
        audits.push(e)
      },
      // A channel with no connected integration → skipped, not delivered.
      deliverToChannel: async ({ channelType }) => ({
        status: 'skipped' as const,
        channelType,
        reason: 'no_integration' as const,
      }),
    }
    const definition: WorkflowDefinition = {
      startStepId: 's1',
      steps: [
        {
          id: 's1',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'brief me',
          deliver: { channelType: 'telegram', channelId: 'chat-42' },
        },
      ],
    }
    const { run } = await seedWorkflowAndRun(deps, definition)
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('completed')
    // The step run carries the outcome (the run-detail surface reads it).
    const stepRun = stores.stepRuns.find((s) => s.runId === run.id && s.stepId === 's1')
    expect(
      (stepRun?.output as { __delivery?: { status: string; reason?: string } } | undefined)
        ?.__delivery,
    ).toMatchObject({ status: 'skipped', reason: 'no_integration' })
    // A non-delivered push is audited so the silent no-op becomes a signal.
    expect(audits.find((a) => a.type === 'workflow.step_delivered')).toMatchObject({
      type: 'workflow.step_delivered',
      stepId: 's1',
      delivery: { status: 'skipped', reason: 'no_integration' },
    })
  })

  it('records a delivered outcome on the step run but does not audit it (no per-fire noise)', async () => {
    const stores = makeFakeStores()
    const audits: WorkflowAuditEvent[] = []
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport({ responseText: 'briefing' }),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
      emitAudit: async (e) => {
        audits.push(e)
      },
      deliverToChannel: async ({ channelType, channelId }) => ({
        status: 'delivered' as const,
        channelType,
        channelId,
      }),
    }
    const definition: WorkflowDefinition = {
      startStepId: 's1',
      steps: [
        {
          id: 's1',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'brief me',
          deliver: { channelType: 'telegram', channelId: 'chat-42' },
        },
      ],
    }
    const { run } = await seedWorkflowAndRun(deps, definition)
    await advanceWorkflowRun(deps, run.id)
    const stepRun = stores.stepRuns.find((s) => s.runId === run.id && s.stepId === 's1')
    expect(
      (stepRun?.output as { __delivery?: { status: string } } | undefined)?.__delivery?.status,
    ).toBe('delivered')
    expect(audits.find((a) => a.type === 'workflow.step_delivered')).toBeUndefined()
  })

  it('pins a stable contextId on the consult for a persistent-session step', async () => {
    const stores = makeFakeStores()
    const seenContextIds: Array<string | undefined> = []
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: {
        async send(request: ConsultRequest): Promise<ConsultResponse> {
          seenContextIds.push(request.contextId)
          const task: Task = {
            taskId: 't',
            contextId: request.contextId ?? 'c',
            status: { state: 'completed', timestamp: new Date().toISOString() },
            artifacts: [],
            history: [{ messageId: 'm', role: 'agent', parts: [{ kind: 'text', text: 'ok' }] }],
          }
          return { task }
        },
      },
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
    }

    const definition: WorkflowDefinition = {
      startStepId: 's1',
      steps: [
        {
          id: 's1',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'a',
          session: 'persistent',
        },
        {
          id: 's2',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'b',
        },
      ],
    }

    const { workflow, run } = await seedWorkflowAndRun(deps, definition)
    await advanceWorkflowRun(deps, run.id)

    // `persistent` → a stable key; the default (`s2`, omitted) → undefined.
    expect(seenContextIds).toEqual([`workflow:${workflow.id}:s1`, undefined])
  })

  it('passes an assistant_call `tools` filter through as the consult allowedTools', async () => {
    const stores = makeFakeStores()
    const seenAllowed: Array<string[] | undefined> = []
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: {
        async send(request: ConsultRequest): Promise<ConsultResponse> {
          seenAllowed.push(request.allowedTools)
          const task: Task = {
            taskId: 't',
            contextId: request.contextId ?? 'c',
            status: { state: 'completed', timestamp: new Date().toISOString() },
            artifacts: [],
            history: [{ messageId: 'm', role: 'agent', parts: [{ kind: 'text', text: 'ok' }] }],
          }
          return { task }
        },
      },
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
    }

    const definition: WorkflowDefinition = {
      startStepId: 's1',
      steps: [
        {
          id: 's1',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'a',
          tools: ['webFetch', 'getMemory'],
        },
        {
          id: 's2',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'b',
        },
      ],
    }

    const { run } = await seedWorkflowAndRun(deps, definition)
    await advanceWorkflowRun(deps, run.id)

    // The step with `tools` → that allow-list; the default step (no `tools`) → undefined.
    expect(seenAllowed).toEqual([['webFetch', 'getMemory'], undefined])
  })

  it('passes an assistant_call `skills` allow-list through as the consult skills', async () => {
    const stores = makeFakeStores()
    const seenSkills: Array<string[] | undefined> = []
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: {
        async send(request: ConsultRequest): Promise<ConsultResponse> {
          seenSkills.push(request.skills)
          const task: Task = {
            taskId: 't',
            contextId: request.contextId ?? 'c',
            status: { state: 'completed', timestamp: new Date().toISOString() },
            artifacts: [],
            history: [{ messageId: 'm', role: 'agent', parts: [{ kind: 'text', text: 'ok' }] }],
          }
          return { task }
        },
      },
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
    }

    const definition: WorkflowDefinition = {
      startStepId: 's1',
      steps: [
        {
          id: 's1',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'a',
          skills: ['deep-research', 'crm-enrich'],
        },
        {
          id: 's2',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'b',
        },
      ],
    }

    const { run } = await seedWorkflowAndRun(deps, definition)
    await advanceWorkflowRun(deps, run.id)

    // The step with `skills` → that allow-list; the default step (no `skills`) → undefined.
    expect(seenSkills).toEqual([['deep-research', 'crm-enrich'], undefined])
  })

  it('passes an assistant_call `enforcedSkills` list through as the consult enforcedSkills', async () => {
    const stores = makeFakeStores()
    const seen: Array<{ skills?: string[]; enforced?: string[] }> = []
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: {
        async send(request: ConsultRequest): Promise<ConsultResponse> {
          seen.push({ skills: request.skills, enforced: request.enforcedSkills })
          const task: Task = {
            taskId: 't',
            contextId: request.contextId ?? 'c',
            status: { state: 'completed', timestamp: new Date().toISOString() },
            artifacts: [],
            history: [{ messageId: 'm', role: 'agent', parts: [{ kind: 'text', text: 'ok' }] }],
          }
          return { task }
        },
      },
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
    }

    const definition: WorkflowDefinition = {
      startStepId: 's1',
      steps: [
        {
          id: 's1',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'a',
          // A step can enforce some skills and offer others independently.
          skills: ['deep-research'],
          enforcedSkills: ['brand-voice', 'compliance-check'],
        },
        {
          id: 's2',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'b',
        },
      ],
    }

    const { run } = await seedWorkflowAndRun(deps, definition)
    await advanceWorkflowRun(deps, run.id)

    expect(seen).toEqual([
      { skills: ['deep-research'], enforced: ['brand-voice', 'compliance-check'] },
      { skills: undefined, enforced: undefined },
    ])
  })

  it('parses JSON responses from assistant_call into structured output for branch', async () => {
    const stores = makeFakeStores()
    const tools = new Map<string, Tool>([
      ['publish', makeFakeTool('publish')],
      ['notify', makeFakeTool('notify')],
    ])
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport({ responseJson: { approved: true, reason: 'on-tone' } }),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => tools,
    }

    const definition: WorkflowDefinition = {
      startStepId: 'review',
      steps: [
        {
          id: 'review',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'review draft',
          storeOutputAs: 'review',
        },
        {
          id: 'decide',
          type: 'branch',
          condition: { '==': [{ var: 'vars.review.approved' }, true] },
          nextStepIdIfTrue: 'publish',
          nextStepIdIfFalse: 'notify',
        },
        { id: 'publish', type: 'tool_call', toolName: 'publish', arguments: {}, nextStepId: null },
        { id: 'notify', type: 'tool_call', toolName: 'notify', arguments: {}, nextStepId: null },
      ],
    }
    const { run } = await seedWorkflowAndRun(deps, definition)
    const outcome = await advanceWorkflowRun(deps, run.id)

    expect(outcome.kind).toBe('completed')
    const steps = stores.stepRuns
    const stepIds = steps.map((s) => s.stepId)
    expect(stepIds).toEqual(['review', 'decide', 'publish'])
  })

  it('takes the false branch when the condition is false', async () => {
    const stores = makeFakeStores()
    const tools = new Map<string, Tool>([
      ['publish', makeFakeTool('publish')],
      ['notify', makeFakeTool('notify')],
    ])
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport({ responseJson: { approved: false, reason: 'off-tone' } }),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => tools,
    }

    const definition: WorkflowDefinition = {
      startStepId: 'review',
      steps: [
        {
          id: 'review',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'review draft',
          storeOutputAs: 'review',
        },
        {
          id: 'decide',
          type: 'branch',
          condition: { '==': [{ var: 'vars.review.approved' }, true] },
          nextStepIdIfTrue: 'publish',
          nextStepIdIfFalse: 'notify',
        },
        { id: 'publish', type: 'tool_call', toolName: 'publish', arguments: {}, nextStepId: null },
        { id: 'notify', type: 'tool_call', toolName: 'notify', arguments: {}, nextStepId: null },
      ],
    }
    const { run } = await seedWorkflowAndRun(deps, definition)
    await advanceWorkflowRun(deps, run.id)

    const stepIds = stores.stepRuns.map((s) => s.stepId)
    expect(stepIds).toEqual(['review', 'decide', 'notify'])
  })

  it('marks the run failed when a tool_call fails', async () => {
    const stores = makeFakeStores()
    const audits: WorkflowAuditEvent[] = []
    const tools = new Map<string, Tool>([
      ['boom', makeFakeTool('boom', { fail: true })],
    ])
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport(),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => tools,
      emitAudit: async (e) => { audits.push(e) },
    }

    const definition: WorkflowDefinition = {
      startStepId: 'fail',
      steps: [{ id: 'fail', type: 'tool_call', toolName: 'boom', arguments: {} }],
    }
    const { run } = await seedWorkflowAndRun(deps, definition)
    const outcome = await advanceWorkflowRun(deps, run.id)

    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.stepId).toBe('fail')
      expect(outcome.error.reason).toBe('tool_returned_error')
    }
    expect(audits.map((a) => a.type)).toEqual(['workflow.run_started', 'workflow.run_failed'])
    const updated = stores.runs.get(run.id)
    expect(updated?.status).toBe('failed')
  })

  it('fails when a tool_call references an unknown tool', async () => {
    const stores = makeFakeStores()
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport(),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
    }
    const { run } = await seedWorkflowAndRun(deps, {
      startStepId: 's',
      steps: [{ id: 's', type: 'tool_call', toolName: 'ghost', arguments: {} }],
    })
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.reason).toBe('tool_not_found')
    }
  })

  it('Phase A: errors on `wait` steps with a clear message', async () => {
    const stores = makeFakeStores()
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport(),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
      // pauseRunForWait NOT set → Phase A behavior
    }
    const { run } = await seedWorkflowAndRun(deps, {
      startStepId: 'sleep',
      steps: [{ id: 'sleep', type: 'wait', until: { duration: { hours: 1 } } }],
    })
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.reason).toBe('wait_requires_phase_b')
    }
    // Step run was created and marked failed (visible in getWorkflowRun).
    expect(stores.stepRuns).toHaveLength(1)
    expect(stores.stepRuns[0].status).toBe('failed')
  })

  it('Phase B (simulated): pauses the run on a `wait` step', async () => {
    const stores = makeFakeStores()
    let pauseCall: { runId: string; stepRunId: string; dueAt: Date } | null = null
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport(),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
      pauseRunForWait: async ({ runId, stepRunId, dueAt }) => {
        pauseCall = { runId, stepRunId, dueAt }
      },
    }
    const { run } = await seedWorkflowAndRun(deps, {
      startStepId: 'sleep',
      steps: [{ id: 'sleep', type: 'wait', until: { duration: { minutes: 5 } } }],
    })
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('paused')
    if (outcome.kind === 'paused') {
      expect(outcome.reason).toBe('wait')
      expect(outcome.stepId).toBe('sleep')
    }
    expect(pauseCall).not.toBeNull()
    expect(pauseCall!.runId).toBe(run.id)
    expect(stores.runs.get(run.id)!.status).toBe('awaiting_wait')
  })

  it('resolves `primary` to the workspace primary assistant', async () => {
    const stores = makeFakeStores()
    let lastConsultRequest: ConsultRequest | null = null
    const transport: ConsultTransport = {
      async send(req) {
        lastConsultRequest = req
        return {
          task: {
            taskId: 't',
            contextId: 'c',
            status: { state: 'completed', timestamp: new Date().toISOString() },
            artifacts: [],
            history: [{ messageId: 'm', role: 'agent', parts: [{ kind: 'text', text: 'ok' }] }],
          },
        }
      },
    }
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: transport,
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
    }
    const { run } = await seedWorkflowAndRun(deps, {
      startStepId: 's',
      steps: [
        { id: 's', type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'hi' },
      ],
    })
    await advanceWorkflowRun(deps, run.id)
    expect(lastConsultRequest!.target.assistantId).toBe(PRIMARY_ASSISTANT_ID)
    expect(lastConsultRequest!.caller.channelType).toBe('workflow')
    expect(lastConsultRequest!.chain.budget).toBeGreaterThan(0)
  })

  it('interpolates input + vars into prompt and arguments', async () => {
    const stores = makeFakeStores()
    let toolInput: unknown = null
    const tools = new Map<string, Tool>([
      ['record', makeFakeTool('record', { capture: (i) => (toolInput = i) })],
    ])
    let assistantPrompt = ''
    const transport: ConsultTransport = {
      async send(req) {
        assistantPrompt = req.message.parts
          .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
          .map((p) => p.text).join('')
        return {
          task: {
            taskId: 't',
            contextId: 'c',
            status: { state: 'completed', timestamp: new Date().toISOString() },
            artifacts: [],
            history: [{ messageId: 'm', role: 'agent', parts: [{ kind: 'text', text: '{"label":"green"}' }] }],
          },
        }
      },
    }
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: transport,
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => tools,
    }
    const { run } = await seedWorkflowAndRun(deps, {
      startStepId: 's1',
      steps: [
        {
          id: 's1',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'classify {{input.subject}}',
          storeOutputAs: 'cls',
        },
        {
          id: 's2',
          type: 'tool_call',
          toolName: 'record',
          arguments: { subject: '{{input.subject}}', label: '{{vars.cls.label}}' },
          nextStepId: null,
        },
      ],
    }, 'manual', { subject: 'pizza' })
    await advanceWorkflowRun(deps, run.id)
    expect(assistantPrompt).toBe('classify pizza')
    expect(toolInput).toEqual({ subject: 'pizza', label: 'green' })
  })

  it('returns failed if no primary assistant is configured for the workspace', async () => {
    const stores = makeFakeStores()
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport(),
      resolvePrimary: async () => null,
      buildToolRegistry: async () => new Map(),
    }
    const { run } = await seedWorkflowAndRun(deps, {
      startStepId: 's',
      steps: [{ id: 's', type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'hi' }],
    })
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.reason).toBe('no_primary_assistant')
    }
  })

  it('scheduled run (triggeredBy=null) loads the workflow via findByIdSystem, not the RLS-gated getById', async () => {
    // Regression: the migration-159 cutover left `loadWorkflowForRun` using
    // a zero-UUID fallback for the RLS user when `run.triggeredBy === null`
    // (scheduled triggers). Zero UUID matches no `workspace_members` row,
    // so every scheduled run silently failed with `workflow_not_found`
    // before any step executed — 100% of enabled recurring reminders in
    // production were dead for 2 days. The executor must use the
    // system-bypass `findByIdSystem` for runs without a per-user context.
    const stores = makeFakeStores()
    // Simulate prod RLS: getById/list return nothing under any user the
    // executor might fall back to. Only findByIdSystem can see the row.
    stores.workflowStore.getById = async () => null
    stores.workflowStore.list = async () => []

    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport({ responseText: 'reminder body' }),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
    }
    const { run } = await seedWorkflowAndRun(
      deps,
      {
        startStepId: 's',
        steps: [{ id: 's', type: 'assistant_call', target: { assistantId: PRIMARY_ASSISTANT_ID }, prompt: 'remind me' }],
      },
      'schedule',
    )
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('completed')
  })
})

describe('[COMP:workflow/executor] page anchor resolution', () => {
  const PAGE_ID = '00000000-0000-0000-0000-00000000aaaa'
  const PARENT_ID = '00000000-0000-0000-0000-00000000bbbb'

  function captureTransport(captured: ConsultRequest[]): ConsultTransport {
    const inner = makeConsultTransport({ responseText: 'done' })
    return {
      async send(request) {
        captured.push(request)
        return inner.send(request)
      },
    }
  }

  it('threads page.{id} to ConsultRequest.pageAnchorId and audits it on the step run', async () => {
    const stores = makeFakeStores()
    const captured: ConsultRequest[] = []
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: captureTransport(captured),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
    }
    const { run } = await seedWorkflowAndRun(deps, {
      startStepId: 's1',
      steps: [
        {
          id: 's1',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'edit the page',
          page: { id: PAGE_ID },
        },
      ],
    })
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('completed')
    expect(captured).toHaveLength(1)
    expect(captured[0].pageAnchorId).toBe(PAGE_ID)
    // The authored anchor is recorded on the step-run input for audit.
    expect(stores.stepRuns[0].input).toMatchObject({ page: { id: PAGE_ID } })
  })

  it('page.{create} calls createAnchorPage with an interpolated title, threads the new id, and writes the reserved var', async () => {
    const stores = makeFakeStores()
    const captured: ConsultRequest[] = []
    const createCalls: Array<{
      workspaceId: string
      userId: string
      title: string
      nestUnder?: string
      originPrompt?: string
    }> = []
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: captureTransport(captured),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
      createAnchorPage: async (params) => {
        createCalls.push(params)
        return { id: PAGE_ID }
      },
    }
    const { run } = await seedWorkflowAndRun(
      deps,
      {
        startStepId: 's1',
        steps: [
          {
            id: 's1',
            type: 'assistant_call',
            target: { assistantId: 'primary' },
            prompt: 'write the report',
            page: { create: true, title: 'Report: {{input.topic}}', nestUnder: PARENT_ID },
          },
        ],
      },
      'manual',
      { topic: 'moats' },
    )
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('completed')
    expect(createCalls).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        title: 'Report: moats',
        nestUnder: PARENT_ID,
        // Genesis provenance: the interpolated step prompt.
        originPrompt: 'write the report',
      },
    ])
    expect(captured[0].pageAnchorId).toBe(PAGE_ID)
    // The created id is persisted in run vars under the reserved key so
    // later fromStep anchors (and run inspection) can reach it.
    expect(stores.runs.get(run.id)?.vars).toMatchObject({ __pageAnchor_s1: PAGE_ID })
  })

  it('page.{fromStep} resolves the page a prior create-step made this run', async () => {
    const stores = makeFakeStores()
    const captured: ConsultRequest[] = []
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: captureTransport(captured),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
      createAnchorPage: async () => ({ id: PAGE_ID }),
    }
    const { run } = await seedWorkflowAndRun(deps, {
      startStepId: 'make',
      steps: [
        {
          id: 'make',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'create the report',
          page: { create: true, title: 'Report' },
        },
        {
          id: 'fill',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'fill in the details',
          page: { fromStep: 'make' },
        },
      ],
    })
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('completed')
    expect(captured).toHaveLength(2)
    expect(captured[0].pageAnchorId).toBe(PAGE_ID)
    expect(captured[1].pageAnchorId).toBe(PAGE_ID)
  })

  it('fails typed with page_anchor_unresolved when fromStep has not created a page', async () => {
    // The schema blocks dangling fromStep references, but a branch can route
    // around the create-step at run time — the executor must fail legibly.
    const stores = makeFakeStores()
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport(),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
      createAnchorPage: async () => ({ id: PAGE_ID }),
    }
    const { run } = await seedWorkflowAndRun(deps, {
      // Start directly at `fill`, skipping the create-step.
      startStepId: 'fill',
      steps: [
        {
          id: 'make',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'create',
          page: { create: true },
          nextStepId: null,
        },
        {
          id: 'fill',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'fill',
          page: { fromStep: 'make' },
          nextStepId: null,
        },
      ],
    })
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.reason).toBe('page_anchor_unresolved')
      expect(outcome.error.message).toContain('make')
    }
  })

  it('fails typed with page_anchor_create_failed when the create port throws', async () => {
    const stores = makeFakeStores()
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport(),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
      createAnchorPage: async () => {
        throw new Error('db down')
      },
    }
    const { run } = await seedWorkflowAndRun(deps, {
      startStepId: 's1',
      steps: [
        {
          id: 's1',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'write',
          page: { create: true },
        },
      ],
    })
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.reason).toBe('page_anchor_create_failed')
      expect(outcome.error.message).toContain('db down')
    }
  })

  it('fails typed with page_anchor_unavailable when create is authored but no port is configured', async () => {
    const deps = makeDeps({})
    const { run } = await seedWorkflowAndRun(deps, {
      startStepId: 's1',
      steps: [
        {
          id: 's1',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'write',
          page: { create: true },
        },
      ],
    })
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.reason).toBe('page_anchor_unavailable')
    }
  })

  it('hoists a typed reason from a transport throw onto the step error', async () => {
    // The callee executor's page-anchor gate throws Errors carrying e.g.
    // reason: 'page_anchor_not_found'; the dispatch catch must surface it
    // instead of the generic 'dispatch_threw'.
    const stores = makeFakeStores()
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: {
        async send() {
          throw Object.assign(new Error('Page anchor not visible.'), {
            reason: 'page_anchor_not_found',
          })
        },
      },
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
    }
    const { run } = await seedWorkflowAndRun(deps, {
      startStepId: 's1',
      steps: [
        {
          id: 's1',
          type: 'assistant_call',
          target: { assistantId: 'primary' },
          prompt: 'edit',
          page: { id: PAGE_ID },
        },
      ],
    })
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.reason).toBe('page_anchor_not_found')
      expect(outcome.error.message).toContain('not visible')
    }
  })

  it('resolves a whole-string {{input.x}} anchor to the uuid it holds (Phase B)', async () => {
    const stores = makeFakeStores()
    const captured: ConsultRequest[] = []
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: captureTransport(captured),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
    }
    const { run } = await seedWorkflowAndRun(
      deps,
      {
        startStepId: 's1',
        steps: [
          {
            id: 's1',
            type: 'assistant_call',
            target: { assistantId: 'primary' },
            prompt: 'update the page',
            page: { id: '{{input.pageId}}' },
          },
        ],
      },
      'manual',
      { pageId: PAGE_ID },
    )
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('completed')
    expect(captured[0].pageAnchorId).toBe(PAGE_ID)
  })

  it('fails typed with invalid_page_anchor when the template resolves to a non-uuid', async () => {
    const stores = makeFakeStores()
    let consultCalled = false
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: {
        async send() {
          consultCalled = true
          throw new Error('must not reach the consult')
        },
      },
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
    }
    const { run } = await seedWorkflowAndRun(
      deps,
      {
        startStepId: 's1',
        steps: [
          {
            id: 's1',
            type: 'assistant_call',
            target: { assistantId: 'primary' },
            prompt: 'update the page',
            page: { id: '{{input.pageId}}' },
          },
        ],
      },
      'manual',
      { pageId: 'not-a-page-id' },
    )
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(consultCalled).toBe(false)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.reason).toBe('invalid_page_anchor')
      expect(outcome.error.message).toContain('{{input.pageId}}')
    }
  })

  it('keeps dispatch_threw for a reason-less transport throw', async () => {
    const stores = makeFakeStores()
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: {
        async send() {
          throw new Error('socket hangup')
        },
      },
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
    }
    const { run } = await seedWorkflowAndRun(deps, {
      startStepId: 's1',
      steps: [
        { id: 's1', type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'go' },
      ],
    })
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.reason).toBe('dispatch_threw')
    }
  })

  it('classifies a wall-clock timeout as run status "timeout" and preserves partial output', async () => {
    const stores = makeFakeStores()
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: {
        async send() {
          throw Object.assign(
            new Error('assistant_call step exceeded its 180000ms wall-clock budget and was aborted'),
            { reason: 'timeout', partialOutput: 'research gathered before the abort' },
          )
        },
      },
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
    }
    const { run } = await seedWorkflowAndRun(deps, {
      startStepId: 's1',
      steps: [
        { id: 's1', type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'go' },
      ],
    })
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.reason).toBe('timeout')
    }
    // Run-level status carries `timeout` (distinct from a plain failure)...
    expect(stores.runs.get(run.id)?.status).toBe('timeout')
    // ...and the partial output the callee gathered survives on the step run.
    const stepRun = stores.stepRuns.find((s) => s.runId === run.id && s.stepId === 's1')
    expect(stepRun?.status).toBe('failed')
    expect(stepRun?.output).toEqual({
      value: 'research gathered before the abort',
      __truncated: true,
    })
  })
})

describe('[COMP:workflow/executor] dead-anchor auto-disable', () => {
  const PAGE_ID = '00000000-0000-0000-0000-00000000aaaa'

  /** Transport whose page-anchor gate always reports the page gone. */
  const deadAnchorTransport: ConsultTransport = {
    async send() {
      throw Object.assign(new Error('Page anchor not found.'), {
        reason: 'page_anchor_not_found',
      })
    },
  }

  const anchoredDef = (deliver?: { channelType: 'telegram'; channelId: string }): WorkflowDefinition => ({
    startStepId: 's1',
    steps: [
      {
        id: 's1',
        type: 'assistant_call',
        target: { assistantId: 'primary' },
        prompt: 'edit the page',
        page: { id: PAGE_ID },
        ...(deliver ? { deliver } : {}),
      },
    ],
  })

  async function runTimes(
    deps: ExecutorDeps,
    workflowId: string,
    n: number,
  ): Promise<void> {
    for (let i = 0; i < n; i++) {
      const run = await deps.runStore.createRun({
        workflowId,
        workspaceId: WORKSPACE_ID,
        triggeredBy: USER_ID,
        triggerKind: 'manual',
        input: {},
      })
      await advanceWorkflowRun(deps, run.id)
    }
  }

  it('disables the workflow + emits workflow.auto_disabled after 3 consecutive dead-anchor failures', async () => {
    const stores = makeFakeStores()
    const audits: WorkflowAuditEvent[] = []
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: deadAnchorTransport,
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
      emitAudit: async (e) => { audits.push(e) },
    }
    const workflow = await deps.workflowStore.create({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      name: 'page maintainer',
      definition: anchoredDef(),
    })

    await runTimes(deps, workflow.id, 2)
    expect(stores.workflows.get(workflow.id)?.enabled).toBe(true) // streak of 2: still on

    await runTimes(deps, workflow.id, 1)
    expect(stores.workflows.get(workflow.id)?.enabled).toBe(false) // 3rd trips the breaker

    const disabled = audits.find((a) => a.type === 'workflow.auto_disabled')
    expect(disabled).toMatchObject({
      type: 'workflow.auto_disabled',
      workflowId: workflow.id,
      reason: 'page_anchor_not_found',
      streak: 3,
    })
  })

  it('a successful run between failures resets the streak', async () => {
    const stores = makeFakeStores()
    let failNext = true
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: {
        async send(request) {
          if (failNext) {
            throw Object.assign(new Error('Page anchor not found.'), {
              reason: 'page_anchor_not_found',
            })
          }
          return makeConsultTransport({ responseText: 'ok' }).send(request)
        },
      },
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
    }
    const workflow = await deps.workflowStore.create({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      name: 'page maintainer',
      definition: anchoredDef(),
    })

    await runTimes(deps, workflow.id, 2) // two dead-anchor failures
    failNext = false
    await runTimes(deps, workflow.id, 1) // success breaks the streak
    failNext = true
    await runTimes(deps, workflow.id, 2) // two more failures: streak is 2, not 5

    expect(stores.workflows.get(workflow.id)?.enabled).toBe(true)
  })

  it('notifies the first deliver-carrying step channel when the breaker trips', async () => {
    const stores = makeFakeStores()
    const deliveries: Array<{ channelId: string; text: string }> = []
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: deadAnchorTransport,
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
      deliverToChannel: async ({ channelId, text, channelType }) => {
        deliveries.push({ channelId, text })
        return { status: 'delivered' as const, channelType, channelId }
      },
    }
    const workflow = await deps.workflowStore.create({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      name: 'page maintainer',
      definition: anchoredDef({ channelType: 'telegram', channelId: 'chat-9' }),
    })

    await runTimes(deps, workflow.id, 3)

    expect(stores.workflows.get(workflow.id)?.enabled).toBe(false)
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0].channelId).toBe('chat-9')
    expect(deliveries[0].text).toContain('disabled')
    expect(deliveries[0].text).toContain('page maintainer')
  })

  it('other failure reasons never trip the breaker', async () => {
    const stores = makeFakeStores()
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport({ fail: 'model exploded' }),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
    }
    const workflow = await deps.workflowStore.create({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      name: 'flaky workflow',
      definition: anchoredDef(),
    })

    await runTimes(deps, workflow.id, 4)
    expect(stores.workflows.get(workflow.id)?.enabled).toBe(true)
  })
})

describe('[COMP:workflow/executor] cross-run state ({{lastRun}}) + anchor reuse', () => {
  const emitTool = (name = 'emit'): Tool =>
    buildTool({
      name,
      description: 'returns its `value` argument as output',
      inputSchema: z.object({ value: z.unknown() }).passthrough(),
      async execute(input) {
        return { data: (input as { value: unknown }).value }
      },
    })

  it('writes a terminal outcome: engine logs + summary, author state/todo/blockers', async () => {
    const stores = makeFakeStores()
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport({ responseText: 'all done' }),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map([['emit', emitTool()]]),
    }
    const { run } = await seedWorkflowAndRun(deps, {
      startStepId: 'st',
      steps: [
        { id: 'st', type: 'tool_call', toolName: 'emit', arguments: { value: { cursor: 7 } }, storeOutputAs: 'state', nextStepId: 'td' },
        { id: 'td', type: 'tool_call', toolName: 'emit', arguments: { value: ['ship docs'] }, storeOutputAs: 'todo', nextStepId: 'bl' },
        { id: 'bl', type: 'tool_call', toolName: 'emit', arguments: { value: ['waiting on legal'] }, storeOutputAs: 'blockers', nextStepId: 'sum' },
        { id: 'sum', type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'summarize', storeOutputAs: 'summary' },
      ],
    })
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('completed')

    const persisted = stores.runs.get(run.id)?.outcome
    expect(persisted).toBeTruthy()
    expect(persisted?.status).toBe('completed')
    expect(persisted?.summary).toBe('all done')
    expect(persisted?.state).toEqual({ cursor: 7 })
    expect(persisted?.todo).toEqual(['ship docs'])
    expect(persisted?.blockers).toEqual(['waiting on legal'])
    expect(persisted?.logs.map((l) => `${l.stepId}:${l.status}`)).toEqual([
      'st:completed', 'td:completed', 'bl:completed', 'sum:completed',
    ])
  })

  it('records a failed run: terminal error appended to outcome.blockers + a failed log entry', async () => {
    const stores = makeFakeStores()
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport({ fail: 'model refused' }),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
    }
    const { run } = await seedWorkflowAndRun(deps, {
      startStepId: 's1',
      steps: [{ id: 's1', type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'go' }],
    })
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('failed')
    const persisted = stores.runs.get(run.id)?.outcome
    expect(persisted?.status).toBe('failed')
    expect(persisted?.blockers.length).toBeGreaterThan(0)
    expect(persisted?.logs).toHaveLength(1)
    expect(persisted?.logs[0]).toMatchObject({ stepId: 's1', status: 'failed' })
  })

  it('surfaces the prior terminal run as {{lastRun.X}} on the next run', async () => {
    const stores = makeFakeStores()
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport({ responseText: 'second-output' }),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
    }
    const def: WorkflowDefinition = {
      startStepId: 's1',
      steps: [{ id: 's1', type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'prior summary was: {{lastRun.summary}}', storeOutputAs: 'summary' }],
    }
    // First run — no prior terminal run, so {{lastRun.summary}} → ''.
    const { workflow, run: run1 } = await seedWorkflowAndRun(deps, def)
    await advanceWorkflowRun(deps, run1.id)
    expect(stores.stepRuns.find((s) => s.runId === run1.id)?.input.prompt).toBe('prior summary was: ')
    expect(stores.runs.get(run1.id)?.outcome?.summary).toBe('second-output')

    // Second run of the SAME workflow reads run1's outcome.
    const run2 = await deps.runStore.createRun({
      workflowId: workflow.id, workspaceId: WORKSPACE_ID, triggeredBy: USER_ID, triggerKind: 'manual', input: {},
    })
    await advanceWorkflowRun(deps, run2.id)
    expect(stores.stepRuns.find((s) => s.runId === run2.id)?.input.prompt).toBe('prior summary was: second-output')
  })

  it('page.reuse "per-workflow" find-or-creates ONE page across runs via a stable anchorKey', async () => {
    const stores = makeFakeStores()
    const createCalls: Array<{ anchorKey?: string }> = []
    const byKey = new Map<string, string>()
    let n = 0
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport(),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
      createAnchorPage: async (params) => {
        createCalls.push(params)
        if (params.anchorKey && byKey.has(params.anchorKey)) return { id: byKey.get(params.anchorKey)! }
        const id = `00000000-0000-0000-0000-${String(n++).padStart(12, '0')}`
        if (params.anchorKey) byKey.set(params.anchorKey, id)
        return { id }
      },
    }
    const def: WorkflowDefinition = {
      startStepId: 's1',
      steps: [{ id: 's1', type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'append to the log', page: { create: true, title: 'Maintenance Log', reuse: 'per-workflow' } }],
    }
    const { workflow, run: run1 } = await seedWorkflowAndRun(deps, def)
    await advanceWorkflowRun(deps, run1.id)
    const run2 = await deps.runStore.createRun({
      workflowId: workflow.id, workspaceId: WORKSPACE_ID, triggeredBy: USER_ID, triggerKind: 'manual', input: {},
    })
    await advanceWorkflowRun(deps, run2.id)

    expect(createCalls.map((c) => c.anchorKey)).toEqual([`${workflow.id}:s1`, `${workflow.id}:s1`])
    expect(byKey.size).toBe(1) // one page reused, not a duplicate per run
  })

  it('page create default (per-run) mints a fresh page each run with no anchorKey', async () => {
    const stores = makeFakeStores()
    const createCalls: Array<{ anchorKey?: string }> = []
    let n = 0
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport(),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
      createAnchorPage: async (params) => {
        createCalls.push(params)
        return { id: `00000000-0000-0000-0000-${String(n++).padStart(12, '0')}` }
      },
    }
    const def: WorkflowDefinition = {
      startStepId: 's1',
      steps: [{ id: 's1', type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'report', page: { create: true, title: 'Daily Report' } }],
    }
    const { workflow, run: run1 } = await seedWorkflowAndRun(deps, def)
    await advanceWorkflowRun(deps, run1.id)
    const run2 = await deps.runStore.createRun({
      workflowId: workflow.id, workspaceId: WORKSPACE_ID, triggeredBy: USER_ID, triggerKind: 'manual', input: {},
    })
    await advanceWorkflowRun(deps, run2.id)
    expect(createCalls).toHaveLength(2)
    expect(createCalls.every((c) => c.anchorKey === undefined)).toBe(true)
  })

  it('a branch routes on {{lastRun}} — false on the first run, true once a prior run exists', async () => {
    const stores = makeFakeStores()
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport(),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map([['echo', emitTool('echo')]]),
    }
    const def: WorkflowDefinition = {
      startStepId: 'decide',
      steps: [
        { id: 'decide', type: 'branch', condition: { '==': [{ var: 'lastRun.status' }, 'completed'] }, nextStepIdIfTrue: 'hadPrior', nextStepIdIfFalse: 'firstRun' },
        { id: 'hadPrior', type: 'tool_call', toolName: 'echo', arguments: {}, nextStepId: null },
        { id: 'firstRun', type: 'tool_call', toolName: 'echo', arguments: {}, nextStepId: null },
      ],
    }
    const { workflow, run: run1 } = await seedWorkflowAndRun(deps, def)
    await advanceWorkflowRun(deps, run1.id)
    expect(stores.stepRuns.filter((s) => s.runId === run1.id).map((s) => s.stepId)).toEqual(['decide', 'firstRun'])

    const run2 = await deps.runStore.createRun({
      workflowId: workflow.id, workspaceId: WORKSPACE_ID, triggeredBy: USER_ID, triggerKind: 'manual', input: {},
    })
    await advanceWorkflowRun(deps, run2.id)
    expect(stores.stepRuns.filter((s) => s.runId === run2.id).map((s) => s.stepId)).toEqual(['decide', 'hadPrior'])
  })

  it('outcome blockers/todo accept a plain string var; whitespace-only → []', async () => {
    const stores = makeFakeStores()
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport(),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map([['emit', emitTool()]]),
    }
    const { run } = await seedWorkflowAndRun(deps, {
      startStepId: 'b',
      steps: [
        { id: 'b', type: 'tool_call', toolName: 'emit', arguments: { value: 'one blocker' }, storeOutputAs: 'blockers', nextStepId: 't' },
        { id: 't', type: 'tool_call', toolName: 'emit', arguments: { value: '   ' }, storeOutputAs: 'todo' },
      ],
    })
    await advanceWorkflowRun(deps, run.id)
    const outcome = stores.runs.get(run.id)?.outcome
    expect(outcome?.blockers).toEqual(['one blocker'])
    expect(outcome?.todo).toEqual([])
  })

  it('outcome state coerces a non-object var to {}', async () => {
    const stores = makeFakeStores()
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport(),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map([['emit', emitTool()]]),
    }
    const { run } = await seedWorkflowAndRun(deps, {
      startStepId: 's',
      steps: [{ id: 's', type: 'tool_call', toolName: 'emit', arguments: { value: ['not', 'an', 'object'] }, storeOutputAs: 'state' }],
    })
    await advanceWorkflowRun(deps, run.id)
    expect(stores.runs.get(run.id)?.outcome?.state).toEqual({})
  })

  it('failed-run blockers UNION the author var with the terminal error', async () => {
    const stores = makeFakeStores()
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport({ fail: 'model refused' }),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map([['emit', emitTool()]]),
    }
    const { run } = await seedWorkflowAndRun(deps, {
      startStepId: 'b',
      steps: [
        { id: 'b', type: 'tool_call', toolName: 'emit', arguments: { value: ['author blocker'] }, storeOutputAs: 'blockers', nextStepId: 'go' },
        { id: 'go', type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'go' },
      ],
    })
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('failed')
    const blockers = stores.runs.get(run.id)?.outcome?.blockers ?? []
    expect(blockers).toContain('author blocker')
    expect(blockers.length).toBeGreaterThanOrEqual(2) // author entry + terminal error
  })

  it('outcome summary falls back to the last step output and caps at 2000 chars', async () => {
    const stores = makeFakeStores()
    const long = 'x'.repeat(2500)
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: makeConsultTransport({ responseText: long }),
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
    }
    const { run } = await seedWorkflowAndRun(deps, {
      startStepId: 's1',
      steps: [{ id: 's1', type: 'assistant_call', target: { assistantId: 'primary' }, prompt: 'go' }], // no summary var
    })
    await advanceWorkflowRun(deps, run.id)
    const summary = stores.runs.get(run.id)?.outcome?.summary
    expect(summary).toBe('x'.repeat(2000))
    expect(summary?.length).toBe(2000)
  })
})
