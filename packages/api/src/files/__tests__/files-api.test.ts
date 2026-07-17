import { describe, it, expect, vi } from 'vitest'
import { Writable } from 'node:stream'
import { createFilesApi, MAX_BYTES_PER_WORKSPACE, type FilesClientResolver } from '../files-api.js'
import { parseStorageBucket } from '../gcs-client.js'
import type { GcsFilesClient } from '../gcs-client.js'
import type {
  WorkspaceFile,
  WorkspaceFileCreateInput,
  WorkspaceFileIndexRow,
  WorkspaceFileMetaPatch,
  WorkspaceFilesStore,
} from '@sidanclaw/core'
import type { WorkspaceAuditStore } from '../../db/workspace-audit-store.js'

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
    async readBlob(key) {
      const b = blobs.get(key)
      if (!b) return null
      const mime = mimes.get(key) ?? 'application/octet-stream'
      return { bytes: b, mime, metadata: { workspaceId: '', mime } }
    },
    async statBlob(key) {
      const b = blobs.get(key)
      if (!b) return null
      return { sizeBytes: b.length, mime: mimes.get(key) ?? 'application/octet-stream', updatedAt: null }
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

function makeFakeStore(): WorkspaceFilesStore & { rows: Map<string, WorkspaceFile> } {
  const rows = new Map<string, WorkspaceFile>()
  return {
    rows,
    async create(_userId, input: WorkspaceFileCreateInput) {
      for (const r of rows.values()) {
        if (r.workspaceId === input.workspaceId && r.path === input.path) {
          const dupe = new Error('duplicate key value violates unique constraint "workspace_files_workspace_id_path_key"')
          throw dupe
        }
      }
      const id = input.id ?? `wf-${rows.size + 1}`
      const now = new Date()
      const row: WorkspaceFile = {
        id,
        workspaceId: input.workspaceId,
        path: input.path,
        parentPath: input.parentPath,
        name: input.name,
        title: input.title ?? null,
        summary: input.summary ?? null,
        mime: input.mime,
        sizeBytes: input.sizeBytes,
        tags: input.tags ?? [],
        relatedIds: input.relatedIds ?? [],
        storageUri: input.storageUri,
        sensitivity: input.sensitivity ?? 'internal',
        metadata: input.metadata ?? {},
        userId: input.userId ?? null,
        assistantId: input.assistantId ?? null,
        source: input.source ?? 'user',
        sourceEpisodeId: input.sourceEpisodeId ?? null,
        verifiedByUserId: null,
        verifiedAt: null,
        validFrom: now,
        validTo: null,
        supersededBy: null,
        retractedAt: null,
        retractedReason: null,
        retractedBy: null,
        createdByUserId: input.createdByUserId ?? null,
        createdByAssistantId: input.createdByAssistantId ?? null,
        createdAt: now,
        updatedAt: now,
      }
      rows.set(id, row)
      return row
    },
    async getById(ctx, id) {
      const r = rows.get(id)
      return r && r.workspaceId === ctx.workspaceId ? r : null
    },
    async getByPath(ctx, path) {
      for (const r of rows.values()) {
        if (r.workspaceId === ctx.workspaceId && r.path === path) return r
      }
      return null
    },
    async updateMeta(_userId, workspaceId, id, patch: WorkspaceFileMetaPatch) {
      const r = rows.get(id)
      if (!r || r.workspaceId !== workspaceId) return null
      if (patch.title !== undefined) r.title = patch.title
      if (patch.summary !== undefined) r.summary = patch.summary
      if (patch.tags !== undefined) r.tags = patch.tags
      if (patch.relatedIds !== undefined) r.relatedIds = patch.relatedIds
      if (patch.sensitivity !== undefined) r.sensitivity = patch.sensitivity
      r.updatedAt = new Date()
      return r
    },
    async updateSize(_userId, workspaceId, id, sizeBytes) {
      const r = rows.get(id)
      if (!r || r.workspaceId !== workspaceId) return null
      r.sizeBytes = sizeBytes
      r.updatedAt = new Date()
      return r
    },
    async delete(_userId, workspaceId, id) {
      const r = rows.get(id)
      if (!r || r.workspaceId !== workspaceId) return false
      rows.delete(id)
      return true
    },
    async listByPath() { return [] as WorkspaceFileIndexRow[] },
    async searchByText() { return [] as WorkspaceFileIndexRow[] },
    async listIndexRanked() { return [] as WorkspaceFileIndexRow[] },
    async sumSizeBytes(ctx) {
      let sum = 0
      for (const r of rows.values()) {
        if (r.workspaceId === ctx.workspaceId) sum += r.sizeBytes
      }
      return sum
    },
    async supersede() { return null },
    async getHistory() { return [] },
    async retractByStorageBucketSystem(workspaceId, bucket, scheme, _reason) {
      let n = 0
      for (const r of rows.values()) {
        if (r.workspaceId === workspaceId && r.storageUri.startsWith(`${scheme}://${bucket}/`) && !r.retractedAt) {
          r.retractedAt = new Date()
          r.validTo = new Date()
          n++
        }
      }
      return n
    },
  }
}

function makeFakeAudit(): WorkspaceAuditStore & { events: Array<{ eventType: string; subjectId: string | null; details: Record<string, unknown> }> } {
  const events: Array<{ eventType: string; subjectId: string | null; details: Record<string, unknown> }> = []
  return {
    events,
    async append(params) {
      events.push({
        eventType: params.eventType,
        subjectId: params.subjectId ?? null,
        details: params.details ?? {},
      })
    },
    async list() { return [] },
  }
}

const ctx = { workspaceId: 'workspace_1', userId: 'user_1', assistantId: 'assistant_1' }

describe('[COMP:files/api] createFilesApi.write', () => {
  it('writes blob, inserts row, emits audit', async () => {
    const gcs = makeFakeGcs()
    const store = makeFakeStore()
    const audit = makeFakeAudit()
    const api = createFilesApi({ gcs, store, auditStore: audit, bucket: 'sidanclaw-files-test' })
    const result = await api.write(ctx, { path: '/notes.md', content: 'hello world' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(gcs.blobs.size).toBe(1)
    const blob = [...gcs.blobs.values()][0]
    expect(blob.toString('utf-8')).toBe('hello world')
    expect(store.rows.size).toBe(1)
    expect(audit.events).toHaveLength(1)
    expect(audit.events[0].eventType).toBe('file.created')
    expect(audit.events[0].details).toMatchObject({ path: '/notes.md', mime: 'text/markdown', size_bytes: 11 })
  })

  it('rejects duplicate path with conflict', async () => {
    const api = createFilesApi({
      gcs: makeFakeGcs(),
      store: makeFakeStore(),
      auditStore: makeFakeAudit(),
      bucket: 'b',
    })
    await api.write(ctx, { path: '/x.md', content: '1' })
    const second = await api.write(ctx, { path: '/x.md', content: '2' })
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.error.kind).toBe('conflict')
    }
  })

  it('rejects when quota would be exceeded', async () => {
    const gcs = makeFakeGcs()
    const store = makeFakeStore()
    // Pre-fill store with bytes near the cap.
    await store.create('user_1', {
      workspaceId: ctx.workspaceId,
      path: '/big.bin',
      parentPath: '/',
      name: 'big.bin',
      mime: 'application/octet-stream',
      sizeBytes: MAX_BYTES_PER_WORKSPACE - 10,
      storageUri: 'gs://b/k',
    })
    const api = createFilesApi({ gcs, store, auditStore: makeFakeAudit(), bucket: 'b' })
    const result = await api.write(ctx, { path: '/over.md', content: 'this is more than ten bytes' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('quota_exceeded')
    }
    // No blob should have been written.
    expect(gcs.blobs.size).toBe(0)
  })

  it('rolls back GCS blob on DB insert failure', async () => {
    const gcs = makeFakeGcs()
    const store = makeFakeStore()
    const originalCreate = store.create.bind(store)
    store.create = vi.fn(async () => {
      throw new Error('simulated DB failure')
    }) as typeof store.create

    const api = createFilesApi({ gcs, store, auditStore: makeFakeAudit(), bucket: 'b' })
    await expect(api.write(ctx, { path: '/r.md', content: 'data' })).rejects.toThrow('simulated DB failure')
    expect(gcs.blobs.size).toBe(0)
    expect(originalCreate).toBeDefined()
  })
})

describe('[COMP:files/api] createFilesApi.writeBytes', () => {
  it('stores raw binary bytes verbatim with the given mime', async () => {
    const gcs = makeFakeGcs()
    const store = makeFakeStore()
    const audit = makeFakeAudit()
    const api = createFilesApi({ gcs, store, auditStore: audit, bucket: 'b' })

    // Bytes that are NOT valid UTF-8 — a utf-8 round-trip (the `write` path)
    // would corrupt these. JPEG SOI + a high byte.
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00])
    const result = await api.writeBytes(ctx, {
      path: '/uploads/photo.jpg',
      bytes,
      mime: 'image/jpeg',
      title: 'Photo',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.mime).toBe('image/jpeg')
    expect(result.value.sizeBytes).toBe(5)
    const blob = [...gcs.blobs.values()][0]
    expect([...blob]).toEqual([0xff, 0xd8, 0xff, 0xe0, 0x00]) // byte-exact, not re-encoded
    expect(audit.events.find((e) => e.eventType === 'file.created')).toBeTruthy()
  })

  it('rejects a duplicate path with conflict (no overwrite)', async () => {
    const api = createFilesApi({
      gcs: makeFakeGcs(),
      store: makeFakeStore(),
      auditStore: makeFakeAudit(),
      bucket: 'b',
    })
    await api.writeBytes(ctx, { path: '/u/a.png', bytes: new Uint8Array([1]), mime: 'image/png' })
    const second = await api.writeBytes(ctx, { path: '/u/a.png', bytes: new Uint8Array([2]), mime: 'image/png' })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error.kind).toBe('conflict')
  })
})

