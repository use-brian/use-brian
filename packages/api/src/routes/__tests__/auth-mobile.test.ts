import { beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createHash } from 'node:crypto'
import { authRoutes } from '../auth.js'
import { createTokens } from '../../auth/jwt.js'
import type { AuthSessionStore } from '../../db/auth-session-store.js'
import { MOBILE_REDIRECT_URI, type MobileAuthStore } from '../../db/mobile-auth-store.js'

const USER = '00000000-0000-4000-a000-000000000001'
const SID = '00000000-0000-4000-a000-000000000003'
const SECRET = 'mobile-test-secret'
vi.mock('../../db/users.js', () => ({ findUserById: vi.fn(async () => ({ id: '00000000-0000-4000-a000-000000000001', email: 'user@example.com', name: 'User', avatarUrl: null })) }))
const sessions = {
  validateAccess: vi.fn(async () => true), create: vi.fn(async () => ({ id: SID, authVersion: 0 })),
} as unknown as AuthSessionStore
const store: MobileAuthStore = {
  create: vi.fn(async () => ({ code: 'a'.repeat(43), expiresAt: new Date(Date.now() + 120_000) })),
  consume: vi.fn(async () => ({ userId: USER })),
}
const app = express().use(express.json()).use('/auth', authRoutes(SECRET, undefined, undefined, undefined, undefined, undefined, undefined, sessions, store))
const access = createTokens(USER, SECRET).accessToken
const binding = { clientId: 'brian-ios', redirectUri: MOBILE_REDIRECT_URI }
const verifier = 'v'.repeat(64)
const challenge = createHash('sha256').update(verifier).digest('base64url')
beforeEach(() => { vi.clearAllMocks() })

describe('[COMP:api/auth] mobile PKCE endpoints', () => {
  it('requires human bearer auth, not ambient cookies, for account and mint', async () => {
    await request(app).post('/auth/mobile/code').set('Cookie', `access_token=${access}`).send({ ...binding, challenge }).expect(401)
    await request(app).get('/auth/mobile/account').expect(401)
    expect(store.create).not.toHaveBeenCalled()
  })
  it('shows authenticated account and binds mint to its user', async () => {
    const account = await request(app).get('/auth/mobile/account').auth(access, { type: 'bearer' }).expect(200)
    expect(account.body.user.id).toBe(USER)
    const result = await request(app).post('/auth/mobile/code').auth(access, { type: 'bearer' }).send({ ...binding, challenge, userId: 'attacker' }).expect(200)
    expect(store.create).toHaveBeenCalledWith({ ...binding, challenge, userId: USER })
    expect(result.headers['cache-control']).toBe('no-store')
  })
  it.each([{ challenge: 'plain-verifier' }, { challenge: 'x'.repeat(43) }, { clientId: 'unknown' }, { redirectUri: MOBILE_REDIRECT_URI + '/evil' }])('rejects invalid mint binding %j', async change => {
    await request(app).post('/auth/mobile/code').auth(access, { type: 'bearer' }).send({ ...binding, challenge, ...change }).expect(400)
    expect(store.create).not.toHaveBeenCalled()
  })
  it('exchanges without browser credentials and creates a normal human session', async () => {
    const result = await request(app).post('/auth/mobile/exchange').send({ ...binding, verifier, code: 'a'.repeat(43) }).expect(200)
    expect(store.consume).toHaveBeenCalledWith({ ...binding, verifier, code: 'a'.repeat(43) })
    expect(sessions.create).toHaveBeenCalledWith(USER, expect.any(Object))
    expect(result.body.accessToken).toBeTruthy()
    expect(result.body.refreshToken).toBeTruthy()
  })
  it('never creates a session when atomic validation fails', async () => {
    vi.mocked(store.consume).mockResolvedValueOnce(null)
    await request(app).post('/auth/mobile/exchange').send({ ...binding, verifier, code: 'a'.repeat(43) }).expect(400)
    expect(sessions.create).not.toHaveBeenCalled()
  })
  it.each([{ verifier: 'short' }, { verifier: ' '.repeat(43) }, { clientId: 'desktop' }, { redirectUri: 'https://evil.example' }, { code: {} }])('rejects malformed exchange %j', async change => {
    await request(app).post('/auth/mobile/exchange').send({ ...binding, verifier, code: 'a'.repeat(43), ...change }).expect(400)
    expect(store.consume).not.toHaveBeenCalled()
  })
})
