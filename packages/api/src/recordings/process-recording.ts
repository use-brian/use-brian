// [COMP:recordings/open-process-recording] - generic OSS recording processor.

import type { FilesApi, RecordingTranscriber } from '@use-brian/core'
import { captureRecordingSegmentProvenance, type RecordingSegmentProvenance } from '../db/recording-intake-admission.js'
import { getEpisodeByIdSystem } from '../db/episodes-store.js'
import { getRecordingSystem, updateRecording } from '../db/recordings-store.js'
import { getWorkspacePrimaryAssistant } from '../db/users.js'
import {
  insertTranscriptSegments,
  linkTranscriptSegmentsFile,
  mergeVisualSegments,
  segmentTranscript,
} from '../db/transcript-segments-store.js'
import {
  interleaveTranscriptText,
  type RecordingFrameAnalyzer,
  type VisualMoment,
} from './frame-analysis.js'
import type { FilesClientResolver } from '../files/files-api.js'
import type { GcsFilesClient } from '../files/gcs-client.js'
import type { BrainEpisodeIngestor } from '../ingest-port.js'
import type { RecordingSynthesizeFn } from '../synthesis/recording-synthesizer.js'
import { extractRecordingAudio, probeRecordingDuration } from './ffmpeg.js'
import {
  createTranscriptArtifactWriter,
  type PersistTranscriptInput,
  type PersistedTranscript,
} from './transcript-artifact.js'

export type OpenRecordingProcessResult = { truncated: boolean; segmentsInserted: number; durationMs: number }