describe('[COMP:files/api] createFilesApi.append', () => {
  it('grows blob + bumps row size + audits', async () => {
    const gcs = makeFakeGcs()
    const store = makeFakeStore()
    const audit = makeFakeAudit()
    const api = createFilesApi({ gcs, store, auditStore: audit, bucket: 'b' })
    await api.write(ctx, { path: '/log.md', content: 'one\n' })
    const result = await api.append(ctx, '/log.md', 'two\n')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.sizeBytes).toBe(8)
    const blob = [...gcs.blobs.values()][0]
    expect(blob.toString('utf-8')).toBe('one\ntwo\n')
    expect(audit.events.find((e) => e.eventType === 'file.appended')).toBeTruthy()
  })

  it('not_found when path does not exist', async () => {
    const api = createFilesApi({
      gcs: makeFakeGcs(),
      store: makeFakeStore(),
      auditStore: makeFakeAudit(),
      bucket: 'b',
    })
    const result = await api.append(ctx, '/missing.md', 'x')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('not_found')
  })
})

describe('[COMP:files/api] createFilesApi.read', () => {
  it('returns content + entry', async () => {
    const api = createFilesApi({
      gcs: makeFakeGcs(),
      store: makeFakeStore(),
      auditStore: makeFakeAudit(),
      bucket: 'b',
    })
    await api.write(ctx, { path: '/r.md', content: 'payload' })
    const result = await api.read(ctx, '/r.md')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.content).toBe('payload')
    expect(result.value.file.path).toBe('/r.md')
  })

  it('returns not_found when row missing', async () => {
    const api = createFilesApi({
      gcs: makeFakeGcs(),
      store: makeFakeStore(),
      auditStore: makeFakeAudit(),
      bucket: 'b',
    })
    const result = await api.read(ctx, '/nope.md')
    expect(result.ok).toBe(false)
  })
})

