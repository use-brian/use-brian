/**
 * Job executor, session resume replay, poll and session workers.
 *
 * Boot register module registerWorkers: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`WorkersScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { createGeminiProvider } from '@use-brian/agent-runtime/providers/gemini.js'
import { wrapProvider } from '@use-brian/agent-runtime/providers/wrappers.js'
import { sanitize as sanitizeAnalytics } from '@use-brian/core/analytics/logger.js'
import { createPollWorker } from '@use-brian/core/scheduling/poll-worker.js'
import { advanceWorkflowRun } from '@use-brian/core/workflow/executor.js'
import { recordOverheadUsage } from '../routes/_overhead-usage.js'
import { resumeWorkflowWaitJob } from '../workflow/wait-lifecycle.js'
import { runSessionResume } from '../routes/chat.js'
import { backgroundModelFor } from '../model-resolution.js'
import { createSessionResumeReplay } from '../routes/session-resume-replay.js'
import { bootstrapHistoricalCrmIdentityState } from '../db/crm-identity-store.js'
import { publishSessionEvent } from '../session-event-bus.js'
import { parseGoalTick } from '../goals/driver.js'
import { createJobExecutor } from '../scheduling/executor.js'
import { lazyWorker } from './lazy.js'
import type { WorkersScope } from './scope.js'

// Worker modules that load when the worker starts (deployment.md -> "Boot
// composition" -> "Lazy routers and workers"); `--no-workers` never loads them.
const createSessionStateWorker = lazyWorker(() => import('../workers/session-state-worker.js'), 'createSessionStateWorker', '[session-state-worker]')
const createSessionTitleWorker = lazyWorker(() => import('../workers/session-title-worker.js'), 'createSessionTitleWorker', '[session-title-worker]')
const createOrganizationUpgradeWorker = lazyWorker(() => import('../workspace-access/organization-upgrade-worker.js'), 'createOrganizationUpgradeWorker', '[organization-upgrade]')
const createCleanupWorker = lazyWorker(() => import('../scheduling/cleanup-worker.js'), 'createCleanupWorker', '[cleanup-worker]')

export async function registerWorkers(scope: WorkersScope) {
  const {
    ports, configuredProviders, provider, analytics, usageStore, connectorInstanceStore,
    connectorSourceRuntimeFactory, workflowStore, resolveWorkspaceCustomLlm, connectorGrantStore,
    knowledgeStore, workerManager, jobStore, allTools, mcpSettingsStore, runWorkers, workflowRunStore,
    pendingApprovalsStore, workerRunsStore, filesApi, connectorStore, assistantConnectorStore,
    workspaceToolPolicyStore, assistantConnectorGrantsStore, gdriveFilesStore, deferredConfirmationStore,
    workflowExecutorDeps, goalDriver, resolveWorkspaceByoGeminiKey, isPlaceholderTitle,
    getTitleChannelPrefix, webChatSystemPrompt, sessionResumeStore, workspaceMcpProfile, runQueueWorker,
  } = scope
  // ════════════════════════════════════════════════════════════════
  // Open background workers
  // ════════════════════════════════════════════════════════════════
  if (runWorkers) {
    try {
      const bootstrapped = await bootstrapHistoricalCrmIdentityState()
      if (bootstrapped.bindingsCreated > 0 || bootstrapped.separationsCreated > 0
        || bootstrapped.collisionsSkipped > 0) {
        console.log(
          `[decision-learning] CRM bootstrap: bindings=${bootstrapped.bindingsCreated} separations=${bootstrapped.separationsCreated} collisions=${bootstrapped.collisionsSkipped}`,
        )
      }
    } catch (err) {
      console.error(
        '[decision-learning] CRM bootstrap failed:',
        err instanceof Error ? err.message : err,
      )
    }
  }
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
      if (job.workflowStepRunId) return resumeWorkflowWaitJob(job,{jobStore,runStore:workflowRunStore,workflowStore,executorDeps:workflowExecutorDeps})
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
        ...(job.scheduleClaimId ? { scheduledJob: { id: job.id, claimId: job.scheduleClaimId } } : {}),
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
    configuredProviders,
    provider,
    resolveWorkspaceCustomLlm,
    resolveWorkspaceByoGeminiKey,
    buildWorkspaceProvider: (apiKey) => wrapProvider(createGeminiProvider(apiKey)),
    usageStore,
    tools: allTools,
    // The `resume` capability profile activates exactly the suspended connector tool.
    capabilityStores: { connectorStore, settingsStore: mcpSettingsStore, assistantConnectorStore, connectorGrantStore,
      connectorInstanceStore, workspaceToolPolicyStore, assistantConnectorGrantsStore, connectorSourceRuntimeFactory,
      knowledgeStore, gdriveFilesStore, filesApi: filesApi ?? undefined, engineHooks: ports.engineHooks },
    systemPrompt: webChatSystemPrompt,
    analytics,
    workerManager,
    workerRunsStore,
    publishSessionEvent,
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

  const sessionTitleWorker = createSessionTitleWorker({
    isPlaceholderTitle, getTitleChannelPrefix,
    async resolveRuntime(workspaceId) {
      const runtime = await resolveWorkspaceCustomLlm({ workspaceId, requestedTier: 'standard', allowDefault: true, allowAnyDefault: true })
      return { provider: runtime?.provider ?? provider, model: runtime?.selector ?? backgroundModelFor(configuredProviders),
        providerKeySource: runtime?.providerKeySource ?? 'platform' }
    },
    async recordUsage(job, result, runtime) {
      await recordOverheadUsage({ usageStore, userId: job.actorUserId, assistantId: job.assistantId,
        sessionId: job.sessionId, userMessageId: job.userMessageId ?? undefined,
        model: result.model, usage: result.usage, source: 'overhead:title', triggerKey: 'session_title',
        modelTier: 'standard', providerKeySource: runtime.providerKeySource })
    },
  })
  if (runWorkers) sessionTitleWorker.start()
  if (runWorkers) workspaceMcpProfile.runWorker?.start()

  const sessionStateWorker = createSessionStateWorker({
    async resolveRuntime(workspaceId) {
      const runtime = await resolveWorkspaceCustomLlm({ workspaceId, requestedTier: 'standard', allowDefault: true, allowAnyDefault: true })
      return { provider: runtime?.provider ?? provider, model: runtime?.selector ?? backgroundModelFor(configuredProviders),
        providerKeySource: runtime?.providerKeySource ?? 'platform' }
    },
    async recordResult(job, result, runtime) {
      analytics?.logEvent({ userId: job.actorUserId, assistantId: job.assistantId, sessionId: job.sessionId,
        eventName: result.errorMessage ? 'session_state_diff_failed' : 'session_state_diff_pass', channelType: 'web',
        metadata: { upserts: result.upserts, resolves: result.resolves, failed: Boolean(result.errorMessage), background: true } })
      await recordOverheadUsage({ usageStore, userId: job.actorUserId, assistantId: job.assistantId,
        sessionId: job.sessionId, userMessageId: job.userMessageId,
        model: result.model, usage: result.usage, source: 'overhead:session-state-diff', triggerKey: 'session_state_diff',
        modelTier: 'standard', providerKeySource: runtime.providerKeySource })
    },
  })
  if (runWorkers) sessionStateWorker.start()

  const organizationUpgradeWorker = createOrganizationUpgradeWorker()
  if (runWorkers) organizationUpgradeWorker.start()

  const cleanupWorker = createCleanupWorker({ jobStore })
  if (runWorkers) cleanupWorker.start()

  return { pollWorker, sessionTitleWorker, sessionStateWorker, organizationUpgradeWorker } as const
}
