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
  sid?: string  // revocable auth session ID
  ver?: number  // users.auth_version at issuance
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
    if (!payload || typeof payload !== 'object') return null
    if (!Number.isSafeInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

export type VerifiedAuthToken = {
  userId: string
  sessionId?: string
  authVersion?: number
}

export type TokenSession = {
  id: string
  authVersion: number
}

export function createTokens(userId: string, secret: string, session?: TokenSession) {
  const now = Math.floor(Date.now() / 1000)
  const sessionClaims = session ? { sid: session.id, ver: session.authVersion } : {}

  const accessToken = sign(
    { sub: userId, ...sessionClaims, iat: now, exp: now + ACCESS_TOKEN_EXPIRY, type: 'access' },
    secret,
  )

  const refreshToken = sign(
    { sub: userId, ...sessionClaims, iat: now, exp: now + REFRESH_TOKEN_EXPIRY, type: 'refresh' },
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
  return verifyAccessTokenClaims(token, secret)?.userId ?? null
}

export function verifyRefreshToken(token: string, secret: string): string | null {
  return verifyRefreshTokenClaims(token, secret)?.userId ?? null
}

function verifiedClaims(payload: TokenPayload): VerifiedAuthToken | null {
  if (typeof payload.sub !== 'string' || !payload.sub.trim()) return null
  if (payload.sid !== undefined && (typeof payload.sid !== 'string' || !payload.sid.trim())) return null
  if (
    payload.ver !== undefined &&
    (!Number.isSafeInteger(payload.ver) || payload.ver < 0)
  ) return null
  return {
    userId: payload.sub,
    ...(payload.sid ? { sessionId: payload.sid } : {}),
    ...(payload.ver !== undefined ? { authVersion: payload.ver } : {}),
  }
}

export function verifyAccessTokenClaims(token: string, secret: string): VerifiedAuthToken | null {
  const payload = verify(token, secret)
  if (!payload || payload.type !== 'access') return null
  return verifiedClaims(payload)
}

export function verifyRefreshTokenClaims(token: string, secret: string): VerifiedAuthToken | null {
  const payload = verify(token, secret)
  if (!payload || payload.type !== 'refresh') return null
  return verifiedClaims(payload)
}
