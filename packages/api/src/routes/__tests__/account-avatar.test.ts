/**
 * [COMP:api/account-avatar] Avatar upload / remove / proxy + profile PATCH.
 *
 * Route-level tests: in-memory fake storage clients stand in for active and
 * recorded backends. They cover membership, provenance routing, legacy
 * fallback, replacement cleanup, validation, delete, public GET, and profile.
 *
 * See docs/architecture/platform/user-profile.md.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { Writable } from 'node:stream'
import { createTestApp } from './helpers.js'
import type { GcsFilesClient } from '../../files/gcs-client.js'
import type { FilesClientResolver } from '../../files/files-api.js'

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
const mockWorkspaceMembership = vi.fn()

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

function makeResolver(
  active: GcsFilesClient,
  options: { bucket?: string; uriClients?: Map<string, GcsFilesClient>; uriScheme?: 'gs' | 's3' | 'file' } = {},
): FilesClientResolver {
  return {
    async forWorkspace() {
      return {
        gcs: active,
        bucket: options.bucket ?? 'active-bucket',
        uriScheme: options.uriScheme,
      }
    },
    async forUri(_workspaceId, storageUri) {
      for (const [prefix, client] of options.uriClients ?? []) {
        if (storageUri.startsWith(prefix)) return client
      }
      return active
    },
  }
}

function avatarOptions(gcs: GcsFilesClient, resolver = makeResolver(gcs)) {
  return {
    blobClient: gcs,
    filesResolver: resolver,
    workspaceMembership: mockWorkspaceMembership,
  }
}

describe('[COMP:api/account-avatar] Avatar routes', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockWorkspaceMembership.mockResolvedValue({ role: 'member' })
    mockUpdateUserAvatar.mockResolvedValue(true)
    mockClearUserAvatar.mockResolvedValue(true)
  })

  // ── POST /avatar ────────────────────────────────────────────

  it('uploads an image, writes the blob, returns an avatarUrl, and persists it', async () => {
    const gcs = makeFakeGcs()
    const app = createTestApp(
      '/api/account',
      accountRoutes(avatarOptions(gcs)),
      { userId: 'u_1' },
    )
    // No previous avatar to delete.
    mockFindUserById.mockResolvedValueOnce({ id: 'u_1', avatarStorageKey: null } as never)

    const res = await request(app)
      .post('/api/account/avatar')
      .field('workspaceId', 'ws_1')
      .attach('file', Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        filename: 'me.png',
        contentType: 'image/png',
      })

    expect(res.status).toBe(200)
    expect(res.body.avatarUrl).toMatch(/\/api\/account\/avatar\/u_1\?v=/)
    expect(mockWorkspaceMembership).toHaveBeenCalledWith('u_1', 'ws_1')
    // Blob key keeps workspaceId/avatar-id as the final two path components.
    expect(gcs.blobs.size).toBe(1)
    const [writtenKey] = [...gcs.blobs.keys()]
    expect(writtenKey).toMatch(/^ws_1\/[0-9a-f-]{36}$/)
    // Persisted with the same storage key, immutable origin, and proxy URL.
    expect(mockUpdateUserAvatar).toHaveBeenCalledTimes(1)
    const arg = mockUpdateUserAvatar.mock.calls[0][1]
    expect(arg.storageKey).toBe(writtenKey)
    expect(arg.storageWorkspaceId).toBe('ws_1')
    expect(arg.storageUri).toBe(`gs://active-bucket/${writtenKey}`)
    expect(arg.url).toBe(res.body.avatarUrl)
    expect(arg.previousStorageKey).toBeNull()
  })

  it('deletes the previous object through its recorded backend after a storage switch', async () => {
    const oldGcs = makeFakeGcs()
    const newGcs = makeFakeGcs()
    await oldGcs.writeBlob('ws_1/old', Buffer.from([1]), {
      workspaceId: 'ws_1',
      mime: 'image/png',
    })
    const resolver = makeResolver(newGcs, {
      bucket: 'new-bucket',
      uriClients: new Map([['gs://old-bucket/', oldGcs]]),
    })
    const app = createTestApp(
      '/api/account',
      accountRoutes(avatarOptions(newGcs, resolver)),
      { userId: 'u_1' },
    )
    mockFindUserById.mockResolvedValueOnce({
      id: 'u_1',
      avatarStorageKey: 'ws_1/old',
      avatarStorageWorkspaceId: 'ws_1',
      avatarStorageUri: 'gs://old-bucket/ws_1/old',
    } as never)

    const res = await request(app)
      .post('/api/account/avatar')
      .field('workspaceId', 'ws_1')
      .attach('file', Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        filename: 'new.png',
        contentType: 'image/png',
      })

    expect(res.status).toBe(200)
    // Old key gone, new key present.
    expect(oldGcs.blobs.has('ws_1/old')).toBe(false)
    expect(newGcs.blobs.size).toBe(1)
  })

  it('rejects an upload when the user is not a workspace member', async () => {
    const gcs = makeFakeGcs()
    mockWorkspaceMembership.mockResolvedValueOnce(null)
    const app = createTestApp('/api/account', accountRoutes(avatarOptions(gcs)), { userId: 'u_1' })

    const res = await request(app)
      .post('/api/account/avatar')
      .field('workspaceId', 'ws_other')
      .attach('file', Buffer.from([0x89]), { filename: 'me.png', contentType: 'image/png' })

    expect(res.status).toBe(403)
    expect(gcs.blobs.size).toBe(0)
    expect(mockUpdateUserAvatar).not.toHaveBeenCalled()
  })

  it('requires workspaceId for a new upload', async () => {
    const gcs = makeFakeGcs()
    const app = createTestApp('/api/account', accountRoutes(avatarOptions(gcs)), { userId: 'u_1' })
    const res = await request(app)
      .post('/api/account/avatar')
      .attach('file', Buffer.from([0x89]), { filename: 'me.png', contentType: 'image/png' })

    expect(res.status).toBe(400)
    expect(mockWorkspaceMembership).not.toHaveBeenCalled()
  })

  it('removes the newly written object when another avatar update wins', async () => {
    const gcs = makeFakeGcs()
    mockFindUserById.mockResolvedValueOnce({ id: 'u_1', avatarStorageKey: null } as never)
    mockUpdateUserAvatar.mockResolvedValueOnce(false)
    const res = await request(createTestApp('/api/account', accountRoutes(avatarOptions(gcs)), { userId: 'u_1' }))
      .post('/api/account/avatar')
      .field('workspaceId', 'ws_1')
      .attach('file', Buffer.from('png'), { filename: 'me.png', contentType: 'image/png' })
    expect(res.status).toBe(409)
    expect(gcs.blobs.size).toBe(0)
  })

  it('rejects a non-image MIME with 400 and writes nothing', async () => {
    const gcs = makeFakeGcs()
    const app = createTestApp(
      '/api/account',
      accountRoutes(avatarOptions(gcs)),
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
      accountRoutes(avatarOptions(gcs)),
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
      accountRoutes(avatarOptions(gcs)),
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

  it('removes an uploaded avatar through its recorded backend and clears the columns', async () => {
    const defaultGcs = makeFakeGcs()
    const recordedGcs = makeFakeGcs()
    await recordedGcs.writeBlob('ws_1/cur', Buffer.from([1]), {
      workspaceId: 'ws_1',
      mime: 'image/png',
    })
    const resolver = makeResolver(defaultGcs, {
      uriClients: new Map([['s3://avatar-bucket/', recordedGcs]]),
    })
    const app = createTestApp(
      '/api/account',
      accountRoutes(avatarOptions(defaultGcs, resolver)),
      { userId: 'u_1' },
    )
    mockFindUserById.mockResolvedValueOnce({
      id: 'u_1',
      avatarStorageKey: 'ws_1/cur',
      avatarStorageWorkspaceId: 'ws_1',
      avatarStorageUri: 's3://avatar-bucket/ws_1/cur',
    } as never)

    const res = await request(app).delete('/api/account/avatar')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(recordedGcs.blobs.has('ws_1/cur')).toBe(false)
    expect(defaultGcs.blobs.size).toBe(0)
    expect(mockClearUserAvatar).toHaveBeenCalledWith('u_1', 'ws_1/cur')
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
    const defaultGcs = makeFakeGcs()
    const recordedGcs = makeFakeGcs()
    await recordedGcs.writeBlob('ws_1/cur', Buffer.from([0x89, 0x50]), {
      workspaceId: 'ws_1',
      mime: 'image/png',
    })
    const resolver = makeResolver(defaultGcs, {
      uriClients: new Map([['s3://avatar-bucket/', recordedGcs]]),
    })
    // Public router mounts WITHOUT auth.
    const app = createTestApp('/api/account/avatar', accountAvatarPublicRoutes({
      blobClient: defaultGcs,
      filesResolver: resolver,
    }))
    mockFindUserById.mockResolvedValueOnce({
      id: 'u_1',
      avatarStorageKey: 'ws_1/cur',
      avatarStorageWorkspaceId: 'ws_1',
      avatarStorageUri: 's3://avatar-bucket/ws_1/cur',
    } as never)

    const res = await request(app).get('/api/account/avatar/u_1')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/image\/png/)
    expect(res.headers['cache-control']).toMatch(/max-age=3600/)
  })

  it('serves a legacy NULL-provenance avatar from the default client', async () => {
    const gcs = makeFakeGcs()
    await gcs.writeBlob('avatars/u_1/legacy', Buffer.from([0x89]), {
      workspaceId: 'u_1',
      mime: 'image/png',
    })
    const app = createTestApp('/api/account/avatar', accountAvatarPublicRoutes({
      blobClient: gcs,
      filesResolver: makeResolver(makeFakeGcs()),
    }))
    mockFindUserById.mockResolvedValueOnce({
      id: 'u_1',
      avatarStorageKey: 'avatars/u_1/legacy',
      avatarStorageWorkspaceId: null,
      avatarStorageUri: null,
    } as never)

    expect((await request(app).get('/api/account/avatar/u_1')).status).toBe(200)
  })

  it('returns 404 from the public proxy when the user has no uploaded avatar', async () => {
    const gcs = makeFakeGcs()
    const app = createTestApp('/api/account/avatar', accountAvatarPublicRoutes({
      blobClient: gcs,
      filesResolver: makeResolver(gcs),
    }))
    mockFindUserById.mockResolvedValueOnce({ id: 'u_1', avatarStorageKey: null } as never)

    const res = await request(app).get('/api/account/avatar/u_1')
    expect(res.status).toBe(404)
  })
})
