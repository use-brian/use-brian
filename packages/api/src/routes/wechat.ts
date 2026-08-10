/**
 * WeChat internal route — iLink long-poll connector seam.
 *
 * Mounted at `/internal/wechat`. iLink has no inbound webhook: chat arrives on
 * the long-poll held by `apps/wechat-connector`, which authenticates with
 * `X-Connector-Secret` and POSTs already-normalized messages here. Endpoints:
 *
 *   POST /internal/wechat/inbound   — `{ channelId, message }`: run the turn
 *   GET  /internal/wechat/channels  — active wechat channels + credentials for
 *                                     the connector's restoreAll() on boot
 *   POST /internal/wechat/cursor    — persist the long-poll cursor
 *                                     (`get_updates_buf`) between polls
 *
 * `channelId` is the workspace `channels` row id (which bot); the DM peer is
 * `message.channelId` (== the sender's `ilink_user_id` — DMs only, W2). The
 * answering assistant resolves via `channel_assistants`. The WeChat account
 * that performed the QR binding maps to the assistant owner (the binding is
 * the identity proof); every other sender maps to a tier-2 shadow user because
 * iLink exposes no email. The turn then runs through the shared
 * `processChannelMessage` pipeline. Outbound replies go API → iLink REST
 * directly (the adapter), never back through the connector (W3).
 *
 * WeChat has no message edits and no buttons: tool confirmations are
 * text-only (yes / no / always / never), and instead of an edit-in-place
 * status message the route drives the native typing indicator (typing_ticket
 * via getconfig). See docs/architecture/channels/wechat.md.
 *
 * Component tag: [COMP:api/wechat-inbound].
 */

import { timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import {
  createWechatAdapter,
  createIlinkClient,
  downloadWechatMediaItem,
  findWechatMediaItem,
  type WeixinMessage,
} from '@use-brian/channels'
import type { IncomingMessage } from '@use-brian/channels'
import { z } from 'zod'
import { parseFileContent } from '@use-brian/core'
import type { ConfirmationDecision, ConfirmationResolver, ContentBlock } from '@use-brian/core'
import type { LLMProvider, Tool, MemoryStore, UsageStore, AnalyticsLogger, McpSettingsStore } from '@use-brian/core'
import { findAssistantById } from '../db/users.js'
import { withChatLock } from '../db/chat-lock.js'
import { resolveChannelUser, type ChannelUserStore } from '../db/channel-user-store.js'
import { resolveRoutingForSurface, getChannelForWebhook } from '../db/channels-store.js'
import type { ChannelIntegrationStore, ChannelIntegrationConfig, WechatCredentials } from '../db/channel-integrations.js'
import { upsertWechatContextToken, getWechatContextToken } from '../db/wechat-context-tokens.js'
import type { ConnectorStore } from '../db/connector-store.js'
import { getToolDisplayName, formatConfirmationInput } from '@use-brian/shared'
import { processChannelMessage } from './channel-pipeline.js'
import { cacheInboundImageTag } from './channel-file-cache.js'
import { billingPartyForAssistant } from '../billing-party.js'
import type { ChatArchiveMediaService } from '../chat-archive/media-service.js'
import { archiveMediaRef } from '../chat-archive/media-service.js'

export type WechatRouteOptions = {
  /** Servable background-lane model, resolved at boot; forwarded to the
   * channel pipeline so its background calls work without a Google key. */
  backgroundModel?: string
  /** Shared secret the connector presents on every call (WECHAT_CONNECTOR_SECRET). */
  connectorSecret: string
  provider: LLMProvider
  resolveWorkspaceCustomLlm?: import('../custom-llm-runtime.js').WorkspaceCustomLlmResolver
  systemPrompt: string
  tools: Map<string, Tool>
  memoryStore: MemoryStore
  usageStore?: UsageStore
  checkCreditBudget?: import('./route-helpers.js').CreditBudgetGate
  integrationStore: ChannelIntegrationStore
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
  /** Transient upload cache (`file_cache`). When present, inbound images are
   *  cached so the turn carries a promotable `<attached_file id="…">` tag
   *  (save-on-request — see routes/channel-file-cache.ts). Absent ⇒ images
   *  ride content blocks with no reference, as before. */
  fileStore?: import('@use-brian/core').FileStore
  artifactPromoter?: import('@use-brian/api/files/artifact-promote.js').ArtifactPromoter | null
  analytics?: AnalyticsLogger
  skillStore?: import('../db/skill-store.js').SkillStore
  episodicStore?: import('@use-brian/core').EpisodicStore
  sessionStateStore?: import('@use-brian/core').SessionStateStore
  capabilityStore: import('@use-brian/core').CapabilityStore
  archiveMedia?: ChatArchiveMediaService
}

// Natural-language → decision mapping for WeChat text-based confirmation
// (no buttons on this platform — text is the only path).
const DECISION_MAP: Record<string, ConfirmationDecision> = {
  yes: 'allow', y: 'allow', allow: 'allow', approve: 'allow', ok: 'allow',
  no: 'deny', n: 'deny', deny: 'deny', reject: 'deny',
  always: 'always_allow', 'always allow': 'always_allow',
  never: 'always_deny', 'always deny': 'always_deny',
}

// Refuse media downloads above this — matches the document cap elsewhere.
const MAX_SMALL_MEDIA_BYTES = 25 * 1024 * 1024
const MAX_LARGE_MEDIA_BYTES = 500 * 1024 * 1024

// Refresh the native typing indicator at most this often while a turn runs.
const TYPING_REFRESH_MS = 5_000

/** QR binding is the only reliable identity proof iLink supplies. */
export function isBoundWechatOwner(senderId: string, credentials: WechatCredentials): boolean {
  return Boolean(credentials.bound_user_id && credentials.bound_user_id === senderId)
}

const inboundSchema = z.object({
  channelId: z.string().min(1),
  message: z.object({
    userId: z.string().min(1),
    channelId: z.string().min(1),
    messageId: z.string().optional(),
    text: z.string(),
    isGroupChat: z.boolean().optional(),
    replyToMessageId: z.string().optional(),
    timestamp: z.number().optional(),
  }).passthrough(),
})

const cursorSchema = z.object({
  channelId: z.string().min(1),
  getUpdatesBuf: z.string(),
})

/**
 * Constant-time shared-secret check. Fails closed: an empty/unset configured
 * secret matches nothing — this router fronts `/channels`, which returns every
 * WeChat bot token, so a misconfigured mount must reject rather than wave
 * callers through. Mirrors the Discord guard.
 */
function connectorSecretMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || expected.length === 0) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function wechatRoutes(options: WechatRouteOptions): Router {
  const router = Router()

  // Pending text-based tool confirmations, keyed by `channelId:peerId`.
  const pendingConfirmations = new Map<string, { resolver: ConfirmationResolver; toolCallId: string }>()

  // ── Connector auth ────────────────────────────────────────────
  router.use((req, res, next) => {
    if (!connectorSecretMatches(req.headers['x-connector-secret'], options.connectorSecret)) {
      res.status(401).json({ error: 'Invalid or missing X-Connector-Secret' })
      return
    }
    next()
  })

  // ── restoreAll source — active wechat channels + credentials ──
  router.get('/channels', async (_req, res) => {
    try {
      const rows = await options.integrationStore.listActiveWithCredentialsSystem('wechat')
      res.json(
        rows.map((r) => {
          const creds = r.credentials as WechatCredentials
          return {
            channelId: r.channelId,
            botToken: creds.bot_token,
            baseUrl: creds.base_url,
            getUpdatesBuf: creds.get_updates_buf ?? '',
          }
        }),
      )
    } catch (err) {
      console.error('[wechat] /channels failed:', err)
      res.status(500).json({ error: 'internal_error' })
    }
  })

  // ── Long-poll cursor persistence ──────────────────────────────
  router.post('/cursor', async (req, res) => {
    const parsed = cursorSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_payload' })
      return
    }
    try {
      await options.integrationStore.mergeCredentialsSystem(
        parsed.data.channelId,
        'wechat',
        (current) => ({ ...(current as WechatCredentials), get_updates_buf: parsed.data.getUpdatesBuf }),
      )
      res.json({ ok: true })
    } catch (err) {
      console.error('[wechat] /cursor failed:', err)
      res.status(500).json({ error: 'internal_error' })
    }
  })

  // ── Inbound message from the long-poll connector ──────────────
  router.post('/inbound', async (req, res) => {
    const parsed = inboundSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_payload' })
      return
    }
    // Ack immediately — the query loop can run far longer than the connector's
    // forward timeout, and inbound is fire-and-forget from its side.
    res.status(200).json({ ok: true })

    const { channelId, message } = parsed.data
    const incoming = message as unknown as IncomingMessage
    const peerId = incoming.channelId

    try {
      // 1. Channel must be active and chat-enabled.
      const channel = await getChannelForWebhook(channelId)
      if (!channel || channel.status !== 'active' || !channel.enabledCapabilities.includes('chat')) {
        console.warn(`[wechat] channel ${channelId} not accepting chat — ignoring inbound`)
        return
      }

      // 2. Integration → bot credentials (for sending).
      const integration = await options.integrationStore.getByChannelForWebhook(channelId, 'wechat')
      if (!integration) {
        console.error(`[wechat] no integration for channel ${channelId} — ignoring inbound`)
        return
      }
      const creds = integration.credentials as WechatCredentials

      // 2b. Access control — silently ignore unauthorized senders (the
      //     per-integration allow/block list on the iLink user id, same model
      //     as Slack/Telegram/Discord). Before routing so a blocked user
      //     costs nothing.
      const cfg = (integration.config ?? {}) as ChannelIntegrationConfig
      const accessMode = cfg.userAccessMode ?? 'allow_all'
      if (accessMode === 'allowlist') {
        const allowed = cfg.allowedUserIds ?? []
        if (allowed.length > 0 && !allowed.includes(incoming.userId)) return
      } else if (accessMode === 'blocklist') {
        const blocked = cfg.blockedUserIds ?? []
        if (blocked.includes(incoming.userId)) return
      }

      // 2c. Persist the per-contact context token — every outbound send to
      //     this peer must echo the latest one (iLink protocol requirement).
      const raw = incoming.raw as WeixinMessage | undefined
      if (raw?.context_token) {
        await upsertWechatContextToken({
          channelId,
          ilinkUserId: peerId,
          contextToken: raw.context_token,
        }).catch((err) => console.error('[wechat] context token persist failed:', err))
      }

      // 3. Resolve the answering assistant (per-peer routing, else default).
      const routing = await resolveRoutingForSurface(channelId, peerId)
      if (!routing) {
        console.error(`[wechat] channel ${channelId} has no assistant routing — ignoring inbound`)
        return
      }
      const assistant = await findAssistantById(routing.assistantId)
      if (!assistant) {
        console.error(`[wechat] assistant ${routing.assistantId} not found (orphaned integration?)`)
        return
      }
      const ownerId = await billingPartyForAssistant({
        id: assistant.id,
        ownerUserId: assistant.ownerUserId ?? null,
        workspaceId: assistant.workspaceId ?? null,
      })

      // 4. Resolve the WeChat sender → a platform user. The QR-bound account
      //    is the owner identity; all other contacts stay tier-2 shadows.
      let channelUserId = ownerId
      let isIdentified = true
      if (!isBoundWechatOwner(incoming.userId, creds) && options.channelUserStore && incoming.userId) {
        try {
          const resolved = await resolveChannelUser(
            options.channelUserStore,
            'wechat',
            incoming.userId,
            routing.assistantId,
            async () => ({ providerUserId: incoming.userId, email: null, displayName: null }),
          )
          channelUserId = resolved.user.id
          isIdentified = resolved.isIdentified
        } catch (err) {
          console.error('[wechat] channel user resolution failed, falling back to owner:', err)
        }
      }

      // 5. Build the send-side adapter (API → iLink REST).
      const adapter = createWechatAdapter({
        baseUrl: creds.base_url,
        botToken: creds.bot_token,
        getContextToken: (uid: string) => getWechatContextToken(channelId, uid),
      })

      // 6. A pending confirmation on this chat intercepts the next message as
      //    a yes/no/always/never decision. A non-decision message resolves as
      //    deny so the in-flight turn (holding the chat lock) unblocks, then
      //    falls through as a fresh turn. Mirrors discord.ts / slack.ts.
      const confirmKey = `${channelId}:${peerId}`
      const pending = pendingConfirmations.get(confirmKey)
      if (pending) {
        const decision = DECISION_MAP[incoming.text.trim().toLowerCase()]
        if (decision) {
          pendingConfirmations.delete(confirmKey)
          pending.resolver.resolve(pending.toolCallId, decision)
          return
        }
        pending.resolver.resolve(pending.toolCallId, 'deny')
        pendingConfirmations.delete(confirmKey)
      }

      // 7. Sequentialize per DM peer.
      await withChatLock(`wechat:${channelId}:${peerId}`, () =>
        processMessage({
          adapter,
          incoming,
          assistant,
          channelUserId,
          ownerId,
          isIdentified,
          routing,
          channelId,
          creds,
          confirmKey,
          archiveConnectorInstanceId: integration.connectorInstanceId,
        }),
      )
    } catch (err) {
      console.error(`[wechat] error processing message for channel ${channelId}:`, err)
    }
  })

  async function processMessage(params: {
    adapter: ReturnType<typeof createWechatAdapter>
    incoming: IncomingMessage
    assistant: Awaited<ReturnType<typeof findAssistantById>> & {}
    channelUserId: string
    ownerId: string
    isIdentified: boolean
    routing: { assistantId: string; modelAlias: string }
    channelId: string
    creds: WechatCredentials
    confirmKey: string
    archiveConnectorInstanceId?: string | null
  }): Promise<void> {
    const { adapter, incoming, assistant, channelUserId, ownerId, isIdentified, routing, channelId, creds, confirmKey } = params
    const peerId = incoming.channelId
    const raw = incoming.raw as WeixinMessage | undefined

    // ── Build content blocks (text + downloaded/decrypted media) ──
    // iLink media is AES-encrypted on the CDN, so bytes are pulled and
    // decrypted here (the generic URL acquirers can't). Voice notes with
    // server STT already arrived as text via the adapter.
    const userContentBlocks: ContentBlock[] = []
    const mediaItem = raw ? findWechatMediaItem(raw.item_list) : null
    if (mediaItem) {
      const fallbackKind = mediaItem.video_item ? 'video'
        : mediaItem.voice_item ? 'voice'
          : mediaItem.image_item ? 'image' : 'file'
      incoming.mediaType = fallbackKind === 'image' ? 'photo'
        : fallbackKind === 'file' ? 'document' : fallbackKind
      incoming.mediaMime = fallbackKind === 'image' ? 'image/jpeg'
        : fallbackKind === 'video' ? 'video/mp4'
          : fallbackKind === 'voice' ? 'audio/silk' : 'application/octet-stream'
      incoming.mediaName = fallbackKind === 'image' ? 'image'
        : fallbackKind === 'video' ? 'video.mp4'
          : fallbackKind === 'voice' ? 'voice.silk' : mediaItem.file_item?.file_name ?? 'file.bin'
      incoming.mediaSizeBytes = 0
      incoming.archiveMediaAvailability = 'missing'
      try {
        const maxBytes = fallbackKind === 'video' || fallbackKind === 'voice'
          ? MAX_LARGE_MEDIA_BYTES : MAX_SMALL_MEDIA_BYTES
        const media = await downloadWechatMediaItem(mediaItem, { maxBytes })
        if (!media) throw new Error('iLink media item did not contain downloadable bytes')
        const archiveKind = media.mime === 'image/gif' ? 'video' : media.kind
        incoming.mediaType = archiveKind === 'image' ? 'photo'
          : archiveKind === 'file' ? 'document' : archiveKind
        incoming.mediaMime = media.mime
        incoming.mediaName = media.name
        incoming.mediaSizeBytes = media.data.length
        if (
          options.archiveMedia
          && assistant.workspaceId
          && incoming.messageId
        ) {
          try {
            const instanceId = await options.archiveMedia.resolveBinding({
              workspaceId: assistant.workspaceId,
              ownerUserId: ownerId,
              source: 'wechat',
              instanceId: params.archiveConnectorInstanceId,
            })
            const asset = await options.archiveMedia.storeBuffer({
              workspaceId: assistant.workspaceId,
              instanceId,
              ownerUserId: ownerId,
              source: 'wechat',
              providerMessageId: incoming.messageId,
              kind: archiveKind,
              filename: media.name,
              mime: media.mime,
              sizeBytes: media.data.length,
              bytes: media.data,
            })
            const ref = archiveMediaRef(asset)
            incoming.archiveMediaRef = {
              assetId: ref.asset_id!, sha256: ref.sha256!, filename: ref.filename,
              mime: ref.mime, sizeBytes: ref.size_bytes,
            }
          } catch (err) {
            incoming.archiveMediaAvailability = 'failed'
            console.error('[wechat] local archive media staging failed:', err)
          }
        }
        if (media.data.length > maxBytes) {
          userContentBlocks.push({
            type: 'text',
            text: `[The user sent a ${media.kind} over ${Math.round(maxBytes / 1024 / 1024)} MB - too large to process.]`,
          })
        } else if (media.kind === 'image') {
          userContentBlocks.push({ type: 'image', mimeType: media.mime, data: media.data.toString('base64') })
          // Save-on-request seam — without the tag the model can SEE the
          // image but holds no reference to it, so "keep this" dead-ends.
          // `channelUserId` MUST match the session key the pipeline uses
          // below. Empty string on any miss keeps the block-only turn.
          // (WeChat cannot currently deliver an outbound document — see
          // DOCUMENT_CAPABLE_CHANNELS — but saving and emailing both work.)
          const tag = options.fileStore
            ? await cacheInboundImageTag({
                fileStore: options.fileStore,
                channelType: 'wechat',
                channelId: incoming.channelId,
                userId: channelUserId,
                assistant,
                file: { buffer: media.data, mime: media.mime, fileName: media.name },
              })
            : ''
          if (tag) userContentBlocks.push({ type: 'text', text: tag })
        } else if (media.kind === 'file') {
          if (media.mime === 'application/pdf') {
            userContentBlocks.push({ type: 'image', mimeType: media.mime, data: media.data.toString('base64') })
          } else {
            const parsedFile = await parseFileContent(media.data, media.mime, media.name)
            if (
              parsedFile.mediaMimeType === 'application/pdf' ||
              parsedFile.mediaMimeType?.startsWith('image/')
            ) {
              userContentBlocks.push({
                type: 'image',
                mimeType: parsedFile.mediaMimeType,
                data: media.data.toString('base64'),
              })
            } else {
              userContentBlocks.push({
                type: 'text',
                text: `<attached_file name="${media.name}" type="${media.mime}">\n${parsedFile.text}\n</attached_file>`,
              })
            }
          }
        } else if (media.kind === 'voice') {
          userContentBlocks.push({
            type: 'text',
            text: '[The user sent a voice message. It is stored and being transcribed for chat-history search.]',
          })
        } else if (media.kind === 'video') {
          userContentBlocks.push({
            type: 'text',
            text: '[The user sent a video. It is stored and being processed for chat-history search.]',
          })
        }
      } catch (err) {
        incoming.archiveMediaAvailability = 'failed'
        console.error('[wechat] media download/decrypt failed:', err)
        userContentBlocks.push({
          type: 'text',
          text: '[The user sent an attachment that could not be downloaded. Ask them to resend it.]',
        })
      }
    }
    if (incoming.text.trim()) {
      userContentBlocks.unshift({ type: 'text', text: incoming.text })
    } else if (userContentBlocks.length === 0) {
      return
    }

    // ── Native typing indicator (no edits on WeChat → no status message).
    // The ticket comes from getconfig with the peer's fresh context token;
    // best-effort — a failed fetch just means no indicator.
    const client = createIlinkClient({ baseUrl: creds.base_url, token: creds.bot_token })
    let typingTicket: string | undefined
    try {
      const contextToken = raw?.context_token ?? (await getWechatContextToken(channelId, peerId))
      const config = await client.getConfig({ ilinkUserId: peerId, contextToken })
      typingTicket = config.typing_ticket
    } catch {
      // Non-critical.
    }
    let lastTypingAt = 0
    async function refreshTyping(): Promise<void> {
      if (!typingTicket) return
      const now = Date.now()
      if (now - lastTypingAt < TYPING_REFRESH_MS) return
      lastTypingAt = now
      await client.sendTyping({ ilinkUserId: peerId, typingTicket, status: 1 }).catch(() => {})
    }
    async function cancelTyping(): Promise<void> {
      if (!typingTicket || lastTypingAt === 0) return
      await client.sendTyping({ ilinkUserId: peerId, typingTicket, status: 2 }).catch(() => {})
    }

    const abortController = new AbortController()

    await processChannelMessage({
      backgroundModel: options.backgroundModel,
      userId: channelUserId,
      ownerId,
      assistant: { ...assistant, ownerUserId: ownerId },
      isIdentified,
      channelType: 'wechat',
      channelId: peerId,
      messageText: incoming.text,
      userContentBlocks,
      // Raw paste for the large-paste intercept (WeChat has no prefix wrapper).
      rawUserText: incoming.text ?? '',
      isGroupChat: false,
      replyToMessageId: incoming.replyToMessageId ?? null,
      incomingChannelMessageId: incoming.messageId ?? null,
      archiveIncoming: incoming,
      archiveConnectorInstanceId: params.archiveConnectorInstanceId,
      modelAlias: routing.modelAlias,
      adaptiveResearchEnabled: true,
      abortController,
      provider: options.provider,
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
          // message resolves it via DECISION_MAP (step 6 above).
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
          await adapter.sendMessage(peerId, {
            text: err.message.includes('usage limit')
              ? err.message
              : 'Something went wrong. Please try again.',
          })
        },
        async onCleanup() {
          await cancelTyping()
        },
      },
    })
  }

  return router
}
