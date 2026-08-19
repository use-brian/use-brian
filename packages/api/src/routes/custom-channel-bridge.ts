/**
 * Custom channel bridge route — the API-side half of the bridge protocol (v1).
 *
 * Mounted at `/bridge/v1/channels` (deliberately NOT under `/api`, so it never
 * sits behind a bare `app.use('/api', requireAuth(…))` guard). An operator-run
 * bridge process authenticates every call with `Authorization: Bearer <bridge
 * token>`; the token is compared constant-time against the hash stored in the
 * channel's `channel_integrations.credentials` and a mismatch is a bare 401.
 * `:channelId` is the workspace `channels.id`; a missing or non-active channel
 * is a 404 and the bridge must stop.
 *
 *   GET  /:channelId/hello        — token check + channel facts
 *   PUT  /:channelId/state        — publish bridge state (last write wins)
 *   POST /:channelId/inbound      — one normalized inbound message → the turn
 *   GET  /:channelId/outbox       — long-poll for leased outbound items
 *   POST /:channelId/outbox/ack   — settle leased items
 *   POST /:channelId/heartbeat    — bump last_seen_at
 *
 * Inbound mirrors the other BYO routes (`routes/wechat.ts` is the closest
 * precedent): channel active + chat capability, `isSelf` → archived as
 * outbound and never answered, group + requireMention + not mentioned →
 * archived, access control → archived (never dropped), routing → archived
 * when nobody answers, tier-2 shadow user keyed `custom:<channelId>:<senderId>`,
 * `withChatLock('custom:<channelId>:<peerId>')`, then `processChannelMessage`
 * with text-only confirmations (yes / no / always / never — a bridge has no
 * buttons). Replies go through the custom adapter, which enqueues outbox
 * items the bridge pulls. The 200 is sent BEFORE the turn runs.
 *
 * See docs/architecture/channels/custom-channel.md.
 * Component tag: [COMP:api/custom-channel-bridge].
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { z } from 'zod'
import {
  createCustomAdapter,
  bridgeInboundOversize,
  CUSTOM_CHANNEL_PROTOCOL_VERSION,
  BRIDGE_INBOUND_TEXT_MAX_BYTES,
  BRIDGE_INBOUND_MEDIA_MAX_ITEMS,
  BRIDGE_INBOUND_MEDIA_MAX_BYTES,
  type BridgeInbound,
  type BridgeInboundMedia,
  type BridgeInboundMessage,
  type BridgeHello,
  type BridgeState,
  type OutboxAck,
  type OutboxItem,
} from '@use-brian/channels'
import type { IncomingMessage } from '@use-brian/channels'
import { parseFileContent, sanitize as sanitizeAnalytics } from '@use-brian/core'
import type { ConfirmationDecision, ConfirmationResolver, ContentBlock } from '@use-brian/core'
import type { LLMProvider, Tool, MemoryStore, UsageStore, AnalyticsLogger, McpSettingsStore } from '@use-brian/core'
import { getToolDisplayName, formatConfirmationInput } from '@use-brian/shared'
import { findAssistantById } from '../db/users.js'
import { withChatLock } from '../db/chat-lock.js'
import { resolveChannelUser, type ChannelUserStore } from '../db/channel-user-store.js'
import { resolveRoutingForSurface, getChannelForWebhook, type Channel } from '../db/channels-store.js'
import type {
  ChannelIntegrationStore,
  ChannelIntegrationConfig,
  ChannelIntegrationWithCredentials,
  CustomChannelCredentials,
} from '../db/channel-integrations.js'
import type { CustomChannelStore } from '../db/custom-channel-store.js'
import { bridgeTokenMatches } from '../db/custom-channel-token.js'
import type { ConnectorStore } from '../db/connector-store.js'
import { query } from '../db/client.js'
import { processChannelMessage } from './channel-pipeline.js'
import { channelUserErrorText } from './_channel-error-text.js'
import { cacheInboundImageTag } from './channel-file-cache.js'
import { billingPartyForAssistant } from '../billing-party.js'
import type { ChatArchiveLiveMedia } from '../chat-archive/live-media.js'
import { archiveMediaRef } from '../chat-archive/live-media.js'
import {
  resolveChatArchiveInstanceId,
  archiveUnroutedInbound,
  appendOutboundChatArchive,
} from '../chat-archive/live-writer.js'

export type CustomChannelBridgeRouteOptions = {
  /** Servable background-lane model, resolved at boot; forwarded to the
   * channel pipeline so its background calls work without a Google key. */
  backgroundModel?: string
  provider: LLMProvider
  configuredProviders?: import('@use-brian/shared/model-registry').ProviderAvailability
  resolveWorkspaceCustomLlm?: import('../custom-llm-runtime.js').WorkspaceCustomLlmResolver
  systemPrompt: string
  tools: Map<string, Tool>
  memoryStore: MemoryStore
  usageStore?: UsageStore
  checkCreditBudget?: import('./route-helpers.js').CreditBudgetGate
  integrationStore: ChannelIntegrationStore
  customChannelStore: CustomChannelStore
  channelUserStore?: ChannelUserStore
  workerManager?: import('@use-brian/core').WorkerManager
  connectorStore?: ConnectorStore
  mcpSettingsStore?: McpSettingsStore
  assistantConnectorStore?: import('../db/assistant-connector-store.js').AssistantConnectorStore
  connectorGrantStore?: import('../db/connector-grant-store.js').ConnectorGrantStore
  connectorInstanceStore?: import('../db/connector-instance-store.js').ConnectorInstanceStore
  knowledgeStore?: import('@use-brian/core').KnowledgeStoreInterface
  gdriveFilesStore?: import('@use-brian/core').GDriveFilesStore
  workspaceFilesStore?: import('@use-brian/core').WorkspaceFilesStore
  /** Transient upload cache (`file_cache`) — see routes/channel-file-cache.ts. */
  fileStore?: import('@use-brian/core').FileStore
  artifactPromoter?: import('@use-brian/api/files/artifact-promote.js').ArtifactPromoter | null
  analytics?: AnalyticsLogger
  skillStore?: import('../db/skill-store.js').SkillStore
  episodicStore?: import('@use-brian/core').EpisodicStore
  sessionStateStore?: import('@use-brian/core').SessionStateStore
  capabilityStore: import('@use-brian/core').CapabilityStore
  archiveMedia?: ChatArchiveLiveMedia
  /** Injectable clock/sleep for the long-poll (tests). */
  sleep?: (ms: number) => Promise<void>
}

