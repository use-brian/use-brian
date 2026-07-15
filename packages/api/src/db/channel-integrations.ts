/**
 * Channel integration store — per-channel BYO chat-channel credentials.
 *
 * One row per workspace `channels` install (Slack / Telegram / WhatsApp),
 * keyed by `channel_id` (migration 158, the channel-integrations split — feed
 * credentials moved out to `distribution_profiles`).
 *
 * See docs/architecture/channels/adapter-pattern.md → "Slack Credential Provisioning"
 * for the design rationale. Component tag: [COMP:api/channel-integrations-store].
 *
 * Credentials are encrypted at rest with AES-256-GCM. The key is supplied
 * at store construction time as a 32-byte Buffer, derived from the
 * CHANNEL_CREDENTIAL_KEY env var (base64). The ciphertext layout is:
 *
 *   [iv (12 bytes)] [authTag (16 bytes)] [ciphertext (variable)]
 *
 * Rotating the key is a one-shot operation: load with the old key, re-encrypt
 * with the new key, update the row. Not implemented yet — deferred until the
 * KMS migration.
 */

import {
  encryptCredentials as _encryptCredentials,
  decryptCredentials as _decryptCredentials,
} from './credential-crypto.js'
import { query, queryWithRLS } from './client.js'

// ── Types ──────────────────────────────────────────────────────

export type SlackCredentials = {
  bot_token: string
  signing_secret: string
}

export type TelegramCredentials = {
  bot_token: string
  webhook_secret: string // server-generated, for X-Telegram-Bot-Api-Secret-Token verification
}

export type WhatsAppCredentials = {
  phone_number: string  // for display only; actual auth state lives in GCS
}

/**
 * Discord BYO credentials. The bot token is the only secret — sending is
 * Discord REST (Authorization: Bot <token>) and receiving is the Gateway
 * connector, which gets the decrypted token via `/connect`. `bot_user_id` is
 * stored on the integration row (not here) for self-mention detection.
 * `public_key` is only needed for the optional HTTP Interactions transport
 * (Ed25519); the Gateway transport ignores it. See docs/architecture/channels/discord.md.
 */
export type DiscordCredentials = {
  bot_token: string
  public_key?: string  // Ed25519 application public key — Interactions transport only
}

/**
 * Threads (Meta) distribution credentials. Long-lived (60d) token from the
 * OAuth code → short-lived → long-lived exchange. Refreshed by a daily job
 * within 7 days of expiry. `platform_user_id` + `platform_handle` are
 * denormalized here for display + identity resolution without hitting the
 * Graph API on every load.
 * See docs/architecture/feed/threads.md.
 */
export type ThreadsCredentials = {
  access_token: string
  expires_at: string          // ISO-8601
  platform_user_id: string
  platform_handle: string
}

/**
 * X (Twitter) distribution credentials. OAuth 2.0 PKCE exchange returns a
 * short-lived (2h) access token + rotating refresh token. The refresh job
 * (`twitter-token-refresh.ts`) runs on a 5-min cadence and refreshes any
 * token within 10 min of expiry. A successful refresh invalidates the old
 * refresh_token — persist the new pair atomically.
 * See docs/architecture/feed/twitter.md.
 */
export type TwitterCredentials = {
  access_token: string
  refresh_token: string
  expires_at: string          // ISO-8601 — ~2h from issuance
  platform_user_id: string    // X numeric user id
  platform_handle: string     // @handle (no leading @)
  scope: string               // space-separated list of granted scopes
}

/**
 * Assistant-inbox (AgentMail) credentials. `inbox_id` IS the inbox's email
 * address. `api_key` is the inbox-scoped key minted at provisioning when the
 * vendor returns one — absent, the provider falls back to the org/BYO key
 * from env. `webhook_secret` is the per-webhook Svix signing secret returned
 * at registration; verification tries it first, then the env-level secret.
 * See docs/architecture/integrations/agentmail.md.
 */
export type EmailCredentials = {
  inbox_id: string
  api_key?: string
  webhook_secret?: string
}

/** Credential maps for every BYO channel we support. */
export type ChannelCredentials =
  | SlackCredentials
  | TelegramCredentials
  | WhatsAppCredentials
  | DiscordCredentials
  | ThreadsCredentials
  | TwitterCredentials
  | EmailCredentials

