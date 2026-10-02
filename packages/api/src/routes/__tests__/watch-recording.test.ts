import express from 'express'
import request from 'supertest'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { watchRecordingRoutes } from '../watch-recording.js'
import { WatchError, sha256, type watchStore } from '../../recordings/watch-store.js'
import type { WatchService } from '../../recordings/watch-service.js'
import { requireAuth } from '../../auth/middleware.js'

const clientId = randomUUID(), owner = randomUUID(), grantId = randomUUID()
function harness() {
  const grant = { id: grantId, owner_id: owner, workspace_id: randomUUID(), assistant_id: randomUUID() }
  const capture = { client_id: clientId, id: randomUUID() }
  const store = {
    provision: vi.fn(async () => ({ grantId })), list: vi.fn(async () => []), revoke: vi.fn(async () => {}),
    renew: vi.fn(async () => ({})),
    relay: vi.fn(async (ownerId: string, id: string) => { if (ownerId !== owner || id !== grantId) throw new WatchError(404, 'relay_grant_not_found'); return { ...grant, authMode: 'relay' } }),
    authenticate: vi.fn(async (token: string) => { if (token !== 'device') throw new WatchError(401, 'invalid_device_access'); return grant }),
    hasWindow: vi.fn(async () => false),
    create: vi.fn(async () => capture), get: vi.fn(async () => capture), receive: vi.fn(async () => {}),
  }
  const service = { prepare: vi.fn(async () => {}), status: vi.fn(async () => ({ clientId, state: 'open' })), retry: vi.fn(async () => ({ clientId })), finalize: vi.fn(async () => ({ state: 'finalized' })) }
  const authorize = vi.fn(async () => {}), validateAudio = vi.fn(async () => {})
  const app = express(); app.use(express.json())
  app.use('/api/watch/v1', watchRecordingRoutes({ deployment: 'test', provisioningKey: 'server-secret', authorize, service: service as unknown as WatchService, store: store as unknown as typeof watchStore, validateAudio,
    humanAuth: (req, res, next) => { if (req.headers.authorization !== 'Bearer human') return void res.status(401).json({ error: 'human_required' }); req.userId = owner; next() } }))
  app.get('/api/general', requireAuth('test'), (_req, res) => { res.json({ secret: true }) })
  return { app, store, service, authorize, validateAudio }
}
const base = `/api/watch/v1/sessions/${clientId}`
describe('watch v1 Express boundaries', () => {
  it('requires human approval for grants and does not let opaque device tokens access ordinary JWT routes', async () => {
    const h = harness()
    await request(h.app).post('/api/watch/v1/grants').set('Authorization', 'Bearer device').send({}).expect(401)
    await request(h.app).get('/api/general').set('Authorization', 'Bearer device').expect(401)
    const input = { workspaceId: randomUUID(), assistantId: randomUUID(), deviceId: randomUUID(), label: 'Watch' }
    await request(h.app).post('/api/watch/v1/grants').set('Authorization', 'Bearer human').send(input).expect(201)
    expect(h.store.provision).toHaveBeenCalledWith({ ...input, ownerId: owner, deployment: 'test', provisioningKey: 'server-secret' })
    await request(h.app).get(base).set('Authorization', 'Bearer human').expect(401)
  })
  it('uses identical session handlers for owner relay without any watch token, and blocks grant substitution', async () => {
    const h = harness(), relay = `/api/watch/v1/relay/${grantId}/sessions/${clientId}`
    await request(h.app).get(relay).set('Authorization', 'Bearer human').expect(200)
    expect(h.store.relay).toHaveBeenCalledWith(owner, grantId, 'test')
    expect(h.service.status).toHaveBeenCalledWith(expect.objectContaining({ id: grantId, authMode: 'relay' }), clientId)
    await request(h.app).get(relay).set('Authorization', 'Bearer device').expect(401)
    await request(h.app).get(`/api/watch/v1/relay/${randomUUID()}/sessions/${clientId}`).set('Authorization', 'Bearer human').expect(404)
    await request(h.app).put(relay).set('Authorization', 'Bearer human').send({ capturedAt: '2026-01-01T00:00:00Z', title: 'Meeting', source: 'apple-watch', workspaceId: randomUUID() }).expect(400)
    const bytes = Buffer.from('m4a')
    await request(h.app).put(`${relay}/windows`).query({ sequence: 0, offsetMs: 0, durationMs: 1000, sha256: sha256(bytes) })
      .set('Authorization', 'Bearer human').set('Content-Type', 'audio/mp4').send(bytes).expect(200)
    expect(h.store.receive).toHaveBeenCalledWith(expect.objectContaining({ id: grantId, authMode: 'relay' }), expect.anything(), expect.anything())
    await request(h.app).post(`${relay}/retry`).set('Authorization', 'Bearer human').expect(200)
    await request(h.app).post(`${relay}/finalize`).set('Authorization', 'Bearer human').send({ expectedWindows: 1 }).expect(200)
    expect(h.store.authenticate).not.toHaveBeenCalled()
    h.authorize.mockRejectedValue(new WatchError(403, 'destination_unavailable'))
    await request(h.app).get(relay).set('Authorization', 'Bearer human').expect(403)
  })
  it('checks membership on each device request and handles rejected async handlers safely', async () => {
    const h = harness()
    h.authorize.mockRejectedValue(new WatchError(403, 'destination_unavailable'))
    const result = await request(h.app).get(base).set('Authorization', 'Bearer device').expect(403)
    expect(result.body.error).toBe('destination_unavailable')
    expect(h.service.status).not.toHaveBeenCalled()
  })
  it('persists raw audio receipt, keeps model work separate, and exposes explicit retry', async () => {
    const h = harness(), bytes = Buffer.from('m4a')
    await request(h.app).put(`${base}/windows`).query({ sequence: 0, offsetMs: 0, durationMs: 1000, sha256: sha256(bytes) })
      .set('Authorization', 'Bearer device').set('Content-Type', 'audio/mp4').send(bytes).expect(200)
    expect(h.store.receive).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ audio: bytes, sequence: 0 }))
    expect(h.service.retry).not.toHaveBeenCalled()
    h.store.hasWindow.mockResolvedValue(true)
    await request(h.app).put(`${base}/windows`).query({ sequence: 0, offsetMs: 0, durationMs: 1000, sha256: sha256(bytes) })
      .set('Authorization', 'Bearer device').set('Content-Type', 'audio/mp4').send(bytes).expect(200)
    expect(h.validateAudio).toHaveBeenCalledTimes(1) // durable replays don't depend on ffprobe availability
    await request(h.app).post(`${base}/retry`).set('Authorization', 'Bearer device').expect(200)
    expect(h.service.retry).toHaveBeenCalledWith(expect.objectContaining({ id: grantId }), clientId)
  })
  it('rejects checksum mismatch, extra destination fields and invalid timing before receipt', async () => {
    const h = harness(), bytes = Buffer.from('m4a')
    const valid = { sequence: 0, offsetMs: 0, durationMs: 1000, sha256: sha256(bytes) }
    for (const [patch, code] of [[{ sha256: sha256('wrong') }, 422], [{ sequence: -1 }, 400], [{ workspaceId: randomUUID() }, 400], [{ offsetMs: 10800000 }, 400]] as const) {
      await request(h.app).put(`${base}/windows`).query({ ...valid, ...patch }).set('Authorization', 'Bearer device').set('Content-Type', 'audio/mp4').send(bytes).expect(code)
    }
    expect(h.store.receive).not.toHaveBeenCalled()
    await request(h.app).put(base).set('Authorization', 'Bearer device').send({ capturedAt: '2026-01-01T00:00:00Z', title: 'Meeting', source: 'apple-watch', pageId: randomUUID() }).expect(400)
  })
  it('enforces the body limit and hides provider errors from responses', async () => {
    const h = harness(), bytes = Buffer.alloc(2 * 1024 * 1024 + 1)
    await request(h.app).put(`${base}/windows`).query({ sequence: 0, offsetMs: 0, durationMs: 1000, sha256: sha256(bytes) }).set('Authorization', 'Bearer device').set('Content-Type', 'audio/mp4').send(bytes).expect(413)
    h.service.retry.mockRejectedValue(new Error('secret provider diagnostics'))
    const res = await request(h.app).post(`${base}/retry`).set('Authorization', 'Bearer device').expect(503)
    expect(res.body).toEqual({ error: 'watch_temporarily_unavailable' })
    expect(res.headers['cache-control']).toBe('no-store')
  })
  it('finalize missing ranges reach clients and arbitrary destinations are rejected', async () => {
    const h = harness()
    h.service.finalize.mockRejectedValue(new WatchError(409, 'missing_windows', { missingSequences: [1] }))
    const r = await request(h.app).post(`${base}/finalize`).set('Authorization', 'Bearer device').send({ expectedWindows: 3 }).expect(409)
    expect(r.body.detail.missingSequences).toEqual([1])
    expect(h.service.finalize).toHaveBeenCalledWith(expect.anything(), clientId, { expectedWindows: 3, allowIncomplete: false, source: 'windows' })
    await request(h.app).post(`${base}/finalize`).set('Authorization', 'Bearer device').send({ expectedWindows: 3, pageId: randomUUID() }).expect(400)
  })
})
