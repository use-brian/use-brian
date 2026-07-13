/**
 * Episode envelope + EpisodeContentRef — the universal contract every
 * ingest adapter and Pipeline B speaks.
 *
 * Schema spec: docs/plans/company-brain/data-model.md §Episode envelope
 * (lines 289–408). Each `EpisodeContentRef` variant is a discriminated
 * union arm keyed on `source_kind`; the storage rule is pointer-based
 * with manual-paste as the inline exception (data-model.md:328–331).
 *
 * Consumed by WU-3.5 (`episodes-store.ts`), WU-3.6 (`pipeline-b.ts`),
 * WU-3.7 (ingest engine routing), and the WS-7 source adapters.
 *
 * [COMP:brain/episode-envelope]
 */

import type { Sensitivity } from '../security/sensitivity.js'

// ── Source kind ──────────────────────────────────────────────────────

/**
 * Full set of Episode source kinds. Locked vocabulary from data-model.md
 * (incl. SV 2026-05-14 additions: bulk_profile_import,
 * profile_materialization, voice_memo, platform_engagement_digest).
 */
export const SOURCE_KINDS = [
  'web_chat',
  'slack_thread',
  'email_thread',
  'meeting',
  'github_sync',
  'file_upload',
  'manual_paste',
  'channel_window',
  'connector_action',
  'inter_assistant_handoff',
  'bulk_profile_import',
  'profile_materialization',
  'voice_memo',
  'platform_engagement_digest',
  // Doc-page distillation (canvas-brain-distillation.md — "canvas" == today's
  // "doc"). One Episode per page section; `source_ref` carries the
  // `(page_id, section_block_id, version)` back-edge so every derived fact
  // points at the exact block it came from. "Canvas is just another
  // source_kind" — it rides Pipeline B, trust, and supersession unmodified.
  'doc_page',
  // Audio/video recording upload (recording-to-brain). Three platform
  // writers (`routes/recordings.ts`, `routes/telegram-byo.ts`,
  // `ingest/channel-media-intake.ts`) were already emitting this literal —
  // the column has no CHECK, so it persisted while missing from this
  // vocabulary (2026-07-10 source audit).
  'recording',
] as const

export type SourceKind = typeof SOURCE_KINDS[number]

// ── EpisodeContentRef discriminated union ─────────────────────────────

export type WebChatContentRef = {
  source_kind: 'web_chat'
  session_id: string
  message_id_range: [string, string]
}

export type SlackThreadContentRef = {
  source_kind: 'slack_thread'
  slack_workspace_id: string
  channel_id: string
  thread_ts: string
  message_count: number
}

export type EmailThreadContentRef = {
  source_kind: 'email_thread'
  message_id_chain: string[]
}

export type MeetingContentRef = {
  source_kind: 'meeting'
  transcript_file_id: string
  recording_url?: string
  attendee_external_ids: string[]
}

export type GithubSyncContentRef = {
  source_kind: 'github_sync'
  repo: string
  commit_from: string
  commit_to: string
  files_changed: string[]
}

export type FileUploadContentRef = {
  source_kind: 'file_upload'
  file_id: string
}

/** Inline body is the manual-paste exception (data-model.md:328-331, 421). */
export type ManualPasteContentRef = {
  source_kind: 'manual_paste'
  inline: string
}

export type ChannelWindowContentRef = {
  source_kind: 'channel_window'
  channel_id: string
  window_start: Date
  window_end: Date
  message_count: number
}

export type ConnectorActionContentRef = {
  source_kind: 'connector_action'
  connector_id: string
  action_kind: string
  external_id?: string
}

export type InterAssistantHandoffContentRef = {
  source_kind: 'inter_assistant_handoff'
  from_assistant_id: string
  to_assistant_id: string
  context_summary: string
}

/** Pipeline B extraction is bypassed; manifest holds pre-structured profiles. */
export type BulkProfileImportContentRef = {
  source_kind: 'bulk_profile_import'
  provider: 'linkedin' | 'twitter' | string
  profile_count: number
  manifest_file_id: string
}

export type ProfileMaterializationTrigger =
  | 'meeting'
  | 'mention'
  | 'follow_up'
  | 'manual'

/** Lazy per-entity Episode on first touch; back-links to a bulk_profile_import. */
export type ProfileMaterializationContentRef = {
  source_kind: 'profile_materialization'
  bulk_episode_id: string
  entity_id: string
  trigger_kind: ProfileMaterializationTrigger
}

