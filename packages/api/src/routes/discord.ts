// REBRAND-CUTOVER: this file contains sidan.ai runtime values that must flip to usebrian.ai when DNS + Vercel domains + OAuth consoles + webhooks are cut over. Grep REBRAND-CUTOVER.
/**
 * Discord internal route — Gateway connector seam.
 *
 * Mounted at `/internal/discord`. Unlike Slack/Telegram (public webhooks),
 * Discord chat arrives over the Gateway WebSocket held by `apps/discord-connector`,
 * which authenticates with `X-Connector-Secret` and POSTs already-normalized
 * messages here. Two endpoints:
 *
 *   POST /internal/discord/inbound   — `{ channelId, message }`: run the turn
 *   GET  /internal/discord/channels  — active discord channels + bot tokens for
 *                                      the connector's restoreAll() on boot
 *
 * `channelId` is the workspace `channels` row id (which bot/integration);
 * `message.channelId` is the Discord channel id to reply into. The answering
 * assistant is resolved via `channel_assistants` (per Discord-channel surface,
 * else the channel default), the Discord sender → a platform user via the
 * channel-user identity path, and the turn runs through the shared
 * `processChannelMessage` pipeline. Outbound replies go API → Discord REST
 * directly (the adapter), not back through the connector.
 *
 * Component tag: [COMP:api/discord-route].
 */

import { timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import { createDiscordAdapter, DiscordApiError, respondToInteraction } from '@use-brian/channels'
import type { IncomingMessage, OutgoingAction } from '@use-brian/channels'
import { findAssistantById } from '../db/users.js'
import { withChatLock } from '../db/chat-lock.js'
import { resolveChannelUser, type ChannelUserStore } from '../db/channel-user-store.js'
import { resolveRoutingForSurface, getChannelForWebhook } from '../db/channels-store.js'
import { parseFileContent, buildTool } from '@use-brian/core'
import { z } from 'zod'
import type { ConfirmationDecision, ConfirmationResolver, ContentBlock } from '@use-brian/core'
import type { LLMProvider, Tool, MemoryStore, UsageStore, AnalyticsLogger, McpSettingsStore } from '@use-brian/core'
import type { ChannelIntegrationStore, ChannelIntegrationConfig, DiscordCredentials } from '../db/channel-integrations.js'
import type { ConnectorStore } from '../db/connector-store.js'
import { getToolDisplayName, humanizeToolName, describeToolInput, formatConfirmationInput } from '@use-brian/shared'
import { processChannelMessage } from './channel-pipeline.js'
import { cacheInboundImageTag } from './channel-file-cache.js'
import { billingPartyForAssistant } from '../billing-party.js'
import { classifyMedia, buildDocumentFiledReply, buildOversizeDocReply } from '../ingest/channel-media-intake.js'

export type DiscordRouteOptions = {
  /** Servable background-lane model, resolved at boot; forwarded to the
   * channel pipeline so its background calls work without a Google key. */
  backgroundModel?: string
  /** Shared secret the connector presents on every call (DISCORD_CONNECTOR_SECRET). */
  connectorSecret: string
  provider: LLMProvider
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
  /** Promotes an over-threshold text paste to a durable artifact
   *  (large-content-artifacts §Phase 3.2). Absent ⇒ pastes pass through. */
  artifactPromoter?: import('@use-brian/api/files/artifact-promote.js').ArtifactPromoter | null
  analytics?: AnalyticsLogger
  skillStore?: import('../db/skill-store.js').SkillStore
  episodicStore?: import('@use-brian/core').EpisodicStore
  sessionStateStore?: import('@use-brian/core').SessionStateStore
  /**
   * Route a pulled Discord attachment (CDN URL) through the channel-media intake
   * (audio/video → recording → brain). Boot wires it over `acquireAndIngest`.
   * See docs/plans/channel-media-ingest.md §Phase 5.
   */
  ingestChannelMediaRef?: (input: {
    source: { url: string; headers?: Record<string, string> }
    mime: string
    fileName: string | null
    sizeBytes: number | null
    sender: { id: string; name: string | null }
    /** Conversation/channel id — correlates the pre-flight-confirm reply turn. */
    conversationId: string
    workspaceId: string
    assistantId: string
    actingUserId: string
  }) => Promise<import('../ingest/channel-media-intake.js').ChannelMediaIntakeResult>
  capabilityStore: import('@use-brian/core').CapabilityStore
}

// Natural-language → decision mapping for Discord text-based confirmation.
const DECISION_MAP: Record<string, ConfirmationDecision> = {
  yes: 'allow', y: 'allow', allow: 'allow', approve: 'allow', ok: 'allow',
  no: 'deny', n: 'deny', deny: 'deny', reject: 'deny',
  always: 'always_allow', 'always allow': 'always_allow',
  never: 'always_deny', 'always deny': 'always_deny',
}

const STATUS_THROTTLE_MS = 1200

// Decision label shown back in the morphed prompt after a button press.
const DECISION_LABEL: Record<ConfirmationDecision, string> = {
  allow: 'Allowed', deny: 'Denied', always_allow: 'Always allowed', always_deny: 'Always denied',
}

const interactionSchema = z.object({
  // Internal `channels` row id (forwarded for symmetry; resolution keys off the
  // Discord channel id below since the pending map is keyed by it).
  channelId: z.string().min(1),
  interaction: z.object({
    id: z.string().min(1),
    token: z.string().min(1),
    channelId: z.string().min(1), // Discord channel id
    messageId: z.string().optional(),
    userId: z.string().optional(),
    customId: z.string().min(1),
  }),
})

const inboundSchema = z.object({
  channelId: z.string().min(1),
  message: z.object({
    userId: z.string().min(1),
    channelId: z.string().min(1),
    messageId: z.string().optional(),
    text: z.string(),
    isGroupChat: z.boolean().optional(),
    isMentioned: z.boolean().optional(),
    replyToMessageId: z.string().optional(),
    timestamp: z.number().optional(),
  }).passthrough(),
})

/**
 * Constant-time shared-secret check. Fails closed: an empty/unset
 * configured secret matches nothing — this router fronts `/channels`,
 * which returns every Discord bot token, so a misconfigured mount must
 * reject rather than wave callers through.
 */
function connectorSecretMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || expected.length === 0) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Translate a Discord REST rejection into the failure copy a tool result owes
 * the model — a plain-language diagnosis plus the retry verdict — the way
 * `describeSlackError` does for Slack. Discord answers with an HTTP status
 * plus its own numeric `code`, and the two that matter most are indistinguishable
 * from each other by status alone (a 404 is "message gone" OR "emoji not a
 * thing"), so the numeric code leads where we have it.
 *
 * Deliberately narrow: this is the reaction path's vocabulary. If another
 * Discord tool needs one, widen it here rather than growing a second copy.
 */
function describeDiscordReactionError(err: unknown): string {
  if (!(err instanceof DiscordApiError)) {
    const message = err instanceof Error ? err.message : String(err)
    return `Discord did not accept the reaction${message ? `: ${message}` : ''}. Fix what that names before retrying; the same call will otherwise fail the same way.`
  }
  switch (err.code) {
    case 10008:
      return 'Discord has no such message (Unknown Message, code 10008) — it was deleted, or the message id does not belong to that channel. Retrying this exact id will keep failing.'
    case 10014:
      return 'Discord does not recognise that emoji (Unknown Emoji, code 10014). Use a single standard unicode emoji; a custom server emoji has to be passed as `name:id`, not as `:name:`. Re-check the emoji before retrying — this one will keep failing.'
    case 50001:
      return "The bot cannot access that channel (Missing Access, code 50001) — it is not in the channel, or the channel is invisible to it. Someone with permission must add the bot to the channel; retrying will not help."
    case 50013:
      return 'The bot lacks the Add Reactions permission in that channel (Missing Permissions, code 50013) — reacting to an older message also needs Read Message History. A server admin must grant those to the bot role; retrying will not help until they do.'
    case 30010:
      return 'That message already carries Discord\'s maximum number of distinct reactions (code 30010), so no further emoji can be added. Retrying will keep failing; react with an emoji already on the message, or reply in text.'
    default:
      break
  }
  if (err.httpStatus === 429) {
    return 'Discord rate-limited the request (HTTP 429). This is transient: wait a moment and retry once. Do not loop.'
  }
  if (err.httpStatus === 403) {
    return 'Discord refused the request as forbidden (HTTP 403) — the bot role is missing Add Reactions (and, for older messages, Read Message History) in that channel. A server admin must grant them; retrying will not help until they do.'
  }
  if (err.httpStatus === 404) {
    return 'Discord found nothing to react to (HTTP 404) — the message was deleted, the channel id is wrong, or the emoji is not one Discord knows. Re-check the message id and the emoji; retrying unchanged will keep failing.'
  }
  if (err.httpStatus >= 500) {
    return `Discord's API failed server-side (HTTP ${err.httpStatus}). Nothing about the request is wrong: retry once after a short wait, and if it persists tell the user Discord is having trouble.`
  }
  return `Discord rejected the request (HTTP ${err.httpStatus}${err.code != null ? `, code ${err.code}` : ''}): ${err.message}. Fix what that names before retrying; the same call will otherwise fail the same way.`
}

/**
 * The Discord-only `reactToMessage` tool, exported as a factory (the
 * `createUpdateViewedSkillTool` pattern in `chat.ts`) so its failure copy is
 * unit-testable without driving a whole inbound turn.
 *
 * Failure-copy contract (docs/architecture/engine/tool-executor.md →
 * "Failure copy"): a reaction that did not land must never read like one that
 * did, so every failure names the message id + channel, says the message is
 * still unreacted, and carries Discord's diagnosis + retry verdict through
 * `describeDiscordReactionError` rather than a bare status.
 */
export function createDiscordReactToMessageTool(args: {
  adapter: { reactToMessage?: (channelId: string, messageId: string, emoji: string) => Promise<void> }
  channelId: string
  messageId?: string
}): Tool {
  const { adapter, channelId, messageId } = args
  return buildTool({
    name: 'reactToMessage',
    description:
      "React to the user's Discord message with a single unicode emoji (e.g. 👍, ❤️, 🔥, 👀). Use for quick acknowledgements when a full text reply isn't needed, or alongside a text response.",
    inputSchema: z.object({
      emoji: z.string().describe('A single unicode emoji, e.g. "👍", "❤️", "🔥", "👀"'),
    }),
    isConcurrencySafe: true,
    isReadOnly: false,
    async execute(input) {
      if (!messageId) {
        return {
          data:
            `No reaction was added: this turn did not arrive with a Discord message id, so there is no message for ${input.emoji} to attach to. ` +
            'Acknowledge in text instead — reactToMessage cannot work on this turn however it is called.',
          isError: true,
        }
      }
      const target = `message ${messageId} in Discord channel ${channelId}`
      if (!adapter.reactToMessage) {
        return {
          data:
            `No reaction was added to ${target}: the Discord adapter serving this workspace exposes no reaction capability, so ${input.emoji} was never sent. ` +
            'Acknowledge in text instead and do not tell the user you reacted. Retrying will fail the same way.',
          isError: true,
        }
      }
      try {
        await adapter.reactToMessage(channelId, messageId, input.emoji)
        return { data: `Reacted with ${input.emoji}` }
      } catch (err) {
        return {
          data:
            `Adding the ${input.emoji} reaction to ${target} failed, so the message is still unreacted. ${describeDiscordReactionError(err)} ` +
            'Do not tell the user you reacted to their message; if the acknowledgement matters, say it in text.',
          isError: true,
        }
      }
    },
  })
}

export function discordRoutes(options: DiscordRouteOptions): Router {
  const router = Router()

  // Pending text-based tool confirmations, keyed by Discord channel id.
  const pendingConfirmations = new Map<string, { resolver: ConfirmationResolver; toolCallId: string }>()

  // ── Connector auth ────────────────────────────────────────────
  router.use((req, res, next) => {
    if (!connectorSecretMatches(req.headers['x-connector-secret'], options.connectorSecret)) {
      res.status(401).json({ error: 'Invalid or missing X-Connector-Secret' })
      return
    }
    next()
  })

  // ── restoreAll source — active discord channels + bot tokens ──
  router.get('/channels', async (_req, res) => {
    try {
      const rows = await options.integrationStore.listActiveWithCredentialsSystem('discord')
      res.json(
        rows.map((r) => ({
          channelId: r.channelId,
          botToken: (r.credentials as DiscordCredentials).bot_token,
          botUserId: r.botUserId ?? undefined,
        })),
      )
    } catch (err) {
      console.error('[discord] /channels failed:', err)
      res.status(500).json({ error: 'internal_error' })
    }
  })

  // ── Inbound message from the Gateway connector ────────────────
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

    try {
      // 1. Channel must be active and chat-enabled.
      const channel = await getChannelForWebhook(channelId)
      if (!channel || channel.status !== 'active' || !channel.enabledCapabilities.includes('chat')) {
        console.warn(`[discord] channel ${channelId} not accepting chat — ignoring inbound`)
        return
      }

      // 2. Integration → bot token (for sending) + bot user id.
      const integration = await options.integrationStore.getByChannelForWebhook(channelId, 'discord')
      if (!integration) {
        console.error(`[discord] no integration for channel ${channelId} — ignoring inbound`)
        return
      }
      const creds = integration.credentials as DiscordCredentials

      // 2b. Access control — silently ignore messages from unauthorized Discord
      //     users (the per-integration allow/block list, same model as Slack /
      //     Telegram). `incoming.userId` is the Discord author id. Done before
      //     routing/assistant resolution so a blocked user costs nothing.
      const cfg = (integration.config ?? {}) as ChannelIntegrationConfig
      const accessMode = cfg.userAccessMode ?? 'allow_all'
      if (accessMode === 'allowlist') {
        const allowed = cfg.allowedUserIds ?? []
        if (allowed.length > 0 && !allowed.includes(incoming.userId)) return
      } else if (accessMode === 'blocklist') {
        const blocked = cfg.blockedUserIds ?? []
        if (blocked.includes(incoming.userId)) return
      }

      // 3. Resolve the answering assistant (per Discord-channel surface, else default).
      const routing = await resolveRoutingForSurface(channelId, incoming.channelId)
      if (!routing) {
        console.error(`[discord] channel ${channelId} has no assistant routing — ignoring inbound`)
        return
      }
      const assistant = await findAssistantById(routing.assistantId)
      if (!assistant) {
        console.error(`[discord] assistant ${routing.assistantId} not found (orphaned integration?)`)
        return
      }
      const ownerId = await billingPartyForAssistant({
        id: assistant.id,
        ownerUserId: assistant.ownerUserId ?? null,
        workspaceId: assistant.workspaceId ?? null,
      })

      // 4. Resolve the Discord sender → a platform user (shadow user, tier 2:
      //    Discord bots can't read user email without OAuth, so identity stays
      //    anonymous — session only, no memory consolidation).
      //    See docs/architecture/channels/channel-user-identity.md.
      let channelUserId = ownerId
      let isIdentified = true
      if (options.channelUserStore && incoming.userId) {
        try {
          const author = (incoming.raw as { author?: { username?: string; global_name?: string | null } })?.author
          const displayName = author?.global_name ?? author?.username ?? null
          const resolved = await resolveChannelUser(
            options.channelUserStore,
            'discord',
            incoming.userId,
            routing.assistantId,
            async () => ({ providerUserId: incoming.userId, email: null, displayName }),
          )
          channelUserId = resolved.user.id
          isIdentified = resolved.isIdentified
        } catch (err) {
          console.error('[discord] channel user resolution failed, falling back to owner:', err)
        }
      }

      // 5. Build the send-side adapter (API → Discord REST).
      const adapter = createDiscordAdapter({
        token: creds.bot_token,
        botUserId: integration.botUserId ?? undefined,
      })

      // 6. A pending confirmation on this channel intercepts the next message
      //    as a yes/no/always/never decision.
      const pending = pendingConfirmations.get(incoming.channelId)
      if (pending) {
        const decision = DECISION_MAP[incoming.text.trim().toLowerCase()]
        if (decision) {
          pendingConfirmations.delete(incoming.channelId)
          pending.resolver.resolve(pending.toolCallId, decision)
          return
        }
        // Not a decision keyword: treat as deny so the in-flight turn (which
        // holds the per-channel chat lock while it waits on this resolver)
        // unblocks immediately instead of stalling until the 300s timeout —
        // then fall through to process this message as a fresh turn. Mirrors
        // slack.ts. Resolving an already-resolved/timed-out call is a no-op.
        pending.resolver.resolve(pending.toolCallId, 'deny')
        pendingConfirmations.delete(incoming.channelId)
      }

      // 7. Sequentialize per Discord channel.
      await withChatLock(`discord:${incoming.channelId}`, () =>
        processMessage({
          adapter,
          incoming,
          assistant,
          channelUserId,
          ownerId,
          isIdentified,
          routing,
          ingestChannelMediaRef: options.ingestChannelMediaRef,
          archiveConnectorInstanceId: integration.connectorInstanceId,
        }),
      )
    } catch (err) {
      console.error(`[discord] error processing message for channel ${incoming.channelId}:`, err)
    }
  })

  // ── Button-press interaction from the Gateway connector ───────
  //
  // A confirmation button press arrives here as an already-flattened
  // INTERACTION_CREATE. The ordering is load-bearing: we ack Discord (type 7
  // UPDATE_MESSAGE — morph the prompt + clear the buttons) BEFORE resolving the
  // parked confirmation. Resolving resumes the query loop (tool execution, usage
  // recording, the next model turn) whose microtasks would otherwise hog the
  // event loop and delay this callback's network send past Discord's 3s deadline
  // — which surfaces as a "This interaction failed" toast even though the late
  // update still lands. Ack first, resume after.
  router.post('/interaction', async (req, res) => {
    const parsed = interactionSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'bad_payload' })
      return
    }
    // Ack the connector immediately; the Discord callback happens below.
    res.status(200).json({ ok: true })

    const { interaction } = parsed.data
    // custom_id = mcp_confirm:<toolCallId>:<decision>
    const parts = interaction.customId.split(':')
    if (parts[0] !== 'mcp_confirm' || parts.length < 3) return
    const toolCallId = parts[1]
    const decision = parts[2] as ConfirmationDecision
    if (!(decision in DECISION_LABEL)) return

    const pending = pendingConfirmations.get(interaction.channelId)
    const matched = !!pending && pending.toolCallId === toolCallId
    if (matched) pendingConfirmations.delete(interaction.channelId)

    // 1. Ack + edit the prompt in place, with nothing else competing for the
    //    event loop. On a stale/expired button we still ack so the user sees a
    //    note rather than Discord's "This interaction failed".
    try {
      await respondToInteraction(interaction.id, interaction.token, {
        type: 7,
        data: {
          content: matched ? `Tool action: ${DECISION_LABEL[decision]}` : 'Expired or already handled.',
          components: [],
          allowed_mentions: { parse: [] },
        },
      })
    } catch (err) {
      console.error('[discord] interaction ack failed:', err)
    }

    // 2. Now resume the parked turn. Resolving an already-resolved/timed-out
    //    call is a no-op (the resolver guards against it), so a button press
    //    racing the text fallback is safe.
    if (matched && pending) pending.resolver.resolve(toolCallId, decision)
  })

  async function processMessage(params: {
    adapter: ReturnType<typeof createDiscordAdapter>
    incoming: IncomingMessage
    assistant: Awaited<ReturnType<typeof findAssistantById>> & {}
    channelUserId: string
    ownerId: string
    isIdentified: boolean
    routing: { assistantId: string; modelAlias: string }
    ingestChannelMediaRef?: DiscordRouteOptions['ingestChannelMediaRef']
    archiveConnectorInstanceId?: string | null
  }): Promise<void> {
    const { adapter, incoming, assistant, channelUserId, ownerId, isIdentified, routing, ingestChannelMediaRef } = params
    const channelId = incoming.channelId

    // Route AUDIO/VIDEO + DOCUMENT attachments to the brain: AV → recording
    // pipeline, documents → durable artifact + file_segments
    // (large-content-artifacts §Phase 3.3). Documents ALSO stay content blocks
    // for this turn; AV stays excluded as before. Fire-and-forget.
    const isAv = (m: string) => m.startsWith('audio/') || m.startsWith('video/')
    const brainMediaFiles =
      ingestChannelMediaRef && assistant.workspaceId && incoming.files?.length
        ? incoming.files.filter((f) => classifyMedia(f.mimeType, f.name) !== 'unsupported')
        : []
    for (const f of brainMediaFiles) {
      ingestChannelMediaRef!({
        source: { url: f.url }, // Discord CDN URLs are pre-signed — no auth header.
        mime: f.mimeType,
        fileName: f.name,
        sizeBytes: null,
        sender: { id: incoming.userId, name: null },
        conversationId: channelId,
        workspaceId: assistant.workspaceId!,
        assistantId: assistant.id,
        actingUserId: ownerId,
      })
        .then(async (result) => {
          // A BIG recording is held for confirmation (pre-flight-confirm
          // invariant): send the ask. The user's reply drives the confirm tool.
          if (result?.status === 'pending_confirmation') {
            await adapter.sendMessage(channelId, { text: result.message })
            return
          }
          // Document outcomes reply per §Phase 0.1/3.3; 'skipped' stays quiet.
          if (result?.status === 'ingested' && result.kind === 'document') {
            await adapter.sendMessage(channelId, { text: buildDocumentFiledReply(result.fileName) })
            return
          }
          if (result?.status === 'rejected' && result.reason === 'doc_too_large') {
            await adapter.sendMessage(channelId, {
              text: buildOversizeDocReply('https://app.sidan.ai', result.limitMb ?? 25, result.sizeMb ?? 0),
            })
          }
        })
        .catch((err) => console.error('[discord] media→brain ingest failed:', err))
    }
    // Documents ride BOTH paths — only AV is excluded from this turn's blocks.
    const contentBlockFiles = (incoming.files ?? []).filter((f) => !isAv(f.mimeType))

    // ── Build content blocks (text + downloaded attachments) ──
    const userContentBlocks: ContentBlock[] = []
    if (contentBlockFiles.length) {
      const downloads = await Promise.all(
        contentBlockFiles.map(async (file) => {
          try {
            // Discord CDN URLs are pre-signed — fetch directly, no auth header.
            const resp = await fetch(file.url)
            if (!resp.ok) {
              console.error(`[discord] file download failed (${resp.status}): ${file.name}`)
              return null
            }
            return { ...file, buffer: Buffer.from(await resp.arrayBuffer()) }
          } catch (err) {
            console.error(`[discord] failed to download file: ${file.name}`, err)
            return null
          }
        }),
      )
      for (const dl of downloads) {
        if (!dl) continue
        if (dl.mimeType.startsWith('image/') || dl.mimeType === 'application/pdf') {
          userContentBlocks.push({ type: 'image', mimeType: dl.mimeType, data: dl.buffer.toString('base64') })
          // Save-on-request seam — without the tag the model can SEE the
          // image but holds no reference to it, so "keep this" / "attach
          // this to the email" dead-ends. `channelUserId` MUST match the
          // session key the pipeline uses below. Empty string on any miss
          // keeps the pre-existing block-only turn.
          const tag = options.fileStore
            ? await cacheInboundImageTag({
                fileStore: options.fileStore,
                channelType: 'discord',
                channelId: incoming.channelId,
                userId: channelUserId,
                assistant,
                file: { buffer: dl.buffer, mime: dl.mimeType, fileName: dl.name },
              })
            : ''
          if (tag) userContentBlocks.push({ type: 'text', text: tag })
        } else {
          const parsedFile = await parseFileContent(dl.buffer, dl.mimeType, dl.name)
          if (
            parsedFile.mediaMimeType === 'application/pdf' ||
            parsedFile.mediaMimeType?.startsWith('image/')
          ) {
            userContentBlocks.push({
              type: 'image',
              mimeType: parsedFile.mediaMimeType,
              data: dl.buffer.toString('base64'),
            })
          } else {
            userContentBlocks.push({
              type: 'text',
              text: `<attached_file name="${dl.name}" type="${dl.mimeType}">\n${parsedFile.text}\n</attached_file>`,
            })
          }
        }
      }
    }
    if (incoming.text.trim()) {
      userContentBlocks.unshift({ type: 'text', text: incoming.text })
    } else if (userContentBlocks.length === 0) {
      return
    }

    // ── reactToMessage tool ──
    const extraTools = new Map(options.tools)
    const reactToMessage = createDiscordReactToMessageTool({
      adapter,
      channelId,
      messageId: incoming.messageId,
    })
    extraTools.set('reactToMessage', reactToMessage)

    // ── Status: one message, edited in place (Discord has no native indicator) ──
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
      backgroundModel: options.backgroundModel,
      userId: channelUserId,
      ownerId,
      assistant: { ...assistant, ownerUserId: ownerId },
      isIdentified,
      channelType: 'discord',
      channelId,
      messageText: incoming.text,
      userContentBlocks,
      // Raw paste for the large-paste intercept (Discord has no prefix wrapper).
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
      systemPrompt: options.systemPrompt,
      tools: extraTools,
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
          // Park the resolver so BOTH paths can answer: an atomic button press
          // (relayed back as an INTERACTION_CREATE → POST /interaction) and the
          // text fallback (the next message on this channel → DECISION_MAP). The
          // key includes toolCallId so a button echoing a stale id is rejected.
          pendingConfirmations.set(channelId, { resolver, toolCallId: req.toolCallId })
          const lines = req.displayLines && req.displayLines.length > 0
            ? req.displayLines
            : formatConfirmationInput(req.input)
          const inputSummary = lines.length > 0 ? '\n' + lines.join('\n') : ''
          const displayName = getToolDisplayName(req.toolName)

          // custom_id = mcp_confirm:<toolCallId>:<decision> (≤100 chars, the
          // Discord button limit). Mirrors the Telegram inline-keyboard payload.
          const actions: OutgoingAction[] = [
            { id: 'allow', label: 'Allow', data: `mcp_confirm:${req.toolCallId}:allow` },
            { id: 'deny', label: 'Deny', data: `mcp_confirm:${req.toolCallId}:deny` },
          ]
          if (req.allowPersistentApproval) {
            actions.push(
              { id: 'always', label: 'Always Allow', data: `mcp_confirm:${req.toolCallId}:always_allow` },
              { id: 'never', label: 'Always Deny', data: `mcp_confirm:${req.toolCallId}:always_deny` },
            )
          }
          const replyHint = req.allowPersistentApproval
            ? 'Tap a button, or reply: yes / no / always / never'
            : 'Tap a button, or reply: yes / no'
          await adapter.sendMessage(channelId, {
            text: `${displayName}${inputSummary}\n\n${replyHint}`,
            actions,
          })
        },
        async sendResponse(text, documents) {
          const finalText = text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
          const hasDocuments = !!documents?.length
          const reply = finalText || (hasDocuments ? '' : "I couldn't generate a reply — please rephrase or try again.")
          let channelMessageId: string | undefined
          // Edit-in-place: morph the status message into the response when it
          // fits one Discord message; otherwise drop the status and send fresh.
          // A reply carrying documents always sends fresh — an edit cannot
          // attach uploads, so the edit path would silently drop them.
          if (statusMessageId && !hasDocuments && reply.length <= 2000) {
            await adapter.editMessage(channelId, statusMessageId, { text: reply, format: 'markdown' })
            channelMessageId = statusMessageId
            statusMessageId = undefined
          } else {
            if (statusMessageId) {
              await adapter.deleteMessage?.(channelId, statusMessageId).catch(() => {})
              statusMessageId = undefined
            }
            channelMessageId = await adapter.sendMessage(
              channelId,
              { text: reply, format: 'markdown', documents },
              incoming.messageId ? { threadTs: incoming.messageId } : undefined,
            )
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
          if (statusMessageId) {
            await adapter.deleteMessage?.(channelId, statusMessageId).catch(() => {})
            statusMessageId = undefined
          }
          await adapter.sendMessage(channelId, {
            text: err.message.includes('usage limit')
              ? err.message
              : 'Something went wrong. Please try again.',
          })
        },
        async onCleanup() {
          // A leftover status message means we errored before sending a reply.
          if (statusMessageId) {
            await adapter.deleteMessage?.(channelId, statusMessageId).catch(() => {})
            statusMessageId = undefined
          }
        },
      },
    })
  }

  return router
}
