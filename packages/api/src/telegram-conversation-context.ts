/** [COMP:api/telegram-conversation-context]
 * Normal topic history is independent of recorder ownership. Only an explicitly
 * bound and audience-approved group may create a new shared context room.
 */
import { parseTopicChannelId } from '@use-brian/channels'
import { query } from './db/client.js'
import { readSessionById, type Session } from './db/sessions.js'
import { findOrCreateChannelRoom, renewChannelConversationGeneration, roomInputScope } from './channel-room/room.js'
import { resolveGroupAudienceSystem } from './context-scope/delivery-authority.js'
import { hasTelegramWorkspaceConversationBinding } from './telegram-conversation-admission.js'
import { appendChannelRoomMessage } from './channel-room/messages.js'
import type { TelegramTextDelivery } from '@use-brian/channels'
import { mayReadGroupContext } from './channel-room/turn.js'
import { sessionKindSql } from './session-kind.js'

type Input = { integrationId: string; workspaceId: string; assistantId: string; conversationId: string; userId: string; expectedIdentity?: Identity }
type Identity = NonNullable<Session['providerContextIdentity']>

/** Read-only renewal for history and provider-input guards. Canonical group
 * audience/binding readers own these rules; appends additionally execute the
 * pinned database guard under the session lock. No activity timestamp changes. */
export async function assertTelegramConversationCurrent(room: Session): Promise<void> {
  if(!room.workspaceId || !room.providerContextIdentity || room.providerContextGeneration == null)throw new Error('provider_context_unavailable')
  const metadataCurrent=async()=>Boolean((await query(`SELECT s.id FROM sessions s
    JOIN channel_integrations ci ON ci.id::text=s.provider_context_identity->>'integrationId'
    JOIN channels c ON c.id=ci.channel_id JOIN assistants a ON a.id=s.assistant_id
    WHERE s.id=$1 AND s.provider_context_identity=$2::jsonb AND s.provider_context_generation=$3
      AND ${sessionKindSql.providerConversationContext('s')} AND ${sessionKindSql.activeChannelRoom('s')}
      AND ci.status='active' AND c.status='active' AND ci.channel_type='telegram' AND c.workspace_id=s.workspace_id
      AND a.workspace_id=s.workspace_id AND ci.bot_user_id=s.provider_context_identity->>'botId'
      AND ci.identity_generation=s.provider_context_generation
      AND NOT EXISTS(SELECT 1 FROM channel_recording_policies p WHERE p.workspace_id=s.workspace_id
        AND p.bot_id=ci.bot_user_id AND p.conversation_id=s.channel_id AND NOT p.enabled)`,
  [room.id,room.providerContextIdentity,room.providerContextGeneration])).rows.length)
  if(!await metadataCurrent())throw new Error('provider_context_unavailable')
  const {chatId,messageThreadId}=parseTopicChannelId(room.channelId)
  if(!await hasTelegramWorkspaceConversationBinding(room.workspaceId,chatId,room.channelId,messageThreadId))throw new Error('provider_context_unavailable')
  const audience=await resolveGroupAudienceSystem({workspaceId:room.workspaceId,assistantId:room.assistantId,userId:room.userId,
    channelType:'telegram',channelId:room.channelId})
  if(!audience.allowed || audience.source!=='binding' || !await mayReadGroupContext(audience.ceiling,{
    ...audience.ceiling,clearance:(room.effectiveClearance??'internal') as typeof audience.ceiling.clearance,
    compartments:room.contextCompartments,projectIds:room.contextProjectId?[room.contextProjectId]:[],
  }) || !await metadataCurrent())throw new Error('provider_context_unavailable')
}

