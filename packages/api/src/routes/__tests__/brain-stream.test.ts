/**
 * Unit tests for the brain realtime SSE route.
 * Component tag: [COMP:api/brain-stream-sse].
 *
 * The route is mounted WITHOUT requireAuth (EventSource can't send
 * headers), so it does its own auth pass: `Authorization: Bearer <jwt>`
 * for curl/tests, `?access_token=<jwt>` for the browser. Workspace
 * membership is verified before the stream opens; a non-member gets the
 * same 404 the entity routes return (existence not probeable).
 *
 * The guard branches return JSON and are exercised with supertest. The
 * "stream opens" path holds the socket open, so it runs against a real
 * ephemeral `http` server and is torn down once the SSE headers arrive.
 * `verifyAccessToken` + `subscribeToBrainChanges` are module-mocked;
 * `workspaceStore` is injected.
 *
 * Spec: docs/architecture/platform/realtime-sync.md.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import http from 'node:http'

vi.mock('../../auth/jwt.js', () => ({ verifyAccessToken: vi.fn() }))
vi.mock('../../brain-stream/sse-fanout.js', () => ({ subscribeToBrainChanges: vi.fn(() => () => {}) }))

import { brainStreamRoutes } from '../brain-stream.js'
import { verifyAccessToken } from '../../auth/jwt.js'
import { subscribeToBrainChanges } from '../../brain-stream/sse-fanout.js'
import type { WorkspaceStore } from '../../db/workspace-store.js'

const mockVerify = vi.mocked(verifyAccessToken)
const mockSubscribe = vi.mocked(subscribeToBrainChanges)

const WID = '11111111-1111-1111-1111-111111111111'
const UID = '22222222-2222-2222-2222-222222222222'

function makeWorkspaceStore(role: 'owner' | 'admin' | 'member' | null = 'member'): WorkspaceStore {
  return { getRole: vi.fn().mockResolvedValue(role) } as unknown as WorkspaceStore
}

function makeApp(workspaceStore: WorkspaceStore) {
  const app = express()
  app.use(express.json())
  app.use('/api/brain/stream', brainStreamRoutes({ workspaceStore, jwtSecret: 'test-secret' }))
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSubscribe.mockReturnValue(() => {})
})

describe('[COMP:api/brain-stream-sse] auth + workspace guards', () => {
  it('401 with no token at all', async () => {
    mockVerify.mockReturnValue(null)
    const res = await request(makeApp(makeWorkspaceStore())).get(`/api/brain/stream?workspaceId=${WID}`)
    expect(res.status).toBe(401)
  })

  it('401 when the bearer token does not verify', async () => {
    mockVerify.mockReturnValue(null)
    const res = await request(makeApp(makeWorkspaceStore()))
      .get(`/api/brain/stream?workspaceId=${WID}`)
      .set('Authorization', 'Bearer bad.jwt')
    expect(res.status).toBe(401)
  })

  it('400 when workspaceId is missing', async () => {
    mockVerify.mockReturnValue(UID)
    const res = await request(makeApp(makeWorkspaceStore()))
      .get('/api/brain/stream')
      .set('Authorization', 'Bearer good.jwt')
    expect(res.status).toBe(400)
  })

  it('400 when workspaceId is not a uuid', async () => {
    mockVerify.mockReturnValue(UID)
    const res = await request(makeApp(makeWorkspaceStore()))
      .get('/api/brain/stream?workspaceId=not-a-uuid')
      .set('Authorization', 'Bearer good.jwt')
    expect(res.status).toBe(400)
  })

  it('404 for a non-member (existence not probeable)', async () => {
    mockVerify.mockReturnValue(UID)
    const store = makeWorkspaceStore(null)
    const res = await request(makeApp(store))
      .get(`/api/brain/stream?workspaceId=${WID}`)
      .set('Authorization', 'Bearer good.jwt')
    expect(res.status).toBe(404)
    expect(mockSubscribe).not.toHaveBeenCalled()
  })

  it('accepts the token via ?access_token= too (browser EventSource path)', async () => {
    // Missing workspaceId still 400s, but proves the query-token branch runs
    // (verify is consulted) without opening a stream.
    mockVerify.mockReturnValue(UID)
    const res = await request(makeApp(makeWorkspaceStore())).get('/api/brain/stream?access_token=good.jwt')
    expect(res.status).toBe(400)
    expect(mockVerify).toHaveBeenCalledWith('good.jwt', 'test-secret')
  })
})

describe('[COMP:api/brain-stream-sse] stream open (member)', () => {
  let server: http.Server
  let port: number

  beforeEach(async () => {
    mockVerify.mockReturnValue(UID)
    const app = makeApp(makeWorkspaceStore('member'))
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, resolve))
    port = (server.address() as { port: number }).port
  })

  afterEach(() => {
    server.close()
  })

  it('opens the SSE stream with event-stream headers + registers a subscriber', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        { port, path: `/api/brain/stream?workspaceId=${WID}`, headers: { Authorization: 'Bearer good.jwt' } },
        (res) => {
          try {
            expect(res.statusCode).toBe(200)
            expect(res.headers['content-type']).toContain('text/event-stream')
            expect(res.headers['cache-control']).toContain('no-cache')
            expect(mockSubscribe).toHaveBeenCalledWith(WID, expect.any(Function))
          } catch (err) {
            req.destroy()
            reject(err)
            return
          }
          // Tear the long-lived stream down so the test completes.
          req.destroy()
          resolve()
        },
      )
      req.on('error', () => {
        // `req.destroy()` above surfaces as an ECONNRESET on some Node
        // versions after we've already resolved — ignore.
      })
    })
  })
})
