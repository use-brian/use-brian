// [COMP:recordings/open-process-recording] - generic OSS recording processor.

import type { FilesApi, RecordingTranscriber } from '@use-brian/core'
import { getEpisodeByIdSystem } from '../db/episodes-store.js'
import { getRecordingSystem, updateRecording } from '../db/recordings-store.js'
import {
  insertTranscriptSegments,
  linkTranscriptSegmentsFile,
  segmentTranscript,
} from '../db/transcript-segments-store.js'
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
    getEpisode?: typeof getEpisodeByIdSystem
    getRecording?: typeof getRecordingSystem
    probe?: typeof probeRecordingDuration
    extract?: typeof extractRecordingAudio
    insertSegments?: typeof insertTranscriptSegments
    filesApi?: FilesApi
    persistTranscript?: (input: PersistTranscriptInput) => Promise<PersistedTranscript | null>
    linkTranscriptFile?: (recordingId: string, transcriptFileId: string) => Promise<void>
    synthesize?: RecordingSynthesizeFn
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
  const source = (episode.sourceRef ?? {}) as { gcsKey?: string; storageUri?: string | null }
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

  const segments = segmentTranscript(transcription.utterances)
  const segmentsInserted = await (deps.insertSegments ?? insertTranscriptSegments)({
    recordingId: episode.id,
    workspaceId: episode.workspaceId,
    createdByUserId: job.actingUserId,
    visibility: { userId: episode.userId, assistantId: episode.assistantId },
    sensitivity: episode.sensitivity,
    segments,
  })

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
        utterances: transcription.utterances,
        title: recording?.title ?? recording?.fileName ?? null,
      })
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

  const text = transcription.utterances
    .map((utterance) => `${utterance.speaker ? `${utterance.speaker}: ` : ''}${utterance.text}`)
    .join('\n')
  await deps.brainIngestor({
    workspaceId: episode.workspaceId,
    userId: job.actingUserId,
    assistantId: episode.assistantId ?? '',
    content: text,
    occurredAt: new Date(),
    sourceLabel: 'recording',
    sourceKind: 'voice_memo',
    sourceRef: { connector: 'programmatic', label: 'recording', recording_id: episode.id },
    parentEpisodeId: episode.id,
    sensitivity: episode.sensitivity,
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
        parentPageId: job.parentPageId ?? null,
      })
    } catch (err) {
      console.error(`[process-recording] synthesis failed for ${episode.id} (non-fatal):`, err)
    }
  }
  return { truncated: transcription.truncated, segmentsInserted, durationMs }
}
