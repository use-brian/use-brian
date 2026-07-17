/**
 * Workspace channels management routes — the Phase D operator surface.
 *
 * Lists the channels a workspace owns, edits clearance / capabilities /
 * status / name, and wires per-surface assistant routing. Channels are
 * *created* by the connect flow (`integrations.ts` → `ensureChannelForIntegration`);
 * there is no "create blank channel" endpoint here.
 *
 * Mount point: `/api` (URLs are `/api/workspaces/:workspaceId/channels...`).
 * Workspace membership is checked via `WorkspaceStore.getRole`; the channel
 * reads/writes go through `channels-store.ts`, whose `queryWithRLS` calls are
 * gated by migration 153's workspace-member + clearance RLS policy — so a
 * member below a channel's clearance simply cannot see or mutate it.
 *
 * See docs/architecture/channels/adapter-pattern.md.
 * Component tag: [COMP:api/channels-route].
 */

import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import type { Response } from 'express'
import { z } from 'zod'
import {
  validateSlackCredentials,
  validateTelegramCredentials,
  validateDiscordCredentials,
  createTelegramApi,
  createSlackApi,
} from '@use-brian/channels'
import type { WorkspaceStore } from '../db/workspace-store.js'
import type { DiscordConnectorClient } from '../discord/connector-client.js'
import type { WhatsappConnectorClient } from '../whatsapp/connector-client.js'
import type { ChannelIntegration, ChannelIntegrationStore } from '../db/channel-integrations.js'
import {
  listChannelsForWorkspace,
  getChannelForUser,
  updateChannel,
  deleteChannel,
  listChannelAssistants,
  attachAssistant,
  detachAssistant,
  updateChannelAssistant,
  findOrCreateChannelForWorkspaceConnect,
  type Channel,
  type ChannelAssistant,
} from '../db/channels-store.js'
import { ensureSlackConnectorInstance } from '../ingest/slack-connector-instance.js'
import { query, queryWithRLS } from '../db/client.js'

// Per-integration behavior config accepted by `PATCH .../channels/:id/config`.
// Mirrors the `ChannelIntegrationConfig` type (db/channel-integrations.ts).
// Lives here (open) since the workspace-channels surface moved into the open
// core; the closed per-assistant `integrations.ts` route imports it from here
// so the two surfaces stay on one schema.

const requireMentionOverrideSchema = z.object({
  chatId: z.string().min(1).max(64),
  topicId: z.union([z.number().int().min(1), z.null()]).optional(),
}).strict()

export const channelConfigSchema = z.object({
  replyInThread: z.boolean().optional(),
  ackReaction: z.string().max(50).optional(),
  requireMention: z.boolean().optional(),
  // Telegram BYO only — per-chat / per-topic overrides that flip the
  // `requireMention` default. A null topicId means "whole chat".
  requireMentionOverrides: z.array(requireMentionOverrideSchema).max(500).optional(),
  userAccessMode: z.enum(['allow_all', 'allowlist', 'blocklist', 'group_members']).optional(),
  allowedUserIds: z.array(z.string().max(50)).max(100).optional(),
  blockedUserIds: z.array(z.string().max(50)).max(100).optional(),
}).strict()

export type ChannelsRouteOptions = {
  workspaceStore: WorkspaceStore
  /**
   * Channel-integration store — supplies each channel's per-integration
   * behavior `config` AND backs the workspace-scoped channel connect
   * endpoints (POST `.../channels/slack` + `/telegram`) plus the `PATCH
   * .../config` endpoint. Optional: when the server has no
   * `CHANNEL_CREDENTIAL_KEY` the store can't be built — channels are then
   * listed without `config` and the connect / config endpoints return 503.
   */
  integrationStore?: ChannelIntegrationStore
  /**
   * Public API base URL — required for the Telegram connect endpoint to
   * register the channel's webhook with Telegram
   * (`${apiUrl}/webhook/telegram/${channelId}`). Telegram connect returns 503
   * if missing; Slack connect works without it (the user registers the URL
   * manually in their Slack app).
   */
  apiUrl?: string
  /**
   * Discord Gateway connector client. Required for the Discord connect endpoint
   * (POST `.../channels/discord`): after the integration is saved, the API tells
   * the connector to open the bot's Gateway socket. Discord connect returns 503
   * if missing.
   */
  discordConnector?: DiscordConnectorClient
  /** WhatsApp BYON connector bridge, used to tear down sockets on delete. */
  whatsappConnector?: WhatsappConnectorClient
  /**
   * Hosted default Telegram bot token (`env.TELEGRAM_BOT_TOKEN`). Fallback bot
   * for resolving display names of sessions-derived telegram delivery
   * destinations when the workspace has no BYO bot (or its bot isn't in the
   * chat). Optional — a deployment without a default bot skips resolution and
   * the picker shows raw chat ids.
   */
  telegramBotToken?: string
}

