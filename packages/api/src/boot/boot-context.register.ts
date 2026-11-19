/**
 * BootContext: the built open singletons the hosted overlay and channel hosts compose against.
 *
 * Boot register module registerBootContext: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`BootContextScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { backgroundModelFor, ensureServableModel } from '../model-resolution.js'
import { EXTRACTION_MODEL } from '../build-episode-ingestors.js'
import {
  enqueueRecordingJob, claimNextRecordingJob, markRecordingJobDone, markRecordingJobFailed,
} from '../db/recording-jobs-store.js'
import { publishSessionEvent } from '../session-event-bus.js'
import type { BootContext } from '../boot.js'
import type { BootContextScope } from './scope.js'

export function registerBootContext(scope: BootContextScope) {
  const {
    ports, env, app, configuredProviders, provider, analytics, integrationStore, crmStore,
    resolvePrimaryAssistantForWorkspace, entityLinksStore, entitiesStore, usageStore, decisionRuntime,
    connectorInstanceStore, connectorSourceRuntimeFactory, workspaceSkillStore, workspaceSkillFilesStore,
    skillStore, workflowStore, resolveWorkspaceCustomLlm, linkedAccountStore, emailAuth, connectorGrantStore,
    episodesStore, workspaceStore, savedViewStore, workspaceAuditStore, knowledgeStore,
    ingestApplicationService, workerManager, jobStore, resolveBackgroundRuntime, workspaceFilesStore,
    allTools, filesResolver, mcpSettingsStore, memoryStore, taskStore, brainEpisodeIngestor, runWorkers,
    workflowRunStore, generateSynthesize, workerRunsStore, sessionStateStore, filesApi, connectorStore,
    assistantConnectorStore, workspaceToolPolicyStore, assistantConnectorGrantsStore, gdriveFilesStore,
    capabilityStore, apiKeyStore, episodicStore, deferredConfirmationStore, workspaceSkillEnablementStore,
    workflowExecutorDeps, approvalBridgeDeps, entityKindClassifier, filesBlobClient, chunkedFileUploads,
    docPageStore, knowledgeCaptureRuleStore, communitySkillRegistry, voiceTranscription,
    connectorActionStore, docGateway, linkCodeStore, workspaceRouter, workflowEventDispatcher,
    recordingSynthesize, ingestRulesStore, port, chatConfirmationStore, channelUserStore,
  } = scope
  // ════════════════════════════════════════════════════════════════
  // BootContext
  // ════════════════════════════════════════════════════════════════
  const ctx: BootContext = {
    app,
    provider,
    decisionRuntime,
    resolveWorkspaceCustomLlm,
    publishSessionEvent,
    resolveBackgroundRuntime,
    get backgroundModel() { return backgroundModelFor(configuredProviders) },
    get extractionModel() {
      return configuredProviders.size > 0
        ? ensureServableModel(EXTRACTION_MODEL, configuredProviders)
        : EXTRACTION_MODEL
    },
    resolveBackgroundModel: () => backgroundModelFor(configuredProviders),
    configuredProviders,
    docGateway,
    docPageStore,
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
    ingestApplicationService,
    crmStore,
    taskStore,
    recordingSynthesize,
    generateSynthesize,
    connectorStore,
    connectorInstanceStore,
    connectorSourceRuntimeFactory,
    workspaceToolPolicyStore,
    mcpSettingsStore,
    assistantConnectorStore,
    assistantConnectorGrantsStore,
    connectorGrantStore,
    connectorActionStore,
    workspaceFilesStore,
    savedViewStore,
    knowledgeStore,
    knowledgeCaptureRuleStore,
    capabilityStore,
    apiKeyStore,
    usageStore,
    workspaceStoreRefForRouter: workspaceRouter,
    workflowStore,
    workflowRunStore,
    workflowExecutorDeps,
    deferredConfirmationStore,
    chatConfirmationStore,
    episodicStore,
    sessionStateStore,
    workerManager,
    workerRunsStore,
    skillStore,
    workspaceSkillStore,
    workspaceSkillEnablementStore,
    workspaceSkillFilesStore,
    communitySkillRegistry,
    jobStore,
    linkedAccountStore,
    linkCodeStore,
    integrationStore,
    channelUserStore,
    ingestRulesStore,
    gdriveFilesStore,
    filesApi,
    filesResolver,
    filesBlobClient,
    chunkedFileUploads,
    brainEpisodeIngestor,
    recordingJobs: {
      enqueue: enqueueRecordingJob,
      claim: claimNextRecordingJob,
      markDone: markRecordingJobDone,
      markFailed: markRecordingJobFailed,
    },
    entityKindClassifier,
    workflowEventDispatcher,
    voiceTranscription,
    resolvePrimaryAssistantForWorkspace,
    emailAuth,
    approvalBridgeDeps,
  }

  return { ctx } as const
}
