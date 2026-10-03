import { describe, it, expect, vi } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { requireAuth, requireAuthWithoutTouch, optionalAuth } from '../middleware.js'
import { createTokens } from '../jwt.js'

const SECRET = 'middleware-test-secret'
const TEST_USER_A = '00000000-0000-4000-a000-000000000001'
const TEST_USER_B = '00000000-0000-4000-a000-000000000002'
const allowSessions = { validateAccess: vi.fn().mockResolvedValue(true) }

function makeReq(headers: Record<string, string | undefined> = {}): Request {
  return { headers } as unknown as Request
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: null as unknown,
    status(code: number) { this.statusCode = code; return this },
    json(b: unknown) { this.body = b; return this },
  }
  return res as unknown as Response & { statusCode: number; body: unknown }
}

describe('[COMP:api/auth] requireAuth middleware', () => {
  it('returns 401 when no Authorization header is set', async () => {
    const req = makeReq()
    const res = makeRes() as unknown as Response & { statusCode: number; body: unknown }
    const next = vi.fn() as unknown as NextFunction
    await requireAuth(SECRET, allowSessions)(req, res, next)
    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 401 when header is not Bearer format', async () => {
    const req = makeReq({ authorization: 'Basic abc' })
    const res = makeRes() as unknown as Response & { statusCode: number; body: unknown }
    const next = vi.fn() as unknown as NextFunction
    await requireAuth(SECRET, allowSessions)(req, res, next)
    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 401 for an invalid token', async () => {
    const req = makeReq({ authorization: 'Bearer not.a.valid.token' })
    const res = makeRes() as unknown as Response & { statusCode: number; body: unknown }
    const next = vi.fn() as unknown as NextFunction
    await requireAuth(SECRET, allowSessions)(req, res, next)
    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('calls next() and sets req.userId on a valid token', async () => {
    const { accessToken } = createTokens(TEST_USER_A, SECRET)
    const req = makeReq({ authorization: `Bearer ${accessToken}` })
    const res = makeRes() as unknown as Response & { statusCode: number; body: unknown }
    const next = vi.fn() as unknown as NextFunction
    await requireAuth(SECRET, allowSessions)(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(req.userId).toBe(TEST_USER_A)
    expect(res.statusCode).toBe(0)
  })

  it('returns 401 when the signed session has been revoked', async () => {
    const deniedSessions = { validateAccess: vi.fn().mockResolvedValue(false) }
    const { accessToken } = createTokens(TEST_USER_A, SECRET, {
      id: '00000000-0000-4000-a000-000000000099',
      authVersion: 2,
    })
    const req = makeReq({ authorization: `Bearer ${accessToken}` })
    const res = makeRes() as unknown as Response & { statusCode: number; body: unknown }
    const next = vi.fn() as unknown as NextFunction
    await requireAuth(SECRET, deniedSessions)(req, res, next)
    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 401 when token sub is not a valid UUID', async () => {
    const { accessToken } = createTokens('not-a-uuid', SECRET)
    const req = makeReq({ authorization: `Bearer ${accessToken}` })
    const res = makeRes() as unknown as Response & { statusCode: number; body: unknown }
    const next = vi.fn() as unknown as NextFunction
    await requireAuth(SECRET, allowSessions)(req, res, next)
    expect(res.statusCode).toBe(401)
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 401 for a refresh token passed as access token', async () => {
    const { refreshToken } = createTokens(TEST_USER_A, SECRET)
    const req = makeReq({ authorization: `Bearer ${refreshToken}` })
    const res = makeRes() as unknown as Response & { statusCode: number; body: unknown }
    const next = vi.fn() as unknown as NextFunction
    await requireAuth(SECRET, allowSessions)(req, res, next)
    expect(res.statusCode).toBe(401)
  })
})

describe('[COMP:api/auth] optionalAuth middleware', () => {
  it('calls next() without userId when no Authorization header', async () => {
    const req = makeReq()
    const res = makeRes() as unknown as Response & { statusCode: number; body: unknown }
    const next = vi.fn() as unknown as NextFunction
    await optionalAuth(SECRET, allowSessions)(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(req.userId).toBeUndefined()
  })

  it('calls next() with userId when a valid token is present', async () => {
    const { accessToken } = createTokens(TEST_USER_B, SECRET)
    const req = makeReq({ authorization: `Bearer ${accessToken}` })
    const res = makeRes() as unknown as Response & { statusCode: number; body: unknown }
    const next = vi.fn() as unknown as NextFunction
    await optionalAuth(SECRET, allowSessions)(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(req.userId).toBe(TEST_USER_B)
  })

  it('ignores token with non-UUID sub', async () => {
    const { accessToken } = createTokens('not-a-uuid', SECRET)
    const req = makeReq({ authorization: `Bearer ${accessToken}` })
    const res = makeRes() as unknown as Response & { statusCode: number; body: unknown }
    const next = vi.fn() as unknown as NextFunction
    await optionalAuth(SECRET, allowSessions)(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(req.userId).toBeUndefined()
  })

  it('calls next() without userId when token is invalid (does not reject)', async () => {
    const req = makeReq({ authorization: 'Bearer garbage' })
    const res = makeRes() as unknown as Response & { statusCode: number; body: unknown }
    const next = vi.fn() as unknown as NextFunction
    await optionalAuth(SECRET, allowSessions)(req, res, next)
    expect(next).toHaveBeenCalledOnce()
    expect(req.userId).toBeUndefined()
  })
})


describe('explicit no-touch authentication', () => {
  it('passes no-touch only after all normal JWT checks and binds the same identity', async () => {
    const sessions = { validateAccess: vi.fn().mockResolvedValue(true) }
    const session = { id: '00000000-0000-4000-a000-000000000099', authVersion: 2 }
    const { accessToken } = createTokens(TEST_USER_A, SECRET, session)
    const req = makeReq({ authorization: `Bearer ${accessToken}` }), next = vi.fn()
    await requireAuthWithoutTouch(SECRET, sessions)(req, makeRes(), next)
    expect(sessions.validateAccess).toHaveBeenCalledWith(expect.objectContaining({ userId: TEST_USER_A, sessionId: session.id, authVersion: 2 }), { touchLastSeen: false })
    expect(next).toHaveBeenCalledOnce()
    expect(req.authSessionId).toBe(session.id)
    expect(req.authVersion).toBe(2)
  })
  it('does not waive signature, access-token kind, UUID, or revocation checks', async () => {
    const sessions = { validateAccess: vi.fn().mockResolvedValue(false) }
    const tokens = [createTokens(TEST_USER_A, 'wrong-secret').accessToken,
      createTokens(TEST_USER_A, SECRET).refreshToken, createTokens('not-uuid', SECRET).accessToken]
    for (const token of tokens) {
      const next = vi.fn(), res = makeRes()
      await requireAuthWithoutTouch(SECRET, sessions)(makeReq({ authorization: `Bearer ${token}` }), res, next)
      expect(res.statusCode).toBe(401); expect(next).not.toHaveBeenCalled()
    }
    expect(sessions.validateAccess).not.toHaveBeenCalled()
    const next = vi.fn(), res = makeRes()
    await requireAuthWithoutTouch(SECRET, sessions)(makeReq({ authorization: `Bearer ${createTokens(TEST_USER_A, SECRET).accessToken}` }), res, next)
    expect(sessions.validateAccess).toHaveBeenCalledOnce()
    expect(res.statusCode).toBe(401); expect(next).not.toHaveBeenCalled()
  })
})
it('no-touch authentication still rejects an expired access token before database admission', async () => {
  vi.useFakeTimers()
  try {
    const token = createTokens(TEST_USER_A, SECRET).accessToken
    vi.advanceTimersByTime(61 * 60_000)
    const sessions = { validateAccess: vi.fn().mockResolvedValue(true) }, next = vi.fn(), res = makeRes()
    await requireAuthWithoutTouch(SECRET, sessions)(makeReq({ authorization: `Bearer ${token}` }), res, next)
    expect(res.statusCode).toBe(401)
    expect(sessions.validateAccess).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})
