/**
 * Phase C — workflow approval bridge.
 *
 * Tests both halves end-to-end with in-memory fakes:
 *   - request: ask-policy tool_call → executor pauses → bridge writes
 *     pending row + dispatches delivery + emits audit
 *   - resume(approve): tool runs with frozen args → run continues
 *   - resume(reject): step+run marked failed
 *   - sweep: expired rows mark runs failed
 *
 * [COMP:workflow/approval]
 */

import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { advanceWorkflowRun, createExecutionContext, type ExecutorDeps } from '@use-brian/core'
import { buildTool, type Tool } from '@use-brian/core'
import type {
  WorkflowDefinition,
  WorkflowRecord,
  WorkflowRunRecord,
  WorkflowRunStore,
  WorkflowStepRunRecord,
  WorkflowStore,
} from '@use-brian/core'
import type { ConsultRequest, ConsultResponse, ConsultTransport } from '@use-brian/core'
import {
  makeRequestApproval,
  resumeFromApproval,
  sweepExpiredApprovals,
  type ApprovalBridgeDeps,
} from '../approval.js'
import type { PendingApproval, PendingApprovalsStore } from '../../db/pending-approvals-store.js'
import type { WorkspaceAuditStore } from '../../db/workspace-audit-store.js'
import { createAuthorityLease, executeWithCurrentAuthority, runWithAuthorityLease } from '../../context-scope/authority-lease.js'

vi.mock('../../db/client.js', () => ({ query: vi.fn() }))
import { query } from '../../db/client.js'
import { maybeHandleApprovalReply } from '../approval-replies.js'
import { ChannelInteractions } from '../../routes/channel-interactions.js'

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'
const PRIMARY_ASSISTANT_ID = '00000000-0000-0000-0000-000000000002'
const USER_ID = '00000000-0000-0000-0000-000000000003'

