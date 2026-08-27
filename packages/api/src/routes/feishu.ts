/**
 * Feishu/Lark internal route: authenticated long-connection bridge input,
 * workspace routing, durable dedup, channel identity, and shared query loop.
 *
 * Mounted at `/internal/feishu`. The bridge owns inbound WebSockets only;
 * outbound sends use the encrypted app credentials through direct REST.
 *
 * [COMP:api/feishu-route]
 */

import { timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { z } from 'zod'
import {
  createFeishuAdapter,
  parseFeishuResourceRef,
  type FeishuCardAction,
  type FeishuNormalizedMessage,
  type IncomingMessage,
  type OutgoingAction,
} from '@use-brian/channels'
import {
  buildTool,
  composeVoiceTurnText,
  describeTranscriptionFailure,
  parseFileContent,
  transcribeFirstAudio,
  TRANSCRIPTION_DISABLED_REASON,
  type ConfirmationDecision,
  type ConfirmationResolver,
  type ContentBlock,
  type MediaBackend,
  type TokenUsage,
  type Tool,
  type WorkflowEventDispatcher,
} from '@use-brian/core'
import {
  describeToolInput,
  formatConfirmationInput,
  getToolDisplayName,
  humanizeToolName,
} from '@use-brian/shared'
import type { DiscordRouteOptions } from './discord.js'
import { createFeishuApi } from '../feishu/client.js'
import { claimChannelEvent } from '../db/channel-event-dedup.js'
import {
  type ChannelIntegrationConfig,
  type ChannelIntegrationWithCredentials,
  type FeishuCredentials,
} from '../db/channel-integrations.js'
import { getChannelForWebhook, resolveRoutingForSurface } from '../db/channels-store.js'
import {
  channelLinkBindsHere,
  ensureAssistantMember,
  resolveChannelUser,
} from '../db/channel-user-store.js'
import type { LinkedAccountStore } from '../db/linked-accounts.js'
import { mergeShadowUser } from '../db/linked-accounts.js'
import type { LinkCodeStore } from '../db/link-codes.js'
import { findAssistantById, findUserById } from '../db/users.js'
import { withChatLock } from '../db/chat-lock.js'
import { billingPartyForAssistant } from '../billing-party.js'
import { processChannelMessage } from './channel-pipeline.js'
import { channelUserErrorText } from './_channel-error-text.js'
import { cacheInboundImageTag } from './channel-file-cache.js'
import { archiveMediaRef, type ChatArchiveLiveMedia, type ChatArchiveMediaKind } from '../chat-archive/live-media.js'
import { resolveChatArchiveInstanceId } from '../chat-archive/live-writer.js'
import type { DeferredConfirmationStore } from '../db/deferred-confirmation-store.js'
import { tryResolveSchedulerConfirmation } from '../scheduling/confirmation-registry.js'
import { dispatchReactionFeedback } from '../feedback/reaction-dispatch.js'
import { ensureFeishuConnectorInstance } from '../ingest/feishu-connector-instance.js'

export type FeishuWebhookIngestInput = {
  workspaceId: string
  userId: string
  assistantId: string | null
  connectorInstanceId: string
  appId: string
  chatId: string
  messageId: string
  threadId: string | null
  senderId: string
  senderName: string | null
  text: string
  mentionIds: string[]
  createTime: number
  isBot: boolean
}

export type FeishuWebhookIngestor = {
  ingest(input: FeishuWebhookIngestInput): Promise<{ episodeId: string } | null>
}

export type FeishuRouteOptions = Omit<DiscordRouteOptions, 'ingestChannelMediaRef'> & {
  filesApi?: import('@use-brian/core').FilesApi
  readCachedFile?: (
    id: string,
    ctx: import('@use-brian/core').AccessContext,
  ) => Promise<import('@use-brian/core').CachedFile | null>
  workspaceToolPolicyStore?: import('../db/workspace-tool-policy-store.js').WorkspaceToolPolicyStore
  linkedAccountStore?: LinkedAccountStore
  linkCodeStore?: LinkCodeStore
  deferredConfirmationStore?: DeferredConfirmationStore
  workflowEventDispatcher?: WorkflowEventDispatcher
  /** Hosted Pipeline-C implementation; absent in OSS leaves chat unaffected. */
  feishuWebhookIngestor?: FeishuWebhookIngestor
  archiveMedia?: ChatArchiveLiveMedia
  voiceTranscription?: {
    enabled: boolean
    apiKey: string
    backend?: MediaBackend
    model?: string
  }
}

const DECISION_MAP: Record<string, ConfirmationDecision> = {
  yes: 'allow', y: 'allow', allow: 'allow', approve: 'allow', ok: 'allow',
  no: 'deny', n: 'deny', deny: 'deny', reject: 'deny',
  always: 'always_allow', 'always allow': 'always_allow',
  never: 'always_deny', 'always deny': 'always_deny',
}

const DECISION_LABEL: Record<ConfirmationDecision, string> = {
  allow: 'Allowed',
  deny: 'Denied',
  always_allow: 'Always allowed',
  always_deny: 'Always denied',
}

const STATUS_THROTTLE_MS = 1200
const SEEN_CHAT_STALE_MS = 60 * 60 * 1000

const inboundSchema = z.object({
  channelId: z.string().uuid(),
  message: z.unknown(),
})

const interactionSchema = z.object({
  channelId: z.string().uuid(),
  interaction: z.unknown(),
})

const reactionSchema = z.object({
  channelId: z.string().uuid(),
  reaction: z.object({
    messageId: z.string().min(1),
    operator: z.object({
      openId: z.string().min(1),
      userId: z.string().min(1).optional(),
    }),
    emojiType: z.string().min(1).max(64),
    action: z.enum(['added', 'removed']),
    actionTime: z.number().optional(),
  }),
})

export function feishuConnectorSecretMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || expected.length === 0) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function feishuUserAllowed(config: ChannelIntegrationConfig, userId: string): boolean {
  const mode = config.userAccessMode ?? 'allow_all'
  if (mode === 'allowlist') {
    const allowed = config.allowedUserIds ?? []
    return allowed.length === 0 || allowed.includes(userId)
  }
  if (mode === 'blocklist') return !(config.blockedUserIds ?? []).includes(userId)
  return true
}

