import type pg from 'pg'
import { query } from './client.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'

/**
 * Store-seam emitter for the `session` workspace primitive (Live roster —
 * docs/architecture/features/live-work.md §4). Fired ONLY at the turn
 * lifecycle seams (`updateSessionStatus`, `releaseTurnLease`,
 * `reclaimStaleTurn`, `sweepStuckSessions`) — never per token, never per
 * heartbeat touch; the 2s coalescer folds bursts per (workspace,
 * primitive). Resolves the workspace through the owning assistant the way
 * `job-store.ts#notifyJobChange` does; a personal (non-workspace)
 * assistant resolves to null and `notifyWorkspaceChange` drops it, so
 * personal-assistant sessions never signal a workspace. Fire-and-forget:
 * the write path must never feel a NOTIFY failure.
 */
function notifySessionChange(sessionId: string): void {
  void (async () => {
    const r = await query<{ workspaceId: string | null }>(
      `SELECT a.workspace_id AS "workspaceId"
         FROM sessions s
         JOIN assistants a ON a.id = s.assistant_id
        WHERE s.id = $1`,
      [sessionId],
    )
    notifyWorkspaceChange(r.rows[0]?.workspaceId, 'session', 'update', sessionId)
  })().catch(() => {})
}

export type Session = {
  id: string
  assistantId: string
  userId: string
  channelType: string
  channelId: string
  appId: string
  /**
   * Which app surface the session was created from (`brain`, `studio`,
   * `workflow`, `doc`, `chat`). Null for sessions older than
   * migration 187 — treated by the UI as "visible across all surfaces"
   * so old recents don't disappear from any surface's Recents list.
   */
  appOrigin: string | null
  status: string
  compactSummary: string | null
  compactionCount: number
  /**
   * sequence_num of the most recent compaction boundary in this session's
   * session_messages, or null if the session has never been compacted.
   * Loaders pass this to getSessionMessages({ fromSequence }) to skip the
   * already-compacted head on subsequent turns.
   */
  compactBoundarySequence: number | null
  title: string | null
  /**
   * True once the "Running on the standard model — usage limit reached"
   * downgrade notice has been delivered for this session. Cleared when the
   * budget returns to ok. See `markDowngradeNoticeSent` / `clearDowngradeNotice`.
   */
  downgradeNoticeSent: boolean
  /**
   * Channel-native message id of the pinned downgrade notice (Telegram only).
   * Other channels store null — they send the notice but don't pin.
   */
  downgradeNoticePinMessageId: string | null
  /**
   * Explicit session purpose. `'draft'` opts the session into the
   * draft-cardboard UX (proposeDrafts tool injection, system prompt
   * addendum, draft-sessions list filter). `null` is the default for
   * tuning chat and platform-channel sessions. Replaced the legacy
   * `channel_id LIKE 'draft:%'` discriminator (migration 098).
   */
  mode: string | null
  /**
   * Read scope (migration 223). `'owner'` (default) → only the session's
   * `user_id` can read it (sessions_own RLS). `'workspace'` → any member of
   * the owning assistant's workspace can read it (sessions_workspace_shared
   * RLS) — used for doc comment-thread sessions and feed draft sessions.
   */
  visibility: string
  /**
   * Denormalized read-clearance (migration 224) = the owning assistant's
   * clearance, for `visibility='workspace'` sessions. Backs the clearance
   * predicate in `sessions_workspace_shared` and the GET /:id/messages route
   * check. NULL for owner-scoped sessions.
   */
  effectiveClearance: string | null
  /** Immutable Team/Project binding for this conversation (migration 473). */
  contextGroupId: string | null
  contextProjectId: string | null
  contextCompartments: string[]
  contextLockedAt: Date | null
  createdAt: Date
  lastActiveAt: Date
}

export type SessionMessage = {
  id: string
  sessionId: string
  role: string
  content: unknown // JSONB
  sequenceNum: number
  createdAt: Date
  replyToText: string | null
  topicLabel: string | null
  topicConfidence: number | null
  channelMessageId: string | null
  /**
   * Per-message author. Set by the chat route on every append for
   * `sessions.mode='draft'` sessions so team-shared draft UIs can render
   * "alice asked, bob refined" attribution. NULL for non-draft sessions
   * and for rows older than migration 101.
   */
  senderUserId: string | null
  /**
   * The answering ASSISTANT per assistant row (migration 390 — the
   * assistant-side twin of `sender_user_id`). Multi-assistant rooms
   * (multiplayer chat T9) render per-reply avatars from it and label
   * foreign-assistant turns at assembly. NULL for human rows and rows
   * predating the migration (treated as the session's bound assistant).
   */
  senderAssistantId: string | null
  /**
   * Outbound file attachments on assistant messages (migration 273, the
   * `sendFile` tool). Soft references to `workspace_files` rows — rendered
   * as file cards on web; informational parity on messaging rows. `[]` for
   * everything else.
   */
  attachments: SessionMessageAttachment[]
}

/** One outbound attachment — mirrors `OutboundAttachment` in @use-brian/core. */
export type SessionMessageAttachment = {
  fileId: string
  workspaceId: string
  path: string
  name: string
  mime: string
  sizeBytes: number
  caption?: string
}

/** The fields the shared-session predicates read. */
type SessionShape = {
  visibility: string | null
  channelType: string
  appOrigin: string | null
  mode: string | null
}

/**
 * A workspace-shared **chat** session — the Chat app's Workspace view.
 *
 * Narrower than `visibility === 'workspace'` on purpose. Doc comment threads
 * and feed drafts are also workspace-visible, and they have their own
 * lifecycle rules that must not be widened by accident: deleting a doc-thread
 * session cascades to its `comment_threads` row and every comment on it. Every
 * rule this build relaxes (delete by admin, the busy gate, the workspace list)
 * gates on THIS predicate, not on `visibility` alone.
 *
 * See docs/architecture/features/chat-app.md → "Workspace view".
 */
export function isSharedChatSession(s: SessionShape): boolean {
  return (
    s.visibility === 'workspace' &&
    s.channelType === 'web' &&
    s.appOrigin === 'chat'
  )
}

/**
 * A session several humans share, so the model needs speaker labels to tell
 * "the user" apart: shared chats, feed drafts, and doc comment threads.
 */
export function isMultiParticipantSession(s: SessionShape): boolean {
  return (
    isSharedChatSession(s) ||
    s.mode === 'draft' ||
    s.channelType === 'doc_thread'
  )
}

/** Storage-only delimiter for a Slack thread-qualified session channel id. */
export const SLACK_THREAD_SESSION_DELIMITER = ':thread:'

/**
 * Turn a provider Slack channel + root `thread_ts` into the conversation id
 * stored on `sessions.channel_id`. A missing root preserves the legacy
 * channel-level session used when the integration does not reply in threads.
 *
 * Slack API calls must keep using the base channel id plus a separate
 * `thread_ts`; this encoded id is only for Brian's session-scoped state.
 */
export function buildSlackSessionChannelId(
  channelId: string,
  threadTs?: string | null,
): string {
  return threadTs
    ? `${channelId}${SLACK_THREAD_SESSION_DELIMITER}${threadTs}`
    : channelId
}

/** Convert a stored session conversation id back to a provider destination. */
export function providerChannelIdFromSession(
  channelType: string,
  sessionChannelId: string,
): string {
  if (channelType !== 'slack') return sessionChannelId
  const delimiterIndex = sessionChannelId.indexOf(SLACK_THREAD_SESSION_DELIMITER)
  return delimiterIndex === -1
    ? sessionChannelId
    : sessionChannelId.slice(0, delimiterIndex)
}

/**
 * Create a workspace-shared chat session (the Chat app's "New workspace chat").
 *
 * Uses the existing `visibility` switch with **no schema change** — the
 * starter is the `user_id` owner row and other members address the session
 * **by id**, so the `(assistant_id, user_id, channel_type, channel_id, app_id)`
 * unique key is untouched. This is the doc-comment-thread insert shape
 * (`comment-thread-store.ts`), which sets all three of `visibility`,
 * `workspace_id` and `effective_clearance` — miss one and the RLS predicate
 * or the clearance filter silently excludes the row.
 */