// Natural-language → decision mapping for text-based confirmation (a bridge
// has no buttons — text is the only path). Mirrors routes/wechat.ts.
const DECISION_MAP: Record<string, ConfirmationDecision> = {
  yes: 'allow', y: 'allow', allow: 'allow', approve: 'allow', ok: 'allow',
  no: 'deny', n: 'deny', deny: 'deny', reject: 'deny',
  always: 'always_allow', 'always allow': 'always_allow',
  never: 'always_deny', 'always deny': 'always_deny',
}

/** Long-poll ceiling (ms) — `wait` is clamped to this. */
export const OUTBOX_LONG_POLL_MAX_MS = 30_000
/** Default `wait` when the bridge omits it. */
const OUTBOX_LONG_POLL_DEFAULT_MS = 25_000
/** Claim retry cadence inside a long-poll. */
const OUTBOX_POLL_INTERVAL_MS = 1_000
const OUTBOX_LIMIT_DEFAULT = 20
const OUTBOX_LIMIT_MAX = 100

// Re-enqueue typing at most this often while a turn runs (the outbox is a
// DB table; flooding it with typing rows helps nobody).
const TYPING_REFRESH_MS = 5_000
// URL media fetch budget.
const MEDIA_FETCH_TIMEOUT_MS = 30_000

// ── Wire schemas ────────────────────────────────────────────────
// The channels package is dependency-free, so the zod validators for its
// wire types live here, typed against the exported shapes.

const bridgeActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('qr'),
    imageDataUrl: z.string().max(2 * 1024 * 1024).optional(),
    url: z.string().max(4096).optional(),
    text: z.string().max(4096).optional(),
    expiresAt: z.string().max(64).optional(),
  }),
  z.object({
    kind: z.literal('input'),
    prompt: z.string().min(1).max(2000),
    inputKind: z.enum(['numeric', 'text']),
    requestId: z.string().min(1).max(200),
  }),
  z.object({
    kind: z.literal('confirm_on_device'),
    message: z.string().min(1).max(2000),
  }),
])

export const bridgeStateSchema: z.ZodType<BridgeState> = z.object({
  status: z.enum(['connecting', 'needs_action', 'connected', 'disconnected', 'error']),
  message: z.string().max(2000).optional(),
  accountLabel: z.string().max(500).optional(),
  action: bridgeActionSchema.optional(),
  bridgeVersion: z.string().max(200).optional(),
})

