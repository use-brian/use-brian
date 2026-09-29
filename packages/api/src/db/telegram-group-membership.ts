/**
 * System-level reads for verifying a personal Telegram group: which bots
 * Brian knows to have been in a chat, and which Telegram accounts a user has
 * linked. No RLS: the delivery check runs outside any user request.
 *
 * Spec: docs/architecture/context-engine/scoped-context.md
 *   -> "Destination-bound delivery authority" -> "Personal groups".
 * [COMP:api/personal-group-membership]
 */

import { query } from './client.js'

/**
 * Bot user ids of active Telegram integrations that have observed `chatId`
 * (`config.seenChats`). Every id is re-verified live before it is subtracted
 * from the member count, so a bot that has since left never hides a person.
 */
export async function listTelegramBotUserIdsSeenInChatSystem(chatId: string): Promise<string[]> {
  const result = await query<{ botUserId: string }>(
    `SELECT DISTINCT ci.bot_user_id AS "botUserId"
       FROM channel_integrations ci
      WHERE ci.channel_type = 'telegram'
        AND ci.status = 'active'
        AND ci.bot_user_id IS NOT NULL
        AND ci.config->'seenChats' @> jsonb_build_array(jsonb_build_object('chatId', $1::text))`,
    [chatId],
  )
  return result.rows.map((row) => row.botUserId)
}

/** Telegram user ids the user has linked (`linked_identities`). */
export async function listLinkedTelegramIdsSystem(userId: string): Promise<string[]> {
  const result = await query<{ providerId: string }>(
    `SELECT provider_id AS "providerId"
       FROM linked_identities
      WHERE user_id = $1 AND provider = 'telegram'`,
    [userId],
  )
  return result.rows.map((row) => row.providerId)
}
