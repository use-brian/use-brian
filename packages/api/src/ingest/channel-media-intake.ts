// [COMP:brain/channel-media-intake] — the universal, channel-agnostic media
// intake (channel-media-ingest Phase 3 + Phase 6 metering).
//
// Every channel adapter (WhatsApp push, Slack/Discord pull) does ONE thing:
// land the bytes in GCS and hand this a normalized `ChannelMediaRef`. From here
// the path is shared:
//   • audio/video → a `recording` Episode anchored at the GCS key + an
//     enqueued recording_jobs row → the Phase-2 worker (ffmpeg extract →
//     transcribe → Pipeline B). The source is never downloaded here.
//   • document (pdf / office / text) → the injected `ingestDocument` port
//     (download-bounded → parse → Pipeline B).
//   • anything else → rejected.
//
// A per-call size cap + an injected `checkQuota` (Phase 6) bound abuse from
// external senders. All collaborators are injected so this unit-tests without a
// DB, GCS, or a worker. See docs/plans/channel-media-ingest.md §Phase 3.

import type { CreateEpisodeInput, EpisodeRecord, EpisodeSensitivity } from '../db/episodes-store.js'
import type { Recording } from '../db/recordings-store.js'
import { buildChannelSessionKey } from '../db/pending-recording-confirmations-store.js'

/** A normalized inbound attachment whose bytes are already in GCS. */
export type ChannelMediaRef = {
  /** Originating channel, for provenance + metering. */
  channel: 'whatsapp' | 'slack' | 'discord' | 'telegram'
  /** GCS object key the adapter wrote the bytes to. */
  gcsKey: string
  /**
   * Full `gs://<bucket>/<key>` URI when the bytes were written to the
   * workspace's own (BYO) bucket. Absent → the bytes are in the platform bucket
   * (all non-BYO workspaces and every pre-BYO ref). Recorded on the episode so
   * every later read (worker, media-fetch) routes to the right bucket.
   */
  storageUri?: string | null
  mime: string
  fileName: string | null
  /** Bytes, when known (content-length / Baileys fileLength). */
  sizeBytes: number | null
  /** The external sender (phone / Slack user / Discord user) — provenance + metering. */
  sender: { id: string; name: string | null }
  /**
   * The conversation/chat id the media arrived in (Slack channel, WhatsApp chat
   * jid, Telegram chat id, Discord channel). Used with `channel` + `actingUserId`
   * to build the pre-flight-confirm correlation key so the user's reply turn can
   * find the pending row. Optional: when absent, a big recording falls back to
   * enqueueing (the confirm cannot be correlated). See
   * docs/architecture/engine/preflight-confirmation.md §5.
   */
  conversationId?: string | null
  workspaceId: string
  assistantId: string | null
  /** Episode creator + COGS / surcharge attribution (the channel/workspace owner). */
  actingUserId: string
  sensitivity?: EpisodeSensitivity
  /**
   * Transcription opt-out (default: transcribe). When `false`, an audio/video
   * `recording` Episode is still anchored at the GCS key (so media-fetch can
   * resolve it, e.g. for an external highlights integration) but the
   * pre-flight-confirm + transcription enqueue are skipped entirely. Set by a
   * caller that consumes the raw media itself. Absent/true → today's behavior.
   */
  transcribe?: boolean
}

export type ChannelMediaKind = 'audio_video' | 'document' | 'unsupported'

/** v1 document set — what `parseFileContent` / the distiller can turn into text. */
const DOCUMENT_MIME_PREFIXES = ['application/pdf', 'text/', 'application/json']
const DOCUMENT_MIME_EXACT = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
]

export function classifyMedia(mime: string): ChannelMediaKind {
  const m = mime.toLowerCase()
  if (m.startsWith('audio/') || m.startsWith('video/')) return 'audio_video'
  if (DOCUMENT_MIME_PREFIXES.some((p) => m.startsWith(p)) || DOCUMENT_MIME_EXACT.includes(m)) {
    return 'document'
  }
  return 'unsupported'
}

