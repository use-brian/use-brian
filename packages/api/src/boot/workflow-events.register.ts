/**
 * Event run queue, workflow event dispatcher and CRM/campaign workers.
 *
 * Boot register module registerWorkflowEvents: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`WorkflowEventsScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import {
  type StrictWorkflowEventDispatcher,
  createWorkflowEventDispatcher,
} from '@use-brian/core/workflow/event-trigger.js'
import { advanceWorkflowRun } from '@use-brian/core/workflow/executor.js'
import { createRunQueueWorker } from '@use-brian/core/workflow/run-queue.js'
import { randomUUID } from 'node:crypto'
import {
  crmWorkflowAdmission, createCrmDomainEventWorker, createDbCrmDomainEventOutboxStore,
} from '../crm-operations/domain-event-worker.js'
import { createDbCrmOperationsStore } from '../db/crm-operations-store.js'
import { kbMaintenanceRunGuard } from '../knowledge/maintenance.js'
import { findEventWaitingGoalsSystem } from '../db/goals.js'
import {
  createWorkflowRunQueueStore, findEventTriggeredWorkflowsSystem, countRecentRunsForWorkflowSystem,
  pauseWorkflowForPrimitiveEventSystem, getWorkflowCreatorSystem, pauseWorkflowSystem,
} from '../db/workflow-store.js'
import { connectorWorkflowEventAdmissibleSystem } from '../workflow/connector-event-admission.js'
import { crmDocumentWorker } from '../crm-operations/commercial-preparations.js'
import { setPageEventDispatcher } from '../page-event-fanout.js'
import { setTaskEventDispatcher } from '../task-event-fanout.js'
import { setKnowledgeEventDispatcher } from '../knowledge-event-fanout.js'
import { setBrandEventDispatcher } from '../brand-event-fanout.js'
import { setMessageEventDispatcher } from '../message-events.js'
import { lazyWorker } from './lazy.js'
import type { WorkflowEventsScope } from './scope.js'

// Worker modules that load when the worker starts (deployment.md -> "Boot
// composition" -> "Lazy routers and workers"); `--no-workers` never loads them.
const createCrmImportFileCleanupWorker = lazyWorker(() => import('../crm-operations/import-file-cleanup-worker.js'), 'createCrmImportFileCleanupWorker', '[crm-file-cleanup]')
const createAssociationLifecycleWorker = lazyWorker(() => import('../association/lifecycle-worker.js'), 'createAssociationLifecycleWorker', '[association-lifecycle]')
const createProviderInboxWorker = lazyWorker(() => import('../association/provider-inbox-worker.js'), 'createProviderInboxWorker', '[provider-inbox]')
const createCrmEntitlementWorker = lazyWorker(() => import('../crm-operations/entitlement-worker.js'), 'createCrmEntitlementWorker', '[crm-entitlement-expiry]')
const createCrmRetentionWorker = lazyWorker(() => import('../crm-operations/retention-worker.js'), 'createCrmRetentionWorker', '[crm-retention]')
const createCampaignConversionOutboxWorker = lazyWorker(() => import('../campaigns/conversion-outbox.js'), 'createCampaignConversionOutboxWorker', '[campaign-conversions]')

export function registerWorkflowEvents(scope: WorkflowEventsScope) {
  const {
    crmDocumentRuntime, connectorGrantStore, campaignDispatchService, filesResolver, runWorkers, associationStore,
    workflowRunStore, workflowExecutorDeps, goalDriver, kbMaintenanceStore,
  } = scope
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

  const workflowEventDispatcher: StrictWorkflowEventDispatcher = createWorkflowEventDispatcher({
    findEventTriggeredWorkflows: ({ workspaceId }) =>
      findEventTriggeredWorkflowsSystem(workspaceId),
    findAdditionalConnectorEventWorkspaces: ({ connectorInstanceId }) =>
      connectorGrantStore.listGrantedWorkspaceIdsForInstanceSystem(connectorInstanceId),
    startWorkflowRun: async ({ workflowId, workspaceId, input }) => {
      // A connector event outside the workflow's department audience is withheld before any
      // effect (run, storm pause or audit). Channel and brand sources carry no department audience.
      if (input.trigger.sourceType === 'connector' && (!input.trigger.connectorInstanceId
        || !await connectorWorkflowEventAdmissibleSystem(workflowId, workspaceId, input.trigger.connectorInstanceId))) {
        console.warn(`[workflow-event] connector event withheld from workflow ${workflowId}: outside its department audience`)
        return
      }
      const recent = await countRecentRunsForWorkflowSystem(
        workflowId,
        RUN_STORM_WINDOW_SECONDS,
      )
      if (recent >= RUN_STORM_THRESHOLD) {
        const reason = `Paused automatically: this workflow's event trigger started ${recent} runs in the last ${Math.round(RUN_STORM_WINDOW_SECONDS / 60)} minutes. Review the trigger's match filter, then re-enable the workflow to resume.`
        if (input.trigger.sourceType === 'task' || input.trigger.sourceType === 'knowledge' || input.trigger.sourceType === 'page') {
          await pauseWorkflowForPrimitiveEventSystem({ workflowId, workspaceId, input, triggerKind:'event',
            triggeredBy:await getWorkflowCreatorSystem(workflowId) }, reason)
        } else {
          await pauseWorkflowSystem(workflowId, reason)
        }
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
      // KB self-maintain budget guard (mig 411): a knowledge-managed
      // workflow over its weekly proposal budget (or whose agent is
      // disabled) skips the run — the 7-day window slides, so it resumes
      // by itself. One indexed read for every non-managed workflow.
      try {
        const guard = await kbMaintenanceRunGuard(kbMaintenanceStore, workflowId)
        if (guard.skip) {
          console.warn(`[workflow-event] kb-maintenance guard skipped workflow ${workflowId}: ${guard.reason}`)
          return
        }
      } catch (err) {
        console.warn('[workflow-event] kb-maintenance guard failed (run proceeds):', err)
      }
      const triggeredBy = await getWorkflowCreatorSystem(workflowId)
      const crmAdmission = crmWorkflowAdmission(input)
      if (crmAdmission && workflowRunStore.createWebhookRun) {
        const admitted = await workflowRunStore.createWebhookRun({
          workflowId,
          workspaceId,
          triggeredBy,
          triggerKind: 'event',
          input,
          ...crmAdmission,
        })
        if (admitted.kind === 'conflict') {
          throw new Error(`CRM domain event ${input.event.domainEventId as string} conflicted with an existing workflow run.`)
        }
        runQueueWorker.nudge()
        return
      }
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
    resumeEventWaitingGoal: ({ goalId, event }) => goalDriver.resumeOnEvent(goalId, event),
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
  // Knowledge lifecycle events likewise — the seam `db/knowledge-store.ts`
  // publishes into on every entry create / update / delete, covering the sync
  // worker, the assistant repo-writer's write-through, and manual edits.
  setKnowledgeEventDispatcher(workflowEventDispatcher)
  // Brand lifecycle events likewise — the seam `db/brand-store.ts` publishes
  // into on create / draft update / approve / supersede, covering the Studio
  // routes, the `updateBrandDraft` chat tool, and the brain-MCP bridge.
  setBrandEventDispatcher(workflowEventDispatcher)
  setMessageEventDispatcher(workflowEventDispatcher)

  const crmDomainEventWorker = createCrmDomainEventWorker({
    store: createDbCrmDomainEventOutboxStore(),
    dispatcher: workflowEventDispatcher,
    workerId: `crm-domain-${process.pid}-${randomUUID()}`,
    onError: (error, event) => console.warn(
      `[crm-domain-events] ${event?.id ?? '(tick)'} failed:`,
      error instanceof Error ? error.message : error,
    ),
  })
  if (runWorkers) crmDomainEventWorker.start()
  const campaignConversionWorker = createCampaignConversionOutboxWorker({
    onError: (_error, lease) => console.warn(`[campaign-conversions] ${lease?.id ?? '(tick)'} projection failed; retry is scheduled.`),
  })
  if (runWorkers) campaignConversionWorker.start()
  if (runWorkers) campaignDispatchService.start()
  const crmRetentionWorker = createCrmRetentionWorker({ onError: () => console.warn('[crm-retention] Retention run failed; inspect the workspace run report.') })
  if (runWorkers) crmRetentionWorker.start()
  // Recovers issue attempts whose inline run did not finish (crash, deploy, lease expiry).
  const crmIssueWorker = crmDocumentWorker(createDbCrmOperationsStore(), crmDocumentRuntime, { onError: () => console.warn('[crm-documents] An issue attempt could not be processed; a later scan retries it.') })
  if (runWorkers) crmIssueWorker.start()
  const crmEntitlementWorker=createCrmEntitlementWorker({onError:()=>console.warn('[crm-entitlement-expiry] A due grant could not be processed; a later scan will retry.')})
  if(runWorkers) crmEntitlementWorker.start()
  const associationLifecycleWorker=createAssociationLifecycleWorker({onError:()=>console.warn('[association-lifecycle] A lifecycle operation failed; a later scan will retry.')})
  if(runWorkers) associationLifecycleWorker.start()
  const providerInboxWorker = createProviderInboxWorker({
    process: (workspaceId, receiptId) => associationStore.retryProviderEventReceipt(workspaceId, receiptId),
    onError: () => console.warn('[provider-inbox] A receipt did not apply; inspect its retry or reconciliation state.'),
  })
  if (runWorkers) providerInboxWorker.start()
  const crmFileCleanupWorker = filesResolver ? createCrmImportFileCleanupWorker({resolver:filesResolver,onError:()=>console.warn('[crm-file-cleanup] Cleanup failed; inspect the workspace receipt.')}) : null
  if (runWorkers) crmFileCleanupWorker?.start()

  return {
    runQueueWorker, workflowEventDispatcher, crmDomainEventWorker, campaignConversionWorker,
    crmRetentionWorker, crmIssueWorker, crmEntitlementWorker, crmFileCleanupWorker, associationLifecycleWorker, providerInboxWorker,
  } as const
}