export async function createWorkspaceChatSession(params: {
  assistantId: string
  starterUserId: string
  workspaceId: string
  /** The owning assistant's clearance — the session's read floor. */
  effectiveClearance: string | null
  contextGroupId?: string | null
  contextProjectId?: string | null
}): Promise<Session> {
  return findOrCreateSession({
    assistantId: params.assistantId,
    userId: params.starterUserId,
    channelType: 'web',
    // A fresh UUID, so the identity tuple is unique and the upsert always
    // inserts — "New workspace chat" starts a new thread, never resumes one.
    channelId: crypto.randomUUID(),
    appOrigin: 'chat',
    visibility: 'workspace',
    workspaceId: params.workspaceId,
    effectiveClearance: params.effectiveClearance,
    ...(params.contextGroupId !== undefined
      ? { contextGroupId: params.contextGroupId }
      : {}),
    ...(params.contextProjectId !== undefined
      ? { contextProjectId: params.contextProjectId }
      : {}),
  })
}

/**
 * Find or create a session for the given tuple.
 * Updates lastActiveAt on access.
 */
export async function findOrCreateSession(params: {
  assistantId: string
  userId: string
  channelType: string
  channelId: string
  appId?: string
  /**
   * UI surface the session was created from. Persisted on first
   * insert; the ON CONFLICT branch deliberately does NOT update this
   * column so a session keeps its original surface when reopened
   * elsewhere. Accepted values: brain | studio | workflow | doc |
   * chat. Null when omitted (visible everywhere).
   */
  appOrigin?: string | null
  /**
   * Read scope (migration 223). Omit → DB default `'owner'`. Pass
   * `'workspace'` for sessions that back a workspace artifact (doc
   * comment threads). The ON CONFLICT branch deliberately does NOT update
   * it — visibility is fixed at first insert, like `app_origin`.
   */
  visibility?: 'owner' | 'workspace'
  /**
   * Denormalized workspace pointer that backs the `sessions_workspace_shared`
   * RLS policy (migration 223). Required for `visibility:'workspace'` sessions
   * so a teammate read resolves; omit (→ NULL) for owner-scoped sessions. Set
   * once at insert; the ON CONFLICT branch does not update it. Never read back
   * onto the `Session` object — it exists only for the RLS gate.
   */
  workspaceId?: string | null
  /**
   * Denormalized read-clearance (migration 224) = the owning assistant's
   * clearance. Set for `visibility:'workspace'` sessions so the clearance gate
   * resolves; omit (→ NULL) otherwise. Fixed at insert.
   */
  effectiveClearance?: string | null
  /** Context is fixed on insert; the first message locks it in the database. */
  contextGroupId?: string | null
  contextProjectId?: string | null
  contextCompartments?: string[]
}): Promise<Session> {
  const appId = params.appId ?? 'Use Brian'
  const appOrigin = params.appOrigin ?? null
  const visibility = params.visibility ?? 'owner'
  const workspaceId = params.workspaceId ?? null
  const effectiveClearance = params.effectiveClearance ?? null
  const inheritAssistantGroup = params.contextGroupId === undefined
  const inheritAssistantProject = params.contextProjectId === undefined
  const contextGroupId = params.contextGroupId ?? null
  const contextProjectId = params.contextProjectId ?? null
  const contextCompartments = params.contextCompartments ?? null

  const result = await query<Session>(
    `INSERT INTO sessions (
       assistant_id, user_id, channel_type, channel_id, app_id, app_origin,
       visibility, workspace_id, effective_clearance, context_group_id,
       context_project_id, context_compartments
     )
     SELECT $1, $2, $3, $4, $5, $6, $7,
            COALESCE($8::uuid, a.workspace_id), $9,
            selected.context_group_id, selected.context_project_id,
            CASE
              WHEN $12::text[] IS NOT NULL THEN $12::text[]
              WHEN g.compartment_key IS NOT NULL THEN ARRAY[g.compartment_key]::text[]
              ELSE ARRAY[]::text[]
            END
       FROM assistants a
       CROSS JOIN LATERAL (
         SELECT CASE WHEN $13::boolean THEN a.default_workspace_group_id ELSE $10::uuid END AS context_group_id,
                CASE WHEN $14::boolean THEN a.default_project_id ELSE $11::uuid END AS context_project_id
       ) selected
       LEFT JOIN workspace_groups g ON g.id = selected.context_group_id
      WHERE a.id = $1
     ON CONFLICT (assistant_id, user_id, channel_type, channel_id, app_id) DO UPDATE
       SET last_active_at = now()
     RETURNING id, assistant_id as "assistantId", user_id as "userId",
               channel_type as "channelType", channel_id as "channelId",
               app_id as "appId", app_origin as "appOrigin", status, compact_summary as "compactSummary",
               compaction_count as "compactionCount",
               compact_boundary_sequence as "compactBoundarySequence", title,
               downgrade_notice_sent as "downgradeNoticeSent",
               downgrade_notice_pin_message_id as "downgradeNoticePinMessageId",
               mode, visibility, effective_clearance as "effectiveClearance",
               context_group_id as "contextGroupId",
               context_project_id as "contextProjectId",
               context_compartments as "contextCompartments",
               context_locked_at as "contextLockedAt",
               created_at as "createdAt", last_active_at as "lastActiveAt"`,
    [
      params.assistantId,
      params.userId,
      params.channelType,
      params.channelId,
      appId,
      appOrigin,
      visibility,
      workspaceId,
      effectiveClearance,
      contextGroupId,
      contextProjectId,
      contextCompartments,
      inheritAssistantGroup,
      inheritAssistantProject,
    ],
  )

  return result.rows[0]
}

/**
 * Read-only lookup by the session's identity tuple. Returns null when
 * no row exists — callers MUST NOT auto-create. Used by GET-only paths
 * (history endpoints, etc.) where `findOrCreateSession` would mint a
 * row on read and pollute the table.
 */
export async function findSessionByChannel(params: {
  assistantId: string
  userId: string
  channelType: string
  channelId: string
  appId?: string
}): Promise<Session | null> {
  const appId = params.appId ?? 'Use Brian'
  const result = await query<Session>(
    `SELECT id, assistant_id as "assistantId", user_id as "userId",
            channel_type as "channelType", channel_id as "channelId",
            app_id as "appId", app_origin as "appOrigin", status, compact_summary as "compactSummary",
            compaction_count as "compactionCount",
            compact_boundary_sequence as "compactBoundarySequence", title,
            downgrade_notice_sent as "downgradeNoticeSent",
            downgrade_notice_pin_message_id as "downgradeNoticePinMessageId",
            mode, visibility, effective_clearance as "effectiveClearance",
            context_group_id as "contextGroupId",
            context_project_id as "contextProjectId",
            context_compartments as "contextCompartments",
            context_locked_at as "contextLockedAt",
            created_at as "createdAt", last_active_at as "lastActiveAt"
     FROM sessions
     WHERE assistant_id = $1 AND user_id = $2 AND channel_type = $3
       AND channel_id = $4 AND app_id = $5`,
    [params.assistantId, params.userId, params.channelType, params.channelId, appId],
  )
  return result.rows[0] ?? null
}

/**
 * Brain-inspection ephemeral session — spawned by the inbox "Ask
 * about this" affordance.
 *
 * Marked `transient=true` so it stays out of the sidebar; pinned to
 * `channel_type='brain_inspection'` and a UUID `channel_id` so the
 * sidebar's `channel_type IN ('web', 'notification')` filter ignores
 * it naturally. The session runs against the user's primary
 * assistant (caller resolves) with a tool registry filtered to
 * inspection + brain-read tools — see
 * [`docs/architecture/brain/corrections.md`](../../../../docs/architecture/brain/corrections.md)
 * §"Ephemeral chat session".
 *
 * Always creates a fresh session per call (no upsert) because each
 * inbox-item Ask is a one-off deliberation — reusing prior
 * inspection sessions would conflate distinct decisions.
 *
 * System-level — caller enforces workspace membership + auth.
 */
export async function createInspectionSession(params: {
  primaryAssistantId: string
  userId: string
  appId?: string
}): Promise<Session> {
  // Fresh UUID per call: each Ask thread is an unrelated deliberation.
  return createTransientBrainSession({
    primaryAssistantId: params.primaryAssistantId,
    userId: params.userId,
    appId: params.appId,
    channelType: 'brain_inspection',
    channelId: crypto.randomUUID(),
  })
}

