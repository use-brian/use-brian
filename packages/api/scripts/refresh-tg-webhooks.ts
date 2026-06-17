/**
 * One-shot: re-register every BYO Telegram webhook.
 *
 * Doubles as the channel-integrations-split cutover step — it re-points each
 * webhook at the new `/webhook/telegram/:channelId` URL scheme (migration 158;
 * see docs/plans/channel-integrations-split.md) and refreshes the
 * `allowed_updates` set (now includes `my_chat_member`) at the same time.
 *
 * Context: packages/channels/src/telegram/api.ts → setWebhook() now asks
 * Telegram to send membership-change updates in addition to messages and
 * callback queries. Telegram only honors whatever `allowed_updates` value
 * was last sent, so existing BYO integrations keep the old narrow set
 * until this script runs.
 *
 * Run locally via Cloud SQL Proxy — same pattern as scripts/migrate.ts:
 *
 *   cloud-sql-proxy internal-process-490404:asia-east1:sidanclaw-db --port 5433 &
 *   RAW_URL=$(gcloud secrets versions access latest --secret=DATABASE_URL \
 *     --project=internal-process-490404)
 *   LOCAL_URL=$(echo "$RAW_URL" | sed -E \
 *     's|@/sidanclaw\?host=/cloudsql/[^&]+|@127.0.0.1:5433/sidanclaw|')
 *   CHANNEL_CREDENTIAL_KEY=$(gcloud secrets versions access latest \
 *     --secret=CHANNEL_CREDENTIAL_KEY --project=internal-process-490404) \
 *   WEBHOOK_BASE_URL=https://sidanclaw-api-1011357498898.asia-east1.run.app \
 *   DATABASE_URL="$LOCAL_URL" \
 *     pnpm --filter @sidanclaw/api tsx scripts/refresh-tg-webhooks.ts
 *
 * Idempotent — running twice just re-POSTs the same setWebhook call.
 */

import dotenv from 'dotenv'
import { resolve } from 'node:path'
dotenv.config({ path: resolve(import.meta.dirname, '..', '..', '..', '.env') })

import pg from 'pg'
import {
  loadChannelCredentialKey,
  decryptCredentials,
  type TelegramCredentials,
} from '../src/db/channel-integrations.js'
import { createTelegramApi } from '@sidanclaw/channels'

const DATABASE_URL = process.env.DATABASE_URL
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}
if (!WEBHOOK_BASE_URL) {
  console.error('WEBHOOK_BASE_URL is required (e.g. https://sidanclaw-api-….run.app)')
  process.exit(1)
}

const key = loadChannelCredentialKey(process.env.CHANNEL_CREDENTIAL_KEY)

type IntegrationRow = {
  id: string
  channel_id: string
  credentials: Buffer
}

async function refresh(): Promise<void> {
  const client = new pg.Client({ connectionString: DATABASE_URL })
  await client.connect()

  try {
    const { rows } = await client.query<IntegrationRow>(
      `SELECT id, channel_id, credentials
       FROM channel_integrations
       WHERE channel_type = 'telegram' AND status = 'active'`,
    )

    console.log(`[refresh-tg-webhooks] found ${rows.length} active telegram integrations`)

    let ok = 0
    let failed = 0

    for (const row of rows) {
      const creds = decryptCredentials(row.credentials, key) as TelegramCredentials
      const api = createTelegramApi({ token: creds.bot_token })
      const webhookUrl = `${WEBHOOK_BASE_URL}/webhook/telegram/${row.channel_id}`

      try {
        await api.setWebhook(webhookUrl, creds.webhook_secret)
        ok += 1
        console.log(`  ✓ integration ${row.id} (channel ${row.channel_id})`)
      } catch (err) {
        failed += 1
        console.error(`  ✗ integration ${row.id} (channel ${row.channel_id}):`, err)
      }
    }

    console.log(`[refresh-tg-webhooks] done — ok=${ok} failed=${failed}`)
    process.exitCode = failed === 0 ? 0 : 1
  } finally {
    await client.end()
  }
}

refresh().catch((err) => {
  console.error('[refresh-tg-webhooks] fatal:', err)
  process.exit(1)
})
