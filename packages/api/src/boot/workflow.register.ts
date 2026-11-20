/**
 * Workflow executor, external approvals, goal driver and workflow/brain/view tools.
 *
 * Boot register module registerWorkflow: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`WorkflowScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { MODEL_MAP } from '../model-resolution.js'
import { sanitize as sanitizeAnalytics } from '@use-brian/core/analytics/logger.js'
import { createBrainHealingTools } from '@use-brian/core/brain/healing-tools.js'
import {
  createEntityKindClassifier,
} from '@use-brian/core/classification/rules/entity-kind/index.js'
import { createCorrectionTools } from '@use-brian/core/corrections/tools.js'
import { createFindPageTool } from '@use-brian/core/doc/find-page.js'
import { createEntityAliasTools } from '@use-brian/core/entities/alias-tools.js'
import type { GoalRecord } from '@use-brian/core/goals/types.js'
import { createPresentDocumentTool } from '@use-brian/core/tools/base/present-document.js'
import { createViewTools } from '@use-brian/core/views/tools.js'
import {
  type ExecutorDeps as WorkflowExecutorDeps,
  advanceWorkflowRun,
} from '@use-brian/core/workflow/executor.js'
import { buildOneStepReminderWorkflow } from '@use-brian/core/workflow/one-step.js'
import { createScheduleWorkflowTool } from '@use-brian/core/workflow/scheduled-trigger.js'
import { createWorkflowTools } from '@use-brian/core/workflow/tools.js'
import { createWorkflowBrainTools } from '@use-brian/core/workflows/tools.js'
import { restoreWorkspaceMcpDelegation } from '../workspace-mcp/delegation.js'
import { findSessionById } from '../db/sessions.js'
import { providerChannelIdFromSession } from '../db/session-channel-id.js'
import { destinationThreadRef } from '../external-approvals/destinations.js'
import { createExternalApprovalSourceRegistry } from '../external-approvals/source-registry.js'
import { ExternalApprovalService, configureExternalApprovals } from '../external-approvals/service.js'
import { createExternalApprovalSqlStore } from '../external-approvals/sql-store.js'
import { resolveRetainedTaskGoalAuthority } from '../workspace-access/goal-source-admission.js'
import { pauseWorkflowRunForWait } from '../workflow/wait-lifecycle.js'
import { getWorkspacePlan } from '../db/workspace-store.js'
import { createHash } from 'node:crypto'
import { findAssistantById } from '../db/users.js'
import { resolveExecutionContextSystem } from '../context-scope/execution-context.js'
import {
  resolveWorkflowRunScope, resolveGoalAuthoritySystem, resolveWorkflowAuthoringScope,
} from '../context-scope/workflow-authority.js'
import { createEntityMergeStore } from '../db/entity-merge-store.js'
import { publishGoalActivity } from '../goals/activity-bus.js'
import { configureChannelWorkflowReplies } from '../routes/channel-workflow-context.js'
import { createMemoryToEntityPromotionStore } from '../db/memory-to-entity-promotion-store.js'
import { type GoalLoopState, createGoalDriver, isGoalAuthorityFailure } from '../goals/driver.js'
import { claimCrmGoalEventResume, assertGoalCrmSourceAuthority } from '../goals/crm-event-resume.js'
import {
  getGoalForExecutionSystem, tryClaimGoalForTick, transitionRunningGoalStatusSystem,
  finishNativeTaskGoalTerminalSystem, getGoalAwaitingEventSystem, updateGoalSystem,
  setGoalAwaitingEventSystem, clearGoalAwaitingEventSystem,
} from '../db/goals.js'
import { createAllowanceTree } from '../goals/allowance-tree.js'
import { createExecutionLedger } from '../goals/execution-state.js'
import { scheduleNativeGoalTick, captureGoalMaterializationSource } from '../goals/materialization-source.js'
import { readRoutineOperationCeiling } from '../db/routine-intake-store.js'
import { findActiveNativeExecutionSystem } from '../db/task-execution-store.js'
import { buildWorkflowToolRegistry } from '../workflow/mcp-bridge.js'
import {
  type ApprovalBridgeDeps, makeRequestApproval, continueDelegatedWorkflowApproval,
} from '../workflow/approval.js'
import { resolveRecentApprovalChannel } from '../workflow/recent-approval-channel.js'
import { reviewOnCreate, configureApprovalReviewConsumers } from '../approval-review/resolution.js'
import { consumeDelegatedReceipt } from '../approval-review/consumption.js'
import { createApprovalDeliveryDispatcher } from '../workflow/approval-deliveries.js'
import { createWorkflowChannelDelivery } from '../workflow/channel-delivery.js'
import { createWorkflowDependencyPreflight } from '../workflow/dependency-preflight.js'
import { createDeliveryTargetResolver } from '../scheduling/delivery-target.js'
import { createGoalBriefBoundary } from '../briefs/context.js'
import { runIngestPage } from '../doc/ingest-page-runner.js'
import { createDbDocPageSourceStore } from '../db/doc-page-source-store.js'
import { createDbPageActionsStore } from '../db/page-actions-store.js'
import { createDbPageSendLogStore } from '../db/page-send-log-store.js'
import { createGmailSendSeam } from '../google/send-seam.js'
import { createSendPagePort } from '../workflow/send-page.js'
import { createDbDocPageStore } from '../db/doc-page-store.js'
import { supersedeMemoriesByTags } from '../db/memories.js'
import { createMemoryRetractionStore } from '../db/retraction-store.js'
import { authorizeBrainRowMutation } from '../db/brain-inbox-store.js'
import { createSoftDeleteStore } from '../db/soft-delete-store.js'
import { createSensitivityReclassificationStore } from '../db/sensitivity-reclassification-store.js'
import { getPool, query } from '../db/client.js'
import { lazyRoutes } from './lazy.js'
import type { WorkflowScope } from './scope.js'

// Router modules that load on their mount's first request (deployment.md ->
// "Boot composition" -> "Lazy routers and workers"); the mounts below are unchanged.
const externalApprovalRoutes = lazyRoutes(() => import('../external-approvals/routes.js'), 'externalApprovalRoutes')

export function registerWorkflow(scope: WorkflowScope) {
  const {
    ports, env, app, provider, analytics, integrationStore, goalStore, deliverGoalTerminal, crmStore,
    resolvePrimaryAssistantForWorkspace, entityLinksStore, entitiesStore, usageStore, decisionRuntime,
    connectorInstanceStore, workspaceSkillStore, workflowStore, linkedIdentityStore, connectorGrantStore,
    workspaceStore, savedViewStore, workspaceAuditStore, knowledgeStore, jobStore, resolveBackgroundRuntime,
    channelQuestionStore, customChannelStore, allTools, mcpSettingsStore, memoryStore, taskStore,
    brainEpisodeIngestor, workflowRunStore, workspaceDirectoryStore, blueprintRecordStore,
    pendingApprovalsStore, connectorStore, assistantConnectorStore, workspaceToolPolicyStore,
    assistantConnectorGrantsStore, gdriveFilesStore, capabilityStore, apiKeyStore, consultTransport,
    knowledgeRepoWriter, goalDefaultBudgetStore, crmIntakeReadStore, brainCandidateStore, late,
  } = scope
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
    resolveRunScope: async ({ userId, assistantId, workspaceId, run, externalClientPrincipal }) => {
      if (!externalClientPrincipal) return resolveWorkflowRunScope({ userId, assistantId, workspaceId, run })
      const assistant = await findAssistantById(assistantId)
      if (!assistant) throw new Error('Workflow assistant not found.')
      const { turnScope, executionContext } = await resolveExecutionContextSystem({
        userId,
        assistant,
        workspaceId,
        identity: {
          kind: 'programmatic',
          principal: {
            kind: 'brain_key',
            credentialId: externalClientPrincipal.apiKeyId,
            actorUserId: externalClientPrincipal.externalUserId,
          },
          credentialOwnerUserId: userId,
        },
        ownership: { kind: 'workspace', workspaceId },
        lifecycle: {
          abortSignal: new AbortController().signal,
          sessionId: run.id,
          channelType: 'workflow',
          channelId: run.id,
          sessionPersisted: false,
        },
        attribution: { billingUserId: userId, credentialOwnerUserId: userId },
        key: {
          contextGroupId: run.contextGroupId ?? null,
          contextProjectId: run.contextProjectId ?? null,
          contextLockedAt: run.startedAt,
        },
      })
      return { turnScope, executionContext, assistantClearance: assistant.clearance }
    },
    sendPage: sendPagePort,
    resolveVerifiedClientEmail: ({ apiKeyId, assistantId, email }) =>
      linkedIdentityStore.findUniqueVerifiedApiClientByEmail({ apiKeyId, assistantId, email }),
    buildToolRegistry: async ({ workspaceId, assistantId, userId, turnScope, workspaceDelegation }) => {
      const parent = workspaceDelegation ? await restoreWorkspaceMcpDelegation(workspaceDelegation,capabilityStore) : undefined
      return buildWorkflowToolRegistry(
      {
        firstParty: allTools,
        connectorStore,
        settingsStore: mcpSettingsStore,
        assistantConnectorStore,
        connectorGrantStore,
        connectorInstanceStore,
        workspaceToolPolicyStore,
        knowledgeStore,
        // Lets a `tool_call` step write the KB — gated by the executor's
        // `workflow_step` approval pause, never unattended. See the
        // `allowKnowledgeWrites` note in mcp-bridge.ts.
        knowledgeRepoWriter,
        gdriveFilesStore,
        // Evaluated per-run (this closure fires post-boot), so the late
        // `filesApi` initialization below is already done.
        filesApi: late.filesApi ?? undefined,
        engineHooks: ports.engineHooks,
        assistantConnectorGrantsStore,
      },
      { workspaceId, assistantId, userId, turnScope, workspaceConsent: parent?.consent },
    )
    },
    pauseRunForWait: params => pauseWorkflowRunForWait(params,{jobStore,runStore:workflowRunStore,resolvePrimary:resolvePrimaryAssistantForWorkspace}),
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
      } else if (event.type === 'workflow.failure_delivered') {
        details.workflowId = event.workflowId; details.stepId = event.stepId
        details.delivery = event.delivery
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
      questionStore: channelQuestionStore,
      integrationStore: integrationStore ?? undefined,
      defaultTelegramBotToken: env.TELEGRAM_BOT_TOKEN,
      waConnectorUrl: env.WA_CONNECTOR_URL,
      waConnectorSecret: env.WA_CONNECTOR_SECRET,
      customChannelStore,
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
    deliverToChannel: workflowExecutorDeps.deliverToChannel,
    webBaseUrl: env.APP_URL,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
  })

  const externalApprovalSources = createExternalApprovalSourceRegistry()
  const externalApprovalService = new ExternalApprovalService(
    externalApprovalSources, createExternalApprovalSqlStore(),
    async (source, state) => {
      // Live destination session provides only a transport carrier, not an approver.
      const destination = source.audience === 'conversation_members' && source.destinationSessionId
        ? await findSessionById(source.destinationSessionId) : null
      if (source.audience === 'conversation_members' && (!destination
        || destination.workspaceId !== source.workspaceId || destination.assistantId !== source.assistantId
        || destination.channelType !== source.channelType
        || (source.channelType !== 'web' && (providerChannelIdFromSession(destination.channelType, destination.channelId) !== source.channelId
          || destinationThreadRef(destination.channelType, destination.channelId) !== source.threadRef))
        || (source.channelType === 'web' && destination.id !== source.channelId))) return
      const deliveryUserId = destination?.userId ?? source.approverUserId
      if (!deliveryUserId) return
      // Load the frozen request so channel/web cards can show title + details.
      const row = await pendingApprovalsStore.getByIdSystem(state.approvalId)
      const request = (row?.approvalPayload as { request?: { title?: string; message?: string; method?: string; options?: string[]; allowCustom?: boolean } } | undefined)?.request
      const recentTarget = source.channelType === 'web'
        ? (source.channelId !== 'queue'
          ? { channelType: 'web' as const, channelId: source.channelId }
          : undefined)
        : { channelType: source.channelType, channelId: source.channelId,
            channelIntegrationId: source.channelIntegrationId, threadRef: source.threadRef }
      await approvalDeliveries({
        approvalId: state.approvalId, workspaceId: source.workspaceId,
        workflowName: '', stepId: '', toolName: '', arguments: {},
        approverUserId: source.approverUserId, deliveryUserId, externalAction: true,
        deliveryChannelType: source.channelType, deliveryChannelId: source.channelId,
        assistantId: source.assistantId,
        ...(request?.title ? { prompt: { title: request.title, details: request.message,
          ...(request.method === 'question' ? { method: 'question' as const, options: request.options, allowCustom: request.allowCustom } : {}),
        } } : {}),
        ...(recentTarget ? { recentTarget } : {}),
      })
    },
  )
  configureExternalApprovals(externalApprovalService)
  // Dedicated source authentication; before user-authenticated /api routers.
  app.use('/internal/external-approvals', externalApprovalRoutes(externalApprovalService))

  const approvalBridgeDeps: ApprovalBridgeDeps = {
    resolveRecentChannel: resolveRecentApprovalChannel,
    approvalsStore: pendingApprovalsStore,
    auditStore: workspaceAuditStore,
    workflowStore,
    runStore: workflowRunStore,
    buildToolRegistry: workflowExecutorDeps.buildToolRegistry,
    resolvePrimary: workflowExecutorDeps.resolvePrimary,
    deliveries: approvalDeliveries,
    executorDeps: workflowExecutorDeps,
  }
  configureChannelWorkflowReplies(approvalBridgeDeps)
  workflowExecutorDeps.requestApproval = makeRequestApproval(approvalBridgeDeps)
  // Explicitly delegated approval review (features/approval-review.md): a
  // run fully paused on an approval is offered to its assigned reviewer, and
  // a delegated decision continues through the same bridge with the original
  // executor and a receipt revalidated before the gated tool runs.
  workflowExecutorDeps.onApprovalPaused = async ({ runId }) => {
    const pending = await getPool().query<{ id: string; workspace_id: string; kind: string }>(
      `SELECT id, workspace_id, kind FROM pending_approvals WHERE workflow_run_id = $1 AND status = 'pending'`, [runId])
    for (const row of pending.rows) await reviewOnCreate({ id: row.id, workspaceId: row.workspace_id, kind: row.kind as 'workflow_step' })
  }
  configureApprovalReviewConsumers({
    workflowStep: (approval, receipt) => continueDelegatedWorkflowApproval(approvalBridgeDeps, approval, receipt.delegatorUserId, async () => {
      const fresh = await pendingApprovalsStore.getByIdSystem(approval.id)
      if (!fresh) return { ok: false, reason: 'request_missing' }
      const check = await consumeDelegatedReceipt(fresh)
      return check.ok ? { ok: true } : { ok: false, reason: check.reason }
    }),
  })

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
  const scheduleGoalTick = (goal: GoalRecord, fireAt: Date, state: GoalLoopState): Promise<void> =>
    scheduleNativeGoalTick(jobStore, goal, fireAt, state)

  // Resumable task execution: durable pool/checkpoint state for goals that
  // have a native execution (the edition's real UsageStore is usage truth).
  const executionLedger = createExecutionLedger({ allowance: createAllowanceTree({ usageStore: usageStore ?? null }) })

  const goalDriver = createGoalDriver({
    executionLedger,
    briefBoundary: createGoalBriefBoundary(),
    claimCrmEventResume: claimCrmGoalEventResume,
    assertSourceAuthority: assertGoalCrmSourceAuthority,
    executeWithAuthority: async (goal, operation) =>
      (await resolveGoalAuthoritySystem(goal)).executeWithAuthority(operation),
    goalStore:{...goalStore,getByIdSystem:getGoalForExecutionSystem},
    tryClaim: tryClaimGoalForTick,
    transitionRunningStatus: transitionRunningGoalStatusSystem,
    finishTerminal:finishNativeTaskGoalTerminalSystem,
    sessionCostUsd: (sessionId) =>
      usageStore ? usageStore.getSessionCostUsd(sessionId) : Promise.resolve(0),
    meteringAvailable: () => Boolean(usageStore),
    // Workspace credit-cap backstop (hosted): an autonomous acting loop respects
    // the same monthly credit cap a chat turn does — over the cap it BLOCKS
    // (`workspace_over_budget`) rather than run the workspace into the ground.
    // Resolve the workspace plan (system read; fails safe to 'free') and run the
    // injected credit gate: `ok` = under the monthly allowance → proceed,
    // `downgraded`/`blocked` = at/over it → false. The driver only consults this
    // when metering is live (`Boolean(usageStore)`). Wired only when the closed
    // credit gate is injected; absent (open) → undefined → no hosted cap check.
    // The standalone per-goal dollar cap still accrues through its local store. A
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
      const retainedGoal=await resolveRetainedTaskGoalAuthority(goal)
      if(!retainedGoal)publishGoalActivity(goal.id, {
        event: 'status',
        data: { phase: 'iteration_started' },
      })
      let activeRunId = runId
      if (activeRunId) {
        const existing = await workflowRunStore.getRunSystem(activeRunId)
        if (isGoalAuthorityFailure(existing?.error)) {
          throw Object.assign(new Error('goal_source_scope_unavailable'), { code:'goal_source_scope_unavailable' })
        }
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
        // Human steering and the qualified plan travel with the iteration.
        const execution = await findActiveNativeExecutionSystem({ goalId: goal.id })
        if (execution) {
          if (execution.steering.length > 0) runInput.executionSteering = execution.steering.map((x) => x.instruction).join('\n')
          if (execution.checkpoint?.nextStep ?? execution.plan.nextStep) runInput.executionNextStep = execution.checkpoint?.nextStep ?? execution.plan.nextStep
        }
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
      if (outcome.kind === 'failed' && isGoalAuthorityFailure(outcome.error)) {
        throw Object.assign(new Error('goal_source_scope_unavailable'), { code:'goal_source_scope_unavailable' })
      }
      const terminal = outcome.kind === 'completed' || outcome.kind === 'failed'
      if(!retainedGoal)publishGoalActivity(goal.id, {
        event: 'status',
        data: {
          phase: outcome.kind === 'paused'
            ? 'waiting'
            : outcome.kind === 'failed'
              ? 'iteration_failed'
              : 'iteration_completed',
        },
      })
      // Did the agent park this goal on an external event this iteration
      // (`waitForEvent`)? Surface the subscriptions so the driver persists the
      // durable `until:event` marker + safety net rather than the paused-run
      // poll. The marker was cleared at claim time, so this reflects only THIS
      // iteration's `waitForEvent` call (if any).
      const parked = await getGoalAwaitingEventSystem(goal.id)
      // Engine-observed evidence: the run's output content, versioned by
      // hash, so an identical output twice is not new evidence (a finished
      // run alone is never progress).
      let evidence: { summary: string; artifacts: { kind: string; ref: string; version: string }[] } | undefined
      if (outcome.kind === 'completed') {
        const finished = await workflowRunStore.getRunSystem(activeRunId)
        const body = JSON.stringify((finished as { output?: unknown } | null)?.output ?? null)
        if (body !== 'null') {
          evidence = { summary: `Workflow run ${activeRunId} completed.`,
            artifacts: [{ kind: 'workflow_output', ref: goal.means.workflowId ?? 'workflow', version: createHash('sha256').update(body).digest('hex').slice(0, 16) }] }
        }
      }
      return {
        runId: activeRunId,
        terminal,
        completed: outcome.kind === 'completed',
        eventSubscriptions: parked?.subscriptions ?? null,
        evidence,
      }
    },
    deliver: deliverGoalTerminal,
    scheduleGoalTick,
    // No unbudgeted autonomy: kickoff persists the default budget when the
    // author set none. Workspace override first, then the built-in fallback.
    resolveDefaultBudget: async (goal) =>
      (await goalDefaultBudgetStore.get(goal.workspaceId)).budget,
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
    const assistantId = goal.authoringAuthority?.assistantId
    if (!assistantId) throw new Error('goal_authority_unavailable')
    const intake = goal.host?.type === 'task' ? await readRoutineOperationCeiling(goal.workspaceId, goal.host.id) : null
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
      ...(intake ? { tools: intake.actions } : {}),
      name: isVerify ? 'Work a goal to done' : 'Complete a task',
      instructions,
      contextGroupId: goal.contextGroupId,
      contextProjectId: goal.contextProjectId,
      authoringAuthority: goal.authoringAuthority
        ?? (() => { throw new Error('goal_authority_unavailable') })(),
      captureGoalSource: material => captureGoalMaterializationSource(goal.id, 'completion_workflow', material),
      // No wall-clock on a goal iteration (2026-08-19). It used to pin the
      // 900s ceiling because the 90s reminder default clipped real work (a
      // browser-skill run in the cloud sandbox, a research pass, file writes)
      // and made the goal loop burn iterations on timeouts; the default is
      // now no wall-clock at all - the step is progress-bounded by the stall
      // watchdog and cost-bounded by the unchanged turn / tool-call caps + the
      // driver's own spend guards (maxSpend, workspaceBudgetOk). See
      // docs/architecture/engine/computer-use.md → "Working a task's goal".
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
    // Signs proposal receipts: stateless MCP surfaces pass them back verbatim,
    // and every instance must verify what another instance signed.
    proposalReceiptSecret: env.JWT_SECRET,
    listCrmWorkflowEventFilterKeys: async (workspaceId) =>
      (await crmIntakeReadStore.listCrmEventFilterCatalog(workspaceId)).stableKeys.map((item) => item.key),
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
    listAuthorableClientApiKeys: async (userId, assistantId) =>
      (await apiKeyStore.listForUser(userId, assistantId)).map((key) => ({
        id: key.id,
        assistantId: key.assistantId,
        name: key.name,
        scope: key.scope,
        audience: key.audience,
        anonymousContext: key.anonymousContext,
        toolPolicy: key.toolPolicy,
        status: key.status,
        createdAt: key.createdAt.toISOString(),
        lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
      })),
    listTriggerJobs: (workflowId) => jobStore.listFiringJobsForWorkflowSystem(workflowId),
    isKnownTool: (name) => allTools.has(name),
    resolveKnownWorkflowTools: async ({ userId, workspaceId, assistantId, toolNames, authoringAuthority, contextGroupId, contextProjectId }) => {
      const turnScope = await resolveWorkflowAuthoringScope({
        userId, workspaceId, assistantId, authoringAuthority, contextGroupId, contextProjectId,
      })
      const registry = await workflowExecutorDeps.buildToolRegistry({
        userId,
        workspaceId,
        assistantId,
        turnScope,
      })
      return toolNames.filter((toolName) => registry.has(toolName))
    },
    jobStore,
    resolvePrimary: resolvePrimaryAssistantForWorkspace,
    resolveDeliveryTarget: createDeliveryTargetResolver(integrationStore ?? undefined),
    deliverToChannel: createWorkflowChannelDelivery({
      questionStore: channelQuestionStore,
      integrationStore: integrationStore ?? undefined,
      defaultTelegramBotToken: env.TELEGRAM_BOT_TOKEN,
      waConnectorUrl: env.WA_CONNECTOR_URL,
      waConnectorSecret: env.WA_CONNECTOR_SECRET,
      customChannelStore,
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
    // Actor-authorized: the tool deletes only rows its caller may mutate.
    softDelete: createSoftDeleteStore({ authorize: authorizeBrainRowMutation }),
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
      reclassifierModel: MODEL_MAP.pro,
      decisionRuntime,
      resolveLlm: async (workspaceId) => {
        const runtime = await resolveBackgroundRuntime(workspaceId)
        return runtime ? { provider: runtime.provider, model: runtime.selector } : null
      },
    })) {
      allTools.set(healingTool.name, healingTool)
    }
  }

  // Native aliases belong to every edition, independent of reclassification.
  for (const aliasTool of createEntityAliasTools(entitiesStore)) {
    allTools.set(aliasTool.name, aliasTool)
  }

  const scheduleWorkflow = createScheduleWorkflowTool({
    workflowStore, jobStore, resolvePrimary: resolvePrimaryAssistantForWorkspace,
  })
  allTools.set('scheduleWorkflow', scheduleWorkflow)

  const { renderView, saveView } = createViewTools({
    taskStore, crmStore, workflowRunStore,
    workspaceDirectory: workspaceDirectoryStore, savedViewStore,
    // Absolute page links for out-app renders (Slack/Telegram/API) — same
    // origin resolution as the computer-use take-over link above.
    pageUrl: (workspaceId, viewId) =>
      `${(env.AUTHED_APP_URL ?? env.APP_URL).replace(/\/$/, '')}/w/${workspaceId}/p/${viewId}`,
  })
  allTools.set('renderView', renderView)
  allTools.set('saveView', saveView)
  // The chat route removes this presentation-only tool unless the request is
  // from the full Chat operator app. Registering it here keeps construction in
  // the composition root while preventing docks/channels from seeing a UI
  // affordance they cannot render.
  allTools.set('presentDocument', createPresentDocumentTool())

  return {
    workflowExecutorDeps, externalApprovalSources, approvalBridgeDeps, creditGate, scheduleGoalTick,
    workflowDependencyPreflight, entityKindClassifier, goalDriver, createCompletionWorkflow,
    ingestPageRunner, pageActionsStore,
  } as const
}
