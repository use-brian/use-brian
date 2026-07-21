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
import { parseFileContent } from '@use-brian/core'
import type { ConfirmationDecision, ConfirmationResolver, ContentBlock } from '@use-brian/core'
import type { LLMProvider, Tool, MemoryStore, UsageStore, AnalyticsLogger, McpSettingsStore } from '@use-brian/core'
import type {
  ChannelIntegrationStore,
  ChannelIntegrationConfig,
  MsTeamsCredentials,
} from '../db/channel-integrations.js'
import type { ConnectorStore } from '../db/connector-store.js'
import { getToolDisplayName, humanizeToolName, describeToolInput, formatConfirmationInput } from '@use-brian/shared'
import { processChannelMessage } from './channel-pipeline.js'
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
  provider: LLMProvider
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
  artifactPromoter?: import('@use-brian/api/files/artifact-promote.js').ArtifactPromoter | null
  analytics?: AnalyticsLogger
  skillStore?: import('../db/skill-store.js').SkillStore
  pendingMessageStore?: import('../db/pending-message-store.js').PendingMessageStore
  episodicStore?: import('@use-brian/core').EpisodicStore
  sessionStateStore?: import('@use-brian/core').SessionStateStore
  capabilityStore: import('@use-brian/core').CapabilityStore
  /**
   * Passive-ingest port (closed Pipeline-C impl injected via buildChannelHosts).
   * Absent → ingest degrades to a no-op (OSS, or before the closed impl wires).
   */
  msteamsWebhookIngestor?: MsTeamsWebhookIngestor
}

// Natural-language → decision mapping for Teams text-based confirmation
// (no Adaptive Card buttons yet — that is the P5 parity fast-follow).
const DECISION_MAP: Record<string, ConfirmationDecision> = {
  yes: 'allow', y: 'allow', allow: 'allow', approve: 'allow', ok: 'allow',
  no: 'deny', n: 'deny', deny: 'deny', reject: 'deny',
  always: 'always_allow', 'always allow': 'always_allow',
  never: 'always_deny', 'always deny': 'always_deny',
}