describe('[COMP:files/api] createFilesApi.stat', () => {
  it('returns the row without touching the blob layer', async () => {
    const gcs = makeFakeGcs()
    const store = makeFakeStore()
    const api = createFilesApi({ gcs, store, auditStore: makeFakeAudit(), bucket: 'b' })
    await api.write(ctx, { path: '/s.md', content: 'payload' })

    // Blow away the blob — stat must still succeed (metadata only).
    gcs.blobs.clear()
    const result = await api.stat(ctx, '/s.md')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.path).toBe('/s.md')
    expect(result.value.sizeBytes).toBe(Buffer.byteLength('payload'))
  })

  it('returns not_found when row missing', async () => {
    const api = createFilesApi({
      gcs: makeFakeGcs(),
      store: makeFakeStore(),
      auditStore: makeFakeAudit(),
      bucket: 'b',
    })
    const result = await api.stat(ctx, '/nope.md')
    expect(result.ok).toBe(false)
  })
})

describe('[COMP:files/api] createFilesApi.readBytes', () => {
  it('returns the raw bytes verbatim (binary-safe, no UTF-8 decode)', async () => {
    const api = createFilesApi({
      gcs: makeFakeGcs(),
      store: makeFakeStore(),
      auditStore: makeFakeAudit(),
      bucket: 'b',
    })
    // Bytes that do NOT round-trip through a UTF-8 decode (0xFF is invalid).
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x01])
    await api.writeBytes(ctx, { path: '/img.png', bytes: original, mime: 'image/png' })

    const result = await api.readBytes(ctx, '/img.png')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Buffer.from(result.value.bytes).equals(original)).toBe(true)
    expect(result.value.file.mime).toBe('image/png')
  })

  it('returns not_found when the blob is missing (orphaned row)', async () => {
    const gcs = makeFakeGcs()
    const store = makeFakeStore()
    const api = createFilesApi({ gcs, store, auditStore: makeFakeAudit(), bucket: 'b' })
    await api.write(ctx, { path: '/orphan.md', content: 'x' })
    gcs.blobs.clear()
    const result = await api.readBytes(ctx, '/orphan.md')
    expect(result.ok).toBe(false)
  })
})

