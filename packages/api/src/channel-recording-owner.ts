/** [COMP:api/channel-recording] Recover only the authenticated connector of this bot. */
import type { PoolClient } from 'pg'
import { getPool } from './db/client.js'

/** Compare-and-set preserves explicit ownership, revoked members and stopped policies. */
export async function recoverTelegramRecordingOwner(
  integrationId: string,
  db: Pick<PoolClient, 'query'> = getPool(),
): Promise<void> {
  await db.query(`UPDATE channel_integrations ci
    SET recording_owner_user_id = ci.connected_by_user_id
    FROM channels c, workspace_members wm
    WHERE ci.id=$1 AND ci.channel_id=c.id AND ci.channel_type='telegram'
      AND ci.status='active' AND c.status='active'
      AND ci.recording_owner_user_id IS NULL
      AND ci.connected_workspace_id=c.workspace_id
      AND ci.connected_bot_user_id=ci.bot_user_id
      AND wm.workspace_id=c.workspace_id AND wm.user_id=ci.connected_by_user_id`, [integrationId])
}