/**
 * Access control mode for who can interact with the bot.
 * `group_members` is WhatsApp-only — answer only people who share a group with
 * the connected number (DMs from strangers are dropped); `allowedUserIds` then
 * holds phone numbers. `blocklist` is Slack/Telegram/Discord-only.
 */
export type UserAccessMode = 'allow_all' | 'allowlist' | 'blocklist' | 'group_members'

/**
 * One entry in `requireMentionOverrides`. Presence in the list flips the
 * integration-level `requireMention` default for that chat (or chat+topic
 * when `topicId` is set). If global is `true`, listed entries behave as if
 * `requireMention = false`, and vice versa. See
 * docs/architecture/channels/channel-user-identity.md → "BYO Telegram
 * group mention overrides".
 */
export type RequireMentionOverride = {
  chatId: string
  /** Forum topic id. `null`/omitted = whole chat. */
  topicId?: number | null
}

/**
 * A chat the bot has been observed in. Populated opportunistically by the
 * BYO route from inbound messages and `my_chat_member` events, so the
 * settings UI can render human-readable group/topic names instead of raw IDs.
 * Topic names come from `forum_topic_created` / `forum_topic_edited` service
 * messages — topics that existed before the bot joined appear here with
 * only an id until the owner edits the topic once.
 */
export type SeenChat = {
  chatId: string
  chatTitle: string | null
  isForum: boolean
  topics: Array<{ topicId: number; name: string | null; lastSeenAt: string }>
  lastSeenAt: string
}

/**
 * Per-integration behavior settings stored in the `config` JSONB column.
 * Shared across Slack and Telegram BYO integrations. Not all fields apply
 * to every channel — `replyInThread` is Slack-only (Telegram has no threads).
 */
export type ChannelIntegrationConfig = {
  replyInThread?: boolean      // default: false — reply at channel level (Slack only)
  ackReaction?: string         // default: '' — no reaction. e.g. 'eyes', 'brain', '👀'
  requireMention?: boolean     // default: true — only respond when @mentioned in groups
  /**
   * Per-chat / per-topic overrides that flip the `requireMention` default.
   * Telegram BYO only. See RequireMentionOverride type.
   */
  requireMentionOverrides?: RequireMentionOverride[]
  /**
   * Opportunistically populated inventory of chats the bot has seen. Feeds
   * the settings UI's override selector. Telegram BYO only.
   */
  seenChats?: SeenChat[]
  userAccessMode?: UserAccessMode // default: 'allow_all'
  allowedUserIds?: string[]    // used when userAccessMode = 'allowlist' — @handle or numeric ID
  blockedUserIds?: string[]    // used when userAccessMode = 'blocklist' — @handle or numeric ID
  /**
   * WhatsApp BYON bot only — group chat JIDs the bot is allowed to reply in
   * (the per-group reply opt-in, consulted only when the bot's send scope is
   * `dm_and_groups`). The WhatsApp analogue of Telegram's per-chat overrides.
   */
  whatsappGroupOptIn?: string[]
}

/** @deprecated Use ChannelIntegrationConfig — kept for backwards compatibility. */
export type SlackIntegrationConfig = ChannelIntegrationConfig

export type ChannelIntegration = {
  id: string
  /** Owning workspace channel (FK → channels, migration 158). */
  channelId: string
  channelType: string
  teamId: string | null
  teamName: string | null
  botUserId: string | null
  // Telegram bot @handle (no leading @). Needed for group @mention
  // detection in the BYO webhook path. Null on legacy rows until the
  // webhook self-heals via getMe. Slack/WhatsApp leave this null.
  botUsername: string | null
  config: ChannelIntegrationConfig
  status: 'active' | 'revoked' | 'invalid'
  createdAt: Date
  updatedAt: Date
  lastEventAt: Date | null
  /**
   * Paired connector_instance row for sources whose ingest engine hangs
   * off `connector_instance` (Slack today — migration 182). NULL for
   * channels that don't use the ingest substrate (Telegram, WhatsApp).
   */
  connectorInstanceId: string | null
}

