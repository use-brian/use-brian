/**
 * Chat-link store — public chat URLs for an assistant.
 *
 * Backs the `/c/<token>` anonymous chat surface. Spec:
 * docs/architecture/features/public-chat-link.md.
 *
 * Uses query() (not queryWithRLS) — same documented pattern as
 * connection-store.ts: anonymous token resolution crosses user
 * boundaries, so authorization is enforced at the route layer
 * (owner/workspace-admin gate on the manage routes; the token itself
 * is the credential on the public routes).
 *
 * The token is stored raw (not hashed) — see the migration-372 header
 * for the rationale. 32 bytes of entropy, URL-safe.
 *
 * [COMP:api/chat-link-store]
 */

import { randomBytes } from 'node:crypto'
import { query } from './client.js'

export type ChatLink = {
  id: string
  assistantId: string
  token: string
  label: string
  status: 'active' | 'revoked'
  dailyMessageLimit: number
  dailyUsed: number
  createdBy: string | null
  createdAt: Date
  revokedAt: Date | null
  lastUsedAt: Date | null
}

/** A resolved active link plus what the anon surface needs to render/gate. */
export type ResolvedChatLink = {
  linkId: string
  assistantId: string
  dailyMessageLimit: number
  workspaceId: string | null
  assistantName: string
  assistantIconSeed: number
  assistantBio: string | null
}

const LINK_COLUMNS = `
  id,
  assistant_id AS "assistantId",
  token,
  label,
  status,
  daily_message_limit AS "dailyMessageLimit",
  daily_used AS "dailyUsed",
  created_by AS "createdBy",
  created_at AS "createdAt",
  revoked_at AS "revokedAt",
  last_used_at AS "lastUsedAt"
` as const

function mintChatLinkToken(): string {
  return randomBytes(32).toString('base64url')
}

export type ChatLinkStore = {
  /** Mint a new link for an assistant. Route layer enforces owner/admin. */
  create(input: {
    assistantId: string
    createdBy: string
    label?: string
    dailyMessageLimit?: number
  }): Promise<ChatLink>

  /** All links (active + revoked) for an assistant, newest first. */
  listForAssistant(assistantId: string): Promise<ChatLink[]>

  /** Revoke a link. Returns false when it doesn't belong to the assistant. */
  revoke(linkId: string, assistantId: string): Promise<boolean>

  /**
   * Resolve a presented token to an active link. Returns null when the
   * token is unknown, revoked, or the assistant's workspace has switched
   * external sharing off (same kill switch page share links honor).
   */
  resolveToken(token: string): Promise<ResolvedChatLink | null>

  /**
   * Atomically consume one message from the link's daily budget.
   * Increment-or-reset by date in a single UPDATE so concurrent turns
   * never race. Returns `{ allowed: false }` when the cap is exceeded
   * (limit 0 = unlimited). Also stamps last_used_at.
   */
  consumeDailyBudget(linkId: string): Promise<{ allowed: boolean; used: number; limit: number }>
}

export function createChatLinkStore(): ChatLinkStore {
  return {
    async create({ assistantId, createdBy, label, dailyMessageLimit }) {
      const token = mintChatLinkToken()
      const result = await query<ChatLink>(
        `INSERT INTO assistant_chat_links
           (assistant_id, token, label, daily_message_limit, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${LINK_COLUMNS}`,
        [
          assistantId,
          token,
          label?.trim() || 'Public chat',
          dailyMessageLimit ?? 200,
          createdBy,
        ],
      )
      return result.rows[0]
    },

    async listForAssistant(assistantId) {
      const result = await query<ChatLink>(
        `SELECT ${LINK_COLUMNS} FROM assistant_chat_links
         WHERE assistant_id = $1
         ORDER BY created_at DESC`,
        [assistantId],
      )
      return result.rows
    },

    async revoke(linkId, assistantId) {
      const result = await query(
        `UPDATE assistant_chat_links
         SET status = 'revoked', revoked_at = now()
         WHERE id = $1 AND assistant_id = $2 AND status = 'active'`,
        [linkId, assistantId],
      )
      return (result.rowCount ?? 0) > 0
    },

    async resolveToken(token) {
      const result = await query<ResolvedChatLink>(
        `SELECT
           l.id AS "linkId",
           l.assistant_id AS "assistantId",
           l.daily_message_limit AS "dailyMessageLimit",
           a.workspace_id AS "workspaceId",
           a.name AS "assistantName",
           COALESCE(a.icon_seed, 0) AS "assistantIconSeed",
           a.bio AS "assistantBio"
         FROM assistant_chat_links l
         JOIN assistants a ON a.id = l.assistant_id
         LEFT JOIN workspaces w ON w.id = a.workspace_id
         WHERE l.token = $1
           AND l.status = 'active'
           AND (w.id IS NULL OR w.external_sharing_enabled = true)`,
        [token],
      )
      return result.rows[0] ?? null
    },

    async consumeDailyBudget(linkId) {
      const result = await query<{ used: number; limit: number }>(
        `UPDATE assistant_chat_links
         SET daily_used = CASE
               WHEN daily_window_date = CURRENT_DATE THEN daily_used + 1
               ELSE 1
             END,
             daily_window_date = CURRENT_DATE,
             last_used_at = now()
         WHERE id = $1
         RETURNING daily_used AS "used", daily_message_limit AS "limit"`,
        [linkId],
      )
      const row = result.rows[0]
      if (!row) return { allowed: false, used: 0, limit: 0 }
      const allowed = row.limit === 0 || row.used <= row.limit
      return { allowed, used: row.used, limit: row.limit }
    },
  }
}
