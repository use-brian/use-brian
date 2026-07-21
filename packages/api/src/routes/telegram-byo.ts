// REBRAND-CUTOVER: this file contains sidan.ai runtime values that must flip to usebrian.ai when DNS + Vercel domains + OAuth consoles + webhooks are cut over. Grep REBRAND-CUTOVER.
/**
 * Telegram BYO webhook route — per-channel BYO credentials.
 *
 * See docs/architecture/channels/adapter-pattern.md.
 * Component tag: [COMP:api/telegram-byo-route].
 *
 * The route is mounted at `/webhook/telegram/:channelId` — the workspace
 * `channels` id, registered with Telegram via setWebhook. The *answering*
 * assistant is resolved from the channel: `channel_assistants` routes per
 * Telegram chat, falling back to the channel default (see
 * docs/architecture/channels/adapter-pattern.md). Each request:
 *
 *   1. Fetches the Telegram integration from channel_integrations by the URL's
 *      channel id (no RLS — the request has no authenticated user yet). If
 *      that misses, falls back to resolving via assistant id — legacy bots
 *      registered before the channels split still have an assistant id baked
 *      into their stored Telegram webhook URL, and rather than 404 them into
 *      silence we resolve the integration, process the message normally, and
 *      fire-and-forget re-issue `setWebhook` with the new URL so the bot
 *      self-heals on its next inbound delivery. No user reconnect needed.
 *   2. Verifies the X-Telegram-Bot-Api-Secret-Token header against the
 *      integration's stored webhook_secret.
 *   3. Builds a per-request TelegramAdapter from the decrypted bot token.
 *   4. Resolves the answering assistant via `channels` / `channel_assistants`,
 *      resolves the sender, runs the query loop.
 */

import { Router } from 'express'
import { createTelegramAdapter, createTelegramApi, verifyTelegramWebhook, validateTelegramCredentials, TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES } from '@use-brian/channels'
import type { IncomingMessage, TelegramAdapterConfig, RequireMentionConfig, ChatSeenEvent } from '@use-brian/channels'
import { findAssistantById, findUserById } from '../db/users.js'
import { getWorkspaceRoleSystem } from '../db/workspace-store.js'
import { query } from '../db/client.js'
import { resolveChannelUser, fetchTelegramProfile, type ChannelUserStore } from '../db/channel-user-store.js'
import { resolveAssistantForSurface, resolveRoutingForSurface, getChannelForWebhook } from '../db/channels-store.js'
import type { LinkedAccountStore } from '../db/linked-accounts.js'
import { withChatLock } from '../db/chat-lock.js'
import { buildDocumentFiledReply, buildOversizeDocReply } from '../ingest/channel-media-intake.js'
import type { ConfirmationDecision, ConfirmationResolver, ContentBlock } from '@use-brian/core'
import type { LLMProvider, Tool, MemoryStore, UsageStore, AnalyticsLogger, McpSettingsStore, KnowledgeStoreInterface, GDriveFilesStore, TokenUsage } from '@use-brian/core'
import { transcribeFirstAudio, sanitize as sanitizeAnalytics, type MediaBackend } from '@use-brian/core'
import type { ChannelIntegrationStore, ChannelIntegrationConfig, TelegramCredentials, SeenChat } from '../db/channel-integrations.js'
import type { ConnectorStore } from '../db/connector-store.js'
import type { AssistantConnectorStore } from '../db/assistant-connector-store.js'
import { getToolDisplayName, humanizeToolName, describeToolInput, formatConfirmationInput } from '@use-brian/shared'
import { processChannelMessage } from './channel-pipeline.js'
import { cacheInboundImage } from './channel-file-cache.js'
import { billingPartyForAssistant } from '../billing-party.js'
import { buildFileContentBlocks } from './route-helpers.js'
import { handleConnectCommand } from './_connect-command.js'
import { tryResolveSchedulerConfirmation } from '../scheduling/confirmation-registry.js'
import type { DeferredConfirmationStore } from '../db/deferred-confirmation-store.js'
import { randomUUID } from 'node:crypto'
import { createEpisode } from '../db/episodes-store.js'
/**
 * Recording-to-brain ingest PORT. The transcription pipeline + credit
 * surcharge math are a closed (hosted) implementation injected via
 * `buildChannelHosts`; the open route only quotes the surcharge and hands the
 * downloaded bytes over. Absent (OSS) → audio files fall through to the
 * normal file-attachment path.
 */
export type ChannelRecordingIngest = {
  /** Credit surcharge quote for a recording of `durationSec`. 0 → transcribe without confirming. */
  surchargeCredits: (durationSec: number) => number
  /** Transcribe → segment → ingest → charge-on-success. */
  run: (input: {
    recordingId: string
    workspaceId: string
    assistantId: string
    userId: string
    audio: { buffer: Buffer; mime: string; durationMs: number }
    sensitivity: 'internal'
  }) => Promise<{ surchargeCredits: number; truncated: boolean }>
}
// getConnectorUserId now used inside channel-pipeline.ts

type TelegramByoRouteOptions = {
  provider: LLMProvider
  systemPrompt: string
  tools: Map<string, Tool>
  memoryStore: MemoryStore
  usageStore?: UsageStore
  checkCreditBudget?: import('./route-helpers.js').CreditBudgetGate
  /** Absolute base URL for the web app; used by the /connect Mini App button. */
  appUrl?: string
  /**
   * Absolute base URL for this API service. Used to re-register Telegram
   * webhooks when a legacy assistant-id URL is detected (channel-integrations
   * split self-heal — see the route JSDoc above).
   */
  apiUrl: string
  integrationStore: ChannelIntegrationStore
  linkedAccountStore?: LinkedAccountStore
  channelUserStore?: ChannelUserStore
  workerManager?: import('@use-brian/core').WorkerManager
  connectorStore?: ConnectorStore
  mcpSettingsStore?: McpSettingsStore
  assistantConnectorStore?: AssistantConnectorStore
  /** Stage 4 of the team-connector promotion: enables team-exposure grant consumption. */
  connectorGrantStore?: import('../db/connector-grant-store.js').ConnectorGrantStore
  /** Stage 5: enables team-native connector_instance consumption. */
  connectorInstanceStore?: import('../db/connector-instance-store.js').ConnectorInstanceStore
  /** Shared workspace tool policy (migration 312) — team-owned connector allow/ask/block. */
  workspaceToolPolicyStore?: import('../db/workspace-tool-policy-store.js').WorkspaceToolPolicyStore
  knowledgeStore?: KnowledgeStoreInterface
  gdriveFilesStore?: GDriveFilesStore
  /** Workspace files store (Q3 §10). Optional. */
  workspaceFilesStore?: import('@use-brian/core').WorkspaceFilesStore
  /** Files orchestration API. Enables outbound documents (`sendFile`). */
  filesApi?: import('@use-brian/core').FilesApi
  /** Transient upload cache (`file_cache`). When present, inbound photos are
   *  cached before block-building so the `<attached_file id>` tag gives the
   *  model a promotable reference (`saveFileToBrain` on request). See
   *  docs/architecture/engine/file-handling.md → "Save-on-request". */
  fileStore?: import('@use-brian/core').FileStore
  /** Promotes an over-threshold text paste to a durable artifact
   *  (large-content-artifacts §Phase 3.2). Absent ⇒ pastes pass through. */
  artifactPromoter?: import('@use-brian/api/files/artifact-promote.js').ArtifactPromoter | null
  analytics?: AnalyticsLogger
  skillStore?: import('../db/skill-store.js').SkillStore
  pendingMessageStore?: import('../db/pending-message-store.js').PendingMessageStore
  deferredConfirmationStore?: DeferredConfirmationStore
  episodicStore?: import('@use-brian/core').EpisodicStore
  sessionStateStore?: import('@use-brian/core').SessionStateStore
  capabilityStore: import('@use-brian/core').CapabilityStore
  /**
   * Voice-message transcription config. Mirrors the official Telegram route —
   * see docs/architecture/media/transcription.md.
   */
  voiceTranscription?: {
    enabled: boolean
    apiKey: string
    backend?: MediaBackend
    model?: string
  }
  /**
   * Recording-to-brain deps. When wired, an inbound audio FILE (`msg.audio` — a
   * deliberate recording, not a quick voice note) under the 20MB bot download
   * cap is routed through the transcription pipeline: confirm the duration
   * surcharge via inline buttons, then transcribe → segment → ingest → charge.
   * Omitted → audio files fall through to the normal file-attachment path. See
   * docs/architecture/media/transcription.md.
   */
  recordingIngest?: ChannelRecordingIngest
  /**
   * Route inbound document / video (≤ the 20MB bot cap) through the universal
   * channel-media intake for durability. Audio is NOT routed here on BYO — it
   * keeps the inline `recordingIngest` port path above (queue migration is a
   * separate remaining item). See large-content-artifacts §Phase 0.3.
   */
  ingestChannelMediaRef?: (input: {
    source: { url: string }
    mime?: string
    fileName: string | null
    sizeBytes: number | null
    sender: { id: string; name: string | null }
    conversationId: string
    workspaceId: string
    assistantId: string | null
    actingUserId: string
  }) => Promise<import('../ingest/channel-media-intake.js').ChannelMediaIntakeResult | null>
}

