/** System-level leased window ledger for chat archive Pipeline B enrichment. */

import { createHash } from 'node:crypto'
import type pg from 'pg'
import { getPool } from './client.js'

export type ChatArchiveEnrichmentMessage = {
  id: string
  providerMessageId: string
  senderId: string
  senderDisplay: string | null
  sentAt: Date
  direction: 'inbound' | 'outbound'
  kind: 'text' | 'image' | 'voice' | 'file' | 'link'
  bodyText: string | null
  mediaRef: { filename?: string; mime?: string; size_bytes?: number } | null
}

export type ChatArchiveEnrichmentWindow = {
  id: string
  workspaceId: string
  instanceId: string
  ownerUserId: string
  source: string
  conversationId: string
  firstMessageId: string
  lastMessageId: string
  firstProviderMessageId: string
  lastProviderMessageId: string
  windowStart: Date
  windowEnd: Date
  attemptCount: number
  messages: ChatArchiveEnrichmentMessage[]
}

export type ChatArchiveEnrichmentStore = {
  claimNext(): Promise<ChatArchiveEnrichmentWindow | null>
  complete(id: string): Promise<void>
  fail(id: string, attemptCount: number, message: string): Promise<void>
}

type WindowRow = Omit<ChatArchiveEnrichmentWindow, 'source' | 'messages'>

const WINDOW_COLS = `
  id,
  workspace_id              AS "workspaceId",
  instance_id               AS "instanceId",
  owner_user_id              AS "ownerUserId",
  conversation_id           AS "conversationId",
  first_message_id           AS "firstMessageId",
  last_message_id            AS "lastMessageId",
  first_provider_message_id  AS "firstProviderMessageId",
  last_provider_message_id   AS "lastProviderMessageId",
  window_start               AS "windowStart",
  window_end                 AS "windowEnd",
  attempt_count              AS "attemptCount"
`

async function loadMessages(client: Pick<pg.ClientBase, 'query'>, windowId: string) {
  const result = await client.query<ChatArchiveEnrichmentMessage & { source: string }>(
    `SELECT m.id,
            m.provider_message_id AS "providerMessageId",
            m.sender_id AS "senderId", m.sender_display AS "senderDisplay",
            m.sent_at AS "sentAt", m.direction, m.kind,
            m.body_text AS "bodyText", m.media_ref AS "mediaRef", m.source
       FROM chat_archive_enrichment_messages em
       JOIN chat_archive_messages m ON m.id = em.message_id
      WHERE em.window_id = $1
      ORDER BY m.sent_at ASC, m.id ASC`,
    [windowId],
  )
  return result.rows
}

