/**
 * Domain stores (memory, goals, tasks, CRM, workflow, pages, retrieval) and analytics.
 *
 * Boot register module registerStores: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`StoresScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { executionToolContext } from '@use-brian/agent-runtime/security/execution-context.js'
import { sanitize as sanitizeAnalytics, AnalyticsLogger } from '@use-brian/core/analytics/logger.js'
import type { SessionContextAuthority } from '@use-brian/core/memory/session-state-types.js'
import type { TaskRecord, TaskAssignmentProvenance } from '@use-brian/core/tasks/types.js'
import { resolveRetainedTaskGoalAuthority } from '../workspace-access/goal-source-admission.js'
import { admitModelOutput } from '../context-scope/admission.js'
import { createDbEntitiesStore } from '../db/entities-store.js'
import { createDbConnectorActionStore } from '../db/connector-actions-store.js'
import { setGlobalMailboxContactImportDeps } from '../mailbox/contact-import-tools.js'
import { createCrmDeliveryService } from '../crm-operations/delivery-service.js'
import { createCrmDeliveryProvider } from '../crm-operations/delivery-providers.js'
import { createCampaignEmailService } from '../content-planning/email.js'
import {
  getGlobalEmailInboxProvider, setGlobalEmailInboxProvider, createEmailInboxProvider,
} from '../agentmail/provider.js'
import { createCrmOperationsService } from '../crm-operations/service.js'
import { createDbCrmOperationsStore } from '../db/crm-operations-store.js'
import { createDbCrmIntakeReadStore } from '../db/crm-intake-store.js'
import { createCampaignDispatchService } from '../campaigns/dispatch.js'
import { createDbHomeDockStore } from '../db/home-dock-store.js'
import { publishGoalActivity } from '../goals/activity-bus.js'
import { createDbMemoryStore } from '../db/memory-store.js'
import { createMemoryRecallEventsStore } from '../db/memory-recall-events-store.js'
import { createDbTaskStore } from '../db/tasks-store.js'
import { createDbGoalStore } from '../db/goals-store.js'
import { createGoalRollupRunner } from '../goals/rollup-runner.js'
import type { GoalDeliver } from '../goals/writeback.js'
import { claimGoalRollupTerminalSystem, finishNativeTaskGoalTerminalSystem } from '../db/goals.js'
import { createDbCrmStore } from '../db/crm-store.js'
import { createDbCrmEmailDraftStore } from '../db/crm-email-drafts.js'
import { createDbWorkspaceFilesStore } from '../db/workspace-files-store.js'
import { createWorkspaceFileUploadsStore } from '../db/workspace-file-uploads-store.js'
import { createDbWorkflowStore, createDbWorkflowRunStore } from '../db/workflow-store.js'
import { createPendingApprovalsStore } from '../db/pending-approvals-store.js'
import { createDomainProvisioner } from '../domains/provisioner.js'
import { createDbSavedViewStore } from '../db/saved-views-store.js'
import { publishPageLifecycle } from '../page-event-fanout.js'
import { createDbPageGrantStore } from '../db/page-grant-store.js'
import { createDbPageDomainStore } from '../db/page-domain-store.js'
import { createDbInternalLinkAliasStore } from '../db/internal-link-alias-store.js'
import { createDbPageTemplateStore } from '../db/page-templates-store.js'
import { createDbBlueprintRecordStore } from '../db/blueprint-records-store.js'
import { createDbWorkspaceGroupStore } from '../db/workspace-group-store.js'
import { createDbDocThemesStore } from '../db/doc-themes-store.js'
import { createDbDocEntityStore } from '../db/doc-entity-store.js'
import { createDbEpisodicStore } from '../db/episodic-store.js'
import { createDbEpisodesStore } from '../db/episodes-store.js'
import { createDbEntityLinksStore } from '../db/entity-links-store.js'
import { composeRetrievalStore, createDbRetrievalStore } from '../db/retrieval-store.js'
import { createDbProvenanceStore } from '../db/provenance-store.js'
import { createDbAggregateStore } from '../db/aggregate-store.js'
import { createDbRowHistoryStore } from '../db/row-history-store.js'
import { createDbMarkUsefulStore } from '../db/mark-useful-store.js'
import { createDbSessionStateStore } from '../db/session-state-store.js'
import { createDbPlanStore } from '../db/plan-steps-store.js'
import { createDbCacheStore } from '../db/cache-store.js'
import { createDbFileStore } from '../db/file-store.js'
import { createDbAnalyticsStore } from '../db/analytics-store.js'
import { loadChannelCredentialKey } from '../db/channel-integrations.js'
import { createCrmIntegrationStore } from '../db/crm-integration-store.js'
import { deliverToChannel } from '../inter-assistant/deliver.js'
import { query } from '../db/client.js'
import type { StoresScope } from './scope.js'

export function registerStores(scope: StoresScope) {
  const { ports, env, sharedEmbedder, late } = scope
  async function resolvePrimaryAssistantForWorkspace(workspaceId: string, _userId?: string, execute: typeof query = query): Promise<string | null> {
    const result = await execute<{ id: string }>(
      `SELECT id FROM assistants WHERE workspace_id = $1 AND kind = 'primary' LIMIT 1`,
      [workspaceId],
    )
    return result.rows[0]?.id ?? null
  }

  const memoryStore = createDbMemoryStore({ excludedBackgroundWorkspaceIdsSql: ports.backgroundInferencePolicy?.excludedWorkspaceIdsSql })
  const brainCandidateStore = ports.brainCandidateStore
  const memoryRecallEventsStore = createMemoryRecallEventsStore()
  const goalStore = createDbGoalStore()
  // Terminal delivery for a goal (done | blocked) — the workspace primary
  // assistant messages the creator (sanitized by deliverToChannel). Shared by
  // the structural rollup AND the acting-loop driver (no silent termination,
  // goals.md §7).
  const deliverGoalTerminal: GoalDeliver = async (goal, terminal, reason) => {
    const retained=await resolveRetainedTaskGoalAuthority(goal)
    if(retained)await admitModelOutput({...executionToolContext(retained.authority.execution,{appId:'native'}),scopeAccumulator:retained.authority.accumulator})
    if(!retained)publishGoalActivity(goal.id, {
      event: 'done',
      data: { status: terminal, ...(reason ? { reason } : {}) },
    })
    if (!goal.createdByUserId) return
    // Terminal analytics (goal_done / goal_blocked): this seam is the one place
    // BOTH terminal paths (acting loop + structural rollup) converge, so the
    // taxonomy is covered without touching either loop. Emit before the channel
    // delivery so a delivery failure never loses the event.
    if(!retained)analytics.logEvent({
      userId: goal.createdByUserId,
      channelType: 'workflow',
      eventName: terminal === 'done' ? 'goal_done' : 'goal_blocked',
      metadata: {
        goal_id: sanitizeAnalytics(goal.id),
        ...(reason ? { reason: sanitizeAnalytics(reason) } : {}),
      },
    })
    const assistantId = goal.authoringAuthority?.assistantId
    if (!assistantId) return
    const text =
      terminal === 'done'
        ? `Goal done: ${goal.outcome}`
        : reason === 'unconfirmed_needs_clarification'
          ? `I tried to work a task but its goal isn't confirmed yet: "${goal.outcome}". Confirm the goal and I'll proceed.`
          : `Goal blocked${reason ? ` (${reason})` : ''}: ${goal.outcome}`
    // In-chat pursuit: a goal that originated in a chat session also persists
    // its terminal line back into that transcript, so the conversation records
    // how the pursuit ended (the notification-session copy still lands).
    await deliverToChannel({
      workspaceId: goal.workspaceId,
      assistantId,
      userId: goal.createdByUserId,
      text,
      channelType: 'web',
      scopeEvidence: retained?.authority.accumulator.evidence??{
        sensitivity: 'public',
        compartments: goal.authoringAuthority?.ceiling.mutationCompartments ?? [],
        projectIds: goal.contextProjectId ? [goal.contextProjectId] : [],
      },
      integrationStore: late.integrationStore ?? undefined,
      ...(goal.originSessionId ? { sessionId: goal.originSessionId } : {}),
    })
  }
  // Structural goal-seeker rollup: when a sub-task closes, complete any
  // task-hosted goal whose `subtasks` done_when is now met (no acting loop, no
  // metering).
  const goalRollup = createGoalRollupRunner({
    goalStore,
    claimTerminal: claimGoalRollupTerminalSystem,
    finishTerminal:finishNativeTaskGoalTerminalSystem,
    deliverGoalDone: (goal) => deliverGoalTerminal(goal, 'done', null),
  })
  // Task autopilot v2 (task-goal-autopilot.md §8): a top-level task create no
  // longer mints a templated draft. The triage judge (one background-tier LLM
  // call: "can the assistant honestly help?") drafts a goal WITH a brief only
  // on a pass. The judge needs the provider + usage stores, constructed later
  // in boot, so the hook calls through this late-bound ref. Null (OSS keyless,
  // or before wiring) = no drafting — fail-closed by design.
  late.judgeTaskForGoal = null
  // Assigned execution (goals.md -> "Formation, readiness and automatic
  // entry"): late-bound like the judge. A create carrying trusted human
  // assignment provenance enters execution; anything else keeps triage.
  late.enterOrTriageTask = null
  const taskStore = createDbTaskStore({
    onTaskTerminal: goalRollup.onTaskTerminal,
    onTaskCreate: (task, userId, assignment, authority) => {
      if(authority){late.judgeTaskForGoal?.(task,userId,authority);return}
      if (late.enterOrTriageTask) late.enterOrTriageTask(task, userId, assignment)
      else late.judgeTaskForGoal?.(task, userId)
    },
  })
  const crmStore = createDbCrmStore()
  const crmEmailDraftStore = createDbCrmEmailDraftStore()
  const campaignDkim = env.CAMPAIGN_DKIM_DOMAIN && env.CAMPAIGN_DKIM_SELECTOR && env.CAMPAIGN_DKIM_PRIVATE_KEY
    ? {
        domainName: env.CAMPAIGN_DKIM_DOMAIN,
        keySelector: env.CAMPAIGN_DKIM_SELECTOR,
        privateKey: env.CAMPAIGN_DKIM_PRIVATE_KEY.replaceAll('\\n', '\n'),
      }
    : undefined
  const crmDeliveries = createCrmDeliveryService(createCrmDeliveryProvider({
    encryptionKey: env.CHANNEL_CREDENTIAL_KEY ? loadChannelCredentialKey(env.CHANNEL_CREDENTIAL_KEY) : null,
    emailProvider: getGlobalEmailInboxProvider,
    ...(campaignDkim ? { campaignMail: { dkim: campaignDkim } } : {}),
  }))
  const campaignEmailService = createCampaignEmailService({ deliveries: crmDeliveries })
  const campaignDispatchService = createCampaignDispatchService({
    deliveries: crmDeliveries,
    email: campaignEmailService,
    publicOrigin: env.CAMPAIGN_PUBLIC_ORIGIN ?? env.API_URL,
    oneClickEnabled: Boolean(campaignDkim),
  })
  // The Office binding is attached once Office storage and release are composed below.
  const crmDocumentRuntime: import('../crm-operations/commercial-preparations.js').CrmCommercialDocumentRuntime = { binding: null }
  const crmOperationsService = createCrmOperationsService(createDbCrmOperationsStore(), { deliveries: crmDeliveries, documents: crmDocumentRuntime })
  const crmIntegrationStore = createCrmIntegrationStore()
  const crmIntakeReadStore = createDbCrmIntakeReadStore()
  setGlobalMailboxContactImportDeps({ crm: crmStore })
  const workspaceFilesStore = createDbWorkspaceFilesStore()
  const workspaceFileUploadsStore = createWorkspaceFileUploadsStore()
  // `syncNativeSlashCommands` is late-bound: see BootLate (boot/late.ts).
  const nativeSlashSyncTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const scheduleNativeSlashCommandSync = (userId: string | undefined, workspaceId: string) => {
    if (!userId || !late.syncNativeSlashCommands) return
    const existing = nativeSlashSyncTimers.get(workspaceId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      nativeSlashSyncTimers.delete(workspaceId)
      void late.syncNativeSlashCommands?.(userId, workspaceId).catch((err) =>
        console.warn('[channels] native command sync failed:', err))
    }, 250)
    timer.unref?.()
    nativeSlashSyncTimers.set(workspaceId, timer)
  }
  const workflowStore = createDbWorkflowStore({
    resolveAuthoringPrimary: (workspaceId, client) => resolvePrimaryAssistantForWorkspace(workspaceId, undefined, (sql, values) => client.query(sql, values)),
    onChanged: (userId, workspaceId) => scheduleNativeSlashCommandSync(userId, workspaceId),
  })
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
  const internalLinkAliasStore = createDbInternalLinkAliasStore()
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

  const sessionStateStore = createDbSessionStateStore()
  const planStore = createDbPlanStore()
  const cacheStore = createDbCacheStore()
  const fileStore = createDbFileStore()
  const usageStore = ports.usageStore
  const analyticsStore = createDbAnalyticsStore()
  const analytics = new AnalyticsLogger(analyticsStore)

  return {
    analytics, goalStore, deliverGoalTerminal, crmDeliveries, campaignEmailService, crmDocumentRuntime,
    crmStore, resolvePrimaryAssistantForWorkspace, scheduleNativeSlashCommandSync, entityLinksStore,
    entitiesStore, analyticsStore, usageStore, workflowStore, episodesStore, internalLinkAliasStore,
    savedViewStore, cacheStore, fileStore, workspaceFilesStore, campaignDispatchService, memoryStore,
    taskStore, workflowRunStore, pageTemplateStore, blueprintRecordStore, pendingApprovalsStore,
    sessionStateStore, retrievalStore, episodicStore, crmIntakeReadStore, brainCandidateStore,
    crmOperationsService, crmIntegrationStore, crmEmailDraftStore, workspaceFileUploadsStore, planStore,
    connectorActionStore, memoryRecallEventsStore, pageGrantStore, pageDomainStore, domainProvisioner,
    workspaceGroupStore, docEntityStore, docThemesStore, homeDockStore,
  } as const
}
