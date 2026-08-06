import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

// Mock DB + core modules
vi.mock('../../db/users.js', () => ({
  findOrCreateUser: vi.fn(),
  getDefaultAssistant: vi.fn(),
  findUserById: vi.fn(),
  // Upload resolves the file's workspace from the session's assistant (audit
  // #3 clearance scoping). Default undefined → workspace falls back to null.
  findAssistantById: vi.fn(),
  getWorkspacePrimaryAssistant: vi.fn(),
}))
vi.mock('../../db/workspace-files.js', () => ({
  getWorkspaceFileById: vi.fn(),
}))
vi.mock('../../db/file-ingest-jobs-store.js', () => ({
  enqueueFileIngestJob: vi.fn(),
  getFileIngestJob: vi.fn(),
}))
vi.mock('../../db/sessions.js', () => ({
  findOrCreateSession: vi.fn(),
  findSessionById: vi.fn(),
}))
vi.mock('@use-brian/core', async () => {
  const actual = await vi.importActual<typeof import('@use-brian/core')>('@use-brian/core')
  return {
    ...actual,
    parseFileContent: vi.fn(),
    shouldInline: vi.fn(() => true),
  }
})

import { fileRoutes } from '../files.js'
import { findOrCreateUser, getDefaultAssistant, findUserById, findAssistantById, getWorkspacePrimaryAssistant } from '../../db/users.js'
import { findOrCreateSession, findSessionById } from '../../db/sessions.js'
import { getWorkspaceFileById } from '../../db/workspace-files.js'
import { enqueueFileIngestJob, getFileIngestJob } from '../../db/file-ingest-jobs-store.js'
import { parseFileContent, shouldInline } from '@use-brian/core'

const mockFindOrCreateUser = vi.mocked(findOrCreateUser)
const mockGetDefaultAssistant = vi.mocked(getDefaultAssistant)
const mockFindUserById = vi.mocked(findUserById)
const mockFindOrCreateSession = vi.mocked(findOrCreateSession)
const mockFindSessionById = vi.mocked(findSessionById)
const mockParseFileContent = vi.mocked(parseFileContent)

