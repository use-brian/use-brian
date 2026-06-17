/**
 * `recordFeedback` — single writer for all three feedback surfaces.
 *
 * Channels:
 *  - Web chat → `POST /api/feedback` (`routes/feedback.ts`)
 *  - Slack    → `reaction_added` event (`routes/slack.ts`)
 *  - Telegram → `message_reaction` update (`routes/telegram.ts`)
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

import { query } from '../db/client.js'
import { getDefaultAssistant } from '../db/users.js'
import { createMemory } from '../db/memories.js'

/**
 * Source channel for a feedback event. Stamped on the analytics row's
 * `metadata.source` so the reflection prompt and analytics dashboards
 * can break down by surface.
 */
export type FeedbackSource = 'web' | 'slack' | 'telegram'

export type RecordFeedbackParams = {
  /** Internal user id (the resolver in the route layer maps a Slack
   *  user / Telegram user / web JWT to this). */
  userId: string
  /** UUID of the assistant message being reacted to —
   *  `session_messages.id`. The Slack/Telegram reaction handlers look
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
  /** Optional channel id (Slack channel, Telegram chat). Persisted on
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

  // 1. Analytics event. `channel_type` carries the source surface so
  //    analytics queries can break feedback down by Slack vs Telegram
  //    vs web without parsing metadata.
  const analyticsResult = await query<{ id: string }>(
    `INSERT INTO analytics_events (user_id, session_id, event_name, metadata, channel_type)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      userId,
      sessionId,
      `feedback_${kind}`,
      JSON.stringify({
        messageId,
        issueType: issueType ?? null,
        details: trimmedDetails.length > 0 ? trimmedDetails : null,
        source,
        channelId: channelId ?? null,
      }),
      source,
    ],
  )
  const analyticsId = analyticsResult.rows[0]?.id ?? null

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
    const assistant = await getDefaultAssistant(userId)
    if (!assistant) return { analyticsId, memoryId: null }

    const summary = buildMemorySummary(issueType, trimmedDetails)
    const memory = await createMemory({
      assistantId: assistant.id,
      userId,
      scope: 'shared',
      tags: ['feedback', 'correction', ...(issueType ? [slugify(issueType)] : [])],
      summary,
      detail:
        `User flagged a response as "${issueType ?? 'unhelpful'}" with this explanation:\n` +
        `${trimmedDetails}\n\nApply this to future responses.`,
      confidence: 0.85,
      source: 'feedback',
      sourceSessionId: sessionId ?? undefined,
      sensitivity: 'internal',
      createdByUserId: userId,
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
