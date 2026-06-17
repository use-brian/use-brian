import { query } from './client.js'

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
   * Outbound file attachments on assistant messages (migration 273, the
   * `sendFile` tool). Soft references to `workspace_files` rows — rendered
   * as file cards on web; informational parity on messaging rows. `[]` for
   * everything else.
   */
  attachments: SessionMessageAttachment[]
}

/** One outbound attachment — mirrors `OutboundAttachment` in @sidanclaw/core. */
export type SessionMessageAttachment = {
  fileId: string
  workspaceId: string
  path: string
  name: string
  mime: string
  sizeBytes: number
  caption?: string
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
}): Promise<Session> {
  const appId = params.appId ?? 'sidanclaw'
  const appOrigin = params.appOrigin ?? null
  const visibility = params.visibility ?? 'owner'
  const workspaceId = params.workspaceId ?? null
  const effectiveClearance = params.effectiveClearance ?? null

  const result = await query<Session>(
    `INSERT INTO sessions (assistant_id, user_id, channel_type, channel_id, app_id, app_origin, visibility, workspace_id, effective_clearance)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
               created_at as "createdAt", last_active_at as "lastActiveAt"`,
    [params.assistantId, params.userId, params.channelType, params.channelId, appId, appOrigin, visibility, workspaceId, effectiveClearance],
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
  const appId = params.appId ?? 'sidanclaw'
  const result = await query<Session>(
    `SELECT id, assistant_id as "assistantId", user_id as "userId",
            channel_type as "channelType", channel_id as "channelId",
            app_id as "appId", app_origin as "appOrigin", status, compact_summary as "compactSummary",
            compaction_count as "compactionCount",
            compact_boundary_sequence as "compactBoundarySequence", title,
            downgrade_notice_sent as "downgradeNoticeSent",
            downgrade_notice_pin_message_id as "downgradeNoticePinMessageId",
            mode, visibility, effective_clearance as "effectiveClearance",
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
  const appId = params.appId ?? 'sidanclaw'
  // Fresh UUID per call — no conflict on the (assistant, user,
  // channel_type, channel_id, app_id) uniqueness constraint, since the
  // channel_id is unique per Ask. crypto.randomUUID() ships in Node ≥ 19.
  const channelId = crypto.randomUUID()
  const result = await query<Session>(
    `INSERT INTO sessions (
       assistant_id, user_id, channel_type, channel_id, app_id, transient
     )
     VALUES ($1, $2, 'brain_inspection', $3, $4, TRUE)
     RETURNING id, assistant_id as "assistantId", user_id as "userId",
               channel_type as "channelType", channel_id as "channelId",
               app_id as "appId", app_origin as "appOrigin", status, compact_summary as "compactSummary",
               compaction_count as "compactionCount",
               compact_boundary_sequence as "compactBoundarySequence", title,
               downgrade_notice_sent as "downgradeNoticeSent",
               downgrade_notice_pin_message_id as "downgradeNoticePinMessageId",
               mode, visibility, effective_clearance as "effectiveClearance",
               created_at as "createdAt", last_active_at as "lastActiveAt"`,
    [params.primaryAssistantId, params.userId, channelId, appId],
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
            created_at as "createdAt", last_active_at as "lastActiveAt"
     FROM sessions WHERE id = $1`,
    [id],
  )
  if (result.rows.length === 0) return null
  // Touch last_active_at
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
}

/**
 * Reset every session whose `status='running'` AND `last_active_at` is older
 * than the supplied staleness threshold to `status='timeout'`. Returns the
 * rows that were touched so callers can emit per-session telemetry / bus
 * events. See `packages/api/src/scheduling/stuck-session-sweeper.ts` and
 * `docs/architecture/context-engine/session-messages.md` →
 * "Stuck-running recovery".
 */
export async function sweepStuckSessions(
  staleAfterMs: number,
): Promise<Array<{ id: string; mode: string | null; userId: string }>> {
  const result = await query<{ id: string; mode: string | null; user_id: string }>(
    `UPDATE sessions
        SET status = 'timeout', last_active_at = now()
      WHERE status = 'running'
        AND last_active_at < now() - ($1 || ' milliseconds')::interval
      RETURNING id, mode, user_id`,
    [String(staleAfterMs)],
  )
  return result.rows.map((r) => ({ id: r.id, mode: r.mode, userId: r.user_id }))
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
            attachments
     FROM session_messages WHERE ${conditions.join(' AND ')}
     ORDER BY sequence_num ASC ${limitClause}`,
    values,
  )

  return result.rows
}

/**
 * Map DB session messages to LLM Message format, prepending a compact
 * timestamp to user messages so the model always knows when each message
 * was sent. Uses the DB's `created_at` (actual arrival time), not the
 * current time. Only modifies the in-memory representation — stored
 * content stays clean for UI display.
 *
 * Format: `[Wed, Apr 15, 12:33 PM HKT] ` — compact, includes day-of-week.
 */
export function toStampedMessages(
  dbMessages: SessionMessage[],
  timezone: string,
): Array<{ role: 'user' | 'assistant' | 'system'; content: unknown }> {
  return dbMessages.map((m) => {
    const base = {
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
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

    // Find the first text block and prepend the timestamp
    const content = m.content as Array<{ type?: string; text?: string }>
    for (let i = 0; i < content.length; i++) {
      const block = content[i]
      if (block.type === 'text' && typeof block.text === 'string') {
        return {
          ...base,
          content: [
            ...content.slice(0, i),
            { ...block, text: `[${stamp}] ${block.text}` },
            ...content.slice(i + 1),
          ],
        }
      }
    }
    // No text block — prepend one with just the timestamp
    return {
      ...base,
      content: [{ type: 'text', text: `[${stamp}]` }, ...content],
    }
  })
}

/**
 * Append a message to a session. Auto-increments sequence_num.
 *
 * Optional fields:
 * - replyToText:       snapshot text of the message being replied to, if any
 * - topicLabel:        normalized topic label from the classifier
 * - topicConfidence:   0..1 classifier confidence
 * - channelMessageId:  channel-native ID of this message (Telegram, Slack, WhatsApp)
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
  /** Outbound file attachments (assistant rows only — `sendFile`, migration 273). */
  attachments?: SessionMessageAttachment[]
}): Promise<SessionMessage> {
  const result = await query<SessionMessage>(
    `INSERT INTO session_messages
       (session_id, role, content, sequence_num,
        reply_to_text, topic_label, topic_confidence, channel_message_id, sender_user_id, attachments)
     VALUES ($1, $2, $3,
       COALESCE((SELECT MAX(sequence_num) FROM session_messages WHERE session_id = $1), 0) + 1,
       $4, $5, $6, $7, $8, $9
     )
     RETURNING id, session_id as "sessionId", role, content,
               sequence_num as "sequenceNum", created_at as "createdAt",
               reply_to_text as "replyToText",
               topic_label as "topicLabel",
               topic_confidence as "topicConfidence",
               channel_message_id as "channelMessageId",
               sender_user_id as "senderUserId",
               attachments`,
    [
      params.sessionId,
      params.role,
      JSON.stringify(params.content),
      params.replyToText ?? null,
      params.topicLabel ?? null,
      params.topicConfidence ?? null,
      params.channelMessageId ?? null,
      params.senderUserId ?? null,
      JSON.stringify(params.attachments ?? []),
    ],
  )

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
 * (channel_type, channel_id, channel_message_id). Used by the
 * Slack `reaction_added` and Telegram `message_reaction` handlers to
 * route an emoji reaction back to the assistant turn it referred to.
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
       AND s.channel_id = $2
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
 * the channel-native id (Slack `ts`, Telegram `message_id`) only
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
 * Delete a message and all subsequent messages in the session
 * (by sequence_num). Used for retry/edit — destroy-and-regenerate semantics.
 *
 * Returns the deleted messages so the caller can log them to analytics
 * (preserving the signal that a retry/edit happened).
 */
export async function truncateMessagesFrom(messageId: string): Promise<{
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
 * Find the user's most-active messaging channel (telegram or slack).
 * Returns the channel_type and channel_id of the session with the most
 * recent activity, excluding 'web' and 'cron' sessions.
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
       AND channel_type IN ('telegram', 'slack', 'whatsapp')
       AND channel_id NOT IN ('notifications', 'default')
       AND (channel_type != 'whatsapp' OR channel_id LIKE '%@%')
     ORDER BY last_active_at DESC
     LIMIT 1`,
    [assistantId, userId],
  )
  return result.rows[0] ?? null
}