// ── Fakes ────────────────────────────────────────────────────────────────

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
        lifecycleState: 'active', lifecycleTransitionedAt: null, lifecycleReason: null,
        pinned: false,
        managedBy: null,
        createdAt: now, updatedAt: now,
      }
      workflows.set(r.id, r); return r
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
    async listRunsForWorkflow(_u, workflowId) {
      return [...runs.values()].filter((r) => r.workflowId === workflowId)
    },
    async resolveRunsByIdPrefix(_u, idPrefix) {
      return [...runs.values()].filter((r) => r.id.startsWith(idPrefix))
    },
    listRunsForPage: async () => [],
    async getLatestOutcomeForWorkflowSystem(workflowId, excludeRunId) {
      const terminal = [...runs.values()]
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

function fakeApprovalsStore(): PendingApprovalsStore & { rows: PendingApproval[] } {
  const rows: PendingApproval[] = []
  let n = 500
  const id = () => `00000000-0000-0000-0000-${String(n++).padStart(12, '0')}`
  return {
    rows,
    async create(params) {
      const r: PendingApproval = {
        id: id(),
        workspaceId: params.workspaceId,
        workflowRunId: params.workflowRunId,
        workflowStepRunId: params.workflowStepRunId,
        toolName: params.toolName,
        arguments: params.arguments,
        approverUserId: params.approverUserId,
        deliveryChannelType: params.deliveryChannelType,
        deliveryChannelId: params.deliveryChannelId ?? null,
        status: 'pending',
        expiresAt: params.expiresAt ?? null,
        respondedAt: null,
        respondedBy: null,
        rejectReason: null,
        createdAt: new Date(),
        kind: 'workflow_step',
        blockingSessionId: null,
        approvalPayload: params.approvalPayload ?? {},
        originatingAssistantId: params.originatingAssistantId,
        answerText: null,
      }
      rows.push(r); return r
    },
    async createToolInvocation() {
      throw new Error('createToolInvocation not used in workflow approval tests')
    },
    async createStagedSkillUpdate() {
      throw new Error('createStagedSkillUpdate not used in workflow approval tests')
    },
    async createStagedSkillCreation() {
      throw new Error('createStagedSkillCreation not used in workflow approval tests')
    },
    async findPendingStagedSkillUpdate() {
      return null
    },
    async findPendingStagedSkillCreation() {
      return null
    },
    async createWorkflowRefinement(): Promise<never> {
      throw new Error('createWorkflowRefinement not used in workflow approval tests')
    },
    async findPendingWorkflowRefinement() {
      return null
    },
    async createStagedWrite() {
      throw new Error('createStagedWrite not used in workflow approval tests')
    },
    async createQuestion() {
      throw new Error('createQuestion not used in workflow approval tests')
    },
    async createBrowserSkillSend() {
      throw new Error('createBrowserSkillSend not used in workflow approval tests')
    },
    async createBrowserSkillAudit() {
      throw new Error('createBrowserSkillAudit not used in workflow approval tests')
    },
    async createEmailSenderCard() {
      throw new Error('createEmailSenderCard not used in workflow approval tests')
    },
    async expireById(id) {
      const row = rows.find(r => r.id === id && r.status === 'pending')
      if (row) row.status = 'expired'
    },
    async recordAnswer() {
      throw new Error('recordAnswer not used in workflow approval tests')
    },
    async listSkillApprovals(_u, workspaceId) {
      return rows.filter(
        (r) =>
          r.workspaceId === workspaceId &&
          r.status === 'pending' &&
          (r.kind === 'staged_skill_update' || r.kind === 'staged_skill_creation'),
      )
    },
    async listPendingForWorkspace(_u, workspaceId) {
      return rows.filter((r) => r.workspaceId === workspaceId && r.status === 'pending')
    },
    async countPendingForUser(userId) {
      return rows.filter((r) => r.approverUserId === userId && r.status === 'pending').length
    },
    async getById(_u, id) { return rows.find((r) => r.id === id) ?? null },
    async getByIdSystem(id) { return rows.find((r) => r.id === id) ?? null },
    async reviseWorkflowEmailBody() {
      throw new Error('reviseWorkflowEmailBody not used in workflow approval tests')
    },
    async respond(id, decision, responder, reason) {
      const r = rows.find((x) => x.id === id)
      if (!r || r.status !== 'pending') return null
      r.status = decision
      r.respondedAt = new Date()
      r.respondedBy = responder
      r.rejectReason = reason ?? null
      return r
    },
    async expireDue() {
      const out: PendingApproval[] = []
      for (const r of rows) {
        if (r.status === 'pending' && r.expiresAt && r.expiresAt.getTime() <= Date.now()) {
          r.status = 'expired'
          r.respondedAt = new Date()
          out.push(r)
        }
      }
      return out
    },
    async expireDueQuestions() {
      const out: PendingApproval[] = []
      for (const r of rows) {
        if (
          r.status === 'pending'
          && r.kind === 'question'
          && r.expiresAt
          && r.expiresAt.getTime() <= Date.now()
        ) {
          r.status = 'expired'
          r.respondedAt = new Date()
          out.push(r)
        }
      }
      return out
    },
    // Admin-side methods — unused by these workflow tests but required
    // by the PendingApprovalsStore interface (Wave 3 admin surface).
    async listForAdmin() { return { rows: [], nextCursor: null } },
    async rankWorkspacesForAdmin() { return [] },
    async getByIdForAdmin() { return null },
    async forceExpireForAdmin(id) {
      const r = rows.find((x) => x.id === id)
      if (!r || r.status !== 'pending') return null
      r.status = 'expired'
      r.respondedAt = new Date()
      return r
    },
  }
}

function fakeAuditStore(): WorkspaceAuditStore & { events: Array<{ eventType: string; subjectId: string | null; details: Record<string, unknown> }> } {
  const events: Array<{ eventType: string; subjectId: string | null; details: Record<string, unknown> }> = []
  return {
    events,
    async append(p) {
      events.push({
        eventType: p.eventType,
        subjectId: p.subjectId ?? null,
        details: p.details ?? {},
      })
    },
    async list() { return [] },
  }
}

const FAKE_TRANSPORT: ConsultTransport = {
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

function askPolicyTool(name: string, capture?: (i: unknown) => void): Tool {
  const t = buildTool({
    name,
    description: 'ask-policy tool',
    inputSchema: z.object({}).passthrough(),
    requiresConfirmation: true,
    async execute(input) {
      capture?.(input)
      return { data: { sent: true, input } }
    },
  })
  // Simulate the MCP-bridge contract: resolveConfirmation true = ask.
  t.resolveConfirmation = async () => true
  return t
}

// ── Cancellation regressions (real bridge + downstream executor) ─────────

async function cancellationFixture() {
  const stores = makeStores()
  const approvals = fakeApprovalsStore()
  const execute = vi.fn(async (_input: unknown, _ctx: { abortSignal: AbortSignal }) => ({ data: { sent: true } }))
  const downstream = vi.fn(async (_input: unknown, _ctx: { abortSignal: AbortSignal }) => ({ data: { continued: true } }))
  const tool = buildTool({ name: 'send', description: 'send', inputSchema: z.object({}), execute })
  const next = buildTool({ name: 'next', description: 'next', inputSchema: z.object({}), execute: downstream })
  const registry = new Map([['send', tool], ['next', next]])
  const executorDeps: ExecutorDeps = {
    workflowStore: stores.workflowStore, runStore: stores.runStore,
    consultTransport: FAKE_TRANSPORT, resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
    buildToolRegistry: async () => registry,
  }
  const deps: ApprovalBridgeDeps = {
    ...executorDeps, approvalsStore: approvals, auditStore: fakeAuditStore(),
    deliveries: async () => {}, executorDeps,
  }
  const workflow = await stores.workflowStore.create({
    userId: USER_ID, workspaceId: WORKSPACE_ID, name: 'cancellation',
    definition: { startStepId: 'send', steps: [
      { id: 'send', type: 'tool_call', toolName: 'send', arguments: {}, nextStepId: 'next' },
      { id: 'next', type: 'tool_call', toolName: 'next', arguments: {}, nextStepId: null },
    ] },
  })
  const run = await stores.runStore.createRun({ workflowId: workflow.id, workspaceId: WORKSPACE_ID, triggeredBy: USER_ID, triggerKind: 'manual' })
  const step = await stores.runStore.createStepRun({ runId: run.id, stepId: 'send', stepType: 'tool_call', input: {} })
  await stores.runStore.updateRun(run.id, { status: 'awaiting_input', currentStepId: 'send' })
  const approval = await approvals.create({ workspaceId: WORKSPACE_ID, workflowRunId: run.id,
    workflowStepRunId: step.id, toolName: 'send', arguments: {}, approverUserId: USER_ID,
    originatingAssistantId: PRIMARY_ASSISTANT_ID, deliveryChannelType: 'web', expiresAt: null,
  })
  return { ...stores, deps, approvals, approval, run, tool, registry, execute, downstream }
}

function deferred() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

function cancellationRunScope(signal = new AbortController().signal) {
  const access = { workspaceId: WORKSPACE_ID, userId: USER_ID, assistantId: PRIMARY_ASSISTANT_ID,
    assistantKind: 'primary' as const, clearance: 'internal' as const, compartments: ['product'],
    mutationCompartments: ['product'], projectIds: [], visibilityAssistantIds: null }
  const authority = createAuthorityLease(access, async () => access)
  return {
    assistantClearance: 'internal' as const,
    turnScope: { access, activeGroupId: null, activeProjectId: null, effectiveCompartments: ['product'],
      effectiveProjectIds: [], writeCompartments: ['product'], writeProjectIds: [] },
    executionContext: createExecutionContext({
      identity: { kind: 'system', purpose: 'workflow', jobId: 'run-fixture' },
      ownership: { kind: 'workspace', workspaceId: WORKSPACE_ID }, access, authority,
      writeDefaults: { compartments: ['product'], projectIds: [] },
      lifecycle: { abortSignal: signal, sessionId: 'run-fixture', channelType: 'workflow', channelId: 'run-fixture' },
    }),
  }
}

it.each(['none', 'stop', 'lifecycle'] as const)('projects live execution authority while preserving %s cancellation on approval resume', async source => {
  const f = await cancellationFixture()
  const stop = new AbortController(), lifecycle = new AbortController()
  const scope = cancellationRunScope(lifecycle.signal)
  f.deps.executorDeps.resolveRunScope = async () => scope
  expect(await resumeFromApproval(f.deps, f.approval.id, 'approved', USER_ID, undefined,
    source === 'none' ? undefined : stop.signal)).toMatchObject({ status: 'completed' })
  const context = f.execute.mock.calls[0][1] as import('@use-brian/core').ToolContext
  expect(context.authority).toBe(scope.executionContext.security.authority)
  expect(context.mutationCompartments).toEqual(['product'])
  expect(context.executionContext?.lifecycle.abortSignal).toBe(context.abortSignal)
  if (source === 'none') expect(context.executionContext).toBe(scope.executionContext)
  else {
    expect(context.abortSignal.aborted).toBe(false)
    if (source === 'stop') stop.abort()
    else lifecycle.abort()
    expect(context.abortSignal.aborted).toBe(true)
  }
})

it.each(['claim', 'scope', 'registry', 'authority', 'tool', 'downstream_registry', 'downstream_tool'] as const)(
  'Stop during %s preserves the submitted decision and terminates continuation', async stage => {
    const f = await cancellationFixture()
    const controller = new AbortController()
    const entered = deferred(), paused = deferred()
    const pause = async () => { entered.release(); await paused.promise }
    if (stage === 'claim') {
      const respond = f.approvals.respond.bind(f.approvals)
      f.approvals.respond = async (...args) => { const row = await respond(...args); await pause(); return row }
    }
    if (stage === 'scope') f.deps.executorDeps.resolveRunScope = async () => { await pause(); throw new Error('scope cancelled') }
    if (stage === 'registry') f.deps.buildToolRegistry = async () => { await pause(); return f.registry }
    if (stage === 'authority') f.deps.executorDeps.resolveRunScope = async () => ({
      ...cancellationRunScope(),
      executeWithAuthority: async operation => { await pause(); return operation() },
    })
    if (stage === 'downstream_registry') f.deps.executorDeps.buildToolRegistry = async () => { await pause(); return f.registry }
    if (stage === 'tool') f.execute.mockImplementation(async (_input, ctx) => {
      expect(ctx.abortSignal).toBe(controller.signal)
      await pause()
      expect(ctx.abortSignal.aborted).toBe(true)
      return { data: { sent: true } } // A non-cooperative tool may have committed an effect.
    })
    if (stage === 'downstream_tool') f.downstream.mockImplementation(async (_input, ctx) => {
      expect(ctx.abortSignal.aborted).toBe(false)
      await pause()
      expect(ctx.abortSignal.aborted).toBe(true)
      return { data: { continued: true } }
    })
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ id: f.approval.id }] } as never)
    const interactions = new ChannelInteractions()
    const scope = { channelType: 'custom', integrationId: 'integration', conversationId: 'chat', senderId: 'sender' }
    const ack = vi.fn()
    interactions.registerTurn(scope, controller, { onAbort: ack })
    const result = maybeHandleApprovalReply({ approvalsStore: f.approvals, bridgeDeps: f.deps }, USER_ID, `approve ${f.approval.id}`, {
      workspaceId: WORKSPACE_ID, assistantId: PRIMARY_ASSISTANT_ID, authorized: async () => true, abortSignal: controller.signal,
    })
    await entered.promise
    expect(interactions.handle(scope, { kind: 'text', text: 'stop' }).handled).toBe(true)
    expect(ack).toHaveBeenCalledOnce()
    paused.release()
    expect(await result).toMatchObject({ status: 'approval_submitted_workflow_cancelled', runId: f.run.id })
    expect(f.approval.status).toBe('approved')
    expect(f.runs.get(f.run.id)).toMatchObject({ status: 'failed', finishedAt: expect.any(Date), error: {
      reason: stage.startsWith('downstream') ? 'workflow_cancelled' : 'approval_resume_cancelled',
    } })
    expect(f.stepRuns[0].status).toBe(['tool', 'downstream_registry', 'downstream_tool'].includes(stage) ? 'completed' : 'failed')
    if (['claim', 'scope', 'registry', 'authority'].includes(stage)) expect(f.execute).not.toHaveBeenCalled()
    if (stage !== 'downstream_tool') expect(f.downstream).not.toHaveBeenCalled()
  },
)

