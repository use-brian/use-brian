/**
 * Slack canonical source adapter — public surface (WU-7.2).
 *
 * Aggregates the per-source pieces a canonical adapter contributes per
 * ingest.md §Adapter strategy:
 *
 *   - `source` — stable identifier matching `connector_instance.provider`
 *   - `normalize` — resolved Slack thread → `EpisodeEnvelope`
 *   - `filterImplementations` — the four Slack filters (run on the raw
 *     thread — see filters.ts for why)
 *   - `defaultRules` — pre-seeded rule list
 *
 * Pure TypeScript — no Slack API calls, no signature verification, no DB
 * (per packages/core/CLAUDE.md). Webhook receiving + `conversations.replies`
 * thread resolution live downstream in `apps/api`.
 *
 * [COMP:brain/source-adapters/slack]
 */

export { normalizeSlackThread } from './normalize.js'
export type {
  SlackFileInput,
  SlackIngestContext,
  SlackMessageInput,
  SlackThreadInput,
} from './types.js'

export {
  channelMatch,
  isDm,
  isMention,
  userMatch,
  channelMatchParamsSchema,
  isDmParamsSchema,
  isMentionParamsSchema,
  userMatchParamsSchema,
  slackFilterImplementations,
  slackFilterParamsSchemas,
  type ChannelMatchParams,
  type IsDmParams,
  type IsMentionParams,
  type UserMatchParams,
  type SlackFilterType,
} from './filters.js'

export {
  slackDefaultRules,
  type SlackDefaultRule,
} from './default-rules.js'

export {
  resolveSlackMentions,
  extractMentionIds,
  type ResolvedMention,
  type SlackMentionResolution,
} from './mentions.js'

import { normalizeSlackThread } from './normalize.js'
import {
  slackFilterImplementations,
  slackFilterParamsSchemas,
} from './filters.js'
import { slackDefaultRules } from './default-rules.js'

/**
 * Aggregate Slack adapter. Mirrors `calendarAdapter`'s shape — a shared
 * `ConnectorAdapter` interface is planned for `packages/core/src/ingest/`
 * once the WS-7 adapters all land; until then the type stays local.
 */
export const slackAdapter = {
  source: 'slack' as const,
  normalize: normalizeSlackThread,
  filterImplementations: slackFilterImplementations,
  filterParamsSchemas: slackFilterParamsSchemas,
  defaultRules: slackDefaultRules,
}

export type SlackAdapter = typeof slackAdapter