/**
 * Brain-entry editing session. The channel id is the immutable server-bound
 * target for this transient conversation; any model-supplied target must
 * match it exactly. A superseding apply rotates the client to a fresh session
 * for the live row while preserving the temporary transcript in local UI state.
 */
export async function createBrainEditSession(params: {
  primaryAssistantId: string
  userId: string
  primitive: string
  rowId: string
  appId?: string
}): Promise<Session> {
  return createTransientBrainSession({
    primaryAssistantId: params.primaryAssistantId,
    userId: params.userId,
    appId: params.appId,
    channelType: 'brain_edit',
    channelId: `${params.primitive}:${params.rowId}:${crypto.randomUUID()}`,
  })
}

async function createTransientBrainSession(params: {
  primaryAssistantId: string
  userId: string
  appId?: string
  channelType: 'brain_inspection' | 'brain_edit'
  channelId: string
}): Promise<Session> {
  const result = await query<Session>(
    `INSERT INTO sessions (
       assistant_id, user_id, channel_type, channel_id, app_id, transient,
       workspace_id, context_group_id, context_project_id, context_compartments
     )
     SELECT a.id, $2, $3, $4, $5, TRUE, a.workspace_id,
            a.default_workspace_group_id, a.default_project_id,
            CASE WHEN g.compartment_key IS NULL THEN ARRAY[]::text[]
                 ELSE ARRAY[g.compartment_key]::text[] END
       FROM assistants a
       LEFT JOIN workspace_groups g ON g.id = a.default_workspace_group_id
      WHERE a.id = $1
     RETURNING id, assistant_id as "assistantId", user_id as "userId",
               channel_type as "channelType", channel_id as "channelId",
               app_id as "appId", app_origin as "appOrigin", status, compact_summary as "compactSummary",
               compaction_count as "compactionCount",
               compact_boundary_sequence as "compactBoundarySequence", title,
               downgrade_notice_sent as "downgradeNoticeSent",
               downgrade_notice_pin_message_id as "downgradeNoticePinMessageId",
               mode, visibility, effective_clearance as "effectiveClearance",
               context_group_id as "contextGroupId",
               context_project_id as "contextProjectId",
               context_compartments as "contextCompartments",
               context_locked_at as "contextLockedAt",
               created_at as "createdAt", last_active_at as "lastActiveAt"`,
    [
      params.primaryAssistantId,
      params.userId,
      params.channelType,
      params.channelId,
      params.appId ?? 'Use Brian',
    ],
  )
  return result.rows[0]
}

/**
 * Find a session by its primary key ID.
 */
export async function findSessionById(id: string): Promise<Session | null> {
  const result = await query<Session>(
    `SELECT id, assistant_id as "assistantId", user_id as "userId",
            channel_type as "channelType", channel_id as "channelId",
            app_id as "appId", app_origin as "appOrigin", status, compact_summary as "compactSummary",
            compaction_count as "compactionCount",
            compact_boundary_sequence as "compactBoundarySequence", title,
            downgrade_notice_sent as "downgradeNoticeSent",
            downgrade_notice_pin_message_id as "downgradeNoticePinMessageId",
            mode, visibility, effective_clearance as "effectiveClearance",
            context_group_id as "contextGroupId",
            context_project_id as "contextProjectId",
            context_compartments as "contextCompartments",
            context_locked_at as "contextLockedAt",
            created_at as "createdAt", last_active_at as "lastActiveAt"
     FROM sessions WHERE id = $1`,
    [id],
  )
  if (result.rows.length === 0) return null
  // Touch last_active_at.
  //
  // NOTE: this is a *read* that writes the recency column, and that is
  // deliberate — `last_active_at` orders the session rail, where "someone
  // looked at it" counts as activity. It is also exactly why turn liveness
  // must NOT live here: a client polling an open room refreshes this column
  // forever, which is how the 2026-08-08 stuck room defeated the 6-minute
  // sweeper for ~31 minutes. Liveness has its own column that only the
  // running turn writes (`turn_heartbeat_at`, migration 424). Never move the
  // sweep predicate back onto `last_active_at`.
  await query(`UPDATE sessions SET last_active_at = now() WHERE id = $1`, [id])
  return result.rows[0]
}

/**
 * Record that the downgrade reminder has been delivered for this session.
 * `pinMessageId` is the channel-native message id of the pinned notice
 * (Telegram only). Other channels pass null.
 */
export async function markDowngradeNoticeSent(
  sessionId: string,
  pinMessageId: string | null,
): Promise<void> {
  await query(
    `UPDATE sessions
     SET downgrade_notice_sent = true,
         downgrade_notice_pin_message_id = $1
     WHERE id = $2`,
    [pinMessageId, sessionId],
  )
}

/**
 * Clear the downgrade reminder state. Called when the budget returns to ok
 * so the next overage re-arms the notice.
 */
export async function clearDowngradeNotice(sessionId: string): Promise<void> {
  await query(
    `UPDATE sessions
     SET downgrade_notice_sent = false,
         downgrade_notice_pin_message_id = NULL
     WHERE id = $1`,
    [sessionId],
  )
}

/**
 * Update session status.
 */
export async function updateSessionStatus(sessionId: string, status: string): Promise<void> {
  await query(
    `UPDATE sessions SET status = $1, last_active_at = now() WHERE id = $2`,
    [status, sessionId],
  )
  notifySessionChange(sessionId)
}

// ── Turn lease (migration 424) ────────────────────────────────────────────
//
// `sessions.status='running'` is a lock. Before migration 424 it had no owner
// and no lease: the chat route released it on the happy path and in the catch,
// and any exit reaching neither pinned the session forever. The sweeper that
// was supposed to rescue it keyed staleness off `last_active_at`, which
// `findSessionById` refreshes on every READ, so a client watching the session
// held the backstop off indefinitely (2026-08-08: ~31 minutes).
//
// The lease fixes both halves. `turn_heartbeat_at` is written only by the
// running turn, so no read can refresh it; `turn_lease_token` says who holds
// the lock, so an orphan cannot disturb its successor.
//
// Spec: docs/architecture/context-engine/session-messages.md
//       → "Turn lease and recovery".

/** How often a running turn refreshes its lease. */
export const TURN_HEARTBEAT_INTERVAL_MS = 20_000

/**
 * How long a lease survives without a heartbeat before it may be reclaimed.
 * 4.5x the heartbeat, so a live turn under load or GC pause is never stolen.
 * Unlike the old `last_active_at` threshold this need NOT clear Cloud Run's
 * 300s request cap: a turn running past the cap keeps heartbeating (the
 * interval is independent of the request), and one that stopped heartbeating
 * is dead regardless of how long its request was allowed to be.
 */
export const TURN_LEASE_STALE_AFTER_MS = 90_000

/** Why a turn's lock was released. Persisted so a heal can explain itself. */
export type TurnEndReason =
  | 'completed'
  | 'stopped_by_user'
  | 'stalled_reclaimed'
  | 'timeout'

/**
 * Take the lease for a turn that has just claimed `status='running'`. Returns
 * the token every later lease operation must present. Clears any stale cancel
 * request and end reason left by the previous turn.
 */
export async function startTurnLease(sessionId: string): Promise<string> {
  const result = await query<{ turn_lease_token: string }>(
    `UPDATE sessions
        SET turn_lease_token = gen_random_uuid(),
            turn_heartbeat_at = now(),
            cancel_requested_at = NULL,
            turn_end_reason = NULL
      WHERE id = $1
      RETURNING turn_lease_token`,
    [sessionId],
  )
  const token = result.rows[0]?.turn_lease_token
  if (!token) throw new Error(`startTurnLease: session ${sessionId} not found`)
  return token
}

/**
 * One heartbeat tick. Refreshes the lease AND reports whether a stop was
 * requested, in a single statement — that is how a stop reaches a turn running
 * in another process without a bus round-trip.
 *
 * `held: false` means the lease is no longer ours (reclaimed as stale, or
 * released). The caller must abort: continuing would let an orphan turn write
 * a reply into a session another turn now owns.
 */
