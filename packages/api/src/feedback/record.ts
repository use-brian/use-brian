/**
 * `recordFeedback` — single writer for all four feedback surfaces.
 *
 * Channels:
 *  - Web chat → `POST /api/feedback` (`routes/feedback.ts`)
 *  - Slack    → `reaction_added` event (`routes/slack.ts`)
 *  - Telegram → `message_reaction` update (`routes/telegram.ts`)
 *  - Feishu   → normalized reaction event (`routes/feishu.ts`)
 *
 * Every path lands here so the analytics row + the heuristic
 * feedback-memory write happen identically regardless of source. The
 * reflection consolidation (`packages/core/src/consolidation/phases.ts`)
 * reads the resulting `analytics_events` rows joined to
 * `memory_recall_events` — one writer means one schema for the join.
 *
 * Spec: docs/architecture/brain/corrections.md → "Feedback signal".
 *
 * [COMP:brain/feedback-recorder]
 */

import { deriveResourceScope, type ResourceScope, type ScopeSource } from '@use-brian/core'
import { getPool } from '../db/client.js'
import { createMemory } from '../db/memories.js'
import { recordDerivedResource } from '../db/derived-scope-store.js'

/**
 * Source channel for a feedback event. Stamped on the analytics row's
 * `metadata.source` so the reflection prompt and analytics dashboards
 * can break down by surface.
 */
export type FeedbackSource = 'web' | 'slack' | 'telegram' | 'feishu'

export type RecordFeedbackParams = {
  /** Internal user id (the resolver in the route layer maps a Slack,
   *  Telegram, Feishu/Lark, or web identity to this). */
  userId: string
  /** UUID of the assistant message being reacted to —
   *  `session_messages.id`. The Slack/Telegram/Feishu reaction handlers look
   *  this up via `findSessionMessageByChannelId` before calling
   *  through. Web passes it directly from the chat UI. */
  messageId: string
  sessionId: string | null
  kind: 'positive' | 'negative'
  /** Optional issue-type slug. Web modal supplies the user-chosen
   *  reason; reactions supply the emoji label (`thumbsdown`,
   *  `frustration`, etc.). */
  issueType?: string
  /** Free-text user explanation. Web modal: the textarea contents.
   *  Reactions: the normalised emoji label (`:thumbsdown:`). */
  details?: string
  source: FeedbackSource
  /** Optional channel id (Slack channel, Telegram or Feishu/Lark chat). Persisted on
   *  `analytics_events.channel_type` is set from `source`; this rides
   *  on metadata for surface-level analytics breakdowns. */
  channelId?: string
}

/**
 * Persist a feedback event + (optionally) derive a feedback-memory
 * row when the user supplied substantive details.
 *
 * Always writes one `analytics_events` row. For negative feedback
 * carrying ≥10 chars of details, also writes one memory tagged
 * `feedback`/`correction` so the model picks the correction up on
 * future turns even before the next reflection consolidation cycle.
 *
 * The auto-memory threshold matches `memory_recall_events-store`'s
 * `correctionCount` heuristic — keeping the threshold aligned means
 * `analytics_events.metadata.details` rendered as memory and the
 * bad-outcome badge on the original memory stay in sync.
 *
 * Returns `{ analyticsId, memoryId }` where `memoryId` is `null` if
 * the auto-memory branch did not fire.
 */
