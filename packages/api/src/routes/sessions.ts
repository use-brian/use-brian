import { Router } from 'express'
import { findOrCreateUser, getDefaultAssistant, getUserAssistant, getUserProfilesByIds, getWorkspacePrimaryAssistant } from '../db/users.js'
import { findSessionByChannel, findSessionById, getSessionMessages, renameSession } from '../db/sessions.js'
import { query } from '../db/client.js'
import { resolveUser } from './route-helpers.js'
import { getWorkspaceRoleSystem, getWorkspaceMembershipWithClearanceSystem } from '../db/workspace-store.js'
import { canRead } from '@sidanclaw/core'
import {
  type SessionEvent,
  type SubscribeSessionEvents,
  noopSubscribeSessionEvents,
} from '../session-event-port.js'

/** A session whose read-access we gate (the subset of fields the gate reads). */
type GatedSession = {
  userId: string
  assistantId: string
  visibility: string | null
  mode: string | null
  effectiveClearance: string | null
}

/**
 * Authorize a per-session read for the caller. Shared by `GET /:id/messages`
 * and the reconnect stream `GET /:id/stream` so the two can't drift: a
 * `visibility='workspace'` session (doc comment threads, migration 223) or a
 * `mode='draft'` session is readable by any workspace member at/above the
 * session's `effective_clearance` (migration 224); every other session is
 * owner-only. Returns `null` on success, or `{ status, error }` to reject.
 */
async function gateSessionRead(
  jwtUserId: string,
  session: GatedSession,
): Promise<{ status: number; error: string } | null> {
  if (session.visibility === 'workspace' || session.mode === 'draft') {
    const teamRow = await query<{ workspaceId: string | null }>(
      `SELECT workspace_id AS "workspaceId" FROM assistants WHERE id = $1`,
      [session.assistantId],
    )
    const workspaceId = teamRow.rows[0]?.workspaceId
    if (!workspaceId) return { status: 403, error: 'Draft session is not team-owned' }
    const membership = await getWorkspaceMembershipWithClearanceSystem(jwtUserId, workspaceId)
    if (!membership) return { status: 403, error: 'Not a member of this team' }
    if (
      session.effectiveClearance &&
      !canRead(membership.clearance, session.effectiveClearance as 'public' | 'internal' | 'confidential')
    ) {
      return { status: 403, error: 'Insufficient clearance' }
    }
    return null
  }
  if (session.userId !== jwtUserId) return { status: 403, error: 'Forbidden' }
  return null
}

/**
 * Session API routes for web UI.
 * GET /api/sessions — list user's web sessions
 * GET /api/sessions/:id/messages — get messages for a session
 */
export type SessionRouteOptions = {
  /**
   * Live session-event bus subscribe — backs the `GET /:id/stream` reconnect
   * relay (the doc-comment live-reconnect feature). The composition root injects
   * the real `subscribeSessionEvents` (the open session-event bus); when unset
   * the relay no-ops. See oss-local-brain-wedge.md §12.5.
   */
  subscribeSessionEvents?: SubscribeSessionEvents
}

