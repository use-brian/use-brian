/**
 * [COMP:api/workspace-icon] Upload, remove, public proxy, and concurrency.
 */

import { Writable } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'
import type { GcsFilesClient } from '../../files/gcs-client.js'
import type { FilesClientResolver } from '../../files/files-api.js'

vi.mock('../../db/workspace-icon.js', () => ({
  getWorkspaceIconPointer: vi.fn(),
  replaceWorkspaceIconPointer: vi.fn(),
  clearWorkspaceIconPointer: vi.fn(),
}))

vi.mock('../../brain-stream/notify.js', () => ({
  notifyWorkspaceChange: vi.fn(),
}))

import {
  workspaceIconPublicRoutes,
  workspaceIconRoutes,
} from '../workspace-icon.js'
import {
  clearWorkspaceIconPointer,
  getWorkspaceIconPointer,
  replaceWorkspaceIconPointer,
} from '../../db/workspace-icon.js'
import { notifyWorkspaceChange } from '../../brain-stream/notify.js'

const mockGetPointer = vi.mocked(getWorkspaceIconPointer)
const mockReplacePointer = vi.mocked(replaceWorkspaceIconPointer)
const mockClearPointer = vi.mocked(clearWorkspaceIconPointer)
const mockNotify = vi.mocked(notifyWorkspaceChange)

function makeFakeGcs(): GcsFilesClient & {
  blobs: Map<string, Buffer>
  mimes: Map<string, string>
} {
  const blobs = new Map<string, Buffer>()
  const mimes = new Map<string, string>()
  return {
    blobs,
    mimes,
    async writeBlob(key, bytes, metadata) {
      blobs.set(key, bytes)
      mimes.set(key, metadata.mime)
    },
    async appendBlob() {},
    async readBlob(key) {
      const bytes = blobs.get(key)
      if (!bytes) return null
      const mime = mimes.get(key) ?? 'application/octet-stream'
      return { bytes, mime, metadata: { workspaceId: 'ws-1', mime } }
    },
    async statBlob(key) {
      const bytes = blobs.get(key)
      if (!bytes) return null
      return {
        sizeBytes: bytes.length,
        mime: mimes.get(key) ?? 'application/octet-stream',
        updatedAt: null,
      }
    },
    async deleteBlob(key) {
      blobs.delete(key)
      mimes.delete(key)
    },
    async signedReadUrl(key) {
      return `https://signed.example/${key}`
    },
    async signedWriteUrl(key) {
      return `https://signed.example/${key}?write=1`
    },
    writeStream(key, options) {
      const chunks: Buffer[] = []
      return new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(Buffer.from(chunk))
          callback()
        },
        final(callback) {
          blobs.set(key, Buffer.concat(chunks))
          mimes.set(key, options.mime)
          callback()
        },
      })
    },
  }
}

function makeResolver(
  active: GcsFilesClient,
  uriClients = new Map<string, GcsFilesClient>(),
): FilesClientResolver {
  return {
    async forWorkspace() {
      return { gcs: active, bucket: 'active-bucket', uriScheme: 'gs' }
    },
    async forUri(_workspaceId, storageUri) {
      for (const [prefix, client] of uriClients) {
        if (storageUri.startsWith(prefix)) return client
      }
      return active
    },
  }
}

const workspaceStore = { getRole: vi.fn() }
const auditStore = { append: vi.fn() }

function authedApp(
  gcs?: GcsFilesClient,
  resolver = gcs ? makeResolver(gcs) : undefined,
) {
  return createTestApp(
    '/api/workspaces',
    workspaceIconRoutes({
      workspaceStore: workspaceStore as never,
      auditStore: auditStore as never,
      blobClient: gcs,
      filesResolver: resolver,
    }),
    { userId: 'u-1' },
  )
}

