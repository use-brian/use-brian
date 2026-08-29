/**
 * Approval ground truth — the free eval (plan §9).
 *
 * Every `pending_approvals` row is a labelled datapoint the product
 * already collects: the agent proposed an action (tool + arguments), a
 * human decided. Their difference IS the eval — a tool family with a
 * high rejection rate is a tool the model proposes wrongly, and the
 * reject reasons are the rubric. This module just reads what's already
 * there; nothing new is captured.
 *
 * Spec: docs/architecture/engine/turn-ledger.md → "Approval ground truth"
 * [COMP:api/approval-ground-truth]
 */

import { query } from '../db/client.js'

export type ApprovalDatapoint = {
  id: string
  toolName: string
  argumentsJson: unknown
  decision: string
  respondedBy: string | null
  rejectReason: string | null
  proposedAt: Date
  respondedAt: Date
  latencyMs: number
}

export type ApprovalToolSummary = {
  toolName: string
  proposed: number
  approved: number
  rejected: number
  rejectionRate: number
  rejectReasons: string[]
}

/** Decided approvals for a workspace window — the labelled set. */
export async function listApprovalGroundTruth(params: {
  workspaceId: string
  since?: Date
}): Promise<ApprovalDatapoint[]> {
  const res = await query(
    `SELECT id, tool_name, arguments, status, responded_by, reject_reason, created_at, responded_at
       FROM pending_approvals
      WHERE workspace_id = $1
        AND responded_at IS NOT NULL
        AND ($2::timestamptz IS NULL OR created_at >= $2)
      ORDER BY responded_at ASC`,
    [params.workspaceId, params.since ?? null],
  )
  return res.rows.map((r) => ({
    id: r.id as string,
    toolName: r.tool_name as string,
    argumentsJson: r.arguments,
    decision: r.status as string,
    respondedBy: (r.responded_by as string | null) ?? null,
    rejectReason: (r.reject_reason as string | null) ?? null,
    proposedAt: r.created_at as Date,
    respondedAt: r.responded_at as Date,
    latencyMs: (r.responded_at as Date).getTime() - (r.created_at as Date).getTime(),
  }))
}

const REJECTED_STATUSES = new Set(['rejected', 'denied', 'cancelled'])

/** Per-tool agent-proposed vs human-decided summary. */
export function summarizeApprovalGroundTruth(rows: ApprovalDatapoint[]): ApprovalToolSummary[] {
  const byTool = new Map<string, ApprovalToolSummary>()
  for (const row of rows) {
    let s = byTool.get(row.toolName)
    if (!s) {
      s = { toolName: row.toolName, proposed: 0, approved: 0, rejected: 0, rejectionRate: 0, rejectReasons: [] }
      byTool.set(row.toolName, s)
    }
    s.proposed += 1
    if (REJECTED_STATUSES.has(row.decision)) {
      s.rejected += 1
      if (row.rejectReason) s.rejectReasons.push(row.rejectReason)
    } else {
      s.approved += 1
    }
  }
  for (const s of byTool.values()) {
    s.rejectionRate = s.proposed === 0 ? 0 : s.rejected / s.proposed
  }
  return [...byTool.values()].sort((a, b) => b.rejectionRate - a.rejectionRate || b.proposed - a.proposed)
}
