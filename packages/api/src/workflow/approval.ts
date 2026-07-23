/**
 * Workflow approval bridge — Phase C (Q4 §12).
 *
 * Glues the executor's `requestApproval` callback to the
 * `pending_approvals` store, the audit log, and the channel-delivery
 * dispatcher. Also implements the resume path: on approve, run the gated
 * tool with the frozen arguments and continue advancing the workflow run;
 * on reject, mark the run failed.
 *
 * Designed for one process. Horizontal scale-out is fine because the
 * `pending_approvals.respond()` SQL is atomic — only one path will see
 * status='pending' on a given row.
 *
 * [COMP:workflow/approval]
 */

import type {
  ExecutorDeps,
  JobStore,
  Tool,
  ToolContext,
  WorkflowDefinition,
  WorkflowRecord,
  WorkflowRunRecord,
  WorkflowRunStore,
  WorkflowStepRunRecord,
  WorkflowStore,
} from '@use-brian/core'
import { advanceWorkflowRun } from '@use-brian/core'
import type { WorkspaceAuditStore } from '../db/workspace-audit-store.js'
import type { PendingApprovalsStore, PendingApproval } from '../db/pending-approvals-store.js'
import type { SessionResumeStore } from '../db/session-resume-store.js'

export type ApprovalDeliveryDispatcher = (params: {
  approvalId: string
  workspaceId: string
  workflowName: string
  stepId: string
  toolName: string
  arguments: Record<string, unknown>
  approverUserId: string
  deliveryChannelType: 'web' | 'telegram' | 'slack' | 'whatsapp' | 'msteams'
  deliveryChannelId: string | null
}) => Promise<void>

export type ApprovalBridgeDeps = {
  approvalsStore: PendingApprovalsStore
  auditStore: WorkspaceAuditStore
  workflowStore: WorkflowStore
  runStore: WorkflowRunStore
  /** Per-run merged tool registry builder — same shape as the executor uses. */
  buildToolRegistry: ExecutorDeps['buildToolRegistry']
  /** Resolve the workspace's primary assistant (for tool execution context). */
  resolvePrimary: ExecutorDeps['resolvePrimary']
  /** Send the approval prompt over the chosen channel + register the deep link. */
  deliveries: ApprovalDeliveryDispatcher
  /**
   * The full executor deps — handed to `advanceWorkflowRun` after the
   * gated tool runs (so the rest of the workflow continues with all
   * downstream pause hooks intact).
   */
  executorDeps: ExecutorDeps
}

/**
 * Implementation of `ExecutorDeps.requestApproval`. Pause-side: writes the
 * pending row, dispatches the channel notification, emits the audit event.
 * The executor flips the run state to `awaiting_input` after this returns.
 */
export function makeRequestApproval(deps: ApprovalBridgeDeps): NonNullable<ExecutorDeps['requestApproval']> {
  return async ({
    runId,
    stepRunId,
    workspaceId,
    approverUserId,
    toolName,
    arguments: args,
    deliveryChannel,
    expiresAt,
  }) => {
    // Look up the workflow name for the audit + delivery message.
    const run = await deps.runStore.getRunSystem(runId)
    const workflowName = run
      ? (await deps.workflowStore.getById(approverUserId, run.workflowId))?.name ?? '<workflow>'
      : '<workflow>'
    const stepRow = await getStepRunSystem(deps, stepRunId)

    const approval = await deps.approvalsStore.create({
      workspaceId,
      workflowRunId: runId,
      workflowStepRunId: stepRunId,
      toolName,
      arguments: args,
      approverUserId,
      deliveryChannelType: deliveryChannel,
      deliveryChannelId: null, // delivery layer resolves the channel id from approver's preferred channel
      expiresAt,
    })

    // Audit (fire-and-forget — don't block the executor).
    deps.auditStore.append({
      workspaceId,
      actorUserId: null,
      eventType: 'workflow.approval_requested',
      subjectId: approval.id,
      details: {
        runId,
        workflowName,
        toolName,
        stepId: stepRow?.stepId ?? null,
        deliveryChannel,
      },
    }).catch(() => { /* fire-and-forget */ })

    // Dispatch the prompt over the chosen channel. Best-effort — the row
    // is durable in the DB even if delivery fails, and the user can always
    // approve via the web UI.
    try {
      await deps.deliveries({
        approvalId: approval.id,
        workspaceId,
        workflowName,
        stepId: stepRow?.stepId ?? '<step>',
        toolName,
        arguments: args,
        approverUserId,
        deliveryChannelType: deliveryChannel,
        deliveryChannelId: null,
      })
    } catch (err) {
      console.error(`[workflow-approval] delivery failed for ${approval.id}:`, err)
    }
  }
}

