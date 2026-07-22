// REBRAND-CUTOVER: this file contains sidan.ai runtime values that must flip to usebrian.ai when DNS + Vercel domains + OAuth consoles + webhooks are cut over. Grep REBRAND-CUTOVER.
/**
 * Slack webhook route — per-channel BYO credentials.
 *
 * See docs/architecture/channels/adapter-pattern.md → "Slack Credential Provisioning".
 * Component tag: [COMP:api/slack-route].
 *
 * The route is mounted at `/webhook/slack/:channelId` — the workspace
 * `channels` id. The *answering* assistant is resolved from the channel:
 * `channel_assistants` routes per Slack conversation, falling back to the
 * channel default (see docs/architecture/channels/adapter-pattern.md). Each request:
 *
 *   1. Fetches the Slack integration from channel_integrations by the URL's
 *      channel id (no RLS — the request has no authenticated user yet).
 *   2. Verifies the HMAC-SHA256 signature against THIS integration's
 *      signing secret (not a global env var). Uses req.rawBody.
 *   3. Responds to Slack's url_verification challenge inline.
 *   4. Builds a per-request SlackAdapter from the decrypted bot token.
 *   5. Resolves the answering assistant via `channels` / `channel_assistants`,
 *      resolves the Slack sender → a platform user, runs the query loop.
 *
 * The raw body is preserved by the global `express.json({ verify })` hook
 * in `packages/api/src/index.ts` — don't mount `express.json()` again here
 * or the rawBody property will be lost.
 */

import { Router } from 'express'
import type { Request } from 'express'
import { createSlackAdapter, verifySlackSignature } from '@use-brian/channels'
import type { IncomingMessage, SlackAdapterConfig } from '@use-brian/channels'
import { findAssistantById, findUserById } from '../db/users.js'
import { query } from '../db/client.js'
import { withChatLock } from '../db/chat-lock.js'
import { resolveChannelUser, fetchSlackProfile, type ChannelUserStore } from '../db/channel-user-store.js'
import type { LinkCodeStore } from '../db/link-codes.js'
import type { LinkedAccountStore } from '../db/linked-accounts.js'
import { mergeShadowUser } from '../db/linked-accounts.js'
import { resolveAssistantForSurface, resolveRoutingForSurface, getChannelForWebhook } from '../db/channels-store.js'
import { parseFileContent, buildTool, sanitize as sanitizeAnalytics } from '@use-brian/core'
import { z } from 'zod'
import type { ConfirmationDecision, ConfirmationResolver, ContentBlock } from '@use-brian/core'
import type { LLMProvider, Tool, MemoryStore, UsageStore, AnalyticsLogger, McpSettingsStore, WorkflowEventDispatcher } from '@use-brian/core'
import type { ChannelIntegrationStore } from '../db/channel-integrations.js'
import type { ConnectorStore } from '../db/connector-store.js'
import { getToolDisplayName, humanizeToolName, describeToolInput, formatConfirmationInput } from '@use-brian/shared'
import { processChannelMessage } from './channel-pipeline.js'
import { billingPartyForAssistant } from '../billing-party.js'
import { tryResolveSchedulerConfirmation } from '../scheduling/confirmation-registry.js'
import type { DeferredConfirmationStore } from '../db/deferred-confirmation-store.js'
import { ensureSlackConnectorInstance } from '../ingest/slack-connector-instance.js'
import { classifyMedia, buildDocumentFiledReply, buildOversizeDocReply } from '../ingest/channel-media-intake.js'
import { dispatchReactionFeedback } from '../feedback/reaction-dispatch.js'

/**
 * Pipeline-C ingest port. The Slack webhook stays in the open core; the
 * rules-engine ingestor that turns channel traffic into brain Episodes is a
 * closed (hosted) implementation injected via `buildChannelHosts`. Absent
 * (OSS) → chat still works, channel traffic just isn't distilled into the
 * brain. The closed `ingest/slack-webhook-ingest.ts` implements this type.
 */
export type SlackWebhookIngestInput = {
  /** Workspace the resulting Episode belongs to. */
  workspaceId: string
  /** Owning user/assistant — billing party + extraction attribution. */
  userId: string
  assistantId: string | null
  /** Paired `connector_instance.id` keying the rule + batch lookup. */
  connectorInstanceId: string
  /** Slack team / workspace id (T*). */
  teamId: string
  /** Slack channel id (C* / D* / G*). */
  channelId: string
  /** Slack ts — used as the synthetic thread root for single-message events. */
  ts: string
  /** Parent thread ts; falls back to `ts` for a standalone message. */
  threadTs: string | null
  /** Author Slack user id. Absent for bot-only messages. */
  userSlackId: string | null
  /** Message text. */
  text: string
  /** True when the message author is a bot — bot traffic is skipped. */
  isBot: boolean
  /**
   * Slack bot token for this integration — used to resolve `<@U…>` mention
   * ids to names via `users.info` before extraction. When absent, mentions
   * are left unresolved (names fall back to any embedded `|label`).
   */
  botToken?: string
}

export type SlackWebhookIngestor = {
  /**
   * Route one inbound Slack message through the connector instance's
   * DB-backed rules and, depending on the routing decision, either
   * materialize an Episode inline (`realtime`) or append to a scheduled
   * batch (`scheduled`). Resolves to:
   *   - `{ episodeId }` when realtime extraction ran,
   *   - `null` for `drop` matches, scheduled enqueues, bot traffic,
   *     empty text, an unprovisioned CI, or a no-match outcome.
   */
  ingest: (input: SlackWebhookIngestInput) => Promise<{ episodeId: string } | null>
}

