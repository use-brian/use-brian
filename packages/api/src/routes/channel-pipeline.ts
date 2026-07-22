// REBRAND-CUTOVER: this file contains sidan.ai runtime values that must flip to usebrian.ai when DNS + Vercel domains + OAuth consoles + webhooks are cut over. Grep REBRAND-CUTOVER.
/**
 * Shared channel message processing pipeline.
 *
 * Eliminates the ~350 lines of duplicated processMessage logic across
 * WhatsApp, Telegram, and Slack routes. Each channel provides a thin
 * `ChannelHooks` implementation for channel-specific rendering (typing,
 * confirmations, response delivery, tool status).
 *
 * The pipeline handles: session creation → budget check → pattern extraction →
 * message persistence → history loading → memory context → system prompt →
 * pending messages → tool setup → MCP + skills → preflight → query loop →
 * cost tracking → memory nudge.
 *
 * See docs/architecture/channels/adapter-pattern.md.
 */

import {
  queryLoop, buildMemoryContext, createMemoryTools, createSessionStateTools,
  buildSessionStateBlock, runSessionStateDiff,
  synthesizeMissingToolResults,
  collectStream, calculateCost, runPreflight, buildPreflightPrompt,
  runMemoryNudge, sanitize as sanitizeAnalytics, createConfirmationResolver,
  classifyTopic, fetchEpisodicContext, filterToolsByCapabilities,
  modelToCompactionTier, SensitivityAccumulator, CompartmentAccumulator,
  buildWorkspaceFilesContext, AttachmentCollector,
  EvidenceAccumulator, matchesDisputedFigure, buildDisputeContextNote,
} from '@use-brian/core'
import type { FilesApi, OutboundAttachment } from '@use-brian/core'
import type { OutgoingDocument } from '@use-brian/channels'
import { parseFollowUps } from '@use-brian/shared'
import { runProactiveCompaction } from './proactive-compaction.js'
import { notifyBrainWriteIfMatch } from '../brain-stream/notify.js'
import { recordOverheadUsage } from './_overhead-usage.js'
import { composeRecoveryMessage } from './_recovery-message.js'
import { resolveReplyText } from './_reply-context.js'
import { buildFullSystemPrompt } from './_prompt-builder.js'
import { getEvolution as getWorkspaceMemoryEvolution } from '../db/workspace-memory-evolution-store.js'
import { getBrainEvolution } from '../db/workspace-brain-evolution-store.js'
import { resolvePresenceTimezone } from '../auth/client-timezone.js'
import type {
  ContentBlock, LLMProvider, Tool, MemoryStore, UsageStore,
  AnalyticsLogger, McpSettingsStore, KnowledgeStoreInterface, GDriveFilesStore,
  ConfirmationResolver, Message, TopicClassification, ClassifierRecentTurn,
  EpisodicStore, CapabilityStore, TokenUsage,
  SessionStateStore, SessionStateRecord,
} from '@use-brian/core'

import { mintActorMediaToken } from '../media-token.js'
import { findUserById } from '../db/users.js'
import {
  findOrCreateSession, addSessionMessage, setSessionMessageChannelId,
  getSessionMessages, updateSessionStatus, getPreferredChannel,
  getGroupChatContext, buildGroupChatContextPrompt, getSessionTopicLabels,
  markDowngradeNoticeSent, clearDowngradeNotice,
} from '../db/sessions.js'
import { resolveModel, wouldBudgetDowngradeAffectModel, chatTierBudget, BACKGROUND_MODEL } from '../model-resolution.js'
import type { ConnectorStore } from '../db/connector-store.js'
import type { AssistantConnectorStore } from '../db/assistant-connector-store.js'
import type { PendingMessageStore } from '../db/pending-message-store.js'
import type { SkillStore } from '../db/skill-store.js'
import { injectMcpTools } from '../mcp/inject.js'
import { createKnowledgeRepoWriter } from '../knowledge/repo-writer.js'
import { createDbKnowledgeStore } from '../db/knowledge-store.js'
import { createSyncCredentialProvider } from '../knowledge/sync-credentials.js'
import { buildBrowserEscalationPrompt, buildUnavailableCapabilitiesPrompt, injectSkills, checkUsageBudget } from './route-helpers.js'
import type { CreditBudgetGate } from './route-helpers.js'
import { getConnectorUserId, getWorkspacePurpose, getWorkspacePlan, resolveReadCeilingsSystem } from '../db/workspace-store.js'
import {
  buildChannelSessionKey,
  listPendingRecordingConfirmationsForSession,
} from '../db/pending-recording-confirmations-store.js'
import { buildPendingContext } from '../inter-assistant/pending-context.js'
import { billingPartyForAssistant } from '../billing-party.js'
import { promotePastedText, shouldPromotePaste } from '../files/paste-promotion.js'
import type { ArtifactPromoter } from '../files/artifact-promote.js'

/**
 * Per-turn memory index cap — see chat.ts for the rationale and
 * docs/architecture/context-engine/memory-system.md → "Index cap".
 * Kept in sync across every per-turn caller.
 */
const PER_TURN_INDEX_CAP = 60

/**
 * Per-turn cap for the `# Workspace Files` L1 block (Q3 / company-brain §10).
 * Mirror in `routes/chat.ts` — keep in sync.
 */
const PER_TURN_FILES_INDEX_CAP = 50

// ── Channel hooks ────────────────────────────────────────────────

/**
 * Channel-specific rendering callbacks. The pipeline calls these
 * at the appropriate points — channels implement them.
 *
 * All hooks are optional except `sendResponse` and `sendError`.
 * Missing hooks = no-op (e.g., WhatsApp has no tool status display).
 *
 * **Streaming vs final-only channels.** Two delivery models share this
 * interface:
 *  - **Final-only** (Telegram, Slack, WhatsApp): the pipeline buffers
 *    text into a single string and calls `sendResponse(fullText)` once
 *    on `turn_complete`. These channels leave `onTextDelta` /
 *    `onCitation` unimplemented.
 *  - **Streaming** (web SSE): every `text_delta` and `citation` event
 *    surfaces live via the corresponding hook. `sendResponse` is still
 *    called at `turn_complete` so the channel can perform any terminal
 *    bookkeeping (persist, emit `done`), but the streamed text is
 *    already on the wire — implementations typically no-op the text
 *    body and just emit the terminal marker.
 *
 * The pipeline calls both in order; channels opt in to whichever fits.
 */
export type ChannelHooks = {
  /** Called once before the query loop starts. Start typing indicators here. */
  onProcessingStart?(): Promise<void>

  /** Called on `status` events from the query loop (e.g., "Researching..."). */
  onStatus?(message: string): Promise<void>

  /**
   * Called on every `text_delta` event from the query loop. Streaming
   * channels (web SSE) emit each chunk as it arrives; final-only
   * channels (Telegram, Slack, WhatsApp) leave this unimplemented and
   * receive the accumulated text via `sendResponse` instead.
   */
  onTextDelta?(text: string): Promise<void>

  /**
   * Called on `citation` events. Streaming channels render these as
   * separate UI elements (web shows source chips). Final-only channels
   * either inline the citation into the text body (Slack does this in
   * `sendResponse`) or skip them entirely.
   *
   * `sources` shape mirrors what the query loop yields — typically an
   * array of `{ uri, title?, snippet? }`.
   */
  onCitation?(sources: unknown[]): Promise<void>

  /**
   * Called on `tool_start`. The pipeline emits this before
   * `onToolInput`; channels that show a tool timeline use this to
   * append a row in pending state.
   */
  onToolStart?(id: string, name: string): Promise<void>

  /** Called on `tool_input`. */
  onToolInput?(id: string, name: string, input: Record<string, unknown>): Promise<void>

  /** Called on `tool_result`. */
  onToolResult?(results: ContentBlock[]): Promise<void>

  /**
   * Called immediately after the inbound user message is persisted to
   * `session_messages`. Streaming channels use this to surface the
   * DB-assigned id to the client so it can attach feedback / edit /
   * retry actions to that specific user turn (the web chat panel reads
   * `id` from this event). Final-only channels (Telegram, Slack,
   * WhatsApp) typically don't need this — actions on individual user
   * messages aren't part of their UI affordance.
   *
   * `sequenceNum` and `content` are included so collaborative-session
   * channels (web draft sessions) can publish a `user_message_saved`
   * draft-bus event with everything peer viewers need to render the
   * new turn without re-querying.
   */
  onUserMessageSaved?(message: {
    id: string
    sequenceNum: number
    content: ContentBlock[]
  }): Promise<void>

  /**
   * Called once per assistant message persisted by `flushBufferedTurns`.
   * Same use case as `onUserMessageSaved`: streaming channels surface
   * the DB id so the client can attach actions (regenerate, copy,
   * thumbs-up). Multi-turn loops (tool_use → tool_result → assistant
   * text) fire this once per buffered assistant turn that gets flushed.
   *
   * Includes `sequenceNum` + `content` for the same reason as
   * `onUserMessageSaved`.
   */
  onAssistantMessageSaved?(message: {
    id: string
    sequenceNum: number
    content: ContentBlock[]
  }): Promise<void>

  /**
   * Called on `tool_confirmation_required`. The channel must render the
   * confirmation prompt and stash the resolver so the route-level handler
   * can call resolver.resolve() when the user responds.
   *
   * `displayLines` carries human-readable prompt rows when the tool
   * pre-formatted them (e.g. `deleteMemory` resolves ids → summaries).
   * `allowPersistentApproval` is true only for MCP tools — built-in tools
   * should render Allow/Deny only.
   */
  onConfirmationRequired(
    request: {
      toolCallId: string
      toolName: string
      serverName: string
      input: Record<string, unknown>
      description: string
      displayLines?: string[]
      allowPersistentApproval?: boolean
    },
    resolver: ConfirmationResolver,
  ): Promise<void>

  /**
   * Deliver the final response text for one turn. Called on `turn_complete`.
   * `text` may be empty — the channel decides how to handle that
   * (e.g., react with thumbsup, or do nothing).
   *
   * `documents` carries outbound file attachments (`sendFile` tool) with
   * bytes already resolved from GCS — the channel forwards them on the
   * `OutgoingMessage` and the adapter delivers them after the text chunks.
   * Channels that can't deliver documents ignore the argument (the
   * `sendFile` tool already refused on those channels, so it stays empty).
   *
   * Channels that talk to messaging platforms (Slack, Telegram) MAY
   * return `{ channelMessageId }` — the platform-native id the
   * adapter received from its send call. The pipeline stamps it onto
   * the most-recently-persisted assistant `session_messages` row so
   * later reaction handlers can map a Slack reaction or Telegram
   * `message_reaction` update back to the assistant turn it
   * reacted to. Channels that don't have a stable platform id
   * (web streaming, scheduled-job executor) return `void`.
   */
  sendResponse(text: string, documents?: OutgoingDocument[]): Promise<{ channelMessageId?: string } | void>

  /**
   * Called the FIRST time a session observes the budget-downgraded state.
   * Subsequent downgrade turns are suppressed by the pipeline so the chat
   * isn't spammed. Return the channel-native message id of the pinned
   * notice (Telegram) to persist for later unpin, or null when the channel
   * doesn't pin. See `onBudgetOk` for the matching clear-on-ok hook.
   */
  onDowngraded?(resetsAt: string | null): Promise<string | null>

  /**
   * Called when the budget has returned to ok AND this session previously
   * delivered a downgrade notice that now needs clearing. Receives the pin
   * message id persisted by `onDowngraded` so pinning channels can unpin.
   * Channels that don't pin can ignore the argument.
   */
  onBudgetOk?(pinMessageId: string | null): Promise<void>

  /** Called on `error` events from the query loop or budget-blocked. */
  sendError(error: Error): Promise<void>

  /**
   * Called once in the `finally` block. Clean up typing indicators,
   * status messages, abort controller registrations, etc.
   */
  onCleanup?(): Promise<void>
}