export async function touchTurnLease(
  sessionId: string,
  token: string,
): Promise<{ held: boolean; cancelRequested: boolean }> {
  const result = await query<{ cancel_requested_at: Date | null }>(
    `UPDATE sessions
        SET turn_heartbeat_at = now()
      WHERE id = $1 AND turn_lease_token = $2 AND status = 'running'
      RETURNING cancel_requested_at`,
    [sessionId, token],
  )
  const row = result.rows[0]
  if (!row) return { held: false, cancelRequested: false }
  return { held: true, cancelRequested: row.cancel_requested_at !== null }
}

/**
 * Ask the turn holding this session's lock to stop. Picked up by the holder's
 * next heartbeat tick (<= `TURN_HEARTBEAT_INTERVAL_MS`) when it runs in another
 * process; the same-process path aborts its `AbortController` directly and does
 * not wait for this. No-op when nothing is running.
 */
export async function requestTurnCancel(sessionId: string): Promise<boolean> {
  const result = await query(
    `UPDATE sessions
        SET cancel_requested_at = now()
      WHERE id = $1 AND status = 'running'`,
    [sessionId],
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * Resting status for a released lock. A clean end (finished, or a human who
 * chose to stop it) rests at `idle`; an abnormal end rests at `timeout`, which
 * blocks nothing but preserves the debugging signal that this turn did not end
 * the way it was supposed to.
 */
function restingStatusFor(reason: TurnEndReason): 'idle' | 'timeout' {
  return reason === 'completed' || reason === 'stopped_by_user' ? 'idle' : 'timeout'
}

/**
 * Release the lock, recording why. Token-guarded: a turn whose lease was
 * already reclaimed must not flip a SUCCESSOR turn back to idle. Pass
 * `token: null` for an administrative release (the stop route), which releases
 * whoever holds it.
 */
export async function releaseTurnLease(
  sessionId: string,
  reason: TurnEndReason,
  token: string | null,
): Promise<boolean> {
  const result = await query(
    `UPDATE sessions
        SET status = $1,
            turn_lease_token = NULL,
            turn_heartbeat_at = NULL,
            cancel_requested_at = NULL,
            turn_end_reason = $2,
            last_active_at = now()
      WHERE id = $3
        AND status = 'running'
        ${token === null ? '' : 'AND turn_lease_token = $4'}`,
    token === null
      ? [restingStatusFor(reason), reason, sessionId]
      : [restingStatusFor(reason), reason, sessionId, token],
  )
  const released = (result.rowCount ?? 0) > 0
  if (released) notifySessionChange(sessionId)
  return released
}

/**
 * On-demand heal: reclaim this session's lock if, and only if, its lease has
 * gone stale. Returns true when the caller now owns nothing (the lock is free)
 * — the caller re-claims normally afterwards.
 *
 * This is the fastest of the three recovery paths: a user's own next message
 * repairs the session instead of queueing behind a lock nobody holds. The
 * sweeper (<= `TURN_LEASE_STALE_AFTER_MS` + its tick) covers the case where
 * nobody sends anything, and the stop route covers the impatient case.
 *
 * A NULL heartbeat is a pre-migration-424 row: fall back to `last_active_at`
 * so those still recover, accepting that reads refresh it.
 */
export async function reclaimStaleTurn(
  sessionId: string,
  staleAfterMs: number = TURN_LEASE_STALE_AFTER_MS,
): Promise<boolean> {
  const result = await query(
    `UPDATE sessions
        SET status = 'timeout',
            turn_lease_token = NULL,
            turn_heartbeat_at = NULL,
            cancel_requested_at = NULL,
            turn_end_reason = 'stalled_reclaimed'
      WHERE id = $1
        AND status = 'running'
        AND COALESCE(turn_heartbeat_at, last_active_at)
              < now() - ($2 || ' milliseconds')::interval`,
    [sessionId, String(staleAfterMs)],
  )
  const reclaimed = (result.rowCount ?? 0) > 0
  if (reclaimed) notifySessionChange(sessionId)
  return reclaimed
}

/**
 * Is a turn PROVABLY alive on this session right now? True only when the row
 * is `running`, holds a lease token, and that lease was heartbeaten within
 * `staleAfterMs`. This is the admission-time proof of life the ordinary chat
 * path needs before it may take the slot: a client's `midTurn` flag says
 * whether ITS stream is open, not whether the turn is; a client whose stream
 * was cut (proxy idle timeout, reload, second tab) sends an ordinary turn
 * while the previous one is still working, and blind-claiming the slot then
 * mints a new lease and the live turn aborts itself as an "orphan" at its next
 * heartbeat (2026-08-18: page builds killed 30-90s in, three times in one
 * session). A pre-migration-424 row (NULL heartbeat) is never "live" here, so
 * legacy rows keep the old behaviour; a stale lease is not live either - the
 * caller reclaims it (`reclaimStaleTurn`) and proceeds.
 */
export async function isTurnLeaseLive(
  sessionId: string,
  staleAfterMs: number = TURN_LEASE_STALE_AFTER_MS,
): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM sessions
      WHERE id = $1
        AND status = 'running'
        AND turn_lease_token IS NOT NULL
        AND turn_heartbeat_at >= now() - ($2 || ' milliseconds')::interval`,
    [sessionId, String(staleAfterMs)],
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * Reset every session whose `status='running'` lease has gone stale to
 * `status='timeout'`. Returns the rows that were touched so callers can emit
 * per-session telemetry / bus events.
 *
 * Staleness is the LEASE (`turn_heartbeat_at`), never `last_active_at` — see
 * the block comment above and `findSessionById`. `COALESCE` keeps
 * pre-migration-424 rows sweepable.
 *
 * See `packages/api/src/scheduling/stuck-session-sweeper.ts` and
 * `docs/architecture/context-engine/session-messages.md` →
 * "Turn lease and recovery".
 */
export async function sweepStuckSessions(
  staleAfterMs: number,
): Promise<Array<{ id: string; mode: string | null; userId: string; visibility: string }>> {
  const result = await query<{
    id: string
    mode: string | null
    user_id: string
    visibility: string
  }>(
    `UPDATE sessions
        SET status = 'timeout',
            turn_lease_token = NULL,
            turn_heartbeat_at = NULL,
            cancel_requested_at = NULL,
            turn_end_reason = 'stalled_reclaimed',
            last_active_at = now()
      WHERE status = 'running'
        AND COALESCE(turn_heartbeat_at, last_active_at)
              < now() - ($1 || ' milliseconds')::interval
      RETURNING id, mode, user_id, visibility`,
    [String(staleAfterMs)],
  )
  // Per-row emission: the coalescer folds a multi-workspace sweep into one
  // signal per (workspace, primitive) anyway.
  for (const r of result.rows) notifySessionChange(r.id)
  return result.rows.map((r) => ({
    id: r.id,
    mode: r.mode,
    userId: r.user_id,
    visibility: r.visibility,
  }))
}

/**
 * Atomically write the compact summary text, advance the boundary cursor,
 * and bump compaction_count. The UPDATE is gated on the expected current
 * cursor value so two turns racing to compact the same session don't
 * clobber each other — the loser sees rowCount === 0 and must discard its
 * summary + reload.
 *
 * `newCursor` is the sequence_num of the FIRST recent (non-compactable)
 * row, matching the loader's inclusive `fromSequence` semantics.
 * `expectedCurrentCursor` is the `compact_boundary_sequence` value the
 * caller read at the start of the turn (null = never compacted).
 *
 * Returns true when the row was updated, false when the guard failed
 * (concurrent compaction landed first).
 */
export async function setCompactSummaryAndBoundary(
  sessionId: string,
  summary: string,
  newCursor: number,
  expectedCurrentCursor: number | null,
): Promise<boolean> {
  const result = await query(
    `UPDATE sessions
     SET compact_summary = $1,
         compact_boundary_sequence = $2,
         compaction_count = compaction_count + 1,
         last_compacted_at = now()
     WHERE id = $3
       AND compact_boundary_sequence IS NOT DISTINCT FROM $4`,
    [summary, newCursor, sessionId, expectedCurrentCursor],
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * Auto-update a session title (from the LLM auto-titler). Skips sessions
 * that have been manually renamed by the user so we never overwrite their
 * choice.
 *
 * Returns true if the title was actually written.
 */
export async function updateSessionTitle(sessionId: string, title: string): Promise<boolean> {
  const result = await query(
    `UPDATE sessions
     SET title = $1
     WHERE id = $2 AND title_manually_set = false`,
    [title, sessionId],
  )
  return (result.rowCount ?? 0) > 0
}

/**
 * Manually rename a session. Sets the title_manually_set flag so the
 * auto-titler stops touching it.
 */
export async function renameSession(sessionId: string, title: string): Promise<void> {
  await query(
    `UPDATE sessions SET title = $1, title_manually_set = true WHERE id = $2`,
    [title, sessionId],
  )
}

/**
 * Repoint a workspace room at another assistant — its DEFAULT voice from the
 * next turn on (`PATCH /api/sessions/:id/assistant`).
 *
 * Only `assistant_id` moves. `effective_clearance` is deliberately NOT
 * recomputed: it is the room's read floor, fixed at creation, and the route
 * only admits an assistant that already satisfies it
 * (`mayAssistantAnswerInRoom`). Lowering it would retroactively widen the
 * audience of a transcript written under a higher bar; raising it would evict
 * members from a room they have already read. Neither is wanted, and neither
 * is needed — see docs/architecture/features/chat-app.md → "Choosing an
 * assistant".
 *
 * Authorization is the caller's (`gateSessionRead` + the workspace/clearance
 * checks in the route); this is the dumb write.
 */
export async function rebindSessionAssistant(
  sessionId: string,
  assistantId: string,
): Promise<void> {
  await query(
    `UPDATE sessions SET assistant_id = $1 WHERE id = $2`,
    [assistantId, sessionId],
  )
}

/**
 * Count user+assistant turns in a session (for auto-titling triggers).
 */
export async function countSessionTurns(sessionId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM session_messages WHERE session_id = $1 AND role IN ('user', 'assistant')`,
    [sessionId],
  )
  return parseInt(result.rows[0]?.count ?? '0')
}

