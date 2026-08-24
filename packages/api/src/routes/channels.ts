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

import { randomBytes, randomUUID } from 'node:crypto'
import { Router } from 'express'
import type { Response } from 'express'
import { z } from 'zod'
import {
  validateSlackCredentials,
  validateTelegramCredentials,
  validateDiscordCredentials,
  validateMsTeamsCredentials,
  validateWhatsAppCloudCredentials,
  subscribeWhatsAppCloudApp,
  DEFAULT_WHATSAPP_GRAPH_API_VERSION,
  createTelegramApi,
  TELEGRAM_BOT_COMMANDS,
  createSlackApi,
} from '@use-brian/channels'
import type { WorkspaceStore } from '../db/workspace-store.js'
import type { LinkCodeStore } from '../db/link-codes.js'
import type { DiscordConnectorClient } from '../discord/connector-client.js'
import type { WhatsappConnectorClient } from '../whatsapp/connector-client.js'
import type { WechatConnectorClient } from '../wechat/connector-client.js'
import type { FeishuConnectorClient } from '../feishu/connector-client.js'
import { validateFeishuCredentials } from '../feishu/client.js'
import type { CustomChannelStore } from '../db/custom-channel-store.js'
import { mintBridgeToken, hashBridgeToken } from '../db/custom-channel-token.js'
import type {
  ChannelIntegration,
  ChannelIntegrationStore,
  SeenChat,
} from '../db/channel-integrations.js'
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
  resolveRoutingForSurface,
  type Channel,
  type ChannelAssistant,
} from '../db/channels-store.js'
import { ensureSlackConnectorInstance } from '../ingest/slack-connector-instance.js'
import { ensureMsTeamsConnectorInstance } from '../ingest/msteams-connector-instance.js'
import { query, queryWithRLS } from '../db/client.js'
import { providerChannelIdFromSession } from '../db/sessions.js'

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
  allowGuestConnectorTools: z.boolean().optional(),
  allowTrustedGuestFullAccess: z.boolean().optional(),
  blockedUserIds: z.array(z.string().max(50)).max(100).optional(),
}).strict()

const WHATSAPP_E164_DIGITS = /^[1-9]\d{7,14}$/

export function normalizeWhatsAppPhoneNumber(value: string): string | null {
  const trimmed = value.trim()
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null
  const rawDigits = trimmed.replace(/\D/g, '')
  const digits = trimmed.startsWith('00') ? rawDigits.slice(2) : rawDigits
  return WHATSAPP_E164_DIGITS.test(digits) ? digits : null
}

function normalizeWhatsAppPhoneNumbers(values: string[]): string[] | null {
  const normalized: string[] = []
  for (const value of values) {
    const phoneNumber = normalizeWhatsAppPhoneNumber(value)
    if (!phoneNumber) return null
    if (!normalized.includes(phoneNumber)) normalized.push(phoneNumber)
  }
  return normalized
}

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
   * WeChat iLink connector bridge. Required for the WeChat QR pairing
   * endpoints (POST `.../channels/wechat/pairing` + status/verify-code) and
   * used to start/stop the per-channel long-poll loop. WeChat connect
   * returns 503 if missing. See docs/architecture/channels/wechat.md.
   */
  wechatConnector?: WechatConnectorClient
  /** Feishu/Lark long-connection bridge used to start/stop inbound delivery. */
  feishuConnector?: FeishuConnectorClient
  /**
   * Custom (bridge-driven) channel state + outbox store. Required for the
   * custom channel endpoints (POST `.../channels/custom`, rotate-token,
   * state, input, disconnect); they return 503 if missing. See
   * docs/architecture/channels/custom-channel.md.
   */
  customChannelStore?: CustomChannelStore
  /**
   * Hosted default Telegram bot token (`env.TELEGRAM_BOT_TOKEN`). Fallback bot
   * for resolving display names of sessions-derived telegram delivery
   * destinations when the workspace has no BYO bot (or its bot isn't in the
   * chat). Optional — a deployment without a default bot skips resolution and
   * the picker shows raw chat ids.
   */
  telegramBotToken?: string
  /** One-time BYO Telegram account pairing. */
  ownerPairing?: {
    enabled: boolean
    /** OSS setup cannot finish without an owner route; hosted keeps routing optional. */
    requiredOnConnect?: boolean
    linkCodeStore: LinkCodeStore
  }
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

const connectMsTeamsSchema = z.object({
  // Azure Bot (single-tenant): Microsoft App id + client secret + tenant id.
  appId: z.string().min(1),
  appPassword: z.string().min(1),
  tenantId: z.string().min(1),
  defaultAssistantId: z.string().uuid().nullish(),
  displayName: z.string().min(1).max(200).optional(),
}).strict()

const connectFeishuSchema = z.object({
  appId: z.string().min(1).max(200),
  appSecret: z.string().min(1).max(500),
  brand: z.enum(['feishu', 'lark']),
  defaultAssistantId: z.string().uuid().nullish(),
  displayName: z.string().min(1).max(200).optional(),
}).strict()

const connectWhatsAppCloudSchema = z.object({
  accessToken: z.string().min(1),
  appSecret: z.string().min(8),
  verifyToken: z.string().min(8).max(256).optional(),
  phoneNumberId: z.string().regex(/^\d+$/),
  wabaId: z.string().regex(/^\d+$/),
  graphApiVersion: z.string().regex(/^v\d+\.\d+$/).default(DEFAULT_WHATSAPP_GRAPH_API_VERSION),
  defaultAssistantId: z.string().uuid().nullish(),
  displayName: z.string().min(1).max(200).optional(),
}).strict()

const wechatPairStartSchema = z.object({
  defaultAssistantId: z.string().uuid().nullish(),
}).strict()

const connectCustomSchema = z.object({
  displayName: z.string().min(1).max(200),
  // Free label (`wechat-desktop`, `sms-gateway`) for display + per-kind guide.
  // An empty form field arrives as null or "" - both mean "no kind".
  kind: z.preprocess(
    (v) => (v === null || (typeof v === 'string' && v.trim() === '') ? undefined : v),
    z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9._-]*$/i).optional(),
  ),
  defaultAssistantId: z.string().uuid().nullish(),
}).strict()