it('does not revive a cancelled run through an approval whose delivery was in flight during Stop', async () => {
  const f = await cancellationFixture()
  const controller = new AbortController()
  const entered = deferred(), paused = deferred()
  f.registry.get('next')!.requiresConfirmation = true
  f.deps.executorDeps.requestApproval = makeRequestApproval({ ...f.deps,
    deliveries: async () => { entered.release(); await paused.promise },
  })
  const result = resumeFromApproval(f.deps, f.approval.id, 'approved', USER_ID, undefined, controller.signal)
  await entered.promise
  const outstanding = f.approvals.rows.find(row => row.toolName === 'next')!
  expect(outstanding.status).toBe('pending')
  controller.abort(); paused.release()
  expect(await result).toMatchObject({ status: 'approval_submitted_workflow_cancelled' })
  expect(await resumeFromApproval(f.deps, outstanding.id, 'approved', USER_ID)).toMatchObject({ status: 'workflow_cancelled' })
  expect(outstanding.status).toBe('expired')
  expect(f.downstream).not.toHaveBeenCalled()
  expect(f.runs.get(f.run.id)).toMatchObject({ status: 'failed', error: { reason: 'workflow_cancelled' } })
})

it('rechecks a cancelled run when Stop races the approval claim', async () => {
  const f = await cancellationFixture()
  const respond = f.approvals.respond.bind(f.approvals)
  f.approvals.respond = async (...args) => {
    await f.runStore.updateRun(f.run.id, { status: 'failed', error: { reason: 'workflow_cancelled' }, finishedAt: new Date() })
    return respond(...args)
  }
  expect(await resumeFromApproval(f.deps, f.approval.id, 'approved', USER_ID)).toMatchObject({ status: 'workflow_cancelled' })
  expect(f.execute).not.toHaveBeenCalled()
  expect(f.downstream).not.toHaveBeenCalled()
})