/**
 * Get messages for a session, ordered by sequence number.
 *
 * `fromSequence` is inclusive (returns rows with sequence_num >= N) and is
 * the cursor used by the compaction path to skip already-compacted history.
 * `afterSequence` is exclusive (sequence_num > N) and predates the cursor.
 * Prefer `fromSequence` for new code.
 */
export async function getSessionMessages(
  sessionId: string,
  opts?: { limit?: number; afterSequence?: number; fromSequence?: number | null },
): Promise<SessionMessage[]> {
  const conditions = ['session_id = $1']
  const values: unknown[] = [sessionId]
  let paramIdx = 2

  if (opts?.afterSequence !== undefined) {
    conditions.push(`sequence_num > $${paramIdx}`)
    values.push(opts.afterSequence)
    paramIdx++
  }

  if (opts?.fromSequence !== undefined && opts.fromSequence !== null) {
    conditions.push(`sequence_num >= $${paramIdx}`)
    values.push(opts.fromSequence)
    paramIdx++
  }

  const limitClause = opts?.limit ? `LIMIT $${paramIdx}` : ''
  if (opts?.limit) values.push(opts.limit)

  const result = await query<SessionMessage>(
    `SELECT id, session_id as "sessionId", role, content,
            sequence_num as "sequenceNum", created_at as "createdAt",
            reply_to_text as "replyToText",
            topic_label as "topicLabel",
            topic_confidence as "topicConfidence",
            channel_message_id as "channelMessageId",
            sender_user_id as "senderUserId",
            sender_assistant_id as "senderAssistantId",
            attachments
     FROM session_messages WHERE ${conditions.join(' AND ')}
     ORDER BY sequence_num ASC ${limitClause}`,
    values,
  )

  return result.rows
}

/** One stored message, by id. */
export async function getSessionMessageById(
  messageId: string,
): Promise<SessionMessage | null> {
  const result = await query<SessionMessage>(
    `SELECT id, session_id as "sessionId", role, content,
            sequence_num as "sequenceNum", created_at as "createdAt",
            reply_to_text as "replyToText",
            topic_label as "topicLabel",
            topic_confidence as "topicConfidence",
            channel_message_id as "channelMessageId",
            sender_user_id as "senderUserId",
            sender_assistant_id as "senderAssistantId",
            attachments
     FROM session_messages WHERE id = $1`,
    [messageId],
  )
  return result.rows[0] ?? null
}

/**
 * Rewrite the text of one stored message, in place.
 *
 * Deliberately narrow: it replaces `content` wholesale with a single text
 * block, which is the exact shape a room post is written in. The caller
 * authorizes the edit AND verifies the row is that shape — an assistant turn's
 * `tool_use` chain or a message carrying attachments must never be flattened
 * into a text block by an edit.
 */
export async function updateSessionMessageText(params: {
  messageId: string
  sessionId: string
  text: string
}): Promise<SessionMessage | null> {
  const result = await query<SessionMessage>(
    `UPDATE session_messages
        SET content = $3
      WHERE id = $1 AND session_id = $2
     RETURNING id, session_id as "sessionId", role, content,
               sequence_num as "sequenceNum", created_at as "createdAt",
               reply_to_text as "replyToText",
               topic_label as "topicLabel",
               topic_confidence as "topicConfidence",
               channel_message_id as "channelMessageId",
               sender_user_id as "senderUserId",
               sender_assistant_id as "senderAssistantId",
               attachments`,
    [params.messageId, params.sessionId, JSON.stringify([{ type: 'text', text: params.text }])],
  )
  return result.rows[0] ?? null
}

/**
 * Map DB session messages to LLM Message format, prepending a compact
 * timestamp to user messages so the model always knows when each message
 * was sent. Uses the DB's `created_at` (actual arrival time), not the
 * current time. Only modifies the in-memory representation — stored
 * content stays clean for UI display.
 *
 * Format: `[Wed, Apr 15, 12:33 PM HKT] ` — compact, includes day-of-week.
 *
 * **Speaker attribution.** In a multi-participant session (a workspace-shared
 * chat, a feed draft, a doc comment thread) "the user" is several people, and
 * a reply that cannot tell them apart is wrong in a way the transcript cannot
 * show. Pass `senderNames` (a `sender_user_id` → display-name map) and each
 * human turn is labelled `[stamp] Alice: …`. This is the SAME seam as the
 * timestamp, and for the same reason: the label is assembly-time only, so
 * `session_messages.content` stays clean and turning the feature off does not
 * leave name prefixes baked into history. Omit the map (every personal
 * session) and nothing changes.
 */
export function toStampedMessages(
  dbMessages: SessionMessage[],
  timezone: string,
  senderNames?: ReadonlyMap<string, string>,
  /**
   * Multi-assistant rooms (T9): label FOREIGN assistant turns. When a room
   * turn runs as assistant X, any assistant row answered by a different
   * assistant gets a `[Name]:` prefix at assembly — the model must never
   * mistake another assistant's words for its own. Same seam and reason as
   * the human stamp: assembly-time only, stored content stays clean. Rows
   * with a NULL `sender_assistant_id` (legacy, single-voice sessions) are
   * left untouched.
   */
  assistantVoices?: {
    names: ReadonlyMap<string, string>
    currentAssistantId: string
  },
): Array<{ role: 'user' | 'assistant' | 'system'; content: unknown }> {
  return dbMessages.map((m) => {
    const base = {
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
    }
    if (
      m.role === 'assistant' &&
      assistantVoices &&
      m.senderAssistantId &&
      m.senderAssistantId !== assistantVoices.currentAssistantId &&
      Array.isArray(m.content)
    ) {
      const name = assistantVoices.names.get(m.senderAssistantId)
      if (name) {
        const content = m.content as Array<{ type?: string; text?: string }>
        for (let i = 0; i < content.length; i++) {
          const block = content[i]
          if (block.type === 'text' && typeof block.text === 'string') {
            return {
              ...base,
              content: [
                ...content.slice(0, i),
                { ...block, text: `[${name}]: ${block.text}` },
                ...content.slice(i + 1),
              ],
            }
          }
        }
      }
      return base
    }
    if (m.role !== 'user' || !Array.isArray(m.content)) return base

    const stamp = m.createdAt.toLocaleString('en-US', {
      timeZone: timezone || 'UTC',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    })
    const speaker =
      m.senderUserId && senderNames?.get(m.senderUserId)
        ? ` ${senderNames.get(m.senderUserId)}:`
        : ''
    const prefix = `[${stamp}]${speaker}`

    // Find the first text block and prepend the timestamp
    const content = m.content as Array<{ type?: string; text?: string }>
    for (let i = 0; i < content.length; i++) {
      const block = content[i]
      if (block.type === 'text' && typeof block.text === 'string') {
        return {
          ...base,
          content: [
            ...content.slice(0, i),
            { ...block, text: `${prefix} ${block.text}` },
            ...content.slice(i + 1),
          ],
        }
      }
    }
    // No text block — prepend one with just the timestamp
    return {
      ...base,
      content: [{ type: 'text', text: prefix }, ...content],
    }
  })
}