type SlackRouteOptions = {
  /** Servable background-lane model, resolved at boot; forwarded to the
   * channel pipeline so its background calls work without a Google key. */
  backgroundModel?: string
  provider: LLMProvider
  systemPrompt: string
  tools: Map<string, Tool>
  memoryStore: MemoryStore
  usageStore?: UsageStore
  checkCreditBudget?: import('./route-helpers.js').CreditBudgetGate
  integrationStore: ChannelIntegrationStore
  channelUserStore?: ChannelUserStore
  /** Link-code claim (identity healing). When both set, a 6-char code in DM merges the Slack user into the code owner. See docs/architecture/platform/identity-healing.md. */
  linkedAccountStore?: LinkedAccountStore
  linkCodeStore?: LinkCodeStore
  workerManager?: import('@use-brian/core').WorkerManager
  connectorStore?: ConnectorStore
  mcpSettingsStore?: McpSettingsStore
  assistantConnectorStore?: import('../db/assistant-connector-store.js').AssistantConnectorStore
  /** Stage 4 of the team-connector promotion: enables team-exposure grant consumption. */
  connectorGrantStore?: import('../db/connector-grant-store.js').ConnectorGrantStore
  /** Stage 5: enables team-native connector_instance consumption. */
  connectorInstanceStore?: import('../db/connector-instance-store.js').ConnectorInstanceStore
  knowledgeStore?: import('@use-brian/core').KnowledgeStoreInterface
  gdriveFilesStore?: import('@use-brian/core').GDriveFilesStore
  /** Workspace files store (Q3 §10). Optional. */
  workspaceFilesStore?: import('@use-brian/core').WorkspaceFilesStore
  /** Files orchestration API. Enables outbound documents (`sendFile`). */
  filesApi?: import('@use-brian/core').FilesApi
  /** Promotes an over-threshold text paste to a durable artifact
   *  (large-content-artifacts §Phase 3.2). Absent ⇒ pastes pass through. */
  artifactPromoter?: import('@use-brian/api/files/artifact-promote.js').ArtifactPromoter | null
  /**
   * Route a pulled media reference (a download URL) through the channel-media
   * intake (audio/video → recording → brain). Boot wires this over
   * `acquireAndIngest`; absent → media stays LLM-content-blocks only. See
   * docs/plans/channel-media-ingest.md §Phase 5.
   */
  ingestChannelMediaRef?: (input: {
    source: { url: string; headers?: Record<string, string> }
    mime: string
    fileName: string | null
    sizeBytes: number | null
    sender: { id: string; name: string | null }
    /** Conversation/chat id — correlates the pre-flight-confirm reply turn. */
    conversationId: string
    workspaceId: string
    assistantId: string
    actingUserId: string
  }) => Promise<import('../ingest/channel-media-intake.js').ChannelMediaIntakeResult>
  analytics?: AnalyticsLogger
  skillStore?: import('../db/skill-store.js').SkillStore
  pendingMessageStore?: import('../db/pending-message-store.js').PendingMessageStore
  deferredConfirmationStore?: DeferredConfirmationStore
  episodicStore?: import('@use-brian/core').EpisodicStore
  sessionStateStore?: import('@use-brian/core').SessionStateStore
  capabilityStore: import('@use-brian/core').CapabilityStore
  /**
   * Connector-action audit deps. When both are set + the answering
   * assistant is workspace-scoped, every outbound Slack `chat.postMessage`
   * / `chat.update` emits a `connector_action` Episode + audit row.
   *
   * TODO: migrate Slack to the unified `connector_instance` substrate
   * (see `docs/architecture/integrations/connector-actions.md`
   * → "Slack write actions (temp path)"). Until then the audit is
   * emitted at the bot-socket boundary rather than the tool boundary.
   */
  connectorActionStore?: import('../db/connector-actions-store.js').ConnectorActionStore
  episodesStore?: import('../db/episodes-store.js').DbEpisodesStore
  /**
   * Closed-seam audit factory (`connector-action-port.ts`). Binds the hosted
   * payload-classifier emission; absent (OSS) → outbound sends un-audited.
   */
  buildConnectorActionAudit?: import('../connector-action-port.js').BuildConnectorActionAudit
  /**
   * Shared workflow event-trigger dispatcher. When set, every inbound Slack
   * webhook is also fed to it — a `trigger.kind='event'` workflow whose
   * `event.sources[]` names this Slack channel integration fires. Best-effort
   * and independent of chat handling. See workflow-builder.md §Event trigger.
   */
  workflowEventDispatcher?: WorkflowEventDispatcher
  /**
   * Pipeline B ingestor for Slack channel messages. When set + the channel
   * has the `'ingest'` capability enabled, every inbound message is also
   * routed through the in-memory rule list and — on a realtime match —
   * materialized as a `slack_thread` Episode + extracted. Best-effort,
   * runs after the workflow-event dispatch and never blocks chat.
   * See docs/architecture/brain/ingest-pipeline.md → "Source adapters".
   */
  slackWebhookIngestor?: SlackWebhookIngestor
}

// Natural language → decision mapping for Slack text-based confirmation
const DECISION_MAP: Record<string, ConfirmationDecision> = {
  yes: 'allow', y: 'allow', allow: 'allow', approve: 'allow', ok: 'allow',
  no: 'deny', n: 'deny', deny: 'deny', reject: 'deny',
  always: 'always_allow', 'always allow': 'always_allow',
  never: 'always_deny', 'always deny': 'always_deny',
}