export async function processOpenRecording(
  job: {
    recordingId: string
    actingUserId: string
    blueprintSlug?: string | null
    parentPageId?: string | null
  },
  deps: {
    filesResolver: FilesClientResolver
    fallbackStorage: GcsFilesClient
    transcriber?: RecordingTranscriber
    brainIngestor?: BrainEpisodeIngestor
    /** Pipeline B owner for a workspace-shared recording; defaults to the workspace primary. */
    resolvePrimaryAssistantId?: (actingUserId: string, workspaceId: string) => Promise<string | null>
    getEpisode?: typeof getEpisodeByIdSystem
    getRecording?: typeof getRecordingSystem
    probe?: typeof probeRecordingDuration
    extract?: typeof extractRecordingAudio
    captureProvenance?: typeof captureRecordingSegmentProvenance
    insertSegments?: typeof insertTranscriptSegments
    filesApi?: FilesApi
    persistTranscript?: (input: PersistTranscriptInput, provenance: RecordingSegmentProvenance) => Promise<PersistedTranscript | null>
    linkTranscriptFile?: (recordingId: string, transcriptFileId: string) => Promise<void>
    synthesize?: RecordingSynthesizeFn
    /**
     * Video keyframe analysis (transcription.md → "Video frame analysis").
     * Runs only for a `video/*` recording; failure-isolated — a vision outage
     * degrades the recording to audio-only, it never fails the job.
     */
    analyzeFrames?: RecordingFrameAnalyzer
  },
): Promise<OpenRecordingProcessResult> {
  if (!deps.transcriber) {
    throw new Error('recording transcriber prerequisite missing: configure GEMINI_API_KEY or DASHSCOPE_API_KEY')
  }
  if (!deps.brainIngestor) {
    throw new Error('recording Pipeline B prerequisite missing: wire buildEpisodeIngestors')
  }
  const episode = await (deps.getEpisode ?? getEpisodeByIdSystem)(job.actingUserId, job.recordingId, {})
  if (!episode) throw new Error(`recording ${job.recordingId} not found`)
  const provenance = await (deps.captureProvenance ?? captureRecordingSegmentProvenance)({ actorUserId: job.actingUserId }, episode.workspaceId, job.recordingId)
  const source = { gcsKey: provenance.recordingStorageKey, storageUri: provenance.parent.storageUri }
  if (!source.gcsKey) throw new Error(`recording ${job.recordingId} has no storage key`)

  const storage = source.storageUri
    ? await deps.filesResolver.forUri(episode.workspaceId, source.storageUri)
    : deps.fallbackStorage
  const readUrl = await storage.signedReadUrl(source.gcsKey, 3600)
  const durationMs = await (deps.probe ?? probeRecordingDuration)(readUrl)
  if (durationMs > 180 * 60 * 1000) throw new Error('recording exceeds the 180 minute limit')
  const audio = await (deps.extract ?? extractRecordingAudio)(readUrl)
  const recording = await (deps.getRecording ?? getRecordingSystem)(job.recordingId)
  // URL-submit providers cannot reliably treat the original video container as
  // audio. For local storage, stage the already-extracted 16 kHz M4A track behind
  // the public signed endpoint, then remove it as soon as transcription settles.
  const stagedKey = source.storageUri?.startsWith('file://')
    ? `${source.gcsKey}.transcription.m4a`
    : null
  let transcriptionUrl = readUrl
  if (stagedKey) {
    await storage.writeBlob(stagedKey, audio.buffer, {
      workspaceId: episode.workspaceId,
      createdByUserId: job.actingUserId,
      mime: audio.mime,
    })
    transcriptionUrl = await storage.signedReadUrl(stagedKey, 3600)
  }

  let transcription: Awaited<ReturnType<RecordingTranscriber['transcribe']>>
  try {
    transcription = await deps.transcriber.transcribe({
      buffer: audio.buffer,
      mime: audio.mime,
      durationMs,
      sourceUrl: transcriptionUrl,
      displayName: recording?.title ?? recording?.fileName ?? undefined,
    })
  } finally {
    if (stagedKey) await storage.deleteBlob(stagedKey).catch(() => {})
  }
  if (transcription.utterances.length === 0) throw new Error('transcriber returned an empty transcript')

  // Video keyframe analysis — additive and failure-isolated, matching every
  // other optional step: a vision failure logs and the recording proceeds
  // audio-only. The mime decides (a video/* upload has frames worth reading;
  // running ffmpeg's decoder over plain audio is a no-op the analyzer skips).
  let visualMoments: VisualMoment[] = []
  const mime = recording?.mime ?? (episode.sourceRef as { mime?: string } | null)?.mime ?? ''
  if (deps.analyzeFrames && mime.startsWith('video/')) {
    try {
      const analysis = await deps.analyzeFrames({ sourceUrl: readUrl, durationMs })
      if (analysis) visualMoments = analysis.moments
    } catch (err) {
      console.error(`[process-recording] frame analysis failed for ${episode.id} (non-fatal):`, err)
    }
  }

  const segments = mergeVisualSegments(segmentTranscript(transcription.utterances), visualMoments)
  const segmentsInserted = await (deps.insertSegments ?? insertTranscriptSegments)({
    recordingId: episode.id,
    workspaceId: episode.workspaceId,
    createdByUserId: job.actingUserId,
    visibility: { userId: episode.userId, assistantId: episode.assistantId },
    sensitivity: episode.sensitivity,
    compartments: episode.compartments,
    projectIds: episode.projectIds,
    segments,
  }, provenance)

  // Hosted parity step 3.5: the durable transcript is additive and isolated.
  // transcript_segments remains the retrieval substrate, so the file is marked
  // as deliberately unindexed by the shared artifact writer.
  const persistTranscript = deps.persistTranscript ?? (deps.filesApi
    ? createTranscriptArtifactWriter({ filesApi: deps.filesApi })
    : undefined)
  if (persistTranscript) {
    try {
      const artifact = await persistTranscript({
        recordingId: episode.id,
        workspaceId: episode.workspaceId,
        actingUserId: job.actingUserId,
        assistantId: episode.assistantId,
        sensitivity: episode.sensitivity,
        compartments: episode.compartments,
        projectIds: episode.projectIds,
        utterances: transcription.utterances,
        title: recording?.title ?? recording?.fileName ?? null,
      }, provenance)
      if (artifact) {
        const linkTranscriptFile = deps.linkTranscriptFile ?? (async (recordingId, transcriptFileId) => {
          await updateRecording(recordingId, { transcriptFileId })
          await linkTranscriptSegmentsFile(recordingId, transcriptFileId)
        })
        await linkTranscriptFile(episode.id, artifact.fileId)
      }
    } catch (err) {
      console.error('[process-recording] transcript artifact failed (non-fatal):', err)
    }
  }

  const text = interleaveTranscriptText(transcription.utterances, visualMoments)
  // A workspace-shared recording (no assistant partition) binds Pipeline B to the
  // workspace primary, like every other workspace-level ingest. '' is not an
  // assistant: the child episode would fail its uuid insert.
  const brainAssistantId = episode.assistantId
    ?? await (deps.resolvePrimaryAssistantId ?? (async (actor, workspace) => (await getWorkspacePrimaryAssistant(actor, workspace))?.id ?? null))(job.actingUserId, episode.workspaceId)
  if (!brainAssistantId) throw new Error('recording_brain_assistant_unavailable')
  await deps.brainIngestor({
    workspaceId: episode.workspaceId,
    userId: job.actingUserId,
    assistantId: brainAssistantId,
    content: text,
    occurredAt: new Date(),
    sourceLabel: 'recording',
    sourceKind: 'voice_memo',
    sourceRef: { connector: 'programmatic', label: 'recording', recording_id: episode.id },
    parentEpisodeId: episode.id,
    sensitivity: episode.sensitivity,
    compartments: episode.compartments,
    projectIds: episode.projectIds,
  })

  // Blueprint synthesis is opt-in, additive to Pipeline B, and never runs over
  // a partial transcript. Its failure cannot turn successful ingestion into a
  // failed/retried recording job.
  const blueprintSlug = job.blueprintSlug?.trim()
  if (blueprintSlug && deps.synthesize && !transcription.truncated) {
    try {
      await deps.synthesize({
        recordingId: episode.id,
        workspaceId: episode.workspaceId,
        userId: job.actingUserId,
        assistantId: episode.assistantId ?? '',
        sensitivity: episode.sensitivity,
        blueprintSlug,
        compartments: episode.compartments,
        projectIds: episode.projectIds,
        parentPageId: job.parentPageId ?? null,
      })
    } catch (err) {
      console.error(`[process-recording] synthesis failed for ${episode.id} (non-fatal):`, err)
    }
  }
  return { truncated: transcription.truncated, segmentsInserted, durationMs }
}

/** Queue-producer lifecycle. Status is recording bookkeeping, not a mutation of
 * the Episode's immutable source_ref (which correctly invalidates derivations). */
export async function processOpenRecordingWithBookkeeping(
  job: Parameters<typeof processOpenRecording>[0], deps: Parameters<typeof processOpenRecording>[1],
): Promise<OpenRecordingProcessResult> {
  await updateRecording(job.recordingId, { status: 'processing', lastError: null })
  const result = await processOpenRecording(job, deps)
  await updateRecording(job.recordingId, {
    status: 'processed', truncated: result.truncated, durationMs: result.durationMs, lastError: null,
  })
  return result
}
