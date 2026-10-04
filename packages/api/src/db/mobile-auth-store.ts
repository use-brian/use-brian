import { createHash, randomBytes } from 'node:crypto'
import { query } from './client.js'

export const MOBILE_REDIRECT_URI = 'usebrian-mobile://auth'
export function isMobileClient(clientId: unknown, redirectUri: unknown): clientId is string {
  return (clientId === 'brian-ios' || clientId === 'brian-android') && redirectUri === MOBILE_REDIRECT_URI
}
export function isS256Challenge(value: unknown): value is string {
  // A canonical, unpadded SHA-256 base64url encoding (including its final pad bits).
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value
}
export type MobileAuthBinding = { clientId: string; redirectUri: string }
export type MobileAuthStore = {
  create(input: MobileAuthBinding & { userId: string; challenge: string }): Promise<{ code: string; expiresAt: Date }>
  consume(input: MobileAuthBinding & { code: string; verifier: string }): Promise<{ userId: string } | null>
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export function createDbMobileAuthStore(): MobileAuthStore {
  return {
    async create(input) {
      const code = randomBytes(32).toString('base64url')
      const expiresAt = new Date(Date.now() + 120_000)
      await query(
        `INSERT INTO mobile_auth_codes (code_hash, user_id, client_id, redirect_uri, challenge, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [hash(code), input.userId, input.clientId, input.redirectUri, input.challenge, expiresAt.toISOString()],
      )
      return { code, expiresAt }
    },
    async consume(input) {
      const challenge = createHash('sha256').update(input.verifier).digest('base64url')
      // Every binding is checked BEFORE consumption, in the same atomic statement.
      // Failed PKCE/client/redirect checks cannot burn a legitimate user's code.
      const result = await query<{ userId: string }>(
        `UPDATE mobile_auth_codes SET used_at = NOW()
         WHERE code_hash = $1 AND client_id = $2 AND redirect_uri = $3 AND challenge = $4
           AND used_at IS NULL AND expires_at > NOW()
         RETURNING user_id AS "userId"`,
        [hash(input.code), input.clientId, input.redirectUri, challenge],
      )
      return result.rows[0] ?? null
    },
  }
}
