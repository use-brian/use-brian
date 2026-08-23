/**
 * PostgreSQL adapter for temporary realtime thread targets.
 *
 * Tool writes/listing use queryWithRLS. The inbound lookup is a trusted
 * system read performed only after a channel route resolves the workspace and
 * assistant from its authenticated integration.
 *
 * [COMP:api/realtime-thread-target-store]
 */

import type {
  RealtimeThreadTarget,
  RealtimeThreadTargetStore,
} from '@use-brian/core'
import { query, queryWithRLS } from './client.js'

type TargetRow = {
  id: string
  workspaceId: string
  assistantId: string
  channelType: string
  conversationRef: string
  threadRef: string
  taskIds: string[]
  contextText: string | null
  expiresAt: Date
  createdByUserId: string | null
  createdAt: Date
  updatedAt: Date
}

const TARGET_COLUMNS = `
  id,
  workspace_id AS "workspaceId",
  assistant_id AS "assistantId",
  channel_type AS "channelType",
  conversation_ref AS "conversationRef",
  thread_ref AS "threadRef",
  task_ids AS "taskIds",
  context_text AS "contextText",
  expires_at AS "expiresAt",
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`

function toTarget(row: TargetRow): RealtimeThreadTarget {
  return {
    ...row,
    taskIds: row.taskIds ?? [],
    expiresAt: new Date(row.expiresAt),
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  }
}

export function createRealtimeThreadTargetStore(): RealtimeThreadTargetStore {
  return {
    async set(actingUserId, input) {
      const result = await queryWithRLS<TargetRow>(
        actingUserId,
        `INSERT INTO realtime_thread_targets (
           workspace_id, assistant_id, channel_type, conversation_ref,
           thread_ref, task_ids, context_text, expires_at, created_by_user_id
         )
         SELECT $1, $2, lower($3), $4, $5, $6::uuid[], $7, $8, $9
          WHERE EXISTS (
            SELECT 1 FROM assistants
             WHERE id = $2 AND workspace_id = $1
          )
           AND NOT EXISTS (
             SELECT 1 FROM unnest($6::uuid[]) AS bound(task_id)
              WHERE NOT EXISTS (
                SELECT 1 FROM tasks
                 WHERE id = bound.task_id AND workspace_id = $1
              )
           )
         ON CONFLICT (workspace_id, assistant_id, channel_type, conversation_ref, thread_ref)
         DO UPDATE SET
           task_ids = EXCLUDED.task_ids,
           context_text = EXCLUDED.context_text,
           expires_at = EXCLUDED.expires_at,
           created_by_user_id = EXCLUDED.created_by_user_id
         RETURNING ${TARGET_COLUMNS}`,
        [
          input.workspaceId,
          input.assistantId,
          input.channelType,
          input.conversationRef,
          input.threadRef,
          input.taskIds,
          input.contextText,
          input.expiresAt,
          input.createdByUserId,
        ],
      )
      const row = result.rows[0]
      if (!row) {
        throw new Error('The assistant or one of the bound task ids is outside this workspace. No realtime thread target was saved.')
      }
      return toTarget(row)
    },

    async list(actingUserId, input) {
      const params: unknown[] = [input.workspaceId, input.assistantId]
      const clauses = ['workspace_id = $1', 'assistant_id = $2']
      if (input.channelType) {
        params.push(input.channelType)
        clauses.push(`channel_type = $${params.length}`)
      }
      if (!input.includeExpired) clauses.push('expires_at > now()')
      const result = await queryWithRLS<TargetRow>(
        actingUserId,
        `SELECT ${TARGET_COLUMNS}
           FROM realtime_thread_targets
          WHERE ${clauses.join(' AND ')}
          ORDER BY expires_at ASC`,
        params,
      )
      return result.rows.map(toTarget)
    },

    async remove(actingUserId, input) {
      const result = await queryWithRLS<{ id: string }>(
        actingUserId,
        `DELETE FROM realtime_thread_targets
          WHERE id = $1 AND workspace_id = $2 AND assistant_id = $3
          RETURNING id`,
        [input.id, input.workspaceId, input.assistantId],
      )
      return result.rowCount === 1
    },

    async findActive(input) {
      const result = await query<TargetRow>(
        `SELECT ${TARGET_COLUMNS}
           FROM realtime_thread_targets
          WHERE workspace_id = $1
            AND assistant_id = $2
            AND channel_type = $3
            AND conversation_ref = $4
            AND thread_ref = $5
            AND expires_at > $6
          LIMIT 1`,
        [
          input.workspaceId,
          input.assistantId,
          input.channelType,
          input.conversationRef,
          input.threadRef,
          input.now ?? new Date(),
        ],
      )
      return result.rows[0] ? toTarget(result.rows[0]) : null
    },
  }
}