const STATUS_THROTTLE_MS = 1200

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

  // Pending text-based tool confirmations, keyed by Teams conversation id.
  const pendingConfirmations = new Map<string, { resolver: ConfirmationResolver; toolCallId: string }>()

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
      // 4. Channel must be active + chat-enabled.
      const channel = await getChannelForWebhook(channelId)
      if (!channel || channel.status !== 'active' || !channel.enabledCapabilities.includes('chat')) {
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
      const incoming = adapter.parseIncoming(req.body)
      if (!incoming) return

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
      const ownerId = await billingPartyForAssistant({
        id: assistant.id,
        ownerUserId: assistant.ownerUserId ?? null,
        workspaceId: assistant.workspaceId ?? null,
      })

      // 8. Resolve the Teams sender → a platform user (tier 2 shadow: Teams bots
      //    can't read email without Graph consent, so identity stays anonymous).
      let channelUserId = ownerId
      let isIdentified = true
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
          channelUserId = resolved.user.id
          isIdentified = resolved.isIdentified
        } catch (err) {
          console.error('[msteams] channel user resolution failed, falling back to owner:', err)
        }
      }

      // 9. A pending confirmation on this conversation intercepts the next
      //    message as a yes/no/always/never decision (text fallback; Adaptive
      //    Card buttons are P5).
      const pending = pendingConfirmations.get(incoming.channelId)
      if (pending) {
        const decision = DECISION_MAP[incoming.text.trim().toLowerCase()]
        pendingConfirmations.delete(incoming.channelId)
        pending.resolver.resolve(pending.toolCallId, decision ?? 'deny')
        if (decision) return
        // Not a decision keyword: we unblocked the parked turn above; fall
        // through and process this message as a fresh turn.
      }

      // 10. Sequentialize per Teams conversation.
      await withChatLock(`msteams:${incoming.channelId}`, () =>
        processMessage({ adapter, incoming, assistant, channelUserId, ownerId, isIdentified, routing }),
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
  }): Promise<void> {
    const { adapter, incoming, assistant, channelUserId, ownerId, isIdentified, routing } = params
    const channelId = incoming.channelId

    // ── Build content blocks (text + downloaded attachments) ──
    // Teams `file.download.info` attachments carry a pre-authorized downloadUrl,
    // so no auth header is needed (same as Discord's pre-signed CDN URLs).
    const userContentBlocks: ContentBlock[] = []
    if (incoming.files?.length) {
      const downloads = await Promise.all(
        incoming.files.map(async (file) => {
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
        }),
      )
      for (const dl of downloads) {
        if (!dl) continue
        if (dl.mimeType.startsWith('image/') || dl.mimeType === 'application/pdf') {
          userContentBlocks.push({ type: 'image', mimeType: dl.mimeType, data: dl.buffer.toString('base64') })
        } else {
          const parsedFile = await parseFileContent(dl.buffer, dl.mimeType, dl.name)
          userContentBlocks.push({
            type: 'text',
            text: `<attached_file name="${dl.name}" type="${dl.mimeType}">\n${parsedFile.text}\n</attached_file>`,
          })
        }
      }
    }
    if (incoming.text.trim()) {
      userContentBlocks.unshift({ type: 'text', text: incoming.text })
    } else if (userContentBlocks.length === 0) {
      return
    }

    // ── Status: one message, edited in place (Teams has no native indicator) ──
    let statusMessageId: string | undefined
    let lastStatusUpdate = 0
    type ToolEntry = { id: string; name: string; description?: string; done: boolean }
    const toolTimeline: ToolEntry[] = []

    function formatToolStatus(): string {
      const active = toolTimeline.filter((t) => !t.done)
      if (active.length > 0) {
        const current = active[active.length - 1]
        return current.description ?? humanizeToolName(current.name)
      }
      if (toolTimeline.length > 0) {
        const last = toolTimeline[toolTimeline.length - 1]
        return `Done: ${last.description ?? humanizeToolName(last.name)}`
      }
      return 'Thinking...'
    }

    async function setStatus(text: string, force = false): Promise<void> {
      const now = Date.now()
      if (!force && now - lastStatusUpdate < STATUS_THROTTLE_MS) return
      lastStatusUpdate = now
      try {
        if (!statusMessageId) {
          statusMessageId = await adapter.sendStatus(channelId, text)
        } else {
          await adapter.editMessage(channelId, statusMessageId, { text })
        }
      } catch {
        // Non-critical.
      }
    }

    const abortController = new AbortController()

    await processChannelMessage({
      userId: channelUserId,
      ownerId,
      assistant: { ...assistant, ownerUserId: ownerId },
      isIdentified,
      channelType: 'msteams',
      channelId,
      messageText: incoming.text,
      userContentBlocks,
      rawUserText: incoming.text ?? '',
      isGroupChat: incoming.isGroupChat,
      replyToMessageId: incoming.replyToMessageId ?? null,
      incomingChannelMessageId: incoming.messageId ?? null,
      modelAlias: routing.modelAlias,
      adaptiveResearchEnabled: true,
      abortController,
      provider: options.provider,
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
      pendingMessageStore: options.pendingMessageStore,
      workerManager: options.workerManager,
      episodicStore: options.episodicStore,
      sessionStateStore: options.sessionStateStore,
      capabilityStore: options.capabilityStore,
      hooks: {
        async onProcessingStart() {
          await setStatus('Thinking...', true)
        },
        async onStatus(message) {
          await setStatus(message, true)
        },
        async onToolStart(id, name) {
          toolTimeline.push({ id, name, done: false })
          await setStatus(formatToolStatus())
        },
        async onToolInput(id, name, input) {
          const desc = describeToolInput(name, input)
          if (desc) {
            const entry = toolTimeline.find((t) => t.id === id)
            if (entry) entry.description = desc
            await setStatus(formatToolStatus())
          }
        },
        async onToolResult(results) {
          for (const block of results) {
            if (block.type === 'tool_result') {
              const entry = toolTimeline.find(
                (t) => t.id === (block as ContentBlock & { toolUseId?: string }).toolUseId,
              )
              if (entry) entry.done = true
            }
          }
          await setStatus(formatToolStatus())
        },
        async onConfirmationRequired(req, resolver) {
          // Park the resolver so the next message on this conversation answers
          // it (text fallback). Adaptive Card buttons are the P5 fast-follow.
          pendingConfirmations.set(channelId, { resolver, toolCallId: req.toolCallId })
          const lines = req.displayLines && req.displayLines.length > 0
            ? req.displayLines
            : formatConfirmationInput(req.input)
          const inputSummary = lines.length > 0 ? '\n' + lines.join('\n') : ''
          const displayName = getToolDisplayName(req.toolName)
          const replyHint = req.allowPersistentApproval
            ? 'Reply: yes / no / always / never'
            : 'Reply: yes / no'
          await adapter.sendMessage(channelId, {
            text: `${displayName}${inputSummary}\n\n${replyHint}`,
          })
        },
        async sendResponse(text) {
          const finalText = text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
          const reply = finalText || "I couldn't generate a reply — please rephrase or try again."
          let channelMessageId: string | undefined
          // Edit-in-place: morph the status message into the response when it
          // fits one Teams activity; otherwise send fresh (chunked).
          if (statusMessageId && reply.length <= adapter.maxMessageLength) {
            await adapter.editMessage(channelId, statusMessageId, { text: reply, format: 'markdown' })
            channelMessageId = statusMessageId
            statusMessageId = undefined
          } else {
            channelMessageId = await adapter.sendMessage(channelId, { text: reply, format: 'markdown' })
            if (statusMessageId) {
              await adapter.editMessage(channelId, statusMessageId, { text: '…' }).catch(() => {})
              statusMessageId = undefined
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
          statusMessageId = undefined
          await adapter.sendMessage(channelId, {
            text: err.message.includes('usage limit') ? err.message : 'Something went wrong. Please try again.',
          })
        },
        async onCleanup() {
          statusMessageId = undefined
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
