/**
 * One-shot READ-ONLY diagnostic: inspect a BYO Telegram bot's privacy mode and
 * webhook delivery state. Makes only getMe + getWebhookInfo calls — no writes,
 * no setWebhook. Never prints the bot token.
 *
 * Run via Cloud SQL Proxy (same pattern as refresh-tg-webhooks.ts):
 *   DATABASE_URL=... CHANNEL_CREDENTIAL_KEY=... \
 *     pnpm --filter @sidanclaw/api tsx scripts/diag-tg-webhook.ts <channel_id>
 */

import pg from 'pg'
import {
  loadChannelCredentialKey,
  decryptCredentials,
  type TelegramCredentials,
} from '../src/db/channel-integrations.js'

const DATABASE_URL = process.env.DATABASE_URL
const channelId = process.argv[2]
const chatId = process.argv[3] // optional: also run getChatMember in this chat
if (!DATABASE_URL) { console.error('DATABASE_URL required'); process.exit(1) }
if (!channelId) { console.error('channel_id arg required'); process.exit(1) }

const key = loadChannelCredentialKey(process.env.CHANNEL_CREDENTIAL_KEY)

async function tg(token: string, method: string, params?: Record<string, unknown>): Promise<unknown> {
  const qs = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : ''
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}${qs}`)
  return res.json()
}

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()
  try {
    const { rows } = await client.query<{ id: string; channel_id: string; bot_username: string; credentials: Buffer }>(
      `SELECT id, channel_id, bot_username, credentials FROM channel_integrations
       WHERE channel_type='telegram' AND channel_id = $1`,
      [channelId],
    )
    if (!rows.length) { console.error('no integration for channel', channelId); process.exit(1) }
    const row = rows[0]
    const creds = decryptCredentials(row.credentials, key) as TelegramCredentials
    console.log(`integration=${row.id} channel=${row.channel_id} bot=@${row.bot_username}`)

    const me = (await tg(creds.bot_token, 'getMe')) as { ok: boolean; result?: Record<string, unknown> }
    console.log('--- getMe ---')
    if (me.ok && me.result) {
      const r = me.result
      console.log(JSON.stringify({
        id: r.id,
        username: r.username,
        can_join_groups: r.can_join_groups,
        can_read_all_group_messages: r.can_read_all_group_messages,
        supports_inline_queries: r.supports_inline_queries,
      }, null, 2))
    } else {
      console.log(JSON.stringify(me))
    }

    const info = (await tg(creds.bot_token, 'getWebhookInfo')) as { ok: boolean; result?: Record<string, unknown> }
    console.log('--- getWebhookInfo ---')
    if (info.ok && info.result) {
      const r = info.result
      console.log(JSON.stringify({
        url: r.url,
        has_custom_certificate: r.has_custom_certificate,
        pending_update_count: r.pending_update_count,
        ip_address: r.ip_address,
        last_error_date: r.last_error_date
          ? new Date((r.last_error_date as number) * 1000).toISOString()
          : null,
        last_error_message: r.last_error_message ?? null,
        last_synchronization_error_date: r.last_synchronization_error_date
          ? new Date((r.last_synchronization_error_date as number) * 1000).toISOString()
          : null,
        max_connections: r.max_connections,
        allowed_updates: r.allowed_updates,
      }, null, 2))
    } else {
      console.log(JSON.stringify(info))
    }

    if (chatId) {
      const cm = (await tg(creds.bot_token, 'getChatMember', { chat_id: chatId, user_id: String(me.result?.id) })) as { ok: boolean; result?: Record<string, unknown> }
      console.log('--- getChatMember (self) ---')
      if (cm.ok && cm.result) {
        const r = cm.result
        console.log(JSON.stringify({
          status: r.status,
          can_read_all_messages: r.can_read_all_messages, // present for admins
          can_manage_chat: r.can_manage_chat,
          is_member: r.is_member,
        }, null, 2))
      } else {
        console.log(JSON.stringify(cm))
      }
    }
  } finally {
    await client.end()
  }
}

main().catch((err) => { console.error('fatal:', err); process.exit(1) })