/**
 * Coalescing cap (multiplayer chat T12): a merge group keeps its most recent
 * N user rows; older rows collapse into one "earlier messages omitted" line.
 * Normal compaction owns long-session history — this only bounds one
 * assembled turn.
 */
export const COALESCE_MAX_MERGED_ROWS = 100

/**
 * Merge CONSECUTIVE plain user messages into one user turn (multiplayer chat
 * T4). The provider wire contract is strict `(user, assistant)` alternation,
 * and a room accumulates one user ROW per post (T2) — so at assembly time
 * every run of adjacent user messages must collapse into a single user turn
 * whose content carries each post as its own (already stamped + attributed)
 * text block. Lives beside `toStampedMessages` because it is the same seam:
 * assembly-time only, stored rows stay untouched.
 *
 * Scope rules:
 *  - Only PLAIN user messages merge (string or block content with no
 *    `tool_result`). A tool_result-bearing user row is a pairing carrier
 *    (query-loop tool-pairing invariant) and both breaks the group and stays
 *    untouched.
 *  - Applies to ANY consecutive-user-row history, not just rooms — an aborted
 *    or errored turn can leave consecutive user rows in a personal session
 *    too (the pre-existing edge this also fixes).
 *  - A group longer than `maxMerged` keeps its most recent `maxMerged` rows
 *    and prepends one omission note (T12; `omittedNote` carries the copy so
 *    this stays i18n-free at the db layer).
 */
export function coalesceConsecutiveUserMessages<
  M extends { role: string; content: unknown },
>(
  messages: M[],
  opts?: { maxMerged?: number; omittedNote?: string },
): M[] {
  const maxMerged = opts?.maxMerged ?? COALESCE_MAX_MERGED_ROWS
  const omittedNote = opts?.omittedNote ?? '[Earlier messages omitted]'

  const isPlainUser = (m: M): boolean => {
    if (m.role !== 'user') return false
    if (typeof m.content === 'string') return true
    if (!Array.isArray(m.content)) return false
    return !m.content.some(
      (b: { type?: string }) => b?.type === 'tool_result',
    )
  }
  const toBlocks = (content: unknown): Array<Record<string, unknown>> =>
    typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : (content as Array<Record<string, unknown>>)

  const out: M[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!isPlainUser(m)) {
      out.push(m)
      continue
    }
    // Collect the full run of adjacent plain user messages.
    let j = i
    while (j + 1 < messages.length && isPlainUser(messages[j + 1])) j++
    if (j === i) {
      out.push(m)
      continue
    }
    let group = messages.slice(i, j + 1)
    let omitted = 0
    if (group.length > maxMerged) {
      omitted = group.length - maxMerged
      group = group.slice(omitted)
    }
    const blocks = group.flatMap((g) => toBlocks(g.content))
    out.push({
      ...m,
      content: [
        ...(omitted > 0 ? [{ type: 'text', text: omittedNote }] : []),
        ...blocks,
      ],
    })
    i = j
  }
  return out
}

/**
 * Append a message to a session. Auto-increments sequence_num.
 *
 * Optional fields:
 * - replyToText:       snapshot text of the message being replied to, if any
 * - topicLabel:        normalized topic label from the classifier
 * - topicConfidence:   0..1 classifier confidence
 * - channelMessageId:  channel-native ID of this message (Telegram, Slack, Feishu/Lark, WhatsApp)
 * - senderUserId:      per-message author. Set for `mode='draft'` sessions so
 *                      team-shared UIs can render per-turn attribution.
 */
export async function addSessionMessage(params: {
  sessionId: string
  role: string
  content: unknown
  replyToText?: string | null
  topicLabel?: string | null
  topicConfidence?: number | null
  channelMessageId?: string | null
  senderUserId?: string | null
  /** The answering assistant (assistant rows in multi-assistant rooms — T9). */
  senderAssistantId?: string | null
  /** Outbound file attachments (assistant rows only — `sendFile`, migration 273). */
  attachments?: SessionMessageAttachment[]
}, client?: Pick<pg.ClientBase, 'query'>): Promise<SessionMessage> {
  const sql =
    `INSERT INTO session_messages
       (session_id, role, content, sequence_num,
        reply_to_text, topic_label, topic_confidence, channel_message_id, sender_user_id, sender_assistant_id, attachments)
     VALUES ($1, $2, $3,
       COALESCE((SELECT MAX(sequence_num) FROM session_messages WHERE session_id = $1), 0) + 1,
       $4, $5, $6, $7, $8, $9, $10
     )
     RETURNING id, session_id as "sessionId", role, content,
               sequence_num as "sequenceNum", created_at as "createdAt",
               reply_to_text as "replyToText",
               topic_label as "topicLabel",
               topic_confidence as "topicConfidence",
               channel_message_id as "channelMessageId",
               sender_user_id as "senderUserId",
               sender_assistant_id as "senderAssistantId",
               attachments`
  const values = [
      params.sessionId,
      params.role,
      JSON.stringify(params.content),
      params.replyToText ?? null,
      params.topicLabel ?? null,
      params.topicConfidence ?? null,
      params.channelMessageId ?? null,
      params.senderUserId ?? null,
      params.senderAssistantId ?? null,
      JSON.stringify(params.attachments ?? []),
    ]
  const result = client
    ? await client.query<SessionMessage>(sql, values)
    : await query<SessionMessage>(sql, values)

  return result.rows[0]
}

/**
 * Fetch distinct non-null topic labels for a session, newest first.
 * Used by the topic classifier to detect `resume` (returning to a topic
 * discussed earlier in the session but not in the previous turn).
 */
export async function getSessionTopicLabels(sessionId: string, limit = 20): Promise<string[]> {
  const result = await query<{ topicLabel: string }>(
    `SELECT DISTINCT ON (topic_label) topic_label as "topicLabel"
     FROM session_messages
     WHERE session_id = $1 AND topic_label IS NOT NULL
     ORDER BY topic_label, sequence_num DESC
     LIMIT $2`,
    [sessionId, limit],
  )
  return result.rows.map((r) => r.topicLabel)
}

/**
 * Locate a session message by the channel-native triple
 * (channel_type, provider channel_id, channel_message_id). Used by the
 * Slack `reaction_added` and Telegram `message_reaction` handlers to
 * route an emoji reaction back to the assistant turn it referred to.
 * Slack's reaction payload omits the parent thread timestamp, so its base
 * channel id also matches thread-qualified session ids under that channel.
 *
 * Returns the session_message row + session row (for the workspace
 * scope the feedback writer needs). Returns `null` if no row matches
 * — common when the reacted-to message predates the channel-id
 * round-trip plumbing, or when the reactor reacts to a non-bot
 * message.
 *
 * Performance note: this lookup is NOT indexed on
 * `channel_message_id` alone today — the existing partial index is
 * `(session_id, channel_message_id)`. For v1 reaction throughput
 * (occasional events, not per-turn) a sequential scan is acceptable;
 * if reaction volume grows, add an index on
 * `(channel_message_id) WHERE channel_message_id IS NOT NULL`.
 */
