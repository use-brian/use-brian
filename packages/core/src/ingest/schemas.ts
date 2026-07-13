/**
 * Zod schemas mirroring `types.ts`. Used at trust boundaries:
 *
 *  - Adapters (WS-7) parse their inbound payloads through these before
 *    handing an Episode to Pipeline B.
 *  - Pipeline B (WU-3.6) validates Episodes hydrated from the database
 *    or from a job queue.
 *
 * In-process call sites within a single trusted runtime can skip
 * validation — the TypeScript types alone are enough for trusted callers.
 *
 * Spec: docs/plans/company-brain/data-model.md §Episode envelope.
 *
 * [COMP:brain/episode-envelope]
 */

import { z } from 'zod'

import { SOURCE_KINDS } from './types.js'

// ── Primitives ───────────────────────────────────────────────────────

export const sourceKindSchema = z.enum(SOURCE_KINDS)

/** Aligns with `Sensitivity` in `../security/sensitivity.ts`. */
export const sensitivitySchema = z.enum(['public', 'internal', 'confidential'])

/**
 * Cap on inline manual-paste bodies (data-model.md:421). Producers must
 * promote oversize content to a `file_upload` Episode; this schema
 * refuses oversize payloads at the trust boundary.
 */
export const MANUAL_PASTE_INLINE_MAX_BYTES = 16 * 1024

// ── Content ref variants ─────────────────────────────────────────────

const webChatContentRefSchema = z.object({
  source_kind: z.literal('web_chat'),
  session_id: z.string().min(1),
  message_id_range: z.tuple([z.string().min(1), z.string().min(1)]),
})

const slackThreadContentRefSchema = z.object({
  source_kind: z.literal('slack_thread'),
  slack_workspace_id: z.string().min(1),
  channel_id: z.string().min(1),
  thread_ts: z.string().min(1),
  message_count: z.number().int().nonnegative(),
})

const emailThreadContentRefSchema = z.object({
  source_kind: z.literal('email_thread'),
  message_id_chain: z.array(z.string().min(1)).min(1),
})

const meetingContentRefSchema = z.object({
  source_kind: z.literal('meeting'),
  transcript_file_id: z.string().min(1),
  recording_url: z.string().url().optional(),
  attendee_external_ids: z.array(z.string().min(1)),
})

const githubSyncContentRefSchema = z.object({
  source_kind: z.literal('github_sync'),
  repo: z.string().min(1),
  commit_from: z.string().min(1),
  commit_to: z.string().min(1),
  files_changed: z.array(z.string().min(1)),
})

const fileUploadContentRefSchema = z.object({
  source_kind: z.literal('file_upload'),
  file_id: z.string().min(1),
})

const manualPasteContentRefSchema = z.object({
  source_kind: z.literal('manual_paste'),
  inline: z
    .string()
    .refine(
      (s) => Buffer.byteLength(s, 'utf8') <= MANUAL_PASTE_INLINE_MAX_BYTES,
      `inline body exceeds ${MANUAL_PASTE_INLINE_MAX_BYTES} bytes; promote to file_upload`,
    ),
})

const channelWindowContentRefSchema = z.object({
  source_kind: z.literal('channel_window'),
  channel_id: z.string().min(1),
  window_start: z.coerce.date(),
  window_end: z.coerce.date(),
  message_count: z.number().int().nonnegative(),
})

const connectorActionContentRefSchema = z.object({
  source_kind: z.literal('connector_action'),
  connector_id: z.string().min(1),
  action_kind: z.string().min(1),
  external_id: z.string().min(1).optional(),
})

const interAssistantHandoffContentRefSchema = z.object({
  source_kind: z.literal('inter_assistant_handoff'),
  from_assistant_id: z.string().min(1),
  to_assistant_id: z.string().min(1),
  context_summary: z.string().min(1),
})

const bulkProfileImportContentRefSchema = z.object({
  source_kind: z.literal('bulk_profile_import'),
  provider: z.string().min(1),
  profile_count: z.number().int().nonnegative(),
  manifest_file_id: z.string().min(1),
})

const profileMaterializationContentRefSchema = z.object({
  source_kind: z.literal('profile_materialization'),
  bulk_episode_id: z.string().min(1),
  entity_id: z.string().min(1),
  trigger_kind: z.enum(['meeting', 'mention', 'follow_up', 'manual']),
})

