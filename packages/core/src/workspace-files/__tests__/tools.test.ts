import { describe, it, expect } from 'vitest'
import { createFileTools, type FileToolEvent } from '../tools.js'
import type { FilesApi, FilesContext, FilesError, FilesResult } from '../api.js'
import type { WorkspaceFile, WorkspaceFileIndexRow, WorkspaceFileMetaPatch } from '../types.js'

// ── Fake FilesApi ────────────────────────────────────────────
//
// In-memory mirror of the real api: tracks files keyed by id, exposes
// path lookup, and synthesizes WorkspaceFile records on write. Errors
// (quota / not-found / conflict) are returned via the FilesResult
// envelope, matching the production contract.

type FakeFile = WorkspaceFile & { content: string }

function buildFakeApi(): FilesApi & {
  files: Map<string, FakeFile>
  quotaLimit: number
  setQuotaLimit(n: number): void
  totalBytes(): number
} {
  const files = new Map<string, FakeFile>()
  let nextId = 100
  let quotaLimit = Number.MAX_SAFE_INTEGER

  function totalBytes(): number {
    let sum = 0
    for (const f of files.values()) sum += f.sizeBytes
    return sum
  }

  function findByPath(workspaceId: string, path: string): FakeFile | null {
    for (const f of files.values()) {
      if (f.workspaceId === workspaceId && f.path === path) return f
    }
    return null
  }

  function findByIdOrPath(ctx: FilesContext, ref: string): FakeFile | null {
    if (files.has(ref)) {
      const f = files.get(ref)!
      return f.workspaceId === ctx.workspaceId ? f : null
    }
    return findByPath(ctx.workspaceId, ref)
  }

  function indexRow(f: FakeFile): WorkspaceFileIndexRow {
    return {
      id: f.id,
      workspaceId: f.workspaceId,
      path: f.path,
      parentPath: f.parentPath,
      name: f.name,
      title: f.title,
      summary: f.summary,
      mime: f.mime,
      sizeBytes: f.sizeBytes,
      tags: f.tags,
      sensitivity: f.sensitivity,
      updatedAt: f.updatedAt,
    }
  }

  return {
    files,
    quotaLimit,
    setQuotaLimit(n) { quotaLimit = n },
    totalBytes,

    async write(ctx, params): Promise<FilesResult<WorkspaceFile>> {
      if (findByPath(ctx.workspaceId, params.path)) {
        return { ok: false, error: { kind: 'conflict', path: params.path } }
      }
      const bytes = Buffer.from(params.content, 'utf-8').length
      if (totalBytes() + bytes > quotaLimit) {
        return {
          ok: false,
          error: {
            kind: 'quota_exceeded',
            currentBytes: totalBytes(),
            limitBytes: quotaLimit,
            attemptedBytes: bytes,
          } satisfies FilesError,
        }
      }
      const id = `00000000-0000-0000-0000-${String(nextId++).padStart(12, '0')}`
      const now = new Date()
      const file: FakeFile = {
        id,
        workspaceId: ctx.workspaceId,
        path: params.path,
        parentPath: '/',
        name: params.path.split('/').pop() ?? params.path,
        title: params.title ?? null,
        summary: params.summary ?? null,
        mime: params.mime ?? 'text/plain',
        sizeBytes: bytes,
        tags: params.tags ?? [],
        relatedIds: [],
        storageUri: `gs://test/${ctx.workspaceId}/${id}`,
        sensitivity: params.sensitivity ?? 'internal',
        metadata: {},
        userId: null,
        assistantId: null,
        source: 'user',
        sourceEpisodeId: null,
        verifiedByUserId: null,
        verifiedAt: null,
        validFrom: now,
        validTo: null,
        supersededBy: null,
        retractedAt: null,
        retractedReason: null,
        retractedBy: null,
        createdByUserId: ctx.userId,
        createdByAssistantId: ctx.assistantId ?? null,
        createdAt: now,
        updatedAt: now,
        content: params.content,
      }
      files.set(id, file)
      return { ok: true, value: { ...file } }
    },

    async writeBytes(ctx, params): Promise<FilesResult<WorkspaceFile>> {
      if (findByPath(ctx.workspaceId, params.path)) {
        return { ok: false, error: { kind: 'conflict', path: params.path } }
      }
      const bytes = params.bytes.length
      if (totalBytes() + bytes > quotaLimit) {
        return {
          ok: false,
          error: {
            kind: 'quota_exceeded',
            currentBytes: totalBytes(),
            limitBytes: quotaLimit,
            attemptedBytes: bytes,
          } satisfies FilesError,
        }
      }
      const id = `00000000-0000-0000-0000-${String(nextId++).padStart(12, '0')}`
      const now = new Date()
      const file: FakeFile = {
        id,
        workspaceId: ctx.workspaceId,
        path: params.path,
        parentPath: '/',
        name: params.path.split('/').pop() ?? params.path,
        title: params.title ?? null,
        summary: params.summary ?? null,
        mime: params.mime,
        sizeBytes: bytes,
        tags: params.tags ?? [],
        relatedIds: [],
        storageUri: `gs://test/${ctx.workspaceId}/${id}`,
        sensitivity: params.sensitivity ?? 'internal',
        metadata: {},
        userId: null,
        assistantId: null,
        source: 'user',
        sourceEpisodeId: null,
        verifiedByUserId: null,
        verifiedAt: null,
        validFrom: now,
        validTo: null,
        supersededBy: null,
        retractedAt: null,
        retractedReason: null,
        retractedBy: null,
        createdByUserId: ctx.userId,
        createdByAssistantId: ctx.assistantId ?? null,
        createdAt: now,
        updatedAt: now,
        // Fake mirror keeps the raw bytes (base64) so tests can assert the
        // original was preserved, not a text summary.
        content: Buffer.from(params.bytes).toString('base64'),
      }
      files.set(id, file)
      return { ok: true, value: { ...file } }
    },

    async append(ctx, idOrPath, content) {
      const f = findByIdOrPath(ctx, idOrPath)
      if (!f) return { ok: false, error: { kind: 'not_found', reference: idOrPath } }
      const bytes = Buffer.from(content, 'utf-8').length
      if (totalBytes() + bytes > quotaLimit) {
        return {
          ok: false,
          error: {
            kind: 'quota_exceeded',
            currentBytes: totalBytes(),
            limitBytes: quotaLimit,
            attemptedBytes: bytes,
          },
        }
      }
      f.content += content
      f.sizeBytes += bytes
      f.updatedAt = new Date()
      return { ok: true, value: { ...f } }
    },

    async stat(ctx, idOrPath) {
      const f = findByIdOrPath(ctx, idOrPath)
      if (!f) return { ok: false, error: { kind: 'not_found', reference: idOrPath } }
      return { ok: true, value: { ...f } }
    },

    async read(ctx, idOrPath) {
      const f = findByIdOrPath(ctx, idOrPath)
      if (!f) return { ok: false, error: { kind: 'not_found', reference: idOrPath } }
      return { ok: true, value: { file: { ...f }, content: f.content } }
    },

    async readBytes(ctx, idOrPath) {
      const f = findByIdOrPath(ctx, idOrPath)
      if (!f) return { ok: false, error: { kind: 'not_found', reference: idOrPath } }
      return { ok: true, value: { file: { ...f }, bytes: Buffer.from(f.content, 'utf-8') } }
    },

    async search(ctx, params) {
      const rows: WorkspaceFileIndexRow[] = []
      for (const f of files.values()) {
        if (f.workspaceId !== ctx.workspaceId) continue
        if (params.tag && !f.tags.includes(params.tag)) continue
        if (params.parentPath && f.parentPath !== params.parentPath) continue
        if (params.query) {
          const hay = `${f.title ?? ''} ${f.summary ?? ''} ${f.tags.join(' ')} ${f.name}`.toLowerCase()
          if (!hay.includes(params.query.toLowerCase())) continue
        }
        rows.push(indexRow(f))
      }
      const limit = params.limit ?? 25
      return rows.slice(0, limit)
    },

    async setMeta(ctx, idOrPath, patch: WorkspaceFileMetaPatch) {
      const f = findByIdOrPath(ctx, idOrPath)
      if (!f) return { ok: false, error: { kind: 'not_found', reference: idOrPath } }
      if (patch.title !== undefined) f.title = patch.title
      if (patch.summary !== undefined) f.summary = patch.summary
      if (patch.tags !== undefined) f.tags = patch.tags
      if (patch.relatedIds !== undefined) f.relatedIds = patch.relatedIds
      if (patch.sensitivity !== undefined) f.sensitivity = patch.sensitivity
      f.updatedAt = new Date()
      return { ok: true, value: { ...f } }
    },

    async delete(ctx, idOrPath) {
      const f = findByIdOrPath(ctx, idOrPath)
      if (!f) return { ok: false, error: { kind: 'not_found', reference: idOrPath } }
      files.delete(f.id)
      return { ok: true, value: { id: f.id, path: f.path } }
    },
  }
}

