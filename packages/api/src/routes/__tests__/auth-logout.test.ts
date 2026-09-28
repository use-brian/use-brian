import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createHmac } from 'node:crypto'
import { authRoutes } from '../auth.js'
import { createTokens } from '../../auth/jwt.js'
import { requireAuth } from '../../auth/middleware.js'
import { findUserById } from '../../db/users.js'
import type { AuthSessionStore, AuthTokenClaims } from '../../db/auth-session-store.js'

vi.mock('../../db/users.js', () => ({ findUserById: vi.fn().mockResolvedValue(null) }))

const SECRET = 'logout-test-secret'
const USER = '00000000-0000-4000-a000-000000000001'
const OTHER_USER = '00000000-0000-4000-a000-000000000002'
const SID = '00000000-0000-4000-a000-000000000003'
const OTHER_SID = '00000000-0000-4000-a000-000000000004'

function setup() {
  let version = 0
  const rows = new Map<string, { userId: string; authVersion: number; revoked: boolean }>()
  const issue = (id: string, userId = USER) => {
    rows.set(id, { userId, authVersion: version, revoked: false })
    return createTokens(userId, SECRET, { id, authVersion: version })
  }
  const admitted = (claims: AuthTokenClaims) => {
    if ((claims.authVersion ?? 0) !== version) return false
    if (!claims.sessionId) return true
    const row = rows.get(claims.sessionId)
    return !!row && row.userId === claims.userId && !row.revoked && row.authVersion === version
  }
  const sessions = {
    create: vi.fn(),
    validateAccess: vi.fn(async (claims: AuthTokenClaims) => admitted(claims)),
    validateRefresh: vi.fn(async (claims: AuthTokenClaims) => admitted(claims)
      ? { id: claims.sessionId ?? SID, authVersion: version } : null),
    listForUser: vi.fn(async () => []),
    revokeForUser: vi.fn(async (userId: string, id: string) => {
      const row = rows.get(id)
      if (!row || row.userId !== userId || row.revoked) return false
      row.revoked = true
      return true
    }),
    revokeAllForUser: vi.fn(async (userId: string, expectedVersion?: number) => {
      if (expectedVersion !== undefined && expectedVersion !== version) return false
      version++
      for (const row of rows.values()) if (row.userId === userId) row.revoked = true
      return true
    }),
  } satisfies AuthSessionStore
  const app = express()
  app.use(express.json())
  app.use('/auth', authRoutes(SECRET, undefined, undefined, undefined, undefined, undefined, undefined, sessions))
  app.get('/protected', requireAuth(SECRET, sessions), (_req, res) => res.json({ ok: true }))
  return { app, sessions, issue }
}

function signedPayload(payload: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', SECRET).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${signature}`
}

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

