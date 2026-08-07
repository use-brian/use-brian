/**
 * Parallel fan-out semantics of the frontier scheduler (array `nextStepId`):
 * concurrent branch execution, the implicit join, first-failure settling,
 * the pause-while-parallel guard, and the explicit `startAt` resume
 * frontier. The sequential semantics regression suite lives in
 * `executor.test.ts` — every test there runs on the same scheduler.
 */
import { describe, it, expect } from 'vitest'
import { advanceWorkflowRun, type ExecutorDeps } from '../executor.js'
import type {
  WorkflowDefinition,
  WorkflowRecord,
  WorkflowRunRecord,
  WorkflowRunStore,
  WorkflowStepRunRecord,
  WorkflowStore,
} from '../types.js'
import type { ConsultRequest, ConsultResponse, ConsultTransport, Task } from '../../a2a/types.js'

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'
const PRIMARY_ASSISTANT_ID = '00000000-0000-0000-0000-000000000002'
const USER_ID = '00000000-0000-0000-0000-000000000003'

// ── Minimal fakes (mirrors executor.test.ts) ────────────────────────────

function makeFakeStores() {
  const workflows = new Map<string, WorkflowRecord>()
  const runs = new Map<string, WorkflowRunRecord>()
  const stepRuns: WorkflowStepRunRecord[] = []
  let nextWorkflow = 100
  let nextRun = 200
  let nextStep = 300

  const workflowStore: WorkflowStore = {
    async create(params) {
      const now = new Date()
      const record: WorkflowRecord = {
        id: `00000000-0000-0000-0000-${String(nextWorkflow++).padStart(12, '0')}`,
        workspaceId: params.workspaceId,
        createdBy: params.userId,
        name: params.name,
        description: params.description ?? null,
        definition: params.definition,
        enabled: true,
        pausedReason: null,
        trigger: params.trigger ?? { kind: 'manual' },
        webhookSlug: null,
        webhookSecret: null,
        modelAlias: 'pro',
        maxTurns: null,
        researchMode: false,
        nameManuallySet: false,
        lifecycleState: 'active',
        lifecycleTransitionedAt: null,
        lifecycleReason: null,
        pinned: false,
        managedBy: null,
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
      const updated = { ...existing, ...fields, updatedAt: new Date() } as WorkflowRecord
      workflows.set(id, updated)
      return updated
    },
    async delete(_userId, id) {
      return workflows.delete(id)
    },
    async findByWebhookSlugSystem() {
      return null
    },
    async findByIdSystem(id) {
      return workflows.get(id) ?? null
    },
    async updateAutoName() {
      return false
    },
  }

  const runStore: WorkflowRunStore = {
    async createRun({ workflowId, workspaceId, triggeredBy, triggerKind, input }) {
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
      const updated: WorkflowRunRecord = { ...existing, ...fields, lastActiveAt: new Date() }
      runs.set(id, updated)
      return updated
    },
    async createStepRun({ runId, stepId, stepType, input }) {
      const record: WorkflowStepRunRecord = {
        id: `00000000-0000-0000-0000-${String(nextStep++).padStart(12, '0')}`,
        runId,
        stepId,
        stepType,
        status: 'running',
        input: input ?? {},
        output: null,
        error: null,
        startedAt: new Date(),
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
      return [...runs.values()]
        .filter((r) => r.workflowId === workflowId)
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
        .slice(0, opts?.limit ?? 50)
    },
    async resolveRunsByIdPrefix() {
      return []
    },
    listRunsForPage: async () => [],
    async getLatestOutcomeForWorkflowSystem() {
      return null
    },
  }

  return { workflowStore, runStore, runs, stepRuns }
}

/**
 * A consult transport with per-prompt manual latches: `hold('b')` keeps the
 * step whose prompt is 'b' pending until `release('b')`. Unheld prompts
 * resolve on the next microtask. Records the order sends STARTED.
 */
function makeLatchedTransport(opts?: { failPrompts?: string[] }) {
  const started: string[] = []
  const settledOrder: string[] = []
  const latches = new Map<string, { promise: Promise<void>; release: () => void }>()
  let inFlight = 0
  let maxInFlight = 0

  const hold = (prompt: string) => {
    let release!: () => void
    const promise = new Promise<void>((res) => (release = res))
    latches.set(prompt, { promise, release })
  }
  const release = (prompt: string) => latches.get(prompt)?.release()

  const transport: ConsultTransport = {
    async send(request: ConsultRequest): Promise<ConsultResponse> {
      const prompt = request.message.parts
        .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
        .map((p) => p.text)
        .join('')
      started.push(prompt)
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      const latch = latches.get(prompt)
      if (latch) await latch.promise
      else await new Promise((res) => setTimeout(res, 0))
      inFlight--
      settledOrder.push(prompt)
      const taskId = `task_${started.length}`
      if (opts?.failPrompts?.includes(prompt)) {
        const task: Task = {
          taskId,
          contextId: `ctx_${taskId}`,
          status: {
            state: 'failed',
            timestamp: new Date().toISOString(),
            message: { messageId: 'm', role: 'agent', parts: [{ kind: 'text', text: `${prompt} exploded` }] },
          },
          artifacts: [],
        }
        return { task }
      }
      const task: Task = {
        taskId,
        contextId: `ctx_${taskId}`,
        status: { state: 'completed', timestamp: new Date().toISOString() },
        artifacts: [],
        history: [{ messageId: 'm', role: 'agent', parts: [{ kind: 'text', text: `${prompt}-out` }] }],
      }
      return { task }
    },
  }

  return { transport, started, settledOrder, hold, release, maxParallel: () => maxInFlight }
}

const call = (id: string, next: string | string[] | null, extra?: Record<string, unknown>) => ({
  id,
  type: 'assistant_call' as const,
  target: { assistantId: 'primary' as const },
  prompt: id,
  nextStepId: next,
  ...extra,
})

async function seed(
  deps: ExecutorDeps,
  definition: WorkflowDefinition,
): Promise<{ workflow: WorkflowRecord; run: WorkflowRunRecord }> {
  const workflow = await deps.workflowStore.create({
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    name: 'parallel test',
    definition,
  })
  const run = await deps.runStore.createRun({
    workflowId: workflow.id,
    workspaceId: WORKSPACE_ID,
    triggeredBy: USER_ID,
    triggerKind: 'manual',
    input: {},
  })
  return { workflow, run }
}

function makeDeps(stores: ReturnType<typeof makeFakeStores>, transport: ConsultTransport): ExecutorDeps {
  return {
    workflowStore: stores.workflowStore,
    runStore: stores.runStore,
    consultTransport: transport,
    resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
    buildToolRegistry: async () => new Map(),
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('[COMP:workflow/executor] Parallel fan-out', () => {
  it('runs fan-out branches concurrently and joins before the downstream step', async () => {
    const stores = makeFakeStores()
    const latched = makeLatchedTransport()
    const deps = makeDeps(stores, latched.transport)

    const definition: WorkflowDefinition = {
      startStepId: 'a',
      steps: [
        call('a', ['b', 'c', 'd']),
        call('b', 'j'),
        call('c', 'j'),
        call('d', 'j'),
        call('j', null, { storeOutputAs: 'joined' }),
      ],
    }
    const { run } = await seed(deps, definition)
    const outcome = await advanceWorkflowRun(deps, run.id)

    expect(outcome.kind).toBe('completed')
    // All three branches genuinely overlapped.
    expect(latched.maxParallel()).toBeGreaterThanOrEqual(3)
    // The join ran exactly once, and only after every branch settled.
    expect(latched.started.filter((p) => p === 'j')).toHaveLength(1)
    expect(latched.started.indexOf('j')).toBeGreaterThan(
      Math.max(
        latched.settledOrder.indexOf('b'),
        latched.settledOrder.indexOf('c'),
        latched.settledOrder.indexOf('d'),
      ) - 1,
    )
    const stepRuns = stores.stepRuns.filter((s) => s.runId === run.id)
    expect(stepRuns.filter((s) => s.stepId === 'j')).toHaveLength(1)
    expect(stepRuns.every((s) => s.status === 'completed')).toBe(true)
    // The crash-recovery frontier is cleared at terminal.
    const finished = stores.runs.get(run.id)!
    expect(finished.vars.__frontier).toBeUndefined()
    expect(finished.status).toBe('completed')
  })

  it('holds the join while one branch is still in flight', async () => {
    const stores = makeFakeStores()
    const latched = makeLatchedTransport()
    latched.hold('c')
    const deps = makeDeps(stores, latched.transport)

    const definition: WorkflowDefinition = {
      startStepId: 'a',
      steps: [call('a', ['b', 'c']), call('b', 'j'), call('c', 'j'), call('j', null)],
    }
    const { run } = await seed(deps, definition)
    const advancing = advanceWorkflowRun(deps, run.id)

    // Give the scheduler time to run b to completion while c hangs.
    await new Promise((res) => setTimeout(res, 20))
    expect(latched.settledOrder).toContain('b')
    expect(latched.started).not.toContain('j')

    latched.release('c')
    const outcome = await advancing
    expect(outcome.kind).toBe('completed')
    expect(latched.started).toContain('j')
  })

  it('makes both branches\' storeOutputAs vars visible to the join step', async () => {
    const stores = makeFakeStores()
    const latched = makeLatchedTransport()
    const deps = makeDeps(stores, latched.transport)

    const definition: WorkflowDefinition = {
      startStepId: 'a',
      steps: [
        call('a', ['b', 'c']),
        { ...call('b', 'j'), storeOutputAs: 'left' },
        { ...call('c', 'j'), storeOutputAs: 'right' },
        { ...call('j', null), prompt: 'join: {{vars.left}} + {{vars.right}}' },
      ],
    }
    const { run } = await seed(deps, definition)
    const outcome = await advanceWorkflowRun(deps, run.id)

    expect(outcome.kind).toBe('completed')
    const joinPrompt = latched.started.find((p) => p.startsWith('join:'))
    expect(joinPrompt).toBe('join: b-out + c-out')
  })

  it('fails the run on the first branch failure but lets the sibling settle honestly', async () => {
    const stores = makeFakeStores()
    const latched = makeLatchedTransport({ failPrompts: ['b'] })
    latched.hold('c')
    const deps = makeDeps(stores, latched.transport)

    const definition: WorkflowDefinition = {
      startStepId: 'a',
      steps: [call('a', ['b', 'c']), call('b', 'j'), call('c', 'j'), call('j', null)],
    }
    const { run } = await seed(deps, definition)
    const advancing = advanceWorkflowRun(deps, run.id)
    await new Promise((res) => setTimeout(res, 10))
    latched.release('c')
    const outcome = await advancing

    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.stepId).toBe('b')
      expect(outcome.error.reason).toBe('consult_failed')
    }
    const stepRuns = stores.stepRuns.filter((s) => s.runId === run.id)
    // The sibling that was already in flight completed and is recorded.
    expect(stepRuns.find((s) => s.stepId === 'c')?.status).toBe('completed')
    // The join never started.
    expect(stepRuns.find((s) => s.stepId === 'j')).toBeUndefined()
    expect(stores.runs.get(run.id)!.status).toBe('failed')
  })

  it('fails a wait step typed pause_in_parallel when a sibling branch is still live', async () => {
    const stores = makeFakeStores()
    const latched = makeLatchedTransport()
    latched.hold('c')
    const deps: ExecutorDeps = {
      ...makeDeps(stores, latched.transport),
      pauseRunForWait: async () => {
        throw new Error('pauseRunForWait must not be called while siblings are live')
      },
    }

    // Bypasses authoring validation on purpose (a branch can route into this
    // shape at run time even when the static check passes).
    const definition: WorkflowDefinition = {
      startStepId: 'a',
      steps: [
        call('a', ['w', 'c']),
        { id: 'w', type: 'wait', until: { duration: { minutes: 5 } }, nextStepId: null },
        call('c', null),
      ],
    }
    const { run } = await seed(deps, definition)
    const advancing = advanceWorkflowRun(deps, run.id)
    await new Promise((res) => setTimeout(res, 10))
    latched.release('c')
    const outcome = await advancing

    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.reason).toBe('pause_in_parallel')
    }
    const waitRun = stores.stepRuns.find((s) => s.runId === run.id && s.stepId === 'w')
    expect(waitRun?.status).toBe('failed')
  })

  it('honours a wait pause at the join once every branch has settled', async () => {
    const stores = makeFakeStores()
    const latched = makeLatchedTransport()
    let paused = false
    const deps: ExecutorDeps = {
      ...makeDeps(stores, latched.transport),
      pauseRunForWait: async () => {
        paused = true
      },
    }

    const definition: WorkflowDefinition = {
      startStepId: 'a',
      steps: [
        call('a', ['b', 'c']),
        call('b', 'w'),
        call('c', 'w'),
        { id: 'w', type: 'wait', until: { duration: { minutes: 5 } }, nextStepId: null },
      ],
    }
    const { run } = await seed(deps, definition)
    const outcome = await advanceWorkflowRun(deps, run.id)

    expect(outcome.kind).toBe('paused')
    expect(paused).toBe(true)
    expect(stores.runs.get(run.id)!.status).toBe('awaiting_wait')
    expect(stores.runs.get(run.id)!.currentStepId).toBe('w')
  })

  it('resumes from an explicit startAt frontier (fan-out resume)', async () => {
    const stores = makeFakeStores()
    const latched = makeLatchedTransport()
    const deps = makeDeps(stores, latched.transport)

    const definition: WorkflowDefinition = {
      startStepId: 'a',
      steps: [call('a', ['b', 'c']), call('b', null), call('c', null)],
    }
    const { run } = await seed(deps, definition)
    // Simulate a resume that already completed step "a": enter at its fan-out.
    await stores.runStore.updateRun(run.id, { status: 'running', currentStepId: 'a' })
    const outcome = await advanceWorkflowRun(deps, run.id, { startAt: ['b', 'c'] })

    expect(outcome.kind).toBe('completed')
    expect(latched.started.sort()).toEqual(['b', 'c'])
  })

  it('completes the run on an empty startAt frontier instead of re-entering at startStepId', async () => {
    const stores = makeFakeStores()
    const latched = makeLatchedTransport()
    const deps = makeDeps(stores, latched.transport)

    const definition: WorkflowDefinition = {
      startStepId: 'a',
      steps: [call('a', null)],
    }
    const { run } = await seed(deps, definition)
    await stores.runStore.updateRun(run.id, { status: 'running', currentStepId: 'a' })
    const outcome = await advanceWorkflowRun(deps, run.id, { startAt: [] })

    expect(outcome.kind).toBe('completed')
    // Nothing executed — the terminal step had already run before the pause.
    expect(latched.started).toEqual([])
  })

  it('a legacy cycle terminates after one visit per step instead of looping', async () => {
    const stores = makeFakeStores()
    const latched = makeLatchedTransport()
    const deps = makeDeps(stores, latched.transport)

    // Predates the DAG authoring check: b jumps back to a.
    const definition: WorkflowDefinition = {
      startStepId: 'a',
      steps: [call('a', 'b'), call('b', 'a')],
    }
    const { run } = await seed(deps, definition)
    const outcome = await advanceWorkflowRun(deps, run.id)

    expect(outcome.kind).toBe('completed')
    expect(latched.started).toEqual(['a', 'b'])
  })

  it('caps concurrent execution at the scheduler limit', async () => {
    const stores = makeFakeStores()
    const latched = makeLatchedTransport()
    const deps = makeDeps(stores, latched.transport)

    // Two chained fan-outs: 5 + 1 successors live at once, worst case.
    const definition: WorkflowDefinition = {
      startStepId: 'a',
      steps: [
        call('a', ['b1', 'b2', 'b3', 'b4', 'b5']),
        call('b1', null),
        call('b2', null),
        call('b3', null),
        call('b4', null),
        call('b5', null),
      ],
    }
    const { run } = await seed(deps, definition)
    const outcome = await advanceWorkflowRun(deps, run.id)

    expect(outcome.kind).toBe('completed')
    expect(latched.maxParallel()).toBeLessThanOrEqual(5)
    expect(latched.started.sort()).toEqual(['a', 'b1', 'b2', 'b3', 'b4', 'b5'])
  })
})
