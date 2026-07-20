/**
 * Linked-identity store — auth-only half of the user_linked_accounts split.
 *
 * Stage 3 of the team-connector promotion. "This external provider identity
 * IS this Use Brian user." Used by the mini-app auto-login path and by
 * any webhook enrichment step that needs to look up the Use Brian user
 * behind an external identity.
 *
 * Routing decisions (which assistant does this identity talk to?) live in
 * `channel_routes` — a separate store with a separate shape. See
 * `channel-route-store.ts`.
 *
 * Coexists with `linked-accounts.ts` (legacy) during the dual-read window.
 * Webhook handlers prefer this store and fall back to `linkedAccountStore`
 * if no row exists in `linked_identities` yet.
 *
 * See docs/architecture/integrations/mcp.md.
 * Component tag: [COMP:api/linked-identity-store].
 */

import { query, queryWithRLS } from './client.js'

export type LinkedIdentity = {
  id: string
  userId: string
  provider: string
  providerId: string
  metadata: Record<string, unknown> | null
  linkedAt: Date
}

const COLS = `
  id,
  user_id AS "userId",
  provider,
  provider_id AS "providerId",
  metadata,
  linked_at AS "linkedAt"
` as const

export type LinkedIdentityStore = {
  /**
   * Look up the Use Brian user behind an external provider identity.
   * System-level (no RLS) — called by webhook handlers before a user
   * session exists. Analogous to the legacy `findByProvider`.
   */
  findByProvider(provider: string, providerId: string): Promise<LinkedIdentity | null>

  /**
   * Create or refresh an identity row. Idempotent on (provider, provider_id).
   * No RLS — called after link-code verification.
   */
  upsert(params: {
    userId: string
    provider: string
    providerId: string
    metadata?: Record<string, unknown>
  }): Promise<LinkedIdentity>

  /** List identities owned by a user. RLS-gated. */
  listForUser(actingUserId: string): Promise<LinkedIdentity[]>

  /** Unlink — deletes an identity row. RLS-gated. */
  deleteForUser(actingUserId: string, id: string): Promise<boolean>
}

export function createLinkedIdentityStore(): LinkedIdentityStore {
  return {
    async findByProvider(provider, providerId) {
      const result = await query<LinkedIdentity>(
        `SELECT ${COLS} FROM linked_identities
         WHERE provider = $1 AND provider_id = $2`,
        [provider, providerId],
      )
      return result.rows[0] ?? null
    },

    async upsert(params) {
      const result = await query<LinkedIdentity>(
        `INSERT INTO linked_identities (user_id, provider, provider_id, metadata)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (provider, provider_id) DO UPDATE SET
           user_id = EXCLUDED.user_id,
           metadata = EXCLUDED.metadata
         RETURNING ${COLS}`,
        [
          params.userId,
          params.provider,
          params.providerId,
          params.metadata ? JSON.stringify(params.metadata) : null,
        ],
      )
      return result.rows[0]
    },

    async listForUser(actingUserId) {
      const result = await queryWithRLS<LinkedIdentity>(
        actingUserId,
        `SELECT ${COLS} FROM linked_identities ORDER BY linked_at DESC`,
        [],
      )
      return result.rows
    },

    async deleteForUser(actingUserId, id) {
      const result = await queryWithRLS(
        actingUserId,
        `DELETE FROM linked_identities WHERE id = $1`,
        [id],
      )
      return (result.rowCount ?? 0) > 0
    },
  }
}