export type ChannelMediaIntakeDeps = {
  /** open episodes-store `createEpisode(actorUserId, input)`. */
  createEpisode: (actorUserId: string, input: CreateEpisodeInput) => Promise<EpisodeRecord>
  /** First-class recording state used by the recording UI and worker. */
  createRecording: (input: {
    id: string
    workspaceId: string
    mime: string
    gcsKey: string
    storageUri?: string | null
    fileName?: string | null
    bytes?: number | null
    status?: import('../db/recordings-store.js').RecordingStatus
    assistantId: string | null
    userId?: string | null
    sensitivity?: string
    createdByUserId: string
  }) => Promise<Recording>
  /** open recording-jobs-store `enqueueRecordingJob`. */
  enqueueRecordingJob: (input: {
    recordingId: string
    workspaceId: string
    actingUserId: string
    blueprintSlug?: string | null
  }) => Promise<{ enqueued: boolean; jobId: string | null }>
  /** Document path (download-bounded → parse → Pipeline B). Absent → documents rejected. */
  ingestDocument?: (args: {
    gcsKey: string
    /** BYO storage URI when the bytes live in the workspace's own bucket; else null. */
    storageUri?: string | null
    mime: string
    fileName: string | null
    sizeBytes: number | null
    workspaceId: string
    assistantId: string | null
    actingUserId: string
    sensitivity: EpisodeSensitivity
  }) => Promise<ChannelDocumentIngestResult>
  /** Phase 6 metering. Absent → no quota enforcement. */
  checkQuota?: (ref: ChannelMediaRef) => Promise<{ ok: boolean; reason?: string }>
  /**
   * Resolve the workspace's default recording blueprint at the ENQUEUE EDGE
   * (selection ladder `explicit ?? workspace default ?? none`, decision D2). A
   * channel recording has no human picker, so the default (or `null` for
   * ingest-only) is resolved here and stored on the job verbatim — the worker
   * never re-resolves. Absent → no default (ingest-only). Null-safe: a lookup
   * failure resolves to `null`, never blocking the recording. See
   * docs/architecture/brain/structural-synthesis.md §D2.
   */
  resolveWorkspaceDefaultBlueprint?: (workspaceId: string) => Promise<string | null>
  /**
   * Pre-flight-confirm wiring (channel-recording-preflight-confirm §5). When ALL
   * of these are present, a BIG (surcharge-incurring) recording is NOT enqueued:
   * the intake does a cheap duration probe, stores a pending confirmation, and
   * returns `{ status: 'pending_confirmation', message }` so the channel route
   * can send the ask. Small (no-surcharge) recordings always enqueue as before.
   * When any are absent (no GCS read URL, no store) → today's behavior (enqueue),
   * so the confirm is purely additive and fail-open.
   */
  preflightConfirm?: {
    /** Short-lived signed READ url for ffprobe (no full download). Routed to the
     *  bytes' bucket via `storageUri` (BYO) or the platform bucket when absent. */
    signedReadUrl: (args: { gcsKey: string; workspaceId: string; storageUri?: string | null }) => Promise<string>
    /** Probe the recording's duration in ms (ffprobe over the signed url). */
    probeDurationMs: (signedUrl: string) => Promise<number>
    /** Surcharge credits for a duration; 0 == small == enqueue immediately. */
    surchargeCredits: (durationSeconds: number) => number
    /** Persist the pending confirmation (keyed by recordingId). */
    storePending: (input: {
      recordingId: string
      channelSessionKey: string
      durationSeconds: number
      surchargeCredits: number
      defaultBlueprintSlug: string | null
      fileLabel: string | null
    }) => Promise<{ inserted: boolean }>
    /** Build the templated ask copy (cheap, no LLM). */
    buildAsk: (input: {
      durationSeconds: number
      surchargeCredits: number
      hasDefaultBlueprint: boolean
      fileLabel: string | null
    }) => string
  }
  /** Hard byte ceiling (defence-in-depth; the connector also caps at the wire). */
  maxBytes?: number
}

/**
 * What the injected `ingestDocument` port reports back. Every arm that a user
 * would care about maps onto a `ChannelMediaIntakeResult` the route can turn
 * into a reply — the silent `{ episodeId: null }` drop is dead
 * (large-content-artifacts §Phase 0.1).
 */
export type ChannelDocumentIngestResult =
  | {
      status: 'accepted'
      episodeId: string | null
      /** Set on the durable-artifact path (§Phase 3.3): the workspace_files id + path. */
      fileId?: string
      path?: string
    }
  | { status: 'too_large'; sizeBytes: number; limitBytes: number }
  | { status: 'storage_quota' }
  | { status: 'skipped_no_assistant' }
  | { status: 'empty' }

