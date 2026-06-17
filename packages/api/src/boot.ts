/**
 * bootOpenApi — the OPEN composition root for the sidanclaw HTTP API.
 *
 * This module builds the entire OPEN slice of the API service: the express
 * app + middleware, the LLM provider stack, every open DB store, the open tool
 * set, the 47 open route mounts (in the platform's original order), and the
 * open background workers. It imports ZERO closed code — every closed seam is
 * an OPTIONAL injected PORT with a safe default (allow-all credit gate, no-op
 * usage recorder, inert feed hooks, no-op episode ingestors, …). The closed
 * platform entry (`apps/api/src/index.ts`, `@sidanclaw/api-server`) calls this
 * with the real impls + a `mountExtraRoutes` hook that mounts the 33 closed
 * routes onto the same app against the SAME store instances exposed on
 * `BootContext`. A standalone open entry (`sidanclaw/apps/api`,
 * `@sidanclaw/api-open`) calls it with no ports → all safe defaults.
 *
 * See docs/plans/oss-local-brain-wedge.md §10 (ports & adapters DI), §12.5
 * (the open/closed manifest), and /tmp/squash/apps-split-plan.md for the full
 * inventory of open vs closed mounts.
 *
 * INVARIANT: never import `@sidanclaw/api-platform/*` or `@sidanclaw/shared-server`
 * from this file. The classification rule is mechanical — those two specifiers
 * are the only "closed" import surfaces. Config + secrets arrive through the
 * `env` option, not `getEnv()`.
 */

import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type http from 'node:http'

import express, { type Express } from 'express'
import { createTelegramApi } from '@sidanclaw/channels'
import {
  createGeminiProvider, createAnthropicProvider, wrapProvider, wrapFallback,
  createBaseTools, LAYER_1_SYSTEM_PROMPT,
  createWorkerManager, createWorkerTools,
  createSchedulingTools, createPollWorker,
  startJitteredInterval,
  createCacheTool, createReadFileTool, distillFileToText,
  createRateLimiter, sanitizeDeep,
  AnalyticsLogger, sanitize as sanitizeAnalytics,
  createConsolidationWorker,
  createEmbeddingWorker,
  createCommitmentLifecycleWorker,
  createSprintVarianceResolver,
  createCompositeCommitmentResolver,
  createGeminiEmbedder,
  calculateCost,
  collectStream,
  createInterAssistantTools,
  createReportBugTool,
  createReviewDataRequestTool,
  createWorkflowTools,
  createWorkflowBrainTools,
  createCorrectionTools,
  createBrainHealingTools,
  createScheduleWorkflowTool,
  advanceWorkflowRun,
  createTaskTools,
  createWorkspaceTools,
  type WorkspaceDirectoryStore,
  type WorkspaceMemberInfo,
  createCrmTools,
  createMemoryTools,
  createRetrievalTools,
  createViewTools,
  createFileTools,
  createFindPageTool,
  createIngestRuleTools,
  createEntityKindClassifier,
  createCircuitBreaker,
  createKnowledgeSyncWorker,
  type ExecutorDeps as WorkflowExecutorDeps,
  type LLMProvider,
  type Tool,
  type UsageStore,
  type BrainCandidateStore,
  type PendingClassificationStore,
  type GDriveFilesStore,
  type EntityRecord,
} from '@sidanclaw/core'

// ── OPEN package imports (@sidanclaw/api) ──────────────────────────
import { findAssistantById, isUserBlockedForAssistant, listAccessibleAssistants } from './db/users.js'
import { getTaskByIdSystem } from './db/tasks.js'
import { createDbConnectorActionStore } from './db/connector-actions-store.js'
import { authRoutes } from './routes/auth.js'
import { devAuthRoutes, isLocalDevEnv } from './routes/dev-auth.js'
import { createDbMagicLinkStore } from './db/magic-link-store.js'
import { createSmtpClient, createWorkspaceSmtpTransport } from './email/smtp-client.js'
import { chatRoutes, runSessionResume, tryResolveLiveToolApproval } from './routes/chat.js'
import { createSessionResumeReplay } from './routes/session-resume-replay.js'
import { brainRoutes } from './routes/brain.js'
import { homeRoutes } from './routes/home.js'
import { homeDockRoutes } from './routes/home-dock.js'
import { createDbHomeDockStore } from './db/home-dock-store.js'
import { assembleHomeSignals } from './home/signals.js'
import { runHomeRefresh } from './home/refresh.js'
import { isWorkspaceMember } from './db/home-store.js'
import { sessionRoutes } from './routes/sessions.js'
import { sessionQuestionRoutes } from './routes/sessions-questions.js'
import { analyticsRoutes } from './routes/analytics.js'
import { fileRoutes } from './routes/files.js'
import { docFilesRoutes } from './routes/doc-files.js'
import { feedbackRoutes } from './routes/feedback.js'
import { accountRoutes, accountAvatarPublicRoutes } from './routes/account.js'
import { memoryRoutes } from './routes/memories.js'
import { createEntityMergeStore } from './db/entity-merge-store.js'
import { assistantRoutes } from './routes/assistants.js'
import { skillRoutes } from './routes/skills.js'
import { workspaceRoutes } from './routes/workspaces.js'
import { invitationRoutes } from './routes/invitations.js'
import { createWorkspaceInvitationStore } from './db/workspace-invitation-store.js'
import { kbGapsRoutes } from './routes/kb-gaps.js'
import { createWorkspaceStore, getWorkspaceMembershipWithClearanceSystem } from './db/workspace-store.js'
import { createWorkspaceAuditStore } from './db/workspace-audit-store.js'
import { createConnectionStore } from './db/connection-store.js'
import { createPendingMessageStore } from './db/pending-message-store.js'
import { createChatConfirmationStore } from './db/chat-confirmation-store.js'
import { createDeferredConfirmationStore } from './db/deferred-confirmation-store.js'
import { createSnapshotStore } from './db/snapshot-store.js'
import { createDbKnowledgeStore } from './db/knowledge-store.js'
import { knowledgeRoutes, workspaceKnowledgeRoutes } from './routes/knowledge.js'
import { getBranchHead, getRepoTree, getFileContents, compareCommits } from './github/client.js'
import { startBrainStreamFanout } from './brain-stream/sse-fanout.js'
import { brainStreamRoutes } from './routes/brain-stream.js'
import { publishSessionEvent, startSessionEventBus, subscribeSessionEvents } from './session-event-bus.js'
import { createDbMcpSettingsStore } from './db/mcp-settings-store.js'
import { createDbConnectorStore } from './db/connector-store.js'
import { createConnectorInstanceStore } from './db/connector-instance-store.js'
import { createDbAssistantConnectorStore } from './db/assistant-connector-store.js'
import { createDbAssistantConnectorGrantsStore } from './db/assistant-connector-grants-store.js'
import { createDbSkillStore, createDbWorkspaceSkillStore, type WorkspaceSkill } from './db/skill-store.js'
import { makeSkillEdgeRecomputer } from './db/skill-edge-service.js'
import { createDbWorkspaceSkillFilesStore } from './db/workspace-skill-files-store.js'
import { createDbWorkspaceSkillEnablementStore } from './db/workspace-skill-enablement-store.js'
import { getSkillDraftContext } from './skills/draft-context.js'
import { createDbSkillCuratorDigestStore } from './db/skill-curator-digest-store.js'
import { skillApprovalsRoutes } from './routes/skill-approvals.js'
import { createSkillReviewWorker } from './workers/skill-review-worker.js'
import { createGeminiSkillReviewLLM } from './workers/skill-review-llm.js'
import { buildWorkspaceCuratorScope } from './workers/workspace-curator-scope.js'
import { loadSkillRegistry } from './registry/load-skill-registry.js'
import { handleRoutes } from './routes/handles.js'
import { connectionRoutes } from './routes/connections.js'
import { discoverRoutes } from './routes/discover.js'
import { createModesRouter } from './routes/modes.js'
import { pendingMessageRoutes } from './routes/pending-messages.js'
import { snapshotRoutes } from './routes/snapshots.js'
import { loadConnectorRegistry } from './registry/load-registry.js'
import { createDbLinkedAccountStore } from './db/linked-accounts.js'
import { createChannelRouteStore } from './db/channel-route-store.js'
import { createDbLinkCodeStore } from './db/link-codes.js'
import { optionalAuth, requireAuth } from './auth/middleware.js'
import { attachClientTimezone } from './auth/client-timezone.js'
import { createDbMemoryStore } from './db/memory-store.js'
import { createMemoryToEntityPromotionStore } from './db/memory-to-entity-promotion-store.js'
import { createMemoryRecallEventsStore } from './db/memory-recall-events-store.js'
import { createDbTaskStore } from './db/tasks-store.js'
import { createDbCrmStore } from './db/crm-store.js'
import { createDbWorkspaceFilesStore } from './db/workspace-files-store.js'
import { createGcsFilesClient } from './files/gcs-client.js'
import { createLocalFilesClient } from './files/local-files-client.js'
import { createFilesApi } from './files/files-api.js'
import {
  createDbWorkflowStore,
  createDbWorkflowRunStore,
  getRunIdForStepRun,
} from './db/workflow-store.js'
import { buildWorkflowToolRegistry } from './workflow/mcp-bridge.js'
import { createPendingApprovalsStore } from './db/pending-approvals-store.js'
import {
  makeRequestApproval,
  sweepExpiredApprovals,
  sweepExpiredQuestions,
  type ApprovalBridgeDeps,
} from './workflow/approval.js'
import { createApprovalDeliveryDispatcher } from './workflow/approval-deliveries.js'
import { workflowApprovalsRoutes } from './routes/workflow-approvals.js'
import { approvalsRoutes } from './routes/approvals.js'
import { workflowsRoutes } from './routes/workflows.js'
import { workflowWebhookRoutes } from './routes/workflow-webhooks.js'
import { createWorkflowChannelDelivery } from './workflow/channel-delivery.js'
import { createDeliveryTargetResolver } from './scheduling/delivery-target.js'
import { viewsRoutes } from './routes/views.js'
import { publicShareRoutes } from './routes/public-share.js'
import { docThemesRoutes } from './routes/doc-themes.js'
import { createDbSavedViewStore } from './db/saved-views-store.js'
import { createDbPageGrantStore } from './db/page-grant-store.js'
import { createDbWorkspaceGroupStore } from './db/workspace-group-store.js'
import { createDbDocThemesStore } from './db/doc-themes-store.js'
import { createDbDocPageStore } from './db/doc-page-store.js'
import { createDbDocEntityStore } from './db/doc-entity-store.js'
import { docEntitiesRoutes } from './routes/doc-entities.js'
import { createDbCommentThreadStore } from './db/comment-thread-store.js'
import { createDbDocNotificationsStore } from './db/doc-notifications-store.js'
import { commentRoutes } from './routes/comments.js'
import { inboxRoutes } from './routes/inbox.js'
import { createDbEpisodicStore } from './db/episodic-store.js'
import { createDbEpisodesStore } from './db/episodes-store.js'
import { createDbEntityLinksStore } from './db/entity-links-store.js'
import {
  createDbEntitiesStore,
  reclassifyEntityKind as reclassifyEntityKindFn,
  promoteEntityToCrm as promoteEntityToCrmFn,
} from './db/entities-store.js'
import { createClassifierSelfHealWorker } from '@sidanclaw/core'
import { supersedeMemoriesByTags } from './db/memories.js'
import { composeRetrievalStore, createDbRetrievalStore } from './db/retrieval-store.js'
import { createDbProvenanceStore } from './db/provenance-store.js'
import { createDbAggregateStore } from './db/aggregate-store.js'
import { createDbRowHistoryStore } from './db/row-history-store.js'
import { createMemoryRetractionStore } from './db/retraction-store.js'
import { createSoftDeleteStore } from './db/soft-delete-store.js'
import { createSensitivityReclassificationStore } from './db/sensitivity-reclassification-store.js'
import { createDbMarkUsefulStore } from './db/mark-useful-store.js'
import { createDbRetrievalMissStore } from './db/retrieval-miss-store.js'
import { createDbKbGapCandidateStore } from './db/kb-gap-candidate-store.js'
import { createRetrievalMissDetector } from './retrieval/retrieval-miss-detector.js'
import { createDbEmbeddingStore } from './db/embedding-store.js'
import { createDbSessionStateStore } from './db/session-state-store.js'
import { createDbPlanStore } from './db/plan-steps-store.js'
import { createDbCacheStore } from './db/cache-store.js'
import { createDbFileStore } from './db/file-store.js'
import { createDbAnalyticsStore } from './db/analytics-store.js'
import { createDbJobStore } from './db/job-store.js'
import { createDbSessionResumeStore } from './db/session-resume-store.js'
import { createDbWorkerRunsStore } from './db/worker-runs-store.js'
import { sweepStaleWorkerRuns } from './workers/worker-runs-cleanup.js'
import { createDbCapabilityStore } from './db/capability-store.js'
import {
  createDbChannelIntegrationStore,
  loadChannelCredentialKey,
} from './db/channel-integrations.js'
import { createDbApiKeyStore } from './db/api-key-store.js'
import { createShadowClaimStore } from './db/shadow-claim-store.js'
import { publicApiRoutes } from './routes/public-api.js'
import { assistantMcpRoutes } from './routes/assistant-mcp.js'
import { createControlPlaneReader } from './agent-surface/control-plane-reader.js'
import { buildAgentToolset } from './agent-surface/toolset.js'
import { createDbBrainKeyStore } from './db/brain-keys-store.js'
import { brainKeysRoutes } from './routes/brain-keys.js'
import { createDbWorkspaceLlmProviderSettingsStore, loadLlmProviderKeyEncryptionKey } from './db/workspace-llm-provider-settings.js'
import { workspaceLlmKeysRoutes } from './routes/workspace-llm-keys.js'
import { createDbCompartmentStore } from './db/compartment-store.js'
import { compartmentRoutes } from './routes/compartments.js'
import { brainMcpRoutes } from './brain-mcp/server.js'
import { createDbOAuthClientStore } from './db/oauth-client-store.js'
import { createDbDesktopAuthStore } from './db/desktop-auth-store.js'
import { createDbOAuthAuthorizationStore } from './db/oauth-authorization-store.js'
import { oauthRoutes, oauthMetadataRoutes } from './brain-mcp/oauth/index.js'
import { oauthAuthorizationsRoutes } from './routes/oauth-authorizations.js'
import { createJobExecutor } from './scheduling/executor.js'
import { createStuckSessionSweeper } from './scheduling/stuck-session-sweeper.js'
import { createViewsPruneWorker } from './scheduling/views-prune-worker.js'
import { createCleanupWorker } from './scheduling/cleanup-worker.js'
import { createCalleeExecutor } from './inter-assistant/executor.js'
import { createSnapshotGenerator } from './inter-assistant/snapshot-generator.js'
import { deliverToChannel } from './inter-assistant/deliver.js'
import { query, queryWithRLS, getPool } from './db/client.js'

