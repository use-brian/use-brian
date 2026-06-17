import { createHmac, randomBytes } from 'node:crypto'

/**
 * Minimal JWT implementation (HS256) — no external dependency.
 *
 * Access tokens: 1h expiry, used for API requests.
 * Refresh tokens: 30d expiry, stored as httpOnly cookie, used to get new access tokens.
 */

const ACCESS_TOKEN_EXPIRY = 60 * 60           // 1 hour
const REFRESH_TOKEN_EXPIRY = 30 * 24 * 60 * 60 // 30 days

type TokenPayload = {
  sub: string   // user ID
  iat: number
  exp: number
  type: 'access' | 'refresh'
}

function base64url(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data
  return buf.toString('base64url')
}

function sign(payload: TokenPayload, secret: string): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify(payload))
  const signature = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url')
  return `${header}.${body}.${signature}`
}

function verify(token: string, secret: string): TokenPayload | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const [header, body, signature] = parts
  const expected = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url')

  if (signature !== expected) return null

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenPayload
    if (payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

export function createTokens(userId: string, secret: string) {
  const now = Math.floor(Date.now() / 1000)

  const accessToken = sign(
    { sub: userId, iat: now, exp: now + ACCESS_TOKEN_EXPIRY, type: 'access' },
    secret,
  )

  const refreshToken = sign(
    { sub: userId, iat: now, exp: now + REFRESH_TOKEN_EXPIRY, type: 'refresh' },
    secret,
  )

  return {
    accessToken,
    refreshToken,
    accessTokenExpiresIn: ACCESS_TOKEN_EXPIRY,
    refreshTokenExpiresIn: REFRESH_TOKEN_EXPIRY,
  }
}

export function verifyAccessToken(token: string, secret: string): string | null {
  const payload = verify(token, secret)
  if (!payload || payload.type !== 'access') return null
  return payload.sub
}

export function verifyRefreshToken(token: string, secret: string): string | null {
  const payload = verify(token, secret)
  if (!payload || payload.type !== 'refresh') return null
  return payload.sub
}