/**
 * An integration with its credentials decrypted. Separate type from
 * ChannelIntegration so a stray `JSON.stringify(integration)` can't
 * accidentally leak the bot token — you have to explicitly ask for the
 * decrypted form via `getWithCredentials()`.
 */
export type ChannelIntegrationWithCredentials = ChannelIntegration & {
  credentials: ChannelCredentials
}

// ── Crypto ─────────────────────────────────────────────────────


/**
 * Decode the base64 CHANNEL_CREDENTIAL_KEY env var into a 32-byte Buffer.
 * Throws with a clear message if the key is missing or wrong length.
 */
export function loadChannelCredentialKey(base64Key: string | undefined): Buffer {
  if (!base64Key) {
    throw new Error(
      'CHANNEL_CREDENTIAL_KEY is required to manage channel_integrations. ' +
      'Generate one with: openssl rand -base64 32',
    )
  }
  const key = Buffer.from(base64Key, 'base64')
  if (key.length !== 32) {
    throw new Error(
      `CHANNEL_CREDENTIAL_KEY must decode to exactly 32 bytes (got ${key.length}). ` +
      'Generate with: openssl rand -base64 32',
    )
  }
  return key
}

// Thin ChannelCredentials-typed wrappers over the OPEN generic crypto in
// ./credential-crypto.ts (so this file's API + its closed importers are
// unchanged, while the open connector stores import the generic directly).
export function encryptCredentials(credentials: ChannelCredentials, key: Buffer): Buffer {
  return _encryptCredentials(credentials, key)
}

export function decryptCredentials(blob: Buffer, key: Buffer): ChannelCredentials {
  return _decryptCredentials<ChannelCredentials>(blob, key)
}

// ── Store ──────────────────────────────────────────────────────