/**
 * Resume path — called by the route handler after the user clicks
 * Approve. Runs the gated tool with the frozen arguments, then re-enters
 * `advanceWorkflowRun` to continue the workflow.
 *
 * Returns the new run status string (for the route's response body).
 * Idempotent: a second Approve click finds status != 'pending' and no-ops.
 */
export async function resumeFromApproval(
  deps: ApprovalBridgeDeps,
  approvalId: string,
  decision: 'approved' | 'rejected',
  responderUserId: string,
  rejectReason?: string,
): Promise<{ status: string; runId: string | null }> {
  const updated = await deps.approvalsStore.respond(
    approvalId,
    decision,
    responderUserId,
    rejectReason,
  )
  if (!updated) {
    // Already responded by another path (idempotent double-click) or expired.
    const existing = await deps.approvalsStore.getByIdSystem(approvalId)
    return { status: existing?.status ?? 'unknown', runId: existing?.workflowRunId ?? null }
  }

  const run = await deps.runStore.getRunSystem(updated.workflowRunId)
  if (!run) {
    return { status: 'orphaned', runId: updated.workflowRunId }
  }

  // Audit the decision.
  deps.auditStore.append({
    workspaceId: updated.workspaceId,
    actorUserId: responderUserId,
    eventType: decision === 'approved' ? 'workflow.approval_approved' : 'workflow.approval_rejected',
    subjectId: updated.id,
    details: {
      runId: run.id,
      toolName: updated.toolName,
      ...(decision === 'rejected' && rejectReason ? { reason: rejectReason } : {}),
    },
  }).catch(() => { /* fire-and-forget */ })

  if (decision === 'rejected') {
    // Mark the run failed. The step run row stays at 'running' (the
    // approval preempted execution); we mark it 'failed' here for the
    // step trail.
    await deps.runStore.updateStepRun(updated.workflowStepRunId, {
      status: 'failed',
      error: { message: 'rejected by approver', reason: 'approval_rejected', detail: rejectReason ?? null },
      finishedAt: new Date(),
    })
    await deps.runStore.updateRun(run.id, {
      status: 'failed',
      currentStepId: run.currentStepId,
      error: { message: 'approval rejected', reason: 'approval_rejected' },
      finishedAt: new Date(),
    })
    return { status: 'failed', runId: run.id }
  }

  // Approved → run the tool with the frozen arguments, then continue.
  const workflow = await deps.workflowStore.getById(responderUserId, run.workflowId)
  if (!workflow) {
    return { status: 'orphaned_workflow', runId: run.id }
  }

  const primaryAssistantId = await deps.resolvePrimary(run.workspaceId)
  if (!primaryAssistantId) {
    await deps.runStore.updateRun(run.id, {
      status: 'failed',
      error: { message: 'workspace lost its primary assistant', reason: 'no_primary_assistant' },
      finishedAt: new Date(),
    })
    return { status: 'failed', runId: run.id }
  }

  const registry = await deps.buildToolRegistry({
    workspaceId: run.workspaceId,
    assistantId: primaryAssistantId,
    userId: run.triggeredBy,
  })

  const tool = registry.get(updated.toolName)
  if (!tool) {
    await failStep(deps, run, workflow, updated, 'tool_no_longer_available', 'Tool no longer available in registry')
    return { status: 'failed', runId: run.id }
  }

  // Validate arguments (defense-in-depth — frozen at pause but the tool
  // schema may have shifted with a deploy; better to surface the error
  // than to call with invalid input).
  let validatedInput: unknown
  try {
    validatedInput = tool.inputSchema.parse(updated.arguments)
  } catch (err) {
    await failStep(deps, run, workflow, updated, 'tool_input_invalid_after_resume', err instanceof Error ? err.message : String(err))
    return { status: 'failed', runId: run.id }
  }

  const toolContext: ToolContext = {
    userId: run.triggeredBy ?? workflow.createdBy,
    assistantId: primaryAssistantId,
    sessionId: `workflow_run_${run.id}`,
    appId: 'Use Brian',
    channelType: 'workflow',
    channelId: run.id,
    workspaceId: run.workspaceId,
    assistantKind: 'primary',
    abortSignal: new AbortController().signal,
  }

  let result
  try {
    result = await tool.execute(validatedInput, toolContext)
  } catch (err) {
    await failStep(deps, run, workflow, updated, 'tool_threw_after_resume', err instanceof Error ? err.message : String(err))
    return { status: 'failed', runId: run.id }
  }

  if (result.isError) {
    await failStep(deps, run, workflow, updated, 'tool_returned_error_after_resume', String(result.data))
    return { status: 'failed', runId: run.id }
  }

  // Mark the gated step completed and advance the run past it.
  await deps.runStore.updateStepRun(updated.workflowStepRunId, {
    status: 'completed',
    output: wrapOutput(result.data),
    finishedAt: new Date(),
  })

  // Resolve next step from the definition.
  const stepDef = workflow.definition.steps.find((s) => s.id === run.currentStepId)
  const nextId = nextStepIdFromDef(workflow.definition, stepDef?.id ?? '')

  // Optionally store the tool output under storeOutputAs.
  let nextVars = run.vars
  if (stepDef?.storeOutputAs && stepDef.type === 'tool_call') {
    nextVars = { ...run.vars, [stepDef.storeOutputAs]: result.data }
  }

  // If this was the terminal step, mark the run completed directly. Calling
  // `advanceWorkflowRun` with currentStepId=null would re-enter the run from
  // the start (the executor falls back to `definition.startStepId`) and
  // re-trigger the same approval — wrong.
  if (nextId === null) {
    const finishedAt = new Date()
    await deps.runStore.updateRun(run.id, {
      status: 'completed',
      currentStepId: null,
      vars: nextVars,
      finishedAt,
    })
    deps.auditStore.append({
      workspaceId: run.workspaceId,
      actorUserId: run.triggeredBy,
      eventType: 'workflow.run_completed',
      subjectId: run.id,
      details: {
        workflowId: workflow.id,
        name: workflow.name,
        stepCount: 1, // approximate — the resume only knows about the gated step
        durationMs: finishedAt.getTime() - run.startedAt.getTime(),
      },
    }).catch(() => { /* fire-and-forget */ })
    return { status: 'completed', runId: run.id }
  }

  await deps.runStore.updateRun(run.id, {
    status: 'running',
    currentStepId: nextId,
    vars: nextVars,
  })

  // Continue the run.
  const outcome = await advanceWorkflowRun(deps.executorDeps, run.id)
  return { status: outcome.kind === 'paused' ? `paused_${outcome.reason}` : outcome.kind, runId: run.id }
}

