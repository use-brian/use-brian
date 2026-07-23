/** OSS recording upload and queue routes. [COMP:recordings/open-routes] */

import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import {
  createEpisode,
  getEpisodeByIdSystem,
  mergeEpisodeSourceRef,
} from '../db/episodes-store.js'
import { createRecording, getRecording, updateRecording } from '../db/recordings-store.js'
import type { FilesClientResolver } from '../files/files-api.js'
import { buildStorageKey, buildStorageUri } from '../files/gcs-client.js'
import { probeRecordingDuration } from '../recordings/ffmpeg.js'

const MAX_RECORDING_DURATION_MS = 180 * 60 * 1000

type RouteDeps = {
  filesResolver: FilesClientResolver
  getRole: (userId: string, workspaceId: string) => Promise<string | null>
  enqueueJob: (input: {
    recordingId: string
    workspaceId: string
    actingUserId: string
  }) => Promise<{ enqueued: boolean; jobId: string | null }>
  hasProcessed: (recordingId: string) => Promise<boolean>
  probe?: typeof probeRecordingDuration
  createEpisode?: typeof createEpisode
  createRecording?: typeof createRecording
  getRecording?: typeof getRecording
  getEpisode?: typeof getEpisodeByIdSystem
  updateRecording?: typeof updateRecording
  mergeEpisodeSourceRef?: typeof mergeEpisodeSourceRef
}

function userIdOf(req: unknown): string | undefined {
  return (req as { userId?: string }).userId
}

function probeFailureDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.startsWith('ffprobe prerequisite failed:')
    ? message
    : `Could not read recording duration: ${message}`
}

async function recordingStorage(
  deps: RouteDeps,
  workspaceId: string,
  source: { storageUri?: string | null },
) {
  return source.storageUri
    ? deps.filesResolver.forUri(workspaceId, source.storageUri)
    : (await deps.filesResolver.forWorkspace(workspaceId)).gcs
}

