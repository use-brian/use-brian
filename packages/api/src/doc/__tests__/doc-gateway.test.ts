import { describe, it, expect, vi } from 'vitest'
import { pageToYDoc, applyOpsToYDoc, yDocToSnapshot, type DocOp } from '@use-brian/doc-model'
import { defaultDrawingLibrary } from '@use-brian/shared/drawing'
import { createBriefSyncClient, createDocGateway } from '../doc-gateway.js'

const OPS = [{ op: 'setTitle' as const, title: 'Hi' }]

describe('[COMP:api/doc-model-gateway] DocGateway', () => {
  it('returns undefined when sync env is not configured (non-prod)', () => {
    expect(createDocGateway({ syncUrl: undefined, syncSecret: undefined })).toBeUndefined()
    expect(createDocGateway({ syncUrl: 'ws://x', syncSecret: undefined })).toBeUndefined()
    // url undefined + secret set → undefined OUTSIDE production (vitest runs as
    // NODE_ENV=test, so the prod host default below does not kick in).
    expect(createDocGateway({ syncUrl: undefined, syncSecret: 's' })).toBeUndefined()
  })

  it('in production, defaults the url to the convention host so only the secret is required', async () => {
    // No explicit url opt and no DOC_SYNC_URL env: the prod default applies.
    const prevUrl = process.env.DOC_SYNC_URL
    delete process.env.DOC_SYNC_URL
    vi.stubEnv('NODE_ENV', 'production')
    try {
      const fetchImpl = vi.fn(async () =>
        new Response(JSON.stringify({ idMap: {}, skipped: [], seq: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      const gw = createDocGateway({
        syncSecret: 'secret',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
      expect(gw).toBeDefined()
      await gw!.applyOps({ userId: 'u1', pageId: 'p1', ops: OPS })
      const [url] = fetchImpl.mock.calls[0] as unknown as [string]
      // REBRAND-CUTOVER: flips to doc-sync.usebrian.ai with the doc-gateway default
      expect(url).toBe('https://doc-sync.sidan.ai/internal/apply')
    } finally {
      vi.unstubAllEnvs()
      if (prevUrl !== undefined) process.env.DOC_SYNC_URL = prevUrl
    }
  })

  it('POSTs ops to the http twin of the ws url with the secret header', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ idMap: { 'tmp-1': 'real-1' }, skipped: [], seq: 7 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const gw = createDocGateway({
      syncUrl: 'wss://doc-sync.example/',
      syncSecret: 'secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })!
    const out = await gw.applyOps({ userId: 'u1', pageId: 'p1', ops: OPS })

    expect(fetchImpl).toHaveBeenCalledOnce()
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://doc-sync.example/internal/apply')
    expect((init.headers as Record<string, string>)['x-doc-sync-secret']).toBe('secret')
    expect(JSON.parse(init.body as string)).toEqual({ pageId: 'p1', ops: OPS, userId: 'u1' })
    expect(out).toEqual({ idMap: { 'tmp-1': 'real-1' }, skipped: [], version: 7 })
  })

  it('surfaces a non-2xx response as a structured error (no throw)', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }))
    const gw = createDocGateway({
      syncUrl: 'ws://localhost:8080',
      syncSecret: 's',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })!
    expect(await gw.applyOps({ userId: 'u', pageId: 'p', ops: OPS })).toEqual({
      error: 'sync apply HTTP 503',
    })
  })

  it('surfaces a network failure as a structured error', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const gw = createDocGateway({
      syncUrl: 'ws://localhost:8080',
      syncSecret: 's',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })!
    const out = await gw.applyOps({ userId: 'u', pageId: 'p', ops: OPS })
    expect('error' in out && out.error).toContain('sync unreachable')
  })

  it('names a Brief Direction refusal instead of a bare status, so Brian proposes instead', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'brief_direction_protected' }), { status: 409 }))
    const gw = createDocGateway({ syncUrl: 'ws://sync', syncSecret: 's', fetchImpl: fetchImpl as unknown as typeof fetch })!
    const out = await gw.applyOps({ userId: 'u', pageId: 'p', ops: OPS })
    expect('error' in out && out.error).toMatch(/^brief_direction_protected: .*manageBrief/)
  })

  it('round-trips live shape reads and all four actions through the sync wire protocol', async () => {
    const scene = { version: 1 as const, elements: ['a', 'b'].map((id, i) => ({ id, type: 'rectangle' as const, x: i * 300, y: 0, width: 100, height: 80 })), files: {}, appState: { viewBackgroundColor: '#fff' } }
    const doc = pageToYDoc({ blocks: [{ id: 'diagram', kind: 'drawing', scene }] }, 'Test')
    const fetchImpl = vi.fn(async (_url: unknown, init: RequestInit) => {
      const payload = JSON.parse(String(init.body)) as { userId: string; pageId: string; ops: DocOp[] }
      expect(payload.userId).toBe('user'); expect(payload.pageId).toBe('page')
      return Response.json({ ...applyOpsToYDoc(doc, payload.ops), page: yDocToSnapshot(doc).page })
    })
    const gateway = createDocGateway({ syncUrl: 'ws://sync.example', syncSecret: 'test-secret', fetchImpl: fetchImpl as typeof fetch })!
    const read = await gateway.drawing!({ userId: 'user', pageId: 'page', blockId: 'diagram', actions: [] })
    if ('error' in read) throw new Error(read.error)
    const item = defaultDrawingLibrary()[0]
    const result = await gateway.drawing!({ userId: 'user', pageId: 'page', blockId: 'diagram', namespace: read.namespace, actions: [
      { type: 'move', elementIds: ['a'], dx: 50, dy: 30 },
      { type: 'resize', elementId: 'a', width: 180, height: 100 },
      { type: 'connect', fromId: 'a', toId: 'b' },
      { type: 'insertLibraryItem', item, x: 600, y: 100 },
    ] })
    expect(result).toMatchObject({ namespace: read.namespace, changedElementIds: expect.arrayContaining(['a', 'b']) })
    if ('error' in result) throw new Error(result.error)
    expect(result.scene.elements[0]).toMatchObject({ x: 50, y: 30, width: 180, height: 100 })
    expect(result.scene.elements).toHaveLength(3 + item.elements.length)
    expect(result.scene.elements.some(e => e.type === 'arrow')).toBe(true)
    doc.destroy()
  })

  it('does not report a successful edit for an old sync service or a rejected drawing op', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ idMap: {}, skipped: [] }))
    const gateway = createDocGateway({ syncUrl: 'ws://sync.example', syncSecret: 's', fetchImpl: fetchImpl as typeof fetch })!
    expect(await gateway.drawing!({ userId: 'u', pageId: 'p', blockId: 'd', actions: [] })).toMatchObject({ error: expect.stringContaining('updated doc-sync') })
    fetchImpl.mockResolvedValue(Response.json({ skipped: [{ opIndex: 0, reason: 'Drawing was replaced' }] }))
    expect(await gateway.drawing!({ userId: 'u', pageId: 'p', blockId: 'd', actions: [] })).toEqual({ error: 'Drawing was replaced' })
  })

  it('posts the post-commit Brief merge notice to the live holder and reports delivery', async () => {
    expect(createBriefSyncClient({ syncUrl: undefined, syncSecret: undefined })).toBeUndefined()
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ merged: true }), { status: 200 }))
    const client = createBriefSyncClient({ syncUrl: 'wss://sync.example', syncSecret: 's', fetchImpl: fetchImpl as unknown as typeof fetch })!
    expect(await client.syncBrief('page-1')).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://sync.example/internal/brief-sync')
    expect(JSON.parse(String(init.body))).toEqual({ pageId: 'page-1' })
    const failing = createBriefSyncClient({ syncUrl: 'ws://sync', syncSecret: 's', fetchImpl: (async () => { throw new Error('down') }) as unknown as typeof fetch })!
    expect(await failing.syncBrief('page-1')).toBe(false)
  })
})
