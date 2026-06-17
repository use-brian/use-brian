/**
 * Telegram link code store — temporary 6-char codes for the linking handshake.
 *
 * Web UI generates a code, user sends it to the Telegram bot, bot verifies
 * and creates a linked account. Codes expire after 5 minutes.
 *
 * See docs/architecture/platform/auth.md → "Linked Accounts".
 * Component tag: [COMP:api/link-codes-store].
 */

import { randomInt } from 'node:crypto'
import { query } from './client.js'

// ── Types ──────────────────────────────────────────────────────

export type LinkCode = {
  id: string
  userId: string
  assistantId: string
  code: string
  expiresAt: Date
  claimedAt: Date | null
  claimedByProviderId: string | null
  createdAt: Date
}

export type LinkCodeStore = {
  /**
   * Generate a new 6-char code. Invalidates any existing unclaimed codes
   * for this (user, assistant) pair.
   */
  create(params: { userId: string; assistantId: string }): Promise<LinkCode>

  /**
   * Look up a valid (unclaimed, unexpired) code.
   * No RLS — used by the Telegram webhook handler.
   */
  findValidCode(code: string): Promise<LinkCode | null>

  /** Mark a code as claimed. No RLS. */
  claim(code: string, providerIdThatClaimed: string): Promise<void>

  /**
   * Get the most recent code for a (user, assistant) pair.
   * Used by the web UI polling endpoint to check link status.
   * No RLS — the API route enforces auth via requireAuth + ownership check.
   */
  getByUserAndAssistant(userId: string, assistantId: string): Promise<LinkCode | null>
}

// ── Column aliases ────────────────────────────────────────────

const TLC_COLS = `
  id, user_id as "userId", assistant_id as "assistantId",
  code, expires_at as "expiresAt", claimed_at as "claimedAt",
  claimed_by_provider_id as "claimedByProviderId", created_at as "createdAt"
`

type TlcRow = {
  id: string
  userId: string
  assistantId: string
  code: string
  expiresAt: Date
  claimedAt: Date | null
  claimedByProviderId: string | null
  createdAt: Date
}

// ── Code generation ───────────────────────────────────────────

// Alphabet: uppercase alphanumeric without ambiguous chars (0/O, 1/I/L)
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6
const TTL_MINUTES = 5

function generateCode(): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(ALPHABET.length)]
  }
  return code
}

// ── Factory ───────────────────────────────────────────────────

export function createDbLinkCodeStore(): LinkCodeStore {
  return {
    async create(params) {
      // Invalidate any existing unclaimed codes for this user+assistant
      await query(
        `UPDATE telegram_link_codes
         SET expires_at = now()
         WHERE user_id = $1 AND assistant_id = $2 AND claimed_at IS NULL AND expires_at > now()`,
        [params.userId, params.assistantId],
      )

      const code = generateCode()
      const result = await query<TlcRow>(
        `INSERT INTO telegram_link_codes (user_id, assistant_id, code, expires_at)
         VALUES ($1, $2, $3, now() + interval '${TTL_MINUTES} minutes')
         RETURNING ${TLC_COLS}`,
        [params.userId, params.assistantId, code],
      )
      return result.rows[0]
    },

    async findValidCode(code) {
      const result = await query<TlcRow>(
        `SELECT ${TLC_COLS}
         FROM telegram_link_codes
         WHERE code = $1 AND claimed_at IS NULL AND expires_at > now()
         LIMIT 1`,
        [code],
      )
      return result.rows[0] ?? null
    },

    async claim(code, providerIdThatClaimed) {
      await query(
        `UPDATE telegram_link_codes
         SET claimed_at = now(), claimed_by_provider_id = $2
         WHERE code = $1 AND claimed_at IS NULL`,
        [code, providerIdThatClaimed],
      )
    },

    async getByUserAndAssistant(userId, assistantId) {
      const result = await query<TlcRow>(
        `SELECT ${TLC_COLS}
         FROM telegram_link_codes
         WHERE user_id = $1 AND assistant_id = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [userId, assistantId],
      )
      return result.rows[0] ?? null
    },
  }
}
