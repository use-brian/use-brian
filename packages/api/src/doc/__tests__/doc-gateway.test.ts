import { describe, it, expect, vi } from 'vitest'
import { createDocGateway } from '../doc-gateway.js'

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
})