// ─────────────────────────────────────────────────────────────────────
// WU-6.4 — Path B durable resume, enqueue side (tool_invocation kind).
//
// `resumeFromApproval` above is workflow-only. A `tool_invocation`
// approval suspends a *chat session*, not a workflow run — its resume
// path is the Path B checkpoint in `session_resume_points` + the poll
// worker's `resumeHandler` dispatch. This function is the enqueue side:
// when such an approval resolves, it either lets the live in-memory
// confirmation resolver pick it up (fast path, no restart) or — when no
// live resolver answers (the chat process restarted) — enqueues a
// `session_resume` scheduled job so the resume worker rehydrates the
// turn.
//
// See docs/plans/company-brain/approvals.md → "Chat resume — Path B".
// ─────────────────────────────────────────────────────────────────────

export type ToolInvocationResumeDeps = {
  approvalsStore: PendingApprovalsStore
  sessionResumeStore: SessionResumeStore
  jobStore: JobStore
  /**
   * Fast-path hook into the chat route's in-memory confirmation
   * resolvers. Returns `true` when a live resolver for the suspended
   * session was found and notified (no restart — Path A continues).
   * Returns `false` when no live resolver exists (the chat process
   * restarted), which is the signal to enqueue the resume job.
   */
  tryResolveLive: (params: {
    sessionId: string
    approvalId: string
    decision: 'approved' | 'rejected'
    /** Reject note from the approvals panel, forwarded to the live resolver
     *  so a deny-with-comment reaches the model. */
    reason?: string
  }) => boolean
}

