import { parseTopicChannelId } from '@use-brian/channels'
import type { PoolClient } from 'pg'
import { providerChannelIdFromSession, SLACK_THREAD_SESSION_DELIMITER } from '../db/session-channel-id.js'
import { PROACTIVE_DELIVERY_TRANSPORTS, sessionKindSql } from '../session-kind.js'

export type ExternalDestination = { id:string; sessionId:string; assistantId:string; channelType:string; channelId:string; channelIntegrationId?:string; threadRef?:string; label:string }
export type DestinationInventory = { destinations:ExternalDestination[]; connections:{id:string;channelType:string;label:string;available:boolean;reason?:'no_conversation'|'unsupported_transport'}[] }
// Only advertise transports whose current approval delivery path honors the pinned installation.
export const externalDestinationTransports = ['web', ...PROACTIVE_DELIVERY_TRANSPORTS] as const
export const destinationConversationSql = `${sessionKindSql.conversationLane('s')} AND s.anchor_kind IN ('none','channel') AND s.recording_revision IS NULL`
export const destinationReadSql = `public.session_recording_read_allowed(s.id) AND public.workflow_evidence_envelope_visible(s.workspace_id,public.session_context_parent_snapshot(s.workspace_id,s.id))`

/** Decode only native thread storage formats, never provider IDs for other transports. */
export function destinationThreadRef(channelType:string, sessionChannelId:string):string|undefined {
  if (channelType !== 'slack' && channelType !== 'feishu') return undefined
  const index=sessionChannelId.indexOf(SLACK_THREAD_SESSION_DELIMITER)
  return index === -1 ? undefined : sessionChannelId.slice(index + SLACK_THREAD_SESSION_DELIMITER.length)
}

/** Metadata-only equivalent of getCredentialsForAssistantIntegrationSystem's winning route. */
export async function destinationIntegrations(client:PoolClient, workspaceId:string, assistantId:string, channelType:string, channelId:string, integrationId?:string) {
  const parsed = channelType === 'telegram' ? parseTopicChannelId(channelId) : { chatId: channelId, messageThreadId: undefined, discussionRootId: undefined }
  const parent = (parsed.messageThreadId ?? parsed.discussionRootId) == null ? channelId : parsed.chatId
  return (await client.query<{id:string;label:string|null}>(`SELECT ci.id,c.display_name AS label FROM channel_integrations ci
    JOIN channels c ON c.id=ci.channel_id JOIN channel_assistants ca ON ca.channel_id=ci.channel_id
    WHERE c.workspace_id=$1 AND ca.assistant_id=$2 AND ci.channel_type=$3
      AND ci.status='active' AND c.status='active' AND ($6::uuid IS NULL OR ci.id=$6)
      -- Same public provider discriminator as the channel settings inventory.
      -- Cloud API is not a connector-backed pinned delivery destination.
      AND ($3<>'whatsapp' OR (strpos($4,'@')>0 AND NOT
        (nullif(ci.bot_user_id,'') IS NOT NULL AND nullif(ci.team_id,'') IS NOT NULL)))
      AND ca.id=(SELECT winning.id FROM channel_assistants winning WHERE winning.channel_id=ci.channel_id
        AND (winning.external_surface_id IS NULL OR winning.external_surface_id=$4 OR winning.external_surface_id=$5)
        ORDER BY CASE WHEN winning.external_surface_id=$4 THEN 0 WHEN winning.external_surface_id=$5 THEN 1 ELSE 2 END LIMIT 1)
    FOR SHARE OF ci,c,ca`,[workspaceId,assistantId,channelType,channelId,parent,integrationId ?? null])).rows
}

/** Caller owns the transaction and has set app.current_user_id locally. No history or credential reads. */
export async function discoverExternalDestinations(client:PoolClient,workspaceId:string,assistantId:string,userId:string):Promise<DestinationInventory> {
  const allowed = await client.query(`SELECT a.id FROM assistants a JOIN workspace_members wm ON wm.workspace_id=a.workspace_id
    WHERE a.workspace_id=$1 AND a.id=$2 AND wm.user_id=$3 AND public.assistant_placement_visible($3,a.id) FOR SHARE OF a,wm`,[workspaceId,assistantId,userId])
  if (!allowed.rows.length) return {destinations:[],connections:[]}
  const sessions = (await client.query<{sessionId:string;channelType:string;channelId:string}>(`SELECT s.id AS "sessionId",s.channel_type AS "channelType",s.channel_id AS "channelId"
    FROM sessions s WHERE s.workspace_id=$1 AND s.assistant_id=$2 AND ${destinationConversationSql} AND ${destinationReadSql}
    ORDER BY s.id FOR SHARE OF s`,[workspaceId,assistantId])).rows
  const destinations:ExternalDestination[]=[]
  for (const s of sessions) {
    if (!(externalDestinationTransports as readonly string[]).includes(s.channelType)) continue
    const channelId=s.channelType==='web' ? s.sessionId : providerChannelIdFromSession(s.channelType,s.channelId)
    if (!channelId) continue
    const threadRef=destinationThreadRef(s.channelType,s.channelId)
    const integrations=s.channelType==='web' ? [undefined] : await destinationIntegrations(client,workspaceId,assistantId,s.channelType,channelId)
    for (const integration of integrations) destinations.push({id:integration ? `${s.sessionId}:${integration.id}` : s.sessionId,
      sessionId:s.sessionId,assistantId,channelType:s.channelType,channelId,...(threadRef !== undefined ? {threadRef}:{}),...(integration ? {channelIntegrationId:integration.id}:{}),label:`${s.channelType}: ${integration?.label ? `${integration.label} / ` : ''}${channelId}${threadRef !== undefined ? ` #${threadRef}` : ''} (${s.sessionId}${integration ? ` / ${integration.id}` : ''})`})
  }
  const installations=(await client.query<{id:string;channelType:string;label:string|null;supported:boolean}>(`SELECT ci.id,ci.channel_type AS "channelType",c.display_name AS label,
      (ci.channel_type<>'whatsapp' OR NOT(nullif(ci.bot_user_id,'') IS NOT NULL AND nullif(ci.team_id,'') IS NOT NULL)) AS supported
    FROM channel_integrations ci JOIN channels c ON c.id=ci.channel_id
    WHERE c.workspace_id=$1 AND ci.status='active' AND c.status='active' ORDER BY ci.id`,[workspaceId])).rows
  return {destinations,connections:installations.map(i=>{
    const available=destinations.some(d=>d.channelIntegrationId===i.id)
    const supported=i.supported && (externalDestinationTransports as readonly string[]).includes(i.channelType)
    return {id:i.id,channelType:i.channelType,label:`${i.channelType}: ${i.label ?? i.id}`,available,
      ...(!available ? {reason:supported ? 'no_conversation' as const : 'unsupported_transport' as const}:{})}
  })}
}
