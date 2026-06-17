/**
 * Unit tests for the shadow-claim consent-token mint route.
 * Component tag: [COMP:auth/shadow-claim-route].
 *
 * Covers POST /auth/claim/issue-token in auth.ts (the token-mint half
 * of shadow-claim; the partner-side exchange POST /claim-shadow lives
 * in public-api.ts). Mocks `query`; verifies the requireAuth gate, the
 * 503 when the feature is unwired, input validation, the partner-key
 * not-found / revoked checks, shadow_not_found, the cannot_merge_self
 * guard, and a successful mint returning { claimToken, expiresAt }.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'

const queryMock = vi.fn()
vi.mock('../../db/client.js', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}))

import { authRoutes } from '../auth.js'
import { createTokens } from '../../auth/jwt.js'

const JWT_SECRET = 'test-jwt-secret'
const REAL_USER = '11111111-1111-1111-1111-111111111111'
const SHADOW_USER = '22222222-2222-2222-2222-222222222222'

const shadowClaimStore = { create: vi.fn(), consume: vi.fn() }
const apiKeyStore = { getByIdSystem: vi.fn() }

function makeApp(opts: { wired?: boolean } = {}) {
  const wired = opts.wired ?? true
  const app = express()
  app.use(express.json())
  app.use(
    '/auth',
    authRoutes(
      JWT_SECRET,
      undefined,
      undefined,
      undefined,
      wired ? (shadowClaimStore as never) : undefined,
      wired ? (apiKeyStore as never) : undefined,
    ),
  )
  return app
}

function auth(userId: string): Record<string, string> {
  return { Authorization: `Bearer ${createTokens(userId, JWT_SECRET).accessToken}` }
}

function issue(app: express.Express, body: Record<string, unknown>, userId = REAL_USER) {
  return request(app).post('/auth/claim/issue-token').set(auth(userId)).send(body)
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('[COMP:auth/shadow-claim-route] POST /auth/claim/issue-token', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await request(makeApp()).post('/auth/claim/issue-token').send({})
    expect(res.status).toBe(401)
  })

  it('returns 503 when the shadow-claim stores are not wired', async () => {
    const res = await issue(makeApp({ wired: false }), { partnerKeyId: 'k', externalUserId: 'x' })
    expect(res.status).toBe(503)
  })

  it('rejects a body missing partnerKeyId or externalUserId with 400', async () => {
    expect((await issue(makeApp(), { externalUserId: 'x' })).status).toBe(400)
    expect((await issue(makeApp(), { partnerKeyId: 'k' })).status).toBe(400)
  })

  it('returns 404 when the partner key does not exist', async () => {
    apiKeyStore.getByIdSystem.mockResolvedValueOnce(null)
    const res = await issue(makeApp(), { partnerKeyId: 'k-x', externalUserId: 'ext-1' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('partner_key_not_found')
  })

  it('returns 403 when the partner key is revoked', async () => {
    apiKeyStore.getByIdSystem.mockResolvedValueOnce({ id: 'k-1', status: 'revoked' })
    const res = await issue(makeApp(), { partnerKeyId: 'k-1', externalUserId: 'ext-1' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('partner_key_revoked')
  })

  it('returns 404 when no shadow user matches the api:<keyId>:<externalUserId> identity', async () => {
    apiKeyStore.getByIdSystem.mockResolvedValueOnce({ id: 'k-1', status: 'active' })
    queryMock.mockResolvedValueOnce({ rows: [] })
    const res = await issue(makeApp(), { partnerKeyId: 'k-1', externalUserId: 'ext-1' })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('shadow_not_found')
  })

  it('refuses to merge the caller into their own account', async () => {
    apiKeyStore.getByIdSystem.mockResolvedValueOnce({ id: 'k-1', status: 'active' })
    queryMock.mockResolvedValueOnce({ rows: [{ id: REAL_USER, auth_provider: 'channel' }] })
    const res = await issue(makeApp(), { partnerKeyId: 'k-1', externalUserId: 'ext-1' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('cannot_merge_self')
  })

  it('mints a single-use claim token on success', async () => {
    apiKeyStore.getByIdSystem.mockResolvedValueOnce({ id: 'k-1', status: 'active' })
    queryMock.mockResolvedValueOnce({ rows: [{ id: SHADOW_USER, auth_provider: 'channel' }] })
    shadowClaimStore.create.mockResolvedValueOnce({
      token: 'claim-tok-abc',
      expiresAt: new Date('2026-05-16T12:05:00Z'),
    })
    const res = await issue(makeApp(), {
      partnerKeyId: 'k-1',
      externalUserId: 'ext-1',
      displayLabel: 'Acme partner',
    })
    expect(res.status).toBe(200)
    expect(res.body.claimToken).toBe('claim-tok-abc')
    expect(res.body.expiresAt).toBe('2026-05-16T12:05:00.000Z')
    expect(shadowClaimStore.create).toHaveBeenCalledWith(
      expect.objectContaining({ realUserId: REAL_USER, shadowUserId: SHADOW_USER, partnerKeyId: 'k-1' }),
    )
  })
})
