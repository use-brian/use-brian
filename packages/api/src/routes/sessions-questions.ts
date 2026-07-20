/**
 * askQuestion suspend-resume — answer / cancel / list routes.
 *
 * Three endpoints all keyed on a `pending_approvals` row with
 * `kind='question'`:
 *
 *   POST /api/sessions/:sessionId/answer/:approvalId
 *     Submit the user's free-text answer. Atomic flip: status 'pending'
 *     → 'approved', writes `answer_text`. Triggers the same Path B resume
 *     enqueue used by `tool_invocation`, so the chat turn continues
 *     either via the live in-memory resolver or via the scheduled-job
 *     resume worker.
 *
 *   POST /api/sessions/:sessionId/cancel/:approvalId
 *     User chose "cancel and start over." Flips status to 'rejected'
 *     with reason='cancelled'. The resume replay sees rejected + kind=
 *     'question' and emits a cancellation note; the queryLoop synthesises
 *     a final reply that acknowledges the cancellation.
 *
 *   GET /api/sessions/:sessionId/pending
 *     Frontend recovery probe. Called on chat reload to detect that the
 *     session is currently suspended on a question and re-render the
 *     inline answer input. Returns the pending row (`approvalId`,
 *     `question`, `expiresAt`) or `null`.
 *
 * See docs/architecture/engine/askquestion-suspend-resume.md.
 *
 * Component tag: [COMP:api/pending-questions-resume].
 */

import { Router } from 'express'
import type { WorkerRunsStore, WorkerStatus } from '@use-brian/core'
import { findSessionById } from '../db/sessions.js'
import { findAssistantById } from '../db/users.js'
import type { PendingApprovalsStore, PendingApproval } from '../db/pending-approvals-store.js'
import {
  enqueueToolInvocationResume,
  type ToolInvocationResumeDeps,
} from '../workflow/approval.js'

export type SessionQuestionRouteOptions = {
  approvalsStore: PendingApprovalsStore
  /**
   * Resume deps used by `enqueueToolInvocationResume`. The same fast-path
   * + scheduled-job machinery powers the question kind; only the replay
   * callback's branch (`approvalKind === 'question'`) differs, and that
   * lives in `session-resume-replay.ts`.
   */
  resumeDeps: ToolInvocationResumeDeps
  /**
   * Phase 3 / 5 — worker_runs read store used by GET /worker-runs to
   * power the live progress indicator the frontend shows during resume
   * polling. Optional; when absent the endpoint returns an empty
   * summary (legacy behavior — no worker persistence).
   */
  workerRunsStore?: WorkerRunsStore
}

/** Cap on workers surfaced by description in the live summary. Keeps
 *  the response tight for the 2s polling cadence. */
const ACTIVE_WORKER_DESCRIPTION_CAP = 10

function emptySummary() {
  return {
    total: 0, running: 0, completed: 0, failed: 0, stopped: 0,
    active: [] as Array<{ workerId: string; description: string }>,
  }
}

const MAX_ANSWER_CHARS = 8000

function isQuestionPendingForUser(
  approval: PendingApproval,
  userId: string,
  sessionId: string,
): { ok: true } | { ok: false; status: number; body: Record<string, unknown> } {
  if (approval.kind !== 'question') {
    return {
      ok: false,
      status: 400,
      body: { error: 'Approval is not a question', kind: approval.kind },
    }
  }
  if (approval.approverUserId !== userId) {
    return {
      ok: false,
      status: 403,
      body: { error: 'Only the asked user can resolve this question' },
    }
  }
  if (approval.blockingSessionId !== sessionId) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Question does not belong to this session' },
    }
  }
  if (approval.status !== 'pending') {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'Question already resolved',
        status: approval.status,
        idempotent: true,
      },
    }
  }
  return { ok: true }
}

