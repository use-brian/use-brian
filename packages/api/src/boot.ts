/**
 * bootOpenApi — the OPEN composition root for the Use Brian HTTP API.
 *
 * This module composes the entire OPEN slice of the API service from ordered
 * boot register modules (`packages/api/src/boot/*.register.ts`): the express
 * app + middleware, the LLM provider stack, every open DB store, the open tool
 * set, the open route mounts (in the platform's original order), and the open
 * background workers. Each register step receives the bindings the earlier
 * steps built and returns the ones later steps consume (`boot/scope.ts`); the
 * few bindings that cross steps against construction order live in one
 * per-boot late-binding table (`boot/late.ts`). The composition list below IS
 * the mount order. The root itself keeps only its own seams: the turn-kernel
 * inference registration, the early public overlay hook, the late overlay hook
 * and the session-event bus.
 *
 * It imports ZERO closed code — every closed seam is an OPTIONAL injected PORT
 * with a safe default (allow-all credit gate, no-op usage recorder, inert feed
 * hooks, no-op episode ingestors, …). The closed platform entry
 * (`apps/api/src/index.ts`, `@use-brian/api-server`) calls this with the real
 * impls + a `mountExtraRoutes` hook that mounts the closed routes onto the same
 * app against the SAME store instances exposed on `BootContext`. A standalone
 * open entry (`use-brian/apps/api`, `@use-brian/api-open`) calls it with no
 * ports → all safe defaults.
 *
 * Spec: docs/architecture/platform/deployment.md → "Boot composition";
 * docs/architecture/foundation/open-core-placement.md → "Runtime Package
 * Boundary".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or `@use-brian/shared-server`
 * from this file or a register module. The classification rule is mechanical —
 * those two specifiers are the only "closed" import surfaces. Config + secrets
 * arrive through the `env` option, not `getEnv()`.
 */
