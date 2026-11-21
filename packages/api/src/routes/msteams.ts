import { dispatchIncomingMessageEvent } from '../message-events.js'
import type { ChannelQuestionStore } from '../workflow/channel-questions.js'
/**
 * Microsoft Teams webhook route — the Bot Framework messaging endpoint.
 *
 * Mounted at `/webhook/msteams`. Public (self-authenticating): each inbound
 * request carries a JWT in the `Authorization` header issued by Azure Bot
 * Service, which we verify against Bot Framework's OpenID metadata with the
 * per-channel App id as the required audience (see
 * docs/architecture/channels/msteams.md → "Inbound verification"). There is no
 * HMAC-over-body (Slack) or connector secret (Discord); the `serviceUrl` for
 * the reply is captured from the inbound Activity.
 *
 *   POST /webhook/msteams/:channelId   — `:channelId` is the workspace
 *                                        `channels` row id the operator pasted
 *                                        into the Azure Bot messaging endpoint.
 *
 * The answering assistant is resolved via `channel_assistants` (per Teams
 * conversation surface, else the channel default), the Teams sender → a
 * platform user via the channel-user identity path (tier 2 — Teams bots can't
 * cheaply read email), and the turn runs through the shared
 * `processChannelMessage` pipeline. Outbound replies go API → Bot Connector
 * (`serviceUrl`) with a freshly minted token.
 *
 * Component tag: [COMP:api/msteams-route].
 */

import { Router } from 'express'
import { createMsTeamsAdapter, createMsTeamsVerifier, type MsTeamsVerifier } from '@use-brian/channels'
import type { IncomingMessage } from '@use-brian/channels'
import { findAssistantById } from '../db/users.js'
import { withChatLock } from '../db/chat-lock.js'
import { resolveChannelUser, type ChannelUserStore } from '../db/channel-user-store.js'
import { resolveRoutingForSurface, resolveAssistantForSurface, getChannelForWebhook } from '../db/channels-store.js'
import type { AnalyticsLogger } from '@use-brian/core/analytics/logger.js'
import type { MemoryStore } from '@use-brian/core/memory/types.js'
import type { UsageStore } from '@use-brian/agent-runtime/billing/cost-tracker.js'
import type { McpSettingsStore } from '@use-brian/agent-runtime/mcp/types.js'
import type { LLMProvider } from '@use-brian/agent-runtime/providers/types.js'
import type { Tool } from '@use-brian/agent-runtime/tools/types.js'
import type {
  ChannelIntegrationStore,
  ChannelIntegrationConfig,
  MsTeamsCredentials,
} from '../db/channel-integrations.js'
import type { ConnectorStore } from '../db/connector-store.js'
import { processChannelMessage } from './channel-pipeline.js'
import { channelConfirmations, confirmationMessage, roomInteractionScope, type ChannelInteractionScope } from './channel-interactions.js'
import { isWorkspaceAdmin, postPassiveChannelMessage, resolveRoomBinding } from '../channel-room/room.js'
import { channelUserErrorText } from './_channel-error-text.js'
import { buildDownloadedChannelContent } from './channel-file-cache.js'
import { createEditableChannelStatus } from './channel-editable-status.js'
import { billingPartyForAssistant } from '../billing-party.js'

/**
 * One inbound Teams message normalized for the passive-ingest pipeline. The
 * closed Pipeline-C rules engine (`api-platform`) implements `MsTeamsWebhookIngestor`
 * and is injected via the `buildChannelHosts` port — mirrors `SlackWebhookIngestor`.
 * Ingest runs on EVERY message (not just @mentions), so it reads the raw Activity
 * rather than the mention-gated `IncomingMessage`. See
 * docs/architecture/channels/msteams.md → "Passive ingest".
 */
export type MsTeamsWebhookIngestInput = {
  workspaceId: string
  userId: string
  assistantId: string | null
  /** Paired `connector_instance.id` keying the rule + batch lookup. */
  connectorInstanceId: string
  /** Azure tenant id (from the Activity conversation / channelData). */
  tenantId: string | null
  /** Teams conversation id (the synthetic thread root). */
  conversationId: string
  /** Bot Framework activity id. */
  activityId: string | null
  /** Author Teams id (`29:…`). */
  senderId: string | null
  senderName: string | null
  text: string
  /** True when the author is the bot itself — skipped. */
  isBot: boolean
}

export type MsTeamsWebhookIngestor = {
  ingest: (input: MsTeamsWebhookIngestInput) => Promise<{ episodeId: string } | null>
}