// ── Pipeline params ──────────────────────────────────────────────

export type ChannelPipelineParams = {
  /**
   * Background-lane model, resolved once at boot against the configured
   * providers. Omitted = fall back to the literal, which is only servable
   * where a Google credential exists.
   */
  backgroundModel?: string
  // ── Identity ──
  /** The user whose session this is (channel user or owner). */
  userId: string
  /** The assistant owner (pays for usage). */
  ownerId: string
  /** The assistant record. */
  assistant: {
    id: string
    name: string
    ownerUserId: string
    workspaceId: string | null
    /** Layer 2 custom instructions set by the assistant owner. */
    systemPrompt: string | null
    /** Max sensitivity this assistant is allowed to read. See sensitivity.md. */
    clearance: 'public' | 'internal' | 'confidential'
    /**
     * Compartment grant (MLS category axis). NULL/absent = universe. Optional
     * because BYO-channel loaders (slack/telegram-byo/whatsapp) don't yet
     * select it — those turns default to universe until their loaders carry it
     * (web chat / public API / REST / brain explorer already enforce). See
     * docs/plans/compartment-axis.md.
     */
    compartments?: string[] | null
    /** Auto-stamp compartments on writes this assistant authors (⊆ compartments). */
    defaultCompartments?: string[]
    /** Drives the primary widen in the universal access predicate. */
    kind: 'primary' | 'standard' | 'app'
  }
  /**
   * Whether the channel user is identified (linked account or matched email).
   * Controls pattern extraction and memory context.
   * WhatsApp/Web always true; Telegram/Slack may be false for shadow users.
   */
  isIdentified: boolean
  checkCreditBudget?: CreditBudgetGate

  // ── Channel context ──
  channelType: 'whatsapp' | 'telegram' | 'slack' | 'discord' | 'email' | 'msteams' | 'wechat'
  channelId: string
  /**
   * The acting user's channel-native id captured from the inbound webhook —
   * WhatsApp phone, Telegram `@handle`, Slack user id. Forwarded to
   * `injectMcpTools` as the `X-Sidanclaw-Actor-Id` for opted-in connectors.
   * Optional: absent (or a Telegram user with no @username) ⇒ no native id is
   * sent (channel + email + userId still are). See tool-hooks.md.
   */
  actorChannelId?: string | null
  /**
   * Pin the per-turn media token to a specific recording episode. Set by the
   * WhatsApp video auto-turn to the episode it fired for, so media-fetching
   * connectors (e.g. the highlights MCP) act on THAT video rather than the
   * user's latest. Absent (interactive chat, non-video turns) ⇒ latest.
   */
  mediaEpisodeId?: string | null
  /** The incoming message text (used for pattern extraction & preflight). */
  messageText: string
  /**
   * Pre-built user content blocks. Channels that support file uploads
   * (Slack) build these before calling the pipeline.
   */
  userContentBlocks: ContentBlock[]
  /**
   * The adapter's raw inbound message text (`incoming.text`) BEFORE any
   * attachment-context prefix or voice-transcript wrapper was prepended.
   * When present, over the paste-promotion threshold, and `artifactPromoter`
   * is wired, the pipeline promotes it to a durable workspace_files artifact
   * and rewrites `messageText` + `userContentBlocks` to carry the manifest +
   * head excerpt instead of the blob. Absent (or below threshold) ⇒ the turn
   * is untouched. See large-content-artifacts §Phase 3.2 +
   * use-brian/packages/api/src/files/paste-promotion.ts.
   */
  rawUserText?: string
  /** Whether this is a group chat (affects context assembly). */
  isGroupChat: boolean
  /**
   * Channel-native ID of the message the user is replying to, if any.
   * Telegram passes `reply_to_message.message_id`; Slack passes
   * `thread_ts`; WhatsApp passes the quoted message ID. The pipeline
   * resolves this to text via resolveReplyText().
   */
  replyToMessageId?: string | number | null
  /**
   * Raw channel payload — used by resolveReplyText for Telegram so it
   * can read `reply_to_message.text` directly without a DB lookup.
   */
  replyRaw?: unknown
  /**
   * Channel-native ID of THIS incoming message. Persisted on the user
   * row so future replies targeting this message can resolve back to
   * its text via channel_message_id lookup. Slack: `ts`; WhatsApp:
   * message id; Telegram: message_id.
   */
  incomingChannelMessageId?: string | number | null

  // ── Model ──
  /** The model alias string from the assistant record. */
  modelAlias: string | undefined
  /**
   * When true, runs an adaptive research-intent classifier on the incoming
   * message before resolving the model. If the classifier flags the message
   * as research-warranting AND the workspace plan permits the `research`
   * alias (paid tiers only), the model upgrades to research-tier and the
   * loop gets the research budget (100 turns / 100 tool calls). Skipped on
   * short messages, free plans, and when no message text is present.
   *
   * Channels (Telegram / Slack / WhatsApp) opt in here because they have no
   * manual toggle. The web chat route runs its own adaptive path in
   * `routes/chat.ts` against the same classifier.
   */
  adaptiveResearchEnabled?: boolean

  // ── Abort ──
  /** External abort controller — wired into the query loop context. */
  abortController: AbortController

  // ── Stores & services ──
  provider: LLMProvider
  systemPrompt: string
  tools: Map<string, Tool>
  memoryStore: MemoryStore
  usageStore?: UsageStore
  analytics?: AnalyticsLogger
  connectorStore?: ConnectorStore
  mcpSettingsStore?: McpSettingsStore
  assistantConnectorStore?: AssistantConnectorStore
  /** Stage 4 of the team-connector promotion: enables team-exposure grant consumption. */
  connectorGrantStore?: import('../db/connector-grant-store.js').ConnectorGrantStore
  /** Stage 5: enables team-native connector_instance consumption. */
  connectorInstanceStore?: import('../db/connector-instance-store.js').ConnectorInstanceStore
  workspaceToolPolicyStore?: import('../db/workspace-tool-policy-store.js').WorkspaceToolPolicyStore
  knowledgeStore?: KnowledgeStoreInterface
  gdriveFilesStore?: GDriveFilesStore
  /** Workspace files store (Q3 §10). When set + the assistant has the
   *  `files` capability + `assistant.workspaceId` is bound, the
   *  `# Workspace Files` L1 block is injected. Optional. */
  workspaceFilesStore?: import('@use-brian/core').WorkspaceFilesStore
  /** Files orchestration API. When set, the pipeline wires a per-turn
   *  `AttachmentCollector` into the tool context (enabling `sendFile`) and
   *  resolves collected attachments to bytes (`readBytes`) at
   *  `turn_complete` for document delivery. Absent (dev without a blob
   *  client) → `sendFile` errors honestly on its missing-collector gate. */
  filesApi?: FilesApi
  /**
   * Promotes an over-threshold paste to a durable workspace_files artifact
   * (large-content-artifacts §Phase 3.2, decision D6). Wired once at boot from
   * the channel route options. Absent/null ⇒ pastes pass through untouched.
   * See use-brian/packages/api/src/files/artifact-promote.ts.
   */
  artifactPromoter?: ArtifactPromoter | null
  skillStore?: SkillStore
  pendingMessageStore?: PendingMessageStore
  workerManager?: import('@use-brian/core').WorkerManager
  episodicStore?: EpisodicStore
  sessionStateStore?: SessionStateStore
  capabilityStore: CapabilityStore

  // ── Channel hooks ──
  hooks: ChannelHooks

  /**
   * Mutable ref populated by the pipeline after session creation.
   * Channels that need the session ID in hooks (e.g., WhatsApp confirmation
   * store) pass an empty object and read `.id` after the pipeline fills it.
   */
  sessionRef?: { id?: string }

  /**
   * Per-message author for collaborative `mode='draft'` sessions.
   * Stamped on both the user message and any assistant messages
   * persisted from this turn so peer viewers in the team's draft
   * session see "alice asked, bob refined" style attribution.
   * Other channels (and personal sessions) leave this null. See
   * `docs/architecture/feed/draft-sessions.md`.
   */
  senderUserId?: string | null

  /**
   * Voice-transcription result that ran BEFORE the pipeline (channels
   * transcribe up-front so the transcript is part of `messageText`).
   * Usage is recorded here as `overhead:transcription` once we have a
   * stored user_message_id.
   */
  voiceTranscriptionUsage?: {
    usage: TokenUsage | null
    model: string
    /** Duration of the voice note, when the channel handler measured it. */
    audioSeconds?: number
  } | null
}

