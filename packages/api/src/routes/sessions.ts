import { Router } from 'express'
import { findOrCreateUser, getDefaultAssistant, getUserAssistant, getUserProfilesByIds, getWorkspacePrimaryAssistant } from '../db/users.js'
import { addSessionMessage, createWorkspaceChatSession, findSessionByChannel, findSessionById, getSessionMessageById, getSessionMessages, isSharedChatSession, renameSession, updateSessionMessageText } from '../db/sessions.js'
import { query } from '../db/client.js'
import { resolveUser } from './route-helpers.js'
import { getWorkspaceRoleSystem, getWorkspaceMembershipWithClearanceSystem } from '../db/workspace-store.js'
import { canRead } from '@use-brian/core'
import {
  type GetSessionPresence,
  type PublishSessionEvent,
  type SessionEvent,
  type SetSessionTyping,
  type SubscribeSessionEvents,
  emptySessionPresence,
  noopPublishSessionEvent,
  noopSetSessionTyping,
  noopSubscribeSessionEvents,
} from '../session-event-port.js'
import {
  addSessionPin,
  listSessionPins,
  removeSessionPin,
  validateSessionPinPayload,
} from '../db/session-pins-store.js'
import { resolveSessionPinLabels } from '../resolve-session-pins.js'

/** A session whose read-access we gate (the subset of fields the gate reads). */
type GatedSession = {
  userId: string
  assistantId: string
  visibility: string | null
  mode: string | null
  effectiveClearance: string | null
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
 */
export async function gateSessionRead(
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
  /**
   * Live session-event bus publish — the room post path (`POST /:id/messages`)
   * emits `user_message_saved` here so every open viewer fans the post in
   * live (multiplayer chat T2). No-op when unset (unit tests).
   */
  publishSessionEvent?: PublishSessionEvent
  /**
   * Room ambient-capture hook (multiplayer chat P2): called fire-and-forget
   * with every accepted room post AFTER it is persisted + fanned out, so
   * silent teammate exchange reaches the brain-ingest pipeline. Absent = no
   * capture (unit tests; hosts that haven't wired the ingestor).
   */
  onRoomPost?: (input: {
    sessionId: string
    workspaceId: string
    assistantId: string
    senderUserId: string
    senderName: string | null
    text: string
    effectiveClearance: string | null
  }) => void
  /**
   * Room typing beacon (`POST /:id/typing`) — updates the viewer's presence
   * entry on the bus; the follow stream relays the resulting `presence`
   * events. No-op when unset (unit tests).
   */
  setSessionTyping?: SetSessionTyping
  /**
   * Presence snapshot for the follow stream's initial frame, so a viewer
   * joining a room sees who is already typing without waiting for the next
   * transition. Empty when unset.
   */
  getSessionPresence?: GetSessionPresence
}

/** Max characters accepted for one room post (text-only in P1 — T12). */
const ROOM_POST_MAX_CHARS = 32_000

export function sessionRoutes(opts: SessionRouteOptions = {}): Router {
  const subscribeSessionEvents = opts.subscribeSessionEvents ?? noopSubscribeSessionEvents
  const publishSessionEvent = opts.publishSessionEvent ?? noopPublishSessionEvent
  const setSessionTyping = opts.setSessionTyping ?? noopSetSessionTyping
  const getSessionPresence = opts.getSessionPresence ?? emptySessionPresence
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
        // The minting surface (or null pre-migration). The Chat app's rail
        // splits on it — chat-origin rows are "Chats", the rest are the
        // dock's ambient threads under "Other conversations".
        appOrigin: s.appOrigin,
      })))
    } catch (err) {
      console.error('Sessions list error:', err)
      res.status(500).json({ error: 'Failed to load sessions' })
    }
  })

  /**
   * GET /api/sessions/workspace?workspaceId=X — the Chat app's Workspace view.
   *
   * A SEPARATE query from the owner-scoped list above, deliberately. That
   * query's `visibility = 'owner'` filter is load-bearing (its comment explains
   * why) and relaxing it would leak every doc comment thread and feed draft
   * into everyone's recents. Shared chats are their own list with their own
   * predicate: `visibility='workspace' AND channel_type='web' AND
   * app_origin='chat'`, scoped to the workspace, clearance-filtered against
   * the caller's membership clearance, `last_active_at DESC`.
   *
   * A member below a session's clearance simply never sees the row — there is
   * no "you lack clearance" state, because the existence of the conversation
   * is itself the thing being withheld.
   *
   * Spec: docs/architecture/features/chat-app.md → "Workspace view".
   */
  router.get('/workspace', async (req, res) => {
    try {
      const jwtUserId = (req as { userId?: string }).userId
      const user = await resolveUser(jwtUserId)
      if (!user) { res.json([]); return }

      const workspaceId = req.query.workspaceId as string | undefined
      if (!workspaceId) {
        res.status(400).json({ error: 'Missing workspaceId' })
        return
      }

      // Membership + clearance in one read. Non-members get 403 rather than an
      // empty list: "you are not in this workspace" is not the same answer as
      // "this workspace has no shared chats", and conflating them makes a
      // broken workspace switch look like an empty feature.
      const membership = await getWorkspaceMembershipWithClearanceSystem(user.id, workspaceId)
      if (!membership) {
        res.status(403).json({ error: 'Not a member of this workspace' })
        return
      }

      const result = await query<{
        id: string; title: string | null; channelId: string
        lastActiveAt: Date; status: string
        starterUserId: string; effectiveClearance: string | null
        assistantId: string
      }>(
        `SELECT s.id, s.title, s.channel_id AS "channelId",
                s.last_active_at AS "lastActiveAt", s.status,
                s.user_id AS "starterUserId",
                s.effective_clearance AS "effectiveClearance",
                s.assistant_id AS "assistantId"
           FROM sessions s
           JOIN assistants a ON a.id = s.assistant_id
          WHERE a.workspace_id = $1
            AND s.visibility = 'workspace'
            AND s.channel_type = 'web'
            AND s.app_origin = 'chat'
          ORDER BY s.last_active_at DESC
          LIMIT 50`,
        [workspaceId],
      )

      // Clearance filter in JS rather than SQL: `sensitivity_rank` is a
      // domain rule that already lives in `canRead`, and duplicating the
      // ordering into a WHERE clause is how the two drift.
      const visible = result.rows.filter(
        (r) =>
          !r.effectiveClearance ||
          canRead(membership.clearance, r.effectiveClearance as 'public' | 'internal' | 'confidential'),
      )

      // Starter identity for the "Started by" chip. One batched lookup;
      // `users` RLS is own-row only, so this is a system read — membership
      // above already authorized seeing who is in this workspace.
      const profiles = await getUserProfilesByIds(visible.map((r) => r.starterUserId))
      res.json(visible.map((s) => ({
        id: s.id,
        title: s.title ?? 'New Chat',
        channelId: s.channelId,
        lastActive: s.lastActiveAt,
        status: s.status,
        startedByUserId: s.starterUserId,
        startedByName: profiles.get(s.starterUserId)?.name ?? null,
        startedByAvatarUrl: profiles.get(s.starterUserId)?.avatarUrl ?? null,
        // The room's bound assistant — the client's avatar / mention / Ask
        // labels resolve from it (rooms may bind any workspace assistant at
        // creation, not just the primary).
        assistantId: s.assistantId,
      })))
    } catch (err) {
      console.error('Workspace sessions list error:', err)
      res.status(500).json({ error: 'Failed to load workspace chats' })
    }
  })

  /**
   * POST /api/sessions/workspace — start a workspace-shared chat.
   * Body: { workspaceId: string }
   *
   * An explicit create (rather than a `shared: true` flag on the first
   * `POST /api/chat`) so the session exists — and is listable by teammates —
   * from the moment the user starts it, not from the moment they happen to
   * send their first message.
   *
   * Any workspace member may create one; the session's read floor is the
   * assistant's clearance, so a shared chat can never be more readable than
   * the assistant it runs on.
   */
  router.post('/workspace', async (req, res) => {
    try {
      const jwtUserId = (req as { userId?: string }).userId
      const user = await resolveUser(jwtUserId)
      if (!user) { res.status(401).json({ error: 'Unauthorized' }); return }

      const { workspaceId, assistantId } = req.body as {
        workspaceId?: string
        assistantId?: string
      }
      if (!workspaceId) {
        res.status(400).json({ error: 'Missing workspaceId' })
        return
      }

      // Which assistant the room binds to. The starter may pick ANY
      // workspace assistant at creation (the binding stays per-room for its
      // lifetime — per-turn multi-assistant routing is the separate P3
      // work); omitted → the workspace primary. `getUserAssistant` is the
      // access check; the workspace guard stops a stale client id from
      // binding another workspace's assistant into this room.
      // `getWorkspacePrimaryAssistant` is membership-checked, so the default
      // path is both "which assistant" and "may this user be here".
      let assistant: { id: string; workspaceId?: string | null } | null = null
      if (assistantId) {
        const candidate = await getUserAssistant(user.id, assistantId)
        if (!candidate || candidate.workspaceId !== workspaceId) {
          res.status(403).json({ error: 'Assistant not available in this workspace' })
          return
        }
        assistant = candidate
      } else {
        assistant = await getWorkspacePrimaryAssistant(user.id, workspaceId)
      }
      if (!assistant) {
        res.status(403).json({ error: 'Not a member of this workspace' })
        return
      }

      const clearanceRow = await query<{ clearance: string | null }>(
        `SELECT clearance FROM assistants WHERE id = $1`,
        [assistant.id],
      )

      const session = await createWorkspaceChatSession({
        assistantId: assistant.id,
        starterUserId: user.id,
        workspaceId,
        effectiveClearance: clearanceRow.rows[0]?.clearance ?? null,
      })

      res.status(201).json({
        id: session.id,
        title: session.title ?? 'New Chat',
        channelId: session.channelId,
        lastActive: session.lastActiveAt,
        status: session.status,
        startedByUserId: user.id,
        assistantId: session.assistantId,
      })
    } catch (err) {
      console.error('Workspace session create error:', err)
      res.status(500).json({ error: 'Failed to start a workspace chat' })
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

      // Verify ownership before allowing rename. Shared sessions are
      // team-shared, so we accept rename from the original starter OR any
      // team admin/owner of the assistant's team. Non-shared sessions stay
      // strictly per-user.
      // NOTE the asymmetry inside `visibility='workspace'` (migration 223).
      // A workspace-shared CHAT (`app_origin='chat'`) widens to
      // starter-or-admin, because a shared thread nobody but its starter can
      // retitle is a shared thread with a private owner. A doc COMMENT THREAD
      // does not: it is workspace-READABLE, but renaming or destroying it is
      // still the author's call, and DELETE cascades to `comment_threads` plus
      // every comment on it. That is why the predicate is
      // `isSharedChatSession`, not a bare `visibility` check — do NOT "unify"
      // them.
      const sessionResult = await query<{
        id: string
        userId: string
        mode: string | null
        visibility: string | null
        channelType: string
        appOrigin: string | null
        workspaceId: string | null
      }>(
        `SELECT s.id,
                s.user_id as "userId",
                s.mode,
                s.visibility,
                s.channel_type as "channelType",
                s.app_origin as "appOrigin",
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
        } else if (
          (session.mode === 'draft' || isSharedChatSession(session)) &&
          session.workspaceId
        ) {
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
        mode: string | null; visibility: string | null; appOrigin: string | null
        workspaceId: string | null
      }>(
        `SELECT s.id, s.user_id as "userId", s.status,
                s.channel_type as "channelType", s.mode, s.visibility,
                s.app_origin as "appOrigin",
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

      // 2. Verify ownership — session must belong to the requesting user, OR
      // be a workspace-shared CHAT the caller administers. Doc-thread sessions
      // stay delete-restricted to the creator by design (see the rename note
      // above): deletion cascades to the `comment_threads` row + all comments,
      // which is why this gates on `isSharedChatSession` and not `visibility`.
      const jwtUserId = (req as { userId?: string }).userId
      if (jwtUserId) {
        let allowed = session.userId === jwtUserId
        if (!allowed && isSharedChatSession(session) && session.workspaceId) {
          const role = await getWorkspaceRoleSystem(jwtUserId, session.workspaceId)
          allowed = role === 'admin' || role === 'owner'
        }
        if (!allowed) {
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
        // The answering assistant per reply (multi-assistant rooms, T9) —
        // the client resolves the avatar from its roster. Null on human rows
        // and pre-390 history (rendered as the session's bound assistant).
        senderAssistantId: m.senderAssistantId,
        // Outbound file attachments (sendFile, migration 273) — rendered
        // as file cards. Omitted when empty to keep the payload lean.
        attachments: m.attachments.length > 0 ? m.attachments : undefined,
      })))
    } catch (err) {
      console.error('Messages load error:', err)
      res.status(500).json({ error: 'Failed to load messages' })
    }
  })

  /**
   * POST /api/sessions/:id/messages — the room POST path (multiplayer chat
   * T2). Body: { message: string }.
   *
   * Persists ONE `role='user'` row with `sender_user_id`, emits
   * `user_message_saved` on the per-session bus so every open viewer fans the
   * post in live, and runs NO turn — posting is free (D2); the assistant
   * speaks only when addressed, via `POST /api/chat` (T3). Never busy-gated:
   * a post during a live turn is accepted and lands as a durable row the next
   * coalesced assembly reads (T4; rows-not-buffers keeps the §7 steering door
   * open).
   *
   * Shared chat sessions ONLY (`isSharedChatSession`) — a personal chat has
   * no silent-post semantics, and doc threads / feed drafts keep their own
   * lifecycle. Write access = read access (`gateSessionRead`): whoever can
   * read the room can post, attributed.
   */
  router.post('/:id/messages', async (req, res) => {
    try {
      const jwtUserId = (req as { userId?: string }).userId
      const user = await resolveUser(jwtUserId)
      if (!user) { res.status(401).json({ error: 'Unauthorized' }); return }

      const raw = (req.body as { message?: unknown })?.message
      const text = typeof raw === 'string' ? raw.trim() : ''
      if (!text) {
        res.status(400).json({ error: 'Missing message' })
        return
      }
      if (text.length > ROOM_POST_MAX_CHARS) {
        res.status(400).json({ error: 'Message too long' })
        return
      }

      const session = await findSessionById(req.params.id)
      if (!session) {
        res.status(404).json({ error: 'Session not found' })
        return
      }
      if (!isSharedChatSession(session)) {
        res.status(403).json({ error: 'Posting is only available in workspace chats' })
        return
      }
      const denied = await gateSessionRead(user.id, session)
      if (denied) {
        res.status(denied.status).json({ error: denied.error })
        return
      }

      const stored = await addSessionMessage({
        sessionId: session.id,
        role: 'user',
        content: [{ type: 'text', text }],
        senderUserId: user.id,
      })
      publishSessionEvent({
        kind: 'user_message_saved',
        sessionId: session.id,
        payload: {
          id: stored.id,
          sequenceNum: stored.sequenceNum,
          senderUserId: user.id,
          content: stored.content,
        },
      })

      // Ambient brain capture (P2) — fire-and-forget so a slow or failing
      // ingest path can never delay the post's 201. The hook resolves the
      // room's workspace itself when we can't cheaply provide it here.
      if (opts.onRoomPost) {
        const wsRow = await query<{ workspaceId: string | null }>(
          `SELECT workspace_id AS "workspaceId" FROM assistants WHERE id = $1`,
          [session.assistantId],
        ).catch(() => null)
        const workspaceId = wsRow?.rows[0]?.workspaceId
        if (workspaceId) {
          try {
            opts.onRoomPost({
              sessionId: session.id,
              workspaceId,
              assistantId: session.assistantId,
              senderUserId: user.id,
              senderName: user.name ?? null,
              text,
              effectiveClearance: session.effectiveClearance,
            })
          } catch (err) {
            console.error('[sessions] room post capture hook failed:', err)
          }
        }
      }

      res.status(201).json({
        id: stored.id,
        sequenceNum: stored.sequenceNum,
        timestamp: stored.createdAt,
      })
    } catch (err) {
      console.error('Room post error:', err)
      res.status(500).json({ error: 'Failed to post message' })
    }
  })

  /**
   * PATCH /api/sessions/:id/messages/:messageId — rewrite one of your own room
   * posts in place. Body: `{ message: string }`.
   *
   * The silent half of editing (the other half is `/api/chat` with
   * `truncateFromMessageId`, which destroys and regenerates because it needs a
   * turn). A post nobody was asked to answer is repaired where it stands: no
   * turn runs, the row keeps its id, its sequence and its attribution, and the
   * `user_message_saved` emit fans the new text to every open viewer through
   * the same refetch a new post triggers.
   *
   * Narrower than posting on purpose:
   * - **Your own row only.** Read access lets a member post into the room; it
   *   does not let them rewrite what a teammate said. `gateSessionRead` still
   *   runs first, so a non-member gets the room's own 403/404 either way.
   * - **Plain human text only.** A row carrying anything but text blocks (an
   *   assistant turn's `tool_use` chain, a message with attachments) would be
   *   FLATTENED by a text-block rewrite, so it is refused rather than
   *   silently reshaped.
   */
  router.patch('/:id/messages/:messageId', async (req, res) => {
    try {
      const jwtUserId = (req as { userId?: string }).userId
      const user = await resolveUser(jwtUserId)
      if (!user) { res.status(401).json({ error: 'Unauthorized' }); return }

      const raw = (req.body as { message?: unknown })?.message
      const text = typeof raw === 'string' ? raw.trim() : ''
      if (!text) {
        res.status(400).json({ error: 'Missing message' })
        return
      }
      if (text.length > ROOM_POST_MAX_CHARS) {
        res.status(400).json({ error: 'Message too long' })
        return
      }

      const session = await findSessionById(req.params.id)
      if (!session) {
        res.status(404).json({ error: 'Session not found' })
        return
      }
      if (!isSharedChatSession(session)) {
        res.status(403).json({ error: 'Editing is only available in workspace chats' })
        return
      }
      const denied = await gateSessionRead(user.id, session)
      if (denied) {
        res.status(denied.status).json({ error: denied.error })
        return
      }

      const existing = await getSessionMessageById(req.params.messageId)
      if (!existing || existing.sessionId !== session.id) {
        res.status(404).json({ error: 'Message not found' })
        return
      }
      if (existing.role !== 'user' || existing.senderUserId !== user.id) {
        res.status(403).json({ error: 'You can only edit your own messages' })
        return
      }
      const blocks = Array.isArray(existing.content) ? existing.content : null
      const isPlainText =
        !!blocks &&
        blocks.length > 0 &&
        blocks.every(
          (block) =>
            !!block &&
            typeof block === 'object' &&
            (block as { type?: unknown }).type === 'text',
        )
      if (!isPlainText || (existing.attachments?.length ?? 0) > 0) {
        res.status(409).json({ error: 'This message cannot be edited' })
        return
      }

      const updated = await updateSessionMessageText({
        messageId: existing.id,
        sessionId: session.id,
        text,
      })
      if (!updated) {
        res.status(404).json({ error: 'Message not found' })
        return
      }
      publishSessionEvent({
        kind: 'user_message_saved',
        sessionId: session.id,
        payload: {
          id: updated.id,
          sequenceNum: updated.sequenceNum,
          senderUserId: user.id,
          content: updated.content,
        },
      })

      res.json({
        id: updated.id,
        sequenceNum: updated.sequenceNum,
        timestamp: updated.createdAt,
      })
    } catch (err) {
      console.error('Room message edit error:', err)
      res.status(500).json({ error: 'Failed to edit message' })
    }
  })

  /**
   * POST /api/sessions/:id/typing — the room typing beacon. Body:
   * `{ isTyping: boolean }`.
   *
   * Presence is in-memory bus state, never a row: the beacon updates this
   * viewer's entry and the bus broadcasts a `presence` event on transitions
   * only (plus the staleness sweep), which the follow stream relays to every
   * open viewer. A beacon from a viewer with no live follow subscription is
   * a no-op by design. Rooms only — a personal chat has no second human to
   * signal — and the gate matches posting: whoever can read can signal.
   */
  router.post('/:id/typing', async (req, res) => {
    try {
      const jwtUserId = (req as { userId?: string }).userId
      if (!jwtUserId) { res.status(401).json({ error: 'Unauthorized' }); return }
      const session = await findSessionById(req.params.id)
      if (!session) { res.status(404).json({ error: 'Session not found' }); return }
      if (!isSharedChatSession(session)) {
        res.status(403).json({ error: 'Typing signals are only available in workspace chats' })
        return
      }
      const denied = await gateSessionRead(jwtUserId, session)
      if (denied) { res.status(denied.status).json({ error: denied.error }); return }
      setSessionTyping({
        sessionId: session.id,
        userId: jwtUserId,
        isTyping: (req.body as { isTyping?: unknown })?.isTyping === true,
      })
      res.status(204).end()
    } catch (err) {
      console.error('Room typing beacon error:', err)
      res.status(500).json({ error: 'Failed to update typing state' })
    }
  })

  // ── Room pins (multiplayer chat P1b, T14/D10) ──────────────────────
  //
  // Pins are the room's working frame — references to brain primitives,
  // URLs, and freeform instructions the assistant assembles inside every
  // turn (resolution + clearance live at assembly, `resolve-session-pins`).
  // Write access = post access (`gateSessionRead` on a shared chat), so
  // whoever can talk in the room can pin, attributed. Changes emit
  // `pins_changed` on the per-session bus so every viewer's chip row
  // refetches (signals, never data). Session-generic on the storage side;
  // shared chat sessions only at the route for now (the room surface is the
  // first renderer).

  const gatePinAccess = async (req: {
    userId?: string
    params: Record<string, string | string[] | undefined>
  }): Promise<
    | { ok: true; userId: string; sessionId: string }
    | { ok: false; status: number; error: string }
  > => {
    const jwtUserId = req.userId
    const user = await resolveUser(jwtUserId)
    if (!user) return { ok: false, status: 401, error: 'Unauthorized' }
    const session = await findSessionById(String(req.params.id ?? ''))
    if (!session) return { ok: false, status: 404, error: 'Session not found' }
    if (!isSharedChatSession(session)) {
      return { ok: false, status: 403, error: 'Pins are only available in workspace chats' }
    }
    const denied = await gateSessionRead(user.id, session)
    if (denied) return { ok: false, status: denied.status, error: denied.error }
    return { ok: true, userId: user.id, sessionId: session.id }
  }

  router.get('/:id/pins', async (req, res) => {
    try {
      const gate = await gatePinAccess(req)
      if (!gate.ok) { res.status(gate.status).json({ error: gate.error }); return }
      const pins = await listSessionPins(gate.sessionId)
      // Chip labels resolve under the SESSION's clearance ceiling — the read
      // gate already guarantees every reader is at/above it, so a label can
      // never out-leak the room. `null` label = unavailable chip state.
      const session = await findSessionById(gate.sessionId)
      const wsRow = await query<{ workspaceId: string | null }>(
        `SELECT workspace_id AS "workspaceId" FROM assistants WHERE id = $1`,
        [session?.assistantId],
      )
      const workspaceId = wsRow.rows[0]?.workspaceId
      const labels = workspaceId
        ? await resolveSessionPinLabels(pins, workspaceId, session?.effectiveClearance ?? null)
        : new Map<string, string | null>()
      const profiles = await getUserProfilesByIds(
        pins.map((p) => p.addedByUserId).filter((id): id is string => Boolean(id)),
      )
      // Assistant-added pins (migration 421) attribute by assistant name.
      const assistantIds = [...new Set(
        pins.map((p) => p.addedByAssistantId).filter((id): id is string => Boolean(id)),
      )]
      const assistantNames = new Map<string, string>()
      if (assistantIds.length > 0) {
        const rows = await query<{ id: string; name: string }>(
          `SELECT id, name FROM assistants WHERE id = ANY($1::uuid[])`,
          [assistantIds],
        )
        for (const row of rows.rows) assistantNames.set(row.id, row.name)
      }
      res.json(pins.map((p) => ({
        id: p.id,
        kind: p.kind,
        refId: p.refId,
        url: p.url,
        text: p.text,
        label: labels.get(p.id) ?? null,
        position: p.position,
        addedByUserId: p.addedByUserId,
        addedByAssistantId: p.addedByAssistantId,
        addedByName: p.addedByUserId
          ? profiles.get(p.addedByUserId)?.name ?? null
          : p.addedByAssistantId
            ? assistantNames.get(p.addedByAssistantId) ?? null
            : null,
        createdAt: p.createdAt,
      })))
    } catch (err) {
      console.error('Pins list error:', err)
      res.status(500).json({ error: 'Failed to load pins' })
    }
  })

  router.post('/:id/pins', async (req, res) => {
    try {
      const gate = await gatePinAccess(req)
      if (!gate.ok) { res.status(gate.status).json({ error: gate.error }); return }

      const body = req.body as { kind?: string; refId?: string; url?: string; text?: string }
      const payload = validateSessionPinPayload(body)
      if (!payload.ok) {
        res.status(400).json({ error: payload.error })
        return
      }

      const pin = await addSessionPin({
        sessionId: gate.sessionId,
        kind: payload.kind,
        refId: payload.refId,
        url: payload.url,
        text: payload.text,
        addedByUserId: gate.userId,
      })
      publishSessionEvent({
        kind: 'pins_changed',
        sessionId: gate.sessionId,
        payload: { byUserId: gate.userId },
      })
      res.status(201).json({ id: pin.id, kind: pin.kind, position: pin.position })
    } catch (err) {
      console.error('Pin add error:', err)
      res.status(500).json({ error: 'Failed to add pin' })
    }
  })

  router.delete('/:id/pins/:pinId', async (req, res) => {
    try {
      const gate = await gatePinAccess(req)
      if (!gate.ok) { res.status(gate.status).json({ error: gate.error }); return }
      const removed = await removeSessionPin(gate.sessionId, String(req.params.pinId))
      if (!removed) { res.status(404).json({ error: 'Pin not found' }); return }
      publishSessionEvent({
        kind: 'pins_changed',
        sessionId: gate.sessionId,
        payload: { byUserId: gate.userId },
      })
      res.json({ ok: true })
    } catch (err) {
      console.error('Pin remove error:', err)
      res.status(500).json({ error: 'Failed to remove pin' })
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
    // `no-transform` keeps compressing proxies (Next dev rewrites included)
    // from buffering the stream into one end-of-turn chunk.
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const send = (event: string, data: unknown) => {
      if (res.writableEnded) return
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    send('status', { status: session.status })

    // Workspace-shared chat sessions get FOLLOW mode (multiplayer chat T13):
    // the stream stays open regardless of turn state and relays the room's
    // live events — teammate posts (`user_message_saved`), committed turns
    // (`assistant_message_saved`), turn lifecycle (`turn_started` /
    // `turn_completed`), the throttled text/reasoning snapshot (`snapshot`),
    // the discrete activity mirror (`activity`: tool steps, research status,
    // pending tool confirmations). Events
    // are signals + capped data — the client refetches the persisted
    // transcript at settle. Clearance is already enforced by the
    // `gateSessionRead` above. A 25s comment ping defeats proxy idle
    // timeouts.
    if (isSharedChatSession(session)) {
      let closed = false
      // The viewer joins the room's presence set under their display name —
      // that name is what teammates' typing indicators render.
      const viewerName = await getUserProfilesByIds([jwtUserId])
        .then((profiles) => profiles.get(jwtUserId)?.name ?? null)
        .catch(() => null)
      // Who is already here (and possibly mid-typing) before the first
      // transition arrives. Sent before subscribing; the join emit that
      // follows updates every viewer, this one included.
      send('presence', { viewers: getSessionPresence(req.params.id) })
      const unsubscribeRoom = subscribeSessionEvents({
        sessionId: req.params.id,
        userId: jwtUserId,
        name: viewerName,
        cb: (event: SessionEvent) => {
          switch (event.kind) {
            case 'user_message_saved':
              send('user_message_saved', event.payload)
              break
            case 'assistant_message_saved':
              send('assistant_message_saved', event.payload)
              break
            case 'turn_started':
              send('turn_started', event.payload)
              break
            case 'turn_stream':
              send('snapshot', event.payload)
              break
            case 'turn_activity':
              send('activity', event.payload)
              break
            case 'turn_completed':
              send('turn_completed', event.payload)
              break
            case 'pins_changed':
              send('pins_changed', event.payload)
              break
            case 'presence':
              send('presence', event.payload)
              break
            default:
              break
          }
        },
      })
      const ping = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n')
      }, 25_000)
      ping.unref?.()
      req.on('close', () => {
        if (closed) return
        closed = true
        clearInterval(ping)
        unsubscribeRoom()
      })
      return
    }

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
