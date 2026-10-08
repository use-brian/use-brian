/** Shared session read authorization.
 * Spec: docs/architecture/features/workflow.md, Session-backed approval read authority.
 * [COMP:api/pending-approvals-store]
 */
import { findFeedThreadDraft } from './content-planning/collaboration-service.js'
import { getFeedCollaboration } from './db/feed-collaboration-store.js'
import { getUserAssistant } from './db/users.js'
import { query } from './db/client.js'
import { getWorkspaceMembershipWithReadScopeSystem } from './db/workspace-store.js'
import { decideSessionRead } from './session-read-access.js'

/** A session whose read-access we gate (the subset of fields the gate reads). */
type GatedSession = {
  id?: string
  channelType?: string
  userId: string
  assistantId: string
  visibility: string | null
  mode: string | null
  effectiveClearance: string | null
  contextCompartments?: string[]
  contextProjectId?: string | null
}

/**
 * Authorize a per-session read for the caller. Shared by `GET /:id/messages`,
 * the reconnect stream `GET /:id/stream`, and the `POST /api/chat` resume path
 * (`routes/chat.ts`) so they can't drift: a `visibility='workspace'` session
 * (doc comment threads, migration 223) or a `mode='draft'` session is readable
 * by any workspace member at/above the session's `effective_clearance`
 * (migration 224); every other session is owner-only. Returns `null` on
 * success, or `{ status, error }` to reject. Exported so the chat write/resume
 * path enforces the same rule as the reads (WS3: `findSessionById` did no
 * per-user check, so a member of a shared primary assistant could resume
 * another member's private session by id).
 *
 * The decision itself is the pure `decideSessionRead`
 * (`../session-read-access.ts`), shared with the Live roster's tiering so
 * the gate and the roster cannot drift; this wrapper only resolves the
 * async facts (assistant → workspace, caller → membership clearance).
 */
export async function gateSessionRead(
  jwtUserId: string,
  session: GatedSession,
): Promise<{ status: number; error: string } | null> {
  if (!(await getUserAssistant(jwtUserId, session.assistantId))) return { status: 403, error: 'Session not available' }
  if (session.mode === 'draft' && session.id && !(await query('SELECT feed_draft_audience_allowed($1) AS allowed', [session.id])).rows[0]?.allowed) return { status: 403, error: 'Draft source access required' }
  if (session.channelType === 'feed_thread') {
    const parent = session.id ? await findFeedThreadDraft(session.id) : null
    if (!parent || parent.assistantId !== session.assistantId) return { status: 404, error: 'Draft discussion not found' }
    try { await getFeedCollaboration({ userId: jwtUserId, assistantId: parent.assistantId, sessionId: parent.sessionId, kind: 'user' }); return null }
    catch { return { status: 403, error: 'Draft access required' } }
  }
  let assistantWorkspaceId: string | null = null
  let membershipClearance: 'public' | 'internal' | 'confidential' | null = null
  let membershipCompartments: string[] | null | undefined
  let departmentAccess: NonNullable<Awaited<ReturnType<typeof getWorkspaceMembershipWithReadScopeSystem>>>['departmentAccess']
  let membershipProjectIds: string[] | null | undefined
  {
    // Private workspace sessions retain their department floor after ownership checks.
    const teamRow = await query<{ workspaceId: string | null }>(
      `SELECT workspace_id AS "workspaceId" FROM assistants WHERE id = $1`,
      [session.assistantId],
    )
    assistantWorkspaceId = teamRow.rows[0]?.workspaceId ?? null
    if (assistantWorkspaceId) {
      const membership = await getWorkspaceMembershipWithReadScopeSystem(jwtUserId, assistantWorkspaceId)
      membershipClearance = membership?.clearance ?? null
      membershipCompartments = membership?.compartments
      membershipProjectIds = membership?.projectIds
      departmentAccess = membership?.departmentAccess
    }
  }
  const decision = decideSessionRead({
    callerUserId: jwtUserId,
    session,
    assistantWorkspaceId,
    membershipClearance,
    membershipCompartments,
    membershipProjectIds,
    departmentAccess,
  })
  return decision.readable ? null : { status: decision.status, error: decision.error }
}
