import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import type { GcsFilesClient } from '../../files/gcs-client.js'
import { openRecordingsRoutes } from '../recordings.js'

function makeApp(overrides: Record<string, unknown> = {}) {
  const storage: GcsFilesClient = {
    writeBlob: vi.fn(),
    appendBlob: vi.fn(),
    readBlob: vi.fn(),
    statBlob: vi.fn(),
    deleteBlob: vi.fn(),
    signedReadUrl: vi.fn(async (key) => `http://localhost:4000/api/local-files?action=read&key=${key}`),
    signedWriteUrl: vi.fn(async (key) => `http://localhost:4000/api/local-files?key=${key}`),
    writeStream: vi.fn(),
  } as unknown as GcsFilesClient
  const episode = {
    id: 'rec-1',
    workspaceId: 'ws-1',
    createdByUserId: 'user-1',
    sourceRef: { gcsKey: 'ws-1/recordings/file-1', storageUri: 'file:///data/files/ws-1/recordings/file-1' },
  }
  const deps = {
    filesResolver: {
      forWorkspace: vi.fn(async () => ({ gcs: storage, bucket: '/data/files', uriScheme: 'file' as const })),
      forUri: vi.fn(async () => storage),
    },
    getRole: vi.fn(async () => 'owner'),
    enqueueJob: vi.fn(async () => ({ enqueued: true, jobId: 'job-1' })),
    hasProcessed: vi.fn(async () => false),
    probe: vi.fn(async () => 65_000),
    createEpisode: vi.fn(async () => episode),
    createRecording: vi.fn(async () => ({})),
    getRecording: vi.fn(async () => ({
      id: 'rec-1',
      workspaceId: 'ws-1',
      storageUri: 'file:///data/files/ws-1/recordings/file-1',
      gcsKey: 'ws-1/recordings/file-1',
      mime: 'video/mp4',
      durationMs: 65_000,
    })),
    getEpisode: vi.fn(async () => episode),
    updateRecording: vi.fn(async () => undefined),
    mergeEpisodeSourceRef: vi.fn(async () => undefined),
    ...overrides,
  }
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as typeof req & { userId: string }).userId = 'user-1'
    next()
  })
  app.use('/api/recordings', openRecordingsRoutes(deps as never))
  return { app, deps, storage }
}

describe('[COMP:recordings/open-routes] OSS recordings routes', () => {
  it('returns a short-lived public signed read URL for playback and provider fetches', async () => {
    const { app } = makeApp()
    const response = await request(app).get('/api/recordings/rec-1/media-url')

    expect(response.status).toBe(200)
    expect(response.body.url).toMatch(/^http:\/\/localhost:4000\/api\/local-files/)
    expect(new URL(response.body.url).searchParams.get('action')).toBe('read')
    expect(response.body.mime).toBe('video/mp4')
  })

  it('creates a recording and returns the active storage backend upload URL', async () => {
    const { app, deps, storage } = makeApp()
    const response = await request(app).post('/api/recordings/upload-url').send({
      workspaceId: 'ws-1',
      assistantId: 'assistant-1',
      fileName: 'clip.mp4',
      mime: 'video/mp4',
    })

    expect(response.status).toBe(200)
    expect(response.body.recordingId).toBe('rec-1')
    expect(response.body.uploadUrl).toMatch(/^http:\/\/localhost:4000\/api\/local-files/)
    expect(storage.signedWriteUrl).toHaveBeenCalledWith(expect.stringMatching(/^ws-1\/recordings\//), {
      contentType: 'video/mp4',
      ttlSec: 3600,
    })
    expect(deps.createRecording).toHaveBeenCalledWith(expect.objectContaining({
      storageUri: expect.stringMatching(/^file:\/\/\/data\/files\/ws-1\/recordings\//),
    }))
  })

  it('estimates without a hosted credit surcharge', async () => {
    const { app } = makeApp()
    const response = await request(app).post('/api/recordings/rec-1/estimate')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      recordingId: 'rec-1',
      durationMs: 65_000,
      durationSeconds: 65,
      surchargeCredits: 0,
    })
  })

  it('returns the actionable ffprobe prerequisite error', async () => {
    const { app } = makeApp({
      probe: vi.fn(async () => {
        throw new Error('ffprobe prerequisite failed: spawn ffprobe ENOENT')
      }),
    })
    const response = await request(app).post('/api/recordings/rec-1/estimate')

    expect(response.status).toBe(422)
    expect(response.body).toEqual({
      error: 'could_not_read_duration',
      detail: 'ffprobe prerequisite failed: spawn ffprobe ENOENT',
    })
  })

  it('queues processing on the existing OSS recording worker', async () => {
    const { app, deps } = makeApp()
    const response = await request(app).post('/api/recordings/rec-1/process').send({})

    expect(response.status).toBe(202)
    expect(response.body).toEqual({ recordingId: 'rec-1', status: 'queued', jobId: 'job-1' })
    expect(deps.enqueueJob).toHaveBeenCalledWith({
      recordingId: 'rec-1',
      workspaceId: 'ws-1',
      actingUserId: 'user-1',
    })
  })
})
