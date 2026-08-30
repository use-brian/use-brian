// REBRAND-CUTOVER: this file contains sidan.ai runtime values that must flip to usebrian.ai when DNS + Vercel domains + OAuth consoles + webhooks are cut over. Grep REBRAND-CUTOVER.
/**
 * Shared channel message processing pipeline.
 *
 * Eliminates the ~350 lines of duplicated processMessage logic across
 * WhatsApp, Telegram, Slack, and Feishu/Lark routes. Each channel provides a thin
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

import { createTurnLedger } from '../ledger/recorder.js'
import { getLedgerPayloadStore } from '../ledger/runtime.js'
import {
  queryLoop, buildMemoryContext, createMemoryTools, createSessionStateTools,
  buildSessionStateBlock, runSessionStateDiff,
  synthesizeMissingToolResults,
  collectStream, calculateCost, runPreflight, buildPreflightPrompt,
  runMemoryNudge, sanitize as sanitizeAnalytics, createConfirmationResolver,
  classifyTopic, fetchEpisodicContext, filterToolsByCapabilities,
  modelToCompactionTier, SensitivityAccumulator, CompartmentAccumulator,
  ContextScopeAccumulator,
  buildWorkspaceFilesContext, buildUploadPolicyBlock, AttachmentCollector,
  EvidenceAccumulator, matchesDisputedFigure, buildDisputeContextNote,
  latestWorkflowProposalReceipt,
  parseSlashCommand, buildSlashCommandBlock,
  buildEmailDraftAnchorPrompt, formatActiveEmailDraftContext,
} from '@use-brian/core'
import type { FilesApi, OutboundAttachment, RealtimeThreadTarget } from '@use-brian/core'
import { resolveBrandContext } from '../brand/prompt-context.js'
import type { IncomingMessage, OutgoingDocument } from '@use-brian/channels'
import { parseFollowUps, resolveCharter } from '@use-brian/shared'
import { loadDecisionPlaybookContext } from '../decision-learning/playbook-context.js'
import { runProactiveCompaction } from './proactive-compaction.js'
import { notifyBrainWriteIfMatch } from '../brain-stream/notify.js'
import { recordOverheadUsage } from './_overhead-usage.js'
import { recordExternalCostFromMeta } from '../billing-external.js'
import {
  acceptedGoalIdsFromToolResults,
  GOAL_ACCEPTED_CHANNEL_MESSAGE,
} from '../goals/acknowledgement.js'
import { composeRecoveryMessage } from './_recovery-message.js'
import {
  CONTEXT_NOT_AVAILABLE_MESSAGE,
  CUSTOM_MODEL_IMAGE_FALLBACK_NOTICE,
  CUSTOM_MODEL_IMAGE_REJECTION,
} from './_channel-error-text.js'
import { decideImageTurnRoute } from '../custom-llm-runtime.js'
import { resolveReplyText } from './_reply-context.js'
import {
  attachUserVisibleContext,
  buildSplitSystemPrompt,
  formatPrivateRuntimeContext,
  formatUserVisibleContext,
  speakerIdentityFromUser,
} from './_prompt-builder.js'
import { getEvolution as getWorkspaceMemoryEvolution } from '../db/workspace-memory-evolution-store.js'
import { getBrainEvolution } from '../db/workspace-brain-evolution-store.js'
import { resolvePresenceTimezone } from '../auth/client-timezone.js'
import type {
  ContentBlock, LLMProvider, Tool, MemoryStore, UsageStore,
  AnalyticsLogger, McpSettingsStore, KnowledgeStoreInterface, GDriveFilesStore,
  ConfirmationResolver, Message, TopicClassification, ClassifierRecentTurn,
  EpisodicStore, CapabilityStore, TokenUsage, ToolResultMeta,
  SessionStateStore, SessionStateRecord, CrmEmailDraftStore,
} from '@use-brian/core'

import { mintActorMediaToken } from '../media-token.js'
import { findUserById } from '../db/users.js'
import { type PublishSessionEvent, noopPublishSessionEvent } from '../session-event-port.js'
import {
  createTurnStreamPublisher,
  publishRoomTurnActivity,
  publishTurnCompleted,
} from '../session-live-publisher.js'
import {
  findOrCreateSession, addSessionMessage, setSessionMessageChannelId,
  getSessionMessages, updateSessionStatus, getPreferredChannel,
  getGroupChatContext, buildGroupChatContextPrompt, getSessionTopicLabels,
  markDowngradeNoticeSent, clearDowngradeNotice,
} from '../db/sessions.js'
import { resolveChatModelSelection, wouldBudgetDowngradeAffectModel, chatTierBudget, BACKGROUND_MODEL, backgroundModelFor } from '../model-resolution.js'
import type { ConnectorStore } from '../db/connector-store.js'
import type { AssistantConnectorStore } from '../db/assistant-connector-store.js'
import type { SkillStore } from '../db/skill-store.js'
import { injectMcpTools } from '../mcp/inject.js'
import { createKnowledgeRepoWriter } from '../knowledge/repo-writer.js'
import { createDbKnowledgeStore } from '../db/knowledge-store.js'
import { createDbWorkspaceSkillStore } from '../db/skill-store.js'
import { createDbWorkspaceSkillEnablementStore } from '../db/workspace-skill-enablement-store.js'
import { createSyncCredentialProvider } from '../knowledge/sync-credentials.js'
import { buildBrowserEscalationPrompt, buildUnavailableCapabilitiesPrompt, injectSkills, checkUsageBudget } from './route-helpers.js'
import type { CreditBudgetGate } from './route-helpers.js'
import { getConnectorUserId, getWorkspacePurpose, getWorkspacePlan, getWorkspaceRoleSystem } from '../db/workspace-store.js'
import {
  ContextNotAvailableError,
  formatActiveWorkspaceContext,
  noteAutomaticScopeEvidence,
  resolveTurnScopeSystem,
} from '../context-scope/resolve-turn-scope.js'
import { bindToolsToAgentAccess } from '../context-scope/agent-access-tools.js'
import {
  buildChannelSessionKey,
  listPendingRecordingConfirmationsForSession,
} from '../db/pending-recording-confirmations-store.js'
import { billingPartyForAssistant } from '../billing-party.js'
import { promotePastedText, shouldPromotePaste } from '../files/paste-promotion.js'
import type { ArtifactPromoter } from '../files/artifact-promote.js'
import { appendInboundChatArchive, appendOutboundChatArchive, persistInboundChatArchive } from '../chat-archive/live-writer.js'
import { isRegistryModelAvailable, registryRow } from '@use-brian/shared/model-registry'
import type { ProviderAvailability } from '@use-brian/shared/model-registry'

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
 *  - **Final-only** (Telegram, Slack, WhatsApp, Feishu/Lark): the pipeline buffers
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
   * channels (Telegram, Slack, WhatsApp, Feishu/Lark) leave this unimplemented and
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

  /** Called once when a confirmed goal has been armed and kicked off. */
  onGoalAccepted?(message: string, goalId: string): Promise<void>

  /**
   * Called immediately after the inbound user message is persisted to
   * `session_messages`. Streaming channels use this to surface the
   * DB-assigned id to the client so it can attach feedback / edit /
   * retry actions to that specific user turn (the web chat panel reads
   * `id` from this event). Final-only channels (Telegram, Slack, Feishu/Lark,
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
   * Channels that talk to messaging platforms (Slack, Telegram, Feishu/Lark) MAY
   * return `{ channelMessageId }` — the platform-native id the
   * adapter received from its send call. The pipeline stamps it onto
   * the most-recently-persisted assistant `session_messages` row so
   * later reaction handlers can map a Slack or Feishu/Lark reaction or Telegram
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
  /**
   * The assistant's PERSONAL owner — `assistants.owner_user_id`, which the
   * ownership XOR flip (migration 089) made **NULL for every workspace-owned
   * assistant**. Every caller passes `assistant.ownerUserId` straight through,
   * so this is null on the majority of production assistants and the type must
   * say so: it was declared `string` for months while carrying null, which is
   * how the overhead rows below ended up violating `usage_tracking.user_id`'s
   * NOT NULL constraint on every official-Telegram turn.
   *
   * It is NOT the paying party. Anything that bills, or that writes a row with
   * a user column, must use `billingUserId` (resolved once below via
   * `billingPartyForAssistant`, which consults `workspaces.owner_user_id`).
   * `ownerId` survives only as the personal-owner input to that resolution.
   */
  ownerId: string | null
  /** The assistant record. */
  assistant: {
    id: string
    name: string
    /** NULL for workspace-owned assistants — see `ownerId` above. */
    ownerUserId: string | null
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
    teamScopeMode?: 'legacy' | 'all' | 'assigned'
    defaultWorkspaceGroupId?: string | null
    projectScopeMode?: 'all' | 'assigned'
    defaultProjectId?: string | null
    /** Drives the primary widen in the universal access predicate. */
    kind: 'primary' | 'standard' | 'app'
  }
  /**
   * Whether the channel user is identified (linked account or matched email).
   * Controls pattern extraction and memory context.
   * WhatsApp/Web always true; Telegram/Slack/Feishu-Lark may be false for shadow users.
   */
  isIdentified: boolean
  /**
   * Explicitly allowlisted outside guest. This is narrower than
   * `isIdentified=false`: anonymous group participants keep the existing
   * channel behavior, while an external guest gets persona + isolated session
   * chat only. Workspace context, tools, and persistence are withheld unless
   * the connector-only opt-in below is set.
   */
  externalGuest?: boolean
  /**
   * Explicit owner opt-in for an external guest to use the connected tools
   * enabled for this assistant. Does not relax memory, workspace-file, skill,
   * private-context, or long-term-persistence boundaries.
   */
  externalGuestConnectorTools?: boolean
  checkCreditBudget?: CreditBudgetGate

  // ── Channel context ──
  channelType: 'whatsapp' | 'telegram' | 'slack' | 'discord' | 'email' | 'msteams' | 'wechat' | 'custom' | 'feishu'
  /** Physical provider destination used for delivery and connector actions. */
  channelId: string
  /**
   * Conversation id used for session-scoped storage/state when narrower than
   * the provider destination. Threaded Slack passes
   * `<channelId>:thread:<threadTs>` while delivery keeps the bare channel id.
   * Defaults to `channelId` for every other channel.
   */
  sessionChannelId?: string
  /**
   * The acting user's channel-native id captured from the inbound webhook —
   * WhatsApp phone, Telegram `@handle`, Slack user id, or Feishu/Lark open id. Forwarded to
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
   * Bounded context read from the current provider conversation before this
   * turn (for example, Slack's visible thread during an empty-session
   * cutover). It is untrusted material the user can see, so it joins the
   * user-visible context envelope on the newest user turn. It must never enter
   * private runtime/system context and is not persisted as authored session
   * history by this pipeline.
   */
  providerVisibleContext?: string | null
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
   * `thread_ts`; Feishu/Lark passes `parent_id`/`root_id`; WhatsApp passes the quoted message ID. The pipeline
   * resolves this to text via resolveReplyText().
   */
  replyToMessageId?: string | number | null
  /**
   * Active channel-neutral target resolved by the inbound route. It bypasses
   * addressing only; task tools separately enforce its bound lineage + rules.
   */
  realtimeThreadTarget?: RealtimeThreadTarget | null
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
  /**
   * Parsed provider message for the shared local archive normalizer. Keeping
   * this at the common pipeline boundary prevents per-adapter
   * archive writers. Raw provider payloads are discarded by the normalizer.
   */
  archiveIncoming?: IncomingMessage
  /** The route already enqueued this inbound archive row before invoking the pipeline. */
  archiveInboundAlreadyPersisted?: boolean
  /** Exact connector backing this route, when known. */
  archiveConnectorInstanceId?: string | null
  /**
   * Per-channel-instance document capability (custom bridges declare it in
   * their state report). Threaded onto ToolContext so the `sendFile` gate can
   * admit a bridge that proved it delivers files — see
   * `ToolContext.channelDocumentsSupported`.
   */
  channelDocumentsSupported?: boolean

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
   * Channels (Telegram / Slack / Feishu-Lark / WhatsApp) opt in here because they have no
   * manual toggle. The web chat route runs its own adaptive path in
   * `routes/chat.ts` against the same classifier.
   */
  adaptiveResearchEnabled?: boolean

  // ── Abort ──
  /** External abort controller — wired into the query loop context. */
  abortController: AbortController

  // ── Stores & services ──
  provider: LLMProvider
  /** Live application-provider availability and preference. */
  configuredProviders?: ProviderAvailability
  /** OSS workspace custom endpoint default for user-facing channel turns. */
  resolveWorkspaceCustomLlm?: import('../custom-llm-runtime.js').WorkspaceCustomLlmResolver
  /**
   * Session live-event bus publish — the Live watch pane's feed
   * (docs/architecture/features/live-work.md §5.2): every channel turn
   * publishes throttled `turn_stream` snapshots + activity events through
   * the shared `session-live-publisher`, between the `running`/`idle`
   * bookends. Optional ONLY for unit tests: like `resolveWorkspaceCustomLlm`
   * above, this param must be threaded by hand at every
   * `processChannelMessage` call site AND every mount in both editions'
   * entrypoints — an omitted optional param degrades by writing nothing
   * down, the exact `channel-custom-llm-wiring` failure shape. No-op when
   * unset.
   */
  publishSessionEvent?: PublishSessionEvent
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
  /** Workspace capture categories; absent/empty keeps interactive KB writes dark. */
  knowledgeCaptureRuleStore?: import('../knowledge/capture-rules.js').KnowledgeCaptureRuleStore
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
  /** Upload-cache reader, so a photo just attached to this turn can be
   *  promoted on demand (Shopify product images). Chat/channel paths only. */
  readCachedFile?: (id: string, ctx: import('@use-brian/core').AccessContext) => Promise<import('@use-brian/core').CachedFile | null>
  /**
   * Promotes an over-threshold paste to a durable workspace_files artifact
   * (large-content-artifacts §Phase 3.2, decision D6). Wired once at boot from
   * the channel route options. Absent/null ⇒ pastes pass through untouched.
   * See use-brian/packages/api/src/files/artifact-promote.ts.
   */
  artifactPromoter?: ArtifactPromoter | null
  skillStore?: SkillStore
  /**
   * Workspace-skill surface for `injectSkills`. Both were absent here until
   * mig 491, which meant messaging channels could only see the legacy
   * slug-keyed skill toggles — never the `workspace_skill_enablement`
   * allowlist, and never the `all_assistants` flag. A workspace skill that was
   * plainly enabled in the web app was simply not offered on Telegram.
   */
  workspaceSkillStore?: import('../db/skill-store.js').WorkspaceSkillStore
  workspaceSkillEnablementStore?: import('../db/workspace-skill-enablement-store.js').WorkspaceSkillEnablementStore
  workerManager?: import('@use-brian/core').WorkerManager
  episodicStore?: EpisodicStore
  sessionStateStore?: SessionStateStore
  /** Canonical CRM email drafts and per-conversation active anchor. */
  crmEmailDraftStore?: CrmEmailDraftStore
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