export function slackRoutes(options: SlackRouteOptions): Router {
  const router = Router()

  // Active abort controllers — keyed by channelId, so "stop" messages
  // can cancel the in-flight query loop.
  const activeAbortControllers = new Map<string, AbortController>()

  // Pending Slack confirmations — keyed by channelId
  type SlackPendingConf = { resolver: ConfirmationResolver; toolCallId: string }
  const pendingSlackConfirmations = new Map<string, SlackPendingConf>()

  router.post<{ channelId: string }>('/:channelId', async (req, res) => {
    const { channelId } = req.params

    // ── URL verification (must be BEFORE integration lookup) ────
    // Slack sends this challenge when the user creates their app
    // from the manifest. At that point no integration row exists
    // yet — the user hasn't pasted credentials into Use Brian. The
    // challenge contains no sensitive data, so responding without
    // auth is safe and required for the "Create from manifest" flow.
    const body = req.body as { type?: string; challenge?: string }
    if (body.type === 'url_verification' && body.challenge) {
      res.json({ challenge: body.challenge })
      return
    }

    const rawBody = (req as Request & { rawBody?: string }).rawBody ?? JSON.stringify(req.body)

    // 1. Fetch integration (skips RLS — webhooks arrive pre-auth)
    const integration = await options.integrationStore.getByChannelForWebhook(
      channelId,
      'slack',
    )
    if (!integration) {
      res.status(404).end()
      return
    }

    // 2. Verify the Slack signature with the integration's signing secret
    const slackCreds = integration.credentials as import('../db/channel-integrations.js').SlackCredentials
    if (
      !verifySlackSignature({
        signingSecret: slackCreds.signing_secret,
        signature: req.header('x-slack-signature') ?? undefined,
        timestamp: req.header('x-slack-request-timestamp') ?? undefined,
        body: rawBody,
      })
    ) {
      res.status(401).end()
      return
    }

    // Acknowledge the webhook immediately — Slack retries if we don't ACK
    // within 3 seconds, and the queryLoop can take much longer.
    res.status(200).end()

    // Fire-and-forget: touch last_event_at so the UI can show freshness.
    options.integrationStore.touchLastEventAt(integration.id).catch((err) => {
      console.error('[slack] touchLastEventAt failed:', err)
    })

    // ── Deferred best-effort producers (workflow-event + ingest) ──
    // Both are best-effort and must run for EVERY inbound event — including
    // non-mention messages and ingest-only channels where `chat` is disabled —
    // so they fire from the `finally` below, on every exit path. They are
    // DEFERRED (not fired here) so they do NOT compete with the user-facing
    // chat turn for the small connection pool during a burst: each inbound
    // message otherwise fans out a chat turn PLUS these producers concurrently,
    // and on a `PG_POOL_MAX=2` pool that races the reply into a
    // `timeout exceeded when trying to connect` (the 2026-06-29 Slack
    // pool-exhaustion incident — see docs/architecture/platform/deployment.md
    // → "fleet-wide connection budget"). Running them after the turn settles
    // keeps interactive latency on the user's connection budget, not the
    // brain-extraction one.
    //   - workflow event-trigger producer: an `event`-trigger workflow can
    //     fire on any Slack message (bot-authored or not, @mention or not), so
    //     it sees the raw event.
    //   - Pipeline B ingest producer (the fifth ingest producer; the four
    //     polled ones — github / gmail / calendar / fathom — handle
    //     webhook-less sources): routes the message through `slackDefaultRules`
    //     first-match-wins; a realtime match materializes a `slack_thread`
    //     Episode and runs Pipeline B. Gated on the channel's `'ingest'`
    //     capability. See `ingest/slack-webhook-ingest.ts`.
    let backgroundProducersDrained = false
    const drainBackgroundProducers = (): void => {
      if (backgroundProducersDrained) return
      backgroundProducersDrained = true
      if (options.workflowEventDispatcher) {
        void dispatchSlackWorkflowEvent(
          options.workflowEventDispatcher,
          req.body,
          integration.id,
          channelId,
        ).catch((err) =>
          console.error('[slack] workflow event dispatch failed:', err),
        )
      }
      if (options.slackWebhookIngestor) {
        void dispatchSlackIngest(
          options.slackWebhookIngestor,
          req.body,
          channelId,
          integration.id,
          integration.connectorInstanceId,
          slackCreds.bot_token,
        ).catch((err) =>
          console.error('[slack] ingest dispatch failed:', err),
        )
      }
    }

    // ── Reaction feedback producer ────────────────────────────────
    // `reaction_added` events on an assistant message become brain
    // feedback signal (👍 / 👎 → `recordFeedback` → analytics_events
    // for the reflection consolidation to read). Ambiguous emoji,
    // reactions on user messages, and reactions on messages
    // predating the channel-id plumbing are silently ignored.
    // Best-effort, never blocks chat. See docs/architecture/brain/corrections.md.
    if (options.channelUserStore) {
      void dispatchSlackReactionFeedback({
        body: req.body,
        botToken: slackCreds.bot_token,
        channelsRowId: channelId,
        channelUserStore: options.channelUserStore,
      }).catch((err) =>
        console.error('[slack] reaction feedback dispatch failed:', err),
      )
    }

    // Parse → resolve → chat turn run inside this try so the deferred
    // background producers above drain in `finally` on EVERY exit path
    // (early return, chat-turn success/failure, or unexpected error),
    // preserving "they always run". The body indentation is kept flat
    // intentionally — this is an additive try/finally wrap, not a ~280-line
    // re-indent.
    try {
    // 4. Build a per-request adapter with this integration's bot token + config.
    //
    // The outbound audit hook is deferred — at construction time we don't
    // know which assistant will answer (that's resolved AFTER parsing).
    // The mutable holder is set once the assistant is resolved (below),
    // and `safeAudit` consults it at send-time. If the assistant
    // resolution fails (404), `outboundAuditHolder.fn` stays null and
    // sends through `chat.postMessage` are not audited — same posture as
    // the pre-audit codepath.
    const slackConfig = (integration.config ?? {}) as SlackAdapterConfig
    let extractedMessage: IncomingMessage | null = null
    const outboundAuditHolder: {
      fn:
        | null
        | ((event: import('@use-brian/channels').SlackOutboundAudit) => Promise<void>)
    } = { fn: null }
    const adapter = createSlackAdapter({
      botToken: slackCreds.bot_token,
      botUserId: integration.botUserId ?? undefined,
      config: slackConfig,
      onMessage: (msg) => { extractedMessage = msg },
      onOutboundAudit: async (event) => {
        if (outboundAuditHolder.fn) await outboundAuditHolder.fn(event)
      },
    })

    // Drive the adapter's event handler — it parses the Slack payload,
    // filters bot messages, checks @mentions for group chats, and invokes
    // onMessage for the single normalized IncomingMessage.
    adapter.handleEvent(req.body)
    if (!extractedMessage) return

    const incoming: IncomingMessage = extractedMessage

    // 5. Resolve the answering assistant via the workspace channel.
    //    `channel_assistants` routes per external surface — the Slack
    //    conversation id picks a surface-specific assistant, else the channel
    //    default. Capability gate: a revoked channel, or one with `chat`
    //    disabled, rejects inbound. See docs/architecture/channels/adapter-pattern.md.
    const channel = await getChannelForWebhook(channelId)
    if (!channel || channel.status !== 'active' || !channel.enabledCapabilities.includes('chat')) {
      console.warn(`[slack] channel ${channelId} not accepting chat — ignoring inbound`)
      return
    }
    const resolvedRouting = await resolveRoutingForSurface(channelId, incoming.channelId)
    if (!resolvedRouting) {
      console.error(`[slack] channel ${channelId} has no assistant routing — ignoring inbound`)
      return
    }
    const resolvedAssistantId = resolvedRouting.assistantId

    const assistant = await findAssistantById(resolvedAssistantId)
    if (!assistant) {
      console.error(`[slack] assistant ${resolvedAssistantId} not found (integration orphaned?)`)
      return
    }
    // Override the per-assistant default with the routing row's modelAlias.
    // Migration 197 made the routing row the source of truth; the Settings
    // tab value stays as the seed for fresh attachments only.
    assistant.slackModelAlias = resolvedRouting.modelAlias
    // Post-089 ownership XOR: team assistants have NULL owner_user_id and
    // team access flows through teams.owner_user_id. `billingPartyForAssistant`
    // is the single source of truth for "the authoritative user behind
    // this assistant" and handles both XOR branches. Used downstream for
    // session ownership, memory attribution, and budget gating.
    // See docs/architecture/integrations/mcp.md.
    const ownerId = await billingPartyForAssistant({
      id: assistant.id,
      ownerUserId: assistant.ownerUserId ?? null,
      workspaceId: assistant.workspaceId ?? null,
    })

    // ── Connector-action audit wiring (Slack temp path) ──────────
    //
    // With the assistant resolved, set the deferred audit hook so every
    // outbound `chat.postMessage` / `chat.update` writes a
    // `connector_action` Episode + audit row. Workspace-scoped chats
    // only — personal assistants don't have a workspace partition.
    // `audience_clearance` is derived from the Slack channel id prefix:
    //   - 'D' (DM) → internal
    //   - 'G' (private group) → internal
    //   - 'C' (public channel) → public
    //   - default → public (safer ceiling)
    if (
      assistant.workspaceId &&
      options.connectorActionStore &&
      options.episodesStore &&
      options.buildConnectorActionAudit
    ) {
      const workspaceId = assistant.workspaceId
      const assistantId = assistant.id
      const assistantClearance = assistant.clearance
      const userId = ownerId
      const connectorActionStore = options.connectorActionStore
      const episodesStore = options.episodesStore
      const buildAudit = options.buildConnectorActionAudit

      function audienceFromSlackChannelId(channel: string): 'public' | 'internal' {
        const ch = channel.charAt(0).toUpperCase()
        if (ch === 'D' || ch === 'G') return 'internal'
        return 'public'
      }

      outboundAuditHolder.fn = async (event) => {
        const audienceClearance = audienceFromSlackChannelId(event.channel)
        // Truncate text for audit payload — Slack messages can be up
        // to 4000 chars and the body is the largest field on the row.
        const text = event.text.length > 4096 ? event.text.slice(0, 4096) + '…(truncated)' : event.text
        const auditPayload: Record<string, unknown> = {
          channel: event.channel,
          thread_ts: event.ts ?? null,
          text,
          length: event.text.length,
        }
        if (event.status === 'failed' && event.error) {
          auditPayload.error = event.error
        }
        try {
          // Audit emission goes through the open connector-action PORT — the
          // closed emission primitive (payload classifier + env) is bound by
          // the composition root's `buildConnectorActionAudit`. Open build
          // leaves the factory unset and outbound sends run un-audited.
          const audit = buildAudit({
            workspaceId,
            assistantClearance,
            sensitivityAccumulator: undefined,
            connectorActionStore,
            episodesStore,
          })
          await audit.emit(
            { userId, assistantId },
            {
              connectorId: 'slack',
              actionKind: event.kind,
              audienceClearance,
              status: event.status,
              externalId: event.externalTs
                ? `${event.channel}:${event.externalTs}`
                : null,
              payload: auditPayload,
            },
          )
        } catch (auditErr) {
          console.warn(
            '[slack] connector_action audit emit failed (best-effort, suppressed):',
            auditErr instanceof Error ? auditErr.message : String(auditErr),
          )
        }
      }
    }

    // Access control — silently ignore messages from unauthorized users
    const accessMode = slackConfig.userAccessMode ?? 'allow_all'
    if (accessMode === 'allowlist') {
      const allowed = slackConfig.allowedUserIds ?? []
      if (allowed.length > 0 && !allowed.includes(incoming.userId)) return
    } else if (accessMode === 'blocklist') {
      const blocked = slackConfig.blockedUserIds ?? []
      if (blocked.includes(incoming.userId)) return
    }

    // Ack reaction — instant visual feedback before processing starts
    if (slackConfig.ackReaction && incoming.messageId) {
      adapter.reactToMessage?.(incoming.channelId, incoming.messageId, slackConfig.ackReaction)
        .catch(() => {}) // non-critical
    }

    // Compute thread target: if replyInThread is enabled, reply in the
    // existing thread (thread_ts) or start a new thread on the user's message (ts).
    const threadTs = slackConfig.replyInThread
      ? (incoming.replyToMessageId ?? incoming.messageId)
      : undefined

    // ── Check if this message is an abort request or edit ───────
    // Bypass the chat lock — abort the running loop immediately.
    const ABORT_KEYWORDS = ['stop', 'cancel', 'abort', 'nevermind', 'never mind']
    const normalizedText = incoming.text.trim().toLowerCase()
    const activeController = activeAbortControllers.get(incoming.channelId)
    if (activeController) {
      if (ABORT_KEYWORDS.includes(normalizedText)) {
        // Explicit abort — cancel and acknowledge
        activeController.abort()
        activeAbortControllers.delete(incoming.channelId)
        await adapter.sendMessage(incoming.channelId, { text: 'Stopped.' }, threadTs ? { threadTs } : undefined)
        return
      }
      if (incoming.isEdit) {
        // Edit-to-retry — abort the current loop so the edited message
        // can be reprocessed. The edit falls through to normal processing
        // via the chat lock (which serializes after the abort completes).
        activeController.abort()
        activeAbortControllers.delete(incoming.channelId)
      }
    }

    // ── Check if this message is a confirmation response ──────
    const pendingConf = pendingSlackConfirmations.get(incoming.channelId)
    if (pendingConf) {
      const normalized = incoming.text.trim().toLowerCase()
      const decision = DECISION_MAP[normalized]
      if (decision) {
        pendingConf.resolver.resolve(pendingConf.toolCallId, decision)
        pendingSlackConfirmations.delete(incoming.channelId)
        return
      }
      // If the text doesn't match any decision keyword, treat as deny
      // and process as a new message
      pendingConf.resolver.resolve(pendingConf.toolCallId, 'deny')
      pendingSlackConfirmations.delete(incoming.channelId)
    } else if (options.deferredConfirmationStore) {
      // Check for a deferred confirmation from a scheduled job
      const normalized = incoming.text.trim().toLowerCase()
      const decision = DECISION_MAP[normalized]
      if (decision) {
        const deferred = await options.deferredConfirmationStore.findPendingByChannel('slack', incoming.channelId)
        if (deferred && tryResolveSchedulerConfirmation(deferred.toolCallId, decision)) {
          options.deferredConfirmationStore.markResolved(deferred.toolCallId, decision)
            .catch((err) => console.error('[slack] deferred confirmation DB update failed:', err))
          return
        }
      }
    }

    // 5a-link. Link-code claim — a 6-char alphanumeric code in a Slack
    //          message binds this Slack user to the sidan web user that
    //          generated the code. Merges sessions/memories. See
    //          docs/architecture/platform/identity-healing.md.
    if (
      options.linkCodeStore &&
      options.linkedAccountStore &&
      incoming.userId &&
      incoming.text
    ) {
      const trimmed = incoming.text.trim().toUpperCase()
      if (/^[A-Z0-9]{6}$/.test(trimmed)) {
        const code = await options.linkCodeStore.findValidCode(trimmed)
        if (code) {
          try {
            await options.linkedAccountStore.upsert({
              userId: code.userId,
              assistantId: code.assistantId,
              provider: 'slack',
              providerId: incoming.userId,
              providerMetadata: { channelId: incoming.channelId },
            })
            await options.linkCodeStore.claim(trimmed, incoming.userId)
            mergeShadowUser(code.userId, incoming.userId, 'slack', {
              reason: 'link-code',
              evidence: { codeId: code.id, channelId: incoming.channelId },
            }).catch((err) => {
              console.error('[slack] link-code merge failed:', err)
            })
            const linkedAssistant = await findAssistantById(code.assistantId)
            const assistantName = linkedAssistant?.name ?? 'your assistant'
            await adapter.sendMessage(incoming.channelId, {
              text: `Linked to "${assistantName}". Your past conversations here are now connected to your account.`,
            }, threadTs ? { threadTs } : undefined).catch((err) => {
              console.error('[slack] link confirmation send failed:', err)
            })
            return
          } catch (err) {
            console.error('[slack] link-code claim failed:', err)
            // Fall through to normal processing — the user can retry.
          }
        }
      }
    }

    // 5b. Resolve channel user identity — maps Slack user → platform user.
    //     See docs/architecture/channels/channel-user-identity.md.
    let channelUserId = ownerId
    let isIdentified = true
    if (options.channelUserStore && incoming.userId) {
      try {
        const resolved = await resolveChannelUser(
          options.channelUserStore,
          'slack',
          incoming.userId,
          resolvedAssistantId,
          () => fetchSlackProfile(incoming.userId, slackCreds.bot_token),
        )
        channelUserId = resolved.user.id
        isIdentified = resolved.isIdentified
      } catch (err) {
        console.error('[slack] channel user resolution failed, falling back to owner:', err)
      }
    }

    // 6. Sequentialize per Slack channel via Postgres advisory lock.
    //    Awaited (not fire-and-forget) so the deferred background producers
    //    drain AFTER the user-facing reply, never concurrently with it.
    try {
      await withChatLock(`slack:${incoming.channelId}`, () =>
        processMessage({
          backgroundModel: options.backgroundModel,
          adapter,
          incoming,
          assistant,
          channelUserId,
          ownerId,
          isIdentified,
          threadTs,
          botToken: slackCreds.bot_token,
          ...options,
          pendingSlackConfirmations,
          activeAbortControllers,
        }),
      )
    } catch (err) {
      console.error(`[slack] error processing message for chat ${incoming.channelId}:`, err)
      // Surface the terminal failure as an analytics row. Without this, a
      // dropped reply (e.g. a pool-exhaustion "timeout exceeded when trying
      // to connect" when a burst makes pool checkouts wait past
      // connectionTimeoutMillis — see docs/architecture/platform/deployment.md
      // → "fleet-wide connection budget") is invisible: no retry, no user
      // signal, only this console line. Reuses the `chat_route_error`
      // taxonomy so sessions can self-diagnose via analytics_events. The
      // channel-pipeline's own try/catch covers query-loop failures; this
      // catches everything earlier in the turn that bubbles up to the route.
      options.analytics?.logEvent({
        userId: ownerId,
        assistantId: assistant.id,
        eventName: 'chat_route_error',
        channelType: 'slack',
        metadata: {
          error_type: sanitizeAnalytics((err as Error)?.name ?? 'unknown'),
          error_message: sanitizeAnalytics(((err as Error)?.message ?? '').slice(0, 200)),
          stage: sanitizeAnalytics('slack_route_catch'),
        },
      })
    }
    } catch (err) {
      // Safety net: anything earlier in parse/resolve that throws after the
      // 200 ACK used to surface as an unhandled rejection. Log and continue so
      // the `finally` still drains the background producers.
      console.error('[slack] inbound processing error:', err)
    } finally {
      drainBackgroundProducers()
    }
  })

  return router
}

