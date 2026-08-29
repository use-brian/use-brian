/**
 * Live — the all-activity roster route (docs/architecture/features/live-work.md §3).
 *
 *   GET /api/workspaces/:workspaceId/live
 *
 * One merged, server-side-tiered list of everything the workspace's
 * assistants are doing right now: running + recently-settled sessions
 * (web, rooms, doc threads, channels) and workflow runs (which, post
 * Phase-2 cutover, ARE the scheduled jobs). Read/watch-only v1 — this
 * route ships projections, never verbs.
 *
 * Tiering is decided here, per row, before anything leaves the server
 * (D9): `full` rows carry the content-derived `title`; `presence` rows
 * carry EXACTLY the §6.1 allowlist (built from named fields — never a
 * spread of the session row); above-clearance workspace sessions are
 * omitted entirely (D5); sessions on personal assistants outside the
 * workspace are structurally excluded by the `assistants.workspace_id`
 * join (§6-a). The tier predicate is the shared `liveSessionTier` /
 * `decideSessionRead` (../session-read-access.ts) — the exact
 * `gateSessionRead` rule, reused not re-implemented.
 *
 * [COMP:api/live-work-roster]
 */
import { Router } from 'express'
import { query } from '../db/client.js'
import { getWorkspaceMembershipWithClearanceSystem } from '../db/workspace-store.js'
import { TURN_LEASE_STALE_AFTER_MS } from '../db/sessions.js'
import { liveSessionTier } from '../session-read-access.js'

/** How long a settled item stays on the roster — a read-time window, no stored state (§3.2). */
export const LIVE_RECENT_WINDOW_MINUTES = 30

/** Roster size guard: newest-activity-first, beyond this the tail is noise. */
const ROSTER_LIMIT = 200

export type LiveWorkState = 'working' | 'waiting' | 'stalled' | 'settled'

export type LiveSessionItem = {
  kind: 'session'
  tier: 'full' | 'presence'
  id: string
  assistantId: string
  assistantName: string
  ownerUserId: string | null
  ownerName: string | null
  channelType: string
  state: LiveWorkState
  startedAt: string
  lastActiveAt: string
  /** FULL tier only — §6.1: a presence row carries EXACTLY the allowlist. */
  visibility?: string | null
  /** FULL tier only — content-derived, never on a presence row (§6.1). */
  title?: string
}

export type LiveWorkflowRunItem = {
  kind: 'workflow_run'
  id: string
  workflowId: string
  workflowName: string
  assistantId: string | null
  assistantName: string | null
  trigger: 'scheduled' | 'manual' | 'event'
  state: LiveWorkState
  startedAt: string
  lastActiveAt: string
  stepSummary?: string
}

export type LiveWorkItem = LiveSessionItem | LiveWorkflowRunItem

/**
 * Session `state` derivation (§3.2): `working` = running + fresh
 * heartbeat; `waiting` = running + an unresolved blocking
 * confirmation/question; `stalled` = running + stale lease — the
 * sweeper's own predicate (`COALESCE(turn_heartbeat_at,
 * last_active_at)`), read-only here: the roster never reclaims;
 * `settled` = anything not running inside the recent window.
 */
export function deriveSessionState(row: {
  status: string
  waiting: boolean
  turnHeartbeatAt: Date | null
  lastActiveAt: Date
  now?: Date
  staleAfterMs?: number
}): LiveWorkState {
  if (row.status !== 'running') return 'settled'
  if (row.waiting) return 'waiting'
  const now = row.now ?? new Date()
  const staleAfterMs = row.staleAfterMs ?? TURN_LEASE_STALE_AFTER_MS
  const liveness = row.turnHeartbeatAt ?? row.lastActiveAt
  if (now.getTime() - liveness.getTime() > staleAfterMs) return 'stalled'
  return 'working'
}

/**
 * Run `state` derivation (§3.2): runs have no session lock — their
 * liveness is `workflow_runs.status` + `last_active_at` recency, mapped
 * analogously to sessions. `awaiting_input` / `awaiting_wait` are the
 * run-side "waiting"; a pending/running run whose `last_active_at` went
 * stale past the same derived threshold is `stalled`.
 */
