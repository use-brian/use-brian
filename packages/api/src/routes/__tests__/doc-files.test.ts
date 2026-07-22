import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'
import { docFilesRoutes, type DocFilesDeps } from '../doc-files.js'

/**
 * Durable doc-block media routes. The route writes straight to the
 * permanent `workspace_files` primitive under a reserved `/doc/` path and
 * serves reads via a signed-GCS redirect — or the signed URL as JSON under
 * `?redirect=0` for fetch()-based consumers (streaming the bytes only in
 * the local-disk dev fallback). Every endpoint is workspace-membership
 * gated.
 *
 * [COMP:api/doc-files]
 */

function makeDeps(over: Partial<DocFilesDeps> = {}): DocFilesDeps {
  return {
    filesApi: {
      writeBytes: vi.fn(),
    } as unknown as DocFilesDeps['filesApi'],
    store: {
      getById: vi.fn(),
    } as unknown as DocFilesDeps['store'],
    gcs: {
      signedReadUrl: vi.fn(),
      readBlob: vi.fn(),
    } as unknown as DocFilesDeps['gcs'],
    // Member by default (internal clearance); override per-test for the 403 path.
    membership: vi.fn().mockResolvedValue({ clearance: 'internal' }),
    ...over,
  }
}

describe('[COMP:api/doc-files] Doc-block media routes', () => {
  beforeEach(() => vi.clearAllMocks())

  // ── POST /:workspaceId/upload ───────────────────────────────────

  it('uploads an image into workspace_files under a /doc/ path and returns a durable ref', async () => {
    const deps = makeDeps()
    vi.mocked(deps.filesApi.writeBytes).mockResolvedValue({
      ok: true,
      value: { id: 'wf_1', mime: 'image/png', sizeBytes: 4 },
    } as never)

    const app = createTestApp('/api/doc-files', docFilesRoutes(deps), { userId: 'u_1' })
    const res = await request(app)
      .post('/api/doc-files/ws_1/upload')
      .attach('files', Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        filename: 'shot.png',
        contentType: 'image/png',
      })

    expect(res.status).toBe(200)
    expect(res.body.files).toHaveLength(1)
    expect(res.body.files[0]).toMatchObject({
      id: 'wf_1',
      bucket: 'workspace_files',
      path: 'wf_1', // path === id by contract
      mimeType: 'image/png',
      sizeBytes: 4,
      name: 'shot.png',
    })

    // Written to the reserved /doc/ prefix (the brain-exclusion key).
    const [ctx, params] = vi.mocked(deps.filesApi.writeBytes).mock.calls[0]
    expect(ctx).toMatchObject({ workspaceId: 'ws_1', userId: 'u_1', clearance: 'internal' })
    expect(params.path).toMatch(/^\/doc\/.*shot\.png$/)
    expect(params.mime).toBe('image/png')
  })

  it('rejects a non-member upload with 403 and never writes', async () => {
    const deps = makeDeps({ membership: vi.fn().mockResolvedValue(null) })
    const app = createTestApp('/api/doc-files', docFilesRoutes(deps), { userId: 'u_outsider' })

    const res = await request(app)
      .post('/api/doc-files/ws_1/upload')
      .attach('files', Buffer.from('x'), { filename: 'a.png', contentType: 'image/png' })

    expect(res.status).toBe(403)
    expect(deps.filesApi.writeBytes).not.toHaveBeenCalled()
  })

  it('returns a per-file error for a disallowed MIME type', async () => {
    const deps = makeDeps()
    const app = createTestApp('/api/doc-files', docFilesRoutes(deps), { userId: 'u_1' })

    const res = await request(app)
      .post('/api/doc-files/ws_1/upload')
      .attach('files', Buffer.from('MZ'), {
        filename: 'evil.exe',
        contentType: 'application/x-msdownload',
      })

    expect(res.status).toBe(200)
    expect(res.body.files[0].error).toMatch(/Unsupported file type/)
    expect(deps.filesApi.writeBytes).not.toHaveBeenCalled()
  })

  // ── GET /:workspaceId/:id ───────────────────────────────────────

  it('302-redirects a signed HTTPS read URL (cloud-storage path)', async () => {
    const deps = makeDeps()
    vi.mocked(deps.store.getById).mockResolvedValue({ id: 'wf_1', mime: 'image/png' } as never)
    vi.mocked(deps.gcs.signedReadUrl).mockResolvedValue('https://signed.example/ws_1/wf_1?sig=abc')

    const app = createTestApp('/api/doc-files', docFilesRoutes(deps), { userId: 'u_1' })
    const res = await request(app).get('/api/doc-files/ws_1/wf_1')

    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('https://signed.example/ws_1/wf_1?sig=abc')
    expect(deps.gcs.readBlob).not.toHaveBeenCalled()
  })

  it('returns the signed URL as JSON when ?redirect=0 (fetch-based consumers)', async () => {
    // A CORS fetch can't follow the cross-origin 302 (tainted origin →
    // `Origin: null` → bucket CORS mismatch); PageIcon + attachment
    // downloads mint the URL here and fetch storage directly.
    const deps = makeDeps()
    vi.mocked(deps.store.getById).mockResolvedValue({ id: 'wf_1', mime: 'image/png' } as never)
    vi.mocked(deps.gcs.signedReadUrl).mockResolvedValue('https://signed.example/ws_1/wf_1?sig=abc')

    const app = createTestApp('/api/doc-files', docFilesRoutes(deps), { userId: 'u_1' })
    const res = await request(app).get('/api/doc-files/ws_1/wf_1?redirect=0')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ url: 'https://signed.example/ws_1/wf_1?sig=abc' })
    expect(deps.gcs.readBlob).not.toHaveBeenCalled()
  })

  it('still streams local-disk bytes under ?redirect=0 (no file:// in a body)', async () => {
    const deps = makeDeps()
    vi.mocked(deps.store.getById).mockResolvedValue({ id: 'wf_1', mime: 'image/png' } as never)
    vi.mocked(deps.gcs.signedReadUrl).mockResolvedValue('file:///tmp/sidanclaw-files/ws_1/wf_1')
    vi.mocked(deps.gcs.readBlob).mockResolvedValue({
      bytes: Buffer.from([1, 2, 3]),
      mime: 'image/png',
      metadata: { workspaceId: 'ws_1' },
    } as never)

    const app = createTestApp('/api/doc-files', docFilesRoutes(deps), { userId: 'u_1' })
    const res = await request(app).get('/api/doc-files/ws_1/wf_1?redirect=0')

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(Buffer.from(res.body)).toEqual(Buffer.from([1, 2, 3]))
  })

  it('routes a signed read through the backend recorded in storageUri', async () => {
    const s3 = {
      signedReadUrl: vi.fn().mockResolvedValue('https://s3.example/ws_1/wf_1?sig=abc'),
      readBlob: vi.fn(),
    }
    const resolver = { forUri: vi.fn().mockResolvedValue(s3) }
    const deps = makeDeps({ resolver: resolver as never })
    vi.mocked(deps.store.getById).mockResolvedValue({
      id: 'wf_1',
      mime: 'image/png',
      storageUri: 's3://customer-bucket/ws_1/wf_1',
    } as never)

    const app = createTestApp('/api/doc-files', docFilesRoutes(deps), { userId: 'u_1' })
    const res = await request(app).get('/api/doc-files/ws_1/wf_1')

    expect(res.status).toBe(302)
    expect(res.headers.location).toBe('https://s3.example/ws_1/wf_1?sig=abc')
    expect(resolver.forUri).toHaveBeenCalledWith('ws_1', 's3://customer-bucket/ws_1/wf_1')
    expect(deps.gcs.signedReadUrl).not.toHaveBeenCalled()
  })

  it('streams the bytes when the signed URL is a local file:// (dev fallback)', async () => {
    const deps = makeDeps()
    vi.mocked(deps.store.getById).mockResolvedValue({ id: 'wf_1', mime: 'image/png' } as never)
    vi.mocked(deps.gcs.signedReadUrl).mockResolvedValue('file:///tmp/sidanclaw-files/ws_1/wf_1')
    vi.mocked(deps.gcs.readBlob).mockResolvedValue({
      bytes: Buffer.from([1, 2, 3]),
      mime: 'image/png',
      metadata: { workspaceId: 'ws_1' },
    } as never)

    const app = createTestApp('/api/doc-files', docFilesRoutes(deps), { userId: 'u_1' })
    const res = await request(app).get('/api/doc-files/ws_1/wf_1')

    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(Buffer.from(res.body)).toEqual(Buffer.from([1, 2, 3]))
  })

  it('404s when the row is not readable in this workspace', async () => {
    const deps = makeDeps()
    vi.mocked(deps.store.getById).mockResolvedValue(null as never)

    const app = createTestApp('/api/doc-files', docFilesRoutes(deps), { userId: 'u_1' })
    const res = await request(app).get('/api/doc-files/ws_1/missing')

    expect(res.status).toBe(404)
    expect(deps.gcs.signedReadUrl).not.toHaveBeenCalled()
  })

  it('rejects a non-member read with 403', async () => {
    const deps = makeDeps({ membership: vi.fn().mockResolvedValue(null) })
    const app = createTestApp('/api/doc-files', docFilesRoutes(deps), { userId: 'u_outsider' })

    const res = await request(app).get('/api/doc-files/ws_1/wf_1')

    expect(res.status).toBe(403)
    expect(deps.store.getById).not.toHaveBeenCalled()
  })
})