export async function findSessionMessageByChannelTriple(
  channelType: string,
  channelId: string,
  channelMessageId: string,
): Promise<{
  messageId: string
  sessionId: string
  assistantId: string
  workspaceId: string | null
} | null> {
  const result = await query<{
    messageId: string
    sessionId: string
    assistantId: string
    workspaceId: string | null
  }>(
    `SELECT sm.id        AS "messageId",
            sm.session_id AS "sessionId",
            s.assistant_id AS "assistantId",
            a.workspace_id AS "workspaceId"
     FROM session_messages sm
     JOIN sessions s ON s.id = sm.session_id
     JOIN assistants a ON a.id = s.assistant_id
     WHERE s.channel_type = $1
       AND (
         s.channel_id = $2
         OR (
           s.channel_type = 'slack'
           AND s.channel_id LIKE $2 || ':thread:%'
         )
       )
       AND sm.channel_message_id = $3
       AND sm.role = 'assistant'
     LIMIT 1`,
    [channelType, channelId, channelMessageId],
  )
  return result.rows[0] ?? null
}

/**
 * Stamp the channel-native ID onto a previously-inserted message.
 *
 * Outgoing assistant turns are persisted by the channel pipeline
 * BEFORE the adapter actually delivers them — the adapter returns
 * the channel-native id (Slack `ts`, Telegram/Feishu-Lark `message_id`) only
 * after sending. This helper closes that gap so reaction handlers
 * can later look the row up via `findSessionMessageByChannelId` and
 * route feedback to the correct memory-recall events. Best-effort:
 * if the row no longer exists (truncate-on-retry, race), this is
 * a no-op rather than an error.
 *
 * No-ops when `channelMessageId` is empty or null.
 *
 * Spec: docs/architecture/brain/corrections.md → "Emoji reactions
 * as feedback signal" — the channel-id round-trip.
 */
export async function setSessionMessageChannelId(
  sessionMessageId: string,
  channelMessageId: string | null | undefined,
): Promise<void> {
  if (!channelMessageId) return
  await query(
    `UPDATE session_messages
       SET channel_message_id = $2
     WHERE id = $1
       AND channel_message_id IS NULL`,
    [sessionMessageId, channelMessageId],
  )
}

/**
 * Lookup a session message's text by its channel-native ID. Used by
 * resolveReplyText for Slack (thread_ts) and WhatsApp (quotedMessageId)
 * where the webhook hands us the channel-native ID but not the text.
 *
 * Returns null if no match.
 */
export async function findSessionMessageByChannelId(
  sessionId: string,
  channelMessageId: string,
): Promise<SessionMessage | null> {
  const result = await query<SessionMessage>(
    `SELECT id, session_id as "sessionId", role, content,
            sequence_num as "sequenceNum", created_at as "createdAt",
            reply_to_text as "replyToText",
            topic_label as "topicLabel",
            topic_confidence as "topicConfidence",
            channel_message_id as "channelMessageId",
            sender_user_id as "senderUserId"
     FROM session_messages
     WHERE session_id = $1 AND channel_message_id = $2
     LIMIT 1`,
    [sessionId, channelMessageId],
  )
  return result.rows[0] ?? null
}

/**
 * Find the visible Slack message carrying one exact provider timestamp across
 * the bare-channel and thread-qualified session shapes. This is deliberately
 * narrower than a transcript search: it is the compatibility fallback for a
 * session-key cutover where the current thread session cannot resolve its root
 * but an older session stored that same Slack message id.
 *
 * The lookup stays bound to the current assistant and bare Slack channel. It
 * never accepts a model-provided target and never returns neighbouring rows
 * from the legacy channel-wide session (which could belong to another thread).
 */
export async function findSlackVisibleMessageByChannelId(params: {
  assistantId: string
  channelId: string
  channelMessageId: string
}): Promise<Pick<SessionMessage, 'role' | 'content' | 'channelMessageId'> | null> {
  const result = await query<Pick<SessionMessage, 'role' | 'content' | 'channelMessageId'>>(
    `SELECT sm.role, sm.content,
            sm.channel_message_id as "channelMessageId"
     FROM session_messages sm
     JOIN sessions s ON s.id = sm.session_id
     WHERE s.assistant_id = $1
       AND s.channel_type = 'slack'
       AND (
         s.channel_id = $2
         OR s.channel_id LIKE $2 || ':thread:%'
       )
       AND sm.channel_message_id = $3
     ORDER BY sm.created_at DESC
     LIMIT 1`,
    [params.assistantId, params.channelId, params.channelMessageId],
  )
  return result.rows[0] ?? null
}

/**
 * Delete a message and all subsequent messages in the session
 * (by sequence_num). Used for retry/edit — destroy-and-regenerate semantics.
 *
 * Returns the deleted messages so the caller can log them to analytics
 * (preserving the signal that a retry/edit happened).
 */
export async function truncateMessagesFrom(
  messageId: string,
  expectedSessionId?: string,
): Promise<{
  deleted: number
  sessionId: string | null
  deletedMessages: SessionMessage[]
}> {
  // Find the message to get session + sequence
  const info = await query<{ sessionId: string; sequenceNum: number }>(
    `SELECT session_id as "sessionId", sequence_num as "sequenceNum"
     FROM session_messages WHERE id = $1`,
    [messageId],
  )
  if (info.rows.length === 0) return { deleted: 0, sessionId: null, deletedMessages: [] }

  const { sessionId, sequenceNum } = info.rows[0]

  // This primitive resolves the session FROM the message id, so a leaked
  // message id from another session could delete that session's history.
  // When the caller names the session it believes it is truncating, refuse a
  // message that lives in a different session (treated as not-found). WS3
  // cross-session chat-deletion fix, 2026-07-07 — the public-API twin already
  // guards this at the route; this makes the primitive safe by construction.
  if (expectedSessionId != null && sessionId !== expectedSessionId) {
    return { deleted: 0, sessionId: null, deletedMessages: [] }
  }

  // Capture what we're about to delete
  const deletedMessages = await query<SessionMessage>(
    `SELECT id, session_id as "sessionId", role, content,
            sequence_num as "sequenceNum", created_at as "createdAt",
            reply_to_text as "replyToText",
            topic_label as "topicLabel",
            topic_confidence as "topicConfidence",
            channel_message_id as "channelMessageId",
            sender_user_id as "senderUserId"
     FROM session_messages
     WHERE session_id = $1 AND sequence_num >= $2
     ORDER BY sequence_num ASC`,
    [sessionId, sequenceNum],
  )

  const result = await query(
    `DELETE FROM session_messages
     WHERE session_id = $1 AND sequence_num >= $2`,
    [sessionId, sequenceNum],
  )

  return {
    deleted: result.rowCount ?? 0,
    sessionId,
    deletedMessages: deletedMessages.rows,
  }
}

/**
 * Fetch recent messages across ALL sessions in a group chat channel.
 * Used to give the bot awareness of the full channel conversation when
 * each user has an isolated session. Returns messages in chronological order.
 */
export async function getGroupChatContext(params: {
  assistantId: string
  channelType: string
  channelId: string
  limit?: number
}): Promise<Array<{ role: string; content: unknown; userId: string; createdAt: Date }>> {
  const limit = params.limit ?? 30
  const result = await query<{ role: string; content: unknown; userId: string; createdAt: Date }>(
    `SELECT sm.role, sm.content, s.user_id as "userId", sm.created_at as "createdAt"
     FROM session_messages sm
     JOIN sessions s ON sm.session_id = s.id
     WHERE s.assistant_id = $1
       AND s.channel_type = $2
       AND s.channel_id = $3
     ORDER BY sm.created_at DESC
     LIMIT $4`,
    [params.assistantId, params.channelType, params.channelId, limit],
  )
  // Reverse to chronological order (query returns newest first)
  return result.rows.reverse()
}

/**
 * Format group chat messages into a system prompt context section.
 * Extracts text from content blocks and labels messages by role.
 */
export function buildGroupChatContextPrompt(
  messages: Array<{ role: string; content: unknown; userId: string; createdAt: Date }>,
  currentUserId: string,
): string {
  if (messages.length === 0) return ''

  function extractText(content: unknown): string {
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text)
        .join(' ')
    }
    return '(non-text content)'
  }

  const lines = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const text = extractText(m.content)
      if (!text.trim()) return null
      if (m.role === 'assistant') return `You (assistant): ${text}`
      const label = m.userId === currentUserId ? 'Current user' : 'Another user'
      return `${label}: ${text}`
    })
    .filter(Boolean)

  if (lines.length === 0) return ''

  return `# Recent channel conversation\n\nThe following is the recent conversation in this group chat channel. Multiple users may be participating. Use this to understand the full context of what was said, including your own previous replies to other users.\n\n${lines.join('\n')}`
}

