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
import { findOfficeArtifactForSessionSystem } from './db/office-artifact-sessions.js'
import { policyFor } from './session-kind.js'
import { resolveOfficeAccess } from './office/access.js'

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
 * The anchor half of the read rule (`sessionPolicy(kind).read.anchorGate`).
 * A workspace session attached to a feed draft, a feed thread or an Office
 * file is read by that anchor's audience, in addition to (draft) or instead
 * of (feed thread, Office file) the membership decision. Returns
 * `'continue'` when the membership decision must still run, `null` when the
 * anchor alone authorizes, or the refusal. The ONE implementation the gate,
 * the workspace list and the Live roster share (unified-sessions L3, L4).
 */
export async function anchorReadGate(
  jwtUserId: string,
  session: Pick<GatedSession, 'id' | 'channelType' | 'assistantId' | 'visibility' | 'mode'>,
): Promise<{ status: number; error: string } | null | 'continue'> {
  const policy = policyFor({ channelType: session.channelType ?? 'web', visibility: session.visibility, mode: session.mode })
  if (policy.read.rule !== 'workspace') return 'continue'
  switch (policy.read.anchorGate) {
    case 'none':
      return 'continue'
    case 'feed_draft_audience':
      if (session.id && !(await query('SELECT feed_draft_audience_allowed($1) AS allowed', [session.id])).rows[0]?.allowed) {
        return { status: 403, error: 'Draft source access required' }
      }
      return 'continue'
    case 'feed_collaboration': {
      const parent = session.id ? await findFeedThreadDraft(session.id) : null
      if (!parent || parent.assistantId !== session.assistantId) return { status: 404, error: 'Draft discussion not found' }
      try { await getFeedCollaboration({ userId: jwtUserId, assistantId: parent.assistantId, sessionId: parent.sessionId, kind: 'user' }); return null }
      catch { return { status: 403, error: 'Draft access required' } }
    }
    case 'office_file': {
      // An Office file's shared thread is read by exactly the file's
      // audience: the Office access predicate decides, never workspace
      // membership. A caller who cannot read the file learns nothing.
      const link = session.id ? await findOfficeArtifactForSessionSystem(session.id) : null
      if (!link || !(await resolveOfficeAccess(jwtUserId, link.artifactId))) return { status: 404, error: 'Session not found' }
      return null
    }
  }
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
  const anchor = await anchorReadGate(jwtUserId, session)
  if (anchor !== 'continue') return anchor
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