export function sessionQuestionRoutes(opts: SessionQuestionRouteOptions): Router {
  const router = Router({ mergeParams: true })

  // GET /api/sessions/:sessionId/pending — return the pending question
  // for this session if one exists. Used by the frontend on chat reload
  // to detect "session suspended on a question" and re-render the inline
  // answer input.
  router.get('/:sessionId/pending', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const sessionId = req.params.sessionId
    const session = await findSessionById(sessionId)
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: 'Session not found' })
      return
    }
    // Workspace-scoped read — `listPendingForWorkspace` is RLS-gated to
    // the calling user. We filter to question kind + matching session.
    const assistant = await findAssistantById(session.assistantId)
    const wsId = assistant?.workspaceId ?? null
    if (!wsId) {
      // Pre-workspace assistants can't suspend on a question (the engine
      // requires `assistant.workspaceId` to mint the approval). Return
      // empty rather than 500.
      res.json({ pending: null })
      return
    }
    const pending = await opts.approvalsStore.listPendingForWorkspace(userId, wsId)
    const match = pending.find(
      (r) => r.kind === 'question' && r.blockingSessionId === sessionId,
    )
    if (!match) {
      res.json({ pending: null })
      return
    }
    res.json({
      pending: {
        approvalId: match.id,
        question:
          typeof match.approvalPayload.question === 'string'
            ? match.approvalPayload.question
            : null,
        expiresAt: match.expiresAt,
        createdAt: match.createdAt,
      },
    })
  })

  // POST /api/sessions/:sessionId/answer/:approvalId — submit answer.
  router.post('/:sessionId/answer/:approvalId', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const { sessionId, approvalId } = req.params
    const body = (req.body ?? {}) as { answer?: unknown }
    if (typeof body.answer !== 'string') {
      res.status(400).json({ error: 'answer must be a string' })
      return
    }
    const answer = body.answer.trim()
    if (answer.length === 0) {
      res.status(400).json({ error: 'answer is empty' })
      return
    }
    if (answer.length > MAX_ANSWER_CHARS) {
      res.status(400).json({
        error: `answer exceeds ${MAX_ANSWER_CHARS} characters`,
        actualLength: answer.length,
      })
      return
    }
    const approval = await opts.approvalsStore.getById(userId, approvalId)
    if (!approval) {
      res.status(404).json({ error: 'Approval not found' })
      return
    }
    const check = isQuestionPendingForUser(approval, userId, sessionId)
    if (!check.ok) {
      res.status(check.status).json(check.body)
      return
    }
    const updated = await opts.approvalsStore.recordAnswer(approvalId, answer, userId)
    if (!updated) {
      // Lost a race — another submit settled the row first.
      const settled = await opts.approvalsStore.getById(userId, approvalId)
      res.status(409).json({
        error: 'Question already resolved',
        status: settled?.status ?? 'unknown',
        idempotent: true,
      })
      return
    }
    const resume = await enqueueToolInvocationResume(opts.resumeDeps, {
      approval: updated,
      decision: 'approved',
    })
    res.json({
      status: updated.status,
      resume,
    })
  })

  // GET /api/sessions/:sessionId/worker-runs — live progress summary.
  // Polled by the web client at ~2s while the resume worker drives the
  // continuation turn after an answer / cancel. The shape is a status
  // histogram + descriptions of currently-running workers so the UI can
  // render "3 of 5 researchers still working" with per-worker hover
  // text. Workspace-scoped via the session-ownership gate; the store
  // itself is system-bypass (workers are server-side infra). See
  // docs/architecture/engine/askquestion-suspend-resume.md.
  router.get('/:sessionId/worker-runs', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const sessionId = req.params.sessionId
    const session = await findSessionById(sessionId)
    if (!session || session.userId !== userId) {
      res.status(404).json({ error: 'Session not found' })
      return
    }
    if (!opts.workerRunsStore) {
      // No persistence wired — return empty so the frontend stops the
      // progress chip without erroring.
      res.json({ summary: emptySummary() })
      return
    }
    const rows = await opts.workerRunsStore.loadForSession(sessionId)
    const counts: Record<WorkerStatus, number> = {
      running: 0, completed: 0, failed: 0, stopped: 0,
    }
    const active: Array<{ workerId: string; description: string }> = []
    for (const r of rows) {
      counts[r.status] = (counts[r.status] ?? 0) + 1
      if (r.status === 'running' && active.length < ACTIVE_WORKER_DESCRIPTION_CAP) {
        active.push({ workerId: r.workerId, description: r.description })
      }
    }
    res.json({
      summary: {
        total: rows.length,
        running: counts.running,
        completed: counts.completed,
        failed: counts.failed,
        stopped: counts.stopped,
        active,
      },
    })
  })

  // POST /api/sessions/:sessionId/cancel/:approvalId — cancel question.
  router.post('/:sessionId/cancel/:approvalId', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const { sessionId, approvalId } = req.params
    const approval = await opts.approvalsStore.getById(userId, approvalId)
    if (!approval) {
      res.status(404).json({ error: 'Approval not found' })
      return
    }
    const check = isQuestionPendingForUser(approval, userId, sessionId)
    if (!check.ok) {
      res.status(check.status).json(check.body)
      return
    }
    // Reuse `respond('rejected', ...)` with reason='cancelled'. The resume
    // replay reads kind='question' + status='rejected' and emits the
    // cancellation outcome note, which the model uses to acknowledge in
    // the synthesis turn.
    const updated = await opts.approvalsStore.respond(
      approvalId,
      'rejected',
      userId,
      'cancelled',
    )
    if (!updated) {
      const settled = await opts.approvalsStore.getById(userId, approvalId)
      res.status(409).json({
        error: 'Question already resolved',
        status: settled?.status ?? 'unknown',
        idempotent: true,
      })
      return
    }
    const resume = await enqueueToolInvocationResume(opts.resumeDeps, {
      approval: updated,
      decision: 'rejected',
    })
    res.json({
      status: updated.status,
      resume,
    })
  })

  return router
}
