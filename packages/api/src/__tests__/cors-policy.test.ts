import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'

import { createApiCorsMiddleware, isOpaqueDesktopBearerRequest } from '../cors-policy.js'
import { requireAuth } from '../auth/middleware.js'

describe('[COMP:api/cors-policy] bundled desktop opaque-origin admission', () => {
  it('admits actual bearer requests from the file renderer', () => {
    expect(isOpaqueDesktopBearerRequest({
      path: '/api/assistants',
      authorization: 'Bearer desktop-token',
    })).toBe(true)
  })

  it('admits bearer preflights case-insensitively', () => {
    expect(isOpaqueDesktopBearerRequest({
      path: '/api/chat',
      requestedHeaders: 'content-type, Authorization, x-client-timezone',
    })).toBe(true)
  })

  it('admits refresh while rejecting cookie-only opaque requests', () => {
    expect(isOpaqueDesktopBearerRequest({ path: '/auth/refresh' })).toBe(true)
    expect(isOpaqueDesktopBearerRequest({ path: '/api/assistants' })).toBe(false)
    expect(isOpaqueDesktopBearerRequest({
      path: '/api/assistants',
      authorization: 'Bearer ',
    })).toBe(false)
  })
})

describe('[COMP:api/cors-policy] shared browser preflight policy', () => {
  function app() {
    const server = express()
    server.use(createApiCorsMiddleware(['https://app.example']))
    server.get('/protected', requireAuth('fictional-test-secret'), (_req, res) => res.json({ ok: true }))
    server.use((_req, res) => res.sendStatus(200))
    return server
  }

  it('caches the configured origin method/header policy for ten minutes', async () => {
    const response = await request(app()).options('/protected')
      .set('Origin', 'https://app.example')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'Authorization')
    expect(response.status).toBe(204)
    expect(response.headers).toMatchObject({
      'access-control-allow-origin': 'https://app.example',
      'access-control-allow-credentials': 'true',
      'access-control-max-age': '600',
      vary: 'Origin',
    })
    expect(response.headers['access-control-allow-headers']).toContain('Authorization')
    expect(response.headers['access-control-allow-methods']).toContain('PUT')
  })

  it('still rejects an actual protected request without a bearer after an admitted preflight', async () => {
    const server = app()
    await request(server).options('/protected').set('Origin', 'https://app.example').expect(204)
    const response = await request(server).get('/protected').set('Origin', 'https://app.example')
    expect(response.status).toBe(401)
    expect(response.headers['access-control-max-age']).toBeUndefined()
    expect(response.body.ok).toBeUndefined()
  })

  it.each(['https://untrusted.example', undefined])('does not admit or cache another origin (%s)', async (origin) => {
    const probe = request(app()).options('/protected')
    if (origin) probe.set('Origin', origin)
    const response = await probe
    expect(response.status).toBe(204)
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    expect(response.headers['access-control-allow-credentials']).toBeUndefined()
    expect(response.headers['access-control-max-age']).toBeUndefined()
  })

  it.each(['/api/brain/mcp', '/api/home-apps/widget/state', '/auth/refresh', '/protected'])('preserves opaque bearer/bridge admission without credentials or policy caching (%s)', async (path) => {
    const response = await request(app()).options(path).set('Origin', 'null')
      .set('Access-Control-Request-Headers', 'Authorization')
    expect(response.status).toBe(204)
    expect(response.headers['access-control-allow-origin']).toBe('null')
    expect(response.headers['access-control-allow-credentials']).toBeUndefined()
    expect(response.headers['access-control-max-age']).toBeUndefined()
  })

  it('does not admit an opaque cookie-only request', async () => {
    const response = await request(app()).options('/protected').set('Origin', 'null')
      .set('Access-Control-Request-Headers', 'Content-Type')
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    expect(response.headers['access-control-max-age']).toBeUndefined()
  })

  it.each(['/api/brain/mcp', '/api/home-apps/widget/state', '/auth/refresh'])('retains the opaque bridge/refresh exception without an Authorization preflight (%s)', async (path) => {
    const response = await request(app()).options(path).set('Origin', 'null')
      .set('Access-Control-Request-Headers', 'Content-Type')
    expect(response.status).toBe(204)
    expect(response.headers['access-control-allow-origin']).toBe('null')
    expect(response.headers['access-control-allow-credentials']).toBeUndefined()
    expect(response.headers['access-control-max-age']).toBeUndefined()
  })

  it.each(['resolve', 'complete', 'recover'])('leaves browser-fill %s CORS to its route', async (action) => {
    const response = await request(app()).options(`/api/protected-browser-fill/${action}`)
      .set('Origin', 'https://app.example')
      .set('Access-Control-Request-Headers', 'Authorization')
    expect(response.status).toBe(200)
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
    expect(response.headers['access-control-max-age']).toBeUndefined()
  })
})
