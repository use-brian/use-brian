/**
 * Phase B — wait step end-to-end:
 *   1. Run a workflow with a wait step.
 *   2. Verify pauseRunForWait was called with the right run + step run ids
 *      and the computed dueAt timestamp.
 *   3. Resume by calling advanceWorkflowRun again on the same run.
 *
 * The actual SQL pause/resume bridge lives in apps/api wiring; this test
 * exercises the executor's contract with the bridge.
 *
 * [COMP:workflow/wait]
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { advanceWorkflowRun, type ExecutorDeps } from '../executor.js'
import type {
  WorkflowDefinition,
  WorkflowRecord,
  WorkflowRunRecord,
  WorkflowRunStore,
  WorkflowStepRunRecord,
  WorkflowStore,
} from '../types.js'
import { buildTool, type Tool } from '../../tools/types.js'
import type { ConsultRequest, ConsultResponse, ConsultTransport } from '../../a2a/types.js'

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'
const PRIMARY_ASSISTANT_ID = '00000000-0000-0000-0000-000000000002'
const USER_ID = '00000000-0000-0000-0000-000000000003'

function makeStores() {
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
        definition, enabled: true, pausedReason: null,
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

const PASSTHROUGH_TRANSPORT: ConsultTransport = {
  async send(_req: ConsultRequest): Promise<ConsultResponse> {
    return {
      task: {
        taskId: 't', contextId: 'c',
        status: { state: 'completed', timestamp: new Date().toISOString() },
        artifacts: [],
        history: [{ messageId: 'm', role: 'agent', parts: [{ kind: 'text', text: 'ok' }] }],
      },
    }
  },
}

function fakeTool(name: string, capture?: (i: unknown) => void): Tool {
  return buildTool({
    name,
    description: name,
    inputSchema: z.object({}).passthrough(),
    async execute(input) {
      capture?.(input)
      return { data: { ok: true } }
    },
  })
}

describe('[COMP:workflow/wait] Phase B — wait step + resume', () => {
  it('pauses on wait, calls pauseRunForWait, resumes on next advance', async () => {
    const stores = makeStores()
    const pauseCalls: Array<{ runId: string; stepRunId: string; dueAt: Date }> = []
    const tools = new Map<string, Tool>([
      ['stepA', fakeTool('stepA')],
      ['stepB', fakeTool('stepB')],
    ])
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: PASSTHROUGH_TRANSPORT,
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => tools,
      pauseRunForWait: async ({ runId, stepRunId, dueAt }) => {
        pauseCalls.push({ runId, stepRunId, dueAt })
      },
    }

    const definition: WorkflowDefinition = {
      startStepId: 'a',
      steps: [
        { id: 'a', type: 'tool_call', toolName: 'stepA', arguments: {}, nextStepId: 'wait1' },
        { id: 'wait1', type: 'wait', until: { duration: { minutes: 5 } }, nextStepId: 'b' },
        { id: 'b', type: 'tool_call', toolName: 'stepB', arguments: {}, nextStepId: null },
      ],
    }

    const workflow = await deps.workflowStore.create({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      name: 'wait test',
      definition,
    })
    const run = await deps.runStore.createRun({
      workflowId: workflow.id,
      workspaceId: WORKSPACE_ID,
      triggeredBy: USER_ID,
      triggerKind: 'manual',
    })

    // 1. First advance — runs stepA, pauses on wait.
    const first = await advanceWorkflowRun(deps, run.id)
    expect(first.kind).toBe('paused')
    if (first.kind === 'paused') {
      expect(first.reason).toBe('wait')
      expect(first.stepId).toBe('wait1')
    }
    expect(pauseCalls).toHaveLength(1)
    expect(pauseCalls[0].runId).toBe(run.id)
    expect(pauseCalls[0].dueAt.getTime()).toBeGreaterThan(Date.now() + 4 * 60 * 1000)
    expect(pauseCalls[0].dueAt.getTime()).toBeLessThan(Date.now() + 6 * 60 * 1000)

    // Run state recorded as awaiting_wait, currentStepId = 'wait1'.
    const paused = stores.runs.get(run.id)
    expect(paused?.status).toBe('awaiting_wait')
    expect(paused?.currentStepId).toBe('wait1')

    // The wait step run row should exist and still be 'running' (the bridge
    // never marks it completed — Phase C's resume path does that, OR the
    // executor on wake-up advances past it).
    const waitStep = stores.stepRuns.find((s) => s.stepId === 'wait1')
    expect(waitStep).toBeTruthy()

    // 2. Resume — simulate the poll worker calling advanceWorkflowRun again
    //    after the dueAt elapsed. The executor reads currentStepId and
    //    re-enters at the wait step. To resume past the wait, the bridge
    //    is responsible for advancing currentStepId BEFORE re-calling
    //    advanceWorkflowRun. We simulate that here.
    await deps.runStore.updateRun(run.id, {
      status: 'running',
      currentStepId: 'b',
    })
    const second = await advanceWorkflowRun(deps, run.id)
    expect(second.kind).toBe('completed')

    const finished = stores.runs.get(run.id)
    expect(finished?.status).toBe('completed')

    // stepA + wait1 + b = 3 step runs (the wait step run inserted on the first
    // advance is still there; b is a new one).
    expect(stores.stepRuns.map((s) => s.stepId)).toEqual(['a', 'wait1', 'b'])
  })

  it('legacy code path: when pauseRunForWait is absent, wait fails with Phase B error (regression)', async () => {
    const stores = makeStores()
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: PASSTHROUGH_TRANSPORT,
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
      // pauseRunForWait NOT provided → Phase A behavior preserved.
    }
    const workflow = await deps.workflowStore.create({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      name: 'wait',
      definition: {
        startStepId: 'w',
        steps: [{ id: 'w', type: 'wait', until: { duration: { minutes: 1 } } }],
      },
    })
    const run = await deps.runStore.createRun({
      workflowId: workflow.id,
      workspaceId: WORKSPACE_ID,
      triggeredBy: USER_ID,
      triggerKind: 'manual',
    })
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') {
      expect(outcome.error.reason).toBe('wait_requires_phase_b')
    }
  })

  it('computes dueAt from `until.duration` (hours + days)', async () => {
    const stores = makeStores()
    const pauses: Array<{ dueAt: Date }> = []
    const deps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: PASSTHROUGH_TRANSPORT,
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
      pauseRunForWait: async ({ dueAt }) => { pauses.push({ dueAt }) },
    }
    const workflow = await deps.workflowStore.create({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      name: 'long wait',
      definition: {
        startStepId: 'w',
        steps: [{ id: 'w', type: 'wait', until: { duration: { days: 1, hours: 6 } } }],
      },
    })
    const run = await deps.runStore.createRun({
      workflowId: workflow.id,
      workspaceId: WORKSPACE_ID,
      triggeredBy: USER_ID,
      triggerKind: 'manual',
    })
    await advanceWorkflowRun(deps, run.id)
    expect(pauses).toHaveLength(1)
    const ms = pauses[0].dueAt.getTime() - Date.now()
    // 30h ± 1 minute slack for test execution time.
    expect(ms).toBeGreaterThan(30 * 60 * 60 * 1000 - 60_000)
    expect(ms).toBeLessThan(30 * 60 * 60 * 1000 + 60_000)
  })
})
