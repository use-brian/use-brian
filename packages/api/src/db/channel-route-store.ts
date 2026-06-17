/**
 * Channel-route store — routing-only half of the user_linked_accounts split.
 *
 * Stage 3 of the team-connector promotion. "Messages from this external
 * provider identity route to this assistant." Decoupled from user identity:
 * sender attribution is a separate lookup via `linked-identity-store.ts`.
 *
 * UNIQUE (provider, provider_id) — one external chat routes to exactly one
 * assistant at a time. Re-linking to a different assistant overwrites the
 * routing row.
 *
 * Coexists with `linked-accounts.ts` (legacy) during the dual-read window.
 * Webhook handlers prefer this store and fall back to
 * `linkedAccountStore.findByProvider(...)?.assistantId` if no row exists
 * here yet.
 *
 * See docs/architecture/integrations/mcp.md.
 * Component tag: [COMP:api/channel-route-store].
 */

import { query, queryWithRLS } from './client.js'

export type ChannelRoute = {
  id: string
  assistantId: string
  provider: string
  providerId: string
  createdAt: Date
}

const COLS = `
  id,
  assistant_id AS "assistantId",
  provider,
  provider_id AS "providerId",
  created_at AS "createdAt"
` as const

export type ChannelRouteStore = {
  /**
   * Look up the assistant behind an external provider identity.
   * System-level (no RLS) — called by webhook handlers before a user
   * session exists.
   */
  findByProvider(provider: string, providerId: string): Promise<ChannelRoute | null>

  /**
   * Create or re-point a route. Idempotent on (provider, provider_id);
   * re-linking moves the identity to a new assistant.
   */
  upsert(params: {
    assistantId: string
    provider: string
    providerId: string
  }): Promise<ChannelRoute>

  /** List routes pointing at an assistant. No RLS (system use). */
  listForAssistantSystem(assistantId: string): Promise<ChannelRoute[]>

  /** Delete a specific route. System-level; used by member-removal cascade. */
  deleteSystem(provider: string, providerId: string, assistantId: string): Promise<boolean>

  /** Delete all routes pointing at an assistant. System-level; used when an assistant is deleted. */
  deleteAllForAssistantSystem(assistantId: string): Promise<number>
}

export function createChannelRouteStore(): ChannelRouteStore {
  return {
    async findByProvider(provider, providerId) {
      const result = await query<ChannelRoute>(
        `SELECT ${COLS} FROM channel_routes
         WHERE provider = $1 AND provider_id = $2`,
        [provider, providerId],
      )
      return result.rows[0] ?? null
    },

    async upsert(params) {
      const result = await query<ChannelRoute>(
        `INSERT INTO channel_routes (assistant_id, provider, provider_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (provider, provider_id) DO UPDATE SET
           assistant_id = EXCLUDED.assistant_id
         RETURNING ${COLS}`,
        [params.assistantId, params.provider, params.providerId],
      )
      return result.rows[0]
    },

    async listForAssistantSystem(assistantId) {
      const result = await query<ChannelRoute>(
        `SELECT ${COLS} FROM channel_routes WHERE assistant_id = $1`,
        [assistantId],
      )
      return result.rows
    },

    async deleteSystem(provider, providerId, assistantId) {
      const result = await query(
        `DELETE FROM channel_routes
         WHERE provider = $1 AND provider_id = $2 AND assistant_id = $3`,
        [provider, providerId, assistantId],
      )
      return (result.rowCount ?? 0) > 0
    },

    async deleteAllForAssistantSystem(assistantId) {
      const result = await query(
        `DELETE FROM channel_routes WHERE assistant_id = $1`,
        [assistantId],
      )
      return result.rowCount ?? 0
    },
  }
}