function credentialsForApi(credentials: FeishuCredentials) {
  return {
    appId: credentials.app_id,
    appSecret: credentials.app_secret,
    brand: credentials.brand,
  }
}

function actionData(action: FeishuCardAction): string | null {
  if (typeof action.action.value === 'string') return action.action.value
  if (action.action.value && typeof action.action.value === 'object') {
    const data = (action.action.value as { data?: unknown }).data
    return typeof data === 'string' ? data : null
  }
  return null
}

function mimeFallback(type: string): string {
  if (type === 'image') return 'image/jpeg'
  if (type === 'sticker') return 'image/png'
  if (type === 'audio') return 'audio/mpeg'
  if (type === 'video') return 'video/mp4'
  return 'application/octet-stream'
}

function archiveKindForMime(mime: string): ChatArchiveMediaKind {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'voice'
  if (mime.startsWith('video/')) return 'video'
  return 'file'
}

function workflowEventMessage(value: unknown): FeishuNormalizedMessage | null {
  if (!value || typeof value !== 'object') return null
  const message = value as Partial<FeishuNormalizedMessage>
  if (
    typeof message.messageId !== 'string'
    || !message.messageId
    || typeof message.chatId !== 'string'
    || (message.chatType !== 'p2p' && message.chatType !== 'group')
    || typeof message.senderId !== 'string'
    || typeof message.content !== 'string'
    || !Array.isArray(message.resources)
    || !Array.isArray(message.mentions)
  ) return null
  return message as FeishuNormalizedMessage
}

/**
 * Feed one non-addressed, explicitly enabled Feishu group message into the
 * shared Slack/Feishu Pipeline-C ingestor. Provider admission stays here; the
 * injected implementation owns no Feishu policy and cannot bypass the admin
 * allowlist.
 */
async function dispatchFeishuIngest(params: {
  options: FeishuRouteOptions
  channel: NonNullable<Awaited<ReturnType<typeof getChannelForWebhook>>>
  integration: ChannelIntegrationWithCredentials
  eventMessage: FeishuNormalizedMessage
}): Promise<void> {
  const { options, channel, integration, eventMessage } = params
  const ingestor = options.feishuWebhookIngestor
  if (!ingestor || eventMessage.chatType !== 'group') return
  const isBot = eventMessage.senderIsBot === true || eventMessage.senderType === 'bot'
  if (isBot || !eventMessage.content.trim()) return
  if (!channel.enabledCapabilities.includes('ingest')) return

  const config = (integration.config ?? {}) as ChannelIntegrationConfig
  // A message that starts a live turn already reaches memory through Pipeline
  // A. Passive ingest covers only the exchange between addressed turns.
  const interactiveEnabled = channel.enabledCapabilities.includes('chat')
  const addressed = interactiveEnabled
    && (!(config.requireMention ?? true) || eventMessage.mentionedBot)

  // Resolve/provision before the allowlist check so a pre-feature Feishu
  // integration acquires its default-off connector instance on the next group
  // event and can appear in Studio. Provisioning alone never admits content.
  const routing = await resolveRoutingForSurface(channel.id, eventMessage.chatId)
  if (!routing) return
  const assistant = await findAssistantById(routing.assistantId)
  if (!assistant) return
  const ownerId = await billingPartyForAssistant({
    id: assistant.id,
    ownerUserId: assistant.ownerUserId ?? null,
    workspaceId: assistant.workspaceId ?? null,
  })

  let connectorInstanceId = integration.connectorInstanceId
  if (!connectorInstanceId) {
    connectorInstanceId = await ensureFeishuConnectorInstance({
      channelIntegrationId: integration.id,
      actingUserId: ownerId,
    })
  }
  if (addressed || !(config.ambientIngestChatIds ?? []).includes(eventMessage.chatId)) return

  const credentials = integration.credentials as FeishuCredentials
  const mentionIds = eventMessage.mentions
    .map((mention) => mention.openId ?? mention.userId ?? mention.key)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)

  await ingestor.ingest({
    workspaceId: channel.workspaceId,
    userId: ownerId,
    assistantId: assistant.id,
    connectorInstanceId,
    appId: credentials.app_id,
    chatId: eventMessage.chatId,
    messageId: eventMessage.messageId,
    threadId: eventMessage.threadId ?? eventMessage.rootId ?? null,
    senderId: eventMessage.senderId,
    senderName: eventMessage.senderName ?? null,
    text: eventMessage.content,
    mentionIds,
    createTime: eventMessage.createTime,
    isBot,
  })
}

