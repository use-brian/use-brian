import { describe, it, expect } from 'vitest'
import { advanceWorkflowRun, type ExecutorDeps, type SendPageResult } from '../executor.js'
import type {
  WorkflowDefinition,
  WorkflowRecord,
  WorkflowRunRecord,
  WorkflowRunStore,
  WorkflowStepRunRecord,
  WorkflowStore,
  WorkflowTriggerKind,
} from '../types.js'
import type { ConsultTransport } from '../../a2a/types.js'

// Minimal fakes — mirrors executor.test.ts's harness, narrowed to what the
// deterministic send_page dispatch needs (no consults ever run here).

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'
const USER_ID = '00000000-0000-0000-0000-000000000003'
const PAGE_ID = '00000000-0000-0000-0000-00000000aaaa'

function makeFakeStores() {
  const workflows = new Map<string, WorkflowRecord>()
  const runs = new Map<string, WorkflowRunRecord>()
  const stepRuns: WorkflowStepRunRecord[] = []
  let nextWorkflow = 100
  let nextRun = 200
  let nextStep = 300

  const workflowStore = {
    async create(params: {
      userId: string
      workspaceId: string
      name: string
      definition: WorkflowDefinition
    }) {
      const now = new Date()
      const record = {
        id: `00000000-0000-0000-0000-${String(nextWorkflow++).padStart(12, '0')}`,
        workspaceId: params.workspaceId,
        createdBy: params.userId,
        name: params.name,
        description: null,
        definition: params.definition,
        enabled: true,
        pausedReason: null,
        trigger: { kind: 'manual' as const },
        webhookSlug: null,
        webhookSecret: null,
        modelAlias: 'pro' as const,
        maxTurns: null,
        researchMode: false,
        nameManuallySet: false,
        lifecycleState: 'active' as const,
        lifecycleTransitionedAt: null,
        lifecycleReason: null,
        pinned: false,
        digestedAt: null,
        digestVerdict: null,
        createdAt: now,
        updatedAt: now,
      } satisfies WorkflowRecord
      workflows.set(record.id, record)
      return record
    },
    async getById(_userId: string, id: string) {
      return workflows.get(id) ?? null
    },
    async findByIdSystem(id: string) {
      return workflows.get(id) ?? null
    },
  } as unknown as WorkflowStore

  const runStore = {
    async createRun(params: {
      workflowId: string
      workspaceId: string
      triggeredBy: string | null
      triggerKind: WorkflowTriggerKind
      input: Record<string, unknown>
    }) {
      const now = new Date()
      const run: WorkflowRunRecord = {
        id: `00000000-0000-0000-0000-${String(nextRun++).padStart(12, '0')}`,
        workflowId: params.workflowId,
        workspaceId: params.workspaceId,
        triggeredBy: params.triggeredBy,
        triggerKind: params.triggerKind,
        status: 'pending',
        input: params.input,
        vars: {},
        currentStepId: null,
        error: null,
        outcome: null,
        startedAt: now,
        finishedAt: null,
        lastActiveAt: now,
      }
      runs.set(run.id, run)
      return run
    },
    async getRunSystem(id: string) {
      return runs.get(id) ?? null
    },
    async getLatestOutcomeForWorkflowSystem() {
      return null
    },
    async updateRun(id: string, fields: Partial<WorkflowRunRecord>) {
      const existing = runs.get(id)
      if (!existing) return null
      const updated = { ...existing, ...fields, lastActiveAt: new Date() }
      runs.set(id, updated)
      return updated
    },
    async createStepRun(params: {
      runId: string
      stepId: string
      stepType: WorkflowStepRunRecord['stepType']
      input: Record<string, unknown>
    }) {
      const stepRun: WorkflowStepRunRecord = {
        id: `00000000-0000-0000-0000-${String(nextStep++).padStart(12, '0')}`,
        runId: params.runId,
        stepId: params.stepId,
        stepType: params.stepType,
        status: 'running',
        input: params.input,
        output: null,
        error: null,
        startedAt: new Date(),
        finishedAt: null,
      }
      stepRuns.push(stepRun)
      return stepRun
    },
    async updateStepRun(id: string, fields: Partial<WorkflowStepRunRecord>) {
      const idx = stepRuns.findIndex((s) => s.id === id)
      if (idx === -1) return null
      stepRuns[idx] = { ...stepRuns[idx], ...fields }
      return stepRuns[idx]
    },
    async listStepRuns(_userId: string, runId: string) {
      return stepRuns.filter((s) => s.runId === runId)
    },
  } as unknown as WorkflowRunStore

  return { workflowStore, runStore, stepRuns }
}

const inertTransport: ConsultTransport = {
  async consult() {
    throw new Error('send_page tests must never consult')
  },
} as unknown as ConsultTransport