describe('[COMP:api/workspace-icon] routes', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    workspaceStore.getRole.mockResolvedValue('admin')
    mockGetPointer.mockResolvedValue({
      iconUrl: null,
      iconStorageKey: null,
      iconStorageUri: null,
    })
    mockReplacePointer.mockImplementation(async (_workspaceId, _expected, next) => ({
      iconUrl: next.iconUrl,
      iconStorageKey: next.iconStorageKey,
      iconStorageUri: next.iconStorageUri,
    }))
    mockClearPointer.mockResolvedValue(true)
  })

  it('uploads an allowed image, persists a versioned proxy pointer, and signals chrome', async () => {
    const gcs = makeFakeGcs()
    const res = await request(authedApp(gcs))
      .post('/api/workspaces/ws-1/icon')
      .attach('file', Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        filename: 'team.png',
        contentType: 'image/png',
      })

    expect(res.status).toBe(200)
    expect(res.body.iconUrl).toMatch(/\/api\/workspace-icons\/ws-1\?v=/)
    expect(gcs.blobs.size).toBe(1)
    const [key] = [...gcs.blobs.keys()]
    expect(key).toMatch(/^ws-1\/workspace-icons\/[0-9a-f-]{36}$/)
    expect(mockReplacePointer).toHaveBeenCalledWith(
      'ws-1',
      null,
      expect.objectContaining({
        iconUrl: res.body.iconUrl,
        iconStorageKey: key,
        iconStorageUri: `gs://active-bucket/${key}`,
      }),
    )
    expect(mockNotify).toHaveBeenCalledWith('ws-1', 'workspace_config', 'update')
    expect(auditStore.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'workspace.icon_changed',
        details: { kind: 'uploaded' },
      }),
    )
  })

  it('requires an admin and returns 503 when storage is not configured', async () => {
    const gcs = makeFakeGcs()
    workspaceStore.getRole.mockResolvedValueOnce('member')
    expect(
      (
        await request(authedApp(gcs))
          .post('/api/workspaces/ws-1/icon')
          .attach('file', Buffer.from('png'), {
            filename: 'team.png',
            contentType: 'image/png',
          })
      ).status,
    ).toBe(403)

    workspaceStore.getRole.mockResolvedValueOnce('admin')
    expect(
      (
        await request(authedApp())
          .post('/api/workspaces/ws-1/icon')
          .attach('file', Buffer.from('png'), {
            filename: 'team.png',
            contentType: 'image/png',
          })
      ).status,
    ).toBe(503)
  })

  it('rejects SVG and an oversized image before writing', async () => {
    const gcs = makeFakeGcs()
    const svg = await request(authedApp(gcs))
      .post('/api/workspaces/ws-1/icon')
      .attach('file', Buffer.from('<svg/>'), {
        filename: 'team.svg',
        contentType: 'image/svg+xml',
      })
    expect(svg.status).toBe(400)
    expect(gcs.blobs.size).toBe(0)

    const oversized = await request(authedApp(gcs))
      .post('/api/workspaces/ws-1/icon')
      .attach('file', Buffer.alloc(5 * 1024 * 1024 + 1), {
        filename: 'large.png',
        contentType: 'image/png',
      })
    expect(oversized.status).toBe(413)
    expect(gcs.blobs.size).toBe(0)
  })

  it('deletes a losing concurrent upload instead of orphaning it', async () => {
    const gcs = makeFakeGcs()
    mockReplacePointer.mockResolvedValueOnce(null)
    const res = await request(authedApp(gcs))
      .post('/api/workspaces/ws-1/icon')
      .attach('file', Buffer.from('png'), {
        filename: 'team.png',
        contentType: 'image/png',
      })
    expect(res.status).toBe(409)
    expect(gcs.blobs.size).toBe(0)
    expect(mockNotify).not.toHaveBeenCalled()
  })

  it('clears the pointer before deleting the old object through its recorded backend', async () => {
    const active = makeFakeGcs()
    const old = makeFakeGcs()
    await old.writeBlob('ws-1/workspace-icons/old', Buffer.from('old'), {
      workspaceId: 'ws-1',
      mime: 'image/webp',
    })
    mockGetPointer.mockResolvedValueOnce({
      iconUrl: 'https://api.example/api/workspace-icons/ws-1?v=old',
      iconStorageKey: 'ws-1/workspace-icons/old',
      iconStorageUri: 's3://old-bucket/ws-1/workspace-icons/old',
    })
    const resolver = makeResolver(
      active,
      new Map([['s3://old-bucket/', old]]),
    )
    const res = await request(authedApp(active, resolver)).delete(
      '/api/workspaces/ws-1/icon',
    )

    expect(res.status).toBe(200)
    expect(res.body.iconUrl).toBeNull()
    expect(mockClearPointer).toHaveBeenCalledWith(
      'ws-1',
      'ws-1/workspace-icons/old',
    )
    expect(old.blobs.size).toBe(0)
    expect(mockNotify).toHaveBeenCalledWith('ws-1', 'workspace_config', 'update')
  })

  it('serves image bytes from the public proxy and rejects non-image stored MIME', async () => {
    const gcs = makeFakeGcs()
    await gcs.writeBlob('ws-1/workspace-icons/current', Buffer.from('image'), {
      workspaceId: 'ws-1',
      mime: 'image/png',
    })
    mockGetPointer.mockResolvedValue({
      iconUrl: 'https://api.example/api/workspace-icons/ws-1?v=current',
      iconStorageKey: 'ws-1/workspace-icons/current',
      iconStorageUri: 'gs://active-bucket/ws-1/workspace-icons/current',
    })
    const publicApp = createTestApp(
      '/api/workspace-icons',
      workspaceIconPublicRoutes({
        blobClient: gcs,
        filesResolver: makeResolver(gcs),
      }),
    )

    const image = await request(publicApp).get('/api/workspace-icons/ws-1')
    expect(image.status).toBe(200)
    expect(image.headers['content-type']).toMatch(/image\/png/)
    expect(image.headers['x-content-type-options']).toBe('nosniff')
    expect(image.headers['cache-control']).toContain('max-age=3600')

    gcs.mimes.set('ws-1/workspace-icons/current', 'text/html')
    expect(
      (await request(publicApp).get('/api/workspace-icons/ws-1')).status,
    ).toBe(404)
  })
})