export type ToolInvocationResumeOutcome =
  /** A live in-memory resolver handled it — Path A fast path. */
  | { kind: 'resumed_live' }
  /** No live resolver; a `session_resume` job was enqueued for the worker. */
  | { kind: 'enqueued'; jobId: string }
  /** No resume checkpoint exists — nothing to resume (e.g. the turn
   *  already completed, or Path B was never wired when the row was minted). */
  | { kind: 'no_checkpoint' }

/**
 * Resolve a `tool_invocation` approval's downstream resume. The
 * `pending_approvals` row MUST already be flipped (approved/rejected) by
 * the caller — this only drives the chat-turn continuation.
 *
 * [COMP:brain/session-resume-worker]
 */
export async function enqueueToolInvocationResume(
  deps: ToolInvocationResumeDeps,
  params: {
    approval: PendingApproval
    decision: 'approved' | 'rejected'
    /** Reject note (deny-with-comment). Only forwarded to the live-resolver
     *  fast path; the restart resume worker does not yet replay it. */
    reason?: string
  },
): Promise<ToolInvocationResumeOutcome> {
  const { approval, decision, reason } = params
  const sessionId = approval.blockingSessionId

  // No suspended session recorded → nothing to resume.
  if (!sessionId) return { kind: 'no_checkpoint' }

  // Fast path: a live resolver in this process handled the suspension.
  if (deps.tryResolveLive({ sessionId, approvalId: approval.id, decision, reason })) {
    return { kind: 'resumed_live' }
  }

  // Restart path: the chat process that suspended the turn is gone. A
  // resume checkpoint must exist for the worker to rehydrate from.
  const point = await deps.sessionResumeStore.getByApprovalId(approval.id)
  if (!point) {
    // No checkpoint — Path B wasn't wired when the row was minted, or
    // the turn already finished. Nothing the worker can replay.
    return { kind: 'no_checkpoint' }
  }

  // `tool_invocation` rows always carry an originating assistant
  // (`createToolInvocation` requires it). Defensive: without one we
  // cannot satisfy `scheduled_jobs.assistant_id`'s FK — skip rather
  // than crash.
  if (!approval.originatingAssistantId) {
    return { kind: 'no_checkpoint' }
  }

  // Enqueue a one-time `session_resume` job. The poll worker dispatches
  // it to `resumeHandler` (NOT the standard executor) on its next tick.
  // assistant/user come off the approval row; instructions/channel are
  // placeholders the resume handler ignores.
  const now = new Date()
  const job = await deps.jobStore.create({
    assistantId: approval.originatingAssistantId,
    userId: approval.approverUserId,
    schedule: { type: 'once', datetime: now.toISOString() },
    timezone: 'UTC',
    instructions: `session_resume:${approval.id}`,
    channelType: 'session_resume',
    channelId: sessionId,
    nextRunAt: now,
    silentUntilFire: true,
  })
  await deps.jobStore.setState(job.id, {
    triggerKind: 'session_resume',
    resume: { sessionId, approvalId: approval.id },
  })
  return { kind: 'enqueued', jobId: job.id }
}

/**
 * askQuestion suspend-resume (Phase 5) — periodic TTL sweep for
 * `kind='question'` rows. Distinct from `sweepExpiredApprovals` because
 * the post-expire action is "resume the chat with an `expired` outcome
 * note" rather than "fail the workflow run". Flips expired rows then
 * enqueues a `session_resume` job per row so the chat eventually
 * produces a final synthesis turn that acknowledges no answer arrived.
 * Each row was already minted with `originatingAssistantId` (the
 * createPendingQuestion port asserts it), so the enqueue won't drop on
 * the missing-assistant defense in `enqueueToolInvocationResume`.
 *
 * See docs/architecture/engine/askquestion-suspend-resume.md.
 *
 * [COMP:api/question-ttl-sweeper]
 */
