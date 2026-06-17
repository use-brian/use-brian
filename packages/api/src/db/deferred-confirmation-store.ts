/**
 * Persistent storage for deferred tool confirmations from scheduled jobs.
 *
 * When a scheduled job encounters an 'ask'-policy tool, the confirmation
 * is parked in this table and delivered to the user's channel. The
 * in-memory ConfirmationResolver (in confirmation-registry.ts) handles
 * the actual Promise resolution; this store is for crash recovery,
 * channel-based lookup, and expiry tracking.
 *
 * Follows the same pattern as chat-confirmation-store.ts.
 */

import { query } from './client.js'

export type DeferredConfirmation = {
  id: string
  /** Originating scheduled job, or `null` for a workflow-callee confirmation. */
  jobId: string | null
  toolCallId: string
  toolName: string
  serverName: string
  input: Record<string, unknown>
  description: string | null
  assistantId: string
  userId: string
  channelType: string
  channelId: string
  status: string
  decision: string | null
  createdAt: Date
  expiresAt: Date
  resolvedAt: Date | null
}

export type DeferredConfirmationInsert = {
  /** Originating scheduled job, or `null` for a workflow-callee confirmation. */
  jobId: string | null
  toolCallId: string
  toolName: string
  serverName: string
  input: Record<string, unknown>
  description: string
  assistantId: string
  userId: string
  channelType: string
  channelId: string
}

export type DeferredConfirmationStore = {
  insert(data: DeferredConfirmationInsert): Promise<void>
  findByToolCallId(toolCallId: string): Promise<DeferredConfirmation | null>
  findPendingByChannel(channelType: string, channelId: string): Promise<DeferredConfirmation | null>
  markResolved(toolCallId: string, decision: string): Promise<void>
  cleanupExpired(): Promise<number>
}

export function createDeferredConfirmationStore(): DeferredConfirmationStore {
  return {
    async insert(data) {
      await query(
        `INSERT INTO deferred_confirmations
           (job_id, tool_call_id, tool_name, server_name, input, description,
            assistant_id, user_id, channel_type, channel_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          data.jobId, data.toolCallId, data.toolName, data.serverName,
          JSON.stringify(data.input), data.description,
          data.assistantId, data.userId, data.channelType, data.channelId,
        ],
      )
    },

    async findByToolCallId(toolCallId) {
      const result = await query<DeferredConfirmation>(
        `SELECT id, job_id AS "jobId", tool_call_id AS "toolCallId",
                tool_name AS "toolName", server_name AS "serverName",
                input, description, assistant_id AS "assistantId",
                user_id AS "userId", channel_type AS "channelType",
                channel_id AS "channelId", status, decision,
                created_at AS "createdAt", expires_at AS "expiresAt",
                resolved_at AS "resolvedAt"
         FROM deferred_confirmations
         WHERE tool_call_id = $1 AND expires_at > now()`,
        [toolCallId],
      )
      return result.rows[0] ?? null
    },

    async findPendingByChannel(channelType, channelId) {
      const result = await query<DeferredConfirmation>(
        `SELECT id, job_id AS "jobId", tool_call_id AS "toolCallId",
                tool_name AS "toolName", server_name AS "serverName",
                input, description, assistant_id AS "assistantId",
                user_id AS "userId", channel_type AS "channelType",
                channel_id AS "channelId", status, decision,
                created_at AS "createdAt", expires_at AS "expiresAt",
                resolved_at AS "resolvedAt"
         FROM deferred_confirmations
         WHERE channel_type = $1 AND channel_id = $2
           AND status = 'pending' AND expires_at > now()
         ORDER BY created_at ASC
         LIMIT 1`,
        [channelType, channelId],
      )
      return result.rows[0] ?? null
    },

    async markResolved(toolCallId, decision) {
      await query(
        `UPDATE deferred_confirmations
         SET status = 'resolved', decision = $2, resolved_at = now()
         WHERE tool_call_id = $1`,
        [toolCallId, decision],
      )
    },

    async cleanupExpired() {
      const result = await query(
        `DELETE FROM deferred_confirmations WHERE expires_at <= now()`,
      )
      return result.rowCount ?? 0
    },
  }
}