const updateSchema = z.object({
  clearance: z.enum(['public', 'internal', 'confidential']).optional(),
  enabledCapabilities: z.array(z.enum(['chat', 'broadcast', 'ingest'])).optional(),
  status: z.enum(['active', 'revoked', 'invalid']).optional(),
  displayName: z.string().min(1).max(200).optional(),
}).strict()

const attachSchema = z.object({
  assistantId: z.string().uuid(),
  externalSurfaceId: z.string().min(1).max(200).nullish(),
  modelAlias: z.enum(['standard', 'pro', 'max']).optional(),
}).strict()

const updateRoutingSchema = z.object({
  modelAlias: z.enum(['standard', 'pro', 'max']).optional(),
}).strict()

const connectSlackSchema = z.object({
  botToken: z.string().startsWith('xoxb-'),
  signingSecret: z.string().min(16),
  defaultAssistantId: z.string().uuid().nullish(),
  displayName: z.string().min(1).max(200).optional(),
}).strict()

const connectTelegramSchema = z.object({
  botToken: z.string().min(1),
  defaultAssistantId: z.string().uuid().nullish(),
  displayName: z.string().min(1).max(200).optional(),
}).strict()

const connectDiscordSchema = z.object({
  botToken: z.string().min(1),
  // Ed25519 application public key — only needed if the workspace also wires
  // the HTTP Interactions transport. Ignored by the Gateway path.
  publicKey: z.string().min(1).optional(),
  defaultAssistantId: z.string().uuid().nullish(),
  displayName: z.string().min(1).max(200).optional(),
}).strict()

/**
 * Per-type plausibility of a sessions-derived destination id. Rows whose
 * `channel_id` cannot be a valid id for their `channel_type` are dropped from
 * the deliver picker's option list: the pre-fix cross-wire delivery bug minted
 * `channel_type='slack'` session rows keyed by a Telegram chat id and by an
 * internal `channels.id` UUID, and those rows persist in `sessions`. Filtering
 * server-side keeps them out of every consumer, including stale clients.
 * WhatsApp JID shapes vary too much to police — they pass through unfiltered.
 */
const DESTINATION_ID_SHAPE: Record<string, RegExp> = {
  telegram: /^-?\d+$/,
  slack: /^[CDG][A-Z0-9]+$/,
}

/** Per-`getChat` budget — naming is a nicety, never worth a slow editor load. */
const TELEGRAM_GETCHAT_TIMEOUT_MS = 1500

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

function serializeChannel(
  c: Channel,
  integration?: ChannelIntegration | null,
): Record<string, unknown> {
  return {
    id: c.id,
    workspaceId: c.workspaceId,
    channelType: c.channelType,
    clearance: c.clearance,
    enabledCapabilities: c.enabledCapabilities,
    status: c.status,
    displayName: c.displayName,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
    // Per-integration behavior config. `null` when the channel has no
    // `channel_integrations` row — the UI then renders no config section.
    integrationId: integration?.id ?? null,
    config: integration?.config ?? null,
  }
}

function serializeChannelAssistant(a: ChannelAssistant): Record<string, unknown> {
  return {
    id: a.id,
    channelId: a.channelId,
    assistantId: a.assistantId,
    externalSurfaceId: a.externalSurfaceId,
    modelAlias: a.modelAlias,
    createdAt: a.createdAt.toISOString(),
  }
}

