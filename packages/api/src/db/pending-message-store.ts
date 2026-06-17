/**
 * Pending message store — async message queue for inter-assistant communication.
 *
 * Handles two message types:
 * - ask_confirmation: callee drafts a response, owner must approve/reject/edit
 * - async_response: approved response delivered to caller on next interaction
 *
 * Pending messages are first-class persisted entities — they survive server
 * restarts and are queryable from any session/channel.
 *
 * See docs/plans/inter-assistant-communication.md.
 */

import { query, queryWithRLS } from './client.js'

// ── Types ──────────────────────────────────────────────────────

export type PendingMessage = {
  id: string
  targetAssistantId: string
  targetUserId: string
  sourceAssistantId: string
  messageType: 'ask_confirmation' | 'async_response'
  category: string | null
  payload: Record<string, unknown>
  status: 'pending' | 'delivered' | 'resolved'
  resolution: 'approved' | 'rejected' | 'edited' | null
  resolvedPayload: Record<string, unknown> | null
  createdAt: Date
  resolvedAt: Date | null
  deliveredAt: Date | null
  /** Joined fields for display. */
  sourceAssistantName?: string
  sourceOwnerHandle?: string
}

const MESSAGE_COLUMNS = `
  id,
  target_assistant_id AS "targetAssistantId",
  target_user_id AS "targetUserId",
  source_assistant_id AS "sourceAssistantId",
  message_type AS "messageType",
  category,
  payload,
  status,
  resolution,
  resolved_payload AS "resolvedPayload",
  created_at AS "createdAt",
  resolved_at AS "resolvedAt",
  delivered_at AS "deliveredAt"
` as const

const MESSAGE_COLUMNS_WITH_SOURCE = `
  apm.id,
  apm.target_assistant_id AS "targetAssistantId",
  apm.target_user_id AS "targetUserId",
  apm.source_assistant_id AS "sourceAssistantId",
  apm.message_type AS "messageType",
  apm.category,
  apm.payload,
  apm.status,
  apm.resolution,
  apm.resolved_payload AS "resolvedPayload",
  apm.created_at AS "createdAt",
  apm.resolved_at AS "resolvedAt",
  apm.delivered_at AS "deliveredAt",
  sa.name AS "sourceAssistantName",
  su.handle AS "sourceOwnerHandle"
` as const

// ── Store ──────────────────────────────────────────────────────

export type PendingMessageStore = {
  create(params: {
    targetAssistantId: string
    targetUserId: string
    sourceAssistantId: string
    messageType: 'ask_confirmation' | 'async_response'
    category?: string
    payload: Record<string, unknown>
  }): Promise<PendingMessage>

  /** List pending messages for a user (across all their assistants). */
  listForUser(userId: string): Promise<PendingMessage[]>

  /** List pending messages for a specific assistant. */
  listForAssistant(userId: string, assistantId: string): Promise<PendingMessage[]>

  /** Resolve a pending message (approve/reject/edit). */
  resolve(
    userId: string,
    messageId: string,
    decision: 'approved' | 'rejected' | 'edited',
    editedPayload?: Record<string, unknown>,
  ): Promise<PendingMessage | null>

  /** Mark a message as delivered (shown to the user). */
  markDelivered(messageId: string): Promise<void>

  /** Get pending messages for delivery (system-level, no RLS). */
  getPendingForDelivery(userId: string, assistantId: string): Promise<PendingMessage[]>
}

export function createPendingMessageStore(): PendingMessageStore {
  return {
    async create(params) {
      const result = await query<PendingMessage>(
        `INSERT INTO assistant_pending_messages
         (target_assistant_id, target_user_id, source_assistant_id, message_type, category, payload)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${MESSAGE_COLUMNS}`,
        [
          params.targetAssistantId,
          params.targetUserId,
          params.sourceAssistantId,
          params.messageType,
          params.category ?? null,
          JSON.stringify(params.payload),
        ],
      )
      return result.rows[0]
    },

    async listForUser(userId) {
      const result = await queryWithRLS<PendingMessage>(
        userId,
        `SELECT ${MESSAGE_COLUMNS_WITH_SOURCE}
         FROM assistant_pending_messages apm
         JOIN assistants sa ON sa.id = apm.source_assistant_id
         JOIN users su ON su.id = sa.owner_user_id
         WHERE apm.target_user_id = $1 AND apm.status IN ('pending', 'delivered')
         ORDER BY apm.created_at DESC`,
        [userId],
      )
      return result.rows
    },

    async listForAssistant(userId, assistantId) {
      const result = await queryWithRLS<PendingMessage>(
        userId,
        `SELECT ${MESSAGE_COLUMNS_WITH_SOURCE}
         FROM assistant_pending_messages apm
         JOIN assistants sa ON sa.id = apm.source_assistant_id
         JOIN users su ON su.id = sa.owner_user_id
         WHERE apm.target_assistant_id = $1 AND apm.status IN ('pending', 'delivered')
         ORDER BY apm.created_at DESC`,
        [assistantId],
      )
      return result.rows
    },

    async resolve(userId, messageId, decision, editedPayload) {
      const result = await queryWithRLS<PendingMessage>(
        userId,
        `UPDATE assistant_pending_messages
         SET status = 'resolved',
             resolution = $2,
             resolved_payload = $3,
             resolved_at = now()
         WHERE id = $1 AND status IN ('pending', 'delivered')
         RETURNING ${MESSAGE_COLUMNS}`,
        [messageId, decision, editedPayload ? JSON.stringify(editedPayload) : null],
      )
      return result.rows[0] ?? null
    },

    async markDelivered(messageId) {
      await query(
        `UPDATE assistant_pending_messages
         SET status = 'delivered', delivered_at = now()
         WHERE id = $1 AND status = 'pending'`,
        [messageId],
      )
    },

    async getPendingForDelivery(userId, assistantId) {
      // System-level query (no RLS) — called from chat route delivery hook.
      // ask_confirmation: re-inject on every message until resolved (atomic approval required).
      // async_response: inject once (pending only), then mark delivered.
      const result = await query<PendingMessage>(
        `SELECT ${MESSAGE_COLUMNS_WITH_SOURCE}
         FROM assistant_pending_messages apm
         JOIN assistants sa ON sa.id = apm.source_assistant_id
         JOIN users su ON su.id = sa.owner_user_id
         WHERE apm.target_user_id = $1
           AND apm.target_assistant_id = $2
           AND (
             (apm.message_type = 'ask_confirmation' AND apm.status IN ('pending', 'delivered'))
             OR (apm.message_type = 'async_response' AND apm.status = 'pending')
           )
         ORDER BY apm.created_at ASC`,
        [userId, assistantId],
      )
      return result.rows
    },
  }
}
