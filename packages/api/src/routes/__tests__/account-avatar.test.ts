/**
 * [COMP:api/account-avatar] Avatar upload / remove / proxy + profile PATCH.
 *
 * Route-level tests: an in-memory fake GcsFilesClient stands in for the bucket
 * (never hit a real bucket) and the db layer is mocked. We assert the upload
 * happy-path returns an avatarUrl, writes the blob, and calls updateUserAvatar;
 * that a non-image MIME and an oversize file are rejected; that DELETE clears
 * the columns; and that PATCH /profile validates the name.
 *
 * See docs/architecture/platform/user-profile.md.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { Writable } from 'node:stream'
import { createTestApp } from './helpers.js'
import type { GcsFilesClient } from '../../files/gcs-client.js'

// Mock DB modules. The avatar routes touch the client pool only via the shared
// account routes' other handlers; the avatar paths go through db/users.js.
vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(() => ({ connect: vi.fn(), query: vi.fn() })),
}))
vi.mock('../../db/users.js', () => ({
  findUserById: vi.fn(),
  updateUserTimezone: vi.fn(),
  updateUserAvatar: vi.fn(),
  clearUserAvatar: vi.fn(),
  updateUserProfile: vi.fn(),
}))

import { accountRoutes, accountAvatarPublicRoutes } from '../account.js'
import {
  findUserById,
  updateUserAvatar,
  clearUserAvatar,
  updateUserProfile,
} from '../../db/users.js'

const mockFindUserById = vi.mocked(findUserById)
const mockUpdateUserAvatar = vi.mocked(updateUserAvatar)
const mockClearUserAvatar = vi.mocked(clearUserAvatar)
const mockUpdateUserProfile = vi.mocked(updateUserProfile)

function makeFakeGcs(): GcsFilesClient & { blobs: Map<string, Buffer>; mimes: Map<string, string> } {
  const blobs = new Map<string, Buffer>()
  const mimes = new Map<string, string>()
  return {
    blobs,
    mimes,
    async writeBlob(key, bytes, metadata) {
      blobs.set(key, bytes)
      mimes.set(key, metadata.mime)
    },
    async appendBlob(key, bytes) {
      const existing = blobs.get(key)
      if (!existing) throw new Error(`gcs fake: missing key ${key}`)
      blobs.set(key, Buffer.concat([existing, bytes]))
    },
    async statBlob(key) {
      const b = blobs.get(key)
      if (!b) return null
      return { sizeBytes: b.length, mime: mimes.get(key) ?? 'application/octet-stream', updatedAt: null }
    },
    async readBlob(key) {
      const b = blobs.get(key)
      if (!b) return null
      const mime = mimes.get(key) ?? 'application/octet-stream'
      return { bytes: b, mime, metadata: { workspaceId: '', mime } }
    },
    async deleteBlob(key) {
      blobs.delete(key)
      mimes.delete(key)
    },
    async signedReadUrl(key) {
      return `https://signed.example/${key}`
    },
    async signedWriteUrl(key) {
      return `https://signed.example/${key}?upload=1`
    },
    writeStream(key, opts) {
      const chunks: Buffer[] = []
      return new Writable({
        write(chunk, _enc, cb) {
          chunks.push(Buffer.from(chunk))
          cb()
        },
        final(cb) {
          blobs.set(key, Buffer.concat(chunks))
          mimes.set(key, opts.mime)
          cb()
        },
      })
    },
  }
}

describe('[COMP:api/account-avatar] Avatar routes', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  // ── POST /avatar ────────────────────────────────────────────

  it('uploads an image, writes the blob, returns an avatarUrl, and persists it', async () => {
    const gcs = makeFakeGcs()
    const app = createTestApp(
      '/api/account',
      accountRoutes({ blobClient: gcs }),
      { userId: 'u_1' },
    )
    // No previous avatar to delete.
    mockFindUserById.mockResolvedValueOnce({ id: 'u_1', avatarStorageKey: null } as never)

    const res = await request(app)
      .post('/api/account/avatar')
      .attach('file', Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        filename: 'me.png',
        contentType: 'image/png',
      })

    expect(res.status).toBe(200)
    expect(res.body.avatarUrl).toMatch(/\/api\/account\/avatar\/u_1\?v=/)
    // Blob written under avatars/<userId>/<uuid>.
    expect(gcs.blobs.size).toBe(1)
    const [writtenKey] = [...gcs.blobs.keys()]
    expect(writtenKey).toMatch(/^avatars\/u_1\//)
    // Persisted with the same storage key + the proxy URL.
    expect(mockUpdateUserAvatar).toHaveBeenCalledTimes(1)
    const arg = mockUpdateUserAvatar.mock.calls[0][1]
    expect(arg.storageKey).toBe(writtenKey)
    expect(arg.url).toBe(res.body.avatarUrl)
  })

  it('best-effort deletes the previous uploaded blob on re-upload', async () => {
    const gcs = makeFakeGcs()
    // Seed a previous avatar blob.
    await gcs.writeBlob('avatars/u_1/old', Buffer.from([1]), {
      workspaceId: 'u_1',
      mime: 'image/png',
    })
    const app = createTestApp(
      '/api/account',
      accountRoutes({ blobClient: gcs }),
      { userId: 'u_1' },
    )
    mockFindUserById.mockResolvedValueOnce({ id: 'u_1', avatarStorageKey: 'avatars/u_1/old' } as never)

    const res = await request(app)
      .post('/api/account/avatar')
      .attach('file', Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        filename: 'new.png',
        contentType: 'image/png',
      })

    expect(res.status).toBe(200)
    // Old key gone, new key present.
    expect(gcs.blobs.has('avatars/u_1/old')).toBe(false)
    expect(gcs.blobs.size).toBe(1)
  })

  it('rejects a non-image MIME with 400 and writes nothing', async () => {
    const gcs = makeFakeGcs()
    const app = createTestApp(
      '/api/account',
      accountRoutes({ blobClient: gcs }),
      { userId: 'u_1' },
    )

    const res = await request(app)
      .post('/api/account/avatar')
      .attach('file', Buffer.from('hello'), {
        filename: 'note.txt',
        contentType: 'text/plain',
      })

    expect(res.status).toBe(400)
    expect(gcs.blobs.size).toBe(0)
    expect(mockUpdateUserAvatar).not.toHaveBeenCalled()
  })

  it('rejects an oversize file (multer limit) without persisting', async () => {
    const gcs = makeFakeGcs()
    const app = createTestApp(
      '/api/account',
      accountRoutes({ blobClient: gcs }),
      { userId: 'u_1' },
    )

    // 6 MB > the 5 MB multer cap. Multer raises a LIMIT_FILE_SIZE error, which
    // surfaces as a non-200 and never reaches the handler body.
    const big = Buffer.alloc(6 * 1024 * 1024, 0)
    const res = await request(app)
      .post('/api/account/avatar')
      .attach('file', big, { filename: 'big.png', contentType: 'image/png' })

    expect(res.status).not.toBe(200)
    expect(gcs.blobs.size).toBe(0)
    expect(mockUpdateUserAvatar).not.toHaveBeenCalled()
  })

  it('returns 400 when no file is attached', async () => {
    const gcs = makeFakeGcs()
    const app = createTestApp(
      '/api/account',
      accountRoutes({ blobClient: gcs }),
      { userId: 'u_1' },
    )

    const res = await request(app).post('/api/account/avatar')
    expect(res.status).toBe(400)
  })

  it('does not register POST /avatar without a blob client (404)', async () => {
    const app = createTestApp('/api/account', accountRoutes(), { userId: 'u_1' })
    const res = await request(app)
      .post('/api/account/avatar')
      .attach('file', Buffer.from([0x89]), { filename: 'me.png', contentType: 'image/png' })
    expect(res.status).toBe(404)
  })

  // ── DELETE /avatar ──────────────────────────────────────────

  it('removes an uploaded avatar: deletes the blob and clears the columns', async () => {
    const gcs = makeFakeGcs()
    await gcs.writeBlob('avatars/u_1/cur', Buffer.from([1]), {
      workspaceId: 'u_1',
      mime: 'image/png',
    })
    const app = createTestApp(
      '/api/account',
      accountRoutes({ blobClient: gcs }),
      { userId: 'u_1' },
    )
    mockFindUserById.mockResolvedValueOnce({ id: 'u_1', avatarStorageKey: 'avatars/u_1/cur' } as never)

    const res = await request(app).delete('/api/account/avatar')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(gcs.blobs.has('avatars/u_1/cur')).toBe(false)
    expect(mockClearUserAvatar).toHaveBeenCalledWith('u_1')
  })

  // ── PATCH /profile ──────────────────────────────────────────

  it('updates the display name', async () => {
    const app = createTestApp('/api/account', accountRoutes(), { userId: 'u_1' })

    const res = await request(app)
      .patch('/api/account/profile')
      .send({ name: '  Ada Lovelace  ' })

    expect(res.status).toBe(200)
    expect(res.body.name).toBe('Ada Lovelace') // trimmed
    expect(mockUpdateUserProfile).toHaveBeenCalledWith('u_1', { name: 'Ada Lovelace' })
  })

  it('rejects an empty / oversize name with 400', async () => {
    const app = createTestApp('/api/account', accountRoutes(), { userId: 'u_1' })

    const empty = await request(app).patch('/api/account/profile').send({ name: '   ' })
    expect(empty.status).toBe(400)

    const huge = await request(app)
      .patch('/api/account/profile')
      .send({ name: 'x'.repeat(81) })
    expect(huge.status).toBe(400)

    expect(mockUpdateUserProfile).not.toHaveBeenCalled()
  })

  it('rejects a non-string name with 400', async () => {
    const app = createTestApp('/api/account', accountRoutes(), { userId: 'u_1' })
    const res = await request(app).patch('/api/account/profile').send({ name: 42 })
    expect(res.status).toBe(400)
  })

  // ── Public proxy: GET /:userId ──────────────────────────────

  it('serves an uploaded avatar blob from the public proxy', async () => {
    const gcs = makeFakeGcs()
    await gcs.writeBlob('avatars/u_1/cur', Buffer.from([0x89, 0x50]), {
      workspaceId: 'u_1',
      mime: 'image/png',
    })
    // Public router mounts WITHOUT auth.
    const app = createTestApp('/api/account/avatar', accountAvatarPublicRoutes(gcs))
    mockFindUserById.mockResolvedValueOnce({ id: 'u_1', avatarStorageKey: 'avatars/u_1/cur' } as never)

    const res = await request(app).get('/api/account/avatar/u_1')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/image\/png/)
    expect(res.headers['cache-control']).toMatch(/max-age=3600/)
  })

  it('returns 404 from the public proxy when the user has no uploaded avatar', async () => {
    const gcs = makeFakeGcs()
    const app = createTestApp('/api/account/avatar', accountAvatarPublicRoutes(gcs))
    mockFindUserById.mockResolvedValueOnce({ id: 'u_1', avatarStorageKey: null } as never)

    const res = await request(app).get('/api/account/avatar/u_1')
    expect(res.status).toBe(404)
  })
})
