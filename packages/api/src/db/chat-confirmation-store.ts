/**
 * Persistent storage for pending tool confirmations in WhatsApp chats.
 *
 * Replaces the in-memory pendingConfirmations Map so state survives API
 * restarts and is visible across multiple API instances.
 *
 * The ConfirmationResolver (live Promise) still lives in memory — DB is the
 * source of truth for "which chat has a pending confirmation." If the resolver
 * is gone (restart or different instance), the confirmation times out
 * gracefully and the user is informed.
 *
 * Rows auto-expire after 5 minutes (matching the query loop's
 * confirmationTimeoutMs). Expired rows are cleaned up opportunistically.
 */

import { query } from './client.js'

export type ChatConfirmation = {
  chatJid: string
  toolCallId: string
  sessionId: string
  createdAt: Date
  expiresAt: Date
}

export type ChatConfirmationStore = {
  /** Upsert a pending confirmation for a chat (one per chat). */
  upsert(chatJid: string, toolCallId: string, sessionId: string): Promise<void>

  /** Find a pending (non-expired) confirmation for a chat. */
  findByChatJid(chatJid: string): Promise<ChatConfirmation | null>

  /** Remove a confirmation after it's been resolved. */
  remove(chatJid: string): Promise<void>

  /** Clean up expired rows. Called opportunistically. */
  cleanupExpired(): Promise<number>
}

export function createChatConfirmationStore(): ChatConfirmationStore {
  return {
    async upsert(chatJid, toolCallId, sessionId) {
      await query(
        `INSERT INTO chat_confirmations (chat_jid, tool_call_id, session_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (chat_jid) DO UPDATE
         SET tool_call_id = $2, session_id = $3,
             created_at = now(), expires_at = now() + interval '5 minutes'`,
        [chatJid, toolCallId, sessionId],
      )
    },

    async findByChatJid(chatJid) {
      const result = await query<ChatConfirmation>(
        `SELECT chat_jid AS "chatJid", tool_call_id AS "toolCallId",
                session_id AS "sessionId", created_at AS "createdAt", expires_at AS "expiresAt"
         FROM chat_confirmations
         WHERE chat_jid = $1 AND expires_at > now()`,
        [chatJid],
      )
      return result.rows[0] ?? null
    },

    async remove(chatJid) {
      await query(`DELETE FROM chat_confirmations WHERE chat_jid = $1`, [chatJid])
    },

    async cleanupExpired() {
      const result = await query(`DELETE FROM chat_confirmations WHERE expires_at <= now()`)
      return result.rowCount ?? 0
    },
  }
}
