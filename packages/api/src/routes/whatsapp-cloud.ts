/** Official Meta WhatsApp Cloud API webhook route. */
import { Router } from 'express'
import type { Request } from 'express'
import {
  createWhatsAppCloudAdapter,
  createWhatsAppCloudApi,
  parseWhatsAppCloudMessages,
  verifyWhatsAppCloudSignature,
  whatsappCloudMediaId,
} from '@use-brian/channels'
import type { IncomingMessage } from '@use-brian/channels'
import { parseFileContent } from '@use-brian/core'
import type {
  AnalyticsLogger,
  ConfirmationDecision,
  ConfirmationResolver,
  ContentBlock,
  LLMProvider,
  McpSettingsStore,
  MemoryStore,
  Tool,
  UsageStore,
  WorkflowEventDispatcher,
} from '@use-brian/core'
import { formatConfirmationInput, getToolDisplayName } from '@use-brian/shared'
import type {
  ChannelIntegrationConfig,
  ChannelIntegrationStore,
  WhatsAppCloudCredentials,
} from '../db/channel-integrations.js'
import { getChannelForWebhook, resolveRoutingForSurface } from '../db/channels-store.js'
import { resolveChannelUser, type ChannelUserStore } from '../db/channel-user-store.js'
import { findAssistantById } from '../db/users.js'
import { withChatLock } from '../db/chat-lock.js'
import { billingPartyForAssistant } from '../billing-party.js'
import { cacheInboundImageTag } from './channel-file-cache.js'
import { processChannelMessage } from './channel-pipeline.js'
import { channelUserErrorText } from './_channel-error-text.js'
import { whatsappCloudUserAllowed } from '../whatsapp/cloud-access.js'
import {
  whatsappCloudManagedGroupStore,
  type WhatsAppCloudManagedGroupStore,
} from '../db/whatsapp-cloud-managed-groups.js'
import {
  createWhatsAppCloudManagedGroupsApi,
  parseWhatsAppCloudManagedGroupLifecycleEvents,
  type WhatsAppCloudGroupLifecycleEvent,
} from '../whatsapp/cloud-managed-groups-client.js'
export { whatsappCloudUserAllowed } from '../whatsapp/cloud-access.js'

const MAX_MEDIA_BYTES = 25 * 1024 * 1024
const DECISIONS: Record<string, ConfirmationDecision> = {
  yes: 'allow', y: 'allow', allow: 'allow', approve: 'allow', ok: 'allow',
  no: 'deny', n: 'deny', deny: 'deny', reject: 'deny',
  always: 'always_allow', never: 'always_deny',
}

export type WhatsAppCloudRouteOptions = {
  backgroundModel?: string
  provider: LLMProvider
  /**
   * Forwarded to the pipeline so `resolveChatModelSelection` can run its
   * serving-model substitution (`ensureServableModel`). Omitting it does not
   * error - the substitution is simply skipped and the turn can select a model
   * this deployment has no credential for. Same silent-degrade shape as a
   * missing `resolveWorkspaceCustomLlm`; graded by `channel-custom-llm-wiring`.
   */
  configuredProviders?: import('@use-brian/shared/model-registry').ProviderAvailability
  resolveWorkspaceCustomLlm?: import('../custom-llm-runtime.js').WorkspaceCustomLlmResolver
  systemPrompt: string
  tools: Map<string, Tool>
  memoryStore: MemoryStore
  usageStore?: UsageStore
  checkCreditBudget?: import('./route-helpers.js').CreditBudgetGate
  integrationStore: ChannelIntegrationStore
  channelUserStore?: ChannelUserStore
  workerManager?: import('@use-brian/core').WorkerManager
  connectorStore?: import('../db/connector-store.js').ConnectorStore
  mcpSettingsStore?: McpSettingsStore
  assistantConnectorStore?: import('../db/assistant-connector-store.js').AssistantConnectorStore
  connectorGrantStore?: import('../db/connector-grant-store.js').ConnectorGrantStore
  connectorInstanceStore?: import('../db/connector-instance-store.js').ConnectorInstanceStore
  workspaceToolPolicyStore?: import('../db/workspace-tool-policy-store.js').WorkspaceToolPolicyStore
  knowledgeStore?: import('@use-brian/core').KnowledgeStoreInterface
  knowledgeCaptureRuleStore?: import('../knowledge/capture-rules.js').KnowledgeCaptureRuleStore
  gdriveFilesStore?: import('@use-brian/core').GDriveFilesStore
  workspaceFilesStore?: import('@use-brian/core').WorkspaceFilesStore
  filesApi?: import('@use-brian/core').FilesApi
  fileStore?: import('@use-brian/core').FileStore
  artifactPromoter?: import('../files/artifact-promote.js').ArtifactPromoter | null
  analytics?: AnalyticsLogger
  skillStore?: import('../db/skill-store.js').SkillStore
  episodicStore?: import('@use-brian/core').EpisodicStore
  sessionStateStore?: import('@use-brian/core').SessionStateStore
  crmEmailDraftStore?: import('@use-brian/core').CrmEmailDraftStore
  capabilityStore: import('@use-brian/core').CapabilityStore
  /** Best-effort producer for workflows triggered by this channel integration. */
  workflowEventDispatcher?: WorkflowEventDispatcher
  /** Injectable seam for managed-group lifecycle persistence. */
  whatsappCloudManagedGroupStore?: WhatsAppCloudManagedGroupStore
}