export function createChatArchiveEnrichmentStore(
  pool: pg.Pool = getPool(),
  windowSize = 20,
): ChatArchiveEnrichmentStore {
  return {
    async claimNext() {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `UPDATE chat_archive_enrichment_windows
              SET status = 'failed', next_attempt_at = now(), locked_until = NULL,
                  last_error = 'lease expired', updated_at = now()
            WHERE status = 'processing' AND locked_until < now()`,
        )

        const existing = await client.query<WindowRow>(
          `SELECT ${WINDOW_COLS}
             FROM chat_archive_enrichment_windows
            WHERE status IN ('pending', 'failed') AND next_attempt_at <= now()
            ORDER BY next_attempt_at ASC, created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1`,
        )
        let row = existing.rows[0]
        if (row) {
          const updated = await client.query<WindowRow>(
            `UPDATE chat_archive_enrichment_windows
                SET status = 'processing', attempt_count = attempt_count + 1,
                    locked_until = now() + interval '10 minutes', updated_at = now()
              WHERE id = $1
              RETURNING ${WINDOW_COLS}`,
            [row.id],
          )
          row = updated.rows[0]!
        } else {
          const anchorResult = await client.query<{
            workspaceId: string
            instanceId: string
            ownerUserId: string
            conversationId: string
          }>(
            `SELECT m.workspace_id AS "workspaceId", m.instance_id AS "instanceId",
                    m.owner_user_id AS "ownerUserId", m.conversation_id AS "conversationId"
               FROM chat_archive_messages m
              WHERE (m.body_text IS NOT NULL OR m.media_ref IS NOT NULL)
                AND NOT EXISTS (
                  SELECT 1 FROM chat_archive_enrichment_messages em WHERE em.message_id = m.id
                )
              ORDER BY m.sent_at ASC, m.id ASC
              FOR UPDATE OF m SKIP LOCKED
              LIMIT 1`,
          )
          const anchor = anchorResult.rows[0]
          if (!anchor) {
            await client.query('COMMIT')
            return null
          }
          const candidates = await client.query<{
            id: string
            providerMessageId: string
            sentAt: Date
          }>(
            `SELECT m.id, m.provider_message_id AS "providerMessageId", m.sent_at AS "sentAt"
               FROM chat_archive_messages m
              WHERE m.instance_id = $1 AND m.conversation_id = $2
                AND (m.body_text IS NOT NULL OR m.media_ref IS NOT NULL)
                AND NOT EXISTS (
                  SELECT 1 FROM chat_archive_enrichment_messages em WHERE em.message_id = m.id
                )
              ORDER BY m.sent_at ASC, m.id ASC
              FOR UPDATE OF m SKIP LOCKED
              LIMIT $3`,
            [anchor.instanceId, anchor.conversationId, windowSize],
          )
          if (candidates.rows.length === 0) {
            await client.query('COMMIT')
            return null
          }
          const first = candidates.rows[0]!
          const last = candidates.rows[candidates.rows.length - 1]!
          const contentHash = createHash('sha256')
            .update(candidates.rows.map((message) => message.id).join('\n'))
            .digest('hex')
          const inserted = await client.query<WindowRow>(
            `INSERT INTO chat_archive_enrichment_windows (
               workspace_id, instance_id, owner_user_id, conversation_id,
               first_message_id, last_message_id,
               first_provider_message_id, last_provider_message_id,
               window_start, window_end, message_count, content_hash,
               status, attempt_count, locked_until
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                       'processing', 1, now() + interval '10 minutes')
             RETURNING ${WINDOW_COLS}`,
            [
              anchor.workspaceId, anchor.instanceId, anchor.ownerUserId, anchor.conversationId,
              first.id, last.id, first.providerMessageId, last.providerMessageId,
              first.sentAt, last.sentAt, candidates.rows.length, contentHash,
            ],
          )
          row = inserted.rows[0]!
          for (const message of candidates.rows) {
            await client.query(
              `INSERT INTO chat_archive_enrichment_messages (message_id, window_id)
               VALUES ($1, $2) ON CONFLICT (message_id) DO NOTHING`,
              [message.id, row.id],
            )
          }
        }

        const messages = await loadMessages(client, row.id)
        await client.query('COMMIT')
        return {
          ...row,
          source: messages[0]?.source ?? 'chat',
          messages: messages.map(({ source: _source, ...message }) => message),
        }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },

    async complete(id) {
      await pool.query(
        `UPDATE chat_archive_enrichment_windows
            SET status = 'completed', locked_until = NULL, last_error = NULL,
                completed_at = now(), updated_at = now()
          WHERE id = $1`,
        [id],
      )
    },

    async fail(id, attemptCount, message) {
      const dead = attemptCount >= 5
      const backoffSeconds = Math.min(2 ** Math.max(1, attemptCount) * 15, 3600)
      await pool.query(
        `UPDATE chat_archive_enrichment_windows
            SET status = $2, locked_until = NULL, last_error = $3,
                next_attempt_at = now() + ($4 * interval '1 second'),
                updated_at = now()
          WHERE id = $1`,
        [id, dead ? 'dead' : 'failed', message.slice(0, 2000), backoffSeconds],
      )
    },
  }
}
