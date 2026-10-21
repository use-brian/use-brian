import { query } from './db/client.js'
import { getWorkspaceRoleSystem } from './db/workspace-store.js'
import type { ChannelIntegrationConfig } from './db/channel-integrations.js'

/** Workspace ownership is independent of bot addressing and group clearance.
 * [COMP:api/telegram-conversation-admission] */
export function telegramConfiguredConversation(
  config: ChannelIntegrationConfig, chatId: string, topicId?: number,
): 'owned' | 'elsewhere' | 'unbound' {
  const scopes = config.requireMentionOverrides?.filter(scope => scope.chatId === chatId) ?? []
  if (!scopes.length) return 'unbound'
  return scopes.some(scope => scope.topicId == null || scope.topicId === topicId) ? 'owned' : 'elsewhere'
}

export async function hasTelegramWorkspaceConversationBinding(
  workspaceId: string, chatId: string, conversationId: string, topicId?: number,
  deps = { query, getWorkspaceRole: getWorkspaceRoleSystem, now: () => Date.now() },
): Promise<boolean> {
  // Credentials, seen chats and pre-existing sessions are deliberately absent.
  const result = await deps.query<{ config: ChannelIntegrationConfig; surfaces: string[] }>(
    `SELECT ci.config, COALESCE(array_agg(ca.external_surface_id)
       FILTER (WHERE ca.external_surface_id IS NOT NULL), ARRAY[]::text[]) AS surfaces
       FROM channel_integrations ci JOIN channels c ON c.id=ci.channel_id
       LEFT JOIN channel_assistants ca ON ca.channel_id=c.id
      WHERE c.workspace_id=$1 AND c.status='active' AND ci.status='active'
        AND ci.channel_type='telegram'
      GROUP BY ci.id, ci.config`, [workspaceId])
  for (const row of result.rows) {
    const config = row.config ?? {}
    const scope = telegramConfiguredConversation(config, chatId, topicId)
    if (scope === 'elsewhere') continue // A parent approval never widens topic ownership.
    if (scope === 'owned' || row.surfaces.includes(conversationId) || row.surfaces.includes(chatId)) return true
    const bindings = config.deliveryAudienceBindings?.filter(binding => binding.version === 1
      && binding.audienceType === 'group' && !binding.recipientUserId
      && (binding.channelId === chatId || binding.channelId === conversationId)) ?? []
    if (!bindings.length) continue
    let valid = true
    for (const binding of bindings) {
      if (binding.expiresAt && (!Number.isFinite(Date.parse(binding.expiresAt)) || Date.parse(binding.expiresAt) <= deps.now())) {
        valid = false; break
      }
      const role = await deps.getWorkspaceRole(binding.approvedByUserId, workspaceId)
      if (role !== 'owner' && role !== 'admin') { valid = false; break }
    }
    if (valid) return true
  }
  return false
}