// ── Large-paste intercept ────────────────────────────────────────

/**
 * Central large-paste promotion (large-content-artifacts §Phase 3.2, decision
 * D6). A giant text paste arriving over any messaging channel is promoted to a
 * durable workspace_files artifact; the returned `messageText` +
 * `userContentBlocks` carry the manifest + head excerpt in place of the blob,
 * so neither the persisted user turn nor the LLM input inlines the raw content.
 *
 * Returns the inputs untouched (a paste is never lost) when there is no
 * `rawUserText`, no promoter, no workspace, the paste is below the token
 * threshold, promotion fails, or `rawUserText` is not the literal tail of
 * `messageText` (a shape we can't splice — the adapter prefixed a voice
 * transcript or edit wrapper). The rebuilt `userContentBlocks` reaches BOTH
 * the stored row and the LLM turn because the pipeline re-reads the persisted
 * user message from the DB before the query loop.
 *
 * Tagged `[COMP:api/channel-paste-promotion]`.
 */
export async function promoteChannelPaste(input: {
  rawUserText: string | undefined
  messageText: string
  userContentBlocks: ContentBlock[]
  workspaceId: string | null
  actingUserId: string
  assistantId: string
  artifactPromoter: ArtifactPromoter | null | undefined
  channelType: string
}): Promise<{ messageText: string; userContentBlocks: ContentBlock[] }> {
  const { rawUserText, messageText, userContentBlocks, workspaceId, artifactPromoter } = input
  if (!rawUserText || !artifactPromoter || !workspaceId || !shouldPromotePaste(rawUserText)) {
    return { messageText, userContentBlocks }
  }
  if (!messageText.endsWith(rawUserText)) {
    console.warn(
      `[${input.channelType}] paste-promotion: message text does not end with the raw paste; keeping original`,
    )
    return { messageText, userContentBlocks }
  }
  try {
    const promoted = await promotePastedText({
      text: rawUserText,
      workspaceId,
      actingUserId: input.actingUserId,
      assistantId: input.assistantId,
      promote: artifactPromoter,
    })
    if (!promoted) return { messageText, userContentBlocks }
    const splice = (s: string): string => s.slice(0, s.length - rawUserText.length) + promoted.replaced
    return {
      messageText: splice(messageText),
      userContentBlocks: userContentBlocks.map((block) =>
        block.type === 'text' && block.text.endsWith(rawUserText)
          ? { ...block, text: splice(block.text) }
          : block,
      ),
    }
  } catch (err) {
    console.error(`[${input.channelType}] paste-promotion failed (keeping original):`, err)
    return { messageText, userContentBlocks }
  }
}

/**
 * Assemble the outbound channel message from the buffered assistant turns.
 *
 * TERMINAL TURNS ONLY, and never a sum of `text_delta` chunks. Two incidents
 * sit behind each half:
 *
 *  1. A turn carrying a `tool_use` block is mid-reasoning — the loop feeds the
 *     result back and the model speaks again — so text riding alongside a call
 *     is narration, never the answer. Delta-summing concatenated it into the
 *     reply; on the scheduled-job twin of this path that shipped a model's
 *     entire chain-of-thought, its own tool list included, to a user's Telegram
 *     (2026-07-20, session `b8e567d6` — a job whose instructions named tools its
 *     assistant held no connector grant for, so the model narrated the hunt for
 *     them). `sanitizeDeliveryText` cannot cover this
 *     class — it matches known scaffolding phrasings and free-form reasoning has
 *     none; the signal that identifies it is structural, not lexical.
 *  2. Deltas stream BEFORE the turn-boundary instruction-leak sanitiser rewrites
 *     `response.content`, so a suppressed turn's text shipped anyway. Reading
 *     the buffered content means a suppressed turn contributes nothing,
 *     structurally rather than by downstream heuristics.
 *
 * Takes the turns already sliced to the delivery window: the grounding gate
 * retracts a draft the query loop had ALREADY yielded as an `assistant_turn`
 * (Phase 3b runs before the gate), so the caller cuts those turns off rather
 * than letting retracted unverified figures back into the message.
 *
 * Reads `content` at call time on purpose — the gate's post-nudge trailer
 * mutates the final text block IN PLACE after the turn was yielded, and an
 * eagerly-copied string would drop it.
 *
 * Mirrors `inter-assistant/executor.ts`. Spec:
 * docs/architecture/channels/inter-assistant.md → "Final-text assembly".
 */