const voiceMemoContentRefSchema = z.object({
  source_kind: z.literal('voice_memo'),
  audio_file_id: z.string().min(1),
  duration_secs: z.number().nonnegative(),
  transcribed_at: z.coerce.date().optional(),
  transcript_file_id: z.string().min(1).optional(),
  sub_kind: z.enum(['note', 'thought']),
})

const platformEngagementPerPostSchema = z.object({
  post_episode_id: z.string().min(1),
  likes: z.number().int().nonnegative().optional(),
  replies: z.number().int().nonnegative().optional(),
  views: z.number().int().nonnegative().optional(),
  reposts: z.number().int().nonnegative().optional(),
  follower_delta_attributed: z.number().int().optional(),
})

const platformEngagementAggregateSchema = z.object({
  total_engagement: z.number().int().nonnegative().optional(),
  follower_delta: z.number().int().optional(),
  top_post_episode_id: z.string().min(1).optional(),
})

const platformEngagementDigestContentRefSchema = z.object({
  source_kind: z.literal('platform_engagement_digest'),
  platform: z.string().min(1),
  period_start: z.coerce.date(),
  period_end: z.coerce.date(),
  metrics: z.object({
    per_post: z.array(platformEngagementPerPostSchema),
    aggregate: platformEngagementAggregateSchema,
  }),
})

const docPageContentRefSchema = z.object({
  source_kind: z.literal('doc_page'),
  page_id: z.string().min(1),
  // The section heading block id; `null` for the pre-first-heading preamble.
  section_block_id: z.string().min(1).nullable(),
  version: z.number().int().nonnegative(),
})

// Audio/video recording upload. The stored bytes live in GCS; `file_id` is
// the recording's storage identity (episode `source_ref` carries the full
// {fileId, gcsKey, fileName, mime} envelope). Recording episodes commonly
// carry a NULL content_ref today — this arm legitimises the vocabulary
// (2026-07-10 source audit: three writers emitted the kind unvocabularied).
const recordingContentRefSchema = z.object({
  source_kind: z.literal('recording'),
  file_id: z.string().min(1),
})

export const episodeContentRefSchema = z.discriminatedUnion('source_kind', [
  webChatContentRefSchema,
  slackThreadContentRefSchema,
  emailThreadContentRefSchema,
  meetingContentRefSchema,
  githubSyncContentRefSchema,
  fileUploadContentRefSchema,
  manualPasteContentRefSchema,
  channelWindowContentRefSchema,
  connectorActionContentRefSchema,
  interAssistantHandoffContentRefSchema,
  bulkProfileImportContentRefSchema,
  profileMaterializationContentRefSchema,
  voiceMemoContentRefSchema,
  platformEngagementDigestContentRefSchema,
  docPageContentRefSchema,
  recordingContentRefSchema,
])

// ── Envelope supporting schemas ──────────────────────────────────────

export const episodeActorSchema = z.object({
  user_id: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  external_id: z.string().min(1).optional(),
})

export const episodeAttachmentSchema = z.object({
  kind: z.string().min(1),
  ref: z.string().min(1),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
})

export const episodeContentSchema = z.object({
  raw: z.union([z.string(), z.object({ ref: z.string().min(1) })]),
  attachments: z.array(episodeAttachmentSchema),
})

/**
 * Universal envelope. Mirrors `EpisodeEnvelope` in `types.ts`. The
 * visibility invariant (`user_id IS NOT NULL OR assistant_id IS NOT NULL`,
 * data-model.md:282) is enforced via `superRefine`.
 */
export const episodeEnvelopeSchema = z
  .object({
    source_kind: sourceKindSchema,
    source_ref: z.record(z.unknown()),
    occurred_at: z.coerce.date(),

    actors: z.array(episodeActorSchema),
    content: episodeContentSchema,

    sensitivity: sensitivitySchema,

    user_id: z.string().min(1).nullable(),
    assistant_id: z.string().min(1).nullable(),
    workspace_id: z.string().min(1),

    created_by_user_id: z.string().min(1),
    created_by_assistant_id: z.string().min(1).nullable(),
  })
  .superRefine((env, ctx) => {
    if (env.user_id === null && env.assistant_id === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'episode visibility: at least one of user_id or assistant_id must be set',
        path: ['user_id'],
      })
    }
  })
