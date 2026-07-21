import { Router } from 'express'
import { getDefaultAssistant, getUserAssistant, getWorkspacePrimaryAssistant, updateUserLastSeenTz } from '../db/users.js'
import { resolvePresenceTimezone } from '../auth/client-timezone.js'
import { findOrCreateSession, findSessionByChannel, findSessionById, addSessionMessage, toStampedMessages, getSessionMessages, updateSessionStatus, updateSessionTitle, countSessionTurns, truncateMessagesFrom, getPreferredChannel, getSessionTopicLabels } from '../db/sessions.js'
import { getSelfEntityId } from '../db/memories.js'
import { getRecording } from '../db/recordings-store.js'
import { queryLoop, buildMemoryContext, measureDocContext, createMemoryTools, createSelfProfileTool, createMemoryRecallBuffer, createSkillInvocationBuffer, createRetrievalTools, createSessionStateTools, buildSessionStateBlock, runSessionStateDiff, buildActivePlanBlock, createPlanTools, seedPlanFromTasks, calculateCost, sanitize, shouldInline, ensureToolResultPairing, stripUnsignedToolUses, modelRequiresToolSignatures, elideStaleDocToolResults, synthesizeMissingToolResults, createConfirmationResolver, runPreflight, buildPreflightPrompt, runMemoryNudge, collectStream, classifyTopic, fetchEpisodicContext, transcribeFirstAudio, filterToolsByCapabilities, modelToCompactionTier, decodeExternalCostMeta, buildWorkspaceFilesContext, SensitivityAccumulator, CompartmentAccumulator, AttachmentCollector, runLocalMatchCheck, sanitizeTitle, AUTO_TITLE_AI_MIN_CHARS, COORDINATOR_BASE_ADDENDUM, COORDINATOR_RESEARCH_ADDENDUM, buildDocSkillBlock, buildAmbientDocSkillBlock, detectOperateSiteIntent, EvidenceAccumulator, matchesDisputedFigure, buildDisputeContextNote, type MediaBackend } from '@use-brian/core'
import { insertClaimProvenance, getClaimsForLatestAssistantMessage } from '../db/claim-provenance-store.js'
import type { ToolResultMeta, SessionStateStore, SessionStateRecord, PlanStore, AmbientSurface } from '@use-brian/core'
import { runProactiveCompaction } from './proactive-compaction.js'
import { gateSessionRead } from './sessions.js'
import { renderArtifactManifest } from '../files/artifact-manifest.js'
import { promotePastedText, shouldPromotePaste } from '../files/paste-promotion.js'
import type { ArtifactPromoter } from '../files/artifact-promote.js'
import { recordOverheadUsage } from './_overhead-usage.js'
import { composeRecoveryMessage } from './_recovery-message.js'
import { composeEmptyTurnSynthesis } from './_empty-turn-synthesis.js'
import { resolveReplyText } from './_reply-context.js'
import { buildSplitSystemPrompt, resolveLayer1Prompt, maybeAppendFollowupChips } from './_prompt-builder.js'
import { type PublishSessionEvent, noopPublishSessionEvent } from '../session-event-port.js'
import type { InjectExtraTools, ResolveAppSoul } from '../tool-injection-port.js'
import type { BuildConnectorActionAudit } from '../connector-action-port.js'
import { notifyBrainWriteIfMatch } from '../brain-stream/notify.js'
// Host-specific seams (the real session-event bus, the placeholder-title helpers,
// the per-turn extra-tool injector) are NOT imported here — they are injected via
// WebChatOptions so the chat route depends on no platform-specific code. The
// composition root passes the real impls; the open build uses the inline
// no-op/false/null/unset defaults in chatRoutes(). See oss §12.5.
import type { Message, LLMProvider, Tool, MemoryStore, UsageStore, AnalyticsLogger, FileStore, ContentBlock, CacheStore, McpSettingsStore, ConfirmationDecision, ConfirmationResolver, TopicClassification, ClassifierRecentTurn, EpisodicStore, CapabilityStore, RetrievalStore, TranscribeResult, TokenUsage, WorkerResult, EngineHooks } from '@use-brian/core'

import { resolveModel, ensureServableModel, isStandardTier, chatTierBudget, planNudgeCap } from '../model-resolution.js'
import { registryRow } from '@use-brian/shared/model-registry'
import { buildPendingContext } from '../inter-assistant/pending-context.js'
import type { ConnectorStore } from '../db/connector-store.js'
import { getToolDisplayName, stripFollowUps, stripCommentThreadReplyTag } from '@use-brian/shared'
import { resolveUser, buildBrowserEscalationPrompt, buildUnavailableCapabilitiesPrompt, injectSkills, checkUsageBudget, applyMcpInjection, type CreditBudgetGate } from './route-helpers.js'
import { createDocRunClient } from '../doc/run-presence-client.js'
import type { AssistantRunChannel } from '@use-brian/doc-model'
import {
  FREE_RESEARCH_QUOTA,
  getConnectorUserId,
  getWorkspaceIdentity,
  getWorkspacePlan,
  getWorkspaceResearchUsed,
  incrementWorkspaceResearchUsed,
  resolveReadCeilingsSystem,
} from '../db/workspace-store.js'
import { getEvolution as getWorkspaceMemoryEvolution } from '../db/workspace-memory-evolution-store.js'
import { getBrainEvolution } from '../db/workspace-brain-evolution-store.js'
import { tryResolveSchedulerConfirmation } from '../scheduling/confirmation-registry.js'
import { detectAndResolveNags } from '../scheduling/nag-resolver.js'
import type { DeferredConfirmationStore } from '../db/deferred-confirmation-store.js'
import type { JobStore } from '@use-brian/core'
import type { PendingApprovalsStore, ApprovalKind } from '../db/pending-approvals-store.js'
import type { SessionResumeStore } from '../db/session-resume-store.js'

// Module-level map of active confirmation resolvers, keyed by sessionId.
// Cleaned up on turn_complete or stream close.
const activeResolvers = new Map<string, ConfirmationResolver>()

export function _getActiveResolversSize(): number {
  return activeResolvers.size
}

// WU-6.4 — Path B fast-path index. When a workspace-scoped tool call
// suspends, the `awaiting_approval` event carries both the persisted
// `pending_approvals` row id AND the loop-internal `toolCallId`. The
// unified approvals route resolves by `approvalId` only, so this map
// bridges `approvalId → (sessionId, toolCallId)` while the suspension is
// live. An entry is added on `awaiting_approval` and removed on
// turn_complete / stream close (the same lifecycle as `activeResolvers`).
const approvalResolverIndex = new Map<string, { sessionId: string; toolCallId: string }>()

/**
 * Fast-path hook for `enqueueToolInvocationResume` (WU-6.4). Returns
 * `true` when a live in-memory confirmation resolver for the suspended
 * session was found and notified — i.e. the chat process did NOT
 * restart, so Path A resumes the turn directly. Returns `false` when no
 * live resolver exists, which is the signal to enqueue a `session_resume`
 * job for the resume worker.
 *
 * The unified `/api/approvals/:id/respond` route already flipped the
 * `pending_approvals` row before calling this; here we only translate
 * the approve/reject decision into the `ConfirmationResolver` vocabulary
 * and fire the in-memory promise.
 */
export function tryResolveLiveToolApproval(params: {
  sessionId: string
  approvalId: string
  decision: 'approved' | 'rejected'
}): boolean {
  const entry = approvalResolverIndex.get(params.approvalId)
  if (!entry || entry.sessionId !== params.sessionId) return false
  const resolver = activeResolvers.get(entry.sessionId)
  if (!resolver) return false
  resolver.resolve(entry.toolCallId, params.decision === 'approved' ? 'allow' : 'deny')
  approvalResolverIndex.delete(params.approvalId)
  return true
}

export function _getApprovalResolverIndexSize(): number {
  return approvalResolverIndex.size
}

/**
 * Maximum non-identity memory-index rows injected into the per-turn
 * system prompt. Sized for ~1,400 input tokens at 60 rows × ~80 chars
 * + footer. Memories beyond the cap are surfaced to the model via a
 * "N more memories stored — use getMemory(...)" footer so retrieval
 * stays explicit rather than relying on full-list enumeration.
 * See docs/architecture/context-engine/memory-system.md → "Index cap".
 */
const PER_TURN_INDEX_CAP = 60

/**
 * Per-turn cap for the `# Workspace Files` L1 block (Q3 / company-brain §10).
 * Mirror in `channel-pipeline.ts` — keep in sync.
 */
const PER_TURN_FILES_INDEX_CAP = 50

/**
 * Assistant-run presence client — tells `apps/doc-sync` when a run opens/closes
 * on a doc page so it can broadcast "someone is working on this page" to every
 * connected tab. Best-effort + `undefined` when doc-sync isn't configured
 * (tests / local / smoke), so the calls below no-op there. Constructed once: it
 * only reads env.
 */
const docRunClient = createDocRunClient()

/** Map a session's channel to the assistant-run presence channel label. */
function resolveRunChannel(session: {
  channelType: string
  appOrigin: string | null
}): AssistantRunChannel {
  if (session.appOrigin === 'doc' || session.channelType === 'doc_thread')
    return 'doc'
  if (session.channelType === 'telegram') return 'telegram'
  if (session.channelType === 'slack') return 'slack'
  if (session.channelType === 'cron') return 'cron'
  if (session.channelType === 'web') return 'web'
  return 'unknown'
}

type WebChatOptions = {
  provider: LLMProvider
  /**
   * Workspace BYO LLM key store. When set together with `buildWorkspaceProvider`
   * and the turn's assistant has a workspace, the chat path resolves the
   * workspace's bring-your-own Gemini key (`getPlaintextKeySystem`) and, if
   * present, drives the main response with a provider built from that key.
   * Turns served by a BYO key are NOT billed for LLM/message usage. Absent when
   * LLM_PROVIDER_KEY_ENCRYPTION_KEY is unconfigured — chat uses `provider`.
   */
  llmProviderSettingsStore?: import('../db/workspace-llm-provider-settings.js').WorkspaceLlmProviderSettingsStore
  /**
   * Factory that builds a per-request LLM provider from a raw API key, applying
   * the same wrapping middleware as the platform `provider`. Supplied by the API
   * app alongside `llmProviderSettingsStore`.
   */
  buildWorkspaceProvider?: (apiKey: string) => LLMProvider
  systemPrompt: string
  tools: Map<string, Tool>
  memoryStore: MemoryStore
  fileStore?: FileStore
  /**
   * Silent large-content promotion (large-content-artifacts): giant pastes
   * become workspace_files artifacts + file_segments; the turn carries the
   * manifest. Boot passes the same instance the /upload route uses. Absent
   * (files-less deploy) → pastes flow through unchanged.
   */
  artifactPromoter?: ArtifactPromoter | null
  usageStore?: UsageStore
  /**
   * Doc-page → brain distillation runner (the "Sync to brain" pipeline). When
   * set, the `ingestPage` chat tool is injected on doc turns so the assistant
   * can ingest a page on request. Absent (no Pipeline B) → the tool isn't
   * injected. Built at boot; RLS-scoped to the caller. See
   * docs/architecture/brain/ingest-pipeline.md.
   */
  ingestPage?: (args: { userId: string; pageId: string }) => Promise<void>
  /**
   * Host seams DI-injected by the composition root so the chat route depends on
   * no platform-specific code (oss-local-brain-wedge.md §12.5). All optional;
   * the open build omits them and falls through to the inline defaults in
   * chatRoutes():
   *  - `checkCreditBudget`: real DB credit gate; open default = allow-all (the
   *    `usageStore` guard already skips the budget path when billing is unwired).
   *  - `publishSessionEvent`: real session-event bus; open default = no-op.
   *  - `isPlaceholderTitle` / `getTitleChannelPrefix`: host title helpers that
   *    detect an auto-generated placeholder title to regenerate + a channel
   *    prefix to preserve across a rewrite; open defaults = false / null.
   *  - `injectExtraTools`: host per-turn extra-tool injector (e.g. a
   *    publishing app's outbound tools); open default = unset.
   *  - `resolveExtraSystemPrompt`: host hook returning an extra system-prompt
   *    block for a session (e.g. a draft-session authoring addendum); open
   *    default = null (no addendum).
   *  - `resolveAppSoul`: host hook building a `kind='app'` assistant's Layer-1
   *    soul (e.g. a publishing app's soul); open default = unset (app assistants
   *    fall back to the default prompt).
   */
  checkCreditBudget?: CreditBudgetGate
  publishSessionEvent?: PublishSessionEvent
  isPlaceholderTitle?: (title: string | null | undefined) => boolean
  getTitleChannelPrefix?: (title: string | null | undefined) => string | null
  injectExtraTools?: InjectExtraTools
  resolveExtraSystemPrompt?: (session: { mode: string | null; channelType: string }) => string | null
  resolveAppSoul?: ResolveAppSoul
  /**
   * Tool-use interception port (remote MCP only), forwarded through
   * `applyMcpInjection` → `injectMcpTools` → `createMcpSearchTools`.
   * `preToolUse` can inject/overwrite outbound headers, rewrite args, or
   * block; `postToolUse` observes. Open default = unset. See
   * `docs/architecture/engine/tool-hooks.md`.
   */
  engineHooks?: EngineHooks
  analytics?: AnalyticsLogger
  cacheStore?: CacheStore
  connectorStore?: ConnectorStore
  mcpSettingsStore?: McpSettingsStore
  assistantConnectorStore?: import('../db/assistant-connector-store.js').AssistantConnectorStore
  /** Stage 4 of the team-connector promotion: enables team-exposure grant consumption. */
  connectorGrantStore?: import('../db/connector-grant-store.js').ConnectorGrantStore
  /** Stage 5: enables team-native connector_instance consumption (team-admin-configured tools). */
  connectorInstanceStore?: import('../db/connector-instance-store.js').ConnectorInstanceStore
  /** Shared workspace tool policy (migration 312) — governs team-owned connector tool allow/ask/block. */
  workspaceToolPolicyStore?: import('../db/workspace-tool-policy-store.js').WorkspaceToolPolicyStore
  workerManager?: import('@use-brian/core').WorkerManager
  /**
   * Phase 3 of askQuestion suspend-resume — persisted worker_runs store.
   * When set together with `workerManager`, each turn calls
   * `workerManager.setPersistence(...)` so worker spawn/turn/completion
   * events write to `worker_runs`. Rehydration on resume reads from the
   * same store. Optional; absent in worker / scheduled-job / smoke contexts.
   * See docs/architecture/engine/askquestion-suspend-resume.md.
   */
  workerRunsStore?: import('@use-brian/core').WorkerRunsStore
  /**
   * Metered model lane (docs/architecture/platform/model-registry.md → the
   * L8/L15 lane). All optional — the OPEN build serves metered-class picks
   * without billing (self-host pays its own provider bill); hosted injects
   * the closed billing seams:
   *  - `meteredProfileStore`: workspace-saved profiles (migration 343).
   *  - `meteredModelsAvailable`: aliases whose provider key is configured at
   *    boot — a keyless model is absent, never erroring (L12).
   *  - `estimateMeteredTurn`: cheap pre-flight estimate at a tool-round
   *    budget; returned on `metered_confirm_required` rejections.
   *  - `checkMeteredSpendCap`: per-workspace per-period ceiling (L8 guard
   *    rail); fails closed.
   *  - `chargeMeteredSurcharge`: the `5 + ceil(cost/$0.020)` debit, charged
   *    on turn completion at actual measured cost, idempotent per turn.
   */
  meteredProfileStore?: import('../db/metered-profile-store.js').MeteredProfileStore
  meteredModelsAvailable?: ReadonlySet<string>
  /**
   * Provider names configured at boot. Used to substitute a servable model
   * when the resolved default (always Gemini) has no configured provider — a
   * deployment with no Google credential (Qwen-only) then serves chat by
   * default instead of erroring. See `ensureServableModel`.
   */
  configuredProviders?: ReadonlySet<string>
  estimateMeteredTurn?: (modelAlias: string, toolRounds: number) => { modelAlias: string; toolRounds: number; minCredits: number; maxCredits: number } | null
  checkMeteredSpendCap?: (workspaceId: string) => Promise<{ allowed: boolean; usedCredits: number; capCredits: number }>
  chargeMeteredSurcharge?: (params: { workspaceId: string; requestId: string; modelAlias: string; profileId?: string | null; toolRounds?: number | null; modelCostUsd: number; chargedByUserId?: string | null }) => Promise<{ charged: boolean; credits: number }>
  knowledgeStore?: import('@use-brian/core').KnowledgeStoreInterface
  /**
   * KB repo write-back port (assistant direct edits). Chat is an
   * interactive, confirmation-capable surface, so this route passes
   * `allowKnowledgeWrites: true` to `applyMcpInjection`.
   */
  knowledgeRepoWriter?: import('@use-brian/core').KnowledgeRepoWriter
  gdriveFilesStore?: import('@use-brian/core').GDriveFilesStore
  skillStore?: import('../db/skill-store.js').SkillStore
  /**
   * CL-8 workspace-scoped skill counters. Optional today — when set
   * together with `assistant.workspaceId`, the chat route builds a
   * per-turn `SkillInvocationBuffer`, wires `recordInvocation` into the
   * `useSkill` tool, and flushes `succeeded` after the assistant message
   * commits. Built-in skills are filtered at the wiring layer (they
   * have no `workspace_skills` row).
   * See `docs/architecture/context-engine/memory-consolidation.md` →
   * "Skill invocation feedback (CL-8 lock)".
   */
  workspaceSkillStore?: import('../db/skill-store.js').WorkspaceSkillStore
  /** S14 per-assistant enablement (UUID FK) — gates which auto-gen/workspace
   *  skills surface to this assistant, alongside the legacy slug toggle. */
  workspaceSkillEnablementStore?: import('../db/workspace-skill-enablement-store.js').WorkspaceSkillEnablementStore
  /** Backs load-time `{{kind:name}}` pointer expansion in `useSkill`. */
  workspaceSkillFilesStore?: import('../db/workspace-skill-files-store.js').WorkspaceSkillFilesStore
  communitySkills?: import('@use-brian/core').SkillContent[]
  pendingMessageStore?: import('../db/pending-message-store.js').PendingMessageStore
  deferredConfirmationStore?: DeferredConfirmationStore
  /**
   * Q10 unification (WU-6.3). Required. Backs `kind='tool_invocation'`
   * pending_approvals rows minted when a `requiresConfirmation` tool pauses
   * in a workspace-scoped chat — those rows drive both the unified queue UI
   * and Path B durable resume. Legacy personal assistants (no
   * `assistant.workspaceId`) take Path A and skip the row mint, but the
   * store is still always constructed in `apps/api` so the type is required.
   */
  pendingApprovalsStore: PendingApprovalsStore
  /**
   * Path B durable chat resume (WU-6.4 enqueue side). When set, a
   * suspended `requiresConfirmation` tool call in a workspace-scoped
   * chat writes a `session_resume_points` checkpoint off the
   * `awaiting_approval` query-loop event, so the approval can be
   * replayed by the resume worker after a Cloud Run restart. Optional —
   * Path A (in-memory-only) still works without it.
   * See docs/plans/company-brain/approvals.md → "Chat resume — Path B".
   */
  sessionResumeStore?: SessionResumeStore
  episodicStore?: EpisodicStore
  sessionStateStore?: SessionStateStore
  /** Execution-plan tier store (`# Active plan` block + completeness gate). */
  planStore?: PlanStore
  /**
   * Optional — when provided, the post-user-turn nag resolver runs against
   * this store. See `packages/api/src/scheduling/nag-resolver.ts`.
   */
  jobStore?: JobStore
  /**
   * Optional connector-action audit stores. When BOTH are set AND the
   * assistant is workspace-scoped, every connector action (e.g. an email
   * send) writes a `connector_action` Episode + audit row per
   * `docs/plans/company-brain/connector-actions.md`. The IFC ceiling is
   * computed from `assistant.clearance` and the action's audience;
   * `retrieval_sensitivity_max` defaults to `'public'` until the per-turn
   * `SensitivityAccumulator` is lifted to the injection site (documented
   * limitation — conservative under-stamp, audit-fidelity follow-up).
   */
  connectorActionStore?: import('../db/connector-actions-store.js').ConnectorActionStore
  episodesStore?: import('../db/episodes-store.js').DbEpisodesStore
  /**
   * Host factory that binds the audit deps into a `ConnectorActionAudit` with
   * `emit`/`preflight` methods (the closed emission primitive). The MCP inject
   * calls those methods so the open route imports no closed audit code. Open
   * default: unset → connector actions run un-audited.
   */
  buildConnectorActionAudit?: BuildConnectorActionAudit
  /**
   * Per-assistant capability grants (#4 in
   * `docs/architecture/integrations/connector-actions.md`). Threaded
   * through `applyMcpInjection` so Gmail/GCal write callbacks gate on
   * `assertActionAllowed` before executing. Absent → no enforcement
   * (back-compat with smoke tests).
   */
  assistantConnectorGrantsStore?: import('../db/assistant-connector-grants-store.js').AssistantConnectorGrantsStore
  voiceTranscription?: {
    enabled: boolean
    apiKey: string
    backend?: MediaBackend
    model?: string
  }
  capabilityStore: CapabilityStore
  /** Workspace files store (Q3 §10). When set + the assistant has the `files`
   *  capability + `assistant.workspaceId` is bound, the `# Workspace Files`
   *  L1 block is injected. Optional so smoke tests / dev runs without GCS
   *  still work. */
  workspaceFilesStore?: import('@use-brian/core').WorkspaceFilesStore
  /** Workspace-files byte layer — forwarded via `applyMcpInjection` so
   *  `gmailSendMessage` can attach workspace files as real MIME parts
   *  (`docs/architecture/integrations/gmail.md` → "Attachments"). */
  filesApi?: import('@use-brian/core').FilesApi
  /**
   * Company-brain read surface (WS-5). When set, the 6 retrieval tools
   * (`getEntity`, `search`, `recentEpisodes`, `provenance`, `markUseful`,
   * `aggregate`) are injected into the per-turn tool registry so the model
   * can query the brain. Optional — smoke / legacy callers without the
   * cognitive substrate run without it. See
   * `docs/architecture/brain/retrieval-layer.md`.
   */
  retrievalStore?: RetrievalStore
  /**
   * Brain inbox inspection toolkit (read-only) — registered into the
   * per-turn tool registry ONLY for sessions with
   * `channel_type='brain_inspection'` (spawned by the inbox "Ask about
   * this" affordance). Built at boot from `createInspectionTools` over
   * a DB-backed inspection store. See docs/architecture/brain/corrections.md.
   */
  inspectionTools?: Record<string, import('@use-brian/core').Tool>
  /** Generate mode as a chat tool (fill a blueprint from the brain). Built at
   *  boot with generateSynthesize + pageTemplateStore; workspace-scoped. */
  generateBlueprintTool?: Tool
  /**
   * The blueprint output-contract direct surface (save/get records, create
   * blueprint, list). Built at boot; workspace-scoped; injected on the SAME
   * turns as the fill tool. Callee-executor parity is load-bearing.
   */
  blueprintRecordTools?: Tool[]
  /**
   * On-demand introspection lane tools (pending approvals / scheduled jobs /
   * research runs / session history reads). Built at boot; the route passes
   * them to `applyMcpInjection` ONLY for workspace-primary turns, where they
   * become the `introspection` mcp_search local source — never the direct
   * tool surface. See `docs/architecture/engine/introspection-tools.md`.
   */
  introspectionTools?: Tool[]
  /**
   * Dynamic "workspace blueprints" system-prompt section — closed-world
   * (empty string when the workspace has no blueprints). Carries the
   * bound-vs-unbound application posture. Never part of Layer 1.
   */
  buildBlueprintPromptFragment?: (userId: string, workspaceId: string) => Promise<string>
  /**
   * Entity-graph stores (WU-6.12). When both are set — alongside a
   * workspace-scoped assistant — `saveMemory` accepts an `entityId` that
   * anchors the memory as a CRM note (`note` tag + `memory→entity`
   * `mentioned` edge). See `docs/architecture/brain/corrections.md`
   * §"CRM notes via memory". Both must be supplied together. Web chat is
   * the surface that wires these: it also injects the retrieval tools the
   * model uses to discover the `entityId`.
   */
  entitiesStore?: import('@use-brian/core').EntityStore
  entityLinksStore?: import('@use-brian/core').EntityLinksStore
  /**
   * Self-healing reclassifier candidate store (Q5 of the brain-
   * ingestion-classification design thread). When set together with
   * `entitiesStore` + `entityLinksStore`, the chat route runs a fire-
   * and-forget local-match check after every memory retrieval —
   * memories whose summary mentions an existing workspace entity get
   * a `mentioned` edge + audit row. Optional; absent disables the
   * hook (the explicit `healMemories` chat tool still works).
   */
  brainCandidateStore?: import('@use-brian/core').BrainCandidateStore
  /**
   * Company-brain ingest (WU-3.6). When set, the chat compaction
   * checkpoint hands the just-compacted conversation window to this
   * ingestor, which materializes a `web_chat` Episode and runs Pipeline B
   * extraction — so the brain learns from live chat. Optional.
   */
  chatEpisodeIngestor?: import('../ingest-port.js').ChatEpisodeIngestor
  /**
   * Per-turn memory recall logger (mig 167). When set, the chat route
   * creates a `MemoryRecallBuffer` for each turn, pushes `index_inject`
   * recalls for every memory landing in the L1 memory index and
   * `tool_call` recalls inside `getMemory`, then flushes the batch
   * once the assistant message commits with that message's id.
   * Optional — without it, recall logging falls back to the legacy
   * `memories.recall_count` counter only (no JOIN to feedback).
   * See `docs/architecture/context-engine/memory-system.md` →
   * "Recall-outcome tagging".
   */
  memoryRecallEventsStore?: import('../db/memory-recall-events-store.js').MemoryRecallEventsStore
  /**
   * CL-9 retrieval-miss detector. When set and a workspace-scoped
   * retrieval store is wired, the chat route hands the search tool an
   * `onAfterSearch` hook that pushes (sessionId, queryText, resultIds)
   * into the detector. The detector compares against prior queries in
   * the same session and inserts a `retrieval_miss` row when the
   * within-session reformulation threshold trips. Optional — without
   * it, the search tool runs unchanged.
   *
   * See `docs/architecture/context-engine/memory-consolidation.md` → CL-9 lock.
   */
  retrievalMissDetector?: import('../retrieval/retrieval-miss-detector.js').RetrievalMissDetector
}

/**
 * Extract plain text from a session_messages content column
 * (which may be a JSONB array of ContentBlocks or a string).
 */
function extractMessageText(msg: { content: unknown }): string {
  if (typeof msg.content === 'string') return msg.content
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b: { type?: string }) => b.type === 'text')
      .map((b: { text?: string }) => b.text ?? '')
      .join(' ')
  }
  return ''
}

/**
 * Trim a tool-result error string into a single short line for the SSE
 * payload. Used by the chat UI to show *why* a tool failed in the
 * confirmation card; long stack traces are useless there and oversized
 * SSE frames hurt streaming.
 */
function toolErrorExcerpt(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? `${flat.slice(0, 197)}…` : flat
}

/**
 * Extract the plain-text portion of a Message content, returning '' if the
 * message is entirely non-text (e.g. a user-role row that carries only
 * tool_result blocks under the new persistence model).
 */
function extractPlainText(content: Message['content']): string {
  if (typeof content === 'string') return content
  return content
    .filter((b) => b.type === 'text')
    .map((b) => ('text' in b ? b.text : ''))
    .join('')
}

// `sanitizeTitle` now lives in `@use-brian/core` (`doc/auto-title.ts`) so
// the session generator here and the doc page generator share one cleanup
// contract. Re-exported for the existing `[COMP:api/chat-route] sanitizeTitle`
// unit tests; imported above for internal use by `generateTitle`.
export { sanitizeTitle }

/**
 * Maximum number of worker waves the research-mode coordinator is allowed
 * to spawn before being forced into final synthesis. Each Phase 4b drain
 * counts as one wave. Without a cap the loop could spin if every wave
 * keeps returning protocol-violation workers — the coordinator would
 * forever respawn without converging.
 *
 * 4 means the coordinator can: wave 1 (initial 3-5 workers) → wave 2
 * (follow-ups for partials) → wave 3 (last-chance retries for stubborn
 * gaps) → wave 4 (one final round) → forced synthesis. Empirically enough
 * for any realistic deep-research task; more rounds rarely yield new info
 * and burn the budget.
 */
const RESEARCH_MAX_WORKER_WAVES = 4

/**
 * Build the research-mode `workerDrainPrompt` callback. The factory
 * captures a wave counter in closure; each call increments it.
 *
 * ── Why this is data-only (post-2026-05 redesign) ──────────────────
 *
 * Prior versions inlined paragraphs of protocol rules ("This turn:
 * ONLY spawnWorker tool calls. No text. No `<gap-assessment>`. ...")
 * into the synthetic user message that delivers worker results. The
 * model would occasionally echo those rules back as its reply,
 * producing user-visible prose like "(This turn: ONLY tool calls.
 * No text. No <gap-assessment>...)". The fix isn't a downstream
 * substring filter — those bandage symptoms. The fix is to stop
 * giving the model rule-shaped content to echo.
 *
 * The research addendum (`coordinatorResearchAddendum` below) is
 * already in the system prompt, so the model has every rule it
 * needs. The drain message carries:
 *   - The worker results (data)
 *   - A wave counter (data)
 *   - A single one-line directive verb pointing at the right phase
 *
 * No restated rules, no quoted tags, no protocol prose. Nothing to
 * paraphrase.
 */
function createResearchWorkerDrainPrompt(): (text: string, results: WorkerResult[]) => string {
  let waveCount = 0
  return (notificationText, results) => {
    waveCount++
    const failed = results.filter((r) => r.status === 'failed')
    const cappedOut = waveCount >= RESEARCH_MAX_WORKER_WAVES

    if (failed.length > 0 && !cappedOut) {
      return `Wave ${waveCount} results:\n\n${notificationText}\n\n${failed.length} worker(s) failed; respawn them per the protocol in your system prompt.`
    }

    if (cappedOut) {
      return `Wave ${waveCount} results (retry cap reached):\n\n${notificationText}\n\nSynthesize and reply per Phase 4.`
    }

    return `Wave ${waveCount} results:\n\n${notificationText}\n\nAssess gaps and continue per the protocol in your system prompt (respawn or synthesize).`
  }
}

/**
 * WU-4.4 Q20 invocation block evaluator. Returns true when `userId` is in
 * the assistant's `blocked_user_ids` array. When true, the chat route
 * silently closes the SSE stream without spawning a turn — see
 * `docs/plans/company-brain/permissions.md` §Per-assistant user blocklist.
 *
 * Tolerates null/undefined defensively even though the underlying column
 * is NOT NULL: callers may pass a partially-typed assistant view.
 *
 * Exported for unit testing only.
 */