export function channelsRoutes(opts: ChannelsRouteOptions): Router {
  const router = Router()

  /**
   * Resolve a channel by id, scoped to the URL workspace + the acting user's
   * RLS visibility. Sends 404 and returns null on miss — an unknown id, a
   * channel in another workspace, or one above the user's clearance are all
   * indistinguishable, by design.
   */
  async function loadChannel(
    userId: string,
    workspaceId: string,
    channelId: string,
    res: Response,
  ): Promise<Channel | null> {
    const channel = await getChannelForUser(userId, channelId)
    if (!channel || channel.workspaceId !== workspaceId) {
      res.status(404).json({ error: 'Channel not found' })
      return null
    }
    return channel
  }

  /**
   * Load the workspace's channel integrations keyed by `channelId`. A channel
   * has 0 or 1 integration. Empty when no integration store is configured.
   * RLS-gated via `listForWorkspace`.
   */
  async function loadIntegrations(
    userId: string,
    workspaceId: string,
  ): Promise<Map<string, ChannelIntegration>> {
    if (!opts.integrationStore) return new Map()
    const rows = await opts.integrationStore.listForWorkspace(userId, workspaceId)
    return new Map(rows.map((r) => [r.channelId, r]))
  }

  /**
   * Resolve display names for telegram destination chat ids via Bot API
   * `getChat`. A chat is only visible to a bot that is in it, so the
   * workspace's BYO bot is tried first, the hosted default bot second.
   * Best-effort throughout: any failure (wrong bot, deleted chat, API down,
   * timeout) leaves that id unnamed and the client falls back to the raw id.
   * Tokens are used server-side only and never returned.
   */
  async function resolveTelegramTitles(
    userId: string,
    workspaceId: string,
    chatIds: string[],
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>()
    if (chatIds.length === 0) return names

    const tokens: string[] = []
    if (opts.integrationStore) {
      try {
        const rows = await opts.integrationStore.listForWorkspace(userId, workspaceId)
        const telegram = rows.find((r) => r.channelType === 'telegram')
        if (telegram) {
          const withCreds = await opts.integrationStore.getForUserWithCredentials(userId, telegram.id)
          const byoToken = withCreds && (withCreds.credentials as { bot_token?: string }).bot_token
          if (byoToken) tokens.push(byoToken)
        }
      } catch (err) {
        console.warn('[channels/channel-destinations] BYO telegram lookup failed:', err instanceof Error ? err.message : err)
      }
    }
    if (opts.telegramBotToken && !tokens.includes(opts.telegramBotToken)) {
      tokens.push(opts.telegramBotToken)
    }
    if (tokens.length === 0) return names

    const apis = tokens.map((token) => createTelegramApi({ token }))
    await Promise.all(chatIds.map(async (chatId) => {
      for (const api of apis) {
        try {
          const chat = await withTimeout(api.getChat(chatId), TELEGRAM_GETCHAT_TIMEOUT_MS)
          const personal = [chat.first_name, chat.last_name].filter(Boolean).join(' ')
          const name = chat.title ?? (personal || (chat.username ? `@${chat.username}` : ''))
          if (name) { names.set(chatId, name); return }
        } catch {
          // Not this bot's chat (or transient failure) — try the next token.
        }
      }
    }))
    return names
  }

  // GET /workspaces/:workspaceId/channel-destinations — recent distinct
  // (channel_type, channel_id) tuples from `sessions` joined to the
  // workspace's assistants. Powers the workflow editor's "deliver to"
  // picker so authors can pick a known chat the assistant has spoken in.
  // Excludes the `notifications` placeholder channel id. Rows failing the
  // per-type id-shape check are dropped (see DESTINATION_ID_SHAPE), and
  // telegram ids are resolved to display names via `getChat` — both
  // documented in docs/architecture/features/workflow.md → "Deliver
  // destination picker (web builder)".
  // [COMP:api/channel-destinations-route]
  router.get('/workspaces/:workspaceId/channel-destinations', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { workspaceId } = req.params
    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }

    const result = await queryWithRLS<{
      channelType: string
      channelId: string
      title: string | null
      lastActiveAt: Date
    }>(
      userId,
      `SELECT DISTINCT ON (s.channel_type, s.channel_id)
         s.channel_type    AS "channelType",
         s.channel_id      AS "channelId",
         s.title           AS "title",
         s.last_active_at  AS "lastActiveAt"
       FROM sessions s
       JOIN assistants a ON a.id = s.assistant_id
       WHERE a.workspace_id = $1
         AND s.channel_type IN ('telegram', 'slack', 'whatsapp')
         AND s.channel_id <> 'notifications'
       ORDER BY s.channel_type, s.channel_id, s.last_active_at DESC
       LIMIT 200`,
      [workspaceId],
    )
    const rows = result.rows.filter((r) => {
      const shape = DESTINATION_ID_SHAPE[r.channelType]
      return !shape || shape.test(r.channelId)
    })
    const unnamedTelegramIds = [...new Set(
      rows.filter((r) => r.channelType === 'telegram' && !r.title).map((r) => r.channelId),
    )]
    const telegramNames = await resolveTelegramTitles(userId, workspaceId, unnamedTelegramIds)
    res.json({
      destinations: rows.map((r) => ({
        channelType: r.channelType,
        channelId: r.channelId,
        title: r.title ?? telegramNames.get(r.channelId) ?? null,
        lastActiveAt: r.lastActiveAt.toISOString(),
      })),
    })
  })

  // GET /workspaces/:workspaceId/slack-channels — the workspace's Slack
  // channels by NAME, resolved live via Slack `conversations.list`, so the
  // workflow deliver picker can show real channel names (`#dev-work`) instead
  // of raw ids and can never surface a non-Slack id (a Telegram chat id or an
  // internal `channels.id` from the old cross-wire bug simply isn't a Slack
  // channel, so it never appears). Member channels first. Best-effort: an
  // empty list when Slack isn't connected or the enumeration fails — the
  // picker then falls back to its custom-id input.
  // The resolved bot token is used server-side only and never returned.
  // [COMP:api/slack-channels-route]
  router.get('/workspaces/:workspaceId/slack-channels', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { workspaceId } = req.params
    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }
    if (!opts.integrationStore) { res.json({ channels: [] }); return }

    try {
      const rows = await opts.integrationStore.listForWorkspace(userId, workspaceId)
      const slack = rows.find((r) => r.channelType === 'slack')
      if (!slack) { res.json({ channels: [] }); return }
      const withCreds = await opts.integrationStore.getForUserWithCredentials(userId, slack.id)
      const botToken = withCreds && (withCreds.credentials as { bot_token?: string }).bot_token
      if (!botToken) { res.json({ channels: [] }); return }

      const { channels } = await createSlackApi({ botToken }).conversationsList()
      const usable = channels
        .filter((c) => !c.isArchived)
        // Member channels first (postable without a join), then by name.
        .sort((a, b) => (a.isMember === b.isMember ? a.name.localeCompare(b.name) : a.isMember ? -1 : 1))
        .map((c) => ({ id: c.id, name: c.name, isMember: c.isMember }))
      res.json({ channels: usable })
    } catch (err) {
      console.warn('[channels/slack-channels] failed:', err instanceof Error ? err.message : err)
      res.json({ channels: [] })
    }
  })

  // GET /workspaces/:workspaceId/channels — list the workspace's channels,
  // each enriched with its integration's behavior `config` + `integrationId`.
  router.get('/workspaces/:workspaceId/channels', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { workspaceId } = req.params

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }

    const channels = await listChannelsForWorkspace(userId, workspaceId)
    const integrations = await loadIntegrations(userId, workspaceId)
    res.json({
      channels: channels.map((c) => serializeChannel(c, integrations.get(c.id))),
    })
  })

  // GET /workspaces/:workspaceId/channels/:channelId
  router.get('/workspaces/:workspaceId/channels/:channelId', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { workspaceId, channelId } = req.params

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }

    const channel = await loadChannel(userId, workspaceId, channelId, res)
    if (!channel) return
    const integrations = await loadIntegrations(userId, workspaceId)
    res.json({ channel: serializeChannel(channel, integrations.get(channelId)) })
  })

  // PATCH /workspaces/:workspaceId/channels/:channelId — clearance,
  // enabled capabilities, status, display name. RLS rejects raising the
  // clearance above the acting user's own tier.
  router.patch('/workspaces/:workspaceId/channels/:channelId', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { workspaceId, channelId } = req.params

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }

    const parsed = updateSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid update', detail: parsed.error.message })
      return
    }

    const channel = await loadChannel(userId, workspaceId, channelId, res)
    if (!channel) return

    let updated
    try {
      updated = await updateChannel(userId, channelId, parsed.data)
    } catch (err) {
      // pg code 42501 = RLS WITH CHECK rejected the new row. The channels
      // policy's WITH CHECK forbids raising `clearance` above the acting
      // member's own tier — surface that as 403 instead of bubbling to 500.
      if ((err as { code?: string }).code === '42501') {
        res.status(403).json({
          error: 'clearance_exceeds_member_tier',
          detail:
            "You can't set the channel's clearance higher than your own member clearance.",
        })
        return
      }
      throw err
    }
    if (!updated) {
      res.status(403).json({ error: 'Not authorized to update this channel' })
      return
    }
    const integrations = await loadIntegrations(userId, workspaceId)
    res.json({ channel: serializeChannel(updated, integrations.get(channelId)) })
  })

  // PATCH /workspaces/:workspaceId/channels/:channelId/config — the
  // per-integration behavior config (require-@mention, allow/blocklist, ack
  // reaction, reply-in-thread, per-chat mention overrides). Writes the
  // channel's `channel_integrations.config` JSONB. See
  // docs/architecture/channels/adapter-pattern.md → "Integration Config".
  router.patch('/workspaces/:workspaceId/channels/:channelId/config', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { workspaceId, channelId } = req.params

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }

    if (!opts.integrationStore) {
      res.status(503).json({ error: 'Channel integrations are not configured on this server' })
      return
    }

    const parsed = channelConfigSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid config', detail: parsed.error.message })
      return
    }

    const channel = await loadChannel(userId, workspaceId, channelId, res)
    if (!channel) return

    const integrations = await loadIntegrations(userId, workspaceId)
    const integration = integrations.get(channelId)
    if (!integration) {
      res.status(404).json({ error: 'Channel has no integration to configure' })
      return
    }

    // Merge into the existing config so webhook-only fields (e.g. `seenChats`,
    // populated opportunistically by the BYO webhook) survive a UI PATCH that
    // doesn't echo them back. Mirrors the legacy per-assistant endpoint.
    const merged = { ...integration.config, ...parsed.data }
    try {
      const updated = await opts.integrationStore.updateConfig({
        actingUserId: userId,
        id: integration.id,
        config: merged,
      })
      res.json({ channel: serializeChannel(channel, updated) })
    } catch (err) {
      console.error('[channels] config update failed:', err)
      res.status(500).json({ error: 'Failed to update channel config' })
    }
  })

  // POST /workspaces/:workspaceId/channels/slack — workspace-driven connect.
  // The studio/channels "Add channel" flow's Slack tab posts here: validates
  // the bot token via Slack `auth.test`, find-or-creates the workspace channel
  // (re-install by `team_id` refreshes the existing channel), upserts the
  // encrypted credentials, optionally seeds a default `channel_assistants`
  // routing row. Returns the channel and the webhook URL the user must
  // register in their Slack app's Event Subscriptions.
  router.post('/workspaces/:workspaceId/channels/slack', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { workspaceId } = req.params

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }

    if (!opts.integrationStore) {
      res.status(503).json({ error: 'Channel integrations are not configured on this server' })
      return
    }

    const parsed = connectSlackSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', detail: parsed.error.message })
      return
    }

    let info
    try {
      info = await validateSlackCredentials(parsed.data.botToken)
    } catch (err) {
      res.status(400).json({
        error: 'Slack rejected the bot token',
        detail: (err as Error).message,
      })
      return
    }

    let provisioned
    try {
      provisioned = await findOrCreateChannelForWorkspaceConnect({
        workspaceId,
        channelType: 'slack',
        displayName: parsed.data.displayName ?? info.teamName,
        externalIdentity: { teamId: info.teamId },
        defaultAssistantId: parsed.data.defaultAssistantId ?? null,
      })
    } catch (err) {
      const msg = (err as Error).message
      console.error('[channels] slack channel provisioning failed:', err)
      // `channel_assistants_workspace_match` trigger rejects a cross-workspace
      // default assistant. Surface that as a 400 with the field name.
      if (msg.toLowerCase().includes('workspace')) {
        res.status(400).json({ error: 'defaultAssistantId must belong to this workspace' })
        return
      }
      res.status(500).json({ error: 'Failed to provision channel' })
      return
    }

    try {
      const integration = await opts.integrationStore.upsert({
        channelId: provisioned.channelId,
        channelType: 'slack',
        teamId: info.teamId || null,
        teamName: info.teamName,
        botUserId: info.botUserId,
        botUsername: null,
        credentials: { bot_token: parsed.data.botToken, signing_secret: parsed.data.signingSecret },
        actingUserId: userId,
      })
      // Pair with a connector_instance so the ingest engine + DB-backed
      // rules can route this channel's events (migration 182). Idempotent
      // on re-install.
      try {
        await ensureSlackConnectorInstance({
          channelIntegrationId: integration.id,
          actingUserId: userId,
        })
      } catch (err) {
        console.error('[channels] slack CI provisioning failed:', err)
      }
    } catch (err) {
      console.error('[channels] slack integration upsert failed:', err)
      res.status(500).json({ error: 'Failed to save integration' })
      return
    }

    const channel = await getChannelForUser(userId, provisioned.channelId)
    if (!channel) {
      // Should be unreachable — the user just created it under their RLS.
      res.status(500).json({ error: 'Channel created but no longer visible' })
      return
    }
    const integrations = await loadIntegrations(userId, workspaceId)
    res.status(provisioned.reused ? 200 : 201).json({
      channel: serializeChannel(channel, integrations.get(provisioned.channelId)),
      reused: provisioned.reused,
      // The webhook URL the user must register in their Slack app. We don't
      // know our public hostname without `apiUrl`; return the path and let
      // the client prefix it.
      webhookPath: `/webhook/slack/${provisioned.channelId}`,
      webhookUrl: opts.apiUrl ? `${opts.apiUrl}/webhook/slack/${provisioned.channelId}` : null,
    })
  })

  // POST /workspaces/:workspaceId/channels/telegram — workspace-driven
  // connect. Validates the bot token via Telegram `getMe`, find-or-creates
  // the workspace channel (re-install by `bot_user_id` refreshes), auto-
  // registers the webhook with Telegram against the new channel id, and
  // upserts the encrypted credentials. Optional default-assistant routing.
  router.post('/workspaces/:workspaceId/channels/telegram', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { workspaceId } = req.params

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }

    if (!opts.integrationStore) {
      res.status(503).json({ error: 'Channel integrations are not configured on this server' })
      return
    }
    if (!opts.apiUrl) {
      res.status(503).json({ error: 'Telegram connect requires apiUrl to register the webhook' })
      return
    }

    const parsed = connectTelegramSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', detail: parsed.error.message })
      return
    }

    let info
    try {
      info = await validateTelegramCredentials(parsed.data.botToken)
    } catch (err) {
      res.status(400).json({
        error: 'Telegram rejected the bot token',
        detail: (err as Error).message,
      })
      return
    }

    let provisioned
    try {
      provisioned = await findOrCreateChannelForWorkspaceConnect({
        workspaceId,
        channelType: 'telegram',
        displayName: parsed.data.displayName ?? info.firstName,
        externalIdentity: { botUserId: String(info.botId) },
        defaultAssistantId: parsed.data.defaultAssistantId ?? null,
      })
    } catch (err) {
      const msg = (err as Error).message
      console.error('[channels] telegram channel provisioning failed:', err)
      if (msg.toLowerCase().includes('workspace')) {
        res.status(400).json({ error: 'defaultAssistantId must belong to this workspace' })
        return
      }
      res.status(500).json({ error: 'Failed to provision channel' })
      return
    }

    // Rotate the webhook secret on every connect and re-register; Telegram
    // overwrites the prior registration in place. (We can't reuse the old
    // secret on re-installs without first fetching the stored integration.)
    const webhookSecret = randomBytes(32).toString('hex')
    const webhookUrl = `${opts.apiUrl}/webhook/telegram/${provisioned.channelId}`
    try {
      const api = createTelegramApi({ token: parsed.data.botToken })
      await api.setWebhook(webhookUrl, webhookSecret)
    } catch (err) {
      res.status(500).json({
        error: 'Failed to register Telegram webhook',
        detail: (err as Error).message,
      })
      return
    }

    try {
      await opts.integrationStore.upsert({
        channelId: provisioned.channelId,
        channelType: 'telegram',
        teamId: null,
        teamName: info.firstName,
        botUserId: String(info.botId),
        botUsername: info.botUsername,
        credentials: { bot_token: parsed.data.botToken, webhook_secret: webhookSecret },
        actingUserId: userId,
      })
    } catch (err) {
      console.error('[channels] telegram integration upsert failed:', err)
      res.status(500).json({ error: 'Failed to save integration' })
      return
    }

    const channel = await getChannelForUser(userId, provisioned.channelId)
    if (!channel) {
      res.status(500).json({ error: 'Channel created but no longer visible' })
      return
    }
    const integrations = await loadIntegrations(userId, workspaceId)
    res.status(provisioned.reused ? 200 : 201).json({
      channel: serializeChannel(channel, integrations.get(provisioned.channelId)),
      reused: provisioned.reused,
      botUsername: info.botUsername,
    })
  })

  // POST /workspaces/:workspaceId/channels/discord — BYO Discord bot.
  // Validates the token, stores it encrypted, then asks the Gateway connector
  // to open this bot's WebSocket. See docs/architecture/channels/discord.md.
  router.post('/workspaces/:workspaceId/channels/discord', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { workspaceId } = req.params

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }

    if (!opts.integrationStore) {
      res.status(503).json({ error: 'Channel integrations are not configured on this server' })
      return
    }
    if (!opts.discordConnector) {
      res.status(503).json({ error: 'Discord connect requires the Gateway connector to be configured' })
      return
    }

    const parsed = connectDiscordSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', detail: parsed.error.message })
      return
    }

    let info
    try {
      info = await validateDiscordCredentials(parsed.data.botToken)
    } catch (err) {
      res.status(400).json({ error: 'Discord rejected the bot token', detail: (err as Error).message })
      return
    }

    let provisioned
    try {
      provisioned = await findOrCreateChannelForWorkspaceConnect({
        workspaceId,
        channelType: 'discord',
        displayName: parsed.data.displayName ?? info.botUsername,
        externalIdentity: { botUserId: info.botId },
        defaultAssistantId: parsed.data.defaultAssistantId ?? null,
      })
    } catch (err) {
      const msg = (err as Error).message
      console.error('[channels] discord channel provisioning failed:', err)
      if (msg.toLowerCase().includes('workspace')) {
        res.status(400).json({ error: 'defaultAssistantId must belong to this workspace' })
        return
      }
      res.status(500).json({ error: 'Failed to provision channel' })
      return
    }

    try {
      await opts.integrationStore.upsert({
        channelId: provisioned.channelId,
        channelType: 'discord',
        teamId: null,
        teamName: info.botUsername,
        botUserId: info.botId,
        botUsername: info.botUsername,
        credentials: {
          bot_token: parsed.data.botToken,
          ...(parsed.data.publicKey ? { public_key: parsed.data.publicKey } : {}),
        },
        actingUserId: userId,
      })
    } catch (err) {
      console.error('[channels] discord integration upsert failed:', err)
      res.status(500).json({ error: 'Failed to save integration' })
      return
    }

    // Open the Gateway socket for this bot. Non-fatal on failure: the
    // integration is persisted, so the connector's restoreAll picks it up on
    // its next boot — but report it so the UI can prompt a retry.
    let connectorError: string | null = null
    try {
      await opts.discordConnector.connect(provisioned.channelId, {
        botToken: parsed.data.botToken,
        botUserId: info.botId,
      })
    } catch (err) {
      connectorError = (err as Error).message
      console.error('[channels] discord connector connect failed:', err)
    }

    const channel = await getChannelForUser(userId, provisioned.channelId)
    if (!channel) {
      res.status(500).json({ error: 'Channel created but no longer visible' })
      return
    }
    const integrations = await loadIntegrations(userId, workspaceId)
    res.status(provisioned.reused ? 200 : 201).json({
      channel: serializeChannel(channel, integrations.get(provisioned.channelId)),
      reused: provisioned.reused,
      botUsername: info.botUsername,
      // Bot user id == Discord Application id; the UI uses it to build the
      // server-invite URL (a bot must be in a server before it can be messaged).
      botId: info.botId,
      connectorError,
    })
  })

  // DELETE /workspaces/:workspaceId/channels/:channelId — cascades to the
  // channel's `channel_integrations` + `channel_assistants` rows.
  router.delete('/workspaces/:workspaceId/channels/:channelId', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { workspaceId, channelId } = req.params

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }

    const channel = await loadChannel(userId, workspaceId, channelId, res)
    if (!channel) return

    if (channel.channelType === 'whatsapp' && opts.whatsappConnector) {
      await opts.whatsappConnector.disconnect(channelId).catch((err) => {
        console.error('[channels] whatsapp connector disconnect failed:', err)
      })
    }

    if (channel.channelType === 'whatsapp') {
      await query('DELETE FROM wa_auth_state WHERE channel_id = $1', [channelId])
    }

    await deleteChannel(userId, channelId)

    // For Discord, tear down the live Gateway socket now. Best-effort: the DB
    // rows are already gone, so on the connector's next reboot `restoreAll`
    // wouldn't reconnect this channel anyway — this just drops the socket
    // immediately instead of leaving it idle until then. Never fails the delete.
    if (channel.channelType === 'discord' && opts.discordConnector) {
      opts.discordConnector.disconnect(channelId).catch((err) => {
        console.error('[channels] discord connector disconnect failed:', err)
      })
    }

    res.status(204).end()
  })

  // GET /workspaces/:workspaceId/channels/:channelId/assistants — the
  // per-surface routing rows (NULL `externalSurfaceId` = the channel default).
  router.get('/workspaces/:workspaceId/channels/:channelId/assistants', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { workspaceId, channelId } = req.params

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }

    const channel = await loadChannel(userId, workspaceId, channelId, res)
    if (!channel) return

    const assistants = await listChannelAssistants(userId, channelId)
    res.json({ assistants: assistants.map(serializeChannelAssistant) })
  })

  // POST /workspaces/:workspaceId/channels/:channelId/assistants — attach an
  // assistant for chat routing. Omit `externalSurfaceId` for the channel default.
  router.post('/workspaces/:workspaceId/channels/:channelId/assistants', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { workspaceId, channelId } = req.params

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }

    const parsed = attachSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', detail: parsed.error.message })
      return
    }

    const channel = await loadChannel(userId, workspaceId, channelId, res)
    if (!channel) return

    try {
      const attached = await attachAssistant(userId, {
        channelId,
        assistantId: parsed.data.assistantId,
        externalSurfaceId: parsed.data.externalSurfaceId ?? null,
        modelAlias: parsed.data.modelAlias,
      })
      res.json({ assistant: serializeChannelAssistant(attached) })
    } catch (err) {
      // Same-workspace trigger, or a partial-unique-index conflict (a second
      // default, or a surface already mapped).
      console.error('[channels] attach assistant failed:', err)
      res.status(409).json({ error: 'Could not attach assistant', detail: (err as Error).message })
    }
  })

  // PATCH /workspaces/:workspaceId/channels/:channelId/assistants/:channelAssistantId
  // — patch the routing row. Today only `modelAlias` is mutable; the
  // assistant + surface assignments are immutable (callers re-attach to
  // change them). RLS gates the write.
  router.patch(
    '/workspaces/:workspaceId/channels/:channelId/assistants/:channelAssistantId',
    async (req, res) => {
      const userId = (req as { userId?: string }).userId
      if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
      const { workspaceId, channelId, channelAssistantId } = req.params

      const role = await opts.workspaceStore.getRole(userId, workspaceId)
      if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }

      const parsed = updateRoutingSchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid update', detail: parsed.error.message })
        return
      }

      const channel = await loadChannel(userId, workspaceId, channelId, res)
      if (!channel) return

      // Confirm the routing row belongs to this channel.
      const rows = await listChannelAssistants(userId, channelId)
      if (!rows.some((r) => r.id === channelAssistantId)) {
        res.status(404).json({ error: 'Routing row not found' })
        return
      }

      const updated = await updateChannelAssistant(userId, channelAssistantId, parsed.data)
      if (!updated) {
        res.status(403).json({ error: 'Not authorized to update this routing row' })
        return
      }
      res.json({ assistant: serializeChannelAssistant(updated) })
    },
  )

  // DELETE /workspaces/:workspaceId/channels/:channelId/assistants/:channelAssistantId
  router.delete(
    '/workspaces/:workspaceId/channels/:channelId/assistants/:channelAssistantId',
    async (req, res) => {
      const userId = (req as { userId?: string }).userId
      if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
      const { workspaceId, channelId, channelAssistantId } = req.params

      const role = await opts.workspaceStore.getRole(userId, workspaceId)
      if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }

      const channel = await loadChannel(userId, workspaceId, channelId, res)
      if (!channel) return

      // Confirm the routing row belongs to this channel before deleting.
      const rows = await listChannelAssistants(userId, channelId)
      if (!rows.some((r) => r.id === channelAssistantId)) {
        res.status(404).json({ error: 'Routing row not found' })
        return
      }
      await detachAssistant(userId, channelAssistantId)
      res.status(204).end()
    },
  )

  return router
}