describe('[COMP:api/files-route] File routes', () => {
  const fileStore = {
    cache: vi.fn(),
    get: vi.fn(),
    getBySession: vi.fn(),
  }

  beforeEach(() => {
    vi.resetAllMocks()
    // /ingest hands the semantic work to the queue, so every ingest test needs
    // a working enqueue unless it is specifically testing enqueue behavior.
    vi.mocked(enqueueFileIngestJob).mockResolvedValue({ enqueued: true, jobId: 'job-1' })
  })

  // ── POST /upload ────────────────────────────────────────────

  it('uploads a text file for a guest user', async () => {
    const app = createTestApp('/api/files', fileRoutes(fileStore as never))
    mockFindOrCreateUser.mockResolvedValueOnce({ user: { id: 'u_guest' }, isNew: false } as never)
    mockGetDefaultAssistant.mockResolvedValueOnce({ id: 'a_1' } as never)
    mockFindOrCreateSession.mockResolvedValueOnce({ id: 's_staging' } as never)
    mockParseFileContent.mockResolvedValueOnce({ text: 'hello world', summary: 'A greeting' })
    fileStore.cache.mockResolvedValueOnce({
      id: 'f_1',
      fileName: 'hello.txt',
      mimeType: 'text/plain',
      sizeBytes: 11,
    })

    const res = await request(app)
      .post('/api/files/upload')
      .attach('files', Buffer.from('hello world'), { filename: 'hello.txt', contentType: 'text/plain' })

    expect(res.status).toBe(200)
    expect(res.body.sessionId).toBe('s_staging')
    expect(res.body.files).toHaveLength(1)
    expect(res.body.files[0].id).toBe('f_1')
    expect(res.body.files[0].summary).toBe('A greeting')
  })

  it('returns error for unsupported MIME type', async () => {
    const app = createTestApp('/api/files', fileRoutes(fileStore as never))
    mockFindOrCreateUser.mockResolvedValueOnce({ user: { id: 'u_guest' }, isNew: false } as never)
    mockGetDefaultAssistant.mockResolvedValueOnce({ id: 'a_1' } as never)
    mockFindOrCreateSession.mockResolvedValueOnce({ id: 's_staging' } as never)

    const res = await request(app)
      .post('/api/files/upload')
      .attach('files', Buffer.from('binary'), { filename: 'data.bin', contentType: 'application/octet-stream' })

    expect(res.status).toBe(200)
    expect(res.body.files[0].error).toMatch(/Unsupported file type/)
  })

  it('accepts a known document extension when the transport MIME is generic', async () => {
    const app = createTestApp('/api/files', fileRoutes(fileStore as never))
    mockFindOrCreateUser.mockResolvedValueOnce({ user: { id: 'u_guest' }, isNew: false } as never)
    mockGetDefaultAssistant.mockResolvedValueOnce({ id: 'a_1' } as never)
    mockFindOrCreateSession.mockResolvedValueOnce({ id: 's_staging' } as never)
    mockParseFileContent.mockResolvedValueOnce({ text: 'parsed', summary: 'Document: brief.ODT' })
    fileStore.cache.mockResolvedValueOnce({
      id: 'f_odt',
      fileName: 'brief.ODT',
      mimeType: 'application/octet-stream',
      sizeBytes: 6,
    })

    const res = await request(app)
      .post('/api/files/upload')
      .attach('files', Buffer.from('office'), {
        filename: 'brief.ODT',
        contentType: 'application/octet-stream',
      })

    expect(res.status).toBe(200)
    expect(res.body.files[0].id).toBe('f_odt')
    expect(mockParseFileContent).toHaveBeenCalledWith(
      expect.any(Buffer),
      'application/octet-stream',
      'brief.ODT',
    )
  })

  it('caches byte-detected PDF media with its effective MIME instead of transport text MIME', async () => {
    const app = createTestApp('/api/files', fileRoutes(fileStore as never))
    mockFindOrCreateUser.mockResolvedValueOnce({ user: { id: 'u_guest' }, isNew: false } as never)
    mockGetDefaultAssistant.mockResolvedValueOnce({ id: 'a_1' } as never)
    mockFindOrCreateSession.mockResolvedValueOnce({ id: 's_staging' } as never)
    mockParseFileContent.mockResolvedValueOnce({
      text: Buffer.from('%PDF').toString('base64'),
      summary: 'PDF: download.txt',
      mediaMimeType: 'application/pdf',
    })
    fileStore.cache.mockResolvedValueOnce({
      id: 'f_pdf',
      fileName: 'download.txt',
      mimeType: 'application/pdf',
      sizeBytes: 4,
    })

    const res = await request(app)
      .post('/api/files/upload')
      .attach('files', Buffer.from('%PDF'), {
        filename: 'download.txt',
        contentType: 'text/plain',
      })

    expect(res.status).toBe(200)
    expect(fileStore.cache).toHaveBeenCalledWith(
      expect.objectContaining({
        mimeType: 'application/pdf',
        content: expect.stringMatching(/^data:application\/pdf;base64,/),
      }),
    )
  })

  it('returns 400 when no files provided', async () => {
    const app = createTestApp('/api/files', fileRoutes(fileStore as never))
    const res = await request(app).post('/api/files/upload')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/No files/)
  })

  it('keeps transient cache uploads at 20 MiB', async () => {
    const app = createTestApp('/api/files', fileRoutes(fileStore as never))
    const res = await request(app)
      .post('/api/files/upload')
      .attach('files', Buffer.alloc(20 * 1024 * 1024 + 1), {
        filename: 'oversized.pdf',
        contentType: 'application/pdf',
      })

    expect(res.status).toBe(413)
    expect(res.body).toEqual({
      error: 'file_too_large',
      detail: 'Each file must be 20 MB or smaller.',
    })
  })

  it('accepts a durable ingest file above 20 MiB', async () => {
    const ingestor = vi.fn().mockResolvedValue({
      fileName: 'large.pdf',
      fileId: 'wf-large',
      path: '/uploads/large.pdf',
      sizeBytes: 20 * 1024 * 1024 + 1,
      distilled: true,
      decomposed: true,
      counts: { entities: 1, edges: 0, memories: 1, tasks: 0 },
    })
    vi.mocked(getWorkspacePrimaryAssistant).mockResolvedValueOnce({
      id: 'a-1',
      kind: 'primary',
      workspaceId: 'ws-1',
      clearance: 'internal',
      compartments: [],
    } as never)
    const app = createTestApp(
      '/api/files',
      fileRoutes(fileStore as never, ingestor),
      { userId: 'u-1' },
    )
    const bytes = Buffer.alloc(20 * 1024 * 1024 + 1)
    const res = await request(app)
      .post('/api/files/ingest')
      .field('workspaceId', 'ws-1')
      .attach('files', bytes, { filename: 'large.pdf', contentType: 'application/pdf' })

    expect(res.status).toBe(200)
    expect(res.body.files[0]).toMatchObject({ ok: true, fileId: 'wf-large' })
    expect(ingestor).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'large.pdf', mime: 'application/pdf' }),
      expect.objectContaining({ workspaceId: 'ws-1', userId: 'u-1' }),
    )
    expect(ingestor.mock.calls[0][0].bytes).toHaveLength(bytes.length)
  })

  // ── POST /ingest is a QUEUE boundary ────────────────────────
  //
  // Regression cover for the 2026-08-05 false-failure: /ingest used to run
  // parse + chunk + Pipeline B inline, so a 4 MB document held the request for
  // 185 s and Cloudflare 524'd the browser at 100 s while the server finished
  // the work. Every file in the batch showed "Failed" after being fully
  // ingested, and the retry hit the path conflict. The invariant that keeps it
  // from coming back: no model-priced work on the request thread.

  const primaryAssistant = {
    id: 'a-1',
    kind: 'primary',
    workspaceId: 'ws-1',
    clearance: 'internal',
    compartments: [],
  }

  function ingestorFor(over: Record<string, unknown> = {}) {
    return vi.fn().mockResolvedValue({
      fileName: 'report.html',
      fileId: 'wf-1',
      path: '/uploads/report.html',
      sizeBytes: 31_203,
      distilled: false,
      decomposed: false,
      counts: { entities: 0, edges: 0, memories: 0, tasks: 0 },
      ...over,
    })
  }

  async function postIngest(ingestor: ReturnType<typeof ingestorFor>) {
    vi.mocked(getWorkspacePrimaryAssistant).mockResolvedValueOnce(primaryAssistant as never)
    return request(createTestApp('/api/files', fileRoutes(fileStore as never, ingestor), { userId: 'u-1' }))
      .post('/api/files/ingest')
      .field('workspaceId', 'ws-1')
      .attach('files', Buffer.from('<html><body>hi</body></html>'), {
        filename: 'report.html',
        contentType: 'text/html',
      })
  }

  it('queues the brain ingest instead of running it on the request thread', async () => {
    const ingestor = ingestorFor()
    const res = await postIngest(ingestor)

    expect(res.status).toBe(200)
    expect(res.body.files[0]).toMatchObject({
      ok: true,
      fileId: 'wf-1',
      status: 'queued',
      jobId: 'job-1',
    })
    // The bytes are filed synchronously; nothing is interpreted inline.
    expect(ingestor).toHaveBeenCalledWith(
      expect.objectContaining({ fileName: 'report.html', process: false }),
      expect.objectContaining({ workspaceId: 'ws-1', userId: 'u-1' }),
    )
    // No counts to report yet — claiming any would be a guess.
    expect(res.body.files[0].counts).toBeUndefined()
    expect(res.body.files[0].decomposed).toBeUndefined()
  })

  it('enqueues the job as `explicit` so the worker may distill a PDF or image', async () => {
    await postIngest(ingestorFor())

    expect(enqueueFileIngestJob).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 'wf-1',
        workspaceId: 'ws-1',
        actingUserId: 'u-1',
        assistantId: 'a-1',
        mode: 'explicit',
      }),
    )
  })

  it('reports success when a job for the file is already in flight', async () => {
    // Queue-level idempotency, not a failure: the work is happening either way,
    // and telling the user it failed is what sends them into a retry loop.
    vi.mocked(enqueueFileIngestJob).mockResolvedValue({ enqueued: false, jobId: null })
    const res = await postIngest(ingestorFor())

    expect(res.status).toBe(200)
    expect(res.body.files[0]).toMatchObject({ ok: true, status: 'queued', alreadyQueued: true })
  })

  it('stores a durable Pins file without semantic processing', async () => {
    const ingestor = vi.fn().mockResolvedValue({
      fileName: 'extension-request.pdf',
      fileId: 'wf-staged',
      path: '/uploads/extension-request.pdf',
      sizeBytes: 4,
      distilled: false,
      decomposed: false,
      counts: { entities: 0, edges: 0, memories: 0, tasks: 0 },
    })
    vi.mocked(getWorkspacePrimaryAssistant).mockResolvedValueOnce({
      id: 'a-1',
      kind: 'primary',
      workspaceId: 'ws-1',
      clearance: 'internal',
      compartments: [],
    } as never)

    const res = await request(createTestApp(
      '/api/files',
      fileRoutes(fileStore as never, ingestor),
      { userId: 'u-1' },
    ))
      .post('/api/files/store')
      .field('workspaceId', 'ws-1')
      .attach('files', Buffer.from('%PDF'), {
        filename: 'extension-request.pdf',
        contentType: 'application/pdf',
      })

    expect(res.status).toBe(200)
    expect(res.body.files[0]).toMatchObject({
      ok: true,
      fileId: 'wf-staged',
      distilled: false,
      decomposed: false,
      counts: { entities: 0, edges: 0, memories: 0, tasks: 0 },
    })
    expect(ingestor).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: 'extension-request.pdf',
        mime: 'application/pdf',
        process: false,
      }),
      expect.objectContaining({ workspaceId: 'ws-1', userId: 'u-1' }),
    )
  })

  it('starts and completes a direct-to-storage chunked upload', async () => {
    const chunkedUploads = {
      start: vi.fn().mockResolvedValue({
        uploadId: 'upload-1',
        fileId: 'file-large',
        chunkSizeBytes: 8 * 1024 * 1024,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        parts: [{ index: 0, offset: 0, sizeBytes: 4, url: 'https://storage.example/part-0' }],
      }),
      complete: vi.fn().mockResolvedValue({
        id: 'file-large',
        name: 'catalog.pdf',
        path: '/uploads/catalog.pdf',
        sizeBytes: 31 * 1024 * 1024,
        mime: 'application/pdf',
      }),
      abort: vi.fn(),
      sweepExpired: vi.fn(),
    }
    vi.mocked(getWorkspacePrimaryAssistant).mockResolvedValue({
      id: 'a-1',
      kind: 'primary',
      workspaceId: 'ws-1',
      clearance: 'internal',
      compartments: [],
    } as never)
    const app = createTestApp(
      '/api/files',
      fileRoutes(fileStore as never, null, null, null, chunkedUploads as never),
      { userId: 'u-1' },
    )

    const started = await request(app).post('/api/files/uploads/start').send({
      workspaceId: 'ws-1',
      fileName: 'catalog.pdf',
      mime: 'application/pdf',
      sizeBytes: 31 * 1024 * 1024,
    })
    expect(started.status).toBe(201)
    expect(started.body.uploadId).toBe('upload-1')
    expect(chunkedUploads.start).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', userId: 'u-1' }),
      expect.objectContaining({ fileName: 'catalog.pdf', sizeBytes: 31 * 1024 * 1024 }),
    )

    const completed = await request(app)
      .post('/api/files/uploads/upload-1/complete')
      .send({ workspaceId: 'ws-1' })
    expect(completed.status).toBe(200)
    expect(completed.body).toMatchObject({
      ok: true,
      fileId: 'file-large',
      decomposed: false,
    })
    expect(chunkedUploads.complete).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', userId: 'u-1' }),
      'upload-1',
    )
  })

  it('rejects a durable ingest file above 30 MiB with the route-specific limit', async () => {
    const app = createTestApp('/api/files', fileRoutes(fileStore as never, vi.fn()), {
      userId: 'u-1',
    })
    const res = await request(app)
      .post('/api/files/ingest')
      .field('workspaceId', 'ws-1')
      .attach('files', Buffer.alloc(30 * 1024 * 1024 + 1), {
        filename: 'too-large.pdf',
        contentType: 'application/pdf',
      })

    expect(res.status).toBe(413)
    expect(res.body).toEqual({
      error: 'file_too_large',
      detail: 'Each file must be 30 MB or smaller.',
    })
  })

  it('uses existing session when sessionId provided', async () => {
    const app = createTestApp('/api/files', fileRoutes(fileStore as never), { userId: 'u_1' })
    mockFindUserById.mockResolvedValueOnce({ id: 'u_1' } as never)
    mockGetDefaultAssistant.mockResolvedValueOnce({ id: 'a_1' } as never)
    mockFindSessionById.mockResolvedValueOnce({ id: 's_existing' } as never)
    mockParseFileContent.mockResolvedValueOnce({ text: 'data', summary: 'Data file' })
    fileStore.cache.mockResolvedValueOnce({
      id: 'f_2',
      fileName: 'data.json',
      mimeType: 'application/json',
      sizeBytes: 4,
    })

    const res = await request(app)
      .post('/api/files/upload')
      .field('sessionId', 's_existing')
      .attach('files', Buffer.from('data'), { filename: 'data.json', contentType: 'application/json' })

    expect(res.status).toBe(200)
    expect(mockFindSessionById).toHaveBeenCalledWith('s_existing')
    // Audit #3: uploads stamp clearance dimensions so the cached file is
    // gated on read (user-private + sensitivity), not world-readable by id.
    expect(fileStore.cache).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u_1', sensitivity: 'internal' }),
    )
  })

  // ── GET /:id/preview ────────────────────────────────────────

  it('returns 404 when file not found', async () => {
    const app = createTestApp('/api/files', fileRoutes(fileStore as never))
    fileStore.get.mockResolvedValueOnce(null)

    const res = await request(app).get('/api/files/f_gone/preview')
    expect(res.status).toBe(404)
  })

  it('returns JSON metadata for non-image file', async () => {
    const app = createTestApp('/api/files', fileRoutes(fileStore as never))
    fileStore.get.mockResolvedValueOnce({
      id: 'f_1',
      fileName: 'doc.pdf',
      mimeType: 'application/pdf',
      content: 'parsed text',
      sizeBytes: 1000,
    })

    const res = await request(app).get('/api/files/f_1/preview')
    expect(res.status).toBe(200)
    expect(res.body.fileName).toBe('doc.pdf')
    expect(res.body.mimeType).toBe('application/pdf')
  })

  it('streams raw image bytes for image file', async () => {
    const app = createTestApp('/api/files', fileRoutes(fileStore as never))
    const imageData = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
    fileStore.get.mockResolvedValueOnce({
      id: 'f_img',
      fileName: 'photo.png',
      mimeType: 'image/png',
      content: `data:image/png;base64,${imageData}`,
      sizeBytes: 4,
    })

    const res = await request(app).get('/api/files/f_img/preview')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/image\/png/)
  })
})