export function sessionRoutes(opts: SessionRouteOptions = {}): Router {
  const subscribeSessionEvents = opts.subscribeSessionEvents ?? noopSubscribeSessionEvents
  const router = Router()

  router.get('/', async (req, res) => {
    try {
      const jwtUserId = (req as { userId?: string }).userId
      const user = await resolveUser(jwtUserId)
      if (!user) { res.json([]); return }

      // Resolve the assistant whose sessions we list. Mirrors the chat
      // route's workspace-aware routing (routes/chat.ts → "assistant
      // resolution") so Recents are scoped to the SAME assistant a new chat
      // from this surface would target:
      //   1. assistantId given → that assistant (access-checked).
      //   2. workspaceId given, no assistantId → that workspace's primary
      //      assistant (membership-checked). This is what the chat-home
      //      sends. WITHOUT it the list fell through to getDefaultAssistant
      //      below — the *Personal* workspace's primary — so every other
      //      workspace's Recents leaked the user's personal chat history
      //      (cross-workspace history leak).
      //   3. neither → the user's default (Personal-workspace primary).
      //      Back-compat for callers that predate the workspaceId param.
      const requestedAssistantId = req.query.assistantId as string | undefined
      const requestedWorkspaceId = req.query.workspaceId as string | undefined
      const assistant = requestedAssistantId
        ? await getUserAssistant(user.id, requestedAssistantId)
        : requestedWorkspaceId
          ? await getWorkspacePrimaryAssistant(user.id, requestedWorkspaceId)
          : await getDefaultAssistant(user.id)
      if (!assistant) { res.json([]); return }

      // Optional surface scope (migration 187, extended by 255). When the
      // chat panel is mounted from a specific app surface (Brain / Studio /
      // Workflow / Doc / Chat / Approvals / Knowledge-base), pass
      // `?appOrigin=<surface>` to filter Recents to that surface plus the
      // unscoped (null app_origin) sessions that predate the migration.
      // Omitting the param returns everything — back-compat for callers that
      // don't know about the field. Keep in sync with the CHECK in
      // migration 255 + the KNOWN_ORIGINS set in chat.ts.
      const KNOWN_ORIGINS = ['brain', 'studio', 'workflow', 'doc', 'chat', 'approvals', 'knowledge-base'] as const
      const rawOrigin = typeof req.query.appOrigin === 'string' ? req.query.appOrigin : null
      const appOrigin = rawOrigin && (KNOWN_ORIGINS as readonly string[]).includes(rawOrigin) ? rawOrigin : null

      // Hide feed-web's single-thread surfaces from the main web sidebar:
      // post-drafting sessions (`mode='draft'`) and the sticky tuning /
      // per-draft-iteration channels documented in
      // docs/architecture/context-engine/session-messages.md → "Web
      // (sticky per-surface chat)". They're hydrated by their owning
      // surface via `/api/sessions/by-channel`, not by this list. A chat
      // started in apps/web — even against a `kind='app'` assistant — has
      // `mode IS NULL` and a UUID channel_id, so it remains visible after
      // refresh.
      const result = await query<{
        id: string; title: string | null; channelId: string;
        lastActiveAt: Date; status: string; appOrigin: string | null
      }>(
        `SELECT s.id, s.title, s.channel_id as "channelId",
                s.last_active_at as "lastActiveAt", s.status,
                s.app_origin as "appOrigin"
         FROM sessions s
         WHERE s.assistant_id = $1 AND s.user_id = $2
           -- Enumerations list only owner-scoped sessions. Workspace-shared
           -- rows (doc threads / drafts, migration 223) are reached by id
           -- via their surface, never by this list — the channel_type filter
           -- already excludes them, but the visibility predicate makes the
           -- intent explicit and survives future channel_type changes.
           AND s.visibility = 'owner'
           AND s.channel_type IN ('web', 'notification')
           AND s.mode IS DISTINCT FROM 'draft'
           AND s.channel_id <> 'tuning'
           AND s.channel_id NOT LIKE 'draft-iter:%'
           AND ($3::text IS NULL OR s.app_origin = $3 OR s.app_origin IS NULL)
         ORDER BY s.last_active_at DESC
         LIMIT 50`,
        [assistant.id, user.id, appOrigin],
      )

      res.json(result.rows.map((s) => ({
        id: s.id,
        title: s.title ?? 'New Chat',
        channelId: s.channelId,
        lastActive: s.lastActiveAt,
      })))
    } catch (err) {
      console.error('Sessions list error:', err)
      res.status(500).json({ error: 'Failed to load sessions' })
    }
  })

  /**
   * GET /api/sessions/by-channel?assistantId=X&channelId=Y[&channelType=web]
   *
   * Lookup an existing session by its identity tuple — does NOT create one.
   * Used by feed-web's tuning chat and per-draft iteration chat to resume
   * a sticky session when the surface is reopened. Returns 404 when the
   * tuple has never been used. Channel type defaults to 'web'.
   */
  router.get('/by-channel', async (req, res) => {
    try {
      const jwtUserId = (req as { userId?: string }).userId
      const user = await resolveUser(jwtUserId)
      if (!user) { res.status(404).json({ error: 'No session' }); return }

      const assistantId = req.query.assistantId as string | undefined
      const channelId = req.query.channelId as string | undefined
      const channelType = (req.query.channelType as string | undefined) ?? 'web'

      if (!assistantId || !channelId) {
        res.status(400).json({ error: 'Missing assistantId or channelId' })
        return
      }

      // Verify the user actually owns/has access to the assistant before
      // we leak any session ids. getUserAssistant returns null when the
      // user doesn't have access.
      const assistant = await getUserAssistant(user.id, assistantId)
      if (!assistant) { res.status(404).json({ error: 'No session' }); return }

      const session = await findSessionByChannel({
        assistantId: assistant.id,
        userId: user.id,
        channelType,
        channelId,
      })
      if (!session) { res.status(404).json({ error: 'No session' }); return }

      res.json({
        id: session.id,
        assistantId: session.assistantId,
        channelType: session.channelType,
        channelId: session.channelId,
        title: session.title,
        lastActive: session.lastActiveAt,
      })
    } catch (err) {
      console.error('Session by-channel error:', err)
      res.status(500).json({ error: 'Failed to lookup session' })
    }
  })

  /**
   * PATCH /api/sessions/:id — rename a session.
   * Body: { title: string }
   * Sets title_manually_set so the auto-titler doesn't overwrite it.
   */
  router.patch('/:id', async (req, res) => {
    try {
      const sessionId = req.params.id
      const { title } = req.body as { title?: string }

      if (!title || typeof title !== 'string') {
        res.status(400).json({ error: 'Missing title' })
        return
      }
      const trimmed = title.trim()
      if (trimmed.length === 0) {
        res.status(400).json({ error: 'Title cannot be empty' })
        return
      }
      if (trimmed.length > 200) {
        res.status(400).json({ error: 'Title too long (max 200 chars)' })
        return
      }

      // Verify ownership before allowing rename. Draft sessions are
      // team-shared, so we accept rename from the original starter OR any
      // team admin/owner of the assistant's team. Non-draft sessions stay
      // strictly per-user.
      // NOTE: `visibility='workspace'` doc-thread sessions (migration 223)
      // are READABLE by any workspace member, but rename/delete deliberately
      // stay owner-only — a teammate reading a thread is not license to
      // retitle or destroy it. Do NOT "unify" this onto the workspace RLS
      // gate: DELETE cascades to comment_threads + every comment.
      const sessionResult = await query<{
        id: string
        userId: string
        mode: string | null
        workspaceId: string | null
      }>(
        `SELECT s.id,
                s.user_id as "userId",
                s.mode,
                a.workspace_id as "workspaceId"
           FROM sessions s
           LEFT JOIN assistants a ON a.id = s.assistant_id
          WHERE s.id = $1`,
        [sessionId],
      )
      if (sessionResult.rows.length === 0) {
        res.status(404).json({ error: 'Session not found' })
        return
      }
      const session = sessionResult.rows[0]

      const jwtUserId = (req as { userId?: string }).userId
      let allowed = false
      if (jwtUserId) {
        if (session.userId === jwtUserId) {
          allowed = true
        } else if (session.mode === 'draft' && session.workspaceId) {
          const role = await getWorkspaceRoleSystem(jwtUserId, session.workspaceId)
          if (role === 'admin' || role === 'owner') allowed = true
        }
      } else {
        const { user: guestUser } = await findOrCreateUser({
          authProvider: 'web-guest',
          authProviderId: 'guest-local',
        })
        if (session.userId === guestUser.id) allowed = true
      }
      if (!allowed) {
        res.status(403).json({ error: 'Not your session' })
        return
      }

      await renameSession(sessionId, trimmed)
      res.json({ ok: true, title: trimmed })
    } catch (err) {
      console.error('Session rename error:', err)
      res.status(500).json({ error: 'Failed to rename session' })
    }
  })

  router.delete('/:id', async (req, res) => {
    try {
      const sessionId = req.params.id

      // 1. Verify session exists and get ownership info
      const sessionResult = await query<{
        id: string; userId: string; status: string; channelType: string
      }>(
        `SELECT id, user_id as "userId", status, channel_type as "channelType" FROM sessions WHERE id = $1`,
        [sessionId],
      )

      if (sessionResult.rows.length === 0) {
        res.status(404).json({ error: 'Session not found' })
        return
      }

      const session = sessionResult.rows[0]

      // 2. Verify ownership — session must belong to the requesting user.
      // Workspace-shared doc-thread sessions (migration 223) stay
      // delete-restricted to the creator by design (see the rename note
      // above): deletion cascades to the comment_threads row + all comments.
      const jwtUserId = (req as { userId?: string }).userId
      if (jwtUserId) {
        // Authenticated user — check session's user_id matches
        if (session.userId !== jwtUserId) {
          res.status(403).json({ error: 'Not your session' })
          return
        }
      } else {
        // Guest — verify session belongs to the guest user
        const { user: guestUser } = await findOrCreateUser({
          authProvider: 'web-guest',
          authProviderId: 'guest-local',
        })
        if (session.userId !== guestUser.id) {
          res.status(403).json({ error: 'Not your session' })
          return
        }
      }

      // 3. Block deleting a running session
      if (session.status === 'running') {
        res.status(409).json({ error: 'Cannot delete a session that is currently running. Try again in a moment.' })
        return
      }

      // 4. Delete the session. session_messages / tool_result_cache /
      // file_cache cascade. usage_tracking is intentionally PRESERVED: its
      // session_id FK is ON DELETE SET NULL (migration 253), so the billing /
      // credit / COGS ledger survives history deletion. Deleting it here (the
      // old "defense in depth") erased real cost and let anyone zero their
      // credit usage by clearing chat — and it's what made doc authoring
      // un-billable, since its transient sessions wiped their own per-turn
      // rows on cleanup. The credit derivation counts the now-orphaned
      // main_response rows. See cost-and-pricing.md → "Credit accounting".
      await query(`DELETE FROM sessions WHERE id = $1`, [sessionId])

      res.json({ ok: true })
    } catch (err) {
      console.error('Session delete error:', err)
      res.status(500).json({ error: 'Failed to delete session' })
    }
  })

  router.get('/:id/messages', async (req, res) => {
    try {
      const jwtUserId = (req as { userId?: string }).userId
      if (!jwtUserId) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }

      // Workspace-shared sessions need an explicit auth branch: the session's
      // user_id is the original starter, so a per-message history read for a
      // teammate would otherwise fail. `gateSessionRead` authorizes any
      // workspace member at/above the session's `effective_clearance` for a
      // `visibility='workspace'` (doc comment threads, migration 223) or
      // `mode='draft'` session; every other session stays owner-only. See
      // docs/plans/doc-brain-distillation.md → "Session model".
      const session = await findSessionById(req.params.id)
      if (!session) {
        res.status(404).json({ error: 'Session not found' })
        return
      }
      const denied = await gateSessionRead(jwtUserId, session)
      if (denied) {
        res.status(denied.status).json({ error: denied.error })
        return
      }

      const messages = await getSessionMessages(req.params.id)
      // Resolve sender profiles (name + avatar) so the client can attribute
      // *other* members' messages (a comment thread otherwise only knows the
      // current viewer's identity and renders a "?" avatar for everyone else).
      // One batched lookup; `users` RLS is own-row only, so this is a system
      // read — the membership/clearance gate above already authorized the
      // conversation.
      const profiles = await getUserProfilesByIds(
        messages
          .map((m) => m.senderUserId)
          .filter((id): id is string => Boolean(id)),
      )
      res.json(messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.createdAt,
        senderUserId: m.senderUserId,
        senderName: m.senderUserId ? profiles.get(m.senderUserId)?.name ?? null : null,
        senderAvatarUrl: m.senderUserId ? profiles.get(m.senderUserId)?.avatarUrl ?? null : null,
        // Outbound file attachments (sendFile, migration 273) — rendered
        // as file cards. Omitted when empty to keep the payload lean.
        attachments: m.attachments.length > 0 ? m.attachments : undefined,
      })))
    } catch (err) {
      console.error('Messages load error:', err)
      res.status(500).json({ error: 'Failed to load messages' })
    }
  })

  // GET /api/sessions/:id/stream — reconnect to an in-flight turn.
  //
  // A doc comment-reply turn runs to completion in the background after a page
  // refresh (the `doc_thread` carve-out in chat.ts), so a reloaded thread needs
  // to re-attach to the live reply. This endpoint emits the session's current
  // `status`; if it isn't `running` there's nothing in flight, so it sends
  // `done` and closes. While `running` it subscribes to the session turn bus and
  // forwards each `turn_stream` snapshot (the full reply-so-far + the running
  // tool's name) as a `snapshot` SSE frame, ending on `turn_completed`. A 5s
  // DB-status poll is the backstop finalizer for any missed completion signal
  // (a cross-instance turn end, a dropped NOTIFY). Same access gate as
  // `/:id/messages`. See docs/architecture/features/doc-comments.md → "Live
  // turn reconnect".
  router.get('/:id/stream', async (req, res) => {
    const jwtUserId = (req as { userId?: string }).userId
    if (!jwtUserId) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    const session = await findSessionById(req.params.id)
    if (!session) {
      res.status(404).json({ error: 'Session not found' })
      return
    }
    const denied = await gateSessionRead(jwtUserId, session)
    if (denied) {
      res.status(denied.status).json({ error: denied.error })
      return
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const send = (event: string, data: unknown) => {
      if (res.writableEnded) return
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    send('status', { status: session.status })

    // Nothing in flight — tell the client immediately so it stops showing a
    // "working…" state and closes the stream.
    if (session.status !== 'running') {
      send('done', {})
      res.end()
      return
    }

    let closed = false
    let unsubscribe: (() => void) | null = null
    let poll: NodeJS.Timeout | null = null
    const finalize = () => {
      if (closed) return
      closed = true
      if (poll) clearInterval(poll)
      unsubscribe?.()
      send('done', {})
      res.end()
    }

    unsubscribe = subscribeSessionEvents({
      sessionId: req.params.id,
      userId: jwtUserId,
      name: null,
      cb: (event: SessionEvent) => {
        if (event.kind === 'turn_stream') {
          send('snapshot', event.payload)
        } else if (event.kind === 'turn_completed') {
          finalize()
        }
      },
    })

    // Backstop: the bus event can be missed (a turn that ended on another
    // instance, a dropped NOTIFY). Poll the authoritative DB status so the
    // client never hangs on "working" past the turn. The stuck-session-sweeper
    // flips an abandoned turn to 'timeout', which is also caught here.
    poll = setInterval(() => {
      void findSessionById(req.params.id)
        .then((s) => {
          if (!s || s.status !== 'running') finalize()
        })
        .catch(() => {})
    }, 5_000)
    poll.unref?.()

    req.on('close', () => {
      if (closed) return
      closed = true
      if (poll) clearInterval(poll)
      unsubscribe?.()
    })
  })

  return router
}
