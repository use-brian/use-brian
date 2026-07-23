// [COMP:recordings/open-process-recording] - generic OSS recording processor.

import type { RecordingTranscriber } from '@use-brian/core'
import { getEpisodeByIdSystem } from '../db/episodes-store.js'
import { getRecordingSystem } from '../db/recordings-store.js'
import { insertTranscriptSegments, segmentTranscript } from '../db/transcript-segments-store.js'
import type { FilesClientResolver } from '../files/files-api.js'
import type { GcsFilesClient } from '../files/gcs-client.js'
import type { BrainEpisodeIngestor } from '../ingest-port.js'
import { extractRecordingAudio, probeRecordingDuration } from './ffmpeg.js'

export type OpenRecordingProcessResult = { truncated: boolean; segmentsInserted: number; durationMs: number }

export async function processOpenRecording(
  job: { recordingId: string; actingUserId: string },
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
  const transcription = await deps.transcriber.transcribe({
    buffer: audio.buffer,
    mime: audio.mime,
    durationMs,
    sourceUrl: readUrl,
    displayName: recording?.title ?? recording?.fileName ?? undefined,
  })
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
  return { truncated: transcription.truncated, segmentsInserted, durationMs }
}