describe('[COMP:api/auth] POST /auth/logout', () => {
  it('revokes refresh and access while leaving another session usable', async () => {
    const { app, issue, sessions } = setup()
    const first = issue(SID)
    const other = issue(OTHER_SID)
    await request(app).get('/protected').auth(first.accessToken, { type: 'bearer' }).expect(200)
    await request(app).post('/auth/logout').send({ refreshToken: first.refreshToken }).expect(200, { ok: true })
    expect(sessions.revokeForUser).toHaveBeenCalledWith(USER, SID)
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled()
    await request(app).post('/auth/refresh').send({ refreshToken: first.refreshToken }).expect(401)
    await request(app).get('/protected').auth(first.accessToken, { type: 'bearer' }).expect(401)
    await request(app).post('/auth/refresh').send({ refreshToken: other.refreshToken }).expect(200)
    await request(app).get('/protected').auth(other.accessToken, { type: 'bearer' }).expect(200)
  })

  it('makes credentials from a refresh already in flight unusable after logout', async () => {
    const { app, issue } = setup()
    const tokens = issue(SID)
    let release!: () => void
    const held = new Promise<null>(resolve => { release = () => resolve(null) })
    vi.mocked(findUserById).mockReturnValueOnce(held)
    const refreshing = request(app).post('/auth/refresh').send({ refreshToken: tokens.refreshToken }).then(response => response)
    await vi.waitFor(() => expect(findUserById).toHaveBeenCalled())
    await request(app).post('/auth/logout').send({ refreshToken: tokens.refreshToken }).expect(200)
    release()
    const late = await refreshing
    expect(late.status).toBe(200)
    await request(app).post('/auth/refresh').send({ refreshToken: late.body.refreshToken }).expect(401)
    await request(app).get('/protected').auth(late.body.accessToken, { type: 'bearer' }).expect(401)
  })

  it('is idempotent without live-session admission, including previously revoked sessions', async () => {
    const { app, issue, sessions } = setup()
    const tokens = issue(SID)
    await sessions.revokeForUser(USER, SID)
    for (let i = 0; i < 2; i++) {
      await request(app).post('/auth/logout').send({ refreshToken: tokens.refreshToken }).expect(200, { ok: true })
    }
    expect(sessions.validateAccess).not.toHaveBeenCalled()
    expect(sessions.validateRefresh).not.toHaveBeenCalled()
  })

  it('ignores expired access tokens in Authorization', async () => {
    const { app, issue } = setup()
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now - 2 * 60 * 60 * 1000)
    const tokens = issue(SID)
    vi.mocked(Date.now).mockReturnValue(now)
    await request(app).get('/protected').auth(tokens.accessToken, { type: 'bearer' }).expect(401)
    await request(app).post('/auth/logout').auth(tokens.accessToken, { type: 'bearer' })
      .send({ refreshToken: tokens.refreshToken }).expect(200)
    await request(app).post('/auth/refresh').send({ refreshToken: tokens.refreshToken }).expect(401)
  })

  it('does not revoke a session owned by someone other than the signed user', async () => {
    const { app, issue, sessions } = setup()
    const other = issue(SID, OTHER_USER)
    const mismatched = createTokens(USER, SECRET, { id: SID, authVersion: 0 })
    await request(app).post('/auth/logout').send({ refreshToken: mismatched.refreshToken }).expect(200)
    expect(sessions.revokeForUser).toHaveBeenCalledWith(USER, SID)
    await request(app).get('/protected').auth(other.accessToken, { type: 'bearer' }).expect(200)
  })

  it('invalidates legacy tokens account-wide once; replay cannot revoke a fresh login', async () => {
    const { app, issue, sessions } = setup()
    const legacy = createTokens(USER, SECRET)
    const existing = issue(SID)
    await request(app).post('/auth/logout').send({ refreshToken: legacy.refreshToken }).expect(200)
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(USER, 0)
    await request(app).post('/auth/refresh').send({ refreshToken: legacy.refreshToken }).expect(401)
    await request(app).get('/protected').auth(legacy.accessToken, { type: 'bearer' }).expect(401)
    await request(app).get('/protected').auth(existing.accessToken, { type: 'bearer' }).expect(401)
    const fresh = issue(OTHER_SID)
    await request(app).post('/auth/logout').send({ refreshToken: legacy.refreshToken }).expect(200)
    expect(sessions.revokeAllForUser).toHaveBeenCalledTimes(1)
    await request(app).post('/auth/refresh').send({ refreshToken: fresh.refreshToken }).expect(200)
    await request(app).get('/protected').auth(fresh.accessToken, { type: 'bearer' }).expect(200)
  })

  it.each([undefined, {}, { refreshToken: null }, { refreshToken: 123 }, { refreshToken: [] },
    { refreshToken: {} }, { refreshToken: '' }, { refreshToken: '  ' }])('rejects malformed body %j', async (body) => {
    const { app, sessions } = setup()
    const req = request(app).post('/auth/logout')
    await (body === undefined ? req : req.send(body)).expect(400)
    expect(sessions.revokeForUser).not.toHaveBeenCalled()
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled()
  })

  it('rejects invalid, expired, malformed-claim and wrong-type JWTs without revocation', async () => {
    const { app, issue, sessions } = setup()
    const tokens = issue(SID)
    const payload = { sub: USER, sid: SID, ver: 0, exp: Math.floor(Date.now() / 1000) + 60, type: 'refresh' }
    for (const refreshToken of [
      'not.a.jwt', tokens.accessToken, tokens.refreshToken + 'tampered',
      createTokens(USER, 'wrong-secret').refreshToken,
      signedPayload({ ...payload, exp: 1 }), signedPayload({ ...payload, exp: undefined }),
      signedPayload({ ...payload, sid: '' }), signedPayload({ ...payload, sid: 123 }),
      signedPayload({ ...payload, sub: '' }), signedPayload({ ...payload, type: 'other' }),
    ]) {
      await request(app).post('/auth/logout').send({ refreshToken }).expect(401)
    }
    expect(sessions.validateAccess).not.toHaveBeenCalled()
    expect(sessions.revokeForUser).not.toHaveBeenCalled()
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled()
  })

  it('does not acknowledge success if persistence fails', async () => {
    const { app, issue, sessions } = setup()
    const tokens = issue(SID)
    sessions.revokeForUser.mockRejectedValueOnce(new Error('database unavailable'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await request(app).post('/auth/logout').send({ refreshToken: tokens.refreshToken }).expect(503)
  })
})
