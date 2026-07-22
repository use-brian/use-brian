/**
 * bootOpenApi — the OPEN composition root for the Use Brian HTTP API.
 *
 * This module builds the entire OPEN slice of the API service: the express
 * app + middleware, the LLM provider stack, every open DB store, the open tool
 * set, the 47 open route mounts (in the platform's original order), and the
 * open background workers. It imports ZERO closed code — every closed seam is
 * an OPTIONAL injected PORT with a safe default (allow-all credit gate, no-op
 * usage recorder, inert feed hooks, no-op episode ingestors, …). The closed
 * platform entry (`apps/api/src/index.ts`, `@use-brian/api-server`) calls this
 * with the real impls + a `mountExtraRoutes` hook that mounts the 33 closed
 * routes onto the same app against the SAME store instances exposed on
 * `BootContext`. A standalone open entry (`use-brian/apps/api`,
 * `@use-brian/api-open`) calls it with no ports → all safe defaults.
 *
 * See the open-core split (repo CLAUDE.md; plan in git history) §10 (ports & adapters DI), §12.5
 * (the open/closed manifest), and /tmp/squash/apps-split-plan.md for the full
 * inventory of open vs closed mounts.
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or `@use-brian/shared-server`
 * from this file. The classification rule is mechanical — those two specifiers
 * are the only "closed" import surfaces. Config + secrets arrive through the
 * `env` option, not `getEnv()`.
 */

import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type http from 'node:http'

import express, { type Express } from 'express'
import { createTelegramApi } from '@use-brian/channels'
import {
  vertexTransport, resolveVertexTokenSource, aiStudioTransport,
  createEmbedderForAdapter, type EmbedderAdapterConfig, type GoogleTransport, type MediaBackend,
  createGeminiProvider, createAnthropicProvider, createOpenAICompatProvider, createRoutingProvider,
  DASHSCOPE_INTL_BASE_URL, DASHSCOPE_INTL_LABEL, wrapProvider,
  createBaseTools, LAYER_1_SYSTEM_PROMPT,
  createWorkerManager, createWorkerTools,
  createSchedulingTools, createPollWorker,
  startJitteredInterval, stopJitteredInterval,
  createCacheTool, createReadFileTool, distillFileToText,
  createRateLimiter, sanitizeDeep,
  AnalyticsLogger, sanitize as sanitizeAnalytics,
  createConsolidationWorker,
  createEmbeddingWorker,
  createEmbeddingUsageRecorder,
  createCommitmentLifecycleWorker,
  createSprintVarianceResolver,
  createCompositeCommitmentResolver,
  calculateCost,
  createGoalClarityAssessor,
  createGoalVerifier,
  createTaskTriageJudge,
  type TaskRecord,
  collectStream,
  createInterAssistantTools,
  createReportBugTool,
  createConfirmRecordingProcessingTool,
  createIngestStoredFileTool,
  createReprocessRecordingTool,
  createReviewDataRequestTool,
  createWorkflowTools,
  createWorkflowBrainTools,
  createCorrectionTools,
  createBrainHealingTools,
  createScheduleWorkflowTool,
  advanceWorkflowRun,
  createWorkflowEventDispatcher,
  type WorkflowEventDispatcher,
  createRunQueueWorker,
  createTaskTools,
  createGoalTools,
  buildOneStepReminderWorkflow,
  type GoalRecord,
  createWorkspaceTools,
  createTranscriptionPrefTools,
  type WorkspaceDirectoryStore,
  type WorkspaceMemberInfo,
  createCrmTools,
  createMemoryTools,
  createRetrievalTools,
  createViewTools,
  createFileTools,
  createDeckTools,
  type FileToolPolicy,
  createFindPageTool,
  createIngestRuleTools,
  createEntityKindClassifier,
  createCircuitBreaker,
  createKnowledgeSyncWorker,
  type SyncCredentials,
  type ExecutorDeps as WorkflowExecutorDeps,
  type LLMProvider,
  type TokenUsage,
  type Tool,
  type UsageStore,
  type BrainCandidateStore,
  type PendingClassificationStore,
  type GDriveFilesStore,
  type EntityRecord,
  type EngineHooks,
  createIntrospectionTools,
  createComputerTools,
  createComputeTools,
  createLocalBrowserProvider,
  createCloudBrowserProvider,
  createSandboxOrchestrator,
  createInMemorySandboxTaskStore,
  createSandboxReaper,
  createSandboxMeter,
  createInMemorySpendAccumulator,
  resolveUnattendedComputerUse,
  DEFAULT_SESSION_BUDGET_USD,
  createE2bCloudProvider,
  createE2bRuntime,
  createSkillRunnerTools,
  createBuFallbackTool,
  RESEARCH_BUDGET_CEILING,
  type BlockApprovalsPort,
  type BrowserSkillGrantStore,
  type ComputerToolPolicy,
  type BrowserProfileStore,
  type SandboxOrchestrator,
  type SandboxProvider,
  type SandboxTaskStore,
  type Sensitivity,
  type SessionVault,
} from '@use-brian/core'

import { APP_LEVEL_ASSISTANT_ID, OFFICIAL_CONNECTORS, OFFICIAL_CONNECTOR_TOOLS } from '@use-brian/shared'

// ── OPEN package imports (@use-brian/api) ──────────────────────────
import { findAssistantById, isUserBlockedForAssistant, listAccessibleAssistants } from './db/users.js'
import { getTaskByIdSystem } from './db/tasks.js'
import { createBrowserSkillsStore } from './db/browser-skills-store.js'
import { createDbConnectorActionStore } from './db/connector-actions-store.js'
import { authRoutes } from './routes/auth.js'
import { devAuthRoutes, isLocalDevEnv } from './routes/dev-auth.js'
import { localSessionRoutes, isOssEdition } from './routes/local-session.js'
import { createDbMagicLinkStore } from './db/magic-link-store.js'
import { createSmtpClient, createWorkspaceSmtpTransport } from './email/smtp-client.js'
import { chatRoutes, runSessionResume, tryResolveLiveToolApproval } from './routes/chat.js'
import { menuForClass } from '@use-brian/shared/model-registry'
import { BACKGROUND_MODEL, ensureServableModel } from './model-resolution.js'
import { EXTRACTION_MODEL } from './build-episode-ingestors.js'
import { createMeteredProfileStore } from './db/metered-profile-store.js'
import { createWorkspaceModelDefaultsStore } from './db/workspace-model-defaults-store.js'
import { createSessionResumeReplay } from './routes/session-resume-replay.js'
import { brainRoutes } from './routes/brain.js'
import { brainInboxRoutes } from './routes/brain-inbox.js'
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
import { browserExtensionRoutes } from './routes/browser-extension.js'
import { computerRoutes } from './routes/computer.js'
import { createRelayCommandTransport, relayExtensionConnected } from './sandbox/relay-transport.js'
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
import { createWorkspaceStore, getWorkspaceMembershipWithClearanceSystem, getWorkspacePlan, getWorkspaceTranscriptionPrefs, setWorkspaceTranscriptionPrefs } from './db/workspace-store.js'
import { createWorkspaceAuditStore } from './db/workspace-audit-store.js'
import { createConnectionStore } from './db/connection-store.js'
import { createPendingMessageStore } from './db/pending-message-store.js'
import {
  getPendingRecordingConfirmation,
  deletePendingRecordingConfirmation,
  buildChannelSessionKey,
} from './db/pending-recording-confirmations-store.js'
import { enqueueRecordingJob, hasCompletedRecordingJob } from './db/recording-jobs-store.js'
import { createChatConfirmationStore } from './db/chat-confirmation-store.js'
import { createDeferredConfirmationStore } from './db/deferred-confirmation-store.js'
import { createSnapshotStore } from './db/snapshot-store.js'
import { createDbKnowledgeStore } from './db/knowledge-store.js'
import { createKnowledgeRepoWriter } from './knowledge/repo-writer.js'
import { knowledgeRoutes, workspaceKnowledgeRoutes } from './routes/knowledge.js'
import { getBranchHead, getRepoTree, getFileContents, compareCommits, getRepoPermissions } from './github/client.js'
import { startBrainStreamFanout } from './brain-stream/sse-fanout.js'
import { brainStreamRoutes } from './routes/brain-stream.js'
import { publishSessionEvent, startSessionEventBus, subscribeSessionEvents } from './session-event-bus.js'
import { createDbMcpSettingsStore } from './db/mcp-settings-store.js'
import { createDbConnectorStore } from './db/connector-store.js'
import { createConnectorInstanceStore } from './db/connector-instance-store.js'
import { createWorkspaceToolPolicyStore } from './db/workspace-tool-policy-store.js'
import { buildOpenSyncCredentials } from './build-sync-credentials.js'
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
import { createWorkflowLifecycleWorker } from './workers/workflow-lifecycle-worker.js'
import {
  createGeminiWorkflowDigestLLM,
} from './workers/workflow-digest-llm.js'
import { buildWorkspaceCuratorScope } from './workers/workspace-curator-scope.js'
import { loadSkillRegistry } from './registry/load-skill-registry.js'
import { handleRoutes } from './routes/handles.js'
import { connectionRoutes } from './routes/connections.js'
import { connectorRoutes } from './routes/connectors.js'
import { discoverRoutes } from './routes/discover.js'
import { createModesRouter } from './routes/modes.js'
import { pendingMessageRoutes } from './routes/pending-messages.js'
import { channelsRoutes } from './routes/channels.js'
import { whatsappByonRoutes } from './routes/whatsapp-byon.js'
import { whatsappIngestAdminRoutes } from './routes/whatsapp-byon-admin.js'
import { telegramByoRoutes } from './routes/telegram-byo.js'
import { slackRoutes } from './routes/slack.js'
import { discordRoutes } from './routes/discord.js'
import { msteamsRoutes } from './routes/msteams.js'
import { telegramLinkingRoutes } from './routes/telegram-linking.js'
import { slackLinkingRoutes } from './routes/slack-linking.js'
import { createDbChannelUserStore } from './db/channel-user-store.js'
import { createDiscordConnectorClient } from './discord/connector-client.js'
import { createWhatsappConnectorClient } from './whatsapp/connector-client.js'
import { createWhatsappByonRuntime } from './whatsapp/byon-runtime.js'
import { createIngestRulesStore } from './db/ingest-rules-store.js'
import { createIngestRuleEditorStore } from './db/ingest-rules-editor-store.js'
import { processChannelMessage } from './routes/channel-pipeline.js'
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
import { createDbGoalStore } from './db/goals-store.js'
import { createGoalRollupRunner } from './goals/rollup-runner.js'
import { createGoalDriver, parseGoalTick, GOAL_TICK_KIND, INITIAL_GOAL_LOOP_STATE, type GoalLoopState } from './goals/driver.js'
import { createGoalStallReaper } from './goals/reaper.js'
import { createGoalWorkTools } from './goals/work-tools.js'
import { gatherGoalEvidence } from './goals/evidence.js'
import { listUsableWorkspaceConnectors } from './connectors/usable-connectors.js'
import { type GoalDeliver } from './goals/writeback.js'
import {
  tryClaimGoalForTick,
  getGoalByIdSystem,
  updateGoalSystem,
  getGoalAwaitingEventSystem,
  setGoalAwaitingEventSystem,
  clearGoalAwaitingEventSystem,
  findEventWaitingGoalsSystem,
} from './db/goals.js'
import { goalsRoutes } from './routes/goals.js'
import { createDbCrmStore } from './db/crm-store.js'
import { createDbWorkspaceFilesStore } from './db/workspace-files-store.js'
import { getWorkspaceFileById } from './db/workspace-files.js'
import { createGcsFilesClient } from './files/gcs-client.js'
import { createLocalFilesClient } from './files/local-files-client.js'
import { createFilesApi, createSingletonFilesClientResolver, type FilesClientResolver } from './files/files-api.js'
import { createSearchFileContentTool } from './files/file-artifact-tools.js'
import {
  createChatSearchRecordingTool,
  createListRecordingsTool,
} from './recordings/recording-chat-tools.js'
import { createArtifactPromoter } from './files/artifact-promote.js'
import { createFileIngestor } from './files/ingest-file.js'
import { createFileIngestWorker } from './files/file-ingest-worker.js'
import { enqueueFileIngestJob, claimNextFileIngestJob, markFileIngestJobDone, markFileIngestJobFailed } from './db/file-ingest-jobs-store.js'
import { createCachedByoFilesResolver, type WorkspaceStorageBinding } from './files/byo-files-resolver.js'
import { sweepStaleByoBindings } from './files/byo-staleness.js'
import {
  createDbWorkflowStore,
  createDbWorkflowRunStore,
  getRunIdForStepRun,
  findEventTriggeredWorkflowsSystem,
  getWorkflowCreatorSystem,
  getPrimaryAssistantForWorkspace,
  createWorkflowRunQueueStore,
  countRecentRunsForWorkflowSystem,
  pauseWorkflowSystem,
  listLifecycleSweepRowsSystem,
  applyLifecycleTransitionSystem,
  markWorkflowsDigestedSystem,
  deleteWorkflowSystem,
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
import { modelMenuRoutes } from './routes/model-menu.js'
import { pageActionsRoutes } from './routes/page-actions.js'
import { workflowWebhookRoutes } from './routes/workflow-webhooks.js'
import { createWorkflowChannelDelivery } from './workflow/channel-delivery.js'
import { createWorkflowDependencyPreflight } from './workflow/dependency-preflight.js'
import { createDeliveryTargetResolver } from './scheduling/delivery-target.js'
import { viewsRoutes } from './routes/views.js'
import { teamspacesRoutes } from './routes/teamspaces.js'
import { createTeamspaceStore } from './db/teamspace-store.js'
import { decksRoutes } from './routes/decks.js'
import { createDeckStore } from './db/deck-store.js'
import { publicShareRoutes } from './routes/public-share.js'
import { publicSiteRoutes } from './routes/public-sites.js'
import { createDomainProvisioner } from './domains/provisioner.js'
import { deriveOwnApexBlocks, deriveReservedSubdomainLabels } from '@use-brian/shared/page-slugs'
import { createEmailInboxProvider, setGlobalEmailInboxProvider } from './agentmail/provider.js'
import { docThemesRoutes } from './routes/doc-themes.js'
import { runIngestPage } from './doc/ingest-page-runner.js'
import { internalIngestRoutes } from './doc/internal-ingest-route.js'
import { internalPageEventRoutes } from './doc/internal-page-event-route.js'
import { createDbDocPageSourceStore } from './db/doc-page-source-store.js'
import { createDbSavedViewStore } from './db/saved-views-store.js'
import { publishPageLifecycle, setPageEventDispatcher } from './page-event-fanout.js'
import { setMediaTokenSecret } from './media-token.js'
import { setTaskEventDispatcher } from './task-event-fanout.js'
import { createRecordingSynthesizer, type RecordingSynthesizeFn } from './synthesis/recording-synthesizer.js'
import { createResearchSynthesizer } from './synthesis/research-synthesizer.js'
import { createGenerateSynthesizer, type GenerateSynthesizeFn } from './synthesis/generate-synthesizer.js'
import { createGenerateBlueprintTool } from './synthesis/generate-blueprint-tool.js'
import {
  buildBlueprintSurfacePrompt,
  createBlueprintRecordTools,
} from './synthesis/blueprint-record-tools.js'
import { createDbPageGrantStore } from './db/page-grant-store.js'
import { createDbPageDomainStore } from './db/page-domain-store.js'
import { createDbPageTemplateStore } from './db/page-templates-store.js'
import { createDbBlueprintRecordStore } from './db/blueprint-records-store.js'
import { createDbPageActionsStore } from './db/page-actions-store.js'
import { createDbPageSendLogStore } from './db/page-send-log-store.js'
import { createGmailSendSeam } from './google/send-seam.js'
import { createSendPagePort } from './workflow/send-page.js'
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
import { createDbEpisodesStore, getEpisodeByIdSystem } from './db/episodes-store.js'
import { createDbEntityLinksStore } from './db/entity-links-store.js'
import {
  createDbEntitiesStore,
  reclassifyEntityKind as reclassifyEntityKindFn,
  promoteEntityToCrm as promoteEntityToCrmFn,
} from './db/entities-store.js'
import { createClassifierSelfHealWorker } from '@use-brian/core'
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
  // Optional because the Gemini provider can be Vertex-backed instead (see
  // VERTEX_PROJECT_ID). A deployment in a region where Google blocks the AI
  // Studio developer API (e.g. Hong Kong) has no such key; the open entry
  // requires GEMINI_API_KEY *or* VERTEX_PROJECT_ID.
  GEMINI_API_KEY?: string
  // Vertex AI backing for the `gemini` provider. When VERTEX_PROJECT_ID is set,
  // boot builds the gemini transport against Vertex (regional host + OAuth)
  // instead of AI Studio. Credentials come from the metadata server (ADC)
  // unless VERTEX_SERVICE_ACCOUNT_JSON holds a full service-account key.
  // VERTEX_LOCATION picks host + regional quota pool (default asia-east2).
  VERTEX_PROJECT_ID?: string
  VERTEX_LOCATION?: string
  VERTEX_SERVICE_ACCOUNT_JSON?: string
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
  // Optional OpenAI-compatible endpoint key (DashScope international — the
  // wave-1 Qwen/DeepSeek models). Absent ⇒ those models are absent from
  // routing and every menu (model-registry plan L12); the base URL is a
  // constant in the provider module, never an env var.
  DASHSCOPE_API_KEY?: string
  // Optional DashScope base-URL override. Unset = the international (Singapore)
  // endpoint. Set to the Beijing host (https://dashscope.aliyuncs.com/compatible-mode/v1)
  // for a mainland-China deployment. Applies to Qwen chat, embeddings, and media.
  DASHSCOPE_BASE_URL?: string
  // Optional connector / channel config (closed-secret gated; open passes none).
  GOOGLE_CLIENT_ID?: string
  CHANNEL_CREDENTIAL_KEY?: string
  TELEGRAM_BOT_TOKEN?: string
  GMAIL_SMTP_USER?: string
  GMAIL_SMTP_APP_PASSWORD?: string
  EMAIL_FROM_ADDRESS?: string
  WA_CONNECTOR_URL?: string
  WA_CONNECTOR_SECRET?: string
  /**
   * Discord Gateway connector bridge (`apps/discord-connector` or a
   * compatible self-hosted bridge). Both set → the Discord connect endpoint
   * works and `/internal/discord/inbound` is mounted; unset → Discord
   * connect returns 503 and the inbound route is absent.
   */
  DISCORD_CONNECTOR_URL?: string
  DISCORD_CONNECTOR_SECRET?: string
  LLM_PROVIDER_KEY_ENCRYPTION_KEY?: string
  // Blob storage (open uses local-disk fallback when unset).
  GCS_FILES_BUCKET?: string
  // Weekly skill-hygiene passes ship dark unless on.
  SKILLS_AUTO_GEN_ENABLED?: boolean
  // Workflow staleness/digestion/archival sweep ships dark unless on.
  WORKFLOW_LIFECYCLE_ENABLED?: boolean
  // Computer-use local mode (docs/architecture/engine/computer-use.md §4):
  // the browser-relay's HTTP base + shared secret. Unset (open default) →
  // the local browser backend reports not_configured.
  BROWSER_RELAY_URL?: string
  BROWSER_RELAY_SECRET?: string
  // Computer-use cloud mode (§5): E2B Cloud credentials + the pre-baked
  // sandbox template (agent-browser + python3 + unshare). Unset → the cloud
  // backend reports not_configured and routing falls back to local.
  E2B_API_KEY?: string
  E2B_TEMPLATE_ID?: string
  // The watched browser-use exploration's model (§4 — the browser-grounding
  // leg rides a cheap tier). Optional; defaults per available key below.
  BROWSER_USE_MODEL?: string
  // Barrier 2 (§4.9): the deploy flag for the unattended acting path. The
  // flag is necessary but NOT sufficient — boot also requires live metering
  // (resolveUnattendedComputerUse). Ships dark.
  COMPUTER_USE_UNATTENDED_ENABLED?: boolean
  // Custom domains for published pages (migration 324;
  // docs/architecture/features/custom-domains.md). Vercel pair set → hosted
  // provisioner; else manual-DNS verification against the CNAME target.
  PAGE_DOMAIN_VERCEL_TOKEN?: string
  PAGE_DOMAIN_VERCEL_PROJECT_ID?: string
  PAGE_DOMAIN_VERCEL_TEAM_ID?: string
  PAGE_DOMAIN_CNAME_TARGET?: string
  PAGE_DOMAINS_MAX_PER_WORKSPACE?: string
  // Comma-separated hostnames customers may NOT attach as custom domains —
  // exact hosts or `.suffix` entries (e.g. `.example-status.io`). Boot always
  // also blocks the deployment's own origin hosts (derived from
  // API_URL/APP_URL/AUTHED_APP_URL); this adds policy on top. No hostname
  // policy lives in code.
  PAGE_DOMAIN_BLOCKED_HOSTS?: string
  // Platform-issued workspace subdomains (docs/architecture/features/
  // platform-subdomains.md). Customer subdomains → CUSTOMER_SUBDOMAIN_APEX;
  // first-party workspaces (FIRST_PARTY_SUBDOMAIN_WORKSPACE_IDS, comma list) →
  // PLATFORM_SUBDOMAIN_APEX. Either apex unset = that half dark.
  // PLATFORM_SUBDOMAIN_RESERVED adds reserved labels (comma list).
  CUSTOMER_SUBDOMAIN_APEX?: string
  PLATFORM_SUBDOMAIN_APEX?: string
  FIRST_PARTY_SUBDOMAIN_WORKSPACE_IDS?: string
  PLATFORM_SUBDOMAIN_RESERVED?: string
  // AgentMail assistant-owned email (docs/architecture/integrations/agentmail.md).
  // Hosted passes the platform org key; OSS/self-host passes a BYO key. Unset
  // (open default) → the email surface is dark: inbox provisioning routes 503,
  // the /webhook/agentmail route is not mounted, the UI hides the section.
  AGENTMAIL_API_KEY?: string
}

