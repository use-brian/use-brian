/**
 * Inter-assistant executor, consult transport and tools.
 *
 * Boot register module registerAssistants: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`AssistantsScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { workspaceCredentialDelegation } from '@use-brian/agent-runtime/security/workspace-delegation.js'
import { createInterAssistantTools } from '@use-brian/core/tools/base/ask-assistant.js'
import { captureWorkspaceMcpDelegation } from '../workspace-mcp/delegation.js'
import { findAssistantById } from '../db/users.js'
import { publishSessionEvent } from '../session-event-bus.js'
import { publishGoalActivity } from '../goals/activity-bus.js'
import { goalOwnsWorkflowRun } from '../goals/activity.js'
import { getGoalByIdSystem } from '../db/goals.js'
import { createCalleeExecutor } from '../inter-assistant/executor.js'
import type { AssistantsScope } from './scope.js'

export async function registerAssistants(scope: AssistantsScope) {
  const {
    ports, env, configuredProviders, provider, analytics, integrationStore, usageStore,
    connectorInstanceStore, workspaceSkillStore, workspaceSkillFilesStore, skillStore,
    resolveWorkspaceCustomLlm, connectorGrantStore, savedViewStore, knowledgeStore, customChannelStore,
    allTools, mcpSettingsStore, memoryStore, workflowRunStore, workerRunsStore, sessionStateStore,
    retrievalStore, connectorStore, assistantConnectorStore, workspaceToolPolicyStore,
    assistantConnectorGrantsStore, gdriveFilesStore, capabilityStore, apiKeyStore, episodicStore,
    chatEpisodeIngestor, deferredConfirmationStore, injectExtraTools, resolveAppSoul, researchSynthesize,
    workspaceSkillEnablementStore, generateBlueprintTool, blueprintRecordTools, buildBlueprintPromptFragment,
    connectionStore, late,
  } = scope
  const calleeExecutor = createCalleeExecutor({
    provider,
    resolveWorkspaceCustomLlm,
    configuredProviders,
    checkCreditBudget: ports.checkCreditBudget,
    publishSessionEvent,
    tools: allTools,
    memoryStore,
    // Session-state bridge: a consult that delivers into a user channel reads
    // that conversation's `# Open commitments` (read-only). See
    // context-engine/session-state.md → "Delivery-conversation bridging".
    sessionStateStore,
    // Lazy getter: `filesApi` is assigned further down (the workspace-
    // filesystem block) — a direct reference here would freeze `null`.
    // The executor reads `options.filesApi` per call, post-boot.
    get filesApi() { return late.filesApi ?? undefined },
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
    assistantConnectorGrantsStore,
    knowledgeStore,
    gdriveFilesStore,
    capabilityStore,
    apiKeyStore,
    episodicStore,
    analytics,
    usageStore,
    chatEpisodeIngestor,
    deferredConfirmationStore,
    integrationStore: integrationStore ?? undefined,
    defaultTelegramBotToken: env.TELEGRAM_BOT_TOKEN,
    waConnectorUrl: env.WA_CONNECTOR_URL,
    waConnectorSecret: env.WA_CONNECTOR_SECRET,
    customChannelStore,
    injectExtraTools,
    resolveAppSoul,
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

  const { createInProcessTransport } = await import('@use-brian/core/a2a/transport-in-process.js')
  const consultTransport = createInProcessTransport({
    runConsult: async ({ request }) => {
      let question: import('@use-brian/agent-runtime/tools/base/ask-question.js').AssistantQuestion | undefined
      let decisionApplicationId: string | null = null
      let scopeEvidence: import('@use-brian/agent-runtime/security/context-scope.js').ScopeEvidence | undefined
      let liveGoalId: string | null = null
      if (request.workflowRunId) {
        const run = await workflowRunStore.getRunSystem(request.workflowRunId)
        const candidate = run?.input && typeof run.input === 'object'
          ? (run.input as Record<string, unknown>).goalId
          : null
        if (run && typeof candidate === 'string' && candidate) {
          const goal = await getGoalByIdSystem(candidate)
          if (goal && goalOwnsWorkflowRun(goal, run)) {
            liveGoalId = goal.id
          }
        }
      }
      const text = await calleeExecutor({
        workspaceId: request.target.workspaceId,
        callerAssistantId: request.caller.assistantId,
        callerUserId: request.caller.userId,
        callerAccessCeiling: request.callerAccessCeiling,
        callerScopeEvidence: request.callerScopeEvidence,
        callerWorkspaceDelegation: request.callerWorkspaceDelegation,
        calleeAssistantId: request.target.assistantId,
        expectedWorkspaceId: request.target.workspaceId,
        question: request.message.parts
          .filter((p): p is { kind: 'text'; text: string } => p.kind === 'text')
          .map((p) => p.text)
          .join(' '),
        callerSessionId: '',
        sessionKey: request.contextId,
        contextGroupId: request.contextScope?.groupId,
        contextProjectId: request.contextScope?.projectId,
        allowedTools: request.allowedTools,
        externalClientPrincipal: request.externalClientPrincipal,
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
        workflowStepId: request.workflowStepId,
        decisionContext: request.decisionContext
          ? {
              actorUserId: request.caller.userId,
              operationId: request.decisionContext.operationId,
              externalPrincipal: request.decisionContext.externalPrincipal,
              applicability: request.decisionContext.applicability,
            }
          : undefined,
        onDecisionApplication: (id) => { decisionApplicationId = id },
        onScopeEvidence: (evidence) => { scopeEvidence = evidence },
        onQuestion: (value) => { question = value },
        onActivity: liveGoalId
          ? (frame) => publishGoalActivity(liveGoalId!, frame)
          : undefined,
      })
      return {
        text,
        question,
        scopeEvidence,
        ...(decisionApplicationId
          ? {
              artifacts: [{
                artifactId: `decision-application:${decisionApplicationId}`,
                name: 'decision-playbook-application',
                parts: [{ kind: 'data' as const, data: { applicationId: decisionApplicationId } }],
              }],
            }
          : {}),
      }
    },
  })

  const interAssistantTools = createInterAssistantTools({
    captureWorkspaceDelegation: async context => {
      const retained = workspaceCredentialDelegation(context.executionContext)
      if (retained) return retained
      const identity = context.executionContext?.identity
      if (identity?.kind !== 'programmatic' || context.sessionPersisted !== true) return undefined
      return captureWorkspaceMcpDelegation(context)
    },
    isFollowing: (follower, following) => connectionStore.isFollowing(follower, following),
    getFollowing: async (id) => {
      const conns = await connectionStore.getFollowing(id)
      return Promise.all(conns.map(async (c) => {
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
        }
      }))
    },
    consultTransport,
  })
  for (const tool of interAssistantTools) allTools.set(tool.name, tool)

  return { calleeExecutor, consultTransport } as const
}
