import { dispatchIncomingMessageEvent } from '../message-events.js'
import type { ChannelQuestionStore } from '../workflow/channel-questions.js'
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
 * answering assistant resolves via `channel_assistants`. The SENDER resolves
 * only through a canonical identity binding (`db/channel-identity-bindings.ts`):
 * the QR-bound WeChat account, bound to one Brian account in this workspace
 * at the current transport generation. There is no fallback - no billing
 * owner, no QR or channel creator, no shadow user, no old session owner - and
 * every refusal is a fixed, model-free notice. `LINK <code>` is a control
 * command claimed before anything else reads the text. The turn then runs
 * through the shared `processChannelMessage` pipeline under a receipt-keyed
 * session with a live `credentialCurrent` check. Outbound replies go API →
 * iLink REST directly (the adapter), never back through the connector (W3).
 * See docs/architecture/channels/wechat.md → "Staff identity".
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
  describeWechatPayload,
  downloadWechatMediaItem,
  findWechatMediaItem,
  WeixinItemType,
  WeixinMessageType,
  WeixinMessageState,
  type WeixinMessage,
} from '@use-brian/channels'
import type { IncomingMessage } from '@use-brian/channels'
import { z } from 'zod'
import { parseFileContent } from '@use-brian/core'
import type { ContentBlock } from '@use-brian/core'
import type { LLMProvider, Tool, MemoryStore, UsageStore, AnalyticsLogger, McpSettingsStore } from '@use-brian/core'
import { findAssistantById } from '../db/users.js'
import { withChatLock } from '../db/chat-lock.js'
import type { ChannelUserStore } from '../db/channel-user-store.js'
import { getWorkspaceRoleSystem } from '../db/workspace-store.js'
import {
  parseWechatLinkCommand,
  wechatSessionChannelId,
  type ChannelIdentityBindingStore,
  type ClaimWechatLinkCodeResult,
  type WechatIdentityReceipt,
} from '../db/channel-identity-bindings.js'
import { resolveRoutingForSurface, getChannelForWebhook } from '../db/channels-store.js'
import type { ChannelIntegrationStore, ChannelIntegrationConfig, WechatCredentials } from '../db/channel-integrations.js'
import { upsertWechatContextToken, getWechatContextToken } from '../db/wechat-context-tokens.js'
import type { ConnectorStore } from '../db/connector-store.js'
import { processChannelMessage } from './channel-pipeline.js'
import { channelConfirmations, confirmationMessage, type ChannelInteractionScope } from './channel-interactions.js'
import { channelUserErrorText } from './_channel-error-text.js'
import { cacheInboundImageTag } from './channel-file-cache.js'
import { billingPartyForAssistant } from '../billing-party.js'
import type { ChatArchiveLiveMedia } from '../chat-archive/live-media.js'
import { archiveMediaRef } from '../chat-archive/live-media.js'
import { resolveChatArchiveInstanceId, archiveUnroutedInbound } from '../chat-archive/live-writer.js'
import { query } from '../db/client.js'
import { sanitize as sanitizeAnalytics } from '@use-brian/core'