async function persistFeishuSeenChat(
  store: FeishuRouteOptions['integrationStore'],
  integrationId: string,
  chatId: string,
  chatType: 'p2p' | 'group',
): Promise<void> {
  await store.mergeConfigSystem(integrationId, (current) => {
    const seen = current.seenChats ?? []
    const existing = seen.find((chat) => chat.chatId === chatId)
    const now = new Date().toISOString()
    if (!existing) {
      return {
        ...current,
        seenChats: [
          ...seen,
          {
            chatId,
            chatTitle: null,
            chatType,
            isForum: false,
            topics: [],
            lastSeenAt: now,
          },
        ],
      }
    }
    if (
      existing.chatType === chatType
      && Date.now() - Date.parse(existing.lastSeenAt) <= SEEN_CHAT_STALE_MS
    ) {
      return current
    }
    return {
      ...current,
      seenChats: seen.map((chat) =>
        chat.chatId === chatId ? { ...chat, chatType, lastSeenAt: now } : chat,
      ),
    }
  })
}

/** Channel-native reaction tool with failure copy that cannot claim success. */
export function createFeishuReactToMessageTool(args: {
  adapter: ReturnType<typeof createFeishuAdapter>
  channelId: string
  messageId?: string
}): Tool {
  return buildTool({
    name: 'reactToMessage',
    description: 'React to the user\'s Feishu or Lark message with one emoji.',
    inputSchema: z.object({ emoji: z.string().min(1).max(32) }),
    isConcurrencySafe: true,
    isReadOnly: false,
    async execute(input) {
      if (!args.messageId || !args.adapter.reactToMessage) {
        return {
          data: 'No reaction was added because this turn has no reactable Feishu message.',
          isError: true,
        }
      }
      try {
        await args.adapter.reactToMessage(args.channelId, args.messageId, input.emoji)
        return { data: `Reacted with ${input.emoji}` }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        return {
          data: `The reaction was not added to Feishu message ${args.messageId}. ${detail} Do not tell the user it succeeded.`,
          isError: true,
        }
      }
    },
  })
}

