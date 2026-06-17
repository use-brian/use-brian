/**
 * One-time identity-healing backfill for orphan channel-shadow users.
 *
 * Targets Tier 2 shadows — `auth_provider='channel'` users with `email IS NULL`
 * created before email resolution worked for their provider (e.g. Slack
 * pre-`users:read.email` scope grant). For each shadow:
 *
 *   1. Pick any assistant the shadow is a member of, and that assistant's
 *      bot-integration credentials.
 *   2. Re-call the provider profile API (Slack `users.info` today; future
 *      providers slot in below).
 *   3. If an email comes back:
 *        a. Existing real user with that email → mergeShadowUser
 *           ('backfill' reason). Audit row + linked_identities written.
 *        b. No real user → backfill email on the shadow row in place; the
 *           shadow becomes Tier 1 going forward.
 *   4. No email (scope still missing, deactivated user, etc.) → skip.
 *
 * Idempotent. Re-run after granting a new scope or onboarding a new
 * Slack workspace to recover orphans.
 *
 * Run against production via Cloud SQL Proxy. The dry-run default
 * prints the action plan; pass `--execute` to mutate.
 *
 *   tsx scripts/backfill-channel-shadow-identities.ts                 # dry-run, slack only
 *   tsx scripts/backfill-channel-shadow-identities.ts --execute       # do it
 *   tsx scripts/backfill-channel-shadow-identities.ts --provider=slack --execute
 *   tsx scripts/backfill-channel-shadow-identities.ts --user=<uuid>   # one shadow, for testing
 *
 * See docs/architecture/platform/identity-healing.md.
 */

import dotenv from 'dotenv'
import { resolve } from 'node:path'

dotenv.config({ path: resolve(import.meta.dirname, '..', '..', '..', '.env') })

import { query } from '../src/db/client.js'
import {
  createDbChannelIntegrationStore,
  loadChannelCredentialKey,
} from '../src/db/channel-integrations.js'
import { fetchSlackProfile } from '../src/db/channel-user-store.js'
import { findUserByEmail } from '../src/db/users.js'
import { mergeShadowUser } from '../src/db/linked-accounts.js'

type ShadowRow = {
  id: string
  authProviderId: string
  name: string | null
  createdAt: Date
}

type Counters = {
  scanned: number
  merged: number
  promoted: number
  skipped: number
  failed: number
}

const PROVIDERS_WITH_EMAIL = new Set(['slack'])

function parseArgs() {
  const args = process.argv.slice(2)
  return {
    execute: args.includes('--execute'),
    provider:
      args.find((a) => a.startsWith('--provider='))?.split('=')[1] ?? 'slack',
    userId: args.find((a) => a.startsWith('--user='))?.split('=')[1],
  }
}

async function fetchProfileFor(
  provider: string,
  providerUserId: string,
  assistantId: string,
  integrationStore: ReturnType<typeof createDbChannelIntegrationStore>,
): Promise<{ email: string | null; displayName: string | null } | null> {
  const integration = await integrationStore.getCredentialsForAssistantSystem(
    assistantId,
    provider,
  )
  if (!integration) return null

  if (provider === 'slack') {
    const creds = integration.credentials
    if (creds.kind !== 'slack') return null
    return fetchSlackProfile(providerUserId, creds.botToken)
  }

  // Telegram / WhatsApp never expose email — backfill can't help; skip.
  return null
}