import type { UsageStore } from '@use-brian/agent-runtime/billing/cost-tracker.js'
import type { EngineHooks } from '@use-brian/agent-runtime/engine/hooks.js'
import type { ExternalCredentialPool } from '@use-brian/agent-runtime/providers/credential-pool.js'
import type { LLMProvider } from '@use-brian/agent-runtime/providers/types.js'
import type { Tool } from '@use-brian/agent-runtime/tools/types.js'
import type { AnalyticsLogger } from '@use-brian/core/analytics/logger.js'
import type { ApplicationModuleDefinition } from '@use-brian/core/application-platform/contracts.js'
import type { BrainCandidateStore } from '@use-brian/core/brain/candidates-types.js'
import type { PendingClassificationStore } from '@use-brian/core/classification/pending-queue.js'
import type {
  createEntityKindClassifier,
} from '@use-brian/core/classification/rules/entity-kind/index.js'
import type { SyncCredentials } from '@use-brian/core/knowledge/sync-worker.js'
import type { MediaBackend } from '@use-brian/core/media/backend.js'
import type { BrowserCredentialStore } from '@use-brian/core/sandbox/browser-credentials.js'
import type { BrowserSkillGrantStore } from '@use-brian/core/sandbox/browser-skills.js'
import type { SandboxTaskStore } from '@use-brian/core/sandbox/orchestrator.js'
import type { BrowserProfileStore } from '@use-brian/core/sandbox/profiles.js'
import type { SessionVault } from '@use-brian/core/sandbox/types.js'
import type { TaskAdmissionPort } from '@use-brian/core/tasks/admission.js'
import type { GDriveFilesStore } from '@use-brian/core/tools/base/gdrive-files.js'
import type { createWorkerManager } from '@use-brian/core/workers/worker.js'
import type { WorkflowEventDispatcher } from '@use-brian/core/workflow/event-trigger.js'
import type { ExecutorDeps as WorkflowExecutorDeps } from '@use-brian/core/workflow/executor.js'
import type { PoolClient } from 'pg'
import type { ConnectorSourceRuntimeFactory } from './application-platform/source-runtime.js'
import { configureTurnKernel } from './turn/runtime.js'
import type { createWorkspaceStore } from './db/workspace-store.js'
import type { createDbEntitiesStore } from './db/entities-store.js'
import type http from 'node:http'
import type { Express } from 'express'
import type { findUserById } from './db/users.js'
import type { createDbConnectorActionStore } from './db/connector-actions-store.js'
import type { createDbMagicLinkStore } from './db/magic-link-store.js'
import type { createSmtpClient } from './email/smtp-client.js'
import type { AccountTeardownRule } from './db/account-teardown.js'
import type { AssistantTeardownRule } from './db/assistant-teardown.js'
import type { workspaceRoutes } from './routes/workspaces.js'
import type { externalAppConfiguration } from './external-app-documents/configuration.js'
import type { createWorkspaceAuditStore } from './db/workspace-audit-store.js'
import type {
  enqueueRecordingJob, claimNextRecordingJob, markRecordingJobDone, markRecordingJobFailed,
} from './db/recording-jobs-store.js'
import type { createChatConfirmationStore } from './db/chat-confirmation-store.js'
import type { createDeferredConfirmationStore } from './db/deferred-confirmation-store.js'
import type { createDbKnowledgeStore } from './db/knowledge-store.js'
import type { createDbKnowledgeCaptureRuleStore } from './knowledge/capture-rules.js'
import { startSessionEventBus } from './session-event-bus.js'
import type { createDbMcpSettingsStore } from './db/mcp-settings-store.js'
import type { createDbConnectorStore } from './db/connector-store.js'
import type { createConnectorInstanceStore } from './db/connector-instance-store.js'
import type { createWorkspaceToolPolicyStore } from './db/workspace-tool-policy-store.js'
import type { createDbAssistantConnectorStore } from './db/assistant-connector-store.js'
import type { createDbAssistantConnectorGrantsStore } from './db/assistant-connector-grants-store.js'
import type { createDbSkillStore, createDbWorkspaceSkillStore } from './db/skill-store.js'
import type { createDbWorkspaceSkillFilesStore } from './db/workspace-skill-files-store.js'
import type { createDbWorkspaceSkillEnablementStore } from './db/workspace-skill-enablement-store.js'
import type { loadSkillRegistry } from './registry/load-skill-registry.js'
import type { telegramByoRoutes } from './routes/telegram-byo.js'
import type { slackRoutes } from './routes/slack.js'
import type { discordRoutes } from './routes/discord.js'
import type { createDbChannelUserStore } from './db/channel-user-store.js'
import type { createIngestRulesStore } from './db/ingest-rules-store.js'
import type { IngestApplicationService } from './ingest/application-service.js'
import type { createDbLinkedAccountStore } from './db/linked-accounts.js'
import type { createDbLinkCodeStore } from './db/link-codes.js'
import type { createDbMemoryStore } from './db/memory-store.js'
import type { createDbTaskStore } from './db/tasks-store.js'
import type { createDbCrmStore } from './db/crm-store.js'
import type { createDbWorkspaceFilesStore } from './db/workspace-files-store.js'
import type { GcsFilesClient } from './files/gcs-client.js'
import type { createDocGateway } from './doc/doc-gateway.js'
import type { createFilesApi, FilesClientResolver } from './files/files-api.js'
import type { ChunkedFileUploadService } from './files/chunked-upload.js'
import type { createDbWorkflowStore, createDbWorkflowRunStore } from './db/workflow-store.js'
import type { ApprovalBridgeDeps } from './workflow/approval.js'
import type { createDbSavedViewStore } from './db/saved-views-store.js'
import type { RecordingSynthesizeFn } from './synthesis/recording-synthesizer.js'
import type { GenerateSynthesizeFn } from './synthesis/generate-synthesizer.js'
import type { createDbDocPageStore } from './db/doc-page-store.js'
import type { createDbEpisodicStore } from './db/episodic-store.js'
import type { createDbEpisodesStore } from './db/episodes-store.js'
import type { createDbEntityLinksStore } from './db/entity-links-store.js'
import type { createDbSessionStateStore } from './db/session-state-store.js'
import type { createDbJobStore } from './db/job-store.js'
import type { createDbWorkerRunsStore } from './db/worker-runs-store.js'
import type { createDbCapabilityStore } from './db/capability-store.js'
import type { createDbChannelIntegrationStore } from './db/channel-integrations.js'
import type { createDbApiKeyStore } from './db/api-key-store.js'
import type { GenerateSynthesisBilling } from './routes/generate-synthesis.js'
import { getPool } from './db/client.js'
import type { ChatEpisodeInput, ChatEpisodeIngestor, BrainEpisodeIngestor } from './ingest-port.js'
import type { BuildConnectorActionAudit } from './connector-action-port.js'
import type { InjectExtraTools, ResolveAppSoul } from './tool-injection-port.js'
import type { CreditBudgetGate } from './routes/route-helpers.js'
import type {
  DecisionRuntime, DecisionRouteResolver, CreateDecisionRuntimeOptions, DecisionRuntimeAttempt,
  DecisionRuntimeOutcome,
} from './decision-runtime.js'
import { registerOverlaySeams } from './boot/overlay-seams.register.js'
import { registerHttp } from './boot/http.register.js'
import { registerRuntime } from './boot/runtime.register.js'
import { registerStores } from './boot/stores.register.js'
import { registerProviders } from './boot/providers.register.js'
import { registerConnectors } from './boot/connectors.register.js'
import { registerAuth } from './boot/auth.register.js'
import { registerWorkspace } from './boot/workspace.register.js'
import { registerTools } from './boot/tools.register.js'
import { registerOfficeTools } from './boot/office-tools.register.js'
import { registerCapture } from './boot/capture.register.js'
import { registerAssistants } from './boot/assistants.register.js'
import { registerWorkflow } from './boot/workflow.register.js'
import { registerPrimitives } from './boot/primitives.register.js'
import { registerFiles } from './boot/files.register.js'
import { registerComputerUse } from './boot/computer-use.register.js'
import { registerChatRoutes } from './boot/chat-routes.register.js'
import { registerIntegrationRoutes } from './boot/integration-routes.register.js'
import { registerSessionRoutes } from './boot/session-routes.register.js'
import { registerWorkspaceRoutes } from './boot/workspace-routes.register.js'
import { registerPublicRoutes } from './boot/public-routes.register.js'
import { registerApiRoutes } from './boot/api-routes.register.js'
import { registerOfficeRoutes } from './boot/office-routes.register.js'
import { registerBrainRoutes } from './boot/brain-routes.register.js'
import { registerWorkflowEvents } from './boot/workflow-events.register.js'
import { registerWorkers } from './boot/workers.register.js'
import { registerLearningWorkers } from './boot/learning-workers.register.js'
import { registerMemoryWorkers } from './boot/memory-workers.register.js'
import { registerRecordingWorkers } from './boot/recording-workers.register.js'
import { registerSyncWorkers } from './boot/sync-workers.register.js'
import { registerBootContext } from './boot/boot-context.register.js'
import { registerChannels } from './boot/channels.register.js'
import { registerLifecycle } from './boot/lifecycle.register.js'
import type { BootLate } from './boot/late.js'
import type { RootScope } from './boot/scope.js'


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
  ASSOCIATION_PROMOTION_HMAC_KEY?: string
  // Optional because the Gemini provider can be Vertex-backed instead (see
  // VERTEX_PROJECT_ID). A deployment in a region where Google blocks the AI
  // Studio developer API (e.g. Hong Kong) has no such key; the open entry
  // requires GEMINI_API_KEY *or* VERTEX_PROJECT_ID.
  GEMINI_API_KEY?: string
  /** Optional TypeSafe System One credential. Absence keeps decisions LLM-only. */
  TYPESAFE_API_KEY?: string
  /** Dedicated key for the native OpenAI Decisions endpoint, separate from subscription chat. */
  OPENAI_DECISIONS_API_KEY?: string
  /** Both values are required to activate the audited deployment-wide decision override. */
  DECISION_DEFAULT_MODE?: string
  DECISION_DEFAULT_MODEL?: string
  DECISION_DEFAULT_OPERATIONS?: string
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
  /** Public origin serving native campaign unsubscribe and click routes. */
  CAMPAIGN_PUBLIC_ORIGIN?: string
  CAMPAIGN_DKIM_DOMAIN?: string
  CAMPAIGN_DKIM_SELECTOR?: string
  CAMPAIGN_DKIM_PRIVATE_KEY?: string
  /** Dedicated Outpost auth portal; falls back to APP_URL in other profiles. */
  AUTH_PORTAL_URL?: string
  OUTPOST_AUTH_EMAIL_ENABLED?: boolean
  OUTPOST_LOCAL_OWNER_USER_ID?: string
  OUTPOST_LOCAL_OWNER_EMAIL?: string
  OUTPOST_AUTH_OIDC_ENABLED?: boolean
  OUTPOST_OIDC_SUBJECT_IDENTITY_ENABLED?: boolean
  OUTPOST_OIDC_ENROLLMENT_MODE?: string
  OUTPOST_OIDC_WORKSPACE_MAPPINGS?: string
  OUTPOST_OIDC_ISSUER_URL?: string
  OUTPOST_OIDC_CLIENT_ID?: string
  OUTPOST_OIDC_CLIENT_SECRET?: string
  OUTPOST_OIDC_PROVIDER_NAME?: string
  OUTPOST_AUTH_BRIDGE_SECRET?: string
  AUTHED_APP_URL?: string
  FEED_URL?: string
  /**
   * Optional hosted Use Brian origin for paid OSS Feed capabilities. The
   * local API remains authoritative for planning and sends only scoped Feed
   * requests through the Cloud Link.
   */
  MANAGED_FEED_CLOUD_URL?: string
  /** OSS-only, local support-capsule capture. Hosted compositions leave unset. */
  SUPPORT_DIAGNOSTICS_ENABLED?: boolean
  /** Optional Cloud Run injected port; falls back to API_URL port / 4000. */
  PORT?: string
  // Voice transcription reuses GEMINI_API_KEY; these toggle/model it.
  VOICE_TRANSCRIPTION_ENABLED?: boolean
  VOICE_TRANSCRIPTION_MODEL?: string
  /** Optional long-recording override; defaults to VOICE_TRANSCRIPTION_MODEL. */
  RECORDING_TRANSCRIPTION_MODEL?: string
  // Optional outage-only Claude fallback.
  FALLBACK_PROVIDER_ENABLED?: boolean
  ANTHROPIC_API_KEY?: string
  // Optional OpenAI-compatible endpoint key (DashScope international — the
  // wave-1 Qwen/DeepSeek models). Absent ⇒ those models are absent from
  // routing and every menu (model-registry plan L12); the base URL is a
  // constant in the provider module, never an env var.
  DASHSCOPE_API_KEY?: string
  // OSS provider preference restored by the standalone entry from
  // ~/.usebrian/config.json. An explicit process environment value wins there.
  USEBRIAN_PREFERRED_PROVIDER?: string
  // Optional DashScope base-URL override. Unset = the international (Singapore)
  // endpoint. Set to the Beijing host (https://dashscope.aliyuncs.com/compatible-mode/v1)
  // for a mainland-China deployment. Applies to Qwen chat, embeddings, and media.
  DASHSCOPE_BASE_URL?: string
  // Optional DashScope media-model id overrides. The Model Studio catalog
  // varies by region/endpoint and over time, so the built-in defaults
  // (qwen-vl-max / qwen3-asr-flash / qwen-long) may not exist on a given
  // endpoint — a mismatch surfaces as a "model not found" error on image /
  // audio / PDF understanding. Unset ⇒ the default.
  DASHSCOPE_VISION_MODEL?: string
  DASHSCOPE_ASR_MODEL?: string
  DASHSCOPE_LONG_MODEL?: string
  /** Long-recording async transcription model; separate from short-audio ASR. */
  DASHSCOPE_FILETRANS_MODEL?: string
  // Optional connector / channel config (closed-secret gated; open passes none).
  GOOGLE_CLIENT_ID?: string
  /**
   * Dedicated server-only key for Google Maps Grounding Lite MCP. When absent,
   * the three Maps tools do not register. Never reuse the browser Picker key.
   */
  GOOGLE_MAPS_SERVER_API_KEY?: string
  CHANNEL_CREDENTIAL_KEY?: string
  TELEGRAM_BOT_TOKEN?: string
  SMTP_HOST?: string
  SMTP_PORT?: string | number
  SMTP_SECURE?: boolean
  SMTP_USER?: string
  SMTP_PASSWORD?: string
  /** Legacy Google Workspace SMTP credentials. */
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
  /** Feishu/Lark long-connection bridge. Both values are required together. */
  FEISHU_CONNECTOR_URL?: string
  FEISHU_CONNECTOR_SECRET?: string
  /**
   * WeChat iLink long-poll connector bridge (`apps/wechat-connector`). Both
   * set → the WeChat QR pairing endpoints work and `/internal/wechat/*` is
   * mounted; unset → WeChat connect returns 503 and the inbound route is
   * absent. See docs/architecture/channels/wechat.md.
   */
  WECHAT_CONNECTOR_URL?: string
  WECHAT_CONNECTOR_SECRET?: string
  /** Local-only chat archive sidecar. Both values are required together. */
  BRIAN_MESSAGE_STORE_URL?: string
  /**
   * Set when the archive runs on another host in the deployment rather than
   * beside the platform. Extraction is loopback-only by default because it
   * accepts raw personal attachments.
   */
  BRIAN_MESSAGE_STORE_ALLOW_REMOTE?: string
  BRIAN_MESSAGE_STORE_HMAC_SECRET?: string
  LLM_PROVIDER_KEY_ENCRYPTION_KEY?: string
  // Blob storage. Select at most one GCS, Azure, or S3 deployment default.
  // Otherwise LOCAL_FILES_DIR enables durable self-hosted local storage;
  // non-Cloud-Run dev falls back to /tmp. Cloud defaults override local disk.
  GCS_FILES_BUCKET?: string
  S3_FILES_BUCKET?: string
  S3_REGION?: string
  S3_ENDPOINT?: string
  S3_FORCE_PATH_STYLE?: string
  S3_ACCESS_KEY_ID?: string
  S3_SECRET_ACCESS_KEY?: string
  S3_SESSION_TOKEN?: string
  AZURE_BLOB_CONTAINER?: string
  /** Shared-key auth for Azure Blob: a connection string, or account + key. */
  AZURE_STORAGE_CONNECTION_STRING?: string
  AZURE_STORAGE_ACCOUNT?: string
  AZURE_STORAGE_ACCOUNT_KEY?: string
  /** Blob endpoint override for Azurite or a sovereign cloud. */
  AZURE_BLOB_ENDPOINT?: string
  LOCAL_FILES_DIR?: string
  /** Public HTTPS base used only for signed local-file transfer URLs. */
  LOCAL_FILES_PUBLIC_URL?: string
  /** Enables admin-selected server filesystem paths for knowledge sources. */
  LOCAL_FILESYSTEM_SOURCES_ENABLED?: boolean
  // Weekly skill-hygiene passes ship dark unless on.
  SKILLS_AUTO_GEN_ENABLED?: boolean
  // Computer-use local mode (docs/architecture/engine/computer-use.md §4):
  // the browser-relay's HTTP base + shared secret. Unset (open default) →
  // the local browser backend reports not_configured.
  BROWSER_RELAY_URL?: string
  PROTECTED_BROWSER_FILL_SINGLE_INSTANCE?: string
  PROTECTED_BROWSER_FILL_EXTENSION_ORIGINS?: string
  BROWSER_RELAY_SECRET?: string
  // Computer-use cloud mode (§5): E2B Cloud credentials + the pre-baked
  // sandbox template (agent-browser + python3 + unshare). Unset → the cloud
  // backend reports not_configured and routing falls back to local.
  E2B_API_KEY?: string
  E2B_TEMPLATE_ID?: string
  // Jev Ultrafast is the watched-browser primary; Browser Use remains its
  // pre-action fallback. Both ids stay host-selected, never sandbox-owned.
  JEV_ULTRAFAST_MODEL?: string
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
  // PLATFORM_SUBDOMAIN_RESERVED adds reserved labels (comma list). Hosted also
  // reuses the product apex + allowlist to reserve AgentMail domains.
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
  decisionRuntime?: DecisionRuntime
  /** Resolve the workspace-owned Standard lane at episode execution time. */
  resolveWorkspaceLlm?: (workspaceId: string) => Promise<ChatEpisodeInput['llm'] | null>
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
   * as `overhead:extraction` rows. Hosted and normal standalone both inject a
   * store; a bespoke composition may omit it and skip recording.
   */
  usageStore?: UsageStore
  /**
   * Bulk-ingest surcharge hook threaded into Pipeline B (`ingestCharge`),
   * fired once per successfully-extracted episode. The platform's
   * implementation prices by source kind (0.5-credit bulk-ingest item,
   * idempotent per episode); absent in OSS — ingest stays uncharged.
   */
  ingestCharge?: (episode: { id: string; workspaceId: string; sourceKind: string; createdByUserId: string }) => Promise<void>
  application: IngestApplicationService
  taskAdmission: TaskAdmissionPort
}