// ── WS3 #8: signed preview capability URLs ───────────────────────────
// When `previewSecret` is configured, the bare-UUID IDOR is closed: `/preview`
// requires a valid `?sig` minted by the authenticated, access-scoped
// `/preview-url` route. Without the secret the legacy unsigned behavior holds
// (the describe above covers that path).
describe('[COMP:api/files-route] Signed preview URLs', () => {
  const SECRET = 'test-preview-secret'
  const fileStore = {
    cache: vi.fn(),
    get: vi.fn(),
    getBySession: vi.fn(),
  }

  beforeEach(() => {
    vi.resetAllMocks()
  })

  // ── Mint route: GET /:id/preview-url ──────────────────────────

  it('mints a signed URL for an authorized viewer (access-scoped get succeeds)', async () => {
    const app = createTestApp('/api/files', fileRoutes(fileStore as never, null, null, SECRET), {
      userId: 'u_owner',
    })
    fileStore.get.mockResolvedValueOnce({ id: 'f_1', mimeType: 'image/png' })

    const res = await request(app).get('/api/files/f_1/preview-url?workspaceId=ws_1')
    expect(res.status).toBe(200)
    expect(res.body.url).toMatch(/^\/api\/files\/f_1\/preview\?sig=/)
    // The gate ran the access-scoped read (ctx passed), not the unscoped branch.
    expect(fileStore.get).toHaveBeenCalledWith(
      'f_1',
      expect.objectContaining({ workspaceId: 'ws_1', userId: 'u_owner' }),
    )
  })

  it('refuses to mint when the viewer cannot read the file (foreign workspace/user → 404)', async () => {
    const app = createTestApp('/api/files', fileRoutes(fileStore as never, null, null, SECRET), {
      userId: 'u_attacker',
    })
    // Access-scoped get returns null (predicate filtered it out).
    fileStore.get.mockResolvedValueOnce(null)

    const res = await request(app).get('/api/files/f_victim/preview-url?workspaceId=ws_other')
    expect(res.status).toBe(404)
  })

  it('mint route requires auth (401 without a user)', async () => {
    const app = createTestApp('/api/files', fileRoutes(fileStore as never, null, null, SECRET))
    const res = await request(app).get('/api/files/f_1/preview-url?workspaceId=ws_1')
    expect(res.status).toBe(401)
    expect(fileStore.get).not.toHaveBeenCalled()
  })

  it('mint route requires workspaceId (400)', async () => {
    const app = createTestApp('/api/files', fileRoutes(fileStore as never, null, null, SECRET), {
      userId: 'u_owner',
    })
    const res = await request(app).get('/api/files/f_1/preview-url')
    expect(res.status).toBe(400)
  })

  it('mint route 503s when no preview secret is configured', async () => {
    const app = createTestApp('/api/files', fileRoutes(fileStore as never), { userId: 'u_owner' })
    const res = await request(app).get('/api/files/f_1/preview-url?workspaceId=ws_1')
    expect(res.status).toBe(503)
  })

  // ── Preview route enforces the signature ──────────────────────

  it('serves the image bytes with a valid minted signature', async () => {
    const app = createTestApp('/api/files', fileRoutes(fileStore as never, null, null, SECRET), {
      userId: 'u_owner',
    })
    const imageData = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
    // Mint (image mime), then serve.
    fileStore.get.mockResolvedValueOnce({ id: 'f_img', mimeType: 'image/png' })
    const mint = await request(app).get('/api/files/f_img/preview-url?workspaceId=ws_1')
    expect(mint.status).toBe(200)
    const url: string = mint.body.url

    fileStore.get.mockResolvedValueOnce({
      id: 'f_img',
      fileName: 'photo.png',
      mimeType: 'image/png',
      content: `data:image/png;base64,${imageData}`,
      sizeBytes: 4,
    })
    const res = await request(app).get(url)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/image\/png/)
    // The serve read is the UNSCOPED branch — no ctx (the signature is the gate).
    expect(fileStore.get).toHaveBeenLastCalledWith('f_img')
  })

  it('rejects /preview with no signature (401) — closes the bare-UUID IDOR', async () => {
    const app = createTestApp('/api/files', fileRoutes(fileStore as never, null, null, SECRET))
    const res = await request(app).get('/api/files/f_1/preview')
    expect(res.status).toBe(401)
    // Never even touches the store — no bytes leak on an unsigned request.
    expect(fileStore.get).not.toHaveBeenCalled()
  })

  it('rejects /preview with a forged signature (403)', async () => {
    const app = createTestApp('/api/files', fileRoutes(fileStore as never, null, null, SECRET))
    const res = await request(app).get('/api/files/f_1/preview?sig=not.a.valid.sig')
    expect(res.status).toBe(403)
    expect(fileStore.get).not.toHaveBeenCalled()
  })

  it('rejects a signature minted for a DIFFERENT file id (403 cross-id replay)', async () => {
    const mintApp = createTestApp('/api/files', fileRoutes(fileStore as never, null, null, SECRET), {
      userId: 'u_owner',
    })
    fileStore.get.mockResolvedValueOnce({ id: 'f_a', mimeType: 'image/png' })
    const mint = await request(mintApp).get('/api/files/f_a/preview-url?workspaceId=ws_1')
    const sig = new URL(`http://x${mint.body.url}`).searchParams.get('sig') as string

    // Replay f_a's sig against f_b.
    const res = await request(mintApp).get(`/api/files/f_b/preview?sig=${encodeURIComponent(sig)}`)
    expect(res.status).toBe(403)
  })
})