const bridgeInboundMediaSchema = z.object({
  kind: z.enum(['image', 'document', 'voice', 'audio', 'video']),
  mime: z.string().min(1).max(255),
  name: z.string().min(1).max(1024),
  dataBase64: z.string().optional(),
  url: z.string().url().max(4096).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  durationSec: z.number().nonnegative().optional(),
}).refine(
  (m) => (m.dataBase64 != null) !== (m.url != null),
  { message: 'exactly one of dataBase64 / url is required' },
)

export const bridgeInboundSchema: z.ZodType<BridgeInbound> = z.object({
  message: z.object({
    peerId: z.string().min(1).max(512),
    peerName: z.string().max(500).optional(),
    senderId: z.string().min(1).max(512),
    senderName: z.string().max(500).optional(),
    messageId: z.string().min(1).max(512),
    // Character cap here; the UTF-8 byte cap is enforced by bridgeInboundOversize.
    text: z.string().max(BRIDGE_INBOUND_TEXT_MAX_BYTES),
    timestamp: z.number(),
    isGroupChat: z.boolean(),
    isMentioned: z.boolean().optional(),
    isSelf: z.boolean().optional(),
    replyToMessageId: z.string().max(512).optional(),
    media: z.array(bridgeInboundMediaSchema).max(BRIDGE_INBOUND_MEDIA_MAX_ITEMS).optional(),
  }),
})

export const outboxAckSchema: z.ZodType<OutboxAck> = z.object({
  results: z.array(z.object({
    id: z.string().uuid(),
    ok: z.boolean(),
    error: z.string().max(2000).optional(),
    providerMessageId: z.string().max(512).optional(),
  })).max(500),
})

const heartbeatSchema = z.object({}).passthrough()

// ── Helpers ─────────────────────────────────────────────────────

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization
  if (typeof header !== 'string') return null
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match ? match[1] : null
}

type BridgeContext = {
  channel: Channel
  integration: ChannelIntegrationWithCredentials
  credentials: CustomChannelCredentials
  config: ChannelIntegrationConfig
}

function bridgeContext(res: Response): BridgeContext {
  return res.locals.bridge as BridgeContext
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

async function workspaceOwnerId(workspaceId: string): Promise<string | null> {
  const result = await query<{ owner_user_id: string }>(
    `SELECT owner_user_id FROM workspaces WHERE id = $1 LIMIT 1`,
    [workspaceId],
  )
  return result.rows[0]?.owner_user_id ?? null
}

/** Resolve one inline-or-URL media item to bytes, honoring the 25 MB cap. */
async function loadMediaBytes(item: BridgeInboundMedia): Promise<Buffer> {
  if (item.dataBase64 != null) {
    const bytes = Buffer.from(item.dataBase64, 'base64')
    if (bytes.length > BRIDGE_INBOUND_MEDIA_MAX_BYTES) throw new Error('media item exceeds the inline limit')
    return bytes
  }
  if (!item.url) throw new Error('media item carries neither dataBase64 nor url')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MEDIA_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(item.url, { signal: controller.signal, redirect: 'follow' })
    if (!res.ok) throw new Error(`media fetch failed: HTTP ${res.status}`)
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (declared > BRIDGE_INBOUND_MEDIA_MAX_BYTES) throw new Error('media item exceeds the fetch limit')
    const chunks: Buffer[] = []
    let total = 0
    const reader = res.body?.getReader()
    if (!reader) throw new Error('media fetch returned no body')
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > BRIDGE_INBOUND_MEDIA_MAX_BYTES) {
        await reader.cancel().catch(() => {})
        throw new Error('media item exceeds the fetch limit')
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
  } finally {
    clearTimeout(timer)
  }
}

function toOutboxItem(item: { id: string; type: string; peerId: string | null; payload: Record<string, unknown>; createdAt: string }): OutboxItem {
  return item as unknown as OutboxItem
}

// ── Router ──────────────────────────────────────────────────────