export async function recordFeedback(params: RecordFeedbackParams): Promise<{
  analyticsId: string | null
  memoryId: string | null
}> {
  const { userId, messageId, sessionId, kind, issueType, details, source, channelId } = params

  // Defensive: empty or whitespace details lose the memory branch even
  // if length passes — `.trim()` aligns with the recall-events
  // `correctionCount` join predicate.
  const trimmedDetails = details?.trim() ?? ''

  const client = await getPool().connect()
  let analyticsId: string | null = null
  let feedbackSource: ScopeSource | null = null
  let canonicalSessionId: string | null = null
  let canonicalAssistantId: string | null = null

  try {
    await client.query('BEGIN')
    const target = (await client.query<{
      workspace_id: string | null
      session_id: string
      assistant_id: string | null
      role: string
      source: ScopeSource | null
    }>(
      `SELECT sm.workspace_id,sm.session_id,sm.assistant_id,sm.role,
              CASE WHEN sm.workspace_id IS NULL THEN NULL
                   ELSE read_scope_source(sm.workspace_id,'session_message',sm.id) END AS source
         FROM session_messages sm
        WHERE sm.id=$1
        FOR SHARE`,
      [messageId],
    )).rows[0]
    if (!target || target.role !== 'assistant' || (sessionId && sessionId !== target.session_id)) {
      throw new Error('feedback_target_unavailable')
    }
    canonicalSessionId = target.session_id
    canonicalAssistantId = target.assistant_id

    // Legacy messages remain useful for count-only analytics, but they cannot
    // create a memory or enter reflection without canonical turn evidence.
    let feedbackScope: ResourceScope | null = null
    if (target.workspace_id && target.source && target.assistant_id
      && (target.source as ScopeSource & { held?: boolean }).held !== true) {
      const member = (await client.query<{
        role: string
        clearance: string
        compartments: string[] | null
        projects_allowed: boolean
      }>(
        `SELECT wm.role,
                CASE WHEN wm.role IN ('owner','admin') THEN 'confidential' ELSE wm.clearance END AS clearance,
                effective_member_read_compartments($1,$2) AS compartments,
                CASE WHEN wm.role IN ('owner','admin') THEN true ELSE NOT EXISTS (
                  SELECT 1 FROM unnest($3::uuid[]) required(project_id)
                  WHERE NOT EXISTS (
                    SELECT 1 FROM workspace_project_members pm
                    WHERE pm.project_id=required.project_id AND pm.user_id=$1
                  )
                ) END AS projects_allowed
           FROM workspace_members wm
          WHERE wm.user_id=$1 AND wm.workspace_id=$2`,
        [userId, target.workspace_id, target.source.projectIds],
      )).rows[0]
      const reachesTeams = member && (member.compartments === null
        || target.source.compartments.every((value) => member.compartments!.includes(value)))
      const reachesUser = target.source.userId === null || target.source.userId === userId
      const sensitivityRank = { public: 0, internal: 1, confidential: 2 } as const
      const reachesSensitivity = member
        && member.clearance in sensitivityRank
        && sensitivityRank[member.clearance as keyof typeof sensitivityRank]
          >= sensitivityRank[target.source.sensitivity]
      if (!member || !member.projects_allowed || !reachesTeams || !reachesUser
        || !reachesSensitivity) {
        throw new Error('feedback_target_unavailable')
      }
      feedbackScope = deriveResourceScope(
        { producer: 'feedback:receipt', sources: [target.source] },
        { ...target.source, userId, assistantId: target.assistant_id },
      )
    }

  // 1. Analytics event. `channel_type` carries the source surface so
  //    analytics queries can break feedback down by Slack vs Telegram
  //    vs web without parsing metadata.
    const analyticsResult = await client.query<{ id: string }>(
    `INSERT INTO analytics_events (user_id, assistant_id, session_id, event_name, metadata, channel_type,
       workspace_id,sensitivity,compartments,project_ids,scope_version,scope_held)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [
      userId,
      canonicalAssistantId,
      canonicalSessionId,
      `feedback_${kind}`,
      JSON.stringify({
        messageId,
        issueType: issueType ?? null,
        details: trimmedDetails.length > 0 ? trimmedDetails : null,
        source,
        channelId: channelId ?? null,
      }),
      source,
      feedbackScope?.workspaceId ?? null,
      feedbackScope?.sensitivity ?? null,
      feedbackScope?.compartments ?? null,
      feedbackScope?.projectIds ?? null,
      feedbackScope ? 1 : null,
      feedbackScope ? false : null,
    ],
  )
    analyticsId = analyticsResult.rows[0]?.id ?? null
    if (analyticsId && feedbackScope && target.source) {
      feedbackSource = {
        ...feedbackScope,
        resourceKind: 'feedback_event',
        resourceId: analyticsId,
        version: '1',
      }
      await recordDerivedResource(
        client,
        { producer: 'feedback:receipt', sources: [target.source] },
        feedbackSource,
      )
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }

  // 2. Auto-memory: negative + substantive details. Reaction events
  //    pass `details = reactionDetailsLabel(emoji)` which is short
  //    (`:angry:` → 7 chars) and intentionally below the threshold,
  //    so reactions DO NOT spawn auto-memories — they only land in
  //    analytics for the reflection consolidation to pick up. Web
  //    feedback modal entries DO pass through here when the user
  //    wrote a real explanation.
  if (kind !== 'negative' || trimmedDetails.length < 10) {
    return { analyticsId, memoryId: null }
  }

  try {
    if (!feedbackSource || !canonicalAssistantId) return { analyticsId, memoryId: null }

    const summary = buildMemorySummary(issueType, trimmedDetails)
    const memory = await createMemory({
      workspaceId: feedbackSource.workspaceId,
      assistantId: canonicalAssistantId,
      userId,
      scope: 'shared',
      tags: ['feedback', 'correction', ...(issueType ? [slugify(issueType)] : [])],
      summary,
      detail:
        `User flagged a response as "${issueType ?? 'unhelpful'}" with this explanation:\n` +
        `${trimmedDetails}\n\nApply this to future responses.`,
      confidence: 0.85,
      sensitivity: feedbackSource.sensitivity,
      compartments: feedbackSource.compartments,
      projectIds: feedbackSource.projectIds,
      source: 'feedback',
      sourceSessionId: canonicalSessionId ?? undefined,
      createdByUserId: userId,
      derivation: { producer: 'feedback:auto-memory', sources: [feedbackSource] },
    })
    return { analyticsId, memoryId: memory.id }
  } catch (err) {
    // Don't fail the whole feedback call if memory creation errors —
    // the analytics row is already in and that's what the reflection
    // consolidation reads. A logged failure here is operator-visible.
    console.error('[feedback] auto-memory failed:', err)
    return { analyticsId, memoryId: null }
  }
}

function buildMemorySummary(issueType: string | undefined, details: string): string {
  const short = details.length > 100 ? details.slice(0, 97) + '...' : details
  if (issueType) {
    return `User correction (${issueType.toLowerCase()}): ${short}`
  }
  return `User correction: ${short}`
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}