export async function findTelegramConversationContext(input: Input): Promise<Session | null> {
  const metadata = (await query<Identity & { policyExists: boolean; stopped: boolean }>(
    `SELECT ci.id AS "integrationId",ci.bot_user_id AS "botId",ci.identity_generation AS generation,
      EXISTS(SELECT 1 FROM channel_recording_policies p WHERE p.workspace_id=c.workspace_id
        AND p.bot_id=ci.bot_user_id AND p.conversation_id=$4) AS "policyExists",
      EXISTS(SELECT 1 FROM channel_recording_policies p WHERE p.workspace_id=c.workspace_id
        AND p.bot_id=ci.bot_user_id AND p.conversation_id=$4 AND NOT p.enabled) AS stopped
     FROM channel_integrations ci JOIN channels c ON c.id=ci.channel_id
     JOIN assistants a ON a.id=$3 AND a.workspace_id=c.workspace_id
     WHERE ci.id=$1 AND c.workspace_id=$2 AND ci.status='active' AND c.status='active'
       AND ci.channel_type='telegram' AND ci.bot_user_id IS NOT NULL`,
    [input.integrationId,input.workspaceId,input.assistantId,input.conversationId],
  )).rows[0]
  if (input.expectedIdentity && (!metadata || metadata.integrationId !== input.expectedIdentity.integrationId
    || metadata.botId !== input.expectedIdentity.botId || Number(metadata.generation) !== input.expectedIdentity.generation)) {
    throw new Error('provider_context_unavailable')
  }
  if (!metadata || metadata.stopped) return null
  const { chatId, messageThreadId } = parseTopicChannelId(input.conversationId)
  if (!await hasTelegramWorkspaceConversationBinding(input.workspaceId,chatId,input.conversationId,messageThreadId)) return null
  const audience = await resolveGroupAudienceSystem({ workspaceId: input.workspaceId, assistantId: input.assistantId,
    userId: input.userId, channelType: 'telegram', channelId: input.conversationId })
  if (!audience.allowed || audience.source !== 'binding') return null
  const identity: Identity = { integrationId: metadata.integrationId, botId: metadata.botId, generation: Number(metadata.generation) }
  const existing = (await query<{ id: string; identity: Identity; generation: number }>(`SELECT s.id,s.provider_context_identity AS identity,s.provider_context_generation AS generation FROM sessions s
    WHERE s.workspace_id=$1 AND s.channel_type='telegram' AND s.channel_id=$2
      AND ${sessionKindSql.activeChannelRoom('s')} AND ${sessionKindSql.providerConversationContext('s')}`,
  [input.workspaceId,input.conversationId])).rows[0]
  if (!existing && metadata.policyExists) return null // Never move an existing Personal/Work recording into a room.
  // A different installation cannot retire or acquire this room by sending
  // to the same provider destination. Its own recording policy remains separate.
  if (existing && existing.identity.integrationId !== identity.integrationId) return null
  if (existing && existing.identity.botId === identity.botId && Number(existing.generation) !== identity.generation) {
    const previous=await readSessionById(existing.id)
    if(!previous)throw new Error('provider_context_unavailable')
    const renewed=await renewChannelConversationGeneration(previous,identity.generation)
    await assertTelegramConversationCurrent(renewed)
    return renewed
  }
  if (existing && existing.identity.botId !== identity.botId) {
    // Preserve old history under its original audience; a new bot never inherits it.
    await query(`UPDATE sessions s SET archived_at=coalesce(archived_at,now()) WHERE s.id=$1
      AND ${sessionKindSql.providerConversationContext('s')} AND s.provider_context_identity=$2::jsonb`, [existing.id,existing.identity])
  }
  const { room } = await findOrCreateChannelRoom({ workspaceId: input.workspaceId, channelIntegrationId: input.integrationId,
    assistantId: input.assistantId, channelType: 'telegram', channelId: input.conversationId,
    starterUserId: input.userId, providerContextIdentity: identity })
  if (!room.providerContextIdentity || room.providerContextIdentity.integrationId !== identity.integrationId
    || room.providerContextIdentity.botId !== identity.botId || Number(room.providerContextGeneration) !== identity.generation) {
    throw new Error('provider_context_unavailable')
  }
  await assertTelegramConversationCurrent(room)
  return room
}

/** Save only text confirmed visible by Telegram, once per provider receipt.
 * Failed sends and private execution/tool rounds never become shared history. */
export async function recordDeliveredTelegramConversation(delivery: TelegramTextDelivery): Promise<void> {
  if (!delivery.origin) return // An uncorrelated receipt cannot authorize retention.
  const row = (await query<{ id: string }>(`SELECT s.id FROM sessions s
    WHERE s.channel_type='telegram' AND s.channel_id=$1
      AND s.provider_context_identity->>'integrationId'=$2 AND s.provider_context_identity->>'botId'=$3 AND s.provider_context_generation=$4
      AND ${sessionKindSql.activeChannelRoom('s')} AND ${sessionKindSql.providerConversationContext('s')}`,
  [delivery.channelId,delivery.origin.integrationId,delivery.botId,delivery.origin.generation])).rows[0]
  if (!row) return
  const room = await readSessionById(row.id)
  if (!room?.workspaceId) throw new Error('provider_context_unavailable')
  await assertTelegramConversationCurrent(room)
  await appendChannelRoomMessage({ sessionId: room.id, role: 'assistant', content: [{ type: 'text', text: delivery.text }],
    channelMessageId: delivery.providerMessageId, senderAssistantId: room.assistantId,
    publishedSenderName: delivery.botUsername ?? null, scope: roomInputScope(room,room.workspaceId),
    providerContext: { identity: room.providerContextIdentity!, generation: delivery.origin.generation } })
}