export function customChannelBridgeRoutes(options: CustomChannelBridgeRouteOptions): Router {
  const router = Router()
  const store = options.customChannelStore
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  // Pending text-based tool confirmations, keyed by `channelId:peerId`.
  const pendingConfirmations = new Map<string, { resolver: ConfirmationResolver; toolCallId: string }>()

  // ── Bridge token auth — loads the channel + integration once per request.
  const auth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const rawChannelId = req.params.channelId
    const channelId = Array.isArray(rawChannelId) ? rawChannelId[0] : rawChannelId
    if (!channelId) { res.status(404).json({ error: 'channel_not_found' }); return }
    const token = bearerToken(req)
    try {
      const channel = await getChannelForWebhook(channelId)
      if (!channel || channel.channelType !== 'custom' || channel.status !== 'active') {
        res.status(404).json({ error: 'channel_not_found' })
        return
      }
      const integration = await options.integrationStore.getByChannelForWebhook(channelId, 'custom')
      if (!integration) {
        res.status(404).json({ error: 'channel_not_found' })
        return
      }
      const credentials = integration.credentials as CustomChannelCredentials
      if (!bridgeTokenMatches(token, credentials.bridge_token_hash)) {
        res.status(401).end()
        return
      }
      res.locals.bridge = {
        channel,
        integration,
        credentials,
        config: (integration.config ?? {}) as ChannelIntegrationConfig,
      } satisfies BridgeContext
      next()
    } catch (err) {
      console.error(`[custom-channel] auth failed for channel ${channelId}:`, err)
      res.status(500).json({ error: 'internal_error' })
    }
  }
  router.use('/:channelId', auth)

  // ── GET /hello ──────────────────────────────────────────────
  router.get('/:channelId/hello', async (_req, res) => {
    const { channel, credentials, config } = bridgeContext(res)
    await store.touchSeen(channel.id).catch((err) => console.error('[custom-channel] touchSeen failed:', err))
    const hello: BridgeHello = {
      channelId: channel.id,
      workspaceId: channel.workspaceId,
      displayName: channel.displayName ?? null,
      kind: credentials.kind ?? null,
      config: {
        requireMention: config.requireMention ?? true,
        userAccessMode: config.userAccessMode ?? 'allow_all',
      },
      protocol: CUSTOM_CHANNEL_PROTOCOL_VERSION,
      serverTime: new Date().toISOString(),
    }
    res.json(hello)
  })

  // ── PUT /state ──────────────────────────────────────────────
  router.put('/:channelId/state', async (req, res) => {
    const { channel } = bridgeContext(res)
    const parsed = bridgeStateSchema.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'bad_payload', detail: parsed.error.message }); return }
    try {
      await store.putState(channel.id, parsed.data)
      res.json({ ok: true })
    } catch (err) {
      console.error(`[custom-channel] putState failed for channel ${channel.id}:`, err)
      res.status(500).json({ error: 'internal_error' })
    }
  })

  // ── POST /heartbeat ─────────────────────────────────────────
  router.post('/:channelId/heartbeat', async (req, res) => {
    const { channel } = bridgeContext(res)
    if (req.body != null && !heartbeatSchema.safeParse(req.body).success) {
      res.status(400).json({ error: 'bad_payload' })
      return
    }
    try {
      await store.touchSeen(channel.id)
      res.json({ ok: true })
    } catch (err) {
      console.error(`[custom-channel] heartbeat failed for channel ${channel.id}:`, err)
      res.status(500).json({ error: 'internal_error' })
    }
  })

  // ── GET /outbox — long-poll ─────────────────────────────────
  router.get('/:channelId/outbox', async (req, res) => {
    const { channel } = bridgeContext(res)
    const wait = clampInt(req.query.wait, OUTBOX_LONG_POLL_DEFAULT_MS, 0, OUTBOX_LONG_POLL_MAX_MS)
    const limit = clampInt(req.query.limit, OUTBOX_LIMIT_DEFAULT, 1, OUTBOX_LIMIT_MAX)
    let closed = false
    res.on('close', () => { closed = true })
    try {
      await store.touchSeen(channel.id)
      // Drop what a dead bridge left behind before leasing anything — 24 h
      // old replies must never fire on resurrection.
      const expired = await store.expireStale(channel.id)
      for (const e of expired) {
        if (e.count > 0) {
          console.warn(`[custom-channel] dropped ${e.count} expired outbox item(s) for channel ${e.channelId}`)
          const ownerId = await workspaceOwnerId(channel.workspaceId).catch(() => null)
          if (ownerId) {
            options.analytics?.logEvent({
              userId: ownerId,
              eventName: 'custom_channel.outbox_expired',
              channelType: 'custom',
              metadata: { channel_id: sanitizeAnalytics(e.channelId), count: e.count },
            })
          }
        }
      }
      const deadline = Date.now() + wait
      for (;;) {
        const items = await store.claim(channel.id, limit)
        if (items.length > 0) {
          res.json({ items: items.map(toOutboxItem) })
          return
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0 || closed) break
        await sleep(Math.min(OUTBOX_POLL_INTERVAL_MS, remaining))
      }
      if (!closed) res.json({ items: [] })
    } catch (err) {
      console.error(`[custom-channel] outbox poll failed for channel ${channel.id}:`, err)
      if (!closed) res.status(500).json({ error: 'internal_error' })
    }
  })

  // ── POST /outbox/ack ────────────────────────────────────────
  router.post('/:channelId/outbox/ack', async (req, res) => {
    const { channel } = bridgeContext(res)
    const parsed = outboxAckSchema.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'bad_payload', detail: parsed.error.message }); return }
    try {
      const settled = await store.ack(channel.id, parsed.data.results)
      const failed = parsed.data.results.filter((r) => !r.ok)
      if (failed.length > 0) {
        console.warn(`[custom-channel] bridge reported ${failed.length} failed outbox item(s) for channel ${channel.id}`)
        const ownerId = await workspaceOwnerId(channel.workspaceId).catch(() => null)
        if (ownerId) {
          options.analytics?.logEvent({
            userId: ownerId,
            eventName: 'custom_channel.outbox_failed',
            channelType: 'custom',
            metadata: { channel_id: sanitizeAnalytics(channel.id), count: failed.length },
          })
        }
      }
      res.json({ ok: true, settled })
    } catch (err) {
      console.error(`[custom-channel] outbox ack failed for channel ${channel.id}:`, err)
      res.status(500).json({ error: 'internal_error' })
    }
  })

  // ── POST /inbound ───────────────────────────────────────────
  router.post('/:channelId/inbound', async (req, res) => {
    const { channel, integration, config } = bridgeContext(res)
    const channelId = channel.id
    const parsed = bridgeInboundSchema.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'bad_payload', detail: parsed.error.message }); return }
    const oversize = bridgeInboundOversize(parsed.data)
    if (oversize) { res.status(413).json({ error: 'payload_too_large', detail: oversize }); return }

    const msg = parsed.data.message
    const peerId = msg.peerId
    const adapter = createCustomAdapter({
      enqueue: (item) => store.enqueue(channelId, { type: item.type, peerId: item.peerId, payload: item.payload }),
    })
    const incoming = adapter.parseIncoming(msg)

    try {
      // 1. Chat capability (the auth middleware already proved active).
      if (!channel.enabledCapabilities.includes('chat')) {
        console.warn(`[custom-channel] channel ${channelId} not accepting chat — dropping inbound`)
        res.status(202).json({ ok: true, archivedOnly: false, dropped: true })
        return
      }

      // 2. The bridge account's own message: archive as outbound, never a turn.
      if (msg.isSelf) {
        await archiveSelfMessage(channel, msg)
        res.status(202).json({ ok: true, archivedOnly: true })
        return
      }

      if (!incoming) {
        // Nothing to say (no text, no media) — acknowledge and move on.
        res.status(202).json({ ok: true, archivedOnly: false, dropped: true })
        return
      }

      const archiveOnly = async (why: string): Promise<void> => {
        await archiveUnroutedInbound({
          source: 'custom',
          workspaceId: channel.workspaceId,
          conversationId: peerId,
          message: incoming,
        }).catch((err: unknown) => console.error('[custom-channel] unrouted archive append failed:', err))
        console.log(`[custom-channel] ${why} for ${peerId} on channel ${channelId} — archived, not answered`)
        res.status(202).json({ ok: true, archivedOnly: true })
      }

      // 3. Group + requireMention (default true) + not mentioned → archived.
      const requireMention = config.requireMention ?? true
      if (msg.isGroupChat && requireMention && !msg.isMentioned) {
        await archiveOnly('unaddressed group message')
        return
      }

      // 4. Access control on the sender — archived, never ignored.
      const accessMode = config.userAccessMode ?? 'allow_all'
      if (accessMode === 'allowlist') {
        const allowed = config.allowedUserIds ?? []
        if (allowed.length > 0 && !allowed.includes(msg.senderId)) {
          await archiveOnly('sender not on the allowlist')
          return
        }
      } else if (accessMode === 'blocklist') {
        const blocked = config.blockedUserIds ?? []
        if (blocked.includes(msg.senderId)) {
          await archiveOnly('sender on the blocklist')
          return
        }
      }

      // 5. Routing (per-peer, else the channel default).
      const routing = await resolveRoutingForSurface(channelId, peerId)
      if (!routing) {
        await archiveOnly('no assistant routing')
        return
      }
      const assistant = await findAssistantById(routing.assistantId)
      if (!assistant) {
        console.error(`[custom-channel] assistant ${routing.assistantId} not found (orphaned routing?)`)
        await archiveOnly('assistant missing')
        return
      }
      const ownerId = await billingPartyForAssistant({
        id: assistant.id,
        ownerUserId: assistant.ownerUserId ?? null,
        workspaceId: assistant.workspaceId ?? null,
      })

      // 6. Sender → tier-2 shadow user, namespaced by channel: two custom
      //    channels may carry overlapping sender ids.
      let channelUserId = ownerId
      let isIdentified = true
      if (options.channelUserStore) {
        try {
          const resolved = await resolveChannelUser(
            options.channelUserStore,
            'custom',
            `${channelId}:${msg.senderId}`,
            routing.assistantId,
            async () => ({
              providerUserId: `${channelId}:${msg.senderId}`,
              email: null,
              displayName: msg.senderName ?? null,
            }),
          )
          channelUserId = resolved.user.id
          isIdentified = resolved.isIdentified
        } catch (err) {
          console.error('[custom-channel] channel user resolution failed, falling back to owner:', err)
        }
      }

      // Ack now — the query loop runs far longer than any bridge timeout and
      // inbound is fire-and-forget from the bridge's side.
      res.status(200).json({ ok: true })

      // 7. A pending confirmation on this chat intercepts the next message
      //    as a yes/no/always/never decision; anything else resolves as deny
      //    and falls through as a fresh turn. Mirrors wechat.ts.
      const confirmKey = `${channelId}:${peerId}`
      const pending = pendingConfirmations.get(confirmKey)
      if (pending) {
        const decision = DECISION_MAP[incoming.text.trim().toLowerCase()]
        pendingConfirmations.delete(confirmKey)
        if (decision) {
          pending.resolver.resolve(pending.toolCallId, decision)
          return
        }
        pending.resolver.resolve(pending.toolCallId, 'deny')
      }

      // 8. Sequentialize per conversation.
      await withChatLock(`custom:${channelId}:${peerId}`, () =>
        processMessage({
          adapter,
          incoming,
          bridgeMessage: msg,
          assistant,
          channelUserId,
          ownerId,
          isIdentified,
          routing,
          channelId,
          confirmKey,
          archiveConnectorInstanceId: integration.connectorInstanceId,
        }),
      )
    } catch (err) {
      console.error(`[custom-channel] error processing inbound for channel ${channelId}:`, err)
      if (!res.headersSent) res.status(500).json({ error: 'internal_error' })
    }
  })

  /**
   * `isSelf`: the owner's own phone reply. It belongs in the archive as an
   * OUTBOUND message on that conversation so the model's history and the
   * owner's real replies line up. The live writer keys outbound appends by a
   * session message id; a bridge-relayed self message has no session row, so
   * a synthetic `bridge-self:<messageId>` cursor stands in.
   */
  async function archiveSelfMessage(channel: Channel, msg: BridgeInboundMessage): Promise<void> {
    try {
      const ownerUserId = await workspaceOwnerId(channel.workspaceId)
      if (!ownerUserId) return
      const state = await store.getState(channel.id).catch(() => null)
      await appendOutboundChatArchive({
        source: 'custom',
        ownerUserId,
        workspaceId: channel.workspaceId,
        assistantId: msg.senderId,
        assistantName: msg.senderName ?? state?.accountLabel ?? msg.senderId,
        conversationId: msg.peerId,
        sessionMessageId: `bridge-self:${msg.messageId}`,
        providerMessageId: msg.messageId,
        text: msg.text,
        replyToProviderId: msg.replyToMessageId ?? null,
      })
    } catch (err) {
      console.error('[custom-channel] self-message archive append failed:', err)
    }
  }

  async function processMessage(params: {
    adapter: ReturnType<typeof createCustomAdapter>
    incoming: IncomingMessage
    bridgeMessage: BridgeInboundMessage
    assistant: Awaited<ReturnType<typeof findAssistantById>> & {}
    channelUserId: string
    ownerId: string
    isIdentified: boolean
    routing: { assistantId: string; modelAlias: string }
    channelId: string
    confirmKey: string
    archiveConnectorInstanceId?: string | null
  }): Promise<void> {
    const { adapter, incoming, bridgeMessage, assistant, channelUserId, ownerId, isIdentified, routing, channelId, confirmKey } = params
    const peerId = incoming.channelId

    // ── Content blocks (text + media) — same shapes as routes/wechat.ts ──
    const userContentBlocks: ContentBlock[] = []
    const mediaItems = bridgeMessage.media ?? []
    for (const [index, item] of mediaItems.entries()) {
      const archiveKind = item.kind === 'document' ? 'file' : item.kind === 'audio' ? 'voice' : item.kind
      if (index === 0) {
        incoming.mediaType = item.kind === 'image' ? 'photo' : item.kind
        incoming.mediaMime = item.mime
        incoming.mediaName = item.name
        incoming.mediaSizeBytes = item.sizeBytes ?? 0
        incoming.archiveMediaAvailability = 'missing'
      }
      try {
        const bytes = await loadMediaBytes(item)
        if (index === 0) incoming.mediaSizeBytes = bytes.length
        if (options.archiveMedia && assistant.workspaceId && incoming.messageId) {
          try {
            const archiveInstanceId = params.archiveConnectorInstanceId
              ?? await resolveChatArchiveInstanceId({
                source: 'custom',
                ownerUserId: ownerId,
                workspaceId: assistant.workspaceId,
                assistantId: routing.assistantId,
                assistantName: assistant.name ?? '',
                conversationId: peerId,
              })
            if (!archiveInstanceId) throw new Error('custom channel archive instance could not be resolved')
            const asset = await options.archiveMedia.storeBuffer({
              workspaceId: assistant.workspaceId,
              instanceId: archiveInstanceId,
              ownerUserId: ownerId,
              source: 'custom',
              providerMessageId: mediaItems.length > 1 ? `${incoming.messageId}#${index}` : incoming.messageId,
              kind: archiveKind === 'voice' ? 'voice' : archiveKind,
              filename: item.name,
              mime: item.mime,
              bytes,
            })
            if (index === 0) {
              const ref = archiveMediaRef(asset)
              incoming.archiveMediaRef = {
                assetId: ref.asset_id!, sha256: ref.sha256!, filename: ref.filename,
                mime: ref.mime, sizeBytes: ref.size_bytes,
              }
              incoming.archiveMediaAvailability = undefined
            }
          } catch (err) {
            if (index === 0) incoming.archiveMediaAvailability = 'failed'
            console.error('[custom-channel] archive media staging failed:', err)
          }
        }

        if (item.kind === 'image') {
          userContentBlocks.push({ type: 'image', mimeType: item.mime, data: bytes.toString('base64') })
          // Save-on-request seam — without the tag the model can SEE the
          // image but holds no reference to it, so "keep this" dead-ends.
          const tag = options.fileStore
            ? await cacheInboundImageTag({
                fileStore: options.fileStore,
                channelType: 'custom',
                channelId: peerId,
                userId: channelUserId,
                assistant,
                file: { buffer: bytes, mime: item.mime, fileName: item.name },
              })
            : ''
          if (tag) userContentBlocks.push({ type: 'text', text: tag })
        } else if (item.kind === 'document') {
          if (item.mime === 'application/pdf') {
            userContentBlocks.push({ type: 'image', mimeType: item.mime, data: bytes.toString('base64') })
          } else {
            const parsedFile = await parseFileContent(bytes, item.mime, item.name)
            if (
              parsedFile.mediaMimeType === 'application/pdf'
              || parsedFile.mediaMimeType?.startsWith('image/')
            ) {
              userContentBlocks.push({ type: 'image', mimeType: parsedFile.mediaMimeType, data: bytes.toString('base64') })
            } else {
              userContentBlocks.push({
                type: 'text',
                text: `<attached_file name="${item.name}" type="${item.mime}">\n${parsedFile.text}\n</attached_file>`,
              })
            }
          }
        } else if (item.kind === 'voice' || item.kind === 'audio') {
          userContentBlocks.push({
            type: 'text',
            text: '[The user sent a voice message. You cannot hear it directly. It is archived and '
              + 'transcribed asynchronously — use searchChatHistory to retrieve the transcript. '
              + 'If the search returns nothing, transcription has not finished yet; say so rather '
              + 'than saying the content is unavailable.]',
          })
        } else if (item.kind === 'video') {
          userContentBlocks.push({
            type: 'text',
            text: '[The user sent a video. You cannot watch it directly. It is archived and its '
              + 'frames and audio are described asynchronously — use searchChatHistory to retrieve '
              + 'those descriptions. If the search returns nothing, processing has not finished yet; '
              + 'say so rather than saying the content is unavailable.]',
          })
        }
      } catch (err) {
        if (index === 0) incoming.archiveMediaAvailability = 'failed'
        console.error('[custom-channel] media load failed:', err)
        userContentBlocks.push({
          type: 'text',
          text: '[The user sent an attachment that could not be loaded. Ask them to resend it.]',
        })
      }
    }
    if (incoming.text.trim()) {
      userContentBlocks.unshift({ type: 'text', text: incoming.text })
    } else if (userContentBlocks.length === 0) {
      return
    }

    // ── Typing: outbox items, throttled; off on cleanup only if ever on.
    let lastTypingAt = 0
    async function refreshTyping(): Promise<void> {
      const now = Date.now()
      if (now - lastTypingAt < TYPING_REFRESH_MS) return
      lastTypingAt = now
      await adapter.sendTypingIndicator(peerId)
    }
    async function cancelTyping(): Promise<void> {
      if (lastTypingAt === 0) return
      lastTypingAt = 0
      await store.enqueue(channelId, { type: 'typing', peerId, payload: { on: false } }).catch(() => {})
    }

    const abortController = new AbortController()

    await processChannelMessage({
      backgroundModel: options.backgroundModel,
      userId: channelUserId,
      ownerId,
      assistant: { ...assistant, ownerUserId: ownerId },
      isIdentified,
      channelType: 'custom',
      channelId: peerId,
      actorChannelId: bridgeMessage.senderId,
      messageText: incoming.text,
      userContentBlocks,
      rawUserText: incoming.text ?? '',
      isGroupChat: Boolean(incoming.isGroupChat),
      replyToMessageId: incoming.replyToMessageId ?? null,
      incomingChannelMessageId: incoming.messageId ?? null,
      archiveIncoming: incoming,
      archiveConnectorInstanceId: params.archiveConnectorInstanceId,
      modelAlias: routing.modelAlias,
      adaptiveResearchEnabled: true,
      abortController,
      provider: options.provider,
      configuredProviders: options.configuredProviders,
      resolveWorkspaceCustomLlm: options.resolveWorkspaceCustomLlm,
      systemPrompt: options.systemPrompt,
      tools: options.tools,
      memoryStore: options.memoryStore,
      usageStore: options.usageStore,
      checkCreditBudget: options.checkCreditBudget,
      analytics: options.analytics,
      connectorStore: options.connectorStore,
      mcpSettingsStore: options.mcpSettingsStore,
      assistantConnectorStore: options.assistantConnectorStore,
      connectorGrantStore: options.connectorGrantStore,
      connectorInstanceStore: options.connectorInstanceStore,
      knowledgeStore: options.knowledgeStore,
      gdriveFilesStore: options.gdriveFilesStore,
      workspaceFilesStore: options.workspaceFilesStore,
      artifactPromoter: options.artifactPromoter ?? null,
      skillStore: options.skillStore,
      workerManager: options.workerManager,
      episodicStore: options.episodicStore,
      sessionStateStore: options.sessionStateStore,
      capabilityStore: options.capabilityStore,
      hooks: {
        async onProcessingStart() {
          await refreshTyping()
        },
        async onToolStart() {
          await refreshTyping()
        },
        async onToolResult() {
          await refreshTyping()
        },
        async onConfirmationRequired(req, resolver) {
          // Text-only confirmation: park the resolver; the peer's next
          // message resolves it via DECISION_MAP (step 7 above).
          pendingConfirmations.set(confirmKey, { resolver, toolCallId: req.toolCallId })
          const lines = req.displayLines && req.displayLines.length > 0
            ? req.displayLines
            : formatConfirmationInput(req.input)
          const inputSummary = lines.length > 0 ? '\n' + lines.join('\n') : ''
          const displayName = getToolDisplayName(req.toolName)
          const replyHint = req.allowPersistentApproval
            ? 'Reply: yes / no / always / never'
            : 'Reply: yes / no'
          await cancelTyping()
          await adapter.sendMessage(peerId, {
            text: `${displayName}${inputSummary}\n\n${replyHint}`,
          })
        },
        async sendResponse(text) {
          const finalText = text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
          const reply = finalText || "I couldn't generate a reply - please rephrase or try again."
          await cancelTyping()
          const channelMessageId = await adapter.sendMessage(peerId, { text: reply, format: 'markdown' })
          return channelMessageId ? { channelMessageId } : undefined
        },
        async onDowngraded(resetsAt) {
          const resetNote = resetsAt
            ? ` Resets ${new Date(resetsAt).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, weekday: 'short' })}.`
            : ''
          await adapter.sendMessage(peerId, {
            text: `Running on the standard model: usage limit reached.${resetNote} Buy extra usage or upgrade in workspace settings for full speed.`,
          })
          return null
        },
        async sendError(err) {
          await cancelTyping()
          await adapter.sendMessage(peerId, { text: channelUserErrorText(err) })
        },
        async onCleanup() {
          await cancelTyping()
        },
      },
    })
  }

  return router
}