export function openRecordingsRoutes(deps: RouteDeps): Router {
  const router = Router()

  router.get('/:recordingId/media-url', async (req, res) => {
    const userId = userIdOf(req)
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const recording = await (deps.getRecording ?? getRecording)(userId, req.params.recordingId)
    if (!recording) return void res.status(404).json({ error: 'Recording not found' })
    const storage = recording.storageUri
      ? await deps.filesResolver.forUri(recording.workspaceId, recording.storageUri)
      : (await deps.filesResolver.forWorkspace(recording.workspaceId)).gcs
    const ttlSec = 10 * 60
    const url = await storage.signedReadUrl(recording.gcsKey, ttlSec)
    res.json({
      url,
      expiresAt: new Date(Date.now() + ttlSec * 1000).toISOString(),
      mime: recording.mime,
      durationMs: recording.durationMs,
    })
  })

  router.post('/upload-url', async (req, res) => {
    const userId = userIdOf(req)
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const { workspaceId, assistantId, fileName, mime, kind } = (req.body ?? {}) as {
      workspaceId?: string
      assistantId?: string
      fileName?: string
      mime?: string
      kind?: string
    }
    if (!workspaceId || !assistantId || !mime) {
      return void res.status(400).json({ error: 'workspaceId, assistantId, and mime are required' })
    }
    if (!mime.startsWith('audio/') && !mime.startsWith('video/')) {
      return void res.status(400).json({ error: 'Only audio/video recordings are supported' })
    }
    if (kind !== undefined && kind !== 'memo' && kind !== 'meeting') {
      return void res.status(400).json({ error: "kind must be 'memo' or 'meeting'" })
    }
    if (!(await deps.getRole(userId, workspaceId))) {
      return void res.status(403).json({ error: 'Not a member of this workspace' })
    }

    const fileId = randomUUID()
    const key = buildStorageKey(workspaceId, `recordings/${fileId}`)
    const resolved = await deps.filesResolver.forWorkspace(workspaceId)
    const storageUri = buildStorageUri(resolved.bucket, workspaceId, `recordings/${fileId}`, resolved.uriScheme)
    const episode = await (deps.createEpisode ?? createEpisode)(userId, {
      sourceKind: 'recording',
      sourceRef: { fileId, gcsKey: key, storageUri, fileName: fileName ?? null, mime, status: 'awaiting_upload' },
      occurredAt: new Date(),
      workspaceId,
      userId: null,
      assistantId,
      createdByUserId: userId,
      sensitivity: 'internal',
    })
    await (deps.createRecording ?? createRecording)({
      id: episode.id,
      workspaceId,
      mime,
      gcsKey: key,
      storageUri,
      fileName: fileName ?? null,
      title: fileName ?? null,
      ...(kind ? { kind } : {}),
      userId: null,
      assistantId,
      sensitivity: 'internal',
      createdByUserId: userId,
    })
    const uploadUrl = await resolved.gcs.signedWriteUrl(key, { contentType: mime, ttlSec: 3600 })
    res.json({ recordingId: episode.id, uploadUrl, key })
  })

  router.post('/:recordingId/estimate', async (req, res) => {
    const userId = userIdOf(req)
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const episode = await (deps.getEpisode ?? getEpisodeByIdSystem)(userId, req.params.recordingId, {})
    if (!episode) return void res.status(404).json({ error: 'Recording not found' })
    if (!(await deps.getRole(userId, episode.workspaceId))) return void res.status(403).json({ error: 'Forbidden' })
    const source = (episode.sourceRef ?? {}) as { gcsKey?: string; storageUri?: string | null }
    if (!source.gcsKey) return void res.status(400).json({ error: 'Recording has no stored audio' })

    try {
      const storage = await recordingStorage(deps, episode.workspaceId, source)
      const durationMs = await (deps.probe ?? probeRecordingDuration)(await storage.signedReadUrl(source.gcsKey, 600))
      if (durationMs > MAX_RECORDING_DURATION_MS) {
        return void res.status(413).json({ error: 'too_long', ceilingMinutes: 180 })
      }
      res.json({
        recordingId: episode.id,
        durationMs,
        durationSeconds: Math.round(durationMs / 1000),
        surchargeCredits: 0,
      })
    } catch (err) {
      const detail = probeFailureDetail(err)
      console.error(`[recordings] estimate failed for ${episode.id}: ${detail}`)
      res.status(422).json({
        error: 'could_not_read_duration',
        detail,
      })
    }
  })

  router.post('/:recordingId/process', async (req, res) => {
    const userId = userIdOf(req)
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const episode = await (deps.getEpisode ?? getEpisodeByIdSystem)(userId, req.params.recordingId, {})
    if (!episode) return void res.status(404).json({ error: 'Recording not found' })
    if (!(await deps.getRole(userId, episode.workspaceId))) return void res.status(403).json({ error: 'Forbidden' })
    const source = (episode.sourceRef ?? {}) as { gcsKey?: string; storageUri?: string | null }
    if (!source.gcsKey) return void res.status(400).json({ error: 'Recording has no stored audio' })
    if (req.body?.confirm !== true && (await deps.hasProcessed(episode.id))) {
      return void res.status(409).json({
        requiresConfirmation: true,
        reason: 'already_processed',
        recordingId: episode.id,
      })
    }

    let durationMs: number
    try {
      const storage = await recordingStorage(deps, episode.workspaceId, source)
      durationMs = await (deps.probe ?? probeRecordingDuration)(await storage.signedReadUrl(source.gcsKey, 600))
    } catch (err) {
      const detail = probeFailureDetail(err)
      console.error(`[recordings] process preflight failed for ${episode.id}: ${detail}`)
      return void res.status(422).json({ error: 'could_not_read_duration', detail })
    }
    if (durationMs > MAX_RECORDING_DURATION_MS) return void res.status(413).json({ error: 'too_long' })

    const { jobId } = await deps.enqueueJob({
      recordingId: episode.id,
      workspaceId: episode.workspaceId,
      actingUserId: episode.createdByUserId,
    })
    await (deps.updateRecording ?? updateRecording)(episode.id, { status: 'queued', durationMs })
    await (deps.mergeEpisodeSourceRef ?? mergeEpisodeSourceRef)(episode.createdByUserId, episode.id, { status: 'queued' })
    res.status(202).json({ recordingId: episode.id, status: 'queued', jobId })
  })

  return router
}