/**
 * Why `assembleDeliverableText` came back with nothing.
 *
 *  - `tools_only`    — the run called tools but never reached a terminal turn.
 *                      Work may already have shipped side effects, so a blind
 *                      retry can duplicate them.
 *  - `no_model_output` — no turn carried text OR a tool call. The provider
 *                      returned nothing usable, `EMPTY_RETRY_PLAN` included.
 *                      Retrying is safe and is often all that is needed.
 *  - `text_withheld` — text existed and this pipeline refused to send it: the
 *                      grounding gate retracted the draft (`deliveryCutIdx`)
 *                      or the instruction-leak sanitiser stripped it. Retrying
 *                      is safe.
 */
export type EmptyDeliveryReason = 'tools_only' | 'no_model_output' | 'text_withheld'

/**
 * Classify an empty delivery window so telemetry records WHICH failure this
 * was and the caller can decide whether a retry is safe to suggest.
 *
 * `window` is `pendingAssistantTurns.slice(deliveryCutIdx)` and may legitimately
 * be EMPTY: when the grounding gate retracts every turn it has yielded, the cut
 * consumes the whole buffer. An empty window has no tool call and no text, so
 * the structural tests below would call it `no_model_output` — which is exactly
 * backwards, since the model did speak and this pipeline withheld it. Hence
 * `retractedCount` (the cut index) decides that case first.
 */
export function classifyEmptyDelivery(input: {
  window: { content: ContentBlock[] }[]
  /** `deliveryCutIdx`: turns the grounding gate cut out of the window. */
  retractedCount: number
}): EmptyDeliveryReason {
  const { window, retractedCount } = input
  if (window.length === 0) {
    return retractedCount > 0 ? 'text_withheld' : 'no_model_output'
  }
  if (window.some((t) => t.content.some((b) => b.type === 'tool_use'))) return 'tools_only'
  if (window.some((t) => t.content.some((b) => b.type === 'text'))) return 'text_withheld'
  return 'no_model_output'
}

/**
 * What a channel user is told when a turn produced nothing deliverable and no
 * tool ran that a retry could duplicate.
 *
 * Deliberately claims nothing about tools: the `tools_only` branch falls back
 * here when `composeRecoveryMessage` declines (no SUCCESSFUL tool call to
 * describe), and in that case tools were called and failed. Short, always true,
 * and it tells the user the one thing they need — the message arrived, and
 * sending it again is safe.
 */
export const EMPTY_DELIVERY_NOTICE =
  'I could not produce a reply to that message. Please send it again, or rephrase it.'

