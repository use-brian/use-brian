import { createHmac } from 'node:crypto'

/**
 * Short-lived bearer token that binds a verified Telegram user identity to
 * a pending Google OAuth handshake. See docs/architecture/channels/telegram-mini-app.md.
 *
 * HS256 using the shared JWT_SECRET. The `kind: 'tg-link'` claim keeps this
 * distinct from the access/refresh tokens minted by jwt.ts.
 */

const TTL_SECONDS = 300 // 5 minutes

export type TgLinkTokenPayload = {
  kind: 'tg-link'
  tgUserId: string
  firstName: string | null
  chatId: string
  iat: number
  exp: number
}

function base64url(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data
  return buf.toString('base64url')
}

export function signTgLinkToken(
  input: { tgUserId: string; firstName: string | null; chatId: string },
  secret: string,
): string {
  const now = Math.floor(Date.now() / 1000)
  const payload: TgLinkTokenPayload = {
    kind: 'tg-link',
    tgUserId: input.tgUserId,
    firstName: input.firstName,
    chatId: input.chatId,
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

export function verifyTgLinkToken(token: string, secret: string): TgLinkTokenPayload | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null

  const [header, body, signature] = parts
  const expected = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url')

  if (signature !== expected) return null

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as TgLinkTokenPayload
    if (payload.kind !== 'tg-link') return null
    if (payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}
