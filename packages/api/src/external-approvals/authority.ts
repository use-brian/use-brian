import type { PoolClient } from 'pg'
import { providerChannelIdFromSession } from '../db/session-channel-id.js'
import type { ExternalApprovalSource } from './contracts.js'
import { destinationThreadRef, destinationConversationSql, destinationReadSql, destinationIntegrations, externalDestinationTransports } from './destinations.js'
import { ExternalApprovalError } from './service.js'

/** Same owner transaction connection; caller sets app.current_user_id LOCAL for user admission. */
export async function assertExternalDestination(client:PoolClient,source:ExternalApprovalSource,userId?:string):Promise<void> {
  const deny=()=>new ExternalApprovalError(404,'Approval destination unavailable')
  if (source.audience!=='conversation_members' || !source.destinationSessionId || source.approverUserId!==null
    || !(externalDestinationTransports as readonly string[]).includes(source.channelType)) throw deny()
  const rows=await client.query<{channelType:string;channelId:string}>(`SELECT s.channel_type AS "channelType",s.channel_id AS "channelId"
    FROM sessions s JOIN assistants a ON a.id=s.assistant_id AND a.workspace_id=s.workspace_id
    WHERE s.id=$1 AND s.workspace_id=$2 AND s.assistant_id=$3 AND ${destinationConversationSql}
    ${userId ? `AND EXISTS(SELECT 1 FROM workspace_members wm WHERE wm.workspace_id=s.workspace_id AND wm.user_id=$4)
      AND public.assistant_placement_visible($4,a.id) AND ${destinationReadSql}`:''} FOR SHARE OF s,a`,
    userId ? [source.destinationSessionId,source.workspaceId,source.assistantId,userId] : [source.destinationSessionId,source.workspaceId,source.assistantId])
  const row=rows.rows[0]
  if (!row || row.channelType!==source.channelType) throw deny()
  const channelId=row.channelType==='web' ? source.destinationSessionId : providerChannelIdFromSession(row.channelType,row.channelId)
  if (channelId!==source.channelId || destinationThreadRef(row.channelType,row.channelId)!==(source.threadRef ?? undefined)) throw deny()
  if (userId) {
    const member=await client.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 FOR SHARE',[source.workspaceId,userId])
    if (!member.rows.length) throw deny()
  }
  if (source.channelType==='web') { if (source.channelIntegrationId || source.threadRef != null) throw deny(); return }
  if (!source.channelIntegrationId || !(await destinationIntegrations(client,source.workspaceId,source.assistantId,source.channelType,source.channelId,source.channelIntegrationId)).length) throw deny()
}