describe('[COMP:files/api] createFilesApi.delete', () => {
  it('removes blob and row, emits audit', async () => {
    const gcs = makeFakeGcs()
    const store = makeFakeStore()
    const audit = makeFakeAudit()
    const api = createFilesApi({ gcs, store, auditStore: audit, bucket: 'b' })
    await api.write(ctx, { path: '/d.md', content: 'x' })
    const result = await api.delete(ctx, '/d.md')
    expect(result.ok).toBe(true)
    expect(gcs.blobs.size).toBe(0)
    expect(store.rows.size).toBe(0)
    expect(audit.events.find((e) => e.eventType === 'file.deleted')).toBeTruthy()
  })
})

describe('[COMP:files/byo-resolver] per-workspace client routing', () => {
  // Two named buckets behind a single resolver: the workspace's CURRENT
  // target ("byo-bucket") for new writes, and an older "app-bucket" that
  // pre-BYO files still live in. forUri must route by each file's storage_uri.
  function makeRoutingHarness() {
    const appGcs = makeFakeGcs()
    const byoGcs = makeFakeGcs()
    const resolver: FilesClientResolver = {
      async forWorkspace() {
        return { gcs: byoGcs, bucket: 'byo-bucket', byo: true }
      },
      async forUri(_workspaceId, storageUri) {
        return parseStorageBucket(storageUri) === 'byo-bucket' ? byoGcs : appGcs
      },
    }
    return { appGcs, byoGcs, resolver }
  }

  it('writes new files to the workspace forWorkspace() bucket', async () => {
    const { appGcs, byoGcs, resolver } = makeRoutingHarness()
    const api = createFilesApi({ resolver, store: makeFakeStore(), auditStore: makeFakeAudit() })
    const result = await api.write(ctx, { path: '/n.md', content: 'hi' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.storageUri.startsWith('gs://byo-bucket/')).toBe(true)
    expect(byoGcs.blobs.size).toBe(1)
    expect(appGcs.blobs.size).toBe(0)
  })

  it('reads an existing file from the bucket recorded in its storage_uri', async () => {
    const { appGcs, byoGcs, resolver } = makeRoutingHarness()
    const store = makeFakeStore()
    // Simulate a file written BEFORE the BYO switch: bytes in app-bucket, and a
    // matching index row whose storage_uri points there.
    const fileId = 'pre-byo-1'
    await appGcs.writeBlob(`${ctx.workspaceId}/${fileId}`, Buffer.from('legacy'), {
      workspaceId: ctx.workspaceId,
      mime: 'text/plain',
    })
    await store.create('user_1', {
      id: fileId,
      workspaceId: ctx.workspaceId,
      path: '/legacy.md',
      parentPath: '/',
      name: 'legacy.md',
      mime: 'text/plain',
      sizeBytes: 6,
      storageUri: `gs://app-bucket/${ctx.workspaceId}/${fileId}`,
    })
    const api = createFilesApi({ resolver, store, auditStore: makeFakeAudit() })
    const result = await api.read(ctx, '/legacy.md')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.content).toBe('legacy') // came from app-bucket, not byo-bucket
    expect(byoGcs.blobs.size).toBe(0)
  })

  it('lifts the soft quota when the workspace is on BYO storage', async () => {
    const { resolver } = makeRoutingHarness() // forWorkspace().byo === true
    const store = makeFakeStore()
    await store.create('user_1', {
      workspaceId: ctx.workspaceId,
      path: '/big.bin',
      parentPath: '/',
      name: 'big.bin',
      mime: 'application/octet-stream',
      sizeBytes: MAX_BYTES_PER_WORKSPACE - 1,
      storageUri: 'gs://byo-bucket/k',
    })
    const api = createFilesApi({ resolver, store, auditStore: makeFakeAudit() })
    const result = await api.write(ctx, { path: '/more.md', content: 'well over one byte' })
    expect(result.ok).toBe(true) // no quota_exceeded — cap lifted under BYO
  })
})

describe('[COMP:files/api] createFilesApi.setMeta', () => {
  it('patches only supplied fields and audits', async () => {
    const audit = makeFakeAudit()
    const api = createFilesApi({
      gcs: makeFakeGcs(),
      store: makeFakeStore(),
      auditStore: audit,
      bucket: 'b',
    })
    await api.write(ctx, { path: '/m.md', content: 'x', title: 'Old' })
    const result = await api.setMeta(ctx, '/m.md', { title: 'New', tags: ['t'] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.title).toBe('New')
    expect(result.value.tags).toEqual(['t'])
    const event = audit.events.find((e) => e.eventType === 'file.meta_updated')
    expect(event).toBeTruthy()
    expect(event!.details.fields).toEqual(expect.arrayContaining(['title', 'tags']))
  })
})
