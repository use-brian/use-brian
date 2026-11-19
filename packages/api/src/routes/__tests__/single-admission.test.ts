/** [COMP:api/auth] One admission per request across fall-through `/api` routers.
 *
 * The open boot mounts many `app.use('/api', requireAuth(...), router)` guards
 * (and the hosted edition adds more from the same middleware); a request whose
 * handler sits in a later router used to validate its session once per guard it
 * crossed. One request now validates once. Each new request still validates, so
 * revocation is observed on the next request, and a request whose earlier guard
 * did not admit it is never treated as admitted.
 * Spec: docs/architecture/engine/turn-kernel.md "One admission per request". */
import express, { Router } from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { optionalAuth, requireAuth } from '../../auth/middleware.js'
import { createTokens } from '../../auth/jwt.js'

const SECRET = 'single-admission-fixture-secret'
const USER = '00000000-0000-4000-a000-0000000000aa'

/** Three fall-through routers in front of the matching handler, as in boot.ts. */
function app(sessions: { validateAccess: (claims: unknown) => Promise<boolean> }) {
  const server = express()
  server.use('/api/sessions', optionalAuth(SECRET, sessions), Router().get('/never', (_req, res) => { res.end() }))
  for (const name of ['first', 'second', 'third']) {
    server.use('/api', requireAuth(SECRET, sessions), Router().get(`/${name}`, (_req, res) => { res.json({ name }) }))
  }
  server.use('/api', requireAuth(SECRET, sessions), Router().get('/target', (req, res) => {
    res.json({ userId: req.userId, authVersion: req.authVersion })
  }))
  return server
}

describe('[COMP:api/auth] single admission per request', () => {
  it('validates the session once for one request through every fall-through guard', async () => {
    const validateAccess = vi.fn(async () => true)
    const { accessToken } = createTokens(USER, SECRET)
    const response = await request(app({ validateAccess })).get('/api/target').set('Authorization', `Bearer ${accessToken}`)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ userId: USER, authVersion: 0 })
    expect(validateAccess).toHaveBeenCalledTimes(1)
  })

  it('validates every new request afresh, so a revocation applies to the next request', async () => {
    let live = true
    const validateAccess = vi.fn(async () => live)
    const server = app({ validateAccess })
    const { accessToken } = createTokens(USER, SECRET)
    expect((await request(server).get('/api/target').set('Authorization', `Bearer ${accessToken}`)).status).toBe(200)
    live = false
    const revoked = await request(server).get('/api/target').set('Authorization', `Bearer ${accessToken}`)
    expect(revoked.status).toBe(401)
    expect(validateAccess).toHaveBeenCalledTimes(2)
  })

  it('does not reuse an admission from a different validator or header on the same request', async () => {
    const first = { validateAccess: vi.fn(async () => true) }, second = { validateAccess: vi.fn(async () => false) }
    const server = express()
    server.use('/api', requireAuth(SECRET, first), Router().get('/other', (_req, res) => { res.end() }))
    server.use('/api', requireAuth(SECRET, second), Router().get('/target', (_req, res) => { res.end() }))
    const { accessToken } = createTokens(USER, SECRET)
    expect((await request(server).get('/api/target').set('Authorization', `Bearer ${accessToken}`)).status).toBe(401)
    expect(first.validateAccess).toHaveBeenCalledTimes(1)
    expect(second.validateAccess).toHaveBeenCalledTimes(1)
  })
})
