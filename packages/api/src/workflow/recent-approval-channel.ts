/**
 * Resolve approval notifications from inbound history, never outgoing activity.
 * Spec: docs/workflow/recent-approval-channel.md
 * [COMP:workflow/recent-approval-channel]
 */
import { parseTopicChannelId } from '@use-brian/channels'
import type { DeliverToChannel } from '@use-brian/core'
import { query } from '../db/client.js'
import { providerChannelIdFromSession, SLACK_THREAD_SESSION_DELIMITER } from '../db/sessions.js'
import { PROACTIVE_DELIVERY_TRANSPORTS, sessionKindSql } from '../session-kind.js'

export type RecentApprovalTarget = Pick<Parameters<DeliverToChannel>[0],
  'channelId' | 'channelIntegrationId' | 'threadRef'> & {
  channelType: (typeof PROACTIVE_DELIVERY_TRANSPORTS)[number]
}
export type RecentApprovalResolver = (scope: {
  workspaceId: string
  assistantId: string
  approverUserId: string
}) => Promise<RecentApprovalTarget | null>

/** Only inbound human messages count. Session activity also includes outbound pushes. */
export const resolveRecentApprovalChannel: RecentApprovalResolver = async (scope) => {
  const result = await query<RecentApprovalTarget & { messageId: string | null }>(
    `SELECT s.channel_type AS "channelType", s.channel_id AS "channelId",
            m.channel_message_id AS "messageId"
     FROM session_messages m
     JOIN sessions s ON s.id = m.session_id
     JOIN assistants a ON a.id = s.assistant_id
     WHERE a.workspace_id = $1 AND s.assistant_id = $2 AND s.user_id = $3
       AND m.role = 'user' AND (m.sender_user_id IS NULL OR m.sender_user_id = $3)
       AND ${sessionKindSql.proactiveDeliveryTransport('s')}
       AND s.channel_id <> ''
     ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
    [scope.workspaceId, scope.assistantId, scope.approverUserId],
  )
  const target = result.rows[0]
  // WhatsApp delivery currently uses the system connector, not the pinned account.
  // Do not search older history or risk sending through a different account.
  if (!target || target.channelType === 'whatsapp') return null
  const channelId = providerChannelIdFromSession(target.channelType, target.channelId)
  const threadRef = target.channelType === 'slack' && channelId !== target.channelId
    ? target.channelId.slice(channelId.length + SLACK_THREAD_SESSION_DELIMITER.length)
    : target.channelType === 'feishu' ? target.messageId ?? undefined : undefined
  const parentId = target.channelType === 'telegram' ? parseTopicChannelId(channelId).chatId : channelId
  // Pin the owning integration so BYO Telegram can never fall back to the official bot.
  // Prefer an observed chat; ambiguous bindings are not safe notification destinations.
  // Match the credential resolver's winning binding across ALL assistants.
  // Retain inactive integrations: the adapter will reject them without switching bots.
  const integrations = await query<{ id: string; observed: boolean }>(
    `SELECT DISTINCT ci.id,
       EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(ci.config->'seenChats', '[]'::jsonb)) chat
               WHERE chat->>'chatId' IN ($4, $5)) AS observed
     FROM channel_integrations ci
     JOIN channels c ON c.id = ci.channel_id
     JOIN channel_assistants ca ON ca.channel_id = ci.channel_id
     WHERE c.workspace_id = $1 AND ca.assistant_id = $2 AND ci.channel_type = $3
       AND ca.id = (
         SELECT winning.id
         FROM channel_assistants winning
         WHERE winning.channel_id = ci.channel_id
           AND (winning.external_surface_id IS NULL
                OR winning.external_surface_id = $4
                OR winning.external_surface_id = $5)
         ORDER BY CASE
           WHEN winning.external_surface_id = $4 THEN 0
           WHEN winning.external_surface_id = $5 THEN 1
           ELSE 2
         END
         LIMIT 1
       )
     ORDER BY observed DESC, ci.id`,
    [scope.workspaceId, scope.assistantId, target.channelType, channelId, parentId],
  )
  const candidates = integrations.rows.some((r) => r.observed)
    ? integrations.rows.filter((r) => r.observed) : integrations.rows
  // No binding is not evidence of official-bot provenance (e.g. deleted BYO).
  if (candidates.length !== 1) return null
  return { channelType: target.channelType, channelId, threadRef, channelIntegrationId: candidates[0].id }
}