/**
 * Find the user's most-active messaging channel.
 * Returns the channel_type and provider delivery channel id of the session
 * with the most recent activity, excluding 'web' and 'cron' sessions. A
 * thread-qualified Slack session is normalized back to its base channel;
 * scheduled delivery expresses threading separately.
 * Returns null if the user has never used a messaging channel.
 */
export async function getPreferredChannel(
  assistantId: string,
  userId: string,
): Promise<{ channelType: string; channelId: string } | null> {
  const result = await query<{ channelType: string; channelId: string }>(
    `SELECT channel_type as "channelType", channel_id as "channelId"
     FROM sessions
     WHERE assistant_id = $1 AND user_id = $2
       AND channel_type IN ('telegram', 'slack', 'whatsapp', 'custom', 'feishu')
       AND channel_id NOT IN ('notifications', 'default')
       AND (channel_type != 'whatsapp' OR channel_id LIKE '%@%')
     ORDER BY last_active_at DESC
     LIMIT 1`,
    [assistantId, userId],
  )
  const row = result.rows[0]
  return row
    ? { ...row, channelId: providerChannelIdFromSession(row.channelType, row.channelId) }
    : null
}

// ── Introspection: workspace session history (audit §6-a) ────────────
//
// Backs the `listWorkspaceSessions` / `readSessionTranscript` introspection
// tools (SessionHistoryIntrospectionPort in @use-brian/core). The workspace
// primary may read the workspace's assistants' transcripts. Both reads scope
// via the `assistants.workspace_id = $1` join — which structurally EXCLUDES
// other members' personal assistants (their `workspace_id` is NULL or a
// different workspace), the §6-a workspace boundary. These are system reads
// (no RLS userId): the passed workspace + the join are the only bound. See
// docs/architecture/engine/introspection-tools.md → "Session history".

/** One session-list row for the introspection tool (assistant name joined). */
export type WorkspaceSessionSummary = {
  id: string
  assistantId: string
  assistantName: string
  channelType: string
  status: string
  createdAt: Date
  lastActiveAt: Date
}

/** One transcript-message gist for the introspection tool (text-only). */
export type WorkspaceTranscriptMessage = {
  role: string
  gist: string
}

/**
 * List recent sessions belonging to the workspace's assistants, newest-active
 * first. Scoped by the `assistants.workspace_id = $1` join (§6-a boundary) —
 * a teammate's PERSONAL assistant is never returned. Optional `channelType`
 * narrows to one channel. `limit` is clamped by the caller (tool) and again
 * defensively here.
 */
export async function listSessionsForWorkspaceSystem(
  workspaceId: string,
  opts: { limit: number; channelType?: string },
): Promise<WorkspaceSessionSummary[]> {
  const limit = Math.max(1, Math.min(opts.limit, 50))
  const conditions = ['a.workspace_id = $1']
  const values: unknown[] = [workspaceId]
  let paramIdx = 2

  if (opts.channelType) {
    conditions.push(`s.channel_type = $${paramIdx}`)
    values.push(opts.channelType)
    paramIdx++
  }

  values.push(limit)
  const result = await query<WorkspaceSessionSummary>(
    `SELECT s.id,
            s.assistant_id  AS "assistantId",
            a.name          AS "assistantName",
            s.channel_type  AS "channelType",
            s.status,
            s.created_at    AS "createdAt",
            s.last_active_at AS "lastActiveAt"
     FROM sessions s
     JOIN assistants a ON a.id = s.assistant_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY s.last_active_at DESC
     LIMIT $${paramIdx}`,
    values,
  )
  return result.rows
}

/**
 * The sessions that make up ONE conversation on a user channel — every
 * session whose `(channel_type, channel_id)` equals the given target and
 * whose assistant belongs to `workspaceId` (same `assistants.workspace_id`
 * join / §6-a boundary as `listSessionsForWorkspaceSystem`; a teammate's
 * personal assistant bound to the same chat is never returned). A multi-bot
 * chat yields one row per assistant, newest-active first.
 *
 * Used by the callee executor to bridge the session-state tier into a
 * scheduled run that DELIVERS into this conversation (workflow
 * `assistant_call` steps + scheduled-job reminders). System-level and
 * read-only. See docs/architecture/context-engine/session-state.md →
 * "Delivery-conversation bridging".
 */
export async function listSessionsByChannelForWorkspaceSystem(params: {
  workspaceId: string
  channelType: string
  channelId: string
  /** Defaults to 10; clamped to [1, 25]. */
  limit?: number
}): Promise<Array<{ id: string; assistantId: string; assistantName: string }>> {
  const limit = Math.max(1, Math.min(params.limit ?? 10, 25))
  const result = await query<{ id: string; assistantId: string; assistantName: string }>(
    `SELECT s.id,
            s.assistant_id AS "assistantId",
            a.name         AS "assistantName"
     FROM sessions s
     JOIN assistants a ON a.id = s.assistant_id
     WHERE a.workspace_id = $1
       AND s.channel_type = $2
       AND s.channel_id = $3
     ORDER BY s.last_active_at DESC
     LIMIT $4`,
    [params.workspaceId, params.channelType, params.channelId, limit],
  )
  return result.rows
}

/**
 * Read the most-recent `limit` messages of ONE session, chronological, as
 * text-only gists — ONLY IF the session belongs to a workspace assistant of
 * `workspaceId`. Returns:
 *   - `null`  when no session with that id belongs to the workspace (unknown
 *             id OR out-of-scope session — the caller renders an identical
 *             not-found message either way, so this is not an existence
 *             oracle).
 *   - `[]`    when the session is in scope but has no messages.
 *   - rows    otherwise (tool_use / tool_result blocks collapsed to one-line
 *             markers; never the full payload).
 *
 * Two queries: a scope guard (does this id belong to a workspace assistant?)
 * then the message fetch — mirrors the file's other resolve-then-act reads.
 */
export async function getSessionTranscriptForWorkspaceSystem(
  sessionId: string,
  workspaceId: string,
  opts: { limit: number },
): Promise<WorkspaceTranscriptMessage[] | null> {
  const limit = Math.max(1, Math.min(opts.limit, 100))

  // Scope guard: the session must exist AND its assistant must be in this
  // workspace. Anything else is an honest miss (returns null → not-found).
  const scope = await query<{ id: string }>(
    `SELECT s.id
     FROM sessions s
     JOIN assistants a ON a.id = s.assistant_id
     WHERE s.id = $1 AND a.workspace_id = $2
     LIMIT 1`,
    [sessionId, workspaceId],
  )
  if (scope.rows.length === 0) return null

  // Most-recent N, then reverse to chronological (like getGroupChatContext).
  const result = await query<{ role: string; content: unknown }>(
    `SELECT role, content
     FROM session_messages
     WHERE session_id = $1
     ORDER BY sequence_num DESC
     LIMIT $2`,
    [sessionId, limit],
  )
  return result.rows.reverse().map((r) => ({ role: r.role, gist: gistMessageContent(r.content) }))
}

/**
 * Reduce a session_messages JSONB `content` to a single text-only gist for
 * the transcript tool. Text blocks are joined; `tool_use` / `tool_result`
 * blocks collapse to one-line markers (`[tool: <name>]` / `[tool result]`)
 * so no frozen tool payload is ever surfaced. A bare string content is
 * returned as-is; anything unrecognized becomes `(non-text content)` rather
 * than throwing (a read tool must not fail on an odd row).
 */
function gistMessageContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return '(non-text content)'
  const parts: string[] = []
  for (const block of content as Array<Record<string, unknown>>) {
    const type = typeof block?.type === 'string' ? block.type : ''
    if (type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name : 'tool'
      parts.push(`[tool: ${name}]`)
    } else if (type === 'tool_result') {
      parts.push('[tool result]')
    }
    // Other block kinds (image, thinking, …) are dropped from the gist.
  }
  const joined = parts.join(' ').trim()
  return joined === '' ? '(non-text content)' : joined
}