function isCloudCredentials(credentials: unknown): credentials is WhatsAppCloudCredentials {
  return (credentials as { provider?: string } | null)?.provider === 'cloud_api'
}

function senderName(incoming: IncomingMessage): string | null {
  const raw = incoming.raw as { senderName?: unknown } | null
  return typeof raw?.senderName === 'string' ? raw.senderName : null
}

function xmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function whatsappCloudExternalConnectorToolsAllowed(
  config: ChannelIntegrationConfig,
  isIdentified: boolean,
  userId: string,
): boolean {
  return !isIdentified
    && config.userAccessMode === 'allowlist'
    && (config.allowedUserIds ?? []).includes(userId)
}

export async function dispatchWhatsAppCloudWorkflowEvent(input: {
  dispatcher: WorkflowEventDispatcher
  workspaceId: string
  channelIntegrationId: string
  config: ChannelIntegrationConfig
  providerAccountId: string
  incoming: IncomingMessage
}): Promise<void> {
  const { dispatcher, workspaceId, channelIntegrationId, config, providerAccountId, incoming } = input
  if (!whatsappCloudUserAllowed(config, incoming.userId, incoming.isGroupChat)) return

  const raw = incoming.raw as {
    message?: { type?: unknown }
    phoneNumberId?: unknown
    groupId?: unknown
  } | null
  await dispatcher.dispatch({
    workspaceId,
    source: { type: 'channel', channelIntegrationId, channel: 'whatsapp' },
    text: incoming.text,
    actorId: incoming.userId,
    channelId: incoming.channelId,
    mentions: [],
    isBot: false,
    isGroupChat: incoming.isGroupChat,
    providerAccountId,
    occurredAt: new Date(incoming.timestamp * 1000).toISOString(),
    payload: {
      text: incoming.text,
      message_id: incoming.messageId,
      from: incoming.userId,
      phone_number_id: typeof raw?.phoneNumberId === 'string' ? raw.phoneNumberId : null,
      group_id: typeof raw?.groupId === 'string' ? raw.groupId : null,
      message_type: typeof raw?.message?.type === 'string' ? raw.message.type : null,
      media_type: incoming.mediaType ?? null,
    },
  })
}