// ── large-content-artifacts §Phase 2.3: silent upload promotion ──────
describe('[COMP:api/files-upload-promotion] /upload silent artifact promotion', () => {
  const fileStore = {
    cache: vi.fn(),
    get: vi.fn(),
    getBySession: vi.fn(),
    linkArtifact: vi.fn(),
  }
  const mockShouldInline = vi.mocked(shouldInline)

  function arm(workspaceId: string | null = 'ws-1') {
    mockFindOrCreateUser.mockResolvedValue({ user: { id: 'u_1' }, isNew: false } as never)
    mockGetDefaultAssistant.mockResolvedValue({ id: 'a_1', workspaceId } as never)
    mockFindOrCreateSession.mockResolvedValue({ id: 's_1', assistantId: 'a_1' } as never)
    vi.mocked(findAssistantById).mockResolvedValue({ id: 'a_1', workspaceId } as never)
    fileStore.cache.mockResolvedValue({ id: 'f_1', fileName: 'big.md', mimeType: 'text/markdown', sizeBytes: 90000 })
    fileStore.linkArtifact.mockResolvedValue(undefined)
  }

  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('promotes a large text file: promoter called, cache linked, response carries artifact', async () => {
    arm()
    mockParseFileContent.mockResolvedValue({ text: 'X'.repeat(90000), summary: 'big doc' })
    mockShouldInline.mockReturnValue(false)
    const promoter = vi.fn().mockResolvedValue({
      fileId: 'wf-9', path: '/uploads/chat/x-big.md', status: 'ready', segmentCount: 42, truncated: false,
    })
    const app = createTestApp('/api/files', fileRoutes(fileStore as never, null, promoter))

    const res = await request(app)
      .post('/api/files/upload')
      .attach('files', Buffer.from('X'.repeat(90000)), { filename: 'big.md', contentType: 'text/markdown' })

    expect(res.status).toBe(200)
    expect(promoter).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: 'big.md',
        mime: 'text/markdown',
        workspaceId: 'ws-1',
        actingUserId: 'u_1',
        storeOnly: false,
      }),
    )
    expect(fileStore.linkArtifact).toHaveBeenCalledWith('f_1', 'wf-9', 42)
    expect(res.body.files[0].artifact).toEqual({ fileId: 'wf-9', path: '/uploads/chat/x-big.md', indexing: 'ready' })
  })

  it('small files are NOT promoted', async () => {
    arm()
    mockParseFileContent.mockResolvedValue({ text: 'short', summary: 's' })
    mockShouldInline.mockReturnValue(true)
    const promoter = vi.fn()
    const app = createTestApp('/api/files', fileRoutes(fileStore as never, null, promoter))
    const res = await request(app)
      .post('/api/files/upload')
      .attach('files', Buffer.from('short'), { filename: 'small.txt', contentType: 'text/plain' })
    expect(res.status).toBe(200)
    expect(promoter).not.toHaveBeenCalled()
    expect(res.body.files[0].artifact).toBeNull()
  })

  it('promotion failure degrades to cache-only, never fails the upload', async () => {
    arm()
    mockParseFileContent.mockResolvedValue({ text: 'X'.repeat(90000), summary: null as never })
    mockShouldInline.mockReturnValue(false)
    const promoter = vi.fn().mockResolvedValue(null)
    const app = createTestApp('/api/files', fileRoutes(fileStore as never, null, promoter))
    const res = await request(app)
      .post('/api/files/upload')
      .attach('files', Buffer.from('X'.repeat(90000)), { filename: 'big.md', contentType: 'text/markdown' })
    expect(res.status).toBe(200)
    expect(res.body.files[0].id).toBe('f_1')
    expect(res.body.files[0].artifact).toBeNull()
    expect(fileStore.linkArtifact).not.toHaveBeenCalled()
  })

  it('big PDFs promote store-only (no parsed text handed to the chunker)', async () => {
    arm()
    mockParseFileContent.mockResolvedValue({ text: 'base64ish', summary: 'PDF document' })
    mockShouldInline.mockReturnValue(true) // PDFs bypass the text gate entirely
    const promoter = vi.fn().mockResolvedValue({
      fileId: 'wf-pdf', path: '/uploads/chat/x.pdf', status: 'ready', segmentCount: 0, truncated: false,
    })
    const app = createTestApp('/api/files', fileRoutes(fileStore as never, null, promoter))
    const big = Buffer.alloc(3 * 1024 * 1024, 1)
    const res = await request(app)
      .post('/api/files/upload')
      .attach('files', big, { filename: 'deck.pdf', contentType: 'application/pdf' })
    expect(res.status).toBe(200)
    expect(promoter).toHaveBeenCalledWith(
      expect.objectContaining({ storeOnly: true, parsedText: '' }),
    )
  })

  it('no workspace -> no promotion (cache-only legacy behavior)', async () => {
    arm(null)
    mockParseFileContent.mockResolvedValue({ text: 'X'.repeat(90000), summary: null as never })
    mockShouldInline.mockReturnValue(false)
    const promoter = vi.fn()
    const app = createTestApp('/api/files', fileRoutes(fileStore as never, null, promoter))
    const res = await request(app)
      .post('/api/files/upload')
      .attach('files', Buffer.from('X'.repeat(90000)), { filename: 'big.md', contentType: 'text/markdown' })
    expect(res.status).toBe(200)
    expect(promoter).not.toHaveBeenCalled()
  })
})