/**
 * Connector access for a channel turn. Normal channel users keep the existing
 * connector path. An explicit external guest needs the integration owner's
 * opt-in because the tools act through credentials granted to the routed
 * assistant rather than credentials owned by the guest.
 */
export function connectorToolsAllowedForChannelTurn(
  externalGuest: boolean,
  externalGuestConnectorTools: boolean | undefined,
): boolean {
  return !externalGuest || externalGuestConnectorTools === true
}

// ── Pipeline ─────────────────────────────────────────────────────

/**
 * Private-runtime block for a sender who is not a member of the assistant's
 * workspace. Model-facing (system channel), never delivered verbatim; keeps
 * the wording plain because the model paraphrases it to the user.
 * Exported for `[COMP:api/channel-pipeline/non-member-sender]`.
 */
export function buildNonMemberSenderBlock(args: {
  channelType: string
  senderEmail: string | null
  senderName: string | null
}): string {
  const who = args.senderEmail
    ? `${args.senderName ? `${args.senderName} <${args.senderEmail}>` : args.senderEmail}`
    : (args.senderName ?? 'this sender')
  const identity = args.senderEmail
    ? `Their ${args.channelType} account resolves to the Use Brian account ${args.senderEmail}, and that account is not a member of this workspace.`
    : `Their ${args.channelType} account could not be matched to a member of this workspace.`
  return (
    '# Sender is not a workspace member\n\n' +
    `You are answering ${who}, who is NOT a member of this assistant's workspace. ` +
    'Every workspace-scoped read (workflows, tasks, pages, brain, contacts, deals, connectors) will come back empty or "not found" for them. ' +
    'That is an access boundary, not a missing record: do NOT report "no workflows", "no tasks", "not found" or "not visible in this workspace" as fact, do not ask them to open a different workspace, and do not retry lookups. ' +
    `If they ask about workspace data or ask you to act on it, tell them plainly: ${identity} ` +
    'Give both remedies: (1) a workspace admin invites that email to the workspace, or (2) they link this ' +
    `${args.channelType} account to the Use Brian account they normally use, from Settings -> Account -> Connected accounts, then re-send the message. ` +
    'Everything they say in this chat is still answerable from what they provide here.'
  )
}

/**
 * Everything the pipeline owes the rest of the system for one `tool_result`
 * event: the realtime brain repaint, the `tool_executed` analytics row, and the
 * external-API cost row.
 *
 * The last two did not exist here at all. `tool_executed` was emitted ONLY by
 * `routes/chat.ts` (with `channelType` hardcoded to `'web'`) and by the callee
 * executor, so every messaging channel wrote NOTHING per tool call while
 * genuinely running tools: between 2026-08-12 and 2026-08-19, Telegram logged
 * 123 turns and 0 tool events and Slack 52 turns and 0, against 142 persisted
 * session messages carrying `tool_use` blocks on those same Telegram sessions.
 * Nothing surfaced it, because a missing row looks exactly like a tool that was
 * never called — so the admin per-tool rollups, the sentiment stores, and the
 * product-sentiment tool all reported "channels never use tools" as fact.
 *
 * The same blindness cost real money. `recordExternalCostFromMeta` is the ONE
 * seam that turns `ToolResult.meta.externalCost_*` into a billable row, and the
 * channel lane never called it: an identical `webSearch` billed the workspace
 * from web chat and nothing at all from Telegram.
 *
 * Two identities, deliberately different, mirroring the split the main turn
 * already makes at `turn_complete`:
 *
 *  - **analytics → `userId`** (the channel user). These are activity events;
 *    per-user monitoring must see the person who actually typed.
 *  - **usage → `billingUserId`** (the workspace / personal owner). Spend
 *    follows the payer, never the possibly-shadow chatter.
 *
 * `channelType` is always the pipeline's real channel. Hardcoding `'web'` is
 * what made the chat route's rows unusable for answering "which channel uses
 * which tool" in the first place.
 *
 * Metadata mirrors the chat + executor shape exactly - `tool_name`, `success`,
 * a conditional short `error_message`, then the tool's own `ToolResultMeta` -
 * so an admin rollup can treat a channel row and a web row identically. Never
 * tool input or output content. `in_worker` is deliberately absent: that key
 * marks the chat route's sub-agent lane, and this pipeline has no worker lane.
 *
 * Synchronous and total: analytics logging and cost metering are both
 * fire-and-forget by construction, so a metering failure can never fail the
 * user's turn.
 *
 * [COMP:api/channel-tool-observability]
 */
export function recordChannelToolResults(input: {
  results: ContentBlock[]
  metaByToolUseId?: Record<string, ToolResultMeta>
  analytics: AnalyticsLogger | undefined
  usageStore: UsageStore | undefined
  /** Channel user — the analytics actor. */
  userId: string
  /** Resolved billing party — pays for external API spend. */
  billingUserId: string
  assistantId: string
  sessionId: string
  workspaceId: string | null
  /**
   * Folds the tool's external spend into the SAME credit unit as the turn that
   * spent it: the credit derivation groups by `COALESCE(user_message_id, id)`,
   * so a stamped row adds COGS visibility without adding a credit. The chat
   * route stamps it too - this is parity, not a new policy.
   */
  userMessageId: string
  userPlan: string
  channelType: string
}): void {
  for (const block of input.results) {
    if (block.type !== 'tool_result') continue
    // Realtime parity with the web chat lane (realtime-sync): a brain write
    // from a Telegram / Slack / Feishu-Lark / WhatsApp turn must repaint an open brain page
    // the same way a web-chat write does. Same fire-and-forget map lookup
    // chat.ts uses.
    notifyBrainWriteIfMatch(input.workspaceId, block.name, block.isError ?? false)

    const toolMeta = input.metaByToolUseId?.[block.toolUseId]
    const extraMeta: Record<string, ReturnType<typeof sanitizeAnalytics> | number | boolean> = {}
    if (toolMeta) {
      for (const [k, v] of Object.entries(toolMeta)) {
        extraMeta[k] = typeof v === 'string' ? sanitizeAnalytics(v) : v
      }
    }
    input.analytics?.logEvent({
      userId: input.userId,
      assistantId: input.assistantId,
      sessionId: input.sessionId,
      eventName: 'tool_executed',
      channelType: input.channelType,
      metadata: {
        tool_name: sanitizeAnalytics(block.name),
        success: !(block.isError ?? false),
        ...(block.isError
          ? { error_message: sanitizeAnalytics(block.content.replace(/\s+/g, ' ').trim().slice(0, 200)) }
          : {}),
        ...extraMeta,
      },
    })
    void recordExternalCostFromMeta({
      toolMeta,
      usageStore: input.usageStore,
      userId: input.billingUserId,
      assistantId: input.assistantId,
      sessionId: input.sessionId,
      userMessageId: input.userMessageId,
      userPlan: input.userPlan,
      channelType: input.channelType,
      analytics: input.analytics,
    })
  }
}

