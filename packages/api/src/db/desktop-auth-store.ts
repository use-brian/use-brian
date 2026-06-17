/**
 * Desktop-auth code store — single-use codes for the native desktop OAuth
 * handoff (RFC 8252 + PKCE).
 *
 * Backs `POST /auth/desktop/code` (create, called by the browser-side
 * `/desktop/auth` bridge for an authenticated user) and
 * `POST /auth/desktop/exchange` (atomic consume, called by the Electron app).
 * Raw codes are 32 bytes of randomness, base64url-encoded; only the sha256 hash
 * is stored in `desktop_auth_codes.code_hash` so a DB dump can't reconstruct
 * working codes.
 *
 * See docs/architecture/platform/auth.md → "Desktop app sign-in (PKCE handoff)".
 * Component tag: [COMP:api/desktop-auth-store].
 */

import { createHash, randomBytes } from 'node:crypto'
import { query } from './client.js'

export type DesktopAuthConsumed = {
  userId: string
  /** The PKCE S256 challenge bound at mint time; the exchange route verifies it. */
  challenge: string
}

export type DesktopAuthStore = {
  /**
   * Mint a fresh code for an authenticated user, bound to a PKCE challenge.
   * Inserts only the hash; returns the raw code so the bridge can put it in the
   * `sidanclaw://auth?code=…` redirect. Once create() returns, the raw value
   * lives only in that redirect.
   */
  create(input: {
    userId: string
    challenge: string
    ip?: string
    /** Optional override for the 2-minute default. */
    ttlMs?: number
  }): Promise<{ code: string; expiresAt: Date }>

  /**
   * Atomically consume a code. Returns the bound `{ userId, challenge }` on
   * success, or `null` if the code is missing, expired, or already used. The
   * UPDATE-RETURNING stops a race where two parallel exchanges both succeed.
   */
  consume(code: string): Promise<DesktopAuthConsumed | null>
}

const CODE_BYTES = 32
const DEFAULT_TTL_MS = 2 * 60 * 1000

function generateCode(): string {
  return randomBytes(CODE_BYTES).toString('base64url')
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

export function createDbDesktopAuthStore(): DesktopAuthStore {
  return {
    async create(input) {
      const code = generateCode()
      const codeHash = hashCode(code)
      const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS
      const expiresAt = new Date(Date.now() + ttlMs)

      await query(
        `INSERT INTO desktop_auth_codes (code_hash, user_id, challenge, expires_at, created_ip)
         VALUES ($1, $2, $3, $4, $5)`,
        [codeHash, input.userId, input.challenge, expiresAt.toISOString(), input.ip ?? null],
      )

      return { code, expiresAt }
    },

    async consume(code) {
      const codeHash = hashCode(code)
      const result = await query<{ userId: string; challenge: string }>(
        `UPDATE desktop_auth_codes
           SET used_at = NOW()
         WHERE code_hash = $1
           AND used_at IS NULL
           AND expires_at > NOW()
         RETURNING user_id AS "userId", challenge`,
        [codeHash],
      )

      if (result.rows.length === 0) return null
      return result.rows[0]
    },
  }
}
