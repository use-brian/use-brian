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
import { findOrCreateUser, getDefaultAssistant, findUserById } from '../../db/users.js'
import { findOrCreateSession, findSessionById } from '../../db/sessions.js'
import { parseFileContent } from '@sidanclaw/core'

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