export type MsTeamsRouteOptions = {
  questionStore?: ChannelQuestionStore
  /** Servable background-lane model, resolved at boot; forwarded to the
   * channel pipeline so its background calls work without a Google key. */
  backgroundModel?: string
  decisionRuntime?: import('@use-brian/core/decisions/hydra.js').DecisionExecutionPort
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
  channelUserStore?: ChannelUserStore
  workerManager?: import('@use-brian/core/workers/worker.js').WorkerManager
  connectorStore?: ConnectorStore
  mcpSettingsStore?: McpSettingsStore
  assistantConnectorStore?: import('../db/assistant-connector-store.js').AssistantConnectorStore
  connectorGrantStore?: import('../db/connector-grant-store.js').ConnectorGrantStore
  connectorInstanceStore?: import('../db/connector-instance-store.js').ConnectorInstanceStore
  knowledgeStore?: import('@use-brian/core/knowledge/types.js').KnowledgeStoreInterface
  knowledgeCaptureRuleStore?: import('../knowledge/capture-rules.js').KnowledgeCaptureRuleStore
  gdriveFilesStore?: import('@use-brian/core/tools/base/gdrive-files.js').GDriveFilesStore
  workspaceFilesStore?: import('@use-brian/core/workspace-files/types.js').WorkspaceFilesStore
  /** Transient upload cache (`file_cache`). When present, inbound images are
   *  cached so the turn carries a promotable `<attached_file id="…">` tag
   *  (save-on-request — see routes/channel-file-cache.ts). Absent ⇒ images
   *  ride content blocks with no reference, as before. */
  fileStore?: import('@use-brian/core/files/types.js').FileStore
  artifactPromoter?: import('../files/artifact-promote.js').ArtifactPromoter | null
  analytics?: AnalyticsLogger
  skillStore?: import('../db/skill-store.js').SkillStore
  workflowStore?: import('@use-brian/core/workflow/types.js').WorkflowStore
  workspaceSkillStore?: import('../db/skill-store.js').WorkspaceSkillStore
  workspaceSkillEnablementStore?: import('../db/workspace-skill-enablement-store.js').WorkspaceSkillEnablementStore
  workspaceSkillFilesStore?: import('../db/workspace-skill-files-store.js').WorkspaceSkillFilesStore
  episodicStore?: import('@use-brian/core/memory/episodic-types.js').EpisodicStore
  sessionStateStore?: import('@use-brian/core/memory/session-state-types.js').SessionStateStore
  crmEmailDraftStore?: import('@use-brian/core/crm/email-drafts.js').CrmEmailDraftStore
  capabilityStore: import('@use-brian/core/authorization/types.js').CapabilityStore
  /**
   * Passive-ingest port (closed Pipeline-C impl injected via buildChannelHosts).
   * Absent → ingest degrades to a no-op (OSS, or before the closed impl wires).
   */
  msteamsWebhookIngestor?: MsTeamsWebhookIngestor
}

/**
 * Per-integration allow/block gate on the Teams sender id. Pure + exported so
 * it is unit-testable without a full route harness. Mirrors the Slack/Discord
 * `userAccessMode` semantics: unauthorized senders are silently ignored.
 */
export function msteamsUserAllowed(config: ChannelIntegrationConfig, userId: string): boolean {
  const mode = config.userAccessMode ?? 'allow_all'
  if (mode === 'allowlist') {
    const allowed = config.allowedUserIds ?? []
    return allowed.length === 0 || allowed.includes(userId)
  }
  if (mode === 'blocklist') {
    return !(config.blockedUserIds ?? []).includes(userId)
  }
  return true
}