export type ChannelIntegrationStore = {
  /**
   * Create or update an integration row. Uses `channel_id` as the conflict
   * target — one integration per channel (migration 158) — so re-installing
   * the same channel refreshes the credentials instead of creating a duplicate.
   */
  upsert(params: {
    channelId: string
    channelType: string
    teamId: string | null
    teamName: string | null
    botUserId: string | null
    botUsername: string | null
    credentials: ChannelCredentials
    actingUserId: string
  }): Promise<ChannelIntegration>

  /**
   * Persist a bot_username on an existing row. Webhook self-heal path:
   * legacy integrations predate the column, so the BYO handler calls
   * getMe once and backfills. No RLS — runs pre-auth on the webhook.
   */
  setBotUsername(id: string, botUsername: string): Promise<void>

  /**
   * Fetch an integration by `channel_id` + channel type. Webhook hot path:
   * skips RLS because webhook requests arrive before the user is known.
   * Returns decrypted credentials.
   *
   * `channel_id` is the only key — migration 158 dropped the legacy
   * `assistant_id` column. Webhook routes registered with a legacy
   * `/webhook/<type>/<assistantId>` URL fall back via
   * `getCredentialsForAssistantSystem` (which joins through
   * `channel_assistants`); see the telegram-byo route handler for the
   * two-step lookup + self-heal pattern.
   */
  getByChannelForWebhook(
    channelId: string,
    channelType: string,
  ): Promise<ChannelIntegrationWithCredentials | null>

  /**
   * Fetch the integration credentials for an assistant's channel of a given
   * type — the outbound-delivery path. Resolves assistant → channel via
   * `channel_assistants`; if the assistant routes on several channels of the
   * type, the default-routing (`external_surface_id IS NULL`) one wins.
   * System-level (no RLS) — outbound delivery runs in workers / background
   * flows with no session user.
   */
  getCredentialsForAssistantSystem(
    assistantId: string,
    channelType: string,
  ): Promise<ChannelIntegrationWithCredentials | null>

  /**
   * Lookup by bot username. Used by the Mini App verify route to resolve
   * which BYO bot's token should verify an `initData` HMAC when the
   * request originated from a `/connect` button on a BYO bot. System-level
   * (no RLS) — the request is pre-auth and only the returned token is
   * used to verify a signature, never exposed.
   */
  getByBotUsernameSystem(
    botUsername: string,
    channelType: string,
  ): Promise<ChannelIntegrationWithCredentials | null>

  /**
   * RLS-gated fetch of a single integration row with decrypted credentials.
   * For owner-initiated tooling (e.g. the Telegram refresh endpoint that
   * re-runs getMe and updates bot_username). Returns null if the row doesn't
   * exist OR the acting user isn't authorized — callers cannot distinguish,
   * which is the desired behavior for RLS.
   */
  getForUserWithCredentials(
    actingUserId: string,
    id: string,
  ): Promise<ChannelIntegrationWithCredentials | null>

  /** List integrations for a workspace's channels, RLS-gated via `channels`. */
  listForWorkspace(
    actingUserId: string,
    workspaceId: string,
  ): Promise<ChannelIntegration[]>

  /** Delete an integration. RLS-gated. */
  deleteForUser(actingUserId: string, id: string): Promise<boolean>

  /** Update the config JSONB column. RLS-gated. */
  updateConfig(params: {
    actingUserId: string
    id: string
    config: ChannelIntegrationConfig
  }): Promise<ChannelIntegration>

  /**
   * System-level config merge (no RLS). Used by the BYO webhook to persist
   * opportunistic observations (`seenChats`) without user context. Atomically
   * reads the current row, applies `mutate`, and writes it back.
   *
   * Only keys the mutator touches are committed — other concurrent writers
   * (e.g. owner flipping `requireMention` in the UI) aren't clobbered provided
   * they touch different keys. For concurrent writes to the *same* key,
   * last-write-wins; the UI path runs rarely enough that this is acceptable.
   */
  mergeConfigSystem(
    id: string,
    mutate: (current: ChannelIntegrationConfig) => ChannelIntegrationConfig,
  ): Promise<void>

  /** Update last_event_at. Webhook path — no RLS. */
  touchLastEventAt(id: string): Promise<void>

  /**
   * System-level status flip by `channel_id` (no RLS). The wa-connector calls
   * `/internal/whatsapp/disconnected` when WhatsApp logs the linked device out
   * (status 401); the route flips the integration to `'revoked'` so the status
   * endpoint reports it disconnected and the UI prompts a reconnect. A later
   * reconnect re-activates it via `upsert` (which sets `status = 'active'`).
   * Returns whether a row matched. Pre-auth: the connector has no session user.
   */
  setStatusByChannelSystem(
    channelId: string,
    channelType: string,
    status: 'active' | 'revoked' | 'invalid',
  ): Promise<boolean>

  /**
   * List every active integration of a channel type whose owning channel is
   * also active, with decrypted credentials + bot user id. System-level
   * (no RLS) — the Discord Gateway connector calls this via
   * `GET /internal/discord/channels` on boot to reconnect every live bot.
   */
  listActiveWithCredentialsSystem(
    channelType: string,
  ): Promise<Array<{ channelId: string; botUserId: string | null; credentials: ChannelCredentials }>>
}

// Columns that are safe to expose (no credentials blob).
const CI_PUBLIC_COLS = `
  id, channel_id as "channelId",
  channel_type as "channelType",
  team_id as "teamId", team_name as "teamName", bot_user_id as "botUserId",
  bot_username as "botUsername",
  config, status, created_at as "createdAt", updated_at as "updatedAt",
  last_event_at as "lastEventAt",
  connector_instance_id as "connectorInstanceId"
`

type CiRow = {
  id: string
  channelId: string
  channelType: string
  teamId: string | null
  teamName: string | null
  botUserId: string | null
  botUsername: string | null
  config: ChannelIntegrationConfig
  status: 'active' | 'revoked' | 'invalid'
  createdAt: Date
  updatedAt: Date
  lastEventAt: Date | null
  connectorInstanceId: string | null
}

