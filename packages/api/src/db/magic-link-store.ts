/**
 * Magic-link token store — single-use email sign-in tokens.
 *
 * Backs `POST /auth/email/request-link` (create) and `POST /auth/email/verify`
 * (atomic consume). Raw tokens are 32 bytes of randomness, base64url-encoded;
 * only the sha256 hash is stored in `magic_link_tokens.token_hash` so a DB
 * dump can't reconstruct working links.
 *
 * Each token is also issued with a 6-digit **one-time passcode** (`code_hash`)
 * so a user can sign in by typing the code on any device — the cross-device /
 * prefetch-proof alternative to clicking the link. See
 * docs/architecture/platform/auth.md → "Email magic-link flow".
 * Component tag: [COMP:api/magic-link-store].
 */

import { createHash, randomBytes, randomInt } from 'node:crypto'
import { query } from './client.js'

// ── Types ──────────────────────────────────────────────────────

export type MagicLinkLocale = 'en' | 'ja' | 'zh'

export type MagicLinkConsumed = {
  email: string
  nextPath: string | null
  locale: MagicLinkLocale | null
}

/**
 * Result of a `consumeByCode` attempt:
 *   - `ok`      — the code matched an active token; it is now consumed.
 *   - `invalid` — no active code matched (wrong / expired / already used /
 *                 no code was ever issued for this email).
 *   - `locked`  — too many wrong guesses against this email's active codes;
 *                 the code is burnt and the user must request a new one.
 */
export type MagicLinkCodeResult =
  | ({ status: 'ok' } & MagicLinkConsumed)
  | { status: 'invalid' }
  | { status: 'locked' }

export type MagicLinkStore = {
  /**
   * Generate a fresh token + passcode, insert their hashes, and return the raw
   * values to the caller (so the caller can drop them into the email body).
   * The raw token and raw code are the only places these values are reachable —
   * once create() returns and the email is sent, they live only in the user's
   * inbox.
   */
  create(input: {
    email: string
    nextPath?: string
    locale?: MagicLinkLocale
    ip?: string
    userAgent?: string
    /** Optional override for the 15-minute default. */
    ttlMs?: number
  }): Promise<{ token: string; code: string; expiresAt: Date }>

  /**
   * Atomically consume a token. Returns the bound email + next_path + locale
   * on success, or `null` if the token is missing, expired, or already used.
   * The UPDATE-RETURNING is what stops a race where two parallel verifies
   * on the same link both succeed.
   */
  consumeByToken(token: string): Promise<MagicLinkConsumed | null>

  /**
   * Atomically consume a token by its (email, 6-digit code) pair — the OTP
   * sign-in path. Brute force of the 1e6 code space is bounded by
   * `CODE_MAX_ATTEMPTS` failed guesses across the email's active codes (after
   * which `locked` is returned) on top of request-link's 3-codes/email/hour cap.
   */
  consumeByCode(email: string, code: string): Promise<MagicLinkCodeResult>

  /** Count tokens minted for an email since `since`. Backs rate limiting. */
  countRecentForEmail(email: string, since: Date): Promise<number>

  /** Count tokens minted from an IP since `since`. Backs rate limiting. */
  countRecentForIp(ip: string, since: Date): Promise<number>
}

// ── Token + passcode generation ───────────────────────────────

const TOKEN_BYTES = 32
const DEFAULT_TTL_MS = 15 * 60 * 1000

/**
 * How many wrong OTP guesses (across an email's active codes) are tolerated
 * before the code is locked out. With request-link capping active codes at
 * 3/email/hour, ≤5 guesses over a 1e6 space keeps brute-force success below
 * ~1.5e-5 per window while still forgiving a couple of user typos.
 */
export const CODE_MAX_ATTEMPTS = 5

function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/** Uniform 6-digit passcode, zero-padded. `randomInt` avoids modulo bias. */
function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0')
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Hash a passcode salted with its email. The 6-digit space is trivially
 * rainbow-tabled from a bare sha256, so salting per-email means a DB dump
 * can't precompute one table that cracks every row — an attacker must brute
 * each (email, code) pair inside the 15-minute TTL.
 */
function hashCode(email: string, code: string): string {
  return createHash('sha256').update(`${email.trim().toLowerCase()}:${code}`).digest('hex')
}

// ── Implementation ────────────────────────────────────────────

export function createDbMagicLinkStore(): MagicLinkStore {
  return {
    async create(input) {
      const token = generateToken()
      const code = generateCode()
      const tokenHash = hashToken(token)
      const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS
      const expiresAt = new Date(Date.now() + ttlMs)
      const emailLower = input.email.trim().toLowerCase()
      const codeHash = hashCode(emailLower, code)

      await query(
        `INSERT INTO magic_link_tokens (
           token_hash, email, next_path, locale,
           expires_at, created_ip, user_agent, code_hash
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          tokenHash,
          emailLower,
          input.nextPath ?? null,
          input.locale ?? null,
          expiresAt.toISOString(),
          input.ip ?? null,
          input.userAgent ? input.userAgent.slice(0, 512) : null,
          codeHash,
        ],
      )

      return { token, code, expiresAt }
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

    async consumeByCode(email, code) {
      const emailLower = email.trim().toLowerCase()
      const codeHash = hashCode(emailLower, code)

      // 1. Lockout guard — if the email's active codes have already absorbed
      //    CODE_MAX_ATTEMPTS wrong guesses, refuse without even checking the
      //    code. `activeCount === 0` (no live code) is reported as `invalid`,
      //    which is indistinguishable from a wrong code (no email enumeration).
      const active = await query<{ maxAttempts: number | null; n: string }>(
        `SELECT MAX(code_attempts) AS "maxAttempts", COUNT(*)::text AS n
           FROM magic_link_tokens
          WHERE email = $1
            AND used_at IS NULL
            AND expires_at > NOW()
            AND code_hash IS NOT NULL`,
        [emailLower],
      )
      const activeCount = parseInt(active.rows[0]?.n ?? '0', 10)
      if (activeCount === 0) return { status: 'invalid' }
      if ((active.rows[0]?.maxAttempts ?? 0) >= CODE_MAX_ATTEMPTS) {
        return { status: 'locked' }
      }

      // 2. Atomic single-use consume of the newest matching code. Same
      //    used_at-NULL + future-expiry guard as consumeByToken, scoped to the
      //    (email, code_hash) pair via a single-row subselect.
      const consumed = await query<{
        email: string
        nextPath: string | null
        locale: MagicLinkLocale | null
      }>(
        `UPDATE magic_link_tokens
           SET used_at = NOW()
         WHERE id = (
           SELECT id FROM magic_link_tokens
            WHERE email = $1
              AND code_hash = $2
              AND used_at IS NULL
              AND expires_at > NOW()
            ORDER BY created_at DESC
            LIMIT 1
         )
         RETURNING email, next_path AS "nextPath", locale`,
        [emailLower, codeHash],
      )
      if (consumed.rows.length > 0) {
        return { status: 'ok', ...consumed.rows[0] }
      }

      // 3. Wrong code — burn one attempt against every active code for this
      //    email so repeated guesses walk toward the lockout.
      await query(
        `UPDATE magic_link_tokens
           SET code_attempts = code_attempts + 1
         WHERE email = $1
           AND used_at IS NULL
           AND expires_at > NOW()
           AND code_hash IS NOT NULL`,
        [emailLower],
      )
      return { status: 'invalid' }
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