export function isUserBlocked(
  blockedUserIds: string[] | null | undefined,
  userId: string,
): boolean {
  return Array.isArray(blockedUserIds) && blockedUserIds.includes(userId)
}

/**
 * Whether a chat turn is eligible for *adaptive* research-mode entry —
 * the server-side `classifyResearchIntent` pass that can silently flip
 * an unpinned turn into research/coordinator mode.
 *
 * Eligible only when the caller left `mode` unpinned (`undefined`), the
 * assistant is workspace-scoped (research requires workspace billing),
 * the plan is paid, AND the assistant is NOT `kind='app'`. (Message
 * presence is guarded separately at the call site, where it also
 * narrows the message type for the classifier input.)
 *
 * The `kind='app'` exclusion is load-bearing. App assistants have a
 * bounded job: a doc assistant authors the page with
 * `renderPage`/`renderView`; a feed assistant publishes. Research
 * (coordinator) mode swaps in a delegation-only tool surface that drops
 * exactly those tools, so silently upgrading an app assistant into
 * research makes its core task impossible — the model calls its
 * authoring tools, gets `Unknown tool`, thought-burns, and the turn
 * degrades into a truncated empty-turn fallback. This predicate closes
 * the silent adaptive path; `appAssistantForbidsResearch` below closes
 * the remaining explicit + splitter triggers, so an app assistant never
 * reaches coordinator mode by any route.
 */
export function isAdaptiveResearchEligible(args: {
  requestedMode: 'default' | 'research' | undefined
  workspaceId: string | null | undefined
  userPlan: string
  assistantKind: string | null | undefined
}): boolean {
  return (
    args.requestedMode === undefined &&
    !!args.workspaceId &&
    args.userPlan !== 'free' &&
    args.assistantKind !== 'app'
  )
}

/**
 * App assistants must never enter **coordinator** mode. Coordinator mode
 * filters the live tool surface down to a delegation-only allowlist
 * (`COORDINATOR_ALLOWED_TOOLS_*`) that excludes their authoring + retrieval
 * tools (doc: `renderPage` / `patchPage` / `createSubPage` /
 * `getCurrentPage` / `recentEpisodes` / `search` …). The assistant's own
 * Layer-1 soul still advertises those tools, so the model calls them, the
 * executor returns `Unknown tool`, and the turn collapses — often leaking a
 * self-addressed "(for debugging — the user won't see this)" note into the
 * user-facing reply (incident 2026-06-01 08:39 UTC, doc).
 *
 * This is the catch-all for the coordinator triggers: the explicit
 * `mode:'research'` toggle AND the Pro/Max splitter, which can flip a turn
 * into coordinator mode independent of research mode. It applies to ALL
 * `kind='app'` assistants (doc + feed) — none of them ever delegate to
 * workers. Doc research mode (see {@link appAssistantForbidsResearch})
 * keeps the assistant in its own page-authoring loop with web search +
 * `renderPage`/`patchPage` intact, which is what makes a research toggle on
 * a doc comment functional without re-triggering the incident above.
 */
export function appAssistantForbidsCoordinator(assistantKind: string | null | undefined): boolean {
  return assistantKind === 'app'
}

/**
 * Which app assistants must have the explicit `mode:'research'` toggle forced
 * OFF. All `kind='app'` assistants do — only **feed** (`appType='distribution'`)
 * remains, and research mode adds nothing to a publishing turn (its global
 * addendum is worker-centric). Doc authoring is no longer an app type; doc
 * research runs on the host assistant (the workspace primary by default), which
 * is not `kind='app'`, so it is never forbidden here — it stays a page-authoring
 * turn via the doc skill block, never entering coordinator mode (that gate is
 * {@link appAssistantForbidsCoordinator}).
 *
 * `isAdaptiveResearchEligible` independently keeps the *silent* adaptive upgrade
 * off for ALL `kind='app'` assistants.
 */
export function appAssistantForbidsResearch(
  assistantKind: string | null | undefined,
): boolean {
  return assistantKind === 'app'
}

/**
 * Is this turn happening on the Doc surface? True for a session that
 * originated in `apps/app-web` (`appOrigin='doc'`) or a doc comment
 * thread. This is the surface signal that drives doc-skill injection,
 * decoupled from WHICH assistant is talking (the workspace primary by default,
 * or any assistant the user switched to). Mirrors the surface test in
 * `resolveRunChannel`.
 */
export function isDocSurface(session: {
  appOrigin: string | null
  channelType: string
}): boolean {
  return session.appOrigin === 'doc' || session.channelType === 'doc_thread'
}

/**
 * The app-web WORKSPACE surfaces — the non-doc origins the shared
 * `SurfaceChatPanel` dock stamps on its sessions (migration 255). Mirrors
 * the non-doc, non-chat slice of `KNOWN_ORIGINS` below — keep in sync.
 */
const APP_SURFACE_ORIGINS = new Set([
  'brain',
  'studio',
  'workflow',
  'approvals',
  'knowledge-base',
])

/**
 * Is this turn happening on an app-web WORKSPACE surface (Brain / Studio /
 * Workflow / Approvals / Knowledge-base chat)? These turns get the doc page
 * tools injected AMBIENTLY — same tools as the doc surface, but with the
 * weak `buildAmbientDocSkillBlock` steering (chat-first, author a page only
 * on an explicit ask) instead of the page-first protocol. Coordinator /
 * research gating is NOT affected by this predicate — those key off
 * `isDocSurface` so a workspace-surface research turn keeps the standard
 * coordinator path.
 */
export function isAppSurface(session: { appOrigin: string | null }): boolean {
  return session.appOrigin !== null && APP_SURFACE_ORIGINS.has(session.appOrigin)
}

/**
 * The steering line appended under "# Active doc page" when a doc turn
 * carries the id of a page the user is currently looking at (a comment-thread
 * reply, the floating dock, or Space→AI all send `docViewId`). The user is
 * LOOKING AT this page, so the work belongs here via `patchPage` — which routes
 * through the live Yjs doc and streams onto the editor they see.
 *
 * `renderPage` mints a SECOND, separate page the user is NOT viewing; it lands
 * as an orphan draft they won't find. That was the 2026-06-02 incident: a user
 * wrote their project bullets into "New draft", asked the assistant (from that
 * page's comment thread) to "create different projects by bullet points below",
 * and the model — handed `renderPage` as a co-equal option on the non-empty
 * branch — authored a brand-new "Project Portfolio" page and left the page the
 * user was staring at untouched. From the user's seat: "it says it created a
 * page, but nothing is visible."
 *
 * So BOTH branches default to editing in place. The non-empty branch permits
 * `renderPage` ONLY on an explicit new-page request; a comment-thread reply (the
 * conversation is anchored to this page) forbids it outright. Kept pure +
 * exported so `chat.test.ts` can assert the steering without booting the route.
 */
export function buildActivePageInstruction(args: {
  isEmptyPage: boolean
  isCommentThread: boolean
}): string {
  if (args.isEmptyPage) {
    // The user is already looking at this freshly-created, empty page (e.g. the
    // doc landing pre-creates it and navigates here). Build it IN PLACE so the
    // construction lands on the page they see and streams to the live editor —
    // `patchPage` routes through the Yjs doc, `renderPage` does not and would
    // spawn a second, separate page.
    return (
      'This page is open and EMPTY. Build it **in place**: call `patchPage` with this ' +
      'pageId and the version above as `expectedVersion`, using `add` ops to append the ' +
      'blocks (open with a heading, frame it with a line of text, add the content, close ' +
      'with a takeaway). Do NOT call `renderPage` — that creates a second, separate page, ' +
      'but the user is already looking at this one. ' +
      'Whatever you have to say this turn belongs on THIS page, not in chat: even a short ' +
      'answer, a clarifying question, or "I could not find X" must be written onto the page ' +
      'with `patchPage` (a heading + a line of text is enough). Never end the turn with only ' +
      'a chat reply and an empty page.'
    )
  }
  // Non-empty: the user is looking at a page that already has content (often
  // their own pasted notes). Organize / rewrite / extend it IN PLACE. Offering
  // `renderPage` here orphans the work onto a page they aren't viewing.
  return (
    'To edit this page call `patchPage` with this pageId and the version above as ' +
    '`expectedVersion`, addressing blocks by the ids listed. The user is looking at THIS ' +
    'page, so organize, rewrite, or extend it in place — even when they paste raw notes and ' +
    'ask you to "create" or "structure" something from them, that means restructure THIS ' +
    'page (replace/extend the blocks below), not start over elsewhere. Do NOT call ' +
    '`renderPage` unless the user EXPLICITLY asks for a separate, new page; it mints a ' +
    'second page the user is not looking at and will not find.' +
    (args.isCommentThread
      ? ' This turn is a comment-thread reply anchored to this page, so the request is ' +
        'about this page — never call `renderPage` here.'
      : '')
  )
}

/**
 * The `# Currently viewing — workspace skill` turn-context block for a turn
 * whose request carried `viewingSkillRowId` (the app-web floating dock on
 * the Brain skill editor route sends it, path-derived). Gives the model the
 * skill's SAVED contents so "this skill" resolves to what the user is
 * looking at. Deliberately tool-agnostic (tool-awareness rule): it never
 * promises an edit capability — the honest default is proposing revised
 * text in chat for the user to apply and save. Kept pure + exported so
 * `chat.test.ts` asserts the shape without booting the route.
 */
export function buildViewingSkillBlock(skill: {
  rowId: string
  name: string
  description: string
  whenToUse?: string
  content: string
  state: 'active' | 'stale' | 'archived'
  activatedAt?: Date
}): string {
  const status =
    skill.state === 'stale'
      ? 'stale (needs re-review)'
      : skill.activatedAt
        ? 'active'
        : 'suggested (awaiting the user’s confirmation)'
  // The store caps bodies at 5000 chars on write; the slice is a guard for
  // legacy over-cap rows so one skill can never flood the envelope.
  const body =
    skill.content.length > 6000
      ? `${skill.content.slice(0, 6000)}\n…(truncated)`
      : skill.content
  return (
    `# Currently viewing — workspace skill\n` +
    `The user has this workspace skill open in the Brain skill editor right now. ` +
    `When they say "this skill" — or ask about the skill they are looking at — they mean this one.\n\n` +
    `Skill: ${JSON.stringify(skill.name)} (row id: ${skill.rowId}, status: ${status})\n` +
    `Description: ${skill.description}\n` +
    (skill.whenToUse ? `When to use: ${skill.whenToUse}\n` : '') +
    `\nSaved instructions (markdown):\n` +
    `\`\`\`\`markdown\n${body}\n\`\`\`\`\n\n` +
    `This is the last SAVED version — edits the user has typed in the editor but not saved ` +
    `are not visible to you, and you cannot type into their editor. When they ask for ` +
    `changes, propose the exact revised text in chat so they can apply and save it themselves.`
  )
}

/**
 * The `# Currently viewing — deck` turn-context block for a turn whose
 * request carried `viewingDeckId` (the app-web floating dock on the deck
 * preview route sends it, path-derived). Lets "this deck" / "slide 3"
 * resolve to what the user is watching; the preview refreshes live after
 * every deck edit. Tool-agnostic on purpose (tool-awareness rule) — the
 * deck id is the handle, not a capability promise. Kept pure + exported
 * for chat.test.ts. Spec: docs/architecture/features/deck-generation.md.
 */
export function buildViewingDeckBlock(deck: {
  id: string
  title: string
  version: number
  slides: { title: string; layout?: string }[]
}): string {
  const outline = deck.slides
    .map((s, i) => `${i}: ${JSON.stringify(s.title)}${s.layout && s.layout !== 'content' ? ` (${s.layout})` : ''}`)
    .join('\n')
  return (
    `# Currently viewing — deck\n` +
    `The user has this presentation deck open in the live preview right now. ` +
    `When they say "this deck", "the presentation", or reference a slide by number or name, they mean this one. ` +
    `The preview updates automatically whenever the deck changes.\n\n` +
    `Deck: ${JSON.stringify(deck.title)} (deckId: ${deck.id}, version: ${deck.version})\n` +
    `Slides (0-based index, title slide excluded):\n${outline}`
  )
}

/**
 * Attach the per-turn `<turn_context>` envelope to the newest user message.
 *
 * Returns the new messages array, or `null` when no plain trailing user
 * message can carry it (empty history, assistant-final resume shapes, or a
 * tool_result-bearing user message) — the caller then falls back to in-prompt
 * placement for that turn.
 *
 * Ephemeral by design: operates on the in-memory copy passed to the query
 * loop; the persisted session row never carries the envelope. That is the
 * cache-prefix invariant this exists for — history bytes stay identical
 * across turns, the system prompt stays byte-stable, and the provider's
 * implicit prompt cache covers both. An empty `turnContext` returns the
 * input unchanged.
 */
export function attachTurnContext(
  messages: Message[],
  turnContext: string,
): Message[] | null {
  if (!turnContext || turnContext.trim().length === 0) return messages
  if (messages.length === 0) return null
  const last = messages[messages.length - 1]
  if (last.role !== 'user') return null
  // A tool_result-bearing user message is a pairing carrier — don't graft
  // prose onto it; fall back to in-prompt placement instead.
  if (
    typeof last.content !== 'string' &&
    last.content.some((b) => b.type === 'tool_result')
  ) {
    return null
  }
  const envelope = `<turn_context>\n${turnContext.trim()}\n</turn_context>`
  const content =
    typeof last.content === 'string'
      ? [
          { type: 'text' as const, text: last.content },
          { type: 'text' as const, text: envelope },
        ]
      : [...last.content, { type: 'text' as const, text: envelope }]
  return [...messages.slice(0, -1), { role: 'user', content }]
}

/**
 * Pick the sticky `channel_id` used to resolve (or create) a web session when
 * `findSessionById` misses. Precedence:
 *   1. An explicit `requestedChannelId` (feed-web tuning / per-draft chats that
 *      already own a sticky channel).
 *   2. The `requestedSessionId` itself — a brand-new chat mints a temp UUID and
 *      sends it as `sessionId` before any row exists, so it misses the by-id
 *      lookup. Reusing it as the channel id means every turn of that
 *      conversation (and a concurrent double-send) reunites on ONE session row
 *      via the `channel_id` upsert key, instead of minting a fresh
 *      random-channel session per turn (the duplicate-Recents bug).
 *   3. Neither → undefined, and the caller falls back to a random UUID.
 * Whitespace-only values are treated as absent.
 */
export function resolveStickyChannelId(
  requestedChannelId: string | undefined | null,
  requestedSessionId: string | undefined | null,
): string | undefined {
  return requestedChannelId?.trim() || requestedSessionId?.trim() || undefined
}

/**
 * Generate a session title using the LLM.
 *
 * Guardrails:
 * - Skip messages whose extracted text is empty (tool_result user rows).
 * - Cap `maxTokens` so the stream can't produce a paragraph.
 * - Post-process to strip markdown and trim at a word boundary.
 */
type GenerateTitleResult = { title: string | null; usage: TokenUsage | null; model: string | null }

async function generateTitle(provider: LLMProvider, messages: Message[]): Promise<GenerateTitleResult> {
  const filteredMessages = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, text: extractPlainText(m.content) }))
    .filter((m) => m.text.trim().length > 0)

  const excerpt = filteredMessages
    .slice(0, 6)
    .map((m) => `${m.role}: ${m.text.slice(0, 200)}`)
    .join('\n')

  // Return `title: null` on the fallback paths so callers can choose to
  // keep the existing placeholder rather than overwrite it with the
  // generic "New Chat". Especially load-bearing for sessions whose host
  // gave them a context-carrying placeholder (e.g. a bracketed channel
  // prefix) that "New Chat" would erase — see the auto-title call site.
  if (!excerpt) return { title: null, usage: null, model: null }

  let rawTitle = ''
  let usage: TokenUsage | null = null
  for await (const chunk of provider.stream({
    // Standard tier per docs/architecture/platform/cost-and-pricing.md
    // → Model routing (extraction / classification / structured-output bucket).
    model: 'gemini-3.1-flash-lite',
    systemPrompt:
      'Summarize this conversation into a short descriptive title (3-6 words). The title should capture the specific topic being discussed. Output ONLY the title text — no markdown, quotes, or punctuation.\n\nRules:\n- Always 3-6 words\n- Rephrase questions into topic form (e.g. "what do you think about oil prices" → "Oil Price Analysis Today")\n- Include the specific subject, not just the category\n\nExamples:\nuser: what do you think about oil price today? → Oil Price Analysis Today\nuser: help me plan a trip to Japan → Planning a Trip to Japan\nuser: tell me about the latest crypto news → Latest Crypto Market News',
    messages: [{ role: 'user', content: excerpt }],
    maxTokens: 32,
    temperature: 0.2,
  })) {
    if (chunk.type === 'text_delta') rawTitle += chunk.text
    if (chunk.type === 'message_end') usage = chunk.usage
  }

  const cleaned = sanitizeTitle(rawTitle)
  // If the model returned fewer than 3 words, derive a title from the first
  // user message instead — let sanitizeTitle handle the length cap (48 chars)
  // so we don't awkwardly truncate mid-phrase.
  if (cleaned.split(/\s+/).length < 3) {
    const firstUserText = filteredMessages.find((m) => m.role === 'user')?.text ?? ''
    const fallback = sanitizeTitle(firstUserText)
    if (fallback.split(/\s+/).length >= 2) {
      return { title: fallback.charAt(0).toUpperCase() + fallback.slice(1), usage, model: 'gemini-3.1-flash-lite' }
    }
  }
  return {
    title: cleaned.length > 0 ? cleaned : null,
    usage,
    model: 'gemini-3.1-flash-lite',
  }
}

/**
/**
 * Write a `usage_tracking` row for an external-API cost attached to a
 * tool result. No-op when `toolMeta` carries no `externalCost_*` fields.
 *
 * See docs/architecture/platform/cost-and-pricing.md → "External API cost
 * tracking policy". This is the single site that turns
 * `ToolResult.meta.externalCost_*` into a billable row. Every integration
 * that spends money per call must flow through here.
 */
async function recordExternalCostFromMeta(params: {
  toolMeta: ToolResultMeta | undefined
  usageStore: UsageStore | undefined
  userId: string
  assistantId: string
  sessionId: string
  userMessageId: string | null | undefined
  userPlan: string
  analytics: AnalyticsLogger | undefined
}): Promise<void> {
  if (!params.usageStore) return
  const cost = decodeExternalCostMeta(params.toolMeta)
  if (!cost) return

  const actualCostUsd =
    cost.kind === 'per-token'
      ? calculateCost(cost.model, {
          inputTokens: cost.inputTokens,
          outputTokens: cost.outputTokens,
          cacheReadTokens: cost.cacheReadTokens ?? 0,
        })
      : cost.flatCostUsd

  const inputTokens = cost.kind === 'per-token' ? cost.inputTokens : 0
  const outputTokens = cost.kind === 'per-token' ? cost.outputTokens : 0
  const cacheReadTokens = cost.kind === 'per-token' ? cost.cacheReadTokens ?? 0 : 0

  try {
    await params.usageStore.recordUsage({
      userId: params.userId,
      assistantId: params.assistantId,
      sessionId: params.sessionId,
      model: cost.model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens: 0,
      actualCostUsd,
      source: params.userPlan === 'free' ? 'free' : 'included',
      userMessageId: params.userMessageId ?? undefined,
    })
  } catch (err) {
    console.error('External cost tracking failed:', err)
    params.analytics?.logEvent({
      userId: params.userId,
      assistantId: params.assistantId,
      sessionId: params.sessionId,
      eventName: 'usage_tracking_error',
      channelType: 'web',
      metadata: {
        error_type: sanitize((err as Error)?.name ?? 'unknown'),
        external_cost_model: sanitize(cost.model),
      },
    })
  }
}

// ─────────────────────────────────────────────────────────────────────
// Path B durable chat resume (Q22 RESOLVED). The poll worker invokes
// `runSessionResume` when it picks up a `state.triggerKind='session_resume'`
// scheduled-job row. The orchestrator here is intentionally narrow — it
// owns the resume-point + approval lookup, the status gate, and the
// post-replay cleanup — and delegates the actual turn replay (synthetic
// tool result + queryLoop + session_messages persistence) to an injected
// `replay` callback. The callback lives in the apps/api wiring layer
// where the full tool registry + provider + per-session context are
// already constructed for the fresh-turn HTTP path.
//
// See:
//   docs/plans/company-brain/approvals.md → "Chat resume — Path B
//   (lightweight checkpoint) — Q22 RESOLVED"
//   packages/api/migrations/124_session_resume_points.sql
// ─────────────────────────────────────────────────────────────────────

/** Resolved approval outcome handed to a replay callback. */
export type ResumeReplayApprovalStatus = 'approved' | 'rejected' | 'expired'

export type ResumeReplayParams = {
  sessionId: string
  approvalId: string
  /** Tool the model proposed at suspension, frozen at that point. */
  suspendedToolName: string
  /** Model-proposed arguments at suspension. The approval gates THIS input. */
  suspendedToolInput: unknown
  /** Resume worker position marker — useful for analytics + assertions. */
  loopStepIndex: number
  approvalStatus: ResumeReplayApprovalStatus
  rejectReason: string | null
  /**
   * Carries the user's typed answer when the suspended tool was askQuestion
   * (kind='question'). NULL for tool_invocation kinds. See
   * docs/architecture/engine/askquestion-suspend-resume.md.
   */
  answerText: string | null
  /** Approval kind, so the replay can branch without re-fetching. */
  approvalKind: ApprovalKind
}

/**
 * Replay callback. Responsible for: invoking (or synthesizing) the tool
 * result reflecting `approvalStatus`, calling queryLoop with the
 * assembled history, persisting the resulting assistant turn(s) to
 * session_messages, and emitting relevant analytics_events.
 *
 * Returns `'completed'` to signal that the resume_point should be
 * deleted, or `'deferred'` to leave it in place for retry on a later
 * poll tick (e.g. transient downstream failure).
 */
export type SessionResumeReplay = (params: ResumeReplayParams) => Promise<'completed' | 'deferred'>

export type SessionResumeDeps = {
  sessionResumeStore: SessionResumeStore
  pendingApprovalsStore: PendingApprovalsStore
  replay: SessionResumeReplay
  /** Optional analytics tap for resume lifecycle events. */
  analytics?: AnalyticsLogger
}

export type SessionResumeOutcome =
  | { status: 'completed' }
  /** Resume_point was already cleaned up, approval is still pending, or
   *  the replay deferred. The poll worker treats this as a non-failure
   *  (job is marked done so it doesn't refire; the next tick is driven
   *  by a fresh enqueue, not by re-leasing the same row). */
  | { status: 'skipped'; reason: string }
  /** Data-integrity surprise (e.g. resume_point.session_id mismatch).
   *  The poll worker marks the job failed and surfaces a loud log. */
  | { status: 'failed'; reason: string }

/**
 * Drive a Path B durable chat resume. Idempotent: a re-fire after a
 * successful resume is a `'skipped'` no-op because the resume_point row
 * is already gone.
 *
 * Lifecycle:
 *   1. Look up resume_point by `approvalId`. Missing → skip (already done).
 *   2. Verify `sessionId` matches the row. Mismatch → fail (integrity).
 *   3. Load the `pending_approvals` row (system-bypass).
 *   4. If status still `'pending'` → skip (poll worker ran too early; a
 *      later resolve will re-enqueue).
 *   5. Call `deps.replay(...)` with the resolved state.
 *   6. On `'completed'`, delete the resume_point and return.
 *
 * [COMP:brain/session-resume-worker]
 */
export async function runSessionResume(
  deps: SessionResumeDeps,
  params: { sessionId: string; approvalId: string },
): Promise<SessionResumeOutcome> {
  const { sessionResumeStore, pendingApprovalsStore, replay, analytics } = deps
  const { sessionId, approvalId } = params

  const point = await sessionResumeStore.getByApprovalId(approvalId)
  if (!point) {
    return { status: 'skipped', reason: 'resume_point_missing' }
  }
  if (point.sessionId !== sessionId) {
    // Integrity surprise — the trigger payload and the row disagree.
    // Don't fall through into a replay against the wrong session.
    return {
      status: 'failed',
      reason: `session_mismatch (point.sessionId=${point.sessionId}, payload=${sessionId})`,
    }
  }

  const approval = await pendingApprovalsStore.getByIdSystem(approvalId)
  if (!approval) {
    // FK CASCADE should prevent this — defensive only.
    return { status: 'failed', reason: 'approval_missing' }
  }
  if (approval.status === 'pending') {
    return { status: 'skipped', reason: 'approval_still_pending' }
  }
  if (approval.status !== 'approved' && approval.status !== 'rejected' && approval.status !== 'expired') {
    // 'superseded' or any new status we haven't taught the replay about.
    return { status: 'skipped', reason: `approval_status_unsupported:${approval.status}` }
  }

  analytics?.logEvent({
    userId: approval.approverUserId,
    sessionId,
    eventName: 'session_resume_started',
    channelType: 'web',
    metadata: {
      approval_id: sanitize(approvalId),
      suspended_tool: sanitize(point.suspendedToolName),
      approval_status: sanitize(approval.status),
    },
  })

  let outcome: 'completed' | 'deferred'
  try {
    outcome = await replay({
      sessionId,
      approvalId,
      suspendedToolName: point.suspendedToolName,
      suspendedToolInput: point.suspendedToolInput,
      loopStepIndex: point.loopStepIndex,
      approvalStatus: approval.status,
      rejectReason: approval.rejectReason,
      answerText: approval.answerText,
      approvalKind: approval.kind,
    })
  } catch (err) {
    analytics?.logEvent({
      userId: approval.approverUserId,
      sessionId,
      eventName: 'session_resume_failed',
      channelType: 'web',
      metadata: {
        approval_id: sanitize(approvalId),
        error_type: sanitize((err as Error)?.name ?? 'unknown'),
      },
    })
    throw err
  }

  if (outcome === 'deferred') {
    analytics?.logEvent({
      userId: approval.approverUserId,
      sessionId,
      eventName: 'session_resume_deferred',
      channelType: 'web',
      metadata: { approval_id: sanitize(approvalId) },
    })
    return { status: 'skipped', reason: 'replay_deferred' }
  }

  await sessionResumeStore.deleteBySessionId(sessionId)
  analytics?.logEvent({
    userId: approval.approverUserId,
    sessionId,
    eventName: 'session_resume_completed',
    channelType: 'web',
    metadata: {
      approval_id: sanitize(approvalId),
      approval_status: sanitize(approval.status),
    },
  })
  return { status: 'completed' }
}

/**
 * Web chat API route.
 * POST /api/chat { message, sessionId?, model? }
 * Streams SSE events: text_delta, tool_start, tool_result, turn_complete, done
 *
 * Supports both authenticated (JWT) and guest users.
 */