it('does not claim an already cancelled approval', async () => {
  const f = await cancellationFixture()
  const controller = new AbortController(); controller.abort()
  expect(await resumeFromApproval(f.deps, f.approval.id, 'approved', USER_ID, undefined, controller.signal)).toEqual({ status: 'cancelled', runId: null })
  expect(f.approval.status).toBe('pending')
  expect(f.runs.get(f.run.id)?.status).toBe('awaiting_input')
})

it('checks cancellation at the tool boundary after argument validation', async () => {
  const f = await cancellationFixture()
  const controller = new AbortController()
  vi.spyOn(f.tool.inputSchema, 'parse').mockImplementation(() => { controller.abort(); return {} })
  expect(await resumeFromApproval(f.deps, f.approval.id, 'approved', USER_ID, undefined, controller.signal)).toMatchObject({ status: 'approval_submitted_workflow_cancelled' })
  expect(f.execute).not.toHaveBeenCalled()
  expect(f.runs.get(f.run.id)?.status).toBe('failed')
})

// ── Tests ────────────────────────────────────────────────────────────────

describe('[COMP:workflow/approval] Phase C — pause + resume', () => {
  it.each(['before','during','terminal','prompt'] as const)('refuses an approved operation when authority changes at %s execution', async timing => {
    const stores=makeStores(),approvals=fakeApprovalsStore()
    let revoked=false
    const execute=vi.fn(()=>{if(timing==='during')revoked=true;return {data:'private result',isError:false}})
    const tool=askPolicyTool('gmailSendMessage',execute)
    const deliveries=vi.fn(async()=>{})
    if(timing==='prompt'){
      const create=approvals.create.bind(approvals)
      approvals.create=async params=>{const row=await create(params);revoked=true;return row}
    }
    const executorDeps:ExecutorDeps={workflowStore:stores.workflowStore,runStore:stores.runStore,
      consultTransport:FAKE_TRANSPORT,resolvePrimary:async()=>PRIMARY_ASSISTANT_ID,
      buildToolRegistry:async()=>new Map([[tool.name,tool]]),
      resolveRunScope:async()=>{
        if(revoked)throw Object.assign(new Error('Review permissions and start a new run.'),{reason:'workflow_authority_unavailable'})
        const ceiling={workspaceId:WORKSPACE_ID,userId:USER_ID,clearance:'internal' as const,compartments:[],mutationCompartments:[],projectIds:[],visibilityAssistantIds:null}
        const lease=createAuthorityLease(ceiling,async()=>revoked?null:ceiling)
        return {assistantClearance:'internal',turnScope:{
          access:{workspaceId:WORKSPACE_ID,userId:USER_ID,assistantId:PRIMARY_ASSISTANT_ID,assistantKind:'primary',clearance:'internal',compartments:[],projectIds:[]},
          activeGroupId:null,activeProjectId:null,effectiveCompartments:[],effectiveProjectIds:[],writeCompartments:[],writeProjectIds:[],
        },executeWithAuthority:<T>(operation:()=>Promise<T>)=>runWithAuthorityLease(lease,()=>executeWithCurrentAuthority(operation))}
      }}
    const bridge:ApprovalBridgeDeps={approvalsStore:approvals,auditStore:fakeAuditStore(),workflowStore:stores.workflowStore,
      runStore:stores.runStore,buildToolRegistry:executorDeps.buildToolRegistry,resolvePrimary:executorDeps.resolvePrimary,
      deliveries,executorDeps}
    executorDeps.requestApproval=makeRequestApproval(bridge)
    const workflow=await stores.workflowStore.create({userId:USER_ID,workspaceId:WORKSPACE_ID,name:'Review fixture',definition:{
      startStepId:'send',steps:[{id:'send',type:'tool_call',toolName:tool.name,arguments:{to:'recipient@example.com',body:'Fixture'},approval:{deliveryChannel:'web'}}],
    }})
    const run=await stores.runStore.createRun({workflowId:workflow.id,workspaceId:WORKSPACE_ID,triggeredBy:USER_ID,triggerKind:'manual'})
    expect((await advanceWorkflowRun(executorDeps,run.id)).kind).toBe(timing==='prompt'?'failed':'paused')
    if(timing==='prompt'){
      expect(deliveries).not.toHaveBeenCalled()
      revoked=false // Restoring access cannot revive the failed run via its card.
    }
    if(timing==='terminal')await stores.runStore.updateRun(run.id,{status:'failed'})
    if(timing==='before')revoked=true
    const outcome=await resumeFromApproval(bridge,approvals.rows[0].id,'approved',USER_ID)
    expect(outcome.status).toBe('failed')
    expect(execute).toHaveBeenCalledTimes(timing==='during'?1:0)
    expect(stores.runs.get(run.id)?.status).toBe('failed')
    expect(JSON.stringify(stores.stepRuns)).not.toContain('private result')
    if(timing==='during')expect(stores.runs.get(run.id)?.error).toMatchObject({reason:'authority_changed'})
  })
  it.each([
    { requested: 'telegram' as const, target: null, concrete: 'telegram' },
    { requested: 'recent' as const, target: null, concrete: 'web' },
    { requested: 'recent' as const, target: { channelType: 'slack' as const, channelId: 'C123', threadRef: '123.456', channelIntegrationId: 'byo' }, concrete: 'slack' },
  ])('pauses with $requested approval delivery resolved to $concrete', async ({ requested, target, concrete }) => {
    const stores = makeStores()
    const approvals = fakeApprovalsStore()
    const audit = fakeAuditStore()
    const dispatched: Array<{ approvalId: string; channel: string }> = []

    const askTool = askPolicyTool('gmailSendMessage', () => {
      throw new Error('tool should not run during pause')
    })
    askTool.describeConfirmation = async () => [
      '• From: sales@example.com',
      '• To: me@example.com',
    ]

    const executorDeps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: FAKE_TRANSPORT,
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map([['gmailSendMessage', askTool]]),
    }

    const resolveRecentChannel = vi.fn().mockResolvedValue(target)
    const bridgeDeps: ApprovalBridgeDeps = {
      resolveRecentChannel,
      approvalsStore: approvals,
      auditStore: audit,
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      buildToolRegistry: executorDeps.buildToolRegistry,
      resolvePrimary: executorDeps.resolvePrimary,
      deliveries: async (p) => { dispatched.push({ approvalId: p.approvalId, channel: p.deliveryChannelType }) },
      executorDeps,
    }
    executorDeps.requestApproval = makeRequestApproval(bridgeDeps)

    const definition: WorkflowDefinition = {
      startStepId: 'send',
      steps: [
        {
          id: 'send',
          type: 'tool_call',
          toolName: 'gmailSendMessage',
          arguments: { to: 'me@example.com', body: 'hi' },
          approval: { deliveryChannel: requested },
        },
      ],
    }
    const workflow = await stores.workflowStore.create({
      userId: USER_ID, workspaceId: WORKSPACE_ID, name: 'send mail', definition,
    })
    const run = await stores.runStore.createRun({
      workflowId: workflow.id, workspaceId: WORKSPACE_ID,
      triggeredBy: USER_ID, triggerKind: 'manual',
    })

    const outcome = await advanceWorkflowRun(executorDeps, run.id)
    expect(outcome.kind).toBe('paused')
    if (outcome.kind === 'paused') {
      expect(outcome.reason).toBe('approval')
    }
    // Pending row created.
    expect(approvals.rows).toHaveLength(1)
    expect(approvals.rows[0].toolName).toBe('gmailSendMessage')
    expect(approvals.rows[0].originatingAssistantId).toBe(PRIMARY_ASSISTANT_ID)
    expect(approvals.rows[0].arguments).toEqual({ to: 'me@example.com', body: 'hi' })
    expect(approvals.rows[0].approvalPayload.displayLines).toEqual([
      '• From: sales@example.com',
      '• To: me@example.com',
    ])
    expect(approvals.rows[0].deliveryChannelType).toBe(concrete)
    expect(approvals.rows[0].deliveryChannelId).toBe(target?.channelId ?? null)
    expect(approvals.rows[0].approvalPayload.deliveryTarget).toEqual(target ?? undefined)
    if (requested === 'recent') {
      expect(resolveRecentChannel).toHaveBeenCalledExactlyOnceWith({
        workspaceId: WORKSPACE_ID, assistantId: PRIMARY_ASSISTANT_ID, approverUserId: USER_ID,
      })
    } else {
      expect(resolveRecentChannel).not.toHaveBeenCalled()
    }
    // Delivery dispatched.
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].channel).toBe(concrete)
    // Audit event.
    expect(audit.events.find((e) => e.eventType === 'workflow.approval_requested')).toBeTruthy()
    // Run state = awaiting_input.
    expect(stores.runs.get(run.id)?.status).toBe('awaiting_input')
  })

  it('freezes an exact decision application id into the pending approval payload', async () => {
    const stores = makeStores()
    const approvals = fakeApprovalsStore()
    const audit = fakeAuditStore()
    const executorDeps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: FAKE_TRANSPORT,
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map(),
    }
    const workflow = await stores.workflowStore.create({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      name: 'reviewed send',
      definition: {
        startStepId: 'send',
        steps: [{ id: 'send', type: 'tool_call', toolName: 'imapSendMessage', arguments: {} }],
      },
    })
    const run = await stores.runStore.createRun({
      workflowId: workflow.id,
      workspaceId: WORKSPACE_ID,
      triggeredBy: USER_ID,
      triggerKind: 'manual',
    })
    const requestApproval = makeRequestApproval({
      approvalsStore: approvals,
      auditStore: audit,
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      buildToolRegistry: executorDeps.buildToolRegistry,
      resolvePrimary: executorDeps.resolvePrimary,
      deliveries: async () => {},
      executorDeps,
    })
    const applicationId = '00000000-0000-4000-8000-000000000099'

    await requestApproval({
      runId: run.id,
      stepRunId: '00000000-0000-4000-8000-000000000098',
      workspaceId: WORKSPACE_ID,
      approverUserId: USER_ID,
      assistantId: PRIMARY_ASSISTANT_ID,
      toolName: 'imapSendMessage',
      arguments: { account: 'primary-mailbox' },
      deliveryChannel: 'web',
      expiresAt: null,
      decisionApplicationId: applicationId,
    })

    expect(approvals.rows[0].approvalPayload).toEqual({ decisionApplicationId: applicationId })
  })

  it('approval.required forces a frozen approval even when the tool policy is allow', async () => {
    const stores = makeStores()
    const approvals = fakeApprovalsStore()
    const audit = fakeAuditStore()
    let executed = false
    const allowTool = buildTool({
      name: 'imapSendMessage',
      description: 'send mail',
      inputSchema: z.object({
        to: z.array(z.string()),
        subject: z.string(),
        body: z.string(),
        inReplyTo: z.string(),
      }),
      requiresConfirmation: false,
      async execute() {
        executed = true
        return { data: { ok: true } }
      },
    })
    const executorDeps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: FAKE_TRANSPORT,
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map([['imapSendMessage', allowTool]]),
    }
    const bridgeDeps: ApprovalBridgeDeps = {
      approvalsStore: approvals,
      auditStore: audit,
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      buildToolRegistry: executorDeps.buildToolRegistry,
      resolvePrimary: executorDeps.resolvePrimary,
      deliveries: async () => {},
      executorDeps,
    }
    executorDeps.requestApproval = makeRequestApproval(bridgeDeps)
    const workflow = await stores.workflowStore.create({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      name: 'always review mail',
      definition: {
        startStepId: 'send',
        steps: [{
          id: 'send',
          type: 'tool_call',
          toolName: 'imapSendMessage',
          arguments: {
            to: ['buyer@customer.example'],
            subject: 'Re: Question',
            body: 'Draft body',
            inReplyTo: 'INBOX:17',
          },
          approval: { required: true },
        }],
      },
    })
    const run = await stores.runStore.createRun({
      workflowId: workflow.id,
      workspaceId: WORKSPACE_ID,
      triggeredBy: USER_ID,
      triggerKind: 'manual',
    })

    const outcome = await advanceWorkflowRun(executorDeps, run.id)

    expect(outcome).toMatchObject({ kind: 'paused', reason: 'approval' })
    expect(executed).toBe(false)
    expect(approvals.rows[0].arguments).toEqual({
      to: ['buyer@customer.example'],
      subject: 'Re: Question',
      body: 'Draft body',
      inReplyTo: 'INBOX:17',
    })
  })

  it('resume(approved) runs the gated tool with frozen arguments and continues the run', async () => {
    const stores = makeStores()
    const approvals = fakeApprovalsStore()
    const audit = fakeAuditStore()

    let capturedArgs: unknown = null
    const askTool = askPolicyTool('gmailSendMessage', (i) => { capturedArgs = i })
    let postCalled = false
    const followupTool = buildTool({
      name: 'noop',
      description: 'noop',
      inputSchema: z.object({}).passthrough(),
      async execute() { postCalled = true; return { data: { ok: true } } },
    })

    const registryUsers: Array<string | null> = []
    const executorDeps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: FAKE_TRANSPORT,
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async ({ userId }) => {
        registryUsers.push(userId)
        return new Map([
          ['gmailSendMessage', askTool],
          ['noop', followupTool],
        ])
      },
    }
    const bridgeDeps: ApprovalBridgeDeps = {
      approvalsStore: approvals, auditStore: audit,
      workflowStore: stores.workflowStore, runStore: stores.runStore,
      buildToolRegistry: executorDeps.buildToolRegistry,
      resolvePrimary: executorDeps.resolvePrimary,
      deliveries: async () => {}, executorDeps,
    }
    executorDeps.requestApproval = makeRequestApproval(bridgeDeps)

    const definition: WorkflowDefinition = {
      startStepId: 'send',
      steps: [
        {
          id: 'send', type: 'tool_call', toolName: 'gmailSendMessage',
          arguments: { to: '{{input.email}}', body: 'hi' },
          nextStepId: 'after',
        },
        { id: 'after', type: 'tool_call', toolName: 'noop', arguments: {}, nextStepId: null },
      ],
    }
    const workflow = await stores.workflowStore.create({
      userId: USER_ID, workspaceId: WORKSPACE_ID, name: 'mail', definition,
    })
    const run = await stores.runStore.createRun({
      workflowId: workflow.id, workspaceId: WORKSPACE_ID,
      triggeredBy: null, triggerKind: 'schedule',
      input: { email: 'frozen@example.com' },
    })

    await advanceWorkflowRun(executorDeps, run.id)
    expect(approvals.rows).toHaveLength(1)
    const approvalId = approvals.rows[0].id

    // Resume by approving.
    const result = await resumeFromApproval(bridgeDeps, approvalId, 'approved', USER_ID)
    expect(result.status).toBe('completed')

    // Tool ran with frozen interpolated arguments.
    expect(capturedArgs).toEqual({ to: 'frozen@example.com', body: 'hi' })
    // Follow-up tool ran.
    expect(postCalled).toBe(true)
    expect(registryUsers).toHaveLength(3)
    expect(new Set(registryUsers)).toEqual(new Set([USER_ID]))
    // Final run state.
    expect(stores.runs.get(run.id)?.status).toBe('completed')
    // Audit recorded approval_approved.
    expect(audit.events.find((e) => e.eventType === 'workflow.approval_approved')).toBeTruthy()
  })

  it('resume(rejected) marks the run failed', async () => {
    const stores = makeStores()
    const approvals = fakeApprovalsStore()
    const audit = fakeAuditStore()
    const askTool = askPolicyTool('boom')

    const executorDeps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: FAKE_TRANSPORT,
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map([['boom', askTool]]),
    }
    const bridgeDeps: ApprovalBridgeDeps = {
      approvalsStore: approvals, auditStore: audit,
      workflowStore: stores.workflowStore, runStore: stores.runStore,
      buildToolRegistry: executorDeps.buildToolRegistry,
      resolvePrimary: executorDeps.resolvePrimary,
      deliveries: async () => {}, executorDeps,
    }
    executorDeps.requestApproval = makeRequestApproval(bridgeDeps)

    const workflow = await stores.workflowStore.create({
      userId: USER_ID, workspaceId: WORKSPACE_ID, name: 'reject path',
      definition: {
        startStepId: 's', steps: [{ id: 's', type: 'tool_call', toolName: 'boom', arguments: {} }],
      },
    })
    const run = await stores.runStore.createRun({
      workflowId: workflow.id, workspaceId: WORKSPACE_ID,
      triggeredBy: USER_ID, triggerKind: 'manual',
    })
    await advanceWorkflowRun(executorDeps, run.id)
    const approvalId = approvals.rows[0].id

    const result = await resumeFromApproval(bridgeDeps, approvalId, 'rejected', USER_ID, 'no thanks')
    expect(result.status).toBe('failed')
    expect(stores.runs.get(run.id)?.status).toBe('failed')
    expect(audit.events.find((e) => e.eventType === 'workflow.approval_rejected')).toBeTruthy()
  })

  it('fails the run instead of stranding it when registry rebuild throws after approval', async () => {
    const stores = makeStores()
    const approvals = fakeApprovalsStore()
    const audit = fakeAuditStore()
    const askTool = askPolicyTool('send_report')
    let registryBuilds = 0
    const executorDeps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: FAKE_TRANSPORT,
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => {
        registryBuilds += 1
        if (registryBuilds > 1) throw new Error('connector discovery unavailable')
        return new Map([['send_report', askTool]])
      },
    }
    const bridgeDeps: ApprovalBridgeDeps = {
      approvalsStore: approvals,
      auditStore: audit,
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      buildToolRegistry: executorDeps.buildToolRegistry,
      resolvePrimary: executorDeps.resolvePrimary,
      deliveries: async () => {},
      executorDeps,
    }
    executorDeps.requestApproval = makeRequestApproval(bridgeDeps)
    const workflow = await stores.workflowStore.create({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      name: 'registry failure',
      definition: {
        startStepId: 'send',
        steps: [{ id: 'send', type: 'tool_call', toolName: 'send_report', arguments: {} }],
      },
    })
    const run = await stores.runStore.createRun({
      workflowId: workflow.id,
      workspaceId: WORKSPACE_ID,
      triggeredBy: USER_ID,
      triggerKind: 'manual',
    })
    await advanceWorkflowRun(executorDeps, run.id)

    const result = await resumeFromApproval(bridgeDeps, approvals.rows[0].id, 'approved', USER_ID)

    expect(result.status).toBe('failed')
    expect(stores.runs.get(run.id)?.error).toMatchObject({
      reason: 'tool_registry_unavailable_after_resume',
    })
  })

  it('resume is idempotent — second approve/reject is a no-op', async () => {
    const stores = makeStores()
    const approvals = fakeApprovalsStore()
    const audit = fakeAuditStore()
    const askTool = askPolicyTool('gmailSendMessage')

    const executorDeps: ExecutorDeps = {
      workflowStore: stores.workflowStore, runStore: stores.runStore,
      consultTransport: FAKE_TRANSPORT,
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map([['gmailSendMessage', askTool]]),
    }
    const bridgeDeps: ApprovalBridgeDeps = {
      approvalsStore: approvals, auditStore: audit,
      workflowStore: stores.workflowStore, runStore: stores.runStore,
      buildToolRegistry: executorDeps.buildToolRegistry,
      resolvePrimary: executorDeps.resolvePrimary,
      deliveries: async () => {}, executorDeps,
    }
    executorDeps.requestApproval = makeRequestApproval(bridgeDeps)

    const wf = await stores.workflowStore.create({
      userId: USER_ID, workspaceId: WORKSPACE_ID, name: 'idempotent',
      definition: {
        startStepId: 's',
        steps: [{ id: 's', type: 'tool_call', toolName: 'gmailSendMessage', arguments: {} }],
      },
    })
    const run = await stores.runStore.createRun({
      workflowId: wf.id, workspaceId: WORKSPACE_ID,
      triggeredBy: USER_ID, triggerKind: 'manual',
    })
    await advanceWorkflowRun(executorDeps, run.id)
    const approvalId = approvals.rows[0].id

    const first = await resumeFromApproval(bridgeDeps, approvalId, 'approved', USER_ID)
    expect(first.status).toBe('completed')
    const second = await resumeFromApproval(bridgeDeps, approvalId, 'approved', USER_ID)
    expect(second.status).toBe('approved')
  })

  it('sweep marks expired rows + fails the parent run', async () => {
    const stores = makeStores()
    const approvals = fakeApprovalsStore()
    const audit = fakeAuditStore()
    const askTool = askPolicyTool('gmailSendMessage')

    const executorDeps: ExecutorDeps = {
      workflowStore: stores.workflowStore, runStore: stores.runStore,
      consultTransport: FAKE_TRANSPORT,
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map([['gmailSendMessage', askTool]]),
    }
    const bridgeDeps: ApprovalBridgeDeps = {
      approvalsStore: approvals, auditStore: audit,
      workflowStore: stores.workflowStore, runStore: stores.runStore,
      buildToolRegistry: executorDeps.buildToolRegistry,
      resolvePrimary: executorDeps.resolvePrimary,
      deliveries: async () => {}, executorDeps,
    }
    executorDeps.requestApproval = makeRequestApproval(bridgeDeps)

    const wf = await stores.workflowStore.create({
      userId: USER_ID, workspaceId: WORKSPACE_ID, name: 'expire',
      definition: {
        startStepId: 's',
        steps: [{
          id: 's', type: 'tool_call', toolName: 'gmailSendMessage', arguments: {},
          approval: { expiresAfterHours: 1 },
        }],
      },
    })
    const run = await stores.runStore.createRun({
      workflowId: wf.id, workspaceId: WORKSPACE_ID,
      triggeredBy: USER_ID, triggerKind: 'manual',
    })
    await advanceWorkflowRun(executorDeps, run.id)
    expect(approvals.rows).toHaveLength(1)
    // Force expire by mutating the row.
    approvals.rows[0].expiresAt = new Date(Date.now() - 1000)

    const expiredCount = await sweepExpiredApprovals(bridgeDeps)
    expect(expiredCount).toBe(1)
    expect(approvals.rows[0].status).toBe('expired')
    expect(stores.runs.get(run.id)?.status).toBe('failed')
    expect(audit.events.find((e) => e.eventType === 'workflow.approval_expired')).toBeTruthy()
  })
})
