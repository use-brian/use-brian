/** OSS recording upload and queue routes. [COMP:recordings/open-routes] */

import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import {
  createEpisode,
  getEpisodeByIdSystem,
  mergeEpisodeSourceRef,
} from '../db/episodes-store.js'
import {
  createRecording,
  getRecording,
  listRecordings,
  LIST_RECORDINGS_LIMIT_MAX,
  updateRecording,
  type Recording,
} from '../db/recordings-store.js'
import { readRecordingRange } from '../db/retrieval-store.js'
import { listTasksBySourceEpisode } from '../db/tasks.js'
import { resolveWorkspaceViewpoint } from '../db/workspace-viewpoint.js'
import type { FilesClientResolver } from '../files/files-api.js'
import { buildStorageKey, buildStorageUri } from '../files/gcs-client.js'
import { probeRecordingDuration } from '../recordings/ffmpeg.js'

const MAX_RECORDING_DURATION_MS = 180 * 60 * 1000
export const TRANSCRIPT_PAGE = 200

type RouteDeps = {
  filesResolver: FilesClientResolver
  getRole: (userId: string, workspaceId: string) => Promise<string | null>
  enqueueJob: (input: {
    recordingId: string
    workspaceId: string
    actingUserId: string
    blueprintSlug?: string | null
    parentPageId?: string | null
  }) => Promise<{ enqueued: boolean; jobId: string | null }>
  hasProcessed: (recordingId: string) => Promise<boolean>
  resolvePageWorkspace?: (userId: string, pageId: string) => Promise<string | null>
  probe?: typeof probeRecordingDuration
  createEpisode?: typeof createEpisode
  createRecording?: typeof createRecording
  getRecording?: typeof getRecording
  listRecordings?: typeof listRecordings
  resolveViewpoint?: typeof resolveWorkspaceViewpoint
  readTranscript?: typeof readRecordingRange
  listTasks?: typeof listTasksBySourceEpisode
  getEpisode?: typeof getEpisodeByIdSystem
  updateRecording?: typeof updateRecording
  mergeEpisodeSourceRef?: typeof mergeEpisodeSourceRef
}

function toClientRecording(recording: Recording) {
  return {
    recordingId: recording.id,
    title: recording.title ?? recording.fileName,
    fileName: recording.fileName,
    kind: recording.kind,
    status: recording.status,
    mime: recording.mime,
    durationMs: recording.durationMs,
    bytes: recording.bytes,
    occurredAt: recording.createdAt,
    truncated: recording.truncated,
    lastError: recording.lastError,
    hasTranscript: recording.transcriptFileId != null,
    transcriptFileId: recording.transcriptFileId,
    participants: recording.participants,
  }
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

  router.get('/', async (req, res) => {
    const userId = userIdOf(req)
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const { workspaceId, kind, status, q, limit } = req.query as Record<string, string | undefined>
    if (!workspaceId) return void res.status(400).json({ error: 'workspaceId is required' })
    if (!(await deps.getRole(userId, workspaceId))) {
      return void res.status(403).json({ error: 'Not a member of this workspace' })
    }
    const parsedLimit = limit ? Number(limit) : undefined
    if (parsedLimit !== undefined && (!Number.isFinite(parsedLimit) || parsedLimit < 1)) {
      return void res.status(400).json({ error: 'limit must be a positive number' })
    }
    const rows = await (deps.listRecordings ?? listRecordings)(
      userId,
      workspaceId,
      {
        ...(kind === 'memo' || kind === 'meeting' ? { kind } : {}),
        ...(status ? { status: status as Recording['status'] } : {}),
        ...(q?.trim() ? { q: q.trim() } : {}),
      },
      { limit: Math.min(parsedLimit ?? 20, LIST_RECORDINGS_LIMIT_MAX) },
    )
    res.json({ recordings: rows.map(toClientRecording) })
  })

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

  router.get('/:recordingId/transcript', async (req, res) => {
    const userId = userIdOf(req)
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const recording = await (deps.getRecording ?? getRecording)(userId, req.params.recordingId)
    if (!recording) return void res.status(404).json({ error: 'Recording not found' })

    const actor = await (deps.resolveViewpoint ?? resolveWorkspaceViewpoint)(userId, recording.workspaceId)
    if (!actor) return void res.status(403).json({ error: 'Forbidden' })

    const from = Number((req.query.fromIndex as string) ?? 0)
    const rawTo = req.query.toIndex as string | undefined
    if (!Number.isFinite(from) || from < 0) {
      return void res.status(400).json({ error: 'fromIndex must be a non-negative number' })
    }
    const to = Math.min(
      rawTo !== undefined ? Number(rawTo) : from + TRANSCRIPT_PAGE - 1,
      from + TRANSCRIPT_PAGE - 1,
    )
    if (!Number.isFinite(to) || to < from) {
      return void res.status(400).json({ error: 'toIndex must be >= fromIndex' })
    }

    const segments = await (deps.readTranscript ?? readRecordingRange)(actor, {
      recordingId: recording.id,
      fromIndex: from,
      toIndex: to,
    })
    res.json({
      recordingId: recording.id,
      fromIndex: from,
      toIndex: to,
      segments,
      hasMore: segments.length === to - from + 1,
    })
  })

  router.get('/:recordingId/tasks', async (req, res) => {
    const userId = userIdOf(req)
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const recording = await (deps.getRecording ?? getRecording)(userId, req.params.recordingId)
    if (!recording) return void res.status(404).json({ error: 'Recording not found' })
    const actor = await (deps.resolveViewpoint ?? resolveWorkspaceViewpoint)(userId, recording.workspaceId)
    if (!actor) return void res.status(403).json({ error: 'Forbidden' })
    const tasks = await (deps.listTasks ?? listTasksBySourceEpisode)(actor, recording.id)
    res.json({ recordingId: recording.id, tasks })
  })

  // Keep the bare parameter route after every GET suffix so it cannot shadow
  // media, transcript, tasks, or future static read endpoints.
  router.get('/:recordingId', async (req, res) => {
    const userId = userIdOf(req)
    if (!userId) return void res.status(401).json({ error: 'Unauthorized' })
    const recording = await (deps.getRecording ?? getRecording)(userId, req.params.recordingId)
    if (!recording) return void res.status(404).json({ error: 'Recording not found' })
    res.json(toClientRecording(recording))
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
    const { blueprintSlug, confirm, parentPageId } = (req.body ?? {}) as {
      blueprintSlug?: string
      confirm?: boolean
      parentPageId?: string | null
    }
    let destinationPageId: string | null = null
    if (typeof parentPageId === 'string' && parentPageId.trim()) {
      const pageId = parentPageId.trim()
      const pageWorkspace = deps.resolvePageWorkspace
        ? await deps.resolvePageWorkspace(userId, pageId)
        : null
      if (pageWorkspace !== episode.workspaceId) {
        return void res.status(400).json({
          error: 'invalid_destination',
          detail: 'The destination page does not exist in this workspace, or you cannot access it.',
        })
      }
      destinationPageId = pageId
    }
    if (confirm !== true && (await deps.hasProcessed(episode.id))) {
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
      blueprintSlug:
        typeof blueprintSlug === 'string' && blueprintSlug.trim() ? blueprintSlug.trim() : null,
      parentPageId: destinationPageId,
    })
    await (deps.updateRecording ?? updateRecording)(episode.id, { status: 'queued', durationMs })
    await (deps.mergeEpisodeSourceRef ?? mergeEpisodeSourceRef)(episode.createdByUserId, episode.id, { status: 'queued' })
    res.status(202).json({ recordingId: episode.id, status: 'queued', jobId })
  })

  return router
}