export function feishuRoutes(options: FeishuRouteOptions): Router {
  const router = Router()
  const pendingConfirmations = new Map<
    string,
    { resolver: ConfirmationResolver; toolCallId: string }
  >()

  router.use((req, res, next) => {
    if (!feishuConnectorSecretMatches(req.headers['x-connector-secret'], options.connectorSecret)) {
      res.status(401).json({ error: 'Invalid or missing X-Connector-Secret' })
      return
    }
    next()
  })

  router.get('/channels', async (_req, res) => {
    try {
      const rows = await options.integrationStore.listActiveWithCredentialsSystem('feishu')
      res.json(rows.map((row) => {
        const credentials = row.credentials as FeishuCredentials
        return {
          channelId: row.channelId,
          credentials,
        }
      }))
    } catch (error) {
      console.error('[feishu] restore list failed:', error)
      res.status(500).json({ error: 'internal_error' })
    }
  })

  router.post('/inbound', (req, res) => {
    const parsed = inboundSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_payload' })
      return
    }

    // The bridge callback must finish well inside the provider's three-second
    // deadline. Dedup and all model work continue detached after this ACK.
    res.status(202).json({ accepted: true })
    void processInbound(parsed.data.channelId, parsed.data.message).catch((error) => {
      console.error('[feishu] detached inbound failed:', error)
    })
  })

  router.post('/interaction', (req, res) => {
    const parsed = interactionSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_payload' })
      return
    }
    // apps/feishu-connector already returned the provider callback toast. ACK
    // its relay before resolving a parked query loop.
    res.status(202).json({ accepted: true })
    void processInteraction(parsed.data.channelId, parsed.data.interaction).catch((error) => {
      console.error('[feishu] detached interaction failed:', error)
    })
  })

  router.post('/reaction', (req, res) => {
    const parsed = reactionSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_payload' })
      return
    }
    res.status(202).json({ accepted: true })
    void processReaction(parsed.data.channelId, parsed.data.reaction).catch((error) => {
      console.error('[feishu] detached reaction feedback failed:', error)
    })
  })

  async function processReaction(
    channelRowId: string,
    reaction: z.infer<typeof reactionSchema>['reaction'],
  ): Promise<void> {
    if (reaction.action !== 'added' || !options.channelUserStore) return
    const channel = await getChannelForWebhook(channelRowId)
    if (
      !channel
      || channel.status !== 'active'
      || !channel.enabledCapabilities.includes('chat')
    ) return
    const integration = await options.integrationStore.getByChannelForWebhook(
      channelRowId,
      'feishu',
    )
    if (!integration) return
    const api = createFeishuApi(
      credentialsForApi(integration.credentials as FeishuCredentials),
    )
    const chatId = await api.getMessageChatId(reaction.messageId)
    if (!chatId) return
    await options.integrationStore.touchLastEventAt(integration.id).catch(() => {})

    await dispatchReactionFeedback({
      source: 'feishu',
      channelId: chatId,
      channelMessageId: reaction.messageId,
      rawEmoji: reaction.emojiType,
      resolveUserId: async (assistantId) => {
        const assistant = await findAssistantById(assistantId)
        if (!assistant) return null
        const ownerId = await billingPartyForAssistant({
          id: assistant.id,
          ownerUserId: assistant.ownerUserId ?? null,
          workspaceId: assistant.workspaceId ?? null,
        })
        if (options.linkedAccountStore) {
          try {
            const linked = await options.linkedAccountStore.findByProvider(
              'feishu',
              reaction.operator.openId,
            )
            if (
              linked?.userId
              && await channelLinkBindsHere(
                linked,
                assistantId,
                ownerId,
                assistant.workspaceId ?? null,
              )
            ) {
              const user = await findUserById(linked.userId)
              if (user) {
                await ensureAssistantMember(assistantId, user.id)
                return user.id
              }
            }
          } catch (error) {
            console.error('[feishu] reaction linked-identity lookup failed:', error)
          }
        }
        try {
          const resolved = await resolveChannelUser(
            options.channelUserStore!,
            'feishu',
            reaction.operator.openId,
            assistantId,
            async () => ({
              providerUserId: reaction.operator.openId,
              email: null,
              displayName: null,
            }),
          )
          return resolved.user.id
        } catch (error) {
          console.error('[feishu] reaction channel-user resolution failed:', error)
          return null
        }
      },
    })
  }

  async function processInteraction(channelRowId: string, value: unknown): Promise<void> {
    if (!value || typeof value !== 'object') return
    const interaction = value as FeishuCardAction
    if (!interaction.chatId || !interaction.messageId || !interaction.action) return
    const data = actionData(interaction)
    if (!data) return
    const [prefix, toolCallId, rawDecision] = data.split(':')
    if (prefix !== 'mcp_confirm' || !toolCallId || !(rawDecision in DECISION_LABEL)) return
    const decision = rawDecision as ConfirmationDecision
    const pending = pendingConfirmations.get(interaction.chatId)
    let matched = !!pending && pending.toolCallId === toolCallId
    if (matched) {
      pendingConfirmations.delete(interaction.chatId)
      pending?.resolver.resolve(toolCallId, decision)
    } else if (options.deferredConfirmationStore) {
      const deferred = await options.deferredConfirmationStore.findPendingByChannel(
        'feishu',
        interaction.chatId,
      )
      if (
        deferred?.toolCallId === toolCallId
        && tryResolveSchedulerConfirmation(toolCallId, decision, {
          channelType: 'feishu',
          channelId: interaction.chatId,
        })
      ) {
        matched = true
        await options.deferredConfirmationStore.markResolved(toolCallId, decision)
      }
    }

    // Clear the buttons after a press. This is best-effort; the bridge already
    // returned a provider toast, and resolving must not depend on the edit.
    const integration = await options.integrationStore.getByChannelForWebhook(channelRowId, 'feishu')
    if (integration) {
      const api = createFeishuApi(credentialsForApi(integration.credentials as FeishuCredentials))
      await api.updateCard(interaction.messageId, {
        elements: [{ tag: 'markdown', content: matched ? `Tool action: ${DECISION_LABEL[decision]}` : 'Expired or already handled.' }],
      }).catch(() => {})
    }
  }

  async function processInbound(channelRowId: string, value: unknown): Promise<void> {
    const channel = await getChannelForWebhook(channelRowId)
    if (!channel || channel.status !== 'active') return

    const integration = await options.integrationStore.getByChannelForWebhook(channelRowId, 'feishu')
    if (!integration) return
    const eventMessage = workflowEventMessage(value)
    if (!eventMessage) return
    if (!await claimChannelEvent(channelRowId, eventMessage.messageId)) return

    await persistFeishuSeenChat(
      options.integrationStore,
      integration.id,
      eventMessage.chatId,
      eventMessage.chatType,
    ).catch((error) => {
      console.error('[feishu] seen-chat observation failed:', error)
    })

    try {
    if (!channel.enabledCapabilities.includes('chat')) return
    const credentials = integration.credentials as FeishuCredentials
    const api = createFeishuApi(credentialsForApi(credentials))
    const config = (integration.config ?? {}) as ChannelIntegrationConfig
    const adapter = createFeishuAdapter({
      api,
      botOpenId: integration.botUserId ?? undefined,
      config: {
        requireMention: config.requireMention,
        replyInThread: config.replyInThread ?? true,
      },
      deferMentionGate: true,
    })
    const incoming = adapter.parseIncoming(value)
    if (!incoming) return

    if (incoming.isGroupChat && (config.requireMention ?? true) && !incoming.isMentioned) return
    if (!feishuUserAllowed(config, incoming.userId)) return

    if (config.ackReaction && incoming.messageId) {
      adapter.reactToMessage?.(incoming.channelId, incoming.messageId, config.ackReaction)
        .catch(() => {})
    }

    const routing = await resolveRoutingForSurface(channelRowId, incoming.channelId)
    if (!routing) return
    const assistant = await findAssistantById(routing.assistantId)
    if (!assistant) return
    const ownerId = await billingPartyForAssistant({
      id: assistant.id,
      ownerUserId: assistant.ownerUserId ?? null,
      workspaceId: assistant.workspaceId ?? null,
    })

    const pending = pendingConfirmations.get(incoming.channelId)
    if (pending) {
      const decision = DECISION_MAP[incoming.text.trim().toLowerCase()]
      if (decision) {
        pendingConfirmations.delete(incoming.channelId)
        pending.resolver.resolve(pending.toolCallId, decision)
        return
      }
      pending.resolver.resolve(pending.toolCallId, 'deny')
      pendingConfirmations.delete(incoming.channelId)
    } else if (options.deferredConfirmationStore) {
      const decision = DECISION_MAP[incoming.text.trim().toLowerCase()]
      if (decision) {
        const deferred = await options.deferredConfirmationStore.findPendingByChannel(
          'feishu',
          incoming.channelId,
          routing.assistantId,
        )
        if (
          deferred
          && tryResolveSchedulerConfirmation(deferred.toolCallId, decision, {
            channelType: 'feishu',
            channelId: incoming.channelId,
          })
        ) {
          await options.deferredConfirmationStore.markResolved(deferred.toolCallId, decision)
          return
        }
      }
    }

    // Link-code claim. A signed-in user mints this in Settings and sends it
    // through Feishu/Lark. Claim before sender resolution so the next normal
    // turn immediately uses the real account rather than the Tier 2 shadow.
    if (options.linkCodeStore && options.linkedAccountStore && incoming.text) {
      const trimmed = incoming.text.trim().toUpperCase()
      if (/^[A-Z0-9]{6}$/.test(trimmed)) {
        const candidate = await options.linkCodeStore.findValidCode(trimmed)
        if (candidate) {
          try {
            const code = await options.linkCodeStore.claim(trimmed, incoming.userId)
            if (!code) return
            await options.linkedAccountStore.upsert({
              userId: code.userId,
              assistantId: code.assistantId,
              provider: 'feishu',
              providerId: incoming.userId,
              providerMetadata: {
                channelId: incoming.channelId,
                displayName: incoming.senderDisplay ?? null,
                brand: credentials.brand,
              },
            })
            mergeShadowUser(code.userId, incoming.userId, 'feishu', {
              reason: 'link-code',
              evidence: { codeId: code.id, channelId: incoming.channelId },
            }).catch((error) => console.error('[feishu] link-code merge failed:', error))
            const linkedAssistant = await findAssistantById(code.assistantId)
            const assistantName = linkedAssistant?.name ?? 'your assistant'
            await adapter.sendMessage(
              incoming.channelId,
              { text: `Linked to "${assistantName}". Your past Feishu/Lark conversations are now connected to your account.` },
              { threadTs: incoming.replyToMessageId ?? incoming.messageId },
            ).catch((error) => console.error('[feishu] link confirmation send failed:', error))
            return
          } catch (error) {
            console.error('[feishu] link-code claim failed:', error)
            // Fall through so a transient linking failure does not kill chat.
          }
        }
      }
    }

    let channelUserId = ownerId
    let isIdentified = true
    let foundLinked = false
    if (options.linkedAccountStore) {
      try {
        const linked = await options.linkedAccountStore.findByProvider('feishu', incoming.userId)
        if (
          linked?.userId
          && await channelLinkBindsHere(
            linked,
            routing.assistantId,
            ownerId,
            assistant.workspaceId ?? null,
          )
        ) {
          const user = await findUserById(linked.userId)
          if (user) {
            await ensureAssistantMember(routing.assistantId, user.id)
            channelUserId = user.id
            isIdentified = true
            foundLinked = true
          }
        }
      } catch (error) {
        console.error('[feishu] linked-identity lookup failed, falling back to shadow resolution:', error)
      }
    }
    if (!foundLinked && options.channelUserStore) {
      try {
        const resolved = await resolveChannelUser(
          options.channelUserStore,
          'feishu',
          incoming.userId,
          routing.assistantId,
          async () => ({
            providerUserId: incoming.userId,
            email: null,
            displayName: incoming.senderDisplay ?? null,
          }),
        )
        channelUserId = resolved.user.id
        isIdentified = resolved.isIdentified
      } catch (error) {
        console.error('[feishu] channel user resolution failed:', error)
      }
    }

    await options.integrationStore.touchLastEventAt(integration.id).catch(() => {})
    await withChatLock(`feishu:${incoming.channelId}`, () => runTurn({
      adapter,
      api,
      incoming,
      assistant,
      ownerId,
      channelUserId,
      isIdentified,
      routing,
      connectorInstanceId: integration.connectorInstanceId,
    }))
    } finally {
      if (options.workflowEventDispatcher) {
        const mentionIds = eventMessage.mentions
          .map((mention) => mention.openId ?? mention.userId ?? mention.key)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
        await options.workflowEventDispatcher.dispatch({
          workspaceId: channel.workspaceId,
          source: {
            type: 'channel',
            channelIntegrationId: integration.id,
            channel: 'feishu',
          },
          text: eventMessage.content || null,
          actorId: eventMessage.senderId,
          channelId: eventMessage.chatId,
          mentions: mentionIds,
          isBot: eventMessage.senderIsBot === true || eventMessage.senderType === 'bot',
          payload: {
            text: eventMessage.content,
            channel_id: eventMessage.chatId,
            message_id: eventMessage.messageId,
            thread_id: eventMessage.threadId ?? null,
            root_id: eventMessage.rootId ?? null,
            user: eventMessage.senderId,
            is_bot: eventMessage.senderIsBot === true || eventMessage.senderType === 'bot',
          },
        }).catch((error) => {
          console.error('[feishu] workflow event dispatch failed:', error)
        })
      }
      if (options.feishuWebhookIngestor) {
        await dispatchFeishuIngest({
          options,
          channel,
          integration,
          eventMessage,
        }).catch((error) => {
          console.error('[feishu] passive ingest dispatch failed:', error)
        })
      }
    }
  }

  async function runTurn(params: {
    adapter: ReturnType<typeof createFeishuAdapter>
    api: ReturnType<typeof createFeishuApi>
    incoming: IncomingMessage
    assistant: NonNullable<Awaited<ReturnType<typeof findAssistantById>>>
    ownerId: string
    channelUserId: string
    isIdentified: boolean
    routing: { assistantId: string; modelAlias: string }
    connectorInstanceId: string | null
  }): Promise<void> {
    const { adapter, api, incoming, assistant, ownerId, channelUserId, isIdentified, routing, connectorInstanceId } = params
    const userContentBlocks: ContentBlock[] = []
    let voiceTranscriptionUsage:
      | { usage: TokenUsage | null; model: string; audioSeconds?: number }
      | null = null
    let voiceHandled = false

    for (const [fileIndex, file] of (incoming.files ?? []).entries()) {
      const ref = parseFeishuResourceRef(file.url)
      if (!ref) continue
      try {
        const downloaded = await api.downloadResource(
          ref.messageId,
          ref.fileKey,
          ref.type === 'image' || ref.type === 'sticker' ? 'image' : 'file',
        )
        const buffer = Buffer.from(downloaded.data)
        const mime = downloaded.contentType ?? (file.mimeType.includes('*') ? mimeFallback(ref.type) : file.mimeType)
        if (fileIndex === 0) {
          incoming.mediaMime = mime
          incoming.mediaName = file.name
          incoming.mediaSizeBytes = buffer.length
          incoming.archiveMediaAvailability = 'missing'
          if (options.archiveMedia && assistant.workspaceId && incoming.messageId) {
            try {
              const instanceId = connectorInstanceId
                ?? await resolveChatArchiveInstanceId({
                  source: 'feishu',
                  ownerUserId: ownerId,
                  workspaceId: assistant.workspaceId,
                  assistantId: routing.assistantId,
                  assistantName: assistant.name ?? '',
                  conversationId: incoming.channelId,
                })
              if (!instanceId) throw new Error('feishu archive instance could not be resolved')
              const asset = await options.archiveMedia.storeBuffer({
                workspaceId: assistant.workspaceId,
                instanceId,
                ownerUserId: ownerId,
                source: 'feishu',
                providerMessageId: incoming.messageId,
                kind: archiveKindForMime(mime),
                filename: file.name,
                mime,
                bytes: buffer,
              })
              const stored = archiveMediaRef(asset)
              incoming.archiveMediaRef = {
                assetId: stored.asset_id!,
                sha256: stored.sha256!,
                filename: stored.filename,
                mime: stored.mime,
                sizeBytes: stored.size_bytes,
              }
              incoming.archiveMediaAvailability = undefined
            } catch (error) {
              incoming.archiveMediaAvailability = 'failed'
              console.error('[feishu] archive media staging failed:', error)
            }
          }
        }
        if (mime.startsWith('image/') || mime === 'application/pdf') {
          userContentBlocks.push({ type: 'image', mimeType: mime, data: buffer.toString('base64'), name: file.name })
          const tag = options.fileStore
            ? await cacheInboundImageTag({
                fileStore: options.fileStore,
                channelType: 'feishu',
                channelId: incoming.channelId,
                userId: channelUserId,
                assistant,
                file: { buffer, mime, fileName: file.name },
              })
            : ''
          if (tag) userContentBlocks.push({ type: 'text', text: tag })
          continue
        }
        if (mime.startsWith('audio/') && !voiceHandled) {
          voiceHandled = true
          let failure: string | undefined
          let transcript: string | undefined
          const durationSeconds = incoming.mediaDurationSec
          if (durationSeconds != null && durationSeconds > 180) {
            failure = 'the recording is longer than the three-minute inline transcription limit and requires cost confirmation in the web app'
          } else if (!options.voiceTranscription?.enabled) {
            failure = TRANSCRIPTION_DISABLED_REASON
          } else {
            try {
              const result = await transcribeFirstAudio(
                [{
                  buffer,
                  mime,
                  index: 0,
                  ...(durationSeconds !== undefined ? { durationSeconds } : {}),
                }],
                {
                  enabled: true,
                  apiKey: options.voiceTranscription.apiKey,
                  ...(options.voiceTranscription.backend
                    ? { backend: options.voiceTranscription.backend }
                    : {}),
                  model: options.voiceTranscription.model,
                  onFailure: (reason) => { failure = reason },
                },
              )
              if (result) {
                voiceTranscriptionUsage = {
                  usage: result.usage,
                  model: result.model,
                  ...(result.audioSeconds !== undefined ? { audioSeconds: result.audioSeconds } : {}),
                }
              }
              if (result?.text.trim()) transcript = result.text
              else if (result) failure = 'the audio was silent or unintelligible'
            } catch (error) {
              console.error('[feishu] voice transcription failed:', error)
              failure = describeTranscriptionFailure(error)
            }
          }
          incoming.text = composeVoiceTurnText(transcript, failure, incoming.text)
          continue
        }
        if (mime.startsWith('video/') || mime.startsWith('audio/')) {
          userContentBlocks.push({
            type: 'text',
            text: `<attached_file name="${file.name}" type="${mime}">This media was archived, but it is not processed inline in this turn.</attached_file>`,
          })
          continue
        }
        const parsed = await parseFileContent(buffer, mime, file.name)
        userContentBlocks.push({
          type: 'text',
          text: `<attached_file name="${file.name}" type="${mime}">\n${parsed.text}\n</attached_file>`,
        })
      } catch (error) {
        console.error(`[feishu] resource acquisition failed for ${file.name}:`, error)
        userContentBlocks.push({
          type: 'text',
          text: `<attached_file name="${file.name}" type="${file.mimeType}">The Feishu attachment could not be downloaded.</attached_file>`,
        })
      }
    }

    if (incoming.text.trim()) userContentBlocks.unshift({ type: 'text', text: incoming.text })
    if (userContentBlocks.length === 0) return

    const turnTools = new Map(options.tools)
    turnTools.set('reactToMessage', createFeishuReactToMessageTool({
      adapter,
      channelId: incoming.channelId,
      messageId: incoming.messageId,
    }))

    const replyTarget = incoming.replyToMessageId ?? incoming.messageId
    let statusMessageId: string | undefined
    let lastStatusUpdate = 0
    const timeline: Array<{ id: string; name: string; description?: string; done: boolean }> = []

    function statusText(): string {
      const active = timeline.filter((entry) => !entry.done)
      if (active.length > 0) {
        const current = active[active.length - 1]
        return current.description ?? humanizeToolName(current.name)
      }
      if (timeline.length > 0) {
        const last = timeline[timeline.length - 1]
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
          statusMessageId = await adapter.sendStatus(
            incoming.channelId,
            text,
            replyTarget ? { threadTs: replyTarget } : undefined,
          )
        } else {
          await adapter.editMessage(incoming.channelId, statusMessageId, { text })
        }
      } catch {
        // Progress is best-effort; the final send remains authoritative.
      }
    }

    await processChannelMessage({
      backgroundModel: options.backgroundModel,
      userId: channelUserId,
      ownerId,
      assistant: { ...assistant, ownerUserId: ownerId },
      isIdentified,
      channelType: 'feishu',
      channelId: incoming.channelId,
      actorChannelId: incoming.userId,
      messageText: incoming.text || '[Feishu attachment]',
      userContentBlocks,
      rawUserText: incoming.text,
      isGroupChat: incoming.isGroupChat,
      replyToMessageId: incoming.replyToMessageId ?? null,
      incomingChannelMessageId: incoming.messageId ?? null,
      voiceTranscriptionUsage,
      // Provider resource references must not enter the durable archive until
      // they have a staged archive asset. Text still archives normally.
      archiveIncoming: { ...incoming, mediaUrl: undefined, files: undefined, raw: undefined },
      modelAlias: routing.modelAlias,
      adaptiveResearchEnabled: true,
      abortController: new AbortController(),
      provider: options.provider,
      configuredProviders: options.configuredProviders,
      resolveWorkspaceCustomLlm: options.resolveWorkspaceCustomLlm,
      systemPrompt: options.systemPrompt,
      tools: turnTools,
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
      readCachedFile: options.readCachedFile,
      artifactPromoter: options.artifactPromoter ?? null,
      skillStore: options.skillStore,
      workerManager: options.workerManager,
      episodicStore: options.episodicStore,
      sessionStateStore: options.sessionStateStore,
      crmEmailDraftStore: options.crmEmailDraftStore,
      capabilityStore: options.capabilityStore,
      hooks: {
        async onProcessingStart() { await setStatus('Thinking...', true) },
        async onStatus(message) { await setStatus(message, true) },
        async onToolStart(id, name) {
          timeline.push({ id, name, done: false })
          await setStatus(statusText())
        },
        async onToolInput(id, name, input) {
          const description = describeToolInput(name, input)
          const entry = timeline.find((item) => item.id === id)
          if (entry && description) entry.description = description
          await setStatus(statusText())
        },
        async onToolResult(results) {
          for (const block of results) {
            if (block.type !== 'tool_result') continue
            const entry = timeline.find((item) => item.id === block.toolUseId)
            if (entry) entry.done = true
          }
          await setStatus(statusText())
        },
        async onGoalAccepted(message) {
          await adapter.sendMessage(
            incoming.channelId,
            { text: message },
            replyTarget ? { threadTs: replyTarget } : undefined,
          )
        },
        async onConfirmationRequired(request, resolver) {
          pendingConfirmations.set(incoming.channelId, {
            resolver,
            toolCallId: request.toolCallId,
          })
          const lines = request.displayLines?.length
            ? request.displayLines
            : formatConfirmationInput(request.input)
          const actions: OutgoingAction[] = [
            { id: 'allow', label: 'Allow', data: `mcp_confirm:${request.toolCallId}:allow` },
            { id: 'deny', label: 'Deny', data: `mcp_confirm:${request.toolCallId}:deny` },
          ]
          if (request.allowPersistentApproval) {
            actions.push(
              { id: 'always', label: 'Always Allow', data: `mcp_confirm:${request.toolCallId}:always_allow` },
              { id: 'never', label: 'Always Deny', data: `mcp_confirm:${request.toolCallId}:always_deny` },
            )
          }
          await adapter.sendMessage(incoming.channelId, {
            text: `${getToolDisplayName(request.toolName)}${lines.length ? `\n${lines.join('\n')}` : ''}\n\n${request.allowPersistentApproval ? 'Tap a button, or reply: yes / no / always / never' : 'Tap a button, or reply: yes / no'}`,
            actions,
          }, replyTarget ? { threadTs: replyTarget } : undefined)
        },
        async sendResponse(text, documents) {
          const reply = text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
            || (documents?.length ? '' : "I couldn't generate a reply. Please rephrase or try again.")
          let channelMessageId: string | undefined
          if (statusMessageId && !documents?.length && reply.length <= 4000) {
            await adapter.editMessage(incoming.channelId, statusMessageId, { text: reply, format: 'markdown' })
            channelMessageId = statusMessageId
            statusMessageId = undefined
          } else {
            if (statusMessageId) {
              await adapter.clearStatus?.(incoming.channelId, { messageId: statusMessageId }).catch(() => {})
              statusMessageId = undefined
            }
            channelMessageId = await adapter.sendMessage(
              incoming.channelId,
              { text: reply, format: 'markdown', documents },
              replyTarget ? { threadTs: replyTarget } : undefined,
            )
          }
          return { channelMessageId }
        },
        async onDowngraded(resetsAt) {
          const reset = resetsAt ? ` Resets ${new Date(resetsAt).toLocaleString()}.` : ''
          await adapter.sendMessage(incoming.channelId, {
            text: `Running on the standard model: usage limit reached.${reset}`,
          }, replyTarget ? { threadTs: replyTarget } : undefined)
          return null
        },
        async sendError(error) {
          if (statusMessageId) {
            await adapter.clearStatus?.(incoming.channelId, { messageId: statusMessageId }).catch(() => {})
            statusMessageId = undefined
          }
          await adapter.sendMessage(
            incoming.channelId,
            { text: channelUserErrorText(error) },
            replyTarget ? { threadTs: replyTarget } : undefined,
          )
        },
        async onCleanup() {
          if (statusMessageId) {
            await adapter.clearStatus?.(incoming.channelId, { messageId: statusMessageId }).catch(() => {})
            statusMessageId = undefined
          }
        },
      },
    })
  }

  return router
}
