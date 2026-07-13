import { createHmac } from 'node:crypto'

/**
 * Short-lived pairing token for the browser extension (computer-use local
 * mode, spec §4 "Local mode"): minted by the authed
 * `POST /api/browser-extension/pair`, presented by the extension in the
 * relay's `hello{pairingToken}` envelope, verified by the relay with the
 * same shared JWT_SECRET, and bound to `{userId, workspaceId}` for the life
 * of the WebSocket connection.
 *
 * HS256 like jwt.ts / tg-link-token.ts; the `kind: 'browser-ext-pair'`
 * claim keeps it distinct from access/refresh and tg-link tokens.
 */

const TTL_SECONDS = 600 // 10 minutes — pairing is an interactive one-shot

export type BrowserExtPairTokenPayload = {
  kind: 'browser-ext-pair'
  userId: string
  workspaceId: string
  iat: number
  exp: number
}

function base64url(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data
  return buf.toString('base64url')
}

export function signBrowserExtPairToken(
  input: { userId: string; workspaceId: string },
  secret: string,
): string {
  const now = Math.floor(Date.now() / 1000)
  const payload: BrowserExtPairTokenPayload = {
    kind: 'browser-ext-pair',
    userId: input.userId,
    workspaceId: input.workspaceId,
    iat: now,
    exp: now + TTL_SECONDS,
  }
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify(payload))
  const signature = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url')
  return `${header}.${body}.${signature}`
}

export function verifyBrowserExtPairToken(
  token: string,
  secret: string,
): BrowserExtPairTokenPayload | null {
  const payload = verifyKind(token, secret, 'browser-ext-pair')
  return payload as BrowserExtPairTokenPayload | null
}

/**
 * Longer-lived session token the RELAY mints (same shared secret) after a
 * successful pair-token hello and returns in `ready{sessionToken}` — so the
 * extension can reconnect with backoff + re-`hello` for weeks without asking
 * the user to re-pair. Revocation = rotating JWT_SECRET or unpairing in the
 * extension; per-user server-side revocation can ride the vault work later.
 */
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days

export type BrowserExtSessionTokenPayload = {
  kind: 'browser-ext-session'
  userId: string
  workspaceId: string
  iat: number
  exp: number
}

export function signBrowserExtSessionToken(
  input: { userId: string; workspaceId: string },
  secret: string,
): string {
  const now = Math.floor(Date.now() / 1000)
  const payload: BrowserExtSessionTokenPayload = {
    kind: 'browser-ext-session',
    userId: input.userId,
    workspaceId: input.workspaceId,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  }
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify(payload))
  const signature = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url')
  return `${header}.${body}.${signature}`
}

export function verifyBrowserExtSessionToken(
  token: string,
  secret: string,
): BrowserExtSessionTokenPayload | null {
  const payload = verifyKind(token, secret, 'browser-ext-session')
  return payload as BrowserExtSessionTokenPayload | null
}

/** Accept either token kind at the relay's hello (pair = first time, session = reconnect). */
export function verifyBrowserExtHelloToken(
  token: string,
  secret: string,
): { kind: 'browser-ext-pair' | 'browser-ext-session'; userId: string; workspaceId: string } | null {
  return (
    verifyBrowserExtPairToken(token, secret) ?? verifyBrowserExtSessionToken(token, secret)
  )
}

function verifyKind(
  token: string,
  secret: string,
  kind: 'browser-ext-pair' | 'browser-ext-session',
): { kind: typeof kind; userId: string; workspaceId: string; iat: number; exp: number } | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const [header, body, signature] = parts
  const expected = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url')

  if (signature !== expected) return null

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as {
      kind?: string
      userId?: string
      workspaceId?: string
      iat?: number
      exp?: number
    }
    if (payload.kind !== kind) return null
    if (typeof payload.userId !== 'string' || payload.userId.length === 0) return null
    if (typeof payload.workspaceId !== 'string' || payload.workspaceId.length === 0) return null
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload as { kind: typeof kind; userId: string; workspaceId: string; iat: number; exp: number }
  } catch {
    return null
  }
}