/**
 * The closed seams `bootOpenApi` accepts. ALL optional — every field has a
 * safe default applied inside boot, so an open entry passing `{}` (or omitting
 * `ports`) boots a fully-functional single-player API with billing/feed/
 * connectors absent.
 */
export interface OpenApiPorts {
  /** Optional path-scoped overlay router with its own parsing, CORS and request limits. */
  feedHistorySql?: string;
  // ── Billing — open default: allow-all / no-op ──
  /** Real DB credit gate; default allows every turn. */
  feedImage?: { codex?: import('@use-brian/agent-runtime/providers/codex-app-server/image.js').CodexImageProvider; config?: import('@use-brian/shared').FeedImageConfig; billing?: import('./content-planning/generation-port.js').FeedGenerationBilling };
  checkCreditBudget?: CreditBudgetGate
  /** Optional subscription entitlement for the separate bulk Memory download. */
  /** Edition-local DB usage recorder; default no-op for bespoke compositions. */
  usageStore?: UsageStore
  /** Workspace-aware decision policy. Absent defaults every operation to LLM-only. */
  resolveDecisionRoute?: DecisionRouteResolver
  /** Register additional decision transports; registry rows make them appear in settings automatically. */
  configureDecisionAdapters?: NonNullable<CreateDecisionRuntimeOptions['configureAdapters']>
  /** Optional edition-local attempt attribution/usage sink. */
  recordDecisionAttempt?: (attempt: DecisionRuntimeAttempt) => void | Promise<void>
  /** Optional edition-local final-path analytics sink. */
  recordDecisionOutcome?: (outcome: DecisionRuntimeOutcome) => void | Promise<void>
  /** Hosted priority pool for spend-bearing provider keys. Open default uses env directly. */
  externalCredentialPool?: ExternalCredentialPool
  /**
   * Bulk-ingest surcharge hook (0.5-credit bulk-ingest item, priced +
   * ledgered platform-side, idempotent per episode). Threaded into every
   * Pipeline B wiring; default absent — OSS ingest is uncharged.
   */
  ingestCharge?: (episode: { id: string; workspaceId: string; sourceKind: string; createdByUserId: string }) => Promise<void>
  /** Hosted recording-duration credit quote; absent in OSS/self-hosted. */
  recordingSurchargeCredits?: (durationSeconds: number) => number
  /**
   * Hosted plan-tiered workspace storage quota (`getWorkspacePlan` ->
   * `storageLimitBytesForPlan`). Absent = UNLIMITED: a self-host or Outpost
   * install's disk or bucket is its own, and the plan table is a hosted
   * billing construct. Until 2026-10-01 the open boot derived this from the
   * workspace `plan` column in both editions, which put every OSS install and
   * every Outpost on the free tier's 1 GiB.
   */
  storageLimitBytesFor?: (workspaceId: string) => Promise<number>
  /**
   * Hosted standalone Generate-from-Brain pricing + success charge. The open
   * route remains fully usable without it and reports zero credits in OSS.
   */
  generateBilling?: GenerateSynthesisBilling
  /**
   * Metered model lane billing (model-registry.md L8/L15) — the closed
   * `5 + ceil(cost/$0.040)` estimate / spend-cap / charge seams. Default
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
  resolveExtraSystemPrompt?: (session: { mode: string | null; channelType: string; anchor: string }) => string | null
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
   * Encrypted saved-login metadata + the broker-only resolver capability.
   * Absent → profiles and manual Take-Over continue to work, while headless
   * reauthentication and its Browser-app forms stay unavailable.
   */
  browserCredentialStore?: BrowserCredentialStore
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
  /** Hosted override for knowledge-sync credential resolution. The open
   * composition uses the connector-instance/grant-backed provider. */
  buildSyncCredentials?: (deps: {
    connectorInstanceStore: ReturnType<typeof createConnectorInstanceStore>
    connectorGrantStore: ReturnType<typeof import('./db/connector-grant-store.js').createConnectorGrantStore>
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
   * Pipeline-C Slack ingest and recording billing policy. The standalone app
   * supplies `buildOpenChannelHosts` for generic media intake; hosted supplies
   * its policy-enriched host. Called right after `BootContext` assembly.
   */
  buildChannelHosts?: (ctx: BootContext) => ChannelHostHooks | Promise<ChannelHostHooks>
  /** Hosted runs its billing-aware recording worker; OSS defaults this on. */
  runOpenRecordingWorker?: boolean

  /** Hosted has a pending-ingest batch worker; OSS executes WhatsApp realtime. */
  whatsappScheduledBatching?: boolean
  /** Same flag for the mailbox (imap) brain router — hosted batches its
   *  newsletter digests; OSS executes scheduled matches realtime. */
  mailboxScheduledBatching?: boolean
  /** Same flag for room ambient capture (multiplayer chat P2) — hosted
   *  batches room posts into hourly digest windows; OSS runs inline. */
  roomScheduledBatching?: boolean
  /** A later closed router owns the hosted shared-number fallback. */
  whatsappOfficialFallback?: boolean
  /**
   * Resolves the official WhatsApp bot's number for Settings → Account →
   * Connected accounts. Hosted-only (the number lives behind the closed
   * official-bot plumbing), and its absence is what 503s the WhatsApp
   * link-code route in OSS. See docs/architecture/channels/whatsapp.md →
   * "Account linking".
   */
  getWhatsappOfficialNumber?: () => Promise<string | null>
  /**
   * Account-teardown rules for tables an edition adds on top of the open
   * schema. The teardown fails closed on any unclassified foreign key to
   * `users`, so an overlay that references `users` must classify its
   * columns here. See docs/architecture/features/privacy-controls.md ->
   * "Teardown order".
   */
  accountTeardownRules?: Readonly<Record<string, AccountTeardownRule>>
  /** Optional verified-email continuation and matching native OAuth workspace preference. */
  /**
   * Assistant-teardown rules for overlay tables. `DELETE /api/assistants/:id`
   * fails closed on any unclassified foreign key to `assistants` (see
   * db/assistant-teardown.ts), so an overlay that references `assistants`
   * without an ON DELETE action must classify its columns here.
   */
  assistantTeardownRules?: Readonly<Record<string, AssistantTeardownRule>>

  /**
   * BYO-storage signer for the PUBLIC shared-page recording playback URL
   * (`<source>/recording/media-url` on the public share/site routes). A
   * recording carrying a `storage_uri` must be signed by that bucket's own
   * client — the platform client would mint a URL for the wrong bucket.
   * Hosted passes its files-resolver-backed implementation (the same seam the
   * authed recordings route uses); open build leaves it unset → the platform
   * blob client signs everything, which is correct for single-bucket OSS.
   */
  resolveRecordingReadClient?: (
    workspaceId: string,
    storageUri: string | null | undefined,
  ) => Promise<Pick<GcsFilesClient, 'signedReadUrl'>>

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
  /** Trusted deployed open module code, composed into the existing module registry. */
  applicationModules?: readonly ApplicationModuleDefinition<PoolClient>[]
  env: OpenApiEnv
  /** Shared self-host/hosted application integration configuration; no automatic grants. */
  externalApps?: ReturnType<typeof externalAppConfiguration>
  ports?: OpenApiPorts
  /** Default true; gates the background workers (consolidation, pollers, …). */
  runWorkers?: boolean
  /** Default true. False only for a credential-free local administrative fixture. */
  startLocalSubscriptionProvider?: boolean
}

/**
 * Host hooks injected into the open channel routes. OSS supplies the generic
 * media hooks; hosted additionally supplies passive ingest and billing policy.
 */
export interface ChannelHostHooks {
  /** Pipeline-C rules-engine ingest for Slack channel traffic (closed). */
  slackWebhookIngestor?: import('./routes/slack.js').SlackWebhookIngestor
  /** Pipeline-C rules-engine ingest for Microsoft Teams channel traffic (closed). */
  msteamsWebhookIngestor?: import('./routes/msteams.js').MsTeamsWebhookIngestor
  /** Shared Pipeline-C message-channel ingest for Feishu/Lark group traffic. */
  feishuWebhookIngestor?: import('./routes/feishu.js').FeishuWebhookIngestor
  /** Universal channel-media intake for Slack pulled attachments. */
  slackIngestChannelMediaRef?: Parameters<typeof slackRoutes>[0]['ingestChannelMediaRef']
  /** Universal channel-media intake for Discord attachments. */
  discordIngestChannelMediaRef?: Parameters<typeof discordRoutes>[0]['ingestChannelMediaRef']
  /** Universal channel-media intake for Telegram BYO files. */
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
  /** Shared provider-neutral classifier cascade for open and hosted callers. */
  decisionRuntime: DecisionRuntime
  /** Workspace-owned text/tool runtime resolver for closed route consumers. */
  resolveWorkspaceCustomLlm: import('./custom-llm-runtime.js').WorkspaceCustomLlmResolver
  /**
   * Session live-event bus publish for closed channel routes
   * (live-work.md §5.2): every `processChannelMessage` caller must pass it
   * or that edition's turns are invisible to the Live watch pane — the
   * same threaded-by-hand obligation as `resolveWorkspaceCustomLlm` above.
   */
  publishSessionEvent: import('./session-event-port.js').PublishSessionEvent
  /** Standard/background custom runtime, resolved at execution time. */
  resolveBackgroundRuntime: import('./custom-llm-runtime.js').BackgroundRuntimeResolver
  /** Application-provider background model when no workspace runtime exists. */
  backgroundModel: string
  /** Application-provider Standard extraction model for closed ingest consumers. */
  extractionModel: string
  /** Live application background selector for hot provider preference changes. */
  resolveBackgroundModel: () => string
  /** Mutable application provider catalog/preference for closed channel routes. */
  configuredProviders: import('@use-brian/shared/model-registry').ProviderAvailability
  /** Collaborative page bridge shared by server-side page writers. */
  docGateway: ReturnType<typeof createDocGateway>
  /** Version-CAS fallback when the collaborative gateway is unavailable. */
  docPageStore: ReturnType<typeof createDbDocPageStore>
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
  ingestApplicationService: IngestApplicationService
  crmStore: ReturnType<typeof createDbCrmStore>
  taskStore: ReturnType<typeof createDbTaskStore>
  connectorStore: ReturnType<typeof createDbConnectorStore>
  connectorInstanceStore: ReturnType<typeof createConnectorInstanceStore>
  connectorSourceRuntimeFactory?: ConnectorSourceRuntimeFactory
  workspaceToolPolicyStore: ReturnType<typeof createWorkspaceToolPolicyStore>
  mcpSettingsStore: ReturnType<typeof createDbMcpSettingsStore>
  assistantConnectorStore: ReturnType<typeof createDbAssistantConnectorStore>
  assistantConnectorGrantsStore: ReturnType<typeof createDbAssistantConnectorGrantsStore>
  connectorGrantStore: Awaited<ReturnType<typeof import('./db/connector-grant-store.js').createConnectorGrantStore>>
  connectorActionStore: ReturnType<typeof createDbConnectorActionStore>
  workspaceFilesStore: ReturnType<typeof createDbWorkspaceFilesStore>
  /**
   * The doc page store. Exposed so a closed route can resolve a page under the
   * CALLER's RLS — e.g. the recordings `/process` route verifying the brief's
   * destination page before the (system-level) worker files into it.
   */
  savedViewStore: ReturnType<typeof createDbSavedViewStore>
  knowledgeStore: ReturnType<typeof createDbKnowledgeStore>
  knowledgeCaptureRuleStore: ReturnType<typeof createDbKnowledgeCaptureRuleStore>
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
  deferredConfirmationStore: ReturnType<typeof createDeferredConfirmationStore>
  chatConfirmationStore: ReturnType<typeof createChatConfirmationStore>
  episodicStore: ReturnType<typeof createDbEpisodicStore>
  sessionStateStore: ReturnType<typeof createDbSessionStateStore>
  workerManager: ReturnType<typeof createWorkerManager>
  workerRunsStore: ReturnType<typeof createDbWorkerRunsStore>
  skillStore: ReturnType<typeof createDbSkillStore>
  workspaceSkillStore: ReturnType<typeof createDbWorkspaceSkillStore>
  workspaceSkillEnablementStore: ReturnType<typeof createDbWorkspaceSkillEnablementStore>
  workspaceSkillFilesStore: ReturnType<typeof createDbWorkspaceSkillFilesStore>
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
  /** Existing backend-agnostic resolver used by files, channel media, and recordings. */
  filesResolver: FilesClientResolver | null
  /** App-default GCS/local client for legacy refs without a storageUri. */
  filesBlobClient: GcsFilesClient | null
  /**
   * Canonical chunked workspace-file uploads (start / PUT parts / complete).
   * Edition-specific recording routes admit uploads through it so a recording
   * is only ever derived from a stored file. Null when file storage is off.
   */
  chunkedFileUploads: ChunkedFileUploadService | null
  /** Open Pipeline B ingestor built over this boot's store graph. */
  brainEpisodeIngestor: BrainEpisodeIngestor | undefined
  /** Open recording queue operations for edition-specific routes. */
  recordingJobs: {
    enqueue: typeof enqueueRecordingJob
    claim: typeof claimNextRecordingJob
    markDone: typeof markRecordingJobDone
    markFailed: typeof markRecordingJobFailed
  }
  entityKindClassifier: ReturnType<typeof createEntityKindClassifier>
  workflowEventDispatcher: WorkflowEventDispatcher
  voiceTranscription: { enabled: boolean; apiKey: string; backend?: MediaBackend; model: string | undefined }
  resolvePrimaryAssistantForWorkspace: (workspaceId: string) => Promise<string | null>
  emailAuth: EmailAuth | undefined
  approvalBridgeDeps: ApprovalBridgeDeps
}

export type EmailAuth = {
  resolveVerifiedEmailUser?: (email: string) => Promise<NonNullable<Awaited<ReturnType<typeof findUserById>>> | null>
  magicLinkStore: ReturnType<typeof createDbMagicLinkStore>
  smtpClient: ReturnType<typeof createSmtpClient>
  appUrl: string
  canSignInEmail?: (email: string) => Promise<boolean>
  allowedReturnOrigins?: string[]
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
  const late = {} as BootLate
  const root: RootScope = { opts, env, ports, late }
  const s1 = { ...root, ...registerOverlaySeams(root) }
  const runWorkers = opts.runWorkers ?? true
  const s2 = { ...s1, runWorkers }
  const s3 = { ...s2, ...registerHttp(s2) }
  const s4 = { ...s3, ...await registerRuntime(s3) }
  const s5 = { ...s4, ...registerStores(s4) }
  const s6 = { ...s5, ...await registerProviders(s5) }
  const s7 = { ...s6, ...registerConnectors(s6) }
  const { configuredProviders, resolveWorkspaceCustomLlm } = s7
  // The turn kernel's deployment-wide inference wiring (turn/runtime.ts):
  // every runner resolves the workspace custom endpoint and the configured
  // providers through this registration, so a route that forgets to thread
  // them cannot change which model answers a turn.
  configureTurnKernel({ resolveWorkspaceCustomLlm, configuredProviders })
  const s8 = { ...s7, ...await registerAuth(s7) }
  const s9 = { ...s8, ...await registerWorkspace(s8) }
  const s10 = { ...s9, ...registerTools(s9) }
  const s11 = { ...s10, ...registerOfficeTools(s10) }
  const s12 = { ...s11, ...await registerCapture(s11) }
  const s13 = { ...s12, ...await registerAssistants(s12) }
  const s14 = { ...s13, ...registerWorkflow(s13) }
  const s15 = { ...s14, ...registerPrimitives(s14) }
  const s16 = { ...s15, ...registerFiles(s15) }
  const s17 = { ...s16, ...registerComputerUse(s16) }
  const s18 = { ...s17, ...registerChatRoutes(s17) }
  const s19 = { ...s18, ...registerIntegrationRoutes(s18) }
  const s20 = { ...s19, ...await registerSessionRoutes(s19) }
  const s21 = { ...s20, ...registerWorkspaceRoutes(s20) }
  registerPublicRoutes(s21)
  const { app, integrationStore, linkedAccountStore, workspaceStore } = s21

  // PUBLIC closed routes mount HERE — before the bare `/api` requireAuth guards
  // below. Mounting them via `mountExtraRoutes` (which runs last) lets the first
  // bare guard 401 them first. See OpenApiPorts.mountPublicExtraRoutes.
  if (ports.mountPublicExtraRoutes) {
    await ports.mountPublicExtraRoutes(app, { linkedAccountStore, integrationStore, workspaceStore })
  }
  registerApiRoutes(s21)
  const s22 = { ...s21, ...registerOfficeRoutes(s21) }
  registerBrainRoutes(s22)
  const s23 = { ...s22, ...registerWorkflowEvents(s22) }
  const s24 = { ...s23, ...await registerWorkers(s23) }
  const s25 = { ...s24, ...registerLearningWorkers(s24) }
  const s26 = { ...s25, ...await registerMemoryWorkers(s25) }
  const s27 = { ...s26, ...registerRecordingWorkers(s26) }
  const s28 = { ...s27, ...await registerSyncWorkers(s27) }
  const s29 = { ...s28, ...registerBootContext(s28) }
  await registerChannels(s29)
  const { ctx } = s29

  // ── Let the platform mount its closed routes + workers onto the same app ──
  if (ports.mountExtraRoutes) {
    await ports.mountExtraRoutes(app, ctx)
  }

  // ── Session-event bus is generic infra; boot it so doc-comment live
  //    reconnect (open) and any closed feed draft features both subscribe. ──
  startSessionEventBus()
  const s30 = { ...s29, ...registerLifecycle(s29) }
  const { start, shutdown } = s30


  return { app, ctx, start, shutdown }
}


// Re-export getPool so the platform can reuse the same pool accessor for its
// diagnostic endpoints without re-importing the open db/client.
export { getPool }