// ── Workflow event-trigger producer ─────────────────────────────
//
// The channel half of the workflow `event` trigger. The mention-gating
// SlackAdapter drops bot + non-mention messages — but an `event`-trigger
// workflow may want exactly those (a monitoring bot's alert in #incidents).
// So this parses the raw Slack Events API payload itself and feeds the
// shared `WorkflowEventDispatcher`, which connectors share via the ingest
// `onEvent` seam. See docs/plans/company-brain/workflow-builder.md §Event
// trigger.

type ParsedSlackEvent = {
  /** The Slack event type — `message` (any post) or `app_mention` (the `<@bot>` twin). */
  eventType: 'message' | 'app_mention'
  text: string | null
  actorId: string | null
  channelId: string | null
  mentions: string[]
  isBot: boolean
  payload: Record<string, unknown>
}

/** `<@U123>` mention ids in Slack message text. */
function parseSlackMentions(text: string | null): string[] {
  if (!text) return []
  return [...text.matchAll(/<@([A-Z0-9]+)>/g)].map((m) => m[1])
}

/**
 * Parse a raw Slack Events API payload into the matchable fields the
 * workflow dispatcher needs. Returns null for anything that is not a fresh
 * channel post — URL verification, message edits / deletes, channel joins.
 * A bot post carries `subtype='bot_message'` (legacy) or a `bot_id` with no
 * subtype (modern); both are kept so a workflow can opt into bot traffic.
 */