export function msteamsRoutes(options: MsTeamsRouteOptions): Router {
  const router = Router()


  // Verifiers are cached per App id so the JWKS cache survives across requests
  // (a fresh verifier per request would refetch Bot Framework's keys every time).
  const verifiers = new Map<string, MsTeamsVerifier>()
  function verifierFor(appId: string): MsTeamsVerifier {
    let v = verifiers.get(appId)
    if (!v) {
      v = createMsTeamsVerifier({ appId })
      verifiers.set(appId, v)
    }
    return v
  }

  router.post<{ channelId: string }>('/:channelId', async (req, res) => {
    const { channelId } = req.params

    // 1. Integration → credentials (need app_id as the JWT audience + to send).
    const integration = await options.integrationStore.getByChannelForWebhook(channelId, 'msteams')
    if (!integration) {
      res.status(404).end()
      return
    }
    const creds = integration.credentials as MsTeamsCredentials

    // 2. Verify the inbound JWT against Bot Framework's keys, audience = app_id.
    const verdict = await verifierFor(creds.app_id).verifyAuthHeader(req.headers.authorization)
    if (!verdict.valid) {
      res.status(401).end()
      return
    }

    // 3. Ack immediately — the query loop runs far longer than Bot Framework's
    //    endpoint timeout; the reply is sent out-of-band via `serviceUrl`.
    res.status(200).end()

    const activity = req.body as { type?: string; serviceUrl?: string; from?: { name?: string } }
    if (activity?.type !== 'message') return // conversationUpdate / typing / etc.

    const serviceUrl = typeof activity.serviceUrl === 'string' ? activity.serviceUrl : undefined

    // Passive ingest — runs on EVERY message, independent of the chat mention
    // gate, so a non-addressed channel message still distils to the brain.
    // Best-effort producer (fire-and-forget); reads the raw Activity.
    if (options.msteamsWebhookIngestor) {
      dispatchMsTeamsIngest(
        options.msteamsWebhookIngestor, req.body, channelId, integration.id,
        integration.connectorInstanceId ?? null,
      ).catch((err) => console.error('[msteams] ingest dispatch failed:', err))
    }

    try {
      // 4. Require an active channel. Chat capability is gated after workflow dispatch.
      const channel = await getChannelForWebhook(channelId)
      if (!channel || channel.status !== 'active') {
        return
      }

      // 5. Build the adapter bound to THIS conversation's serviceUrl, and parse
      //    the Activity into the normalized IncomingMessage (mention gating +
      //    requireMention live in the adapter).
      const cfg = (integration.config ?? {}) as ChannelIntegrationConfig
      const botId = integration.botUserId ?? `28:${creds.app_id}`
      const adapter = createMsTeamsAdapter({
        appId: creds.app_id,
        appPassword: creds.app_password,
        tenantId: creds.tenant_id,
        serviceUrl,
        botId,
        config: cfg,
      })
      // Normalize independently of mention gating, including attachment-only
      // messages. Keep the conversational adapter and its gates unchanged.
      const eventIncoming = createMsTeamsAdapter({
        appId: creds.app_id, appPassword: creds.app_password,
        tenantId: creds.tenant_id, serviceUrl, botId,
        config: { ...cfg, requireMention: false, preserveMentionOnly: true },
      }).parseIncoming(req.body)
      if (eventIncoming && msteamsUserAllowed(cfg, eventIncoming.userId)) {
        await dispatchIncomingMessageEvent({
          workspaceId: channel.workspaceId, integrationId: integration.id,
          // Adapters use milliseconds; the workflow envelope expects seconds.
          incoming: {
            ...eventIncoming, timestamp: eventIncoming.timestamp / 1000, channelType: 'msteams',
            mentions: [...new Set<string>((req.body.entities ?? [])
              .filter((entity: { type?: string }) => entity.type === 'mention')
              .map((entity: { mentioned?: { id?: string } }) => entity.mentioned?.id)
              .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0))],
          },
        })
      }
      if (!channel.enabledCapabilities.includes('chat')) return
      // The adapter applies the mention gate. An un-mentioned group message
      // can still become a room post when the group is bound (D4).
      const addressed = adapter.parseIncoming(req.body)
      const incoming = addressed ?? (eventIncoming?.isGroupChat && eventIncoming.text.trim() ? eventIncoming : null)
      if (!incoming) return
      const unaddressed = addressed === null

      // Mark the integration reachable on first inbound (Connected in the UI),
      // and remember the serviceUrl for proactive delivery. Best-effort.
      options.integrationStore.touchLastEventAt(integration.id).catch(() => {})
      if (serviceUrl && serviceUrl !== cfg.msteamsServiceUrl) {
        options.integrationStore
          .mergeConfigSystem(integration.id, (c) => ({ ...c, msteamsServiceUrl: serviceUrl }))
          .catch(() => {})
      }

      // 6. Access control — silently ignore unauthorized senders.
      if (!msteamsUserAllowed(cfg, incoming.userId)) return

      // 7. Resolve the answering assistant (per conversation surface, else default).
      const routing = await resolveRoutingForSurface(channelId, incoming.channelId)
      if (!routing) return
      const assistant = await findAssistantById(routing.assistantId)
      if (!assistant) return
      const roomBinding = await resolveRoomBinding({
        assistant, channelType: 'msteams', channelIntegrationId: integration.id, isGroupChat: incoming.isGroupChat,
      })
      if (unaddressed && !roomBinding) return
      const ownerId = await billingPartyForAssistant({
        id: assistant.id,
        ownerUserId: assistant.ownerUserId ?? null,
        workspaceId: assistant.workspaceId ?? null,
      })

      // Resolve before acquiring the conversation lock held by the suspended turn.
      const senderScope: ChannelInteractionScope = {
        channelType: 'msteams', integrationId: channelId,
        conversationId: incoming.channelId, senderId: incoming.userId,
      }
      // A room's turn belongs to the room: any reader stops it, the addresser
      // or an admin answers its confirmations.
      const scope = roomBinding ? roomInteractionScope(senderScope) : senderScope
      if (!unaddressed && channelConfirmations.handleStop(scope, incoming.text)) return

      // 8. Resolve the Teams sender → a platform user (tier 2 shadow: Teams bots
      //    can't read email without Graph consent, so identity stays anonymous).
      let resolvedUserId: string | null = null
      let isIdentified = false
      if (options.channelUserStore && incoming.userId) {
        try {
          const displayName = activity.from?.name ?? null
          const resolved = await resolveChannelUser(
            options.channelUserStore,
            'msteams',
            incoming.userId,
            routing.assistantId,
            async () => ({ providerUserId: incoming.userId, email: null, displayName }),
          )
          resolvedUserId = resolved.user.id
          isIdentified = resolved.isIdentified
        } catch (err) {
          console.error('[msteams] channel user resolution failed:', err)
        }
      }

      if (!resolvedUserId) {
        if (!unaddressed) await adapter.sendMessage(incoming.channelId, { text: 'Your identity could not be verified. Please try again shortly.' }).catch(() => {})
        return
      }

      const channelUserId = resolvedUserId

      if (unaddressed) {
        await postPassiveChannelMessage({
          assistant: { id: assistant.id, name: assistant.name, workspaceId: assistant.workspaceId },
          channelType: 'msteams',
          channelIntegrationId: integration.id,
          isGroupChat: true,
          sessionChannelId: incoming.channelId,
          senderUserId: channelUserId,
          senderName: activity.from?.name ?? null,
          text: incoming.text,
          channelMessageId: incoming.messageId ?? null,
          postNotice: async (text) => { await adapter.sendMessage(incoming.channelId, { text }) },
        })
        return
      }

      if ((roomBinding
        ? await channelConfirmations.handleRoom(scope, { kind: 'text', text: incoming.text }, {
            senderId: incoming.userId,
            isAdmin: () => isWorkspaceAdmin(channelUserId, roomBinding.workspaceId),
          })
        : channelConfirmations.handle(scope, { kind: 'text', text: incoming.text })).handled) return

      // 10. Sequentialize per Teams conversation.
      await withChatLock(`msteams:${incoming.channelId}`, () =>
        processMessage({
          adapter,
          incoming,
          assistant,
          channelUserId,
          ownerId,
          isIdentified,
          routing,
          integrationId: integration.id,
          scope,
          questionIntegrationId: integration.id,
          archiveConnectorInstanceId: integration.connectorInstanceId,
        }),
      )
    } catch (err) {
      console.error(`[msteams] error processing message for channel ${channelId}:`, err)
    }
  })

  async function processMessage(params: {
    adapter: ReturnType<typeof createMsTeamsAdapter>
    incoming: IncomingMessage
    assistant: Awaited<ReturnType<typeof findAssistantById>> & {}
    channelUserId: string
    ownerId: string
    isIdentified: boolean
    routing: { assistantId: string; modelAlias: string }
    integrationId: string
    scope: ChannelInteractionScope
    questionIntegrationId: string
    archiveConnectorInstanceId?: string | null
  }): Promise<void> {
    const { adapter, incoming, assistant, channelUserId, ownerId, isIdentified, routing } = params
    const channelId = incoming.channelId

    // Teams file.download.info provides pre-authorized URLs. Fetch directly without credentials.
    const downloads = await Promise.all((incoming.files ?? []).map(async (file) => {
      try {
        const resp = await fetch(file.url)
        if (!resp.ok) {
          console.error(`[msteams] file download failed (${resp.status}): ${file.name}`)
          return null
        }
        return { ...file, buffer: Buffer.from(await resp.arrayBuffer()) }
      } catch (err) {
        console.error(`[msteams] failed to download file: ${file.name}`, err)
        return null
      }
    }))
    const userContentBlocks = await buildDownloadedChannelContent(incoming.text, downloads, {
      fileStore: options.fileStore, channelType: 'msteams', channelId, userId: channelUserId, assistant,
    })
    if (!userContentBlocks.length) return

    const progress = createEditableChannelStatus(adapter, channelId)
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
      isIdentified,
      channelType: 'msteams',
      channelId,
      channelIntegrationId: params.integrationId,
      channelIntegrationStore: options.integrationStore,
      messageText: incoming.text,
      userContentBlocks,
      rawUserText: incoming.text ?? '',
      isGroupChat: incoming.isGroupChat,
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
        async postNotice(text) {
          await adapter.sendMessage(incoming.channelId, { text })
        },
        ...progress.hooks,
        async onGoalAccepted(message) {
          await adapter.sendMessage(channelId, { text: message })
        },
        async onConfirmationRequired(req) {
          await adapter.sendMessage(channelId, confirmationMessage(req))
        },
        async sendResponse(text, documents, _question, actions) {
          const finalText = text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
          const hasDocuments = !!documents?.length
          const reply = finalText || (hasDocuments ? '' : "I couldn't generate a reply — please rephrase or try again.")
          let channelMessageId: string | undefined
          // Edit-in-place: morph the status message into the response when it
          // fits one Teams activity; otherwise send fresh (chunked).
          // A reply carrying documents always sends fresh — an edit cannot
          // attach uploads, so the edit path would silently drop them.
          if (progress.messageId && !hasDocuments && reply.length <= adapter.maxMessageLength) {
            await adapter.editMessage(channelId, progress.messageId, { text: reply, format: 'markdown', actions })
            channelMessageId = progress.messageId
            progress.clear()
          } else {
            channelMessageId = await adapter.sendMessage(channelId, { text: reply, format: 'markdown', documents, actions })
            if (progress.messageId) {
              await adapter.editMessage(channelId, progress.messageId, { text: '…' }).catch(() => {})
              progress.clear()
            }
          }
          return { channelMessageId }
        },
        async onDowngraded(resetsAt) {
          const resetNote = resetsAt
            ? ` Resets ${new Date(resetsAt).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, weekday: 'short' })}.`
            : ''
          await adapter.sendMessage(channelId, {
            text: `Running on the standard model: usage limit reached.${resetNote} Buy extra usage or upgrade in workspace settings for full speed.`,
          })
          return null
        },
        async sendError(err) {
          progress.clear()
          await adapter.sendMessage(channelId, {
            text: channelUserErrorText(err),
          })
        },
        async onCleanup() {
          progress.clear()
        },
      },
    })
  }

  /**
   * Best-effort passive-ingest producer. Normalizes the raw Activity and hands
   * it to the injected `MsTeamsWebhookIngestor`. Runs for every message
   * (mentioned or not) when the channel has the `ingest` capability and a paired
   * `connector_instance`. Mirrors `dispatchSlackIngest`.
   */
  async function dispatchMsTeamsIngest(
    ingestor: MsTeamsWebhookIngestor,
    body: unknown,
    channelsRowId: string,
    channelIntegrationId: string,
    connectorInstanceId: string | null,
  ): Promise<void> {
    const a = body as {
      id?: string
      text?: string
      from?: { id?: string; name?: string }
      recipient?: { id?: string }
      conversation?: { id?: string; tenantId?: string }
      channelData?: { tenant?: { id?: string } }
    }
    const conversationId = a.conversation?.id
    const senderId = a.from?.id
    const text = (a.text ?? '').replace(/<at>.*?<\/at>/gi, '').replace(/\s{2,}/g, ' ').trim()
    if (!conversationId || !senderId || !text) return
    // Skip the bot's own outbound.
    if (a.recipient?.id && senderId === a.recipient.id) return

    const channel = await getChannelForWebhook(channelsRowId)
    if (!channel || !channel.enabledCapabilities.includes('ingest')) return
    // No paired connector_instance (provisioned at connect) → no rules to route
    // against yet. Skip rather than materialize an unroutable Episode.
    if (!connectorInstanceId) return
    void channelIntegrationId // reserved for lazy CI self-heal (mirrors slack)

    const assistantId = await resolveAssistantForSurface(channelsRowId, conversationId)
    if (!assistantId) return
    const assistant = await findAssistantById(assistantId)
    if (!assistant) return
    const ownerId = await billingPartyForAssistant({
      id: assistant.id,
      ownerUserId: assistant.ownerUserId ?? null,
      workspaceId: assistant.workspaceId ?? null,
    })

    await ingestor.ingest({
      workspaceId: channel.workspaceId,
      userId: ownerId,
      assistantId: assistant.id,
      connectorInstanceId,
      tenantId: a.conversation?.tenantId ?? a.channelData?.tenant?.id ?? null,
      conversationId,
      activityId: a.id ?? null,
      senderId,
      senderName: a.from?.name ?? null,
      text,
      isBot: false,
    })
  }

  return router
}
