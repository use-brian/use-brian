import express from 'express'
import request from 'supertest'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
vi.mock('../../recordings/watch-store.js', async original => ({
  ...await original<typeof import('../../recordings/watch-store.js')>(),
  withCaptureLock: async (_id: string, work: (db: unknown) => unknown) => work({}),
}))
import { watchRecordingRoutes } from '../watch-recording.js'
import { sha256, WatchError, type watchStore, type Grant, type Capture } from '../../recordings/watch-store.js'
import { verifyWatchUpload, signWatchUpload } from '../../recordings/watch-upload.js'
const key = 'test-server-signing-secret', audio = Buffer.from('full M4A fixture')
function harness() {
  const g = { id: randomUUID(), owner_id: randomUUID(), workspace_id: randomUUID(), assistant_id: randomUUID() }
  const c = { id: randomUUID(), client_id: randomUUID(), state: 'open' }
  let descriptor: { capture_id: string; checksum: string; bytes: number; duration_ms: number; received: boolean } | null = null
  const store = {
    authenticate: vi.fn(async () => g),
    relay: vi.fn(async (owner: string, grantId: string) => { if (owner !== g.owner_id || grantId !== g.id) throw new WatchError(404, 'relay_grant_not_found'); return { ...g, authMode: 'relay' } }),
    get: vi.fn(async (grant: Grant, clientId: string) => { if (grant.id !== g.id || clientId !== c.client_id) throw new WatchError(404, 'capture_not_found'); return c }),
    initializeUpload: vi.fn(async (_grant: Grant, _capture: Capture, input: { sha256: string; bytes: number; durationMs: number }) => {
      if (descriptor && (descriptor.checksum !== input.sha256 || descriptor.bytes !== input.bytes)) throw new WatchError(409, 'full_upload_conflict')
      descriptor ??= { capture_id: c.id, checksum: input.sha256, bytes: input.bytes, duration_ms: input.durationMs, received: false }
      return descriptor
    }),
    upload: vi.fn(async () => descriptor),
    receiveFull: vi.fn(async () => { descriptor!.received = true }),
  }
  const validateAudio = vi.fn(async () => {}), authorize = vi.fn(async () => {})
  const app = express(); app.use(express.json())
  app.use('/api/watch/v1', watchRecordingRoutes({ provisioningKey: key, authorize,
    humanAuth: (req, res, next) => { if (req.headers.authorization !== 'Bearer human') return void res.sendStatus(401); req.userId = g.owner_id; next() },
    service: {} as never, store: store as unknown as typeof watchStore, validateAudio,
  }))
  const input = { sha256: sha256(audio), bytes: audio.length, durationMs: 1000 }
  const initialize = (relay = false) => request(app).post(`/api/watch/v1/${relay ? `relay/${g.id}/` : ''}sessions/${c.client_id}/full-upload`).set('Authorization', relay ? 'Bearer human' : 'Bearer device').send(input)
  return { app, g, c, store, authorize, validateAudio, initialize, input }
}
describe('API-owned signed full-file staging', () => {
  it('initializes/renews one descriptor and receives an immutable checksum-bound body without a user token', async () => {
    const h = harness()
    const first = (await h.initialize().expect(200)).body
    const second = (await h.initialize().expect(200)).body
    expect(first.sessionId).toBe(second.sessionId)
    expect(first.uploadHeaders).toEqual({ 'Content-Type': 'audio/mp4', 'Content-Length': String(audio.length) })
    expect(verifyWatchUpload(new URL(first.uploadUrl, 'https://api.test').searchParams.get('token'), key, h.c.id)).toMatchObject({ sha256: sha256(audio), bytes: audio.length, mode: 'device' })
    await request(h.app).put(first.uploadUrl).set('Content-Type', 'audio/mp4').send(audio).expect(200)
    expect(h.store.receiveFull).toHaveBeenCalledTimes(1)
    await request(h.app).put(second.uploadUrl).set('Content-Type', 'audio/mp4').send(audio).expect(200)
    expect(h.validateAudio).toHaveBeenCalledTimes(1)
    expect((await h.initialize()).body.received).toBe(true)
  })
  it('rejects tampering, expiry, path/key substitution and altered descriptors', async () => {
    const h = harness(), response = await h.initialize()
    const url = new URL(response.body.uploadUrl, 'https://api.test'), token = url.searchParams.get('token')!
    const claims = verifyWatchUpload(token, key, h.c.id)
    const expired = signWatchUpload({ ...claims, expires: Date.now() - 1 }, key)
    await request(h.app).put(`${url.pathname}?token=${expired}`).set('Content-Type', 'audio/mp4').send(audio).expect(401)
    await request(h.app).put(`${url.pathname}?token=${token}x`).set('Content-Type', 'audio/mp4').send(audio).expect(401)
    await request(h.app).put(`/api/watch/v1/uploads/${randomUUID()}?token=${token}`).set('Content-Type', 'audio/mp4').send(audio).expect(401)
    expect(() => verifyWatchUpload(token, 'different-signing-key', h.c.id)).toThrow('invalid_upload_token')
    await request(h.app).post(`/api/watch/v1/sessions/${h.c.client_id}/full-upload`).set('Authorization', 'Bearer device').send({ ...h.input, sha256: sha256('different') }).expect(409)
    expect(h.store.receiveFull).not.toHaveBeenCalled()
  })
  it('checks exact length/checksum before durable receipt and rechecks authority at receipt', async () => {
    const h = harness(), url = (await h.initialize()).body.uploadUrl
    await request(h.app).put(url).set('Content-Type', 'audio/mp4').send(Buffer.alloc(audio.length + 1)).expect(411)
    await request(h.app).put(url).set('Content-Type', 'audio/mp4').send(Buffer.alloc(audio.length)).expect(422)
    expect(h.store.receiveFull).not.toHaveBeenCalled()
    h.validateAudio.mockImplementationOnce(async () => { h.authorize.mockRejectedValue(new WatchError(403, 'destination_unavailable')) })
    await request(h.app).put(url).set('Content-Type', 'audio/mp4').send(audio).expect(403)
    expect(h.store.receiveFull).not.toHaveBeenCalled()
  })
  it('does not acknowledge bytes when the signed token expires during validation', async () => {
    const h = harness(), url = (await h.initialize()).body.uploadUrl
    const now = vi.spyOn(Date, 'now')
    try {
      h.validateAudio.mockImplementationOnce(async () => { now.mockReturnValue(Date.now() + 300001) })
      await request(h.app).put(url).set('Content-Type', 'audio/mp4').send(audio).expect(401)
      expect(h.store.receiveFull).not.toHaveBeenCalled()
    } finally { now.mockRestore() }
  })
  it('relay mints a capability for the SAME grant without sharing renewal tokens', async () => {
    const h = harness(), response = await h.initialize(true).expect(200)
    const token = new URL(response.body.uploadUrl, 'https://api.test').searchParams.get('token')!
    expect(verifyWatchUpload(token, key, h.c.id)).toMatchObject({ mode: 'relay', grantId: h.g.id })
    await request(h.app).put(response.body.uploadUrl).set('Content-Type', 'audio/mp4').send(audio).expect(200)
    expect(h.authorize).toHaveBeenLastCalledWith(expect.objectContaining({ id: h.g.id, authMode: 'relay' }))
    h.store.relay.mockRejectedValue(new WatchError(404, 'relay_grant_not_found'))
    await request(h.app).put(response.body.uploadUrl).set('Content-Type', 'audio/mp4').send(audio).expect(404)
  })
})
