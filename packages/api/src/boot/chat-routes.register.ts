/**
 * Web chat runtime, programmatic API and assistant/workspace MCP routes.
 *
 * Boot register module registerChatRoutes: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`ChatRoutesScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { createGeminiProvider } from '@use-brian/agent-runtime/providers/gemini.js'
import { wrapProvider } from '@use-brian/agent-runtime/providers/wrappers.js'
import type { Tool } from '@use-brian/agent-runtime/tools/types.js'
import { createPlanTools } from '@use-brian/core/memory/plan-tools.js'
import { createSelfProfileTool } from '@use-brian/core/memory/self-profile-tool.js'
import { createSessionStateTools } from '@use-brian/core/memory/session-state-tools.js'
import { LAYER_1_SYSTEM_PROMPT } from '@use-brian/core/system-prompt.js'
import {
  createWorkspaceChatHandoffTool,
} from '@use-brian/core/tools/base/workspace-chat-handoff.js'
import { injectDocTools } from '../doc/inject.js'
import { resolvePinnedContext } from '../resolve-session-pins.js'
import { injectWorkspaceMcpSkills } from '../workspace-mcp/skills.js'
import { findSessionById } from '../db/sessions.js'
import { classifySession } from '../session-kind.js'
import { createSessionPinTools } from '../session-pin-tools.js'
import { createWorkspaceMcpProfile } from '../workspace-mcp/profile.js'
import { enqueueNativeSessionStateJob } from '../db/session-state-jobs.js'
import { enqueueNativeSessionTitleJob } from '../db/session-title-jobs.js'
import { recordOverheadUsage } from '../routes/_overhead-usage.js'
import { getConnectorUserId, getWorkspacePlan } from '../db/workspace-store.js'
import { composeSurfaceCapabilities } from '../mcp/surface.js'
import { createFeedReviewContextLoader } from '../content-planning/review-context.js'
import { findUserById, findAssistantById } from '../db/users.js'
import { createWorkspaceChatHandoffStore } from '../db/workspace-chat-handoff-store.js'
import { createFeedEditorialModelResolver } from '../content-planning/editorial-model.js'
import { createFeedGenerationPort } from '../content-planning/generation-port.js'
import { createFeedGenerationService } from '../content-planning/generation.js'
import { createNativeChatRuntime } from '../routes/chat.js'
import { resolveModel, backgroundModelFor, ensureServableModel } from '../model-resolution.js'
import { publishSessionEvent } from '../session-event-bus.js'
import { optionalAuth, requireAuth } from '../auth/middleware.js'
import { createArtifactPromoter } from '../files/artifact-promote.js'
import { enqueueFileIngestJob } from '../db/file-ingest-jobs-store.js'
import { notifyRoomMentionRecorded } from '../brain-stream/notify.js'
import { publicApiRoutes } from '../routes/public-api.js'
import { apiKeyRoutes } from '../routes/api-keys.js'
import { assistantMcpRoutes } from '../routes/assistant-mcp.js'
import { createDbOAuthAuthorizationStore } from '../db/oauth-authorization-store.js'
import type { ChatRoutesScope } from './scope.js'

export function registerChatRoutes(scope: ChatRoutesScope) {
  const {
    ports, env, app, geminiTransport, configuredProviders, provider, analytics, entityLinksStore,
    entitiesStore, codexProviderManager, documentDistill, distillateCache, usageStore, decisionRuntime,
    connectorInstanceStore, connectorSourceRuntimeFactory, workspaceSkillStore, workspaceSkillFilesStore,
    skillStore, workflowStore, llmProviderSettingsStore, resolveWorkspaceCustomLlm, connectorGrantStore,
    episodesStore, knowledgeStore, workerManager, jobStore, cacheStore, fileStore, workspaceFilesStore,
    allTools, mcpSettingsStore, memoryStore, pendingApprovalsStore, workerRunsStore, sessionStateStore,
    filesApi, retrievalStore, connectorStore, assistantConnectorStore, workspaceToolPolicyStore,
    assistantConnectorGrantsStore, gdriveFilesStore, capabilityStore, apiKeyStore, episodicStore,
    chatEpisodeIngestor, deferredConfirmationStore, injectExtraTools, resolveAppSoul,
    workspaceSkillEnablementStore, generateBlueprintTool, blueprintRecordTools, buildBlueprintPromptFragment,
    knowledgeRepoWriter, brainCandidateStore, crmEmailDraftStore, agentToolset, resolveWorkspaceByoGeminiKey,
    meteredProfileStore, meteredModelsAvailable, isPlaceholderTitle, getTitleChannelPrefix,
    resolveExtraSystemPrompt, ingestPageRunner, knowledgeCaptureRuleStore, communitySkillRegistry,
    sessionResumeStore, planStore, voiceTranscription, mediaBackendIsFreeRated, connectorActionStore,
    memoryRecallEventsStore, brainEntryMutator, introspectionTools, brainMemoryTools, brainRetrievalTools,
  } = scope
  // ════════════════════════════════════════════════════════════════
  // Route mounts (47 open mounts, original order)
  // ════════════════════════════════════════════════════════════════
  const webChatSystemPrompt = LAYER_1_SYSTEM_PROMPT
  // Brain-inspection tools need the closed InspectionStore; open default = none.
  const brainInspectionTools = ports.inspectionTools
  const workspaceChatHandoffTool = createWorkspaceChatHandoffTool(
    createWorkspaceChatHandoffStore(),
  )

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

  const feedReviewContext = createFeedReviewContextLoader(ports.feedHistorySql)
  const feedGeneration = createFeedGenerationService(createFeedGenerationPort(createFeedEditorialModelResolver({ provider, configuredProviders, resolveWorkspaceCustomLlm, usageStore, checkCreditBudget: ports.checkCreditBudget, triggerKey: 'feed_generation' }), { transport: geminiTransport, resolveWorkspaceKey: resolveWorkspaceByoGeminiKey, files: filesApi ?? undefined, usageStore, codex: codexProviderManager?.images ?? ports.feedImage?.codex,
      config: ports.feedImage?.config, billing: ports.feedImage?.billing }), feedReviewContext)
  const nativeChatRuntime = createNativeChatRuntime({
    enqueueSessionTitleJob: enqueueNativeSessionTitleJob,
    enqueueSessionStateJob: enqueueNativeSessionStateJob,
    feedGeneration,
    feedReviewContext,
    provider,
    decisionRuntime,
    artifactPromoter,
    checkCreditBudget: ports.checkCreditBudget,
    meteredProfileStore,
    meteredModelsAvailable,
    configuredProviders,
    estimateMeteredTurn: ports.meteredBilling?.estimateMeteredTurn,
    checkMeteredSpendCap: ports.meteredBilling?.checkMeteredSpendCap,
    chargeMeteredSurcharge: ports.meteredBilling?.chargeMeteredSurcharge,
    publishSessionEvent,
    // T-H8 (docs/plans/room-human-mentions.md): fan out the Inbox live-badge
    // signal after a room mention is recorded, so InboxPanel + the sidebar
    // unread badge — both in the never-unmounting workspace layout — can
    // self-heal instead of waiting for a full page load.
    onRoomMentionRecorded: (input) => notifyRoomMentionRecorded(input.workspaceId),
    isPlaceholderTitle,
    getTitleChannelPrefix,
    injectExtraTools,
    resolveExtraSystemPrompt,
    resolveAppSoul,
    engineHooks: ports.engineHooks,
    llmProviderSettingsStore: llmProviderSettingsStore ?? undefined,
    resolveWorkspaceByoGeminiKey,
    buildWorkspaceProvider: (apiKey: string) => wrapProvider(createGeminiProvider(apiKey)),
    resolveWorkspaceCustomLlm,
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
    recordingSurchargeCredits: ports.recordingSurchargeCredits,
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
    connectorSourceRuntimeFactory,
    workerRunsStore,
    knowledgeStore,
    knowledgeCaptureRuleStore,
    knowledgeRepoWriter,
    gdriveFilesStore,
    skillStore,
    workflowStore,
    workspaceSkillStore,
    workspaceSkillEnablementStore,
    workspaceSkillFilesStore,
    communitySkills: communitySkillRegistry,
    deferredConfirmationStore,
    pendingApprovalsStore,
    sessionResumeStore,
    episodicStore,
    sessionStateStore,
    crmEmailDraftStore,
    planStore,
    jobStore,
    voiceTranscription,
    pdfPreflight: { distill: documentDistill, cache: distillateCache, freeRated: mediaBackendIsFreeRated() },
    connectorActionStore,
    episodesStore,
    buildConnectorActionAudit: ports.buildConnectorActionAudit,
    assistantConnectorGrantsStore,
    retrievalStore,
    memoryRecallEventsStore,
    inspectionTools: brainInspectionTools,
    brainEntryMutator,
    generateBlueprintTool,
    blueprintRecordTools,
    buildBlueprintPromptFragment,
    introspectionTools,
    workspaceChatHandoffTool,
  })
  app.use('/api/chat', optionalAuth(env.JWT_SECRET), nativeChatRuntime.router)

  app.use('/api/v1', publicApiRoutes({
    provider,
    publishSessionEvent,
    resolveWorkspaceCustomLlm,
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

  const workspaceNativeTools = new Map(allTools)
  for (const tool of [
    ...Object.values(brainMemoryTools), ...Object.values(brainRetrievalTools),
    ...Object.values(createPlanTools(planStore)), ...Object.values(createSessionStateTools(sessionStateStore)),
    createSelfProfileTool(entitiesStore, entityLinksStore),
    ...blueprintRecordTools, ...(generateBlueprintTool ? [generateBlueprintTool] : []),
  ]) workspaceNativeTools.set(tool.name, tool)
  const workspaceMcpProfile = createWorkspaceMcpProfile({ nativeTools: workspaceNativeTools, capabilityStore,
    runNativeTurn: nativeChatRuntime.runWorkspaceTurn,
    approvalsStore: pendingApprovalsStore, rawWrites: agentToolset.rawWrites,
    injectTools: async (tools, context, consent) => {
      const execution = context.executionContext
      if (!execution || !context.workspaceId) throw new Error('workspace_mcp_authority_required')
      const access = execution.security.access
      const actor = await findUserById(context.userId)
      if (!actor) throw new Error('workspace_mcp_actor_unavailable')
      for (const tool of Object.values(createSessionPinTools({ sessionId: context.sessionId, workspaceId: context.workspaceId,
        clearance: access.clearance, assistantId: context.assistantId, publishSessionEvent }))) tools.set(tool.name, tool)
      if (access.assistantKind === 'primary' && brainInspectionTools) {
        for (const tool of Object.values(brainInspectionTools)) tools.set(tool.name, tool)
      }
      const connectorBindings: Record<string, string> = {}
      const connectorUserId = await getConnectorUserId(context.userId, context.workspaceId)
      const connectors = await composeSurfaceCapabilities('workspace-mcp', {
        userId: await getConnectorUserId(context.userId, context.workspaceId),
        assistantId: context.assistantId, assistantTeamId: context.workspaceId,
        tools, connectorStore, settingsStore: mcpSettingsStore, assistantConnectorStore,
        connectorGrantStore, connectorInstanceStore, workspaceToolPolicyStore,
        assistantConnectorGrantsStore, connectorSourceRuntimeFactory,
        knowledgeStore, gdriveFilesStore, filesApi: filesApi ?? undefined,
        keepBuiltinsDirect: true, keepDynamicToolsDirect: true,
        restrictSearchToToolNames: consent?.operationNames,
        // Missing legacy bindings are an empty maximum, never a wildcard.
        bindingMaximum: consent ? consent.connectorBindings : undefined,
        onAdmittedBinding: (key, fingerprint) => { connectorBindings[key] = fingerprint },
        engineHooks: ports.engineHooks, userTimezone: actor.timezone,
        actorIdentity: { channel: 'programmatic', id: actor.email, email: actor.email, userId: actor.id },
        contextScope: { effectiveCompartments: access.compartments ?? null,
          effectiveProjectIds: access.projectIds ?? [], access },
        executionContext: execution, scopeAccumulator: context.scopeAccumulator,
        connectorActionAudit: ports.buildConnectorActionAudit?.({
          workspaceId: context.workspaceId, assistantClearance: access.clearance,
          sensitivityAccumulator: context.sensitivity, connectorActionStore, episodesStore,
        }),
        introspectionTools: access.assistantKind === 'primary' ? introspectionTools : undefined,
      })
      const assistant = await findAssistantById(context.assistantId)
      if (!assistant || assistant.workspaceId !== context.workspaceId) throw new Error('workspace_mcp_assistant_unavailable')
      const session = context.sessionPersisted ? await findSessionById(context.sessionId) : null
      await injectExtraTools({ tools, userId: context.userId,
        assistant: { id: assistant.id, kind: assistant.kind, appType: assistant.appType ?? null },
        ...(session ? { session: { id: session.id, mode: session.mode, channelType: session.channelType,
          anchor: classifySession(session).anchor.kind } } : {}),
        connectorActionAudit: ports.buildConnectorActionAudit?.({ workspaceId: context.workspaceId,
          assistantClearance: access.clearance, sensitivityAccumulator: context.sensitivity, connectorActionStore, episodesStore }),
      })
      if (context.activeCapabilities?.has('page')) {
        const runtime = await scope.resolveBackgroundRuntime(context.workspaceId)
        const plan = await getWorkspacePlan(context.workspaceId)
        const standardModel = resolveModel('standard', plan, 'ok')
        const pageTools = new Map<string, Tool>()
        const pins = session ? await resolvePinnedContext({ sessionId: session.id,
          workspaceId: context.workspaceId, clearance: session.effectiveClearance, context }) : null
        await injectDocTools({ tools: pageTools, userId: context.userId, assistant,
          docSurface: true, fileStore, filesApi: filesApi ?? undefined,
          ingestPage: ingestPageRunner ? args => ingestPageRunner(args) : undefined, editPageTargets: pins?.pageTargets ?? [],
          provider: runtime?.provider ?? provider, backgroundModel: runtime?.selector ?? backgroundModelFor(configuredProviders),
          fallbackModel: configuredProviders ? ensureServableModel(standardModel, configuredProviders) : standardModel,
          onEditUsage: ({ model, usage }) => recordOverheadUsage({ usageStore,
            userId: execution.attribution.billingUserId ?? context.userId, actorUserId: context.userId,
            assistantId: context.assistantId, sessionId: context.sessionId, model, usage,
            source: 'overhead:doc-edit', triggerKey: 'doc_edit_worker', modelTier: 'standard',
            providerKeySource: runtime?.providerKeySource ?? 'platform' }),
        })
        tools.delete('renderView')
        for (const [name, tool] of pageTools) tools.set(name, tool.isReadOnly ? tool : { ...tool,
          async execute(input, invocation) {
            await invocation.authority!.assertCurrent()
            if (ports.checkCreditBudget && (await ports.checkCreditBudget(context.workspaceId!, await getWorkspacePlan(context.workspaceId!))).status === 'blocked') {
              return { isError: true, data: { code: 'budget_exhausted', message: 'Workspace model work is unavailable under the current plan.' } }
            }
            return tool.execute(input, invocation)
          },
        })
      }
      await injectWorkspaceMcpSkills(context, { skillStore, connectorUserId, assistantId: assistant.id,
        assistantClearance: access.clearance, assistantKind: assistant.kind, assistantAppType: assistant.appType ?? null,
        tools, availableConnectorIds: connectors.admittedConnectorIds ?? new Set(), unavailableCapabilities: [],
        communitySkills: communitySkillRegistry, channel: 'workspace_mcp', workspaceId: context.workspaceId,
        workspaceSkillStore, workspaceSkillEnablementStore, workspaceSkillFilesStore,
      })
      return connectorBindings
    },
  })

  app.use('/api/v1', assistantMcpRoutes({
    apiUrl: env.API_URL,
    contextOnly: ports.memoryAllowance?.contextOnly,
    authorizationStoreFor: assistantId => createDbOAuthAuthorizationStore({ audience: 'assistant', assistantId }),
    workspaceProfile: workspaceMcpProfile,
    apiKeyStore,
    capabilityStore,
    agentTools: { reads: agentToolset.reads, writes: agentToolset.writes },
  }))

  app.use(
    '/api/assistants/:assistantId/integrations/api-keys',
    requireAuth(env.JWT_SECRET),
    apiKeyRoutes(apiKeyStore, workspaceMcpProfile),
  )

  return {
    feedReviewContext, feedGeneration, artifactPromoter, webChatSystemPrompt, workspaceMcpProfile,
  } as const
}