import type { ChatEpisodeIngestor, BrainEpisodeIngestor } from './ingest-port.js'
import type { BuildConnectorActionAudit } from './connector-action-port.js'
import type { InjectExtraTools, ResolveAppSoul } from './tool-injection-port.js'
import type { CreditBudgetGate } from './routes/route-helpers.js'

// ════════════════════════════════════════════════════════════════════
// Public types
// ════════════════════════════════════════════════════════════════════

/**
 * The handful of config values the OPEN composition reads. The platform maps
 * `getEnv()` into this; the open entry fills it from `process.env` + defaults.
 * Closed-only secrets (Stripe, Slack, Discord OAuth, …) are deliberately
 * absent — the open routes never read them, so they never travel here.
 */
export interface OpenApiEnv {
  GEMINI_API_KEY: string
  JWT_SECRET: string
  NODE_ENV: string
  API_URL: string
  APP_URL: string
  AUTHED_APP_URL?: string
  FEED_URL?: string
  /** Optional Cloud Run injected port; falls back to API_URL port / 4000. */
  PORT?: string
  // Voice transcription reuses GEMINI_API_KEY; these toggle/model it.
  VOICE_TRANSCRIPTION_ENABLED?: boolean
  VOICE_TRANSCRIPTION_MODEL?: string
  // Optional outage-only Claude fallback.
  FALLBACK_PROVIDER_ENABLED?: boolean
  ANTHROPIC_API_KEY?: string
  // Optional connector / channel config (closed-secret gated; open passes none).
  GOOGLE_CLIENT_ID?: string
  CHANNEL_CREDENTIAL_KEY?: string
  TELEGRAM_BOT_TOKEN?: string
  GMAIL_SMTP_USER?: string
  GMAIL_SMTP_APP_PASSWORD?: string
  EMAIL_FROM_ADDRESS?: string
  WA_CONNECTOR_URL?: string
  WA_CONNECTOR_SECRET?: string
  LLM_PROVIDER_KEY_ENCRYPTION_KEY?: string
  // Blob storage (open uses local-disk fallback when unset).
  GCS_FILES_BUCKET?: string
  // Weekly skill-hygiene passes ship dark unless on.
  SKILLS_AUTO_GEN_ENABLED?: boolean
}

/**
 * The store handles a closed Pipeline-B ingestor factory needs. Boot builds
 * these and hands them to the platform's `buildEpisodeIngestors` factory so the
 * real ingestors run against the SAME store graph the routes use. Open default:
 * the factory is absent → no-op ingestors (dreaming still runs on memoryStore).
 */
export interface EpisodeIngestorDeps {
  provider: LLMProvider
  crmStore: ReturnType<typeof createDbCrmStore>
  entitiesStore: ReturnType<typeof createDbEntitiesStore>
  entityLinksStore: ReturnType<typeof createDbEntityLinksStore>
  memoryStore: ReturnType<typeof createDbMemoryStore>
  taskStore: ReturnType<typeof createDbTaskStore>
  episodesStore: ReturnType<typeof createDbEpisodesStore>
  analytics: AnalyticsLogger
}

/**
 * The closed seams `bootOpenApi` accepts. ALL optional — every field has a
 * safe default applied inside boot, so an open entry passing `{}` (or omitting
 * `ports`) boots a fully-functional single-player API with billing/feed/
 * connectors absent.
 */
export interface OpenApiPorts {
  // ── Billing — open default: allow-all / no-op ──
  /** Real DB credit gate; default allows every turn. */
  checkCreditBudget?: CreditBudgetGate
  /** Real DB usage recorder; default no-op (covers consolidation + chat). */
  usageStore?: UsageStore

  // ── Feed/distribution host hooks — open default: inert ──
  injectExtraTools?: InjectExtraTools
  resolveExtraSystemPrompt?: (session: { mode: string | null; channelType: string }) => string | null
  resolveAppSoul?: ResolveAppSoul

  // ── Connector-action audit — open default: unset (un-audited) ──
  buildConnectorActionAudit?: BuildConnectorActionAudit

  // ── Episode ingest (Pipeline B/C) — open default: no-op ──
  /**
   * Factory the platform supplies to build the real Pipeline-B ingestors over
   * boot's store graph. Absent (open) → chat compaction + brain MCP ingest are
   * no-ops. Both ingestors share the same deps.
   */
  buildEpisodeIngestors?: (deps: EpisodeIngestorDeps) => {
    chatEpisodeIngestor: ChatEpisodeIngestor
    brainEpisodeIngestor: BrainEpisodeIngestor
  }

  // ── Chat draft-title helpers — open default: passthrough ──
  isPlaceholderTitle?: (title: string | null | undefined) => boolean
  getTitleChannelPrefix?: (title: string | null | undefined) => string | null

  // ── Closed stores fronted as ports — open default: undefined (routes guard) ──
  /** Self-heal candidate queue; absent → reclassification + self-heal worker off. */
  brainCandidateStore?: BrainCandidateStore
  /** Closed pending-classification queue; absent → self-heal worker stays off. */
  pendingClassificationStore?: PendingClassificationStore
  /** Google-Drive knowledge-file store; absent → gdrive files unavailable to chat/workflow. */
  gdriveFilesStore?: GDriveFilesStore

  // ── Direct file ingest — open default: unset (no /api/files/ingest) ──
  /**
   * Builds the closed FileIngestor over boot's FilesApi + the platform's brain
   * ingestor (boot passes the one it built via `buildEpisodeIngestors`).
   * Open default: unset → fileRoutes mounts without an ingest seam.
   */
  buildFileIngestor?: (deps: {
    filesApi: ReturnType<typeof createFilesApi>
    brainEpisodeIngestor: BrainEpisodeIngestor
    distill: (input: { buffer: Buffer; mime: string }) => Promise<string>
  }) => unknown

  // ── Closed first-party tool factories — open default: omitted ──
  /** Capability-gated triage/sentiment/analytics-query tools (platform-only). */
  buildClosedTools?: () => Tool[]

  // ── Brain-inspection tools — open default: none (needs closed store) ──
  inspectionTools?: Record<string, Tool>

  // ── Bug-report tool create — open default: synthetic id no-op ──
  createBugReport?: (params: {
    assistantId: string
    userId: string
    sessionId?: string
    channelType: string
    channelId?: string
    title: string
    description?: string
    severity?: string
  }) => Promise<{ id: string }>

  // ── Extension hook: the platform mounts its closed routes/workers ──
  mountExtraRoutes?: (app: Express, ctx: BootContext) => void | Promise<void>
}

export interface BootOpenApiOptions {
  env: OpenApiEnv
  ports?: OpenApiPorts
  /** Default true; gates the background workers (consolidation, pollers, …). */
  runWorkers?: boolean
}

/**
 * The built open singletons. The platform wires its closed routes against
 * these SAME instances so both entries share one store graph. Add a field here
 * whenever a closed route needs a store the open boot already built.
 */
export interface BootContext {
  app: Express
  provider: LLMProvider
  allTools: Map<string, Tool>
  analytics: AnalyticsLogger
  env: OpenApiEnv
  runWorkers: boolean
  port: number
  // Stores closed routes reuse (same instances).
  workspaceStore: ReturnType<typeof createWorkspaceStore>
  workspaceAuditStore: ReturnType<typeof createWorkspaceAuditStore>
  memoryStore: ReturnType<typeof createDbMemoryStore>
  entitiesStore: ReturnType<typeof createDbEntitiesStore>
  entityLinksStore: ReturnType<typeof createDbEntityLinksStore>
  episodesStore: ReturnType<typeof createDbEpisodesStore>
  crmStore: ReturnType<typeof createDbCrmStore>
  taskStore: ReturnType<typeof createDbTaskStore>
  connectorStore: ReturnType<typeof createDbConnectorStore>
  connectorInstanceStore: ReturnType<typeof createConnectorInstanceStore>
  mcpSettingsStore: ReturnType<typeof createDbMcpSettingsStore>
  assistantConnectorStore: ReturnType<typeof createDbAssistantConnectorStore>
  assistantConnectorGrantsStore: ReturnType<typeof createDbAssistantConnectorGrantsStore>
  connectorGrantStore: Awaited<ReturnType<typeof import('./db/connector-grant-store.js').createConnectorGrantStore>>
  connectorActionStore: ReturnType<typeof createDbConnectorActionStore>
  workspaceFilesStore: ReturnType<typeof createDbWorkspaceFilesStore>
  knowledgeStore: ReturnType<typeof createDbKnowledgeStore>
  capabilityStore: ReturnType<typeof createDbCapabilityStore>
  apiKeyStore: ReturnType<typeof createDbApiKeyStore>
  usageStore: UsageStore | undefined
  workspaceStoreRefForRouter: ReturnType<typeof workspaceRoutes>
  workflowStore: ReturnType<typeof createDbWorkflowStore>
  workflowRunStore: ReturnType<typeof createDbWorkflowRunStore>
  workflowExecutorDeps: WorkflowExecutorDeps
  pendingMessageStore: ReturnType<typeof createPendingMessageStore>
  deferredConfirmationStore: ReturnType<typeof createDeferredConfirmationStore>
  chatConfirmationStore: ReturnType<typeof createChatConfirmationStore>
  snapshotStore: ReturnType<typeof createSnapshotStore>
  snapshotGenerator: ReturnType<typeof createSnapshotGenerator>
  episodicStore: ReturnType<typeof createDbEpisodicStore>
  sessionStateStore: ReturnType<typeof createDbSessionStateStore>
  workerManager: ReturnType<typeof createWorkerManager>
  workerRunsStore: ReturnType<typeof createDbWorkerRunsStore>
  skillStore: ReturnType<typeof createDbSkillStore>
  communitySkillRegistry: ReturnType<typeof loadSkillRegistry>
  jobStore: ReturnType<typeof createDbJobStore>
  linkedAccountStore: ReturnType<typeof createDbLinkedAccountStore>
  linkCodeStore: ReturnType<typeof createDbLinkCodeStore>
  integrationStore: ReturnType<typeof createDbChannelIntegrationStore> | null
  ingestRulesStore: unknown
  gdriveFilesStore: GDriveFilesStore | undefined
  filesApi: ReturnType<typeof createFilesApi> | null
  entityKindClassifier: ReturnType<typeof createEntityKindClassifier>
  workflowEventDispatcher: unknown
  voiceTranscription: { enabled: boolean; apiKey: string; model: string | undefined }
  resolvePrimaryAssistantForWorkspace: (workspaceId: string) => Promise<string | null>
  resolveDataRequest: (messageId: string, decision: 'approved' | 'rejected') => Promise<void>
  emailAuth: EmailAuth | undefined
  approvalBridgeDeps: ApprovalBridgeDeps
}

type EmailAuth = {
  magicLinkStore: ReturnType<typeof createDbMagicLinkStore>
  smtpClient: ReturnType<typeof createSmtpClient>
  appUrl: string
} | undefined

export interface BootResult {
  app: Express
  ctx: BootContext
  start(): Promise<{ server: http.Server; port: number }>
  shutdown(): Promise<void>
}

// Note on safe-default ports: every consumer of `usageStore` in the open code
// guards `if (usageStore)` (chat, public-api, executor, the consolidation +
// skill-review callModel paths), so leaving the port `undefined` is the correct
// no-op default — no synthetic UsageStore needed. Other ports default at their
// use sites (allow-all credit gate, passthrough title helpers, inert feed hooks).

// ════════════════════════════════════════════════════════════════════
// bootOpenApi
// ════════════════════════════════════════════════════════════════════