/**
 * The store handles a closed Pipeline-B ingestor factory needs. Boot builds
 * these and hands them to the platform's `buildEpisodeIngestors` factory so the
 * real ingestors run against the SAME store graph the routes use. Open default:
 * the factory is absent → no-op ingestors (dreaming still runs on memoryStore).
 */
export interface EpisodeIngestorDeps {
  provider: LLMProvider
  /**
   * The background lane's servable model id, resolved once at boot against the
   * configured providers. Absent = the caller had no boot context (tests, the
   * platform factory pre-dating this) and the ingestor keeps its own default.
   */
  backgroundModel?: string
  /** Same, for the chat-class extraction model Pipeline B runs episodes through. */
  extractionModel?: string
  crmStore: ReturnType<typeof createDbCrmStore>
  entitiesStore: ReturnType<typeof createDbEntitiesStore>
  entityLinksStore: ReturnType<typeof createDbEntityLinksStore>
  memoryStore: ReturnType<typeof createDbMemoryStore>
  taskStore: ReturnType<typeof createDbTaskStore>
  episodesStore: ReturnType<typeof createDbEpisodesStore>
  analytics: AnalyticsLogger
  /**
   * Usage recorder threaded into Pipeline B so extraction LLM calls land
   * as `overhead:extraction` rows. Absent in OSS (no usage store) — the
   * pipeline then skips recording.
   */
  usageStore?: UsageStore
  /**
   * Bulk-ingest surcharge hook threaded into Pipeline B (`ingestCharge`),
   * fired once per successfully-extracted episode. The platform's
   * implementation prices by source kind (0.5-credit bulk-ingest item,
   * idempotent per episode); absent in OSS — ingest stays uncharged.
   */
  ingestCharge?: (episode: { id: string; workspaceId: string; sourceKind: string; createdByUserId: string }) => Promise<void>
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
  /**
   * Bulk-ingest surcharge hook (0.5-credit bulk-ingest item, priced +
   * ledgered platform-side, idempotent per episode). Threaded into every
   * Pipeline B wiring; default absent — OSS ingest is uncharged.
   */
  ingestCharge?: (episode: { id: string; workspaceId: string; sourceKind: string; createdByUserId: string }) => Promise<void>
  /**
   * Metered model lane billing (model-registry.md L8/L15) — the closed
   * `5 + ceil(cost/$0.020)` estimate / spend-cap / charge seams. Default
   * absent: the OSS build serves metered-class picks unbilled (self-host
   * pays its own provider bill) and the UI hides credit figures.
   */
  meteredBilling?: {
    estimateMeteredTurn: (modelAlias: string, toolRounds: number) => { modelAlias: string; toolRounds: number; minCredits: number; maxCredits: number } | null
    checkMeteredSpendCap: (workspaceId: string) => Promise<{ allowed: boolean; usedCredits: number; capCredits: number }>
    chargeMeteredSurcharge: (params: { workspaceId: string; requestId: string; modelAlias: string; profileId?: string | null; toolRounds?: number | null; modelCostUsd: number; chargedByUserId?: string | null }) => Promise<{ charged: boolean; credits: number }>
  }

  // ── Feed/distribution host hooks — open default: inert ──
  injectExtraTools?: InjectExtraTools
  resolveExtraSystemPrompt?: (session: { mode: string | null; channelType: string }) => string | null
  resolveAppSoul?: ResolveAppSoul

  // ── Tool-use hooks (remote MCP preflight) — open default: unset ──
  /**
   * Pre/post interception around remote MCP tool calls. `preToolUse` can
   * inject/overwrite outbound headers, rewrite args, or block; `postToolUse`
   * observes. The platform supplies the config-driven impl; open build
   * leaves it unset (no interception). See
   * `docs/architecture/engine/tool-hooks.md`.
   */
  engineHooks?: EngineHooks

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

  // ── Computer use (closed halves) — open default: undefined ──
  /**
   * The encrypted session vault (§4.4, R2-4) — closed impl over
   * `browser_sessions` (envelope-encrypted, profile-scoped RLS). Absent →
   * cloud browsing works but no session reuse: every login-guarded task
   * needs a fresh Take-Over.
   */
  browserSessionVault?: SessionVault
  /**
   * Durable sandbox-task ledger (§4.10) — closed impl over `sandbox_tasks`.
   * Absent → in-memory task binding (fine for OSS; a restart just costs a
   * fresh sandbox, the vault holds the durable session).
   */
  sandboxTaskStore?: SandboxTaskStore
  /**
   * Browser profiles (R2-4) — closed impl over `browser_profiles`. Absent →
   * identity-less browsing only (no profile gate, no session reuse,
   * Profile-Management reports unconfigured).
   */
  browserProfileStore?: BrowserProfileStore
  /**
   * Block-scoped grants (R2-2) — closed impl over `browser_skill_grants`.
   * Absent → every terminal send a logic-block reaches queues async.
   */
  browserSkillGrantStore?: BrowserSkillGrantStore

  // ── Closed stores fronted as ports — open default: undefined (routes guard) ──
  /** Self-heal candidate queue; absent → reclassification + self-heal worker off. */
  brainCandidateStore?: BrainCandidateStore
  /** Closed pending-classification queue; absent → self-heal worker stays off. */
  pendingClassificationStore?: PendingClassificationStore
  /** Google-Drive knowledge-file store; absent → gdrive files unavailable to chat/workflow. */
  gdriveFilesStore?: GDriveFilesStore
  /**
   * Builds the closed GitHub-PAT resolver for the knowledge sync worker over
   * boot's connector stores (the same stores the knowledge route resolves edit
   * proposals through). Open default: unset → the worker ticks but every GitHub
   * source fails resolution with a clear "not configured" error rather than
   * syncing.
   */
  buildSyncCredentials?: (deps: {
    connectorInstanceStore: ReturnType<typeof createConnectorInstanceStore>
    connectorGrantStore: Awaited<
      ReturnType<typeof import('./db/connector-grant-store.js').createConnectorGrantStore>
    >
  }) => SyncCredentials

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

  /**
   * Closed enrichments for the (open) BYO channel runtime. The channel routes
   * — workspace channels management, Telegram/Slack webhooks, the Discord
   * connector inbound — are mounted by `bootOpenApi` itself for BOTH editions;
   * this factory lets the hosted platform bind the parts that stay closed:
   * Pipeline-C Slack ingest, GCS channel-media intake, and the
   * recording-to-brain surcharge pipeline. Called right after `BootContext`
   * assembly (same effective mount position the closed app used). Open build
   * leaves it unset → chat over channels works, those enrichments are inert.
   */
  buildChannelHosts?: (ctx: BootContext) => ChannelHostHooks | Promise<ChannelHostHooks>

  /** Hosted has a pending-ingest batch worker; OSS executes WhatsApp realtime. */
  whatsappScheduledBatching?: boolean
  /** A later closed router owns the hosted shared-number fallback. */
  whatsappOfficialFallback?: boolean

  // ── Extension hook: the platform mounts its closed routes/workers ──
  mountExtraRoutes?: (app: Express, ctx: BootContext) => void | Promise<void>

  /**
   * Extension hook for PUBLIC (unauthenticated / optionalAuth) closed routes
   * that must register BEFORE the bare `app.use('/api', requireAuth(...), …)`
   * guards below (workflow / approvals / views / doc-* …). `mountExtraRoutes`
   * runs LAST, so a public `/api/*` route mounted there is shadowed by those
   * guards — Express runs path-prefix middleware in registration order, so the
   * first bare `/api` `requireAuth` 401s the request before the later router is
   * reached. The Telegram Mini App verify endpoint (`/api/telegram/mini-app/
   * verify`) regressed exactly this way at the open-core cutover. This hook
   * runs early — before any bare `/api` guard — so such routes win the match.
   *
   * Receives only the stores already built at that early point (see
   * `PublicExtraRouteDeps`); full `BootContext` is not assembled yet.
   */
  mountPublicExtraRoutes?: (app: Express, deps: PublicExtraRouteDeps) => void | Promise<void>
}

/**
 * Stores available to `mountPublicExtraRoutes` at its early call site. Kept
 * deliberately narrow: only the handful built before the bare `/api` guards.
 * Add a field here when a new public closed route needs a store the open boot
 * already created by that point.
 */
export interface PublicExtraRouteDeps {
  linkedAccountStore: ReturnType<typeof createDbLinkedAccountStore>
  integrationStore: ReturnType<typeof createDbChannelIntegrationStore> | null
  workspaceStore: ReturnType<typeof createWorkspaceStore>
}

export interface BootOpenApiOptions {
  env: OpenApiEnv
  ports?: OpenApiPorts
  /** Default true; gates the background workers (consolidation, pollers, …). */
  runWorkers?: boolean
}

/**
 * Hosted-only enrichments the platform injects into the open channel routes
 * via `OpenApiPorts.buildChannelHosts`. Every field is optional — the OSS
 * edition runs the channel routes without any of them.
 */
export interface ChannelHostHooks {
  /** Pipeline-C rules-engine ingest for Slack channel traffic (closed). */
  slackWebhookIngestor?: import('./routes/slack.js').SlackWebhookIngestor
  /** Pipeline-C rules-engine ingest for Microsoft Teams channel traffic (closed). */
  msteamsWebhookIngestor?: import('./routes/msteams.js').MsTeamsWebhookIngestor
  /** GCS channel-media intake for Slack pulled attachments (closed). */
  slackIngestChannelMediaRef?: Parameters<typeof slackRoutes>[0]['ingestChannelMediaRef']
  /** GCS channel-media intake for Discord attachments (closed). */
  discordIngestChannelMediaRef?: Parameters<typeof discordRoutes>[0]['ingestChannelMediaRef']
  /** GCS channel-media intake for Telegram BYO files (closed; the official
   *  shared-bot route stays closed and uses the same closed builder). */
  telegramIngestChannelMediaRef?: Parameters<typeof telegramByoRoutes>[0]['ingestChannelMediaRef']
  /** Recording-to-brain transcription + credit surcharge (closed). */
  recordingIngest?: import('./routes/telegram-byo.js').ChannelRecordingIngest
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
  /**
   * Tool-use interception port (remote MCP only), surfaced so closed routes
   * mounted via `mountExtraRoutes` (the channel webhooks → `processChannelMessage`)
   * can forward it into their own `injectMcpTools` call. Open default = unset.
   * See `docs/architecture/engine/tool-hooks.md`.
   */
  engineHooks?: EngineHooks
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
  workspaceToolPolicyStore: ReturnType<typeof createWorkspaceToolPolicyStore>
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
  /** Structural-synthesis callback for the recording path (blueprint → brief page). */
  recordingSynthesize?: RecordingSynthesizeFn
  /** Structural-synthesis GENERATE callback (fill a blueprint from the brain). */
  generateSynthesize?: GenerateSynthesizeFn
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
  /** Channel shadow-identity store — shared with the closed official-bot / WhatsApp routes. */
  channelUserStore: ReturnType<typeof createDbChannelUserStore>
  ingestRulesStore: ReturnType<typeof createIngestRulesStore>
  gdriveFilesStore: GDriveFilesStore | undefined
  filesApi: ReturnType<typeof createFilesApi> | null
  entityKindClassifier: ReturnType<typeof createEntityKindClassifier>
  workflowEventDispatcher: WorkflowEventDispatcher
  voiceTranscription: { enabled: boolean; apiKey: string; backend?: MediaBackend; model: string | undefined }
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
  // Bind the media-token signing secret for the channel pipeline's actor
  // media tokens (late-bound seam — see media-token.ts).
  setMediaTokenSecret(env.JWT_SECRET)

  const app = express()
  const port = parseInt(env.PORT || new URL(env.API_URL).port || '4000')

