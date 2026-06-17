/**
 * Input shapes for the Slack thread normalizer (WU-7.2).
 *
 * The adapter is pure: callers (HTTP route, batch worker) resolve the full
 * thread by calling Slack's `conversations.replies` themselves and hand the
 * assembled message list to `normalizeSlackThread`. This file declares only
 * the fields the normalizer reads — real Slack payloads carry many more,
 * which the normalizer ignores.
 *
 * Spec: docs/plans/company-brain/ingest.md §Slack (channel monitoring),
 * §"Episode = conversation, not message"; data-model.md §SlackThreadContentRef.
 *
 * [COMP:brain/source-adapters/slack]
 */

export type SlackFileInput = {
  id: string
  mimetype?: string
  name?: string
  size?: number
  /** Slack-internal URL; preserved as the attachment ref. */
  url_private?: string
}

export type SlackMessageInput = {
  /** Slack message timestamp (also serves as message id within a channel). */
  ts: string
  /** Slack user id; absent for bot-only messages. */
  user?: string
  /** Present when the message was posted by a bot (with or without `user`). */
  bot_id?: string
  /** Message body; may be empty for files-only messages. */
  text?: string
  /** Parent thread ts (matches the parent `SlackThreadInput.thread_ts` for replies). */
  thread_ts?: string
  files?: ReadonlyArray<SlackFileInput>
}

export type SlackThreadInput = {
  /** Slack workspace (team) id, e.g. 'T123'. */
  team_id: string
  /** Slack channel id, e.g. 'C456'. */
  channel_id: string
  /** Slack's thread root ts — the lookup key for `conversations.replies`. */
  thread_ts: string
  messages: ReadonlyArray<SlackMessageInput>
}

/**
 * Ingest-context fields the adapter cannot infer from a Slack payload alone.
 * Resolved upstream from the matching `connector_instance` row and the
 * user/assistant who owns it.
 *
 * Visibility-double invariant (at least one of `user_id` / `assistant_id`
 * non-null) is enforced by `episodeEnvelopeSchema.superRefine` at the Pipeline B
 * trust boundary, not here.
 */
export type SlackIngestContext = {
  workspace_id: string
  user_id: string | null
  assistant_id: string | null
  created_by_user_id: string
  created_by_assistant_id: string | null
}