function parseSlackEventForDispatch(body: unknown): ParsedSlackEvent | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (b.type !== 'event_callback') return null
  const ev = b.event
  if (!ev || typeof ev !== 'object') return null
  const e = ev as Record<string, unknown>
  if (e.type !== 'message' && e.type !== 'app_mention') return null
  if (typeof e.subtype === 'string' && e.subtype !== 'bot_message') return null

  const text = typeof e.text === 'string' ? e.text : null
  const isBot = typeof e.bot_id === 'string' || e.subtype === 'bot_message'
  const actorId =
    typeof e.user === 'string'
      ? e.user
      : typeof e.bot_id === 'string'
        ? e.bot_id
        : null
  const channelId = typeof e.channel === 'string' ? e.channel : null
  const eventType: 'message' | 'app_mention' =
    e.type === 'app_mention' ? 'app_mention' : 'message'

  return {
    eventType,
    text,
    actorId,
    channelId,
    mentions: parseSlackMentions(text),
    isBot,
    payload: {
      text: text ?? '',
      channel_id: channelId,
      thread_ts: typeof e.thread_ts === 'string' ? e.thread_ts : null,
      ts: typeof e.ts === 'string' ? e.ts : null,
      user: actorId,
      is_bot: isBot,
    },
  }
}

/**
 * Feed one raw Slack webhook payload to the workflow event dispatcher.
 * `channelsRowId` is the `channels` row (the webhook URL param) — used to
 * resolve the workspace; `channelIntegrationId` is the `channel_integrations`
 * row id a workflow's `event` source names.
 */
async function dispatchSlackWorkflowEvent(
  dispatcher: WorkflowEventDispatcher,
  body: unknown,
  channelIntegrationId: string,
  channelsRowId: string,
): Promise<void> {
  const parsed = parseSlackEventForDispatch(body)
  if (!parsed) return
  const channel = await getChannelForWebhook(channelsRowId)
  if (!channel) return
  await dispatcher.dispatch({
    workspaceId: channel.workspaceId,
    source: { type: 'channel', channelIntegrationId, channel: 'slack' },
    text: parsed.text,
    actorId: parsed.actorId,
    channelId: parsed.channelId,
    mentions: parsed.mentions,
    isBot: parsed.isBot,
    payload: parsed.payload,
  })
}

/**
 * Feed one raw Slack webhook payload to the Pipeline B ingestor.
 *
 * Resolves the workspace via the `channels` row, gates on the `'ingest'`
 * capability (operators opt the channel out of brain ingest by removing
 * `ingest` from `channels.enabled_capabilities`), resolves the answering
 * assistant + owner so the Episode is attributed correctly, then hands
 * the parsed event off. Bot traffic, empty-text events, and filter-misses
 * resolve to `null` inside the ingestor.
 *
 * `channelsRowId` is the `channels` row (the webhook URL param).
 */