const customInputSchema = z.object({
  requestId: z.string().min(1).max(200),
  value: z.string().max(4000),
}).strict()

const wechatVerifyCodeSchema = z.object({
  // The digits the user's phone WeChat shows during pairing.
  code: z.string().min(1).max(16),
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
const TELEGRAM_DESTINATION_ID_PATTERN = /^(-?\d+)(?::topic:([1-9]\d*))?$/

const DESTINATION_ID_SHAPE: Record<string, RegExp> = {
  telegram: TELEGRAM_DESTINATION_ID_PATTERN,
  slack: /^[CDG][A-Z0-9]+$/,
  feishu: /^oc_[A-Za-z0-9]+$/,
  // Only linked-number JIDs support proactive delivery today. Official Cloud
  // API phone numbers are omitted until approved template sends exist.
  whatsapp: /@/,
}

function parseTelegramDestinationId(channelId: string): {
  chatId: string
  topicId: number | null
} | null {
  const match = TELEGRAM_DESTINATION_ID_PATTERN.exec(channelId)
  if (!match) return null
  return { chatId: match[1], topicId: match[2] ? Number(match[2]) : null }
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
    integrationStatus: integration?.status ?? null,
    integrationLabel: integration?.botUsername
      ? `@${integration.botUsername}`
      : integration?.teamName ?? null,
    // Non-secret transport discriminator. Existing WhatsApp linked-number
    // rows have no provider marker; official Meta rows are `cloud_api`.
    integrationProvider: integration?.channelType === 'whatsapp'
      && integration.botUserId
      && integration.teamId
      ? 'cloud_api'
      : null,
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
    const hydrated = await Promise.all(rows.map(async (row) => {
      if (
        row.channelType !== 'whatsapp'
        || row.config.whatsappDisplayPhoneNumber
        || !row.botUserId
        || !row.teamId
      ) return row

      try {
        const withCredentials = await opts.integrationStore!.getForUserWithCredentials(userId, row.id)
        const credentials = withCredentials?.credentials as {
          provider?: unknown
          display_phone_number?: unknown
        } | undefined
        if (credentials?.provider !== 'cloud_api' || typeof credentials.display_phone_number !== 'string') {
          return row
        }
        return {
          ...row,
          config: {
            ...row.config,
            whatsappDisplayPhoneNumber: credentials.display_phone_number,
          },
        }
      } catch {
        return row
      }
    }))
    return new Map(hydrated.map((r) => [r.channelId, r]))
  }

  /**
   * Resolve display names for Telegram destinations. Forum-topic channel ids
   * are split before `getChat` (Telegram only accepts the base chat id), then
   * enriched with topic names from the webhook-populated `seenChats` inventory.
   * A chat is only visible to a bot that is in it, so the workspace's BYO bot
   * is tried first, the hosted default bot second. Best-effort throughout;
   * tokens are used server-side only and never returned.
   */
  async function resolveTelegramTitles(
    userId: string,
    workspaceId: string,
    destinationIds: string[],
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>()
    const parsed = destinationIds.flatMap((channelId) => {
      const destination = parseTelegramDestinationId(channelId)
      return destination ? [{ channelId, ...destination }] : []
    })
    if (parsed.length === 0) return names

    let integrations: ChannelIntegration[] = []
    const tokens: string[] = []
    if (opts.integrationStore) {
      try {
        integrations = await opts.integrationStore.listForWorkspace(userId, workspaceId)
      } catch (err) {
        console.warn('[channels/channel-destinations] BYO telegram lookup failed:', err instanceof Error ? err.message : err)
      }
    }

    const seenByChatId = new Map<string, SeenChat>()
    for (const integration of integrations.filter((r) => r.channelType === 'telegram')) {
      for (const chat of integration.config.seenChats ?? []) {
        const current = seenByChatId.get(chat.chatId)
        if (!current) {
          seenByChatId.set(chat.chatId, chat)
          continue
        }
        const topics = new Map(current.topics.map((topic) => [topic.topicId, topic]))
        for (const topic of chat.topics) {
          const existing = topics.get(topic.topicId)
          if (!existing) {
            topics.set(topic.topicId, topic)
            continue
          }
          const incomingIsNewer = topic.lastSeenAt >= existing.lastSeenAt
          topics.set(topic.topicId, incomingIsNewer
            ? { ...topic, name: topic.name ?? existing.name }
            : { ...existing, name: existing.name ?? topic.name })
        }
        const incomingIsNewer = chat.lastSeenAt >= current.lastSeenAt
        seenByChatId.set(chat.chatId, {
          ...current,
          chatTitle: incomingIsNewer
            ? chat.chatTitle ?? current.chatTitle
            : current.chatTitle ?? chat.chatTitle,
          isForum: current.isForum || chat.isForum,
          topics: [...topics.values()],
          lastSeenAt: incomingIsNewer ? chat.lastSeenAt : current.lastSeenAt,
        })
      }
    }
    const unresolvedChatIds = [...new Set(
      parsed
        .filter(({ chatId }) => !seenByChatId.get(chatId)?.chatTitle)
        .map(({ chatId }) => chatId),
    )]

    if (unresolvedChatIds.length > 0 && opts.integrationStore) {
      const telegramIntegrations = integrations.filter(
        (r) => r.channelType === 'telegram' && r.status === 'active',
      )
      const byoTokens = await Promise.all(telegramIntegrations.map(async (telegram) => {
        try {
          const withCreds = await opts.integrationStore!.getForUserWithCredentials(userId, telegram.id)
          return withCreds && (withCreds.credentials as { bot_token?: string }).bot_token
        } catch (err) {
          console.warn('[channels/channel-destinations] BYO telegram credential lookup failed:', err instanceof Error ? err.message : err)
          return undefined
        }
      }))
      for (const byoToken of byoTokens) {
        if (byoToken && !tokens.includes(byoToken)) tokens.push(byoToken)
      }
    }
    if (opts.telegramBotToken && !tokens.includes(opts.telegramBotToken)) tokens.push(opts.telegramBotToken)

    const chatNames = new Map<string, string>()
    const apis = tokens.map((token) => createTelegramApi({ token }))
    await Promise.all(unresolvedChatIds.map(async (chatId) => {
      try {
        const name = await Promise.any(apis.map(async (api) => {
          const chat = await withTimeout(api.getChat(chatId), TELEGRAM_GETCHAT_TIMEOUT_MS)
          const personal = [chat.first_name, chat.last_name].filter(Boolean).join(' ')
          const name = chat.title ?? (personal || (chat.username ? `@${chat.username}` : ''))
          if (!name) throw new Error('Telegram chat has no display name')
          return name
        }))
        chatNames.set(chatId, name)
      } catch {
        // No configured bot could resolve this chat within the shared timeout.
      }
    }))

    for (const { channelId, chatId, topicId } of parsed) {
      const seen = seenByChatId.get(chatId)
      const chatTitle = seen?.chatTitle ?? chatNames.get(chatId) ?? null
      if (topicId == null) {
        if (chatTitle) names.set(channelId, chatTitle)
        continue
      }
      const topicName = seen?.topics.find((topic) => topic.topicId === topicId)?.name
      names.set(channelId, `${chatTitle ?? chatId} › ${topicName ?? `#${topicId}`}`)
    }
    return names
  }

  // GET /workspaces/:workspaceId/channel-destinations — recent distinct
  // (channel_type, channel_id) tuples from `sessions` joined to the
  // workspace's assistants. Powers the workflow editor's "deliver to"
  // picker so authors can pick a known chat the assistant has spoken in.
  // Excludes the `notifications` placeholder channel id. Rows failing the
  // per-type id-shape check are dropped (see DESTINATION_ID_SHAPE), and
  // Telegram chat/topic ids are resolved via `getChat` + `seenChats` — both
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
         AND s.channel_type IN ('telegram', 'slack', 'whatsapp', 'custom', 'feishu')
         AND s.channel_id <> 'notifications'
       ORDER BY s.channel_type, s.channel_id, s.last_active_at DESC
       LIMIT 200`,
      [workspaceId],
    )
    // Slack sessions are thread-qualified in storage, but workflow delivery
    // targets a provider channel (threading is a separate deliver option).
    // Normalize before validation and collapse several thread sessions from
    // the same channel to the newest destination row.
    const destinations = new Map<string, (typeof result.rows)[number]>()
    for (const row of result.rows) {
      const normalized = {
        ...row,
        channelId: providerChannelIdFromSession(row.channelType, row.channelId),
      }
      const key = `${normalized.channelType}:${normalized.channelId}`
      const existing = destinations.get(key)
      if (!existing || normalized.lastActiveAt.getTime() > existing.lastActiveAt.getTime()) {
        destinations.set(key, normalized)
      }
    }
    const rows = [...destinations.values()].filter((r) => {
      const shape = DESTINATION_ID_SHAPE[r.channelType]
      return !shape || shape.test(r.channelId)
    })
    const telegramIdsToResolve = [...new Set(
      rows
        .filter((r) => r.channelType === 'telegram'
          && (!r.title || parseTelegramDestinationId(r.channelId)?.topicId != null))
        .map((r) => r.channelId),
    )]
    const telegramNames = await resolveTelegramTitles(userId, workspaceId, telegramIdsToResolve)
    let messagingIntegrations: ChannelIntegration[] = []
    if (opts.integrationStore) {
      try {
        messagingIntegrations = (await opts.integrationStore.listForWorkspace(userId, workspaceId))
          .filter((integration) => integration.status === 'active')
      } catch {
        // Destination discovery stays best-effort; unresolved rows remain usable
        // through the shared/default bot path.
      }
    }
    res.json({
      destinations: rows.flatMap((r) => {
        const title = parseTelegramDestinationId(r.channelId)?.topicId != null
          ? telegramNames.get(r.channelId) ?? r.title
          : r.title ?? telegramNames.get(r.channelId) ?? null
        const base = {
          channelType: r.channelType,
          channelId: r.channelId,
          title,
          lastActiveAt: r.lastActiveAt.toISOString(),
        }
        if (r.channelType === 'telegram') {
          const parsed = parseTelegramDestinationId(r.channelId)
          const owners = parsed
            ? messagingIntegrations.filter((integration) =>
              integration.channelType === 'telegram' &&
              integration.config.seenChats?.some((chat) => chat.chatId === parsed.chatId),
            )
            : []
          if (owners.length === 0) return [{ ...base, channelIntegrationId: null, integrationLabel: null }]
          return owners.map((integration) => ({
            ...base,
            channelIntegrationId: integration.id,
            integrationLabel: integration.botUsername ? `@${integration.botUsername}` : integration.teamName,
          }))
        }
        if (r.channelType === 'feishu') {
          const owners = messagingIntegrations.filter((integration) =>
            integration.channelType === 'feishu' &&
            integration.config.seenChats?.some((chat) => chat.chatId === r.channelId),
          )
          if (owners.length === 0) return [{ ...base, channelIntegrationId: null, integrationLabel: null }]
          return owners.map((integration) => ({
            ...base,
            channelIntegrationId: integration.id,
            integrationLabel: integration.teamName,
          }))
        }
        return [base]
      }),
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

    // Renaming is a team-admin right. `display_name` is the one field on this
    // row that every member reads — the Studio rail, the workflow deliver
    // picker and the assistant's own channel list all label the channel by it,
    // so a rename is a workspace-wide edit, not a personal preference. RLS
    // cannot express this (its channels policy is membership + clearance), so
    // the gate lives here; clearance and capabilities stay open to any member
    // exactly as before.
    if (
      parsed.data.displayName !== undefined &&
      role !== 'owner' &&
      role !== 'admin'
    ) {
      res.status(403).json({
        error: 'rename_requires_admin',
        detail: 'Only the workspace owner or an admin can rename a channel.',
      })
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
    let patch = parsed.data
    const isWhatsAppCloud = integration.channelType === 'whatsapp'
      && integration.botUserId
      && integration.teamId
    if (isWhatsAppCloud) {
      const allowedUserIds = parsed.data.allowedUserIds
        ? normalizeWhatsAppPhoneNumbers(parsed.data.allowedUserIds)
        : undefined
      const blockedUserIds = parsed.data.blockedUserIds
        ? normalizeWhatsAppPhoneNumbers(parsed.data.blockedUserIds)
        : undefined
      if (allowedUserIds === null || blockedUserIds === null) {
        res.status(400).json({ error: 'WhatsApp phone numbers must include a country code and contain 8 to 15 digits' })
        return
      }
      patch = {
        ...parsed.data,
        ...(allowedUserIds ? { allowedUserIds } : {}),
        ...(blockedUserIds ? { blockedUserIds } : {}),
      }
    }

    const merged = { ...integration.config, ...patch }
    const changesTrustedGuestAuthority =
      parsed.data.allowTrustedGuestFullAccess !== undefined
      || (
        (integration.config.allowTrustedGuestFullAccess === true
          || merged.allowTrustedGuestFullAccess === true)
        && (
          parsed.data.allowedUserIds !== undefined
          || parsed.data.userAccessMode !== undefined
        )
      )
    if (changesTrustedGuestAuthority && role !== 'owner' && role !== 'admin') {
      res.status(403).json({
        error: 'trusted_guest_access_requires_admin',
        detail: 'Only the workspace owner or an admin can change trusted guest full access.',
      })
      return
    }
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
    if (opts.ownerPairing?.enabled && opts.ownerPairing.requiredOnConnect && !parsed.data.defaultAssistantId) {
      res.status(400).json({ error: 'Select a default assistant to pair the Telegram owner' })
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
      api.upsertMyCommands(TELEGRAM_BOT_COMMANDS).catch((err) => {
        console.warn('[channels] Telegram command registration failed:', err)
      })
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
    let pairingCode: string | null = null
    let pairingCodeExpiresAt: Date | null = null
    if (opts.ownerPairing?.enabled) {
      const routing = await resolveRoutingForSurface(provisioned.channelId, null)
      if (!routing && opts.ownerPairing.requiredOnConnect) {
        res.status(500).json({ error: 'Telegram channel has no default assistant for owner pairing' })
        return
      }
      if (routing) {
        try {
          const code = await opts.ownerPairing.linkCodeStore.create({
            userId,
            assistantId: routing.assistantId,
          })
          pairingCode = code.code
          pairingCodeExpiresAt = code.expiresAt
        } catch (err) {
          console.error('[channels] telegram owner pairing code creation failed:', err)
          res.status(500).json({ error: 'Failed to create Telegram owner pairing code' })
          return
        }
      }
    }
    res.status(provisioned.reused ? 200 : 201).json({
      channel: serializeChannel(channel, integrations.get(provisioned.channelId)),
      reused: provisioned.reused,
      botUsername: info.botUsername,
      pairingCode,
      pairingCodeExpiresAt,
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

  // POST /workspaces/:workspaceId/channels/feishu - BYO Feishu/Lark app.
  // Validates app credentials without opening a socket, stores them encrypted,
  // then asks the dedicated bridge to establish the one long connection.
  router.post('/workspaces/:workspaceId/channels/feishu', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { workspaceId } = req.params

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }
    if (!opts.integrationStore) {
      res.status(503).json({ error: 'Channel integrations are not configured on this server' })
      return
    }
    if (!opts.feishuConnector) {
      res.status(503).json({ error: 'Feishu connect requires the long-connection bridge to be configured' })
      return
    }

    const parsed = connectFeishuSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', detail: parsed.error.message })
      return
    }

    let info: Awaited<ReturnType<typeof validateFeishuCredentials>>
    try {
      info = await validateFeishuCredentials({
        appId: parsed.data.appId,
        appSecret: parsed.data.appSecret,
        brand: parsed.data.brand,
      })
    } catch (error) {
      res.status(400).json({
        error: `${parsed.data.brand === 'lark' ? 'Lark' : 'Feishu'} rejected the app credentials`,
        detail: (error as Error).message,
      })
      return
    }

    let provisioned
    try {
      provisioned = await findOrCreateChannelForWorkspaceConnect({
        workspaceId,
        channelType: 'feishu',
        displayName: parsed.data.displayName ?? info.botName,
        externalIdentity: { botUserId: info.botOpenId, teamId: parsed.data.appId },
        defaultAssistantId: parsed.data.defaultAssistantId ?? null,
      })
    } catch (error) {
      const message = (error as Error).message
      console.error('[channels] feishu channel provisioning failed:', error)
      if (message.toLowerCase().includes('workspace')) {
        res.status(400).json({ error: 'defaultAssistantId must belong to this workspace' })
        return
      }
      res.status(500).json({ error: 'Failed to provision channel' })
      return
    }

    try {
      await opts.integrationStore.upsert({
        channelId: provisioned.channelId,
        channelType: 'feishu',
        teamId: parsed.data.appId,
        teamName: info.botName,
        botUserId: info.botOpenId,
        botUsername: null,
        credentials: {
          app_id: parsed.data.appId,
          app_secret: parsed.data.appSecret,
          brand: parsed.data.brand,
        },
        actingUserId: userId,
      })
    } catch (error) {
      console.error('[channels] feishu integration upsert failed:', error)
      res.status(500).json({ error: 'Failed to save integration' })
      return
    }

    let connectorError: string | null = null
    try {
      await opts.feishuConnector.connect(provisioned.channelId, {
        appId: parsed.data.appId,
        appSecret: parsed.data.appSecret,
        brand: parsed.data.brand,
      })
    } catch (error) {
      connectorError = (error as Error).message
      console.error('[channels] feishu connector connect failed:', error)
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
      botOpenId: info.botOpenId,
      botName: info.botName,
      brand: parsed.data.brand,
      connectorError,
    })
  })

  // POST /workspaces/:workspaceId/channels/msteams — Microsoft Teams BYO
  // connect. Validates the Azure Bot credentials by minting a Bot Connector
  // token, find-or-creates the workspace channel, and upserts the encrypted
  // credentials. Returns the messaging-endpoint URL the operator must paste
  // into their Azure Bot. See docs/architecture/channels/msteams.md.
  router.post('/workspaces/:workspaceId/channels/msteams', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { workspaceId } = req.params

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }

    if (!opts.integrationStore) {
      res.status(503).json({ error: 'Channel integrations are not configured on this server' })
      return
    }

    const parsed = connectMsTeamsSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', detail: parsed.error.message })
      return
    }

    let info
    try {
      info = await validateMsTeamsCredentials({
        appId: parsed.data.appId,
        appPassword: parsed.data.appPassword,
        tenantId: parsed.data.tenantId,
      })
    } catch (err) {
      // A successful token mint proves the app registration + secret + tenant.
      // It does NOT prove the Teams app is installed/reachable — that flips to
      // "Connected" on the first inbound Activity (last_event_at).
      res.status(400).json({ error: 'Azure rejected the Teams bot credentials', detail: (err as Error).message })
      return
    }

    let provisioned
    try {
      provisioned = await findOrCreateChannelForWorkspaceConnect({
        workspaceId,
        channelType: 'msteams',
        displayName: parsed.data.displayName ?? 'Microsoft Teams',
        externalIdentity: { botUserId: info.botId },
        defaultAssistantId: parsed.data.defaultAssistantId ?? null,
      })
    } catch (err) {
      const msg = (err as Error).message
      console.error('[channels] msteams channel provisioning failed:', err)
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
        channelType: 'msteams',
        teamId: parsed.data.tenantId,
        teamName: parsed.data.displayName ?? 'Microsoft Teams',
        botUserId: info.botId,
        botUsername: null,
        credentials: {
          app_id: parsed.data.appId,
          app_password: parsed.data.appPassword,
          tenant_id: parsed.data.tenantId,
        },
        actingUserId: userId,
      })
      // Pair a connector_instance so passive ingest has a CI to route against.
      // Idempotent on re-install; non-fatal (ingest degrades, chat is unaffected).
      try {
        await ensureMsTeamsConnectorInstance({ channelIntegrationId: integration.id, actingUserId: userId })
      } catch (err) {
        console.error('[channels] msteams CI provisioning failed:', err)
      }
    } catch (err) {
      console.error('[channels] msteams integration upsert failed:', err)
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
      // The messaging-endpoint URL the operator pastes into their Azure Bot.
      webhookPath: `/webhook/msteams/${provisioned.channelId}`,
      webhookUrl: opts.apiUrl ? `${opts.apiUrl}/webhook/msteams/${provisioned.channelId}` : null,
    })
  })

  // POST /workspaces/:workspaceId/channels/whatsapp-cloud — official Meta
  // Cloud API transport. The operator registers the returned callback URL and
  // verify token in Meta's WhatsApp webhook settings.
  router.post('/workspaces/:workspaceId/channels/whatsapp-cloud', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { workspaceId } = req.params
    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }
    if (!opts.integrationStore) {
      res.status(503).json({ error: 'Channel integrations are not configured on this server' })
      return
    }

    const parsed = connectWhatsAppCloudSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', detail: parsed.error.message })
      return
    }

    const graphOptions = {
      accessToken: parsed.data.accessToken,
      phoneNumberId: parsed.data.phoneNumberId,
      graphApiVersion: parsed.data.graphApiVersion,
    }
    let info
    try {
      info = await validateWhatsAppCloudCredentials(graphOptions)
    } catch (err) {
      res.status(400).json({ error: 'Meta rejected the WhatsApp credentials', detail: (err as Error).message })
      return
    }

    try {
      await subscribeWhatsAppCloudApp(graphOptions, parsed.data.wabaId)
    } catch (err) {
      res.status(400).json({
        error: 'Meta could not subscribe the app to this WhatsApp Business Account',
        detail: (err as Error).message,
      })
      return
    }

    let provisioned
    try {
      provisioned = await findOrCreateChannelForWorkspaceConnect({
        workspaceId,
        channelType: 'whatsapp',
        displayName: parsed.data.displayName ?? `${info.verifiedName} (${info.displayPhoneNumber})`,
        // phone_number_id is globally stable and distinguishes Cloud API rows
        // from linked-number rows, whose botUserId is null.
        externalIdentity: { botUserId: info.id },
        defaultAssistantId: parsed.data.defaultAssistantId ?? null,
        // Free-form Cloud API messages are valid only inside Meta's 24-hour
        // customer-service window. Do not advertise proactive broadcast until
        // template-message delivery is implemented.
        enabledCapabilities: ['chat'],
      })
    } catch (err) {
      const msg = (err as Error).message
      console.error('[channels] WhatsApp Cloud channel provisioning failed:', err)
      if (msg.toLowerCase().includes('workspace')) {
        res.status(400).json({ error: 'defaultAssistantId must belong to this workspace' })
        return
      }
      res.status(500).json({ error: 'Failed to provision channel' })
      return
    }

    const verifyToken = parsed.data.verifyToken ?? randomBytes(32).toString('hex')
    try {
      const integration = await opts.integrationStore.upsert({
        channelId: provisioned.channelId,
        channelType: 'whatsapp',
        teamId: parsed.data.wabaId,
        teamName: info.verifiedName,
        botUserId: info.id,
        botUsername: null,
        credentials: {
          provider: 'cloud_api',
          access_token: parsed.data.accessToken,
          app_secret: parsed.data.appSecret,
          verify_token: verifyToken,
          phone_number_id: info.id,
          waba_id: parsed.data.wabaId,
          display_phone_number: info.displayPhoneNumber,
          graph_api_version: parsed.data.graphApiVersion,
        },
        actingUserId: userId,
      })
      // A public business number is fail-closed. Operators explicitly add
      // phone numbers before those callers can reach Brian. Keep the public
      // number in non-secret config so Studio can render a persistent chat QR.
      await opts.integrationStore.updateConfig({
        actingUserId: userId,
        id: integration.id,
        config: {
          ...integration.config,
          ...(!provisioned.reused ? { userAccessMode: 'allowlist' as const, allowedUserIds: [] } : {}),
          whatsappDisplayPhoneNumber: info.displayPhoneNumber,
        },
      })
    } catch (err) {
      console.error('[channels] WhatsApp Cloud integration upsert failed:', err)
      res.status(500).json({ error: 'Failed to save integration' })
      return
    }

    const channel = await getChannelForUser(userId, provisioned.channelId)
    if (!channel) {
      res.status(500).json({ error: 'Channel created but no longer visible' })
      return
    }
    const integrations = await loadIntegrations(userId, workspaceId)
    const webhookPath = `/webhook/whatsapp/${provisioned.channelId}`
    res.status(provisioned.reused ? 200 : 201).json({
      channel: serializeChannel(channel, integrations.get(provisioned.channelId)),
      reused: provisioned.reused,
      displayPhoneNumber: info.displayPhoneNumber,
      webhookPath,
      webhookUrl: opts.apiUrl ? `${opts.apiUrl}${webhookPath}` : null,
      verifyToken,
    })
  })

  // ── Custom — bridge-driven channel ─────────────────────────────
  //
  // A custom channel's platform is driven by an operator-run bridge process
  // that talks to `/bridge/v1/channels/:channelId` with a bearer token. This
  // surface mints the channel + integration (the token is returned ONCE; only
  // its SHA-256 hash is stored in the encrypted credentials), rotates the
  // token, reads the bridge's published state, answers an `input` action,
  // and disconnects. See docs/architecture/channels/custom-channel.md.

  // POST /workspaces/:workspaceId/channels/custom — create + mint the token.
  router.post('/workspaces/:workspaceId/channels/custom', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { workspaceId } = req.params

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }
    if (!opts.integrationStore || !opts.customChannelStore) {
      res.status(503).json({ error: 'Custom channels are not configured on this server' })
      return
    }

    const parsed = connectCustomSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', detail: parsed.error.message })
      return
    }

    // Each create is a fresh channel: the bot identity is a minted UUID, so
    // the re-install lookup never matches an existing row.
    const botUserId = `custom:${randomUUID()}`
    let provisioned
    try {
      provisioned = await findOrCreateChannelForWorkspaceConnect({
        workspaceId,
        channelType: 'custom',
        displayName: parsed.data.displayName,
        externalIdentity: { botUserId },
        defaultAssistantId: parsed.data.defaultAssistantId ?? null,
      })
    } catch (err) {
      const msg = (err as Error).message
      console.error('[channels] custom channel provisioning failed:', err)
      if (msg.toLowerCase().includes('workspace')) {
        res.status(400).json({ error: 'defaultAssistantId must belong to this workspace' })
        return
      }
      res.status(500).json({ error: 'Failed to provision channel' })
      return
    }

    const bridgeToken = mintBridgeToken()
    try {
      await opts.integrationStore.upsert({
        channelId: provisioned.channelId,
        channelType: 'custom',
        teamId: null,
        teamName: parsed.data.kind ?? null,
        botUserId,
        botUsername: null,
        credentials: {
          bridge_token_hash: hashBridgeToken(bridgeToken),
          ...(parsed.data.kind ? { kind: parsed.data.kind } : {}),
        },
        actingUserId: userId,
      })
    } catch (err) {
      console.error('[channels] custom integration upsert failed:', err)
      res.status(500).json({ error: 'Failed to save integration' })
      return
    }

    // Seed the state row so Studio shows "connecting / bridge offline"
    // instead of nothing until the bridge first calls in.
    await opts.customChannelStore.putState(provisioned.channelId, {
      status: 'connecting',
      message: 'Waiting for the bridge to connect.',
    }).catch((err) => console.error('[channels] custom state seed failed:', err))

    const channel = await getChannelForUser(userId, provisioned.channelId)
    res.status(201).json({
      channel: channel ? serializeChannel(channel) : null,
      bridgeToken,
      kind: parsed.data.kind ?? null,
    })
  })

  // POST /workspaces/:workspaceId/channels/:channelId/custom/rotate-token
  router.post('/workspaces/:workspaceId/channels/:channelId/custom/rotate-token', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { workspaceId, channelId } = req.params

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }
    if (!opts.integrationStore) {
      res.status(503).json({ error: 'Custom channels are not configured on this server' })
      return
    }

    const channel = await loadChannel(userId, workspaceId, channelId, res)
    if (!channel) return
    if (channel.channelType !== 'custom') { res.status(400).json({ error: 'Not a custom channel' }); return }

    const integrations = await loadIntegrations(userId, workspaceId)
    const existing = integrations.get(channelId)
    if (!existing) { res.status(404).json({ error: 'Channel integration not found' }); return }
    const current = await opts.integrationStore.getForUserWithCredentials(userId, existing.id)
    const currentCreds = (current?.credentials ?? {}) as { kind?: string }

    const bridgeToken = mintBridgeToken()
    try {
      await opts.integrationStore.upsert({
        channelId,
        channelType: 'custom',
        teamId: existing.teamId,
        teamName: existing.teamName,
        botUserId: existing.botUserId,
        botUsername: existing.botUsername,
        credentials: {
          bridge_token_hash: hashBridgeToken(bridgeToken),
          ...(currentCreds.kind ? { kind: currentCreds.kind } : {}),
        },
        actingUserId: userId,
      })
    } catch (err) {
      console.error('[channels] custom token rotation failed:', err)
      res.status(500).json({ error: 'Failed to rotate token' })
      return
    }
    res.json({ bridgeToken })
  })

  // GET /workspaces/:workspaceId/channels/:channelId/custom/state
  router.get('/workspaces/:workspaceId/channels/:channelId/custom/state', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { workspaceId, channelId } = req.params

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }
    if (!opts.customChannelStore) {
      res.status(503).json({ error: 'Custom channels are not configured on this server' })
      return
    }

    const channel = await loadChannel(userId, workspaceId, channelId, res)
    if (!channel) return
    if (channel.channelType !== 'custom') { res.status(400).json({ error: 'Not a custom channel' }); return }

    const state = await opts.customChannelStore.getState(channelId)
    res.json({
      state: state ?? {
        channelId,
        status: 'connecting',
        lastSeenAt: null,
        updatedAt: null,
        online: false,
        outboxDepth: 0,
      },
    })
  })

  // POST /workspaces/:workspaceId/channels/:channelId/custom/input
  router.post('/workspaces/:workspaceId/channels/:channelId/custom/input', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { workspaceId, channelId } = req.params

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }
    if (!opts.customChannelStore) {
      res.status(503).json({ error: 'Custom channels are not configured on this server' })
      return
    }

    const parsed = customInputSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', detail: parsed.error.message })
      return
    }

    const channel = await loadChannel(userId, workspaceId, channelId, res)
    if (!channel) return
    if (channel.channelType !== 'custom') { res.status(400).json({ error: 'Not a custom channel' }); return }

    const id = await opts.customChannelStore.enqueue(channelId, {
      type: 'input',
      peerId: null,
      payload: { requestId: parsed.data.requestId, value: parsed.data.value },
    })
    res.json({ ok: true, itemId: id })
  })

  // POST /workspaces/:workspaceId/channels/:channelId/custom/disconnect
  router.post('/workspaces/:workspaceId/channels/:channelId/custom/disconnect', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { workspaceId, channelId } = req.params

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }
    if (!opts.customChannelStore) {
      res.status(503).json({ error: 'Custom channels are not configured on this server' })
      return
    }

    const channel = await loadChannel(userId, workspaceId, channelId, res)
    if (!channel) return
    if (channel.channelType !== 'custom') { res.status(400).json({ error: 'Not a custom channel' }); return }

    await opts.customChannelStore.enqueue(channelId, { type: 'disconnect', peerId: null, payload: {} })
    await opts.customChannelStore.putState(channelId, {
      status: 'disconnected',
      message: 'Disconnect requested from Studio.',
    })
    res.json({ ok: true })
  })

  // ── WeChat — BYON iLink bot, QR pairing ─────────────────────────
  //
  // Unlike the token-paste platforms, WeChat binds a bot identity by QR scan:
  // start opens a pairing session on the wechat-connector bridge, the client
  // polls status (rendering the returned URL as a QR), and on iLink's confirm
  // THIS route persists the returned credentials (channel + encrypted
  // integration row), then tells the bridge to open the long-poll loop. The
  // bot token only ever moves bridge → API — never to the browser. iLink may
  // also demand a pairing code mid-flow (`need_verifycode`); the client
  // submits it via the verify-code endpoint. See
  // docs/architecture/channels/wechat.md → "Connect flow".

  // Pairing sessions this API instance started: remembers the connect params
  // and memoizes the finalize result so repeat polls stay idempotent.
  const wechatPairings = new Map<string, {
    workspaceId: string
    userId: string
    defaultAssistantId: string | null
    startedAt: number
    finalized?: { channelId: string; connectorError: string | null }
  }>()
  const WECHAT_PAIRING_TTL_MS = 15 * 60_000

  function purgeWechatPairings(): void {
    const now = Date.now()
    for (const [id, p] of wechatPairings) {
      if (now - p.startedAt > WECHAT_PAIRING_TTL_MS) wechatPairings.delete(id)
    }
  }

  // POST /workspaces/:workspaceId/channels/wechat/pairing — start QR pairing.
  router.post('/workspaces/:workspaceId/channels/wechat/pairing', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { workspaceId } = req.params

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }

    if (!opts.integrationStore) {
      res.status(503).json({ error: 'Channel integrations are not configured on this server' })
      return
    }
    if (!opts.wechatConnector) {
      res.status(503).json({ error: 'WeChat connect requires the iLink connector to be configured' })
      return
    }

    const parsed = wechatPairStartSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', detail: parsed.error.message })
      return
    }

    purgeWechatPairings()
    let started
    try {
      started = await opts.wechatConnector.startPairing()
    } catch (err) {
      console.error('[channels] wechat pairing start failed:', err)
      res.status(502).json({ error: 'Failed to start WeChat pairing' })
      return
    }
    wechatPairings.set(started.pairingId, {
      workspaceId,
      userId,
      defaultAssistantId: parsed.data.defaultAssistantId ?? null,
      startedAt: Date.now(),
    })
    res.status(201).json({ pairingId: started.pairingId, qrcodeUrl: started.qrcodeUrl, status: 'qr' })
  })

  // GET /workspaces/:workspaceId/channels/wechat/pairing/:pairingId — poll.
  // On `confirmed`, finalizes: channel row + encrypted credentials + long-poll
  // start. Credentials never reach the response.
  router.get('/workspaces/:workspaceId/channels/wechat/pairing/:pairingId', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { workspaceId, pairingId } = req.params

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }

    const pairing = wechatPairings.get(pairingId)
    if (!pairing || pairing.workspaceId !== workspaceId) {
      res.status(404).json({ error: 'Unknown or expired pairing' })
      return
    }
    if (!opts.integrationStore || !opts.wechatConnector) {
      res.status(503).json({ error: 'WeChat connect is not configured on this server' })
      return
    }

    // Idempotent repeat poll after a finalized confirm.
    if (pairing.finalized) {
      const channel = await getChannelForUser(userId, pairing.finalized.channelId)
      res.json({
        status: 'connected',
        channel: channel ? serializeChannel(channel) : null,
        connectorError: pairing.finalized.connectorError,
      })
      return
    }

    let snapshot
    try {
      snapshot = await opts.wechatConnector.pairingStatus(pairingId)
    } catch (err) {
      console.error('[channels] wechat pairing status failed:', err)
      res.status(502).json({ error: 'Failed to reach the WeChat connector' })
      return
    }
    if (!snapshot) {
      wechatPairings.delete(pairingId)
      res.status(404).json({ error: 'Unknown or expired pairing' })
      return
    }

    if (snapshot.status !== 'confirmed' || !snapshot.result) {
      res.json({
        status: snapshot.status,
        qrcodeUrl: snapshot.qrcodeUrl ?? null,
        error: snapshot.error ?? null,
      })
      return
    }

    // Confirmed: persist and start the poller.
    const result = snapshot.result
    let provisioned
    try {
      provisioned = await findOrCreateChannelForWorkspaceConnect({
        workspaceId,
        channelType: 'wechat',
        displayName: `WeChat bot ${result.ilinkBotId.split('@')[0]}`,
        externalIdentity: { botUserId: result.ilinkBotId },
        defaultAssistantId: pairing.defaultAssistantId,
      })
    } catch (err) {
      const msg = (err as Error).message
      console.error('[channels] wechat channel provisioning failed:', err)
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
        channelType: 'wechat',
        teamId: null,
        teamName: result.ilinkBotId,
        botUserId: result.ilinkBotId,
        botUsername: null,
        credentials: {
          bot_token: result.botToken,
          base_url: result.baseUrl,
          ilink_bot_id: result.ilinkBotId,
          ...(result.boundUserId ? { bound_user_id: result.boundUserId } : {}),
          get_updates_buf: '',
        },
        actingUserId: userId,
      })
    } catch (err) {
      console.error('[channels] wechat integration upsert failed:', err)
      res.status(500).json({ error: 'Failed to save integration' })
      return
    }

    // Open the long-poll loop for this bot. Non-fatal on failure: the
    // integration is persisted, so the connector's restoreAll picks it up on
    // its next boot — but report it so the UI can prompt a retry.
    let connectorError: string | null = null
    try {
      await opts.wechatConnector.connect(provisioned.channelId, {
        botToken: result.botToken,
        baseUrl: result.baseUrl,
      })
    } catch (err) {
      connectorError = (err as Error).message
      console.error('[channels] wechat connector connect failed:', err)
    }

    pairing.finalized = { channelId: provisioned.channelId, connectorError }

    const channel = await getChannelForUser(userId, provisioned.channelId)
    res.json({
      status: 'connected',
      channel: channel ? serializeChannel(channel) : null,
      reused: provisioned.reused,
      connectorError,
    })
  })

  // POST /workspaces/:workspaceId/channels/wechat/pairing/:pairingId/verify-code
  // — forward the pairing digits iLink asked for (`need_verifycode`).
  router.post('/workspaces/:workspaceId/channels/wechat/pairing/:pairingId/verify-code', async (req, res) => {
    const userId = (req as { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const { workspaceId, pairingId } = req.params

    const role = await opts.workspaceStore.getRole(userId, workspaceId)
    if (!role) { res.status(403).json({ error: 'Not a member of this workspace' }); return }

    const pairing = wechatPairings.get(pairingId)
    if (!pairing || pairing.workspaceId !== workspaceId) {
      res.status(404).json({ error: 'Unknown or expired pairing' })
      return
    }
    if (!opts.wechatConnector) {
      res.status(503).json({ error: 'WeChat connect is not configured on this server' })
      return
    }

    const parsed = wechatVerifyCodeSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid input', detail: parsed.error.message })
      return
    }

    try {
      await opts.wechatConnector.submitVerifyCode(pairingId, parsed.data.code)
    } catch (err) {
      console.error('[channels] wechat verify-code failed:', err)
      res.status(502).json({ error: 'Failed to submit the code' })
      return
    }
    res.json({ ok: true })
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

    const integrations = await loadIntegrations(userId, workspaceId)
    const channelIntegration = integrations.get(channelId)
    const isWhatsAppCloud = channel.channelType === 'whatsapp' && channelIntegration
      ? ((await opts.integrationStore?.getForUserWithCredentials(userId, channelIntegration.id))?.credentials as { provider?: string } | undefined)?.provider === 'cloud_api'
      : false

    if (channel.channelType === 'whatsapp' && !isWhatsAppCloud && opts.whatsappConnector) {
      await opts.whatsappConnector.disconnect(channelId).catch((err) => {
        console.error('[channels] whatsapp connector disconnect failed:', err)
      })
    }

    if (channel.channelType === 'whatsapp' && !isWhatsAppCloud) {
      await query('DELETE FROM wa_auth_state WHERE channel_id = $1', [channelId])
    }

    // A custom channel's bridge learns about the delete from a `disconnect`
    // outbox item — enqueue it BEFORE the cascade (the outbox row goes with
    // the channel, so the bridge must already be holding it or see a 404 on
    // its next poll; both stop it). Best-effort, never fails the delete.
    if (channel.channelType === 'custom' && opts.customChannelStore) {
      await opts.customChannelStore.enqueue(channelId, { type: 'disconnect', peerId: null, payload: {} })
        .catch((err) => console.error('[channels] custom disconnect enqueue failed:', err))
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

    if (channel.channelType === 'feishu' && opts.feishuConnector) {
      opts.feishuConnector.disconnect(channelId).catch((err) => {
        console.error('[channels] feishu connector disconnect failed:', err)
      })
    }

    // Same for WeChat: stop the iLink long-poll loop immediately (best-effort;
    // restoreAll would skip the deleted channel anyway). The per-contact
    // context tokens cascade with the channels row (migration 362 FK).
    if (channel.channelType === 'wechat' && opts.wechatConnector) {
      opts.wechatConnector.disconnect(channelId).catch((err) => {
        console.error('[channels] wechat connector disconnect failed:', err)
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