export function whatsappCloudRoutes(options: WhatsAppCloudRouteOptions): Router {
  const router = Router()
  const managedGroups = options.whatsappCloudManagedGroupStore ?? whatsappCloudManagedGroupStore
  const pending = new Map<string, { resolver: ConfirmationResolver; toolCallId: string }>()
  const seen = new Map<string, number>()

  // Meta webhook subscription verification.
  router.get<{ channelId: string }>('/:channelId', async (req, res) => {
    let integration
    try {
      integration = await options.integrationStore.getByChannelForWebhook(req.params.channelId, 'whatsapp')
    } catch (err) {
      console.error('[whatsapp-cloud] verification lookup failed:', err)
      res.status(500).end()
      return
    }
    if (!integration || !isCloudCredentials(integration.credentials)) { res.status(404).end(); return }
    if (
      req.query['hub.mode'] !== 'subscribe'
      || req.query['hub.verify_token'] !== integration.credentials.verify_token
      || typeof req.query['hub.challenge'] !== 'string'
    ) {
      res.status(403).end()
      return
    }
    res.type('text/plain').send(req.query['hub.challenge'])
  })

  router.post<{ channelId: string }>('/:channelId', async (req, res) => {
    const { channelId } = req.params
    let integration
    try {
      integration = await options.integrationStore.getByChannelForWebhook(channelId, 'whatsapp')
    } catch (err) {
      console.error('[whatsapp-cloud] integration lookup failed:', err)
      res.status(500).end()
      return
    }
    if (!integration || !isCloudCredentials(integration.credentials)) { res.status(404).end(); return }
    const credentials = integration.credentials
    const rawBody = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body)
    if (!verifyWhatsAppCloudSignature({
      appSecret: credentials.app_secret,
      signature: req.header('x-hub-signature-256') ?? undefined,
      body: rawBody,
    })) {
      res.status(401).end()
      return
    }

    const messages = parseWhatsAppCloudMessages(req.body).filter((incoming) => {
      const raw = incoming.raw as { phoneNumberId?: unknown }
      return raw.phoneNumberId === credentials.phone_number_id
    })
    const lifecycleEvents = parseWhatsAppCloudManagedGroupLifecycleEvents(req.body)
      .filter((event) => event.phoneNumberId === credentials.phone_number_id)
    res.status(200).end()
    if (messages.length === 0 && lifecycleEvents.length === 0) return
    options.integrationStore.touchLastEventAt(integration.id).catch(() => {})

    for (const event of lifecycleEvents) {
      void handleGroupLifecycle(credentials, event).catch((err) => {
        console.error(`[whatsapp-cloud] failed to process group lifecycle ${event.requestId}:`, err)
      })
    }

    for (const incoming of messages) {
      if (!incoming.messageId) continue
      const dedupKey = `${channelId}:${incoming.messageId}`
      if (seen.has(dedupKey)) continue
      seen.set(dedupKey, Date.now())
      if (seen.size > 2_000) {
        const cutoff = Date.now() - 10 * 60_000
        for (const [key, at] of seen) if (at < cutoff) seen.delete(key)
      }
      void handleMessage(channelId, integration.id, integration.config ?? {}, credentials, incoming).catch((err) => {
        console.error(`[whatsapp-cloud] failed to process ${incoming.messageId}:`, err)
      })
    }
  })

  async function handleGroupLifecycle(
    credentials: WhatsAppCloudCredentials,
    event: WhatsAppCloudGroupLifecycleEvent,
  ): Promise<void> {
    if (event.event !== 'group_create') return
    if (event.error) {
      await persistGroupLifecycle(() => managedGroups.failFromLifecycle(event.requestId, event.error!))
      return
    }
    if (!event.groupId) return
    const inviteLink = event.inviteLink ?? await createWhatsAppCloudManagedGroupsApi({
      accessToken: credentials.access_token,
      phoneNumberId: credentials.phone_number_id,
      graphApiVersion: credentials.graph_api_version,
    }).getGroupInviteLink(event.groupId)
    await persistGroupLifecycle(() => managedGroups.completeFromLifecycle(event.requestId, event.groupId!, inviteLink))
  }

  async function persistGroupLifecycle(update: () => Promise<boolean>): Promise<void> {
    // Meta can deliver the lifecycle webhook immediately after accepting the
    // create call, before the request ID update commits. Brief retries close
    // that race; duplicate webhook deliveries are idempotent in the store.
    for (let attempt = 0; attempt < 5; attempt++) {
      if (await update()) return
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)))
    }
  }

  async function handleMessage(
    channelId: string,
    channelIntegrationId: string,
    config: ChannelIntegrationConfig,
    credentials: WhatsAppCloudCredentials,
    incoming: IncomingMessage,
  ): Promise<void> {
    const channel = await getChannelForWebhook(channelId)
    if (!channel || channel.status !== 'active') return
    if (!whatsappCloudUserAllowed(config, incoming.userId, incoming.isGroupChat)) return
    try {
      if (!channel.enabledCapabilities.includes('chat')) return
      const routing = await resolveRoutingForSurface(channelId, incoming.channelId)
      if (!routing) return
      const assistant = await findAssistantById(routing.assistantId)
      if (!assistant) return
      const ownerId = await billingPartyForAssistant({
        id: assistant.id,
        ownerUserId: assistant.ownerUserId ?? null,
        workspaceId: assistant.workspaceId ?? null,
      })

      let channelUserId = ownerId
      let isIdentified = false
      if (options.channelUserStore) {
        const resolved = await resolveChannelUser(
          options.channelUserStore,
          'whatsapp',
          incoming.userId,
          routing.assistantId,
          async () => ({ providerUserId: incoming.userId, email: null, displayName: senderName(incoming) }),
        )
        channelUserId = resolved.user.id
        isIdentified = resolved.isIdentified
      }

      const conversationKey = `${channelId}:${incoming.channelId}`
      const confirmKey = `${conversationKey}:${incoming.userId}`
      const parked = pending.get(confirmKey)
      if (parked) {
        const decision = DECISIONS[incoming.text.trim().toLowerCase()]
        pending.delete(confirmKey)
        parked.resolver.resolve(parked.toolCallId, decision ?? 'deny')
        if (decision) return
      }

      await withChatLock(`whatsapp-cloud:${conversationKey}`, () => processMessage({
        credentials, incoming, assistant, ownerId, channelUserId, isIdentified,
        externalConnectorToolsAllowed: whatsappCloudExternalConnectorToolsAllowed(config, isIdentified, incoming.userId),
        routing, confirmKey,
      }))
    } finally {
      if (options.workflowEventDispatcher) {
        await dispatchWhatsAppCloudWorkflowEvent({
          dispatcher: options.workflowEventDispatcher,
          workspaceId: channel.workspaceId,
          channelIntegrationId,
          config,
          providerAccountId: credentials.phone_number_id,
          incoming,
        }).catch((err) => console.error('[whatsapp-cloud] workflow event dispatch failed:', err))
      }
    }
  }

  async function processMessage(params: {
    credentials: WhatsAppCloudCredentials
    incoming: IncomingMessage
    assistant: Awaited<ReturnType<typeof findAssistantById>> & {}
    ownerId: string
    channelUserId: string
    isIdentified: boolean
    externalConnectorToolsAllowed: boolean
    routing: { modelAlias: string }
    confirmKey: string
  }): Promise<void> {
    const {
      credentials, incoming, assistant, ownerId, channelUserId, isIdentified,
      externalConnectorToolsAllowed, routing, confirmKey,
    } = params
    const apiOptions = {
      accessToken: credentials.access_token,
      phoneNumberId: credentials.phone_number_id,
      graphApiVersion: credentials.graph_api_version,
      recipientType: incoming.isGroupChat ? 'group' as const : 'individual' as const,
    }
    const adapter = createWhatsAppCloudAdapter(apiOptions)
    const userContentBlocks: ContentBlock[] = []
    const mediaId = whatsappCloudMediaId(incoming)
    if (mediaId) {
      try {
        const media = await createWhatsAppCloudApi(apiOptions).downloadMedia(mediaId, MAX_MEDIA_BYTES)
        incoming.mediaMime = media.mimeType
        incoming.mediaSizeBytes = media.data.byteLength
        if (media.mimeType.startsWith('image/') || media.mimeType === 'application/pdf') {
          userContentBlocks.push({ type: 'image', mimeType: media.mimeType, data: Buffer.from(media.data).toString('base64') })
          if (media.mimeType.startsWith('image/') && options.fileStore) {
            const tag = await cacheInboundImageTag({
              fileStore: options.fileStore,
              channelType: 'whatsapp',
              channelId: incoming.channelId,
              userId: channelUserId,
              assistant,
              file: { buffer: Buffer.from(media.data), mime: media.mimeType, fileName: incoming.mediaName ?? 'image' },
            })
            if (tag) userContentBlocks.push({ type: 'text', text: tag })
          }
        } else if (incoming.mediaType === 'document') {
          const parsed = await parseFileContent(Buffer.from(media.data), media.mimeType, incoming.mediaName ?? 'document')
          userContentBlocks.push({
            type: 'text',
            text: `<attached_file name="${xmlAttribute(incoming.mediaName ?? 'document')}" type="${xmlAttribute(media.mimeType)}">\n${parsed.text}\n</attached_file>`,
          })
        } else {
          userContentBlocks.push({ type: 'text', text: `[The user sent a ${incoming.mediaType ?? 'media'} attachment.]` })
        }
      } catch (err) {
        console.error('[whatsapp-cloud] media download failed:', err)
        userContentBlocks.push({ type: 'text', text: '[The user sent an attachment that could not be downloaded. Ask them to resend it.]' })
      }
    }
    if (incoming.text.trim()) userContentBlocks.unshift({ type: 'text', text: incoming.text })
    if (userContentBlocks.length === 0) return

    const abortController = new AbortController()
    await processChannelMessage({
      backgroundModel: options.backgroundModel,
      userId: channelUserId,
      ownerId,
      assistant: { ...assistant, ownerUserId: ownerId },
      isIdentified,
      externalGuest: !isIdentified,
      externalGuestConnectorTools: externalConnectorToolsAllowed,
      channelType: 'whatsapp',
      channelId: incoming.channelId,
      actorChannelId: incoming.userId,
      messageText: incoming.text,
      rawUserText: incoming.text,
      userContentBlocks,
      isGroupChat: incoming.isGroupChat,
      replyToMessageId: incoming.replyToMessageId ?? null,
      incomingChannelMessageId: incoming.messageId ?? null,
      archiveIncoming: incoming,
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
      workspaceToolPolicyStore: options.workspaceToolPolicyStore,
      knowledgeStore: options.knowledgeStore,
      knowledgeCaptureRuleStore: options.knowledgeCaptureRuleStore,
      gdriveFilesStore: options.gdriveFilesStore,
      workspaceFilesStore: options.workspaceFilesStore,
      filesApi: options.filesApi,
      artifactPromoter: options.artifactPromoter ?? null,
      skillStore: options.skillStore,
      workerManager: options.workerManager,
      episodicStore: options.episodicStore,
      sessionStateStore: options.sessionStateStore,
      crmEmailDraftStore: options.crmEmailDraftStore,
      capabilityStore: options.capabilityStore,
      hooks: {
        async onGoalAccepted(message) {
          await adapter.sendMessage(incoming.channelId, { text: message })
        },
        async onConfirmationRequired(request, resolver) {
          pending.set(confirmKey, { resolver, toolCallId: request.toolCallId })
          const lines = request.displayLines?.length ? request.displayLines : formatConfirmationInput(request.input)
          const summary = lines.length ? `\n${lines.join('\n')}` : ''
          const choices = request.allowPersistentApproval ? 'allow / deny / always / never' : 'allow / deny'
          await adapter.sendMessage(incoming.channelId, {
            text: `*${getToolDisplayName(request.toolName)}*${summary}\n\nAllow this action?\nReply: *${choices}*`,
          })
        },
        async sendResponse(text) {
          const messageId = await adapter.sendMessage(incoming.channelId, {
            text: text.trim() || 'Please try again.',
            format: 'markdown',
          })
          return messageId ? { channelMessageId: messageId } : undefined
        },
        async sendError(err) {
          await adapter.sendMessage(incoming.channelId, {
            text: channelUserErrorText(err),
          })
        },
      },
    })
  }

  return router
}