export type ChannelMediaIntakeResult =
  | { status: 'queued'; kind: 'audio_video'; recordingId: string; jobId: string | null }
  | {
      // A BIG recording — probed, a pending confirmation stored, NOT enqueued. The
      // channel route sends `message` and waits for the user's reply turn. See
      // docs/architecture/engine/preflight-confirmation.md §5.
      status: 'pending_confirmation'
      kind: 'audio_video'
      recordingId: string
      durationSeconds: number
      surchargeCredits: number
      message: string
    }
  | {
      status: 'ingested'
      kind: 'document'
      episodeId: string | null
      fileName: string | null
      /** Set on the durable-artifact path (§Phase 3.3). */
      fileId?: string
      path?: string
    }
  | {
      // Document arms a route should NOT reply to: an unbound assistant or an
      // empty/unreadable parse. Distinct from 'rejected' so routes can stay
      // quiet without lying about an ingest that never happened.
      status: 'skipped'
      kind: 'document'
      reason: 'no_assistant' | 'empty'
    }
  | {
      status: 'rejected'
      reason:
        | 'unsupported'
        | 'too_large'
        | 'quota'
        | 'no_document_handler'
        | 'doc_too_large'
        | 'doc_storage_quota'
      /** Set for 'doc_too_large' so routes can build the handoff copy. */
      sizeMb?: number
      limitMb?: number
    }

/** Default ceiling matches the channel-media-ingest plan (≤500 MB). */
export const DEFAULT_CHANNEL_MEDIA_MAX_BYTES = 500 * 1024 * 1024