async function dispatchSlackIngest(
  ingestor: SlackWebhookIngestor,
  body: unknown,
  channelsRowId: string,
  channelIntegrationId: string,
  connectorInstanceId: string | null,
  botToken: string,
): Promise<void> {
  const parsed = parseSlackEventForDispatch(body)
  if (!parsed) return
  // Bot traffic — skip before any DB work.
  if (parsed.isBot) return
  // De-dupe Slack's double delivery of bot-mention messages. A message that
  // @mentions the bot is delivered as BOTH a `message.*` event AND a separate
  // `app_mention` event (the manifest subscribes to both — app_mention is
  // needed for the chat path's reliable mention detection). The `message.*`
  // event already covers every post — mention or not — so ingesting the
  // `app_mention` twin would double-materialize the same `ts`: a redundant
  // extraction pass plus duplicate person/entity writes. Key ingest on the
  // `message` event and drop the app_mention twin. (Confirmed in prod
  // 2026-06-30: every `<@bot>` message appeared 2× in one scheduled batch
  // with an identical ts.) The workflow-event producer above is unaffected —
  // it intentionally still sees both. See ingest-pipeline.md → "Webhook
  // producer (Slack)".
  if (parsed.eventType === 'app_mention') return
  // Need channel + actor + text — without these there is nothing to ingest.
  if (!parsed.channelId || !parsed.text) return

  const channel = await getChannelForWebhook(channelsRowId)
  if (!channel) return
  if (!channel.enabledCapabilities.includes('ingest')) return

  // Resolve the answering assistant via the channel's routing rows — the
  // Episode is attributed to whichever assistant would have answered the
  // message had it been chat. Workspace channels always have a default
  // routing row, but a channel mid-setup may not; skip in that case.
  const assistantId = await resolveAssistantForSurface(channelsRowId, parsed.channelId)
  if (!assistantId) return
  const assistant = await findAssistantById(assistantId)
  if (!assistant) return
  const ownerId = await billingPartyForAssistant({
    id: assistant.id,
    ownerUserId: assistant.ownerUserId ?? null,
    workspaceId: assistant.workspaceId ?? null,
  })

  // Lazy-provision a paired connector_instance if the integration was
  // installed before migration 182 landed (or in the gap between the
  // install upsert and the install-time hook). Idempotent + self-healing.
  let ciId = connectorInstanceId
  if (!ciId) {
    try {
      ciId = await ensureSlackConnectorInstance({
        channelIntegrationId,
        actingUserId: ownerId,
      })
    } catch (err) {
      console.error('[slack] CI lazy-provision failed:', err)
      return
    }
  }

  const payload = parsed.payload as Record<string, unknown>
  const teamId = readPayloadString(body, 'team_id')
  const ts = typeof payload.ts === 'string' ? payload.ts : null
  if (!teamId || !ts) return

  await ingestor.ingest({
    workspaceId: channel.workspaceId,
    userId: ownerId,
    assistantId: assistant.id,
    connectorInstanceId: ciId,
    teamId,
    channelId: parsed.channelId,
    ts,
    threadTs: typeof payload.thread_ts === 'string' ? payload.thread_ts : null,
    userSlackId: parsed.actorId,
    text: parsed.text,
    isBot: parsed.isBot,
    botToken,
  })
}