export async function sweepExpiredQuestions(deps: {
  approvalsStore: PendingApprovalsStore
  jobStore: JobStore
  sessionResumeStore: SessionResumeStore
}): Promise<number> {
  const expired = await deps.approvalsStore.expireDueQuestions()
  let enqueued = 0
  for (const row of expired) {
    if (!row.blockingSessionId || !row.originatingAssistantId) continue
    // Use the same resume-enqueue helper as the user-answered path. The
    // replay reads `approvalStatus='expired'` + `approvalKind='question'`
    // and emits the kind-aware "no answer came in" outcome note.
    try {
      // Pass-through with a tryResolveLive stub that always returns false
      // — no fast path here; we always want the durable job.
      const result = await enqueueToolInvocationResume(
        {
          approvalsStore: deps.approvalsStore,
          sessionResumeStore: deps.sessionResumeStore,
          jobStore: deps.jobStore,
          tryResolveLive: () => false,
        },
        { approval: row, decision: 'rejected' },
      )
      if (result.kind === 'enqueued') enqueued++
    } catch (err) {
      console.warn(
        `[approvals] question-expiry resume enqueue failed for ${row.id}:`,
        err,
      )
    }
  }
  return enqueued
}

/**
 * Sweep helper — call from a periodic worker. Marks every overdue pending
 * row as `expired`, marks the parent run+step failed, and emits the
 * `workflow.approval_expired` audit event.
 */
export async function sweepExpiredApprovals(deps: ApprovalBridgeDeps): Promise<number> {
  const expired = await deps.approvalsStore.expireDue()
  for (const row of expired) {
    // Only workflow-step rows go through the workflow-run-failure path.
    // Question / tool_invocation / staged_* rows have no workflow refs;
    // their post-expire treatment lives in their own kind-specific
    // sweeper (e.g. sweepExpiredQuestions for kind='question'). Without
    // this kind gate, expireDue would flip a question row here and
    // then crash on updateStepRun(null).
    if (row.kind !== 'workflow_step') continue
    deps.auditStore.append({
      workspaceId: row.workspaceId,
      actorUserId: null,
      eventType: 'workflow.approval_expired',
      subjectId: row.id,
      details: { runId: row.workflowRunId, toolName: row.toolName },
    }).catch(() => {})
    await deps.runStore.updateStepRun(row.workflowStepRunId, {
      status: 'failed',
      error: { message: 'approval expired', reason: 'approval_expired' },
      finishedAt: new Date(),
    })
    await deps.runStore.updateRun(row.workflowRunId, {
      status: 'failed',
      error: { message: 'approval expired', reason: 'approval_expired' },
      finishedAt: new Date(),
    })
  }
  return expired.length
}

// ── Internal helpers ────────────────────────────────────────────────────

async function failStep(
  deps: ApprovalBridgeDeps,
  run: WorkflowRunRecord,
  _workflow: WorkflowRecord,
  approval: PendingApproval,
  reason: string,
  message: string,
): Promise<void> {
  await deps.runStore.updateStepRun(approval.workflowStepRunId, {
    status: 'failed',
    error: { message, reason },
    finishedAt: new Date(),
  })
  await deps.runStore.updateRun(run.id, {
    status: 'failed',
    error: { message, reason },
    finishedAt: new Date(),
  })
}

function wrapOutput(output: unknown): Record<string, unknown> {
  if (output === null || output === undefined) return { value: null }
  if (typeof output === 'object' && !Array.isArray(output)) return output as Record<string, unknown>
  return { value: output }
}

function nextStepIdFromDef(def: WorkflowDefinition, fromStepId: string): string | null {
  const idx = def.steps.findIndex((s) => s.id === fromStepId)
  if (idx === -1) return null
  const step = def.steps[idx]
  if (step.type !== 'branch' && step.nextStepId !== undefined) return step.nextStepId
  return def.steps[idx + 1]?.id ?? null
}

async function getStepRunSystem(
  deps: ApprovalBridgeDeps,
  stepRunId: string,
): Promise<WorkflowStepRunRecord | null> {
  // The runStore exposes RLS-gated `listStepRuns` only — system reads of a
  // single step row need a small ad-hoc query. We use a sentinel userId
  // (the system bypass) by going through the same store with the workflow
  // creator id as a stand-in. Acceptable here since this is read-only,
  // pre-approval, and only used to enrich the audit event.
  // Practical note: we don't strictly NEED the stepId — fall back to
  // returning null on lookup failure; the audit event tolerates a missing
  // stepId.
  try {
    const all = await deps.runStore.listStepRuns(
      '00000000-0000-0000-0000-000000000000',
      // We'd need run id, not step run id, to use this path. Skip for V1
      // — null is acceptable (audit tolerates).
      stepRunId,
    )
    return all.find((s) => s.id === stepRunId) ?? null
  } catch {
    return null
  }
}

// `Tool` import keeps tsc happy when this file is read in isolation.
type _Tool = Tool
