import { describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { recordingRecoveryRoutes } from '../recovery-routes.js'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const recordingId = '22222222-2222-4222-8222-222222222222'
function app(recover: Parameters<typeof recordingRecoveryRoutes>[0], userId?: string) {
  const app = express(); app.use(express.json())
  app.use((req, _res, next) => { Object.assign(req, { userId }); next() })
  app.use(recordingRecoveryRoutes(recover)); return app
}
describe('[COMP:recordings/recovery] authenticated shared routes', () => {
  it('reads without preparing, and prepares only on explicit POST using the authenticated actor', async () => {
    const recover = vi.fn().mockResolvedValue({ recordingId, replacementId: null, title: 'Memo', mime: 'audio/webm' })
    const api = app(recover, 'actor')
    const read = await request(api).get(`/${recordingId}/recovery`).query({ workspaceId })
    expect(read.status).toBe(200); expect(read.headers['cache-control']).toBe('no-store')
    expect(recover).toHaveBeenLastCalledWith({ actorUserId: 'actor' }, workspaceId, recordingId, false)
    const write = await request(api).post(`/${recordingId}/recover`).send({ workspaceId, actorUserId: 'forged' })
    expect(write.status).toBe(200)
    expect(recover).toHaveBeenLastCalledWith({ actorUserId: 'actor' }, workspaceId, recordingId, true)
  })
  it('denies anonymous and malformed calls before reaching recovery', async () => {
    const recover = vi.fn()
    expect((await request(app(recover)).post(`/${recordingId}/recover`).send({ workspaceId })).status).toBe(401)
    expect((await request(app(recover, 'actor')).post('/invalid/recover').send({ workspaceId })).status).toBe(400)
    expect(recover).not.toHaveBeenCalled()
  })
  it('does not label a database outage as a missing recording', async () => {
    const result = await request(app(vi.fn().mockRejectedValue(new Error('database offline')), 'actor')).get(`/${recordingId}/recovery`).query({ workspaceId })
    expect(result.status).toBe(503)
  })
  it('does not disclose why a source is unavailable', async () => {
    const recover = vi.fn().mockRejectedValue(new Error('recording_recovery_unavailable'))
    const result = await request(app(recover, 'actor')).get(`/${recordingId}/recovery`).query({ workspaceId })
    expect(result.status).toBe(404)
    expect(result.body).toEqual({ error: 'recording_recovery_unavailable' })
  })
})
