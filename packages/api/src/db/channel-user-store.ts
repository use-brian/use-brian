/**
 * Channel user identity resolution store.
 *
 * Maps channel provider user IDs (Slack U12345, Telegram numeric ID) to
 * platform user records. Caches the provider API lookup so we don't call
 * Slack users.info on every message.
 *
 * Two-tier shadow user model:
 *   - Tier 1 (identified): has email → full memory consolidation, auto-promote on signup
 *   - Tier 2 (anonymous): no email → session only, no memory, auto-pruned after 30 days
 *
 * See docs/architecture/channels/channel-user-identity.md.
 * Component tag: [COMP:api/channel-user-store].
 */

import { query, getPool } from './client.js'
import { findUserByEmail, findOrCreateUser, type User } from './users.js'
import { mergeShadowUser } from './linked-accounts.js'
import { getWorkspaceRoleSystem } from './workspace-store.js'

// ── Types ──────────────────────────────────────────────────────

export type CachedChannelUser = {
  provider: string
  providerUserId: string
  email: string | null
  displayName: string | null
  userId: string
  assistantId: string
  cachedAt: Date
}

export type ResolvedChannelUser = {
  user: User
  /** true = email matched or has email → full memory. false = no email → session only. */
  isIdentified: boolean
}

export type ChannelUserStore = {
  /**
   * Look up cached resolution. Returns null on miss or expired (>24h).
   * No RLS — used by webhook handlers before user is known.
   */
  resolve(provider: string, providerUserId: string, assistantId: string): Promise<CachedChannelUser | null>

  /**
   * Cache a resolution after provider API call + user lookup/creation.
   * Upserts — re-resolving after cache expiry overwrites the old entry.
   */
  cache(entry: {
    provider: string
    providerUserId: string
    assistantId: string
    email: string | null
    displayName: string | null
    userId: string
  }): Promise<void>

  /** Invalidate all cache entries for an assistant (on integration removal). */
  invalidateForAssistant(assistantId: string): Promise<void>

  /**
   * Delete expired cache entries (older than 24h). Returns count of deleted rows.
   * Should be called periodically to prevent unbounded table growth.
   */
  sweepExpired(): Promise<number>

  /**
   * Prune anonymous shadow users (tier 2: auth_provider='channel', email IS NULL)
   * with no session activity in the last 30 days. Returns count of deleted users.
   */
  pruneAnonymousShadowUsers(): Promise<number>
}

// ── Column aliases ────────────────────────────────────────────

const CUC_COLS = `
  provider,
  provider_user_id as "providerUserId",
  email,
  display_name as "displayName",
  user_id as "userId",
  assistant_id as "assistantId",
  cached_at as "cachedAt"
`

// ── Factory ───────────────────────────────────────────────────