/**
 * Decide whether a verified Telegram identity link should be honored as the
 * sender's real identity on THIS BYO bot.
 *
 * `linked_identities (provider, provider_id)` is globally unique, so a TG user
 * linked to assistant A must not be served under their real identity on
 * assistant B's bot (cross-tenant memory/persona leak). A link binds here when
 * ANY of:
 *   - it routes to this exact assistant (`assistantId` match), or
 *   - the linked user is the assistant's billing-party owner, or
 *   - the linked user is a member of this assistant's workspace.
 *
 * The third branch is the fix for the "no tasks" incident (2026-06-02): a
 * workspace-owned assistant has `assistants.owner_user_id IS NULL`, so its
 * admins/members are NOT the billing-party owner and the `=== ownerId` check
 * never matched them. They were dropped to an anonymous channel shadow that
 * sits in `assistant_members` but not `workspace_members`, so every
 * workspace-scoped brain read (tasks/memories/CRM) came back empty under the
 * `tasks_workspace_member` RLS policy — the assistant was bound to the
 * workspace, but its reader identity was not. Membership is the same gate RLS
 * applies downstream, so honoring the link here cannot widen what the user can
 * read: a stranger linked to another tenant who is not a member of this
 * workspace still stays a shadow.
 */
export async function telegramLinkBindsHere(
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

export function telegramByoRoutes(options: TelegramByoRouteOptions): Router {
  const router = Router()

  // Pending confirmation resolvers — keyed by `chatId:toolCallId`
  type PendingConf = { resolver: ConfirmationResolver; chatId: string }
  const pendingConfResolvers = new Map<string, PendingConf>()

  // Pending recording-surcharge confirmations — keyed by a short token embedded
  // in the inline-button callback data (`rec_confirm:<token>:<yes|no>`). The
  // bytes are re-downloaded on confirm (the Telegram file_id is stable), so the
  // entry only holds the routing + billing metadata. In-memory like
  // pendingConfResolvers; a missed click after a restart just expires.
  type PendingRecording = {
    fileId: string
    mime: string
    durationSec: number
    channelId: string
    assistantId: string
    workspaceId: string
    ownerId: string
  }
  const pendingRecordings = new Map<string, PendingRecording>()

  // Cross-webhook media-group buffer.
  //
  // Telegram delivers a media group (multiple photos sent as one
  // user-intent moment) as N independent webhook updates that share a
  // `media_group_id`. The adapter has its own per-instance buffer for this,
  // but BYO builds a fresh adapter per request (per-tenant credentials),
  // so the adapter's buffer can't merge across webhooks. Without a
  // route-level buffer each photo would fire its own pipeline turn — the
  // model would reply once per card instead of once for the whole group.
  //
  // This Map is keyed by `${channelId}:${media_group_id}`. Each entry
  // accumulates raw `TelegramMessage`s and stores the latest webhook's
  // `flush` closure (which captures that request's adapter, integration,
  // assistant, etc.). After 500ms of buffer idle, the closure synthesizes
  // ONE merged `IncomingMessage` carrying `files[]` and routes it through
  // `handleIncoming`. Downloads then happen in parallel via Promise.all.
  // See docs/architecture/channels/adapter-pattern.md → "Telegram media
  // groups".
  // Minimal shape of the raw inbound `update.message` we need to merge a
  // media group. Matches the relevant subset of Telegram's `Message` type;
  // we keep it local rather than reaching into the channels package's
  // internal `TelegramMessage` definition.
  type RawTelegramGroupMessage = {
    message_id: number
    caption?: string
    text?: string
    media_group_id?: string
    photo?: Array<{ file_id: string }>
    document?: { file_id: string; mime_type?: string; file_name?: string }
    video?: { file_id: string; mime_type?: string }
  }
  type MediaGroupEntry = {
    rawMessages: RawTelegramGroupMessage[]
    timer: ReturnType<typeof setTimeout>
  }
  const mediaGroupBuffers = new Map<string, MediaGroupEntry>()
  const MEDIA_GROUP_BUFFER_MS = 500

  router.post<{ channelId: string }>('/:channelId', async (req, res) => {
    // URL slug semantics:
    //   - Post channel-integrations-split: workspace `channels` id.
    //   - Legacy (pre-split): assistant id baked into the Telegram-side
    //     webhook URL by the old setWebhook caller. We fall back to that
    //     lookup and self-heal — see the route JSDoc above.
    const urlParam = req.params.channelId

    // 1. Fetch integration (skips RLS — webhooks arrive pre-auth). First try
    //    the canonical channels-id lookup; on miss, treat the slug as an
    //    assistant id (legacy URL).
    const byChannel = await options.integrationStore.getByChannelForWebhook(
      urlParam,
      'telegram',
    )
    const byAssistant = byChannel
      ? null
      : await options.integrationStore.getCredentialsForAssistantSystem(
          urlParam,
          'telegram',
        )
    const integration = byChannel ?? byAssistant
    if (!integration) {
      res.status(404).end()
      return
    }
    const isLegacyUrl = byChannel === null && byAssistant !== null

    const credentials = integration.credentials as TelegramCredentials

    // 2. Verify the webhook secret
    const secretHeader = req.header('x-telegram-bot-api-secret-token')
    if (!verifyTelegramWebhook(credentials.webhook_secret, secretHeader)) {
      res.status(401).end()
      return
    }

    // ACK immediately — Telegram retries if no response
    res.status(200).end()

    // Self-heal stale Telegram-side webhook URLs. Fire-and-forget; if
    // setWebhook fails the next inbound delivery will retry. Idempotent on
    // Telegram's side (just re-POSTs the same URL).
    if (isLegacyUrl) {
      console.warn(
        `[telegram-byo] legacy assistant-id URL ${urlParam} → channel ${integration.channelId}; re-registering with Telegram`,
      )
      const newUrl = `${options.apiUrl}/webhook/telegram/${integration.channelId}`
      createTelegramApi({ token: credentials.bot_token })
        .setWebhook(newUrl, credentials.webhook_secret)
        .catch((err) => {
          console.error('[telegram-byo] legacy URL setWebhook failed:', err)
        })
    }

    // Fire-and-forget: touch last_event_at so the UI can show freshness.
    options.integrationStore.touchLastEventAt(integration.id).catch((err) => {
      console.error('[telegram-byo] touchLastEventAt failed:', err)
    })

    // 3. Resolve the channel's default assistant via the workspace channel.
    //    Use the resolved `integration.channelId` — the URL slug may be a
    //    legacy assistant id, not the canonical channels.id.
    //    `channel_assistants` routes per external surface (the Telegram chat
    //    id), else the channel default. Capability gate: a revoked channel, or
    //    one with `chat` disabled, rejects inbound. The per-chat override is
    //    re-resolved inside `handleIncoming` once the chat id is known.
    //    See docs/architecture/channels/adapter-pattern.md.
    const channel = await getChannelForWebhook(integration.channelId)
    if (!channel || channel.status !== 'active' || !channel.enabledCapabilities.includes('chat')) {
      console.warn(`[telegram-byo] channel ${integration.channelId} not accepting chat — ignoring inbound`)
      return
    }
    const defaultRouting = await resolveRoutingForSurface(integration.channelId, null)
    if (!defaultRouting) {
      console.error(`[telegram-byo] channel ${integration.channelId} has no assistant routing — ignoring inbound`)
      return
    }
    const defaultAssistantId = defaultRouting.assistantId

    const assistant = await findAssistantById(defaultAssistantId)
    if (!assistant) {
      console.error(`[telegram-byo] assistant ${defaultAssistantId} not found (integration orphaned?)`)
      return
    }
    // Per-routing model alias overrides the per-assistant default
    // (migration 197). Re-resolved per-message below if a surface-specific
    // routing row matches.
    assistant.telegramModelAlias = defaultRouting.modelAlias
    // Post-089 ownership XOR: team assistants have NULL owner_user_id and
    // team access flows through teams.owner_user_id. `billingPartyForAssistant`
    // is the single source of truth for "the authoritative user behind this
    // assistant" and handles both XOR branches.
    // See docs/architecture/integrations/mcp.md.
    const ownerId = await billingPartyForAssistant({
      id: assistant.id,
      ownerUserId: assistant.ownerUserId ?? null,
      workspaceId: assistant.workspaceId ?? null,
    })

    // 4. Build a per-request adapter with this integration's bot token.
    //    botUsername is required for group @mention detection; legacy rows
    //    predate the column so self-heal by calling getMe once and
    //    persisting the result before constructing the adapter.
    let botUsername = integration.botUsername
    if (!botUsername) {
      try {
        const info = await validateTelegramCredentials(credentials.bot_token)
        botUsername = info.botUsername
        options.integrationStore.setBotUsername(integration.id, botUsername).catch((err) => {
          console.error('[telegram-byo] bot_username backfill persist failed:', err)
        })
      } catch (err) {
        console.error('[telegram-byo] bot_username backfill via getMe failed:', err)
      }
    }

    const storedConfig = (integration.config ?? {}) as ChannelIntegrationConfig

    // Translate the stored JSONB config into the adapter's structured
    // `RequireMentionConfig` so per-chat/topic overrides are respected inside
    // `parseMessage`. Non-mention fields (ackReaction, etc.) pass through.
    const baseRequireMention = storedConfig.requireMention ?? true
    const requireMentionResolved: RequireMentionConfig = storedConfig.requireMentionOverrides?.length
      ? {
          default: baseRequireMention,
          overrides: storedConfig.requireMentionOverrides.map((o) => ({
            chatId: o.chatId,
            topicId: o.topicId ?? null,
          })),
        }
      : baseRequireMention
    const tgConfig: TelegramAdapterConfig = {
      ackReaction: storedConfig.ackReaction,
      requireMention: requireMentionResolved,
    }
    const routeAssistantId = assistant.id
    function reportIncomingFailure(kind: 'message' | 'media group', channelId: string, err: unknown): void {
      console.error(`[telegram-byo] error processing ${kind} for chat ${channelId}:`, err)
      options.analytics?.logEvent({
        userId: ownerId,
        assistantId: routeAssistantId,
        eventName: 'chat_route_error',
        channelType: 'telegram',
        metadata: {
          error_type: sanitizeAnalytics((err as Error)?.name ?? 'unknown'),
          error_message: sanitizeAnalytics(((err as Error)?.message ?? '').slice(0, 200)),
          stage: sanitizeAnalytics('telegram_byo_route_catch'),
        },
      })
      adapter.sendMessage(channelId, {
        text: 'Sorry, something went wrong while handling that message. Please send it again.',
      }).catch((sendErr) => {
        console.error('[telegram-byo] failure notice send failed:', sendErr)
      })
    }

    const adapter = createTelegramAdapter({
      token: credentials.bot_token,
      botUsername: botUsername ?? undefined,
      config: tgConfig,
      // `onMessage` can fire synchronously inside `handleWebhook` (single
      // message) OR asynchronously from a setTimeout (media-group buffer,
      // text-fragment reassembly). Routing through `handleIncoming` keeps
      // the post-extraction pipeline alive after the request handler has
      // already returned — the previous `extractedMessage = msg` capture
      // pattern silently dropped any message that arrived via a buffer
      // timer (e.g. the GM Bro 5:33 PM business-card media group, where
      // both photos vanished entirely from `session_messages`).
      onMessage: (msg) => {
        handleIncoming(msg).catch((err) => {
          reportIncomingFailure('message', msg.channelId, err)
        })
      },
      onChatSeen: (evt) => {
        // Fire-and-forget: persist observations so the settings UI can render
        // human-readable chat/topic names. Throttled inside `persistSeenChat`
        // so repeated messages from an already-known chat don't hammer the DB.
        persistSeenChat(options.integrationStore, integration.id, evt).catch((err) => {
          console.error('[telegram-byo] persistSeenChat failed:', err)
        })
      },
      onMyChatMember: async (evt) => {
        // Group add-protection: silently leave groups when the adder is not
        // the assistant owner (or a team owner/admin for team assistants).
        // See docs/architecture/channels/channel-user-identity.md → "BYO
        // Telegram group add-protection".
        if (!evt.isFreshJoin) return
        if (evt.chatType !== 'group' && evt.chatType !== 'supergroup' && evt.chatType !== 'channel') return

        // Resolve the adder via user_linked_accounts (same scoping rule as
        // DMs — a cross-tenant linked user is treated as unknown).
        let adderUserId: string | null = null
        if (options.linkedAccountStore) {
          try {
            const linked = await options.linkedAccountStore.findByProvider('telegram', evt.adderUserId)
            const linkBindsHere = await telegramLinkBindsHere(
              linked,
              assistant.id,
              ownerId,
              assistant.workspaceId ?? null,
            )
            if (linked?.userId && linkBindsHere) {
              adderUserId = linked.userId
            }
          } catch (err) {
            console.error('[telegram-byo] my_chat_member linked-account lookup failed:', err)
          }
        }

        let authorized = adderUserId === ownerId
        if (!authorized && adderUserId && assistant.workspaceId) {
          const role = await getWorkspaceRoleSystem(adderUserId, assistant.workspaceId)
          authorized = role === 'owner' || role === 'admin'
        }

        if (!authorized) {
          console.warn(
            `[telegram-byo] unauthorized add of assistant ${assistant.id} to chat ${evt.chatId} by tg:${evt.adderUserId} — leaving`,
          )
          adapter.leaveChat(evt.chatId).catch(() => {})
        }
      },
      onCallbackQuery: async (query) => {
        const parts = query.data.split(':')

        // Recording-surcharge confirm (inline buttons): rec_confirm:<token>:<yes|no>
        if (parts[0] === 'rec_confirm' && parts.length >= 3) {
          const token = parts[1]
          const yes = parts[2] === 'yes'
          const rec = pendingRecordings.get(token)
          pendingRecordings.delete(token)
          await adapter.answerCallbackQuery(query.id, { text: yes ? 'Transcribing...' : 'Cancelled' })
          if (query.messageId) {
            await adapter.editMessage(query.chatId, String(query.messageId), {
              text: yes ? 'Transcribing your recording...' : 'Cancelled.',
            }).catch(() => {})
          }
          if (rec && yes) {
            await runTelegramRecording(rec).catch((err) =>
              console.error('[telegram-byo] recording run failed:', err),
            )
          }
          return
        }

        // Parse: mcp_confirm:<toolCallId>:<decision>
        if (parts[0] !== 'mcp_confirm' || parts.length < 3) return

        const toolCallId = parts[1]
        const decision = parts[2] as ConfirmationDecision
        const confKey = `${query.chatId}:${toolCallId}`
        const pending = pendingConfResolvers.get(confKey)

        const label = decision === 'allow' ? 'Allowed' : decision === 'deny' ? 'Denied'
          : decision === 'always_allow' ? 'Always allowed' : 'Always denied'

        if (pending) {
          pending.resolver.resolve(toolCallId, decision)
          pendingConfResolvers.delete(confKey)

          await adapter.answerCallbackQuery(query.id, { text: label })
          if (query.messageId) {
            await adapter.editMessage(query.chatId, String(query.messageId), {
              text: `Tool action: ${label}`,
            })
          }
        } else if (tryResolveSchedulerConfirmation(toolCallId, decision, { channelType: 'telegram', channelId: String(query.chatId) })) {
          options.deferredConfirmationStore?.markResolved(toolCallId, decision)
            .catch((err) => console.error('[telegram-byo] deferred confirmation DB update failed:', err))

          await adapter.answerCallbackQuery(query.id, { text: label })
          if (query.messageId) {
            await adapter.editMessage(query.chatId, String(query.messageId), {
              text: `Tool action: ${label}`,
            })
          }
        } else {
          await adapter.answerCallbackQuery(query.id, { text: 'Expired or already handled' })
        }
      },
    })

    // Stable, non-null aliases for the closure below — TypeScript loses the
    // null-narrowing on `integration`/`assistant` across an `async function`
    // boundary because the callback could in principle fire later. They're
    // both `const` and proven non-null above, so widening the alias is safe.
    const boundIntegration = integration
    const boundAssistant = assistant

    // ── Recording-to-brain (Telegram upload path) ──────────────────
    // An audio FILE (msg.audio) is a deliberate recording; route it through the
    // transcription pipeline. Re-downloads the bytes (file_id is stable), creates
    // a provenance Episode, runs transcribe → segment → ingest → charge-on-success,
    // then replies. See docs/architecture/media/transcription.md.
    async function runTelegramRecording(rec: PendingRecording): Promise<void> {
      if (!options.recordingIngest) return
      try {
        const dl = await adapter.downloadMedia(rec.fileId, { mimeHint: rec.mime })
        const episode = await createEpisode(rec.ownerId, {
          sourceKind: 'recording',
          sourceRef: { channel: 'telegram', durationSec: rec.durationSec },
          occurredAt: new Date(),
          workspaceId: rec.workspaceId,
          userId: null, // workspace-shared via the assistant
          assistantId: rec.assistantId,
          createdByUserId: rec.ownerId,
          sensitivity: 'internal',
        })
        const result = await options.recordingIngest.run({
          recordingId: episode.id,
          workspaceId: rec.workspaceId,
          assistantId: rec.assistantId,
          userId: rec.ownerId,
          audio: { buffer: dl.buffer, mime: rec.mime, durationMs: rec.durationSec * 1000 },
          sensitivity: 'internal',
        })
        const lines = [
          `Transcribed your recording${result.surchargeCredits > 0 ? ` (${result.surchargeCredits} credits)` : ''} and filed it to the brain.`,
        ]
        if (result.truncated) lines.push('(It was long, so I filed what I could.)')
        await adapter.sendMessage(rec.channelId, { text: lines.join(' ') }).catch(() => {})
      } catch (err) {
        console.error('[telegram-byo] recording transcription failed:', err)
        await adapter.sendMessage(rec.channelId, {
          text: 'Something went wrong transcribing that recording. Please try again.',
        }).catch(() => {})
      }
    }

    // Decide what to do with an inbound audio file: refuse over the 20MB bot cap,
    // confirm the duration surcharge via inline buttons when >3 min, else
    // transcribe directly (free, sub-3-min).
    async function handleTelegramRecordingIntake(
      incoming: IncomingMessage,
      assistantId: string,
      assistantWorkspaceId: string | null,
      recOwnerId: string,
    ): Promise<void> {
      if (incoming.mediaSizeBytes && incoming.mediaSizeBytes > TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES) {
        const mb = Math.round(incoming.mediaSizeBytes / (1024 * 1024))
        const limitMb = Math.floor(TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES / (1024 * 1024))
        await adapter.sendMessage(incoming.channelId, {
          text: `This recording is about ${mb} MB, over the ${limitMb} MB limit I can pull through Telegram. Upload it in the web app at app.sidan.ai and I'll transcribe the whole thing.`,
        }).catch(() => {})
        return
      }
      if (!assistantWorkspaceId) {
        await adapter.sendMessage(incoming.channelId, {
          text: 'I can only file recordings for a workspace assistant.',
        }).catch(() => {})
        return
      }
      const fileId = incoming.mediaUrl
      if (!fileId) return
      const durationSec = incoming.mediaDurationSec ?? 0
      const rec: PendingRecording = {
        fileId,
        mime: incoming.mediaMime ?? 'audio/mpeg',
        durationSec,
        channelId: incoming.channelId,
        assistantId,
        workspaceId: assistantWorkspaceId,
        ownerId: recOwnerId,
      }
      const surcharge = options.recordingIngest?.surchargeCredits(durationSec) ?? 0
      if (surcharge > 0) {
        const token = randomUUID().slice(0, 12)
        pendingRecordings.set(token, rec)
        setTimeout(() => pendingRecordings.delete(token), 10 * 60 * 1000)
        const minutes = Math.max(1, Math.round(durationSec / 60))
        await adapter.sendMessage(incoming.channelId, {
          text: `Transcribe this ${minutes}-minute recording into the brain? It will cost about ${surcharge} credits.`,
          actions: [
            { id: 'yes', label: `Transcribe (${surcharge} credits)`, data: `rec_confirm:${token}:yes` },
            { id: 'no', label: 'Cancel', data: `rec_confirm:${token}:no` },
          ],
        }).catch(() => {})
      } else {
        await adapter.sendMessage(incoming.channelId, { text: 'Transcribing your recording...' }).catch(() => {})
        await runTelegramRecording(rec)
      }
    }

    // Per-message handler. Hoisted via `async function` so the `onMessage`
    // wiring above can reference it before its declaration. Closes over
    // the bound aliases, `ownerId`, `channelId`, `credentials`,
    // `tgConfig`, and `adapter` from the enclosing request scope.
    async function handleIncoming(incoming: IncomingMessage): Promise<void> {
      // 4b. Access control — silently ignore messages from unauthorized users.
      //     Supports both @handle (matched against from.username) and numeric ID.
      const integrationConfig = boundIntegration.config ?? {}
      const accessMode = integrationConfig.userAccessMode ?? 'allow_all'
      if (accessMode !== 'allow_all') {
        const raw = incoming.raw as { from?: { id: number; username?: string } }
        const fromId = String(raw.from?.id ?? incoming.userId)
        const fromUsername = raw.from?.username?.toLowerCase()

        const matchesEntry = (entry: string) => {
          if (entry.startsWith('@')) {
            return fromUsername === entry.slice(1).toLowerCase()
          }
          return fromId === entry
        }

        if (accessMode === 'allowlist') {
          const allowed = integrationConfig.allowedUserIds ?? []
          if (allowed.length > 0 && !allowed.some(matchesEntry)) return
        } else if (accessMode === 'blocklist') {
          const blocked = integrationConfig.blockedUserIds ?? []
          if (blocked.some(matchesEntry)) return
        }
      }

      // 4b.2. /connect intercept — hand the user off to web Settings via
      //       a Mini App button. BYO bots are pinned to a specific assistant,
      //       so only the owner can manage connectors here; non-owners get a
      //       polite refusal pointing them at the official shared bot.
      //       See docs/architecture/channels/telegram-mini-app.md → "/connect".
      if (/^\/connect(\b|$)/i.test((incoming.text ?? '').trim())) {
        const telegramUserIdStr = incoming.userId
        const linked = options.linkedAccountStore
          ? await options.linkedAccountStore.findByProvider('telegram', telegramUserIdStr)
          : null
        const isOwner = !!linked && linked.userId === ownerId
        const { message, handled } = handleConnectCommand({
          text: incoming.text ?? '',
          isLinked: !!linked,
          appUrl: options.appUrl,
          byoNonOwner: !!linked && !isOwner,
          // The BYO bot launched the Mini App, so its token is the one
          // that signs initData. Forward the handle so the verifier picks
          // the right HMAC key.
          botUsername: botUsername ?? undefined,
          // Open the connectors page in this bot's own workspace — the bare
          // legacy path dead-ends on the picker for multi-workspace users.
          // (Guarded non-null at the `findAssistantById` check above; the
          // optional chain is only for the hoisted-closure narrowing reset.)
          workspaceId: assistant?.workspaceId ?? undefined,
        })
        if (handled && message) {
          await adapter.sendMessage(incoming.channelId, message).catch((err) => {
            console.error('[telegram-byo] /connect reply failed:', err)
          })
          return
        }
      }

      // 4c. Ack reaction — instant visual feedback before processing starts
      if (tgConfig.ackReaction && incoming.messageId) {
        adapter.reactToMessage?.(incoming.channelId, incoming.messageId, tgConfig.ackReaction)
          .catch(() => {}) // non-critical
      }

      // 4d. Resolve the per-chat answering assistant via the workspace channel.
      //     `channel_assistants` routes per external surface (the Telegram
      //     chat id), else the channel default resolved above. The URL
      //     `:channelId` is the channel-level identity used for credentials,
      //     /connect, and group add-protection.
      //     See docs/architecture/channels/adapter-pattern.md.
      let routedAssistant = boundAssistant
      // C4 capability gate: a revoked channel, or one with `chat` disabled,
      // rejects inbound messages.
      const chatChannel = await getChannelForWebhook(boundIntegration.channelId)
      if (chatChannel && (chatChannel.status !== 'active' || !chatChannel.enabledCapabilities.includes('chat'))) {
        console.warn(`[telegram-byo] channel ${chatChannel.id} not accepting chat (status=${chatChannel.status}) — ignoring inbound`)
        return
      }
      const routedRouting = await resolveRoutingForSurface(
        boundIntegration.channelId,
        incoming.channelId,
      )
      if (routedRouting && routedRouting.assistantId !== boundAssistant.id) {
        const found = await findAssistantById(routedRouting.assistantId)
        if (found) routedAssistant = found
      }
      // Always override the runtime model alias from the matched routing
      // row — even when the routed assistant is the same as the bound one,
      // a per-surface row may override the channel-default tier.
      if (routedRouting) {
        routedAssistant.telegramModelAlias = routedRouting.modelAlias
      }
      const routedAssistantId = routedAssistant.id
      const routedOwnerId = routedAssistant.id === boundAssistant.id
        ? ownerId
        : await billingPartyForAssistant({
            id: routedAssistant.id,
            ownerUserId: routedAssistant.ownerUserId ?? null,
            workspaceId: routedAssistant.workspaceId ?? null,
          })

      // 5. Resolve sender: linked account → shadow (group only) → redirect (private).
      //    See docs/architecture/channels/channel-user-identity.md.
      //
      //    BYO bots are per-assistant, so unlinked strangers in a private DM
      //    used to silently fall back to the owner's identity and pollute the
      //    owner's memory. We now redirect them to the official shared bot
      //    (@use_brian_bot) instead. The owner onboards by linking via a
      //    6-char code from the web UI.
      let channelUserId = ownerId
      let isIdentified = true
      let privateChatRedirect = false
      // Tracks whether Step 1 found a linked-account row. Cannot be inferred
      // from `channelUserId === ownerId` because an owner who linked their
      // own Telegram would have found.id === ownerId, which would otherwise
      // cause Step 2 to re-run and (in a private chat) incorrectly redirect
      // the owner to the shared @use_brian_bot.
      let foundLinked = false
      const telegramUserId = incoming.userId

      if (options.linkedAccountStore && options.channelUserStore) {
        try {
          // Step 1: Check linked accounts, scoped to THIS assistant.
          // `linked_identities (provider, provider_id)` is globally unique, so
          // a TG user linked to assistant A would otherwise get served on
          // assistant B's BYO bot under their own identity (memory + persona
          // leak across tenants). `telegramLinkBindsHere` accepts the link only
          // when it routes to this assistant, the sender is the billing-party
          // owner, or the sender is a member of this assistant's workspace —
          // see channel-user-identity.md → "BYO Telegram bots".
          const linked = await options.linkedAccountStore.findByProvider('telegram', telegramUserId)
          const linkBindsHere = await telegramLinkBindsHere(
            linked,
            boundAssistant.id,
            ownerId,
            boundAssistant.workspaceId ?? null,
          )
          if (linked?.userId && linkBindsHere) {
            const found = await findUserById(linked.userId)
            if (found) {
              channelUserId = found.id
              isIdentified = true
              foundLinked = true
            }
          }

          // Step 2: Not linked → resolve via channel user store (creates shadow)
          if (!foundLinked && telegramUserId !== String(boundIntegration.botUserId ?? '')) {
            const resolved = await resolveChannelUser(
              options.channelUserStore,
              'telegram',
              telegramUserId,
              routedAssistantId,
              () => fetchTelegramProfile(telegramUserId, credentials.bot_token),
            )
            if (resolved.isIdentified) {
              // Tier 1: email matched → use resolved user with full memory
              channelUserId = resolved.user.id
              isIdentified = true
            } else if (incoming.isGroupChat) {
              // Tier 2 in group chat: keep shadow user, no memory (can't assume identity)
              channelUserId = resolved.user.id
              isIdentified = false
            } else {
              // Tier 2 in private chat: redirect to the official shared bot.
              // Telegram never exposes email, so unlinked private-chat users
              // cannot be identified. Rather than silently impersonate the
              // owner, we tell them to use @use_brian_bot (which has its own
              // Mini App sign-in onramp) or link via code from the web UI.
              privateChatRedirect = true
            }
          }
        } catch (err) {
          console.error('[telegram-byo] channel user resolution failed:', err)
          // On resolution failure in a private chat, redirect rather than
          // leak memory to the owner.
          if (!incoming.isGroupChat) privateChatRedirect = true
        }
      }

      if (privateChatRedirect) {
        await adapter.sendMessage(incoming.channelId, {
          text: "This is a private bot. To try Use Brian, DM @use_brian_bot to sign in and link your account.",
        }).catch((err) => {
          console.error('[telegram-byo] redirect message send failed:', err)
        })
        return
      }

      // 5b. Audio FILE → recording-to-brain pipeline instead of normal chat.
      //     A deliberate recording (msg.audio), routed to transcription + brain
      //     ingest with the duration surcharge. Voice notes stay on the existing
      //     voice-transcription-to-chat path. See docs/architecture/media/transcription.md.
      if (options.recordingIngest && incoming.mediaType === 'audio') {
        await handleTelegramRecordingIntake(
          incoming,
          routedAssistant.id,
          routedAssistant.workspaceId ?? null,
          routedOwnerId,
        )
        return
      }

      // 6. Sequentialize per chat via Postgres advisory lock
      await withChatLock(`tg-byo:${incoming.channelId}`, () =>
        processMessage({
          adapter,
          incoming,
          assistant: routedAssistant,
          channelUserId,
          ownerId: routedOwnerId,
          isIdentified,
          ...options,
          pendingConfResolvers,
        }),
      )
    }

    // Cross-webhook media-group routing. Telegram sends each photo of a
    // media group as its own webhook; the adapter's per-instance buffer
    // can't merge them in BYO (fresh adapter per request). Bypass the
    // adapter for media-group photos and accumulate them in a route-level
    // buffer so we can download in parallel and emit ONE turn.
    const rawUpdate = req.body as { message?: RawTelegramGroupMessage }
    const groupId = rawUpdate.message?.media_group_id
    if (groupId && rawUpdate.message) {
      const key = `${integration.channelId}:${groupId}`
      const incomingMsg = rawUpdate.message
      const existing = mediaGroupBuffers.get(key)
      const rawMessages = existing?.rawMessages ?? []
      rawMessages.push(incomingMsg)
      if (existing?.timer) clearTimeout(existing.timer)

      const timer = setTimeout(() => {
        mediaGroupBuffers.delete(key)
        // Synthesize a merged IncomingMessage from the accumulated raw
        // messages. The first message carries the caption (Telegram
        // convention); every message contributes one media file.
        const first = rawMessages[0]
        const base = adapter.parseIncoming({ message: { ...first, media_group_id: undefined } })
        if (!base) return
        const files = rawMessages
          .map((m): { url: string; mimeType: string; name: string } | null => {
            if (m.photo?.length) {
              return {
                url: m.photo[m.photo.length - 1].file_id,
                mimeType: 'image/jpeg',
                name: `photo_${m.message_id}.jpg`,
              }
            }
            if (m.document) {
              return {
                url: m.document.file_id,
                mimeType: m.document.mime_type ?? 'application/octet-stream',
                name: m.document.file_name ?? `document_${m.message_id}`,
              }
            }
            if (m.video) {
              return {
                url: m.video.file_id,
                mimeType: m.video.mime_type ?? 'video/mp4',
                name: `video_${m.message_id}.mp4`,
              }
            }
            return null
          })
          .filter((f): f is { url: string; mimeType: string; name: string } => f !== null)
        const merged: IncomingMessage = {
          ...base,
          // Multi-file shape supersedes the single mediaUrl/mediaType — the
          // processMessage media branch checks `files` first.
          mediaUrl: undefined,
          mediaType: undefined,
          mediaMime: undefined,
          mediaName: undefined,
          files,
        }
        handleIncoming(merged).catch((err) => {
          reportIncomingFailure('media group', merged.channelId, err)
        })
      }, MEDIA_GROUP_BUFFER_MS)

      mediaGroupBuffers.set(key, { rawMessages, timer })
      return
    }

    // Drive the adapter. `onMessage` may fire synchronously here OR later
    // via the media-group / text-fragment buffer timers — both paths now
    // route through `handleIncoming` (see comment on the `onMessage` field
    // above for the prior bug this replaces).
    adapter.handleWebhook(req.body)
  })

  return router
}

// ── Per-message handler ─────────────────────────────────────────

type ProcessMessageParams = {
  adapter: ReturnType<typeof createTelegramAdapter>
  incoming: IncomingMessage
  assistant: { id: string; name: string; ownerUserId: string; telegramModelAlias: string; workspaceId: string | null; systemPrompt: string | null; clearance: 'public' | 'internal' | 'confidential'; kind: 'primary' | 'standard' | 'app' }
  channelUserId: string
  ownerId: string
  isIdentified: boolean
  provider: LLMProvider
  systemPrompt: string
  tools: Map<string, Tool>
  memoryStore: MemoryStore
  usageStore?: UsageStore
  checkCreditBudget?: import('./route-helpers.js').CreditBudgetGate
  linkedAccountStore?: LinkedAccountStore
  channelUserStore?: ChannelUserStore
  workerManager?: import('@use-brian/core').WorkerManager
  connectorStore?: ConnectorStore
  mcpSettingsStore?: McpSettingsStore
  assistantConnectorStore?: AssistantConnectorStore
  /** Stage 4 of the team-connector promotion: enables team-exposure grant consumption. */
  connectorGrantStore?: import('../db/connector-grant-store.js').ConnectorGrantStore
  /** Stage 5: enables team-native connector_instance consumption. */
  connectorInstanceStore?: import('../db/connector-instance-store.js').ConnectorInstanceStore
  /** Shared workspace tool policy (migration 312) — team-owned connector allow/ask/block. */
  workspaceToolPolicyStore?: import('../db/workspace-tool-policy-store.js').WorkspaceToolPolicyStore
  knowledgeStore?: KnowledgeStoreInterface
  gdriveFilesStore?: GDriveFilesStore
  /** Workspace files store (Q3 §10). Optional. */
  workspaceFilesStore?: import('@use-brian/core').WorkspaceFilesStore
  /** Files orchestration API. Enables outbound documents (`sendFile`). */
  filesApi?: import('@use-brian/core').FilesApi
  /** Transient upload cache (`file_cache`) — inbound photos cached for
   *  save-on-request promotion. See file-handling.md → "Save-on-request". */
  fileStore?: import('@use-brian/core').FileStore
  /** Promotes an over-threshold text paste to a durable artifact
   *  (large-content-artifacts §Phase 3.2). Absent ⇒ pastes pass through. */
  artifactPromoter?: import('@use-brian/api/files/artifact-promote.js').ArtifactPromoter | null
  analytics?: AnalyticsLogger
  skillStore?: import('../db/skill-store.js').SkillStore
  pendingConfResolvers: Map<string, { resolver: ConfirmationResolver; chatId: string }>
  pendingMessageStore?: import('../db/pending-message-store.js').PendingMessageStore
  episodicStore?: import('@use-brian/core').EpisodicStore
  sessionStateStore?: import('@use-brian/core').SessionStateStore
  capabilityStore: import('@use-brian/core').CapabilityStore
  voiceTranscription?: {
    enabled: boolean
    apiKey: string
    backend?: MediaBackend
    model?: string
  }
  /** Universal channel-media intake for document/video (large-content-artifacts §Phase 0.3). */
  ingestChannelMediaRef?: TelegramByoRouteOptions['ingestChannelMediaRef']
  /** Web app origin for the oversize-document handoff copy. */
  appUrl?: string
}

async function processMessage(params: ProcessMessageParams): Promise<void> {
  const { adapter, incoming, assistant, channelUserId, ownerId, isIdentified } = params

  // Over-limit inbound media: a file above Telegram's 20MB bot download cap
  // (TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES) cannot be pulled via getFile, so a long
  // recording sent here would otherwise fail silently. Tell the user to use the
  // web app instead of dropping the message. Duration-aware transcription of
  // large recordings lives on the web upload path (recording-to-brain Phase 2).
  // See docs/architecture/media/transcription.md Phase 1.
  if (incoming.mediaSizeBytes && incoming.mediaSizeBytes > TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES) {
    const mb = Math.round(incoming.mediaSizeBytes / (1024 * 1024))
    const limitMb = Math.floor(TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES / (1024 * 1024))
    await adapter.sendMessage(incoming.channelId, {
      text: `This file is about ${mb} MB, over the ${limitMb} MB limit I can pull through Telegram, so I can't read the copy you sent here. To bring in a file this large, upload it in the web app at app.sidan.ai and I'll process the whole thing.`,
    }).catch((err) => {
      console.error('[telegram-byo] over-limit media notice failed:', err)
    })
    return
  }

  // ── Channel-media intake (large-content-artifacts §Phase 0.3) ──
  // Route document / video (≤ the 20MB cap) through the universal intake for
  // durability. Audio deliberately excluded on BYO — it keeps the inline
  // recordingIngestor path (queue migration is a separate remaining item).
  // Fire-and-forget beside the one-turn content-block path below.
  if (
    incoming.mediaUrl &&
    (incoming.mediaType === 'document' || incoming.mediaType === 'video') &&
    params.ingestChannelMediaRef &&
    assistant.workspaceId
  ) {
    const ingest = params.ingestChannelMediaRef
    const workspaceId = assistant.workspaceId
    adapter
      .resolveFileUrl(incoming.mediaUrl)
      .then((url) =>
        ingest({
          source: { url },
          ...(incoming.mediaMime ? { mime: incoming.mediaMime } : {}),
          fileName: incoming.mediaName ?? null,
          sizeBytes: incoming.mediaSizeBytes ?? null,
          sender: { id: channelUserId, name: null },
          conversationId: incoming.channelId,
          workspaceId,
          assistantId: assistant.id,
          actingUserId: ownerId,
        }),
      )
      .then(async (result) => {
        if (result?.status === 'pending_confirmation') {
          await adapter.sendMessage(incoming.channelId, { text: result.message })
          return
        }
        if (result?.status === 'ingested' && result.kind === 'document') {
          await adapter.sendMessage(incoming.channelId, { text: buildDocumentFiledReply(result.fileName) })
          return
        }
        if (result?.status === 'rejected' && result.reason === 'doc_too_large') {
          await adapter.sendMessage(incoming.channelId, {
            text: buildOversizeDocReply(params.appUrl ?? 'https://app.sidan.ai', result.limitMb ?? 25, result.sizeMb ?? 0),
          })
        }
      })
      .catch((err) => console.error('[telegram-byo] media→brain ingest failed:', err))
  }

  // Voice preflight — mirror the official telegram route. Transcribe the
  // voice note via Gemini and rewrite `incoming.text` so the rest of the
  // pipeline (pattern extractor, classifier, persistence, query loop)
  // treats it as plain text. Mutates the input by design — same pattern
  // as packages/api/src/routes/telegram.ts. See
  // docs/architecture/media/transcription.md.
  let voiceTranscriptionUsage: { usage: TokenUsage | null; model: string } | null = null
  if (
    incoming.mediaType === 'voice' &&
    incoming.mediaUrl &&
    params.voiceTranscription?.enabled
  ) {
    try {
      const { buffer, mime } = await adapter.downloadVoice(incoming.mediaUrl)
      const result = await transcribeFirstAudio(
        [{ buffer, mime, index: 0 }],
        {
          enabled: true,
          apiKey: params.voiceTranscription.apiKey,
          ...(params.voiceTranscription.backend
            ? { backend: params.voiceTranscription.backend }
            : {}),
          model: params.voiceTranscription.model,
        },
      )
      if (result) {
        voiceTranscriptionUsage = { usage: result.usage, model: result.model }
        incoming.text = incoming.text
          ? `[voice] ${result.text}\n\n${incoming.text}`
          : `[voice] ${result.text}`
      }
    } catch (err) {
      console.error('[telegram-byo] voice download/transcribe failed:', err)
    }
  }

  // Non-voice media preflight. Two shapes supported:
  //   1. `incoming.files[]` — N media files (Telegram media groups merged
  //      across webhooks at the route layer; see `mediaGroupBuffers` in
  //      `telegramByoRoutes`). Downloads run in parallel via Promise.all.
  //   2. `incoming.mediaUrl` — a single photo/document/video.
  // Voice is handled above and intentionally skipped — the transcript is
  // authoritative, the raw audio is not attached.
  // See docs/architecture/engine/file-handling.md.
  let mediaContentBlocks: ContentBlock[] = []
  let attachmentContext = ''
  // Save-on-request seam: cache an inbound image into file_cache FIRST so
  // buildFileContentBlocks stamps the `<attached_file id>` tag — that id is
  // what `saveFileToBrain` promotes when the user asks to keep the photo.
  // Session key mirrors this route's processChannelMessage call (userId =
  // channelUserId). Null (non-image / no store / failure) keeps the
  // block-only turn. See docs/architecture/engine/file-handling.md.
  const cacheImage = (file: { buffer: Buffer; mime: string; fileName: string }) =>
    params.fileStore
      ? cacheInboundImage({
          fileStore: params.fileStore,
          channelType: 'telegram',
          channelId: incoming.channelId,
          userId: channelUserId,
          assistant,
          file,
        })
      : Promise.resolve(null)
  if (incoming.files && incoming.files.length > 0) {
    try {
      const downloads = await Promise.all(
        incoming.files.map((f) =>
          adapter.downloadMedia(f.url, { mimeHint: f.mimeType }),
        ),
      )
      const cacheIds = await Promise.all(
        downloads.map((dl, i) =>
          cacheImage({
            buffer: dl.buffer,
            mime: dl.mime,
            fileName: incoming.files![i].name || dl.name,
          }),
        ),
      )
      const built = await buildFileContentBlocks(
        downloads.map((dl, i) => ({
          buffer: dl.buffer,
          mimeType: dl.mime,
          fileName: incoming.files![i].name || dl.name,
          ...(cacheIds[i] ? { id: cacheIds[i]! } : {}),
        })),
      )
      mediaContentBlocks = built.contentBlocks
      attachmentContext = built.attachmentContext
    } catch (err) {
      console.error('[telegram-byo] media-group download/parse failed:', err)
    }
  } else if (
    incoming.mediaUrl &&
    incoming.mediaType &&
    incoming.mediaType !== 'voice'
  ) {
    try {
      const dl = await adapter.downloadMedia(incoming.mediaUrl, {
        mimeHint: incoming.mediaMime,
      })
      const fileName = incoming.mediaName ?? dl.name
      const cacheId = await cacheImage({ buffer: dl.buffer, mime: dl.mime, fileName })
      const built = await buildFileContentBlocks([
        { buffer: dl.buffer, mimeType: dl.mime, fileName, ...(cacheId ? { id: cacheId } : {}) },
      ])
      mediaContentBlocks = built.contentBlocks
      attachmentContext = built.attachmentContext
    } catch (err) {
      console.error('[telegram-byo] media download/parse failed:', err)
    }
  }

  // Telegram-specific: tool status timeline (edit-in-place status message)
  type ToolEntry = { id: string; name: string; description?: string; done: boolean }
  const toolTimeline: ToolEntry[] = []
  let statusMessageId: string | null = null
  let lastStatusUpdate = 0
  const STATUS_THROTTLE_MS = 1500
  // Cap the timeline so a long browse (dozens of clicks) doesn't stack an
  // ever-growing wall of lines — keep the most recent actions (the live one
  // is always last) and summarize the rest into a single "+N earlier" header.
  const MAX_TIMELINE_LINES = 5

  function formatToolTimeline(): string {
    if (toolTimeline.length === 0) return 'Thinking...'
    const lines = toolTimeline.map((t) => {
      const label = t.description ?? humanizeToolName(t.name)
      return t.done ? `✓ ${label}` : `⏳ ${label}`
    })
    if (lines.length <= MAX_TIMELINE_LINES) return lines.join('\n')
    const hidden = lines.length - MAX_TIMELINE_LINES
    return [`(+${hidden} earlier step${hidden === 1 ? '' : 's'})`, ...lines.slice(-MAX_TIMELINE_LINES)].join('\n')
  }

  async function updateToolStatus(): Promise<void> {
    const now = Date.now()
    if (now - lastStatusUpdate < STATUS_THROTTLE_MS) return
    lastStatusUpdate = now
    const text = formatToolTimeline()
    try {
      if (statusMessageId) {
        await adapter.editMessage(incoming.channelId, statusMessageId, { text })
      } else {
        statusMessageId = await adapter.sendStatus(incoming.channelId, text)
      }
    } catch {
      // Edit/send failed — non-critical
    }
  }

  const combinedText = attachmentContext + incoming.text
  const userContentBlocks: ContentBlock[] = [...mediaContentBlocks]
  if (combinedText.trim().length > 0) {
    userContentBlocks.push({ type: 'text', text: combinedText })
  } else if (userContentBlocks.length === 0) {
    userContentBlocks.push({ type: 'text', text: '' })
  }

  // Telegram @handle from the inbound update → X-Sidanclaw-Actor-Id (absent for
  // users with no @username). Same raw access as the allowlist check above.
  const byoUsername = (incoming.raw as { from?: { username?: string } }).from?.username
  await processChannelMessage({
    userId: channelUserId,
    ownerId,
    assistant: { ...assistant, ownerUserId: ownerId },
    isIdentified,
    channelType: 'telegram',
    channelId: incoming.channelId,
    actorChannelId: byoUsername ? `@${byoUsername}` : null,
    messageText: combinedText,
    userContentBlocks,
    // Raw paste (pre-attachment-context) for the large-paste intercept.
    rawUserText: incoming.text ?? '',
    isGroupChat: incoming.isGroupChat,
    replyToMessageId: incoming.replyToMessageId ?? null,
    replyRaw: incoming.raw,
    incomingChannelMessageId: incoming.messageId ?? null,
    modelAlias: assistant.telegramModelAlias,
    adaptiveResearchEnabled: true,
    abortController: new AbortController(),
    provider: params.provider,
    systemPrompt: params.systemPrompt,
    tools: params.tools,
    memoryStore: params.memoryStore,
    usageStore: params.usageStore,
    checkCreditBudget: params.checkCreditBudget,
    analytics: params.analytics,
    connectorStore: params.connectorStore,
    mcpSettingsStore: params.mcpSettingsStore,
    assistantConnectorStore: params.assistantConnectorStore,
    connectorGrantStore: params.connectorGrantStore,
    connectorInstanceStore: params.connectorInstanceStore,
    workspaceToolPolicyStore: params.workspaceToolPolicyStore,
    knowledgeStore: params.knowledgeStore,
    gdriveFilesStore: params.gdriveFilesStore,
    workspaceFilesStore: params.workspaceFilesStore,
    filesApi: params.filesApi,
    artifactPromoter: params.artifactPromoter ?? null,
    skillStore: params.skillStore,
    pendingMessageStore: params.pendingMessageStore,
    workerManager: params.workerManager,
    episodicStore: params.episodicStore,
    sessionStateStore: params.sessionStateStore,
    capabilityStore: params.capabilityStore,
    voiceTranscriptionUsage,
    hooks: {
      async onProcessingStart() {
        await adapter.sendTypingIndicator(incoming.channelId)
      },
      async onStatus(message) {
        if (!statusMessageId) {
          statusMessageId = await adapter.sendStatus(incoming.channelId, message)
        }
      },
      async onToolStart(id, name) {
        toolTimeline.push({ id, name, done: false })
        await updateToolStatus()
      },
      async onToolInput(id, name, input) {
        const desc = describeToolInput(name, input)
        if (desc) {
          const entry = toolTimeline.find((t) => t.id === id)
          if (entry) entry.description = desc
          await updateToolStatus()
        }
      },
      async onToolResult(results) {
        for (const block of results) {
          if (block.type === 'tool_result') {
            const entry = toolTimeline.find((t) => t.id === (block as ContentBlock & { toolUseId?: string }).toolUseId)
            if (entry) entry.done = true
          }
        }
        await updateToolStatus()
      },
      async onConfirmationRequired(req, resolver) {
        const confKey = `${incoming.channelId}:${req.toolCallId}`
        params.pendingConfResolvers.set(confKey, { resolver, chatId: incoming.channelId })

        const lines = req.displayLines && req.displayLines.length > 0
          ? req.displayLines
          : formatConfirmationInput(req.input)
        const inputSummary = lines.length > 0 ? '\n\n' + lines.join('\n') : ''

        const actions = [
          { id: 'allow', label: 'Allow', data: `mcp_confirm:${req.toolCallId}:allow` },
          { id: 'deny', label: 'Deny', data: `mcp_confirm:${req.toolCallId}:deny` },
        ]
        if (req.allowPersistentApproval) {
          actions.push(
            { id: 'always', label: 'Always Allow', data: `mcp_confirm:${req.toolCallId}:always_allow` },
            { id: 'never', label: 'Always Deny', data: `mcp_confirm:${req.toolCallId}:always_deny` },
          )
        }

        const displayName = getToolDisplayName(req.toolName)
        await adapter.sendMessage(incoming.channelId, {
          text: `${displayName}${inputSummary}\n\nAllow this action?`,
          actions,
        })
      },
      async sendResponse(text) {
        // Delete the tool status message, then send response as a new message
        if (statusMessageId) {
          await adapter.deleteMessage?.(incoming.channelId, statusMessageId)
          statusMessageId = null
        }
        // Strip zero-width spaces (U+200B, U+FEFF) that some models emit as "empty" responses
        const cleaned = text.replace(/[\u200B\uFEFF]/g, '').trim()
        if (cleaned) {
          await adapter.sendMessage(incoming.channelId, { text, format: 'markdown' })
        } else {
          // Loud-fail after query-loop's empty-response retries exhausted.
          // See telegram.ts comment + docs/architecture/engine/query-loop.md.
          await adapter.sendMessage(incoming.channelId, {
            text: "I couldn't generate a reply — please rephrase or try again.",
          })
        }
      },
      async onDowngraded(resetsAt) {
        const resetNote = resetsAt
          ? ` Resets ${new Date(resetsAt).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, weekday: 'short' })}.`
          : ''
        const noticeId = await adapter.sendMessage(incoming.channelId, {
          text: `Running on the standard model: usage limit reached.${resetNote} Buy extra usage or upgrade in workspace settings for full speed.`,
        })
        if (noticeId) {
          await adapter.pinMessage?.(incoming.channelId, noticeId, { silent: true })
        }
        return noticeId || null
      },
      async onBudgetOk(pinMessageId) {
        if (pinMessageId) {
          await adapter.unpinMessage?.(incoming.channelId, pinMessageId)
        }
      },
      async sendError(err) {
        if (statusMessageId) {
          await adapter.deleteMessage?.(incoming.channelId, statusMessageId).catch(() => {})
          statusMessageId = null
        }
        await adapter.sendMessage(incoming.channelId, {
          text: err.message.includes('usage limit')
            ? err.message
            : 'Something went wrong. Please try again.',
        })
      },
    },
  })
}

// ── Seen-chat observation ──────────────────────────────────────

/**
 * Persist an observed chat/topic into `channel_integrations.config.seenChats`.
 * Writes are throttled to reduce DB churn on busy chats — we only write when
 * new information is actually added (new chat, new topic, or a name we didn't
 * have before) or when the `lastSeenAt` stamp is older than an hour.
 *
 * Exported for unit tests.
 */
const SEEN_CHAT_STALE_MS = 60 * 60 * 1000 // 1h

export async function persistSeenChat(
  store: ChannelIntegrationStore,
  integrationId: string,
  evt: ChatSeenEvent,
): Promise<void> {
  await store.mergeConfigSystem(integrationId, (current) => {
    const seen = current.seenChats ?? []
    const now = new Date().toISOString()

    const existingChat = seen.find((c) => c.chatId === evt.chatId)
    if (!existingChat) {
      const newChat: SeenChat = {
        chatId: evt.chatId,
        chatTitle: evt.chatTitle,
        isForum: evt.isForum,
        topics: evt.topicId != null
          ? [{ topicId: evt.topicId, name: evt.topicName, lastSeenAt: now }]
          : [],
        lastSeenAt: now,
      }
      return { ...current, seenChats: [...seen, newChat] }
    }

    // Decide whether this observation carries anything new.
    const chatStale = Date.now() - Date.parse(existingChat.lastSeenAt) > SEEN_CHAT_STALE_MS
    let dirty = chatStale
    let nextChat: SeenChat = { ...existingChat }

    if (evt.chatTitle && evt.chatTitle !== existingChat.chatTitle) {
      nextChat.chatTitle = evt.chatTitle
      dirty = true
    }
    if (evt.isForum && !existingChat.isForum) {
      nextChat.isForum = true
      dirty = true
    }

    if (evt.topicId != null) {
      const topics = existingChat.topics ?? []
      const existingTopic = topics.find((t) => t.topicId === evt.topicId)
      if (!existingTopic) {
        nextChat.topics = [
          ...topics,
          { topicId: evt.topicId, name: evt.topicName, lastSeenAt: now },
        ]
        dirty = true
      } else {
        const topicStale = Date.now() - Date.parse(existingTopic.lastSeenAt) > SEEN_CHAT_STALE_MS
        const nameImproved = evt.topicName != null && evt.topicName !== existingTopic.name
        if (topicStale || nameImproved) {
          nextChat.topics = topics.map((t) =>
            t.topicId === evt.topicId
              ? {
                  ...t,
                  name: nameImproved ? evt.topicName : t.name,
                  lastSeenAt: now,
                }
              : t,
          )
          dirty = true
        }
      }
    }

    if (!dirty) return current
    nextChat.lastSeenAt = now
    return {
      ...current,
      seenChats: seen.map((c) => (c.chatId === evt.chatId ? nextChat : c)),
    }
  })
}