export async function processChannelMessage(params: ChannelPipelineParams): Promise<void> {
  const {
    userId, ownerId, assistant, isIdentified,
    channelType, channelId, actorChannelId, mediaEpisodeId, isGroupChat,
    modelAlias, adaptiveResearchEnabled, abortController,
    provider, systemPrompt, tools, memoryStore, usageStore,
    analytics, connectorStore, mcpSettingsStore, assistantConnectorStore, connectorGrantStore, connectorInstanceStore, workspaceToolPolicyStore,
    knowledgeStore, knowledgeCaptureRuleStore, gdriveFilesStore, skillStore,
    workspaceSkillStore, workspaceSkillEnablementStore, workerManager,
    episodicStore, sessionStateStore, workspaceFilesStore, filesApi, readCachedFile,
    replyToMessageId, replyRaw, incomingChannelMessageId,
    voiceTranscriptionUsage,
    senderUserId,
    hooks,
    capabilityStore,
  } = params
  const externalGuest = params.externalGuest === true
  const publishSessionEvent = params.publishSessionEvent ?? noopPublishSessionEvent
  const sessionChannelId = params.sessionChannelId ?? channelId
  const externalGuestConnectorTools = externalGuest && params.externalGuestConnectorTools === true
  const connectorToolsAllowed = connectorToolsAllowedForChannelTurn(
    externalGuest,
    params.externalGuestConnectorTools,
  )
  const taskAuthority = params.realtimeThreadTarget
    ? {
        kind: 'realtime_thread_target' as const,
        targetId: params.realtimeThreadTarget.id,
        channelType: params.realtimeThreadTarget.channelType,
        channelRef: params.realtimeThreadTarget.conversationRef,
        threadRef: params.realtimeThreadTarget.threadRef,
        taskIds: params.realtimeThreadTarget.taskIds,
        expiresAt: params.realtimeThreadTarget.expiresAt.toISOString(),
      }
    : undefined

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
    channelId: sessionChannelId,
  })
  let turnScope
  try {
    turnScope = await resolveTurnScopeSystem({
      userId,
      assistant: {
        ...assistant,
        compartments: assistant.compartments ?? null,
      },
      workspaceId: assistant.workspaceId,
      session,
    })
  } catch (err) {
    if (!(err instanceof ContextNotAvailableError)) throw err
    try {
      await hooks.sendError(new Error(CONTEXT_NOT_AVAILABLE_MESSAGE))
    } finally {
      await hooks.onCleanup?.()
    }
    return
  }
  const clearance = turnScope.access.clearance ?? assistant.clearance
  const compartments = turnScope.effectiveCompartments
  const scopeAccumulator = new ContextScopeAccumulator({
    compartments: turnScope.writeCompartments,
    projectIds: turnScope.writeProjectIds,
  })

  // Expose session ID to channel hooks (e.g., WhatsApp confirmation store)
  if (params.sessionRef) params.sessionRef.id = session.id

  // ── Budget gate — billing party pays ──
  // Post-089: billingPartyForAssistant is the single source of truth
  // for the paying user (team owner for team assistants, personal owner
  // otherwise). See docs/architecture/integrations/mcp.md.
  //
  // This is also the ONLY non-null user id this pipeline has. `ownerId` is
  // `assistants.owner_user_id`, NULL on every workspace-owned assistant since
  // the 089 ownership XOR flip, so a row written with `userId: ownerId` dies on
  // `usage_tracking.user_id`'s NOT NULL constraint for the majority of
  // production assistants — which is exactly what every `overhead:classifier`
  // row on official Telegram did until this was resolved here. Nothing below
  // may write a user column from `ownerId`; use `billingUserId`. It cannot be
  // null: `billingPartyForAssistant` throws when an assistant has neither a
  // workspace nor a personal owner, and it throws HERE, before the first
  // overhead call, rather than at a silent per-row catch.
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
  const backgroundLlmRuntime = assistant.workspaceId && params.resolveWorkspaceCustomLlm
    ? await params.resolveWorkspaceCustomLlm({
        workspaceId: assistant.workspaceId,
        requestedTier: 'standard',
        allowDefault: true,
        allowAnyDefault: true,
      })
    : null
  const backgroundProvider = backgroundLlmRuntime?.provider ?? provider
  const backgroundLaneModel = backgroundLlmRuntime?.selector ?? laneModel
  const backgroundUsageAttribution = {
    modelTier: 'standard',
    providerKeySource: backgroundLlmRuntime?.providerKeySource ?? 'platform' as const,
  }
  // ── Large-paste promotion (large-content-artifacts §Phase 3.2) ──
  // Runs before the message is classified, persisted, or fed to the model, so
  // a giant paste never reaches the classifier or the query loop as a blob.
  // Failure keeps the original text. See `promoteChannelPaste` above.
  if (!externalGuest) {
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
  }

  // Load the pre-turn transcript once and reuse it for adaptive research +
  // topic classification. Follow-up detection needs actual dialogue, not an
  // isolated current sentence (2026-08-09 Snapio incident on web; channels
  // share the same classifier contract).
  const preExistingDbMessages = await getSessionMessages(session.id)
  const adaptiveRecentConversation = preExistingDbMessages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .filter((m) => !(
      m.role === 'assistant' &&
      Array.isArray(m.content) &&
      (m.content as Array<{ type?: string }>).some((block) => block.type === 'tool_use')
    ))
    .map((m) => {
      const text = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? (m.content as Array<{ type?: string; text?: string }>)
            .filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text as string)
            .join(' ')
          : ''
      return { role: m.role as 'user' | 'assistant', text: text.trim() }
    })
    .filter((turn) => turn.text.length > 0)
    .slice(-6)

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
    !externalGuest &&
    adaptiveResearchEnabled &&
    messageText &&
    assistant.workspaceId &&
    workspacePlan !== 'free' &&
    budgetStatus !== 'downgraded'
  ) {
    try {
      const { classifyResearchIntent } = await import('@use-brian/core')
      const adaptive = await classifyResearchIntent({
        provider: backgroundProvider,
        message: messageText,
        model: backgroundLaneModel,
        recentConversation: adaptiveRecentConversation,
      })
      if (adaptive.research) {
        effectiveModelAlias = 'research'
        adaptiveResearchActive = true
      }
    } catch (err) {
      console.warn(`[${channelType}] adaptive-research classifier failed:`, err)
    }
  }
  const { logicalModel, logicalTier, servingModel: model } = resolveChatModelSelection(
    effectiveModelAlias,
    workspacePlan,
    budgetStatus,
    params.configuredProviders,
  )
  const resolvedCustomLlm = assistant.workspaceId && params.resolveWorkspaceCustomLlm
    ? await params.resolveWorkspaceCustomLlm({
        workspaceId: assistant.workspaceId,
        requestedTier: logicalTier,
        allowDefault: true,
      })
    : null
  // The same policy object the chat route uses, deliberately: one rule about
  // images and a route that cannot read them, decided in one place. A channel
  // user has even less recourse than a web one (no model picker at all), and
  // a channel turn never carries an explicit `custom:<id>`, so the refusal
  // here is only ever the nothing-to-fall-back-to case.
  const imageRoute = decideImageTurnRoute({
    route: resolvedCustomLlm,
    turnHasImage: userContentBlocks.some((block) => block.type === 'image'),
    explicitCustomSelection: false,
    builtInServable: !params.configuredProviders
      || (() => {
        const row = registryRow(model)
        return row ? isRegistryModelAvailable(row, params.configuredProviders) : false
      })(),
  })
  // Announced, never silent - see CUSTOM_MODEL_IMAGE_FALLBACK_NOTICE. The
  // ordinary path archives the inbound message a few lines below, so the
  // fallback needs no archive of its own.
  let imageFallbackNotice: string | null = imageRoute === 'fall_back_to_builtin'
    ? CUSTOM_MODEL_IMAGE_FALLBACK_NOTICE
    : null
  const customLlmRuntime = imageRoute === 'serve_on_route' ? resolvedCustomLlm : null
  if (imageRoute === 'refuse') {
    // Archive BEFORE refusing. This return used to happen first, so an image
    // sent to a workspace on a custom endpoint left no message row and no
    // bytes — the user saw only "Something went wrong" and the content was
    // gone for good. Provider media is not re-fetchable (WeChat's iLink CDN
    // copy is short-lived and AES-encrypted), so a MODEL capability limit
    // must never decide whether the archive keeps the message: an assistant
    // that cannot look at an attachment is a different thing from a record
    // that no longer exists. Same rule the store applies to embedding and
    // extraction failures — see brian-message-store docs/architecture.md
    // → "Failure behavior".
    if (params.archiveIncoming && !params.archiveInboundAlreadyPersisted) {
      try {
        await appendInboundChatArchive({
          source: channelType,
          // See the persist-inbound archive below — `ownerId` is NULL for a
          // workspace-owned assistant against a field typed `string`.
          ownerUserId: billingUserId,
          workspaceId: assistant.workspaceId,
          connectorInstanceId: params.archiveConnectorInstanceId,
          assistantId: assistant.id,
          assistantName: assistant.name,
          conversationId: channelId,
          message: params.archiveIncoming,
        })
      } catch (err) {
        // Losing the archive row is bad, but failing the whole turn here
        // would replace one silent loss with a worse one: the user would
        // not even get the explanation below.
        console.warn(`[${channelType}] archive-on-refusal failed:`, err)
      }
    }
    // The exact string is load-bearing: channelUserErrorText whitelists it
    // by identity so every channel's sendError surfaces it verbatim.
    await hooks.sendError(new Error(CUSTOM_MODEL_IMAGE_REJECTION))
    return
  }
  const turnProvider = customLlmRuntime?.provider ?? provider
  // The model analytics must NAME, which is not the one the tier resolved.
  // `model` is the platform tier's serving model; on a workspace custom
  // endpoint `turnProvider` is swapped out and the provider pins its own wire
  // id, so `model` never reaches a provider at all. Labelling an event with it
  // points an investigator at a model that did not run: on 2026-08-24 a
  // `channel_delivery_empty` blamed `gemini-3.7-flash` for a turn actually
  // served by `custom:646340b5`. `turn_completed` already reports the truth via
  // `event.response.model`; this is the same answer for the events that fire
  // before a response exists to read it from.
  const analyticsModel = customLlmRuntime?.selector ?? model
  // Tier budget (chat-route parity) — research mode gets 100/100. Other
  // tiers inherit the queryLoop defaults via `null`.
  const tierBudget = chatTierBudget({ model: logicalModel, researchMode: adaptiveResearchActive })

  // v2 (brain_extraction_v2_enabled): per-turn regex pattern extraction
  // retired. Channel-side facts (Slack / Telegram / Feishu-Lark / WhatsApp) now land
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

  const storedReply = await resolveReplyText({
    channelType,
    replyToMessageId: replyToMessageId ?? null,
    session,
    raw: replyRaw,
  })
  const replyResolved = storedReply ?? (
    params.realtimeThreadTarget?.contextText
      ? { text: params.realtimeThreadTarget.contextText, fromAssistant: true }
      : null
  )

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
      provider: backgroundProvider,
      // Background lane (see the chat.ts counterpart) — Flash Lite per
      // cost-and-pricing.md → "Standard-tier routing", not the Flash 3
      // chat alias this had drifted onto.
      model: backgroundLaneModel,
      recentUserTurns,
      replyToText: replyResolved?.text ?? null,
      currentMessage: messageText,
      knownTopicsThisSession: knownTopics,
    })
  } catch (err) {
    console.error(`[${channelType}] topic classifier failed:`, err)
  }

  // ── Persist inbound message (with topic label + reply context) ──
  const persistUserMessage = (client?: Parameters<typeof addSessionMessage>[1]) =>
    addSessionMessage({
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
    }, client)
  const userMessageRow = params.archiveIncoming && !params.archiveInboundAlreadyPersisted
    ? await persistInboundChatArchive({
        source: channelType,
        // `billingUserId`, not `ownerId`: the archive's `LiveArchiveContext`
        // declares `ownerUserId: string`, and on a workspace-owned assistant
        // `ownerId` is NULL. It survives that today (the binding resolves off
        // `workspaceId`, and `connector_instance.created_by` / the outbox's
        // `owner_user_id` are both nullable) — but it was writing a null into a
        // field typed non-null, and the workspace owner is the correct value.
        ownerUserId: billingUserId,
        workspaceId: assistant.workspaceId,
        connectorInstanceId: params.archiveConnectorInstanceId,
        assistantId: assistant.id,
        assistantName: assistant.name,
        conversationId: channelId,
        message: params.archiveIncoming,
      }, persistUserMessage)
    : await persistUserMessage()

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

  // Attribute classifier tokens as overhead against the billing party (channel
  // users don't pay for auxiliary LLM calls). See
  // docs/architecture/channels/channel-user-identity.md → "Billing split".
  // `billingUserId`, never `ownerId` — see the resolution above.
  await recordOverheadUsage({
    usageStore,
    userId: billingUserId,
    actorUserId: userId,
    assistantId: assistant.id,
    sessionId: session.id,
    userMessageId: userMessageRow.id,
    model: classification?.model ?? null,
    usage: classification?.usage,
    source: 'overhead:classifier',
    ...backgroundUsageAttribution,
  })

  // Voice transcription ran in the channel handler before the pipeline —
  // usage is attributed here so it lands alongside the classifier row.
  if (voiceTranscriptionUsage) {
    await recordOverheadUsage({
      usageStore,
      userId: billingUserId,
      actorUserId: userId,
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
  const workflowProposalReceipt = latestWorkflowProposalReceipt(dbMessages)

  // ── Proactive compaction (messaging: 0.5× threshold + multi-topic profile) ──
  // runProactiveCompaction owns stamping + tool-result pairing + summary
  // prepending internally. See docs/architecture/context-engine/compaction.md.
  const compactionResult = await runProactiveCompaction({
    sessionMessages: dbMessages,
    timezone: userTimezone,
    session,
    tier: modelToCompactionTier(logicalModel),
    channelClass: 'messaging',
    profile: 'multi-topic',
    provider: backgroundProvider,
    model: backgroundLaneModel,
    inputTokenLimit: backgroundLlmRuntime?.inputTokenLimit,
    ...backgroundUsageAttribution,
    systemPrompt,
    assistantId: assistant.id,
    userId,
    // `ProactiveCompactionParams.ownerId` is a usage-attribution field and
    // nothing else — its only two readers are the `overhead:extraction` and
    // `overhead:compaction` rows in proactive-compaction.ts, both
    // `userId: ownerId`. Handing it the raw `ownerId` gave those rows the same
    // NOT NULL violation the classifier row had; they just fire less often.
    ownerId: billingUserId,
    channelType,
    memoryStore,
    episodicStore,
    sessionStateStore,
    analytics,
    usageStore,
    userMessageId: userMessageRow.id,
    persistLongTermContext: !externalGuest,
    compartments: turnScope.writeCompartments,
    projectIds: turnScope.writeProjectIds,
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
  // ── Memory context (identified users only) ──
  // Per-turn callers use the ranked+capped index slice. See
  // docs/architecture/context-engine/memory-system.md → "Index cap".
  let memoryContext = ''
  if (isIdentified) {
    const viewerCtx = turnScope.access
    const [soul, identityMemories, rankedIndex] = await Promise.all([
      memoryStore.getSoul(assistant.id, userId, 'Use Brian'),
      memoryStore.getIdentity(viewerCtx),
      memoryStore.getIndexRanked(viewerCtx, PER_TURN_INDEX_CAP),
    ])
    noteAutomaticScopeEvidence(scopeAccumulator, [...identityMemories, ...rankedIndex.rows])
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
      noteAutomaticScopeEvidence(scopeAccumulator, [...workspaceIdentityMems, ...workspaceIdx])
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
      channelId: sessionChannelId,
    })
    groupChatContext = buildGroupChatContextPrompt(channelMessages, userId)
  }

  // ── Episodic context (topic-scoped history for resume/cross-topic) ──
  let episodicContext: string | null = null
  if (!externalGuest && episodicStore && classification) {
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
  const activeCapabilities = externalGuest
    ? new Set<string>()
    : new Set(await capabilityStore.listActive(assistant.id))

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
          projectIds: turnScope.effectiveProjectIds,
        },
        PER_TURN_FILES_INDEX_CAP,
      )
      noteAutomaticScopeEvidence(scopeAccumulator, rows)
      workspaceFilesContext = buildWorkspaceFilesContext(rows)
    } catch (err) {
      console.error(`[${channelType}] workspace-files index fetch failed:`, err)
    }
  }

  // Brand L1 digest (docs/architecture/features/brand.md). The gates
  // (capability + an APPROVED default brand) and the store live in
  // `resolveBrandContext`, so every channel shares one chokepoint instead of
  // each webhook factory forwarding a store.
  const brandContext = externalGuest
    ? null
    : await resolveBrandContext({
        userId,
        workspaceId: assistant.workspaceId,
        hasCapability: activeCapabilities.has('brand'),
        logLabel: channelType,
      })

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
  if (assistant.workspaceId && !externalGuest) {
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

  const decisionPlaybookContext = await loadDecisionPlaybookContext({
    workspaceId: assistant.workspaceId ?? null,
    assistantId: assistant.id,
    actorUserId: userId,
    externalPrincipal: externalGuest,
    operationKind: 'channel_turn',
    operationId: userMessageRow.id,
    sourceKind: 'session_message',
    sourceId: userMessageRow.id,
    channelType,
    analytics,
    logLabel: channelType,
  })
  const playbookRules = decisionPlaybookContext.playbookRules

  // Provenance split: hidden application metadata remains in the trusted
  // system channel. Only the replied-to quote — content the user can see in
  // the messaging client — may prefix the newest user turn. This deliberately
  // accepts lower implicit-cache reuse for changing private metadata; moving
  // it into a user-role envelope caused the 2026-08-01 referent leak.
  const splitPrompt = buildSplitSystemPrompt({
    basePrompt: systemPrompt,
    charter: resolveCharter(assistant),
    playbookRules,
    workspaceEvolutionSnippet,
    currentDateTime,
    timezone: userTimezone,
    anchorTimezone,
    // Who is speaking, stated as application fact. `isIdentified` means the
    // route positively resolved the sender (linked account, email-matched
    // channel user, or the owner on an owner-only path); anonymous shadow
    // senders and external guests get no line and keep the group-context
    // labels as their only attribution. Without this the model has to guess
    // "me" among the roster it knows from team memory — 2026-08-19, Slack:
    // "how many open tasks do I have?" was answered from a TEAMMATE's
    // assignee id, and the "2 open" / "21 total" numbers that followed were
    // all that teammate's. See layer-1-system-prompt.md → "Speaker identity".
    // `actorChannelId` (Slack `U…`, Telegram handle/id, Feishu/Lark open id, WhatsApp number) rides
    // along so "what is my Slack id" is answered as fact, not guessed.
    speakerIdentity: isIdentified && !externalGuest
      ? speakerIdentityFromUser(channelUser, { type: channelType, id: actorChannelId ?? null })
      : null,
    memoryContext,
    workspaceFilesContext,
    brandContext,
    sessionStateBlock,
    episodicContext,
    topicHint: classification,
    replyContext: replyResolved
      ? { text: replyResolved.text, fromAssistant: replyResolved.fromAssistant }
      : null,
    groupChatContext,
  })
  // Everything appended below remains in the trusted system channel.
  let fullSystemPrompt = splitPrompt.stablePrompt
  const privateRuntimeContextParts = splitPrompt.privateRuntimeContext
    ? [splitPrompt.privateRuntimeContext]
    : []
  const activeWorkspaceContext = formatActiveWorkspaceContext(turnScope)
  if (activeWorkspaceContext) privateRuntimeContextParts.push(activeWorkspaceContext)
  if (params.realtimeThreadTarget) {
    const bound = params.realtimeThreadTarget.taskIds.length > 0
      ? params.realtimeThreadTarget.taskIds.map((id) => `- ${id}`).join('\n')
      : '- none (conversation only; task writes are out of scope)'
    privateRuntimeContextParts.push(
      '# Temporary realtime thread authority\n\n' +
      `The user or an authorized workflow opened this exact ${channelType} thread until ${params.realtimeThreadTarget.expiresAt.toISOString()}. ` +
      'Treat this reply as addressed to you even without a mention. Resolve short references against the visible replied-to message. ' +
      'Task tools independently enforce the workspace rules and exact bound task lineages; do not create or change another task, and ask when the intended bound task is ambiguous.\n\n' +
      `Bound task lineage ids:\n${bound}`,
    )
  }
  if (externalGuest) {
    privateRuntimeContextParts.push(
      '# External guest boundary\n\n' +
      `You are talking with an external guest through ${channelType}. ` +
      'They are not a workspace member. Keep the conversation within the information they provide in this isolated chat, and do not claim access to workspace memory, files, or private company context.' +
      (externalGuestConnectorTools
        ? ' You may use the connected tools available in this turn.'
        : ' Connected tools are not available in this turn.'),
    )
  }
  // ── Non-member sender boundary ──
  // The sender resolved to a REAL platform user (or a shadow) that is not a
  // member of this assistant's workspace: an `assistant_members` row but no
  // `workspace_members` row. Every workspace-scoped read (workflows, tasks,
  // pages, brain, CRM) then returns empty or "not found" under RLS, and
  // without this block the model reports that as fact ("no workflows in
  // this workspace yet") and cannot even name the workspace. The classic
  // cause is an identity mismatch: the channel-revealed email (a company
  // Slack address) is not the email of the account the person actually
  // uses. The fact must travel with the turn so the reply names the cause
  // and the remedy instead of the symptom. One PK lookup per channel turn.
  // See docs/architecture/channels/channel-user-identity.md → "Non-member
  // senders".
  if (assistant.workspaceId && !externalGuest) {
    const senderRole = await getWorkspaceRoleSystem(userId, assistant.workspaceId)
    if (senderRole === null) {
      privateRuntimeContextParts.push(
        buildNonMemberSenderBlock({
          channelType,
          senderEmail: channelUser?.email ?? null,
          senderName: channelUser?.name ?? null,
        }),
      )
    }
  }
  let activeEmailDraftContext = ''
  if (params.crmEmailDraftStore && assistant.workspaceId && !externalGuest && activeCapabilities.has('crm')) {
    try {
      const activeEmailDraft = await params.crmEmailDraftStore.getActiveForSession({
        userId,
        workspaceId: assistant.workspaceId,
        sessionId: session.id,
      })
      if (activeEmailDraft) {
        activeEmailDraftContext = formatActiveEmailDraftContext(activeEmailDraft)
      }
    } catch (err) {
      console.error(`[${channelType}] active email draft fetch failed:`, err)
    }
  }
  const userVisibleContext = [
    splitPrompt.userVisibleContext,
    params.providerVisibleContext?.trim() ?? '',
    activeEmailDraftContext,
  ].filter((part) => part.length > 0).join('\n\n')

  // ── Uploaded-file save policy ──
  // Shared with chat.ts. Channels are where this matters MOST — a photo sent
  // to Telegram/WhatsApp is the common "forward this for me" case — yet the
  // block was web-only until 2026-08-06. Tool-agnostic and capability-gated
  // (returns '' without `files`), so appending is unconditional.
  fullSystemPrompt += buildUploadPolicyBlock(activeCapabilities.has('files'))

  // ── Channel formatting hints ──
  if (channelType === 'whatsapp') {
    fullSystemPrompt += `\n\n# Formatting\nYou're on WhatsApp. Supported: *bold*, _italic_, ~strikethrough~, \`code\`, \`\`\`code blocks\`\`\`, > quotes, and lists. NOT supported: tables, headers (#), links ([text](url)). For comparisons, use bullet lists or numbered lists instead of tables.`
  }

  // ── Tools: capability filter + memory ──
  const { saveMemory, getMemory, deleteMemory } = createMemoryTools(memoryStore, {
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
  const allTools = externalGuest
    ? new Map<string, Tool>()
    : filterToolsByCapabilities(new Map(tools), activeCapabilities)
  if (!externalGuest) {
    allTools.set('saveMemory', saveMemory)
    allTools.set('getMemory', getMemory)
    allTools.set('deleteMemory', deleteMemory)
  }

  // Tasks (Q1) + CRM (Q2) are constructed at boot in apps/api/src/index.ts
  // and arrive via `tools`. Per-assistant visibility is gated by §17
  // capability grants ('tasks' / 'crm') applied above by
  // filterToolsByCapabilities — no per-turn injection here.

  if (sessionStateStore && !externalGuest) {
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
  // `getConnectorUserId` returns the workspace owner when a workspace is bound
  // and its `baseUserId` argument otherwise — the same two branches
  // `billingPartyForAssistant` took above, so passing `billingUserId` resolves
  // identically to the old `ownerId` on every non-null case and stays non-null
  // on the workspace-owned case where `ownerId` is NULL.
  const connectorUserId = connectorToolsAllowed
    ? await getConnectorUserId(billingUserId, assistant.workspaceId)
    : userId
  let unavailableCapabilities: string[] = []
  if (connectorToolsAllowed && connectorStore && mcpSettingsStore) {
    // Built every turn so local filesystem sources remain writable even when
    // GitHub credential stores are absent. GitHub targets fail closed without
    // the optional credential provider.
    const knowledgeRepoWriter = createKnowledgeRepoWriter({
      store: createDbKnowledgeStore(),
      syncCredentials: connectorInstanceStore && connectorGrantStore
        ? createSyncCredentialProvider(connectorInstanceStore, connectorGrantStore)
        : undefined,
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
        knowledgeCaptureRuleStore,
        knowledgeRepoWriter,
        allowKnowledgeWrites: true,
        knowledgeCaptureText: params.rawUserText ?? messageText,
        gdriveFilesStore,
        connectorGrantStore,
        connectorInstanceStore,
        workspaceToolPolicyStore,
        assistantTeamId: assistant.workspaceId ?? null,
        contextScope: turnScope,
        // Workspace-files byte layer — `gmailSendMessage` attachments on
        // channel turns (docs/architecture/integrations/gmail.md).
        filesApi,
        readCachedFile,
        // Actor identity for opted-in connectors. `actorChannelId` is the
        // channel-native id captured from the inbound webhook by the channel
        // route (Slack user id / Telegram @handle / Feishu-Lark open id / WhatsApp phone); email +
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
      if (injection.knowledgeCapturePrompt) {
        privateRuntimeContextParts.push(injection.knowledgeCapturePrompt)
      }
    } catch (err) {
      console.error(`[${channelType}] MCP tool injection failed:`, err)
    }
  }

  // ── Skills ──
  if (skillStore && !externalGuest) {
    // Slash command (`/goal register …` as the whole message) — same seam as
    // the web chat route: the name is threaded as an enforced skill slug, the
    // governance gates apply inside injectSkills, and an unresolved name
    // enforces nothing so the message stays plain text. This is what makes
    // `/goal` work identically from Telegram / Slack / any adapter.
    const slashCommand = parseSlashCommand(messageText)
    const skillResult = await injectSkills({
      enforceSlugs: slashCommand ? [slashCommand.name] : undefined,
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
      // Both stores were missing here until mig 491, so on every messaging
      // channel a workspace skill was gated ONLY by the legacy slug-keyed
      // `assistant_skill_settings` table: the `workspace_skill_enablement`
      // allowlist was invisible, and so was the `all_assistants` flag. The
      // result was a skill that worked in web chat and silently did not on
      // Telegram / Slack / WhatsApp / Discord — with every layer looking
      // correct and only the user able to tell.
      //
      // Defaulted from the factories rather than threaded, because nine
      // channel routes each re-declare and forward the pipeline's stores by
      // hand; a store one of them forgot is exactly the silent per-channel gap
      // being fixed here. Both factories are stateless (they close over
      // `query`), same as `createDbKnowledgeStore` above. An injected store
      // still wins, so tests keep their fakes.
      workspaceSkillStore: workspaceSkillStore ?? createDbWorkspaceSkillStore(),
      workspaceSkillEnablementStore:
        workspaceSkillEnablementStore ?? createDbWorkspaceSkillEnablementStore(),
    })
    fullSystemPrompt += skillResult.promptFragment
    if (slashCommand && skillResult.enforcedPromptFragment) {
      fullSystemPrompt += skillResult.enforcedPromptFragment
      privateRuntimeContextParts.push(buildSlashCommandBlock(slashCommand))
    }
  }
  fullSystemPrompt += buildUnavailableCapabilitiesPrompt(unavailableCapabilities, allTools)
  fullSystemPrompt += buildBrowserEscalationPrompt(allTools)
  fullSystemPrompt += buildEmailDraftAnchorPrompt(allTools)

  // ── Pre-flight-confirm reply correlation (channel-recording-preflight-confirm §6) ──
  // If a big recording in THIS conversation is awaiting the user's confirmation,
  // inject a context note so the model can interpret the reply and call
  // `confirmRecordingProcessing` with the right recordingId. The note carries the
  // file label, duration, credit cost, and the default blueprint id so the model
  // can map "yes / the default" to the right choice. Per-turn dynamic injection —
  // not in Layer 1 (the tool name only appears here, when a pending row exists).
  {
    try {
      const channelSessionKey = buildChannelSessionKey({
        channel: channelType,
        channelId: sessionChannelId,
        userId,
      })
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

  // ── Live watch feed (live-work.md §5.2) ──
  // Channel turns have no direct client stream, so the session bus is the
  // ONLY live view of this turn — publish unconditionally (D6), same
  // throttle/cap discipline as routes/chat.ts via the shared publisher.
  // The bus is LISTEN/NOTIFY cross-instance, so a watch relay on brian-api
  // receives turns running here or on brian-api-workers.
  const turnStream = createTurnStreamPublisher({
    sessionId: session.id,
    publishSessionEvent,
    attribution: () => ({ senderUserId: userId, assistantId: assistant.id }),
  })
  const publishChannelActivity = (event: string, data: Record<string, unknown>): void =>
    publishRoomTurnActivity({
      mirror: true,
      sessionId: session.id,
      senderUserId: userId,
      event,
      data,
      publishSessionEvent,
    })

  // ── Outbound attachments (sendFile) ──
  // Only wired when filesApi is present — without it the pipeline could
  // collect intent it can never resolve to bytes, and `sendFile`'s
  // missing-collector gate gives the model an honest error instead.
  const attachmentCollector = filesApi && !externalGuest ? new AttachmentCollector() : undefined

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
    // A channel has no `notice` lane, so an announced fallback has to travel
    // in the message itself - once, on the first thing the user sees, then
    // cleared so a multi-part reply does not repeat it.
    const noticed = imageFallbackNotice ? `${imageFallbackNotice}\n\n${text}` : text
    imageFallbackNotice = null
    const result = await hooks.sendResponse(noticed, documents)
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
    if (lastFlushedAssistantRowId && params.archiveIncoming) {
      await appendOutboundChatArchive({
        source: channelType,
        // See the inbound archive above — `ownerId` is NULL for a
        // workspace-owned assistant against a field typed `string`.
        ownerUserId: billingUserId,
        workspaceId: assistant.workspaceId,
        connectorInstanceId: params.archiveConnectorInstanceId,
        assistantId: assistant.id,
        assistantName: assistant.name,
        conversationId: channelId,
        sessionMessageId: lastFlushedAssistantRowId,
        providerMessageId: channelMessageId,
        text,
        documents,
        replyToProviderId: params.archiveIncoming.messageId ?? null,
      })
    }
  }

  // ── Preflight research ──
  let preflightContext = ''
  if (!externalGuest && messageText.length > 40) {
    try {
      const preflight = await runPreflight({
        provider: backgroundProvider, model: backgroundLaneModel, message: messageText, tools: allTools,
        context: {
          userId, assistantId: assistant.id, sessionId: session.id,
          appId: 'Use Brian', channelType, channelId,
          channelSessionId: sessionChannelId,
          taskAuthority,
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
  let systemPromptWithPreflight = fullSystemPrompt
  if (preflightContext) {
    privateRuntimeContextParts.push(
      buildPreflightPrompt('', preflightContext).replace(/^\n+/, ''),
    )
  }

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
        privateRuntimeContextParts.push(
          `# Figure provenance (dispute check)\n\n${buildDisputeContextNote(priorClaims)}`,
        )
      }
    } catch (err) {
      console.warn(`[${channelType}] dispute pre-pass failed, continuing without:`, err)
    }
  }

  const privateRuntimeBlock = formatPrivateRuntimeContext(
    privateRuntimeContextParts.filter((s) => s.trim().length > 0).join('\n\n'),
  )
  if (privateRuntimeBlock) {
    systemPromptWithPreflight = `${systemPromptWithPreflight}\n\n${privateRuntimeBlock}`
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
  // The replied-to quote is represented on the user turn, so seed that
  // visible material explicitly as evidence too.
  replyEvidence.note(userVisibleContext)
  replyEvidence.note(messageText)

  // Attach only user-visible context to the newest user message. When the
  // trailing message cannot carry it, retain the same provenance marker in
  // the trusted prompt for this rare resume shape.
  const envelopedMessages = attachUserVisibleContext(messages, userVisibleContext)
  if (envelopedMessages) {
    messages = envelopedMessages
  } else if (userVisibleContext) {
    systemPromptWithPreflight =
      `${systemPromptWithPreflight}\n\n${formatUserVisibleContext(userVisibleContext)}`
  }

  // Claim ledger stash — persisted after flushBufferedTurns (which creates
  // the assistant message row) and BEFORE sendResponse, so the linkage
  // exists before the user sees the reply.
  let pendingClaimLedger: Extract<
    import('@use-brian/core').QueryEvent,
    { type: 'claim_ledger' }
  >['claims'] | null = null
  const acknowledgedGoalIds = new Set<string>()

  // ── Query loop ──
  try {
    const scopedTools = bindToolsToAgentAccess(allTools, {
      clearance,
      compartments: turnScope.effectiveCompartments,
      projectIds: turnScope.effectiveProjectIds,
    })
    for await (const event of queryLoop({
      ledger: createTurnLedger({
        workspaceId: assistant.workspaceId ?? null,
        assistantId: assistant.id,
        sessionId: session.id,
        payloads: getLedgerPayloadStore(),
      }).ledger,
      provider: turnProvider, model,
      maxTokens: customLlmRuntime?.maxTokens,
      inputTokenLimit: customLlmRuntime?.inputTokenLimit,
      systemPrompt: systemPromptWithPreflight,
      messages, tools: scopedTools,
      context: {
        userId, assistantId: assistant.id, sessionId: session.id,
        appId: 'Use Brian', channelType, channelId,
        channelSessionId: sessionChannelId,
        taskAuthority,
        workspaceId: assistant.workspaceId ?? undefined,
        workerRuntime: customLlmRuntime
          ? {
              provider: customLlmRuntime.provider,
              model: customLlmRuntime.selector,
              modelTier: customLlmRuntime.modelTier,
              providerKeySource: customLlmRuntime.providerKeySource,
              inputTokenLimit: customLlmRuntime.inputTokenLimit,
              maxTokens: customLlmRuntime.maxTokens,
            }
          : undefined,
        assistantKind: assistant.kind,
        preferredChannel,
        userTimezone,
        workflowProposalReceipt,
        abortSignal: abortController.signal,
        sessionStateStore,
        requestTools: allTools,
        workerManager,
        activeCapabilities,
        outboundAttachments: attachmentCollector,
        channelDocumentsSupported: params.channelDocumentsSupported,
        sensitivity: sensitivityAccumulator,
        compartmentAccumulator,
        scopeAccumulator,
        evidence: replyEvidence,
        // `clearance` is the read ceiling = min(member, assistant);
        // `assistantClearance` is the write ceiling (the assistant's tier).
        clearance,
        compartments,
        projectIds: turnScope.effectiveProjectIds,
        activeGroupId: turnScope.activeGroupId,
        activeProjectId: turnScope.activeProjectId,
        assistantClearance: assistant.clearance,
        assistantCompartments: turnScope.effectiveCompartments,
        assistantDefaultCompartments: turnScope.writeCompartments,
        assistantProjectIds: turnScope.effectiveProjectIds,
        assistantDefaultProjectIds: turnScope.writeProjectIds,
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
          // Live watch mirror: the snapshot is the full reply-so-far, never
          // these deltas, so the deliverable-assembly rule stays intact.
          turnStream.onTextDelta(event.text)
          break
        case 'thinking_delta':
          // No channel delivers reasoning; the watch pane folds the live
          // tail through the same reducer room viewers use (T13).
          turnStream.onReasoningDelta(event.text)
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
              model: sanitizeAnalytics(analyticsModel),
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
          publishChannelActivity('status', { message: event.message })
          break
        case 'tool_start':
          await hooks.onToolStart?.(event.id, event.name)
          turnStream.onToolStart(event.name)
          publishChannelActivity('tool_start', { id: event.id, name: event.name })
          break
        case 'tool_input':
          await hooks.onToolInput?.(event.id, event.name, event.input)
          publishChannelActivity('tool_input', { id: event.id, name: event.name, input: event.input })
          break
        case 'tool_result':
          recordChannelToolResults({
            results: event.results,
            metaByToolUseId: event.metaByToolUseId,
            analytics,
            usageStore,
            userId,
            billingUserId,
            assistantId: assistant.id,
            sessionId: session.id,
            workspaceId: assistant.workspaceId,
            userMessageId: userMessageRow.id,
            userPlan: workspacePlan,
            channelType,
          })
          await hooks.onToolResult?.(event.results)
          for (const block of event.results) {
            if (block.type === 'tool_result') {
              publishChannelActivity('tool_result', {
                id: block.toolUseId,
                name: block.name,
                isError: block.isError ?? false,
              })
            }
          }
          for (const goalId of acceptedGoalIdsFromToolResults(
            event.results,
            event.metaByToolUseId,
          )) {
            if (acknowledgedGoalIds.has(goalId)) continue
            acknowledgedGoalIds.add(goalId)
            // The goal is already running. A transient channel-send failure
            // must not unwind the durable kickoff or abort the final reply.
            try {
              await hooks.onGoalAccepted?.(GOAL_ACCEPTED_CHANNEL_MESSAGE, goalId)
            } catch {
              // Best-effort acknowledgement only; the final response still
              // has its own authoritative delivery/error handling below.
            }
          }
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
                model: sanitizeAnalytics(analyticsModel),
              },
            })
            pendingClaimLedger = null
          }
          // Strip the trailing <followup>[…]</followup> tag — messaging
          // channels (Telegram, Slack, WhatsApp, Feishu/Lark) have no chip affordance,
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
          // suppressed text) — the very leak this assembly closes. An empty
          // bubble is still not the answer, but neither is SILENCE: to the
          // person on the other end it is indistinguishable from being
          // ignored, so they cannot tell a broken backend from a bot that
          // chose not to reply, and they re-ask into the same hole. That is
          // the 2026-08-24 Telegram case — a workspace custom endpoint
          // returned a clean 200 with no content and no usage on every
          // attempt, `EMPTY_RETRY_PLAN` spent both retries against it, and the
          // user got nothing back twice while a "Hi" in the same session
          // answered fine. This branch is the interactive-lane analogue of
          // the callee lane's typed `empty_response` throw: a human cannot be
          // handed an error object, so they are handed a sentence. Every
          // caller of this pipeline across BOTH trees is an attended surface
          // with a person waiting on a reply — the open channel routes, and
          // the closed `api-platform` telegram / whatsapp / agentmail routes,
          // which are thin layers over this same function rather than forks
          // of it. No cron, workflow, or A2A lane reaches here, so there is no
          // unattended surface for the notice to spam.
          if (!outboundText && documents.length === 0) {
            const emptyReason = classifyEmptyDelivery({
              window: pendingAssistantTurns.slice(deliveryCutIdx),
              retractedCount: deliveryCutIdx,
            })
            console.warn(
              `[${channelType}] no deliverable text at turn_complete (session ${session.id}, reason ${emptyReason})`,
            )
            analytics?.logEvent({
              userId, assistantId: assistant.id, sessionId: session.id,
              eventName: 'channel_delivery_empty', channelType,
              metadata: {
                turns: pendingAssistantTurns.length,
                reason: sanitizeAnalytics(emptyReason),
                model: sanitizeAnalytics(analyticsModel),
              },
            })
            // `tools_only` is the one reason where "try again" is the wrong
            // advice: a tool may already have shipped a side effect, so the
            // user needs to CHECK, not resend. That is exactly what
            // `composeRecoveryMessage` exists for on the catch path, and it
            // matches the user's language while it is at it. It returns null
            // when no tool actually succeeded (nothing to describe, and a
            // retry is safe after all) and on any synthesis failure, both of
            // which fall through to the fixed notice. It runs on the
            // background provider on purpose: the endpoint that just produced
            // nothing must not also decide whether the user hears about it.
            const recovered = emptyReason === 'tools_only'
              ? await composeRecoveryMessage({
                  provider: backgroundProvider,
                  pendingAssistantTurns,
                  userText: messageText,
                  channelType,
                })
              : null
            if (recovered) {
              await recordOverheadUsage({
                usageStore,
                userId: billingUserId,
                actorUserId: userId,
                assistantId: assistant.id,
                sessionId: session.id,
                userMessageId: userMessageRow.id,
                model: recovered.model,
                usage: recovered.usage,
                source: 'overhead:recovery-message',
                triggerKey: 'recovery_message',
                ...backgroundUsageAttribution,
              })
            }
            // Not persisted as an assistant row. `flushBufferedTurns` has
            // already run and skips zero-content turns, so there is nothing to
            // append this to, and the catch path's recovery message has the
            // same shape. The consequence is real and deliberate: the model
            // does not see this sentence on the next turn.
            await sendResponseAndStampChannelId(recovered?.text ?? EMPTY_DELIVERY_NOTICE)
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
          if (usage) {
            const cost = customLlmRuntime?.providerKeySource === 'user'
              ? 0
              : calculateCost(event.response.model, usage)
            if (usageStore) {
              usageStore.recordUsage({
                userId: billingUserId, actorUserId: userId, assistantId: assistant.id, sessionId: session.id,
                model: event.response.model,
                modelTier: logicalTier,
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
                providerKeySource: customLlmRuntime?.providerKeySource ?? 'platform',
              }).catch((err) => console.error(`[${channelType}] Usage tracking failed:`, err))
            }

            analytics?.logEvent({
              userId, assistantId: assistant.id, sessionId: session.id,
              eventName: 'turn_completed', channelType,
              metadata: {
                model: sanitizeAnalytics(event.response.model),
                input_tokens: usage.inputTokens,
                output_tokens: usage.outputTokens,
                cost_usd_micro: Math.round(cost * 1_000_000),
                cache_hits: usage.cacheReadTokens ?? 0,
                // HOW the turn ended, not just what it cost. Without this a
                // turn that halted part-way looks identical in analytics to
                // one that finished, and the only way to tell them apart is
                // to eyeball the stored text for a sentence that stops dead
                // (the 2026-08-25 Telegram truncation took fifteen queries to
                // pin for exactly this reason). Layer 5 has already spent its
                // one continuation by the time this fires, so a truncated
                // value here means the reply really did leave cut off.
                stop_reason: sanitizeAnalytics(event.response.stopReason ?? 'unknown'),
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
            provider: backgroundProvider,
            // Standard tier per docs/architecture/platform/cost-and-pricing.md
            // → Model routing (extraction / classification / structured-output bucket).
            model: backgroundLaneModel,
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
          // Same billing split as every other overhead row on this path: the
          // workspace pays, the channel user is recorded as the actor. This
          // pair used to pass the bare `userId`, which billed a (possibly
          // shadow) channel user for an auxiliary call they never asked for
          // and split one turn's overhead across two payers.
          return recordOverheadUsage({
            usageStore,
            userId: billingUserId,
            actorUserId: userId,
            assistantId: assistant.id,
            sessionId: session.id,
            userMessageId: userMessageRow.id,
            model: result.model,
            usage: result.usage,
            source: 'overhead:session-state-diff',
            triggerKey: 'session_state_diff',
            ...backgroundUsageAttribution,
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
          const resp = await collectStream(backgroundProvider.stream({
            model: backgroundLaneModel,
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
            model: backgroundLaneModel,
          }
        },
        store: memoryStore,
      })
        .then((result) => recordOverheadUsage({
          usageStore,
          userId: billingUserId,
          actorUserId: userId,
          assistantId: assistant.id,
          sessionId: session.id,
          userMessageId: userMessageRow.id,
          model: result.model,
          usage: result.usage,
          source: 'overhead:nudge',
          triggerKey: 'memory_nudge',
          ...backgroundUsageAttribution,
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
      provider: backgroundProvider,
      pendingAssistantTurns,
      userText: messageText,
      channelType,
    })
    if (recovered) {
      // Cost attribution for the Flash call. The synthesiser is paid
      // for by the billing party (same as every other overhead row),
      // not by whichever channel user happened to trigger the bail.
      await recordOverheadUsage({
        usageStore,
        userId: billingUserId,
        actorUserId: userId,
        assistantId: assistant.id,
        sessionId: session.id,
        userMessageId: userMessageRow.id,
        model: recovered.model,
        usage: recovered.usage,
        source: 'overhead:recovery-message',
        triggerKey: 'recovery_message',
        ...backgroundUsageAttribution,
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
    // Watch viewers clear their "Working" card on the terminal bus event —
    // published in the finally, not on the paths we happened to think of.
    publishTurnCompleted({ sessionId: session.id, senderUserId: userId, publishSessionEvent })
    await updateSessionStatus(session.id, 'idle')
  }
}
