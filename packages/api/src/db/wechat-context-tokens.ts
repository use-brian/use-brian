/**
 * WeChat (iLink) per-contact context tokens — migration 362.
 *
 * iLink issues a `context_token` on every inbound message; every outbound
 * send to that contact must echo the latest one. The bridge is inbound-only
 * (sends happen API-side, including scheduled/proactive delivery long after
 * the inbound request), so the token is persisted per (channel, contact) and
 * overwritten on each inbound message. Internal-path store: no RLS, mirrors
 * chat_turn_locks. See docs/architecture/channels/wechat.md → "Context
 * tokens". Component tag: [COMP:api/wechat-inbound].
 */

import { query } from './client.js'

export async function upsertWechatContextToken(params: {
  channelId: string
  ilinkUserId: string
  contextToken: string
}): Promise<void> {
  await query(
    `INSERT INTO wechat_context_tokens (channel_id, ilink_user_id, context_token, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (channel_id, ilink_user_id)
     DO UPDATE SET context_token = EXCLUDED.context_token, updated_at = now()`,
    [params.channelId, params.ilinkUserId, params.contextToken],
  )
}

export async function getWechatContextToken(
  channelId: string,
  ilinkUserId: string,
): Promise<string | undefined> {
  const result = await query<{ context_token: string }>(
    `SELECT context_token FROM wechat_context_tokens
     WHERE channel_id = $1 AND ilink_user_id = $2`,
    [channelId, ilinkUserId],
  )
  return result.rows[0]?.context_token
}