function makeDeps(stores: ReturnType<typeof makeFakeStores>, overrides: Partial<ExecutorDeps>): ExecutorDeps {
  return {
    workflowStore: stores.workflowStore,
    runStore: stores.runStore,
    consultTransport: inertTransport,
    resolvePrimary: async () => USER_ID,
    buildToolRegistry: async () => new Map(),
    ...overrides,
  }
}

const SEND_DEFINITION: WorkflowDefinition = {
  startStepId: 's1',
  steps: [
    {
      id: 's1',
      type: 'send_page',
      page: '{{input.event.pageId}}',
      via: 'gmail',
      to: { recordField: 'email' },
      subject: { literal: 'Re: {{input.event.title}}' },
    },
  ],
}

const BUTTON_INPUT = {
  trigger: { sourceType: 'page', provider: 'page', kind: 'button', pageId: PAGE_ID, actorId: USER_ID },
  event: { pageId: PAGE_ID, action: 'button', title: 'Acme draft' },
}

async function seed(
  deps: ExecutorDeps,
  triggerKind: WorkflowTriggerKind,
  input: Record<string, unknown> = BUTTON_INPUT,
  definition: WorkflowDefinition = SEND_DEFINITION,
) {
  const workflow = await deps.workflowStore.create({
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    name: 'send workflow',
    definition,
  })
  const run = await deps.runStore.createRun({
    workflowId: workflow.id,
    workspaceId: WORKSPACE_ID,
    triggeredBy: USER_ID,
    triggerKind,
    input,
  })
  return { workflow, run }
}

describe('[COMP:workflow/send-page-step] dispatchSendPage', () => {
  it('refuses to execute on a non-button run (requires_button_trigger)', async () => {
    const stores = makeFakeStores()
    let portCalls = 0
    const deps = makeDeps(stores, {
      sendPage: async () => {
        portCalls += 1
        return { status: 'sent', recipient: 'x@y.z', subject: 's', externalId: null }
      },
    })
    const { run } = await seed(deps, 'manual')
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.error.reason).toBe('requires_button_trigger')
    expect(portCalls).toBe(0)
  })

  it('fails typed when no send port is wired', async () => {
    const stores = makeFakeStores()
    const deps = makeDeps(stores, {})
    const { run } = await seed(deps, 'button')
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.error.reason).toBe('send_page_unavailable')
  })

  it('sends on a button run: interpolates the page token + literal subject, passes recordField through', async () => {
    const stores = makeFakeStores()
    let received: unknown = null
    const deps = makeDeps(stores, {
      sendPage: async (params) => {
        received = params
        return { status: 'sent', recipient: 'ceo@acme.com', subject: 'Re: Acme draft', externalId: 'gm-1' }
      },
    })
    const { workflow, run } = await seed(deps, 'button')
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('completed')
    expect(received).toMatchObject({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      pageId: PAGE_ID,
      workflowId: workflow.id,
      runId: run.id,
      stepId: 's1',
      via: 'gmail',
      to: { recordField: 'email' },
      subject: { literal: 'Re: Acme draft' },
    })
    const steps = stores.stepRuns
    expect(steps[0].output).toMatchObject({ sent: true, recipient: 'ceo@acme.com', externalId: 'gm-1' })
  })

  it('treats already_sent as an idempotent no-op success', async () => {
    const stores = makeFakeStores()
    const deps = makeDeps(stores, {
      sendPage: async (): Promise<SendPageResult> => ({
        status: 'already_sent',
        recipient: 'ceo@acme.com',
        sentAt: '2026-07-11T00:00:00.000Z',
      }),
    })
    const { run } = await seed(deps, 'button')
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('completed')
    expect(stores.stepRuns[0].output).toMatchObject({ sent: false, alreadySent: true })
  })

  it('maps blocked outcomes to typed step failures', async () => {
    const stores = makeFakeStores()
    const deps = makeDeps(stores, {
      sendPage: async (): Promise<SendPageResult> => ({
        status: 'blocked',
        reason: 'egress_blocked',
        message: 'confidential',
      }),
    })
    const { run } = await seed(deps, 'button')
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.error.reason).toBe('egress_blocked')
  })

  it('maps a thrown transport error to send_failed', async () => {
    const stores = makeFakeStores()
    const deps = makeDeps(stores, {
      sendPage: async () => {
        throw new Error('gmail 500')
      },
    })
    const { run } = await seed(deps, 'button')
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.reason).toBe('send_failed')
      expect(outcome.error.message).toContain('gmail 500')
    }
  })

  it('rejects a page token that resolves to a non-uuid', async () => {
    const stores = makeFakeStores()
    const deps = makeDeps(stores, {
      sendPage: async (): Promise<SendPageResult> => ({
        status: 'sent',
        recipient: 'x@y.z',
        subject: 's',
        externalId: null,
      }),
    })
    const { run } = await seed(deps, 'button', {
      trigger: { sourceType: 'page', kind: 'button' },
      event: { pageId: 'not-a-uuid', action: 'button', title: 't' },
    })
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.error.reason).toBe('invalid_send_page')
  })
})
