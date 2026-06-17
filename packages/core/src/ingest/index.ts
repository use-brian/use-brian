// Ingest module — universal envelope contract every adapter and
// Pipeline B speaks.
//
//   - types.ts                  : envelope + content-ref union
//   - schemas.ts                : Zod runtime schemas
//   - engine.ts                 : routing executor (rules → modes)
//   - filters.ts                : filter library + composeFilters
//   - default-rules.ts          : pre-seeded ingest rules per source
//   - sensitivity-classifier.ts : Q3 async classifier (Pipeline B final step)
//   - adapters/<source>/        : per-source normalizers (gmail / slack / github / calendar)
//
// Spec: docs/plans/company-brain/data-model.md §Episode envelope; ingest.md.

export {
  SOURCE_KINDS,
  type SourceKind,
  type EpisodeContentRef,
  type WebChatContentRef,
  type SlackThreadContentRef,
  type EmailThreadContentRef,
  type MeetingContentRef,
  type GithubSyncContentRef,
  type FileUploadContentRef,
  type ManualPasteContentRef,
  type ChannelWindowContentRef,
  type ConnectorActionContentRef,
  type InterAssistantHandoffContentRef,
  type BulkProfileImportContentRef,
  type ProfileMaterializationContentRef,
  type ProfileMaterializationTrigger,
  type VoiceMemoContentRef,
  type PlatformEngagementPerPost,
  type PlatformEngagementAggregate,
  type PlatformEngagementMetrics,
  type PlatformEngagementDigestContentRef,
  type EpisodeActor,
  type EpisodeAttachment,
  type EpisodeContent,
  type EpisodeEnvelope,
} from './types.js'

export {
  MANUAL_PASTE_INLINE_MAX_BYTES,
  sourceKindSchema,
  sensitivitySchema,
  episodeContentRefSchema,
  episodeActorSchema,
  episodeAttachmentSchema,
  episodeContentSchema,
  episodeEnvelopeSchema,
} from './schemas.js'

// New modules wired by coordinator after WS-3 W3a-W3d wave.
export * from './engine.js'
export * from './filters.js'
export * from './default-rules.js'
export * from './sensitivity-classifier.js'

// WS-3 W3 final wave additions (coordinator-wired).
export * from './pipeline-b.js'
export * from './engine-triggers.js'

// Ingest → workflow event-trigger adapter — the connector half of the
// workflow `event` trigger (the ingest engine `onEvent` seam). The shared
// source-agnostic dispatcher itself lives in `../workflow/event-trigger.ts`.
export * from './workflow-trigger.js'

// Agent-mediated rule edit tools — chat surface for adding / updating /
// deleting ingest rules per connector instance.
export * from './tools.js'