export function deriveRunState(row: {
  status: string
  lastActiveAt: Date
  now?: Date
  staleAfterMs?: number
}): LiveWorkState {
  if (row.status === 'awaiting_input' || row.status === 'awaiting_wait') return 'waiting'
  if (row.status === 'pending' || row.status === 'running') {
    const now = row.now ?? new Date()
    const staleAfterMs = row.staleAfterMs ?? TURN_LEASE_STALE_AFTER_MS
    if (now.getTime() - row.lastActiveAt.getTime() > staleAfterMs) return 'stalled'
    return 'working'
  }
  return 'settled'
}

type SessionRosterRow = {
  id: string
  assistantId: string
  assistantName: string
  assistantWorkspaceId: string
  userId: string
  ownerName: string | null
  channelType: string
  visibility: string | null
  mode: string | null
  status: string
  effectiveClearance: string | null
  title: string | null
  createdAt: Date
  lastActiveAt: Date
  turnHeartbeatAt: Date | null
  waiting: boolean
}

type RunRosterRow = {
  id: string
  workflowId: string
  workflowName: string
  triggerKind: string
  status: string
  currentStepId: string | null
  startedAt: Date
  lastActiveAt: Date
}

/**
 * Build one roster item from a session row, or null when the row is
 * omitted (D5). The presence projection is built from NAMED fields only
 * — the §6.1 allowlist is the feature; adding a field here is a spec
 * change, not a convenience.
 */
export function projectSessionRow(
  row: SessionRosterRow,
  callerUserId: string,
  membershipClearance: 'public' | 'internal' | 'confidential',
  now?: Date,
): LiveSessionItem | null {
  const tier = liveSessionTier({
    callerUserId,
    session: {
      userId: row.userId,
      visibility: row.visibility,
      mode: row.mode,
      effectiveClearance: row.effectiveClearance,
    },
    assistantWorkspaceId: row.assistantWorkspaceId,
    membershipClearance,
  })
  if (tier === 'omitted') return null
  const state = deriveSessionState({
    status: row.status,
    waiting: row.waiting,
    turnHeartbeatAt: row.turnHeartbeatAt,
    lastActiveAt: row.lastActiveAt,
    now,
  })
  // The §6.1 presence allowlist, built from NAMED fields — this object IS
  // the projection boundary; full tier extends it, presence ships it as-is.
  const base: LiveSessionItem = {
    kind: 'session',
    tier,
    id: row.id,
    assistantId: row.assistantId,
    assistantName: row.assistantName,
    ownerUserId: row.userId,
    ownerName: row.ownerName,
    channelType: row.channelType,
    state,
    startedAt: row.createdAt.toISOString(),
    lastActiveAt: row.lastActiveAt.toISOString(),
  }
  if (tier === 'full') {
    base.visibility = row.visibility
    if (row.title) base.title = row.title
  }
  return base
}

/** Map `workflow_runs.trigger_kind` onto the roster's trigger vocabulary. */
function rosterTrigger(triggerKind: string): 'scheduled' | 'manual' | 'event' {
  if (triggerKind === 'schedule') return 'scheduled'
  if (triggerKind === 'event') return 'event'
  return 'manual'
}

export function projectRunRow(row: RunRosterRow, now?: Date): LiveWorkflowRunItem {
  const item: LiveWorkflowRunItem = {
    kind: 'workflow_run',
    id: row.id,
    workflowId: row.workflowId,
    workflowName: row.workflowName,
    // workflow_runs carries no assistant binding; the callee session's
    // assistant surfaces through the watch pane instead (§5.3).
    assistantId: null,
    assistantName: null,
    trigger: rosterTrigger(row.triggerKind),
    state: deriveRunState({ status: row.status, lastActiveAt: row.lastActiveAt, now }),
    startedAt: row.startedAt.toISOString(),
    lastActiveAt: row.lastActiveAt.toISOString(),
  }
  if (row.currentStepId) item.stepSummary = row.currentStepId
  return item
}

/**
 * The two source queries (§3.2), scoped and merged. Sessions scope by the
 * `assistants.workspace_id = $ws` join — the §6-a boundary that
 * structurally excludes teammates' personal assistants — and exclude the
 * callee lanes (`workflow` / `assistant-call`), which never hold the
 * session lock and appear as workflow-run rows instead (D2). The
 * `waiting` flag reads `pending_approvals.blocking_session_id`
 * (unresolved blocking confirmation for that session).
 */