export async function ingestChannelMedia(
  ref: ChannelMediaRef,
  deps: ChannelMediaIntakeDeps,
): Promise<ChannelMediaIntakeResult> {
  const maxBytes = deps.maxBytes ?? DEFAULT_CHANNEL_MEDIA_MAX_BYTES
  if (ref.sizeBytes != null && ref.sizeBytes > maxBytes) {
    return { status: 'rejected', reason: 'too_large' }
  }

  const kind = classifyMedia(ref.mime)
  if (kind === 'unsupported') return { status: 'rejected', reason: 'unsupported' }

  if (deps.checkQuota) {
    const q = await deps.checkQuota(ref)
    if (!q.ok) return { status: 'rejected', reason: 'quota' }
  }

  const sensitivity: EpisodeSensitivity = ref.sensitivity ?? 'internal'

  if (kind === 'audio_video') {
    // Anchor a recording Episode at the GCS object, attributed to the channel
    // owner with the external sender captured as provenance, then enqueue. The
    // Phase-2 worker does the heavy (space-efficient) processing.
    const episode = await deps.createEpisode(ref.actingUserId, {
      sourceKind: 'recording',
      sourceRef: {
        gcsKey: ref.gcsKey,
        // Stamped only for BYO writes; absent → platform bucket on every read.
        ...(ref.storageUri ? { storageUri: ref.storageUri } : {}),
        mime: ref.mime,
        fileName: ref.fileName,
        status: 'awaiting_process',
        source: { channel: ref.channel, sender: ref.sender },
      },
      occurredAt: new Date(),
      workspaceId: ref.workspaceId,
      userId: null, // workspace-shared via the assistant
      assistantId: ref.assistantId,
      createdByUserId: ref.actingUserId,
      sensitivity,
    })
    await deps.createRecording({
      id: episode.id,
      workspaceId: ref.workspaceId,
      mime: ref.mime,
      gcsKey: ref.gcsKey,
      storageUri: ref.storageUri ?? null,
      fileName: ref.fileName,
      bytes: ref.sizeBytes,
      status: 'queued',
      assistantId: ref.assistantId,
      userId: null,
      sensitivity,
      createdByUserId: ref.actingUserId,
    })
    // Store-without-transcribe (highlights-only): the caller wants the recording
    // Episode to exist so media-fetch can resolve it (e.g. an external highlights
    // integration pulls the raw video), but NOT the transcription pipeline. Skip
    // the pre-flight-confirm + enqueue. See docs/architecture/channels/whatsapp.md.
    if (ref.transcribe === false) {
      return { status: 'queued', kind: 'audio_video', recordingId: episode.id, jobId: null }
    }
    // Selection ladder at the enqueue edge (D2): a channel recording has no
    // human picker, so resolve the workspace default (or null = ingest-only)
    // here and store it on the job verbatim — the worker uses it as-is.
    const blueprintSlug = deps.resolveWorkspaceDefaultBlueprint
      ? await deps.resolveWorkspaceDefaultBlueprint(ref.workspaceId)
      : null

    // ── Pre-flight confirm (channel-recording-preflight-confirm §5) ──
    // A BIG (surcharge-incurring) recording must not be transcribed before the
    // user consents (the pre-flight-confirm invariant). Probe the duration
    // cheaply; if it would incur a surcharge AND we can correlate the reply,
    // store a pending confirmation and return the ask instead of enqueueing.
    // Small recordings (or any missing wiring) fall through to enqueue as today.
    if (deps.preflightConfirm && ref.conversationId) {
      try {
        const signedUrl = await deps.preflightConfirm.signedReadUrl({
          gcsKey: ref.gcsKey,
          workspaceId: ref.workspaceId,
          storageUri: ref.storageUri,
        })
        const durationMs = await deps.preflightConfirm.probeDurationMs(signedUrl)
        const durationSeconds = Math.round(durationMs / 1000)
        const surchargeCredits = deps.preflightConfirm.surchargeCredits(durationSeconds)
        if (surchargeCredits > 0) {
          const channelSessionKey = buildChannelSessionKey({
            channel: ref.channel,
            channelId: ref.conversationId,
            userId: ref.actingUserId,
          })
          await deps.preflightConfirm.storePending({
            recordingId: episode.id,
            channelSessionKey,
            durationSeconds,
            surchargeCredits,
            defaultBlueprintSlug: blueprintSlug,
            fileLabel: ref.fileName,
          })
          const message = deps.preflightConfirm.buildAsk({
            durationSeconds,
            surchargeCredits,
            hasDefaultBlueprint: blueprintSlug != null,
            fileLabel: ref.fileName,
          })
          return {
            status: 'pending_confirmation',
            kind: 'audio_video',
            recordingId: episode.id,
            durationSeconds,
            surchargeCredits,
            message,
          }
        }
        // surcharge == 0 → small recording, falls through to enqueue below.
      } catch (err) {
        // ffprobe / signing / store failure must NEVER crash the detached
        // intake. Fall back to enqueueing (today's behavior) rather than
        // dropping the recording. The worker will re-probe authoritatively.
        console.error('[channel-media-intake] pre-flight probe failed, enqueueing without confirm:', err)
      }
    }

    const { jobId } = await deps.enqueueRecordingJob({
      recordingId: episode.id,
      workspaceId: ref.workspaceId,
      actingUserId: ref.actingUserId,
      blueprintSlug,
    })
    return { status: 'queued', kind: 'audio_video', recordingId: episode.id, jobId }
  }

  // document
  if (!deps.ingestDocument) return { status: 'rejected', reason: 'no_document_handler' }
  const doc = await deps.ingestDocument({
    gcsKey: ref.gcsKey,
    storageUri: ref.storageUri,
    mime: ref.mime,
    fileName: ref.fileName,
    sizeBytes: ref.sizeBytes,
    workspaceId: ref.workspaceId,
    assistantId: ref.assistantId,
    actingUserId: ref.actingUserId,
    sensitivity,
  })
  switch (doc.status) {
    case 'accepted':
      return {
        status: 'ingested',
        kind: 'document',
        episodeId: doc.episodeId,
        fileName: ref.fileName,
        ...(doc.fileId ? { fileId: doc.fileId } : {}),
        ...(doc.path ? { path: doc.path } : {}),
      }
    case 'too_large':
      return {
        status: 'rejected',
        reason: 'doc_too_large',
        sizeMb: Math.max(1, Math.round(doc.sizeBytes / (1024 * 1024))),
        limitMb: Math.round(doc.limitBytes / (1024 * 1024)),
      }
    case 'storage_quota':
      return { status: 'rejected', reason: 'doc_storage_quota' }
    case 'skipped_no_assistant':
      return { status: 'skipped', kind: 'document', reason: 'no_assistant' }
    case 'empty':
      return { status: 'skipped', kind: 'document', reason: 'empty' }
  }
}

/**
 * A document over the parse cap (`DOC_PARSE_MAX_BYTES`): same web-upload
 * handoff, but names the size so the sender understands why. Replaces the old
 * silent drop (large-content-artifacts §Phase 0.1). Lives open with the intake
 * (channels open-core move) — the closed acquirers re-export it.
 */
export function buildOversizeDocReply(uploadUrl: string, limitMb: number, sizeMb: number): string {
  return `That document is about ${sizeMb} MB, over the ${limitMb} MB I can process from chat. Upload it at ${uploadUrl} and I'll take in the whole thing.`
}

/** Confirmation that an inbound channel document was saved + queued for indexing. */
export function buildDocumentFiledReply(fileName: string | null): string {
  return fileName
    ? `Saved "${fileName}" to your workspace files and started indexing it. Give me a minute, then ask me anything about it.`
    : `Saved that document to your workspace files and started indexing it. Give me a minute, then ask me anything about it.`
}
