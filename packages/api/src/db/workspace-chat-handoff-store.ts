/**
 * Atomic RLS-scoped persistence for a private-chat -> workspace-room handoff.
 *
 * [COMP:api/workspace-chat-handoff]
 */

import { randomUUID } from 'node:crypto'
import type { WorkspaceChatHandoffPort } from '@use-brian/core'
import { getAppPool } from './client.js'
import { addSessionMessage } from './sessions.js'

export const PRIVATE_CHAT_HANDOFF_HEADING = '## Shared context from a private chat'

export function createWorkspaceChatHandoffStore(): WorkspaceChatHandoffPort {
  return {
    async create(params) {
      const client = await getAppPool().connect()
      let transactionOpen = false
      try {
        await client.query('BEGIN')
        transactionOpen = true
        await client.query(
          `SET LOCAL app.current_user_id = '${params.userId.replace(/'/g, "''")}'`,
        )

        // Revalidate from trusted ToolContext. The source id is never a model
        // input, and all identity/workspace joins must agree before a room is
        // created. The app pool supplies the RLS half; the WHERE clause keeps
        // this safe in the embedded single-role fallback too.
        const source = await client.query<{ clearance: string | null }>(
          `SELECT a.clearance
             FROM sessions s
             JOIN assistants a ON a.id = s.assistant_id
             JOIN workspace_members wm
               ON wm.workspace_id = a.workspace_id
              AND wm.user_id = s.user_id
            WHERE s.id = $1
              AND s.user_id = $2
              AND s.assistant_id = $3
              AND s.channel_type = 'web'
              AND s.visibility = 'owner'
              AND a.workspace_id = $4
            FOR UPDATE OF s`,
          [
            params.sourceSessionId,
            params.userId,
            params.assistantId,
            params.workspaceId,
          ],
        )
        if (source.rows.length === 0) {
          throw new Error(
            'The current conversation can no longer be shared. Open a private web chat in this workspace and try again.',
          )
        }

        const room = await client.query<{ id: string }>(
          `INSERT INTO sessions (
             assistant_id, user_id, channel_type, channel_id, app_id,
             app_origin, visibility, workspace_id, effective_clearance,
             title, title_manually_set
           )
           VALUES ($1, $2, 'web', $3, $4, 'chat', 'workspace', $5, $6, $7, TRUE)
           RETURNING id`,
          [
            params.assistantId,
            params.userId,
            randomUUID(),
            params.appId,
            params.workspaceId,
            source.rows[0].clearance,
            params.title,
          ],
        )

        await addSessionMessage(
          {
            sessionId: room.rows[0].id,
            role: 'user',
            content: [
              {
                type: 'text',
                text: `${PRIVATE_CHAT_HANDOFF_HEADING}\n\n${params.handoff}`,
              },
            ],
            senderUserId: params.userId,
          },
          client,
        )

        await client.query('COMMIT')
        transactionOpen = false
        return { sessionId: room.rows[0].id }
      } catch (error) {
        if (transactionOpen) {
          try {
            await client.query('ROLLBACK')
          } catch {
            // Preserve the original failure. Releasing a broken client below
            // lets pg discard it if necessary.
          }
        }
        throw error
      } finally {
        client.release()
      }
    },
  }
}