export function chatRoutes(options: WebChatOptions): Router {
  // Host-seam injection (DI defaults). The composition root supplies the real
  // impls; the open build falls through to these inert defaults. See WebChatOptions.
  const publishSessionEvent: PublishSessionEvent = options.publishSessionEvent ?? noopPublishSessionEvent
  const isPlaceholderTitle = options.isPlaceholderTitle ?? (() => false)
  const getTitleChannelPrefix = options.getTitleChannelPrefix ?? (() => null)
  const router = Router()

  router.post('/', async (req, res) => {
    const { message: rawMessage, sessionId: requestedSessionId, model: requestedModel, fileIds, attachedRecordingIds, truncateFromMessageId, timezone: clientTimezone, assistantId: requestedAssistantId, replyTo, channelId: requestedChannelId, mode: requestedMode, docViewId: requestedDocViewId, docAnchorBlockId: requestedDocAnchorBlockId, docActiveThemeId: requestedActiveThemeId, workspaceId: requestedWorkspaceId, followupChips: requestedFollowupChips, viewingSkillRowId: requestedViewingSkillRowId, viewingDeckId: requestedViewingDeckId, meteredProfileId, meteredToolRounds, meteredAccepted } = req.body as {
      message?: string
      sessionId?: string
      model?: string
      /** Metered lane (model = a metered registry alias): saved-profile pick,
       * ad-hoc rounds (10-200), and the client's confirm acknowledgement. */
      meteredProfileId?: string
      meteredToolRounds?: number
      meteredAccepted?: boolean
      fileIds?: string[]
      /**
       * Recordings the user attached in THIS turn (recording-to-brain, chat
       * entry). A recording-sized audio/video dropped in chat does NOT ride as
       * a `fileId` (that path base64s bytes into `file_cache` and transcribes
       * inline) — it goes through the recording pipeline (signed URL → GCS →
       * async transcribe), and its id rides here. The turn ACKNOWLEDGES + links
       * rather than summarizing: the transcript is not ready this turn, it
       * lands on the recording's own brief page. See recordings.md → "Chat
       * entry to the recording pipeline".
       */
      attachedRecordingIds?: string[]
      truncateFromMessageId?: string
      timezone?: string
      assistantId?: string
      replyTo?: { id: string; text?: string }
      /**
       * Doc-surface theme anchor: the id of the custom theme the user
       * currently has applied (a per-user `localStorage` value). When present
       * on a doc turn, `injectDocTools` injects `refineActiveTheme` so
       * the user can iterate on their theme from chat.
       */
      docActiveThemeId?: string
      /**
       * Active workspace the chat is rooted in. Backends the
       * workspace-aware routing gate: when present the resolved
       * assistant must live in this workspace, otherwise the chat is
       * rejected (prevents a stale localStorage assistantId from
       * leaking the user's Personal-workspace primary into a Team
       * workspace). When omitted, falls back to the legacy
       * assistant-id-only resolution.
       */
      workspaceId?: string
      /**
       * Doc-surface anchor: the id of the page open in `apps/app-web`.
       * On a doc assistant it is passed to `injectDocTools` as the
       * active `pageId`, so `patchPage` edits/extends that live page (its
       * blocks route to the Yjs doc through the `DocGateway`); when
       * omitted the model mints a fresh page with `renderPage`. On
       * non-doc surfaces this still anchors the legacy global
       * `renderView` to an open draft (append vs. create-new-draft).
       */
      docViewId?: string
      /**
       * Doc-surface insertion anchor: the id of the block the user's
       * cursor was on when they handed off to the AI (pressing Space on an
       * empty line). When present on an open doc page, the model is told
       * to insert generated blocks immediately after this block via
       * `patchPage` `add` ops with `after: "<id>"`, instead of appending at
       * the page end. Absent on every non-empty-line turn.
       */
      docAnchorBlockId?: string
      /**
       * Brain-surface anchor: the `workspace_skills` row id of the skill the
       * user is viewing in the Brain skill editor (`/w/<ws>/brain/skills/<id>`,
       * path-derived by the app-web floating dock). When present, the skill's
       * saved contents are injected as turn context so "this skill" resolves
       * to what the user is looking at. Read RLS-scoped through the same
       * workspace list the editor uses — never leaks a row the requesting
       * user couldn't open.
       */
      viewingSkillRowId?: string
      /**
       * Deck id the app-web floating dock sends while the user is on the
       * deck preview route (path-derived). Injected as turn context so
       * "this deck" / "slide 3" resolve to what they are watching.
       * Workspace-checked against the requesting assistant's workspace.
       */
      viewingDeckId?: string
      /**
       * Optional caller-supplied channel id. Used by per-surface chats
       * (feed-web tuning chat, draft iteration) that want a sticky
       * (assistant_id, user_id, channel_type='web', channel_id) tuple
       * so reopening the same surface resumes the same session. When
       * omitted, falls back to a random UUID — matches legacy behavior.
       */
      channelId?: string
      /**
       * Caller-requested chat mode. Only `'research'` is recognised
       * today — it forces coordinator mode + the max-tier model + a
       * 100-turn ceiling regardless of the splitter's verdict, gated
       * on the free-plan workspace quota (5/lifetime). Omit or pass
       * `'default'` for normal chat behavior.
       */
      mode?: 'default' | 'research'
      /**
       * Client capability flag: the requesting surface renders the
       * `<followup>[...]</followup>` chip tag as clickable chips. ONLY
       * chip-rendering clients (today: the apps/web chat experience) set
       * this. When set, the chat route appends FOLLOW_UP_QUESTIONS_ADDENDUM
       * so the model emits the tag; otherwise it stays out of the prompt so
       * the raw tag can't leak into non-chip surfaces (e.g. the doc
       * editor chat, where it would land in page content). See
       * docs/architecture/features/follow-up-questions.md.
       */
      followupChips?: boolean
    }
    // Mutable so the giant-paste promotion (large-content-artifacts §Phase
    // 3.1) can swap an over-threshold paste for its artifact manifest + head
    // excerpt once the workspace/assistant are resolved below. Every
    // downstream consumer (nag resolver, classifier, persistence, the model
    // turn) sees the replaced text — the original is durable in the artifact.
    let message = rawMessage
    // `requestedMode` semantics:
    //   - 'research'  → manual on, classifier skipped, downstream uses research budget
    //   - 'default'   → manual off, classifier skipped (user explicitly opted out)
    //   - undefined   → adaptive: run the research-intent classifier (mig 196 phase)
    //                    and let it decide. Same downstream effect as 'research'.
    let researchMode = requestedMode === 'research'

    // Either text or files must be present
    const hasFiles = Array.isArray(fileIds) && fileIds.length > 0
    if (!message?.trim() && !hasFiles) {
      res.status(400).json({ error: 'Missing message or files' })
      return
    }

    // Set up SSE headers. `no-transform` matters: compressing proxies
    // (Next dev rewrites included — its compressor honors no-transform)
    // otherwise buffer the stream and deliver it as one chunk at the end.
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no') // Disable nginx buffering
    res.flushHeaders()

    // Set true by `req.on('close')` when the client disconnects (e.g. a page
    // refresh). For a backgrounded `doc_thread` turn the query loop keeps
    // running after this, so every later SSE write must no-op — writing to the
    // dead socket would otherwise throw and tear down the still-running turn.
    let clientGone = false
    const sendEvent = (event: string, data: unknown) => {
      if (clientGone || res.writableEnded) return
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    // Context tracked outside the try so the outer catch can log rich error events
    let userIdForError: string | null = null
    let assistantIdForError: string | null = null
    let sessionIdForError: string | null = null
    // Set by the inner catch when a context-aware recovery message was
    // successfully composed + delivered after a queryLoop bail. Tells
    // the outer catch to send a clean `done` event instead of the
    // generic `error`, since the user already saw a useful message.
    let recoveryDelivered = false
    // Set when this turn opened an assistant-run presence entry on a doc
    // page (see below) so the outer `finally` can close it on every exit path.
    let docRunPageId: string | null = null
    // This turn's confirmation resolver, tracked outside the try so the outer
    // `finally` can evict it from the module-level maps on error/abort exits —
    // the success-path cleanup never runs on those, and each missed eviction
    // is a permanent entry in a process-lifetime Map.
    let turnResolver: ConfirmationResolver | null = null

    try {
      const jwtUserId = (req as { userId?: string }).userId
      const user = await resolveUser(jwtUserId)
      if (!user) {
        sendEvent('error', { error: 'User not found' })
        res.end()
        return
      }
      userIdForError = user.id
      // Plan governing this turn — the WORKSPACE's plan (billing is
      // per-workspace, migration 143). Resolved once the assistant (and
      // therefore its workspace) is known, just below.
      let userPlan = 'free'

      // First-signal-only backfill of users.timezone. The client
      // (browser header or legacy body field) reports its IANA zone
      // on every request, but we only seed `users.timezone` when it's
      // still at the unset default ('UTC' or empty). Subsequent tz
      // changes — travel, device move, etc. — are routed through the
      // travel-drift detector (packages/api/src/scheduling/tz-drift-
      // detector.ts) so the user confirms the move before we rewrite
      // the scheduling anchor. Auto-overwriting on every mismatch
      // would make the detector's "observed tz != users.timezone"
      // precondition unreachable — the two would always match.
      const detectedClientTz = req.clientTimezone ?? clientTimezone
      const hasUnsetTz = !user.timezone || user.timezone === 'UTC'
      if (detectedClientTz && detectedClientTz !== 'UTC' && hasUnsetTz) {
        const { updateUserTimezone } = await import('../db/users.js')
        await updateUserTimezone(user.id, detectedClientTz).catch((err) =>
          console.error('Timezone update failed:', err),
        )
        user.timezone = detectedClientTz
      }

      // Stamp presence on every authenticated turn. Anchor (users.timezone)
      // is rewritten only by the drift detector on confirmed moves; this is
      // the fast-changing "where they are now" signal used for display and
      // inherited by channels without a browser. Fire-and-forget — a write
      // failure here must not block the turn.
      if (detectedClientTz && detectedClientTz !== 'UTC') {
        updateUserLastSeenTz(user.id, detectedClientTz).catch((err) =>
          console.error('[chat] presence tz update failed:', err),
        )
        // Update the in-memory copy so the prompt builder below sees the
        // freshest value without a re-read.
        user.lastSeenTz = detectedClientTz
        user.lastSeenTzAt = new Date()
      }

      // Workspace-aware assistant resolution. Three branches:
      //   1. assistantId provided → look it up, then (if workspaceId
      //      also provided) enforce the workspace gate below.
      //   2. workspaceId provided, no assistantId → resolve that
      //      workspace's `kind='primary'` assistant. This is the path
      //      a user takes when they switch workspaces and type
      //      without picking an assistant.
      //   3. Neither provided → legacy default (the user's Personal
      //      workspace primary). Preserved for non-web channels and
      //      older clients that don't send workspaceId.
      const assistant = requestedAssistantId
        ? await getUserAssistant(user.id, requestedAssistantId)
        : requestedWorkspaceId
          ? await getWorkspacePrimaryAssistant(user.id, requestedWorkspaceId)
          : await getDefaultAssistant(user.id)
      if (!assistant) {
        sendEvent('error', { error: 'No assistant found' })
        options.analytics?.logEvent({
          userId: user.id,
          eventName: 'chat_setup_error', channelType: 'web',
          metadata: { error_type: sanitize('no_assistant'), stage: sanitize('assistant_lookup') },
        })
        res.end()
        return
      }

      // Workspace gate: when the request carries an explicit workspaceId,
      // the resolved assistant must belong to that workspace. Closes the
      // gap where a stale `active-assistant-id` localStorage value (e.g.
      // the user's Personal-workspace primary) silently answered chats
      // typed inside a workspace where they meant a workspace-scoped
      // assistant. See docs/architecture/platform/workspaces.md →
      // "Workspace-aware chat routing".
      if (requestedWorkspaceId && assistant.workspaceId !== requestedWorkspaceId) {
        sendEvent('error', {
          error: 'assistant_workspace_mismatch',
          message: 'The selected assistant is not in this workspace. Pick one from this workspace, or switch workspaces.',
        })
        options.analytics?.logEvent({
          userId: user.id,
          eventName: 'chat_setup_error', channelType: 'web',
          metadata: {
            error_type: sanitize('assistant_workspace_mismatch'),
            stage: sanitize('workspace_gate'),
            workspace_id: sanitize(requestedWorkspaceId),
            assistant_workspace_id: sanitize(assistant.workspaceId ?? ''),
          },
        })
        res.end()
        return
      }
      assistantIdForError = assistant.id

      // Feed (publishing) app assistants never run research mode — the
      // global research addendum is worker-centric and adds nothing to a
      // publishing turn. Doc IS allowed: a doc research turn keeps its
      // authoring tools and web search (it never enters coordinator mode —
      // that gate is `appAssistantForbidsCoordinator` at the splitter branch
      // below), swaps in the research soul, and authors findings to the page.
      // The adaptive (silent) path stays closed for ALL app assistants via
      // `isAdaptiveResearchEligible` below; this only governs the EXPLICIT
      // `mode:'research'` toggle. See incident 2026-06-01.
      if (appAssistantForbidsResearch(assistant.kind)) {
        researchMode = false
      }

      // Resolve the workspace plan — governs model tier + budget gate.
      if (assistant.workspaceId) {
        userPlan = await getWorkspacePlan(assistant.workspaceId)
      }

      // Workspace BYO LLM key resolution. When the workspace has set its own
      // Gemini key, the main response runs against a provider built from THAT
      // key and the turn is NOT billed for LLM usage (MCP/memory ops are
      // unaffected — they bill as today). When no BYO key is set we keep the
      // platform provider and platform billing.
      //
      // A SYSTEM-level decrypt is used here (no acting user) because the chat
      // request is already authenticated/authorized for this assistant's
      // workspace; the key is consumed for provider construction only and is
      // NEVER logged or returned. If a BYO key is set but the provider rejects
      // it (invalid/quota), the error surfaces to the user via the normal
      // query-loop error path — we deliberately do NOT fall back to the
      // platform key, which would silently charge them.
      let turnProvider: LLMProvider = options.provider
      let usedByoKey = false
      if (
        assistant.workspaceId &&
        options.llmProviderSettingsStore &&
        options.buildWorkspaceProvider
      ) {
        try {
          const byoKey = await options.llmProviderSettingsStore.getPlaintextKeySystem({
            workspaceId: assistant.workspaceId,
            provider: 'gemini',
          })
          if (byoKey) {
            turnProvider = options.buildWorkspaceProvider(byoKey)
            usedByoKey = true
          }
        } catch (err) {
          // A decrypt/store failure must not silently downgrade a BYO workspace
          // to platform billing — but it also must not crash the turn. Log
          // (without the key) and keep the platform provider; billing stays as
          // platform, which is the safe (non-undercharging) default.
          console.error('[chat] BYO LLM key resolution failed:', (err as Error).message)
        }
      }

      // ── Giant-paste promotion (large-content-artifacts §Phase 3.1) ──
      // An over-threshold paste (8K tokens, CJK-aware) becomes a durable
      // artifact; the turn (and the persisted user row) carries the manifest
      // + head excerpt instead. Runs before every message consumer below.
      // Failure or no promoter → the original paste flows through unchanged.
      if (message && options.artifactPromoter && assistant.workspaceId && shouldPromotePaste(message)) {
        const promoted = await promotePastedText({
          text: message,
          workspaceId: assistant.workspaceId,
          actingUserId: user.id,
          assistantId: assistant.id,
          promote: options.artifactPromoter,
        }).catch((err) => {
          console.error('[chat] paste promotion failed (keeping original text):', err)
          return null
        })
        if (promoted) message = promoted.replaced
      }

      // Adaptive research entry. When the request didn't pin a mode, run a
      // cheap Gemini-Flash-Lite classifier to decide whether this message
      // warrants research mode. If yes, flip `researchMode = true` so the
      // existing quota gate / model upgrade / worker pipeline downstream
      // kicks in just like manual entry. Gated by `isAdaptiveResearchEligible`:
      // skipped on free plans, on assistants outside a workspace (research
      // requires workspace billing), and on `kind='app'` assistants
      // (doc/feed — research mode strips the very authoring tools they
      // need, so silent auto-entry would break their core job).
      //
      // The LLM call happens here; usage gets recorded later, once the
      // session + user message rows exist for attribution. We carry the
      // classifier result through `adaptiveResearchOverhead`.
      // Operate-site override (docs/architecture/engine/coordinator-pattern.md
      // → "Adaptive entry and the operate-site override"): a request to open /
      // browse / log into / act on ONE named site or URL must keep the normal
      // query loop — the coordinator allowlist and the research workers'
      // read-only boot snapshot structurally exclude every computer-use tool,
      // so entering delegation makes the browse impossible (incident
      // 2026-07-13: "browse luma" → 69-webSearch coordinator fan-out, zero
      // browser calls). Computed deterministically here so `mode:'default'`
      // and classifier-ineligible turns are covered too; the adaptive
      // classifier below ORs in its language-agnostic verdict. It only gates
      // the AUTOMATIC delegation triggers (adaptive entry, the Pro/Max
      // splitter, the Flash standard preflight) — the explicit research
      // toggle wins, which the `!researchMode` guard encodes.
      let operateSiteIntent = !researchMode && !!message && detectOperateSiteIntent(message)
      let adaptiveResearchOverhead: {
        model: string | null
        usage: TokenUsage | null
        reason: string | null
      } | null = null
      if (
        !researchMode &&
        message &&
        isAdaptiveResearchEligible({
          requestedMode,
          workspaceId: assistant.workspaceId,
          userPlan,
          assistantKind: assistant.kind,
        })
      ) {
        const { classifyResearchIntent } = await import('@use-brian/core')
        const adaptive = await classifyResearchIntent({
          provider: options.provider,
          message,
        }).catch(() => ({ research: false, operateSite: false, reason: null, usage: null, model: null }))
        adaptiveResearchOverhead = {
          model: adaptive.model,
          usage: adaptive.usage,
          reason: adaptive.reason,
        }
        operateSiteIntent = operateSiteIntent || adaptive.operateSite
        if (adaptive.research) {
          researchMode = true
          // `phase` is a stable, client-localizable code; `message` stays for
          // non-web consumers and logs. The web client renders a research
          // banner off `phase` (see chat-experience.tsx `case "status"`).
          sendEvent('status', { phase: 'research_detected', message: 'Detected deep-research intent…' })
        }
      }

      // Research-mode quota gate (mig 185_workspace_research_quota).
      //
      // `mode: 'research'` is the brain empty-state's deep-research entry
      // point — forces coordinator mode + max tier model + 100-turn ceiling
      // (set further below). Free workspaces get 5 lifetime turns as the
      // onboarding wedge; paid plans (pro/max_5x/max_10x/enterprise) bypass
      // the cap but still increment the counter so the chrome can surface
      // "used N this month" if we ever want to.
      //
      // Increment happens AFTER the gate passes so a denied request never
      // costs a slot. The catch in incrementWorkspaceResearchUsed is
      // tolerant — a counter-write failure can't deny a turn the gate
      // already approved, but it also won't double-count on retry.
      let researchUsedAfter: number | null = null
      if (researchMode) {
        if (!assistant.workspaceId) {
          sendEvent('error', { error: 'Research mode requires a workspace assistant' })
          res.end()
          return
        }
        const used = await getWorkspaceResearchUsed(assistant.workspaceId)
        const isPaid = userPlan !== 'free'
        if (!isPaid && used >= FREE_RESEARCH_QUOTA) {
          // 402 Payment Required is the cleanest mapping — the gate is a
          // billing one, not an auth or shape failure. Frontend handles
          // by surfacing the upgrade prompt.
          sendEvent('research_quota_exhausted', {
            used,
            quota: FREE_RESEARCH_QUOTA,
            upgradeUrl: '/plans',
          })
          sendEvent('error', {
            error: 'Research quota exhausted',
            code: 'research_quota_exhausted',
            used,
            quota: FREE_RESEARCH_QUOTA,
          })
          res.end()
          return
        }
        researchUsedAfter = await incrementWorkspaceResearchUsed(assistant.workspaceId)
        // Tell the frontend the new count + remaining so the chrome can
        // update its "N of 5 free" hint without a follow-up GET.
        sendEvent('research_quota', {
          used: researchUsedAfter,
          quota: FREE_RESEARCH_QUOTA,
          isPaid,
        })
      }

      // Q20 blocklist (permissions.md §Per-assistant user blocklist): if the
      // inbound author is in this assistant's blocked_user_ids, the assistant
      // appears not to exist for them — close the stream with no event and
      // no error, and do not spawn a turn or touch session state.
      if (isUserBlocked(assistant.blockedUserIds, user.id)) {
        res.end()
        return
      }

      // Resolve session — try by ID first (continuing an existing thread),
      // then by sticky channelId, else create a fresh one.
      //
      // A client that starts a new chat mints a temp UUID and sends it as
      // `sessionId` before any server row exists, so that id misses
      // findSessionById. We fall back to using it AS the sticky channel id:
      // the conversation's first turn creates a row whose channel_id is that
      // temp UUID, and every later turn — even one whose client-side id
      // adoption (the `session` SSE event) raced or was dropped, so it
      // resends the same temp id — reunites on that one row via
      // findSessionByChannel. The findOrCreateSession upsert is keyed on the
      // same channel_id tuple, so a near-simultaneous double-send collapses
      // to one row too. Without this fallback the server minted a fresh
      // random-channel session per turn, fragmenting one chat into several
      // Recents rows (each "New Chat" / auto-titled identically). A real
      // persisted id still resolves via findSessionById above, so continuing
      // an existing thread is unaffected. See
      // docs/architecture/context-engine/session-messages.md → "Web chat: id
      // resolution + sticky-channel fallback".
      let session
      let isNewSession = false
      if (requestedSessionId) {
        session = await findSessionById(requestedSessionId)
      }
      const stickyChannelId = resolveStickyChannelId(requestedChannelId, requestedSessionId)
      if (!session && stickyChannelId) {
        session = await findSessionByChannel({
          assistantId: assistant.id,
          userId: user.id,
          channelType: 'web',
          channelId: stickyChannelId,
        })
      }
      if (!session) {
        const channelId = stickyChannelId || crypto.randomUUID()
        // Migration 187 — tag the session with the surface it was
        // created from so the chat panel's Recents can scope to that
        // surface. Acceptable values: brain | studio | workflow |
        // doc | chat | approvals | knowledge-base (migration 255 added
        // the last two for the consolidated app-web surfaces). Other
        // values get coerced to null so an attacker can't write garbage
        // into the column. Keep in sync with the migration 255 CHECK + the
        // KNOWN_ORIGINS set in sessions.ts.
        const KNOWN_ORIGINS = new Set(['brain', 'studio', 'workflow', 'doc', 'chat', 'approvals', 'knowledge-base'])
        const rawOrigin = typeof (req.body as { appOrigin?: unknown })?.appOrigin === 'string'
          ? (req.body as { appOrigin: string }).appOrigin
          : null
        const appOrigin = rawOrigin && KNOWN_ORIGINS.has(rawOrigin) ? rawOrigin : null
        session = await findOrCreateSession({
          assistantId: assistant.id,
          userId: user.id,
          channelType: 'web',
          channelId,
          appOrigin,
        })
        isNewSession = true
      }

      // Defence-in-depth: a `requestedSessionId` lookup via findSessionById
      // does no assistant-scope check, so reject any cross-assistant id.
      // (`getUserAssistant` already verified the JWT user has access to
      // `assistant.id`; this just stops a user from naming someone else's
      // session under their own assistant context.)
      if (session.assistantId !== assistant.id) {
        sendEvent('error', { error: 'Session does not belong to this assistant' })
        res.end()
        return
      }

      // Per-user ownership/clearance gate on the resolved session. For a
      // SHARED workspace-primary assistant, another member's session carries
      // the same assistant.id, so the check above passes — without this a
      // member could resume, append to, and (via truncateFromMessageId)
      // delete another member's private session by naming its id. Reuses the
      // same gate as GET /:id/messages so reads and writes can't drift:
      // workspace/draft sessions allow any authorized member, every other
      // session is owner-only. (WS3 session-resume scoping, 2026-07-07.)
      const sessionDenied = await gateSessionRead(user.id, session)
      if (sessionDenied) {
        sendEvent('error', { error: sessionDenied.error })
        res.end()
        return
      }

      // Live multi-watcher sessions (draft mode): any participant can drive a
      // turn, but only one at a time. Reject concurrent turns with a clean 409
      // so the frontend can render "someone else is in a turn".
      if (session.mode === 'draft' && session.status === 'running') {
        sendEvent('error', {
          error: 'Another team member is currently sending a turn in this draft. Please wait until it completes.',
          code: 'draft_session_busy',
        })
        res.end()
        return
      }

      sessionIdForError = session.id

      // askQuestion suspend-resume guard (Phase 2). If this session is
      // currently suspended on a pending question, reject the new
      // message with a structured 409-equivalent SSE event so the
      // frontend can render "answer or cancel" instead of starting a
      // fresh turn. See docs/architecture/engine/askquestion-suspend-resume.md.
      if (assistant.workspaceId) {
        try {
          const pending = await options.pendingApprovalsStore.listPendingForWorkspace(
            user.id,
            assistant.workspaceId,
          )
          const pendingQuestion = pending.find(
            (r) => r.kind === 'question' && r.blockingSessionId === session.id,
          )
          if (pendingQuestion) {
            sendEvent('error', {
              code: 'pending_question_exists',
              error:
                'This session is waiting on your answer to a previous question. ' +
                'Answer it or cancel before sending a new message.',
              approvalId: pendingQuestion.id,
              question:
                typeof pendingQuestion.approvalPayload.question === 'string'
                  ? pendingQuestion.approvalPayload.question
                  : null,
              expiresAt: pendingQuestion.expiresAt,
            })
            res.end()
            return
          }
        } catch (err) {
          // Don't 500 if the pending check itself fails — let the turn
          // proceed (degraded UX is better than blocking entirely).
          console.warn('[chat] pending-question check failed:', err)
        }
      }

      // Send session ID immediately so frontend can track it
      sendEvent('session', { sessionId: session.id })

      // Analytics: only log when a new session is created
      if (isNewSession) {
        options.analytics?.logEvent({
          userId: user.id, assistantId: assistant.id, sessionId: session.id,
          eventName: 'session_started', channelType: 'web',
          metadata: {
            model_requested: sanitize(requestedModel ?? 'standard'),
            ...(req.clientTimezone ? { client_tz: sanitize(req.clientTimezone), tz_source: sanitize('header') } : {}),
          },
        })
      }

      // v2 (brain_extraction_v2_enabled): regex pattern extraction
      // retired. Chat-side facts now land via the chat-compaction
      // Episode → Pipeline B path (see `chatEpisodeIngestor` in
      // apps/api/src/index.ts), which produces structured entities /
      // tasks / memories with proper authorship + justification. The
      // regex extractor (`extractPatterns`) only ever produced loose
      // `preference`-typed memories and was a frequent source of
      // over-classification — exactly the pain Q9 of the design thread
      // resolves.

      // Nag-loop resolution: if any of the user's active scheduled jobs
      // has an open `activeNag` and the message contains its `nagUntilKeyword`,
      // clear the activeNag and cancel pending same-day follow-ups.
      // Fire-and-forget — failures here must not block the chat turn.
      // See packages/api/src/scheduling/nag-resolver.ts.
      if (options.jobStore && message) {
        const jobStore = options.jobStore
        detectAndResolveNags({ userId: user.id, userMessage: message, jobStore })
          .then((res) => {
            if (res.resolved > 0) {
              options.analytics?.logEvent({
                userId: user.id, assistantId: assistant.id, sessionId: session.id,
                eventName: 'scheduled_job.nag_resolved', channelType: 'web',
                metadata: {
                  resolved_count: res.resolved,
                  job_ids: sanitize(res.jobIds.join(',').slice(0, 200)),
                },
              })
            }
          })
          .catch((err) => {
            console.error('Nag resolution failed:', err)
          })
      }
      // `memory_extracted` analytics event retired alongside `extractPatterns`
      // (Q9, 2026-05-28). Pipeline B emits its own per-write analytics
      // when extraction lands; the per-turn regex counter is no longer
      // meaningful.

      // Build content blocks — text attachments inlined as text, images as
      // multimodal image blocks, large non-text files as references.
      const userContentBlocks: Array<
        | { type: 'text'; text: string }
        | { type: 'image'; mimeType: string; data: string }
      > = []

      let attachmentContext = ''
      // Voice transcription calls hit Gemini and must be attributed as
      // `overhead:transcription` — collect results here and record once we
      // have the stored user_message_id below.
      const transcriptions: TranscribeResult[] = []
      if (hasFiles && options.fileStore) {
        // Gate each client-supplied fileId by the turn's identity so a file
        // from another workspace/user is filtered out (audit #3). The read
        // clearance ceiling isn't resolved this early in the handler, but the
        // workspace + user-private gate already closes the cross-tenant path
        // (uploads are stamped user_id=uploader). `assistantKind` drives the
        // predicate's visibility double.
        const fileCtx = {
          workspaceId: assistant.workspaceId ?? '',
          userId: user.id,
          assistantId: assistant.id,
          assistantKind: assistant.kind ?? 'standard',
        }
        const fetched = await Promise.all(
          fileIds!.map((id) => options.fileStore!.get(id, fileCtx).catch(() => null)),
        )
        const validFiles = fetched.filter((f): f is NonNullable<typeof f> => f !== null)

        if (validFiles.length > 0) {
          const textParts: string[] = []
          for (const file of validFiles) {
            const isImage = file.mimeType.startsWith('image/')
            const isPdf = file.mimeType === 'application/pdf'
            const isAudio = file.mimeType.startsWith('audio/')
            // Inline-media types (image + PDF) are always emitted as a multimodal
            // `image` block regardless of size. Text-like files gate on size.
            const isTextLike = !isImage && !isPdf && !isAudio && shouldInline(file.content)

            if (isTextLike) {
              textParts.push(
                `<attached_file id="${file.id}" name="${file.fileName}" type="${file.mimeType}">\n${file.content}\n</attached_file>`,
              )
            } else if (isImage || isPdf) {
              // Images + PDFs share the `inlineData` path. Content must be
              // stored as "data:<mime>;base64,<data>" — anything else is a
              // legacy/corrupted row (e.g. pre-native-PDF sessions that
              // stored a "Failed to parse" sentinel string). Refuse to hand
              // garbage to Gemini as bogus base64 — that produces a silent
              // empty-turn ("I couldn't generate a response").
              const match = file.content.match(/^data:[^;]+;base64,(.+)$/)
              if (match) {
                userContentBlocks.push({
                  type: 'image',
                  mimeType: file.mimeType,
                  data: match[1],
                })
                textParts.push(
                  `<attached_file id="${file.id}" name="${file.fileName}" type="${file.mimeType}">[${isPdf ? 'pdf' : 'image'}]</attached_file>`,
                )
              } else {
                textParts.push(
                  `<attached_file id="${file.id}" name="${file.fileName}" type="${file.mimeType}">[This ${isPdf ? 'PDF' : 'image'} was uploaded before the current file pipeline and can't be read. Ask the user to re-upload it.]</attached_file>`,
                )
              }
            } else if (isAudio) {
              // Voice preflight — transcribe just-in-time via Gemini. Transcript
              // becomes an `[voice] <transcript>` text part; raw audio is NOT
              // sent inline to the LLM (the transcript is authoritative).
              // See docs/architecture/media/transcription.md.
              const match = file.content.match(/^data:[^;]+;base64,(.+)$/)
              const base64Data = match ? match[1] : file.content
              let transcription: TranscribeResult | undefined
              if (options.voiceTranscription) {
                const buffer = Buffer.from(base64Data, 'base64')
                transcription = await transcribeFirstAudio(
                  [{ buffer, mime: file.mimeType, index: 0 }],
                  {
                    enabled: options.voiceTranscription.enabled,
                    apiKey: options.voiceTranscription.apiKey,
                    ...(options.voiceTranscription.backend
                      ? { backend: options.voiceTranscription.backend }
                      : {}),
                    model: options.voiceTranscription.model,
                  },
                )
                if (transcription) transcriptions.push(transcription)
              }
              textParts.push(
                transcription
                  ? `[voice] ${transcription.text}`
                  : `<attached_file id="${file.id}" name="${file.fileName}" type="${file.mimeType}">[voice note — transcription unavailable]</attached_file>`,
              )
            } else if (file.artifactFileId) {
              // The upload was silently promoted to a durable artifact
              // (large-content-artifacts §Phase 2.3): the turn carries a
              // compact manifest — the artifact id + searchFileContent hints —
              // never the raw content. Persisted in session_messages, so the
              // id outlives the file_cache TTL.
              textParts.push(
                renderArtifactManifest({
                  fileId: file.artifactFileId,
                  fileName: file.fileName,
                  mime: file.mimeType,
                  sizeBytes: file.sizeBytes,
                  charLength: file.content.length,
                  ...(file.artifactSegmentCount != null ? { segmentCount: file.artifactSegmentCount } : {}),
                  summary: file.summary,
                  status: file.artifactSegmentCount && file.artifactSegmentCount > 0 ? 'ready' : 'pending',
                }),
              )
            } else {
              textParts.push(
                `<attached_file id="${file.id}" name="${file.fileName}" type="${file.mimeType}">[Large file. Use readFileContent with fileId="${file.id}" to retrieve full content.]</attached_file>`,
              )
            }
          }
          if (textParts.length > 0) attachmentContext = textParts.join('\n\n') + '\n\n'
        }
      }

      // Recordings attached in THIS turn (recording-to-brain, chat entry). Unlike
      // a fileId, a recording is NOT content the turn can read — it transcribes
      // async on the worker, and its notes land on its own brief page. So the
      // turn is handed an ACKNOWLEDGE + LINK instruction, never the audio: the
      // model confirms and shares the link rather than pretending to summarize a
      // transcript that does not exist yet. Fetched under the user's RLS, so a
      // recording they cannot see is silently skipped.
      let recordingContext = ''
      if (Array.isArray(attachedRecordingIds) && attachedRecordingIds.length > 0) {
        const recs = await Promise.all(
          attachedRecordingIds.map((id) => getRecording(user.id, id).catch(() => null)),
        )
        const lines = recs
          .filter((r): r is NonNullable<typeof r> => r !== null)
          .map((r) => {
            const title = r.title ?? r.fileName ?? 'recording'
            const url = `/w/${r.workspaceId}/recordings/${r.id}`
            return `- "${title}" → ${url}`
          })
        if (lines.length > 0) {
          recordingContext =
            `[The user attached ${lines.length === 1 ? 'a recording' : `${lines.length} recordings`} to this message. ` +
            `Each is transcribing in the background; its notes and action items will appear on its own page. ` +
            `Acknowledge briefly and share the link(s) as markdown. Do NOT attempt to summarize the content — ` +
            `the transcript is not ready yet. Recordings:\n${lines.join('\n')}]\n\n`
        }
      }

      const userMessageText = recordingContext + attachmentContext + (message ?? '')

      // Add text block after image blocks so images are seen in context
      if (userMessageText) {
        userContentBlocks.push({ type: 'text', text: userMessageText })
      }

      // Truncate from a given message (for retry/edit — destroy-and-regenerate).
      // Preserve the signal: log what was retried so we have history AND inject
      // a hint into the next turn so the model knows the user was dissatisfied.
      let retryHint = ''
      if (truncateFromMessageId) {
        try {
          // Scope the truncate to the caller's own resolved session — a
          // foreign message id resolves to a different session and is refused
          // (WS3 cross-session chat-deletion fix).
          const { deletedMessages } = await truncateMessagesFrom(truncateFromMessageId, session.id)

          // Find the old user prompt and the old assistant response (if any)
          const oldUser = deletedMessages.find((m) => m.role === 'user')
          const oldAssistant = deletedMessages.find((m) => m.role === 'assistant')

          // Regenerating an as-yet-unanswered prompt with identical text (no
          // prior assistant turn) is not a user "retry" — it's a kickoff
          // dispatcher engaging the chat loop over a seeded first message.
          // Skip the retry/edit analytics so it doesn't inflate retry metrics.
          const isUnansweredRegen =
            !oldAssistant && !!oldUser && message === extractMessageText(oldUser)

          // Log to analytics_events for metrics + future analysis
          if (!isUnansweredRegen) {
            const { query: dbQuery } = await import('../db/client.js')
            await dbQuery(
              `INSERT INTO analytics_events (user_id, session_id, event_name, metadata, channel_type)
               VALUES ($1, $2, $3, $4, 'web')`,
              [
                user.id,
                session.id,
                oldUser && message !== extractMessageText(oldUser) ? 'message_edited' : 'message_retried',
                JSON.stringify({
                  truncatedFromMessageId: truncateFromMessageId,
                  deletedCount: deletedMessages.length,
                  oldPromptPreview: oldUser ? extractMessageText(oldUser).slice(0, 200) : null,
                  oldResponsePreview: oldAssistant ? extractMessageText(oldAssistant).slice(0, 300) : null,
                  newPromptPreview: (message ?? '').slice(0, 200),
                }),
              ],
            ).catch((err) => console.error('Retry logging failed:', err))
          }

          // Inject a hint so the model knows this is a retry/edit.
          // Only inject if there was a previous assistant response to react to.
          if (oldAssistant) {
            const isEdit = oldUser && message && extractMessageText(oldUser) !== message
            retryHint = isEdit
              ? '[Note: the user edited their previous message. Your earlier response did not satisfy them. Try a different approach or address their revised intent.]\n\n'
              : '[Note: the user retried this message. Your previous response did not satisfy them. Take a different angle — do not repeat the same structure, examples, or recommendations.]\n\n'
          }
        } catch (err) {
          console.error('Truncate failed:', err)
        }
      }

      // ── Reply resolution + topic classification ────────────────
      // Resolve the replied-to message text (if any) and classify the
      // current turn's topic. Classifier input: recent user turns, known
      // topics in the session, the reply target's text as a strong prior.
      const replyResolved = await resolveReplyText({
        channelType: 'web',
        replyToMessageId: replyTo?.id ?? null,
        session,
        clientSnippet: replyTo?.text,
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
          provider: options.provider,
          model: 'gemini-flash',
          recentUserTurns,
          replyToText: replyResolved?.text ?? null,
          currentMessage: userMessageText,
          knownTopicsThisSession: knownTopics,
        })
      } catch (err) {
        console.error('[chat] topic classifier failed:', err)
      }

      // Execution-plan lifecycle (anti-leak). Reuse the topic-classifier
      // verdict (decision E): a clean topic SHIFT demotes the active attempt
      // to `dormant` so its `# Active plan` block stops injecting on the
      // off-topic turn (built just below); RESUMING an earlier topic
      // reactivates the most-recent dormant attempt. Runs before
      // buildActivePlanBlock so the transition takes effect this turn.
      if (options.planStore && classification) {
        try {
          if (classification.state === 'shift') {
            const activeId = await options.planStore.activeAttemptId(session.id)
            if (activeId) {
              await options.planStore.setAttemptState({
                sessionId: session.id, attemptId: activeId, state: 'dormant',
              })
            }
          } else if (classification.state === 'resume') {
            const dormantId = await options.planStore.recentDormantAttemptId(session.id)
            if (dormantId) {
              await options.planStore.setAttemptState({
                sessionId: session.id, attemptId: dormantId, state: 'active',
              })
            }
          }
        } catch (err) {
          console.error('[chat] plan lifecycle transition failed:', err)
        }
      }

      // Store user message — capture the DB-assigned ID so the client can
      // reference it later for retry/edit/feedback actions.
      // For team-shared draft sessions, stamp the per-message author so
      // collaborators can see "alice asked, bob refined" attribution.
      const storedUserMsg = await addSessionMessage({
        sessionId: session.id,
        role: 'user',
        content: userContentBlocks.length > 0
          ? userContentBlocks
          : [{ type: 'text', text: userMessageText }],
        replyToText: replyResolved?.text ?? null,
        topicLabel: classification?.topic_label ?? null,
        topicConfidence: classification?.confidence ?? null,
        // Attribute the human author on multi-participant sessions: draft-mode
        // sessions ('draft') AND doc comment threads ('doc_thread'), where
        // several people + the AI share one session and per-message authorship
        // is surfaced.
        senderUserId:
          session.mode === 'draft' || session.channelType === 'doc_thread'
            ? user.id
            : null,
      })
      sendEvent('user_message_saved', {
        id: storedUserMsg.id,
        ...(session.mode === 'draft' ? { senderUserId: user.id } : {}),
      })

      // Adaptive research-classifier overhead — the Gemini call happened
      // earlier in this turn (before session existed), so we deferred the
      // usage record to here. Skipped when the classifier didn't run.
      if (adaptiveResearchOverhead) {
        await recordOverheadUsage({
          usageStore: options.usageStore,
          userId: user.id,
          assistantId: assistant.id,
          sessionId: session.id,
          userMessageId: storedUserMsg.id,
          model: adaptiveResearchOverhead.model,
          usage: adaptiveResearchOverhead.usage,
          source: 'overhead:classifier',
          triggerKey: 'adaptive_research_classifier',
        })
      }
      // Mirror to the session-event bus so other watchers of a live
      // draft-mode session see the new user turn appear live.
      if (session.mode === 'draft') {
        publishSessionEvent({
          kind: 'user_message_saved',
          sessionId: session.id,
          payload: {
            id: storedUserMsg.id,
            sequenceNum: storedUserMsg.sequenceNum,
            senderUserId: user.id,
            content: storedUserMsg.content,
          },
        })
        publishSessionEvent({
          kind: 'turn_started',
          sessionId: session.id,
          payload: { senderUserId: user.id },
        })
      }

      // Attribute classifier tokens as overhead (excluded from budget).
      await recordOverheadUsage({
        usageStore: options.usageStore,
        userId: user.id,
        assistantId: assistant.id,
        sessionId: session.id,
        userMessageId: storedUserMsg.id,
        model: classification?.model ?? null,
        usage: classification?.usage,
        source: 'overhead:classifier',
      })

      // Attribute voice transcription tokens as overhead. One row per audio
      // attachment — the Gemini call is separate per file.
      for (const t of transcriptions) {
        await recordOverheadUsage({
          usageStore: options.usageStore,
          userId: user.id,
          assistantId: assistant.id,
          sessionId: session.id,
          userMessageId: storedUserMsg.id,
          model: t.model,
          usage: t.usage,
          source: 'overhead:transcription',
        })
      }

      // Load history. Run two repair passes unconditionally — both are
      // idempotent and run on every request as defence-in-depth against
      // legacy rows:
      //
      //   1. `ensureToolResultPairing` fills in synthetic tool_results for
      //      any orphan tool_use and strips dangling tool_results. Without
      //      this, every provider rejects the malformed history.
      //
      //   2. `stripUnsignedToolUses` drops pre-signature tool_use blocks
      //      (plus their paired results). Gemini 3.x requires a
      //      `thoughtSignature` on every functionCall that reappears in
      //      history; rows persisted before the signature-round-trip fix
      //      will fail the next call otherwise. Going forward, the Gemini
      //      provider emits signatures which the accumulator attaches to
      //      the ContentBlock and the chat route persists as-is into JSONB.
      //
      // See docs/architecture/engine/query-loop.md → "Tool-pairing
      // invariant" and docs/architecture/engine/provider-abstraction.md →
      // "Provider signatures".
      // `fromSequence` skips rows already compacted into the most recent
      // boundary; null (never compacted) loads full history.
      const dbMessages = await getSessionMessages(session.id, {
        fromSequence: session.compactBoundarySequence,
      })

      // Proactive compaction check (web = 1.0× threshold, linear profile).
      // Web chat: the authenticated user IS the owner, so ownerId === user.id.
      // runProactiveCompaction owns stamping + pairing + summary-prepend
      // internally. We apply web-only post-transforms (stripUnsignedToolUses,
      // retryHint injection) to the returned message array before the query
      // loop.
      const compactionResult = await runProactiveCompaction({
        sessionMessages: dbMessages,
        timezone: user.timezone ?? 'UTC',
        session,
        tier: modelToCompactionTier(resolveModel(requestedModel, userPlan, 'ok')),
        channelClass: 'web',
        profile: 'linear',
        provider: options.provider,
        systemPrompt: options.systemPrompt,
        assistantId: assistant.id,
        userId: user.id,
        ownerId: user.id,
        channelType: 'web',
        memoryStore: options.memoryStore,
        episodicStore: options.episodicStore,
        sessionStateStore: options.sessionStateStore,
        analytics: options.analytics,
        usageStore: options.usageStore,
        userMessageId: storedUserMsg.id,
        // Company-brain ingest (WU-3.6) — extract a web_chat Episode from
        // the compacted window. Both gate on a workspace-scoped assistant.
        workspaceId: assistant.workspaceId ?? undefined,
        chatEpisodeIngestor: options.chatEpisodeIngestor,
      })
      // Gate on the serving provider: the signature strip is a Gemini-only
      // workaround and would erase a Qwen (openai-compat) turn's tool calls
      // from history. Resolve the requested model to its provider here (the
      // budget-final model is resolved later; a pure-Qwen deploy still resolves
      // to Qwen, and the unknown/gemini default fails safe). See tool-pairing.ts.
      let messages: Message[] = stripUnsignedToolUses(
        compactionResult.messages,
        modelRequiresToolSignatures(resolveModel(requestedModel, userPlan, 'ok')),
      )

      // Doc tool-result elision (across-turn context-window control).
      // Doc authoring accumulates a full-page outline in every
      // patchPage/getCurrentPage tool_result; the history reloads them on every
      // turn even though the live page is re-delivered via the turn-context
      // envelope below. Collapse all but the most-recent doc page-state results
      // to a stub. Signature-safe (only rewrites unsigned tool_result bodies) and a
      // no-op on non-doc histories, so it runs on every request as
      // defence-in-depth, like the two transforms above. See
      // docs/architecture/engine/query-loop.md → "Doc tool-result elision".
      messages = elideStaleDocToolResults(messages)

      // Inject retry hint into the last user message (the one we just saved).
      // This is what the model sees — the stored DB version remains clean.
      if (retryHint && messages.length > 0) {
        const last = messages[messages.length - 1]
        if (last.role === 'user') {
          const clone: Message = { role: 'user', content:
            typeof last.content === 'string'
              ? retryHint + last.content
              : [{ type: 'text', text: retryHint }, ...last.content],
          }
          messages = [...messages.slice(0, -1), clone]
        }
      }

      // Build memory context + resolve preferred delivery channel.
      // Per-turn callers use the ranked+capped slice so the system prompt
      // stays bounded as the user's memory count grows. See
      // docs/architecture/context-engine/memory-system.md → "Index cap".
      // WU-4.2b: viewer projection ctx used by every per-turn memory read.
      // Personal memories use a personal ctx (workspace falls back to ''
      // for legacy assistants without a workspace — the universal predicate
      // then matches nothing, equivalent to today's empty-result path).
      //
      // Read-side clearance (incident 2026-06-01): the READ ceiling is the
      // acting member's clearance bounded by the assistant's
      // (`min(member, assistant)`), NOT the assistant's alone — otherwise a
      // low-clearance member reads confidential workspace data through a
      // higher-clearance assistant. Writes keep the assistant's clearance
      // (passed as `assistantClearance` on the tool context below).
      const { clearance: readClearance, compartments: readCompartments } =
        await resolveReadCeilingsSystem(
          user.id,
          assistant.workspaceId,
          assistant.clearance,
          assistant.compartments,
        )
      const viewerCtx = {
        workspaceId: assistant.workspaceId ?? '',
        userId: user.id,
        assistantId: assistant.id,
        assistantKind: assistant.kind,
        clearance: readClearance,
        compartments: readCompartments,
      }
      const [soul, identityMemories, rankedIndex, preferredChannel, selfEntityId] = await Promise.all([
        options.memoryStore.getSoul(assistant.id, user.id, 'Use Brian'),
        options.memoryStore.getIdentity(viewerCtx),
        options.memoryStore.getIndexRanked(viewerCtx, PER_TURN_INDEX_CAP),
        getPreferredChannel(assistant.id, user.id),
        getSelfEntityId(viewerCtx),
      ])

      // v2 retrieval-side local-match (Q3b of the brain-ingestion-
      // classification design thread). Fire-and-forget: for each
      // retrieved memory whose summary mentions an existing workspace
      // entity by display_name, write a `mentioned` edge + brain
      // candidate audit row. No LLM in the hot path; failures isolated
      // by the helper. Surfaces only on assistants with a personal
      // brain (`kind='primary' | 'standard'`) — distribution apps have
      // no brain to enrich. Gated by `workspaces.brain_extraction_v2_enabled`
      // is intentionally NOT checked here — the helper is cheap enough
      // and additive that we skip the extra DB hit on the hot path; the
      // edge writes themselves are harmless even when v2 is off.
      if (
        (assistant.kind === 'primary' || assistant.kind === 'standard') &&
        assistant.workspaceId &&
        options.brainCandidateStore &&
        options.entitiesStore &&
        options.entityLinksStore
      ) {
        const matchDeps = {
          ctx: viewerCtx,
          entityStore: options.entitiesStore,
          entityLinks: options.entityLinksStore,
          candidates: options.brainCandidateStore,
        }
        const matchMemories = rankedIndex.rows.map((m) => ({ id: m.id, summary: m.summary }))
        void runLocalMatchCheck(matchMemories, matchDeps).catch((err) => {
          console.warn(
            `[chat/retrieval-match] check failed for user ${user.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        })
      }

      // Fetch team memories + identity (name + purpose) when assistant is team-owned.
      // Team name is surfaced into the L1 soul; purpose grounds the team-vs-user
      // routing decision for saveMemory and the ## Team Context block. Voice
      // rules (category='voice') ride a parallel fetch so they can render in
      // their own L1 section.
      let workspaceIdentityMemories: Awaited<ReturnType<typeof options.memoryStore.getWorkspaceIdentity>> = []
      let teamMemoryIndex: Awaited<ReturnType<typeof options.memoryStore.getWorkspaceIndex>> = []
      let teamVoiceRules: Awaited<ReturnType<typeof options.memoryStore.getWorkspaceMemoriesByCategory>> = []
      let workspaceIdentity: { name: string; purpose: string } | null = null
      if (assistant.workspaceId) {
        ;[workspaceIdentityMemories, teamMemoryIndex, teamVoiceRules, workspaceIdentity] = await Promise.all([
          options.memoryStore.getWorkspaceIdentity(viewerCtx),
          options.memoryStore.getWorkspaceIndex(viewerCtx),
          options.memoryStore.getWorkspaceMemoriesByCategory(viewerCtx, 'voice'),
          getWorkspaceIdentity(assistant.workspaceId),
        ])
      }
      const teamPurpose = workspaceIdentity?.purpose ?? null

      const memoryContext = buildMemoryContext({
        soul,
        identityMemories: identityMemories.map((m) => ({ id: m.id, summary: m.summary, detail: m.detail })),
        memoryIndex: rankedIndex.rows.map((m) => ({ ...m, appId: null })),
        totalNonIdentityCount: rankedIndex.totalCount,
        workspaceIdentityMemories: workspaceIdentityMemories.map((m) => ({ id: m.id, summary: m.summary, detail: m.detail })),
        teamMemoryIndex: teamMemoryIndex.map((m) => ({ ...m, appId: null })),
        teamVoiceRules: teamVoiceRules.map((m) => ({
          id: m.id,
          summary: m.summary,
          detail: m.detail,
          confidence: m.confidence,
        })),
        teamPurpose,
        assistantName: assistant.name,
        selfEntityId,
      })

      // Capability set — used both for the L1 `# Workspace Files` block
      // gating below and for `filterToolsByCapabilities` further down.
      // One fetch, two consumers.
      const activeCapabilities = new Set(await options.capabilityStore.listActive(assistant.id))

      // Workspace files L1 block (Q3 / company-brain §10). Built only when
      // the assistant has the `files` capability AND a workspace AND the
      // store is wired (skipped in dev / smoke without GCS).
      let workspaceFilesContext: string | null = null
      if (
        options.workspaceFilesStore &&
        assistant.workspaceId &&
        activeCapabilities.has('files')
      ) {
        try {
          const rows = await options.workspaceFilesStore.listIndexRanked(
            {
              workspaceId: assistant.workspaceId,
              userId: user.id,
              assistantId: assistant.id,
              assistantKind: assistant.kind,
              // Read ceiling = min(member, assistant) — see readClearance above.
              clearance: readClearance,
              compartments: readCompartments,
            },
            PER_TURN_FILES_INDEX_CAP,
          )
          workspaceFilesContext = buildWorkspaceFilesContext(rows)
        } catch (err) {
          console.error('[chat] workspace-files index fetch failed:', err)
        }
      }

      // Recall logging — TWO separate channels:
      //
      //   (a) `memories.recall_count` aggregate — historically inflated when
      //       every index-inject bumped the counter. Today only explicit
      //       getMemory tool calls bump `recall_count` (via the tool's
      //       `store.trackRecall` call). Utility is judged post-loop by the
      //       memory nudge.
      //
      //   (b) `memory_recall_events` (mig 167, separate table) — logs
      //       index-inject + tool_call recalls per turn, joins downstream
      //       with feedback to surface bad-outcome memories. Two-phase:
      //       push into the per-turn buffer here / inside the tool, flush
      //       with the assistant message id once it commits.
      //
      // Constructed once per turn so each request has its own queue.
      const recallBuffer = options.memoryRecallEventsStore && assistant.workspaceId
        ? createMemoryRecallBuffer({
            sink: options.memoryRecallEventsStore,
            sessionId: session.id,
            workspaceId: assistant.workspaceId,
            userId: user.id,
          })
        : undefined

      // Push `index_inject` rows for the personal memory index + team
      // memory index (when team-owned). The identityMemories are part of
      // the L1 prompt every turn and are intentionally NOT recall-logged
      // — they're always-on, not "the model reached for them".
      if (recallBuffer) {
        recallBuffer.pushMany(
          rankedIndex.rows.map((m) => m.id),
          'index_inject',
        )
        if (assistant.workspaceId) {
          recallBuffer.pushMany(
            teamMemoryIndex.map((m) => m.id),
            'index_inject',
          )
        }
      }

      // CL-8: per-turn skill invocation buffer. Constructed when we have
      // a workspace-scoped skill store; the `useSkill` tool's
      // `recordInvocation` callback (wired in `injectSkills` below)
      // pushes onto this buffer for every successful pick. Flushed once
      // the assistant message commits — on success, the `succeeded`
      // counter is bumped for each invoked skill. On turn error or
      // empty completion, the buffer is cleared without writes.
      //
      // Synchronous counters (`invocations`, `last_invoked_at`, stale →
      // active reactivation) fire directly from `injectSkills` —
      // they're cumulative pick-counters and must fire even if the
      // turn later errors out.
      //
      // See `docs/architecture/context-engine/memory-consolidation.md` →
      // "Skill invocation feedback (CL-8 lock)".
      const skillInvocationBuffer = options.workspaceSkillStore && assistant.workspaceId
        ? createSkillInvocationBuffer({
            sink: {
              incrementSucceeded: (id) => options.workspaceSkillStore!.incrementSucceeded(id),
              incrementUserCorrectedAfter: (id) =>
                options.workspaceSkillStore!.incrementUserCorrectedAfter(id),
            },
          })
        : undefined

      // Episodic context (topic-scoped history for resume/cross-topic).
      let episodicContext: string | null = null
      if (options.episodicStore && classification) {
        try {
          episodicContext = await fetchEpisodicContext({
            store: options.episodicStore,
            sessionId: session.id,
            classification,
          })
        } catch (err) {
          console.error('[chat] episodic context fetch failed:', err)
        }
      }

      // Session-state block (always-on tier — # Open commitments).
      // Injected every turn regardless of classifier verdict so the model
      // doesn't re-derive resolved commitments from raw history.
      let sessionStateBlock: string | null = null
      if (options.sessionStateStore) {
        try {
          sessionStateBlock = await buildSessionStateBlock({
            store: options.sessionStateStore,
            sessionId: session.id,
          })
        } catch (err) {
          console.error('[chat] session-state block fetch failed:', err)
        }
      }

      // Execution-plan tier. Drive counterpart to # Open commitments — present
      // only while the session has an `active` task attempt (the builder
      // returns null for dormant/archived attempts, so it can't leak).
      let planBlock: string | null = null
      if (options.planStore) {
        try {
          planBlock = await buildActivePlanBlock({
            store: options.planStore,
            sessionId: session.id,
          })
        } catch (err) {
          console.error('[chat] active-plan block fetch failed:', err)
        }
      }

      const anchorTz = user.timezone ?? 'UTC'
      const presenceTz = resolvePresenceTimezone({
        liveClientTz: req.clientTimezone ?? clientTimezone ?? null,
        lastSeenTz: user.lastSeenTz,
        lastSeenTzAt: user.lastSeenTzAt,
        anchorTimezone: anchorTz,
      })
      const now = new Date()
      const currentDateTime = now.toLocaleString('en-US', {
        timeZone: presenceTz,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
        timeZoneName: 'short',
      })
      // Doc surface context — drives doc-skill injection independent of
      // WHICH assistant is talking (default: workspace primary; switchable).
      // On the doc surface the host keeps its own Layer-1 and gets the
      // page-authoring protocol appended as a skill block + the doc tools.
      // (Doc is a surface/skill, not an app type — so this is purely the
      // surface test; `docCtx` is kept as the name the gates below read.)
      const onDocSurface = isDocSurface(session)
      const docCtx = onDocSurface
      const docSkillTurn = docCtx
      // The app-web workspace surfaces (Brain / Studio / Workflow / Approvals /
      // Knowledge-base) get the doc tools too, but with the AMBIENT steering
      // (chat-first, author only on an explicit ask). `docToolsTurn` gates the
      // tool injection + the post-turn auto-title pass; every research /
      // coordinator / outline / presence gate stays keyed to the doc-only
      // `docCtx` / `onDocSurface` so those behaviours don't change off-doc.
      const onAppSurface = isAppSurface(session)
      const docToolsTurn = docCtx || onAppSurface
      let basePrompt = resolveLayer1Prompt({
        defaultPrompt: options.systemPrompt,
        assistant: {
          kind: assistant.kind ?? 'standard',
          name: assistant.name,
          appType: assistant.appType ?? null,
        },
        team: workspaceIdentity
          ? { name: workspaceIdentity.name, purpose: workspaceIdentity.purpose }
          : null,
        resolveAppSoul: options.resolveAppSoul,
      })
      // Follow-up chips are opt-in per client (see _prompt-builder.ts):
      // appended only when the requesting surface declares it renders chips,
      // never for `app` assistants. This is what stops `<followup>` leaking
      // into doc page content.
      basePrompt = maybeAppendFollowupChips(basePrompt, {
        followupChips: requestedFollowupChips,
        assistantKind: assistant.kind ?? 'standard',
      })
      // Workspace-level prompt-evolution snippet. Read once per turn
      // from the table the weekly worker writes to. Bare query (system
      // bypass) — the snippet biases the model toward workspace-wide
      // conventions regardless of which user is currently chatting.
      // Failure mode = no snippet injected; never blocks prompt
      // assembly. See docs/architecture/brain/corrections.md →
      // "Workspace-level prompt evolution".
      let workspaceEvolutionSnippet: string | null = null
      if (assistant.workspaceId) {
        try {
          // Two snippets: memory-side (scope/sensitivity bias from
          // memory_verifications, mig 166) and brain-side (per-primitive
          // delete-rate bias from brain_verifications, mig 179). Both
          // sit in Layer 2 and bias future model saves. Join with a
          // blank line so they read as two distinct guidance blocks.
          const [memoryEvo, brainEvo] = await Promise.all([
            getWorkspaceMemoryEvolution(assistant.workspaceId),
            getBrainEvolution(assistant.workspaceId),
          ])
          const parts = [memoryEvo?.promptSnippet, brainEvo?.promptSnippet].filter(
            (s): s is string => typeof s === 'string' && s.length > 0,
          )
          workspaceEvolutionSnippet = parts.length > 0 ? parts.join('\n\n') : null
        } catch (err) {
          console.error('[chat] workspace evolution snippet fetch failed:', err)
        }
      }

      // Phase 0 doc-context instrumentation: stash the skill block string and
      // (further down) the live outline + page counts so the post-turn meter can
      // attribute tokens per component for the `doc_context_composition`
      // event. See docs/plans/doc-turn-context-optimization.md → Phase 0.
      let docSkillBlockStr: string | null = null
      let docLiveOutlineStr: string | null = null
      let docOutlineBlockCount = 0
      let docPageBlockCount = 0
      let docPageVersion = 0

      // Cache-stable split (2026-06-10): the system prompt sent to the
      // provider carries ONLY the stable sections; every volatile per-turn
      // section (minute clock, topic hint, session state, episodic context,
      // reply context, …) is collected into `turnContextParts` and attached
      // to the newest user message as a <turn_context> block just before the
      // query loop (see attachTurnContext). Volatile bytes in the system
      // prompt sit BEFORE the whole history in the provider request, so one
      // changed byte re-prefilled the entire conversation cold on every
      // turn — the dominant chat latency, worst on the doc surface where the
      // Active-doc-page outline bumped its version on every patch. See
      // docs/architecture/engine/query-loop.md → "Turn-context envelope".
      const splitPrompt = buildSplitSystemPrompt({
        basePrompt,
        // Doc page-authoring steering as a skill addendum. On the doc surface:
        // the full page-first protocol (mode tracks the research toggle, the
        // same split the doc soul used to make). On an app-web workspace
        // surface: the compact AMBIENT block — tools present, chat-first,
        // author a page only on an explicit ask. `null` everywhere else.
        docSkillBlock: docSkillTurn
          ? (docSkillBlockStr = buildDocSkillBlock({
              mode: researchMode ? 'research' : 'page',
              teamName: workspaceIdentity?.name,
              teamPurpose: workspaceIdentity?.purpose ?? undefined,
            }))
          : onAppSurface
            ? (docSkillBlockStr = buildAmbientDocSkillBlock({
                teamName: workspaceIdentity?.name,
                teamPurpose: workspaceIdentity?.purpose ?? undefined,
                // `onAppSurface` guarantees appOrigin is one of the five
                // workspace surfaces (APP_SURFACE_ORIGINS) — the line tells
                // the model which view the dock is mounted over, pairing
                // with the client's "Asking about <surface>" chip.
                surface: session.appOrigin as AmbientSurface,
              }))
            : null,
        assistantInstructions: assistant.systemPrompt,
        workspaceEvolutionSnippet,
        currentDateTime,
        timezone: presenceTz,
        anchorTimezone: anchorTz,
        memoryContext,
        workspaceFilesContext,
        sessionStateBlock,
        activePlanBlock: planBlock,
        episodicContext,
        topicHint: classification,
        replyContext: replyResolved
          ? { text: replyResolved.text, fromAssistant: replyResolved.fromAssistant }
          : null,
      })
      let fullSystemPrompt = splitPrompt.stablePrompt
      // Per-turn context blocks, delivered via the envelope (NOT the system
      // prompt — see the cache-stability note above). Sections appended below
      // push here; the envelope is attached right before the query loop.
      const turnContextParts: string[] = splitPrompt.turnContext
        ? [splitPrompt.turnContext]
        : []

      // ── Dispute pre-pass (grounding-gate claim ledger) ──
      // A dispute-shaped message carrying a figure ("唔係要 look 11萬咩")
      // loads the previous reply's claim provenance so the model re-verifies
      // instead of re-asserting. One indexed read, only on the dispute
      // shape; rides the turn-context envelope so the cached prompt prefix
      // stays byte-stable. See grounding-gate.md → "Dispute pre-pass".
      if (typeof message === 'string' && message && matchesDisputedFigure(message)) {
        try {
          const priorClaims = await getClaimsForLatestAssistantMessage(session.id)
          if (priorClaims.length > 0) {
            turnContextParts.push(buildDisputeContextNote(priorClaims))
          }
        } catch (err) {
          console.warn('[chat] dispute pre-pass failed, continuing without:', err)
        }
      }

      // Uploaded-file save policy. The model previously fell back to a text
      // `saveMemory` when asked to save an attachment — and claimed success.
      // Make the contract explicit: persist the file itself, never substitute
      // a memory, and fail honestly. Tool-agnostic (no tool name) per the
      // Layer-1 tool-awareness rule; capability-gated so it only appears where
      // the file tools actually exist (so a later "save the file" turn that
      // carries no fresh upload still gets the guidance).
      if (activeCapabilities.has('files')) {
        fullSystemPrompt +=
          '\n\n# Saving uploaded files\n' +
          'When the user asks to save, keep, or store an UPLOADED file (a chat or comment attachment, shown by an `<attached_file id="…">` tag in the conversation), persist the FILE ITSELF to the workspace files so the original image / PDF / document is kept — use the id from that tag. ' +
          'Do NOT record a memory as a substitute for the file, and never claim a file was saved when only a note was. ' +
          'If you cannot save the file, say plainly that it could not be saved.'
      }

      // Task autopilot nudge (task-goal-autopilot.md). Capability-gated + dynamic
      // (post-`injectMcpTools`), so naming the goal tools here is allowed — they
      // exist whenever this runs. Without this, the auto-drafted goal is a silent
      // DB row the model never surfaces; this makes the model offer it + enforces
      // the confirm-before-work contract.
      if (activeCapabilities.has('goals')) {
        fullSystemPrompt +=
          '\n\n# Goals for tasks\n' +
          'Every top-level task you create is automatically given a DRAFT goal — a plan to drive that task to done. A draft goal does NOTHING on its own. ' +
          'Right after you create a task, briefly tell the user the goal it was given and ask whether you should work it for them. ' +
          'If they agree, confirm the goal (confirmGoal), then spin it up (workTask) so you complete the task autonomously. ' +
          'NEVER start working a task whose goal is not confirmed: if you are about to work a task and its goal is still a draft, stop and confirm the outcome with the user first. ' +
          'Use listGoals to find a task’s draft goal.'
      }

      // ── Doc outline injection (Lock #5/#6, §5.4) ────────────
      // When a doc page is open in the editor, inject its outline so the
      // model can address blocks by id and plan against the LIVE document.
      // `getVersionedPage` prefers `documents.snapshot_json`, so the
      // outline reflects every human edit — not the frozen `saved_views.page`.
      // The doc page/entity tools themselves are injected further down
      // (post-capability-filter, mirroring the extra-tool inject).
      if (
        docCtx &&
        typeof requestedDocViewId === 'string' &&
        requestedDocViewId
      ) {
        try {
          const [{ createDbDocPageStore }, { buildOutline, renderActivePageOutline }] =
            await Promise.all([
              import('../db/doc-page-store.js'),
              import('@use-brian/core'),
            ])
          const current = await createDbDocPageStore().getVersionedPage(
            user.id,
            requestedDocViewId,
          )
          if (current) {
            const pageForOutline = {
              blocks: current.page.blocks,
              version: current.version,
              title: current.title,
            }
            const outline = buildOutline(pageForOutline, {
              pageId: requestedDocViewId,
              pageVersion: current.version,
              title: current.title,
            })
            // Flat outline for a small / heading-less page (byte-identical to
            // before); the folded large-page map (every heading + relevant
            // sections expanded, the rest collapsed to a getSection pointer) for
            // a large, heading-structured page — Phases 2/3 of the doc
            // turn-context work. The flat-vs-folded gate is the pure, unit-tested
            // `renderActivePageOutline`. See doc-turn-context-optimization.md.
            const lines = renderActivePageOutline(
              pageForOutline,
              outline,
              typeof message === 'string' ? message : '',
            )
            const isEmptyPage = current.page.blocks.length === 0
            const activePageBlock =
              `# Active doc page (id=${outline.pageId}, version=${outline.pageVersion})\n` +
              `Title: ${JSON.stringify(outline.title)}\n` +
              `Blocks:\n${lines || '  (empty page)'}\n\n` +
              buildActivePageInstruction({
                isEmptyPage,
                isCommentThread: session.channelType === 'doc_thread',
              })
            // Rides the turn-context envelope: the outline changes on every
            // patch (version bump + previews), so keeping it out of the
            // system prompt is what keeps the cache prefix stable on the doc
            // surface — the worst offender before the split.
            turnContextParts.push(activePageBlock)
            // Phase 0 capture for the doc-context meter (post-turn emit).
            docLiveOutlineStr = activePageBlock
            docOutlineBlockCount = outline.blocks.length
            docPageBlockCount = current.page.blocks.length
            docPageVersion = current.version

            // Insertion anchor (app-web "Space for AI" on an empty line):
            // the user parked their cursor on a specific block and wants the
            // generation to land THERE, not at the page end. Tell the model to
            // chain `add` ops off that block's id. Only when a concrete anchor
            // rode in on the request — the non-anchored path is byte-identical
            // to before.
            if (
              typeof requestedDocAnchorBlockId === 'string' &&
              requestedDocAnchorBlockId
            ) {
              turnContextParts.push(
                `## Insertion anchor\n` +
                `The user placed their cursor on block \`${requestedDocAnchorBlockId}\` and asked you ` +
                `to generate content there. You MUST apply the change with \`patchPage\` this turn — ` +
                `do NOT describe the change in prose or ask to confirm first; generate the blocks. ` +
                `Insert them immediately after that block: use \`patchPage\` \`add\` ops with ` +
                `\`after: "${requestedDocAnchorBlockId}"\` for the first, then chain each subsequent ` +
                `\`add\` after the previously-added block's id so they land in order at that spot. ` +
                `Do NOT append at the end of the page or call \`renderPage\` unless the user explicitly ` +
                `asks to rebuild the whole page. Whatever you have to say this turn belongs on the page ` +
                `via \`patchPage\`, not as a chat-only reply.`,
              )
            }
          }
        } catch (err) {
          console.error('[chat] doc outline injection failed:', err)
        }

        // ── In-page comment-thread discovery ───────────────────────
        // Surface the page's other comment threads (metadata only) so the AI
        // knows what's already been discussed and reads a thread's conversation
        // on demand via `getCommentThread`. A comment-reply turn (its session is
        // `doc_thread`) sees every thread BUT the one it's replying in; a
        // chat turn (floating dock / Space→AI) sees them all.
        try {
          const [{ createDbCommentThreadStore }, { formatThreadDiscovery }] = await Promise.all([
            import('../db/comment-thread-store.js'),
            import('@use-brian/core'),
          ])
          const summaries = await createDbCommentThreadStore().listThreadSummariesForPage(
            user.id,
            requestedDocViewId,
          )
          const section = formatThreadDiscovery(summaries, {
            variant: session.channelType === 'doc_thread' ? 'thread' : 'chat',
            currentSessionId: session.id,
          })
          if (section) turnContextParts.push(section)
        } catch (err) {
          console.error('[chat] doc thread discovery injection failed:', err)
        }
      }

      // ── Viewing-skill context (Brain skill editor) ──────────────
      // The app-web floating dock sends `viewingSkillRowId` while the user
      // is on the skill editor route. Inject the skill's saved contents as
      // turn context so "this skill" resolves to what they are looking at.
      // Read through the same RLS-scoped workspace list the editor itself
      // uses (`listForWorkspace` + actingUserId), so the chat can never
      // surface a skill the requesting user couldn't open in the editor.
      if (
        typeof requestedViewingSkillRowId === 'string' &&
        requestedViewingSkillRowId &&
        assistant.workspaceId
      ) {
        try {
          const { createDbWorkspaceSkillStore } = await import('../db/skill-store.js')
          const workspaceSkills = await createDbWorkspaceSkillStore().listForWorkspace(
            assistant.workspaceId,
            { actingUserId: user.id },
          )
          const viewedSkill = workspaceSkills.find(
            (s) => s.rowId === requestedViewingSkillRowId && s.state !== 'archived',
          )
          if (viewedSkill) turnContextParts.push(buildViewingSkillBlock(viewedSkill))
        } catch (err) {
          console.error('[chat] viewing-skill context injection failed:', err)
        }
      }

      // ── Viewing-deck context (deck live preview) ────────────────
      // The app-web floating dock sends `viewingDeckId` while the user is
      // on the deck preview route. Workspace-checked against the assistant's
      // workspace so a foreign deck id injects nothing.
      if (
        typeof requestedViewingDeckId === 'string' &&
        requestedViewingDeckId &&
        assistant.workspaceId
      ) {
        try {
          const { createDeckStore } = await import('../db/deck-store.js')
          const viewedDeck = await createDeckStore().getSystem(requestedViewingDeckId)
          if (viewedDeck && viewedDeck.workspaceId === assistant.workspaceId) {
            turnContextParts.push(
              buildViewingDeckBlock({
                id: viewedDeck.id,
                title: viewedDeck.title,
                version: viewedDeck.version,
                slides: viewedDeck.spec.slides,
              }),
            )
          }
        } catch (err) {
          console.error('[chat] viewing-deck context injection failed:', err)
        }
      }

      // ── Pending message delivery hook ──────────────────────────
      if (options.pendingMessageStore) {
        try {
          const pending = await buildPendingContext(options.pendingMessageStore, user.id, assistant.id, 'web')
          // Per-turn pending-delivery queue → envelope, not the system prompt.
          if (pending.promptFragment && pending.promptFragment.trim().length > 0) {
            turnContextParts.push(pending.promptFragment.replace(/^\n+/, ''))
          }
        } catch (err) {
          console.error('[chat] pending message delivery failed:', err)
        }
      }

      // ── Host system-prompt addendum ──────────────────────────
      // A host may add a session-specific prompt block (e.g. a draft-session
      // authoring addendum). Open default: none. Pairs with injectExtraTools
      // below so the prompt and the available tools agree.
      const extraSystemPrompt = options.resolveExtraSystemPrompt?.({
        mode: session.mode,
        channelType: session.channelType,
      })
      if (extraSystemPrompt) {
        fullSystemPrompt += `\n\n${extraSystemPrompt}`
      }

      // Add memory tools (with analytics callbacks)
      const { saveMemory, getMemory, deleteMemory } = createMemoryTools(options.memoryStore, {
        userPlan,
        entityStore: options.entitiesStore,
        entityLinksStore: options.entityLinksStore,
        recallBuffer,
        onEvent: (evt) => {
          if (evt.type === 'memory_created') {
            options.analytics?.logEvent({
              userId: user.id, assistantId: assistant.id, sessionId: session.id,
              eventName: 'memory_created', channelType: 'web',
              metadata: { source: sanitize(evt.source), memory_type: sanitize(evt.memoryType) },
            })
          } else if (evt.type === 'memory_retrieved') {
            options.analytics?.logEvent({
              userId: user.id, assistantId: assistant.id, sessionId: session.id,
              eventName: 'memory_retrieved', channelType: 'web',
              metadata: { source: sanitize(evt.source), result_count: evt.resultCount, hit: evt.resultCount > 0 },
            })
          } else if (evt.type === 'memory_deleted') {
            options.analytics?.logEvent({
              userId: user.id, assistantId: assistant.id, sessionId: session.id,
              eventName: 'memory_deleted', channelType: 'web',
              metadata: { memory_id: sanitize(evt.memoryId) },
            })
          }
        },
      })
      // Capability gate: drop tools the assistant lacks the grant for before
      // MCP / skills layer them on. The tool executor re-checks at invocation.
      // Reuses the set computed near the L1 prompt build above.
      const allTools = filterToolsByCapabilities(new Map(options.tools), activeCapabilities)
      allTools.set('saveMemory', saveMemory)
      allTools.set('getMemory', getMemory)
      allTools.set('deleteMemory', deleteMemory)

      // updateSelfProfile — Identity Phase 2 groundwork. Available
      // whenever the entity store is wired AND the assistant has a
      // workspace; falls back silently otherwise (the tool would
      // error at execute-time without workspace). See
      // docs/architecture/brain/corrections.md.
      if (options.entitiesStore && assistant.workspaceId) {
        const updateSelfProfile = createSelfProfileTool(options.entitiesStore, options.entityLinksStore)
        allTools.set('updateSelfProfile', updateSelfProfile)
      }

      // Tasks (Q1) + CRM (Q2) are constructed at boot in apps/api/src/index.ts
      // and arrive via options.tools. Per-assistant visibility is gated by
      // §17 capability grants ('tasks' / 'crm') applied above by
      // filterToolsByCapabilities — no per-turn injection here.

      // Retrieval (WS-5) — the 6 read tools that expose the company brain
      // (`getEntity`, `search`, `recentEpisodes`, `provenance`, `markUseful`,
      // `aggregate`). Workspace-scoped: requires `assistant.workspaceId`
      // because the permission predicate filters every read on workspace
      // partition (per `permissions.md` P1-12). Personal assistants without a
      // workspace skip the injection — the tools would always error on the
      // workspace check in `actorFromContext`. See
      // `docs/architecture/brain/retrieval-layer.md`.
      if (options.retrievalStore && assistant.workspaceId) {
        // CL-9 retrieval-miss hook closure. Bound here so the detector
        // captures the per-turn user/workspace context — the search
        // tool's hook signature only passes through what `ToolContext`
        // already carries (no extra plumbing through queryLoop). When
        // the detector isn't wired this stays `undefined` and the
        // search tool falls back to its pre-CL-9 behavior.
        const missDetector = options.retrievalMissDetector
        const retrievalTools = createRetrievalTools(options.retrievalStore, {
          onAfterSearch: missDetector
            ? (info) => {
                // Skip if the workspaceId isn't bound — the detector's
                // store is RLS-gated per workspace and a null bind is
                // a no-op anyway. Fire-and-forget; `observe` swallows
                // its own exceptions internally (see detector docstring).
                if (!info.workspaceId) return
                void missDetector.observe({
                  sessionId: info.sessionId,
                  workspaceId: info.workspaceId,
                  userId: info.userId,
                  queryText: info.query,
                  resultIds: info.resultIds,
                })
              }
            : undefined,
          onEvent: (evt) => {
            const metadata: Record<string, number | boolean | ReturnType<typeof sanitize>> = {}
            if (evt.type === 'entity_retrieved') {
              metadata.found = evt.found
            } else if (evt.type === 'search_executed') {
              metadata.result_count = evt.resultCount
            } else if (evt.type === 'recent_episodes_listed') {
              metadata.result_count = evt.resultCount
            } else if (evt.type === 'provenance_walked') {
              metadata.found = evt.found
            } else if (evt.type === 'mark_useful_recorded') {
              metadata.primitive = sanitize(evt.primitive)
            } else if (evt.type === 'aggregate_computed') {
              metadata.result_count = evt.resultCount
              metadata.fn = sanitize(evt.fn)
            } else if (evt.type === 'row_history_walked') {
              metadata.chain_length = evt.chainLength
              metadata.primitive = sanitize(evt.primitive)
            }
            options.analytics?.logEvent({
              userId: user.id,
              assistantId: assistant.id,
              sessionId: session.id,
              eventName: `brain_${evt.type}`,
              channelType: 'web',
              metadata,
            })
          },
        })
        for (const [name, tool] of Object.entries(retrievalTools)) {
          allTools.set(name, tool)
        }
      }

      // Generate mode as a chat tool — fill a blueprint from the brain on request
      // (requiresConfirmation; the cost rides this turn's credit). Workspace-scoped.
      if (options.generateBlueprintTool && assistant.workspaceId) {
        allTools.set(options.generateBlueprintTool.name, options.generateBlueprintTool)
      }

      // Blueprint record surface — save/read typed records in-context, define
      // contracts, discover them. Workspace-scoped like the fill tool.
      if (options.blueprintRecordTools && assistant.workspaceId) {
        for (const tool of options.blueprintRecordTools) {
          allTools.set(tool.name, tool)
        }
      }

      // Brain inbox inspection toolkit — read-only introspection tools.
      // Two surfaces:
      //   1. Brain inbox "Ask about this" drawer
      //      (channel_type='brain_inspection') — any assistant in the
      //      inspection session sees these.
      //   2. Primary workspace assistant in normal chat — so the user
      //      can ask "what happened in this workspace today?" /
      //      "what have you been getting wrong?" without detouring
      //      through the inbox.
      //
      // Personal assistants without a workspace don't get the tools
      // (they'd error on the workspace check inside each tool's
      // execute path).
      const isInspectionSession = session.channelType === 'brain_inspection'
      const isPrimaryWithWorkspace =
        assistant.kind === 'primary' && !!assistant.workspaceId
      if (
        options.inspectionTools &&
        (isInspectionSession || isPrimaryWithWorkspace)
      ) {
        for (const [name, tool] of Object.entries(options.inspectionTools)) {
          allTools.set(name, tool)
        }
      }

      // Per-turn sensitivity accumulator — populated by retrieval +
      // memory + KB reads inside the queryLoop, and read by the
      // connector_action audit hook (via closure through the injected tools)
      // when a connector action succeeds. A single shared instance so
      // the audit's `retrieval_sensitivity_max` is the true max sensitivity
      // of brain rows the model saw this turn — not a conservative
      // `'public'` under-stamp. See `connector-actions.md` → IFC.
      const sensitivityAccumulator = new SensitivityAccumulator()
      const compartmentAccumulator = new CompartmentAccumulator()

      // Per-turn outbound-attachment collector (`sendFile`). Web moves no
      // bytes — the drained list persists onto the final assistant
      // `session_messages.attachments` row and the client downloads via
      // the signed-URL route. See adapter-pattern.md → "Outbound documents".
      const outboundAttachmentCollector = new AttachmentCollector()

      // Connector-action audit deps — engaged only when the assistant
      // is workspace-scoped AND both audit stores are wired. Shared
      // across host-injected extra tools (e.g. an outbound post) AND
      // the MCP inject (Gmail `sendMessage`) so one workspace-scoped chat
      // turn audits both surfaces consistently. See
      // `docs/plans/company-brain/connector-actions.md`.
      const connectorActionAudit =
        assistant.workspaceId &&
        options.connectorActionStore &&
        options.episodesStore &&
        options.buildConnectorActionAudit
          ? options.buildConnectorActionAudit({
              workspaceId: assistant.workspaceId,
              assistantClearance: assistant.clearance,
              // Same instance as the queryLoop's `sensitivity:` accumulator
              // — the loop's tool reads populate it, the audit hooks read
              // `.max` at action time.
              sensitivityAccumulator,
              connectorActionStore: options.connectorActionStore,
              episodesStore: options.episodesStore,
            })
          : undefined

      // Host extra-tool injection — a host may merge additional tools into the
      // turn for certain assistants (e.g. a publishing app's outbound tools).
      // The injected impl does its own assistant-kind/appType + session
      // gating; the open route stays agnostic. Open default: unset.
      if (options.injectExtraTools) {
        try {
          await options.injectExtraTools({
            tools: allTools,
            userId: user.id,
            assistant: {
              id: assistant.id,
              kind: assistant.kind,
              appType: assistant.appType ?? null,
            },
            session: {
              id: session.id,
              mode: session.mode,
              channelType: session.channelType,
            },
            // Connector-action audit — built once above, shared with the MCP
            // inject (Gmail audit). See `connector-actions.md`.
            connectorActionAudit,
          })
        } catch (err) {
          console.error('[chat] extra tool injection failed:', err)
        }
      }

      // Pages the AI wrote this turn (filled by the doc tools' onEvent
      // below). Drives the post-turn auto-title pass (migration 218).
      const docWrittenPageIds = new Set<string>()

      // Doc tools — page authoring (renderPage/patchPage/getBlock/…) +
      // entity tools. Injected for any doc-surface turn (`isDocSurface`) AND
      // for the app-web workspace surfaces (`isAppSurface` — ambient: the
      // tools ride the turn, the skill block above tells the model to author
      // only on an explicit ask).
      // Injected here, post-capability-filter (like the extra-tool inject), so
      // they're always present on a doc turn. `patchPage` writes through the live Yjs doc when
      // DOC_SYNC_URL/SECRET are configured; otherwise it falls back to the
      // legacy CAS path. See `packages/api/src/doc/inject.ts`.
      if (docToolsTurn) {
        try {
          const { injectDocTools } = await import('../doc/inject.js')
          await injectDocTools({
            tools: allTools,
            userId: user.id,
            assistant: {
              id: assistant.id,
              kind: assistant.kind,
              appType: assistant.appType,
              workspaceId: assistant.workspaceId,
            },
            // Surface-context injection: true when doc tools are riding the
            // turn — the doc surface itself, or a workspace surface getting
            // the ambient injection.
            docSurface: docToolsTurn,
            // Cached-file store for the `importToPage` faithful AI import.
            fileStore: options.fileStore,
            // Doc-page → brain distillation runner. When present, the
            // `ingestPage` tool is injected so "add this page to the brain"
            // works on request. Absent (no Pipeline B) → tool not injected.
            ingestPage: options.ingestPage,
            // Workspace files API — backs `fetchSiteIcon` (site logo →
            // stored image → `img:` page-icon token). Absent → not injected.
            filesApi: options.filesApi,
            pageId:
              typeof requestedDocViewId === 'string' && requestedDocViewId
                ? requestedDocViewId
                : null,
            // Theme iteration from chat (refine-only). The active custom theme
            // id is a per-user client value; when present we inject
            // `refineActiveTheme` and stream the rebuilt tokens back via the
            // `doc_theme_update` SSE for live apply.
            activeThemeId:
              typeof requestedActiveThemeId === 'string' && requestedActiveThemeId
                ? requestedActiveThemeId
                : null,
            provider: options.provider,
            onThemeRefined: (themeId, tokens, appearance) => {
              if (!res.writableEnded) {
                sendEvent('doc_theme_update', { themeId, tokens, appearance })
              }
            },
            // Record which page(s) the AI wrote this turn so the post-turn
            // auto-title pass (migration 218) only considers pages that
            // changed — covers both `patchPage` (the open page) and
            // `renderPage` (a brand-new page with a different id).
            onEvent: (evt) => {
              if (evt.type === 'page_rendered' || evt.type === 'page_patched') {
                docWrittenPageIds.add(evt.pageId)
              }
              // `renderPage` minted a brand-new page. Unlike `patchPage` (which
              // streams onto the open editor via the Yjs doc) and `renderView`
              // (which rode the now-removed `view_payload` path), `renderPage`
              // emits no client signal — so the new page sat server-side,
              // invisible in the sidebar until a manual refresh. That compounded
              // the 2026-06-02 orphan-page incident: even once the model picks
              // `renderPage` for a genuinely-new page, the user never saw it
              // appear. Forward a dedicated `page_created` SSE the instant the
              // draft persists; the client reloads the sidebar and lands the
              // user on it. (createSubPage keeps its own `sub_page_created` event
              // — that one deliberately does NOT navigate; a new root page does.)
              if (evt.type === 'page_rendered' && !res.writableEnded) {
                sendEvent('page_created', { pageId: evt.pageId })
              }
              // Explicit metadata change (`setTitle`/`setIcon`) — stream the
              // committed title/icon to the open clients the instant the patch
              // commits, so the tabs / breadcrumb / sidebar reflect it live.
              // The post-turn auto-title pass skips `'user'`-named pages, so
              // without this an explicit AI rename / icon change only surfaces
              // on the next refetch. Reuses the `doc_title_update` channel;
              // `nameOrigin` + `overwrite` tell the client to apply the
              // authoritative values (not the COALESCE suggestion semantics).
              if (
                evt.type === 'page_patched' &&
                evt.meta &&
                !res.writableEnded
              ) {
                sendEvent('doc_title_update', {
                  pageId: evt.pageId,
                  title: evt.meta.title,
                  icon: evt.meta.icon,
                  nameOrigin: evt.meta.nameOrigin,
                  overwrite: true,
                })
              }
            },
          })
        } catch (err) {
          console.error('[chat] doc tool injection failed:', err)
        }
      }

      // Session-state commitment tools (always on — the store itself is the
      // feature gate; absent store means absent tools, same as memories).
      if (options.sessionStateStore) {
        const { trackCommitment, resolveCommitment } = createSessionStateTools(
          options.sessionStateStore,
          {
            onEvent: (evt) => {
              options.analytics?.logEvent({
                userId: user.id, assistantId: assistant.id, sessionId: session.id,
                eventName: evt.type, channelType: 'web',
                metadata:
                  evt.type === 'session_state_upsert'
                    ? { source: sanitize(evt.source), was_insert: evt.wasInsert, key: sanitize(evt.key) }
                    : { source: sanitize(evt.source), hit: evt.hit, key: sanitize(evt.key) },
              })
            },
          },
        )
        allTools.set('trackCommitment', trackCommitment)
        allTools.set('resolveCommitment', resolveCommitment)
      }

      // Execution-plan tools (always on when the store is present — the store
      // is the feature gate, same as session-state). Domain-agnostic: step
      // content comes from the model, so research / doc-editing / batch saves
      // are all instances. See execution-plan.md.
      if (options.planStore) {
        const { setPlan, updatePlanStep, abandonPlan } = createPlanTools(
          options.planStore,
          {
            onEvent: (evt) => {
              options.analytics?.logEvent({
                userId: user.id, assistantId: assistant.id, sessionId: session.id,
                eventName: evt.type, channelType: 'web',
                metadata:
                  evt.type === 'plan_set'
                    ? { attempt_id: sanitize(evt.attemptId), steps: evt.steps, revised: evt.revised }
                    : evt.type === 'plan_step_update'
                      ? { key: sanitize(evt.key), status: sanitize(evt.status), hit: evt.hit }
                      : { attempt_id: sanitize(evt.attemptId) },
              })
            },
          },
        )
        allTools.set('setPlan', setPlan)
        allTools.set('updatePlanStep', updatePlanStep)
        allTools.set('abandonPlan', abandonPlan)
      }

      // Inject user's connected MCP tools (custom connectors + built-in Google).
      // `getConnectorUserId` resolves the workspace owner, but for ANY
      // workspace assistant `injectMcpTools` suppresses the owner-personal
      // base load and draws tools only from team-native instances +
      // `connector_grant` overlays — exposure is the injection boundary, solo
      // included (incidents 2026-06-01 / 2026-07-14). Shared with the public
      // API channel via `applyMcpInjection` — both routes must surface the
      // same tool set or assistants degrade silently when consumers switch
      // transports.
      const connectorUserId = await getConnectorUserId(user.id, assistant.workspaceId)
      const { enrichConfirmation, unavailable: unavailableCapabilities } = await applyMcpInjection({
        scope: 'chat',
        connectorUserId,
        assistant,
        userTimezone: user.timezone,
        tools: allTools,
        stores: options,
        engineHooks: options.engineHooks,
        // In-app actor identity: email is how the signed-in user is known on
        // the web/app surface. Channel turns (WA/TG/Slack) set their native id
        // in channel-pipeline. Resolved server-side from the session — never
        // model output. Opted-in connectors receive X-Sidanclaw-Actor-*.
        actorIdentity: { channel: session.channelType ?? 'web', id: user.email, email: user.email, userId: user.id },
        // Forwarded to `injectGoogleTools` → Gmail `sendMessage` audit
        // wrap. Shared with the host extra-tool inject above.
        connectorActionAudit,
        // Workspace domain is null today — workspaces don't carry an
        // email_domain column. The GCal audit hook falls back to
        // treating attendees-with-domain as external (audience=public).
        // Future migration adds the column.
        workspaceDomain: null,
        // Interactive chat has a live Approve/Deny loop, so the KB write
        // tools may exist here (D2 — chat-only). The public API shares
        // `applyMcpInjection` and must NOT set this.
        allowKnowledgeWrites: true,
        // On-demand introspection lane (ability audit §6-c/d): workspace
        // PRIMARY assistants only — these read workspace-operational state
        // (approvals / scheduled jobs / research runs / session history).
        // They enter the mcp_search index, never the direct tool surface.
        introspectionTools:
          assistant.kind === 'primary' && assistant.workspaceId
            ? options.introspectionTools
            : undefined,
      })

      // Inject skills — budget-aware listing + useSkill tool
      if (options.skillStore) {
        const skillResult = await injectSkills({
          skillStore: options.skillStore,
          connectorUserId,
          assistantId: assistant.id,
          // §5.5 governance gate: the assistant's own clearance is the
          // use-time ceiling for which workspace skills are offered.
          assistantClearance: assistant.clearance,
          tools: allTools,
          connectorStore: options.connectorStore,
          unavailableCapabilities,
          communitySkills: options.communitySkills,
          channel: 'chat',
          assistantKind: assistant.kind,
          assistantAppType: assistant.appType ?? null,
          // CL-8 wiring — `injectSkills` builds a slug→rowId map and
          // wires `useSkill.recordInvocation` to bump invocations +
          // last_invoked_at synchronously and queue rowIds for the
          // post-commit `succeeded` flush. No-ops for built-in skills.
          workspaceSkillStore: options.workspaceSkillStore,
          workspaceSkillEnablementStore: options.workspaceSkillEnablementStore,
          workspaceSkillFilesStore: options.workspaceSkillFilesStore,
          workspaceId: assistant.workspaceId ?? undefined,
          invocationBuffer: skillInvocationBuffer,
        })
        fullSystemPrompt += skillResult.promptFragment
      }

      // Inject unavailable capabilities so the model doesn't waste turns
      // searching for tools that don't exist.
      fullSystemPrompt += buildUnavailableCapabilitiesPrompt(unavailableCapabilities)

      // Browser-escalation guidance — dynamic injection gated on the acting
      // browser tools being in the map (tool-awareness carve-out): search
      // that can't produce the exact figure escalates to the browser, and
      // zero profiles never blocks a public-site browse.
      fullSystemPrompt += buildBrowserEscalationPrompt(allTools)

      // Dynamic workspace-blueprints section (blueprint output contract):
      // present only when the workspace has blueprints, naming only blueprints
      // that exist right now. Tool names are legal here — this is a dynamic
      // injection gated on the tools being in the map, never Layer 1 prose.
      if (
        options.buildBlueprintPromptFragment &&
        options.blueprintRecordTools &&
        assistant.workspaceId
      ) {
        fullSystemPrompt += await options.buildBlueprintPromptFragment(user.id, assistant.workspaceId)
      }

      // Research-mode override. Suspends the base L1's "two searches and stop"
      // discipline and replaces it with coordinator-pattern rules (parallelism,
      // multi-round, anti-fabrication). Injected only when the caller passed
      // `mode: 'research'`; the quota gate above has already accepted the turn.
      // See packages/core/src/system-prompt.ts → RESEARCH_MODE_ADDENDUM.
      //
      // Doc-surface research turns are the exception: this addendum is
      // worker / coordinator-centric ("delegate via spawnWorker",
      // "<worker-findings> XML"), but a doc research turn authors findings to
      // the page itself and never delegates. Its research guidance lives in the
      // doc skill block's RESEARCH_MODE_BLOCK (mode tracks the research
      // toggle), so stacking the global addendum here would give it
      // contradictory worker instructions.
      if (researchMode && !docCtx) {
        const { RESEARCH_MODE_ADDENDUM } = await import('@use-brian/core')
        fullSystemPrompt += `\n\n${RESEARCH_MODE_ADDENDUM}`
      }

      // Budget gate — see docs/architecture/platform/cost-and-pricing.md
      //
      // Research-mode turns on PAID plans bypass this gate: an explicit-Pro
      // user who invokes research gets research, no surprise mid-week
      // downgrades. The bypass no longer extends to `'free'` (2026-07-10,
      // the Free-plan removal): a no-plan workspace's research turn hits the
      // gate and blocks like any other turn, closing the hole where the
      // 5-lifetime mig-185 taster was the only cap. That quota (gated above)
      // survives as the OSS build's research cap — the open build injects no
      // credit gate, so this branch allow-alls there either way.
      let budgetStatus: 'ok' | 'downgraded' | 'blocked' = 'ok'
      const researchGateBypass = researchMode && userPlan !== 'free'
      if (!researchGateBypass && options.usageStore && assistant.workspaceId) {
        const gate = await checkUsageBudget(assistant.workspaceId, userPlan, options.checkCreditBudget)
        budgetStatus = gate.status
        if (gate.status === 'blocked') {
          sendEvent('error', {
            message: "This workspace has no active plan. Pick a plan to keep going, or self-host the open-source version.",
            code: 'budget_exhausted',
            resetsAt: gate.resetsAt,
          })
          res.end()
          await updateSessionStatus(session.id, 'idle')
          // turn_started has already fired for draft sessions (above the
          // budget gate). Pair it with turn_completed so watchers don't
          // see the input dimmed forever.
          if (session.mode === 'draft') {
            publishSessionEvent({
              kind: 'turn_completed',
              sessionId: session.id,
              payload: { senderUserId: user.id },
            })
          }
          options.analytics?.logEvent({
            userId: user.id, assistantId: assistant.id, sessionId: session.id,
            eventName: 'budget_blocked', channelType: 'web',
            metadata: { credits_used: gate.creditsUsed, credit_cap: gate.creditCap ?? -1 },
          })
          return
        }
        if (gate.status === 'downgraded') {
          sendEvent('notice', {
            message: "You've used this month's credit allowance — running on the standard model until it resets.",
            code: 'budget_downgraded',
            resetsAt: gate.resetsAt,
          })
          options.analytics?.logEvent({
            userId: user.id, assistantId: assistant.id, sessionId: session.id,
            eventName: 'budget_downgraded', channelType: 'web',
            metadata: { credits_used: gate.creditsUsed, credit_cap: gate.creditCap ?? -1 },
          })
        }
      }

      // Resolve model — enforce plan-based restrictions + budget downgrade.
      // Research mode bypasses the plan gate: every accepted research turn
      // (free quota or paid) runs on the research-tier model (Pro 3.1).
      // That's the "5 free researches give a real taste of the deep mode"
      // wedge — once exhausted the user upgrades to keep using it.
      //
      // Why Pro 3.1 specifically (vs the default Max model, Flash 3.5):
      // Research is reasoning-bound — multi-hop synthesis across web sources
      // is where Pro 3.1 keeps its 3–8 pp lead on GPQA / ARC-AGI-2 / MMLU-Pro.
      // The default Max model (Flash 3.5) wins on agentic / coding / tool-use
      // but underperforms on this specific axis. The `research` alias forces
      // the resolver to Pro 3.1 regardless of the session's requested tier.
      //
      // Budget downgrade still applies — a workspace that has exhausted its
      // weekly $ cap still gets standard regardless of mode.
      // ── Metered model lane (model-registry.md L8/L10/L15) ──────────
      //
      // A metered-class registry alias in `model` bypasses the tier resolver:
      // it serves at the profile's tool-round budget and bills through the
      // surcharge ledger on completion. Gates, in order: provider key present
      // (L12), not at the credit cap, spend cap (L8), explicit confirm
      // acknowledgement, vision capability (L7 — a vision turn on a
      // text-only pick silently serves via the tier default instead).
      // Research mode wins over a metered pick (it forces its own model).
      let meteredTurn: { alias: string; profileId: string | null; toolRounds: number; thinking: boolean | null } | null = null
      if (requestedModel && !researchMode) {
        const meteredRow = registryRow(requestedModel)
        if (meteredRow?.class === 'metered' && meteredRow.status === 'active') {
          if (options.meteredModelsAvailable && !options.meteredModelsAvailable.has(meteredRow.alias)) {
            res.status(400).json({ error: 'model_unavailable', message: 'This model is not available on this deployment.' })
            return
          }
          if (budgetStatus !== 'ok') {
            res.status(402).json({ error: 'metered_at_cap', message: 'Metered models need available credits. Add an extra usage pack or upgrade the plan.' })
            return
          }
          if (assistant.workspaceId && options.checkMeteredSpendCap) {
            const cap = await options.checkMeteredSpendCap(assistant.workspaceId)
            if (!cap.allowed) {
              res.status(402).json({ error: 'metered_spend_cap_reached', usedCredits: cap.usedCredits, capCredits: cap.capCredits })
              return
            }
          }
          // Resolve the budget: saved profile wins (validated against this
          // workspace + this model), else the ad-hoc rounds, else 100/100.
          let profileId: string | null = null
          let toolRounds = 100
          let thinking: boolean | null = null
          if (meteredProfileId && options.meteredProfileStore && assistant.workspaceId) {
            const profile = await options.meteredProfileStore.get(assistant.workspaceId, meteredProfileId)
            if (!profile || profile.modelAlias !== meteredRow.alias) {
              res.status(400).json({ error: 'metered_profile_invalid' })
              return
            }
            profileId = profile.id
            toolRounds = profile.toolRounds
            thinking = profile.thinking
          } else if (typeof meteredToolRounds === 'number') {
            toolRounds = Math.min(200, Math.max(10, Math.round(meteredToolRounds)))
          }
          if (meteredAccepted !== true) {
            // Pre-flight invariant: estimate at the CHOSEN budget → confirm →
            // run. The client shows the estimate in a confirm dialog and
            // resends with meteredAccepted.
            res.status(400).json({
              error: 'metered_confirm_required',
              estimate: options.estimateMeteredTurn?.(meteredRow.alias, toolRounds) ?? null,
            })
            return
          }
          const hasImageInput = userContentBlocks.some((b) => b.type === 'image')
          if (hasImageInput && !meteredRow.capabilities.vision) {
            // L7 vision gate: silently serve this turn via the tier default.
            meteredTurn = null
          } else {
            meteredTurn = { alias: meteredRow.alias, profileId, toolRounds, thinking }
            // Metered turns always run the platform routing provider — a
            // workspace BYO Gemini key cannot serve a DashScope model, and
            // the meter (not the BYO $0 convention) is the honest billing.
            turnProvider = options.provider
            usedByoKey = false
          }
        }
      }

      const resolvedModel = meteredTurn
        ? meteredTurn.alias
        : researchMode && budgetStatus !== 'downgraded'
          ? resolveModel('research', 'max_5x', budgetStatus)
          : resolveModel(requestedModel, userPlan, budgetStatus)
      // Substitute a configured model when the default (Gemini) has no key —
      // lets a Qwen-only deployment serve chat by default. No-op when Gemini
      // is configured, or when the caller doesn't pass configuredProviders.
      const model = options.configuredProviders
        ? ensureServableModel(resolvedModel, options.configuredProviders)
        : resolvedModel

      // Reset worker manager — prevents stale workers from prior requests blocking Phase 4b
      options.workerManager?.reset()
      // Phase 3 of askQuestion suspend-resume — wire per-turn worker
      // persistence so a Cloud Run rotation between a suspend and the
      // user's answer can rehydrate worker results on the new instance.
      // Workspace-scoped only (matches the suspend gate elsewhere).
      // See docs/architecture/engine/askquestion-suspend-resume.md.
      if (assistant.workspaceId && options.workerRunsStore && options.workerManager) {
        options.workerManager.setPersistence({
          store: options.workerRunsStore,
          sessionId: session.id,
          workspaceId: assistant.workspaceId,
        })
      }
      // Per-request research flag: workers spawned during a Research-mode turn
      // get a loosened system prompt (chain webSearch → urlReader, up to 5
      // searches, surface blocked URLs) and a higher turn budget. Reset back
      // to false above via `reset()`, so this only widens the current turn.
      options.workerManager?.setResearchMode(researchMode)
      // Upgrade research workers to the coordinator's model. Without this they
      // run on boot-time Flash, which treats "Search for X" prompts as one-shot
      // and skips urlReader entirely — defeating the deep-research wedge.
      if (researchMode) {
        options.workerManager?.setResearchModel(model)
        // Cap concurrent workers at 5 for the research session. Lowered
        // from 10 after sustained 4GB OOM crashes — 10 concurrent worker
        // queryLoops at HIGH thinking + their statelessHistory growth +
        // their Gemini fetch buffers compounded faster than V8 could GC.
        // 5 halves the parallel memory pressure while still giving the
        // coordinator real fan-out. The coordinator can refill the pool
        // after Phase 4b drains between waves, so total worker output
        // across multi-wave is comparable to the 10-cap setup.
        options.workerManager?.setMaxConcurrent(5)
      }

      // ── Pre-flight: automatic parallel research ──────────────
      // Two modes based on model intelligence:
      //   Standard (Flash): application-layer pre-flight — classifier splits,
      //     workers research, results injected into system prompt.
      //   Pro/Max: full coordinator mode — strip research tools from the main
      //     model, let it delegate via spawnWorker with Phase 4b drain.
      //     Structurally prevents re-searching.
      //
      // Research mode forces coordinator regardless of the classifier — the
      // user explicitly asked for deep research, so we skip the splitter
      // call (saves a Gemini round-trip) and seed coordinator immediately.
      const isProMode = !isStandardTier(model)
      let preflightContext = ''
      // App assistants (doc + feed) never enter coordinator mode — it
      // strips their authoring tools. So a doc research turn (researchMode
      // true) authors directly instead of delegating: coordinatorMode stays
      // false here, the splitter branch below is skipped, and the standard
      // preflight is skipped too (it would strip webSearch/urlReader the
      // research soul tells the model to use).
      const isDocResearchTurn = researchMode && docCtx
      // The doc surface never enters coordinator mode for ANY interlocutor:
      // coordinator strips the page-authoring tools, so a primary doing doc
      // research must author in its own loop, not delegate. `appAssistantForbids`
      // already covers the legacy doc app; `!onDocSurface` covers the
      // primary / switched-in assistant case.
      let coordinatorMode =
        researchMode && !appAssistantForbidsCoordinator(assistant.kind) && !onDocSurface

      if (message && message.length > 40) {
        // `!appAssistantForbidsCoordinator` is the third coordinator gate: a
        // Pro/Max doc/feed turn must NOT enter coordinator mode via the
        // splitter (it would strip the authoring tools — incident 2026-06-01).
        // Non-doc app turns fall through to the standard application-layer
        // preflight below; doc research turns skip even that (see the
        // `isDocResearchTurn` guard on the else branch).
        if (
          !appAssistantForbidsCoordinator(assistant.kind) &&
          !onDocSurface &&
          (researchMode || isProMode)
        ) {
          // Pro/Max: check if this qualifies for coordinator mode.
          // Import classifySplit to check — if it would split, enable coordinator mode
          // and let the model itself drive delegation via spawnWorker + Phase 4b.
          //
          // Research mode skips the classifier entirely (the user already
          // asked for deep mode; running Gemini just to confirm is waste)
          // and seeds the coordinator path unconditionally.
          let splitterDecidedCoordinator = false
          // Operate-site turns never consult the splitter — a browse of one
          // named site must not be decomposed into search workers that cannot
          // browse (see the operateSiteIntent block above). researchMode
          // being true here means the explicit toggle: splitter is moot.
          if (!researchMode && !operateSiteIntent) {
            const { classifySplit } = await import('@use-brian/core')
            const splitResult = await classifySplit({ provider: options.provider, message })
              .catch(() => ({ tasks: null, usage: null, model: null }))
            // Attribute splitter tokens as overhead. Recorded regardless of
            // whether the classifier chose to split — the Gemini call happened.
            await recordOverheadUsage({
              usageStore: options.usageStore,
              userId: user.id,
              assistantId: assistant.id,
              sessionId: session.id,
              userMessageId: storedUserMsg.id,
              model: splitResult.model,
              usage: splitResult.usage,
              source: 'overhead:splitter',
              triggerKey: 'parallel_split_classifier',
            })
            splitterDecidedCoordinator = !!splitResult.tasks

            // Auto-seed (Phase 3): the splitter just decomposed this message
            // into ≤3 sub-tasks — turn them into an execution plan so the
            // completeness gate has something to enforce (and the # Active
            // plan block surfaces it from the next turn). No-ops if a plan is
            // already active or the store is absent. Reuses the splitter
            // signal only; no new LLM call. See execution-plan.md → "Auto-seed".
            if (options.planStore && splitResult.tasks && splitResult.tasks.length > 0) {
              await seedPlanFromTasks(
                options.planStore,
                { sessionId: session.id, userId: user.id, assistantId: assistant.id },
                splitResult.tasks,
              ).catch((err) => console.error('[chat] plan auto-seed failed:', err))
            }
          }
          if (researchMode || splitterDecidedCoordinator) {
            coordinatorMode = true
            // `phase` lets the web client render a localized research banner;
            // `message` is the plain-text fallback for non-web consumers/logs.
            sendEvent('status', {
              phase: researchMode ? 'research_starting' : 'research_parallel',
              message: researchMode ? 'Starting deep research…' : 'Researching in parallel...',
            })
            // Set up event streaming for coordinator workers (same as standard pre-flight)
            const seenWorkers = new Set<string>()
            const seenCitationUrls = new Set<string>()
            options.workerManager?.setOnEvent((workerId, event) => {
              if (!seenWorkers.has(workerId)) {
                seenWorkers.add(workerId)
                const desc = options.workerManager?.getDescription(workerId)
                sendEvent('worker_start', { workerId, description: desc })
              }
              if (event.type === 'tool_start') {
                sendEvent('tool_start', { id: event.id, name: event.name, workerId })
              }
              if (event.type === 'tool_input') {
                sendEvent('tool_input', { id: event.id, name: event.name, input: event.input, workerId })
              }
              if (event.type === 'tool_dropped') {
                sendEvent('tool_dropped', { id: event.id, workerId })
              }
              if (event.type === 'tool_result') {
                for (const block of event.results) {
                  if (block.type === 'tool_result') {
                    sendEvent('tool_result', {
                      id: block.toolUseId,
                      name: block.name,
                      isError: block.isError ?? false,
                      workerId,
                      errorMessage: block.isError ? toolErrorExcerpt(block.content) : undefined,
                    })
                    // Realtime brain stream — fire-and-forget NOTIFY so other
                    // surfaces (a /brain tab, Claude Code, another device)
                    // see the change without polling. No-ops on read tools.
                    // Spec: docs/architecture/platform/realtime-sync.md.
                    notifyBrainWriteIfMatch(assistant.workspaceId, block.name, block.isError ?? false)
                    const toolMeta = event.metaByToolUseId?.[block.toolUseId]
                    const extraMeta: Record<string, string | number | boolean> = { in_worker: true }
                    if (toolMeta) {
                      for (const [k, v] of Object.entries(toolMeta)) {
                        extraMeta[k] = typeof v === 'string' ? sanitize(v) : v
                      }
                    }
                    options.analytics?.logEvent({
                      userId: user.id, assistantId: assistant.id, sessionId: session.id,
                      eventName: 'tool_executed', channelType: 'web',
                      metadata: { tool_name: sanitize(block.name), success: !(block.isError ?? false), ...(block.isError ? { error_message: sanitize(toolErrorExcerpt(block.content)) } : {}), ...extraMeta },
                    })
                    // Fire-and-forget: bill the user for any external API cost
                    // the tool incurred (e.g. Grok tokens for xSearch / x.com
                    // URL read, flat Brave/Serper/Tavily rate for webSearch).
                    void recordExternalCostFromMeta({
                      toolMeta,
                      usageStore: options.usageStore,
                      userId: user.id,
                      assistantId: assistant.id,
                      sessionId: session.id,
                      userMessageId: storedUserMsg.id,
                      userPlan,
                      analytics: options.analytics,
                    })
                  }
                }
              }
              if (event.type === 'citation') {
                const newSources = event.sources
                  .filter((s) => {
                    if (seenCitationUrls.has(s.url)) return false
                    seenCitationUrls.add(s.url)
                    return true
                  })
                  .slice(0, 3)
                if (newSources.length > 0) {
                  sendEvent('citation', { sources: newSources })
                }
              }
            })
          }
        } else if (!isDocResearchTurn && !operateSiteIntent) {
          // Standard: application-layer pre-flight.
          //
          // Skipped for a doc research turn: the preflight can return
          // `researched` (sets `preflightContext`), which strips RESEARCH_TOOLS
          // (webSearch/urlReader) from the loop on the "context already
          // gathered, synthesize don't re-search" rule. But a doc research
          // turn's soul (RESEARCH_MODE_BLOCK) tells the model to search the web
          // and author findings itself — so it must keep those tools. Letting
          // it run its own search→author loop is the whole point of the mode.
          //
          // Also skipped for an operate-site turn (see operateSiteIntent
          // above): pre-searching a site the model is about to open directly
          // wastes worker calls and biases the turn toward synthesis-from-
          // snippets instead of the browse the user asked for.
          try {
            const preflight = await runPreflight({
              provider: options.provider,
              model,
              message,
              tools: allTools,
              context: {
                userId: user.id,
                assistantId: assistant.id,
                sessionId: session.id,
                appId: 'Use Brian',
                channelType: session.channelType,
                channelId: session.channelId,
                abortSignal: new AbortController().signal,
                requestTools: allTools,
              },
              onStatus: (msg) => sendEvent('status', { message: msg }),
              onEvent: (() => {
                const seenWorkers = new Set<string>()
                const seenCitationUrls = new Set<string>()
                return (event: import('@use-brian/core').QueryEvent, workerId: string, description?: string) => {
                  if (!seenWorkers.has(workerId)) {
                    seenWorkers.add(workerId)
                    sendEvent('worker_start', { workerId, description })
                  }
                  if (event.type === 'tool_start') {
                    sendEvent('tool_start', { id: event.id, name: event.name, workerId })
                  }
                  if (event.type === 'tool_input') {
                    sendEvent('tool_input', { id: event.id, name: event.name, input: event.input, workerId })
                  }
                  if (event.type === 'tool_result') {
                    for (const block of event.results) {
                      if (block.type === 'tool_result') {
                        sendEvent('tool_result', {
                      id: block.toolUseId,
                      name: block.name,
                      isError: block.isError ?? false,
                      workerId,
                      errorMessage: block.isError ? toolErrorExcerpt(block.content) : undefined,
                    })
                        notifyBrainWriteIfMatch(assistant.workspaceId, block.name, block.isError ?? false)
                        const toolMeta = event.metaByToolUseId?.[block.toolUseId]
                        const extraMeta: Record<string, string | number | boolean> = { in_worker: true }
                        if (toolMeta) {
                          for (const [k, v] of Object.entries(toolMeta)) {
                            extraMeta[k] = typeof v === 'string' ? sanitize(v) : v
                          }
                        }
                        options.analytics?.logEvent({
                          userId: user.id, assistantId: assistant.id, sessionId: session.id,
                          eventName: 'tool_executed', channelType: 'web',
                          metadata: { tool_name: sanitize(block.name), success: !(block.isError ?? false), ...(block.isError ? { error_message: sanitize(toolErrorExcerpt(block.content)) } : {}), ...extraMeta },
                        })
                        void recordExternalCostFromMeta({
                          toolMeta,
                          usageStore: options.usageStore,
                          userId: user.id,
                          assistantId: assistant.id,
                          sessionId: session.id,
                          userMessageId: storedUserMsg.id,
                          userPlan,
                          analytics: options.analytics,
                        })
                      }
                    }
                  }
                  if (event.type === 'citation') {
                    const newSources = event.sources
                      .filter((s) => {
                        if (seenCitationUrls.has(s.url)) return false
                        seenCitationUrls.add(s.url)
                        return true
                      })
                      .slice(0, 3)
                    if (newSources.length > 0) {
                      sendEvent('citation', { sources: newSources })
                    }
                  }
                }
              })(),
            })
            if (preflight.type === 'researched') {
              preflightContext = preflight.context
            }
            // Attribute the preflight classifier call as overhead regardless
            // of whether it split (the Gemini call happened either way).
            await recordOverheadUsage({
              usageStore: options.usageStore,
              userId: user.id,
              assistantId: assistant.id,
              sessionId: session.id,
              userMessageId: storedUserMsg.id,
              model: preflight.model,
              usage: preflight.usage,
              source: 'overhead:splitter',
              triggerKey: 'parallel_split_classifier',
            })
          } catch (err) {
            console.error('[chat] pre-flight failed, continuing without:', err)
          }
        }
      }

      // Build the tools map for the query loop.
      // In coordinator mode: strip research tools so the model MUST delegate.
      // When preflight has already researched: also strip research tools —
      // the context is injected, main agent should synthesize not re-research.
      // If it genuinely needs more info, it can still use spawnWorker.
      // The coordinator gets only delegation + memory tools.
      // No research tools (structurally forces delegation), no task/notes
      // (coordinator shouldn't do bookkeeping — workers are the tasks).
      //
      // Research-mode coordinator gets the base tools + brain-ingestion
      // primitives (updateSelfProfile / saveContact / saveCompany / saveDeal
      // / createEntity) so it can persist findings to typed entities in
      // Phase 4 — the brain-first architectural edge.
      //
      // askQuestion is kept in the set BUT is structurally terminal — the
      // queryLoop exits when it's called (see query-loop.ts). Combined with
      // the Phase 0 "clarify upfront" rule in the addendum, the model can
      // ask ONE clarifying question before research starts, the user
      // answers, and the next turn proceeds to Phase 1. Calling askQuestion
      // mid-research is forbidden by the addendum but if the model does it
      // anyway, the turn ends cleanly (user can answer) rather than
      // continuing without their input — that's the production failure
      // mode 5/26 22:24 fixed: 3× askQuestion mid-flow with the user
      // unable to interject.
      const COORDINATOR_ALLOWED_TOOLS_BASE = new Set([
        'spawnWorker', 'sendWorkerMessage', 'stopWorker',
        'saveMemory', 'getMemory', 'askQuestion',
      ])
      const COORDINATOR_RESEARCH_EXTRA_TOOLS = new Set([
        // Write tools — for ingesting research findings.
        'updateSelfProfile', 'saveContact', 'saveCompany', 'saveDeal', 'createEntity',
        // Update + edge tools — required for the "link existing
        // entities" case ("save all edges with current brain entities
        // according to researches above"). Without these the
        // coordinator has no execution path and falls back to prose,
        // confabulating that the work was done. listing/getting reads
        // the entity ids the model needs to chain into createEdge or
        // updateContact({ links: [...] }).
        'updateContact', 'updateCompany', 'updateDeal',
        'listContacts', 'listCompanies', 'listDeals',
        'getContact', 'getCompany', 'getDeal',
        'createEdge',
      ])
      const coordinatorAllowedTools = researchMode
        ? new Set([...COORDINATOR_ALLOWED_TOOLS_BASE, ...COORDINATOR_RESEARCH_EXTRA_TOOLS])
        : COORDINATOR_ALLOWED_TOOLS_BASE
      const RESEARCH_TOOLS = new Set([
        'webSearch', 'urlReader',
      ])
      // `createEdge` stays available — it's the only path for the
      // "link existing entities" case (the model can't call `links`
      // on save tools after the rows already exist without an
      // update-call-per-entity loop). The prior hallucinated-id
      // failure mode is now mitigated upstream:
      //   - saveContact/saveCompany/saveDeal return the underlying
      //     `entityId` in tool output, so the model has real ids
      //     to chain through createEdge.
      //   - createEntity's Zod schema rejects CRM kinds, so the
      //     model can't end up with a fictional entity id from a
      //     rejected createEntity call.
      //   - Tool descriptions explicitly require listing/getting
      //     before calling createEdge with stale or unknown ids.
      const loopTools = coordinatorMode
        ? new Map([...allTools].filter(([name]) => coordinatorAllowedTools.has(name)))
        : preflightContext
          ? new Map([...allTools].filter(([name]) => !RESEARCH_TOOLS.has(name)))
          : allTools

      // Coordinator-mode addendum. The base wording covers "spawn 2-3 workers,
      // synthesize, done" — adequate for the splitter-triggered parallel-research
      // path. Research mode runs a structurally distinct 4-phase protocol
      // (Know → Delegate → Reflect → Ingest+Respond) because production traces
      // showed the previous prompt collapsing into "one wave then guess", with
      // workers returning snippet-only summaries and the coordinator concluding
      // "no info found" before workers had real urlReader content.
      const coordinatorBaseAddendum = COORDINATOR_BASE_ADDENDUM
      const coordinatorResearchAddendum = COORDINATOR_RESEARCH_ADDENDUM
      // Coordinator addenda are mode-stable → stay on the system prompt.
      // Preflight findings are per-turn → ride the turn-context envelope
      // (cache-neutral tail) instead of busting the system-prompt prefix.
      let systemPromptWithPreflight = coordinatorMode
        ? `${fullSystemPrompt}\n\n${researchMode ? coordinatorResearchAddendum : coordinatorBaseAddendum}`
        : fullSystemPrompt
      if (!coordinatorMode && preflightContext) {
        turnContextParts.push(buildPreflightPrompt('', preflightContext).replace(/^\n+/, ''))
      }

      // Run query loop — stream events to client
      await updateSessionStatus(session.id, 'running')

      // Assistant-run presence — announce to every tab viewing this doc page
      // that a run just opened, attributed to this member + the channel they
      // came from (works for Telegram/Slack/web triggers with no browser open).
      // Best-effort; no-op off the doc surface or when doc-sync is absent.
      // Closed in the outer `finally`. Progress heartbeats are derived by
      // doc-sync itself as `patchPage` ops land — not driven from here.
      if (
        docCtx &&
        typeof requestedDocViewId === 'string' &&
        requestedDocViewId
      ) {
        docRunPageId = requestedDocViewId
        void docRunClient?.start({
          pageId: requestedDocViewId,
          actor: { id: user.id, name: user.name ?? 'A teammate' },
          channel: resolveRunChannel(session),
        })
      }

      const abortController = new AbortController()

      // A `doc_thread` (comment-reply) turn runs to completion in the
      // BACKGROUND so a page refresh — which drops this SSE connection — can't
      // kill an in-flight reply. The reconnect stream (GET /api/sessions/:id/
      // stream) re-attaches via the session turn bus; the stuck-session-sweeper
      // is the 6-min backstop. Every other turn keeps the token-saving
      // disconnect-abort (closing a normal chat tab stops generation).
      // See docs/architecture/features/doc-comments.md → "Live turn reconnect".
      const isBackgroundTurn = session.channelType === 'doc_thread'
      req.on('close', () => {
        clientGone = true
        if (!isBackgroundTurn) abortController.abort()
      })

      // Live snapshot publishing for the reconnect stream — only `doc_thread`
      // turns flow onto the session bus (every other turn pays nothing). The
      // snapshot carries the full reply-so-far (capped to the NOTIFY budget) so
      // a client reconnecting mid-turn has no missed-prefix gap; published
      // throttled so a streamed reply can't NOTIFY-storm the bus.
      let liveStreamText = ''
      let liveStreamActivity: string | null = null
      let lastStreamPublishAt = 0
      const STREAM_PUBLISH_THROTTLE_MS = 150
      const STREAM_TEXT_CAP = 4_000 // keeps the NOTIFY payload under budget
      const publishTurnStream = (force: boolean) => {
        // Only once the client has actually disconnected — while the original
        // SSE connection is alive it streams `text_delta` directly, so the bus
        // (and its per-event NOTIFY) is pure overhead. `liveStreamText` still
        // accumulates before then, so the first post-disconnect snapshot
        // carries the full reply-so-far (no missed-prefix gap on reconnect).
        if (!isBackgroundTurn || !clientGone) return
        const now = Date.now()
        if (!force && now - lastStreamPublishAt < STREAM_PUBLISH_THROTTLE_MS) return
        lastStreamPublishAt = now
        publishSessionEvent({
          kind: 'turn_stream',
          sessionId: session.id,
          payload: {
            text: liveStreamText.slice(-STREAM_TEXT_CAP),
            activity: liveStreamActivity,
          },
        })
      }

      // ── Persistence buffer ────────────────────────────────────
      //
      // Tool-pairing invariant (see docs/architecture/engine/query-loop.md):
      // every persisted tool_use must be followed by a persisted tool_result
      // with the same id. To guarantee that we buffer each turn IN ITS
      // ENTIRETY (assistant content + its own tool_results) and flush at
      // a single safe point.
      //
      // The buffer is driven by the `assistant_turn` event, which the query
      // loop yields once per turn AFTER all that turn's tool_results are
      // drained. Every buffered entry is already paired — no cross-turn
      // claim logic needed. Intermediate tool-use turns land in the buffer
      // too (unlike `turn_complete`, which is terminal-only).
      type PendingTurn = {
        content: ContentBlock[]          // assistant message's content blocks
        toolResults: ContentBlock[]      // the tool_results for this turn's tool_use blocks
        stopReason: string               // diagnostic for empty-turn logging
      }
      const pendingAssistantTurns: PendingTurn[] = []
      let lastAssistantMessageId: string | null = null
      let flushed = false
      // Grounding-gate claim ledger — stashed from the claim_ledger event,
      // persisted once the final assistant message id is known. See
      // docs/architecture/engine/grounding-gate.md → "Claim ledger".
      let pendingClaimLedger: Extract<
        import('@use-brian/core').QueryEvent,
        { type: 'claim_ledger' }
      >['claims'] | null = null

      /**
       * Atomic flush: walk buffered turns in order, synthesise missing
       * tool_result stubs for any tool_use that never received a real
       * result, and persist each turn's assistant message + (tool_results
       * as a user message). Idempotent via the `flushed` guard.
       */
      const flushBufferedTurns = async (synthesisReason: string) => {
        if (flushed) return
        flushed = true

        console.log(
          `[chat] flushing ${pendingAssistantTurns.length} buffered turn(s) for session ${session.id}`,
        )

        // Outbound attachments (sendFile) belong to the final reply — the
        // last turn with content. Drained here so a recovery re-flush can't
        // double-attach.
        const outboundAttachments = outboundAttachmentCollector.drain()

        const lastNonEmptyIdx = (() => {
          for (let i = pendingAssistantTurns.length - 1; i >= 0; i--) {
            if (pendingAssistantTurns[i].content.length > 0) return i
          }
          return -1
        })()

        for (let turnIdx = 0; turnIdx < pendingAssistantTurns.length; turnIdx++) {
          const turn = pendingAssistantTurns[turnIdx]
          // Pure empty response (safety filter / MAX_TOKENS with zero
          // content). Nothing to persist for this turn — the loop just exits
          // without appending a blank message.
          if (turn.content.length === 0) continue

          // `app` assistants (doc / feed) author their own soul and are
          // never served the FOLLOW_UP_QUESTIONS_ADDENDUM — but the model can
          // still *volunteer* a `<followup>[...]</followup>` chip tag, and once
          // it's persisted raw it (1) renders as literal text on these surfaces
          // and (2) re-teaches itself via history replay on the next turn.
          // Strip it from text blocks before it lands in session_messages.
          // See docs/architecture/features/follow-up-questions.md → "app surfaces".
          //
          // Same defense for the confabulated `<comment-thread-reply pageId=…>`
          // wrapper a doc assistant sometimes invents around a comment-thread
          // reply (no prompt defines it) — left raw it renders as tag soup and
          // leaks an internal page UUID on the comment surfaces.
          // See docs/architecture/features/doc-comments.md → "Reply routing".
          const content =
            assistant.kind === 'app'
              ? turn.content
                  .map((block) =>
                    block.type === 'text'
                      ? { ...block, text: stripCommentThreadReplyTag(stripFollowUps(block.text)) }
                      : block,
                  )
                  .filter((block) => !(block.type === 'text' && block.text.length === 0))
              : turn.content
          // The turn was nothing but a chip tag (no real answer / tool calls).
          if (content.length === 0) continue

          const storedAssistantMsg = await addSessionMessage({
            sessionId: session.id,
            role: 'assistant',
            content,
            attachments:
              turnIdx === lastNonEmptyIdx && outboundAttachments.length > 0
                ? outboundAttachments
                : undefined,
          })
          lastAssistantMessageId = storedAssistantMsg.id

          // The UI uses `assistant_message_saved` to attach retry/edit/
          // feedback actions to the most recent bubble. Only emit for the
          // last non-empty turn — intermediate tool_use turns render as
          // timeline entries, not message bubbles, so the UI doesn't need
          // their ids.
          if (turnIdx === lastNonEmptyIdx) {
            sendEvent('assistant_message_saved', { id: storedAssistantMsg.id })
            // File cards (sendFile) — the streaming client renders these
            // at turn end; refetches read them from the persisted row.
            if (outboundAttachments.length > 0) {
              sendEvent('attachments', {
                messageId: storedAssistantMsg.id,
                attachments: outboundAttachments,
              })
            }
          }
          // Live broadcast for multi-watcher draft-mode sessions. We send
          // every turn (not just the final one) because a host's per-turn
          // tool upserts can ride on intermediate tool_use turns.
          if (session.mode === 'draft') {
            publishSessionEvent({
              kind: 'assistant_message_saved',
              sessionId: session.id,
              payload: {
                id: storedAssistantMsg.id,
                sequenceNum: storedAssistantMsg.sequenceNum,
                content: storedAssistantMsg.content,
              },
            })
          }

          // Synthesise stubs for any tool_use in this turn's content that
          // the executor failed to produce a real result for.
          const missing = synthesizeMissingToolResults(
            turn.content,
            turn.toolResults,
            synthesisReason,
          )
          const allResults = [...turn.toolResults, ...missing]
          if (allResults.length > 0) {
            await addSessionMessage({
              sessionId: session.id,
              role: 'user',
              content: allResults,
            })
          }
        }

        // Flush the per-turn memory recall buffer once the final assistant
        // message id is known. All buffered recalls (index_inject + tool_call)
        // are persisted with that id so the feedback JOIN can attribute
        // downstream signal back to the memories that informed this turn.
        // Best-effort: errors here don't abort the response (we already
        // streamed the model output to the client). See
        // `docs/architecture/context-engine/memory-system.md` →
        // "Recall-outcome tagging".
        // Claim ledger — the claim→evidence linkage of the shipped reply,
        // keyed by the final assistant message row. Best-effort: a ledger
        // failure never blocks the reply (already streamed anyway). The
        // aggregate counts go to analytics — that's the long-horizon trend
        // store; the rows themselves are superseded on the next reply.
        if (pendingClaimLedger && lastAssistantMessageId) {
          try {
            await insertClaimProvenance(lastAssistantMessageId, pendingClaimLedger)
          } catch (err) {
            console.warn('[chat] claim ledger persist failed:', err)
          }
          options.analytics?.logEvent({
            userId: user.id, assistantId: assistant.id, sessionId: session.id,
            eventName: 'claim_ledger_recorded', channelType: 'web',
            metadata: {
              backed_count: pendingClaimLedger.filter((c) => c.status === 'backed').length,
              unverified_count: pendingClaimLedger.filter((c) => c.status === 'unverified').length,
              model: sanitize(model),
            },
          })
          pendingClaimLedger = null
        }
        if (recallBuffer && lastAssistantMessageId) {
          try {
            await recallBuffer.flush(lastAssistantMessageId)
          } catch (err) {
            console.error('[chat] memory recall buffer flush failed:', err)
          }
        } else if (recallBuffer) {
          // No assistant message was committed (every turn was empty).
          // Drop queued recalls — there's no message id to attach them to.
          recallBuffer.discard()
        }
      }

      // ── Turn-context envelope ─────────────────────────────────
      // Attach the per-turn volatile context to the NEWEST user message —
      // ephemeral, exactly like the retry hint above: the stored DB row stays
      // clean, so history bytes never change between turns. Keeping these
      // blocks out of the system prompt keeps the provider's implicit-cache
      // prefix (system prompt + history) byte-stable across turns: step-0
      // prefill reads the conversation from cache instead of cold. See
      // docs/architecture/engine/query-loop.md → "Turn-context envelope".
      const turnContext = turnContextParts
        .filter((s) => s.trim().length > 0)
        .join('\n\n')
      const enveloped = attachTurnContext(messages, turnContext)
      if (enveloped) {
        messages = enveloped
      } else if (turnContext) {
        // No plain trailing user message to carry the envelope (rare resume
        // shapes) — fall back to in-prompt placement for this turn only.
        systemPromptWithPreflight = `${systemPromptWithPreflight}\n\n${turnContext}`
      }

      // ── Reply evidence (grounding gate) ──
      // Figures observed in successful tool results this turn (fed by the
      // tool executor) plus seeded material — the system prompt and the
      // user's own message — form the evidence the gate diffs reply claims
      // against. Prior ASSISTANT turns are deliberately not seeded (a
      // confabulated figure must not launder itself into next-turn
      // evidence). Accumulate-only: no gatedTools, so the identifier
      // write-gate stays a workflow-lane behavior.
      const replyEvidence = new EvidenceAccumulator()
      replyEvidence.note(systemPromptWithPreflight)
      if (typeof message === 'string') replyEvidence.note(message)

      const confirmationResolver = createConfirmationResolver()
      activeResolvers.set(session.id, confirmationResolver)
      turnResolver = confirmationResolver

      try {
        for await (const event of queryLoop({
          // BYO-aware: when the workspace set its own Gemini key, the main
          // response runs against that provider (else the platform provider).
          provider: turnProvider,
          model,
          systemPrompt: systemPromptWithPreflight,
          messages,
          tools: loopTools,
          context: {
            userId: user.id,
            assistantId: assistant.id,
            sessionId: session.id,
            appId: 'Use Brian',
            channelType: session.channelType,
            channelId: session.channelId,
            workspaceId: assistant.workspaceId ?? undefined,
            assistantKind: assistant.kind,
            preferredChannel,
            userTimezone: user.timezone ?? undefined,
            docViewId:
              typeof requestedDocViewId === 'string' && requestedDocViewId
                ? requestedDocViewId
                : null,
            // The turn's user message — doc page-creation tools snapshot it
            // as the new page's `origin_prompt` (the History "first prompt").
            userMessageText:
              typeof message === 'string' && message.trim() ? message.trim() : undefined,
            abortSignal: abortController.signal,
            cacheStore: options.cacheStore,
            sessionStateStore: options.sessionStateStore,
            requestTools: allTools,
            workerManager: options.workerManager,
            activeCapabilities,
            // WU-4.3 — Q8 lock + read-side clearance (incident 2026-06-01).
            // `clearance` is the READ ceiling = min(member, assistant) so a
            // low-clearance member can't read confidential rows through a
            // higher-clearance assistant. `assistantClearance` is the WRITE
            // ceiling (the assistant's own tier) — the tool-executor write
            // gate + default extraction sensitivity key off it, so writes stay
            // authorable at the assistant's clearance even when reads are
            // bounded lower. The sensitivity accumulator (max tier *seen* this
            // turn) drives write stamping and is naturally bounded by reads.
            clearance: readClearance,
            compartments: readCompartments,
            assistantClearance: assistant.clearance,
            assistantCompartments: assistant.compartments,
            assistantDefaultCompartments: assistant.defaultCompartments,
            // Lifted to the per-turn accumulator constructed before the
            // extra-tool injection so the connector_action audit hook sees
            // the same instance the queryLoop populates.
            sensitivity: sensitivityAccumulator,
            compartmentAccumulator,
            evidence: replyEvidence,
            outboundAttachments: outboundAttachmentCollector,
            // Research turns ingest public-web findings: model-driven saves
            // (saveMemory / addKnowledgeEntry / saveContact|Company|Deal)
            // stamp `public` rather than inheriting the `internal` tier of
            // the brain-first orientation reads. Confidential stays a hard
            // floor. See researchWriteFloor + sensitivity.md.
            researchMode,
            // Q10 unification (WU-6.3) — present only when the store is wired
            // AND the assistant is workspace-scoped (pending_approvals.workspace_id
            // is NOT NULL). Legacy personal assistants take Path A.
            createToolInvocationApproval:
              assistant.workspaceId
                ? async ({
                    toolName,
                    toolInput,
                    description,
                    displayLines,
                    allowPersistentApproval,
                    expiresAt,
                  }) => {
                    const row = await options.pendingApprovalsStore.createToolInvocation({
                      workspaceId: assistant.workspaceId!,
                      blockingSessionId: session.id,
                      originatingAssistantId: assistant.id,
                      approverUserId: user.id,
                      toolName,
                      arguments: toolInput,
                      approvalPayload: {
                        description,
                        displayLines,
                        allowPersistentApproval,
                      },
                      deliveryChannelType: 'web',
                      deliveryChannelId: null,
                      expiresAt,
                    })
                    return row.id
                  }
                : undefined,
            // askQuestion suspend-resume (Phase 2). When the model calls
            // askQuestion as the sole tool and no workers are pending,
            // the engine routes the question through this hook instead
            // of terminating the loop. The chat process saves the row,
            // emits awaiting_approval, and exits the SSE without
            // turn_complete; POST /api/sessions/.../answer/:approvalId
            // (or /cancel/...) resolves the suspension via the same
            // Path B enqueue used by tool_invocation. See
            // docs/architecture/engine/askquestion-suspend-resume.md.
            createPendingQuestion:
              assistant.workspaceId
                ? async ({ question, toolUseId, expiresAt }) => {
                    const row = await options.pendingApprovalsStore.createQuestion({
                      workspaceId: assistant.workspaceId!,
                      blockingSessionId: session.id,
                      originatingAssistantId: assistant.id,
                      approverUserId: user.id,
                      question,
                      toolUseId,
                      deliveryChannelType: 'web',
                      deliveryChannelId: null,
                      expiresAt,
                    })
                    return row.id
                  }
                : undefined,
            // Path B durability for gateway-routed tools (`mcp_call`
            // dispatching a local built-in). The tool-executor's
            // `options.onAwaitingApproval` only fires for the wrapper
            // (`mcp_call`); we need a separate hook for the underlying
            // canonical tool so a Cloud Run restart mid-confirmation
            // replays the right thing. Mirrors the `awaiting_approval`
            // event handler below — same `approvalResolverIndex` entry,
            // same `session_resume_points` checkpoint, just keyed on the
            // canonical underlying tool name.
            onInnerAwaitingApproval: (event) => {
              approvalResolverIndex.set(event.approvalId, {
                sessionId: session.id,
                toolCallId: event.toolCallId,
              })
              if (options.sessionResumeStore) {
                options.sessionResumeStore.create({
                  sessionId: session.id,
                  approvalId: event.approvalId,
                  suspendedToolName: event.toolName,
                  suspendedToolInput: event.toolInput,
                  // `mcp_call` is the loop step being executed; replay
                  // re-enters that same step and the dispatcher's fast
                  // path picks up the resolved approval.
                  loopStepIndex: 0,
                }).catch((err) => {
                  console.warn(
                    `[chat] session_resume_points (inner) checkpoint failed for approval ${event.approvalId}; Path A fallback in effect:`,
                    err,
                  )
                })
              }
            },
          },
          channelType: session.channelType,
          compactModel: 'gemini-flash',
          confirmationResolver,
          confirmationTimeoutMs: 86_400_000, // 24h for web
          // Coordinator mode: the model is told "Do NOT write any response text
          // yet" and the loop only un-suppresses on the synthesis turn after
          // Phase 4b drains worker results. Start suppressed so leading
          // thinking-style preambles emitted BEFORE the first spawnWorker
          // chunk don't leak — the reactive flip in queryLoop happens after
          // the text part has already streamed.
          suppressIntermediateText: coordinatorMode,
          // Per-turn ceilings scale with intelligence tier — paid tiers
          // earn headroom for multi-step reasoning; research mode lifts
          // them further so the coordinator + workers have room for
          // deep web synthesis before the loop forces a final answer.
          // See `chatTierBudget` and `docs/architecture/engine/query-loop.md`
          // → "Chat-tier budget".
          //
          // workerDrainPrompt overrides Phase 4b's default "ingest + reply"
          // injection. The override is STATUS-AWARE — it branches on
          // worker outcome:
          //   - If ANY worker returned status='failed' (protocol violation),
          //     it returns a STRONG respawn directive that requires the
          //     model to emit only spawnWorker tool calls in the next turn.
          //     Prompt-only enforcement of "respawn for protocol-violation"
          //     was unreliable — production trace showed the coordinator
          //     emitting a <gap-assessment> text block as its deliverable
          //     and exiting without spawning follow-ups.
          //   - If all workers completed and we're below the retry cap,
          //     the model is allowed to either (a) emit follow-up workers
          //     for partial gaps or (b) move to Phase 4 synthesis.
          //   - If we hit the wave cap, force final synthesis with a
          //     "we tried N waves" explanation so the loop doesn't spin.
          // Metered turns run the PROFILE's tool-round budget (L15) — the
          // user confirmed the estimate at exactly this depth.
          ...(meteredTurn
            ? { maxTurns: meteredTurn.toolRounds, maxToolCalls: meteredTurn.toolRounds }
            : chatTierBudget({ model, researchMode }) ?? {}),
          // Execution-plan completeness gate: when the session has an active
          // plan with open steps, a tool-less turn keeps working them instead
          // of stalling half-done; budget exhaustion fires one model-generated
          // resumable handoff. Deterministic (one cheap read). Nudge cap is
          // tier-scaled (decision D). See execution-plan.md.
          planGate: options.planStore
            ? {
                status: async (sid: string) => {
                  const steps = await options.planStore!.listActiveBySession(sid)
                  if (steps.length === 0) return null
                  const open = steps.filter(
                    (s) => s.status === 'pending' || s.status === 'in_progress',
                  )
                  return {
                    open: open.length,
                    total: steps.length,
                    openSteps: open.map((s) => ({ key: s.key, description: s.description })),
                  }
                },
              }
            : undefined,
          planNudgeCap: planNudgeCap({ model, researchMode }),
          // Fresh-facts grounding gate — a figure-bearing answer about
          // current facts (prices, offers, rates, deadlines) produced with
          // zero tool calls gets one forced-verification nudge. Skipped in
          // coordinator/research mode, whose protocol already forces
          // evidence. `draftDelivered: true` — the web SSE already streamed
          // the draft, so the nudge copy tells the model to correct it
          // explicitly. See docs/architecture/engine/grounding-gate.md.
          ...(!coordinatorMode && !researchMode && typeof message === 'string' && message.trim()
            ? { groundingGate: { userMessage: message, draftDelivered: true } }
            : {}),
          ...(researchMode ? {
            workerDrainPrompt: createResearchWorkerDrainPrompt(),
          } : {}),
          // Opt into askQuestion suspend behavior for workspace-scoped
          // chats. The engine only honors the suspend branch when this
          // flag is set AND `context.createPendingQuestion` is wired
          // (above). Worker / scheduled-job / smoke contexts keep legacy
          // terminal behavior since they don't construct that hook. See
          // docs/architecture/engine/askquestion-suspend-resume.md.
          questionResumeEnabled: !!assistant.workspaceId,
        })) {
          if (abortController.signal.aborted) break

          if (event.type === 'text_delta') {
            sendEvent('text_delta', { text: event.text })
            // Mirror onto the session bus (throttled) so a reconnected client
            // sees the reply stream after a refresh. No-op off `doc_thread`.
            liveStreamText += event.text
            liveStreamActivity = null
            publishTurnStream(false)
          }
          // Verbatim model reasoning streamed live (the model's own words
          // about what it's doing). Consumers that don't render it (channels,
          // older clients) simply ignore the event. See
          // docs/architecture/engine/live-streaming.md.
          if (event.type === 'thinking_delta') {
            sendEvent('reasoning', { text: event.text })
          }
          if (event.type === 'tool_start') {
            sendEvent('tool_start', { id: event.id, name: event.name })
            // Surface the running tool to a reconnected client before any reply
            // text lands (the raw name; the client maps it to a friendly label).
            if (!liveStreamText) {
              liveStreamActivity = event.name
              publishTurnStream(true)
            }
          }
          if (event.type === 'tool_input') {
            // Send a description update so the frontend can show what
            // the tool is actually doing (e.g. "Searching for DRep tools"
            // instead of "Using mcp_search").
            sendEvent('tool_input', { id: event.id, name: event.name, input: event.input })
            // Mirror tool activity to the session-event bus so other watchers
            // of a live draft-mode session see the host's per-turn tool
            // upserts as they happen.
            if (session.mode === 'draft') {
              publishSessionEvent({
                kind: 'tool_input',
                sessionId: session.id,
                payload: { name: event.name, input: event.input },
              })
            }
          }
          if (event.type === 'tool_dropped') {
            // A streamed tool step (today: a stripped askQuestion no-op) was
            // dropped from the persisted turn — tell the client to retract
            // the phantom timeline entry. See query-loop.ts strip branch.
            sendEvent('tool_dropped', { id: event.id })
          }
          if (event.type === 'grounding_nudge') {
            // The grounding gate fired: the figure-bearing draft carried
            // unbacked claims and is being rewritten from tool results. The
            // draft already streamed over SSE (no retraction on web); the
            // corrected turn arrives as a visible continuation. Telemetry
            // only — see docs/architecture/engine/grounding-gate.md.
            options.analytics?.logEvent({
              userId: user.id, assistantId: assistant.id, sessionId: session.id,
              eventName: 'grounding_nudge_fired', channelType: 'web',
              metadata: {
                matched_cue: sanitize(event.matchedCue),
                unbacked_count: event.unbackedCount,
                model: sanitize(model),
              },
            })
          }
          if (event.type === 'claim_ledger') {
            // Stash — persisted once the final assistant message row exists
            // (next to the recall-buffer flush below).
            pendingClaimLedger = event.claims
          }
          if (event.type === 'tool_result') {
            for (const block of event.results) {
              if (block.type === 'tool_result') {
                // For spawnWorker results, extract the workerId so the frontend
                // can nest the worker group under its parent spawnWorker entry.
                let spawnedWorkerId: string | undefined
                if (block.name === 'spawnWorker' && typeof block.content === 'string') {
                  const match = block.content.match(/Worker (worker_\d+)/)
                  if (match) spawnedWorkerId = match[1]
                }
                sendEvent('tool_result', {
                  id: block.toolUseId,
                  name: block.name,
                  isError: block.isError ?? false,
                  spawnedWorkerId,
                  errorMessage: block.isError ? toolErrorExcerpt(block.content) : undefined,
                })
                notifyBrainWriteIfMatch(assistant.workspaceId, block.name, block.isError ?? false)
                // Q5 (§16) — when renderView returns successfully, parse the
                // serialized data and forward the A2UI ViewPayload as a
                // dedicated SSE event so the chat client can mount a
                // <ViewRenderer/> inline. Failure to parse falls through
                // silently — the model still sees the tool result text.
                if (block.name === 'renderView' && !(block.isError ?? false)) {
                  try {
                    const parsed = JSON.parse(block.content) as {
                      kind?: string
                      payload?: unknown
                      entity?: string
                      viewType?: string
                      viewId?: string
                    }
                    if (parsed?.kind === 'view_payload' && parsed.payload) {
                      sendEvent('view_payload', {
                        toolUseId: block.toolUseId,
                        payload: parsed.payload,
                        entity: parsed.entity,
                        viewType: parsed.viewType,
                        // Notion-redesign: server-side draft id so the
                        // chat client can deep-link to the editor.
                        viewId: parsed.viewId,
                      })
                    }
                  } catch {
                    // Malformed tool output — log analytics, do not crash.
                  }
                }
                // Doc sub-pages — `createSubPage` files a new nested draft
                // (its `nest_parent_id` is set server-side) but does NOT go
                // through the renderView/view_payload path, so without this
                // event the new child sits invisible in the sidebar until a
                // manual refresh (its parent never grows a disclosure
                // chevron). Forward a dedicated SSE so the client reloads the
                // sidebar list live. See doc.md → "Nested pages".
                if (block.name === 'createSubPage' && !(block.isError ?? false)) {
                  try {
                    const parsed = JSON.parse(block.content) as {
                      kind?: string
                      pageId?: string
                    }
                    if (parsed?.kind === 'doc_sub_page' && parsed.pageId) {
                      sendEvent('sub_page_created', {
                        toolUseId: block.toolUseId,
                        pageId: parsed.pageId,
                      })
                    }
                  } catch {
                    // Malformed tool output — non-fatal.
                  }
                }
                // Doc comments — forward a dedicated SSE event when the
                // model posts or resolves a comment thread, so the editor
                // paints the gutter highlight/badge live (one event per
                // postComment in a fan-out turn). See doc-comments.md.
                if (block.name === 'postComment' && !(block.isError ?? false)) {
                  try {
                    const parsed = JSON.parse(block.content) as {
                      kind?: string
                      threadId?: string
                      pageId?: string
                      anchorBlockId?: string | null
                      isNew?: boolean
                    }
                    if (parsed?.kind === 'comment_posted' && parsed.threadId) {
                      sendEvent('comment_posted', {
                        toolUseId: block.toolUseId,
                        threadId: parsed.threadId,
                        pageId: parsed.pageId,
                        anchorBlockId: parsed.anchorBlockId ?? null,
                        isNew: parsed.isNew ?? false,
                      })
                    }
                  } catch {
                    // Malformed tool output — non-fatal.
                  }
                }
                if (block.name === 'resolveComment' && !(block.isError ?? false)) {
                  try {
                    const parsed = JSON.parse(block.content) as {
                      kind?: string
                      threadId?: string
                    }
                    if (parsed?.kind === 'thread_resolved' && parsed.threadId) {
                      sendEvent('comment_resolved', {
                        toolUseId: block.toolUseId,
                        threadId: parsed.threadId,
                      })
                    }
                  } catch {
                    // Malformed tool output — non-fatal.
                  }
                }
                // Merge the tool's optional ToolResult.meta (e.g. which search
                // provider served a webSearch call) into the analytics event.
                // Strings are sanitized because these values originate from the
                // tool implementation and become metadata in analytics_events.
                const toolMeta = event.metaByToolUseId?.[block.toolUseId]
                const extraMeta: Record<string, string | number | boolean> = {}
                if (toolMeta) {
                  for (const [k, v] of Object.entries(toolMeta)) {
                    extraMeta[k] = typeof v === 'string' ? sanitize(v) : v
                  }
                }
                options.analytics?.logEvent({
                  userId: user.id, assistantId: assistant.id, sessionId: session.id,
                  eventName: 'tool_executed', channelType: 'web',
                  metadata: { tool_name: sanitize(block.name), success: !(block.isError ?? false), ...(block.isError ? { error_message: sanitize(toolErrorExcerpt(block.content)) } : {}), ...extraMeta },
                })
                void recordExternalCostFromMeta({
                  toolMeta,
                  usageStore: options.usageStore,
                  userId: user.id,
                  assistantId: assistant.id,
                  sessionId: session.id,
                  userMessageId: storedUserMsg.id,
                  userPlan,
                  analytics: options.analytics,
                })
              }
            }
          }
          if (event.type === 'citation') {
            sendEvent('citation', { sources: event.sources })
          }
          if (event.type === 'status') {
            sendEvent('status', { message: event.message })
          }
          if (event.type === 'assistant_turn') {
            // Per-turn buffering. Each assistant_turn arrives with its own
            // tool_results already paired, so the flush site doesn't need
            // to claim-across-turns. Intermediate tool_use turns reach the
            // buffer here — `turn_complete` would skip them because it's
            // terminal-only.
            pendingAssistantTurns.push({
              content: event.response.content,
              toolResults: event.toolResults,
              stopReason: event.response.stopReason ?? 'unknown',
            })
          }
          if (event.type === 'tool_confirmation_required') {
            let enrichedInput = await enrichConfirmation(event.request.toolName, event.request.input)
            let displayName = getToolDisplayName(event.request.toolName)

            // Enrich reviewDataRequest with human-readable details
            if (event.request.toolName === 'reviewDataRequest' && enrichedInput.messageId) {
              try {
                const { query: dbQuery } = await import('../db/client.js')
                const msgResult = await dbQuery<{
                  category: string | null
                  payload: { question?: string; draftResponse?: string }
                  sourceName: string | null
                  sourceHandle: string | null
                }>(
                  `SELECT apm.category, apm.payload,
                          sa.name AS "sourceName", su.handle AS "sourceHandle"
                   FROM assistant_pending_messages apm
                   JOIN assistants sa ON sa.id = apm.source_assistant_id
                   JOIN users su ON su.id = sa.owner_user_id
                   WHERE apm.id = $1`,
                  [enrichedInput.messageId],
                )
                const msg = msgResult.rows[0]
                if (msg) {
                  displayName = `${msg.sourceName ?? 'An assistant'}${msg.sourceHandle ? ` (@${msg.sourceHandle})` : ''} is requesting your ${msg.category ?? 'data'}`
                  enrichedInput = {
                    question: msg.payload.question ?? '(no question)',
                    category: msg.category ?? 'data',
                    action: enrichedInput.action,
                    _messageId: enrichedInput.messageId,
                  }
                }
              } catch { /* use original input */ }
            }

            sendEvent('tool_confirmation_required', {
              toolCallId: event.request.toolCallId,
              toolName: event.request.toolName,
              displayName,
              input: enrichedInput,
              description: event.request.description,
              displayLines: event.request.displayLines,
              allowPersistentApproval: event.request.allowPersistentApproval ?? false,
            })
          }
          if (event.type === 'awaiting_approval') {
            // askQuestion suspensions (Phase 2) skip the live-resolver
            // index. The resolver has no pending entry for the askQuestion
            // toolCallId — `tryResolveLiveToolApproval` would treat
            // `resolver.resolve(...)` as success and short-circuit the
            // Path B enqueue, leaving the session permanently stuck.
            // Questions ALWAYS go through the scheduled-job resume worker.
            // See docs/architecture/engine/askquestion-suspend-resume.md.
            const isAskQuestion = event.toolName === 'askQuestion'
            if (!isAskQuestion) {
              // WU-6.4 — register the fast-path index entry so the unified
              // approvals route (which only knows `approvalId`) can reach
              // this session's live in-memory resolver.
              approvalResolverIndex.set(event.approvalId, {
                sessionId: session.id,
                toolCallId: event.toolCallId,
              })
            }
            // WU-6.4 enqueue side — write the Path B suspension checkpoint.
            // The `pending_approvals` row already exists (the executor's
            // createToolInvocationApproval port minted it). This row is the
            // companion: it lets the resume worker re-enter the loop and
            // replay the suspended tool after a Cloud Run restart. Best-
            // effort — a failed checkpoint write degrades to Path A
            // (in-memory only) rather than blocking the user.
            if (options.sessionResumeStore) {
              try {
                await options.sessionResumeStore.create({
                  sessionId: session.id,
                  approvalId: event.approvalId,
                  suspendedToolName: event.toolName,
                  suspendedToolInput: event.toolInput,
                  loopStepIndex: event.loopStepIndex,
                })
              } catch (err) {
                console.warn(
                  `[chat] session_resume_points checkpoint failed for approval ${event.approvalId}; Path A fallback in effect:`,
                  err,
                )
                options.analytics?.logEvent({
                  userId: user.id, assistantId: assistant.id, sessionId: session.id,
                  eventName: 'session_resume_checkpoint_failed', channelType: 'web',
                  metadata: { approval_id: sanitize(event.approvalId), error_type: sanitize((err as Error)?.name ?? 'unknown') },
                })
              }
            }
          }
          if (event.type === 'turn_complete') {
            // Track cost (fires once — terminal event).
            // Use totalUsage (accumulated across ALL query-loop turns) rather
            // than response.usage (last turn only) so intermediate tool-use
            // turns are included in cost tracking.
            const usage = event.totalUsage
            if (options.usageStore && usage) {
              // BYO billing branch: when the turn was served by the workspace's
              // own Gemini key, the LLM/message cost is the workspace's own spend
              // with Google, not ours — charge it 0. `providerKeySource` records
              // which key drove the turn for downstream attribution. This only
              // covers the main_response (LLM) charge; MCP tool calls and
              // memory/brain ops bill exactly as before (untouched).
              const cost = usedByoKey
                ? 0
                : calculateCost(event.response.model, usage)
              options.usageStore.recordUsage({
                userId: user.id,
                assistantId: assistant.id,
                sessionId: session.id,
                model: event.response.model,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheReadTokens: usage.cacheReadTokens,
                cacheWriteTokens: usage.cacheWriteTokens,
                actualCostUsd: cost,
                source: userPlan === 'free' ? 'free' : 'included',
                userMessageId: storedUserMsg.id,
                triggerKey: 'main_response',
                providerKeySource: usedByoKey ? 'user' : 'platform',
              }).catch((err) => {
                console.error('Usage tracking failed:', err)
                options.analytics?.logEvent({
                  userId: user.id, assistantId: assistant.id, sessionId: session.id,
                  eventName: 'usage_tracking_error', channelType: 'web',
                  metadata: { error_type: sanitize((err as Error)?.name ?? 'unknown') },
                })
              })

              // Metered lane debit (L8): 5 + ceil(cost/$0.020), charged on
              // COMPLETION at actual measured cost, idempotent on the stored
              // user message id (a stream retry can't double-charge). A
              // failed turn never reaches here, so it charges nothing.
              if (meteredTurn && assistant.workspaceId && options.chargeMeteredSurcharge) {
                const chargedMetered = meteredTurn
                options.chargeMeteredSurcharge({
                  workspaceId: assistant.workspaceId,
                  requestId: storedUserMsg.id,
                  modelAlias: chargedMetered.alias,
                  profileId: chargedMetered.profileId,
                  toolRounds: chargedMetered.toolRounds,
                  modelCostUsd: cost,
                  chargedByUserId: user.id,
                }).then(({ credits }) => {
                  options.analytics?.logEvent({
                    userId: user.id, assistantId: assistant.id, sessionId: session.id,
                    eventName: 'metered_turn_charged', channelType: 'web',
                    metadata: {
                      model: sanitize(chargedMetered.alias),
                      tool_rounds: chargedMetered.toolRounds,
                      credits,
                      cost_usd_micro: Math.round(cost * 1_000_000),
                    },
                  })
                }).catch((err) => {
                  console.error('[chat] metered surcharge failed:', err)
                  options.analytics?.logEvent({
                    userId: user.id, assistantId: assistant.id, sessionId: session.id,
                    eventName: 'metered_charge_error', channelType: 'web',
                    metadata: { error_type: sanitize((err as Error)?.name ?? 'unknown') },
                  })
                })
              }

              options.analytics?.logEvent({
                userId: user.id, assistantId: assistant.id, sessionId: session.id,
                eventName: 'turn_completed', channelType: 'web',
                metadata: {
                  model: sanitize(event.response.model),
                  input_tokens: usage.inputTokens,
                  output_tokens: usage.outputTokens,
                  cost_usd_micro: Math.round(cost * 1_000_000),
                  cache_hits: usage.cacheReadTokens ?? 0,
                },
              })

              // Phase 0 doc turn-context instrumentation. Attribute the
              // turn's prompt to its components so the doc token-cost work
              // (delta returns, tighter elision, future hierarchical map +
              // retrieval) is measured, not guessed. Metadata is token counts
              // only (no content) — analytics-events 'metadata-only' contract.
              // See docs/plans/doc-turn-context-optimization.md → Phase 0.
              if (onDocSurface) try {
                const composition = measureDocContext({
                  systemPrompt: systemPromptWithPreflight,
                  skillBlock: docSkillBlockStr,
                  liveOutline: docLiveOutlineStr,
                  outlineBlockCount: docOutlineBlockCount,
                  memoryContext,
                  messages,
                  pageBlockCount: docPageBlockCount,
                  pageVersion: docPageVersion,
                  usage,
                })
                options.analytics?.logEvent({
                  userId: user.id, assistantId: assistant.id, sessionId: session.id,
                  eventName: 'doc_context_composition', channelType: 'web',
                  metadata: {
                    model: sanitize(event.response.model),
                    is_comment_thread: session.channelType === 'doc_thread',
                    system_prompt_tokens: composition.systemPromptTokens,
                    skill_block_tokens: composition.skillBlockTokens,
                    live_outline_tokens: composition.liveOutlineTokens,
                    outline_block_count: composition.outlineBlockCount,
                    memory_context_tokens: composition.memoryContextTokens,
                    message_history_tokens: composition.messageHistoryTokens,
                    doc_history_tokens: composition.docHistoryTokens,
                    max_doc_result_tokens: composition.maxDocResultTokens,
                    large_doc_result_count: composition.largeDocResultCount,
                    page_block_count: composition.pageBlockCount,
                    page_version: composition.pageVersion,
                    input_tokens: composition.inputTokens,
                    output_tokens: composition.outputTokens,
                    cache_read_tokens: composition.cacheReadTokens,
                  },
                })
              } catch (err) {
                // Instrumentation must never fail a turn the user already
                // received (turn_complete fires after the response streamed).
                console.warn('[chat] doc_context_composition instrumentation failed:', err)
              }
            }
            // WU-6.4 — the loop exited normally, so any Path B resume
            // checkpoint for this session is stale (the suspended tool
            // either resolved fast-path or was never reached). Drop it so a
            // late approval-resolve doesn't enqueue a redundant resume job.
            // Best-effort: a leftover row is harmless (the resume worker
            // no-ops on an already-resolved approval).
            if (options.sessionResumeStore) {
              options.sessionResumeStore
                .deleteBySessionId(session.id)
                .catch((err) => console.debug('[chat] resume-point cleanup failed:', err))
            }
          }
          if (event.type === 'error') {
            sendEvent('error', { error: event.error.message })
            console.error('Query loop error:', event.error)
            options.analytics?.logEvent({
              userId: user.id, assistantId: assistant.id, sessionId: session.id,
              eventName: 'query_loop_error', channelType: 'web',
              metadata: { error_type: sanitize(event.error.name ?? 'unknown') },
            })
          }
        }

        // Happy-path flush: the loop completed without throwing. Any
        // tool_use without a result at this point means the executor
        // genuinely failed to produce one (e.g. abort mid-execution). The
        // synthesis message guides the model not to retry.
        await flushBufferedTurns(
          abortController.signal.aborted
            ? '[Tool execution was aborted before completion.]'
            : '[Tool did not return a result. Treat as failed and do not retry.]',
        )

        // CL-8: bump `succeeded` for every skill picked this turn. The
        // happy-path flush above has already committed the assistant
        // message; an abort still counts as success because the model
        // did finish its tool work (only the executor was interrupted)
        // — the user is the one who pulled the plug, not the skill.
        //
        // V1 ships `succeeded` only. The deferred `user_corrected_after`
        // signal is documented in
        // `docs/architecture/context-engine/memory-consolidation.md` →
        // "Skill invocation feedback (CL-8 lock)" and shaped through
        // the buffer's `getNextUserMessage` hook for a follow-up patch.
        if (skillInvocationBuffer) {
          try {
            await skillInvocationBuffer.flush('success')
          } catch (err) {
            console.error('[chat] CL-8 skill invocation buffer flush failed:', err)
          }
        }

        // Session-state diff pass (fire-and-forget safety net). Watches
        // the last exchange for commitments the model forgot to track with
        // `trackCommitment`, and auto-resolves ones it forgot to close. See
        // docs/architecture/context-engine/session-state.md.
        if (options.sessionStateStore) {
          const stateStore = options.sessionStateStore
          const diffRecentTurns: Message[] = []
          // Last user message + last assistant turn's text — enough to
          // infer commitment deltas without ballooning the Standard-tier call.
          const assistantLastText = pendingAssistantTurns
            .flatMap((t) => t.content)
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
          if (assistantLastText) {
            diffRecentTurns.push(
              { role: 'user', content: userMessageText },
              { role: 'assistant', content: assistantLastText },
            )
          }
          stateStore
            .listOpenBySession(session.id)
            .then((open: SessionStateRecord[]) =>
              runSessionStateDiff({
                provider: options.provider,
                // Standard tier per docs/architecture/platform/cost-and-pricing.md
                // → Model routing (extraction / classification / structured-output bucket).
                model: 'gemini-3.1-flash-lite',
                sessionId: session.id,
                userId: user.id,
                assistantId: assistant.id,
                store: stateStore,
                recentTurns: diffRecentTurns,
                openCommitments: open,
              }),
            )
            .then((result) => {
              options.analytics?.logEvent({
                userId: user.id, assistantId: assistant.id, sessionId: session.id,
                eventName: result.errorMessage ? 'session_state_diff_failed' : 'session_state_diff_pass',
                channelType: 'web',
                metadata: {
                  upserts: result.upserts,
                  resolves: result.resolves,
                  error: result.errorMessage ? sanitize(result.errorMessage) : undefined,
                },
              })
              return recordOverheadUsage({
                usageStore: options.usageStore,
                userId: user.id,
                assistantId: assistant.id,
                sessionId: session.id,
                userMessageId: storedUserMsg.id,
                model: result.model,
                usage: result.usage,
                source: 'overhead:session-state-diff',
                triggerKey: 'session_state_diff',
              })
            })
            .catch((err) => console.debug('[chat] session-state diff failed:', err))
        }

        // Memory nudge: judge utility of any getMemory calls (fire-and-forget).
        // Records usage as `overhead:nudge` once the judge call returns.
        // Standard tier per docs/architecture/platform/cost-and-pricing.md
        // → Model routing (extraction / classification / structured-output bucket).
        runMemoryNudge({
          turns: pendingAssistantTurns,
          callModel: async (prompt) => {
            const resp = await collectStream(options.provider.stream({
              model: 'gemini-3.1-flash-lite',
              messages: [{ role: 'user', content: prompt }],
              systemPrompt: 'You are a memory utility judge. Follow instructions exactly.',
              maxTokens: 256,
            }))
            return {
              text: resp.content.filter((b): b is { type: 'text'; text: string } => b.type === 'text').map((b) => b.text).join(''),
              usage: resp.usage,
              model: 'gemini-3.1-flash-lite',
            }
          },
          store: options.memoryStore,
        })
          .then((result) => recordOverheadUsage({
            usageStore: options.usageStore,
            userId: user.id,
            assistantId: assistant.id,
            sessionId: session.id,
            userMessageId: storedUserMsg.id,
            model: result.model,
            usage: result.usage,
            source: 'overhead:nudge',
            triggerKey: 'memory_nudge',
          }))
          .catch((err) => console.debug('[chat] memory nudge failed:', err))

        // If the final buffered turn had no text and no tool_use, the
        // model produced nothing useful on the follow-up — surface a
        // descriptive error to the client so it can show something better
        // than the generic "I couldn't generate a response" fallback.
        const finalTurn = pendingAssistantTurns[pendingAssistantTurns.length - 1]

        // ── Diagnostic: dump all buffered turns for debugging empty responses
        console.log(
          `[chat] Buffered ${pendingAssistantTurns.length} turn(s). Details:`,
          pendingAssistantTurns.map((t, i) => ({
            turn: i,
            stopReason: t.stopReason,
            contentBlocks: t.content.length,
            contentTypes: t.content.map((b) => b.type),
            toolResultCount: t.toolResults.length,
            textPreview: t.content
              .filter((b): b is { type: 'text'; text: string } => b.type === 'text' && 'text' in b)
              .map((b) => b.text.slice(0, 100))
              .join(' | '),
          })),
        )

        if (finalTurn) {
          const hasText = finalTurn.content.some(
            (b) => b.type === 'text' && 'text' in b && b.text.trim().length > 0,
          )
          const hasToolCall = finalTurn.content.some((b) => b.type === 'tool_use')
          if (!hasText && !hasToolCall) {
            // We get here when the model emitted thinking tokens but no
            // text and no tool call — `stopReason=end_turn` with empty
            // content. `forceTextResponse` and the `EMPTY_RETRY_PLAN` in
            // query-loop.ts both try to recover before we reach this
            // branch, so hitting it means those failed too (or a
            // provider 5xx mid-stream).
            //
            // First try `composeEmptyTurnSynthesis` — Flash composes
            // the reply the coordinator skipped. Two modes inside the
            // helper: evidence mode (buffered tool results exist →
            // synthesise the answer; this rescued the Anson / GRI
            // 2026-05-27 incident where 4 webSearches + worker
            // findings sat in the buffer while Pro 3.1 thought-burnt)
            // and no-evidence mode (model thought-burnt before
            // calling any tool → Flash writes a brief "what I'd need"
            // reply that names the missing connector or data source).
            //
            // The canned banner is the absolute last line of defence
            // — emitted only when Flash itself errors or yields empty
            // text. Reaching it should be rare.
            console.warn(
              `[chat] Final turn was empty (stopReason=${finalTurn.stopReason}). Prior turns (if any) were flushed with synthetic tool_result stubs.`,
            )
            options.analytics?.logEvent({
              userId: user.id, assistantId: assistant.id, sessionId: session.id,
              eventName: 'turn_empty_response_fallback',
              channelType: 'web',
              metadata: {
                buffered_turns: pendingAssistantTurns.length,
                final_stop_reason: sanitize(finalTurn.stopReason ?? 'unknown'),
                research_mode: researchMode,
                coordinator_model: sanitize(model),
              },
            })
            let synthesised: string | null = null
            try {
              const result = await composeEmptyTurnSynthesis({
                provider: options.provider,
                pendingAssistantTurns,
                userText: userMessageText,
                channelType: 'web',
              })
              if (result) {
                synthesised = result.text
                await recordOverheadUsage({
                  usageStore: options.usageStore,
                  userId: user.id,
                  assistantId: assistant.id,
                  sessionId: session.id,
                  userMessageId: storedUserMsg.id,
                  model: result.model,
                  usage: result.usage,
                  source: 'overhead:empty-turn-synthesis',
                  triggerKey: 'empty_turn_synthesis',
                })
              }
            } catch (synthErr) {
              console.warn('[chat] empty-turn synthesis raised:', synthErr)
            }
            if (synthesised) {
              sendEvent('text_delta', { text: synthesised })
              await addSessionMessage({
                sessionId: session.id,
                role: 'assistant',
                content: [{ type: 'text', text: synthesised }],
              })
            } else {
              sendEvent('text_delta', {
                text:
                  "Sorry — I couldn't compose a reply for that. The model spent its turn thinking but produced no answer. " +
                  'Try rephrasing the question, splitting it into smaller asks, or — if Research mode is on — toggling it off and resending.',
              })
            }
          }
        }
      } catch (err) {
        // Any throw from the loop — flush whatever we have so the DB
        // stays well-paired, then rethrow to the outer handler.
        await flushBufferedTurns(
          '[Stream terminated unexpectedly before the tool result was recorded.]',
        )

        // CL-8: an LLM-detected error / provider error fails the
        // success criterion — discard the buffer instead of bumping
        // `succeeded`. The synchronous `invocations` + `last_invoked_at`
        // counters were already bumped inside `useSkill.execute`, so the
        // skill is recorded as picked-but-not-succeeded.
        if (skillInvocationBuffer) {
          try {
            await skillInvocationBuffer.flush('error')
          } catch (flushErr) {
            console.error('[chat] CL-8 skill invocation buffer error-flush failed:', flushErr)
          }
        }

        // Try to compose a context-aware recovery message naming any
        // tools that already shipped, so the operator doesn't blindly
        // retry the original instruction and trigger a duplicate side
        // effect (the documented Meta-flake / Gemini-stall failure
        // mode after tool calls). Best-effort; if Flash hiccups we
        // fall through to the outer catch's generic `error` event.
        try {
          const recovered = await composeRecoveryMessage({
            provider: options.provider,
            pendingAssistantTurns,
            userText: userMessageText,
            channelType: 'web',
          })
          if (recovered) {
            sendEvent('text_delta', { text: recovered.text })
            // Persist as a real assistant message so the recovery is
            // part of the conversation history on next page load —
            // without this the chat scroll-back would show
            // tool_use + tool_result with no narration, exactly the
            // ambiguous state the helper was added to avoid.
            await addSessionMessage({
              sessionId: session.id,
              role: 'assistant',
              content: [{ type: 'text', text: recovered.text }],
            })
            await recordOverheadUsage({
              usageStore: options.usageStore,
              userId: user.id,
              assistantId: assistant.id,
              sessionId: session.id,
              userMessageId: storedUserMsg.id,
              model: recovered.model,
              usage: recovered.usage,
              source: 'overhead:recovery-message',
            })
            recoveryDelivered = true
          }
        } catch (recoverErr) {
          console.warn('[chat] recovery message delivery failed:', recoverErr)
        }

        throw err
      }

      // Suppress unused-var warning — lastAssistantMessageId is populated
      // for future use (feedback attach on next turn, analytics) and the
      // SSE event is emitted inside the flush.
      void lastAssistantMessageId

      await updateSessionStatus(session.id, 'idle')
      activeResolvers.delete(session.id)
      // WU-6.4 — drop any fast-path index entries for this session. If an
      // approval is still genuinely pending at stream close (rare — the
      // 24h web timeout normally outlives the SSE connection), the resume
      // worker is the recovery path; the in-memory resolver is gone anyway.
      for (const [approvalId, entry] of approvalResolverIndex) {
        if (entry.sessionId === session.id) approvalResolverIndex.delete(approvalId)
      }

      // Tell team-shared draft watchers the turn just finished so they
      // can re-enable their input boxes. No-op for non-draft sessions.
      if (session.mode === 'draft') {
        publishSessionEvent({
          kind: 'turn_completed',
          sessionId: session.id,
          payload: { senderUserId: user.id },
        })
      }
      // Tell any reconnected comment-thread watcher (the doc reconnect stream,
      // GET /api/sessions/:id/stream) the turn is done so it refetches the
      // persisted reply and clears its "working…" bubble. Only meaningful once
      // the original client disconnected (a reconnect may exist); the endpoint's
      // 5s status poll is the backstop for any missed signal.
      if (isBackgroundTurn && clientGone) {
        publishSessionEvent({
          kind: 'turn_completed',
          sessionId: session.id,
          payload: { senderUserId: user.id },
        })
      }

      // Auto-title: fire after the first full exchange (session has no title
      // yet) so the user sees a meaningful title immediately, then refresh
      // every 10 turns as the conversation evolves. Uses a fresh DB read so
      // the excerpt includes the assistant's just-flushed response.
      //
      // Trigger: title IS NULL (first exchange), the host flags the current
      // title as an auto-generated placeholder to replace (isPlaceholderTitle —
      // open default false), or every ~10 human turns. The NULL check is robust
      // against tool-use inflating the message count.
      const needsFirstTitle = !session.title || isPlaceholderTitle(session.title)
      const isNotification = session.channelType === 'notification'
      let shouldTitle = needsFirstTitle && !isNotification
      if (!shouldTitle && !isNotification) {
        const msgCount = await countSessionTurns(session.id)
        // Count only 'user' role messages that are actual human messages
        // (tool_result messages are also role=user, but this is a rough heuristic)
        const turnCount = Math.floor(msgCount / 2)
        shouldTitle = turnCount > 1 && turnCount % 10 === 0
      }
      if (shouldTitle) {
        // Bounded so a slow title LLM call can never hold the SSE stream open
        // and starve the client of the terminal `done` event. If the timeout
        // fires, the title write is still in flight — it'll land in DB and
        // show on the next sessions fetch, just without an in-stream
        // `title_update` event for this turn.
        const AUTO_TITLE_TIMEOUT_MS = 10_000
        const autoTitle = (async () => {
          try {
            // Reload messages from DB so we get the assistant response that was
            // just flushed — the in-memory `messages` array is stale.
            const freshDbMessages = await getSessionMessages(session.id, { limit: 10 })
            const freshMessages: Message[] = freshDbMessages.map((m) => ({
              role: m.role as 'user' | 'assistant' | 'system',
              content: m.content as Message['content'],
            }))
            const titleResult = await generateTitle(options.provider, freshMessages)
            // generateTitle returns `title: null` when it can't produce a
            // meaningful title (empty excerpt, model returned blank). Keep the
            // existing title in that case — overwriting with a generic fallback
            // would strip context (e.g. a channel-prefixed placeholder the host
            // relies on). The next milestone turn will re-trigger.
            if (titleResult.title === null) {
              await recordOverheadUsage({
                usageStore: options.usageStore,
                userId: user.id,
                assistantId: assistant.id,
                sessionId: session.id,
                userMessageId: storedUserMsg.id,
                model: titleResult.model,
                usage: titleResult.usage,
                source: 'overhead:title',
                triggerKey: 'session_title',
              })
              return
            }
            // Preserve any channel prefix the host kept on the title (e.g. a
            // bracketed channel discriminator) so downstream filters keep
            // working after auto-title rewrites it. getTitleChannelPrefix
            // returns null in the open build. We only re-prefix when the model
            // didn't already include one.
            const channelPrefix = getTitleChannelPrefix(session.title)
            const finalTitle = channelPrefix && !titleResult.title.startsWith('[')
              ? `${channelPrefix} ${titleResult.title}`
              : titleResult.title
            const written = await updateSessionTitle(session.id, finalTitle)
            if (written && !res.writableEnded) {
              sendEvent('title_update', { sessionId: session.id, title: finalTitle })
            }
            await recordOverheadUsage({
              usageStore: options.usageStore,
              userId: user.id,
              assistantId: assistant.id,
              sessionId: session.id,
              userMessageId: storedUserMsg.id,
              model: titleResult.model,
              usage: titleResult.usage,
              source: 'overhead:title',
              triggerKey: 'session_title',
            })
          } catch (err) {
            console.error('Auto-title failed:', err)
            options.analytics?.logEvent({
              userId: user.id, assistantId: assistant.id, sessionId: session.id,
              eventName: 'auto_title_error', channelType: 'web',
              metadata: { error_type: sanitize((err as Error)?.name ?? 'unknown') },
            })
          }
        })()
        await Promise.race([
          autoTitle,
          new Promise<void>((resolve) => setTimeout(() => {
            console.warn(`[chat] auto-title exceeded ${AUTO_TITLE_TIMEOUT_MS}ms; closing stream and letting it finish in the background for session ${session.id}`)
            options.analytics?.logEvent({
              userId: user.id, assistantId: assistant.id, sessionId: session.id,
              eventName: 'auto_title_error', channelType: 'web',
              metadata: { error_type: sanitize('timeout') },
            })
            resolve()
          }, AUTO_TITLE_TIMEOUT_MS)),
        ])
      }

      // Doc reply-to-page safety net — the "New draft" build never answers
      // only in chat. A build anchored to an empty page is told to author it
      // in place, but can still end with just a text reply and NO page op
      // (e.g. it researched to the per-turn tool-call budget and was forced to
      // synthesize a chat answer, or it answered conversationally). Without
      // this the reply lands only in the chat session and the page snaps back
      // to its placeholder — the silent "nothing happened" build. So when the
      // anchored page is still EMPTY and the AI wrote nothing to it this turn,
      // write the reply onto the page via the live `patchPage` path. Runs
      // BEFORE the auto-title pass so the now-non-empty page gets named: the
      // synthetic patch's `onEvent` adds it to `docWrittenPageIds`. See
      // doc.md → "Reply-to-page safety net".
      if (
        docCtx &&
        typeof requestedDocViewId === 'string' &&
        requestedDocViewId &&
        !docWrittenPageIds.has(requestedDocViewId) &&
        !res.writableEnded
      ) {
        try {
          const replyText = pendingAssistantTurns
            .flatMap((t) => t.content)
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map((b) => b.text)
            .join('\n\n')
          const patchPageTool = allTools.get('patchPage')
          if (replyText.trim() && patchPageTool) {
            const [{ createDbDocPageStore }, { placeReplyOnEmptyPage, placeReplyAtAnchor }] =
              await Promise.all([
                import('../db/doc-page-store.js'),
                import('../doc/reply-fallback.js'),
              ])
            const docPageStore = createDbDocPageStore()
            const fallbackContext = {
              userId: user.id,
              assistantId: assistant.id,
              sessionId: session.id,
              appId: 'Use Brian',
              channelType: session.channelType,
              channelId: session.channelId,
              workspaceId: assistant.workspaceId ?? undefined,
              assistantKind: assistant.kind,
              abortSignal: abortController.signal,
            }
            const anchorBlockId =
              typeof requestedDocAnchorBlockId === 'string' && requestedDocAnchorBlockId
                ? requestedDocAnchorBlockId
                : undefined
            // Space-for-AI: the user invoked AI on a specific block of a
            // possibly-populated page and expects content THERE, so try the
            // anchored net first (it lands after the anchor regardless of page
            // emptiness). If no anchor rode in, or the anchor vanished from the
            // page this turn, fall through to the empty-page net (a no-op on a
            // populated page). See doc.md → "Reply-to-page safety net".
            let placed = anchorBlockId
              ? await placeReplyAtAnchor({
                  pageId: requestedDocViewId,
                  anchorBlockId,
                  replyText,
                  docPageStore,
                  patchPageTool,
                  context: fallbackContext,
                })
              : undefined
            if (!placed || (!placed.placed && placed.reason === 'anchor-missing')) {
              placed = await placeReplyOnEmptyPage({
                pageId: requestedDocViewId,
                replyText,
                docPageStore,
                patchPageTool,
                context: fallbackContext,
              })
            }
            options.analytics?.logEvent({
              userId: user.id, assistantId: assistant.id, sessionId: session.id,
              eventName: 'doc_reply_to_page', channelType: 'web',
              metadata: {
                placed: placed.placed,
                reason: sanitize(placed.placed ? 'ok' : placed.reason),
                anchored: Boolean(anchorBlockId),
              },
            })
          }
        } catch (err) {
          console.error('[chat] doc reply-to-page fallback failed:', err)
        }
      }

      // Doc page auto-title (migration 218) — the AI edit trigger. After a
      // doc authoring turn, title any page the AI wrote that is still on
      // its untouched placeholder name. `runDocAutoTitle` re-checks
      // `name_origin = 'placeholder'` + a small content floor and commits via
      // the guarded `setAutoTitle`, so this no-ops for already-titled pages
      // and for the AI's own explicit `setTitle` (which froze name_origin to
      // 'user'). The `doc_title_update` SSE event lands the new name in the
      // open editor + sidebar live. Bounded like the session auto-title so a
      // slow call can't hold the stream open. See doc.md → "Auto-title".
      if (
        docToolsTurn &&
        docWrittenPageIds.size > 0 &&
        !res.writableEnded
      ) {
        const DOC_TITLE_TIMEOUT_MS = 8_000
        const docTitle = (async () => {
          try {
            const [{ createDbDocPageStore }, { createDbSavedViewStore }, { runDocAutoTitle }] =
              await Promise.all([
                import('../db/doc-page-store.js'),
                import('../db/saved-views-store.js'),
                import('../doc/auto-title.js'),
              ])
            const docPageStore = createDbDocPageStore()
            const savedViewStore = createDbSavedViewStore()
            for (const pageId of docWrittenPageIds) {
              const result = await runDocAutoTitle({
                userId: user.id,
                pageId,
                provider: options.provider,
                docPageStore,
                savedViewStore,
                minChars: AUTO_TITLE_AI_MIN_CHARS,
              })
              if (result.applied && result.title && !res.writableEnded) {
                // `icon` is the emoji the generator suggested + the commit
                // landed (null when none / the user already had an icon). The
                // client swaps both the title and the icon live.
                sendEvent('doc_title_update', {
                  pageId,
                  title: result.title,
                  icon: result.icon,
                })
              }
              await recordOverheadUsage({
                usageStore: options.usageStore,
                userId: user.id,
                assistantId: assistant.id,
                sessionId: session.id,
                userMessageId: storedUserMsg.id,
                model: result.model,
                usage: result.usage,
                source: 'overhead:title',
                triggerKey: 'doc_page_title',
              })
            }
          } catch (err) {
            console.error('Doc auto-title failed:', err)
          }
        })()
        await Promise.race([
          docTitle,
          new Promise<void>((resolve) => setTimeout(resolve, DOC_TITLE_TIMEOUT_MS)),
        ])
      }

      sendEvent('done', {})
      res.end()
    } catch (err) {
      console.error('Chat error:', err)
      // When the inner catch already delivered a context-aware recovery
      // message, surface a clean `done` so the client treats the turn
      // as complete (it is — the user already saw the recovery text).
      // The generic `error` here would render a red banner and offer a
      // retry that could duplicate side effects.
      if (recoveryDelivered) {
        sendEvent('done', {})
      } else {
        sendEvent('error', { error: 'Something went wrong' })
      }
      // If a turn_started was broadcast for a draft session before the
      // crash, pair it with turn_completed so collaborators don't see the
      // input dimmed forever. We don't know the senderUserId from outer
      // scope here, so the SSE consumers should treat any turn_completed
      // as "the lock is released" rather than per-user.
      if (sessionIdForError && userIdForError) {
        try {
          // Best-effort — failure here must not mask the original error.
          publishSessionEvent({
            kind: 'turn_completed',
            sessionId: sessionIdForError,
            payload: { senderUserId: userIdForError },
          })
        } catch { /* ignore */ }
        // Also flip status back to idle so subsequent turns aren't blocked
        // by the concurrent-turn guard.
        try {
          await updateSessionStatus(sessionIdForError, 'idle')
        } catch { /* ignore */ }
      }
      // Only log if we have at least user context — earlier failures (e.g.
      // user lookup crash) go to console only since analytics_events requires
      // a non-null user_id.
      if (userIdForError) {
        options.analytics?.logEvent({
          userId: userIdForError,
          assistantId: assistantIdForError ?? undefined,
          sessionId: sessionIdForError ?? undefined,
          eventName: 'chat_route_error', channelType: 'web',
          metadata: {
            error_type: sanitize((err as Error)?.name ?? 'unknown'),
            error_message: sanitize(((err as Error)?.message ?? '').slice(0, 200)),
            stage: sanitize(
              sessionIdForError ? 'post_session' :
              assistantIdForError ? 'post_assistant' : 'post_user',
            ),
          },
        })
      }
      res.end()
    } finally {
      // Evict this turn's confirmation state on error/abort exits — the
      // success path already cleared it before `done`. Identity-guarded:
      // the catch above flips the session back to idle, so a successor turn
      // may have registered its own resolver under the same sessionId by the
      // time this runs; only remove the entry if it is still OURS.
      if (sessionIdForError && turnResolver &&
          activeResolvers.get(sessionIdForError) === turnResolver) {
        activeResolvers.delete(sessionIdForError)
        for (const [approvalId, entry] of approvalResolverIndex) {
          if (entry.sessionId === sessionIdForError) approvalResolverIndex.delete(approvalId)
        }
      }
      // Close the assistant-run presence entry on every exit path (success,
      // error, client-disconnect abort). Best-effort + idempotent; the
      // doc-sync TTL sweeper is the backstop if this POST never lands.
      if (docRunPageId) {
        void docRunClient?.end(docRunPageId)
      }
    }
  })

  // ── POST /confirm — resolve a pending tool confirmation ──────
  router.post('/confirm', async (req, res) => {
    const { sessionId, toolCallId, decision } = req.body as {
      sessionId?: string
      toolCallId?: string
      decision?: ConfirmationDecision
    }

    if (!sessionId || !toolCallId || !decision) {
      res.status(400).json({ error: 'Missing sessionId, toolCallId, or decision' })
      return
    }

    const jwtUserId = (req as { userId?: string }).userId
    if (!jwtUserId) { res.status(401).json({ error: 'Unauthorized' }); return }

    const resolver = activeResolvers.get(sessionId)
    if (resolver) {
      // Ownership gate: only the session's own user may resolve its pending
      // tool confirmation. `activeResolvers` is a process-global map keyed by
      // sessionId across ALL users; without this, any authenticated co-tenant
      // who learns a sessionId could approve/deny another user's gated tool
      // action (e.g. deleteMemory / a connector write) against that user's
      // brain. (Mirrors the approverUserId check on the approvals surface.)
      const session = await findSessionById(sessionId)
      if (!session || session.userId !== jwtUserId) {
        res.status(403).json({ error: 'Not authorized for this confirmation' })
        return
      }
      resolver.resolve(toolCallId, decision)
      res.json({ ok: true })
      return
    }

    // Fallback: a deferred confirmation from a scheduled job. The scheduler
    // registry now records each entry's deliver-target owner, so guard the
    // resolve by the JWT user — a co-tenant who learns a toolCallId cannot
    // approve another user's parked job action. The registry entry carries its
    // own owner, so this needs no deferred-store lookup (and still works when
    // the store is unwired).
    if (tryResolveSchedulerConfirmation(toolCallId, decision, { userId: jwtUserId })) {
      options.deferredConfirmationStore?.markResolved(toolCallId, decision)
        .catch((err) => console.error('[chat] deferred confirmation DB update failed:', err))
      res.json({ ok: true })
      return
    }

    res.status(404).json({ error: 'No pending confirmation for this session' })
  })

  return router
}
