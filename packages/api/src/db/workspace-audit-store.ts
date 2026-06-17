/**
 * Workspace audit store — append + read for the §6 audit feed.
 *
 * The `workspace_audit_log` table (renamed from `team_audit_log` in migration
 * 110, originally created by 109) is the single sink for "who did what when"
 * events scoped to a workspace: member changes, connector connect/disconnect,
 * settings edits, plan changes. Distribution-pipeline events live in their
 * own table (`distribution_events`) and are unioned at read time by the
 * `/api/workspaces/:id/audit` route.
 *
 * Reads use `queryWithRLS` so the per-workspace `tal_member` policy
 * (migration 109) gates what each user sees. Writes happen system-level via
 * the default-true bypass policy because the route handler has already
 * authorized the actor — recording the audit entry is a side effect of the
 * authorized action, not a fresh permission decision.
 *
 * See docs/plans/company-brain.md → "§6 Audit UI".
 */

import { query, queryWithRLS } from './client.js'

export type WorkspaceAuditEventType =
  | 'workspace.renamed'
  | 'workspace.purpose_updated'
  | 'workspace.icon_changed'
  | 'member.added'
  | 'member.removed'
  | 'member.role_changed'
  | 'member.invited'
  | 'member.invite_accepted'
  | 'member.invite_revoked'
  | 'connector.connected'
  | 'connector.disconnected'
  | 'plan.changed'
  // Phase A — workflow primitive (Q4 §12)
  | 'workflow.created'
  | 'workflow.updated'
  | 'workflow.deleted'
  | 'workflow.run_started'
  | 'workflow.run_completed'
  | 'workflow.run_failed'
  | 'workflow.step_delivered'
  // Page-anchor dead-anchor circuit breaker (workflow-page-anchor.md §9)
  | 'workflow.auto_disabled'
  // Phase C — workflow approval flow (Q4 §12)
  | 'workflow.approval_requested'
  | 'workflow.approval_approved'
  | 'workflow.approval_rejected'
  | 'workflow.approval_expired'
  // Q3 Phase A — workspace filesystem (§10)
  | 'file.created'
  | 'file.appended'
  | 'file.meta_updated'
  | 'file.deleted'

export type WorkspaceAuditEvent = {
  id: string
  workspaceId: string
  actorUserId: string | null
  eventType: WorkspaceAuditEventType
  subjectId: string | null
  details: Record<string, unknown>
  createdAt: Date
}

export type AppendAuditParams = {
  workspaceId: string
  /** Null when the event was triggered by a non-user actor (e.g., Stripe webhook). */
  actorUserId: string | null
  eventType: WorkspaceAuditEventType
  /** Optional UUID identifying what the event is about (a member's userId, a
   *  connector instance id, etc.). Null for events that target the workspace
   *  itself. */
  subjectId?: string | null
  details?: Record<string, unknown>
}

export type ListAuditOptions = {
  /** Cursor — return rows strictly older than this timestamp. */
  before?: Date
  /** Default 50, max 200. */
  limit?: number
  eventTypes?: WorkspaceAuditEventType[]
  actorUserId?: string
}

const COLS = `
  id,
  workspace_id  AS "workspaceId",
  actor_user_id AS "actorUserId",
  event_type    AS "eventType",
  subject_id    AS "subjectId",
  details,
  created_at    AS "createdAt"
`

export type WorkspaceAuditStore = {
  /** Append a new audit row. System-level — caller is responsible for
   *  having authorized the underlying action before logging it. */
  append(params: AppendAuditParams): Promise<void>

  /** List a workspace's audit events, newest-first. Workspace-scoped via RLS. */
  list(
    userId: string,
    workspaceId: string,
    opts?: ListAuditOptions,
  ): Promise<WorkspaceAuditEvent[]>
}

export function createWorkspaceAuditStore(): WorkspaceAuditStore {
  return {
    async append(params) {
      try {
        await query(
          `INSERT INTO workspace_audit_log (workspace_id, actor_user_id, event_type, subject_id, details)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            params.workspaceId,
            params.actorUserId,
            params.eventType,
            params.subjectId ?? null,
            params.details ?? {},
          ],
        )
      } catch (err) {
        // Audit writes are fire-and-forget at the call site: a failed
        // INSERT must never break the underlying user action. Log and move on.
        console.warn(
          `[workspace-audit] append failed for event_type=${params.eventType}`,
          err,
        )
      }
    },

    async list(userId, workspaceId, opts = {}) {
      const limit = Math.min(opts.limit ?? 50, 200)
      const conditions: string[] = ['workspace_id = $1']
      const values: unknown[] = [workspaceId]

      if (opts.before) {
        values.push(opts.before)
        conditions.push(`created_at < $${values.length}`)
      }
      if (opts.eventTypes && opts.eventTypes.length > 0) {
        values.push(opts.eventTypes)
        conditions.push(`event_type = ANY($${values.length}::text[])`)
      }
      if (opts.actorUserId) {
        values.push(opts.actorUserId)
        conditions.push(`actor_user_id = $${values.length}`)
      }

      values.push(limit)
      const result = await queryWithRLS<WorkspaceAuditEvent>(
        userId,
        `SELECT ${COLS} FROM workspace_audit_log
         WHERE ${conditions.join(' AND ')}
         ORDER BY created_at DESC
         LIMIT $${values.length}`,
        values,
      )
      return result.rows
    },
  }
}
