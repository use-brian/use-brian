import express from 'express'
import request from 'supertest'
import { describe, it, expect, vi } from 'vitest'
import { protectedBrowserFillRoutes } from '../protected-browser-fill.js'
import { createProtectedFillService } from '../../../../core/src/sandbox/protected-fill.js'
import { signBrowserExtPairToken, signBrowserExtSessionToken } from '../../auth/browser-ext-pair-token.js'
const origin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const scope = { userId: 'user', workspaceId: 'workspace', browserProfileId: 'profile', sessionId: 'session', taskId: 'task', destinationOrigin: 'https://example.com' }
const { userId: _, ...binding } = scope
const source = { kind: 'crm', entityId: '00000000-0000-4000-8000-000000000001', field: 'email' }
function setup() {
  const read = vi.fn(async () => 'SECRET_SENTINEL')
  const service = createProtectedFillService({ authorize: async () => true, authorizeRecovery: async identity => identity.userId === scope.userId && identity.workspaceId === scope.workspaceId && identity.browserProfileId === scope.browserProfileId, validateSource: async () => true, readSource: read })
  const complete = vi.fn(async () => {})
  const app = express().use(express.json()).use('/api/protected-browser-fill', protectedBrowserFillRoutes({ service, jwtSecret: 'secret', extensionOrigins: new Set([origin]), onComplete: complete,
    userAuth: (req, res, next) => { if (req.headers.authorization !== 'Bearer access') { res.sendStatus(401); return }; req.userId = 'user'; next() },
  }))
  const token = signBrowserExtSessionToken(scope, 'secret')
  const post = (path: string, body: object, auth = token, from = origin) => request(app).post(`/api/protected-browser-fill/${path}`).set('Origin', from).set('Authorization', `Bearer ${auth}`).send(body)
  const issue = () => post('references', { ...binding, sources: [source] }, 'access')
  return { app, service, read, complete, post, issue }
}
describe('protected fill direct extension API', () => {
  it('creates metadata, discloses only to session-kind token, and completes cleanup', async () => {
    const { post, issue, complete } = setup()
    const created = await issue()
    expect(created.status).toBe(201)
    expect(JSON.stringify(created.body)).not.toContain('SECRET_SENTINEL')
    const body = { ...binding, items: [{ referenceId: created.body.references[0].referenceId, ref: '@e1' }] }
    const resolved = await post('resolve', body)
    expect(resolved.status).toBe(200)
    expect(resolved.headers['cache-control']).toBe('no-store')
    expect(resolved.body.items).toEqual([{ ref: '@e1', value: 'SECRET_SENTINEL' }])
    expect((await post('resolve', body)).status).toBe(403)
    const { destinationOrigin: _, ...identity } = binding
    expect((await post('complete', identity)).status).toBe(200)
    expect(complete).toHaveBeenCalledWith('session')
  })
  it('rejects access/pair tokens, bad origins, mismatched scope and extra inputs without leaking', async () => {
    const { post, issue, read } = setup()
    const created = await issue()
    const body = { ...binding, items: [{ referenceId: created.body.references[0].referenceId, ref: '@e1' }] }
    for (const token of ['access', signBrowserExtPairToken(scope, 'secret'), signBrowserExtSessionToken({ ...scope, userId: 'other' }, 'secret')]) {
      const denied = await post('resolve', body, token)
      expect(denied.status).toBeGreaterThanOrEqual(400)
      expect(JSON.stringify(denied.body)).not.toContain('SECRET_SENTINEL')
    }
    expect((await post('resolve', body, undefined, 'https://evil.example')).status).toBe(403)
    expect((await post('resolve', { ...body, browserProfileId: 'other' })).status).toBe(403)
    expect((await post('resolve', { ...body, raw: 'SECRET_SENTINEL' })).status).toBe(403)
    expect(read).not.toHaveBeenCalled()
  })
  it('allows only configured extension preflights', async () => {
    const { app } = setup()
    const recoveryPreflight = await request(app).options('/api/protected-browser-fill/recover').set('Origin', origin)
    expect(recoveryPreflight.status).toBe(204)
    expect(recoveryPreflight.headers['access-control-allow-origin']).toBe(origin)
    const preflight = await request(app).options('/api/protected-browser-fill/resolve').set('Origin', origin)
    expect(preflight.status).toBe(204)
    expect(preflight.headers['access-control-allow-origin']).toBe(origin)
    expect((await request(app).options('/api/protected-browser-fill/resolve').set('Origin', 'null')).status).toBe(403)
  })
})


describe('extension-only server reservation recovery route', () => {
  it('cancels pre-resolve reservation and refuses ordinary access/pair tokens and mismatched JWT scope', async () => {
    const { post, issue, service, read } = setup()
    const created = await issue()
    const items = [{ referenceId: created.body.references[0].referenceId, ref: '@e1' }]
    await service.reserve(scope, items)
    const body = { workspaceId: scope.workspaceId, browserProfileId: scope.browserProfileId }
    expect((await post('recover', body, 'access')).status).toBe(401)
    expect((await post('recover', body, signBrowserExtPairToken(scope, 'secret'))).status).toBe(401)
    expect((await post('recover', body, signBrowserExtSessionToken({ ...scope, userId: 'other' }, 'secret'))).status).toBe(403)
    expect((await post('recover', { ...body, browserProfileId: 'other' })).status).toBe(403)
    expect((await post('recover', { ...body, workspaceId: 'other' })).status).toBe(403)
    expect((await post('recover', body, undefined, 'https://evil.example')).status).toBe(403)
    expect(service.isLocked(scope)).toBe(true)
    const cancelled = await post('recover', body)
    expect(cancelled.status).toBe(200)
    expect(cancelled.headers['cache-control']).toBe('no-store')
    expect(cancelled.body).toEqual({ status: 'cancelled' })
    expect((await post('resolve', { ...binding, items })).status).toBe(403)
    expect(read).not.toHaveBeenCalled()
  })
  it('returns only cleanup metadata for uncertain disclosure, retaining the lock', async () => {
    const { post, issue, service } = setup()
    const created = await issue()
    const items = [{ referenceId: created.body.references[0].referenceId, ref: '@e1' }]
    await post('resolve', { ...binding, items })
    const recovered = await post('recover', { workspaceId: scope.workspaceId, browserProfileId: scope.browserProfileId })
    expect(recovered.status).toBe(200)
    expect(recovered.body).toEqual({ status: 'cleanup_required', request: { ...binding, items } })
    expect(JSON.stringify(recovered.body)).not.toContain('SECRET_SENTINEL')
    expect(service.isLocked(scope)).toBe(true)
  })
})
