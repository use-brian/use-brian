/**
 * Unified approval queue routes (company-brain — `approvals.md`).
 *
 * The single cross-cutting surface for `pending_approvals` (mig 117 +
 * 137 — four kinds: workflow_step / tool_invocation / staged_write /
 * distribution_draft). Mounted at `/api/approvals` behind `requireAuth`.
 *
 * [COMP:api/unified-approvals-route]
 *
 *   GET  /                  — list every pending approval for a workspace
 *   GET  /count             — pending count (nav badge)
 *   POST /:id/respond        — approve / reject
 *
 * Respond dispatch by kind:
 *   - `workflow_step`   — fully resolved here: `resumeFromApproval`
 *     resumes (or fails) the parent workflow run. The unified queue is
 *     this kind's only action surface.
 *   - `tool_invocation` — resolved here when `resumeDeps` is wired
 *     (WU-6.4): the row is flipped, then `enqueueToolInvocationResume`
 *     either notifies the live in-memory resolver (no restart) or
 *     enqueues a `session_resume` job for the resume worker (restart).
 *     Without `resumeDeps` it falls back to the 422 deep-link below.
 *   - every other kind  — 422 with `nativeSurface`. `distribution_draft`
 *     resumes through the feed review surface; `staged_write` through
 *     the web queue. The queue still *lists* them so operators have one
 *     place to see what is outstanding; the action deep-links to the
 *     originating surface.
 */

import { Router } from 'express'
import type { ApprovalKind, PendingApprovalsStore } from '../db/pending-approvals-store.js'
import type { WorkspaceStore } from '../db/workspace-store.js'
import {
  resumeFromApproval,
  enqueueToolInvocationResume,
  type ApprovalBridgeDeps,
  type ToolInvocationResumeDeps,
} from '../workflow/approval.js'

export type UnifiedApprovalRouteOptions = {
  approvalsStore: PendingApprovalsStore
  workspaceStore: WorkspaceStore
  bridgeDeps: ApprovalBridgeDeps
  /**
   * WU-6.4 — Path B durable resume deps for `tool_invocation` rows.
   * When set, the route resolves `tool_invocation` approvals in place
   * (flip the row + enqueue/fast-path the chat-turn resume). When
   * absent, `tool_invocation` keeps the legacy 422 deep-link behavior.
   */
  resumeDeps?: ToolInvocationResumeDeps
  /**
   * Agent-surface staged writes (`kind='staged_write'`) — the Approve band
   * of the agent capability surface. When set, approve applies the staged
   * tool via the executor THEN settles the row (apply-then-settle, the
   * skill-approvals order — a failed apply leaves the row pending and
   * retryable). When absent, staged_write keeps the 422 deep-link.
   */
  stagedWriteDeps?: import('../agent-surface/staged-write.js').StagedWriteDeps
  /**
   * Computer-use R2 grants (R2-2): lets the `browser_skill_send` card's
   * third button — Allow always for this block+profile — mint a standing
   * grant at approve time (THE grant is the review). Absent → the card
   * still offers Deny / Allow once.
   */
  browserSkillGrants?: import('@sidanclaw/core').BrowserSkillGrantStore | null
  /**
   * Email channel stranger-sender cards (`kind='email_sender'`, agentmail.md
   * D4). Approve = allowlist the sender on the inbox's integration row
   * (`allowlistSender`); reject = dismiss — the sender stays on the
   * ingest-only path, it is NOT a blocklist. Absent → the kind keeps the
   * 422 deep-link.
   */
  emailSenderDeps?: {
    allowlistSender(channelIntegrationId: string, sender: string): Promise<void>
  }
}