export async function bootOpenApi(opts: BootOpenApiOptions): Promise<BootResult> {
  const env = opts.env
  const ports = opts.ports ?? {}
  const runWorkers = opts.runWorkers ?? true

  if (!env.JWT_SECRET) {
    throw new Error('[boot] JWT_SECRET is required to run this service.')
  }

  const app = express()
  const port = parseInt(env.PORT || new URL(env.API_URL).port || '4000')

  // ── Middleware: raw-body capture + JSON ──
  app.use(express.json({
    verify: (req, _res, buf) => {
      ;(req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8')
    },
  }))

  // ── CORS ──
  const allowedOrigins = new Set([env.APP_URL, env.FEED_URL, env.AUTHED_APP_URL].filter(Boolean) as string[])
  app.use((req, res, next) => {
    const origin = req.headers.origin
    if (origin && allowedOrigins.has(origin)) {
      res.header('Access-Control-Allow-Origin', origin)
      res.header('Vary', 'Origin')
    }
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Timezone')
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    if (req.method === 'OPTIONS') { res.sendStatus(204); return }
    next()
  })

  // ── Client timezone capture ──
  app.use(attachClientTimezone())

  // ── Rate limiting (600 req/60s per actor; bypassed in dev) ──
  if (env.NODE_ENV !== 'development') {
    const rateLimiter = createRateLimiter({ maxRequests: 600 })
    app.use((req, res, next) => {
      rateLimiter.middleware(req, res, next, (r) => {
        const auth = r.headers['authorization']
        const header = Array.isArray(auth) ? auth[0] : auth
        if (header && header.startsWith('Bearer ')) return `u:${header.slice(7)}`
        const forwarded = r.headers['x-forwarded-for']
        const forwardedHead = Array.isArray(forwarded) ? forwarded[0] : forwarded
        return `ip:${r.ip ?? forwardedHead?.split(',')[0]?.trim() ?? 'unknown'}`
      })
    })
  }

  // ── Unicode sanitization on all incoming JSON bodies ──
  app.use((req, _res, next) => {
    if (req.body && typeof req.body === 'object') {
      req.body = sanitizeDeep(req.body)
    }
    next()
  })

  // ── Health check ──
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  // ════════════════════════════════════════════════════════════════
  // Shared infrastructure + stores
  // ════════════════════════════════════════════════════════════════
  const voiceTranscription = {
    enabled: env.VOICE_TRANSCRIPTION_ENABLED ?? false,
    apiKey: env.GEMINI_API_KEY,
    model: env.VOICE_TRANSCRIPTION_MODEL,
  }
  const memoryStore = createDbMemoryStore()
  const brainCandidateStore = ports.brainCandidateStore
  const memoryRecallEventsStore = createMemoryRecallEventsStore()
  const taskStore = createDbTaskStore()
  const crmStore = createDbCrmStore()
  const workspaceFilesStore = createDbWorkspaceFilesStore()
  const workflowStore = createDbWorkflowStore()
  const workflowRunStore = createDbWorkflowRunStore()
  const pendingApprovalsStore = createPendingApprovalsStore()
  const savedViewStore = createDbSavedViewStore()
  const homeDockStore = createDbHomeDockStore()
  const docEntityStore = createDbDocEntityStore()
  const pageGrantStore = createDbPageGrantStore()
  const workspaceGroupStore = createDbWorkspaceGroupStore()
  const docThemesStore = createDbDocThemesStore()
  const episodicStore = createDbEpisodicStore()
  const entityLinksStore = createDbEntityLinksStore()
  const entitiesStore = createDbEntitiesStore({ entityLinks: entityLinksStore })
  const episodesStore = createDbEpisodesStore()
  const connectorActionStore = createDbConnectorActionStore()
  const retrievalStore = composeRetrievalStore({
    entityStore: entitiesStore,
    searchEpisodes: createDbRetrievalStore({
      embedder: createGeminiEmbedder(env.GEMINI_API_KEY),
    }),
    provenance: createDbProvenanceStore(),
    aggregate: createDbAggregateStore(),
    markUseful: createDbMarkUsefulStore(),
    rowHistory: createDbRowHistoryStore(),
  })

  const retrievalMissStore = createDbRetrievalMissStore()
  const kbGapCandidateStore = createDbKbGapCandidateStore()
  const _detectorEmbedder = createGeminiEmbedder(env.GEMINI_API_KEY)
  const retrievalMissDetector = createRetrievalMissDetector({
    retrievalMissStore,
    getEmbedding: async (text) => {
      const [vec] = await _detectorEmbedder.embed([text])
      return vec ?? []
    },
  })
  const sessionStateStore = createDbSessionStateStore()
  const planStore = createDbPlanStore()
  const cacheStore = createDbCacheStore()
  const fileStore = createDbFileStore()
  const usageStore = ports.usageStore
  const analyticsStore = createDbAnalyticsStore()
  const analytics = new AnalyticsLogger(analyticsStore)

  // ── LLM provider stack ──
  const geminiProvider = wrapProvider(createGeminiProvider(env.GEMINI_API_KEY))
  const provider: LLMProvider = (() => {
    if (!env.FALLBACK_PROVIDER_ENABLED) return geminiProvider
    if (!env.ANTHROPIC_API_KEY) {
      console.warn('[provider] FALLBACK_PROVIDER_ENABLED=true but ANTHROPIC_API_KEY is empty — running bare Gemini.')
      return geminiProvider
    }
    const anthropicProvider = wrapProvider(createAnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY }))
    return wrapFallback(geminiProvider, anthropicProvider, {
      fallbackModel: 'claude-haiku-4-5',
      analytics: {
        onFallback({ primaryModel, fallbackModel, errorKind, errorStatus }) {
          analytics.logEvent({
            userId: 'system',
            eventName: 'llm_provider_fallback',
            metadata: {
              primary_model: sanitizeAnalytics(primaryModel),
              fallback_model: sanitizeAnalytics(fallbackModel),
              error_kind: sanitizeAnalytics(errorKind),
              error_status: errorStatus ?? undefined,
            },
          })
        },
      },
    })
  })()

  const jobStore = createDbJobStore()
  const sessionResumeStore = createDbSessionResumeStore()
  const workerRunsStore = createDbWorkerRunsStore()
  const capabilityStore = createDbCapabilityStore()
  const mcpSettingsStore = createDbMcpSettingsStore()
  const credKey = env.CHANNEL_CREDENTIAL_KEY ? loadChannelCredentialKey(env.CHANNEL_CREDENTIAL_KEY) : null
  const connectorInstanceStore = createConnectorInstanceStore(credKey)
  // Ingest-rules store is closed (Studio ▸ Ingestion control plane lives in the
  // platform). Carried on ctx as `unknown` for closed routes; open never reads.
  const ingestRulesStore: unknown = undefined
  const connectorStore = createDbConnectorStore(credKey)
  const assistantConnectorStore = createDbAssistantConnectorStore()
  const assistantConnectorGrantsStore = createDbAssistantConnectorGrantsStore()
  const skillStore = createDbSkillStore()
  let recomputeSkillEdgesOnWrite: ((skill: WorkspaceSkill) => void) | undefined
  const workspaceSkillStore = createDbWorkspaceSkillStore({
    onWritten: (skill) => recomputeSkillEdgesOnWrite?.(skill),
  })
  recomputeSkillEdgesOnWrite = makeSkillEdgeRecomputer({
    entityLinks: entityLinksStore,
    connectorInstanceStore,
    workspaceSkillStore,
  })
  const workspaceSkillFilesStore = createDbWorkspaceSkillFilesStore()
  const workspaceSkillEnablementStore = createDbWorkspaceSkillEnablementStore()
  const skillCuratorDigestStore = createDbSkillCuratorDigestStore()
  const curatorEmbedder = createGeminiEmbedder(env.GEMINI_API_KEY)
  const skillReviewLeaseHolderId = randomUUID()
  const communitySkillRegistry = loadSkillRegistry()

  const integrationStore = credKey ? createDbChannelIntegrationStore(credKey) : null
  const apiKeyStore = createDbApiKeyStore()
  const brainKeyStore = createDbBrainKeyStore()
  const llmProviderSettingsStore = (() => {
    if (!env.LLM_PROVIDER_KEY_ENCRYPTION_KEY) return null
    try {
      return createDbWorkspaceLlmProviderSettingsStore(
        loadLlmProviderKeyEncryptionKey(env.LLM_PROVIDER_KEY_ENCRYPTION_KEY),
      )
    } catch (err) {
      console.warn('[provider] LLM_PROVIDER_KEY_ENCRYPTION_KEY invalid — BYO Gemini keys disabled:', (err as Error).message)
      return null
    }
  })()
  const compartmentStore = createDbCompartmentStore()
  const oauthClientStore = createDbOAuthClientStore()
  const oauthAuthorizationStore = createDbOAuthAuthorizationStore()
  const desktopAuthStore = createDbDesktopAuthStore()
  const shadowClaimStore = createShadowClaimStore()

  const channelRouteStore = createChannelRouteStore()
  const linkedAccountStore = createDbLinkedAccountStore()
  const linkCodeStore = createDbLinkCodeStore()

  // Telegram-linked notify + bot-username memo (only with a bot token).
  const telegramBotTokenForNotify = env.TELEGRAM_BOT_TOKEN
  const notifyTelegramLinked = telegramBotTokenForNotify
    ? async (chatId: string, firstName: string | null) => {
        const api = createTelegramApi({ token: telegramBotTokenForNotify })
        const greeting = firstName ? ` ${firstName}` : ''
        await api.sendMessage(chatId, `You're linked${greeting}. Send me a message any time to get started.`)
      }
    : undefined
  let officialBotUsernamePromise: Promise<string | null> | undefined
  const getTelegramBotUsername = (): Promise<string | null> => {
    const token = env.TELEGRAM_BOT_TOKEN
    if (!token) return Promise.resolve(null)
    if (!officialBotUsernamePromise) {
      officialBotUsernamePromise = createTelegramApi({ token })
        .getMe()
        .then((me) => me.username || null)
        .catch((err) => {
          console.warn('[account] official bot getMe failed:', err)
          officialBotUsernamePromise = undefined
          return null
        })
    }
    return officialBotUsernamePromise
  }

  const emailAuth: EmailAuth =
    env.GMAIL_SMTP_USER && env.GMAIL_SMTP_APP_PASSWORD && env.EMAIL_FROM_ADDRESS
      ? {
          magicLinkStore: createDbMagicLinkStore(),
          smtpClient: createSmtpClient({
            transport: createWorkspaceSmtpTransport({
              user: env.GMAIL_SMTP_USER,
              appPassword: env.GMAIL_SMTP_APP_PASSWORD,
            }),
            fromAddress: env.EMAIL_FROM_ADDRESS,
          }),
          appUrl: env.APP_URL,
        }
      : undefined

  // ── Auth routes ──
  app.use(
    '/auth',
    authRoutes(
      env.JWT_SECRET,
      env.GOOGLE_CLIENT_ID ?? '',
      linkedAccountStore,
      notifyTelegramLinked,
      shadowClaimStore,
      apiKeyStore,
      emailAuth,
      desktopAuthStore,
    ),
  )

  if (isLocalDevEnv()) {
    app.use('/auth', devAuthRoutes({ jwtSecret: env.JWT_SECRET }))
    console.warn('[dev-auth] LOCAL /auth/dev-login enabled — debug-only bypass.')
  }

  const { createConnectorGrantStore } = await import('./db/connector-grant-store.js')
  const connectorGrantStore = createConnectorGrantStore()
  const workspaceStore = createWorkspaceStore({ connectorGrantStore, channelRouteStore })

  const workspaceDirectoryStore: WorkspaceDirectoryStore = {
    async listMembers(userId, workspaceId) {
      const membership = await workspaceStore.getMembership(userId, workspaceId)
      if (!membership) return []
      const members = await workspaceStore.listMembers(userId, workspaceId)
      return members.map((m) => ({
        memberId: m.id, name: m.userName ?? null, email: m.email ?? null,
        avatarUrl: m.avatarUrl ?? null, role: m.role,
      }))
    },
    async get(workspaceId, memberId) {
      const map = await workspaceDirectoryStore.batchGet(workspaceId, [memberId])
      return map.get(memberId) ?? null
    },
    async batchGet(workspaceId, memberIds) {
      if (memberIds.length === 0) return new Map()
      const members = await workspaceStore.listMembers('', workspaceId)
      const requested = new Set(memberIds)
      const out = new Map<string, WorkspaceMemberInfo>()
      for (const m of members) {
        if (!requested.has(m.id)) continue
        out.set(m.id, {
          memberId: m.id, name: m.userName ?? null, email: m.email ?? null,
          avatarUrl: m.avatarUrl ?? null, role: m.role,
        })
      }
      return out
    },
  }

  const workspaceAuditStore = createWorkspaceAuditStore()
  const connectionStore = createConnectionStore()
  const pendingMessageStore = createPendingMessageStore()
  const chatConfirmationStore = createChatConfirmationStore()
  const deferredConfirmationStore = createDeferredConfirmationStore()
  const snapshotStore = createSnapshotStore()
  const knowledgeStore = createDbKnowledgeStore()
  // gdriveFilesStore is closed (api-platform) and arrives via the port. Open
  // passes undefined; the open chat / executor / brain-mcp deps accept it as
  // optional.
  const gdriveFilesStore = ports.gdriveFilesStore
  let syncWorkerRef: { tick(): Promise<void> } | null = null

  // ════════════════════════════════════════════════════════════════
  // Tool set
  // ════════════════════════════════════════════════════════════════
  let workerManager!: ReturnType<typeof createWorkerManager>

  function buildAllTools(): Map<string, Tool> {
    const tools = createBaseTools()

    workerManager = createWorkerManager({
      provider,
      model: 'gemini-flash',
      tools: new Map([...tools].filter(([_, t]) => t.isReadOnly)),
    })
    const { spawnWorker, sendWorkerMessage, stopWorker } = createWorkerTools(workerManager)
    tools.set('spawnWorker', spawnWorker)
    tools.set('sendWorkerMessage', sendWorkerMessage)
    tools.set('stopWorker', stopWorker)

    const { createScheduledJob, updateScheduledJob, searchScheduledJobs, deleteScheduledJob } = createSchedulingTools({
      jobStore,
      workflowStore,
      provider,
      resolveDeliveryTarget: createDeliveryTargetResolver(integrationStore ?? undefined),
      deliverToChannel: createWorkflowChannelDelivery({
        integrationStore: integrationStore ?? undefined,
        defaultTelegramBotToken: env.TELEGRAM_BOT_TOKEN,
        waConnectorUrl: env.WA_CONNECTOR_URL,
        waConnectorSecret: env.WA_CONNECTOR_SECRET,
      }),
      resolveViewWorkspace: async ({ userId, viewId }) =>
        (await savedViewStore.getById(userId, viewId))?.workspaceId ?? null,
    })
    tools.set('createScheduledJob', createScheduledJob)
    tools.set('updateScheduledJob', updateScheduledJob)
    tools.set('searchScheduledJobs', searchScheduledJobs)
    tools.set('deleteScheduledJob', deleteScheduledJob)

    tools.set('retrieveCachedResults', createCacheTool(cacheStore))
    tools.set('readFileContent', createReadFileTool(fileStore))

    // Bug report tool — the create sink is a port; open default returns a
    // synthetic id (no persistence). The platform injects its bug-report store.
    const reportBugTool = createReportBugTool({
      create: ports.createBugReport ?? (async () => ({ id: randomUUID() })),
    })
    tools.set('reportBug', reportBugTool)

    // Closed capability-gated tools (triage / product-sentiment / analytics-query).
    // Open omits them; the platform injects via buildClosedTools.
    if (ports.buildClosedTools) {
      for (const tool of ports.buildClosedTools()) tools.set(tool.name, tool)
    }

    return tools
  }

  const allTools = buildAllTools()

  // ── Episode ingestors — built by the platform factory over boot's stores
  //    (open default: no-op chat ingest, undefined brain ingest). ──
  const builtIngestors = ports.buildEpisodeIngestors?.({
    provider, crmStore, entitiesStore, entityLinksStore, memoryStore, taskStore, episodesStore, analytics,
  })
  const chatEpisodeIngestor: ChatEpisodeIngestor =
    builtIngestors?.chatEpisodeIngestor ?? (async () => {})
  const brainEpisodeIngestor: BrainEpisodeIngestor | undefined = builtIngestors?.brainEpisodeIngestor

  const calleeExecutor = createCalleeExecutor({
    provider,
    tools: allTools,
    memoryStore,
    connectorStore,
    mcpSettingsStore,
    assistantConnectorStore,
    connectorGrantStore,
    connectorInstanceStore,
    knowledgeStore,
    gdriveFilesStore,
    capabilityStore,
    episodicStore,
    analytics,
    usageStore,
    chatEpisodeIngestor,
    deferredConfirmationStore,
    integrationStore: integrationStore ?? undefined,
    defaultTelegramBotToken: env.TELEGRAM_BOT_TOKEN,
    waConnectorUrl: env.WA_CONNECTOR_URL,
    waConnectorSecret: env.WA_CONNECTOR_SECRET,
    injectExtraTools: ports.injectExtraTools,
    resolveAppSoul: ports.resolveAppSoul,
    savedViewStore,
  })

  const { createAssistantModesStore } = await import('./db/assistant-modes-store.js')
  const assistantModesStore = createAssistantModesStore()

  const { createInProcessTransport } = await import('@sidanclaw/core')
  const consultTransport = createInProcessTransport({
    getConnectionModeId: (caller, callee) => connectionStore.getConnectionModeId(caller, callee),
    getMode: (modeId) => assistantModesStore.get(modeId),
    runConsult: async ({ request, mode }) => {
      if (mode?.requireApproval) {
        const targetUserId = await findAssistantById(request.target.assistantId).then((a) => a?.ownerUserId ?? null)
        if (targetUserId) {
          const questionText = request.message.parts
            .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
            .map((p) => p.text)
            .join(' ')
          await pendingMessageStore.create({
            targetAssistantId: request.target.assistantId,
            targetUserId,
            sourceAssistantId: request.caller.assistantId,
            messageType: 'ask_confirmation',
            category: undefined,
            payload: {
              question: questionText,
              callerAssistantId: request.caller.assistantId,
              callerSessionId: '',
              callerChannelType: request.caller.channelType,
              callerChannelId: undefined,
              freshness: mode.freshness,
              modeId: mode.id,
            },
          })
        }
        return { text: '', inputRequired: true }
      }
      const text = await calleeExecutor({
        callerAssistantId: request.caller.assistantId,
        calleeAssistantId: request.target.assistantId,
        mode,
        question: request.message.parts
          .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
          .map((p) => p.text)
          .join(' '),
        callerSessionId: '',
        sessionKey: request.contextId,
        allowedTools: request.allowedTools,
        depth: request.depth,
        modelAlias: request.modelAlias,
        deliverTarget: request.deliver,
        pageAnchorId: request.pageAnchorId,
        callerChannelType: request.caller.channelType,
      })
      return { text }
    },
  })

  const snapshotGenerator = createSnapshotGenerator({ snapshotStore })

  const interAssistantTools = createInterAssistantTools({
    isFollowing: (follower, following) => connectionStore.isFollowing(follower, following),
    getFollowing: async (id) => {
      const conns = await connectionStore.getFollowing(id)
      return Promise.all(conns.map(async (c) => {
        let mode: { id: string; name: string; description: string | null; requireApproval: boolean } | null = null
        if (c.modeId) {
          const m = await assistantModesStore.get(c.modeId)
          if (m) mode = { id: m.id, name: m.name, description: m.description, requireApproval: m.requireApproval }
        }
        const followingAssistant = await findAssistantById(c.followingAssistantId)
        return {
          followingAssistantId: c.followingAssistantId,
          followingWorkspaceId: followingAssistant?.workspaceId ?? '',
          followingAssistantName: c.followingAssistantName,
          followingOwnerHandle: c.followingOwnerHandle,
          followingBio: c.followingBio,
          followingAppType: followingAssistant?.appType ?? null,
          origin: c.origin,
          callerNote: c.callerNote,
          mode,
        }
      }))
    },
    consultTransport,
    getSnapshot: (id, cat) => snapshotStore.getPublished(id, cat),
    generateAndPublishSnapshot: async (assistantId, userId, category) =>
      snapshotGenerator(assistantId, userId, category),
  })
  for (const tool of interAssistantTools) allTools.set(tool.name, tool)

  // ── Workflow tools ──
  async function resolvePrimaryAssistantForWorkspace(workspaceId: string): Promise<string | null> {
    const result = await query<{ id: string }>(
      `SELECT id FROM assistants WHERE workspace_id = $1 AND kind = 'primary' LIMIT 1`,
      [workspaceId],
    )
    return result.rows[0]?.id ?? null
  }

  const workflowExecutorDeps: WorkflowExecutorDeps = {
    workflowStore,
    runStore: workflowRunStore,
    consultTransport,
    resolvePrimary: resolvePrimaryAssistantForWorkspace,
    buildToolRegistry: ({ workspaceId, assistantId, userId }) => buildWorkflowToolRegistry(
      {
        firstParty: allTools,
        connectorStore,
        settingsStore: mcpSettingsStore,
        assistantConnectorStore,
        connectorGrantStore,
        connectorInstanceStore,
        knowledgeStore,
        gdriveFilesStore,
      },
      { workspaceId, assistantId, userId },
    ),
    pauseRunForWait: async ({ runId, stepRunId, workspaceId, triggeredBy, dueAt }) => {
      const primary = await resolvePrimaryAssistantForWorkspace(workspaceId)
      if (!primary) throw new Error(`pauseRunForWait: no primary assistant for workspace ${workspaceId}`)
      await jobStore.create({
        assistantId: primary,
        userId: triggeredBy ?? primary,
        schedule: {
          type: 'once',
          datetime: new Date(dueAt.getTime() - dueAt.getTimezoneOffset() * 60_000)
            .toISOString().slice(0, 19),
        },
        timezone: 'UTC',
        mode: 'local',
        instructions: JSON.stringify({ kind: 'workflow_wait_resume', runId, stepRunId }),
        channelType: 'workflow',
        channelId: runId,
        nextRunAt: dueAt,
        workflowId: (await workflowRunStore.getRunSystem(runId))?.workflowId ?? '',
        workflowStepRunId: stepRunId,
      })
    },
    emitAudit: async (event) => {
      const details: Record<string, unknown> = {}
      if (event.type === 'workflow.run_started') {
        details.workflowId = event.workflowId; details.name = event.workflowName; details.trigger = event.trigger
      } else if (event.type === 'workflow.run_completed') {
        details.workflowId = event.workflowId; details.name = event.workflowName
        details.stepCount = event.stepCount; details.durationMs = event.durationMs
      } else if (event.type === 'workflow.run_failed') {
        details.workflowId = event.workflowId; details.name = event.workflowName
        details.stepId = event.stepId; details.error = event.error
      } else if (event.type === 'workflow.auto_disabled') {
        details.workflowId = event.workflowId; details.name = event.workflowName
        details.reason = event.reason; details.streak = event.streak
      } else if (event.type === 'workflow.step_delivered') {
        details.workflowId = event.workflowId; details.stepId = event.stepId; details.delivery = event.delivery
      }
      await workspaceAuditStore.append({
        workspaceId: event.workspaceId, actorUserId: event.actorUserId,
        eventType: event.type, subjectId: event.runId, details,
      })
    },
    deliverToChannel: createWorkflowChannelDelivery({
      integrationStore: integrationStore ?? undefined,
      defaultTelegramBotToken: env.TELEGRAM_BOT_TOKEN,
      waConnectorUrl: env.WA_CONNECTOR_URL,
      waConnectorSecret: env.WA_CONNECTOR_SECRET,
    }),
    createAnchorPage: async ({ workspaceId, userId, title, nestUnder, originPrompt }) => {
      const draft = await savedViewStore.createDraft({
        userId, workspaceId, name: title, nameOrigin: 'user',
        entity: 'tasks', viewType: 'table',
        binding: { entity: 'tasks', viewType: 'table' },
        page: { blocks: [] },
        nestParentId: nestUnder ?? null,
        originPrompt: originPrompt ?? null,
      })
      await savedViewStore.setState(userId, draft.id, 'saved')
      return { id: draft.id }
    },
  }

  const approvalDeliveries = createApprovalDeliveryDispatcher({
    webBaseUrl: env.APP_URL,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
  })

  const approvalBridgeDeps: ApprovalBridgeDeps = {
    approvalsStore: pendingApprovalsStore,
    auditStore: workspaceAuditStore,
    workflowStore,
    runStore: workflowRunStore,
    buildToolRegistry: workflowExecutorDeps.buildToolRegistry,
    resolvePrimary: workflowExecutorDeps.resolvePrimary,
    deliveries: approvalDeliveries,
    executorDeps: workflowExecutorDeps,
  }
  workflowExecutorDeps.requestApproval = makeRequestApproval(approvalBridgeDeps)

  const {
    proposeWorkflow, createWorkflow: createWorkflowTool, updateWorkflow,
    getWorkflow, runWorkflow, listWorkflows, getWorkflowRun,
  } = createWorkflowTools({
    workflowStore,
    runStore: workflowRunStore,
    executorDeps: workflowExecutorDeps,
    resolvePageAnchor: async (userId, pageId) => {
      const view = await savedViewStore.getById(userId, pageId)
      return view ? { workspaceId: view.workspaceId, state: view.state, name: view.name } : null
    },
    listTriggerJobs: (workflowId) => jobStore.listTriggerJobsForWorkflowSystem(workflowId),
    isKnownTool: (name) => allTools.has(name),
    jobStore,
    resolvePrimary: resolvePrimaryAssistantForWorkspace,
    resolveDeliveryTarget: createDeliveryTargetResolver(integrationStore ?? undefined),
    deliverToChannel: createWorkflowChannelDelivery({
      integrationStore: integrationStore ?? undefined,
      defaultTelegramBotToken: env.TELEGRAM_BOT_TOKEN,
      waConnectorUrl: env.WA_CONNECTOR_URL,
      waConnectorSecret: env.WA_CONNECTOR_SECRET,
    }),
    resolveViewWorkspace: async ({ userId, viewId }) =>
      (await savedViewStore.getById(userId, viewId))?.workspaceId ?? null,
    onEvent: (event) => {
      if (event.type === 'workflow_created' || event.type === 'workflow_updated') {
        workspaceAuditStore.append({
          workspaceId: event.workspaceId,
          actorUserId: event.userId,
          eventType: event.type === 'workflow_created' ? 'workflow.created' : 'workflow.updated',
          subjectId: event.workflowId,
          details: { name: event.name },
        }).catch(() => {})
      }
    },
  })

  allTools.set('proposeWorkflow', proposeWorkflow)
  allTools.set('createWorkflow', createWorkflowTool)
  allTools.set('updateWorkflow', updateWorkflow)
  allTools.set('getWorkflow', getWorkflow)
  allTools.set('runWorkflow', runWorkflow)
  allTools.set('listWorkflows', listWorkflows)
  allTools.set('getWorkflowRun', getWorkflowRun)

  allTools.set('findPage', createFindPageTool({ savedViewStore, docPageStore: createDbDocPageStore() }))

  // Ingest-rule edit tools are closed (the editor store lives in api-platform).
  // The open build omits them; the platform re-registers via buildClosedTools or
  // a post-boot injection if needed. The chat surface still functions without.

  const entityKindClassifier = createEntityKindClassifier()

  for (const brainTool of createWorkflowBrainTools({
    entities: entitiesStore,
    entityLinks: entityLinksStore,
    memories: { supersedeByTags: supersedeMemoriesByTags },
    entityKindClassifier,
  })) {
    allTools.set(brainTool.name, brainTool)
  }

  for (const correctionTool of createCorrectionTools({
    retraction: createMemoryRetractionStore(),
    softDelete: createSoftDeleteStore(),
    reclassify: createSensitivityReclassificationStore(),
    resolveWorkspaceRole: (userId, workspaceId) => workspaceStore.getRole(userId, workspaceId),
  })) {
    allTools.set(correctionTool.name, correctionTool)
  }

  // Self-healing reclassifier chat tools — only when a candidate store is wired
  // (closed). Open build omits them.
  if (brainCandidateStore) {
    for (const healingTool of createBrainHealingTools({
      candidates: brainCandidateStore,
      memories: memoryStore,
      entities: entitiesStore,
      entityLinks: entityLinksStore,
      tasks: taskStore,
      promotion: createMemoryToEntityPromotionStore(),
      entityMerge: { repo: createEntityMergeStore() },
      provider,
      reclassifierModel: 'gemini-flash',
    })) {
      allTools.set(healingTool.name, healingTool)
    }
  }

  const scheduleWorkflow = createScheduleWorkflowTool({
    workflowStore, jobStore, resolvePrimary: resolvePrimaryAssistantForWorkspace,
  })
  allTools.set('scheduleWorkflow', scheduleWorkflow)

  const { renderView, saveView } = createViewTools({
    taskStore, crmStore, workflowRunStore,
    workspaceDirectory: workspaceDirectoryStore, savedViewStore,
  })
  allTools.set('renderView', renderView)
  allTools.set('saveView', saveView)

  // ── resolveDataRequest (inter-assistant approval resolution) ──
  async function resolveDataRequest(messageId: string, decision: 'approved' | 'rejected'): Promise<void> {
    const result = await query<{
      id: string
      targetAssistantId: string
      payload: { question?: string; callerAssistantId?: string; callerSessionId?: string; callerChannelType?: string; callerChannelId?: string; freshness?: string; modeId?: string }
      category: string | null
    }>(
      `UPDATE assistant_pending_messages
       SET status = 'resolved', resolution = $2, resolved_at = now()
       WHERE id = $1 AND status IN ('pending', 'delivered')
       RETURNING id, target_assistant_id AS "targetAssistantId", payload, category`,
      [messageId, decision],
    )
    const msg = result.rows[0]
    if (!msg) return

    if (decision === 'approved' && msg.payload.callerAssistantId) {
      const callerOwner = await query<{ ownerUserId: string }>(
        `SELECT owner_user_id AS "ownerUserId" FROM assistants WHERE id = $1`,
        [msg.payload.callerAssistantId],
      )
      if (callerOwner.rows[0]) {
        let responseText: string
        try {
          if (msg.payload.freshness === 'snapshot') {
            const snapshot = await snapshotStore.getPublished(msg.targetAssistantId, msg.category ?? '')
            if (snapshot) {
              responseText = JSON.stringify(snapshot.content)
              try {
                const { findOrCreateSession, addSessionMessage } = await import('./db/sessions.js')
                const auditSession = await findOrCreateSession({
                  assistantId: msg.targetAssistantId,
                  userId: callerOwner.rows[0].ownerUserId,
                  channelType: 'assistant-call',
                  channelId: `${msg.payload.callerAssistantId}:${Date.now()}`,
                })
                await addSessionMessage({ sessionId: auditSession.id, role: 'user', content: [{ type: 'text', text: msg.payload.question ?? '' }] })
                const formattedResponse = responseText.startsWith('{')
                  ? formatSnapshotResponse(responseText, msg.category)
                  : responseText
                await addSessionMessage({ sessionId: auditSession.id, role: 'assistant', content: [{ type: 'text', text: formattedResponse }] })
              } catch { /* audit logging is non-fatal */ }
            } else {
              const approvedMode = msg.payload.modeId ? await assistantModesStore.get(msg.payload.modeId) : null
              responseText = await calleeExecutor({
                callerAssistantId: msg.payload.callerAssistantId,
                calleeAssistantId: msg.targetAssistantId,
                mode: approvedMode,
                question: msg.payload.question ?? '',
                callerSessionId: msg.payload.callerSessionId ?? '',
              })
            }
          } else {
            const approvedMode = msg.payload.modeId ? await assistantModesStore.get(msg.payload.modeId) : null
            responseText = await calleeExecutor({
              callerAssistantId: msg.payload.callerAssistantId,
              calleeAssistantId: msg.targetAssistantId,
              mode: approvedMode,
              question: msg.payload.question ?? '',
              callerSessionId: msg.payload.callerSessionId ?? '',
            })
          }
        } catch (err) {
          console.error('[resolveDataRequest] callee execution failed:', err)
          responseText = `Failed to retrieve ${msg.category ?? 'data'}: ${err instanceof Error ? err.message : 'unknown error'}`
        }
        if (!responseText) responseText = 'The assistant did not produce a response.'

        await pendingMessageStore.create({
          targetAssistantId: msg.payload.callerAssistantId,
          targetUserId: callerOwner.rows[0].ownerUserId,
          sourceAssistantId: msg.targetAssistantId,
          messageType: 'async_response',
          category: msg.category ?? undefined,
          payload: { question: msg.payload.question, response: responseText },
        })

        const sourceName = await query<{ name: string }>(
          `SELECT name FROM assistants WHERE id = $1`,
          [msg.targetAssistantId],
        ).then((r) => r.rows[0]?.name ?? 'An assistant')

        const deliveryText = `${sourceName} approved your ${msg.category ?? 'data'} request. Here's what they shared:\n\n${
          responseText.startsWith('{') ? formatSnapshotResponse(responseText, msg.category) : responseText
        }`

        deliverToChannel({
          assistantId: msg.payload.callerAssistantId,
          userId: callerOwner.rows[0].ownerUserId,
          text: deliveryText,
          sessionId: msg.payload.callerSessionId,
          channelType: msg.payload.callerChannelType,
          channelId: msg.payload.callerChannelId,
          integrationStore: integrationStore ?? undefined,
          defaultTelegramBotToken: env.TELEGRAM_BOT_TOKEN,
          waConnectorUrl: env.WA_CONNECTOR_URL,
          waConnectorSecret: env.WA_CONNECTOR_SECRET,
        }).catch((err) => console.error('[resolveDataRequest] delivery failed:', err))
      }
    }
  }

  const reviewDataRequestTool = createReviewDataRequestTool({
    getPendingRequests: async (assistantId) => {
      const result = await query<{
        id: string
        sourceAssistantName: string | null
        sourceOwnerHandle: string | null
        category: string | null
        payload: { question?: string; draftResponse?: string }
      }>(
        `SELECT apm.id, sa.name AS "sourceAssistantName", su.handle AS "sourceOwnerHandle",
                apm.category, apm.payload
         FROM assistant_pending_messages apm
         JOIN assistants sa ON sa.id = apm.source_assistant_id
         JOIN users su ON su.id = sa.owner_user_id
         WHERE apm.target_assistant_id = $1
           AND apm.message_type = 'ask_confirmation'
           AND apm.status IN ('pending', 'delivered')
         ORDER BY apm.created_at DESC`,
        [assistantId],
      )
      return result.rows.map((r) => ({
        id: r.id,
        sourceAssistantName: r.sourceAssistantName ?? undefined,
        sourceOwnerHandle: r.sourceOwnerHandle ?? undefined,
        category: r.category,
        payload: r.payload,
      }))
    },
    resolveRequest: resolveDataRequest,
  })
  allTools.set('reviewDataRequest', reviewDataRequestTool)

  // ── Primitive tools (Tasks + CRM) ──
  const taskTools = createTaskTools(taskStore, {
    entityLinks: entityLinksStore,
    onEvent: (evt, ctx) => {
      const base = { userId: ctx.userId, assistantId: ctx.assistantId, sessionId: ctx.sessionId, channelType: ctx.channelType }
      if (evt.type === 'task_created') {
        analytics.logEvent({ ...base, eventName: 'task_created', metadata: { task_id: sanitizeAnalytics(evt.taskId) } })
      } else if (evt.type === 'task_updated') {
        analytics.logEvent({ ...base, eventName: 'task_updated', metadata: { task_id: sanitizeAnalytics(evt.taskId), fields: sanitizeAnalytics(evt.fields.join(',')) } })
      } else if (evt.type === 'task_listed') {
        analytics.logEvent({ ...base, eventName: 'task_listed', metadata: { result_count: evt.resultCount, hit: evt.resultCount > 0 } })
      }
    },
  })
  allTools.set('saveTask', taskTools.saveTask)
  allTools.set('getTask', taskTools.getTask)
  allTools.set('listTasks', taskTools.listTasks)
  allTools.set('updateTask', taskTools.updateTask)
  allTools.set('closeTask', taskTools.closeTask)
  allTools.set('reopenTask', taskTools.reopenTask)

  allTools.set('listWorkspaceMembers', createWorkspaceTools(workspaceDirectoryStore).listWorkspaceMembers)

  const crmTools = createCrmTools(crmStore, {
    entityLinks: entityLinksStore,
    entityKindClassifier,
    onEvent: (evt, ctx) => {
      const base = { userId: ctx.userId, assistantId: ctx.assistantId, sessionId: ctx.sessionId, channelType: ctx.channelType }
      if (evt.type === 'contact_created' || evt.type === 'company_created' || evt.type === 'deal_created') {
        const idKey = evt.type === 'contact_created' ? 'contact_id' : evt.type === 'company_created' ? 'company_id' : 'deal_id'
        const idValue = evt.type === 'contact_created' ? evt.contactId : evt.type === 'company_created' ? evt.companyId : evt.dealId
        analytics.logEvent({ ...base, eventName: evt.type, metadata: { [idKey]: sanitizeAnalytics(idValue) } })
      } else if (evt.type === 'contact_updated' || evt.type === 'company_updated' || evt.type === 'deal_updated') {
        const idKey = evt.type === 'contact_updated' ? 'contact_id' : evt.type === 'company_updated' ? 'company_id' : 'deal_id'
        const idValue = evt.type === 'contact_updated' ? evt.contactId : evt.type === 'company_updated' ? evt.companyId : evt.dealId
        analytics.logEvent({ ...base, eventName: evt.type, metadata: { [idKey]: sanitizeAnalytics(idValue), fields: sanitizeAnalytics(evt.fields.join(',')) } })
      } else if (evt.type === 'deal_stage_advanced') {
        analytics.logEvent({ ...base, eventName: 'deal_stage_advanced', metadata: { deal_id: sanitizeAnalytics(evt.dealId), stage: sanitizeAnalytics(evt.stage) } })
      } else if (evt.type === 'contact_listed' || evt.type === 'company_listed' || evt.type === 'deal_listed') {
        analytics.logEvent({ ...base, eventName: evt.type, metadata: { result_count: evt.resultCount, hit: evt.resultCount > 0 } })
      }
    },
  })
  allTools.set('saveContact', crmTools.saveContact)
  allTools.set('getContact', crmTools.getContact)
  allTools.set('listContacts', crmTools.listContacts)
  allTools.set('updateContact', crmTools.updateContact)
  allTools.set('saveCompany', crmTools.saveCompany)
  allTools.set('getCompany', crmTools.getCompany)
  allTools.set('listCompanies', crmTools.listCompanies)
  allTools.set('updateCompany', crmTools.updateCompany)
  allTools.set('saveDeal', crmTools.saveDeal)
  allTools.set('getDeal', crmTools.getDeal)
  allTools.set('listDeals', crmTools.listDeals)
  allTools.set('updateDeal', crmTools.updateDeal)
  allTools.set('advanceDealStage', crmTools.advanceDealStage)

  // ── Brain-MCP-dedicated tool instances ──
  const brainMemoryTools = createMemoryTools(memoryStore, { entityStore: entitiesStore, entityLinksStore })
  const brainRetrievalTools = createRetrievalTools(retrievalStore)

  // ── Workspace filesystem ──
  const LOCAL_FILES_DIR = join(tmpdir(), 'sidanclaw-files')
  const filesBlobClient = env.GCS_FILES_BUCKET
    ? createGcsFilesClient({ bucket: env.GCS_FILES_BUCKET, projectId: process.env.GOOGLE_CLOUD_PROJECT })
    : process.env.K_SERVICE
      ? null
      : createLocalFilesClient({ baseDir: LOCAL_FILES_DIR })
  if (filesBlobClient && !env.GCS_FILES_BUCKET) {
    console.warn(`[files] GCS_FILES_BUCKET unset — using local-disk file storage at ${LOCAL_FILES_DIR} (dev only).`)
  }
  let filesApi: ReturnType<typeof createFilesApi> | null = null
  let brainFileTools:
    | Pick<
        ReturnType<typeof createFileTools>,
        'fileWrite' | 'fileAppend' | 'fileRead' | 'fileSearch' | 'fileSetMeta' | 'fileDelete' | 'saveFileToBrain' | 'saveFileBytes'
      >
    | null = null
  let fileIngestor: unknown = null
  if (filesBlobClient) {
    filesApi = createFilesApi({
      gcs: filesBlobClient,
      store: workspaceFilesStore,
      auditStore: workspaceAuditStore,
      bucket: env.GCS_FILES_BUCKET ?? 'local-dev',
    })
    const fileTools = createFileTools(filesApi, {
      entityLinks: entityLinksStore,
      readCachedFile: (id, ctx) => fileStore.get(id, ctx),
      onEvent: (evt, ctx) => {
        const base = { userId: ctx.userId, assistantId: ctx.assistantId, sessionId: ctx.sessionId, channelType: ctx.channelType }
        if (evt.type === 'file_created') {
          analytics.logEvent({ ...base, eventName: 'file_created', metadata: { file_id: sanitizeAnalytics(evt.fileId), path: sanitizeAnalytics(evt.path), size_bytes: evt.sizeBytes } })
        } else if (evt.type === 'file_appended') {
          analytics.logEvent({ ...base, eventName: 'file_appended', metadata: { file_id: sanitizeAnalytics(evt.fileId), path: sanitizeAnalytics(evt.path), size_bytes: evt.sizeBytes } })
        } else if (evt.type === 'file_meta_updated') {
          analytics.logEvent({ ...base, eventName: 'file_meta_updated', metadata: { file_id: sanitizeAnalytics(evt.fileId), path: sanitizeAnalytics(evt.path), fields: sanitizeAnalytics(evt.fields.join(',')) } })
        } else if (evt.type === 'file_deleted') {
          analytics.logEvent({ ...base, eventName: 'file_deleted', metadata: { file_id: sanitizeAnalytics(evt.fileId), path: sanitizeAnalytics(evt.path) } })
        } else if (evt.type === 'file_searched') {
          analytics.logEvent({ ...base, eventName: 'file_searched', metadata: { result_count: evt.resultCount, hit: evt.resultCount > 0, has_query: Boolean(evt.query) } })
        }
      },
    })
    allTools.set('fileWrite', fileTools.fileWrite)
    allTools.set('fileAppend', fileTools.fileAppend)
    allTools.set('fileRead', fileTools.fileRead)
    allTools.set('fileSearch', fileTools.fileSearch)
    allTools.set('fileSetMeta', fileTools.fileSetMeta)
    allTools.set('fileDelete', fileTools.fileDelete)
    allTools.set('saveFileToBrain', fileTools.saveFileToBrain)
    allTools.set('sendFile', fileTools.sendFile)
    brainFileTools = {
      fileWrite: fileTools.fileWrite,
      fileAppend: fileTools.fileAppend,
      fileRead: fileTools.fileRead,
      fileSearch: fileTools.fileSearch,
      fileSetMeta: fileTools.fileSetMeta,
      fileDelete: fileTools.fileDelete,
      saveFileToBrain: fileTools.saveFileToBrain,
      saveFileBytes: fileTools.saveFileBytes,
    }
    // Direct ingest seam — closed (FileIngestor builds Pipeline B). Injected as a
    // port; open default leaves it null (no /api/files/ingest ingest).
    if (ports.buildFileIngestor && brainEpisodeIngestor) {
      fileIngestor = ports.buildFileIngestor({
        filesApi,
        brainEpisodeIngestor,
        distill: async ({ buffer, mime }) =>
          (await distillFileToText({ buffer, mime }, { apiKey: env.GEMINI_API_KEY })).text,
      })
    }
  }

  // ── Agent capability toolset ──
  const agentControlPlaneReader = createControlPlaneReader({
    capabilityStore,
    connectorInstanceStore,
    connectorGrantStore,
    workspaceSkillStore,
    modesStore: assistantModesStore,
  })
  const resolveAgentApprover = async (ctx: { channelType: string; channelId: string; userId: string }) => {
    try {
      if (ctx.channelType === 'programmatic') {
        const key = await brainKeyStore.getByIdSystem(ctx.channelId)
        if (key?.createdBy) return key.createdBy
      } else if (ctx.channelType === 'assistant_mcp' || ctx.channelType === 'api') {
        const key = await apiKeyStore.getByIdSystem(ctx.channelId)
        if (key?.createdBy) return key.createdBy
      }
    } catch { /* fall through to the owner */ }
    return ctx.userId
  }
  const agentToolset = buildAgentToolset({
    allTools,
    controlPlaneReader: agentControlPlaneReader,
    approvalsStore: pendingApprovalsStore,
    writeToolDeps: {
      enablementStore: workspaceSkillEnablementStore,
      mcpSettingsStore,
      connectorInstanceStore,
      resolveApprover: resolveAgentApprover,
    },
  })
  for (const [name, tool] of agentToolset.reads) if (!allTools.has(name)) allTools.set(name, tool)
  for (const [name, tool] of agentToolset.writes) if (!allTools.has(name)) allTools.set(name, tool)

  // ════════════════════════════════════════════════════════════════
  // Route mounts (47 open mounts, original order)
  // ════════════════════════════════════════════════════════════════
  const webChatSystemPrompt = LAYER_1_SYSTEM_PROMPT
  // Brain-inspection tools need the closed InspectionStore; open default = none.
  const brainInspectionTools = ports.inspectionTools

  app.use('/api/chat', optionalAuth(env.JWT_SECRET), chatRoutes({
    provider,
    checkCreditBudget: ports.checkCreditBudget,
    publishSessionEvent,
    isPlaceholderTitle: ports.isPlaceholderTitle,
    getTitleChannelPrefix: ports.getTitleChannelPrefix,
    injectExtraTools: ports.injectExtraTools,
    resolveExtraSystemPrompt: ports.resolveExtraSystemPrompt,
    resolveAppSoul: ports.resolveAppSoul,
    llmProviderSettingsStore: llmProviderSettingsStore ?? undefined,
    buildWorkspaceProvider: llmProviderSettingsStore
      ? (apiKey: string) => wrapProvider(createGeminiProvider(apiKey))
      : undefined,
    systemPrompt: webChatSystemPrompt,
    tools: allTools,
    capabilityStore,
    memoryStore,
    entitiesStore,
    entityLinksStore,
    brainCandidateStore,
    chatEpisodeIngestor,
    fileStore,
    workspaceFilesStore,
    usageStore,
    analytics,
    cacheStore,
    connectorStore,
    mcpSettingsStore,
    assistantConnectorStore,
    connectorGrantStore,
    connectorInstanceStore,
    workerManager,
    workerRunsStore,
    knowledgeStore,
    gdriveFilesStore,
    skillStore,
    workspaceSkillStore,
    workspaceSkillEnablementStore,
    workspaceSkillFilesStore,
    communitySkills: communitySkillRegistry,
    pendingMessageStore,
    deferredConfirmationStore,
    pendingApprovalsStore,
    sessionResumeStore,
    episodicStore,
    sessionStateStore,
    planStore,
    jobStore,
    voiceTranscription,
    connectorActionStore,
    episodesStore,
    buildConnectorActionAudit: ports.buildConnectorActionAudit,
    assistantConnectorGrantsStore,
    retrievalStore,
    memoryRecallEventsStore,
    retrievalMissDetector,
    inspectionTools: brainInspectionTools,
  }))

  app.use('/api/v1', publicApiRoutes({
    provider,
    tools: allTools,
    systemPrompt: LAYER_1_SYSTEM_PROMPT,
    apiKeyStore,
    memoryStore,
    usageStore,
    knowledgeStore,
    capabilityStore,
    analytics,
    episodicStore,
    sessionStateStore,
    shadowClaimStore,
    connectorStore,
    mcpSettingsStore,
    assistantConnectorStore,
    connectorGrantStore,
    connectorInstanceStore,
    gdriveFilesStore,
    assistantConnectorGrantsStore,
  }))

  app.use('/api/v1', assistantMcpRoutes({
    apiKeyStore,
    capabilityStore,
    agentTools: { reads: agentToolset.reads, writes: agentToolset.writes },
  }))

  app.use('/api/brain/mcp', brainMcpRoutes({
    brainKeyStore,
    authorizationStore: oauthAuthorizationStore,
    memoryTools: brainMemoryTools,
    taskTools,
    crmTools,
    retrievalTools: brainRetrievalTools,
    fileTools: brainFileTools ?? undefined,
    ingest: brainEpisodeIngestor,
    agentTools: { reads: agentToolset.reads, writes: agentToolset.writes },
  }))

  app.use(oauthMetadataRoutes({ apiUrl: env.API_URL, webUrl: env.APP_URL }))
  app.use('/api/brain/oauth', oauthRoutes({
    clientStore: oauthClientStore,
    authorizationStore: oauthAuthorizationStore,
    workspaceStore,
    signingSecret: env.JWT_SECRET ?? 'dev-oauth-signing-secret',
    webAppUrl: env.APP_URL,
    requireAuth: requireAuth(env.JWT_SECRET),
  }))

  app.use('/api/sessions', optionalAuth(env.JWT_SECRET), sessionRoutes({ subscribeSessionEvents }))
  app.use('/api/sessions', requireAuth(env.JWT_SECRET), sessionQuestionRoutes({
    approvalsStore: pendingApprovalsStore,
    resumeDeps: {
      approvalsStore: pendingApprovalsStore,
      sessionResumeStore,
      jobStore,
      tryResolveLive: tryResolveLiveToolApproval,
    },
    workerRunsStore,
  }))

  app.use('/api/analytics', optionalAuth(env.JWT_SECRET), analyticsRoutes(analyticsStore))

  app.use('/api/feedback', optionalAuth(env.JWT_SECRET), feedbackRoutes())

  app.use('/api/files', optionalAuth(env.JWT_SECRET), fileRoutes(fileStore, fileIngestor as never))
  if (filesApi && filesBlobClient) {
    app.use('/api/doc-files', requireAuth(env.JWT_SECRET), docFilesRoutes({
      filesApi,
      store: workspaceFilesStore,
      gcs: filesBlobClient,
      membership: getWorkspaceMembershipWithClearanceSystem,
    }))
  }

  if (filesBlobClient) {
    app.use('/api/account/avatar', accountAvatarPublicRoutes(filesBlobClient))
  }
  app.use('/api/account', requireAuth(env.JWT_SECRET), accountRoutes({
    linkedAccountStore,
    linkCodeStore,
    getTelegramBotUsername,
    blobClient: filesBlobClient ?? undefined,
  }))

  // GET/POST /api/assistants (inline)
  app.get('/api/assistants', requireAuth(env.JWT_SECRET), async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    try {
      const rawWorkspaceId = req.query.workspaceId
      const workspaceId =
        typeof rawWorkspaceId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawWorkspaceId)
          ? rawWorkspaceId
          : null
      if (typeof rawWorkspaceId === 'string' && rawWorkspaceId !== '' && !workspaceId) {
        res.status(400).json({ error: 'Invalid workspaceId' })
        return
      }
      const rows = await listAccessibleAssistants(userId, workspaceId)
      res.json({
        assistants: rows.map((r) => ({
          id: r.id, name: r.name, role: r.role,
          description: r.systemPrompt ? r.systemPrompt.slice(0, 120) : null,
          memoryCount: r.memoryCount, iconSeed: r.iconSeed ?? 0,
          workspaceId: r.workspaceId,
          telegramModelAlias: r.telegramModelAlias,
          slackModelAlias: r.slackModelAlias,
          clearance: r.clearance, kind: r.kind, appType: r.appType,
        })),
      })
    } catch (err) {
      console.error('[assistants] list failed:', err)
      res.status(500).json({ error: 'Failed to list assistants' })
    }
  })

  app.post('/api/assistants', requireAuth(env.JWT_SECRET), async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    try {
      const { name, kind, workspaceId, appType } = req.body as {
        name?: string; kind?: string; workspaceId?: string; appType?: string
      }
      if (kind !== 'app') {
        res.status(400).json({
          error: 'POST /api/assistants only creates kind=\'app\' assistants. For standard team assistants, POST /api/workspaces/:id/assistants.',
          code: 'STANDARD_ASSISTANT_CREATE_MOVED',
        })
        return
      }
      if (!workspaceId) {
        res.status(400).json({
          error: 'kind=\'app\' requires workspaceId — distribution assistants are team-owned.',
          code: 'APP_REQUIRES_TEAM',
        })
        return
      }
      const { isAppType, defaultClearanceForAppType } = await import('@sidanclaw/shared')
      if (appType !== undefined && appType !== null && !isAppType(appType)) {
        res.status(400).json({
          error: `Unknown app type: ${String(appType)}. Supported: distribution.`,
          code: 'UNKNOWN_APP_TYPE',
        })
        return
      }
      const resolvedAppType = appType && isAppType(appType) ? appType : 'distribution'
      const teamRole = await queryWithRLS<{ role: string }>(
        userId,
        `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, userId],
      )
      if (teamRole.rows.length === 0) {
        res.status(403).json({ error: 'You are not a member of the target team.' })
        return
      }
      if (!['owner', 'admin'].includes(teamRole.rows[0].role)) {
        res.status(403).json({
          error: 'Only team admins or owners can create distribution apps.',
          code: 'APP_REQUIRES_TEAM_ADMIN',
        })
        return
      }
      const assistantName = name?.trim() || 'New Assistant'
      const iconSeed = Math.floor(Math.random() * 1000000)
      const appClearance = defaultClearanceForAppType(resolvedAppType)
      const result = await query<{ id: string }>(
        `INSERT INTO assistants (name, owner_user_id, icon_seed, kind, app_type, workspace_id, clearance)
         VALUES ($1, NULL, $2, 'app', $3, $4, $5) RETURNING id`,
        [assistantName, iconSeed, resolvedAppType, workspaceId, appClearance],
      )
      const assistantId = result.rows[0].id
      await connectionStore.seedWorkspacePrimaryFollows(workspaceId).catch((err) =>
        console.warn('[assistants] seedWorkspacePrimaryFollows failed:', err),
      )
      res.json({ id: assistantId, name: assistantName, iconSeed, kind: 'app', appType: resolvedAppType, workspaceId })
    } catch (err) {
      console.error('[assistants] create failed:', err)
      res.status(500).json({ error: 'Failed to create assistant' })
    }
  })

  const connectorRegistry = loadConnectorRegistry()
  app.use('/api/assistants', requireAuth(env.JWT_SECRET), assistantRoutes({
    assistantConnectorStore,
    connectorStore,
    connectorInstanceStore,
    connectorGrantStore,
    mcpSettingsStore,
    registry: connectorRegistry,
    jobStore,
    skillStore,
    communitySkills: communitySkillRegistry,
    capabilityStore,
    assistantConnectorGrantsStore,
  }))

  app.use('/api/skills/approvals', requireAuth(env.JWT_SECRET), skillApprovalsRoutes({
    approvalsStore: pendingApprovalsStore,
    workspaceStore,
    workspaceSkillStore,
    fileStore: workspaceSkillFilesStore,
    enablementStore: workspaceSkillEnablementStore,
    entityLinks: entityLinksStore,
  }))
  app.use('/api/skills', requireAuth(env.JWT_SECRET), skillRoutes({
    skillStore,
    communityRegistry: communitySkillRegistry,
    workspaceSkillStore,
    workspaceStore,
    workspaceSkillEnablementStore,
    listWorkspaceAssistants: async (userId, workspaceId) =>
      (await listAccessibleAssistants(userId, workspaceId)).map((a) => ({ id: a.id, name: a.name })),
    draftProvider: provider,
    getDraftContext: getSkillDraftContext,
    fileStore,
    checkUsageBudget: ports.checkCreditBudget,
  }))

  const workspaceInvitationStore = createWorkspaceInvitationStore()
  const workspaceRouter = workspaceRoutes({
    workspaceStore,
    auditStore: workspaceAuditStore,
    invitationStore: workspaceInvitationStore,
    smtpClient: emailAuth?.smtpClient,
    appUrl: env.APP_URL,
  })
  app.use('/api/workspaces', requireAuth(env.JWT_SECRET), workspaceRouter)

  const invitationRouter = invitationRoutes({
    invitationStore: workspaceInvitationStore,
    workspaceStore,
    auditStore: workspaceAuditStore,
  })
  app.use('/api/invitations', optionalAuth(env.JWT_SECRET), invitationRouter)

  const kbGapsRouter = kbGapsRoutes({ kbGapStore: kbGapCandidateStore, workspaceStore })
  app.use('/api/kb-gaps', requireAuth(env.JWT_SECRET), kbGapsRouter)

  app.use('/api/workspaces/:workspaceId/brain-keys', requireAuth(env.JWT_SECRET), brainKeysRoutes({ brainKeyStore, workspaceStore }))

  if (llmProviderSettingsStore) {
    app.use('/api/workspaces/:workspaceId/llm-keys', requireAuth(env.JWT_SECRET), workspaceLlmKeysRoutes({ llmProviderSettingsStore, workspaceStore }))
  }

  app.use('/api/workspaces/:workspaceId/compartments', requireAuth(env.JWT_SECRET), compartmentRoutes({ compartmentStore, workspaceStore }))

  app.use('/api/workspaces/:workspaceId/oauth-authorizations', requireAuth(env.JWT_SECRET), oauthAuthorizationsRoutes({
    authorizationStore: oauthAuthorizationStore,
    workspaceStore,
  }))

  app.use('/api', publicShareRoutes({
    pageGrantStore,
    taskStore,
    crmStore,
    workflowRunStore,
    workspaceDirectory: workspaceDirectoryStore,
    gcs: filesBlobClient,
  }))

  app.use('/api', requireAuth(env.JWT_SECRET), workflowApprovalsRoutes({
    approvalsStore: pendingApprovalsStore,
    workspaceStore,
    bridgeDeps: approvalBridgeDeps,
  }))

  app.use('/api/approvals', requireAuth(env.JWT_SECRET), approvalsRoutes({
    approvalsStore: pendingApprovalsStore,
    workspaceStore,
    bridgeDeps: approvalBridgeDeps,
    resumeDeps: {
      approvalsStore: pendingApprovalsStore,
      sessionResumeStore,
      jobStore,
      tryResolveLive: tryResolveLiveToolApproval,
    },
    stagedWriteDeps: { rawWrites: agentToolset.rawWrites },
  }))

  app.use('/api', requireAuth(env.JWT_SECRET), workflowsRoutes({
    workflowStore,
    runStore: workflowRunStore,
    workspaceStore,
    executorDeps: workflowExecutorDeps,
    savedViewStore,
    listTriggerJobs: (workflowId) => jobStore.listTriggerJobsForWorkflowSystem(workflowId),
    jobStore,
    resolvePrimary: workflowExecutorDeps.resolvePrimary,
    emitAudit: async (event) => {
      await workspaceAuditStore.append({
        workspaceId: event.workspaceId,
        actorUserId: event.userId,
        eventType: event.type,
        subjectId: event.workflowId,
        details: { name: event.name },
      })
    },
  }))

  app.use('/api', workflowWebhookRoutes({
    workflowStore,
    runStore: workflowRunStore,
    runDeps: workflowExecutorDeps,
  }))

  app.use('/api', requireAuth(env.JWT_SECRET), viewsRoutes({
    savedViewStore,
    pageGrantStore,
    workspaceGroupStore,
    analytics,
    taskStore,
    crmStore,
    workflowRunStore,
    workspaceStore,
    workspaceDirectory: workspaceDirectoryStore,
    softDeleteStore: createSoftDeleteStore(),
    provider,
    docPageStore: createDbDocPageStore(),
    jobStore,
    docEntityStore,
  }))

  app.use('/api', requireAuth(env.JWT_SECRET), docEntitiesRoutes({ docEntityStore, workspaceStore }))

  app.use('/api', requireAuth(env.JWT_SECRET), docThemesRoutes({ docThemesStore, workspaceStore, provider }))

  const commentThreadStore = createDbCommentThreadStore()
  const docNotificationsStore = createDbDocNotificationsStore()
  app.use('/api', requireAuth(env.JWT_SECRET), commentRoutes({ commentThreadStore }))
  app.use('/api', requireAuth(env.JWT_SECRET), inboxRoutes({ commentThreadStore, docNotificationsStore }))

  app.use('/api/brain/stream', brainStreamRoutes({ workspaceStore, jwtSecret: env.JWT_SECRET }))
  startBrainStreamFanout()
  app.use('/api/brain', requireAuth(env.JWT_SECRET), brainRoutes({ entitiesStore, entityLinksStore, retrievalStore, knowledgeStore, workspaceSkillStore, connectorInstanceStore }))
  app.use('/api/home', requireAuth(env.JWT_SECRET), homeRoutes())
  app.use('/api/home-dock', requireAuth(env.JWT_SECRET), homeDockRoutes({
    homeDockStore,
    isWorkspaceMember,
    assembleSignals: (userId, workspaceId) =>
      assembleHomeSignals(userId, workspaceId, { workflowStore, savedViewStore }),
    refresh: async (userId, workspaceId) => {
      const signals = await assembleHomeSignals(userId, workspaceId, { workflowStore, savedViewStore })
      const assistantId = await resolvePrimaryAssistantForWorkspace(workspaceId)
      await runHomeRefresh({ userId, workspaceId, assistantId, provider, homeDockStore, signals })
    },
  }))

  app.use('/api/teams', requireAuth(env.JWT_SECRET), workspaceRouter) // legacy

  app.use('/api/handles', requireAuth(env.JWT_SECRET), handleRoutes())
  app.use('/api/connections', requireAuth(env.JWT_SECRET), connectionRoutes({ connectionStore }))
  app.use('/api/discover', discoverRoutes())
  app.use('/api/assistants/:assistantId/modes', requireAuth(env.JWT_SECRET), createModesRouter({ modesStore: assistantModesStore }))
  app.use('/api/pending-messages', requireAuth(env.JWT_SECRET), pendingMessageRoutes({ pendingMessageStore, integrationStore: integrationStore ?? undefined, defaultTelegramBotToken: env.TELEGRAM_BOT_TOKEN, waConnectorUrl: env.WA_CONNECTOR_URL, waConnectorSecret: env.WA_CONNECTOR_SECRET }))
  app.use('/api/snapshots', requireAuth(env.JWT_SECRET), snapshotRoutes({ snapshotStore, generateSnapshot: snapshotGenerator }))

  app.use('/api/assistants/:assistantId/memories', requireAuth(env.JWT_SECRET), memoryRoutes())

  app.use('/api/assistants/:assistantId/knowledge', requireAuth(env.JWT_SECRET), knowledgeRoutes({
    knowledgeStore,
    connectorInstanceStore,
    connectorGrantStore,
    triggerSync: async () => { if (syncWorkerRef) await syncWorkerRef.tick() },
  }))

  // workspace-scoped knowledge route needs the closed sync-credential provider;
  // when absent (open) it mounts without the edit-proposal PAT resolution.
  app.use('/api/workspaces/:workspaceId/knowledge', requireAuth(env.JWT_SECRET), workspaceKnowledgeRoutes({
    knowledgeStore,
    connectorInstanceStore,
    connectorGrantStore,
    triggerSync: async () => { if (syncWorkerRef) await syncWorkerRef.tick() },
  }))

  // ════════════════════════════════════════════════════════════════
  // Closed routes (platform-injected) mount here, against the same stores.
  // ════════════════════════════════════════════════════════════════
  const workflowEventDispatcher: unknown = undefined

  // ════════════════════════════════════════════════════════════════
  // Open background workers
  // ════════════════════════════════════════════════════════════════
  const jobExecutor = createJobExecutor({
    jobStore,
    analytics,
    runWorkflowFromJob: async (job) => {
      if (!job.workflowId) return 'no workflow_id on job'
      if (job.workflowStepRunId) {
        const runId = await getRunIdForStepRun(job.workflowStepRunId)
        if (!runId) return `step run ${job.workflowStepRunId} not found (workflow may have been deleted)`
        await workflowRunStore.updateStepRun(job.workflowStepRunId, {
          status: 'completed', output: { resumed: true }, finishedAt: new Date(),
        })
        const run = await workflowRunStore.getRunSystem(runId)
        const wf = run ? await workflowStore.findByIdSystem(run.workflowId) : null
        if (run && wf) {
          const waitStep = wf.definition.steps.find((s) => s.id === run.currentStepId)
          const nextId = waitStep?.nextStepId === undefined
            ? (wf.definition.steps[wf.definition.steps.indexOf(waitStep!) + 1]?.id ?? null)
            : waitStep.nextStepId
          await workflowRunStore.updateRun(runId, { status: 'running', currentStepId: nextId })
        }
        const outcome = await advanceWorkflowRun(workflowExecutorDeps, runId)
        await jobStore.update(job.id, { enabled: false })
        if (outcome.kind === 'failed') {
          throw new Error(
            `workflow wait wake-up ${runId} failed: ${outcome.error?.reason ?? 'unknown'}` +
            (outcome.error?.message ? ` — ${outcome.error.message}` : ''),
          )
        }
        return `workflow wait wake-up: ${outcome.kind}`
      }
      let triggerInput: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(job.instructions) as { input?: Record<string, unknown> }
        triggerInput = parsed.input ?? {}
      } catch { /* legacy job — empty input */ }
      const wf = await workflowStore.getById(job.userId, job.workflowId)
      if (!wf || !wf.enabled) return `workflow ${job.workflowId} not found or disabled`
      if (wf.trigger?.kind !== 'schedule' && job.schedule) {
        await workflowStore
          .update(job.userId, wf.id, { trigger: { kind: 'schedule', schedule: job.schedule, timezone: job.timezone } })
          .catch((err) => console.warn('[workflow] schedule-trigger reconcile failed:', err))
      }
      const run = await workflowRunStore.createRun({
        workflowId: wf.id, workspaceId: wf.workspaceId,
        triggeredBy: null, triggerKind: 'schedule', input: triggerInput,
      })
      const outcome = await advanceWorkflowRun(workflowExecutorDeps, run.id)
      if (outcome.kind === 'failed') {
        throw new Error(
          `workflow run ${run.id} failed: ${outcome.error?.reason ?? 'unknown'}` +
          (outcome.error?.message ? ` — ${outcome.error.message}` : ''),
        )
      }
      return `workflow scheduled trigger: ${outcome.kind} (run ${run.id})`
    },
  })

  deferredConfirmationStore.cleanupExpired()
    .then((n) => { if (n > 0) console.log(`[boot] cleaned up ${n} expired deferred confirmations`) })
    .catch((err) => console.error('[boot] deferred confirmation cleanup failed:', err))

  const sessionResumeReplay = createSessionResumeReplay({
    provider,
    tools: allTools,
    systemPrompt: webChatSystemPrompt,
    analytics,
    workerManager,
    workerRunsStore,
  })
  const pollWorker = createPollWorker({
    store: jobStore,
    executor: jobExecutor,
    resumeHandler: async (job) => {
      const resume = job.state?.resume
      if (!resume) throw new Error(`session_resume job ${job.id} is missing state.resume`)
      const outcome = await runSessionResume(
        { sessionResumeStore, pendingApprovalsStore, replay: sessionResumeReplay, analytics },
        { sessionId: resume.sessionId, approvalId: resume.approvalId },
      )
      if (outcome.status === 'failed') {
        throw new Error(`session_resume failed for approval ${resume.approvalId}: ${outcome.reason}`)
      }
    },
    onJobAutoDisabled: (job, failureCount) => {
      analytics?.logEvent({
        userId: job.userId,
        assistantId: job.assistantId,
        channelType: job.channelType,
        eventName: 'scheduled_job.auto_disabled',
        metadata: {
          consecutive_failures: failureCount,
          schedule_type: sanitizeAnalytics(job.schedule.type),
          workflow_id: job.workflowId ? sanitizeAnalytics(job.workflowId) : undefined,
        },
      })
    },
  })
  if (runWorkers) pollWorker.start()

  const cleanupWorker = createCleanupWorker({ jobStore })
  if (runWorkers) cleanupWorker.start()

  // Ingest batch worker is closed (Pipeline B processor lives in api-platform).
  // The platform starts it via mountExtraRoutes; the open build skips it.
  const classifierCircuitBreaker = createCircuitBreaker(
    // The DB circuit-breaker counter store is closed; the open build uses an
    // in-memory counter so the classifier still has a breaker. (Stateless,
    // process-local — acceptable for single-instance local dev.)
    {
      async increment() { return 1 },
      async reset() {},
      async get() { return 0 },
    } as never,
    { analytics },
  )

  // ── Consolidation worker (dreaming) ──
  const CONSOLIDATION_MODEL = 'gemini-flash'
  const consolidationCallModel = async (
    prompt: string,
    ctx: { assistantId: string; userId: string | null; workspaceId: string | null; phase: string },
  ): Promise<string> => {
    const response = await collectStream(provider.stream({
      model: CONSOLIDATION_MODEL,
      messages: [{ role: 'user', content: prompt }],
      systemPrompt: 'You are a memory consolidation assistant. Follow the user instructions exactly. Output plain text only.',
      maxTokens: 4096,
    }))
    if (response.usage && ctx.userId && usageStore) {
      const cost = calculateCost(CONSOLIDATION_MODEL, response.usage)
      usageStore.recordUsage({
        userId: ctx.userId,
        assistantId: ctx.assistantId,
        sessionId: null,
        model: CONSOLIDATION_MODEL,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        cacheReadTokens: response.usage.cacheReadTokens,
        cacheWriteTokens: response.usage.cacheWriteTokens,
        actualCostUsd: cost,
        source: 'overhead:consolidation',
      }).catch((err) => console.error('[consolidation] usage tracking failed:', err))
    }
    return response.content
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
  }

  const consolidationWorker = createConsolidationWorker({
    store: memoryStore,
    callModel: consolidationCallModel,
    onEvent: (event) => {
      if (event.type === 'consolidation_completed') {
        analytics.logEvent({
          userId: event.userId,
          assistantId: event.assistantId,
          eventName: 'consolidation_completed',
          metadata: {
            phase: sanitizeAnalytics(event.phase),
            memories_affected: event.memoriesAffected,
            merged: event.merged,
            patterns_found: event.patternsFound,
            pruned: event.pruned ?? 0,
            promoted: event.promoted ?? 0,
            domains_summarized: event.domainsSummarized ?? 0,
          },
        })
      } else if (event.type === 'soul_updated') {
        analytics.logEvent({
          userId: event.userId,
          assistantId: event.assistantId,
          eventName: 'soul_updated',
          metadata: {
            previous_length: event.previousLength,
            new_length: event.newLength,
            change_magnitude: event.changeMagnitude,
          },
        })
      }
    },
    // Post-REM reclassification needs the closed brainCandidateStore. Omitted
    // (open) when no candidate store is wired.
    reclassification: brainCandidateStore
      ? {
          entityStore: entitiesStore,
          entityLinks: entityLinksStore,
          tasks: taskStore,
          candidates: brainCandidateStore,
          provider,
          model: 'gemini-flash',
          resolveWorkspaceId: async (assistantId: string) => {
            const r = await query<{ workspaceId: string }>(
              `SELECT workspace_id AS "workspaceId" FROM assistants WHERE id = $1`,
              [assistantId],
            )
            return r.rows[0]?.workspaceId ?? null
          },
          isV2Enabled: async (workspaceId: string) => {
            const r = await query<{ enabled: boolean }>(
              `SELECT brain_extraction_v2_enabled AS "enabled" FROM workspaces WHERE id = $1`,
              [workspaceId],
            )
            return r.rows[0]?.enabled ?? true
          },
        }
      : undefined,
    workspaceCuratorScope: env.SKILLS_AUTO_GEN_ENABLED
      ? buildWorkspaceCuratorScope({
          workspaceSkillStore,
          digestStore: skillCuratorDigestStore,
          getEmbeddings: (texts) => curatorEmbedder.embed(texts),
        })
      : undefined,
  })
  if (runWorkers) consolidationWorker.start()

  // ── Skill-review worker ──
  const SKILL_REVIEW_MODEL = 'gemini-3.1-flash-lite'
  const skillReviewLLM = createGeminiSkillReviewLLM(
    async ({ systemPrompt, prompt, maxTokens, attribution }) => {
      const response = await collectStream(provider.stream({
        model: SKILL_REVIEW_MODEL,
        messages: [{ role: 'user', content: prompt }],
        systemPrompt,
        maxTokens,
      }))
      if (response.usage && usageStore) {
        const cost = calculateCost(SKILL_REVIEW_MODEL, response.usage)
        usageStore.recordUsage({
          userId: attribution.userId,
          assistantId: attribution.assistantId,
          sessionId: null,
          model: SKILL_REVIEW_MODEL,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          cacheReadTokens: response.usage.cacheReadTokens,
          cacheWriteTokens: response.usage.cacheWriteTokens,
          actualCostUsd: cost,
          source: 'overhead:skill-review',
        }).catch((err) => console.error('[skill-review] usage tracking failed:', err))
      }
      return response.content
        .filter((b) => b.type === 'text')
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
    },
  )
  const skillReviewWorker = createSkillReviewWorker({
    workspaceSkillStore,
    fileStore: workspaceSkillFilesStore,
    approvalsStore: pendingApprovalsStore,
    analyticsStore,
    reviewLLM: skillReviewLLM,
    leaseHolderId: skillReviewLeaseHolderId,
    enabled: env.SKILLS_AUTO_GEN_ENABLED ?? false,
    onEvent: (event) => {
      if (event.type === 'tick_complete') {
        console.log(`[skill-review] tick complete — reviewed:${event.reviewed} skipped:${event.skipped} failed:${event.failed}`)
      }
    },
  })
  if (runWorkers) skillReviewWorker.start()

  // ── Classifier self-heal worker — needs the closed pending-classification
  //    queue. Only started when injected (platform); open omits it. ──
  if (ports.pendingClassificationStore) {
    const pendingQueue = ports.pendingClassificationStore
    const classifierSelfHealWorker = createClassifierSelfHealWorker({
      classifier: entityKindClassifier,
      entities: entitiesStore,
      scanner: {
        async scanByCentrality(workspaceId, opts) {
          const { rows } = await query<EntityRecord & { centrality: number | string }>(
            `SELECT
               id, kind, display_name AS "displayName",
               canonical_id AS "canonicalId", aliases, attributes, sensitivity,
               workspace_id AS "workspaceId", user_id AS "userId",
               assistant_id AS "assistantId",
               created_by_user_id AS "createdByUserId",
               created_by_assistant_id AS "createdByAssistantId",
               source_episode_id AS "sourceEpisodeId", source,
               verified_by_user_id AS "verifiedByUserId",
               verified_at AS "verifiedAt",
               valid_from AS "validFrom", valid_to AS "validTo",
               superseded_by AS "supersededBy",
               retracted_at AS "retractedAt",
               retracted_reason AS "retractedReason",
               retracted_by AS "retractedBy",
               centrality, centrality_computed_at AS "centralityComputedAt",
               created_at AS "createdAt", updated_at AS "updatedAt"
             FROM entities
             WHERE workspace_id = $1 AND valid_to IS NULL AND retracted_at IS NULL
             ORDER BY centrality DESC NULLS LAST, created_at DESC
             LIMIT $2`,
            [workspaceId, opts.limit],
          )
          return rows.map((r) => ({
            ...r,
            centrality: typeof r.centrality === 'string' ? Number(r.centrality) : r.centrality,
          })) as EntityRecord[]
        },
      },
      reclassifier: {
        async reclassifyEntityKind(actorUserId, id, newKind) {
          return reclassifyEntityKindFn(actorUserId, id, { kind: newKind })
        },
        async promoteEntityToCrm(actorUserId, id, targetKind) {
          const out = await promoteEntityToCrmFn(actorUserId, id, { kind: targetKind })
          return out.entity
        },
      },
      pendingQueue,
      workspaces: async () => {
        const { rows } = await query<{ workspace_id: string; owner_user_id: string }>(
          `SELECT DISTINCT e.workspace_id, w.owner_user_id
             FROM entities e
             JOIN workspaces w ON w.id = e.workspace_id
             WHERE e.valid_to IS NULL AND e.retracted_at IS NULL`,
        )
        return rows.map((r) => ({ workspaceId: r.workspace_id, actorUserId: r.owner_user_id }))
      },
      circuitBreaker: classifierCircuitBreaker,
    })
    if (runWorkers) classifierSelfHealWorker.start()
  }

  // ── Commitment-memory lifecycle worker ──
  const commitmentLifecycleWorker = createCommitmentLifecycleWorker({
    store: memoryStore,
    resolver: createCompositeCommitmentResolver({
      resolvers: {
        sprint_variance: createSprintVarianceResolver({
          lookup: async (taskId) => {
            const task = await getTaskByIdSystem(taskId)
            return task ? { status: task.status, due: task.due } : null
          },
        }),
      },
    }),
  })
  if (runWorkers) commitmentLifecycleWorker.start()

  // ── Workspace-level prompt evolution worker ──
  const { createMemoryEvolutionWorker } = await import('./workers/memory-evolution-worker.js')
  const memoryEvolutionWorker = createMemoryEvolutionWorker({
    onEvent: (event) => {
      if (event.type === 'workspace_processed' && event.snippetEmitted) {
        console.log(`[memory-evolution] emitted snippet for workspace ${event.workspaceId} (${event.totalVerifications} verifications over ${event.totalSaves} model saves)`)
      } else if (event.type === 'error') {
        console.error(`[memory-evolution] error for workspace ${event.workspaceId ?? '<global>'}: ${event.error}`)
      } else if (event.type === 'tick_complete') {
        console.log(`[memory-evolution] tick complete: processed=${event.processedCount} emitted=${event.emittedCount} skipped=${event.skippedCount} errors=${event.errorCount}`)
      }
    },
  })
  if (runWorkers) memoryEvolutionWorker.start()

  // ── Brain-evolution worker ──
  const { createBrainEvolutionWorker } = await import('./workers/brain-evolution-worker.js')
  const brainEvolutionWorker = createBrainEvolutionWorker({
    onEvent: (event) => {
      if (event.type === 'workspace_processed' && event.snippetEmitted) {
        console.log(`[brain-evolution] emitted snippet for workspace ${event.workspaceId} (primitives above threshold: ${event.primitivesAboveThreshold.join(', ')})`)
      } else if (event.type === 'error') {
        console.error(`[brain-evolution] error for workspace ${event.workspaceId ?? '<global>'}: ${event.error}`)
      } else if (event.type === 'tick_start') {
        console.log(`[brain-evolution] tick start: scanning ${event.workspaceCount} workspaces`)
      }
    },
  })
  if (runWorkers) brainEvolutionWorker.start()

  // ── CL-9 weekly retrieval-miss aggregator ──
  if (process.env.CL9_AGGREGATOR_ENABLED === 'true') {
    const { startRetrievalMissAggregator } = await import('./workers/retrieval-miss-aggregator.js')
    const { query: rawQuery } = await import('./db/client.js')
    const _aggregatorEmbedder = createGeminiEmbedder(env.GEMINI_API_KEY)
    const retrievalMissAggregator = startRetrievalMissAggregator({
      retrievalMissStore,
      kbGapStore: kbGapCandidateStore,
      getEmbedding: async (text) => {
        const [vec] = await _aggregatorEmbedder.embed([text])
        return vec ?? []
      },
      listActiveWorkspaces: async () => {
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        const r = await rawQuery<{ workspaceId: string }>(
          `SELECT DISTINCT workspace_id AS "workspaceId" FROM retrieval_miss WHERE at >= $1`,
          [since],
        )
        return r.rows.map((row) => row.workspaceId)
      },
      onEvent: (event) => {
        if (event.type === 'kb_gap_candidate_emitted') {
          console.log(`[retrieval-miss-aggregator] emitted ${event.count} candidate(s) for workspace ${event.workspaceId}`)
        } else if (event.type === 'error') {
          console.error(`[retrieval-miss-aggregator] error for workspace ${event.workspaceId ?? '<global>'}: ${event.error}`)
        } else if (event.type === 'tick_complete') {
          console.log(`[retrieval-miss-aggregator] tick complete: processed=${event.processedCount} emitted=${event.emittedCount} errors=${event.errorCount}`)
        }
      },
    })
    if (runWorkers) retrievalMissAggregator.start()
  }

  // ── Embedding worker ──
  // primitivesWithVectorColumn is closed (api-platform/admin). Open uses the
  // default primitive set from the embedding store.
  const embeddingWorker = createEmbeddingWorker({
    store: createDbEmbeddingStore(),
    embedder: createGeminiEmbedder(env.GEMINI_API_KEY),
  })
  if (runWorkers) embeddingWorker.start()

  // ── Knowledge sync worker ──
  // The sync-credential provider is closed; without it the worker still ticks
  // but resolves no PAT credentials (no GitHub source syncs locally).
  const knowledgeSyncWorker = createKnowledgeSyncWorker({
    store: knowledgeStore as never,
    api: {
      getBranchHead,
      getRepoTree,
      getFileContents: async (pat, owner, repo, path, ref) => {
        const data = await getFileContents(pat, owner, repo, path, ref)
        return data as { content?: string }
      },
      compareCommits,
    },
    credentials: { resolve: async () => null } as never,
    intervalMs: 15 * 60 * 1000,
    onEvent: (event) => {
      console.log(`[knowledge-sync] ${event.type}: ${event.repo}`, event)
    },
  })
  syncWorkerRef = knowledgeSyncWorker
  if (runWorkers) knowledgeSyncWorker.start()

  // ── Stuck-session sweeper ──
  const stuckSessionSweeper = createStuckSessionSweeper({
    publishDraftTurnCompleted: (sessionId) =>
      publishSessionEvent({ kind: 'turn_completed', sessionId, payload: { senderUserId: 'sweeper' } }),
  })
  if (runWorkers) stuckSessionSweeper.start()

  // ── Views auto-prune worker ──
  const viewsPruneWorker = createViewsPruneWorker({ savedViewStore })
  if (runWorkers) viewsPruneWorker.start()

  // (Anonymous shadow-user pruning rides the CLOSED channel-user store, so the
  // platform starts it from mountExtraRoutes — not here.)

  // ── Hourly approval / question / worker-run sweeps ──
  if (runWorkers) {
    startJitteredInterval(() => {
      sweepExpiredApprovals(approvalBridgeDeps)
        .then((n) => { if (n > 0) console.log(`[approvals] expired ${n} pending approvals`) })
        .catch((err) => console.error('[approvals] sweep failed:', err))
    }, 60 * 60 * 1000)
    startJitteredInterval(() => {
      sweepExpiredQuestions({ approvalsStore: pendingApprovalsStore, jobStore, sessionResumeStore })
        .then((n) => { if (n > 0) console.log(`[approvals] expired ${n} pending questions`) })
        .catch((err) => console.error('[approvals] question sweep failed:', err))
    }, 15 * 60 * 1000)
    startJitteredInterval(() => {
      sweepStaleWorkerRuns(workerRunsStore)
        .then((n) => { if (n > 0) console.log(`[worker-runs] cleaned up ${n} stale rows`) })
        .catch((err) => console.error('[worker-runs] cleanup sweep failed:', err))
    }, 24 * 60 * 60 * 1000)
  }

  // ════════════════════════════════════════════════════════════════
  // BootContext
  // ════════════════════════════════════════════════════════════════
  const ctx: BootContext = {
    app,
    provider,
    allTools,
    analytics,
    env,
    runWorkers,
    port,
    workspaceStore,
    workspaceAuditStore,
    memoryStore,
    entitiesStore,
    entityLinksStore,
    episodesStore,
    crmStore,
    taskStore,
    connectorStore,
    connectorInstanceStore,
    mcpSettingsStore,
    assistantConnectorStore,
    assistantConnectorGrantsStore,
    connectorGrantStore,
    connectorActionStore,
    workspaceFilesStore,
    knowledgeStore,
    capabilityStore,
    apiKeyStore,
    usageStore,
    workspaceStoreRefForRouter: workspaceRouter,
    workflowStore,
    workflowRunStore,
    workflowExecutorDeps,
    pendingMessageStore,
    deferredConfirmationStore,
    chatConfirmationStore,
    snapshotStore,
    snapshotGenerator,
    episodicStore,
    sessionStateStore,
    workerManager,
    workerRunsStore,
    skillStore,
    communitySkillRegistry,
    jobStore,
    linkedAccountStore,
    linkCodeStore,
    integrationStore,
    ingestRulesStore,
    gdriveFilesStore,
    filesApi,
    entityKindClassifier,
    workflowEventDispatcher,
    voiceTranscription,
    resolvePrimaryAssistantForWorkspace,
    resolveDataRequest,
    emailAuth,
    approvalBridgeDeps,
  }

  // ── Let the platform mount its closed routes + workers onto the same app ──
  if (ports.mountExtraRoutes) {
    await ports.mountExtraRoutes(app, ctx)
  }

  // ── Session-event bus is generic infra; boot it so doc-comment live
  //    reconnect (open) and any closed feed draft features both subscribe. ──
  startSessionEventBus()

  // ════════════════════════════════════════════════════════════════
  // start / shutdown
  // ════════════════════════════════════════════════════════════════
  let server: http.Server | undefined

  async function start(): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve) => {
      server = app.listen(port, () => {
        console.log(`sidanclaw api running on port ${port}`)
        console.log(`Tools loaded: ${allTools.size}`)
        resolve({ server: server!, port })
      })
    })
  }

  async function shutdown(): Promise<void> {
    console.log('Shutting down — flushing analytics...')
    consolidationWorker.stop()
    skillReviewWorker.stop()
    embeddingWorker.stop()
    pollWorker.stop()
    knowledgeSyncWorker.stop()
    stuckSessionSweeper.stop()
    await analytics.shutdown()
    if (server) await new Promise<void>((res) => server!.close(() => res()))
  }

  return { app, ctx, start, shutdown }
}

// ── Helper (snapshot response formatter) ──
function formatSnapshotResponse(json: string, category: string | null): string {
  try {
    const data = JSON.parse(json)
    if (category === 'tasks' && data.jobs) {
      const active = (data.jobs as Array<{ instructions: string; enabled: boolean }>).filter((j) => j.enabled)
      return active.length > 0 ? active.map((j) => `• ${j.instructions}`).join('\n') : 'No active tasks.'
    }
    if (category === 'knowledge' && data.entries) {
      return (data.entries as Array<{ title: string; summary?: string }>)
        .slice(0, 10).map((e) => `• ${e.title}${e.summary ? ` — ${e.summary}` : ''}`).join('\n')
    }
    if (category === 'memories' && data.memories) {
      return (data.memories as Array<{ summary: string }>).slice(0, 10).map((m) => `• ${m.summary}`).join('\n')
    }
    return json.slice(0, 500)
  } catch { return json.slice(0, 500) }
}

// Re-export getPool so the platform can reuse the same pool accessor for its
// diagnostic endpoints without re-importing the open db/client.
export { getPool }