export function createDbChannelIntegrationStore(key: Buffer): ChannelIntegrationStore {
  return {
    async upsert(params) {
      const encrypted = encryptCredentials(params.credentials, key)
      // Scoped by the acting user so RLS enforces channel (workspace) access.
      const result = await queryWithRLS<CiRow>(
        params.actingUserId,
        `INSERT INTO channel_integrations
           (channel_id, channel_type, team_id, team_name, bot_user_id, bot_username, credentials, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
         ON CONFLICT (channel_id)
         DO UPDATE SET
           channel_type = EXCLUDED.channel_type,
           team_id      = EXCLUDED.team_id,
           team_name    = EXCLUDED.team_name,
           bot_user_id  = EXCLUDED.bot_user_id,
           bot_username = EXCLUDED.bot_username,
           credentials  = EXCLUDED.credentials,
           status       = 'active',
           updated_at   = now()
         RETURNING ${CI_PUBLIC_COLS}`,
        [
          params.channelId,
          params.channelType,
          params.teamId,
          params.teamName,
          params.botUserId,
          params.botUsername,
          encrypted,
        ],
      )
      // Invalidate channel_user_cache for every assistant routed via this
      // channel. Re-OAuth often changes the granted scope set (e.g. adding
      // users:read.email to Slack); without this, identity resolution keeps
      // serving stale Tier 2 shadow results for up to 24h, defeating the
      // healing path. See docs/architecture/platform/identity-healing.md.
      await query(
        `DELETE FROM channel_user_cache
         WHERE assistant_id IN (
           SELECT assistant_id FROM channel_assistants WHERE channel_id = $1
         )`,
        [params.channelId],
      )
      return result.rows[0]
    },

    async setBotUsername(id, botUsername) {
      await query(
        `UPDATE channel_integrations SET bot_username = $2 WHERE id = $1`,
        [id, botUsername],
      )
    },

    async getByChannelForWebhook(channelId, channelType) {
      // `channel_id`-only lookup — migration 158 dropped the legacy
      // `assistant_id` column. A previous version of this query also matched
      // `OR assistant_id = $1` to self-heal pre-split webhook URLs
      // (`/webhook/<type>/<assistantId>`); after the drop that query failed
      // to even parse and every inbound webhook 500'd. Legacy URLs are now
      // resolved one layer up by the route handler, which falls back to
      // `getCredentialsForAssistantSystem` (joins via `channel_assistants`)
      // and re-issues `setWebhook` with the canonical channel-id URL.
      const result = await query<CiRow & { credentials: Buffer }>(
        `SELECT ${CI_PUBLIC_COLS}, credentials
         FROM channel_integrations
         WHERE channel_id = $1
           AND channel_type = $2
           AND status = 'active'
         LIMIT 1`,
        [channelId, channelType],
      )
      if (result.rows.length === 0) return null
      const row = result.rows[0]
      const credentials = decryptCredentials(row.credentials, key)
      return {
        id: row.id,
        channelId: row.channelId,
        channelType: row.channelType,
        teamId: row.teamId,
        teamName: row.teamName,
        botUserId: row.botUserId,
        botUsername: row.botUsername,
        config: row.config ?? {},
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        lastEventAt: row.lastEventAt,
        connectorInstanceId: row.connectorInstanceId,
        credentials,
      }
    },

    async getCredentialsForAssistantSystem(assistantId, channelType) {
      const result = await query<CiRow & { credentials: Buffer }>(
        `SELECT ${CI_PUBLIC_COLS}, credentials
         FROM channel_integrations
         WHERE id = (
           SELECT ci.id FROM channel_integrations ci
           JOIN channel_assistants ca ON ca.channel_id = ci.channel_id
           WHERE ca.assistant_id = $1 AND ci.channel_type = $2 AND ci.status = 'active'
           ORDER BY ca.external_surface_id NULLS FIRST
           LIMIT 1
         )`,
        [assistantId, channelType],
      )
      if (result.rows.length === 0) return null
      const row = result.rows[0]
      const credentials = decryptCredentials(row.credentials, key)
      return {
        id: row.id,
        channelId: row.channelId,
        channelType: row.channelType,
        teamId: row.teamId,
        teamName: row.teamName,
        botUserId: row.botUserId,
        botUsername: row.botUsername,
        config: row.config ?? {},
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        lastEventAt: row.lastEventAt,
        connectorInstanceId: row.connectorInstanceId,
        credentials,
      }
    },

    async getByBotUsernameSystem(botUsername, channelType) {
      const result = await query<CiRow & { credentials: Buffer }>(
        `SELECT ${CI_PUBLIC_COLS}, credentials
         FROM channel_integrations
         WHERE bot_username = $1 AND channel_type = $2 AND status = 'active'
         LIMIT 1`,
        [botUsername, channelType],
      )
      if (result.rows.length === 0) return null
      const row = result.rows[0]
      const credentials = decryptCredentials(row.credentials, key)
      return {
        id: row.id,
        channelId: row.channelId,
        channelType: row.channelType,
        teamId: row.teamId,
        teamName: row.teamName,
        botUserId: row.botUserId,
        botUsername: row.botUsername,
        config: row.config ?? {},
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        lastEventAt: row.lastEventAt,
        connectorInstanceId: row.connectorInstanceId,
        credentials,
      }
    },

    async getForUserWithCredentials(actingUserId, id) {
      const result = await queryWithRLS<CiRow & { credentials: Buffer }>(
        actingUserId,
        `SELECT ${CI_PUBLIC_COLS}, credentials
         FROM channel_integrations
         WHERE id = $1
         LIMIT 1`,
        [id],
      )
      if (result.rows.length === 0) return null
      const row = result.rows[0]
      const credentials = decryptCredentials(row.credentials, key)
      return {
        id: row.id,
        channelId: row.channelId,
        channelType: row.channelType,
        teamId: row.teamId,
        teamName: row.teamName,
        botUserId: row.botUserId,
        botUsername: row.botUsername,
        config: row.config ?? {},
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        lastEventAt: row.lastEventAt,
        connectorInstanceId: row.connectorInstanceId,
        credentials,
      }
    },

    async listForWorkspace(actingUserId, workspaceId) {
      const result = await queryWithRLS<CiRow>(
        actingUserId,
        `SELECT ${CI_PUBLIC_COLS}
         FROM channel_integrations
         WHERE channel_id IN (SELECT id FROM channels WHERE workspace_id = $1)
         ORDER BY created_at ASC`,
        [workspaceId],
      )
      return result.rows
    },

    async deleteForUser(actingUserId, id) {
      const result = await queryWithRLS(
        actingUserId,
        `DELETE FROM channel_integrations WHERE id = $1`,
        [id],
      )
      return (result.rowCount ?? 0) > 0
    },

    async updateConfig(params) {
      const result = await queryWithRLS<CiRow>(
        params.actingUserId,
        `UPDATE channel_integrations
         SET config = $2, updated_at = now()
         WHERE id = $1
         RETURNING ${CI_PUBLIC_COLS}`,
        [params.id, JSON.stringify(params.config)],
      )
      if (result.rows.length === 0) {
        throw new Error('Integration not found or not authorized')
      }
      return result.rows[0]
    },

    async mergeConfigSystem(id, mutate) {
      const current = await query<{ config: ChannelIntegrationConfig | null }>(
        `SELECT config FROM channel_integrations WHERE id = $1`,
        [id],
      )
      if (current.rows.length === 0) return
      const next = mutate(current.rows[0].config ?? {})
      await query(
        `UPDATE channel_integrations SET config = $2 WHERE id = $1`,
        [id, JSON.stringify(next)],
      )
    },

    async touchLastEventAt(id) {
      await query(
        `UPDATE channel_integrations SET last_event_at = now() WHERE id = $1`,
        [id],
      )
    },

    async setStatusByChannelSystem(channelId, channelType, status) {
      const result = await query(
        `UPDATE channel_integrations SET status = $3, updated_at = now()
         WHERE channel_id = $1 AND channel_type = $2`,
        [channelId, channelType, status],
      )
      return (result.rowCount ?? 0) > 0
    },

    async listActiveWithCredentialsSystem(channelType) {
      const result = await query<{ channelId: string; botUserId: string | null; credentials: Buffer }>(
        `SELECT ci.channel_id AS "channelId", ci.bot_user_id AS "botUserId", ci.credentials
         FROM channel_integrations ci
         JOIN channels c ON c.id = ci.channel_id
         WHERE ci.channel_type = $1
           AND ci.status = 'active'
           AND c.status = 'active'`,
        [channelType],
      )
      return result.rows.map((row) => ({
        channelId: row.channelId,
        botUserId: row.botUserId,
        credentials: decryptCredentials(row.credentials, key),
      }))
    },
  }
}