/** `sub_kind` deliberately omits 'meeting' — meeting recordings use source_kind: 'meeting'. */
export type VoiceMemoContentRef = {
  source_kind: 'voice_memo'
  audio_file_id: string
  duration_secs: number
  transcribed_at?: Date
  transcript_file_id?: string
  sub_kind: 'note' | 'thought'
}

/** Per-platform `metrics` sub-schema is intentionally loose at launch. */
export type PlatformEngagementPerPost = {
  post_episode_id: string
  likes?: number
  replies?: number
  views?: number
  reposts?: number
  follower_delta_attributed?: number
}

export type PlatformEngagementAggregate = {
  total_engagement?: number
  follower_delta?: number
  top_post_episode_id?: string
}

export type PlatformEngagementMetrics = {
  per_post: PlatformEngagementPerPost[]
  aggregate: PlatformEngagementAggregate
}

export type PlatformEngagementDigestContentRef = {
  source_kind: 'platform_engagement_digest'
  platform: 'threads' | 'twitter' | 'linkedin' | string
  period_start: Date
  period_end: Date
  metrics: PlatformEngagementMetrics
}

/**
 * One Episode per heading-delimited page section. `section_block_id` is the
 * heading block's id (or `null` for the pre-first-heading preamble), so every
 * fact Pipeline B derives from this Episode carries a precise `(page_id,
 * block_id)` back-edge via `source_episode_id` — the durable provenance the
 * plan's Decision 1 makes the load-bearing requirement.
 *
 * `version` is the page version at distillation time (`saved_views.version`
 * or the live `documents.seq`). It is recorded for audit / staleness-by-the-
 * user's-workflow, not consulted by Pipeline B itself.
 *
 * See docs/architecture/brain/ingest-pipeline.md §"The ingestion pipeline" step 2.
 */
export type DocPageContentRef = {
  source_kind: 'doc_page'
  page_id: string
  /** The section's heading block id, or `null` for the preamble. */
  section_block_id: string | null
  version: number
}

/** Audio/video recording upload — `file_id` is the GCS storage identity. */
type RecordingContentRef = {
  source_kind: 'recording'
  file_id: string
}

export type EpisodeContentRef =
  | WebChatContentRef
  | SlackThreadContentRef
  | EmailThreadContentRef
  | MeetingContentRef
  | GithubSyncContentRef
  | FileUploadContentRef
  | ManualPasteContentRef
  | ChannelWindowContentRef
  | ConnectorActionContentRef
  | InterAssistantHandoffContentRef
  | BulkProfileImportContentRef
  | ProfileMaterializationContentRef
  | VoiceMemoContentRef
  | PlatformEngagementDigestContentRef
  | DocPageContentRef
  | RecordingContentRef

// ── EpisodeEnvelope universal contract ────────────────────────────────

export type EpisodeActor = {
  user_id?: string
  /** e.g. 'sender' | 'recipient' | 'attendee' */
  role?: string
  /** For unmapped people on the source side. */
  external_id?: string
}

export type EpisodeAttachment = {
  kind: string
  ref: string
  mime: string
  size: number
}

/** Raw content is inline OR a reference to bytes elsewhere (data-model.md:307). */
export type EpisodeContent = {
  raw: string | { ref: string }
  attachments: EpisodeAttachment[]
}

/**
 * Universal envelope from adapters to Pipeline B (data-model.md:295–319).
 *
 * Note on `sensitivity`: this reuses the existing `Sensitivity` union
 * (`'public' | 'internal' | 'confidential'`) from `security/sensitivity.ts`.
 * data-model.md mentions a `'restricted'` tier for `workspace_skills` tables
 * only — the Episodes table itself has no CHECK constraint enforcing it.
 * Aligning with the existing TS type keeps the system coherent; broaden
 * `Sensitivity` if a future WU needs `'restricted'` for Episodes.
 *
 * Visibility invariant: at least one of `user_id` or `assistant_id` is
 * set (data-model.md:282 `episodes_visibility_check`).
 */
export type EpisodeEnvelope = {
  source_kind: SourceKind
  /** Adapter-specific reference payload. */
  source_ref: Record<string, unknown>
  occurred_at: Date

  actors: EpisodeActor[]
  content: EpisodeContent

  /** Computed by the adapter at ingest. */
  sensitivity: Sensitivity

  user_id: string | null
  assistant_id: string | null
  workspace_id: string

  created_by_user_id: string
  created_by_assistant_id: string | null
}
