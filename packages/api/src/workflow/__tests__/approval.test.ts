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
import { advanceWorkflowRun, type ExecutorDeps } from '@sidanclaw/core'
import { buildTool, type Tool } from '@sidanclaw/core'
import type {
  WorkflowDefinition,
  WorkflowRecord,
  WorkflowRunRecord,
  WorkflowRunStore,
  WorkflowStepRunRecord,
  WorkflowStore,
} from '@sidanclaw/core'
import type { ConsultRequest, ConsultResponse, ConsultTransport } from '@sidanclaw/core'
import {
  makeRequestApproval,
  resumeFromApproval,
  sweepExpiredApprovals,
  type ApprovalBridgeDeps,
} from '../approval.js'
import type { PendingApproval, PendingApprovalsStore } from '../../db/pending-approvals-store.js'
import type { WorkspaceAuditStore } from '../../db/workspace-audit-store.js'

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
        approvalPayload: {},
        originatingAssistantId: null,
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
    async createStagedWrite() {
      throw new Error('createStagedWrite not used in workflow approval tests')
    },
    async createQuestion() {
      throw new Error('createQuestion not used in workflow approval tests')
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

// ── Tests ────────────────────────────────────────────────────────────────

describe('[COMP:workflow/approval] Phase C — pause + resume', () => {
  it('pauses on ask-policy tool_call, dispatches delivery, emits audit', async () => {
    const stores = makeStores()
    const approvals = fakeApprovalsStore()
    const audit = fakeAuditStore()
    const dispatched: Array<{ approvalId: string; channel: string }> = []

    const askTool = askPolicyTool('gmailSendMessage', () => {
      throw new Error('tool should not run during pause')
    })

    const executorDeps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: FAKE_TRANSPORT,
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map([['gmailSendMessage', askTool]]),
    }

    const bridgeDeps: ApprovalBridgeDeps = {
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
          approval: { deliveryChannel: 'telegram' },
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
    expect(approvals.rows[0].arguments).toEqual({ to: 'me@example.com', body: 'hi' })
    expect(approvals.rows[0].deliveryChannelType).toBe('telegram')
    // Delivery dispatched.
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0].channel).toBe('telegram')
    // Audit event.
    expect(audit.events.find((e) => e.eventType === 'workflow.approval_requested')).toBeTruthy()
    // Run state = awaiting_input.
    expect(stores.runs.get(run.id)?.status).toBe('awaiting_input')
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

    const executorDeps: ExecutorDeps = {
      workflowStore: stores.workflowStore,
      runStore: stores.runStore,
      consultTransport: FAKE_TRANSPORT,
      resolvePrimary: async () => PRIMARY_ASSISTANT_ID,
      buildToolRegistry: async () => new Map([
        ['gmailSendMessage', askTool],
        ['noop', followupTool],
      ]),
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
      triggeredBy: USER_ID, triggerKind: 'manual',
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
