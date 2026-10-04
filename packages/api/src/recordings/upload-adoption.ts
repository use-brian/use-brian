import type { WorkspaceFile } from '@use-brian/core'
import type { Response } from 'express'
import { ChunkedUploadError } from '../files/chunked-upload.js'
import { isMediaMime, resolveRecordingForFile, type RecordingForFileDeps } from './recording-for-file.js'

export type UploadAdoptionDeps = RecordingForFileDeps

/** The file is returned by canonical publication, never supplied by the caller. */
export async function adoptRecordingUpload(file: WorkspaceFile, userId: string, workspaceId: string, kind: 'memo' | 'meeting' | undefined, deps: UploadAdoptionDeps) {
  if (file.workspaceId !== workspaceId || !isMediaMime(file.mime)) throw new ChunkedUploadError('invalid', 'Expected a canonical audio/video file in this workspace')
  const result = await resolveRecordingForFile(file, userId, deps, { kind })
  if (result.status !== 'ok') throw new Error('recording_upload_adoption_refused')
  return result.recordingId
}

export function sendRecordingUploadError(res: Response, error: unknown) {
  if (error instanceof Error && error.message === 'recording_kind_conflict') {
    return void res.status(409).json({ error: 'recording_kind_conflict' })
  }
  if (error instanceof ChunkedUploadError) {
    const status = error.kind === 'invalid' ? 400 : error.kind === 'not_found' ? 404
      : error.kind === 'expired' ? 410 : error.kind === 'too_large' || error.kind === 'quota_exceeded' ? 413 : 409
    return void res.status(status).json({ error: error.kind, detail: error.message })
  }
  console.error('[recordings] upload preparation failed:', error)
  res.status(503).json({ error: 'recording_upload_preparation_failed' })
}