// ── Fixtures ─────────────────────────────────────────────────

const ctx = {
  assistantId: 'assistant_1',
  userId: 'user_1',
  sessionId: 'session_1',
  appId: 'sidanclaw',
  channelType: 'web',
  channelId: 'c_1',
  workspaceId: 'workspace_1',
  abortSignal: new AbortController().signal,
}
const ctxNoWorkspace = { ...ctx, workspaceId: null }
const UUID_REF = '11111111-1111-1111-1111-111111111111'

// ── Tests ────────────────────────────────────────────────────

describe('[COMP:files/tools] fileWrite', () => {
  it('saves a new file at the requested path', async () => {
    const api = buildFakeApi()
    const events: FileToolEvent[] = []
    const { fileWrite } = createFileTools(api, { onEvent: (e) => events.push(e) })
    const result = await fileWrite.execute({ path: '/notes.md', content: 'Hello' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(api.files.size).toBe(1)
    const stored = [...api.files.values()][0]
    expect(stored.path).toBe('/notes.md')
    expect(stored.sizeBytes).toBe(5)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'file_created', path: '/notes.md', sizeBytes: 5 })
  })

  it('returns isError when the workspace is missing', async () => {
    const api = buildFakeApi()
    const { fileWrite } = createFileTools(api)
    const result = await fileWrite.execute({ path: '/x.md', content: 'x' }, ctxNoWorkspace)
    expect(result.isError).toBe(true)
    expect(api.files.size).toBe(0)
  })

  it('surfaces conflict for duplicate path', async () => {
    const api = buildFakeApi()
    const { fileWrite } = createFileTools(api)
    await fileWrite.execute({ path: '/notes.md', content: 'first' }, ctx)
    const second = await fileWrite.execute({ path: '/notes.md', content: 'second' }, ctx)
    expect(second.isError).toBe(true)
    expect(api.files.size).toBe(1)
  })

  it('surfaces quota exceeded', async () => {
    const api = buildFakeApi()
    api.setQuotaLimit(4)
    const { fileWrite } = createFileTools(api)
    const result = await fileWrite.execute({ path: '/big.md', content: 'longer than limit' }, ctx)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('quota')
    expect(api.files.size).toBe(0)
  })

  it('passes title/summary/tags through', async () => {
    const api = buildFakeApi()
    const { fileWrite } = createFileTools(api)
    await fileWrite.execute(
      {
        path: '/labelled.md',
        content: 'body',
        title: 'Label',
        summary: 'A short summary',
        tags: ['draft', 'finance'],
      },
      ctx,
    )
    const stored = [...api.files.values()][0]
    expect(stored.title).toBe('Label')
    expect(stored.summary).toBe('A short summary')
    expect(stored.tags).toEqual(['draft', 'finance'])
  })
})

