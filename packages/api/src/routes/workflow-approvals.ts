/**
 * Workflow approvals routes (Phase C, Q4 §12).
 *
 *   GET  /api/workspaces/:workspaceId/approvals        — list pending
 *   POST /api/approvals/:id/approve                     — approve + resume
 *   POST /api/approvals/:id/reject                      — reject + fail run
 *
 * The route guards membership via the existing `app.current_user_id`
 * GUC; the executor / resume helper handles the side effects.
 *
 * [COMP:api/approval-routes]
 */

import { Router } from 'express'
import type { PendingApprovalsStore } from '../db/pending-approvals-store.js'
import type { WorkspaceStore } from '../db/workspace-store.js'
import { resumeFromApproval, type ApprovalBridgeDeps } from '../workflow/approval.js'

export type WorkflowApprovalRouteOptions = {
  approvalsStore: PendingApprovalsStore
  workspaceStore: WorkspaceStore
  bridgeDeps: ApprovalBridgeDeps
}

export function workflowApprovalsRoutes(
  opts: WorkflowApprovalRouteOptions,
): Router {
  const router = Router()

  // GET /workspaces/:workspaceId/approvals — list pending for the workspace.
  router.get('/workspaces/:workspaceId/approvals', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const workspaceId = req.params.workspaceId

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }

    const rows = await opts.approvalsStore.listPendingForWorkspace(userId, workspaceId)
    res.json({
      approvals: rows.map((r) => ({
        id: r.id,
        workflowRunId: r.workflowRunId,
        toolName: r.toolName,
        arguments: r.arguments,
        approverUserId: r.approverUserId,
        deliveryChannelType: r.deliveryChannelType,
        expiresAt: r.expiresAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    })
  })

  // POST /approvals/:id/approve — flip + resume.
  router.post('/approvals/:id/approve', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const id = req.params.id

    const approval = await opts.approvalsStore.getById(userId, id)
    if (!approval) { res.status(404).json({ error: 'Approval not found' }); return }
    if (approval.approverUserId !== userId) {
      res.status(403).json({ error: 'Only the assigned approver can respond' })
      return
    }
    if (approval.status !== 'pending') {
      res.json({ status: approval.status, runId: approval.workflowRunId, idempotent: true })
      return
    }

    const result = await resumeFromApproval(opts.bridgeDeps, id, 'approved', userId)
    res.json(result)
  })

  // POST /approvals/:id/reject — flip + mark run failed.
  router.post('/approvals/:id/reject', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const id = req.params.id

    const body = (req.body ?? {}) as { reason?: string }
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 1000) : undefined

    const approval = await opts.approvalsStore.getById(userId, id)
    if (!approval) { res.status(404).json({ error: 'Approval not found' }); return }
    if (approval.approverUserId !== userId) {
      res.status(403).json({ error: 'Only the assigned approver can respond' })
      return
    }
    if (approval.status !== 'pending') {
      res.json({ status: approval.status, runId: approval.workflowRunId, idempotent: true })
      return
    }

    const result = await resumeFromApproval(opts.bridgeDeps, id, 'rejected', userId, reason)
    res.json(result)
  })

  return router
}
