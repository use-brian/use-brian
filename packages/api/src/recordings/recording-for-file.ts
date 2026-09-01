/**
 * Resolve the RECORDING that owns a stored audio/video file, adopting one when
 * the file has never had a recording. [COMP:recordings/recording-for-file]
 *
 * WHY THIS EXISTS. `POST /api/files/:fileId/ingest` refuses audio and video
 * (`media_owned_by_recordings`) because media belongs to the transcription
 * pipeline, not to file ingest — correct, and until now a dead end: the brain
 * drawer's "Re-ingest to brain" button offered the refused lane on every file,
 * the client discarded the server's reason, and the user got one red line with
 * nowhere to go (2026-09-01). Refusing is only half an answer. This is the
 * other half: the same click routes to the pipeline that CAN do the work.
 *
 * THE BYTES ARE NEVER COPIED. A recording's audio already sits in storage; a
 * media `workspace_files` row is a row-only index over it
 * (`api-platform/src/recordings/media-artifact.ts`). Adoption therefore writes
 * rows only — an Episode anchor plus its `recordings` row, both pointing at the
 * file's own `storage_uri` — and no byte moves. `storageKeyForWorkspaceFile` is
 * what makes that safe: the key comes out of the row's URI rather than being
 * re-derived, which is the same rule the readers now follow.
 *
 * IDEMPOTENT ON PURPOSE. Two clicks, one recording. Resolution walks three
 * steps in descending authority: the file's `source_episode_id` back-edge when
 * it names a recording Episode; then any recording already carrying this file
 * as its `media_file_id`; only then adopt. Skipping the second step would mint
 * a second recording for a file whose back-edge was never stamped, and a user
 * would pay the duration surcharge twice for one piece of audio.
 *
 * This function starts NOTHING. It neither probes nor enqueues: the caller
 * still runs estimate → cost/blueprint confirmation → process, so the
 * pre-flight-confirmation invariant is untouched
 * (docs/architecture/engine/preflight-confirmation.md).
 */

import type { WorkspaceFile } from '@use-brian/core'
import {
  createEpisode,
  getEpisodeByIdSystem,
  type EpisodeSensitivity,
} from '../db/episodes-store.js'
import {
  createRecording,
  getRecordingByMediaFileSystem,
  getRecordingSystem,
  updateRecording,
} from '../db/recordings-store.js'
import { storageKeyForWorkspaceFile } from '../files/local-directory-import.js'

export type RecordingForFileDeps = {
  getEpisode?: typeof getEpisodeByIdSystem
  getRecording?: typeof getRecordingSystem
  getRecordingByMediaFile?: typeof getRecordingByMediaFileSystem
  createEpisode?: typeof createEpisode
  createRecording?: typeof createRecording
  updateRecording?: typeof updateRecording
}

export type RecordingForFileResult =
  | {
      status: 'ok'
      recordingId: string
      /** True when this call created the recording rows (no byte was moved). */
      adopted: boolean
      /**
       * Whether a processing run already COMPLETED for this recording. The
       * caller needs it BEFORE it opens its confirmation, because a re-run
       * re-transcribes and can duplicate extracted memories - the dialog has to
       * say so in the same breath as the cost (transcription.md
       * §"Re-processing"). Never inferred from `adopted`: an adopted recording
       * is new, but a resolved one may be either.
       */
      alreadyProcessed: boolean
    }
  /**
   * A compartmented file cannot be adopted. `recordings` carries no
   * compartments column and neither `createRecording` nor `updateRecording`
   * accepts one, so adoption would file the transcript workspace-wide and
   * quietly widen the file's own scope. Refusing is the honest answer until the
   * pipeline carries compartments; an EXISTING recording is returned normally,
   * because that one was already scoped when it was created.
   */
  | { status: 'refused'; reason: 'compartmented' }

export function isMediaMime(mime: string): boolean {
  return mime.startsWith('audio/') || mime.startsWith('video/')
}

/**
 * Files carry a 3-tier sensitivity, Episodes a 4-tier one. `confidential`
 * collapses to `private`, the same mapping room / WhatsApp / mailbox ingest
 * already use — never to a wider tier, because the adopted Episode inherits
 * what the file was already marked.
 */
function toEpisodeSensitivity(s: 'public' | 'internal' | 'confidential'): EpisodeSensitivity {
  return s === 'confidential' ? 'private' : s
}

export async function resolveRecordingForFile(
  file: WorkspaceFile,
  actingUserId: string,
  deps: RecordingForFileDeps = {},
): Promise<RecordingForFileResult> {
  const getEpisode = deps.getEpisode ?? getEpisodeByIdSystem
  const getRecording = deps.getRecording ?? getRecordingSystem
  const getByMediaFile = deps.getRecordingByMediaFile ?? getRecordingByMediaFileSystem

  // 1. The back-edge the media indexer stamps (`sourceEpisodeId: recordingId`).
  //    Verified, never trusted: a non-recording Episode here would mean the
  //    file was ingested through some other boundary, and adopting is right.
  if (file.sourceEpisodeId) {
    const episode = await getEpisode(actingUserId, file.sourceEpisodeId, {})
    if (episode?.sourceKind === 'recording' && episode.workspaceId === file.workspaceId) {
      return {
        status: 'ok',
        recordingId: episode.id,
        adopted: false,
        alreadyProcessed: (await getRecording(episode.id))?.status === 'processed',
      }
    }
  }

  // 2. A recording that already owns these bytes but whose back-edge never
  //    landed on the file row. Without this the button adopts a duplicate.
  const owner = await getByMediaFile(file.workspaceId, file.id)
  if (owner) {
    return {
      status: 'ok',
      recordingId: owner.id,
      adopted: false,
      alreadyProcessed: owner.status === 'processed',
    }
  }

  if ((file.compartments ?? []).length > 0) return { status: 'refused', reason: 'compartmented' }

  // 3. Adopt. Rows only — the audio stays exactly where it is.
  const gcsKey = storageKeyForWorkspaceFile(file)
  const episode = await (deps.createEpisode ?? createEpisode)(actingUserId, {
    sourceKind: 'recording',
    sourceRef: {
      fileId: file.id,
      gcsKey,
      storageUri: file.storageUri,
      fileName: file.name,
      mime: file.mime,
      status: 'awaiting_upload',
    },
    occurredAt: new Date(),
    workspaceId: file.workspaceId,
    // Workspace-shared via the assistant, mirroring an uploaded recording.
    userId: null,
    assistantId: file.assistantId ?? null,
    createdByUserId: actingUserId,
    sensitivity: toEpisodeSensitivity(file.sensitivity),
  })
  await (deps.createRecording ?? createRecording)({
    id: episode.id,
    workspaceId: file.workspaceId,
    mime: file.mime,
    gcsKey,
    storageUri: file.storageUri,
    fileName: file.name,
    title: file.title ?? file.name,
    bytes: file.sizeBytes,
    userId: null,
    assistantId: file.assistantId ?? null,
    sensitivity: file.sensitivity,
    createdByUserId: actingUserId,
  })
  // Close the loop the indexer would have closed, so a second click resolves
  // through step 2 instead of adopting again.
  await (deps.updateRecording ?? updateRecording)(episode.id, { mediaFileId: file.id })
  return { status: 'ok', recordingId: episode.id, adopted: true, alreadyProcessed: false }
}