describe('[COMP:files/tools] fileRead', () => {
  it('returns content + metadata for an existing file', async () => {
    const api = buildFakeApi()
    const { fileWrite, fileRead } = createFileTools(api)
    await fileWrite.execute({ path: '/r.md', content: 'payload' }, ctx)
    const result = await fileRead.execute({ file: '/r.md' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(typeof result.data).toBe('object')
    const data = result.data as { file: { path: string }; content: string }
    expect(data.file.path).toBe('/r.md')
    expect(data.content).toBe('payload')
  })

  it('returns isError on not-found', async () => {
    const api = buildFakeApi()
    const { fileRead } = createFileTools(api)
    const result = await fileRead.execute({ file: '/missing.md' }, ctx)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('not found')
  })

  it('rejects when workspace is missing', async () => {
    const api = buildFakeApi()
    const { fileRead } = createFileTools(api)
    const result = await fileRead.execute({ file: UUID_REF }, ctxNoWorkspace)
    expect(result.isError).toBe(true)
  })
})

describe('[COMP:files/tools] fileAppend', () => {
  it('grows the file and emits an event', async () => {
    const api = buildFakeApi()
    const events: FileToolEvent[] = []
    const { fileWrite, fileAppend } = createFileTools(api, { onEvent: (e) => events.push(e) })
    await fileWrite.execute({ path: '/log.md', content: 'one\n' }, ctx)
    const result = await fileAppend.execute({ file: '/log.md', content: 'two\n' }, ctx)
    expect(result.isError).toBeFalsy()
    const stored = [...api.files.values()][0]
    expect(stored.sizeBytes).toBe(8)
    const appended = events.find((e) => e.type === 'file_appended')
    expect(appended).toBeTruthy()
  })

  it('returns isError on not-found', async () => {
    const api = buildFakeApi()
    const { fileAppend } = createFileTools(api)
    const result = await fileAppend.execute({ file: '/missing.md', content: 'x' }, ctx)
    expect(result.isError).toBe(true)
  })

  it('surfaces quota exceeded', async () => {
    const api = buildFakeApi()
    const { fileWrite, fileAppend } = createFileTools(api)
    await fileWrite.execute({ path: '/q.md', content: 'a' }, ctx)
    api.setQuotaLimit(1)
    const result = await fileAppend.execute({ file: '/q.md', content: 'b' }, ctx)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('quota')
  })
})

describe('[COMP:files/tools] fileSearch', () => {
  it('matches title / summary / name', async () => {
    const api = buildFakeApi()
    const { fileWrite, fileSearch } = createFileTools(api)
    await fileWrite.execute({ path: '/q1-recap.md', content: '...', title: 'Q1 recap', tags: ['finance'] }, ctx)
    await fileWrite.execute({ path: '/q2-plan.md', content: '...', title: 'Q2 plan', tags: ['plan'] }, ctx)

    const recap = await fileSearch.execute({ query: 'recap' }, ctx)
    expect(recap.isError).toBeFalsy()
    expect((recap.data as Array<{ path: string }>).map((r) => r.path)).toEqual(['/q1-recap.md'])

    const tagFilter = await fileSearch.execute({ tag: 'plan' }, ctx)
    expect((tagFilter.data as Array<{ path: string }>).map((r) => r.path)).toEqual(['/q2-plan.md'])
  })

  it('listing without query returns all files capped by limit', async () => {
    const api = buildFakeApi()
    const { fileWrite, fileSearch } = createFileTools(api)
    for (let i = 0; i < 5; i++) {
      await fileWrite.execute({ path: `/n${i}.md`, content: 'x' }, ctx)
    }
    const result = await fileSearch.execute({ limit: 3 }, ctx)
    expect(result.isError).toBeFalsy()
    expect((result.data as Array<unknown>)).toHaveLength(3)
  })
})

describe('[COMP:files/tools] fileSetMeta', () => {
  it('updates only the supplied fields', async () => {
    const api = buildFakeApi()
    const events: FileToolEvent[] = []
    const { fileWrite, fileSetMeta } = createFileTools(api, { onEvent: (e) => events.push(e) })
    await fileWrite.execute({ path: '/m.md', content: 'x', title: 'Old' }, ctx)
    const result = await fileSetMeta.execute(
      { file: '/m.md', title: 'New', tags: ['inbox'] },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    const stored = [...api.files.values()][0]
    expect(stored.title).toBe('New')
    expect(stored.tags).toEqual(['inbox'])
    expect(stored.summary).toBeNull()
    const meta = events.find((e) => e.type === 'file_meta_updated')
    expect(meta).toMatchObject({ fields: expect.arrayContaining(['title', 'tags']) })
  })

  it('rejects when no fields are provided', async () => {
    const api = buildFakeApi()
    const { fileWrite, fileSetMeta } = createFileTools(api)
    await fileWrite.execute({ path: '/m.md', content: 'x' }, ctx)
    const result = await fileSetMeta.execute({ file: '/m.md' }, ctx)
    expect(result.isError).toBe(true)
  })
})

describe('[COMP:files/tools] fileDelete', () => {
  it('removes the file and emits an event', async () => {
    const api = buildFakeApi()
    const events: FileToolEvent[] = []
    const { fileWrite, fileDelete } = createFileTools(api, { onEvent: (e) => events.push(e) })
    await fileWrite.execute({ path: '/d.md', content: 'x' }, ctx)
    const result = await fileDelete.execute({ file: '/d.md' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(api.files.size).toBe(0)
    expect(events.find((e) => e.type === 'file_deleted')).toBeTruthy()
  })

  it('returns isError on not-found', async () => {
    const api = buildFakeApi()
    const { fileDelete } = createFileTools(api)
    const result = await fileDelete.execute({ file: '/missing.md' }, ctx)
    expect(result.isError).toBe(true)
  })
})

describe('[COMP:files/tools] saveFileToBrain', () => {
  const CACHE_ID = '0c491d5a-1718-4680-855d-eb15752ca941'
  // A 1x1 PNG, base64 — stands in for the user's uploaded image.
  const PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

  function cacheReader(content: string, fileName = 'cert.png', mimeType = 'image/png') {
    return async (id: string) =>
      id === CACHE_ID
        ? { id, sessionId: 's_1', fileName, mimeType, content, summary: 'a cert', sizeBytes: 100 }
        : null
  }

  it('persists the ORIGINAL bytes (not a text summary) to the file primitive', async () => {
    const api = buildFakeApi()
    const events: FileToolEvent[] = []
    const { saveFileToBrain } = createFileTools(api, {
      onEvent: (e) => events.push(e),
      readCachedFile: cacheReader(`data:image/png;base64,${PNG_B64}`),
    })

    const result = await saveFileToBrain.execute({ fileId: CACHE_ID }, ctx)

    expect(result.isError).toBeFalsy()
    expect(api.files.size).toBe(1)
    const saved = [...api.files.values()][0]
    expect(saved.mime).toBe('image/png') // preserved binary mime, not text/plain
    expect(saved.path).toBe('/uploads/cert.png')
    // The stored bytes round-trip to the original PNG — proves it's the real
    // file, not a "Degree Certificate: …" summary string.
    expect(Buffer.from(saved.content, 'base64').toString('base64')).toBe(
      Buffer.from(PNG_B64, 'base64').toString('base64'),
    )
    expect(events.find((e) => e.type === 'file_created')).toBeTruthy()
  })

  it('honours an explicit path / title and decodes a plain-text cache entry', async () => {
    const api = buildFakeApi()
    const { saveFileToBrain } = createFileTools(api, {
      readCachedFile: cacheReader('hello notes', 'notes.txt', 'text/plain'),
    })
    const result = await saveFileToBrain.execute(
      { fileId: CACHE_ID, path: '/docs/notes.txt', title: 'My notes' },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    const saved = [...api.files.values()][0]
    expect(saved.path).toBe('/docs/notes.txt')
    expect(saved.title).toBe('My notes')
    expect(Buffer.from(saved.content, 'base64').toString('utf-8')).toBe('hello notes')
  })

  it('fails honestly (no memory substitute) when the upload has expired', async () => {
    const api = buildFakeApi()
    const { saveFileToBrain } = createFileTools(api, { readCachedFile: async () => null })
    const result = await saveFileToBrain.execute({ fileId: CACHE_ID }, ctx)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/expired|re-attach/i)
    expect(api.files.size).toBe(0)
  })

  it('reports it cannot save when the upload cache is not wired', async () => {
    const api = buildFakeApi()
    const { saveFileToBrain } = createFileTools(api) // no readCachedFile
    const result = await saveFileToBrain.execute({ fileId: CACHE_ID }, ctx)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/can'?t be saved|cannot save/i)
  })

  it('returns the workspace gate when the assistant has no workspace', async () => {
    const api = buildFakeApi()
    const { saveFileToBrain } = createFileTools(api, {
      readCachedFile: cacheReader(`data:image/png;base64,${PNG_B64}`),
    })
    const result = await saveFileToBrain.execute({ fileId: CACHE_ID }, ctxNoWorkspace)
    expect(result.isError).toBe(true)
    expect(api.files.size).toBe(0)
  })
})

describe('[COMP:files/tools] saveFileBytes', () => {
  // A 1x1 PNG, base64 — stands in for bytes the caller holds directly.
  const PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

  it('persists the ORIGINAL bytes from a bare base64 string, mime preserved', async () => {
    const api = buildFakeApi()
    const events: FileToolEvent[] = []
    const { saveFileBytes } = createFileTools(api, { onEvent: (e) => events.push(e) })

    const result = await saveFileBytes.execute(
      { path: '/uploads/pic.png', base64: PNG_B64, mime: 'image/png' },
      ctx,
    )

    expect(result.isError).toBeFalsy()
    expect(api.files.size).toBe(1)
    const saved = [...api.files.values()][0]
    expect(saved.mime).toBe('image/png')
    expect(saved.path).toBe('/uploads/pic.png')
    // Stored bytes round-trip to the original PNG — the real file, not text.
    expect(saved.content).toBe(Buffer.from(PNG_B64, 'base64').toString('base64'))
    expect(events.find((e) => e.type === 'file_created')).toBeTruthy()
  })

  it('strips a data: URL prefix before decoding', async () => {
    const api = buildFakeApi()
    const { saveFileBytes } = createFileTools(api)
    const result = await saveFileBytes.execute(
      { path: '/uploads/pic2.png', base64: `data:image/png;base64,${PNG_B64}`, mime: 'image/png' },
      ctx,
    )
    expect(result.isError).toBeFalsy()
    const saved = [...api.files.values()][0]
    expect(saved.content).toBe(Buffer.from(PNG_B64, 'base64').toString('base64'))
  })

  it('passes title / summary / tags through', async () => {
    const api = buildFakeApi()
    const { saveFileBytes } = createFileTools(api)
    await saveFileBytes.execute(
      {
        path: '/uploads/report.pdf',
        base64: PNG_B64,
        mime: 'application/pdf',
        title: 'Report',
        summary: 'Q1 numbers',
        tags: ['finance'],
      },
      ctx,
    )
    const saved = [...api.files.values()][0]
    expect(saved.title).toBe('Report')
    expect(saved.summary).toBe('Q1 numbers')
    expect(saved.tags).toEqual(['finance'])
  })

  it('rejects an oversize payload BEFORE decoding (the size cap)', async () => {
    const api = buildFakeApi()
    const { saveFileBytes } = createFileTools(api)
    // One char over the cap; content need not be valid base64 — the guard runs first.
    const tooBig = 'A'.repeat(14_000_001)
    const result = await saveFileBytes.execute(
      { path: '/uploads/huge.bin', base64: tooBig, mime: 'application/octet-stream' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/too large/i)
    expect(api.files.size).toBe(0)
  })

  it('rejects content that decodes to zero bytes', async () => {
    const api = buildFakeApi()
    const { saveFileBytes } = createFileTools(api)
    // Non-empty string (passes the schema) that base64-decodes to nothing.
    const result = await saveFileBytes.execute(
      { path: '/uploads/empty.bin', base64: '====', mime: 'application/octet-stream' },
      ctx,
    )
    expect(result.isError).toBe(true)
    expect(api.files.size).toBe(0)
  })

  it('returns the workspace gate when the assistant has no workspace', async () => {
    const api = buildFakeApi()
    const { saveFileBytes } = createFileTools(api)
    const result = await saveFileBytes.execute(
      { path: '/uploads/x.png', base64: PNG_B64, mime: 'image/png' },
      ctxNoWorkspace,
    )
    expect(result.isError).toBe(true)
    expect(api.files.size).toBe(0)
  })
})