async function main() {
  const { execute, provider, userId } = parseArgs()

  if (!PROVIDERS_WITH_EMAIL.has(provider)) {
    console.log(
      `Provider '${provider}' does not expose email through its API — nothing to backfill. ` +
        `Use the link-code flow instead.`,
    )
    process.exit(0)
  }

  const key = loadChannelCredentialKey(process.env.CHANNEL_CREDENTIAL_KEY)
  const integrationStore = createDbChannelIntegrationStore(key)

  const mode = execute ? 'EXECUTE' : 'DRY-RUN'
  console.log(`Channel shadow backfill — ${mode} — provider=${provider}\n`)

  const filters: string[] = [
    `auth_provider = 'channel'`,
    `email IS NULL`,
    `auth_provider_id LIKE $1 || ':%'`,
  ]
  const params: unknown[] = [provider]
  if (userId) {
    filters.push(`id = $${params.length + 1}`)
    params.push(userId)
  }
  const { rows: shadows } = await query<ShadowRow>(
    `SELECT id, auth_provider_id AS "authProviderId", name, created_at AS "createdAt"
     FROM users
     WHERE ${filters.join(' AND ')}
     ORDER BY created_at ASC`,
    params,
  )

  console.log(`Found ${shadows.length} orphan shadow(s).\n`)
  if (shadows.length === 0) return

  const counts: Counters = { scanned: 0, merged: 0, promoted: 0, skipped: 0, failed: 0 }

  for (const shadow of shadows) {
    counts.scanned++
    const prefix = `${provider}:`
    if (!shadow.authProviderId.startsWith(prefix)) {
      console.log(`  - ${shadow.id} skipped (unexpected auth_provider_id=${shadow.authProviderId})`)
      counts.skipped++
      continue
    }
    const providerUserId = shadow.authProviderId.slice(prefix.length)

    // Any assistant the shadow is a member of will have the bot token.
    const { rows: assistantRows } = await query<{ assistantId: string }>(
      `SELECT assistant_id AS "assistantId"
       FROM assistant_members
       WHERE user_id = $1
       LIMIT 1`,
      [shadow.id],
    )
    if (assistantRows.length === 0) {
      console.log(`  - ${shadow.id} (${shadow.authProviderId}): no assistant membership; skipping`)
      counts.skipped++
      continue
    }
    const assistantId = assistantRows[0].assistantId

    let profile: { email: string | null; displayName: string | null } | null
    try {
      profile = await fetchProfileFor(provider, providerUserId, assistantId, integrationStore)
    } catch (err) {
      console.error(`  - ${shadow.id}: profile fetch failed:`, (err as Error).message)
      counts.failed++
      continue
    }
    if (!profile || !profile.email) {
      console.log(`  - ${shadow.id} (${shadow.authProviderId}): no email returned; skipping (scope likely missing)`)
      counts.skipped++
      continue
    }

    const existing = await findUserByEmail(profile.email)
    if (existing && existing.id !== shadow.id) {
      if (!execute) {
        console.log(
          `  - ${shadow.id} would MERGE into ${existing.id} (email=${profile.email})`,
        )
      } else {
        try {
          const result = await mergeShadowUser(
            existing.id,
            providerUserId,
            provider,
            {
              reason: 'backfill',
              evidence: { email: profile.email, assistantId, source: 'backfill-script' },
            },
          )
          if (result.merged) {
            console.log(`  - ${shadow.id} merged into ${existing.id} (email=${profile.email})`)
          } else {
            console.log(`  - ${shadow.id} merge returned no rows (shadow may have been deleted concurrently)`)
          }
        } catch (err) {
          console.error(`  - ${shadow.id} merge FAILED:`, (err as Error).message)
          counts.failed++
          continue
        }
      }
      counts.merged++
      continue
    }

    if (!execute) {
      console.log(`  - ${shadow.id} would PROMOTE in place (email=${profile.email})`)
    } else {
      try {
        await query(
          `UPDATE users
           SET email = $2,
               name = COALESCE(NULLIF(name, ''), $3, name),
               updated_at = now()
           WHERE id = $1
             AND email IS NULL`,
          [shadow.id, profile.email, profile.displayName],
        )
        console.log(`  - ${shadow.id} promoted (email=${profile.email})`)
      } catch (err) {
        console.error(`  - ${shadow.id} promote FAILED:`, (err as Error).message)
        counts.failed++
        continue
      }
    }
    counts.promoted++
  }

  console.log(`\nSummary: scanned=${counts.scanned} merged=${counts.merged} promoted=${counts.promoted} skipped=${counts.skipped} failed=${counts.failed}`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
