/**
 * Magic-link token store — single-use email sign-in tokens.
 *
 * Backs `POST /auth/email/request-link` (create) and `POST /auth/email/verify`
 * (atomic consume). Raw tokens are 32 bytes of randomness, base64url-encoded;
 * only the sha256 hash is stored in `magic_link_tokens.token_hash` so a DB
 * dump can't reconstruct working links.
 *
 * See docs/architecture/platform/auth.md → "Email magic-link flow".
 * Component tag: [COMP:api/magic-link-store].
 */

import { createHash, randomBytes } from 'node:crypto'
import { query } from './client.js'

// ── Types ──────────────────────────────────────────────────────

export type MagicLinkLocale = 'en' | 'ja' | 'zh'

export type MagicLinkConsumed = {
  email: string
  nextPath: string | null
  locale: MagicLinkLocale | null
}

export type MagicLinkStore = {
  /**
   * Generate a fresh token, insert its hash, return the raw token to the
   * caller (so the caller can drop it into the email body). The raw token
   * is the only place this value is reachable — once create() returns and
   * the email is sent, the value lives only in the user's inbox.
   */
  create(input: {
    email: string
    nextPath?: string
    locale?: MagicLinkLocale
    ip?: string
    userAgent?: string
    /** Optional override for the 15-minute default. */
    ttlMs?: number
  }): Promise<{ token: string; expiresAt: Date }>

  /**
   * Atomically consume a token. Returns the bound email + next_path + locale
   * on success, or `null` if the token is missing, expired, or already used.
   * The UPDATE-RETURNING is what stops a race where two parallel verifies
   * on the same link both succeed.
   */
  consumeByToken(token: string): Promise<MagicLinkConsumed | null>

  /** Count tokens minted for an email since `since`. Backs rate limiting. */
  countRecentForEmail(email: string, since: Date): Promise<number>

  /** Count tokens minted from an IP since `since`. Backs rate limiting. */
  countRecentForIp(ip: string, since: Date): Promise<number>
}

// ── Token generation ──────────────────────────────────────────

const TOKEN_BYTES = 32
const DEFAULT_TTL_MS = 15 * 60 * 1000

function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// ── Implementation ────────────────────────────────────────────

export function createDbMagicLinkStore(): MagicLinkStore {
  return {
    async create(input) {
      const token = generateToken()
      const tokenHash = hashToken(token)
      const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS
      const expiresAt = new Date(Date.now() + ttlMs)
      const emailLower = input.email.trim().toLowerCase()

      await query(
        `INSERT INTO magic_link_tokens (
           token_hash, email, next_path, locale,
           expires_at, created_ip, user_agent
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          tokenHash,
          emailLower,
          input.nextPath ?? null,
          input.locale ?? null,
          expiresAt.toISOString(),
          input.ip ?? null,
          input.userAgent ? input.userAgent.slice(0, 512) : null,
        ],
      )

      return { token, expiresAt }
    },

    async consumeByToken(token) {
      const tokenHash = hashToken(token)
      // Atomic consume: only one parallel caller can flip used_at from NULL.
      // The WHERE clause + RETURNING prevents the read-then-write race.
      const result = await query<{
        email: string
        nextPath: string | null
        locale: MagicLinkLocale | null
      }>(
        `UPDATE magic_link_tokens
           SET used_at = NOW()
         WHERE token_hash = $1
           AND used_at IS NULL
           AND expires_at > NOW()
         RETURNING email, next_path AS "nextPath", locale`,
        [tokenHash],
      )

      if (result.rows.length === 0) return null
      return result.rows[0]
    },

    async countRecentForEmail(email, since) {
      const result = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM magic_link_tokens
         WHERE email = $1 AND created_at >= $2`,
        [email.trim().toLowerCase(), since.toISOString()],
      )
      return parseInt(result.rows[0]?.count ?? '0', 10)
    },

    async countRecentForIp(ip, since) {
      const result = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM magic_link_tokens
         WHERE created_ip = $1::inet AND created_at >= $2`,
        [ip, since.toISOString()],
      )
      return parseInt(result.rows[0]?.count ?? '0', 10)
    },
  }
}
