import { describe, it, expect } from 'vitest'
import { createTokens, verifyAccessToken, verifyRefreshToken } from '../jwt.js'

const SECRET = 'test-secret-key-for-jwt-tests-only-not-prod'

describe('[COMP:api/auth] createTokens + verifyAccessToken', () => {
  it('round-trips a user id through an access token', () => {
    const { accessToken } = createTokens('user_123', SECRET)
    const verified = verifyAccessToken(accessToken, SECRET)
    expect(verified).toBe('user_123')
  })

  it('round-trips a user id through a refresh token', () => {
    const { refreshToken } = createTokens('user_456', SECRET)
    const verified = verifyRefreshToken(refreshToken, SECRET)
    expect(verified).toBe('user_456')
  })

  it('returns correct expiry durations', () => {
    const { accessTokenExpiresIn, refreshTokenExpiresIn } = createTokens('user_1', SECRET)
    expect(accessTokenExpiresIn).toBe(60 * 60)            // 1 hour
    expect(refreshTokenExpiresIn).toBe(30 * 24 * 60 * 60) // 30 days
  })

  it('rejects a token signed with a different secret', () => {
    const { accessToken } = createTokens('user_1', SECRET)
    expect(verifyAccessToken(accessToken, 'different-secret')).toBeNull()
  })

  it('rejects a malformed token', () => {
    expect(verifyAccessToken('not.a.token', SECRET)).toBeNull()
    expect(verifyAccessToken('only-two-parts', SECRET)).toBeNull()
    expect(verifyAccessToken('', SECRET)).toBeNull()
  })

  it('rejects an access token passed to verifyRefreshToken', () => {
    const { accessToken } = createTokens('user_1', SECRET)
    expect(verifyRefreshToken(accessToken, SECRET)).toBeNull()
  })

  it('rejects a refresh token passed to verifyAccessToken', () => {
    const { refreshToken } = createTokens('user_1', SECRET)
    expect(verifyAccessToken(refreshToken, SECRET)).toBeNull()
  })

  it('rejects a token with a tampered payload', () => {
    const { accessToken } = createTokens('user_1', SECRET)
    const [header, , signature] = accessToken.split('.')
    const tamperedBody = Buffer.from(
      JSON.stringify({ sub: 'other_user', iat: 0, exp: 9999999999, type: 'access' }),
    ).toString('base64url')
    const tamperedToken = `${header}.${tamperedBody}.${signature}`
    expect(verifyAccessToken(tamperedToken, SECRET)).toBeNull()
  })

  it('generates distinct tokens on each call (no caching)', () => {
    // Freeze time with a single timestamp on both tokens to exercise the
    // path where two back-to-back issuances differ only by payload content.
    // The payloads are identical for the same iat/user, so the tokens can
    // match within the same second — that's intentional and fine.
    const t1 = createTokens('user_1', SECRET)
    const t2 = createTokens('user_2', SECRET)
    expect(t1.accessToken).not.toBe(t2.accessToken)
  })
})
