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
}))
vi.mock('../../db/sessions.js', () => ({
  findOrCreateSession: vi.fn(),
  findSessionById: vi.fn(),
}))
vi.mock('@sidanclaw/core', async () => {
  const actual = await vi.importActual<typeof import('@sidanclaw/core')>('@sidanclaw/core')
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
import { enqueueFileIngestJob } from '../../db/file-ingest-jobs-store.js'
import { parseFileContent, shouldInline } from '@sidanclaw/core'

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

  it('returns 400 when no files provided', async () => {
    const app = createTestApp('/api/files', fileRoutes(fileStore as never))
    const res = await request(app).post('/api/files/upload')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/No files/)
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
