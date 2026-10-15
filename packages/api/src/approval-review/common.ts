/** Shared approval-review helpers: the authenticated actor, workspace role and audit. */
import { getPool } from '../db/client.js'
import { createWorkspaceAuditStore, type WorkspaceAuditEventType } from '../db/workspace-audit-store.js'

/** Who is acting, supplied by authentication, never by arguments. */
export type ReviewActor = {
  userId: string
  /** `ui` = authenticated web route; `chat` = attended Brian turn; `mcp` = programmatic. */
  origin: 'ui' | 'chat' | 'mcp'
  /** True only for an authenticated web request or an attended human chat turn. */
  human: boolean
  /** What the human selected or said, and where (for the instruction receipt). */
  receipt?: { sessionId?: string | null; messageId?: string | null; text?: string | null; selection?: string | null }
}

export async function workspaceRole(userId: string, workspaceId: string): Promise<string | null> {
  const r = await getPool().query<{ role: string }>(
    'SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [workspaceId, userId])
  return r.rows[0]?.role ?? null
}

const auditStore = createWorkspaceAuditStore()

export async function appendApprovalReviewAudit(
  workspaceId: string,
  actorUserId: string | null,
  eventType: WorkspaceAuditEventType,
  subjectId: string,
  details: Record<string, unknown>,
): Promise<void> {
  await auditStore.append({ workspaceId, actorUserId, eventType, subjectId, details }).catch((err) => {
    console.warn('[approval-review] audit append failed', err)
  })
}