  // ── Middleware: raw-body capture + JSON ──
  // 15mb ceiling: the WhatsApp connector forwards inbound media inline as
  // base64 (`/internal/whatsapp/inbound`) up to a 10MB raw cap, which inflates
  // to ~13.4MB encoded plus JSON envelope. Express's default 100kb limit 413s
  // any media-bearing message, silently dropping it from ingest. Other routes
  // post small JSON, so the higher ceiling only matters for that relay.
  app.use(express.json({
    limit: '15mb',
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
  // ── Google/Vertex transport + shared embedder (built once) ──
  // Vertex when a GCP project is configured (Google blocks AI Studio in some
  // regions, e.g. Hong Kong; Vertex reaches Gemini there), else the AI Studio
  // key. The same transport backs the `gemini` chat provider (below), the
  // shared embedder, and the media backend, so one OAuth-token cache serves
  // all three. See docs/architecture/engine/provider-abstraction.md.
  // DashScope host: international (Singapore) by default; override to the
  // Beijing endpoint for mainland China. Shared by Qwen chat, embeddings, media.
  const dashscopeBaseUrl = env.DASHSCOPE_BASE_URL || DASHSCOPE_INTL_BASE_URL
  const vertexTx: GoogleTransport | undefined = env.VERTEX_PROJECT_ID
    ? vertexTransport({
        project: env.VERTEX_PROJECT_ID,
        location: env.VERTEX_LOCATION || 'asia-east2',
        tokenSource: resolveVertexTokenSource(env.VERTEX_SERVICE_ACCOUNT_JSON),
      })
    : undefined
  const geminiTransport = vertexTx ?? env.GEMINI_API_KEY

  // One embedder for the whole process (was reconstructed at ten sites).
  // Embeddings default to Google (gemini-embedding-001, the registry's
  // embedding rows) via Vertex or AI Studio; a pure-Qwen deployment with no
  // Google credential falls back to DashScope text-embedding-v3. Vectors from
  // different vendors are NOT comparable — each embedder reports a distinct
  // model_id and switching requires a full re-embed.
  const embedderConfig: EmbedderAdapterConfig = vertexTx
    ? { adapter: 'vertex', transport: vertexTx }
    : env.GEMINI_API_KEY
      ? { adapter: 'google-ai-studio', apiKey: env.GEMINI_API_KEY }
      : { adapter: 'alicloud', apiKey: env.DASHSCOPE_API_KEY ?? '', baseUrl: dashscopeBaseUrl }
  const sharedEmbedder = createEmbedderForAdapter(embedderConfig)

  // Media backend for file distillation + short-audio transcription. Google
  // (Gemini inlineData) via Vertex or AI Studio; a pure-Qwen deployment uses
  // DashScope (Qwen-VL for documents, Qwen-ASR for audio). DashScope is
  // image-only for documents — PDFs are refused there, see media/backend.ts.
  const mediaBackend: MediaBackend = vertexTx
    ? { kind: 'google', transport: vertexTx }
    : env.GEMINI_API_KEY
      ? { kind: 'google', transport: aiStudioTransport(env.GEMINI_API_KEY) }
      : { kind: 'dashscope', apiKey: env.DASHSCOPE_API_KEY ?? '', baseUrl: dashscopeBaseUrl }

  const voiceTranscription = {
    enabled: env.VOICE_TRANSCRIPTION_ENABLED ?? false,
    apiKey: env.GEMINI_API_KEY ?? '',
    backend: mediaBackend,
    model: env.VOICE_TRANSCRIPTION_MODEL,
  }
  const memoryStore = createDbMemoryStore()
  const brainCandidateStore = ports.brainCandidateStore
  const memoryRecallEventsStore = createMemoryRecallEventsStore()
  const goalStore = createDbGoalStore()
  // Terminal delivery for a goal (done | blocked) — the workspace primary
  // assistant messages the creator (sanitized by deliverToChannel). Shared by
  // the structural rollup AND the acting-loop driver (no silent termination,
  // goals.md §7).
  const deliverGoalTerminal: GoalDeliver = async (goal, terminal, reason) => {
    if (!goal.createdByUserId) return
    // Terminal analytics (goal_done / goal_blocked): this seam is the one place
    // BOTH terminal paths (acting loop + structural rollup) converge, so the
    // taxonomy is covered without touching either loop. Emit before the channel
    // delivery so a delivery failure never loses the event.
    analytics.logEvent({
      userId: goal.createdByUserId,
      channelType: 'workflow',
      eventName: terminal === 'done' ? 'goal_done' : 'goal_blocked',
      metadata: {
        goal_id: sanitizeAnalytics(goal.id),
        ...(reason ? { reason: sanitizeAnalytics(reason) } : {}),
      },
    })
    const assistantId = await getPrimaryAssistantForWorkspace(goal.workspaceId)
    if (!assistantId) return
    const text =
      terminal === 'done'
        ? `Goal done: ${goal.outcome}`
        : reason === 'unconfirmed_needs_clarification'
          ? `I tried to work a task but its goal isn't confirmed yet: "${goal.outcome}". Confirm the goal and I'll proceed.`
          : `Goal blocked${reason ? ` (${reason})` : ''}: ${goal.outcome}`
    await deliverToChannel({ assistantId, userId: goal.createdByUserId, text, channelType: 'web' })
  }
  // Structural goal-seeker rollup: when a sub-task closes, complete any
  // task-hosted goal whose `subtasks` done_when is now met (no acting loop, no
  // metering).
  const goalRollup = createGoalRollupRunner({
    goalStore,
    deliverGoalDone: (goal) => deliverGoalTerminal(goal, 'done', null),
  })
  // Task autopilot v2 (task-goal-autopilot.md §8): a top-level task create no
  // longer mints a templated draft. The triage judge (one background-tier LLM
  // call: "can the assistant honestly help?") drafts a goal WITH a brief only
  // on a pass. The judge needs the provider + usage stores, constructed later
  // in boot, so the hook calls through this late-bound ref. Null (OSS keyless,
  // or before wiring) = no drafting — fail-closed by design.
  let judgeTaskForGoal: ((task: TaskRecord, userId: string) => void) | null = null
  const taskStore = createDbTaskStore({
    onTaskTerminal: goalRollup.onTaskTerminal,
    onTaskCreate: (task, userId) => {
      judgeTaskForGoal?.(task, userId)
    },
  })
  const crmStore = createDbCrmStore()
  const workspaceFilesStore = createDbWorkspaceFilesStore()
  const workflowStore = createDbWorkflowStore()
  const workflowRunStore = createDbWorkflowRunStore()
  const pendingApprovalsStore = createPendingApprovalsStore()
  // `onPageLifecycle` feeds page create / update / move into the workflow
  // event-trigger dispatcher (the `page` event source). `publishPageLifecycle`
  // is a no-op until the dispatcher is bound via `setPageEventDispatcher`
  // (closed app boot) — see page-event-fanout.ts.
  const savedViewStore = createDbSavedViewStore({ onPageLifecycle: publishPageLifecycle })
  const pageTemplateStore = createDbPageTemplateStore()
  // Blueprint RECORDS (migration 307) — the typed output of every document-
  // blueprint fill; pages are per-surface projections of these rows.
  const blueprintRecordStore = createDbBlueprintRecordStore()
  const homeDockStore = createDbHomeDockStore()
  const docEntityStore = createDbDocEntityStore()
  const pageGrantStore = createDbPageGrantStore()
  const pageDomainStore = createDbPageDomainStore()
  const domainProvisioner = createDomainProvisioner(env)
  // Assistant Email vendor seam — bind the late-bound global once so every
  // injectMcpTools call site (chat, channels, workflows, public API) sees the
  // assistant-mailbox tools when AGENTMAIL_API_KEY is set. Null (default) =
  // the surface stays dark. See agentmail/provider.ts.
  setGlobalEmailInboxProvider(
    createEmailInboxProvider({ AGENTMAIL_API_KEY: env.AGENTMAIL_API_KEY }),
  )
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
      embedder: sharedEmbedder,
    }),
    provenance: createDbProvenanceStore(),
    aggregate: createDbAggregateStore(),
    markUseful: createDbMarkUsefulStore(),
    rowHistory: createDbRowHistoryStore(),
  })

  const retrievalMissStore = createDbRetrievalMissStore()
  const kbGapCandidateStore = createDbKbGapCandidateStore()
  const _detectorEmbedder = sharedEmbedder
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
  //
  // Registry-routed (docs/architecture/platform/model-registry.md): one
  // wrapped instance per configured provider key; the routing provider
  // dispatches per request on the model's registry row. A missing key means
  // that provider's models are simply absent (plan L12) — the ONLY env
  // gates here are the provider API keys (+ the pre-existing
  // FALLBACK_PROVIDER_ENABLED toggle for the Claude outage fallback).
  // Same-class fallback (registry `fallbackAlias`, plan L2) replaces the
  // old whole-provider wrapFallback: standard-pro Gemini models fall back
  // to Claude Haiku; Max/Research/background rows have no same-class
  // fallback and now surface outages instead of silently swapping class.
  // `geminiTransport` (Vertex or AI Studio) was resolved once above and is
  // shared with the embedder + media backend. The registry still names this
  // provider `gemini`; a Vertex-backed instance serves the same rows.
  console.log(
    `[provider] gemini transport: ${vertexTx ? `vertex (${env.VERTEX_LOCATION || 'asia-east2'})` : 'ai-studio'}`,
  )

  // Gemini is registered only when it has a real credential (AI Studio key or
  // a Vertex project). Registering a keyless `gemini` would defeat the
  // registry's L12 rule — it would appear "configured", its models would show
  // in menus and be picked as the tier default, then 401 at call time. A
  // pure-Qwen deployment leaves it out entirely.
  const providerInstances: Record<string, LLMProvider> = {}
  if (env.GEMINI_API_KEY || env.VERTEX_PROJECT_ID) {
    providerInstances['gemini'] = wrapProvider(createGeminiProvider(geminiTransport))
  }
  if (env.FALLBACK_PROVIDER_ENABLED) {
    if (env.ANTHROPIC_API_KEY) {
      providerInstances['anthropic'] = wrapProvider(createAnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY }))
    } else {
      console.warn('[provider] FALLBACK_PROVIDER_ENABLED=true but ANTHROPIC_API_KEY is empty — running without the Claude fallback.')
    }
  }
  if (env.DASHSCOPE_API_KEY) {
    providerInstances[`openai-compat:${DASHSCOPE_INTL_LABEL}`] = wrapProvider(
      createOpenAICompatProvider({ apiKey: env.DASHSCOPE_API_KEY, baseURL: dashscopeBaseUrl, label: DASHSCOPE_INTL_LABEL }),
    )
  }
  // Selection-surface derivations (model-registry.md L10/L12): which
  // provider keys exist decides which models exist — menus and the chat
  // route's metered gate both consume these, so a keyless model is absent
  // everywhere at once.
  const configuredProviders: ReadonlySet<string> = new Set(Object.keys(providerInstances))
  const meteredModelsAvailable: ReadonlySet<string> = new Set(
    menuForClass('metered', configuredProviders).map((r) => r.alias),
  )
  // The background lane is internal routing with no menu, so L12 can't drop a
  // keyless model out of it the way it does for chat: the id is baked into the
  // call sites. Resolve it once here and inject the result, or a deployment
  // without a Google credential loses every background job — auto-title, memory
  // splitting, classification, digests, themes, skill review. Logged because
  // this lane spends real money and shapes what the brain extracts, so which
  // model serves it should never be implicit.
  const backgroundModel = configuredProviders.size > 0
    ? ensureServableModel(BACKGROUND_MODEL, configuredProviders)
    : BACKGROUND_MODEL
  if (backgroundModel !== BACKGROUND_MODEL) {
    console.log(`[provider] background lane: ${backgroundModel} (${BACKGROUND_MODEL} not servable)`)
  }
  // Pipeline B's extraction model is chat-class, not background-class, but it
  // is hardcoded the same way and dies the same way without a Google key.
  const extractionModel = configuredProviders.size > 0
    ? ensureServableModel(EXTRACTION_MODEL, configuredProviders)
    : EXTRACTION_MODEL
  if (extractionModel !== EXTRACTION_MODEL) {
    console.log(`[provider] extraction: ${extractionModel} (${EXTRACTION_MODEL} not servable)`)
  }
  const provider: LLMProvider = createRoutingProvider(providerInstances, {
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

  const jobStore = createDbJobStore()
  const sessionResumeStore = createDbSessionResumeStore()
  const workerRunsStore = createDbWorkerRunsStore()
  const capabilityStore = createDbCapabilityStore()
  const mcpSettingsStore = createDbMcpSettingsStore()
  const credKey = env.CHANNEL_CREDENTIAL_KEY ? loadChannelCredentialKey(env.CHANNEL_CREDENTIAL_KEY) : null
  const connectorInstanceStore = createConnectorInstanceStore(credKey)
  // Shared workspace tool policy (migration 312) — governs allow/ask/block for
  // team-owned connector tools. See workspace-owned-connector-transfer.md §2C.
  const workspaceToolPolicyStore = createWorkspaceToolPolicyStore()
  const ingestRulesStore = createIngestRulesStore()
  const ingestRuleEditorStore = createIngestRuleEditorStore()
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
  const curatorEmbedder = sharedEmbedder
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
  // Channel shadow-identity resolution (channel_user_cache) — shared by the
  // open BYO webhooks mounted below and the closed official-bot/WhatsApp
  // routes (via BootContext).
  const channelUserStore = createDbChannelUserStore()

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
    // The oss single-player edition's consumer front door (not a dev bypass):
    // a neutral local-owner session the launcher opens. Gated to local + oss.
    if (isOssEdition()) {
      app.use(
        '/auth',
        localSessionRoutes({ jwtSecret: env.JWT_SECRET, ownerName: process.env.USEBRIAN_OWNER_NAME }),
      )
      console.log('[local-session] oss local-owner session enabled at /auth/local-session.')
    }
  }

  const { createConnectorGrantStore } = await import('./db/connector-grant-store.js')
  const connectorGrantStore = createConnectorGrantStore()
  const workspaceStore = createWorkspaceStore({ connectorGrantStore, channelRouteStore })
  const meteredProfileStore = createMeteredProfileStore()
  const modelDefaultsStore = createWorkspaceModelDefaultsStore()

  // ── KB sync-credential resolver ──
  // Resolves the GitHub PAT a synced knowledge source operates through, by
  // `(workspaceId, connectorInstanceId)`. The platform passes a closed factory
  // via `ports.buildSyncCredentials`; the open build falls back to a resolver
  // over the same connector stores (available in OSS since migration
  // 280_oss_connectors). Both the edit-proposal routes and the sync worker use
  // this single instance. See build-sync-credentials.ts.
  const syncCredentials: SyncCredentials = ports.buildSyncCredentials?.({
    connectorInstanceStore,
    connectorGrantStore,
  }) ?? buildOpenSyncCredentials({ connectorInstanceStore, connectorGrantStore })

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

  // ── Assistant KB repo writer ──
  // Direct-commit write-back for the KB write tools (updateKnowledgeEntry /
  // addKnowledgeEntry repo mode), over the same `syncCredentials` resolver
  // the sync worker and edit-proposal routes use. Only interactive,
  // confirmation-capable surfaces receive it (web chat here; the platform
  // channel pipeline builds its own) — see
  // docs/architecture/features/knowledge-base.md → "Assistant direct edits".
  const knowledgeRepoWriter = createKnowledgeRepoWriter({
    store: knowledgeStore,
    syncCredentials,
    recordEvent: ({ userId, eventName, metadata }) => {
      const safe: Record<string, number | boolean | undefined | ReturnType<typeof sanitizeAnalytics>> = {}
      for (const [k, v] of Object.entries(metadata)) {
        if (typeof v === 'number' || typeof v === 'boolean' || v === undefined) safe[k] = v
        else if (v === null) safe[k] = undefined
        else safe[k] = sanitizeAnalytics(String(v)) // ids / repo / sha / op — metadata-only, no content
      }
      analytics.logEvent({ userId, eventName, metadata: safe })
    },
  })

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
      // Record worker LLM COGS — the WorkerManager metering gap. COGS-only
      // (source 'included', no userMessageId → not credit-bearing), mirroring
      // workflow `assistant_call` turns. Guarded on usageStore: absent in OSS →
      // workers record nothing, which is also the acting-loop metering signal.
      // Fire-and-forget like every usageStore call.
      onUsage: usageStore
        ? (u) => {
            usageStore
              .recordUsage({
                userId: u.userId,
                assistantId: u.assistantId,
                sessionId: u.sessionId,
                model: u.model,
                inputTokens: u.usage.inputTokens,
                outputTokens: u.usage.outputTokens,
                cacheReadTokens: u.usage.cacheReadTokens,
                cacheWriteTokens: u.usage.cacheWriteTokens,
                actualCostUsd: calculateCost(u.model, u.usage),
                source: 'included',
                triggerKey: 'worker_run',
              })
              .catch((err) => console.error('[workers] usage tracking failed:', err))
          }
        : undefined,
    })
    const { spawnWorker, sendWorkerMessage, stopWorker } = createWorkerTools(workerManager)
    tools.set('spawnWorker', spawnWorker)
    tools.set('sendWorkerMessage', sendWorkerMessage)
    tools.set('stopWorker', stopWorker)

    const { createScheduledJob, updateScheduledJob, searchScheduledJobs, deleteScheduledJob } = createSchedulingTools({
      backgroundModel,
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
    // Per-file segment retrieval over stored artifacts (large-content-artifacts
    // §Phase 1.4). Registered in the base toolset so chat, the callee executor,
    // and workflows all carry it by construction; the actor is rebuilt from the
    // ToolContext per call, so read ceilings hold on every path.
    tools.set(
      'searchFileContent',
      createSearchFileContentTool({ embedder: sharedEmbedder }),
    )

    // The recording surface for chat, registered at the same seam and for the
    // same reason: chat, the callee executor, and workflows all carry it by
    // construction, and the actor is rebuilt from the ToolContext per call so
    // read ceilings hold everywhere.
    //
    // Two axes, neither redundant: listRecordings is TEMPORAL ("Tuesday's
    // call" — semantic search structurally cannot answer that), searchRecording
    // is PRECISION inside one recording (what was said, by whom, and WHEN, so
    // the model can cite the moment). Note this searchRecording takes
    // `recordingId` as a model INPUT — unlike the synthesis-loop twin in
    // recordings/recording-search-tool.ts, which pins it in the closure so that
    // loop cannot pivot off the recording it was told to summarize.
    tools.set(
      'searchRecording',
      createChatSearchRecordingTool({ embedder: sharedEmbedder }),
    )
    tools.set('listRecordings', createListRecordingsTool())

    // Bug report tool — the create sink is a port; open default returns a
    // synthetic id (no persistence). The platform injects its bug-report store.
    const reportBugTool = createReportBugTool({
      create: ports.createBugReport ?? (async () => ({ id: randomUUID() })),
    })
    tools.set('reportBug', reportBugTool)

    // Channel recording pre-flight confirm (channel-recording-preflight-confirm
    // §5). The agent-native commit for a BIG recording held at intake: the user
    // replies, the model calls this to enqueue (or cancel) via the existing
    // recording-jobs queue. A base engine tool, NOT an MCP connector tool.
    tools.set(
      'confirmRecordingProcessing',
      createConfirmRecordingProcessingTool({
        buildChannelSessionKey,
        getPending: async (recordingId) => {
          const row = await getPendingRecordingConfirmation(recordingId)
          return row
            ? {
                recordingId: row.recordingId,
                channelSessionKey: row.channelSessionKey,
                defaultBlueprintSlug: row.defaultBlueprintSlug,
              }
            : null
        },
        deletePending: deletePendingRecordingConfirmation,
        enqueueRecordingJob,
      }),
    )

    // Existing-file re-ingest + recording re-process — the user-reachable
    // recovery affordances (file-artifacts.md §"Re-ingest", transcription.md
    // §"Re-processing"). Both are thin wrappers over the EXISTING job queues;
    // both refuse to double-ingest silently: an already-ingested/processed
    // target requires a user-approved confirm relayed by the model.
    tools.set(
      'ingestFile',
      createIngestStoredFileTool({
        getFile: async (actor, fileId) => {
          const f = await getWorkspaceFileById(actor, fileId)
          return f
            ? {
                id: f.id,
                name: f.name,
                mime: f.mime,
                sizeBytes: f.sizeBytes,
                sourceEpisodeId: f.sourceEpisodeId,
              }
            : null
        },
        enqueue: enqueueFileIngestJob,
      }),
    )
    tools.set(
      'reprocessRecording',
      createReprocessRecordingTool({
        getRecording: async (actorUserId, recordingId) => {
          const ep = await getEpisodeByIdSystem(actorUserId, recordingId, {})
          return ep
            ? {
                id: ep.id,
                workspaceId: ep.workspaceId,
                sourceKind: ep.sourceKind,
                sourceRef: (ep.sourceRef ?? null) as Record<string, unknown> | null,
              }
            : null
        },
        hasProcessed: hasCompletedRecordingJob,
        enqueue: enqueueRecordingJob,
      }),
    )

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
    usageStore,
    backgroundModel,
    extractionModel,
    ingestCharge: ports.ingestCharge,
  })
  const chatEpisodeIngestor: ChatEpisodeIngestor =
    builtIngestors?.chatEpisodeIngestor ?? (async () => {})
  const brainEpisodeIngestor: BrainEpisodeIngestor | undefined = builtIngestors?.brainEpisodeIngestor

  // Structural-synthesis P4 — the RESEARCH fill. A research-tier `assistant_call`
  // step with a `blueprintId` + page anchor fills the blueprint into the anchored
  // page from the research gather. Built only when a model key is present (no key
  // → no synthesis; the step degrades to free-form authoring). Same stores as the
  // recording/generate synthesizers.
  const researchSynthesize = env.GEMINI_API_KEY
    ? createResearchSynthesizer({
        provider,
        model: 'gemini-flash',
        savedViewStore,
        docPageStore: createDbDocPageStore(),
        crmStore,
        taskStore,
        memoryStore,
        workflowRunStore,
        workspaceDirectory: workspaceDirectoryStore,
        usageStore,
        pageTemplateStore,
        blueprintRecordStore,
        computeCostUsd: (model, usage) => calculateCost(model, usage),
      })
    : undefined

  // Structural-synthesis GENERATE fill (brain → blueprint) + the in-chat /
  // in-workflow tool that wraps it. Built HERE (before the executor + chat route
  // consume it) with the embedder for brain vector search. Undefined without a
  // Gemini key. The standalone Blueprints-UI route meters its own credit
  // (synthesis_surcharge); the tool rides the chat turn's per-message credit.
  const generateSynthesize: GenerateSynthesizeFn | undefined = env.GEMINI_API_KEY
    ? createGenerateSynthesizer({
        provider,
        model: 'gemini-flash',
        savedViewStore,
        docPageStore: createDbDocPageStore(),
        crmStore,
        taskStore,
        memoryStore,
        workflowRunStore,
        workspaceDirectory: workspaceDirectoryStore,
        embedder: sharedEmbedder,
        usageStore,
        pageTemplateStore,
        blueprintRecordStore,
        computeCostUsd: (model, usage) => calculateCost(model, usage),
      })
    : undefined
  const generateBlueprintTool: Tool | undefined = generateSynthesize
    ? createGenerateBlueprintTool({ generateSynthesize, pageTemplateStore })
    : undefined

  // The blueprint output-contract direct surface: save/read records in-context
  // (no model run), define contracts from chat, discover what exists — plus
  // the dynamic "workspace blueprints" prompt section (closed-world: present
  // only when the workspace has blueprints, naming only what exists). Injected
  // into BOTH the chat route and the callee executor. Unlike the fill tool,
  // this needs no model key — records are plain rows.
  const blueprintRecordTools: Tool[] = createBlueprintRecordTools({
    pageTemplateStore,
    blueprintRecordStore,
    // Page-projection deps → builds `projectBlueprintRecordPage`, the one
    // workflow-reachable record→page linkage (page-actions buttons resolve
    // through `blueprint_records.page_id`).
    savedViewStore,
    docPageStore: createDbDocPageStore(),
  })
  const buildBlueprintPromptFragment = async (userId: string, workspaceId: string): Promise<string> => {
    try {
      const templates = await pageTemplateStore.list(userId, workspaceId)
      return buildBlueprintSurfacePrompt(templates)
    } catch (err) {
      console.warn('[boot] blueprint prompt fragment failed (skipped):', err)
      return ''
    }
  }

  // The on-demand introspection lane (ability audit §6-c/d): operational-
  // visibility reads for workspace primaries — pending approvals, scheduled
  // jobs, research runs, session history. The chat route passes these to
  // `applyMcpInjection` for primary turns only, where they become the
  // `introspection` mcp_search local source (discovered on demand, never
  // direct-injected). The platform build can append its closed-tree reads
  // (connector-actions audit, workspace-scoped analytics) to this array.
  // See docs/architecture/engine/introspection-tools.md.
  const { listSessionsForWorkspaceSystem, getSessionTranscriptForWorkspaceSystem } = await import(
    './db/sessions.js'
  )
  const introspectionTools: Tool[] = createIntrospectionTools({
    pendingApprovals: pendingApprovalsStore,
    scheduledJobs: jobStore,
    workerRuns: workerRunsStore,
    sessionHistory: { listSessionsForWorkspaceSystem, getSessionTranscriptForWorkspaceSystem },
  })

  // Declared here (assigned in the workspace-filesystem block below) so the
  // lazy references in the callee executor + workflow tool registry are
  // TDZ-safe: pre-assignment access reads `null` and degrades honestly.
  let filesApi: ReturnType<typeof createFilesApi> | null = null
  let filesResolver: FilesClientResolver | null = null
  let deckStore: ReturnType<typeof createDeckStore> | null = null

  const calleeExecutor = createCalleeExecutor({
    provider,
    tools: allTools,
    memoryStore,
    // Lazy getter: `filesApi` is assigned further down (the workspace-
    // filesystem block) — a direct reference here would freeze `null`.
    // The executor reads `options.filesApi` per call, post-boot.
    get filesApi() { return filesApi ?? undefined },
    // Brain retrieval store — enables the 6 read tools (recentEpisodes/search/
    // getEntity/...) on workflow `assistant_call` + free-mode consults, the
    // same surface the interactive chat route injects per-turn.
    retrievalStore,
    connectorStore,
    mcpSettingsStore,
    assistantConnectorStore,
    connectorGrantStore,
    connectorInstanceStore,
    workspaceToolPolicyStore,
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
    engineHooks: ports.engineHooks,
    savedViewStore,
    // Enables real parallel research-worker fan-out (with worker_runs rows) on
    // research-flagged no-page workflow steps. See workflow.md → "research fan-out".
    workerRunsStore,
    // Structural-synthesis P4 — fills a blueprint into the anchored page from the
    // research gather on a research step carrying a `blueprintId`.
    researchSynthesize,
    // Brain-skill surface for workflow `assistant_call` steps carrying a
    // `skills` allow-list — the callee gets `useSkill` over exactly those
    // skills via the shared `injectSkills` path. Absent → the step runs with
    // no skill surface. See workflow.md → "assistant_call skills".
    skillStore,
    workspaceSkillStore,
    workspaceSkillEnablementStore,
    workspaceSkillFilesStore,
    // Generate mode as a consult tool — fill a blueprint from the brain in a
    // workflow/callee run (same tool the chat route injects).
    generateBlueprintTool,
    // Record surface parity: the SAME record tools + dynamic blueprint prompt
    // chat injects (callee-path parity is load-bearing — workflow steps must
    // save/read records with the exact tools chat uses).
    blueprintRecordTools,
    buildBlueprintPromptFragment,
  })

  const { createAssistantModesStore } = await import('./db/assistant-modes-store.js')
  const assistantModesStore = createAssistantModesStore()

  const { createInProcessTransport } = await import('@use-brian/core')
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
        skills: request.skills,
        enforcedSkills: request.enforcedSkills,
        depth: request.depth,
        modelAlias: request.modelAlias,
        deliverTarget: request.deliver,
        pageAnchorId: request.pageAnchorId,
        callerChannelType: request.caller.channelType,
        workflowId: request.workflowId,
        blueprintId: request.blueprintId,
        workflowRunId: request.workflowRunId,
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

  // Doc-page → brain distillation runner (the "Sync to brain" pipeline). Wired
  // only when Pipeline B is present (`brainEpisodeIngestor`). Shared by the
  // manual route, the `ingestPage` chat tool, and the auto-on-save internal
  // endpoint. See packages/api/src/doc/ingest-page-runner.ts +
  // docs/architecture/brain/ingest-pipeline.md.
  const docPageSourceStore = createDbDocPageSourceStore()
  const ingestPageRunner = brainEpisodeIngestor
    ? (args: { userId: string; pageId: string; skipIfHashUnchanged?: string | null }) =>
        runIngestPage(args, {
          savedViewStore,
          docPageStore: createDbDocPageStore(),
          docPageSourceStore,
          brainEpisodeIngestor,
          resolvePrimaryAssistant: resolvePrimaryAssistantForWorkspace,
        }).then(() => undefined)
    : undefined

  // Page-actions substrate (mig 321): button bindings + the at-most-once
  // send ledger + the deterministic send_page port. The port composes the
  // whole verbatim-send pipeline (egress gate → ledger claim → Gmail seam →
  // stamp-back); core's dispatchSendPage adds the button-trigger gate.
  // See docs/architecture/features/page-actions.md.
  const pageActionsStore = createDbPageActionsStore()
  const pageSendLogStore = createDbPageSendLogStore()
  const sendPagePort = createSendPagePort({
    savedViewStore,
    docPageStore: createDbDocPageStore(),
    blueprintRecordStore,
    pageSendLog: pageSendLogStore,
    acquireGmailSender: createGmailSendSeam({ connectorStore, connectorInstanceStore }),
  })

  const workflowExecutorDeps: WorkflowExecutorDeps = {
    workflowStore,
    runStore: workflowRunStore,
    consultTransport,
    resolvePrimary: resolvePrimaryAssistantForWorkspace,
    sendPage: sendPagePort,
    buildToolRegistry: ({ workspaceId, assistantId, userId }) => buildWorkflowToolRegistry(
      {
        firstParty: allTools,
        connectorStore,
        settingsStore: mcpSettingsStore,
        assistantConnectorStore,
        connectorGrantStore,
        connectorInstanceStore,
        workspaceToolPolicyStore,
        knowledgeStore,
        gdriveFilesStore,
        // Evaluated per-run (this closure fires post-boot), so the late
        // `filesApi` initialization below is already done.
        filesApi: filesApi ?? undefined,
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
      } else if (event.type === 'workflow.storm_paused') {
        details.workflowId = event.workflowId
        details.recentRuns = event.recentRuns; details.windowSeconds = event.windowSeconds
      }
      await workspaceAuditStore.append({
        workspaceId: event.workspaceId, actorUserId: event.actorUserId,
        // storm_paused has no run — the guard fired INSTEAD of enqueueing one;
        // key the audit row on the workflow instead.
        eventType: event.type,
        subjectId: event.type === 'workflow.storm_paused' ? event.workflowId : event.runId,
        details,
      })
    },
    deliverToChannel: createWorkflowChannelDelivery({
      integrationStore: integrationStore ?? undefined,
      defaultTelegramBotToken: env.TELEGRAM_BOT_TOKEN,
      waConnectorUrl: env.WA_CONNECTOR_URL,
      waConnectorSecret: env.WA_CONNECTOR_SECRET,
    }),
    // Connector-health surfacing (migration 294): the workspace's dead
    // connectors, so a finished run names them + notifies the owner.
    getAuthFailedConnectors: async (workspaceId: string) =>
      (await connectorInstanceStore.listByWorkspaceSystem(workspaceId))
        .filter((c) => c.healthStatus === 'auth_failed')
        .map((c) => ({ provider: c.provider, label: c.label })),
    createAnchorPage: async ({ workspaceId, userId, title, nestUnder, originPrompt, anchorKey }) => {
      // Per-workflow reuse (mig 279): a recurring anchor page is found-and-
      // reused, not re-minted, so the workflow appends to ONE page instead of
      // leaving a trail of empty duplicates each fire.
      if (anchorKey) {
        const existing = await savedViewStore.findIdByAnchorKey(userId, workspaceId, anchorKey)
        if (existing) return { id: existing }
      }
      try {
        const draft = await savedViewStore.createDraft({
          userId, workspaceId, name: title, nameOrigin: 'user',
          entity: 'tasks', viewType: 'table',
          binding: { entity: 'tasks', viewType: 'table' },
          page: { blocks: [] },
          nestParentId: nestUnder ?? null,
          originPrompt: originPrompt ?? null,
          anchorKey: anchorKey ?? null,
          // Workflow-authored anchor page — bot-authored page event so a
          // workflow watching `nestUnder` doesn't re-trigger on its own anchor.
          writtenBy: 'system',
        })
        await savedViewStore.setState(userId, draft.id, 'saved')
        return { id: draft.id }
      } catch (err) {
        // Race convergence: another run of this workflow won the find-or-create
        // and inserted the anchor row first, so our INSERT hit the
        // (workspace_id, anchor_key) unique index (Postgres 23505). Re-resolve
        // to the winner's page rather than failing this run — `reuse:
        // 'per-workflow'` promises ONE shared page, so a lost race must reuse,
        // not error. Only swallow the unique-violation; anything else rethrows.
        if (anchorKey && (err as { code?: unknown } | null)?.code === '23505') {
          const winner = await savedViewStore.findIdByAnchorKey(userId, workspaceId, anchorKey)
          if (winner) return { id: winner }
        }
        throw err
      }
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

  // ── Goal-seeker acting loop (R1) ──
  // The stateless driver: one tick = one bounded workflow run + a `done_when`
  // self-verification + a re-arm. Port-injected over the executor (dispatch),
  // the usageStore (R3 spend read + the §4.13 metering barrier), and the
  // jobStore (re-arm via a one-shot `scheduled_jobs` tick). The per-iteration
  // run session is `workflow_run_<runId>`, so spend = getSessionCostUsd of it.
  // See goals/driver.ts + docs/plans/task-goal-seeker.md §10/§11.
  // Closed credit gate (injected by the platform; absent in OSS). Captured so
  // the `workspaceBudgetOk` closure narrows it cleanly.
  const creditGate = ports.checkCreditBudget

  // Hosted paid gate for autonomous workflow compute (scheduled jobs, event
  // triggers, manual runs — everything advances through advanceWorkflowRun).
  // Only `blocked` stops a run: that means the workspace has no active plan
  // (the 2026-07-10 Free-plan removal; see cost-and-pricing.md → "No free
  // plan: the hosted paid gate"). `downgraded` (paid plan over its cap) still
  // runs — tier clamping happens on the consult path, matching chat. Fails
  // OPEN on errors so a transient billing hiccup never strands paid runs.
  // Absent in the open build (no creditGate) → runs are never gated.
  workflowExecutorDeps.workspaceComputeAllowed = creditGate
    ? async (workspaceId) => {
        try {
          const plan = await getWorkspacePlan(workspaceId)
          const { status } = await creditGate(workspaceId, plan)
          return status !== 'blocked'
        } catch (err) {
          console.error('[workflow] workspace compute gate failed, allowing:', err)
          return true
        }
      }
    : undefined
  // The goal-tick writer, shared by the driver's re-arm and the stall reaper's
  // recovery re-arm. A goal tick intentionally carries NO workflow_id — see
  // driver.ts GOAL_TICK_KIND.
  const scheduleGoalTick = async (goal: GoalRecord, fireAt: Date, state: GoalLoopState): Promise<void> => {
    const assistantId = await getPrimaryAssistantForWorkspace(goal.workspaceId)
    if (!assistantId) {
      // A workspace with no primary assistant cannot re-arm — log loudly, the
      // stall reaper will keep retrying rather than the chain dying silently.
      console.error(`[goals] cannot arm tick for goal ${goal.id}: workspace ${goal.workspaceId} has no primary assistant`)
      return
    }
    await jobStore.create({
      assistantId,
      userId: goal.createdByUserId ?? assistantId,
      schedule: { type: 'once', datetime: fireAt.toISOString().slice(0, 19) },
      timezone: 'UTC',
      mode: 'local',
      instructions: JSON.stringify({ kind: GOAL_TICK_KIND, goalId: goal.id, state }),
      channelType: 'workflow',
      channelId: goal.id,
      nextRunAt: fireAt,
    })
  }

  const goalDriver = createGoalDriver({
    goalStore,
    tryClaim: tryClaimGoalForTick,
    sessionCostUsd: (sessionId) =>
      usageStore ? usageStore.getSessionCostUsd(sessionId) : Promise.resolve(0),
    meteringAvailable: () => Boolean(usageStore),
    // Workspace credit-cap backstop (hosted): an autonomous acting loop respects
    // the same monthly credit cap a chat turn does — over the cap it BLOCKS
    // (`workspace_over_budget`) rather than run the workspace into the ground.
    // Resolve the workspace plan (system read; fails safe to 'free') and run the
    // injected credit gate: `ok` = under the monthly allowance → proceed,
    // `downgraded`/`blocked` = at/over it → false. The driver only consults this
    // when metering is live (`Boolean(usageStore)`), so it is inert in OSS.
    // Wired only when the closed credit gate is injected; absent (open) →
    // undefined → no cap check (mirrors how `usageStore` is injected). A
    // billing-lookup error fails OPEN — a transient gate failure must never
    // strand a goal; the per-goal `maxSpend` + the metering barrier remain as
    // backstops. See routes/route-helpers.ts → `checkUsageBudget` for the gate.
    workspaceBudgetOk: creditGate
      ? async (workspaceId) => {
          try {
            const plan = await getWorkspacePlan(workspaceId)
            const { status } = await creditGate(workspaceId, plan)
            return status === 'ok'
          } catch (err) {
            console.error('[goals] workspace budget check failed, allowing:', err)
            return true
          }
        }
      : undefined,
    dispatchRun: async ({ goal, runId }) => {
      let activeRunId = runId
      if (activeRunId) {
        const existing = await workflowRunStore.getRunSystem(activeRunId)
        const isTerminal =
          existing?.status === 'completed' || existing?.status === 'failed' || existing?.status === 'timeout'
        if (!existing || isTerminal) activeRunId = null // terminal/missing → start fresh
      }
      if (!activeRunId) {
        const wfId = goal.means.workflowId
        if (!wfId) throw new Error(`acting goal ${goal.id} has no means.workflowId`)
        // Pass the host task + goal as run input so a "complete this task"
        // workflow can reference {{input.taskTitle}} / {{input.goalOutcome}}, and
        // a `verify` goal's agent can call markGoalComplete with {{input.goalId}}.
        // The §8 triage brief rides along so the working assistant runs with its
        // acceptance criteria ({{input.goalVerification}}) and plan sketch
        // ({{input.goalApproach}}).
        const runInput: Record<string, unknown> = { goalOutcome: goal.outcome, goalId: goal.id }
        if (goal.brief?.verification) runInput.goalVerification = goal.brief.verification
        if (goal.brief?.approach) runInput.goalApproach = goal.brief.approach
        if (goal.host?.type === 'task') {
          const t = await query<{ title: string }>(
            `SELECT title FROM tasks WHERE id = $1 AND valid_to IS NULL`,
            [goal.host.id],
          )
          if (t.rows[0]?.title) runInput.taskTitle = t.rows[0].title
        }
        const run = await workflowRunStore.createRun({
          workflowId: wfId,
          workspaceId: goal.workspaceId,
          triggeredBy: goal.createdByUserId,
          triggerKind: 'manual',
          input: runInput,
        })
        activeRunId = run.id
      }
      const outcome = await advanceWorkflowRun(workflowExecutorDeps, activeRunId)
      const terminal = outcome.kind === 'completed' || outcome.kind === 'failed'
      // Did the agent park this goal on an external event this iteration
      // (`waitForEvent`)? Surface the subscriptions so the driver persists the
      // durable `until:event` marker + safety net rather than the paused-run
      // poll. The marker was cleared at claim time, so this reflects only THIS
      // iteration's `waitForEvent` call (if any).
      const parked = await getGoalAwaitingEventSystem(goal.id)
      return {
        runId: activeRunId,
        terminal,
        completed: outcome.kind === 'completed',
        eventSubscriptions: parked?.subscriptions ?? null,
      }
    },
    deliver: deliverGoalTerminal,
    scheduleGoalTick,
    // No unbudgeted autonomy: kickoff persists the default budget when the
    // author set none (see driver.ts DEFAULT_GOAL_BUDGET).
    applyDefaultBudget: (goalId, budget) => updateGoalSystem(goalId, { budget }),
    // Tick-error observability (the driver handled the error — this is the
    // taxonomy's goal_tick_error, not a failure path).
    onTickError: (goal, error, willRetry) => {
      if (!goal.createdByUserId) return
      const msg = error instanceof Error ? error.message : String(error)
      analytics.logEvent({
        userId: goal.createdByUserId,
        channelType: 'workflow',
        eventName: 'goal_tick_error',
        metadata: {
          goal_id: sanitizeAnalytics(goal.id),
          error_message: sanitizeAnalytics(msg.slice(0, 200)),
          will_retry: willRetry,
        },
      })
    },
    // until:event park persistence (mig 293). The store keeps `state` opaque; the
    // driver owns its shape (`GoalLoopState`), so the read bridges the cast.
    getAwaitingEvent: async (goalId) => {
      const m = await getGoalAwaitingEventSystem(goalId)
      return m ? { subscriptions: m.subscriptions, state: m.state as GoalLoopState | undefined } : null
    },
    setAwaitingEvent: (goalId, marker) => setGoalAwaitingEventSystem(goalId, marker),
    clearAwaitingEvent: (goalId) => clearGoalAwaitingEventSystem(goalId),
    now: () => new Date(),
  })

  // The simple default "complete this task" workflow (autopilot §5): a one-step
  // assistant_call over the host task + goal outcome — the means a spun-up goal
  // runs each iteration. A fresh workflow row per goal (no template store); the
  // task title + outcome arrive as run input ({{input.*}}).
  const createCompletionWorkflow = async (goal: GoalRecord, userId: string): Promise<string> => {
    const assistantId = (await getPrimaryAssistantForWorkspace(goal.workspaceId)) ?? userId
    // A `verify` goal (§12) has no objective predicate: the agent works the
    // outcome and signals completion via markGoalComplete, gated by the
    // adversarial verifier. A task goal keeps the close-the-task path
    // (hostTaskDone) unchanged.
    const isVerify = (goal.doneWhen as { kind?: string }).kind === 'verify'
    const instructions = isVerify
      ? 'Work toward this goal: {{input.goalOutcome}}. Use your tools to do the real work across iterations. ' +
        'When — and only when — the outcome is genuinely achieved, call markGoalComplete with goal_id "{{input.goalId}}" ' +
        'and a concrete "because" stating what you did that satisfies it (an independent verifier will check the claim). ' +
        'If it cannot be finished yet, say what is blocking it and keep working next iteration.'
      : 'Complete this task: {{input.taskTitle}}. Goal: {{input.goalOutcome}}. ' +
        // §8 brief threading — reference the brief only when this goal carries
        // one (dispatchRun sets the run-input keys from goal.brief).
        (goal.brief?.approach ? 'Suggested approach: {{input.goalApproach}}. ' : '') +
        (goal.brief?.verification ? 'How completion is checked: {{input.goalVerification}}. ' : '') +
        'Use your tools to do the work, ' +
        'then close the task (mark it done) when it is complete. If it cannot be finished yet, say what is blocking it.'
    return buildOneStepReminderWorkflow(workflowStore, {
      userId,
      workspaceId: goal.workspaceId,
      assistantId,
      name: isVerify ? 'Work a goal to done' : 'Complete a task',
      instructions,
      // Goal iterations get the wall-clock CEILING (not the 90s reminder
      // default): an autonomous iteration doing real work — a browser-skill
      // run in the cloud sandbox, a research pass, file writes — routinely
      // outlives 90s, and clipping it mid-tool made the goal loop burn
      // iterations on timeouts. Cost stays bounded by the unchanged turn /
      // tool-call caps + the driver's own spend guards (maxSpend,
      // workspaceBudgetOk); only the wall-clock allowance widens. See
      // docs/architecture/engine/computer-use.md → "Working a task's goal".
      depth: { timeoutMs: RESEARCH_BUDGET_CEILING.timeoutMs },
    })
  }

  // Authoring-time external-dependency preflight (fix A / B): delivery-target
  // reachability + connector token probe. Shared by the chat-tool authoring
  // path and the REST builder path so both reject a misconfigured workflow at
  // create time instead of failing on every fire.
  const workflowDependencyPreflight = createWorkflowDependencyPreflight({
    integrationStore: integrationStore ?? undefined,
    defaultTelegramBotToken: env.TELEGRAM_BOT_TOKEN,
    waConnectorUrl: env.WA_CONNECTOR_URL,
    waConnectorSecret: env.WA_CONNECTOR_SECRET,
    connectorStore,
    // Team credential sources — the connector preflight resolves creds with the
    // same precedence as the runtime (team-native instance → member grant →
    // per-user), so a workflow whose connector lives in a team-owned/granted
    // instance is not falsely rejected as "not connected".
    connectorInstanceStore,
    connectorGrantStore,
    // Policy-aware preflight: lets authoring reject an `ask`-policy tool
    // pinned on an `assistant_call` step (never executable there — the callee
    // surface drops ask-policy tools; see dependencyIssues) instead of
    // shipping a workflow that fails every run.
    mcpSettingsStore,
  })

  const {
    proposeWorkflow, createWorkflow: createWorkflowTool, updateWorkflow,
    getWorkflow, runWorkflow, listWorkflows, getWorkflowRun, listSlackChannels, listSlackMembers,
  } = createWorkflowTools({
    workflowStore,
    runStore: workflowRunStore,
    executorDeps: workflowExecutorDeps,
    validateDeliveryTarget: workflowDependencyPreflight.validateDeliveryTarget,
    preflightConnectorTool: workflowDependencyPreflight.preflightConnectorTool,
    listSlackChannels: workflowDependencyPreflight.listSlackChannels,
    listSlackMembers: workflowDependencyPreflight.listSlackMembers,
    resolvePageAnchor: async (userId, pageId) => {
      const view = await savedViewStore.getById(userId, pageId)
      return view ? { workspaceId: view.workspaceId, state: view.state, name: view.name } : null
    },
    listAuthorableSkills: async (userId, workspaceId) => {
      const skills = await workspaceSkillStore.listForWorkspace(workspaceId, { actingUserId: userId })
      return skills.filter((s) => s.state !== 'archived').map((s) => ({ slug: s.slug, name: s.name }))
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
  allTools.set('listSlackChannels', listSlackChannels)
  allTools.set('listSlackMembers', listSlackMembers)

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

  // ── Goal-seeker kickoff tools (default-on 'goals' capability) ──
  const goalTools = createGoalTools(goalStore, {
    onEvent: (evt, ctx) => {
      const base = { userId: ctx.userId, assistantId: ctx.assistantId, sessionId: ctx.sessionId, channelType: ctx.channelType }
      if (evt.type === 'goal_created') {
        analytics.logEvent({ ...base, eventName: 'goal_created', metadata: { goal_id: sanitizeAnalytics(evt.goalId) } })
        // Arm the acting loop for a goal that declares a workflow means; a
        // no-means monitor / structural goal is left to the rollup. Fire-and-
        // forget — a kickoff failure must never fail the setGoal tool call.
        void goalDriver.kickoffGoal(evt.goalId).catch((err) =>
          console.error('[goals] acting-loop kickoff failed:', err),
        )
      } else if (evt.type === 'goal_listed') {
        analytics.logEvent({ ...base, eventName: 'goal_listed', metadata: { result_count: evt.resultCount, hit: evt.resultCount > 0 } })
      }
    },
  })
  allTools.set('setGoal', goalTools.setGoal)
  allTools.set('listGoals', goalTools.listGoals)

  // COGS for the goal clarity + verify Flash calls. Both assessors only know
  // the confirming/verifying user, so resolve that user's primary assistant for
  // attribution (recordUsage INSERTs over `assistants WHERE id = $assistantId`,
  // so the row only persists against a real assistant). Falls back to `userId`
  // as the attribution id if none resolves. Overhead source (excluded from
  // billing aggregates); best-effort + fire-and-forget, never blocks the
  // confirm/verify flow, and a no-op when usageStore/userId is absent (OSS).
  const resolveGoalOverheadAssistant = async (userId: string): Promise<string> => {
    try {
      const assistants = await listAccessibleAssistants(userId)
      return assistants.find((a) => a.kind === 'primary')?.id ?? assistants[0]?.id ?? userId
    } catch {
      return userId
    }
  }
  const recordGoalOverheadUsage =
    (source: 'overhead:goal-clarity' | 'overhead:goal-verify' | 'overhead:goal-triage', model = 'gemini-flash') =>
    (usage: TokenUsage, userId?: string): void => {
      if (!usageStore || !userId) return
      const store = usageStore
      void resolveGoalOverheadAssistant(userId)
        .then((assistantId) =>
          store.recordUsage({
            userId,
            assistantId,
            sessionId: null,
            model,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            actualCostUsd: calculateCost(model, usage),
            source,
          }),
        )
        .catch((err) => console.error(`[${source}] usage tracking failed:`, err))
    }

  // Confirmation clarity gate (§12) — assesses whether a goal's definition of
  // done is clear enough to work autonomously; an unclear goal is blocked at
  // confirm with a clarifying question. Cheap Flash classifier; fail-open.
  const goalClarityAssessor = createGoalClarityAssessor({
    provider,
    model: 'gemini-flash',
    onUsage: recordGoalOverheadUsage('overhead:goal-clarity'),
  })
  // Agentic completion verifier (§12 Phase 3) — adversarially judges a
  // markGoalComplete claim against the goal's outcome before it closes.
  const goalVerifier = createGoalVerifier({
    provider,
    model: 'gemini-flash',
    onUsage: recordGoalOverheadUsage('overhead:goal-verify'),
  })

  // Task autopilot v2 triage judge (task-goal-autopilot.md §8) — one
  // background-tier call per top-level task create: can the assistant honestly
  // help, given what this workspace actually has connected? On pass, mint the
  // draft goal with the generated brief; on fail/error, no draft (fail-closed).
  // Wired only when a provider is configured, so keyless OSS never logs judge
  // errors — tasks simply stay goal-free.
  const TRIAGE_MODEL = backgroundModel
  if (configuredProviders.size > 0) {
    const taskTriageJudge = createTaskTriageJudge({
      provider,
      model: TRIAGE_MODEL,
      onUsage: recordGoalOverheadUsage('overhead:goal-triage', TRIAGE_MODEL),
    })
    // What the assistant can actually do here: the static core surface plus
    // the workspace's live connector grants (clearance-filtered). Grounds the
    // judge so a drafted approach never names an unconnected capability
    // (the CLAUDE.md tool-awareness rule, applied to triage).
    const CORE_CAPABILITY_LINES = [
      'Search and read the company brain: memories, knowledge entries, workspace files, recordings',
      'Create and edit workspace doc pages (briefs, summaries, reports, research write-ups)',
      'Manage CRM records: contacts, companies, deals',
      'Create, update, and close tasks; schedule reminders and recurring jobs',
      'Research on the public web and compile findings',
    ]
    const summariseWorkspaceCapabilities = async (userId: string, workspaceId: string): Promise<string[]> => {
      try {
        const usable = await listUsableWorkspaceConnectors({ connectorInstanceStore, connectorGrantStore, userId, workspaceId })
        const byProvider = new Map<string, string>()
        for (const u of usable) {
          if (byProvider.has(u.instance.provider)) continue
          const entry = OFFICIAL_CONNECTORS.find((c) => c.id === u.instance.provider)
          const tools = (OFFICIAL_CONNECTOR_TOOLS[u.instance.provider] ?? []).map((t) => t.name)
          const name = entry?.name ?? u.instance.label
          byProvider.set(u.instance.provider, tools.length > 0 ? `${name} (${tools.slice(0, 8).join(', ')})` : name)
        }
        return [...CORE_CAPABILITY_LINES, ...byProvider.values()]
      } catch (err) {
        console.error('[goal-triage] capability summary failed; using core surface only:', err)
        return CORE_CAPABILITY_LINES
      }
    }
    judgeTaskForGoal = (task, userId) => {
      void (async () => {
        const capabilities = await summariseWorkspaceCapabilities(userId, task.workspaceId)
        const attrs = Object.keys(task.attributes ?? {}).length > 0 ? JSON.stringify(task.attributes) : null
        const brief = await taskTriageJudge({ title: task.title, description: attrs, capabilities, userId })
        if (!brief) return
        await goalStore.create({
          workspaceId: task.workspaceId,
          host: { type: 'task', id: task.id },
          outcome: brief.outcome,
          doneWhen: { kind: 'query', query: { description: 'task complete', predicate: { hostTaskDone: true } } },
          means: {},
          confirmed: false, // draft — triaged on the Tasks-assignable surface
          createdByUserId: userId,
          brief: { verification: brief.verification, approach: brief.approach, judgeReason: brief.judgeReason },
        })
      })().catch((err) => console.error('[goals] task triage draft failed:', err))
    }
  }

  // Task-autopilot spin-up tools (confirm a draft goal; work a task to done) +
  // the agentic completion signal (markGoalComplete). `gatherEvidence` hands the
  // verifier a read-only host snapshot so it checks the claim against reality.
  const goalWorkTools = createGoalWorkTools({
    createCompletionWorkflow,
    kickoffGoal: goalDriver.kickoffGoal,
    assessClarity: goalClarityAssessor,
    verify: goalVerifier,
    gatherEvidence: gatherGoalEvidence,
  })
  allTools.set('confirmGoal', goalWorkTools.confirmGoal)
  allTools.set('workTask', goalWorkTools.workTask)
  allTools.set('markGoalComplete', goalWorkTools.markGoalComplete)
  allTools.set('waitForEvent', goalWorkTools.waitForEvent)

  allTools.set('listWorkspaceMembers', createWorkspaceTools(workspaceDirectoryStore).listWorkspaceMembers)

  // Workspace transcription preference (migration 332) — the assistant is the
  // configuration surface. Writes are admin/owner-gated in the store setter.
  // See docs/architecture/platform/workspaces.md → "Transcription preferences".
  allTools.set(
    'configureTranscriptionPreference',
    createTranscriptionPrefTools({
      get: (workspaceId) => getWorkspaceTranscriptionPrefs(workspaceId),
      set: (userId, workspaceId, patch) => setWorkspaceTranscriptionPrefs(userId, workspaceId, patch),
    }).configureTranscriptionPreference,
  )

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
  let brainFileTools:
    | Pick<
        ReturnType<typeof createFileTools>,
        'fileWrite' | 'fileAppend' | 'fileRead' | 'fileSearch' | 'fileSetMeta' | 'fileDelete' | 'saveFileToBrain' | 'saveFileBytes'
      >
    | null = null
  let fileIngestor: unknown = null
  if (filesBlobClient) {
    // Bring-your-own GCS storage: a workspace with an active `gcs` connector
    // binding writes its file bytes to its OWN bucket under its OWN key; every
    // other workspace falls through to the app default bucket (byte-identical
    // to before). The binding lookup reads the encrypted connector_instance
    // credential. See docs/plans/byo-google-storage.md.
    const defaultFilesResolver = createSingletonFilesClientResolver(
      filesBlobClient,
      env.GCS_FILES_BUCKET ?? 'local-dev',
    )
    const lookupStorageBinding = async (workspaceId: string): Promise<WorkspaceStorageBinding | null> => {
      // A binding resolves only while we hold the key. Disconnect wipes the key
      // (credential type 'none'), so a disconnected workspace returns null here
      // and falls back to the app default bucket for both reads and writes —
      // its BYO files go dormant until a reconnect re-supplies the key. GCS
      // takes precedence when a workspace somehow has both bindings connected.
      const gcsInst = await connectorInstanceStore.findByWorkspaceProviderSystem(workspaceId, 'gcs')
      if (gcsInst) {
        const creds = await connectorInstanceStore.getAuthCredentialsSystem(gcsInst.id)
        if (creds && creds.type === 'gcs') {
          return { kind: 'gcs', credentials: creds.serviceAccountKey, bucket: creds.bucket, projectId: creds.projectId }
        }
      }
      const s3Inst = await connectorInstanceStore.findByWorkspaceProviderSystem(workspaceId, 's3')
      if (s3Inst) {
        const creds = await connectorInstanceStore.getAuthCredentialsSystem(s3Inst.id)
        if (creds && creds.type === 's3') {
          return {
            kind: 's3',
            credentials: creds.accessKey,
            bucket: creds.bucket,
            region: creds.region,
            endpoint: creds.endpoint,
            forcePathStyle: creds.forcePathStyle,
          }
        }
      }
      return null
    }
    filesResolver = createCachedByoFilesResolver({ lookup: lookupStorageBinding, fallback: defaultFilesResolver })
    filesApi = createFilesApi({
      resolver: filesResolver,
      store: workspaceFilesStore,
      auditStore: workspaceAuditStore,
    })
    // Effective allow/ask/block for a files tool — the same L1 (app-level
    // sentinel) + L2 (per-assistant) strictest-wins resolution the Studio /
    // Assistant tool-policy UIs display and write (`mcp_tool_settings`,
    // serverName='files'). Without this hook those toggles were stored but
    // never read at execution (static requiresConfirmation flags only).
    // See docs/architecture/features/files.md → "Connector-style governance".
    // The one connector id this resolver serves — NOT an "all built-ins"
    // list (see the builtin-id-sets invariant); the policy rows are keyed
    // by this serverName in mcp_tool_settings.
    const FILES_CONNECTOR_ID = 'files'
    const filesToolDefaults = new Map(
      (OFFICIAL_CONNECTOR_TOOLS[FILES_CONNECTOR_ID] ?? []).map((t) => [t.name, t.defaultPolicy]),
    )
    const POLICY_STRICTNESS: Record<string, number> = { allow: 0, ask: 1, block: 2 }
    const strictestFilePolicy = (a: FileToolPolicy, b: FileToolPolicy): FileToolPolicy =>
      (POLICY_STRICTNESS[a] ?? 0) >= (POLICY_STRICTNESS[b] ?? 0) ? a : b
    const resolveFilesToolPolicy = async (
      toolName: string,
      context: { userId: string; assistantId: string },
    ): Promise<FileToolPolicy> => {
      const fallback = (filesToolDefaults.get(toolName) ?? 'ask') as FileToolPolicy
      const [l1, l2] = await Promise.all([
        mcpSettingsStore.getPolicy({
          assistantId: APP_LEVEL_ASSISTANT_ID, userId: context.userId,
          serverName: FILES_CONNECTOR_ID, toolName,
        }),
        mcpSettingsStore.getPolicy({
          assistantId: context.assistantId, userId: context.userId,
          serverName: FILES_CONNECTOR_ID, toolName,
        }),
      ])
      return strictestFilePolicy(
        (l1?.policy as FileToolPolicy) ?? fallback,
        (l2?.policy as FileToolPolicy) ?? fallback,
      )
    }
    const fileTools = createFileTools(filesApi, {
      entityLinks: entityLinksStore,
      readCachedFile: (id, ctx) => fileStore.get(id, ctx),
      resolvePolicy: resolveFilesToolPolicy,
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

    // ── Decks (first-party PPTX) ──
    // Persistent deck artifacts: workspace_decks row (spec) + stable
    // workspace file decks/<id>.pptx. Rides the files capability (output is
    // a workspace file), so tools live inside the filesBlobClient guard.
    // The read/export ROUTER mounts with the other authed routers at the
    // END of boot — an early bare `/api` requireAuth guard here would 401
    // every public mount registered after it (the Mini App outage class;
    // graded by invariants/route-mount-order). See
    // docs/architecture/features/deck-generation.md.
    // previewUrl targets the AUTHENTICATED app origin (app.usebrian.ai) — the
    // /w/… deck route lives in app-web, and the marketing site does NOT
    // redirect /w/* (MOVED_TO_APP_PREFIXES covers only pre-consolidation
    // paths). Same fallback chain as the computer-use take-over link below.
    deckStore = createDeckStore()
    for (const tool of createDeckTools({ filesApi, deckStore, appOrigin: env.AUTHED_APP_URL ?? env.APP_URL })) {
      allTools.set(tool.name, tool)
    }
    // Direct file ingest is open: store the original bytes, derive text, then
    // run the same boot-built Pipeline B ingestor used by brain MCP and docs.
    if (brainEpisodeIngestor) {
      fileIngestor = createFileIngestor({
        filesApi,
        ingest: brainEpisodeIngestor,
        distill: async ({ buffer, mime }) =>
          (await distillFileToText({ buffer, mime }, { backend: mediaBackend })).text,
      })
    }
  }

  // ── Computer use (browser tool surface) ──
  // docs/architecture/engine/computer-use.md §3-§4: five discrete browser
  // tools over the BrowserProvider seam. Local mode drives the user's own
  // Chrome through the browser-relay (BROWSER_RELAY_URL/SECRET; unset →
  // honest not_configured errors). The cloud backend arrives with the
  // SandboxProvider phase and stays not_configured here. Governance mirrors
  // the files pattern: L1/L2 strictest-wins policy over mcp_tool_settings
  // (serverName='computer'), metadata-only analytics audit, and the
  // in-tool send gate + autonomous-path block (§8).
  // BROWSER_RELAY_URL resolution: an explicit value always wins (prod upserts
  // it via the BROWSER_RELAY_URL secret in deploy-browser-relay.sh). In local
  // dev it defaults to the relay's own PORT default (8080), so a My-Browser
  // e2e test only needs BROWSER_RELAY_SECRET set. NEVER defaulted outside
  // development: prod keeps BROWSER_RELAY_SECRET set while the URL secret stays
  // absent until the relay is deployed, and a stray localhost default there
  // would flip the `URL && SECRET` gate true against a dead relay.
  const browserRelayUrl =
    env.BROWSER_RELAY_URL ||
    (env.NODE_ENV === 'development' ? 'http://localhost:8080' : undefined)
  const browserRelayTransport =
    browserRelayUrl && env.BROWSER_RELAY_SECRET
      ? createRelayCommandTransport({
          relayUrl: browserRelayUrl,
          relaySecret: env.BROWSER_RELAY_SECRET,
        })
      : null
  // Cloud mode (§5): E2B behind the SandboxProvider seam. providers/e2b is
  // the only E2B-SDK importer; everything here talks to the interface.
  // The watched exploration's LLM (browserExplore → provider runBrowserUse)
  // threads from HERE — no model id lives in the sandbox tree (§4.14). The
  // browser-grounding leg rides a cheap tier: Haiku when the Anthropic key
  // exists, else the platform Gemini key on Flash. Without either config the
  // provider refuses the lane honestly instead of argparse-dying in the VM.
  const browserUseLlm = env.ANTHROPIC_API_KEY
    ? {
        apiKeyEnvName: 'ANTHROPIC_API_KEY' as const,
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.BROWSER_USE_MODEL || 'claude-haiku-4-5-20251001',
      }
    : env.GEMINI_API_KEY
      ? {
          apiKeyEnvName: 'GOOGLE_API_KEY' as const,
          apiKey: env.GEMINI_API_KEY,
          // The REAL Google API id (browser-use bypasses our provider layer,
          // so no alias resolution) — Flash 3, the cheap-leg tier.
          model: env.BROWSER_USE_MODEL || 'gemini-3-flash-preview',
        }
      : undefined
  const sandboxProvider: SandboxProvider | null = env.E2B_API_KEY
    ? createE2bCloudProvider(
        createE2bRuntime({ apiKey: env.E2B_API_KEY, defaultTemplateId: env.E2B_TEMPLATE_ID }),
        { browserUse: browserUseLlm },
      )
    : null
  // The §4.9 meter: all three COGS lines record through the usage spine, and
  // the per-session dollar cap accumulates on the task row. Barrier 2 rides
  // meteringActive(): no usage store → unattended can never enable.
  const sandboxTaskStoreImpl = ports.sandboxTaskStore ?? createInMemorySandboxTaskStore()
  const sandboxMeter = createSandboxMeter({
    usageStore: usageStore ?? null,
    addSpend: sandboxTaskStoreImpl.addSpend
      ? sandboxTaskStoreImpl.addSpend.bind(sandboxTaskStoreImpl)
      : createInMemorySpendAccumulator(DEFAULT_SESSION_BUDGET_USD).addSpend,
  })
  const unattendedComputerUse = () =>
    resolveUnattendedComputerUse({
      flagEnabled: env.COMPUTER_USE_UNATTENDED_ENABLED === true,
      meter: sandboxMeter,
    })
  const sandboxOrchestrator: SandboxOrchestrator | null = sandboxProvider
    ? createSandboxOrchestrator({
        provider: sandboxProvider,
        taskStore: sandboxTaskStoreImpl,
        meter: sandboxMeter,
        vault: ports.browserSessionVault ?? null,
        profileStore: ports.browserProfileStore ?? null,
        budget: {
          // The workspace credit-cap gate (§4.9): a blocked workspace cannot
          // start a cloud computer task. Mirrors the goals-driver pattern —
          // plan resolved system-side, transient gate errors fail OPEN (the
          // per-session dollar cap + fuse remain as backstops).
          checkCreditBudget: creditGate
            ? async (browseCtx) => {
                let status: string
                try {
                  const plan = await getWorkspacePlan(browseCtx.workspaceId)
                  status = (await creditGate(browseCtx.workspaceId, plan)).status
                } catch (err) {
                  console.error('[computer] credit gate check failed, allowing:', err)
                  return
                }
                if (status === 'blocked') {
                  throw new Error(
                    'This workspace is out of credit for the current period, so a cloud browser task cannot start. Upgrade the plan or wait for the period to reset.',
                  )
                }
              }
            : undefined,
        },
        // Downloads auto-pull into workspace_files (§4.12) — scoped by the
        // TASK's workspace, resolved above the provider seam.
        saveDownload: filesApi
          ? async (dlCtx, file) => {
              const name = file.path.split('/').pop() || 'download'
              await filesApi!.writeBytes(
                { userId: dlCtx.userId, workspaceId: dlCtx.workspaceId, assistantId: null, assistantKind: 'standard' },
                {
                  path: `computer/downloads/${Date.now()}-${name.replace(/[^\w.-]+/g, '_')}`,
                  bytes: file.bytes,
                  mime: 'application/octet-stream',
                  title: name,
                },
              )
            }
          : undefined,
      })
    : null
  const COMPUTER_CONNECTOR_ID = 'computer'
  const computerToolDefaults = new Map(
    (OFFICIAL_CONNECTOR_TOOLS[COMPUTER_CONNECTOR_ID] ?? []).map((t) => [t.name, t.defaultPolicy]),
  )
  const COMPUTER_POLICY_STRICTNESS: Record<string, number> = { allow: 0, ask: 1, block: 2 }
  const resolveComputerToolPolicy = async (
    toolName: string,
    context: { userId: string; assistantId: string },
  ): Promise<ComputerToolPolicy> => {
    const fallback = (computerToolDefaults.get(toolName) ?? 'allow') as ComputerToolPolicy
    const [l1, l2] = await Promise.all([
      mcpSettingsStore.getPolicy({
        assistantId: APP_LEVEL_ASSISTANT_ID, userId: context.userId,
        serverName: COMPUTER_CONNECTOR_ID, toolName,
      }),
      mcpSettingsStore.getPolicy({
        assistantId: context.assistantId, userId: context.userId,
        serverName: COMPUTER_CONNECTOR_ID, toolName,
      }),
    ])
    const a = (l1?.policy as ComputerToolPolicy) ?? fallback
    const b = (l2?.policy as ComputerToolPolicy) ?? fallback
    return (COMPUTER_POLICY_STRICTNESS[a] ?? 0) >= (COMPUTER_POLICY_STRICTNESS[b] ?? 0) ? a : b
  }
  // The acting assistant's clearance for the profile gate (R2-4) — resolved
  // from the assistant row, defensively 'public' (lowest → most restrictive
  // profile access) on any lookup failure.
  const getAssistantClearance = async (assistantId: string): Promise<Sensitivity> => {
    try {
      const res = await query<{ clearance: string | null }>(
        `SELECT clearance FROM assistants WHERE id = $1`,
        [assistantId],
      )
      const c = res.rows[0]?.clearance
      return c === 'public' || c === 'internal' || c === 'confidential' ? c : 'confidential'
    } catch {
      return 'public'
    }
  }
  const computerTools = createComputerTools({
    local: createLocalBrowserProvider({ transport: browserRelayTransport }),
    cloud: createCloudBrowserProvider({
      provider: sandboxProvider,
      binding: sandboxOrchestrator?.binding ?? null,
    }),
    cloudAvailable: () => sandboxProvider !== null,
    // Browser profiles (R2-4/R2-10): the closed store when the platform
    // wires it; OSS boots browse identity-less.
    profiles: ports.browserProfileStore
      ? {
          store: ports.browserProfileStore,
          vault: ports.browserSessionVault ?? null,
          assistantClearance: (toolCtx) => getAssistantClearance(toolCtx.assistantId),
        }
      : null,
    // Channel escalate-to-web (§4.8): a cloud login wall surfaces a deep link
    // into the Take-Over live view for this chat session.
    takeoverLinkFor: (toolCtx) =>
      toolCtx.workspaceId
        ? `${(env.AUTHED_APP_URL ?? env.APP_URL).replace(/\/$/, '')}/w/${toolCtx.workspaceId}/computer/${toolCtx.sessionId}`
        : null,
    onCloudLoginWall: sandboxOrchestrator
      ? async (toolCtx) => sandboxOrchestrator.pauseForTakeover(toolCtx.sessionId)
      : undefined,
    // Proactive live-view hand-off (§5): when a cloud browse starts, push the
    // Take-Over link to the user's channel out-of-band, before any work.
    // Channels drop mid-turn model text and have no live chip, so the model
    // relaying the link cannot reach them — deliverToChannel persists to the
    // session AND pushes to telegram/slack/whatsapp (web is persist-only; the
    // live chip covers realtime there). The tool only fires this on
    // interactive sessions (never headless/autonomous).
    onCloudSessionStarted: async (toolCtx, { takeoverUrl }) => {
      await deliverToChannel({
        assistantId: toolCtx.assistantId,
        userId: toolCtx.userId,
        text: `🖥️ I've opened a live browser to work on this. You can watch it live or take over (for example, to sign in) here: ${takeoverUrl}`,
        sessionId: toolCtx.sessionId,
        channelType: toolCtx.channelType,
        channelId: toolCtx.channelId,
        integrationStore: integrationStore ?? undefined,
        defaultTelegramBotToken: env.TELEGRAM_BOT_TOKEN,
        waConnectorUrl: env.WA_CONNECTOR_URL,
        waConnectorSecret: env.WA_CONNECTOR_SECRET,
      })
    },
    resolvePolicy: resolveComputerToolPolicy,
    // Barrier 2 (§4.9): the flag alone cannot enable unattended computer-use
    // — resolveUnattendedComputerUse also requires live metering, so a
    // metering-absent boot stays attended-only no matter the env.
    unattendedEnabled: unattendedComputerUse,
    // R2-8: unattended is paid-gated on top of Barrier 2.
    getWorkspacePlan,
    onEvent: (evt, ctx) => {
      analytics.logEvent({
        userId: ctx.userId,
        assistantId: ctx.assistantId,
        sessionId: ctx.sessionId,
        channelType: ctx.channelType,
        eventName: 'browser_action',
        metadata: {
          op: sanitizeAnalytics(evt.op),
          backend: sanitizeAnalytics(evt.backend),
          host: sanitizeAnalytics(evt.host ?? ''),
          ok: evt.ok,
          ...(evt.code ? { code: sanitizeAnalytics(evt.code) } : {}),
          // Per-action context cost. Numbers, not strings — sanitizeAnalytics
          // is for free text, and these must stay numeric for the admin
          // aggregate to SUM them. The local backend books no usage_tracking
          // row of its own, so this is the ONLY per-action cost signal it has.
          ...(evt.resultChars !== undefined ? { result_chars: evt.resultChars } : {}),
          ...(evt.resultTokens !== undefined ? { result_tokens: evt.resultTokens } : {}),
        },
      })
    },
  })
  allTools.set('browserNavigate', computerTools.browserNavigate)
  allTools.set('browserSnapshot', computerTools.browserSnapshot)
  allTools.set('browserClick', computerTools.browserClick)
  allTools.set('browserType', computerTools.browserType)
  allTools.set('browserCurrentUrl', computerTools.browserCurrentUrl)
  // Research read-browse (computer-use.md §12): browserReadPage is
  // deliberately NOT in allTools — interactive turns have the full flat
  // tools, and the standard preflight's cheap read-only pass must never be
  // able to spin up a sandbox. It reaches exactly one surface: research
  // workers, via the manager's post-sandbox-registration injection seam
  // (the WorkerManager itself was built from a pre-sandbox tool snapshot).
  workerManager.setResearchBrowseTools(
    new Map([['browserReadPage', computerTools.browserReadPage]]),
  )

  // Isolated Python + the workspace-scoped file-bridge (§4.7, §4.12). The
  // files port wraps FilesApi so every byte movement stays under workspace
  // RLS; the workspace id always comes from the ToolContext, never input.
  const computeTools = createComputeTools({
    provider: sandboxProvider,
    binding: sandboxOrchestrator?.binding ?? null,
    files: filesApi
      ? {
          readBytes: async (fctx, fileIdOrPath) => {
            const res = await filesApi!.readBytes(
              { userId: fctx.userId, workspaceId: fctx.workspaceId, assistantId: null, assistantKind: 'standard' },
              fileIdOrPath,
            )
            if (!res.ok) return null
            return {
              bytes: new Uint8Array(res.value.bytes),
              name: res.value.file.path.split('/').pop() || res.value.file.path,
            }
          },
          writeBytes: async (fctx, params) => {
            const res = await filesApi!.writeBytes(
              { userId: fctx.userId, workspaceId: fctx.workspaceId, assistantId: null, assistantKind: 'standard' },
              { path: params.path, bytes: params.bytes, mime: 'application/octet-stream', title: params.title },
            )
            if (!res.ok) throw new Error('Could not save the file to the workspace (quota or conflict).')
            return { fileId: res.value.id, path: res.value.path }
          },
        }
      : null,
    getWorkspacePlan,
    resolvePolicy: resolveComputerToolPolicy,
    unattendedEnabled: unattendedComputerUse,
    onEvent: (evt, ctx) => {
      analytics.logEvent({
        userId: ctx.userId,
        assistantId: ctx.assistantId,
        sessionId: ctx.sessionId,
        channelType: ctx.channelType,
        eventName: 'computer_compute',
        metadata: {
          kind: sanitizeAnalytics(evt.type),
          ok: evt.ok,
          ...(evt.detail !== undefined ? { detail: evt.detail } : {}),
        },
      })
    },
  })
  allTools.set('runPython', computeTools.runPython)
  allTools.set('loadFromWorkspace', computeTools.loadFromWorkspace)
  allTools.set('saveToWorkspace', computeTools.saveToWorkspace)

  // Logic-blocks (R2-5/R2-9/R2-10): reviewed browsing code in brain, run
  // through the governed runner whose terminal sends hit the same
  // grant/approval/verb-ceiling gate the browser tools use. The approvals
  // bridge parks un-granted sends as kind='browser_skill_send' rows and
  // writes 'auto_approved' AUDIT rows for grant-satisfied ones (R2-2).
  const browserSkillsStore = createBrowserSkillsStore()
  const blockApprovals: BlockApprovalsPort = {
    async createSendApproval(p) {
      const row = await pendingApprovalsStore.createBrowserSkillSend({
        workspaceId: p.workspaceId,
        approverUserId: p.approverUserId,
        sessionId: p.sessionId ?? null,
        payload: p.payload as unknown as Record<string, unknown>,
        expiresAt: p.expiresAt ? new Date(p.expiresAt) : null,
      })
      return { id: row.id }
    },
    async getStatus(id) {
      const row = await pendingApprovalsStore.getByIdSystem(id)
      return row ? row.status : null
    },
    async expire(id) {
      await pendingApprovalsStore.expireById(id)
    },
    async recordAutoApproved(p) {
      await pendingApprovalsStore.createBrowserSkillAudit({
        workspaceId: p.workspaceId,
        approverUserId: p.approverUserId,
        sessionId: p.sessionId ?? null,
        grantId: p.grantId,
        payload: p.payload as unknown as Record<string, unknown>,
      })
    },
  }
  const skillRunnerTools = createSkillRunnerTools({
    provider: sandboxProvider,
    binding: sandboxOrchestrator?.binding ?? null,
    skills: browserSkillsStore,
    grants: ports.browserSkillGrantStore ?? null,
    approvals: blockApprovals,
    profiles: ports.browserProfileStore
      ? {
          store: ports.browserProfileStore,
          vault: ports.browserSessionVault ?? null,
          assistantClearance: (toolCtx) => getAssistantClearance(toolCtx.assistantId),
        }
      : null,
    resolvePolicy: resolveComputerToolPolicy,
    unattendedEnabled: unattendedComputerUse,
    getWorkspacePlan,
    onEvent: (evt, ctx) => {
      analytics.logEvent({
        userId: ctx.userId,
        assistantId: ctx.assistantId,
        sessionId: ctx.sessionId,
        channelType: ctx.channelType,
        eventName: 'browser_skill_run',
        metadata: {
          skill: sanitizeAnalytics(evt.skill),
          site: sanitizeAnalytics(evt.site),
          rehearsal: evt.rehearsal,
          ok: evt.ok,
          sends: evt.sends,
          autoApproved: evt.autoApproved,
          queued: evt.queued,
          denied: evt.denied,
        },
      })
    },
  })
  allTools.set('runBrowserSkill', skillRunnerTools.runBrowserSkill)
  allTools.set('listBrowserSkills', skillRunnerTools.listBrowserSkills)
  allTools.set('listBrowserProfiles', skillRunnerTools.listBrowserProfiles)

  // The watched agentic fallback (R2-1/R2-7): browser-use for novel flows,
  // cloud-only, always self-healing into a draft logic-block (R2-5).
  const buFallback = createBuFallbackTool({
    provider: sandboxProvider,
    binding: sandboxOrchestrator?.binding ?? null,
    skills: browserSkillsStore,
    profiles: ports.browserProfileStore
      ? {
          store: ports.browserProfileStore,
          vault: ports.browserSessionVault ?? null,
          assistantClearance: (toolCtx) => getAssistantClearance(toolCtx.assistantId),
        }
      : null,
    resolvePolicy: resolveComputerToolPolicy,
    unattendedEnabled: unattendedComputerUse,
    getWorkspacePlan,
    onEvent: (evt, ctx) => {
      analytics.logEvent({
        userId: ctx.userId,
        assistantId: ctx.assistantId,
        sessionId: ctx.sessionId,
        channelType: ctx.channelType,
        eventName: 'browser_explore',
        metadata: {
          site: sanitizeAnalytics(evt.site),
          steps: evt.steps,
          distilled: evt.distilled,
          ok: evt.ok,
          ...(evt.skillName ? { skill: sanitizeAnalytics(evt.skillName) } : {}),
        },
      })
    },
  })
  allTools.set('browserExplore', buFallback.browserExplore)

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
      connectorGrantStore,
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

  // ── Silent artifact promotion (large-content-artifacts §2.3/§3.1) ──
  // One promoter instance shared by /upload, the web-chat paste intercept,
  // and (via the platform routes) the channel paste intercept. Pipeline B
  // decomposition rides file_ingest_jobs (worker below); a files-less deploy
  // gets null and every caller degrades to legacy behavior.
  const artifactPromoter = filesApi
    ? createArtifactPromoter({
        filesApi,
        enqueue: (job) => enqueueFileIngestJob(job),
      })
    : null

  app.use('/api/chat', optionalAuth(env.JWT_SECRET), chatRoutes({
    provider,
    artifactPromoter,
    checkCreditBudget: ports.checkCreditBudget,
    meteredProfileStore,
    meteredModelsAvailable,
    configuredProviders,
    estimateMeteredTurn: ports.meteredBilling?.estimateMeteredTurn,
    checkMeteredSpendCap: ports.meteredBilling?.checkMeteredSpendCap,
    chargeMeteredSurcharge: ports.meteredBilling?.chargeMeteredSurcharge,
    publishSessionEvent,
    isPlaceholderTitle: ports.isPlaceholderTitle,
    getTitleChannelPrefix: ports.getTitleChannelPrefix,
    injectExtraTools: ports.injectExtraTools,
    resolveExtraSystemPrompt: ports.resolveExtraSystemPrompt,
    resolveAppSoul: ports.resolveAppSoul,
    engineHooks: ports.engineHooks,
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
    filesApi: filesApi ?? undefined,
    usageStore,
    // Doc-page → brain distillation runner — backs the `ingestPage` chat tool.
    ingestPage: ingestPageRunner
      ? ({ userId, pageId }) => ingestPageRunner({ userId, pageId })
      : undefined,
    analytics,
    cacheStore,
    connectorStore,
    mcpSettingsStore,
    assistantConnectorStore,
    connectorGrantStore,
    connectorInstanceStore,
    workspaceToolPolicyStore,
    workerManager,
    workerRunsStore,
    knowledgeStore,
    knowledgeRepoWriter,
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
    generateBlueprintTool,
    blueprintRecordTools,
    buildBlueprintPromptFragment,
    introspectionTools,
  }))

  app.use('/api/v1', publicApiRoutes({
    provider,
    configuredProviders,
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
    filesApi: filesApi ?? undefined,
    assistantConnectorGrantsStore,
    engineHooks: ports.engineHooks,
    checkCreditBudget: ports.checkCreditBudget,
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
    // Doc-page tools (readPage / editPage / deletePage) reuse the same RLS-gated
    // saved-views + doc-page stores the chat doc tools use, so a brain-key page
    // op runs the identical SQL (CAS + undo for edits, cascade delete) as an
    // in-app edit. See packages/api/src/brain-mcp/tools.ts → buildDocPageTools.
    docTools: { savedViewStore, docPageStore: createDbDocPageStore(), pageTemplateStore },
    ingest: brainEpisodeIngestor,
    agentTools: { reads: agentToolset.reads, writes: agentToolset.writes },
    // Powers the searchRecording tool's vector arm (recording-to-brain).
    embedder: sharedEmbedder,
    // Computer-use R2: writeBrowserSkill — the OSS authoring skill's sync tool.
    browserSkills: browserSkillsStore,
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

  app.use('/api/files', optionalAuth(env.JWT_SECRET), fileRoutes(fileStore, fileIngestor as never, artifactPromoter))
  if (filesApi && filesBlobClient) {
    app.use('/api/doc-files', requireAuth(env.JWT_SECRET), docFilesRoutes({
      filesApi,
      store: workspaceFilesStore,
      gcs: filesBlobClient,
      resolver: filesResolver ?? undefined,
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

  // Built-in connector lifecycle (list / store-credentials / disconnect /
  // rename / delete). OSS-only: the hosted edition mounts its own richer closed
  // `/api/connectors` route, so mounting this open one there would shadow it.
  // Gated on the same `USEBRIAN_EDITION` flag the launcher sets for the open
  // single-player edition. See routes/connectors.ts.
  if (process.env.USEBRIAN_EDITION === 'oss') {
    app.use('/api/connectors', requireAuth(env.JWT_SECRET), connectorRoutes({
      connectorStore,
      connectorInstanceStore,
      gcsByo: {
        requireWorkspaceAdmin: async (userId, workspaceId) => {
          const m = await getWorkspaceMembershipWithClearanceSystem(userId, workspaceId)
          return m?.role === 'owner' || m?.role === 'admin'
        },
      },
      s3Byo: {
        requireWorkspaceAdmin: async (userId, workspaceId) => {
          const m = await getWorkspaceMembershipWithClearanceSystem(userId, workspaceId)
          return m?.role === 'owner' || m?.role === 'admin'
        },
      },
    }))
  }

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
      const { isAppType, defaultClearanceForAppType } = await import('@use-brian/shared')
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
    pageTemplateStore,
    workspaceSkillEnablementStore,
    listWorkspaceAssistants: async (userId, workspaceId) =>
      (await listAccessibleAssistants(userId, workspaceId)).map((a) => ({ id: a.id, name: a.name })),
    draftProvider: provider,
    getDraftContext: getSkillDraftContext,
    fileStore,
    checkUsageBudget: ports.checkCreditBudget,
    // Skill import (GitHub / URL): the connector stores back the GitHub
    // browse + PAT resolution; the files store backs imported support files.
    connectorInstanceStore,
    connectorGrantStore,
    workspaceSkillFilesStore,
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

  // Browser-extension pairing (computer-use local mode, P1.3). The relay's
  // WS endpoint derives from the HTTP base: https://relay → wss://relay/ext.
  const browserRelayWsUrl = browserRelayUrl
    ? `${browserRelayUrl.replace(/\/$/, '').replace(/^http/, 'ws')}/ext`
    : null
  // Take-Over live view + backend toggle + Profile-Management
  // (computer-use.md §5, §7; R2-3/R2-4).
  app.use('/api/computer', requireAuth(env.JWT_SECRET), computerRoutes({
    orchestrator: sandboxOrchestrator,
    provider: sandboxProvider,
    vault: ports.browserSessionVault ?? null,
    profileStore: ports.browserProfileStore ?? null,
    grants: ports.browserSkillGrantStore ?? null,
    skills: browserSkillsStore,
    getWorkspaceRole: (userId, workspaceId) => workspaceStore.getRole(userId, workspaceId),
    setSessionBackend: computerTools.setSessionBackendOverride,
  }))

  app.use('/api/browser-extension', requireAuth(env.JWT_SECRET), browserExtensionRoutes({
    jwtSecret: env.JWT_SECRET,
    workspaceStore,
    relayWsUrl: browserRelayWsUrl,
    extensionConnected:
      browserRelayUrl && env.BROWSER_RELAY_SECRET
        ? (userId) =>
            relayExtensionConnected({
              relayUrl: browserRelayUrl as string,
              relaySecret: env.BROWSER_RELAY_SECRET as string,
              userId,
            })
        : null,
  }))

  app.use('/api', publicShareRoutes({
    pageGrantStore,
    taskStore,
    crmStore,
    workflowRunStore,
    workspaceDirectory: workspaceDirectoryStore,
    gcs: filesBlobClient,
  }))

  // Custom-domain site render — PUBLIC, same containment as publicShareRoutes
  // (docs/architecture/features/custom-domains.md). MUST stay before the bare
  // `/api` requireAuth guards below.
  app.use('/api', publicSiteRoutes({
    pageDomainStore,
    taskStore,
    crmStore,
    workflowRunStore,
    workspaceDirectory: workspaceDirectoryStore,
    gcs: filesBlobClient,
  }))

  // PUBLIC closed routes mount HERE — before the bare `/api` requireAuth guards
  // below. Mounting them via `mountExtraRoutes` (which runs last) lets the first
  // bare guard 401 them first. See OpenApiPorts.mountPublicExtraRoutes.
  if (ports.mountPublicExtraRoutes) {
    await ports.mountPublicExtraRoutes(app, { linkedAccountStore, integrationStore, workspaceStore })
  }

  // Workflow webhook receiver — PUBLIC + self-authenticating (per-workflow HMAC,
  // not the user JWT). It MUST mount here, before the bare `app.use('/api',
  // requireAuth(...))` guards below: Express runs path-prefix middleware in
  // registration order, so a later-registered public `/api` route is 401'd by
  // the first bare guard before its handler ever runs (the same footgun the
  // comment above describes — it shadowed this exact route until 2026-06-30).
  // External senders POST with `X-Workflow-Signature`, never a Bearer token.
  // See docs/architecture/features/workflow.md §Webhook trigger.
  app.use('/api', workflowWebhookRoutes({
    workflowStore,
    runStore: workflowRunStore,
    runDeps: workflowExecutorDeps,
  }))

  // Workspace realtime SSE — PUBLIC mount + own `?access_token=` auth
  // (browser EventSource cannot send an Authorization header). Same rule as
  // the webhook receiver above: it MUST register before the bare
  // `app.use('/api', requireAuth(...))` guards below, or the first guard
  // 401s every stream connect with "Missing or invalid Authorization
  // header". That exact shadowing silently killed the stream when this
  // mount sat below the guards (caught by the realtime-sync-audit probe,
  // 2026-07-08 — EventSource swallows the 401 and just retries, so nothing
  // ever surfaced). See docs/architecture/platform/realtime-sync.md.
  app.use('/api/brain/stream', brainStreamRoutes({ workspaceStore, jwtSecret: env.JWT_SECRET }))
  startBrainStreamFanout()

  // Public assistant directory — world-readable by design (its module header:
  // "no auth required"). Same shadowing victim as the stream above: it sat
  // below the bare guards and 401'd for everyone (route-mount-order rule 2).
  app.use('/api/discover', discoverRoutes())

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
    // Computer-use R2: "Allow always for this block+profile" mints a grant.
    browserSkillGrants: ports.browserSkillGrantStore ?? null,
    // Email stranger-sender cards (agentmail.md D4): approve = the sender
    // joins the inbox integration's allowlist. Config-only here; the vendor
    // Lists mirror (the belt) is applied lazily the next time the webhook
    // route touches the inbox. Absent without a channel credential key.
    emailSenderDeps: integrationStore
      ? {
          async allowlistSender(channelIntegrationId, sender) {
            await integrationStore.mergeConfigSystem(channelIntegrationId, (cfg) => ({
              ...cfg,
              allowedUserIds: [...new Set([...(cfg.allowedUserIds ?? []), sender.toLowerCase()])],
            }))
          },
        }
      : undefined,
  }))

  // Goals board — read-only observability over the goal-seeker primitive.
  app.use(
    '/api/goals',
    requireAuth(env.JWT_SECRET),
    goalsRoutes({
      goalStore,
      workspaceStore,
      createCompletionWorkflow,
      kickoffGoal: goalDriver.kickoffGoal,
      assessClarity: goalClarityAssessor,
    }),
  )

  // Model selection surfaces (model-registry.md L10): per-class menus,
  // metered profiles CRUD, pre-flight estimates. Authed; membership-gated
  // per workspace inside the router.
  app.use('/api', requireAuth(env.JWT_SECRET), modelMenuRoutes({
    workspaceStore,
    meteredProfileStore,
    modelDefaultsStore,
    configuredProviders,
    estimateMeteredTurn: ports.meteredBilling?.estimateMeteredTurn,
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
    validateDeliveryTarget: workflowDependencyPreflight.validateDeliveryTarget,
    preflightConnectorTool: workflowDependencyPreflight.preflightConnectorTool,
    emitAudit: async (event) => {
      await workspaceAuditStore.append({
        workspaceId: event.workspaceId,
        actorUserId: event.userId,
        eventType: event.type,
        subjectId: event.workflowId,
        details: { name: event.name },
      })
    },
    listButtonBindings: (actorUserId, workspaceId, workflowId) =>
      pageActionsStore.listForWorkflow(actorUserId, workspaceId, workflowId),
  }))

  // Page-action buttons: bindings CRUD + per-page resolve + invoke dispatch
  // (workflow runs stamped trigger_kind='button', inline-advanced; goal kind
  // through the same GoalStore.create path as setGoal). Same auth posture as
  // the workflows router. See docs/architecture/features/page-actions.md.
  app.use('/api', requireAuth(env.JWT_SECRET), pageActionsRoutes({
    pageActionsStore,
    workspaceStore,
    savedViewStore,
    pageTemplateStore,
    workflowStore,
    runStore: workflowRunStore,
    executorDeps: workflowExecutorDeps,
    goalStore,
  }))

  app.use('/api', requireAuth(env.JWT_SECRET), viewsRoutes({
    savedViewStore,
    pageTemplateStore,
    blueprintRecordStore,
    pageGrantStore,
    pageDomainStore,
    domainProvisioner,
    pageDomainsMaxPerWorkspace: env.PAGE_DOMAINS_MAX_PER_WORKSPACE
      ? Number(env.PAGE_DOMAINS_MAX_PER_WORKSPACE)
      : undefined,
    // Blocked hostnames = this deployment's own origins (derived, exact) + the
    // `.apex` suffixes derived from them (so a subdomain of our own domain,
    // which rides the wildcard, can't be attached as a BYO domain and falsely
    // verify) + operator policy from PAGE_DOMAIN_BLOCKED_HOSTS. Nothing hardcoded.
    pageDomainBlockedHosts: (() => {
      const originHosts = [env.API_URL, env.APP_URL, env.AUTHED_APP_URL]
        .map((url) => {
          if (!url) return null
          try {
            return new URL(url).hostname.toLowerCase()
          } catch {
            return null
          }
        })
        .filter((h): h is string => Boolean(h))
      const operator = (env.PAGE_DOMAIN_BLOCKED_HOSTS ?? '')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean)
      return [...originHosts, ...deriveOwnApexBlocks(originHosts), ...operator]
    })(),
    // Platform-issued workspace subdomains (docs/architecture/features/
    // platform-subdomains.md). Customer subdomains ride the customer apex;
    // first-party workspaces (allowlist) ride the product apex. Either apex
    // unset = that half dark (fail-safe).
    customerSubdomainApex: env.CUSTOMER_SUBDOMAIN_APEX?.trim().toLowerCase() || undefined,
    platformSubdomainApex: env.PLATFORM_SUBDOMAIN_APEX?.trim().toLowerCase() || undefined,
    firstPartySubdomainWorkspaceIds: new Set(
      (env.FIRST_PARTY_SUBDOMAIN_WORKSPACE_IDS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    reservedSubdomainLabels: (() => {
      const originHosts = [env.API_URL, env.APP_URL, env.AUTHED_APP_URL]
        .map((url) => {
          if (!url) return null
          try {
            return new URL(url).hostname.toLowerCase()
          } catch {
            return null
          }
        })
        .filter((h): h is string => Boolean(h))
      const extra = (env.PLATFORM_SUBDOMAIN_RESERVED ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      return deriveReservedSubdomainLabels(originHosts, extra)
    })(),
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
    // Manual "Sync to brain" — the runner runs in the background. Absent when
    // Pipeline B isn't wired (the route then 503s).
    ingestPage: ingestPageRunner
      ? ({ userId, pageId }) => ingestPageRunner({ userId, pageId })
      : undefined,
  }))

  // Teamspaces (migration 313) — Notion-style page containers above the doc
  // page tree. Visibility rides RLS; sensitivity gates live in the routes.
  // See docs/architecture/features/teamspaces.md.
  app.use('/api', requireAuth(env.JWT_SECRET), teamspacesRoutes({
    teamspaceStore: createTeamspaceStore(),
  }))

  // Internal auto-on-save ingest endpoint — doc-sync POSTs here on a debounced
  // settle when a page's "Sync to brain" toggle is on. Shared-secret gated
  // (DOC_SYNC_SECRET) + dedup/cooldown re-gated server-side. Mounted only when
  // the runner exists. NB: NO requireAuth — it authenticates via the shared
  // secret header, not a user JWT (doc-sync has no member context).
  if (ingestPageRunner) {
    app.use('/', internalIngestRoutes({
      savedViewStore,
      ingestPage: ingestPageRunner,
    }))
  }

  // Internal content-edit page-event endpoint — doc-sync POSTs here on a
  // debounced Yjs settle so a *block-content* edit (which never flows through
  // the saved-views store's metadata `update`) still fires a `page`-source
  // `updated` workflow. Shared-secret gated (DOC_SYNC_SECRET); no Pipeline B
  // dependency, so mounted UNCONDITIONALLY — both editions get content-edit
  // triggers. Feeds the same late-bound `publishPageLifecycle` seam the store's
  // metadata writes use. NB: NO requireAuth (shared-secret header, not a JWT).
  app.use('/', internalPageEventRoutes({
    savedViewStore,
    publish: publishPageLifecycle,
  }))

  app.use('/api', requireAuth(env.JWT_SECRET), docEntitiesRoutes({ docEntityStore, workspaceStore }))

  app.use('/api', requireAuth(env.JWT_SECRET), docThemesRoutes({ docThemesStore, workspaceStore, provider, backgroundModel }))

  const commentThreadStore = createDbCommentThreadStore()
  const docNotificationsStore = createDbDocNotificationsStore()
  app.use('/api', requireAuth(env.JWT_SECRET), commentRoutes({ commentThreadStore }))
  app.use('/api', requireAuth(env.JWT_SECRET), inboxRoutes({ commentThreadStore, docNotificationsStore }))
  // Deck live-preview read + export surface (tools registered in the files
  // block above; absent files backend = no decks, so the mount is guarded).
  if (deckStore && filesApi) {
    app.use('/api', requireAuth(env.JWT_SECRET), decksRoutes({ deckStore, filesApi }))
  }

  // (The public /api/brain/stream SSE mount lives ABOVE the bare `/api`
  // requireAuth guards — see the block next to workflowWebhookRoutes.)
  app.use('/api/brain', requireAuth(env.JWT_SECRET), brainRoutes({ entitiesStore, entityLinksStore, retrievalStore, knowledgeStore, workspaceSkillStore, connectorInstanceStore }))
  // Brain inbox (verification surface). Open + hosted share this one mount: the
  // route's deps are all open (brain-inbox-store / entities-store / crm / sessions /
  // notify). `entityKindClassifier` is boot's own; `pendingClassificationStore` is
  // an optional closed port (undefined in OSS → classify/pending endpoints no-op).
  app.use('/api/brain-inbox', requireAuth(env.JWT_SECRET), brainInboxRoutes({
    workspaceStore,
    entityKindClassifier,
    pendingClassificationStore: ports.pendingClassificationStore,
    filesApi,
  }))
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
  // (/api/discover moved to the early-public block above the bare guards.)
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

  // workspace-scoped knowledge route resolves edit-proposal PATs through the
  // same `syncCredentials` resolver the sync worker uses.
  app.use('/api/workspaces/:workspaceId/knowledge', requireAuth(env.JWT_SECRET), workspaceKnowledgeRoutes({
    knowledgeStore,
    connectorInstanceStore,
    connectorGrantStore,
    syncCredentials,
    triggerSync: async () => { if (syncWorkerRef) await syncWorkerRef.tick() },
  }))

  // ════════════════════════════════════════════════════════════════
  // Closed routes (platform-injected) mount here, against the same stores.
  // ════════════════════════════════════════════════════════════════

  // Shared workflow event-trigger dispatcher (the `page` / connector / channel
  // event source) + its binding to the saved-views store's page-write path.
  // This lives in bootOpenApi — not the closed app boot — so BOTH editions get
  // it: the OSS standalone entry (`@use-brian/api-open`) and the closed platform
  // app. The closed app reuses this instance off the BootContext for its Slack
  // webhook + connector-poll producers (`createApiIngestWorkflowTrigger`); it no
  // longer constructs or binds its own. `setPageEventDispatcher` wires the
  // late-bound seam the store published into (page-event-fanout.ts) — without
  // this bind, `publishPageLifecycle` is a no-op and page events never fire a
  // workflow (the OSS regression this fixes). Event runs are attributed to the
  // workflow creator and recorded `triggerKind='event'` — the marker the
  // run-queue drainer claims on, so its enqueued runs are distinguishable from
  // the inline-advanced manual/schedule/goal runs that share `status='pending'`
  // (see workflow-store.ts → claimNextPendingRunSystem; storing `'manual'` here
  // let the drainer resurrect orphaned inline runs — the 2026-07-06 storm).
  // Event run queue — the bounded drain behind event-triggered runs. Event
  // dispatch ENQUEUES (a `pending` workflow_runs row) and never inline-
  // executes; this worker drains with per-workflow serialization, a per-
  // workspace in-flight cap, lease/stale reclaim, and an attempts cap
  // (mig 302). Producers nudge it right after enqueueing so a quiet system
  // keeps near-inline latency; the interval is the durable fallback.
  // Spec: docs/architecture/features/workflow.md → "Event run queue".
  const runQueueWorker = createRunQueueWorker({
    store: createWorkflowRunQueueStore(),
    advance: (runId) => advanceWorkflowRun(workflowExecutorDeps, runId),
    onError: (err, errCtx) => {
      console.warn(
        `[run-queue] ${errCtx.runId ?? '(tick)'} failed:`,
        err instanceof Error ? err.message : err,
      )
    },
  })

  // Storm guard — the spend circuit-breaker at enqueue time. Queuing bounds
  // stability, not cost: at the threshold the workflow is PAUSED (enabled =
  // false + human-readable paused_reason, surfaced by the builder) instead
  // of enqueueing, and the enabled=true finder filter then drops subsequent
  // events for free. Re-enabling via PATCH clears the reason.
  const RUN_STORM_WINDOW_SECONDS = 300
  const RUN_STORM_THRESHOLD = 25

  const workflowEventDispatcher: WorkflowEventDispatcher = createWorkflowEventDispatcher({
    findEventTriggeredWorkflows: ({ workspaceId }) =>
      findEventTriggeredWorkflowsSystem(workspaceId),
    startWorkflowRun: async ({ workflowId, workspaceId, input }) => {
      const recent = await countRecentRunsForWorkflowSystem(
        workflowId,
        RUN_STORM_WINDOW_SECONDS,
      )
      if (recent >= RUN_STORM_THRESHOLD) {
        await pauseWorkflowSystem(
          workflowId,
          `Paused automatically: this workflow's event trigger started ${recent} runs in the last ${Math.round(RUN_STORM_WINDOW_SECONDS / 60)} minutes. Review the trigger's match filter, then re-enable the workflow to resume.`,
        )
        void Promise.resolve(
          workflowExecutorDeps.emitAudit?.({
            type: 'workflow.storm_paused',
            workspaceId,
            actorUserId: null,
            workflowId,
            recentRuns: recent,
            windowSeconds: RUN_STORM_WINDOW_SECONDS,
          }),
        ).catch(() => {})
        console.warn(
          `[workflow-event] storm guard paused workflow ${workflowId} (${recent} runs / ${RUN_STORM_WINDOW_SECONDS}s)`,
        )
        return
      }
      const triggeredBy = await getWorkflowCreatorSystem(workflowId)
      await workflowRunStore.createRun({
        workflowId,
        workspaceId,
        triggeredBy,
        // The ONLY producer that stamps 'event': this run is drained by the
        // run-queue, not advanced inline. The gate in claimNextPendingRunSystem
        // depends on this value.
        triggerKind: 'event',
        input,
      })
      // Enqueue-only: the run row (status `pending`) IS the queue entry.
      // Nudge the local drain for near-inline latency on quiet systems.
      runQueueWorker.nudge()
    },
    // Second subscriber (additive): goals parked on `until:event`. The finder
    // reads the workspace's non-terminal goals carrying an `awaiting_event`
    // marker and exposes their subscriptions; the resumer hands off to the
    // driver, which clears the marker and schedules an immediate tick restoring
    // the preserved loop state. Wiring BOTH enables the goal fan-out; the
    // workflow path above is untouched.
    findEventWaitingGoals: async ({ workspaceId }) => {
      const rows = await findEventWaitingGoalsSystem(workspaceId)
      return rows.map((r) => ({ goalId: r.goalId, workspaceId, sources: r.subscriptions }))
    },
    resumeEventWaitingGoal: ({ goalId }) => goalDriver.resumeOnEvent(goalId),
    onError: (err, errCtx) => {
      const subject = errCtx.workflowId
        ? `workflow ${errCtx.workflowId}`
        : errCtx.goalId
          ? `goal ${errCtx.goalId}`
          : '(finder)'
      console.warn(
        `[workflow-event] ${subject} failed:`,
        err instanceof Error ? err.message : err,
      )
    },
  })
  setPageEventDispatcher(workflowEventDispatcher)
  // Task lifecycle events ride the same dispatcher — the late-bound seam
  // `db/tasks.ts` publishes into (no-op until this bind). Both editions.
  setTaskEventDispatcher(workflowEventDispatcher)

  // ════════════════════════════════════════════════════════════════
  // Open background workers
  // ════════════════════════════════════════════════════════════════
  const jobExecutor = createJobExecutor({
    jobStore,
    analytics,
    // A goal tick carries no `workflow_id` by design; exempt it from the
    // executor's straggler invariant so it reaches `runWorkflowFromJob` below
    // (single source of truth for the shape is `parseGoalTick`).
    isDelegateHandledWithoutWorkflow: (job) => parseGoalTick(job.instructions) !== null,
    runWorkflowFromJob: async (job) => {
      // Goal-tick (acting loop, R1): the job carries no workflowId/stepRunId —
      // the goal's own means.workflowId is what each iteration runs. The
      // poll-worker's once-job handling deletes this row after we return, and
      // the tick's own re-arm writes the next one-shot (or terminates).
      const goalTick = parseGoalTick(job.instructions)
      if (goalTick) {
        await goalDriver.tickGoal(goalTick.goalId, goalTick.state)
        return `goal tick: ${goalTick.goalId}`
      }
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
  if (runWorkers) runQueueWorker.start()

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

  // ── BYO storage staleness GC (scheduled maintenance, daily) ──
  // Soft-disconnected GCS bindings keep read access through a grace window;
  // once past it they are stale — wipe the key + retract the orphaned files.
  // Runs only where the workspace-files byte layer is active.
  if (runWorkers && filesBlobClient) {
    const BYO_STALENESS_INTERVAL_MS = 24 * 60 * 60 * 1000
    const runByoStalenessSweep = () => {
      void sweepStaleByoBindings({
        connectorInstanceStore,
        workspaceFilesStore,
        nowMs: Date.now(),
        log: (m) => console.log(m),
      }).catch((err) => console.error('[byo-staleness] sweep failed:', err))
    }
    const byoStalenessTimer = setInterval(runByoStalenessSweep, BYO_STALENESS_INTERVAL_MS)
    if (typeof byoStalenessTimer.unref === 'function') byoStalenessTimer.unref()
  }

  // ── Skill-review worker ──
  const SKILL_REVIEW_MODEL = backgroundModel
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

  // ── Workflow lifecycle sweep worker (mig 308) ──
  // Stales / archives / one-off-deletes unused workflows and digests
  // retiring patterns into staged skill candidates. Ships dark behind
  // WORKFLOW_LIFECYCLE_ENABLED; spec: docs/architecture/features/
  // workflow-lifecycle.md.
  const workflowDigestLLM = createGeminiWorkflowDigestLLM(
    async ({ systemPrompt, prompt, maxTokens, attribution }) => {
      const response = await collectStream(provider.stream({
        model: backgroundModel,
        messages: [{ role: 'user', content: prompt }],
        systemPrompt,
        maxTokens,
      }))
      if (response.usage && usageStore) {
        const cost = calculateCost(backgroundModel, response.usage)
        usageStore.recordUsage({
          userId: attribution.userId,
          // Blank assistant + workspace fallback — the mig-305 attribution
          // axis for recorders with no single assistant.
          assistantId: '',
          workspaceId: attribution.workspaceId,
          sessionId: null,
          model: backgroundModel,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          cacheReadTokens: response.usage.cacheReadTokens,
          cacheWriteTokens: response.usage.cacheWriteTokens,
          actualCostUsd: cost,
          source: 'overhead:workflow-digest',
        }).catch((err) => console.error('[workflow-lifecycle] usage tracking failed:', err))
      }
      return response.content
        .filter((b) => b.type === 'text')
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
    },
  )
  const workflowLifecycleWorker = createWorkflowLifecycleWorker({
    store: {
      listSweepRows: listLifecycleSweepRowsSystem,
      applyTransition: applyLifecycleTransitionSystem,
      markDigested: markWorkflowsDigestedSystem,
      deleteWorkflow: deleteWorkflowSystem,
      getWorkflow: (id) => workflowStore.findByIdSystem(id),
    },
    digestLLM: workflowDigestLLM,
    skillPort: {
      async listSkillSummaries(workspaceId, actingUserId) {
        const skills = await workspaceSkillStore.listForWorkspace(workspaceId, { actingUserId })
        return skills.map((s) => ({
          slug: s.slug,
          name: s.name,
          description: s.description ?? '',
        }))
      },
      async hasPendingOrExistingSlug(workspaceId, slug) {
        const existing = await query(
          `SELECT 1 FROM workspace_skills
            WHERE workspace_id = $1 AND slug = $2 AND valid_to IS NULL
            LIMIT 1`,
          [workspaceId, slug],
        )
        if ((existing.rowCount ?? 0) > 0) return true
        const staged = await query(
          `SELECT 1 FROM pending_approvals
            WHERE workspace_id = $1
              AND kind = 'staged_skill_creation'
              AND responded_at IS NULL
              AND arguments->'umbrella'->>'slug' = $2
            LIMIT 1`,
          [workspaceId, slug],
        )
        return (staged.rowCount ?? 0) > 0
      },
      async stageCandidate({ workspaceId, umbrella, approverUserId, sourceWorkflowIds }) {
        await pendingApprovalsStore.createStagedSkillCreation({
          workspaceId,
          proposedUmbrella: umbrella,
          approverUserId,
          originatingAssistantId: null,
          origin: 'workflow-digest',
          sourceWorkflowIds,
        })
      },
    },
    emitAudit: (event) =>
      workspaceAuditStore.append({
        workspaceId: event.workspaceId,
        actorUserId: null,
        eventType: event.eventType,
        subjectId: event.subjectId,
        details: event.details,
      }),
    enabled: env.WORKFLOW_LIFECYCLE_ENABLED ?? false,
    onEvent: (event) => {
      if (event.type === 'tick_complete') {
        console.log(
          `[workflow-lifecycle] tick complete — staled:${event.staled} archived:${event.archived} reactivated:${event.reactivated} deleted:${event.deleted} digested:${event.digested} staged:${event.staged}`,
        )
      }
    },
  })
  if (runWorkers) workflowLifecycleWorker.start()

  // ── Sandbox lifecycle reaper (computer-use.md §7) — kills tasks idle past
  //    the Take-Over abandonment window + runs the vault's per-plan purge.
  //    Only exists when a sandbox provider is configured. ──
  if (sandboxOrchestrator) {
    const sandboxReaper = createSandboxReaper({
      orchestrator: sandboxOrchestrator,
      vault: ports.browserSessionVault ?? null,
      onEvent: (event) => {
        if (event.reaped > 0 || event.purged > 0) {
          console.log(`[sandbox-reaper] tick — reaped:${event.reaped} purged:${event.purged}`)
        }
      },
    })
    if (runWorkers) sandboxReaper.start()
  }

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
    const _aggregatorEmbedder = sharedEmbedder
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
  // default primitive set from the embedding store. `usage` records each
  // committed batch as `overhead:embedding` COGS (workspace-fallback
  // attribution) — absent in OSS, embedding runs unmetered locally.
  const embeddingWorker = createEmbeddingWorker({
    store: createDbEmbeddingStore(),
    embedder: sharedEmbedder,
    ...(usageStore ? { usage: createEmbeddingUsageRecorder(usageStore, sharedEmbedder.model_id) } : {}),
  })
  if (runWorkers) embeddingWorker.start()

  // ── File-ingest worker (large-content-artifacts §Phase 2.2) ──
  // Drains file_ingest_jobs: readBytes → parse → chunk (idempotent) →
  // Pipeline B (when the platform passed an episode-ingestor port; OSS
  // without one runs store-only) → stamp source_episode_id + indexing status.
  // Same single-service model as every worker: runs only where runWorkers is
  // set (prod: brian-api-workers).
  const fileIngestWorker = filesApi
    ? createFileIngestWorker({
        claim: claimNextFileIngestJob,
        markDone: markFileIngestJobDone,
        markFailed: markFileIngestJobFailed,
        filesApi,
        ...(brainEpisodeIngestor ? { brainIngest: brainEpisodeIngestor } : {}),
      })
    : null
  if (runWorkers && fileIngestWorker) fileIngestWorker.start()

  // ── file_cache reaper ──
  // Cached files are read with an `expires_at > now()` filter, so a lapsed row
  // is already invisible; this jittered 6h sweep reclaims its storage. Gated on
  // `runWorkers` and wrapped so a failing tick never crashes boot. Stopped in
  // `shutdown()` like the workers above.
  const fileCacheReaper = runWorkers
    ? startJitteredInterval(() => {
        void Promise.resolve(fileStore.sweepExpired?.())
          .then((n) => { if (n && n > 0) console.log(`[file-cache-reaper] deleted ${n} expired file(s)`) })
          .catch((err) => console.error('[file-cache-reaper] sweep failed:', err))
      }, 6 * 60 * 60 * 1000)
    : null

  // ── Knowledge sync worker ──
  // Uses the `syncCredentials` resolver built once above (platform closed
  // factory, or the open resolver over the connector stores).
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
      getRepoPermissions,
    },
    credentials: syncCredentials,
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

  // ── Goal stall reaper ──
  // The acting loop's external watchdog: recovers goals wedged `running` by a
  // crash mid-tick and confirmed acting goals whose re-arm chain died. See
  // goals.md → "Stall recovery — the goal reaper".
  const goalStallReaper = createGoalStallReaper({
    rearm: async (goalId) => {
      const goal = await getGoalByIdSystem(goalId)
      if (goal) await scheduleGoalTick(goal, new Date(), INITIAL_GOAL_LOOP_STATE)
    },
    onRecovered: ({ id, sweep }) => {
      void getGoalByIdSystem(id).then((goal) => {
        if (!goal?.createdByUserId) return
        analytics.logEvent({
          userId: goal.createdByUserId,
          channelType: 'workflow',
          eventName: 'goal_stall_recovered',
          metadata: { goal_id: sanitizeAnalytics(id), sweep: sanitizeAnalytics(sweep) },
        })
      }).catch(() => {})
    },
  })
  if (runWorkers) goalStallReaper.start()

  // ── Views auto-prune worker ──
  const viewsPruneWorker = createViewsPruneWorker({ savedViewStore })
  if (runWorkers) viewsPruneWorker.start()

  // The hosted composition starts anonymous shadow-user pruning from
  // mountExtraRoutes; the open store itself is exposed on BootContext.

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

  // Structural-synthesis callback for the recording path (blueprint → brief page
  // + guided capture). Built here where the doc/CRM/task/directory stores live;
  // the closed recording factory only holds the reference. Undefined without a
  // Gemini key (the searchRecording vector arm needs the embedder). See
  // docs/architecture/brain/structural-synthesis.md → "The first source".
  const recordingSynthesize: RecordingSynthesizeFn | undefined = env.GEMINI_API_KEY
    ? createRecordingSynthesizer({
        provider,
        model: 'gemini-flash',
        savedViewStore,
        docPageStore: createDbDocPageStore(),
        crmStore,
        taskStore,
        memoryStore,
        workflowRunStore,
        workspaceDirectory: workspaceDirectoryStore,
        embedder: sharedEmbedder,
        usageStore,
        pageTemplateStore,
        blueprintRecordStore,
        computeCostUsd: (model, usage) => calculateCost(model, usage),
      })
    : undefined

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
    engineHooks: ports.engineHooks,
    workspaceStore,
    workspaceAuditStore,
    memoryStore,
    entitiesStore,
    entityLinksStore,
    episodesStore,
    crmStore,
    taskStore,
    recordingSynthesize,
    generateSynthesize,
    connectorStore,
    connectorInstanceStore,
    workspaceToolPolicyStore,
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
    channelUserStore,
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

  // ════════════════════════════════════════════════════════════════
  // BYO channel runtime (open for both editions since the channels
  // open-core move; docs/architecture/channels/adapter-pattern.md).
  // Mounted here — after BootContext assembly, before mountExtraRoutes —
  // which is the same effective position the closed app mounted them from
  // before the move, so the Express `/api` guard ordering is unchanged.
  // Hosted-only enrichments (Pipeline-C Slack ingest, GCS media intake,
  // recording surcharge) arrive via `ports.buildChannelHosts`.
  // ════════════════════════════════════════════════════════════════
  {
    const channelHosts: ChannelHostHooks = ports.buildChannelHosts
      ? await ports.buildChannelHosts(ctx)
      : {}
    const discordConnector =
      env.DISCORD_CONNECTOR_URL && env.DISCORD_CONNECTOR_SECRET
        ? createDiscordConnectorClient({
            connectorUrl: env.DISCORD_CONNECTOR_URL,
            connectorSecret: env.DISCORD_CONNECTOR_SECRET,
          })
        : undefined
    const whatsappConnector =
      env.WA_CONNECTOR_URL && env.WA_CONNECTOR_SECRET
        ? createWhatsappConnectorClient({
            connectorUrl: env.WA_CONNECTOR_URL,
            connectorSecret: env.WA_CONNECTOR_SECRET,
          })
        : undefined

    // Workspace channels operator surface (Studio → Channels).
    app.use('/api', requireAuth(env.JWT_SECRET), channelsRoutes({
      workspaceStore,
      integrationStore: integrationStore ?? undefined,
      apiUrl: env.API_URL,
      discordConnector,
      whatsappConnector,
      // Fallback bot for naming sessions-derived telegram delivery destinations.
      telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    }))

    if (integrationStore && env.WA_CONNECTOR_URL && env.WA_CONNECTOR_SECRET) {
      const whatsapp = createWhatsappByonRuntime({
        connectorUrl: env.WA_CONNECTOR_URL,
        connectorSecret: env.WA_CONNECTOR_SECRET,
        integrationStore,
        provider,
        crm: crmStore,
        entities: entitiesStore,
        entityLinks: entityLinksStore,
        memories: memoryStore,
        tasks: taskStore,
        episodes: episodesStore,
        ingestRulesStore,
        analytics,
        usageStore,
        ingestCharge: ports.ingestCharge,
        scheduledBatching: ports.whatsappScheduledBatching,
        runPipeline: async ({ ctx: channel, input, hooks, abortController }) => {
          if (!channel.assistantId) return
          await processChannelMessage({
            backgroundModel,
            userId: channel.ownerUserId,
            ownerId: channel.ownerUserId,
            assistant: {
              id: channel.assistantId,
              name: channel.assistantName,
              ownerUserId: channel.ownerUserId,
              workspaceId: channel.workspaceId,
              systemPrompt: channel.persona,
              clearance: channel.assistantClearance,
              kind: channel.assistantKind,
            },
            isIdentified: true,
            channelType: 'whatsapp',
            channelId: input.chatJid,
            actorChannelId: (input.senderPnJid ?? input.senderJid).split('@')[0] ?? null,
            mediaEpisodeId: input.mediaEpisodeId,
            messageText: input.text,
            rawUserText: input.text,
            artifactPromoter,
            userContentBlocks: [{ type: 'text', text: input.text }],
            isGroupChat: input.isGroup,
            incomingChannelMessageId: input.messageId,
            modelAlias: undefined,
            adaptiveResearchEnabled: true,
            abortController,
            provider,
            systemPrompt: LAYER_1_SYSTEM_PROMPT,
            tools: allTools,
            memoryStore,
            usageStore,
            analytics,
            connectorStore,
            mcpSettingsStore,
            checkCreditBudget: ports.checkCreditBudget,
            assistantConnectorStore,
            connectorGrantStore,
            connectorInstanceStore,
            knowledgeStore,
            gdriveFilesStore,
            workspaceFilesStore,
            filesApi: filesApi ?? undefined,
            skillStore,
            workerManager,
            episodicStore,
            sessionStateStore,
            capabilityStore,
            hooks,
          })
        },
      })
      app.use('/api', requireAuth(env.JWT_SECRET), whatsappIngestAdminRoutes({
        workspaceStore,
        integrationStore,
        ruleEditor: ingestRuleEditorStore,
        waConnectorUrl: env.WA_CONNECTOR_URL,
        waConnectorSecret: env.WA_CONNECTOR_SECRET,
        scheduledBatching: ports.whatsappScheduledBatching,
      }))
      app.use('/internal/whatsapp', whatsappByonRoutes({
        connectorSecret: env.WA_CONNECTOR_SECRET,
        integrationStore,
        ingestor: whatsapp.ingestor,
        bot: whatsapp.bot,
        passUnknownToFallback: ports.whatsappOfficialFallback,
      }))
    }

    // Telegram / Slack account linking — web-side of the link-code handshake.
    app.use('/api/assistants/:assistantId/telegram', requireAuth(env.JWT_SECRET),
      telegramLinkingRoutes({ linkedAccountStore, linkCodeStore }))
    app.use('/api/assistants/:assistantId/slack', requireAuth(env.JWT_SECRET),
      slackLinkingRoutes({ linkedAccountStore, linkCodeStore }))

    // Inbound webhooks — self-authenticating (per-integration secrets), so no
    // JWT guard. All gated on the integration store (CHANNEL_CREDENTIAL_KEY).
    if (integrationStore) {
      app.use('/webhook/telegram', telegramByoRoutes({
        backgroundModel,
        provider, systemPrompt: LAYER_1_SYSTEM_PROMPT, tools: allTools, capabilityStore,
        memoryStore, usageStore, checkCreditBudget: ports.checkCreditBudget,
        appUrl: env.APP_URL, apiUrl: env.API_URL, integrationStore,
        linkedAccountStore, channelUserStore, workerManager, connectorStore, mcpSettingsStore,
        assistantConnectorStore, connectorGrantStore, connectorInstanceStore, knowledgeStore,
        gdriveFilesStore, workspaceFilesStore, filesApi: filesApi ?? undefined, analytics,
        skillStore, pendingMessageStore, deferredConfirmationStore, episodicStore,
        sessionStateStore, voiceTranscription, workspaceToolPolicyStore,
        recordingIngest: channelHosts.recordingIngest,
        ingestChannelMediaRef: channelHosts.telegramIngestChannelMediaRef,
        artifactPromoter, fileStore,
      }))
      app.use('/webhook/slack', slackRoutes({
        backgroundModel,
        ingestChannelMediaRef: channelHosts.slackIngestChannelMediaRef,
        artifactPromoter,
        provider, systemPrompt: LAYER_1_SYSTEM_PROMPT, tools: allTools, capabilityStore,
        memoryStore, usageStore, checkCreditBudget: ports.checkCreditBudget,
        integrationStore, channelUserStore, linkedAccountStore, linkCodeStore,
        workerManager, connectorStore, mcpSettingsStore, assistantConnectorStore, connectorGrantStore,
        connectorInstanceStore, knowledgeStore, gdriveFilesStore, workspaceFilesStore,
        filesApi: filesApi ?? undefined, analytics, skillStore, pendingMessageStore,
        deferredConfirmationStore, episodicStore, sessionStateStore, workflowEventDispatcher,
        slackWebhookIngestor: channelHosts.slackWebhookIngestor, connectorActionStore, episodesStore,
        buildConnectorActionAudit: ports.buildConnectorActionAudit,
      }))
      // Microsoft Teams — public Bot Framework messaging endpoint, per-channel
      // JWT-verified. No connector app (webhook transport). See
      // docs/architecture/channels/msteams.md.
      app.use('/webhook/msteams', msteamsRoutes({
        backgroundModel,
        provider, systemPrompt: LAYER_1_SYSTEM_PROMPT, tools: allTools, capabilityStore,
        memoryStore, usageStore, checkCreditBudget: ports.checkCreditBudget,
        integrationStore, channelUserStore,
        workerManager, connectorStore, mcpSettingsStore, assistantConnectorStore, connectorGrantStore,
        connectorInstanceStore, knowledgeStore, gdriveFilesStore, workspaceFilesStore,
        analytics, skillStore, pendingMessageStore,
        episodicStore, sessionStateStore, artifactPromoter,
        msteamsWebhookIngestor: channelHosts.msteamsWebhookIngestor,
      }))
      if (env.DISCORD_CONNECTOR_SECRET) {
        app.use('/internal/discord', discordRoutes({
        backgroundModel,
          ingestChannelMediaRef: channelHosts.discordIngestChannelMediaRef,
          artifactPromoter,
          connectorSecret: env.DISCORD_CONNECTOR_SECRET, provider, systemPrompt: LAYER_1_SYSTEM_PROMPT,
          tools: allTools, capabilityStore, memoryStore, usageStore,
          checkCreditBudget: ports.checkCreditBudget, integrationStore, channelUserStore,
          workerManager, connectorStore, mcpSettingsStore, assistantConnectorStore, connectorGrantStore,
          connectorInstanceStore, knowledgeStore, gdriveFilesStore, workspaceFilesStore, analytics,
          skillStore, pendingMessageStore, episodicStore, sessionStateStore,
        }))
      }
    }
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
        console.log(`Use Brian api running on port ${port}`)
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
    runQueueWorker.stop()
    knowledgeSyncWorker.stop()
    stuckSessionSweeper.stop()
    fileIngestWorker?.stop()
    if (fileCacheReaper) stopJitteredInterval(fileCacheReaper)
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