async function fetchSessionRows(workspaceId: string): Promise<SessionRosterRow[]> {
  const result = await query<SessionRosterRow>(
    `SELECT s.id,
            s.assistant_id           AS "assistantId",
            a.name                   AS "assistantName",
            a.workspace_id           AS "assistantWorkspaceId",
            s.user_id                AS "userId",
            u.name                   AS "ownerName",
            s.channel_type           AS "channelType",
            s.visibility,
            s.mode,
            s.status,
            s.effective_clearance    AS "effectiveClearance",
            s.title,
            s.created_at             AS "createdAt",
            s.last_active_at         AS "lastActiveAt",
            s.turn_heartbeat_at      AS "turnHeartbeatAt",
            EXISTS (
              SELECT 1 FROM pending_approvals pa
               WHERE pa.blocking_session_id = s.id
                 AND pa.status = 'pending'
                 AND (pa.expires_at IS NULL OR pa.expires_at > now())
            ) AS "waiting"
       FROM sessions s
       JOIN assistants a ON a.id = s.assistant_id
       LEFT JOIN users u ON u.id = s.user_id
      WHERE a.workspace_id = $1
        AND s.channel_type NOT IN ('workflow', 'assistant-call')
        AND (s.status = 'running'
             OR s.last_active_at > now() - ($2 || ' minutes')::interval)
      ORDER BY s.last_active_at DESC
      LIMIT $3`,
    [workspaceId, String(LIVE_RECENT_WINDOW_MINUTES), ROSTER_LIMIT],
  )
  return result.rows
}

async function fetchRunRows(workspaceId: string): Promise<RunRosterRow[]> {
  const result = await query<RunRosterRow>(
    `SELECT r.id,
            r.workflow_id     AS "workflowId",
            w.name            AS "workflowName",
            r.trigger_kind    AS "triggerKind",
            r.status,
            r.current_step_id AS "currentStepId",
            r.started_at      AS "startedAt",
            r.last_active_at  AS "lastActiveAt"
       FROM workflow_runs r
       JOIN workflows w ON w.id = r.workflow_id
      WHERE r.workspace_id = $1
        AND (r.status IN ('pending', 'running', 'awaiting_input', 'awaiting_wait')
             OR r.last_active_at > now() - ($2 || ' minutes')::interval)
      ORDER BY r.last_active_at DESC
      LIMIT $3`,
    [workspaceId, String(LIVE_RECENT_WINDOW_MINUTES), ROSTER_LIMIT],
  )
  return result.rows
}

/**
 * Mounted at `/api` behind `requireAuth` alongside the other open authed
 * routers (boot.ts). Membership + clearance resolve ONCE per request;
 * workflow-run rows follow the existing run-read authorization (any
 * workspace member — the same access the run-detail surfaces grant).
 */
export function liveWorkRoutes(): Router {
  const router = Router()

  router.get('/workspaces/:workspaceId/live', async (req, res) => {
    try {
      const callerUserId = req.userId
      if (!callerUserId) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      const { workspaceId } = req.params
      const membership = await getWorkspaceMembershipWithClearanceSystem(callerUserId, workspaceId)
      if (!membership) {
        res.status(403).json({ error: 'Not a member of this workspace' })
        return
      }

      const [sessionRows, runRows] = await Promise.all([
        fetchSessionRows(workspaceId),
        fetchRunRows(workspaceId),
      ])
      const now = new Date()
      const items: LiveWorkItem[] = [
        ...sessionRows
          .map((row) => projectSessionRow(row, callerUserId, membership.clearance, now))
          .filter((item): item is LiveSessionItem => item !== null),
        ...runRows.map((row) => projectRunRow(row, now)),
      ].sort((a, b) => (a.lastActiveAt < b.lastActiveAt ? 1 : a.lastActiveAt > b.lastActiveAt ? -1 : 0))

      res.json({ items })
    } catch (err) {
      console.error('[live-work] roster failed:', err)
      res.status(500).json({ error: 'Failed to load live activity' })
    }
  })

  return router
}
