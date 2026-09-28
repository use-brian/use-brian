import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'
import { docFilesRoutes, type DocFilesDeps } from '../doc-files.js'

/** Durable, authenticated doc media. [COMP:api/doc-files] */

function makeDeps(over: Partial<DocFilesDeps> = {}): DocFilesDeps {
  return {
    filesApi: {
      writeBytes: vi.fn(),
      readBytes: vi.fn(),
    } as unknown as DocFilesDeps['filesApi'],
    // Member by default (internal clearance); override per-test for the 403 path.
    membership: vi.fn().mockResolvedValue({ clearance: 'internal' }),
    readProjection: vi.fn().mockResolvedValue({file:{id:'wf_1',mime:'image/png'},validForMs:5000}),
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

  it.each(['', '?redirect=0'])('returns authenticated no-store bytes without a storage capability (%s)', async query => {
    const deps = makeDeps()
    vi.mocked(deps.filesApi.readBytes).mockResolvedValue({ok:true,value:{file:{id:'wf_1',mime:'image/png'},bytes:Buffer.from([1,2,3])}} as never)
    const app = createTestApp('/api/doc-files', docFilesRoutes(deps), {userId:'u_1'})
    const res = await request(app).get(`/api/doc-files/ws_1/wf_1${query}`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['cache-control']).toBe('private, no-store')
    expect(Number(res.headers['x-brian-media-valid-for-ms'])).toBeGreaterThan(0)
    expect(Number(res.headers['x-brian-media-valid-for-ms'])).toBeLessThanOrEqual(5000)
    expect(res.headers['access-control-expose-headers']).toContain('X-Brian-Media-Valid-For-Ms')
    expect(res.headers.location).toBeUndefined()
    expect(Buffer.from(res.body)).toEqual(Buffer.from([1,2,3]))
    expect(deps.filesApi.readBytes).toHaveBeenCalledWith({workspaceId:'ws_1',userId:'u_1',assistantId:null,clearance:'internal'},'wf_1')
  })

  it('returns JSON media as file content, not signed-read instructions', async () => {
    const deps=makeDeps()
    vi.mocked(deps.filesApi.readBytes).mockResolvedValue({ok:true,value:{file:{id:'wf_1',mime:'application/json'},bytes:Buffer.from('{"report":"fixture"}')}} as never)
    const res=await request(createTestApp('/api/doc-files',docFilesRoutes(deps),{userId:'u_1'})).get('/api/doc-files/ws_1/wf_1?redirect=0')
    expect(res.status).toBe(200);expect(res.body).toEqual({report:'fixture'});expect(res.headers.location).toBeUndefined()
  })

  it('404s when current authority or the source changed during byte resolution', async () => {
    const deps=makeDeps()
    vi.mocked(deps.filesApi.readBytes).mockResolvedValue({ok:false,error:{kind:'not_found',reference:'wf_1'}})
    const res=await request(createTestApp('/api/doc-files',docFilesRoutes(deps),{userId:'u_1'})).get('/api/doc-files/ws_1/wf_1')
    expect(res.status).toBe(404);expect(res.body).toEqual({error:'File not found'})
  })

  it('rejects non-member reads before fetching bytes', async () => {
    const deps=makeDeps({membership:vi.fn().mockResolvedValue(null)})
    const res=await request(createTestApp('/api/doc-files',docFilesRoutes(deps),{userId:'outsider'})).get('/api/doc-files/ws_1/wf_1')
    expect(res.status).toBe(403);expect(deps.filesApi.readBytes).not.toHaveBeenCalled()
  })
  it.each(['missing','expired','changed'] as const)('withholds bytes when final projection is %s',async reason=>{
    const deps=makeDeps()
    vi.mocked(deps.filesApi.readBytes).mockResolvedValue({ok:true,value:{file:{id:'wf_1'},bytes:Buffer.from('protected')}} as never)
    vi.mocked(deps.readProjection).mockResolvedValue(reason==='missing'?null:{file:{id:'wf_1',scopeVersion:reason==='changed'?'2':undefined},validForMs:reason==='expired'?0:5000} as never)
    const res=await request(createTestApp('/api/doc-files',docFilesRoutes(deps),{userId:'u_1'})).get('/api/doc-files/ws_1/wf_1')
    expect(res.status).toBe(404);expect(res.text).not.toContain('protected');expect(res.headers['x-brian-media-valid-for-ms']).toBeUndefined()
  })

})