// ── Existing-file re-ingest (file-artifacts.md §"Re-ingest") ─────────────────
//
// The user-reachable recovery for "this stored file never made it into the
// brain" (2026-07-16). Deterministic: enqueues the same worker routine an
// upload uses. The double-ingestion guard is the invariant under test: an
// already-ingested file (source_episode_id set) answers 409
// requiresConfirmation until confirm: true.

describe('[COMP:api/files-reingest] POST /:fileId/ingest', () => {
  const fileStore = { store: vi.fn(), get: vi.fn(), listBySession: vi.fn() }
  const mockGetPrimary = vi.mocked(getWorkspacePrimaryAssistant)
  const mockGetFile = vi.mocked(getWorkspaceFileById)
  const mockEnqueue = vi.mocked(enqueueFileIngestJob)

  const ASSISTANT = {
    id: 'a-1', kind: 'primary', workspaceId: 'ws-1',
    clearance: 'internal', compartments: [],
  }
  const FILE = {
    id: 'f-1', name: 'notes.md', mime: 'text/markdown',
    sizeBytes: 4096, sourceEpisodeId: null as string | null,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetPrimary.mockResolvedValue(ASSISTANT as never)
    mockGetFile.mockResolvedValue(FILE as never)
    mockEnqueue.mockResolvedValue({ enqueued: true, jobId: 'job-1' })
  })

  function app(userId: string | null = 'u-1') {
    return createTestApp('/api/files', fileRoutes(fileStore as never), userId ? { userId } : undefined)
  }

  it('enqueues a never-ingested file without confirmation (202)', async () => {
    const res = await request(app()).post('/api/files/f-1/ingest').send({ workspaceId: 'ws-1' })
    expect(res.status).toBe(202)
    expect(res.body).toMatchObject({ fileId: 'f-1', status: 'queued', jobId: 'job-1' })
    expect(mockEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'f-1', workspaceId: 'ws-1', actingUserId: 'u-1', assistantId: 'a-1', sourceLabel: 'upload' }),
    )
  })

  it('GUARD: an already-ingested file requires confirmation (409, nothing enqueued)', async () => {
    mockGetFile.mockResolvedValue({ ...FILE, sourceEpisodeId: 'ep-9' } as never)
    const res = await request(app()).post('/api/files/f-1/ingest').send({ workspaceId: 'ws-1' })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ requiresConfirmation: true, reason: 'already_ingested', fileName: 'notes.md' })
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('GUARD: confirm: true re-ingests an already-ingested file, labelled reingest', async () => {
    mockGetFile.mockResolvedValue({ ...FILE, sourceEpisodeId: 'ep-9' } as never)
    const res = await request(app()).post('/api/files/f-1/ingest').send({ workspaceId: 'ws-1', confirm: true })
    expect(res.status).toBe(202)
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({ sourceLabel: 'reingest' }))
  })

  it('an in-flight job answers 409 ingest_in_flight (queue idempotency surfaced)', async () => {
    mockEnqueue.mockResolvedValue({ enqueued: false, jobId: null })
    const res = await request(app()).post('/api/files/f-1/ingest').send({ workspaceId: 'ws-1' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('ingest_in_flight')
  })

  it('audio/video is refused — recordings own media (400)', async () => {
    mockGetFile.mockResolvedValue({ ...FILE, mime: 'video/mp4' } as never)
    const res = await request(app()).post('/api/files/f-1/ingest').send({ workspaceId: 'ws-1' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('media_owned_by_recordings')
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('404 for a non-member (existence hidden) and for an invisible file; 401 unauthenticated; 400 without workspaceId', async () => {
    mockGetPrimary.mockResolvedValue(null as never)
    expect((await request(app()).post('/api/files/f-1/ingest').send({ workspaceId: 'ws-1' })).status).toBe(404)

    mockGetPrimary.mockResolvedValue(ASSISTANT as never)
    mockGetFile.mockResolvedValue(null as never)
    expect((await request(app()).post('/api/files/f-1/ingest').send({ workspaceId: 'ws-1' })).status).toBe(404)

    expect((await request(app(null)).post('/api/files/f-1/ingest').send({ workspaceId: 'ws-1' })).status).toBe(401)
    expect((await request(app()).post('/api/files/f-1/ingest').send({})).status).toBe(400)
  })
})

// ── Ingest-job status poll ───────────────────────────────────────────────────
//
// The completion signal for the queued POST /ingest. Without it the UI can only
// say "queued" and stop, which is how the false-failure incident felt from the
// user's side even after the timeout itself was fixed: no way to tell a running
// ingest from a lost one.
describe('[COMP:api/files-route] GET /ingest-jobs/:jobId', () => {
  const mockGetPrimary = vi.mocked(getWorkspacePrimaryAssistant)
  const mockGetJob = vi.mocked(getFileIngestJob)
  const ASSISTANT = { id: 'a-1', kind: 'primary', workspaceId: 'ws-1', clearance: 'internal', compartments: [] }
  const JOB = {
    id: 'job-1',
    fileId: 'wf-1',
    workspaceId: 'ws-1',
    actingUserId: 'u-1',
    assistantId: 'a-1',
    sourceLabel: 'report.html',
    mode: 'explicit' as const,
    status: 'processing' as const,
    attempts: 1,
    lastError: null,
  }

  const app = (userId: string | null = 'u-1') =>
    createTestApp('/api/files', fileRoutes({} as never, vi.fn()), userId ? { userId } : {})

  beforeEach(() => {
    vi.resetAllMocks()
    mockGetPrimary.mockResolvedValue(ASSISTANT as never)
    mockGetJob.mockResolvedValue(JOB as never)
  })

  it('reports the in-flight status', async () => {
    const res = await request(app()).get('/api/files/ingest-jobs/job-1')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ jobId: 'job-1', fileId: 'wf-1', status: 'processing' })
  })

  it('carries the failure reason on a failed job', async () => {
    mockGetJob.mockResolvedValue({ ...JOB, status: 'failed', lastError: 'readBytes failed' } as never)
    const res = await request(app()).get('/api/files/ingest-jobs/job-1')
    expect(res.body).toMatchObject({ status: 'failed', error: 'readBytes failed' })
  })

  it('does not leak a job from a workspace the caller is not a member of', async () => {
    mockGetPrimary.mockResolvedValue(null as never)
    expect((await request(app()).get('/api/files/ingest-jobs/job-1')).status).toBe(404)
  })

  it('404 for an unknown job, 401 unauthenticated', async () => {
    mockGetJob.mockResolvedValue(null as never)
    expect((await request(app()).get('/api/files/ingest-jobs/job-1')).status).toBe(404)
    expect((await request(app(null)).get('/api/files/ingest-jobs/job-1')).status).toBe(401)
  })
})
