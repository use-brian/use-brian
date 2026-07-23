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
  const recording = {
    id: 'rec-1',
    workspaceId: 'ws-1',
    title: 'Weekly sync',
    kind: 'meeting',
    status: 'processed',
    fileName: 'sync.mp4',
    storageUri: 'file:///data/files/ws-1/recordings/file-1',
    gcsKey: 'ws-1/recordings/file-1',
    mime: 'video/mp4',
    bytes: 1234,
    durationMs: 65_000,
    transcriptFileId: 'file-transcript',
    mediaFileId: null,
    participants: [{ speaker: 'A', name: 'Alice' }],
    truncated: false,
    lastError: null,
    deleteAfter: null,
    userId: null,
    assistantId: 'assistant-1',
    sensitivity: 'internal',
    createdByUserId: 'user-1',
    createdAt: new Date('2026-07-20T10:00:00.000Z'),
    updatedAt: new Date('2026-07-20T10:01:00.000Z'),
  }
  const viewpoint = {
    workspaceId: 'ws-1',
    userId: 'user-1',
    assistantId: 'assistant-1',
    assistantKind: 'primary',
    clearance: 'internal',
    compartments: [],
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
    getRecording: vi.fn(async () => recording),
    listRecordings: vi.fn(async () => [recording]),
    resolveViewpoint: vi.fn(async () => viewpoint),
    readTranscript: vi.fn(async () => [{
      segment_index: 0,
      start_ms: 0,
      end_ms: 1000,
      speaker: 'A',
      segment_text: 'Hello brain',
    }]),
    listTasks: vi.fn(async () => []),
    resolvePageWorkspace: vi.fn(async () => 'ws-1'),
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
  it('lists recordings with filters and the app-web projection', async () => {
    const { app, deps } = makeApp()
    const response = await request(app).get(
      '/api/recordings?workspaceId=ws-1&kind=meeting&status=processed&q=weekly&limit=500',
    )

    expect(response.status).toBe(200)
    expect(response.body.recordings).toEqual([expect.objectContaining({
      recordingId: 'rec-1',
      title: 'Weekly sync',
      occurredAt: '2026-07-20T10:00:00.000Z',
      hasTranscript: true,
      participants: [{ speaker: 'A', name: 'Alice' }],
    })])
    expect(deps.listRecordings).toHaveBeenCalledWith(
      'user-1',
      'ws-1',
      { kind: 'meeting', status: 'processed', q: 'weekly' },
      { limit: 100 },
    )
  })

  it('returns recording detail without exposing storage coordinates', async () => {
    const { app } = makeApp()
    const response = await request(app).get('/api/recordings/rec-1')

    expect(response.status).toBe(200)
    expect(response.body).toEqual(expect.objectContaining({
      recordingId: 'rec-1',
      mime: 'video/mp4',
      durationMs: 65_000,
    }))
    expect(response.body).not.toHaveProperty('gcsKey')
    expect(response.body).not.toHaveProperty('storageUri')
  })

  it('reads a bounded transcript page using the caller viewpoint', async () => {
    const { app, deps } = makeApp()
    const response = await request(app).get(
      '/api/recordings/rec-1/transcript?fromIndex=10&toIndex=9999',
    )

    expect(response.status).toBe(200)
    expect(response.body).toEqual(expect.objectContaining({
      recordingId: 'rec-1',
      fromIndex: 10,
      toIndex: 209,
      hasMore: false,
    }))
    expect(deps.resolveViewpoint).toHaveBeenCalledWith('user-1', 'ws-1')
    expect(deps.readTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', clearance: 'internal' }),
      { recordingId: 'rec-1', fromIndex: 10, toIndex: 209 },
    )
  })

  it('denies list access to a non-member and hides inaccessible detail', async () => {
    const deniedList = makeApp({ getRole: vi.fn(async () => null) })
    const listResponse = await request(deniedList.app).get('/api/recordings?workspaceId=ws-1')
    expect(listResponse.status).toBe(403)
    expect(deniedList.deps.listRecordings).not.toHaveBeenCalled()

    const hiddenDetail = makeApp({ getRecording: vi.fn(async () => null) })
    const detailResponse = await request(hiddenDetail.app).get('/api/recordings/rec-other')
    expect(detailResponse.status).toBe(404)
  })

  it('denies transcript access when no caller viewpoint can be resolved', async () => {
    const { app, deps } = makeApp({ resolveViewpoint: vi.fn(async () => null) })
    const response = await request(app).get('/api/recordings/rec-1/transcript')

    expect(response.status).toBe(403)
    expect(deps.readTranscript).not.toHaveBeenCalled()
  })

  it('lists recording tasks through the same caller viewpoint', async () => {
    const tasks = [{
      id: 'task-1',
      title: 'Send the proposal',
      status: 'todo',
      assigneeId: null,
      sourceStartMs: 42_000,
      verified: false,
    }]
    const { app, deps } = makeApp({ listTasks: vi.fn(async () => tasks) })
    const response = await request(app).get('/api/recordings/rec-1/tasks')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ recordingId: 'rec-1', tasks })
    expect(deps.listTasks).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', clearance: 'internal' }),
      'rec-1',
    )
  })

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
      blueprintSlug: null,
      parentPageId: null,
    })
  })

  it('validates and threads blueprint and destination fields when processing', async () => {
    const { app, deps } = makeApp()
    const response = await request(app).post('/api/recordings/rec-1/process').send({
      blueprintSlug: '  sales-call  ',
      parentPageId: '  page-1  ',
    })

    expect(response.status).toBe(202)
    expect(deps.resolvePageWorkspace).toHaveBeenCalledWith('user-1', 'page-1')
    expect(deps.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
      blueprintSlug: 'sales-call',
      parentPageId: 'page-1',
    }))
  })

  it('rejects an inaccessible process destination before enqueueing', async () => {
    const { app, deps } = makeApp({ resolvePageWorkspace: vi.fn(async () => null) })
    const response = await request(app).post('/api/recordings/rec-1/process').send({
      blueprintSlug: 'sales-call',
      parentPageId: 'page-other',
    })

    expect(response.status).toBe(400)
    expect(response.body.error).toBe('invalid_destination')
    expect(deps.enqueueJob).not.toHaveBeenCalled()
  })
})
