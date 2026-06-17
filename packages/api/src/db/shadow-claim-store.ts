/**
 * Shadow claim token store — backs the partner-mediated shadow account
 * claim flow. See docs/architecture/features/shadow-claim.md.
 *
 * Component tag: [COMP:auth/shadow-claim-store].
 *
 * Tokens are short-lived (5min), single-use, and bound to a specific
 * (real_user, shadow_user, partner_key) triple at consent time. The
 * consume path is one atomic UPDATE that flips `used_at` and returns
 * the bound triple — `rowCount === 0` covers all three failure modes
 * (not found / expired / already used) in one query, with a follow-up
 * lookup only when the route needs to disambiguate the error message.
 *
 * No RLS: every read/write here is system-level. Mint is gated by
 * requireAuth at the route layer; consume is gated by API-key auth
 * plus the partner_key_id check.
 */

import { randomBytes } from 'node:crypto'
import { query } from './client.js'

const TOKEN_BYTES = 32
const DEFAULT_TTL_SECONDS = 5 * 60

export type ShadowClaimToken = {
  token: string
  realUserId: string
  shadowUserId: string
  partnerKeyId: string
  externalUserId: string
  displayLabel: string | null
  expiresAt: Date
  usedAt: Date | null
  createdAt: Date
}

export type CreatedShadowClaimToken = {
  token: string
  expiresAt: Date
}

export type ShadowClaimStore = {
  /**
   * Mint a fresh token bound to the (realUser, shadow, partnerKey) triple.
   * Returns the plaintext token + its expiry. Caller must have already
   * validated that:
   *   - realUserId is the authenticated sidanclaw user
   *   - shadowUserId.auth_provider_id === 'api:<partnerKeyId>:<externalUserId>'
   *   - shadowUserId.auth_provider === 'channel'
   *   - shadowUserId !== realUserId
   *
   * No RLS — system-level. The consent route gates with requireAuth.
   */
  create(params: {
    realUserId: string
    shadowUserId: string
    partnerKeyId: string
    externalUserId: string
    displayLabel?: string | null
    ttlSeconds?: number
  }): Promise<CreatedShadowClaimToken>

  /**
   * Atomically consume a token. Returns the bound row on success, or one
   * of the three explicit failure cases. The route maps these to 404 /
   * 409 / 410 respectively so the partner gets actionable errors.
   */
  consume(token: string): Promise<
    | { ok: true; row: ShadowClaimToken }
    | { ok: false; reason: 'not_found' | 'already_used' | 'expired' }
  >
}

export function createShadowClaimStore(): ShadowClaimStore {
  return {
    async create(params) {
      const token = randomBytes(TOKEN_BYTES).toString('base64url')
      const ttl = params.ttlSeconds ?? DEFAULT_TTL_SECONDS
      const expiresAt = new Date(Date.now() + ttl * 1000)

      await query(
        `INSERT INTO shadow_claim_tokens
           (token, real_user_id, shadow_user_id, partner_key_id,
            external_user_id, display_label, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          token,
          params.realUserId,
          params.shadowUserId,
          params.partnerKeyId,
          params.externalUserId,
          params.displayLabel ?? null,
          expiresAt,
        ],
      )

      return { token, expiresAt }
    },

    async consume(token) {
      // Single-shot atomic consume. Only flips `used_at` on a token that's
      // (a) present, (b) unused, (c) unexpired — concurrent calls race
      // safely because the WHERE filters race-and-die in the database.
      const consumed = await query<{
        token: string
        realUserId: string
        shadowUserId: string
        partnerKeyId: string
        externalUserId: string
        displayLabel: string | null
        expiresAt: Date
        usedAt: Date | null
        createdAt: Date
      }>(
        `UPDATE shadow_claim_tokens
            SET used_at = now()
          WHERE token = $1
            AND used_at IS NULL
            AND expires_at > now()
        RETURNING
          token,
          real_user_id     AS "realUserId",
          shadow_user_id   AS "shadowUserId",
          partner_key_id   AS "partnerKeyId",
          external_user_id AS "externalUserId",
          display_label    AS "displayLabel",
          expires_at       AS "expiresAt",
          used_at          AS "usedAt",
          created_at       AS "createdAt"`,
        [token],
      )

      if (consumed.rows.length > 0) {
        return { ok: true, row: consumed.rows[0] }
      }

      // Disambiguate the failure for error messaging. Read-only follow-up.
      const probe = await query<{ used_at: Date | null; expires_at: Date }>(
        `SELECT used_at, expires_at FROM shadow_claim_tokens WHERE token = $1`,
        [token],
      )
      if (probe.rows.length === 0) {
        return { ok: false, reason: 'not_found' }
      }
      if (probe.rows[0].used_at !== null) {
        return { ok: false, reason: 'already_used' }
      }
      return { ok: false, reason: 'expired' }
    },
  }
}