/** Where a non-workflow approval kind is actually resolved. */
const NATIVE_SURFACE: Record<Exclude<ApprovalKind, 'workflow_step'>, string> = {
  tool_invocation: 'chat',
  distribution_draft: 'feed',
  staged_write: 'web',
  staged_skill_creation: 'web',
  staged_skill_update: 'web',
  // Question approvals resolve on the chat surface — the answer input
  // renders inline in the suspended turn. See
  // docs/architecture/engine/askquestion-suspend-resume.md.
  question: 'chat',
  // Logic-block terminal sends (R2-5) resolve on the web Approvals queue —
  // the 3-button card (Deny / Allow once / Allow always for this
  // block+profile). The block's runner polls the row.
  browser_skill_send: 'web',
  // Stranger-sender email cards resolve on the web Approvals queue
  // (approve = allowlist the sender; reject = dismiss, stays ingest-only).
  email_sender: 'web',
}

export function approvalsRoutes(opts: UnifiedApprovalRouteOptions): Router {
  const router = Router()

  // GET / — every pending approval for the workspace, full projection.
  router.get('/', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const workspaceId =
      typeof req.query.workspaceId === 'string' ? req.query.workspaceId : null
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId query param is required' })
      return
    }
    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) {
      res.status(404).json({ error: 'Not found' })
      return
    }

    const rows = await opts.approvalsStore.listPendingForWorkspace(userId, workspaceId)
    res.json({
      approvals: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        status: r.status,
        toolName: r.toolName,
        arguments: r.arguments,
        approvalPayload: r.approvalPayload,
        approverUserId: r.approverUserId,
        originatingAssistantId: r.originatingAssistantId,
        blockingSessionId: r.blockingSessionId,
        workflowRunId: r.workflowRunId,
        deliveryChannelType: r.deliveryChannelType,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt?.toISOString() ?? null,
      })),
    })
  })

  // GET /count — pending count for the workspace (nav badge).
  router.get('/count', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const workspaceId =
      typeof req.query.workspaceId === 'string' ? req.query.workspaceId : null
    if (!workspaceId) {
      res.status(400).json({ error: 'workspaceId query param is required' })
      return
    }
    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    const rows = await opts.approvalsStore.listPendingForWorkspace(userId, workspaceId)
    res.json({ pending: rows.length })
  })

  // POST /:id/respond — approve / reject.
  router.post('/:id/respond', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const id = req.params.id
    const body = (req.body ?? {}) as { decision?: string; reason?: string; grantAlways?: boolean }
    if (body.decision !== 'approved' && body.decision !== 'rejected') {
      res.status(400).json({ error: "decision must be 'approved' or 'rejected'" })
      return
    }
    const decision = body.decision
    const reason =
      typeof body.reason === 'string' ? body.reason.slice(0, 1000) : undefined

    const approval = await opts.approvalsStore.getById(userId, id)
    if (!approval) {
      res.status(404).json({ error: 'Approval not found' })
      return
    }
    if (approval.approverUserId !== userId) {
      res.status(403).json({ error: 'Only the assigned approver can respond' })
      return
    }
    if (approval.status !== 'pending') {
      // Idempotent — a double-submit just echoes the settled state.
      res.json({ status: approval.status, kind: approval.kind, idempotent: true })
      return
    }

    if (approval.kind === 'workflow_step') {
      const result = await resumeFromApproval(opts.bridgeDeps, id, decision, userId, reason)
      res.json({ kind: 'workflow_step', ...result })
      return
    }

    // WU-6.4 — `tool_invocation` resolves in place when Path B is wired:
    // flip the row, then either notify the live in-memory resolver or
    // enqueue a `session_resume` job for the resume worker.
    if (approval.kind === 'tool_invocation' && opts.resumeDeps) {
      const updated = await opts.approvalsStore.respond(id, decision, userId, reason)
      if (!updated) {
        // Lost a race — another path already settled the row.
        const settled = await opts.approvalsStore.getById(userId, id)
        res.json({ kind: 'tool_invocation', status: settled?.status ?? 'unknown', idempotent: true })
        return
      }
      const resume = await enqueueToolInvocationResume(opts.resumeDeps, {
        approval: updated,
        decision,
      })
      res.json({ kind: 'tool_invocation', status: updated.status, resume })
      return
    }

    // Agent-surface staged write — apply the staged control-plane tool,
    // then settle the row. Rejection settles without applying. See
    // docs/architecture/integrations/agent-capability-surface.md §6.1 and
    // packages/api/src/agent-surface/staged-write.ts.
    if (approval.kind === 'staged_write' && opts.stagedWriteDeps) {
      if (decision === 'rejected') {
        const updated = await opts.approvalsStore.respond(id, 'rejected', userId, reason)
        res.json({ kind: 'staged_write', status: updated?.status ?? 'rejected' })
        return
      }
      const { applyStagedWrite } = await import('../agent-surface/staged-write.js')
      const outcome = await applyStagedWrite(opts.stagedWriteDeps, approval, userId)
      if (!outcome.ok) {
        // Apply failed — leave the row pending (retryable) and surface why.
        res.status(502).json({ kind: 'staged_write', error: outcome.error })
        return
      }
      const updated = await opts.approvalsStore.respond(id, 'approved', userId, reason)
      res.json({ kind: 'staged_write', status: updated?.status ?? 'approved', result: outcome.resultText })
      return
    }

    // Logic-block terminal send (R2-2/R2-5): the block's runner polls this
    // row, so responding in place IS the resume — no re-dispatch. The third
    // button, Allow always for this block+profile, mints the standing grant
    // (the grant is the review); the verb ceiling never offers it.
    if (approval.kind === 'browser_skill_send') {
      const updated = await opts.approvalsStore.respond(id, decision, userId, reason)
      if (!updated) {
        const settled = await opts.approvalsStore.getById(userId, id)
        res.json({ kind: 'browser_skill_send', status: settled?.status ?? 'unknown', idempotent: true })
        return
      }
      let grantId: string | null = null
      const payload = approval.approvalPayload as {
        skillId?: string
        profileId?: string
        ceiling?: string | null
      }
      if (
        decision === 'approved' &&
        body.grantAlways === true &&
        opts.browserSkillGrants &&
        payload.skillId &&
        payload.profileId &&
        !payload.ceiling // ceiling verbs are never grantable (R2-1)
      ) {
        const grant = await opts.browserSkillGrants.create({
          workspaceId: approval.workspaceId,
          skillId: payload.skillId,
          profileId: payload.profileId,
          grantedBy: userId,
        })
        grantId = grant.id
      }
      res.json({ kind: 'browser_skill_send', status: updated.status, grantId })
      return
    }

    // Email stranger-sender card (agentmail.md D4): approve = allowlist the
    // sender on the inbox integration (allowlist-then-settle — a failed
    // config write leaves the card pending and retryable); reject = dismiss
    // (the sender stays ingest-only; rejection is NOT a blocklist).
    if (approval.kind === 'email_sender' && opts.emailSenderDeps) {
      if (decision === 'approved') {
        const payload = approval.approvalPayload as {
          channelIntegrationId?: string
          sender?: string
        }
        if (!payload.channelIntegrationId || !payload.sender) {
          res.status(422).json({ kind: 'email_sender', error: 'Card payload is missing its integration or sender' })
          return
        }
        try {
          await opts.emailSenderDeps.allowlistSender(payload.channelIntegrationId, payload.sender)
        } catch (err) {
          res.status(502).json({ kind: 'email_sender', error: (err as Error).message })
          return
        }
      }
      const updated = await opts.approvalsStore.respond(id, decision, userId, reason)
      res.json({ kind: 'email_sender', status: updated?.status ?? decision })
      return
    }

    // Non-workflow kinds resolve through their originating surface — the
    // queue lists them for visibility but does not action them in place.
    res.status(422).json({
      error: 'This approval kind resolves through its originating surface',
      kind: approval.kind,
      nativeSurface: NATIVE_SURFACE[approval.kind] ?? 'web',
      blockingSessionId: approval.blockingSessionId,
    })
  })

  return router
}
