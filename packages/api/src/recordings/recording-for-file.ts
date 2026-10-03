/** Canonical stored-file adoption. No byte copy and no Episode/creator inference. */
import { randomUUID } from 'node:crypto'
import type { WorkspaceFile } from '@use-brian/core'
import { createRecording } from '../db/recordings-store.js'
import { captureRecordingIntakeParent } from '../db/recording-intake-admission.js'

export type RecordingForFileDeps = {
  captureParent?: typeof captureRecordingIntakeParent
  createRecording?: typeof createRecording
}
export type RecordingForFileResult =
  | { status: 'ok'; recordingId: string; adopted: boolean; alreadyProcessed: boolean }
  | { status: 'refused'; reason: 'compartmented' }

export function isMediaMime(mime: string): boolean {
  return mime.startsWith('audio/') || mime.startsWith('video/')
}

/** The input row is a locator only. The store resolves current bytes/scope,
 * creates the Episode and recording together, and serializes retry by parent. */
export async function resolveRecordingForFile(file: WorkspaceFile, actingUserId: string, deps: RecordingForFileDeps = {}): Promise<RecordingForFileResult> {
  const authority = { actorUserId: actingUserId }
  const parent = await (deps.captureParent ?? captureRecordingIntakeParent)(authority, file.workspaceId, file.id)
  const id = randomUUID()
  const recording = await (deps.createRecording ?? createRecording)({
    id, workspaceId: file.workspaceId, mime: parent.mime, gcsKey: '', assistantId: parent.assistantId,
    createdByUserId: actingUserId,
  }, { ...authority, parent })
  return { status: 'ok', recordingId: recording.id, adopted: recording.id === id, alreadyProcessed: recording.status === 'processed' }
}
