/**
 * Task, brand, guardrail, goal, execution, research and CRM tools.
 *
 * Boot register module registerPrimitives: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`PrimitivesScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { calculateCost } from '@use-brian/agent-runtime/billing/cost-tracker.js'
import type { TokenUsage } from '@use-brian/agent-runtime/providers/types.js'
import { sanitize as sanitizeAnalytics } from '@use-brian/core/analytics/logger.js'
import { createBrandTools } from '@use-brian/core/brand/tools.js'
import { createCrmBusinessReferenceTools } from '@use-brian/core/crm/business-reference-tools.js'
import { createCrmCommercialContextTools } from '@use-brian/core/crm/commercial-context-tools.js'
import { createCrmCommercialDocumentTools } from '@use-brian/core/crm/commercial-document-tools.js'
import { createCrmDeliveryOversightTools } from '@use-brian/core/crm/delivery-oversight-tools.js'
import { createCrmEmailDraftTools } from '@use-brian/core/crm/email-drafts.js'
import { createCrmGovernedRecordTools } from '@use-brian/core/crm/governed-record-tools.js'
import {
  CRM_INTEGRATION_OPERATIONS,
  CRM_INTEGRATION_RESOURCE_CATALOG,
} from '@use-brian/core/crm/integration-authority.js'
import {
  createCrmOperationsTools,
  createCrmCredentialTools,
} from '@use-brian/core/crm/operations-tools.js'
import { createCrmTools } from '@use-brian/core/crm/tools.js'
import {
  type GoalLlmUsageContext,
  type GoalLlmRuntime,
  createGoalClarityAssessor,
} from '@use-brian/core/goals/clarity.js'
import { createGoalDefaultBudgetTools } from '@use-brian/core/goals/default-budget-tools.js'
import { createExecutionPlanner } from '@use-brian/core/goals/planner.js'
import { createGoalTools } from '@use-brian/core/goals/tools.js'
import { createTaskTriageJudge } from '@use-brian/core/goals/triage.js'
import { createGoalVerifier } from '@use-brian/core/goals/verify.js'
import { createRealtimeThreadTargetTools } from '@use-brian/core/ingest/realtime-thread-targets.js'
import { createTaskGuardrailTools } from '@use-brian/core/tasks/guardrail-tools.js'
import { createTaskTools } from '@use-brian/core/tasks/tools.js'
import { createInternalLinkTools } from '@use-brian/core/workspace/internal-link-tools.js'
import { createWorkspaceTools } from '@use-brian/core/workspace/tools.js'
import { createTranscriptionPrefTools } from '@use-brian/core/workspace/transcription-tools.js'
import { advanceRetainedGoalWorkflow } from '../workflow/wait-lifecycle.js'
import {
  getWorkspacePlan, getWorkspaceTranscriptionPrefs, setWorkspaceTranscriptionPrefs,
} from '../db/workspace-store.js'
import { triageTaskForGoal } from '../db/goal-task-triage.js'
import { OFFICIAL_CONNECTORS, OFFICIAL_CONNECTOR_TOOLS } from '@use-brian/shared'
import { getWorkspacePrimaryAssistant, listAccessibleAssistants } from '../db/users.js'
import { captureAuthoringAuthoritySystem } from '../context-scope/workflow-authority.js'
import { bindTaskExecutorChangeHook, bindTaskClosedHook, getTaskByIdSystem } from '../db/tasks.js'
import { backgroundModelFor, BACKGROUND_MODEL } from '../model-resolution.js'
import { createCrmReferenceReadStore } from '../db/crm-business-reference-store.js'
import { createCrmCommercialContextReadStore } from '../db/crm-commercial-context-store.js'
import { createCrmCommercialDocumentReadStore } from '../db/crm-commercial-document-store.js'
import { createCrmDeliveryReadStore } from '../db/crm-delivery-oversight-store.js'
import { createCrmGovernedReadStore } from '../db/crm-governed-store.js'
import { createTaskAdmissionPort, createTaskGuardrailStore } from '../db/task-admission-store.js'
import { INITIAL_GOAL_LOOP_STATE } from '../goals/driver.js'
import { createGoalWorkTools } from '../goals/work-tools.js'
import { gatherGoalEvidence } from '../goals/evidence.js'
import { listUsableWorkspaceConnectors } from '../connectors/usable-connectors.js'
import { getGoalByIdSystem, setGoalStatusSystem } from '../db/goals.js'
import {
  type EntryDeps, readExecutionSources, armQualifiedTaskGoal, enterAssignedExecution,
  revalidateWaitingExecutions, resumeAssignedExecution,
} from '../goals/execution-qualification.js'
import {
  noteRoutinePlanningUsage, routineExecutionDeps, routineManifestScope, advanceRoutineIntake,
  ensureRoutineQuestion,
} from '../tasks/routine-execution.js'
import { createRoutineTools } from '../tasks/routine-tools.js'
import { observeRoutineTasks } from '../tasks/routine-observations.js'
import { findActiveNativeExecutionSystem } from '../db/task-execution-store.js'
import { type ControlEffects, createTaskExecutionTools } from '../tasks/execution-control.js'
import { createExternalProgressTools } from '../tasks/external-progress.js'
import { createApprovalReviewTools } from '../approval-review/tools.js'
import { createResearchTools } from '../research/tools.js'
import { createOrganizationTools, createWorkspaceAccessTools } from '../workspace-access/tools.js'
import { createDepartmentTools } from '../workspace-access/department-tools.js'
import { createProjectAccessTools } from '../workspace-access/project-access-tools.js'
import { createProjectHarnessTools } from '../project-harness/tools.js'
import { createBriefTools } from '../briefs/tools.js'
import { createWorkspaceMigrationTools } from '../workspace-access/migration-tools.js'
import { getBrandStore } from '../db/brand-store.js'
import { query } from '../db/client.js'
import type { PrimitivesScope } from './scope.js'

export function registerPrimitives(scope: PrimitivesScope) {
  const {
    configuredProviders, provider, analytics, goalStore, crmDeliveries, crmStore, entityLinksStore,
    usageStore, decisionRuntime, connectorInstanceStore, workflowStore, connectorGrantStore,
    resolveBackgroundRuntime, allTools, taskStore, workflowRunStore, workspaceDirectoryStore,
    pendingApprovalsStore, capabilityStore, workflowExecutorDeps, creditGate, scheduleGoalTick,
    goalDefaultBudgetStore, crmIntakeReadStore, entityKindClassifier, realtimeThreadTargetStore, goalDriver,
    createCompletionWorkflow, internalLinkService, crmOperationsService, crmIntegrationStore,
    crmEmailDraftStore, late,
  } = scope
  // ── Primitive tools (Tasks + CRM) ──
  // The admission gate runs on the `assistant` lane here: a workspace deny
  // rule or a previously rejected title refuses the create with an explanation
  // the model relays; a near-duplicate creates it with a warning appended.
  // Spec: docs/architecture/features/task-guardrails.md
  const taskTools = createTaskTools(taskStore, {
    onObserved: observeRoutineTasks,
    admission: createTaskAdmissionPort(),
    entityLinks: entityLinksStore,
    // Recurring work: a task created inside a workflow run takes the
    // workflow's typed defaultExecutor (workflow.md -> "Default executor").
    resolveRunExecutorDefault: async (workflowRunId) => {
      const run = await workflowRunStore.getRunSystem(workflowRunId)
      const workflow = run ? await workflowStore.findByIdSystem(run.workflowId) : null
      return workflow?.definition.defaultExecutor ?? null
    },
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
  // Bulk pair — confirmation-gated backlog cleanup ("clean up my tasks" as
  // one instruction; tasks.md → "Bulk tools").
  allTools.set('bulkUpdateTasks', taskTools.bulkUpdateTasks)
  allTools.set('archiveTasks', taskTools.archiveTasks)

  // Temporary channel-neutral thread authority. Workflow steps can bind a
  // just-delivered provider message id; inbound adapters consult the same
  // store before applying their ordinary mention/address gate.
  const realtimeThreadTargetTools = createRealtimeThreadTargetTools(realtimeThreadTargetStore)
  allTools.set('setRealtimeThreadTarget', realtimeThreadTargetTools.setRealtimeThreadTarget)
  allTools.set('listRealtimeThreadTargets', realtimeThreadTargetTools.listRealtimeThreadTargets)
  allTools.set('removeRealtimeThreadTarget', realtimeThreadTargetTools.removeRealtimeThreadTarget)

  // ── Brand primitive ──
  // Boot-built like the file tools (NOT through mcp/inject.ts): both carry
  // `requiresCapability: 'brand'`, so the per-turn `filterToolsByCapabilities`
  // call is what gates them and the Studio Built-in rail's toggle is the off
  // switch. `updateBrandDraft` writes the draft only — approval is a Studio
  // action no tool can reach. See docs/architecture/features/brand.md.
  const brandTools = createBrandTools(getBrandStore(), {
    onEvent: (evt, ctx) => {
      const base = { userId: ctx.userId, assistantId: ctx.assistantId, sessionId: ctx.sessionId, channelType: ctx.channelType }
      if (evt.type === 'brand_read') {
        analytics.logEvent({ ...base, eventName: 'brand_read', metadata: { brand_id: sanitizeAnalytics(evt.brandId ?? ''), hit: evt.brandId !== null } })
      } else if (evt.type === 'brand_draft_updated') {
        analytics.logEvent({ ...base, eventName: 'brand_draft_updated', metadata: { brand_id: sanitizeAnalytics(evt.brandId), groups: sanitizeAnalytics(evt.groups.join(',')) } })
      }
    },
  })
  allTools.set('getBrand', brandTools.getBrand)
  allTools.set('updateBrandDraft', brandTools.updateBrandDraft)

  // Guardrail tools — rejecting a task WITH a reason is what teaches the
  // workspace; archiveTasks above is routine cleanup and deliberately teaches
  // nothing. Same `tasks` capability, so a workspace that has tasks has these.
  const guardrailTools = createTaskGuardrailTools(createTaskGuardrailStore())
  allTools.set('rejectTask', guardrailTools.rejectTask)
  allTools.set('saveTaskRule', guardrailTools.saveTaskRule)
  allTools.set('listTaskRules', guardrailTools.listTaskRules)
  allTools.set('deleteTaskRule', guardrailTools.deleteTaskRule)

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

  // Goal classifier/verifier COGS preserves the runtime identity. Workspace
  // custom calls are user-keyed and therefore record zero platform spend.
  const resolveGoalOverheadAssistant = async (userId: string, workspaceId?: string): Promise<string> => {
    try {
      if (workspaceId) {
        const primary = await getWorkspacePrimaryAssistant(userId, workspaceId)
        if (primary) return primary.id
      }
      const assistants = await listAccessibleAssistants(userId)
      return assistants.find((a) => a.kind === 'primary')?.id ?? assistants[0]?.id ?? userId
    } catch {
      return userId
    }
  }
  const recordGoalOverheadUsage =
    (source: 'overhead:goal-clarity' | 'overhead:goal-verify' | 'overhead:goal-triage') =>
    (usage: TokenUsage, context: GoalLlmUsageContext): void => {
      noteRoutinePlanningUsage(context.providerKeySource === 'user' ? 0 : calculateCost(context.model, usage))
      if (!usageStore || !context.userId) return
      const store = usageStore
      const userId = context.userId
      void (context.assistantId
        ? Promise.resolve(context.assistantId)
        : resolveGoalOverheadAssistant(userId, context.workspaceId))
        .then((assistantId) =>
          store.recordUsage({
            userId,
            assistantId,
            sessionId: null,
            model: context.model,
            modelTier: context.modelTier,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            actualCostUsd: context.providerKeySource === 'user'
              ? 0
              : calculateCost(context.model, usage),
            source,
            providerKeySource: context.providerKeySource,
          }),
        )
        .catch((err) => console.error(`[${source}] usage tracking failed:`, err))
    }

  const resolveGoalLlm = async (workspaceId: string): Promise<GoalLlmRuntime | null> => {
    const runtime = await resolveBackgroundRuntime(workspaceId)
    if (runtime) {
      return {
        provider: runtime.provider,
        model: runtime.selector,
        modelTier: runtime.modelTier,
        providerKeySource: runtime.providerKeySource,
        inputTokenLimit: runtime.inputTokenLimit,
        maxTokens: runtime.maxTokens,
      }
    }
    if (configuredProviders.size === 0) return null
    return {
      provider,
      model: backgroundModelFor(configuredProviders),
      modelTier: 'standard',
      providerKeySource: 'platform',
    }
  }

  // Confirmation clarity gate (§12) — assesses whether a goal's definition of
  // done is clear enough to work autonomously; an unclear goal is blocked at
  // confirm with a clarifying question. Cheap Flash classifier; fail-open.
  const goalClarityAssessor = createGoalClarityAssessor({
    provider,
    model: BACKGROUND_MODEL,
    modelTier: 'standard',
    resolveLlm: resolveGoalLlm,
    onUsage: recordGoalOverheadUsage('overhead:goal-clarity'),
  })
  // Agentic completion verifier (§12 Phase 3) — adversarially judges a
  // markGoalComplete claim against the goal's outcome before it closes.
  const goalVerifier = createGoalVerifier({
    provider,
    model: BACKGROUND_MODEL,
    modelTier: 'standard',
    resolveLlm: resolveGoalLlm,
    onUsage: recordGoalOverheadUsage('overhead:goal-verify'),
  })

  // Task autopilot v2 triage judge (task-goal-autopilot.md §8) — one
  // background-tier call per top-level task create: can the assistant honestly
  // help, given what this workspace actually has connected? On pass, mint the
  // draft goal with the generated brief; on fail/error, no draft (fail-closed).
  // Construct even on custom-only deployments. With neither an application
  // provider nor a workspace custom endpoint, the judge fails closed per-call.
  const TRIAGE_MODEL = BACKGROUND_MODEL
  const taskTriageJudge = createTaskTriageJudge({
    provider,
    model: TRIAGE_MODEL,
    modelTier: 'standard',
    decisionRuntime,
    resolveLlm: resolveGoalLlm,
    onUsage: recordGoalOverheadUsage('overhead:goal-triage'),
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
  late.judgeTaskForGoal = (task, userId, authority) => {
    void triageTaskForGoal(task, userId, {
      goalStore,
      // The task's selected executor, and only while the acting user can
      // still see it (tasks.md -> "Responsibility"). Never the primary by
      // inference: no usable executor means no automatic draft.
      resolveAssistantId: async (actor, workspaceId, executorAssistantId) => {
        const usable = await query<{ ok: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM assistants a WHERE a.id = $3 AND a.workspace_id = $2 AND a.kind <> 'app'
             AND public.assistant_placement_visible($1, a.id)) AS ok`,
          [actor, workspaceId, executorAssistantId])
        return usable.rows[0]?.ok ? executorAssistantId : undefined
      },
      // Ready goals use only these public constants; connector metadata is legacy-only.
      publicCoreCapabilities: CORE_CAPABILITY_LINES,
      summariseCapabilities: summariseWorkspaceCapabilities,
      judge: taskTriageJudge,
    }, authority).catch((err) => console.error('[goals] task triage draft failed:', err))
  }
  // An update that makes an assistant the executor triages for it (the
  // previous executor's drafts were retired in the update transaction).
  const executionPlanner = createExecutionPlanner({
    provider, model: TRIAGE_MODEL, modelTier: 'standard', resolveLlm: resolveGoalLlm,
    onUsage: recordGoalOverheadUsage('overhead:goal-triage'),
  })
  const executionEntryDeps: EntryDeps = routineExecutionDeps({
    executorUsable: async (actor, workspaceId, executorAssistantId) => {
      const usable = await query<{ ok: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM assistants a WHERE a.id = $3 AND a.workspace_id = $2 AND a.kind <> 'app'
           AND public.assistant_placement_visible($1, a.id)) AS ok`, [actor, workspaceId, executorAssistantId])
      return usable.rows[0]?.ok === true
    },
    // The selected assistant's actual runtime manifest: tools its active
    // capability grants admit, plus the official tools of connectors usable
    // here. Never connector labels or workflow ids.
    manifest: async (assistantId, workspaceId, actorUserId, task) => {
      const capabilities = new Set(await capabilityStore.listActive(assistantId))
      const turnScope = task ? await routineManifestScope(actorUserId, task) : null
      const registry = turnScope ? await workflowExecutorDeps.buildToolRegistry({ assistantId, workspaceId, userId: actorUserId, turnScope }) : allTools
      const tools = new Set([...allTools.values()]
        .filter((t) => registry.has(t.name) && (!t.requiresCapability || capabilities.has(t.requiresCapability))).map((t) => t.name))
      if (turnScope) for (const tool of registry.values()) {
        if (!tool.requiresCapability || capabilities.has(tool.requiresCapability)) tools.add(tool.name)
      }
      const accounts = new Set<string>()
      for (const u of await listUsableWorkspaceConnectors({ connectorInstanceStore, connectorGrantStore, userId: actorUserId, workspaceId })) {
        const available = OFFICIAL_CONNECTOR_TOOLS[u.instance.provider] ?? []
        if (!turnScope || available.some(t => tools.has(t.name))) accounts.add(u.instance.provider)
        if (!turnScope) for (const t of available) tools.add(t.name)
      }
      return { tools, accounts }
    },
    readSources: readExecutionSources,
    planner: ({ task, context, executorAssistantId, manifestTools, actorUserId }) =>
      executionPlanner({ title: task.title, context, manifestTools, userId: actorUserId, workspaceId: task.workspaceId, assistantId: executorAssistantId }),
    assessClarity: goalClarityAssessor,
    captureAuthority: ({ userId, workspaceId, assistantId }) => captureAuthoringAuthoritySystem({ userId, workspaceId, assistantId }),
    defaultBudget: async (workspaceId) => (await goalDefaultBudgetStore.get(workspaceId)).budget,
    // The canonical arming path: confirm the task's existing draft, or mint
    // one with source proof (ready mode) and confirm it, exactly like the
    // confirm route, with a real authoring envelope.
    armGoal: input => armQualifiedTaskGoal(input, createCompletionWorkflow),
    kickoffGoal: goalDriver.kickoffGoal,
  }, async workspaceId => {
    if (!creditGate) return true
    const { status } = await creditGate(workspaceId, await getWorkspacePlan(workspaceId))
    return status === 'ok'
  })
  workflowExecutorDeps.routineIntake = runId => advanceRoutineIntake(runId, executionEntryDeps, pendingApprovalsStore)
  late.enterOrTriageTask = (task, userId, assignment) => {
    if (!task.executorAssistantId) return
    if (!assignment) { late.judgeTaskForGoal?.(task, userId); return }
    void enterAssignedExecution(task, { kind: 'human_assignment', actorUserId: assignment.actorUserId, origin: assignment.origin,
      at: new Date().toISOString() }, executionEntryDeps)
      .then((r) => { if (r.kind === 'not_entered') late.judgeTaskForGoal?.(task, userId) })
      .catch((err) => console.error('[execution] automatic entry failed:', err))
  }
  bindTaskExecutorChangeHook((task, _previous, userId, assignment) => {
    if (task.executorAssistantId) late.enterOrTriageTask?.(task, userId, assignment)
  })
  // Dependency wake: a prerequisite that actually completed revalidates the
  // unarmed work waiting on it (no polling; the close is the event).
  bindTaskClosedHook((task) => {
    void revalidateWaitingExecutions(task.id, { ...executionEntryDeps, loadTask: getTaskByIdSystem })
      .catch((err) => console.error('[execution] dependency wake failed:', err))
  })

  // Execution controls reach the driver: pause holds the goal without
  // delivery; steer / continue re-activate it and tick now. Counters come
  // from the durable pool, so the fresh handoff state never resets them.
  const executionControlEffects: ControlEffects = {
    afterControl: async (state, kind) => {
      if (!state.goalId) {
        if (kind === 'pause' || !state.taskId) return
        const task = await getTaskByIdSystem(state.taskId)
        if (!task) return
        await resumeAssignedExecution(state.id, task, executionEntryDeps)
        const current = await findActiveNativeExecutionSystem({ taskId: task.id })
        if (current && !current.goalId) await ensureRoutineQuestion(current, pendingApprovalsStore)
        return
      }
      const goal = await getGoalByIdSystem(state.goalId)
      if (!goal || goal.status === 'done' || goal.status === 'abandoned') return
      if (kind === 'pause') {
        if (goal.status === 'active') await setGoalStatusSystem(goal.id, 'blocked', 'execution_paused')
        return
      }
      if (goal.status === 'blocked') await setGoalStatusSystem(goal.id, 'active', null)
      if (goal.status !== 'running') await scheduleGoalTick(goal, new Date(), INITIAL_GOAL_LOOP_STATE)
    },
  }
  const taskExecutionTools = createTaskExecutionTools(executionControlEffects)
  const externalProgressTools = createExternalProgressTools()
  allTools.set('getTaskExecution', taskExecutionTools.getTaskExecution)
  allTools.set('controlTaskExecution', taskExecutionTools.controlTaskExecution)
  allTools.set('bindExternalTaskExecution', externalProgressTools.bindExternalTaskExecution)
  allTools.set('reportTaskProgress', externalProgressTools.reportTaskProgress)
  // Saved research commands (features/research.md): one service for Brian, REST and MCP.
  const researchTools = createResearchTools()
  for (const tool of Object.values(researchTools)) allTools.set(tool.name, tool)
  for (const tool of Object.values(createRoutineTools())) allTools.set(tool.name,tool)
  const approvalReviewTools = createApprovalReviewTools()
  for (const tool of Object.values(approvalReviewTools)) allTools.set(tool.name, tool)

  // Task-autopilot spin-up tools (confirm a draft goal; work a task to done) +
  // the agentic completion signal (markGoalComplete). `gatherEvidence` hands the
  // verifier a read-only host snapshot so it checks the claim against reality.
  const goalWorkTools = createGoalWorkTools({
    createCompletionWorkflow,
    advanceRetainedWorkflowRun: (runId,claim) => advanceRetainedGoalWorkflow(runId,workflowExecutorDeps,claim),
    kickoffGoal: goalDriver.kickoffGoal,
    assessClarity: goalClarityAssessor,
    verify: goalVerifier,
    gatherEvidence: gatherGoalEvidence,
  })
  allTools.set('confirmGoal', goalWorkTools.confirmGoal)
  allTools.set('workTask', goalWorkTools.workTask)
  allTools.set('markGoalComplete', goalWorkTools.markGoalComplete)
  allTools.set('waitForEvent', goalWorkTools.waitForEvent)

  allTools.set(
    'configureGoalDefaultBudget',
    createGoalDefaultBudgetTools(goalDefaultBudgetStore).configureGoalDefaultBudget,
  )

  allTools.set('listWorkspaceMembers', createWorkspaceTools(workspaceDirectoryStore).listWorkspaceMembers)
  for (const tool of [...createOrganizationTools(),...createWorkspaceAccessTools(),...createWorkspaceMigrationTools(),...createDepartmentTools(),...createProjectAccessTools(),...createBriefTools(),...createProjectHarnessTools()]) allTools.set(tool.name,tool)

  for (const tool of Object.values(createInternalLinkTools(internalLinkService))) {
    allTools.set(tool.name, tool)
  }

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
    legacyPipelineStages: {
      resolve: (workspaceId, stage) => crmIntakeReadStore.resolveLegacyPipelineStage(workspaceId, stage),
      service: crmOperationsService,
    },
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
  allTools.set('listCrmFields', crmTools.listCrmFields)
  allTools.set('setCrmCustomFields', crmTools.setCrmCustomFields)
  const crmOperationsTools = createCrmOperationsTools({
    deliveries: crmDeliveries,
    reads: crmIntakeReadStore,
    service: crmOperationsService,
  })
  for (const tool of Object.values(crmOperationsTools)) allTools.set(tool.name, tool)
  const crmBusinessReferenceTools = createCrmBusinessReferenceTools({ reads: createCrmReferenceReadStore(), service: crmOperationsService })
  for (const tool of Object.values(crmBusinessReferenceTools)) allTools.set(tool.name, tool)
  const crmCommercialContextTools = createCrmCommercialContextTools({ reads: createCrmCommercialContextReadStore(), service: crmOperationsService })
  for (const tool of Object.values(crmCommercialContextTools)) allTools.set(tool.name, tool)
  const crmCommercialDocumentTools = createCrmCommercialDocumentTools({ reads: createCrmCommercialDocumentReadStore(), service: crmOperationsService })
  for (const tool of Object.values(crmCommercialDocumentTools)) allTools.set(tool.name, tool)
  const crmDeliveryOversightTools=createCrmDeliveryOversightTools({reads:createCrmDeliveryReadStore(),service:crmOperationsService})
  for(const tool of Object.values(crmDeliveryOversightTools))allTools.set(tool.name,tool)
  const crmGovernedRecordTools = createCrmGovernedRecordTools({ reads: createCrmGovernedReadStore(), service: crmOperationsService })
  for (const tool of Object.values(crmGovernedRecordTools)) allTools.set(tool.name, tool)
  const crmCredentialTools = createCrmCredentialTools({
    preview: async (input, authority, parent) => ({
      ...await crmIntegrationStore.bindingOptions(authority.ceiling.workspaceId, authority.ceiling.userId, input, authority, parent),
      operations: CRM_INTEGRATION_OPERATIONS, selectors: CRM_INTEGRATION_RESOURCE_CATALOG,
    }),
    list: (input, authority, parent) => crmIntegrationStore.listForMember(authority.ceiling.workspaceId, authority.ceiling.userId, input, authority, parent),
    create: (input, authority, parent) => crmIntegrationStore.create(authority.ceiling.workspaceId, authority.ceiling.userId, input, authority, parent),
    revoke: async (input, authority, parent) => ({ revoked: await crmIntegrationStore.revoke(authority.ceiling.workspaceId, authority.ceiling.userId, input.credentialId, authority, parent) }),
  })
  for (const tool of Object.values(crmCredentialTools)) allTools.set(tool.name, tool)
  const crmEmailDraftTools = createCrmEmailDraftTools(crmEmailDraftStore)
  allTools.set('saveEmailDraft', crmEmailDraftTools.saveEmailDraft)
  allTools.set('getEmailDraft', crmEmailDraftTools.getEmailDraft)
  allTools.set('listEmailDrafts', crmEmailDraftTools.listEmailDrafts)

  return {
    taskTools, brandTools, goalClarityAssessor, executionControlEffects, taskExecutionTools,
    externalProgressTools, researchTools, approvalReviewTools, crmTools, crmOperationsTools,
    crmBusinessReferenceTools, crmCommercialContextTools, crmCommercialDocumentTools,
    crmDeliveryOversightTools, crmGovernedRecordTools, crmCredentialTools,
  } as const
}