export type WechatRouteOptions = {
  questionStore?: ChannelQuestionStore
  /** Servable background-lane model, resolved at boot; forwarded to the
   * channel pipeline so its background calls work without a Google key. */
  backgroundModel?: string
  decisionRuntime?: import('@use-brian/core').DecisionExecutionPort
  /** Shared secret the connector presents on every call (WECHAT_CONNECTOR_SECRET). */
  connectorSecret: string
  provider: LLMProvider
  configuredProviders?: import('@use-brian/shared/model-registry').ProviderAvailability
  resolveWorkspaceCustomLlm?: import('../custom-llm-runtime.js').WorkspaceCustomLlmResolver
  /** Live watch feed (live-work.md §5.2) — threaded by hand at every mount; see ChannelPipelineParams. */
  publishSessionEvent?: import('../session-event-port.js').PublishSessionEvent
  systemPrompt: string
  tools: Map<string, Tool>
  memoryStore: MemoryStore
  usageStore?: UsageStore
  checkCreditBudget?: import('./route-helpers.js').CreditBudgetGate
  integrationStore: ChannelIntegrationStore
  /**
   * Canonical identity bindings (migration 743). Absent ⇒ no WeChat turn runs
   * (fail closed): every message gets the fixed "cannot verify" notice.
   */
  identityStore?: ChannelIdentityBindingStore
  /** Retained for mount compatibility; WeChat no longer creates shadow users. */
  channelUserStore?: ChannelUserStore
  workerManager?: import('@use-brian/core').WorkerManager
  connectorStore?: ConnectorStore
  mcpSettingsStore?: McpSettingsStore
  assistantConnectorStore?: import('../db/assistant-connector-store.js').AssistantConnectorStore
  connectorGrantStore?: import('../db/connector-grant-store.js').ConnectorGrantStore
  connectorInstanceStore?: import('../db/connector-instance-store.js').ConnectorInstanceStore
  knowledgeStore?: import('@use-brian/core').KnowledgeStoreInterface
  knowledgeCaptureRuleStore?: import('../knowledge/capture-rules.js').KnowledgeCaptureRuleStore
  gdriveFilesStore?: import('@use-brian/core').GDriveFilesStore
  workspaceFilesStore?: import('@use-brian/core').WorkspaceFilesStore
  /** Transient upload cache (`file_cache`). When present, inbound images are
   *  cached so the turn carries a promotable `<attached_file id="…">` tag
   *  (save-on-request — see routes/channel-file-cache.ts). Absent ⇒ images
   *  ride content blocks with no reference, as before. */
  fileStore?: import('@use-brian/core').FileStore
  artifactPromoter?: import('../files/artifact-promote.js').ArtifactPromoter | null
  analytics?: AnalyticsLogger
  skillStore?: import('../db/skill-store.js').SkillStore
  workflowStore?: import('@use-brian/core').WorkflowStore
  workspaceSkillStore?: import('../db/skill-store.js').WorkspaceSkillStore
  workspaceSkillEnablementStore?: import('../db/workspace-skill-enablement-store.js').WorkspaceSkillEnablementStore
  workspaceSkillFilesStore?: import('../db/workspace-skill-files-store.js').WorkspaceSkillFilesStore
  episodicStore?: import('@use-brian/core').EpisodicStore
  sessionStateStore?: import('@use-brian/core').SessionStateStore
  crmEmailDraftStore?: import('@use-brian/core').CrmEmailDraftStore
  capabilityStore: import('@use-brian/core').CapabilityStore
  archiveMedia?: ChatArchiveLiveMedia
}

// Refuse media downloads above this — matches the document cap elsewhere.
const MAX_SMALL_MEDIA_BYTES = 25 * 1024 * 1024
const MAX_LARGE_MEDIA_BYTES = 500 * 1024 * 1024

// Refresh the native typing indicator at most this often while a turn runs.
const TYPING_REFRESH_MS = 5_000

/**
 * Provider proof: the WeChat account that scanned this bot's QR. It proves
 * who controls the bot, never which Brian account acts - that needs a binding.
 */
export function isQrBoundSender(senderId: string, credentials: WechatCredentials): boolean {
  return Boolean(credentials.bound_user_id && credentials.bound_user_id === senderId)
}

/**
 * Fixed, model-free notices. Every identity refusal ends here: no model,
 * tool, session, history or archive is touched for these messages.
 */
export const WECHAT_IDENTITY_NOTICES = {
  unlinked: 'This WeChat connection is not linked to a Brian account yet. Sign in to Use Brian, open Settings > Account > Connected accounts, create a code for this WeChat connection, then send: LINK <code>',
  accessRemoved: 'Your Brian account no longer has access to this workspace, so this connection cannot answer. Ask a workspace admin to restore your access.',
  notOwner: 'This WeChat connection only answers the person it was paired with.',
  conflict: 'This WeChat connection is paused because it is connected in more than one place. A workspace admin can disconnect the duplicate and pair it again.',
  unverified: 'Brian could not verify your account right now. Nothing was done. Please try again in a moment.',
  assistantUnavailable: 'This connection has no assistant available to you. Ask a workspace admin to check its routing.',
} as const

