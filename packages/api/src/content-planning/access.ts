/** Canonical Feed membership and draft-permission gate, shared by routes and turn context. [COMP:feed/content-planning-routes] */
import { query } from '../db/client.js'
import { canMemberDraftRole, getWorkspaceMembershipSystem } from '../db/workspace-store.js'
export type PlanningAccessContext = {
  userId: string
  workspaceId: string
  role: 'owner' | 'admin' | 'member'
  canDraft: boolean
}

export async function resolvePlanningAccess(
  userId: string,
  assistantId: string,
): Promise<PlanningAccessContext | null> {
  const result = await query<{
    workspaceId: string | null
    kind: string
    appType: string | null
  }>(
    `SELECT workspace_id AS "workspaceId", kind, app_type AS "appType"
       FROM assistants
      WHERE id = $1`,
    [assistantId],
  )
  const assistant = result.rows[0]
  if (
    !assistant?.workspaceId
    || assistant.kind !== 'app'
    || assistant.appType !== 'distribution'
  ) {
    return null
  }
  const membership = await getWorkspaceMembershipSystem(
    userId,
    assistant.workspaceId,
  )
  if (!membership) return null
  return {
    userId,
    workspaceId: assistant.workspaceId,
    role: membership.role,
    canDraft: canMemberDraftRole(membership.role, membership.canDraft),
  }
}