export function createDbChannelUserStore(): ChannelUserStore {
  return {
    async resolve(provider, providerUserId, assistantId) {
      const result = await query<CachedChannelUser>(
        `SELECT ${CUC_COLS}
         FROM channel_user_cache
         WHERE provider = $1 AND provider_user_id = $2 AND assistant_id = $3
           AND cached_at > now() - INTERVAL '24 hours'
         LIMIT 1`,
        [provider, providerUserId, assistantId],
      )
      return result.rows[0] ?? null
    },

    async cache(entry) {
      await query(
        `INSERT INTO channel_user_cache (provider, provider_user_id, assistant_id, email, display_name, user_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (provider, provider_user_id, assistant_id)
         DO UPDATE SET
           email = EXCLUDED.email,
           display_name = EXCLUDED.display_name,
           user_id = EXCLUDED.user_id,
           cached_at = now()`,
        [entry.provider, entry.providerUserId, entry.assistantId, entry.email, entry.displayName, entry.userId],
      )
    },

    async invalidateForAssistant(assistantId) {
      await query(
        `DELETE FROM channel_user_cache WHERE assistant_id = $1`,
        [assistantId],
      )
    },

    async sweepExpired() {
      const result = await query(
        `DELETE FROM channel_user_cache WHERE cached_at <= now() - INTERVAL '24 hours'`,
      )
      return result.rowCount ?? 0
    },

    async pruneAnonymousShadowUsers() {
      // A Tier 2 shadow always owns a vestigial personal workspace + primary
      // assistant from §9 collapse in findOrCreateUser. The workspace FK
      // cascades on user delete, but assistants.owner_user_id is RESTRICT
      // (migration 007 — to protect shared/team assistants from cascading
      // away when a member is deleted). We must delete the shadow's solo-
      // owned assistants first, then the user. Same pattern as
      // routes/account.ts (self-delete).
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')

        const candidates = await client.query<{ id: string }>(
          `SELECT id FROM users
           WHERE auth_provider = 'channel'
             AND email IS NULL
             AND id NOT IN (
               SELECT DISTINCT user_id FROM sessions
               WHERE updated_at > now() - INTERVAL '30 days'
             )`,
        )

        let deleted = 0
        for (const { id } of candidates.rows) {
          // Savepoint per user so one stuck row (e.g. an unexpected
          // RESTRICT-FK referrer) doesn't abort the whole batch.
          await client.query('SAVEPOINT prune_one')
          try {
            await client.query(
              `DELETE FROM assistants
               WHERE owner_user_id = $1
                 AND NOT EXISTS (
                   SELECT 1 FROM assistant_members
                   WHERE assistant_id = assistants.id
                     AND user_id <> $1
                 )`,
              [id],
            )
            await client.query(`DELETE FROM users WHERE id = $1`, [id])
            await client.query('RELEASE SAVEPOINT prune_one')
            deleted++
          } catch (err) {
            await client.query('ROLLBACK TO SAVEPOINT prune_one')
            console.warn(`[pruning] Skipped shadow user ${id}:`, err)
          }
        }

        await client.query('COMMIT')
        return deleted
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
  }
}

// ── Provider profile fetchers ─────────────────────────────────

type ProviderProfile = {
  email: string | null
  displayName: string | null
}

/**
 * Fetch a Slack user's profile (email + display name) via users.info.
 * Requires the `users:read.email` scope on the Slack app.
 */
export async function fetchSlackProfile(slackUserId: string, botToken: string): Promise<ProviderProfile> {
  const resp = await fetch(
    `https://slack.com/api/users.info?${new URLSearchParams({ user: slackUserId })}`,
    { headers: { Authorization: `Bearer ${botToken}` } },
  )
  const data = await resp.json() as {
    ok: boolean
    user?: {
      profile?: { email?: string; display_name?: string; real_name?: string }
      real_name?: string
    }
  }
  if (!data.ok || !data.user) {
    return { email: null, displayName: null }
  }
  return {
    email: data.user.profile?.email ?? null,
    displayName: data.user.profile?.display_name || data.user.real_name || null,
  }
}

// ── Provider profile fetchers ─────────────────────────────────

/**
 * Fetch a Telegram user's profile via getChat.
 * Telegram does NOT expose email — always returns null for email.
 * The user will be a Tier 2 (anonymous) shadow user unless linked.
 */
export async function fetchTelegramProfile(telegramUserId: string, botToken: string): Promise<ProviderProfile> {
  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${botToken}/getChat?${new URLSearchParams({ chat_id: telegramUserId })}`,
    )
    const data = await resp.json() as {
      ok: boolean
      result?: { first_name?: string; last_name?: string; username?: string }
    }
    if (!data.ok || !data.result) {
      return { email: null, displayName: null }
    }
    const parts = [data.result.first_name, data.result.last_name].filter(Boolean)
    return {
      email: null, // Telegram never exposes email
      displayName: parts.join(' ') || data.result.username || null,
    }
  } catch {
    return { email: null, displayName: null }
  }
}

// ── Resolution helper ─────────────────────────────────────────

/**
 * Resolve a channel provider user to a platform user.
 *
 * 1. Check cache (24h TTL)
 * 2. Fetch profile from provider API (email + display name)
 * 3. Match by email → existing user, or create shadow user
 * 4. Ensure assistant_members row
 * 5. Cache the resolution
 *
 * Returns { user, isIdentified } — isIdentified=false means tier 2 (no memory).
 */
export async function resolveChannelUser(
  store: ChannelUserStore,
  provider: string,
  providerUserId: string,
  assistantId: string,
  fetchProfile: () => Promise<ProviderProfile>,
): Promise<ResolvedChannelUser> {
  // 1. Check cache
  const cached = await store.resolve(provider, providerUserId, assistantId)
  if (cached) {
    // Fetch the user from DB — they may have been promoted since caching
    const result = await query<User>(
      `SELECT id, email, name, avatar_url as "avatarUrl",
              auth_provider as "authProvider", auth_provider_id as "authProviderId",
              stripe_customer_id as "stripeCustomerId",
              timezone, created_at as "createdAt"
       FROM users WHERE id = $1`,
      [cached.userId],
    )
    if (result.rows[0]) {
      return { user: result.rows[0], isIdentified: cached.email !== null }
    }
    // User was deleted — fall through to re-resolve
  }

  // 2. Fetch profile from provider
  const profile = await fetchProfile()

  // 3. Match by email or create shadow user
  let user: User
  let isIdentified = false

  if (profile.email) {
    const existing = await findUserByEmail(profile.email)
    if (existing) {
      // Email discovery healing: an orphan shadow for this provider user
      // may pre-exist (e.g. created before the email scope was granted, or
      // before the user signed up via Google with the same address). Fold
      // its sessions/memories/souls into the real user before we route
      // future turns there. mergeShadowUser is a no-op when no shadow
      // exists, so this is safe on the happy path too.
      try {
        await mergeShadowUser(existing.id, providerUserId, provider, {
          reason: 'email-discovery',
          evidence: { email: profile.email, assistantId },
        })
      } catch (err) {
        console.error(
          `[channel-user-store] email-discovery merge failed (provider=${provider} providerUserId=${providerUserId}):`,
          err,
        )
      }
      user = existing
    } else {
      // Tier 1 shadow user: has email, gets full memory
      ;({ user } = await findOrCreateUser({
        authProvider: 'channel',
        authProviderId: `${provider}:${providerUserId}`,
        email: profile.email,
        name: profile.displayName ?? undefined,
      }))
    }
    isIdentified = true
  } else {
    // Tier 2 shadow user: no email, session only, no memory.
    // Dedup: check for existing shadow under any auth_provider format
    // (old 'telegram' style or new 'channel' style) to avoid creating
    // duplicate shadows for the same provider user.
    //
    // Always mark the shadow with the provider + user ID ("slack:U12345")
    // as a fallback name — the profile API can fail (no scope, rate limit)
    // and leaving the shadow nameless renders as "Unknown" in the monitor.
    // Billing still attributes to the assistant owner, so this is just an
    // identification aid.
    const fallbackName = `${provider}:${providerUserId}`
    const existingShadow = await findExistingShadow(provider, providerUserId)
    if (existingShadow) {
      user = existingShadow
      // Normalize to the canonical 'channel' format if still on old style
      if (existingShadow.authProvider !== 'channel' || existingShadow.authProviderId !== `${provider}:${providerUserId}`) {
        await normalizeShadowAuthProvider(existingShadow.id, provider, providerUserId)
      }
      // Backfill a missing name once the profile resolves on a later hit.
      if (!existingShadow.name && profile.displayName) {
        await query(
          `UPDATE users SET name = $1, updated_at = now() WHERE id = $2 AND (name IS NULL OR name = '')`,
          [profile.displayName, existingShadow.id],
        )
        user = { ...existingShadow, name: profile.displayName }
      }
    } else {
      ;({ user } = await findOrCreateUser({
        authProvider: 'channel',
        authProviderId: `${provider}:${providerUserId}`,
        name: profile.displayName ?? fallbackName,
      }))
    }
    isIdentified = false
  }

  // 4. Ensure assistant_members row (so the user appears in the assistant's member list)
  await ensureAssistantMember(assistantId, user.id)

  // 5. Cache
  await store.cache({
    provider,
    providerUserId,
    assistantId,
    email: profile.email,
    displayName: profile.displayName,
    userId: user.id,
  })

  return { user, isIdentified }
}

/**
 * Decide whether a claimed identity link (`linked_identities`) should be
 * honoured as the sender's real identity on THIS assistant. Channel-agnostic:
 * Telegram BYO (`telegramLinkBindsHere` alias) and Slack (`resolveSlackSender`)
 * apply the identical rule.
 *
 * `linked_identities (provider, provider_id)` is globally unique, so a sender
 * linked to assistant A must not be served under their real identity on
 * assistant B (cross-tenant memory/persona leak). A link binds here when ANY of:
 *   - it routes to this exact assistant (`assistantId` match), or
 *   - the linked user is the assistant's billing-party owner, or
 *   - the linked user is a member of this assistant's workspace.
 * Membership is the same gate RLS applies downstream, so honouring the link
 * cannot widen what the sender can read. History + rationale for the third
 * branch: `routes/telegram-byo.ts` → `telegramLinkBindsHere`.
 */
export async function channelLinkBindsHere(
  linked: { userId: string; assistantId: string | null } | null | undefined,
  assistantId: string,
  ownerId: string,
  workspaceId: string | null,
  roleLookup: (
    userId: string,
    workspaceId: string,
  ) => Promise<'owner' | 'admin' | 'member' | null> = getWorkspaceRoleSystem,
): Promise<boolean> {
  if (!linked?.userId) return false
  if (linked.assistantId === assistantId || linked.userId === ownerId) return true
  if (workspaceId) {
    const role = await roleLookup(linked.userId, workspaceId)
    if (role !== null) return true
  }
  return false
}

/**
 * Ensure an `assistant_members` row for (assistant, user) — the sender shows
 * up in the assistant's member list. Idempotent. Shared by the email path
 * above and by the link-first path in the channel routes (a linked sender
 * skips `resolveChannelUser` entirely, so it must call this itself).
 * NOTE: assistant membership is NOT workspace membership — see
 * docs/architecture/channels/channel-user-identity.md → "Non-member senders".
 */
export async function ensureAssistantMember(assistantId: string, userId: string): Promise<void> {
  await query(
    `INSERT INTO assistant_members (assistant_id, user_id, role)
     VALUES ($1, $2, 'member')
     ON CONFLICT (assistant_id, user_id) DO NOTHING`,
    [assistantId, userId],
  )
}

// ── Shadow dedup helpers ─────────────────────────────────────

/** Shared SELECT column list — must match users.ts USER_COLUMNS. */
const USER_COLUMNS = `
  id, email, name, handle, avatar_url as "avatarUrl",
  auth_provider as "authProvider", auth_provider_id as "authProviderId",
  stripe_customer_id as "stripeCustomerId",
  timezone, created_at as "createdAt"
` as const

/**
 * Find an existing shadow user for a provider user across all auth_provider
 * formats. Covers:
 *   - Old style: auth_provider='telegram', auth_provider_id='880211324'
 *   - New style: auth_provider='channel', auth_provider_id='telegram:880211324'
 *
 * Returns the oldest shadow (by created_at) so we consolidate onto the first one.
 */
async function findExistingShadow(provider: string, providerUserId: string): Promise<User | null> {
  const result = await query<User>(
    `SELECT ${USER_COLUMNS}
     FROM users
     WHERE (auth_provider = $1 AND auth_provider_id = $2)
        OR (auth_provider = 'channel' AND auth_provider_id = $3)
     ORDER BY created_at ASC
     LIMIT 1`,
    [provider, providerUserId, `${provider}:${providerUserId}`],
  )
  return result.rows[0] ?? null
}

/**
 * Normalize a shadow user's auth_provider to the canonical 'channel' format.
 * Also merges any duplicate shadows that exist under the other format,
 * reassigning their sessions/memories to the canonical shadow.
 */
async function normalizeShadowAuthProvider(canonicalUserId: string, provider: string, providerUserId: string): Promise<void> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')

    // Find other shadows for the same provider user (different from canonical)
    const duplicates = await client.query<{ id: string }>(
      `SELECT id FROM users
       WHERE id != $1
         AND (
           (auth_provider = $2 AND auth_provider_id = $3)
           OR (auth_provider = 'channel' AND auth_provider_id = $4)
         )`,
      [canonicalUserId, provider, providerUserId, `${provider}:${providerUserId}`],
    )

    // Merge each duplicate into the canonical shadow
    for (const dup of duplicates.rows) {
      // Reassign sessions (skip conflicts)
      await client.query(
        `UPDATE sessions SET user_id = $1
         WHERE user_id = $2
           AND NOT EXISTS (
             SELECT 1 FROM sessions s2
             WHERE s2.user_id = $1
               AND s2.assistant_id = sessions.assistant_id
               AND s2.channel_type = sessions.channel_type
               AND s2.channel_id = sessions.channel_id
               AND COALESCE(s2.app_id, '') = COALESCE(sessions.app_id, '')
           )`,
        [canonicalUserId, dup.id],
      )
      await client.query(`DELETE FROM sessions WHERE user_id = $1`, [dup.id])

      // Reassign memories (skip duplicates)
      await client.query(
        `UPDATE memories SET user_id = $1
         WHERE user_id = $2
           AND NOT EXISTS (
             SELECT 1 FROM memories m2
             WHERE m2.user_id = $1
               AND m2.assistant_id = memories.assistant_id
               AND COALESCE(m2.app_id, '') = COALESCE(memories.app_id, '')
               AND m2.summary = memories.summary
           )`,
        [canonicalUserId, dup.id],
      )
      await client.query(`DELETE FROM memories WHERE user_id = $1`, [dup.id])

      // Reassign assistant_members
      await client.query(
        `INSERT INTO assistant_members (assistant_id, user_id, role)
         SELECT assistant_id, $1, role FROM assistant_members WHERE user_id = $2
         ON CONFLICT (assistant_id, user_id) DO NOTHING`,
        [canonicalUserId, dup.id],
      )
      await client.query(`DELETE FROM assistant_members WHERE user_id = $1`, [dup.id])

      // Reassign usage/analytics. The usage/credit tables live in the CLOSED
      // overlay schema (hosted billing); the OSS edition doesn't have them, so
      // each statement is gated on to_regclass. analytics_events is open.
      if ((await client.query(`SELECT to_regclass('public.usage_tracking') AS t`)).rows[0]?.t) {
        await client.query(`UPDATE usage_tracking SET user_id = $1 WHERE user_id = $2`, [canonicalUserId, dup.id])
      }
      await client.query(`UPDATE analytics_events SET user_id = $1 WHERE user_id = $2`, [canonicalUserId, dup.id])

      // Merge daily_usage
      if ((await client.query(`SELECT to_regclass('public.daily_usage') AS t`)).rows[0]?.t) {
        await client.query(
          `INSERT INTO daily_usage (user_id, date, total_actual_cost, total_turns)
           SELECT $1, date, total_actual_cost, total_turns
           FROM daily_usage WHERE user_id = $2
           ON CONFLICT (user_id, date) DO UPDATE SET
             total_actual_cost = daily_usage.total_actual_cost + EXCLUDED.total_actual_cost,
             total_turns = daily_usage.total_turns + EXCLUDED.total_turns`,
          [canonicalUserId, dup.id],
        )
        await client.query(`DELETE FROM daily_usage WHERE user_id = $1`, [dup.id])
      }

      // Clean up caches and delete the duplicate
      await client.query(`DELETE FROM channel_user_cache WHERE user_id = $1`, [dup.id])
      if ((await client.query(`SELECT to_regclass('public.credit_balances') AS t`)).rows[0]?.t) {
        await client.query(`DELETE FROM credit_balances WHERE user_id = $1`, [dup.id])
      }
      await client.query(`DELETE FROM users WHERE id = $1`, [dup.id])
    }

    // Normalize the canonical shadow to 'channel' format
    await client.query(
      `UPDATE users SET auth_provider = 'channel', auth_provider_id = $1, updated_at = now()
       WHERE id = $2`,
      [`${provider}:${providerUserId}`, canonicalUserId],
    )

    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