export function assembleDeliverableText(turns: { content: ContentBlock[] }[]): string {
  return turns
    .filter((t) => !t.content.some((b) => b.type === 'tool_use'))
    .flatMap((t) => t.content)
    .filter((b): b is ContentBlock & { type: 'text'; text: string } =>
      b.type === 'text' && 'text' in b && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

// ── Pipeline ─────────────────────────────────────────────────────

export async function processChannelMessage(params: ChannelPipelineParams): Promise<void> {
  const {
    userId, ownerId, assistant, isIdentified,
    channelType, channelId, actorChannelId, mediaEpisodeId, isGroupChat,
    modelAlias, adaptiveResearchEnabled, abortController,
    provider, systemPrompt, tools, memoryStore, usageStore,
    analytics, connectorStore, mcpSettingsStore, assistantConnectorStore, connectorGrantStore, connectorInstanceStore, workspaceToolPolicyStore,
    knowledgeStore, gdriveFilesStore, skillStore, pendingMessageStore, workerManager,
    episodicStore, sessionStateStore, workspaceFilesStore, filesApi,
    replyToMessageId, replyRaw, incomingChannelMessageId,
    voiceTranscriptionUsage,
    senderUserId,
    hooks,
    capabilityStore,
  } = params

  // Every background call in this pipeline (session-state diff, memory nudge,
  // research classifier) runs on this one id. Boot resolves it against the
  // configured providers; the literal is the fallback for callers without
  // boot context.
  const laneModel = params.backgroundModel ?? BACKGROUND_MODEL

  // `messageText` + `userContentBlocks` are `let` — the large-paste intercept
  // below may rewrite them to a manifest + head excerpt before anything reads
  // them (classifier, persist, query loop).
  let messageText = params.messageText
  let userContentBlocks = params.userContentBlocks

  // ── Session ──
  const session = await findOrCreateSession({
    assistantId: assistant.id,
    userId,
    channelType,
    channelId,
  })

  // Expose session ID to channel hooks (e.g., WhatsApp confirmation store)
  if (params.sessionRef) params.sessionRef.id = session.id

  // ── Budget gate — billing party pays ──
  // Post-089: billingPartyForAssistant is the single source of truth
  // for the paying user (team owner for team assistants, personal owner
  // otherwise). `ownerId` is retained for non-billing concerns (memory
  // attribution, session ownership). See
  // docs/architecture/integrations/mcp.md.
  const billingUserId = await billingPartyForAssistant({
    id: assistant.id,
    ownerUserId: assistant.workspaceId ? null : ownerId,
    workspaceId: assistant.workspaceId ?? null,
  })
  let budgetStatus: 'ok' | 'downgraded' | 'blocked' = 'ok'
  // Billing is per-workspace (migration 143) — the plan + budget windows
  // are the assistant's workspace's.
  const workspacePlan = assistant.workspaceId
    ? await getWorkspacePlan(assistant.workspaceId)
    : 'free'
  if (usageStore && assistant.workspaceId) {
    const gate = await checkUsageBudget(assistant.workspaceId, workspacePlan, params.checkCreditBudget)
    budgetStatus = gate.status
    if (gate.status === 'blocked') {
      await hooks.sendError(new Error('This workspace has no active Use Brian plan. The workspace owner can pick a plan at sidan.ai/plans, or self-host the open-source version.'))
      return
    }
    if (
      gate.status === 'downgraded'
      && !session.downgradeNoticeSent
      && wouldBudgetDowngradeAffectModel(modelAlias, workspacePlan)
    ) {
      const pinMessageId = (await hooks.onDowngraded?.(gate.resetsAt)) ?? null
      await markDowngradeNoticeSent(session.id, pinMessageId)
    } else if (gate.status === 'ok' && session.downgradeNoticeSent) {
      await hooks.onBudgetOk?.(session.downgradeNoticePinMessageId)
      await clearDowngradeNotice(session.id)
    }
  }
  // ── Large-paste promotion (large-content-artifacts §Phase 3.2) ──
  // Runs before the message is classified, persisted, or fed to the model, so
  // a giant paste never reaches the classifier or the query loop as a blob.
  // Failure keeps the original text. See `promoteChannelPaste` above.
  ;({ messageText, userContentBlocks } = await promoteChannelPaste({
    rawUserText: params.rawUserText,
    messageText,
    userContentBlocks,
    workspaceId: assistant.workspaceId,
    actingUserId: userId,
    assistantId: assistant.id,
    artifactPromoter: params.artifactPromoter,
    channelType,
  }))

  // Adaptive research entry — channels have no manual toggle, so when the
  // caller opts in we classify the message and upgrade the alias to
  // `research` (paid plans only). The downstream `resolveModel` honors plan
  // gating: free plans never reach research-tier regardless of classifier.
  //
  // Classifier overhead (~50 in / 20 out tokens via Flash Lite) is
  // currently unattributed for channels — the chat route attributes the
  // same call via `recordOverheadUsage`; channel cost-tracking is a
  // follow-up.
  let effectiveModelAlias = modelAlias
  let adaptiveResearchActive = false
  if (
    adaptiveResearchEnabled &&
    messageText &&
    assistant.workspaceId &&
    workspacePlan !== 'free' &&
    budgetStatus !== 'downgraded'
  ) {
    try {
      const { classifyResearchIntent } = await import('@use-brian/core')
      const adaptive = await classifyResearchIntent({ provider, message: messageText, model: laneModel })
      if (adaptive.research) {
        effectiveModelAlias = 'research'
        adaptiveResearchActive = true
      }
    } catch (err) {
      console.warn(`[${channelType}] adaptive-research classifier failed:`, err)
    }
  }
  const model = resolveModel(effectiveModelAlias, workspacePlan, budgetStatus)
  // Tier budget (chat-route parity) — research mode gets 100/100. Other
  // tiers inherit the queryLoop defaults via `null`.
  const tierBudget = chatTierBudget({ model, researchMode: adaptiveResearchActive })

  // v2 (brain_extraction_v2_enabled): per-turn regex pattern extraction
  // retired. Channel-side facts (Slack / Telegram / WhatsApp) now land
  // via the chat-compaction Episode → Pipeline B path, which produces
  // structured entities / tasks / memories with proper authorship +
  // justification. See Q9 of the design thread + the `chatEpisodeIngestor`
  // wiring in apps/api/src/index.ts.

  // ── Reply resolution + topic classification (runs BEFORE persist so
  //    the incoming user message row carries the topic label and reply
  //    text). See docs/architecture/context-engine/compaction.md.
  const channelUser = await findUserById(userId)
  const anchorTimezone = channelUser?.timezone ?? 'UTC'
  // Slack/WhatsApp/etc. have no live tz header. Inherit presence from
  // the most recent fresh web observation; fall back to anchor when
  // the user has never used web chat or the observation is stale.
  const userTimezone = resolvePresenceTimezone({
    lastSeenTz: channelUser?.lastSeenTz,
    lastSeenTzAt: channelUser?.lastSeenTzAt,
    anchorTimezone,
  })

  const replyResolved = await resolveReplyText({
    channelType,
    replyToMessageId: replyToMessageId ?? null,
    session,
    raw: replyRaw,
  })

  const preExistingDbMessages = await getSessionMessages(session.id)
  const recentUserTurns: ClassifierRecentTurn[] = preExistingDbMessages
    .filter((m) => m.role === 'user' && Array.isArray(m.content))
    .slice(-8)
    .map((m) => {
      const blocks = m.content as Array<{ type?: string; text?: string }>
      const text = blocks
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join(' ')
        .trim()
      return { text, topicLabel: m.topicLabel }
    })
    .filter((t) => t.text.length > 0)

  const knownTopics = await getSessionTopicLabels(session.id, 20)

  let classification: TopicClassification | null = null
  try {
    classification = await classifyTopic({
      provider,
      model: 'gemini-flash',
      recentUserTurns,
      replyToText: replyResolved?.text ?? null,
      currentMessage: messageText,
      knownTopicsThisSession: knownTopics,
    })
  } catch (err) {
    console.error(`[${channelType}] topic classifier failed:`, err)
  }

  // ── Persist inbound message (with topic label + reply context) ──
  const userMessageRow = await addSessionMessage({
    sessionId: session.id,
    role: 'user',
    content: userContentBlocks,
    replyToText: replyResolved?.text ?? null,
    topicLabel: classification?.topic_label ?? null,
    topicConfidence: classification?.confidence ?? null,
    channelMessageId:
      incomingChannelMessageId !== undefined && incomingChannelMessageId !== null
        ? String(incomingChannelMessageId)
        : null,
    // Per-message author for collaborative draft sessions. Other
    // channels and personal sessions pass null/undefined.
    senderUserId: senderUserId ?? null,
  })

  // Surface the persisted user-message row to streaming channels so
  // the client can attach feedback / edit / retry actions to it, and
  // collaborative-session channels can mirror the new turn to peer
  // viewers via their draft-bus. Final-only channels leave this
  // unimplemented.
  await hooks.onUserMessageSaved?.({
    id: userMessageRow.id,
    sequenceNum: userMessageRow.sequenceNum,
    content: userContentBlocks,
  })

  // Attribute classifier tokens as overhead against the owner (the
  // billing entity — channel users don't pay for auxiliary LLM calls).
  // See docs/architecture/channels/channel-user-identity.md → "Billing split".
  await recordOverheadUsage({
    usageStore,
    userId: ownerId,
    assistantId: assistant.id,
    sessionId: session.id,
    userMessageId: userMessageRow.id,
    model: classification?.model ?? null,
    usage: classification?.usage,
    source: 'overhead:classifier',
  })

  // Voice transcription ran in the channel handler before the pipeline —
  // usage is attributed here so it lands alongside the classifier row.
  if (voiceTranscriptionUsage) {
    await recordOverheadUsage({
      usageStore,
      userId: ownerId,
      assistantId: assistant.id,
      sessionId: session.id,
      userMessageId: userMessageRow.id,
      model: voiceTranscriptionUsage.model,
      usage: voiceTranscriptionUsage.usage,
      source: 'overhead:transcription',
      // Distinguishes an inbound voice message from a recording upload:
      // both are `overhead:transcription`, but they have different volumes,
      // different latency budgets, and would migrate to a new provider
      // independently.
      triggerKey: 'voice_message_transcription',
      ...(voiceTranscriptionUsage.audioSeconds !== undefined
        ? { audioSeconds: voiceTranscriptionUsage.audioSeconds }
        : {}),
    })
  }

  // ── Load history ──
  // `fromSequence` skips rows already compacted into the most recent
  // boundary; null (never compacted) loads full history.
  const dbMessages = await getSessionMessages(session.id, {
    fromSequence: session.compactBoundarySequence,
  })

  // ── Proactive compaction (messaging: 0.5× threshold + multi-topic profile) ──
  // runProactiveCompaction owns stamping + tool-result pairing + summary
  // prepending internally. See docs/architecture/context-engine/compaction.md.
  const compactionResult = await runProactiveCompaction({
    sessionMessages: dbMessages,
    timezone: userTimezone,
    session,
    tier: modelToCompactionTier(model),
    channelClass: 'messaging',
    profile: 'multi-topic',
    provider,
    systemPrompt,
    assistantId: assistant.id,
    userId,
    ownerId,
    channelType,
    memoryStore,
    episodicStore,
    sessionStateStore,
    analytics,
    usageStore,
    userMessageId: userMessageRow.id,
  })
  let messages: Message[] = compactionResult.messages

  // ── Sensitivity accumulator (per-turn) ──
  // Tracks max sensitivity of every memory / KB / episodic row the model
  // sees in this turn. Fed into ToolContext so saveMemory / addKnowledgeEntry
  // stamp new rows with the correct tier (no silent downgrade).
  const sensitivityAccumulator = new SensitivityAccumulator()
  const compartmentAccumulator = new CompartmentAccumulator()
  // Read-side clearance (incident 2026-06-01): the READ ceiling is the acting
  // channel user's clearance bounded by the assistant's. Channel participants
  // with no `workspace_members` row (shadow users) resolve to `public` — most
  // restrictive. Writes keep the assistant's clearance (`assistantClearance`
  // on the ToolContext below).
  const { clearance, compartments } = await resolveReadCeilingsSystem(
    userId,
    assistant.workspaceId,
    assistant.clearance,
    assistant.compartments ?? null,
  )

  // ── Memory context (identified users only) ──
  // Per-turn callers use the ranked+capped index slice. See
  // docs/architecture/context-engine/memory-system.md → "Index cap".
  let memoryContext = ''
  if (isIdentified) {
    const viewerCtx = {
      workspaceId: assistant.workspaceId ?? '',
      userId,
      assistantId: assistant.id,
      assistantKind: assistant.kind,
      clearance,
      compartments,
    }
    const [soul, identityMemories, rankedIndex] = await Promise.all([
      memoryStore.getSoul(assistant.id, userId, 'Use Brian'),
      memoryStore.getIdentity(viewerCtx),
      memoryStore.getIndexRanked(viewerCtx, PER_TURN_INDEX_CAP),
    ])
    for (const m of identityMemories) sensitivityAccumulator.note(m.sensitivity)
    for (const r of rankedIndex.rows) sensitivityAccumulator.note(r.sensitivity)
    let workspaceIdentityMems: typeof identityMemories = []
    let workspaceIdx: Awaited<ReturnType<typeof memoryStore.getWorkspaceIndex>> = []
    let teamPurpose: string | null = null
    if (assistant.workspaceId) {
      ;[workspaceIdentityMems, workspaceIdx, teamPurpose] = await Promise.all([
        memoryStore.getWorkspaceIdentity(viewerCtx),
        memoryStore.getWorkspaceIndex(viewerCtx),
        getWorkspacePurpose(assistant.workspaceId),
      ])
      for (const m of workspaceIdentityMems) sensitivityAccumulator.note(m.sensitivity)
      for (const r of workspaceIdx) sensitivityAccumulator.note(r.sensitivity)
    }
    memoryContext = buildMemoryContext({
      soul,
      identityMemories: identityMemories.map((m) => ({ id: m.id, summary: m.summary, detail: m.detail })),
      memoryIndex: rankedIndex.rows.map((m) => ({ ...m, appId: null })),
      totalNonIdentityCount: rankedIndex.totalCount,
      workspaceIdentityMemories: workspaceIdentityMems.map((m) => ({ id: m.id, summary: m.summary, detail: m.detail })),
      teamMemoryIndex: workspaceIdx.map((m) => ({ ...m, appId: null })),
      teamPurpose,
      assistantName: assistant.name,
    })
  }
  const preferredChannel = await getPreferredChannel(assistant.id, userId)

  // ── Group chat context ──
  let groupChatContext = ''
  if (isGroupChat) {
    const channelMessages = await getGroupChatContext({
      assistantId: assistant.id,
      channelType,
      channelId,
    })
    groupChatContext = buildGroupChatContextPrompt(channelMessages, userId)
  }

  // ── Episodic context (topic-scoped history for resume/cross-topic) ──
  let episodicContext: string | null = null
  if (episodicStore && classification) {
    try {
      episodicContext = await fetchEpisodicContext({
        store: episodicStore,
        sessionId: session.id,
        classification,
      })
    } catch (err) {
      console.error(`[${channelType}] episodic context fetch failed:`, err)
    }
  }

  // ── Session-state block (# Open commitments — always on) ──
  let sessionStateBlock: string | null = null
  if (sessionStateStore) {
    try {
      sessionStateBlock = await buildSessionStateBlock({
        store: sessionStateStore,
        sessionId: session.id,
      })
    } catch (err) {
      console.error(`[${channelType}] session-state block fetch failed:`, err)
    }
  }

  // ── Capability set (used twice — L1 files block + tool filter) ──
  const activeCapabilities = new Set(await capabilityStore.listActive(assistant.id))

  // ── Workspace files L1 block (Q3 / company-brain §10) ──
  // Built only when the store is wired AND the assistant has the `files`
  // capability AND a workspaceId. Skipped silently in dev / smoke without
  // GCS (workspaceFilesStore absent).
  let workspaceFilesContext: string | null = null
  if (
    workspaceFilesStore &&
    assistant.workspaceId &&
    isIdentified &&
    activeCapabilities.has('files')
  ) {
    try {
      const rows = await workspaceFilesStore.listIndexRanked(
        {
          workspaceId: assistant.workspaceId,
          userId,
          assistantId: assistant.id,
          assistantKind: assistant.kind,
          // Read ceiling = min(member, assistant) — see `clearance` above.
          clearance,
          compartments,
        },
        PER_TURN_FILES_INDEX_CAP,
      )
      workspaceFilesContext = buildWorkspaceFilesContext(rows)
    } catch (err) {
      console.error(`[${channelType}] workspace-files index fetch failed:`, err)
    }
  }

  // ── System prompt assembly (shared builder) ──
  const currentDateTime = new Date().toLocaleString('en-US', {
    timeZone: userTimezone,
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true, timeZoneName: 'short',
  })
  // Workspace-level prompt-evolution snippet. Same wiring as chat.ts —
  // see docs/architecture/brain/corrections.md → "Workspace-level
  // prompt evolution".
  let workspaceEvolutionSnippet: string | null = null
  if (assistant.workspaceId) {
    try {
      // Memory-side + brain-side evolution snippets join into one Layer 2 block.
      const [memoryEvo, brainEvo] = await Promise.all([
        getWorkspaceMemoryEvolution(assistant.workspaceId),
        getBrainEvolution(assistant.workspaceId),
      ])
      const parts = [memoryEvo?.promptSnippet, brainEvo?.promptSnippet].filter(
        (s): s is string => typeof s === 'string' && s.length > 0,
      )
      workspaceEvolutionSnippet = parts.length > 0 ? parts.join('\n\n') : null
    } catch (err) {
      console.error(`[${channelType}] workspace evolution snippet fetch failed:`, err)
    }
  }

  let fullSystemPrompt = buildFullSystemPrompt({
    basePrompt: systemPrompt,
    assistantInstructions: assistant.systemPrompt,
    workspaceEvolutionSnippet,
    currentDateTime,
    timezone: userTimezone,
    anchorTimezone,
    memoryContext,
    workspaceFilesContext,
    sessionStateBlock,
    episodicContext,
    topicHint: classification,
    replyContext: replyResolved
      ? { text: replyResolved.text, fromAssistant: replyResolved.fromAssistant }
      : null,
    groupChatContext,
  })

  // ── Channel formatting hints ──
  if (channelType === 'whatsapp') {
    fullSystemPrompt += `\n\n# Formatting\nYou're on WhatsApp. Supported: *bold*, _italic_, ~strikethrough~, \`code\`, \`\`\`code blocks\`\`\`, > quotes, and lists. NOT supported: tables, headers (#), links ([text](url)). For comparisons, use bullet lists or numbered lists instead of tables.`
  }

  // ── Pending inter-assistant messages ──
  if (pendingMessageStore) {
    try {
      const pending = await buildPendingContext(pendingMessageStore, ownerId, assistant.id, channelType)
      fullSystemPrompt += pending.promptFragment
    } catch (err) {
      console.error(`[${channelType}] pending message delivery failed:`, err)
    }
  }

  // ── Tools: capability filter + memory ──
  const { saveMemory, getMemory, deleteMemory } = createMemoryTools(memoryStore, {
    userPlan: workspacePlan,
    onEvent: (evt) => {
      if (evt.type === 'memory_deleted') {
        analytics?.logEvent({
          userId, assistantId: assistant.id, sessionId: session.id,
          eventName: 'memory_deleted', channelType,
          metadata: { memory_id: sanitizeAnalytics(evt.memoryId) },
        })
      }
    },
  })
  // activeCapabilities was lifted up above the L1 prompt build (used by both
  // the `# Workspace Files` block gating and the tool filter here).
  const allTools = filterToolsByCapabilities(new Map(tools), activeCapabilities)
  allTools.set('saveMemory', saveMemory)
  allTools.set('getMemory', getMemory)
  allTools.set('deleteMemory', deleteMemory)

  // Tasks (Q1) + CRM (Q2) are constructed at boot in apps/api/src/index.ts
  // and arrive via `tools`. Per-assistant visibility is gated by §17
  // capability grants ('tasks' / 'crm') applied above by
  // filterToolsByCapabilities — no per-turn injection here.

  if (sessionStateStore) {
    const { trackCommitment, resolveCommitment } = createSessionStateTools(
      sessionStateStore,
      {
        onEvent: (evt) => {
          analytics?.logEvent({
            userId, assistantId: assistant.id, sessionId: session.id,
            eventName: evt.type, channelType,
            metadata:
              evt.type === 'session_state_upsert'
                ? { source: sanitizeAnalytics(evt.source), was_insert: evt.wasInsert, key: sanitizeAnalytics(evt.key) }
                : { source: sanitizeAnalytics(evt.source), hit: evt.hit, key: sanitizeAnalytics(evt.key) },
          })
        },
      },
    )
    allTools.set('trackCommitment', trackCommitment)
    allTools.set('resolveCommitment', resolveCommitment)
  }

  // ── MCP tools ──
  const connectorUserId = await getConnectorUserId(ownerId, assistant.workspaceId)
  let unavailableCapabilities: string[] = []
  if (connectorStore && mcpSettingsStore) {
    // Assistant KB repo writer — built per turn (pure closures, no I/O) over
    // the same closed credential resolution the sync worker uses. Channel
    // chats have a live Approve/Deny loop (`confirmationResolver` below), so
    // this surface qualifies for `allowKnowledgeWrites` (D2 — chat-only).
    const knowledgeRepoWriter = connectorInstanceStore && connectorGrantStore
      ? createKnowledgeRepoWriter({
          store: createDbKnowledgeStore(),
          syncCredentials: createSyncCredentialProvider(connectorInstanceStore, connectorGrantStore),
          recordEvent: ({ userId: eventUserId, eventName, metadata }) => {
            const safe: Record<string, number | boolean | undefined | ReturnType<typeof sanitizeAnalytics>> = {}
            for (const [k, v] of Object.entries(metadata)) {
              if (typeof v === 'number' || typeof v === 'boolean' || v === undefined) safe[k] = v
              else if (v === null) safe[k] = undefined
              else safe[k] = sanitizeAnalytics(String(v))
            }
            analytics?.logEvent({ userId: eventUserId, eventName, channelType, metadata: safe })
          },
        })
      : undefined
    try {
      const injection = await injectMcpTools({
        userId: connectorUserId,
        assistantId: assistant.id,
        tools: allTools,
        connectorStore,
        settingsStore: mcpSettingsStore,
        assistantConnectorStore,
        userTimezone: channelUser?.timezone ?? undefined,
        knowledgeStore,
        knowledgeRepoWriter,
        allowKnowledgeWrites: true,
        gdriveFilesStore,
        connectorGrantStore,
        connectorInstanceStore,
        workspaceToolPolicyStore,
        assistantTeamId: assistant.workspaceId ?? null,
        // Workspace-files byte layer — `gmailSendMessage` attachments on
        // channel turns (docs/architecture/integrations/gmail.md).
        filesApi,
        // Actor identity for opted-in connectors. `actorChannelId` is the
        // channel-native id captured from the inbound webhook by the channel
        // route (Slack user id / Telegram @handle / WhatsApp phone); email +
        // userId come from the resolved channel user. Server-resolved, never
        // model output. See docs/architecture/engine/tool-hooks.md.
        actorIdentity: {
          channel: channelType,
          id: actorChannelId ?? null,
          email: channelUser?.email ?? null,
          userId,
          // Short-lived, user-scoped media capability token. Emitted only to
          // connectors the user granted media access (`sendMediaToken`); lets
          // them fetch this user's latest recording via /internal/media without
          // any shared secret. The endpoint derives the user from the token's
          // signed `sub`. See packages/api-platform/src/media-token.ts.
          mediaToken: mintActorMediaToken({
            sub: userId,
            episodeId: mediaEpisodeId ?? undefined,
            ttlMs: 5 * 60_000,
          }) ?? undefined,
        },
      })
      unavailableCapabilities = injection.unavailable
    } catch (err) {
      console.error(`[${channelType}] MCP tool injection failed:`, err)
    }
  }

  // ── Skills ──
  if (skillStore) {
    const skillResult = await injectSkills({
      skillStore,
      connectorUserId,
      assistantId: assistant.id,
      // §5.5 governance gate: assistant clearance bounds which workspace
      // skills are offered for the turn.
      assistantClearance: assistant.clearance,
      tools: allTools,
      connectorStore,
      unavailableCapabilities,
      channel: channelType,
      // Scope skills to the assistant's workspace (not the owner's personal
      // workspace) — see injectSkills / incident 2026-06-01.
      workspaceId: assistant.workspaceId ?? undefined,
    })
    fullSystemPrompt += skillResult.promptFragment
  }
  fullSystemPrompt += buildUnavailableCapabilitiesPrompt(unavailableCapabilities)
  fullSystemPrompt += buildBrowserEscalationPrompt(allTools)

  // ── Pre-flight-confirm reply correlation (channel-recording-preflight-confirm §6) ──
  // If a big recording in THIS conversation is awaiting the user's confirmation,
  // inject a context note so the model can interpret the reply and call
  // `confirmRecordingProcessing` with the right recordingId. The note carries the
  // file label, duration, credit cost, and the default blueprint id so the model
  // can map "yes / the default" to the right choice. Per-turn dynamic injection —
  // not in Layer 1 (the tool name only appears here, when a pending row exists).
  {
    try {
      const channelSessionKey = buildChannelSessionKey({ channel: channelType, channelId, userId })
      const pendingRecordings = await listPendingRecordingConfirmationsForSession(channelSessionKey)
      if (pendingRecordings.length > 0) {
        const lines = pendingRecordings.map((p) => {
          const mins = Math.max(1, Math.ceil(p.durationSeconds / 60))
          const labelPart = p.fileLabel ? ` ("${p.fileLabel}")` : ''
          const creditWord = p.surchargeCredits === 1 ? 'credit' : 'credits'
          const defaultPart = p.defaultBlueprintSlug
            ? ` Default blueprint id (use this if the user says "yes" or "the default"): ${p.defaultBlueprintSlug}.`
            : ' No workspace default blueprint is set.'
          return `- recordingId: ${p.recordingId}${labelPart} — about ${mins} min, costs ${p.surchargeCredits} ${creditWord} to process.${defaultPart}`
        })
        fullSystemPrompt +=
          `\n\n# Recording awaiting confirmation\n` +
          `The user dropped ${pendingRecordings.length === 1 ? 'a recording' : 'recordings'} that ${pendingRecordings.length === 1 ? 'is' : 'are'} held until they confirm processing (it would incur a credit surcharge). ` +
          `When the user replies about it, call \`confirmRecordingProcessing\` with the matching recordingId and their choice: a blueprint id to shape a brief, "ingest-only" to just file the transcript, or "cancel" to skip it.\n` +
          lines.join('\n')
      }
    } catch (err) {
      console.error(`[${channelType}] pending recording confirmation lookup failed:`, err)
    }
  }

  // ── Processing start ──
  await hooks.onProcessingStart?.()

  await updateSessionStatus(session.id, 'running')
  const confirmationResolver = createConfirmationResolver()

  // ── Outbound attachments (sendFile) ──
  // Only wired when filesApi is present — without it the pipeline could
  // collect intent it can never resolve to bytes, and `sendFile`'s
  // missing-collector gate gives the model an honest error instead.
  const attachmentCollector = filesApi ? new AttachmentCollector() : undefined

  // ── Tool-pairing buffer ──
  type PendingTurn = { content: ContentBlock[]; toolResults: ContentBlock[] }
  const pendingAssistantTurns: PendingTurn[] = []
  let flushed = false
  // Index of the first turn eligible for delivery — the outbound message is
  // built by `assembleDeliverableText` (see its doc comment for why terminal
  // turns, not deltas). `grounding_nudge` advances this past the retracted
  // draft: the query loop yields `assistant_turn` at Phase 3b BEFORE the gate
  // runs, so without the cut the unverified figures the gate just retracted
  // would sail straight back into the message.
  let deliveryCutIdx = 0
  // Track the most-recently-flushed assistant `session_messages` row id
  // so a `sendResponse` returning a channel-native message id (Slack
  // `ts`, Telegram `message_id`) can stamp it onto that row via
  // `setSessionMessageChannelId`. The channel-id round-trip is what
  // lets reaction-add webhooks later look up which assistant turn was
  // reacted to. See `hooks.sendResponse` doc comment + corrections.md.
  let lastFlushedAssistantRowId: string | null = null
  const flushBufferedTurns = async (reason: string, attachments?: OutboundAttachment[]) => {
    if (flushed) return
    flushed = true
    // Attachments (sendFile) belong to the final reply — the last turn
    // with content. Intermediate tool_use turns never carry them.
    const lastContentIdx = (() => {
      for (let i = pendingAssistantTurns.length - 1; i >= 0; i--) {
        if (pendingAssistantTurns[i].content.length > 0) return i
      }
      return -1
    })()
    for (let turnIdx = 0; turnIdx < pendingAssistantTurns.length; turnIdx++) {
      const turn = pendingAssistantTurns[turnIdx]
      if (turn.content.length === 0) continue
      const assistantRow = await addSessionMessage({
        sessionId: session.id,
        role: 'assistant',
        content: turn.content,
        // Stamp draft-session author so peer viewers see who drove
        // the turn that produced this assistant message.
        senderUserId: senderUserId ?? null,
        attachments: turnIdx === lastContentIdx && attachments?.length ? attachments : undefined,
      })
      lastFlushedAssistantRowId = assistantRow.id
      // Streaming channels surface the persisted row so the client
      // can attach actions (regenerate, copy, thumbs-up) and so
      // collaborative channels can mirror the assistant turn to peer
      // viewers. Multi-turn loops (tool_use → tool_result → assistant
      // text) fire this once per buffered turn that has content.
      // Final-only channels leave the hook unimplemented.
      await hooks.onAssistantMessageSaved?.({
        id: assistantRow.id,
        sequenceNum: assistantRow.sequenceNum,
        content: turn.content,
      })
      const missing = synthesizeMissingToolResults(turn.content, turn.toolResults, reason)
      const allResults = [...turn.toolResults, ...missing]
      if (allResults.length > 0) {
        await addSessionMessage({ sessionId: session.id, role: 'user', content: allResults })
      }
    }
  }

  // Helper: invoke `sendResponse` and stamp the returned channel-native
  // id onto the most-recently-flushed assistant row. Best-effort — a
  // hook returning `void` (web SSE, scheduled-job executor) skips the
  // stamp entirely; a missing `lastFlushedAssistantRowId` (recovery
  // path that never flushed) also skips. Errors during the stamp are
  // logged but don't propagate — the user already saw the message.
  const sendResponseAndStampChannelId = async (text: string, documents?: OutgoingDocument[]): Promise<void> => {
    const result = await hooks.sendResponse(text, documents)
    const channelMessageId = result && typeof result === 'object'
      ? result.channelMessageId
      : undefined
    if (channelMessageId && lastFlushedAssistantRowId) {
      try {
        await setSessionMessageChannelId(lastFlushedAssistantRowId, channelMessageId)
      } catch (err) {
        console.warn(
          '[channel-pipeline] setSessionMessageChannelId failed:',
          err instanceof Error ? err.message : String(err),
        )
      }
    }
  }

  // ── Preflight research ──
  let preflightContext = ''
  if (messageText.length > 40) {
    try {
      const preflight = await runPreflight({
        provider, model, message: messageText, tools: allTools,
        context: {
          userId, assistantId: assistant.id, sessionId: session.id,
          appId: 'Use Brian', channelType, channelId,
          userTimezone,
          abortSignal: new AbortController().signal,
          requestTools: allTools,
        },
        onStatus: () => hooks.onStatus?.('Researching...') ?? Promise.resolve(),
      })
      if (preflight.type === 'researched') {
        preflightContext = preflight.context
      }
    } catch (err) {
      console.error(`[${channelType}] pre-flight failed, continuing without:`, err)
    }
  }
  let systemPromptWithPreflight = buildPreflightPrompt(fullSystemPrompt, preflightContext)

  // ── Dispute pre-pass (grounding-gate claim ledger) ──
  // A dispute-shaped follow-up carrying a figure ("唔係要 look 11萬咩")
  // loads the previous reply's claim provenance so the model re-verifies
  // instead of re-asserting. One indexed read, only on the dispute shape.
  // See docs/architecture/engine/grounding-gate.md → "Dispute pre-pass".
  if (messageText && matchesDisputedFigure(messageText)) {
    try {
      const { getClaimsForLatestAssistantMessage } = await import('../db/claim-provenance-store.js')
      const priorClaims = await getClaimsForLatestAssistantMessage(session.id)
      if (priorClaims.length > 0) {
        systemPromptWithPreflight =
          `${systemPromptWithPreflight}\n\n# Figure provenance (dispute check)\n\n${buildDisputeContextNote(priorClaims)}`
      }
    } catch (err) {
      console.warn(`[${channelType}] dispute pre-pass failed, continuing without:`, err)
    }
  }

  // ── Reply evidence (grounding gate) ──
  // Figures observed in successful tool results this turn (fed by the tool
  // executor) plus seeded material — the system prompt and the user's own
  // message — form the evidence the gate diffs reply claims against. Prior
  // ASSISTANT turns are deliberately not seeded: a confabulated figure from
  // the previous reply must not launder itself into evidence for the next.
  // Accumulate-only here (no gatedTools): the identifier write-gate stays a
  // workflow-lane behavior.
  const replyEvidence = new EvidenceAccumulator()
  replyEvidence.note(systemPromptWithPreflight)
  replyEvidence.note(messageText)

  // Claim ledger stash — persisted after flushBufferedTurns (which creates
  // the assistant message row) and BEFORE sendResponse, so the linkage
  // exists before the user sees the reply.
  let pendingClaimLedger: Extract<
    import('@use-brian/core').QueryEvent,
    { type: 'claim_ledger' }
  >['claims'] | null = null

  // ── Query loop ──
  try {
    for await (const event of queryLoop({
      provider, model,
      systemPrompt: systemPromptWithPreflight,
      messages, tools: allTools,
      context: {
        userId, assistantId: assistant.id, sessionId: session.id,
        appId: 'Use Brian', channelType, channelId,
        workspaceId: assistant.workspaceId ?? undefined,
        assistantKind: assistant.kind,
        preferredChannel,
        userTimezone,
        abortSignal: abortController.signal,
        sessionStateStore,
        requestTools: allTools,
        workerManager,
        activeCapabilities,
        outboundAttachments: attachmentCollector,
        sensitivity: sensitivityAccumulator,
        compartmentAccumulator,
        evidence: replyEvidence,
        // `clearance` is the read ceiling = min(member, assistant);
        // `assistantClearance` is the write ceiling (the assistant's tier).
        clearance,
        compartments,
        assistantClearance: assistant.clearance,
        assistantCompartments: assistant.compartments ?? null,
        assistantDefaultCompartments: assistant.defaultCompartments ?? [],
      },
      confirmationResolver,
      confirmationTimeoutMs: 300_000,
      // Fresh-facts grounding gate — a figure-bearing answer about current
      // facts with zero tool calls gets one forced-verification nudge.
      // Messaging replies are final-only, so the draft is retracted (the
      // `grounding_nudge` case below resets `responseText`) and never
      // delivered. See docs/architecture/engine/grounding-gate.md.
      ...(messageText
        ? { groundingGate: { userMessage: messageText, draftDelivered: false } }
        : {}),
      ...(tierBudget
        ? { maxTurns: tierBudget.maxTurns, maxToolCalls: tierBudget.maxToolCalls }
        : {}),
    })) {
      switch (event.type) {
        case 'text_delta':
          // Streaming channels (web SSE) render text as it arrives; the
          // client is a render layer that can drop control markers, so
          // partial chunks are fine here. The final-only channels' outbound
          // message is NOT built from these chunks — see
          // `assembleDeliverableText`.
          await hooks.onTextDelta?.(event.text)
          break
        case 'grounding_nudge':
          // The buffered draft is superseded — cut it out of the deliverable
          // so the outbound message never carries the unverified figures.
          deliveryCutIdx = pendingAssistantTurns.length
          analytics?.logEvent({
            userId, assistantId: assistant.id, sessionId: session.id,
            eventName: 'grounding_nudge_fired', channelType,
            metadata: {
              matched_cue: sanitizeAnalytics(event.matchedCue),
              unbacked_count: event.unbackedCount,
              model: sanitizeAnalytics(model),
            },
          })
          break
        case 'claim_ledger':
          // Stash — persisted in the turn_complete branch after
          // flushBufferedTurns creates the assistant row, before send.
          pendingClaimLedger = event.claims
          break
        case 'citation':
          // Grounding citations from web search / knowledge tools.
          // Streaming channels render as separate UI chips. Final-only
          // channels can ignore (Slack inlines into the response text;
          // Telegram/WhatsApp skip).
          await hooks.onCitation?.(event.sources)
          break
        case 'status':
          await hooks.onStatus?.(event.message)
          break
        case 'tool_start':
          await hooks.onToolStart?.(event.id, event.name)
          break
        case 'tool_input':
          await hooks.onToolInput?.(event.id, event.name, event.input)
          break
        case 'tool_result':
          // Realtime parity with the web chat lane (realtime-sync): a brain
          // write from a Telegram / Slack / WhatsApp turn must repaint an
          // open brain page the same way a web-chat write does. Same
          // fire-and-forget map lookup chat.ts uses.
          for (const block of event.results) {
            if (block.type !== 'tool_result') continue
            notifyBrainWriteIfMatch(
              assistant.workspaceId,
              block.name,
              block.isError ?? false,
            )
          }
          await hooks.onToolResult?.(event.results)
          break
        case 'tool_confirmation_required':
          await hooks.onConfirmationRequired(event.request, confirmationResolver)
          break
        case 'assistant_turn':
          pendingAssistantTurns.push({
            content: event.response.content,
            toolResults: event.toolResults,
          })
          break
        case 'turn_complete': {
          // ── Outbound documents (sendFile) ──
          // Drain BEFORE flushing so the persisted attachment list
          // reflects only what actually resolves to bytes. A failed
          // fetch (file deleted mid-turn, orphaned blob) drops the
          // document and surfaces a plain notice line — never a silent
          // drop. See adapter-pattern.md → "Outbound documents".
          const pendingAttachments = attachmentCollector?.drain() ?? []
          const documents: OutgoingDocument[] = []
          const resolvedAttachments: OutboundAttachment[] = []
          const failedAttachmentNames: string[] = []
          if (pendingAttachments.length > 0 && filesApi) {
            for (const att of pendingAttachments) {
              try {
                const res = await filesApi.readBytes(
                  {
                    workspaceId: att.workspaceId,
                    userId,
                    assistantId: assistant.id,
                    assistantKind: assistant.kind,
                    // Same read ceiling the sendFile stat ran under.
                    clearance,
                    compartments,
                  },
                  att.fileId,
                )
                if (!res.ok) throw new Error(res.error.kind)
                documents.push({
                  filename: att.name,
                  mime: att.mime,
                  data: res.value.bytes,
                  caption: att.caption,
                })
                resolvedAttachments.push(att)
              } catch (err) {
                console.warn(
                  `[${channelType}] outbound attachment byte fetch failed for ${att.fileId}:`,
                  err instanceof Error ? err.message : String(err),
                )
                failedAttachmentNames.push(att.name)
              }
            }
          }

          await flushBufferedTurns('turn_complete', resolvedAttachments)
          // Persist the claim ledger BEFORE the send — the claim→evidence
          // linkage exists before the user sees the reply. Best-effort: a
          // ledger failure never blocks delivery. See
          // docs/architecture/engine/grounding-gate.md → "Claim ledger".
          if (pendingClaimLedger && lastFlushedAssistantRowId) {
            try {
              const { insertClaimProvenance } = await import('../db/claim-provenance-store.js')
              await insertClaimProvenance(lastFlushedAssistantRowId, pendingClaimLedger)
            } catch (err) {
              console.warn(`[${channelType}] claim ledger persist failed:`, err)
            }
            analytics?.logEvent({
              userId, assistantId: assistant.id, sessionId: session.id,
              eventName: 'claim_ledger_recorded', channelType,
              metadata: {
                backed_count: pendingClaimLedger.filter((c) => c.status === 'backed').length,
                unverified_count: pendingClaimLedger.filter((c) => c.status === 'unverified').length,
                model: sanitizeAnalytics(model),
              },
            })
            pendingClaimLedger = null
          }
          // Strip the trailing <followup>[…]</followup> tag — messaging
          // channels (Telegram, Slack, WhatsApp) have no chip affordance,
          // so the raw tag would leak into the message body. Web parses
          // it client-side and renders chips. See
          // docs/architecture/features/follow-up-questions.md.
          const { display: visibleText } = parseFollowUps(
            assembleDeliverableText(pendingAssistantTurns.slice(deliveryCutIdx)),
          )
          const attachmentNotes = failedAttachmentNames.length > 0
            ? `${visibleText ? '\n\n' : ''}${failedAttachmentNames.map((n) => `Could not attach: ${n}`).join('\n')}`
            : ''
          const outboundText = visibleText + attachmentNotes
          // Nothing deliverable: every turn was a tool call, retracted by the
          // grounding gate, or stripped by the leak sanitiser. Delta-summing
          // used to paper over this by shipping whatever streamed (narration,
          // suppressed text) — the very leak this assembly closes. Send
          // nothing rather than an empty bubble, and leave a trace: silence
          // here is a real failure, not a clean turn.
          if (!outboundText && documents.length === 0) {
            console.warn(
              `[${channelType}] no deliverable text at turn_complete (session ${session.id}) — nothing sent`,
            )
            analytics?.logEvent({
              userId, assistantId: assistant.id, sessionId: session.id,
              eventName: 'channel_delivery_empty', channelType,
              metadata: { turns: pendingAssistantTurns.length, model: sanitizeAnalytics(model) },
            })
          } else {
            await sendResponseAndStampChannelId(
              outboundText,
              documents.length > 0 ? documents : undefined,
            )
          }
          deliveryCutIdx = pendingAssistantTurns.length

          // ── Cost tracking + analytics ──
          // Stage 5: cost attributes to the resolved billing party (team
          // owner for team assistants, personal owner for personal). The
          // analytics event below stays keyed on the channel user so
          // per-user activity remains visible in the monitor. See
          // docs/architecture/integrations/mcp.md and
          // docs/architecture/channels/channel-user-identity.md → "Billing split".
          const usage = event.totalUsage
          if (usageStore && usage) {
            const cost = calculateCost(event.response.model, usage)
            usageStore.recordUsage({
              userId: billingUserId, actorUserId: userId, assistantId: assistant.id, sessionId: session.id,
              model: event.response.model,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheReadTokens: usage.cacheReadTokens,
              cacheWriteTokens: usage.cacheWriteTokens,
              actualCostUsd: cost,
              // This is the credit-bearing row. The credit derivation
              // (getPeriodCredits → `user_message_id IS NOT NULL`) skips any
              // main_response row missing this id, so omitting it makes every
              // channel turn debit ZERO credits. The web route stamps it on its
              // main_response too — keep parity. See cost-and-pricing.md →
              // "Credit accounting".
              userMessageId: userMessageRow.id,
              source: workspacePlan === 'free' ? 'free' : 'included',
              triggerKey: 'main_response',
            }).catch((err) => console.error(`[${channelType}] Usage tracking failed:`, err))

            analytics?.logEvent({
              userId, assistantId: assistant.id, sessionId: session.id,
              eventName: 'turn_completed', channelType,
              metadata: {
                model: sanitizeAnalytics(event.response.model),
                input_tokens: usage.inputTokens,
                output_tokens: usage.outputTokens,
                cost_usd_micro: Math.round(cost * 1_000_000),
                cache_hits: usage.cacheReadTokens ?? 0,
              },
            })
          }
          break
        }
        case 'error':
          console.error(`[${channelType}] query loop error:`, event.error)
          await hooks.sendError(event.error)
          break
      }
    }

    await flushBufferedTurns('[Tool did not return a result. Treat as failed and do not retry.]')

    // ── Session-state diff pass (fire-and-forget safety net) ──
    // See docs/architecture/context-engine/session-state.md.
    if (sessionStateStore && isIdentified) {
      const stateStore = sessionStateStore
      const diffRecentTurns: Message[] = []
      const assistantLastText = pendingAssistantTurns
        .flatMap((t) => t.content)
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
      if (assistantLastText) {
        diffRecentTurns.push(
          { role: 'user', content: messageText },
          { role: 'assistant', content: assistantLastText },
        )
      }
      stateStore
        .listOpenBySession(session.id)
        .then((open: SessionStateRecord[]) =>
          runSessionStateDiff({
            provider,
            // Standard tier per docs/architecture/platform/cost-and-pricing.md
            // → Model routing (extraction / classification / structured-output bucket).
            model: laneModel,
            sessionId: session.id,
            userId,
            assistantId: assistant.id,
            store: stateStore,
            recentTurns: diffRecentTurns,
            openCommitments: open,
          }),
        )
        .then((result) => {
          analytics?.logEvent({
            userId, assistantId: assistant.id, sessionId: session.id,
            eventName: result.errorMessage ? 'session_state_diff_failed' : 'session_state_diff_pass',
            channelType,
            metadata: {
              upserts: result.upserts,
              resolves: result.resolves,
              error: result.errorMessage ? sanitizeAnalytics(result.errorMessage) : undefined,
            },
          })
          return recordOverheadUsage({
            usageStore,
            userId,
            assistantId: assistant.id,
            sessionId: session.id,
            userMessageId: userMessageRow.id,
            model: result.model,
            usage: result.usage,
            source: 'overhead:session-state-diff',
            triggerKey: 'session_state_diff',
          })
        })
        .catch((err) => console.debug(`[${channelType}] session-state diff failed:`, err))
    }

    // ── Memory nudge (identified users only) ──
    // Records usage as `overhead:nudge` once the judge call returns. Fire-and-
    // forget — errors are logged but never surface to the user.
    if (isIdentified) {
      // Standard tier per docs/architecture/platform/cost-and-pricing.md
      // → Model routing (extraction / classification / structured-output bucket).
      runMemoryNudge({
        turns: pendingAssistantTurns,
        callModel: async (prompt) => {
          const resp = await collectStream(provider.stream({
            model: laneModel,
            messages: [{ role: 'user', content: prompt }],
            systemPrompt: 'You are a memory utility judge. Follow instructions exactly.',
            maxTokens: 256,
          }))
          return {
            text: resp.content
              .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
              .map((b) => b.text)
              .join(''),
            usage: resp.usage,
            model: laneModel,
          }
        },
        store: memoryStore,
      })
        .then((result) => recordOverheadUsage({
          usageStore,
          userId,
          assistantId: assistant.id,
          sessionId: session.id,
          userMessageId: userMessageRow.id,
          model: result.model,
          usage: result.usage,
          source: 'overhead:nudge',
          triggerKey: 'memory_nudge',
        }))
        .catch((err) => console.debug(`[${channelType}] memory nudge failed:`, err))
    }
  } catch (err) {
    await flushBufferedTurns('[Stream terminated unexpectedly before the tool result was recorded.]')
    console.error(`[${channelType}] unexpected query loop error:`, err)
    analytics?.logEvent({
      userId, assistantId: assistant.id, sessionId: session.id,
      eventName: 'chat_route_error', channelType,
      metadata: {
        error_type: sanitizeAnalytics((err as Error)?.name ?? 'unknown'),
        error_message: sanitizeAnalytics(((err as Error)?.message ?? '').slice(0, 200)),
        stage: sanitizeAnalytics('query_loop'),
      },
    })

    // Try to compose a context-aware recovery message naming any tools
    // that already shipped, so the operator doesn't blindly retry the
    // original instruction and duplicate side effects (e.g. two
    // calendar updates, two Threads replies). Falls back to the
    // generic `hooks.sendError` when no tools ran or Flash hiccups.
    const recovered = await composeRecoveryMessage({
      provider,
      pendingAssistantTurns,
      userText: messageText,
      channelType,
    })
    if (recovered) {
      // Cost attribution for the Flash call. The synthesiser is paid
      // for by the assistant owner (same as every other overhead row),
      // not by whichever channel user happened to trigger the bail.
      await recordOverheadUsage({
        usageStore,
        userId: ownerId,
        actorUserId: userId,
        assistantId: assistant.id,
        sessionId: session.id,
        userMessageId: userMessageRow.id,
        model: recovered.model,
        usage: recovered.usage,
        source: 'overhead:recovery-message',
        triggerKey: 'recovery_message',
      })
      // Surface the recovery text via the same channel-native path the
      // normal turn would have used. Kept on `sendResponse` rather than
      // `sendError` so the message renders as the assistant speaking
      // (no red error styling, no "retry" affordance) — that's the
      // whole point of the helper.
      await sendResponseAndStampChannelId(recovered.text)
    } else {
      await hooks.sendError(err instanceof Error ? err : new Error(String(err)))
    }
  } finally {
    await hooks.onCleanup?.()
    await updateSessionStatus(session.id, 'idle')
  }
}