/** Read a top-level string field off a raw Slack `event_callback` body. */
function readPayloadString(body: unknown, key: string): string | null {
  if (!body || typeof body !== 'object') return null
  const v = (body as Record<string, unknown>)[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}

// ── Reaction feedback producer ─────────────────────────────────

/**
 * Parse one Slack `event_callback` body for a `reaction_added` event
 * on a bot message and route it to `dispatchReactionFeedback`.
 *
 * Non-reaction events, reactions on non-message items, and reactions
 * on user messages (item_user != our bot) are silently dropped. The
 * reaction is classified by the shared emoji map; ambiguous emoji
 * yield no feedback signal.
 *
 * `reaction_removed` events are deliberately ignored in v1 — the
 * analytics row stays in place even if the user removes their
 * reaction. Adding retraction is a follow-up (corrections.md
 * §"Emoji reaction retraction").
 *
 * Spec: docs/architecture/brain/corrections.md → "Emoji reactions
 * as feedback signal".
 */
async function dispatchSlackReactionFeedback(params: {
  body: unknown
  botToken: string
  channelsRowId: string
  channelUserStore: ChannelUserStore
}): Promise<void> {
  const { body, botToken, channelsRowId, channelUserStore } = params
  if (!body || typeof body !== 'object') return
  const b = body as Record<string, unknown>
  if (b.type !== 'event_callback') return
  const ev = b.event
  if (!ev || typeof ev !== 'object') return
  const e = ev as Record<string, unknown>
  if (e.type !== 'reaction_added') return

  const item = e.item
  if (!item || typeof item !== 'object') return
  const it = item as Record<string, unknown>
  if (it.type !== 'message') return

  const reactingSlackUserId = typeof e.user === 'string' ? e.user : null
  const itemUserSlackId = typeof e.item_user === 'string' ? e.item_user : null
  const channelId = typeof it.channel === 'string' ? it.channel : null
  const messageTs = typeof it.ts === 'string' ? it.ts : null
  const rawEmoji = typeof e.reaction === 'string' ? e.reaction : null
  if (!reactingSlackUserId || !channelId || !messageTs || !rawEmoji) return

  // Channel gate — skip reactions on revoked / chat-disabled channels.
  const channel = await getChannelForWebhook(channelsRowId)
  if (!channel || channel.status !== 'active' || !channel.enabledCapabilities.includes('chat')) return

  // The lookup inside `dispatchReactionFeedback` filters by
  // `role='assistant'` so reactions on user messages are naturally
  // dropped. `item_user` is referenced here only for clarity.
  void itemUserSlackId

  await dispatchReactionFeedback({
    source: 'slack',
    channelId,
    channelMessageId: messageTs,
    rawEmoji,
    resolveUserId: async (assistantId) => {
      const assistant = await findAssistantById(assistantId)
      if (!assistant) return null
      // Fall back to the assistant owner if channel-user resolution
      // fails so feedback attribution stays best-effort. The recorded
      // `metadata.source='slack'` + `channelId` still identify the
      // surface for analytics.
      const ownerId = await billingPartyForAssistant({
        id: assistant.id,
        ownerUserId: assistant.ownerUserId ?? null,
        workspaceId: assistant.workspaceId ?? null,
      })
      try {
        const resolved = await resolveChannelUser(
          channelUserStore,
          'slack',
          reactingSlackUserId,
          assistantId,
          () => fetchSlackProfile(reactingSlackUserId, botToken),
        )
        return resolved.user.id
      } catch (err) {
        console.warn('[slack-reaction] channel user resolution failed, using owner:', err)
        return ownerId
      }
    },
  })
}

// ── Per-message handler (mirrors the Telegram route) ──────────

type ProcessMessageParams = {
  /** Servable background-lane model, threaded from the route options. */
  backgroundModel?: string
  adapter: ReturnType<typeof createSlackAdapter>
  incoming: IncomingMessage
  assistant: { id: string; name: string; ownerUserId: string; slackModelAlias: string; workspaceId: string | null; systemPrompt: string | null; clearance: 'public' | 'internal' | 'confidential'; kind: 'primary' | 'standard' | 'app' }
  channelUserId: string
  ownerId: string
  isIdentified: boolean
  threadTs?: string
  botToken: string
  ingestChannelMediaRef?: SlackRouteOptions['ingestChannelMediaRef']
  provider: LLMProvider
  systemPrompt: string
  tools: Map<string, Tool>
  memoryStore: MemoryStore
  usageStore?: UsageStore
  checkCreditBudget?: import('./route-helpers.js').CreditBudgetGate
  workerManager?: import('@use-brian/core').WorkerManager
  connectorStore?: ConnectorStore
  mcpSettingsStore?: McpSettingsStore
  assistantConnectorStore?: import('../db/assistant-connector-store.js').AssistantConnectorStore
  /** Stage 4 of the team-connector promotion: enables team-exposure grant consumption. */
  connectorGrantStore?: import('../db/connector-grant-store.js').ConnectorGrantStore
  /** Stage 5: enables team-native connector_instance consumption. */
  connectorInstanceStore?: import('../db/connector-instance-store.js').ConnectorInstanceStore
  knowledgeStore?: import('@use-brian/core').KnowledgeStoreInterface
  gdriveFilesStore?: import('@use-brian/core').GDriveFilesStore
  /** Workspace files store (Q3 §10). Optional. */
  workspaceFilesStore?: import('@use-brian/core').WorkspaceFilesStore
  /** Files orchestration API. Enables outbound documents (`sendFile`) —
   *  delivered via Slack's external upload flow (needs `files:write`). */
  filesApi?: import('@use-brian/core').FilesApi
  /** Promotes an over-threshold text paste to a durable artifact
   *  (large-content-artifacts §Phase 3.2). Absent ⇒ pastes pass through. */
  artifactPromoter?: import('@use-brian/api/files/artifact-promote.js').ArtifactPromoter | null
  analytics?: AnalyticsLogger
  skillStore?: import('../db/skill-store.js').SkillStore
  pendingSlackConfirmations: Map<string, { resolver: ConfirmationResolver; toolCallId: string }>
  activeAbortControllers: Map<string, AbortController>
  pendingMessageStore?: import('../db/pending-message-store.js').PendingMessageStore
  episodicStore?: import('@use-brian/core').EpisodicStore
  sessionStateStore?: import('@use-brian/core').SessionStateStore
  capabilityStore: import('@use-brian/core').CapabilityStore
}

async function processMessage(params: ProcessMessageParams): Promise<void> {
  const { adapter, incoming, assistant, channelUserId, ownerId, isIdentified, threadTs, botToken, ingestChannelMediaRef } = params
  const threadOpts = threadTs ? { threadTs } : undefined

  const statusThreadTs = incoming.replyToMessageId ?? incoming.messageId
  const statusOpts = {
    ...(statusThreadTs ? { threadTs: statusThreadTs } : threadOpts ? threadOpts : {}),
    messageId: incoming.messageId,
  }

  // ── Slack-specific: download files and build content blocks ──
  const userContentBlocks: ContentBlock[] = []
  // Route AUDIO/VIDEO + DOCUMENT attachments to the brain: AV → recording
  // pipeline (transcribe → Pipeline B; useless as content blocks), documents →
  // durable artifact + file_segments (large-content-artifacts §Phase 3.3).
  // Documents ALSO stay content blocks for this turn (they ride both paths);
  // AV stays excluded from blocks as before. Fire-and-forget; never blocks
  // the reply.
  const isAv = (m: string) => m.startsWith('audio/') || m.startsWith('video/')
  const brainMediaFiles =
    ingestChannelMediaRef && assistant.workspaceId && incoming.files?.length
      ? incoming.files.filter((f) => classifyMedia(f.mimeType) !== 'unsupported')
      : []
  for (const f of brainMediaFiles) {
    ingestChannelMediaRef!({
      source: { url: f.url, headers: { Authorization: `Bearer ${botToken}` } },
      mime: f.mimeType,
      fileName: f.name,
      sizeBytes: null, // Slack IncomingFile carries no size; the stream byte-cap guards.
      sender: { id: incoming.userId, name: null },
      conversationId: incoming.channelId,
      workspaceId: assistant.workspaceId!,
      assistantId: assistant.id,
      actingUserId: ownerId,
    })
      .then(async (result) => {
        // A BIG recording is held for confirmation (pre-flight-confirm invariant):
        // send the templated ask. The user's reply turn drives the confirm tool.
        if (result?.status === 'pending_confirmation') {
          await adapter.sendMessage(incoming.channelId, { text: result.message, format: 'markdown' }, threadOpts)
          return
        }
        // Document outcomes reply per §Phase 0.1/3.3; 'skipped' stays quiet.
        if (result?.status === 'ingested' && result.kind === 'document') {
          await adapter.sendMessage(
            incoming.channelId,
            { text: buildDocumentFiledReply(result.fileName), format: 'markdown' },
            threadOpts,
          )
          return
        }
        if (result?.status === 'rejected' && result.reason === 'doc_too_large') {
          await adapter.sendMessage(
            incoming.channelId,
            {
              text: buildOversizeDocReply('https://app.sidan.ai', result.limitMb ?? 25, result.sizeMb ?? 0),
              format: 'markdown',
            },
            threadOpts,
          )
        }
      })
      .catch((err) => console.error('[slack] media→brain ingest failed:', err))
  }
  // Content blocks: everything except the AV files routed to the brain above
  // (documents ride BOTH paths — durable artifact + this turn's blocks).
  const contentBlockFiles = (incoming.files ?? []).filter((f) => !isAv(f.mimeType))
  if (contentBlockFiles.length) {
    const downloads = await Promise.all(
      contentBlockFiles.map(async (file) => {
        try {
          const resp = await fetch(file.url, {
            headers: { Authorization: `Bearer ${botToken}` },
          })
          if (!resp.ok) {
            console.error(`[slack] file download failed (${resp.status}): ${file.name}`)
            return null
          }
          const contentType = resp.headers.get('content-type') ?? ''
          if (contentType.includes('text/html') && !file.mimeType.includes('text/html')) {
            console.error(`[slack] file download returned HTML (missing files:read scope?): ${file.name}`)
            return null
          }
          const buf = Buffer.from(await resp.arrayBuffer())
          return { ...file, buffer: buf }
        } catch (err) {
          console.error(`[slack] failed to download file: ${file.name}`, err)
          return null
        }
      }),
    )

    const failedFiles = contentBlockFiles.filter((_, i) => !downloads[i])
    if (failedFiles.length > 0) {
      const names = failedFiles.map((f) => f.name).join(', ')
      userContentBlocks.push({
        type: 'text',
        text: `[The user attached ${failedFiles.length} file(s) (${names}) but they could not be downloaded. The Slack app may be missing the "files:read" OAuth scope. Ask the user to re-create their Slack app with the updated manifest from the assistant settings page.]`,
      })
    }

    for (const dl of downloads) {
      if (!dl) continue
      // Images + PDFs share the `inlineData` path — Gemini reads both natively.
      if (dl.mimeType.startsWith('image/') || dl.mimeType === 'application/pdf') {
        userContentBlocks.push({ type: 'image', mimeType: dl.mimeType, data: dl.buffer.toString('base64') })
      } else {
        const parsed = await parseFileContent(dl.buffer, dl.mimeType, dl.name)
        userContentBlocks.push({
          type: 'text',
          text: `<attached_file name="${dl.name}" type="${dl.mimeType}">\n${parsed.text}\n</attached_file>`,
        })
      }
    }
  }

  if (incoming.text.trim()) {
    userContentBlocks.unshift({ type: 'text', text: incoming.text })
  } else if (userContentBlocks.length === 0) {
    return
  }

  // ── Slack-specific: reactToMessage tool ──
  const extraTools = new Map(params.tools)
  const reactToMessage = buildTool({
    name: 'reactToMessage',
    description: 'React to the user\'s Slack message with an emoji. Use this for quick acknowledgements (thumbsup, eyes, heart, fire, etc.) when a full text reply isn\'t needed, or to add an emoji reaction alongside your text response. The emoji name should be a standard Slack emoji name without colons.',
    inputSchema: z.object({
      emoji: z.string().describe('Slack emoji name without colons, e.g. "thumbsup", "heart", "fire", "eyes", "100"'),
    }),
    isConcurrencySafe: true,
    isReadOnly: false,
    async execute(input) {
      if (!incoming.messageId) return { data: 'No message to react to', isError: true }
      try {
        await adapter.reactToMessage?.(incoming.channelId, incoming.messageId, input.emoji)
        return { data: `Reacted with :${input.emoji}:` }
      } catch {
        return { data: `Failed to react with :${input.emoji}:`, isError: true }
      }
    },
  })
  extraTools.set('reactToMessage', reactToMessage)

  // ── Slack-specific: tool status timeline ──
  type ToolEntry = { id: string; name: string; description?: string; done: boolean }
  const toolTimeline: ToolEntry[] = []
  let lastStatusUpdate = 0
  const STATUS_THROTTLE_MS = 1200

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

  async function updateToolStatus(): Promise<void> {
    const now = Date.now()
    if (now - lastStatusUpdate < STATUS_THROTTLE_MS) return
    lastStatusUpdate = now
    await adapter.sendStatus(incoming.channelId, formatToolStatus(), statusOpts).catch(() => {})
  }

  // ── Abort controller ──
  const abortController = new AbortController()
  params.activeAbortControllers.set(incoming.channelId, abortController)

  await processChannelMessage({
    backgroundModel: params.backgroundModel,
    userId: channelUserId,
    ownerId,
    assistant: { ...assistant, ownerUserId: ownerId },
    isIdentified,
    channelType: 'slack',
    channelId: incoming.channelId,
    actorChannelId: incoming.userId, // Slack user id (e.g. U0123) → X-Sidanclaw-Actor-Id
    messageText: incoming.text,
    userContentBlocks,
    // Raw paste for the large-paste intercept (Slack has no prefix wrapper).
    rawUserText: incoming.text ?? '',
    isGroupChat: incoming.isGroupChat,
    replyToMessageId: incoming.replyToMessageId ?? null,
    incomingChannelMessageId: incoming.messageId ?? null,
    modelAlias: assistant.slackModelAlias,
    adaptiveResearchEnabled: true,
    abortController,
    provider: params.provider,
    systemPrompt: params.systemPrompt,
    tools: extraTools,
    memoryStore: params.memoryStore,
    usageStore: params.usageStore,
    checkCreditBudget: params.checkCreditBudget,
    analytics: params.analytics,
    connectorStore: params.connectorStore,
    mcpSettingsStore: params.mcpSettingsStore,
    assistantConnectorStore: params.assistantConnectorStore,
    connectorGrantStore: params.connectorGrantStore,
    connectorInstanceStore: params.connectorInstanceStore,
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
    hooks: {
      async onProcessingStart() {
        await adapter.sendStatus(incoming.channelId, 'Thinking...', statusOpts).catch(() => {})
      },
      async onStatus(message) {
        await adapter.sendStatus(incoming.channelId, message, statusOpts).catch(() => {})
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
        params.pendingSlackConfirmations.set(incoming.channelId, {
          resolver,
          toolCallId: req.toolCallId,
        })
        const lines = req.displayLines && req.displayLines.length > 0
          ? req.displayLines
          : formatConfirmationInput(req.input)
        const inputSummary = lines.length > 0 ? '\n' + lines.join('\n') : ''
        const displayName = getToolDisplayName(req.toolName)
        const replyHint = req.allowPersistentApproval
          ? 'Reply: yes / no / always / never'
          : 'Reply: yes / no'
        await adapter.sendMessage(incoming.channelId, {
          text: `${displayName}${inputSummary}\n\n${replyHint}`,
        }, threadOpts)
      },
      async sendResponse(text, documents) {
        await adapter.clearStatus?.(incoming.channelId, { messageId: incoming.messageId })
        const finalText = text.replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
        // Capture the Slack `ts` so the pipeline stamps it onto the
        // assistant session_message row. The channel-id round-trip is
        // what lets `reaction_added` webhooks later route emoji
        // feedback to the correct turn via
        // `findSessionMessageByChannelId`. See corrections.md.
        let channelMessageId: string | undefined
        if (finalText || documents?.length) {
          channelMessageId = await adapter.sendMessage(
            incoming.channelId,
            { text: finalText, format: 'markdown', documents },
            threadOpts,
          )
        } else {
          // Loud-fail after query-loop's empty-response retries exhausted.
          // See telegram.ts comment + docs/architecture/engine/query-loop.md.
          channelMessageId = await adapter.sendMessage(
            incoming.channelId,
            { text: "I couldn't generate a reply — please rephrase or try again." },
            threadOpts,
          )
        }
        return { channelMessageId }
      },
      async onDowngraded(resetsAt) {
        const resetNote = resetsAt
          ? ` Resets ${new Date(resetsAt).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, weekday: 'short' })}.`
          : ''
        await adapter.sendMessage(incoming.channelId, {
          text: `Running on the standard model: usage limit reached.${resetNote} Buy extra usage or upgrade in workspace settings for full speed.`,
        }, threadOpts)
        return null
      },
      async sendError(err) {
        await adapter.sendMessage(incoming.channelId, {
          text: err.message.includes('usage limit')
            ? err.message
            : 'Something went wrong. Please try again.',
        }, threadOpts)
      },
      async onCleanup() {
        params.activeAbortControllers.delete(incoming.channelId)
        await adapter.clearStatus?.(incoming.channelId, { messageId: incoming.messageId })
      },
    },
  })
}