export const WECHAT_LINK_REPLIES: Record<ClaimWechatLinkCodeResult extends infer R
  ? R extends { ok: false; reason: infer K } ? K & string : never : never, string> & { linked: string } = {
  linked: 'Linked. This WeChat connection now acts as your Brian account in this workspace. Earlier conversations stay where they were.',
  invalid: 'That code did not work. Codes work once and expire after 15 minutes. Create a new one in Settings > Account > Connected accounts.',
  rate_limited: 'Too many attempts. Wait 15 minutes, then create a new code.',
  wrong_sender: 'Only the WeChat account that paired this connection can link it.',
  linked_elsewhere: 'This connection is already linked to another Brian account. That account must disconnect it, or a workspace admin must revoke it, before it can be linked again.',
  not_member: 'That code belongs to an account that is no longer a member of this workspace.',
  conflict: WECHAT_IDENTITY_NOTICES.conflict,
  transport_inactive: 'This WeChat connection is not active.',
}

const inboundSchema = z.object({
  channelId: z.string().min(1),
  /** Transport generation of the loop that forwarded this (absent from older connectors). */
  generation: z.number().int().positive().optional(),
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
  /** A replaced loop must not roll the new transport's cursor back. */
  generation: z.number().int().positive().optional(),
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


  // ── Connector auth ────────────────────────────────────────────
  router.use((req, res, next) => {
    if (!connectorSecretMatches(req.headers['x-connector-secret'], options.connectorSecret)) {
      res.status(401).json({ error: 'Invalid or missing X-Connector-Secret' })
      return
    }
    next()
  })

  // ── restoreAll source — active wechat channels + credentials ──
  // Duplicate ownership of one bot is a visible conflict, never two
  // competing pollers: conflicted transports are excluded from restore.
  router.get('/channels', async (_req, res) => {
    try {
      if (!options.identityStore) {
        res.json([])
        return
      }
      const rows = await options.identityStore.listActiveWechatTransportsSystem()
      const conflicted = rows.filter((r) => r.conflict)
      if (conflicted.length > 0) {
        console.warn(`[wechat] restore excludes ${conflicted.length} conflicted transport(s): ${conflicted.map((r) => r.channelId).join(', ')}`)
      }
      res.json(
        rows.filter((r) => !r.conflict).map((r) => ({
          channelId: r.channelId,
          botId: r.botId,
          generation: r.generation,
          botToken: r.credentials.bot_token,
          baseUrl: r.credentials.base_url,
          getUpdatesBuf: r.credentials.get_updates_buf ?? '',
        })),
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
      if (!options.identityStore) {
        res.status(503).json({ error: 'identity_store_unavailable' })
        return
      }
      const persisted = await options.identityStore.persistWechatCursor(
        parsed.data.channelId,
        parsed.data.generation,
        parsed.data.getUpdatesBuf,
      )
      if (!persisted) {
        res.status(409).json({ error: 'stale_generation' })
        return
      }
      res.json({ ok: true })
    } catch (err) {
      console.error('[wechat] /cursor failed:', err)
      res.status(500).json({ error: 'internal_error' })
    }
  })

  /**
   * Stage an unrouted message's media into the archive before its append.
   *
   * Mirrors processMessage's staging block, but resolves the target from the
   * WORKSPACE OWNER (what `appendUnroutedInbound` uses) rather than a billing
   * party — the store links assets by exact (workspace, instance, owner) and
   * fails the append on a mismatch. Sets `incoming.archiveMediaRef` /
   * `archiveMediaAvailability` in place, exactly like the routed loop.
   */
  async function stageUnroutedWechatMedia(args: {
    channel: { workspaceId: string }
    connectorInstanceId: string | null | undefined
    incoming: IncomingMessage
    raw: WeixinMessage | undefined
  }): Promise<void> {
    const { incoming, raw } = args
    if (!options.archiveMedia || !raw || !incoming.messageId) return
    const mediaItem = findWechatMediaItem(raw.item_list)
    if (!mediaItem) return
    const fallbackKind = mediaItem.video_item ? 'video'
      : mediaItem.voice_item ? 'voice'
        : mediaItem.image_item ? 'image' : 'file'
    incoming.mediaType = fallbackKind === 'image' ? 'photo'
      : fallbackKind === 'file' ? 'document' : fallbackKind
    incoming.archiveMediaAvailability = 'missing'
    try {
      const owner = await query<{ ownerUserId: string }>(
        `SELECT owner_user_id AS "ownerUserId" FROM workspaces WHERE id = $1`,
        [args.channel.workspaceId],
      )
      const ownerUserId = owner.rows[0]?.ownerUserId
      if (!ownerUserId) return
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
      const instanceId = args.connectorInstanceId
        ?? await resolveChatArchiveInstanceId({
          source: 'wechat',
          ownerUserId,
          workspaceId: args.channel.workspaceId,
          assistantId: '',
          assistantName: '',
          conversationId: incoming.channelId,
        })
      if (!instanceId) throw new Error('wechat archive instance could not be resolved')
      const asset = await options.archiveMedia.storeBuffer({
        workspaceId: args.channel.workspaceId,
        instanceId,
        ownerUserId,
        source: 'wechat',
        providerMessageId: incoming.messageId,
        kind: archiveKind,
        filename: media.name,
        mime: media.mime,
        bytes: media.data,
      })
      const ref = archiveMediaRef(asset)
      incoming.archiveMediaRef = {
        assetId: ref.asset_id!, sha256: ref.sha256!, filename: ref.filename,
        mime: ref.mime, sizeBytes: ref.size_bytes,
      }
      incoming.archiveMediaAvailability = undefined
    } catch (err) {
      incoming.archiveMediaAvailability = 'failed'
      throw err
    }
  }

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

    const { channelId, message, generation } = parsed.data
    const incoming = message as unknown as IncomingMessage
    const peerId = incoming.channelId

    try {
      // 1. Workflow ingress requires an active channel, not chat capability.
      const channel = await getChannelForWebhook(channelId)
      if (!channel || channel.channelType !== 'wechat' || channel.status !== 'active') {
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

      // 2a. A replaced loop must not speak for the new transport.
      if (generation !== undefined && options.identityStore) {
        const current = await options.identityStore.getWechatTransportGeneration(channelId)
        if (current !== generation) {
          console.warn(`[wechat] channel ${channelId}: ignoring inbound from a stale transport generation`)
          return
        }
      }

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

      // The connector forwards normalized iLink messages (timestamps in ms).
      // Defensively exclude echoes and streaming intermediates at this seam too.
      const eventRaw = incoming.raw as WeixinMessage | undefined
      if (incoming.userId === creds.ilink_bot_id
        || (eventRaw?.message_type != null && eventRaw.message_type !== WeixinMessageType.USER)
        || (eventRaw?.message_state != null && eventRaw.message_state !== WeixinMessageState.FINISH)) return

      // 2c. Persist the per-contact context token — every outbound send to
      //     this peer must echo the latest one (iLink protocol requirement),
      //     including the fixed identity notices below.
      const raw = incoming.raw as WeixinMessage | undefined
      if (raw?.context_token) {
        await upsertWechatContextToken({
          channelId,
          ilinkUserId: peerId,
          contextToken: raw.context_token,
        }).catch((err) => console.error('[wechat] context token persist failed:', err))
      }
      const adapter = createWechatAdapter({
        baseUrl: creds.base_url,
        botToken: creds.bot_token,
        getContextToken: (uid: string) => getWechatContextToken(channelId, uid),
      })
      const notify = (text: string) => adapter.sendMessage(peerId, { text })
        .then(() => undefined)
        .catch((err) => console.error(`[wechat] channel ${channelId}: notice send failed:`, (err as Error).message))

      // 2d. `LINK <code>` is a control command. It is handled HERE, before the
      //     workflow message event, media download, session, history or
      //     archive, so a bearer code never reaches a model or a record.
      const linkCommand = findWechatMediaItem(eventRaw?.item_list) ? null : parseWechatLinkCommand(incoming.text)
      if (linkCommand) {
        await handleLinkCommand({ channelId, botId: creds.ilink_bot_id, senderId: incoming.userId, code: linkCommand.code, notify })
        return
      }

      if (incoming.text.trim() || incoming.mediaType || findWechatMediaItem(eventRaw?.item_list)) {
        const eventIncoming: IncomingMessage & { channelType: string } = {
          ...incoming, channelType: 'wechat', timestamp: (incoming.timestamp ?? Date.now()) / 1000,
        }
        await dispatchIncomingMessageEvent({
          workspaceId: channel.workspaceId,
          integrationId: integration.id,
          providerAccountId: creds.ilink_bot_id,
          incoming: eventIncoming,
        })
      }
      if (!channel.enabledCapabilities.includes('chat')) return

      // 3. Resolve the answering assistant (per-peer routing, else default).
      const routing = await resolveRoutingForSurface(channelId, peerId)
      if (!routing) {
        // No assistant answers this peer, but the message is still this
        // account's history. Routing decides who replies; it says nothing
        // about what belongs in a record of the account — and without this the
        // archive held backfilled history for conversations that then silently
        // stopped receiving live messages: the same chat, half recorded.
        //
        // A failure here must not change the outcome. The message is already
        // going unanswered; losing it from the archive too is strictly worse
        // than a logged error.
        //
        // Media too: this exit never reaches processMessage's staging loop,
        // and iLink CDN bytes cannot be re-fetched later — an attachment
        // archived here as filename hints is unrecoverable. Stage first,
        // under the SAME (workspace owner, instance) the unrouted append
        // resolves to; the store links assets by exact match.
        await stageUnroutedWechatMedia({
          channel,
          connectorInstanceId: integration.connectorInstanceId,
          incoming,
          raw: incoming.raw as WeixinMessage | undefined,
        }).catch((err) => console.error('[wechat] unrouted archive media staging failed:', err))
        await archiveUnroutedInbound({
          source: 'wechat',
          workspaceId: channel.workspaceId,
          conversationId: peerId,
          connectorInstanceId: integration.connectorInstanceId,
          message: incoming,
        }).catch((err) => console.error('[wechat] unrouted archive append failed:', err))
        console.log(`[wechat] no assistant routing for ${peerId} on channel ${channelId} — archived, not answered`)
        return
      }
      const assistant = await findAssistantById(routing.assistantId)
      if (!assistant) {
        console.error(`[wechat] assistant ${routing.assistantId} not found (orphaned integration?)`)
        return
      }
      // 4. Resolve the sender to exactly one Brian account. No fallback:
      //    every refusal is a fixed notice and makes no model or tool call.
      const receipt = await resolveStaffReceipt({
        channelId, workspaceId: channel.workspaceId, creds, senderId: incoming.userId,
        assistantWorkspaceId: assistant.workspaceId ?? null, notify,
      })
      if (!receipt) return
      const ownerId = await billingPartyForAssistant({
        id: assistant.id,
        ownerUserId: assistant.ownerUserId ?? null,
        workspaceId: assistant.workspaceId ?? null,
      })
      const sessionChannelId = wechatSessionChannelId(receipt)

      // The receipt keys the confirmation scope, so an answer after a rebind
      // cannot reach the previous principal's pending capability.
      const scope: ChannelInteractionScope = {
        channelType: 'wechat', integrationId: channelId,
        conversationId: incoming.channelId, senderId: incoming.userId,
        sessionId: sessionChannelId,
      }
      if (channelConfirmations.handle(scope, { kind: 'text', text: incoming.text }).handled) return

      // 7. Sequentialize per DM peer.
      await withChatLock(`wechat:${channelId}:${peerId}`, () =>
        processMessage({
          adapter,
          incoming,
          assistant,
          receipt,
          sessionChannelId,
          ownerId,
          routing,
          integrationId: integration.id,
          channelId,
          creds,
          scope,
          questionIntegrationId: integration.id,
          archiveConnectorInstanceId: integration.connectorInstanceId,
        }),
      )
    } catch (err) {
      console.error(`[wechat] error processing message for channel ${channelId}:`, err)
    }
  })

  async function handleLinkCommand(args: {
    channelId: string
    botId: string
    senderId: string
    code: string | null
    notify: (text: string) => Promise<void>
  }): Promise<void> {
    if (!options.identityStore) {
      await args.notify(WECHAT_IDENTITY_NOTICES.unverified)
      return
    }
    let result: ClaimWechatLinkCodeResult
    try {
      result = await options.identityStore.claimWechatLinkCode(args)
    } catch (err) {
      console.error(`[wechat] channel ${args.channelId}: link claim failed:`, (err as Error).message)
      await args.notify(WECHAT_IDENTITY_NOTICES.unverified)
      return
    }
    options.analytics?.logEvent({
      userId: result.ok ? result.receipt.accountId : '00000000-0000-0000-0000-000000000000',
      eventName: result.ok ? 'wechat_link_claimed' : 'wechat_link_rejected',
      channelType: 'wechat',
      metadata: {
        channel_id: sanitizeAnalytics(args.channelId),
        ...(result.ok ? { idempotent: result.idempotent } : { reason: sanitizeAnalytics(result.reason) }),
      },
    })
    await args.notify(result.ok ? WECHAT_LINK_REPLIES.linked : WECHAT_LINK_REPLIES[result.reason])
  }

  /**
   * The QR-bound sender, an active uncontested transport, a current binding,
   * live membership, and an assistant of this workspace - or a fixed notice
   * and null. Never the billing owner, a creator, a shadow or a session owner.
   */
  async function resolveStaffReceipt(args: {
    channelId: string
    workspaceId: string
    creds: WechatCredentials
    senderId: string
    assistantWorkspaceId: string | null
    notify: (text: string) => Promise<void>
  }): Promise<WechatIdentityReceipt | null> {
    if (!options.identityStore) {
      await args.notify(WECHAT_IDENTITY_NOTICES.unverified)
      return null
    }
    if (!isQrBoundSender(args.senderId, args.creds)) {
      await args.notify(WECHAT_IDENTITY_NOTICES.notOwner)
      return null
    }
    if (args.assistantWorkspaceId !== args.workspaceId) {
      await args.notify(WECHAT_IDENTITY_NOTICES.assistantUnavailable)
      return null
    }
    try {
      const resolved = await options.identityStore.resolveWechatSender({
        channelId: args.channelId, botId: args.creds.ilink_bot_id, senderId: args.senderId,
      })
      if (resolved.kind === 'transport_inactive') return null
      if (resolved.kind === 'conflict') { await args.notify(WECHAT_IDENTITY_NOTICES.conflict); return null }
      if (resolved.kind === 'unbound') { await args.notify(WECHAT_IDENTITY_NOTICES.unlinked); return null }
      const role = await getWorkspaceRoleSystem(resolved.receipt.accountId, args.workspaceId, true)
      if (!role) { await args.notify(WECHAT_IDENTITY_NOTICES.accessRemoved); return null }
      return resolved.receipt
    } catch (err) {
      console.error(`[wechat] channel ${args.channelId}: identity resolution failed:`, (err as Error).message)
      await args.notify(WECHAT_IDENTITY_NOTICES.unverified)
      return null
    }
  }

  async function processMessage(params: {
    adapter: ReturnType<typeof createWechatAdapter>
    incoming: IncomingMessage
    assistant: Awaited<ReturnType<typeof findAssistantById>> & {}
    receipt: WechatIdentityReceipt
    sessionChannelId: string
    ownerId: string
    routing: { assistantId: string; modelAlias: string }
    integrationId: string
    channelId: string
    creds: WechatCredentials
    scope: ChannelInteractionScope
    questionIntegrationId: string
    archiveConnectorInstanceId?: string | null
  }): Promise<void> {
    const { adapter, incoming, assistant, receipt, sessionChannelId, ownerId, routing, channelId, creds } = params
    const channelUserId = receipt.accountId
    const peerId = incoming.channelId
    const raw = incoming.raw as WeixinMessage | undefined

    // ── Build content blocks (text + downloaded/decrypted media) ──
    // iLink media is AES-encrypted on the CDN, so bytes are pulled and
    // decrypted here (the generic URL acquirers can't). Voice notes with
    // server STT already arrived as text via the adapter.
    const userContentBlocks: ContentBlock[] = []
    const mediaItem = raw ? findWechatMediaItem(raw.item_list) : null
    // An attachment WITH a caption survives `parseIncoming` on its text alone,
    // so the connector's drop-path log never fires and the message archives as
    // text-only — the attachment gone with no trace. Report the rejection here
    // (structure only, no content) so both shapes are visible.
    if (!mediaItem && raw?.item_list?.some((i) => i.type != null && i.type !== WeixinItemType.TEXT)) {
      console.warn(
        `[wechat] inbound carried a non-text item that is not downloadable — no bytes archived: ${describeWechatPayload(raw)}`,
      )
    }
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
            // `channel_integrations.connector_instance_id` is routinely null —
            // a QR-paired WeChat bot never sets it — while the append path
            // mints the archive instance lazily on first message. Requiring
            // the integration's copy here made every attachment fail with
            // `availability: 'failed'` on a channel whose text messages
            // archived perfectly. Fall back to the SAME memoized resolver the
            // append uses, so the asset and its message row cannot land under
            // different instance ids.
            const archiveInstanceId = params.archiveConnectorInstanceId
              ?? await resolveChatArchiveInstanceId({
                source: 'wechat',
                ownerUserId: ownerId,
                workspaceId: assistant.workspaceId,
                assistantId: routing.assistantId,
                assistantName: assistant.name ?? '',
                conversationId: peerId,
              })
            if (!archiveInstanceId) {
              throw new Error('wechat archive instance could not be resolved')
            }
            const asset = await options.archiveMedia.storeBuffer({
              workspaceId: assistant.workspaceId,
              instanceId: archiveInstanceId,
              ownerUserId: ownerId,
              source: 'wechat',
              providerMessageId: incoming.messageId,
              kind: archiveKind,
              filename: media.name,
              mime: media.mime,
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
                channelId: sessionChannelId,
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
            text: '[The user sent a voice message. You cannot hear it directly. It is archived and '
              + 'transcribed asynchronously — use searchChatHistory to retrieve the transcript. '
              + 'If the search returns nothing, transcription has not finished yet; say so rather '
              + 'than saying the content is unavailable.]',
          })
        } else if (media.kind === 'video') {
          userContentBlocks.push({
            type: 'text',
            text: '[The user sent a video. You cannot watch it directly. It is archived and its '
              + 'frames and audio are described asynchronously — use searchChatHistory to retrieve '
              + 'those descriptions. If the search returns nothing, processing has not finished yet; '
              + 'say so rather than saying the content is unavailable.]',
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
      interactionScope: params.scope,
      incomingMessage: incoming,
      questionIntegrationId: params.questionIntegrationId,
      questionStore: options.questionStore,
      backgroundModel: options.backgroundModel,
      decisionRuntime: options.decisionRuntime,
      userId: channelUserId,
      ownerId,
      assistant: { ...assistant, ownerUserId: ownerId },
      // The bound account is the actor; the workspace billing party pays.
      isIdentified: true,
      senderLinkedIdentity: true,
      connectorAuthority: 'sender',
      actorChannelId: incoming.userId,
      credentialCurrent: () => options.identityStore!.isWechatReceiptCurrent(receipt),
      channelType: 'wechat',
      channelId: peerId,
      sessionChannelId,
      channelIntegrationId: params.integrationId,
      channelIntegrationStore: options.integrationStore,
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
      configuredProviders: options.configuredProviders,
      resolveWorkspaceCustomLlm: options.resolveWorkspaceCustomLlm,
      publishSessionEvent: options.publishSessionEvent,
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
      knowledgeCaptureRuleStore: options.knowledgeCaptureRuleStore,
      gdriveFilesStore: options.gdriveFilesStore,
      workspaceFilesStore: options.workspaceFilesStore,
      artifactPromoter: options.artifactPromoter ?? null,
      skillStore: options.skillStore,
      workflowStore: options.workflowStore,
      workspaceSkillStore: options.workspaceSkillStore,
      workspaceSkillEnablementStore: options.workspaceSkillEnablementStore,
      workspaceSkillFilesStore: options.workspaceSkillFilesStore,
      workerManager: options.workerManager,
      episodicStore: options.episodicStore,
      sessionStateStore: options.sessionStateStore,
      crmEmailDraftStore: options.crmEmailDraftStore,
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
        async onGoalAccepted(message) {
          await adapter.sendMessage(peerId, { text: message })
        },
        async onConfirmationRequired(req) {
          await cancelTyping()
          await adapter.sendMessage(peerId, confirmationMessage(req))
        },
        async sendResponse(text, documents, _question, actions) {
          const finalText = text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
          const reply = finalText || (documents?.length ? '' : "I couldn't generate a reply - please rephrase or try again.")
          await cancelTyping()
          const channelMessageId = await adapter.sendMessage(peerId, { text: reply, format: 'markdown', documents, actions })
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
            text: channelUserErrorText(err),
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
