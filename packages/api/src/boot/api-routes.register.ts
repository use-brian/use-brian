/**
 * Self-authenticating public mounts, then the authenticated /api routers.
 *
 * Boot register module registerApiRoutes: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`ApiRoutesScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { getWorkspaceInboxRetentionDays } from '../db/workspace-store.js'
import { resolveWorkspaceViewpoint } from '../db/workspace-viewpoint.js'
import { OFFICIAL_CONNECTOR_TOOLS } from '@use-brian/shared'
import { getWorkspacePrimaryAssistant } from '../db/users.js'
import { captureAuthoringAuthoritySystem } from '../context-scope/workflow-authority.js'
import { tryResolveLiveToolApproval } from '../routes/chat.js'
import { backgroundModelFor } from '../model-resolution.js'
import { getCrmEmailReviewContext } from '../db/crm-r2.js'
import { isWorkspaceMember } from '../db/home-store.js'
import { startBrainStreamFanout } from '../brain-stream/sse-fanout.js'
import { subscribeGoalActivity } from '../goals/activity-bus.js'
import { requireAuth } from '../auth/middleware.js'
import { listUsableWorkspaceConnectors } from '../connectors/usable-connectors.js'
import { setRoutineConfigurationPreflight, RoutineConfigurationError } from '../tasks/routine-proposals.js'
import { assertRoutineRuntimeReady } from '../tasks/routine-preflight.js'
import {
  workflowsRoutes, preflightWorkflowDefinition, createValidatedDefinitionEditor,
} from '../routes/workflows.js'
import { createTeamspaceStore } from '../db/teamspace-store.js'
import { deriveOwnApexBlocks, deriveReservedSubdomainLabels } from '@use-brian/shared/page-slugs'
import { internalIngestRoutes } from '../doc/internal-ingest-route.js'
import { internalPageEventRoutes } from '../doc/internal-page-event-route.js'
import { publishPageLifecycle } from '../page-event-fanout.js'
import { createWorkspaceSearchService } from '../workspace-search/service.js'
import { readSearchItem, createSearchAdapters } from '../workspace-search/adapters.js'
import { createDbDocPageStore } from '../db/doc-page-store.js'
import { createDbCommentThreadStore } from '../db/comment-thread-store.js'
import { createDbDocNotificationsStore } from '../db/doc-notifications-store.js'
import { authorizeBrainRowMutation } from '../db/brain-inbox-store.js'
import { createSoftDeleteStore } from '../db/soft-delete-store.js'
import { lazyRoutes } from './lazy.js'
import type { ApiRoutesScope } from './scope.js'

// Router modules that load on their mount's first request (deployment.md ->
// "Boot composition" -> "Lazy routers and workers"); the mounts below are unchanged.
const codexProviderRoutes = lazyRoutes(() => import('../routes/codex-provider.js'), 'codexProviderRoutes')
const crmIntakeRoutes = lazyRoutes(() => import('../routes/crm-intake.js'), 'crmIntakeRoutes')
const brainStreamRoutes = lazyRoutes(() => import('../routes/brain-stream.js'), 'brainStreamRoutes')
const taskExecutionRoutes = lazyRoutes(() => import('../routes/task-execution.js'), 'taskExecutionRoutes')
const researchRoutes = lazyRoutes(() => import('../routes/research.js'), 'researchRoutes')
const approvalReviewRoutes = lazyRoutes(() => import('../routes/approval-review.js'), 'approvalReviewRoutes')
const goalsRoutes = lazyRoutes(() => import('../routes/goals.js'), 'goalsRoutes')
const goalDefaultBudgetRoutes = lazyRoutes(() => import('../routes/goal-default-budget.js'), 'goalDefaultBudgetRoutes')
const workflowApprovalsRoutes = lazyRoutes(() => import('../routes/workflow-approvals.js'), 'workflowApprovalsRoutes')
const approvalsRoutes = lazyRoutes(() => import('../routes/approvals.js'), 'approvalsRoutes')
const liveWorkRoutes = lazyRoutes(() => import('../routes/live-work.js'), 'liveWorkRoutes')
const modelMenuRoutes = lazyRoutes(() => import('../routes/model-menu.js'), 'modelMenuRoutes')
const pageActionsRoutes = lazyRoutes(() => import('../routes/page-actions.js'), 'pageActionsRoutes')
const workflowWebhookRoutes = lazyRoutes(() => import('../routes/workflow-webhooks.js'), 'workflowWebhookRoutes')
const viewsRoutes = lazyRoutes(() => import('../routes/views.js'), 'viewsRoutes')
const teamspacesRoutes = lazyRoutes(() => import('../routes/teamspaces.js'), 'teamspacesRoutes')
const contextScopeRoutes = lazyRoutes(() => import('../routes/context-scopes.js'), 'contextScopeRoutes')
const workspaceAccessRoutes = lazyRoutes(() => import('../routes/workspace-access.js'), 'workspaceAccessRoutes')
const departmentRoutes = lazyRoutes(() => import('../routes/departments.js'), 'departmentRoutes')
const briefRoutes = lazyRoutes(() => import('../routes/briefs.js'), 'briefRoutes')
const workRoutes = lazyRoutes(() => import('../routes/work.js'), 'workRoutes')
const docThemesRoutes = lazyRoutes(() => import('../routes/doc-themes.js'), 'docThemesRoutes')
const workspaceSearchRoutes = lazyRoutes(() => import('../routes/workspace-search.js'), 'workspaceSearchRoutes')
const internalLinkRoutes = lazyRoutes(() => import('../routes/internal-links.js'), 'internalLinkRoutes')
const docEntitiesRoutes = lazyRoutes(() => import('../routes/doc-entities.js'), 'docEntitiesRoutes')
const commentRoutes = lazyRoutes(() => import('../routes/comments.js'), 'commentRoutes')
const inboxRoutes = lazyRoutes(() => import('../routes/inbox.js'), 'inboxRoutes')
const generateSynthesisRoutes = lazyRoutes(() => import('../routes/generate-synthesis.js'), 'generateSynthesisRoutes')

export function registerApiRoutes(scope: ApiRoutesScope) {
  const {
    ports, env, app, configuredProviders, provider, analytics, integrationStore, goalStore, crmStore,
    resolvePrimaryAssistantForWorkspace, codexProviderManager, workspaceDecisionRoutingStore,
    decisionEvaluationProfileStore, decisionRuntime, operatorDecisionDefault, connectorInstanceStore,
    workflowStore, customLlmEndpointStore, connectorGrantStore, workspaceStore, savedViewStore,
    workspaceAuditStore, backgroundModel, jobStore, resolveBackgroundRuntime, filesResolver, taskStore,
    workflowRunStore, workspaceDirectoryStore, pageTemplateStore, blueprintRecordStore, generateSynthesize,
    pendingApprovalsStore, workflowExecutorDeps, approvalBridgeDeps, goalDefaultBudgetStore,
    crmIntakeReadStore, workflowDependencyPreflight, goalDriver, goalClarityAssessor,
    createCompletionWorkflow, executionControlEffects, internalLinkService, crmOperationsService,
    filesBlobClient, agentToolset, meteredProfileStore, ingestPageRunner, sessionResumeStore,
    workspaceMcpProfile, pageGrantStore, pageDomainStore, modelDefaultsStore, pageActionsStore,
    domainProvisioner, workspaceGroupStore, docEntityStore, docThemesStore, late,
  } = scope
  // PUBLIC + self-authenticating `sk_intake_*` route. It must stay before the
  // bare `/api` JWT guards below and has its own 1 MiB parser because the
  // global 15 MiB parser deliberately skips this exact path.
  app.use('/api', crmIntakeRoutes({
    service: crmOperationsService,
    readStore: crmIntakeReadStore,
  }))

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

  app.use('/api', requireAuth(env.JWT_SECRET), workspaceAccessRoutes())
  app.use('/api', requireAuth(env.JWT_SECRET), departmentRoutes())
  app.use('/api', requireAuth(env.JWT_SECRET), contextScopeRoutes({
    workspaceStore,
    connectorInstanceStore,
    connectorGrantStore,
  }))
  // Governed Project and Department Briefs (project-briefs.md).
  app.use('/api', requireAuth(env.JWT_SECRET), briefRoutes())
  app.use('/api', workRoutes({ taskStore, auth: requireAuth(env.JWT_SECRET) }))
  app.use('/api', taskExecutionRoutes({ auth: requireAuth(env.JWT_SECRET), effects: executionControlEffects }))
  // Saved research: activities, follow-up corrections, lessons, improvements (features/research.md).
  app.use('/api', researchRoutes({ auth: requireAuth(env.JWT_SECRET) }))
  // Explicitly delegated approval review (features/approval-review.md).
  app.use('/api', approvalReviewRoutes({ auth: requireAuth(env.JWT_SECRET) }))

  app.use('/api', requireAuth(env.JWT_SECRET), workflowApprovalsRoutes({
    approvalsStore: pendingApprovalsStore,
    workspaceStore,
    bridgeDeps: approvalBridgeDeps,
  }))

  app.use('/api/approvals', requireAuth(env.JWT_SECRET), approvalsRoutes({
    workspaceMcpReview: workspaceMcpProfile.respondToApproval,
    approvalsStore: pendingApprovalsStore,
    workspaceStore,
    bridgeDeps: approvalBridgeDeps,
    emailReviewContext: async (input) => {
      const ctx = await resolveWorkspaceViewpoint(input.userId, input.workspaceId, null)
      if (!ctx) return null
      return getCrmEmailReviewContext({
        ctx,
        entityId: input.entityId,
        recipient: input.recipient,
        replyTo: input.replyTo,
        toolName: input.toolName,
        account: input.account,
      })
    },
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
    pdfSignaturePreview: async (input) => late.pdfSessionToolRuntime?.previewSignature(input) ?? null,
  }))

  // Workspace default budget API must mount before the generic `/:id` goal
  // routes so "default-budget" is never interpreted as a goal id.
  app.use(
    '/api/goals/default-budget',
    requireAuth(env.JWT_SECRET),
    goalDefaultBudgetRoutes({ workspaceStore, store: goalDefaultBudgetStore }),
  )

  // Goals board + acting-goal controls.
  app.use(
    '/api/goals',
    requireAuth(env.JWT_SECRET),
    goalsRoutes({
      goalStore,
      workspaceStore,
      createCompletionWorkflow,
      kickoffGoal: goalDriver.kickoffGoal,
      subscribeActivity: subscribeGoalActivity,
      assessClarity: goalClarityAssessor,
      resolveAssistantId: async (userId, workspaceId) =>
        (await getWorkspacePrimaryAssistant(userId, workspaceId))?.id,
      resolveAuthoringAuthority: async ({ userId,goal }) => {
        const assistantId = await workflowExecutorDeps.resolvePrimary(goal.workspaceId)
        if (!assistantId) throw new Error('goal_authority_unavailable')
        return captureAuthoringAuthoritySystem({
          userId,
          workspaceId:goal.workspaceId,
          assistantId,
          contextGroupId:goal.contextGroupId,
          contextProjectId:goal.contextProjectId,
        })
      },
    }),
  )

  // Model selection surfaces (model-registry.md L10): per-class menus,
  // metered profiles CRUD, pre-flight estimates. Authed; membership-gated
  // per workspace inside the router.
  app.use('/api', requireAuth(env.JWT_SECRET), modelMenuRoutes({
    workspaceStore,
    meteredProfileStore,
    modelDefaultsStore,
    customLlmEndpointStore,
    decisionRoutingStore: workspaceDecisionRoutingStore,
    decisionEvaluationProfileStore,
    configuredDecisionAdapters: new Set(decisionRuntime.configuredAdapterIds()),
    operatorDecisionDefault,
    configuredProviders,
    estimateMeteredTurn: ports.meteredBilling?.estimateMeteredTurn,
  }))
  if (codexProviderManager) {
    app.use(
      '/api/local/codex',
      requireAuth(env.JWT_SECRET),
      codexProviderRoutes(codexProviderManager),
    )
  }

  const workflowsRouteOptions: Parameters<typeof workflowsRoutes>[0] = {
    workflowStore,
    runStore: workflowRunStore,
    workspaceStore,
    executorDeps: workflowExecutorDeps,
    listCrmWorkflowEventFilterKeys: async (workspaceId) =>
      (await crmIntakeReadStore.listCrmEventFilterCatalog(workspaceId)).stableKeys.map((item) => item.key),
    savedViewStore,
    listTriggerJobs: (workflowId) => jobStore.listFiringJobsForWorkflowSystem(workflowId),
    jobStore,
    resolvePrimary: workflowExecutorDeps.resolvePrimary,
    resolveAuthoringAuthority: async (params, captureInTransaction) => {
      if (captureInTransaction) return captureInTransaction()
      const assistantId = await workflowExecutorDeps.resolvePrimary(params.workspaceId)
      if (!assistantId) throw new Error('workflow_authority_unavailable')
      return captureAuthoringAuthoritySystem({ ...params, assistantId })
    },
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
  }
  setRoutineConfigurationPreflight(async ({userId,workspaceId,configuration,sourceEvidence})=>{
    const issues=await preflightWorkflowDefinition(configuration.definition,{userId,workspaceId},workflowsRouteOptions)
    if (issues.length) throw new RoutineConfigurationError('routine_dependencies_unavailable')
    await assertRoutineRuntimeReady({userId,workspaceId,configuration,sourceEvidence},{
      buildRegistry:params=>workflowExecutorDeps.buildToolRegistry(params),
      usableAccounts:async registry=>new Set((await listUsableWorkspaceConnectors({connectorInstanceStore,connectorGrantStore,userId,workspaceId}))
        .filter(u=>(OFFICIAL_CONNECTOR_TOOLS[u.instance.provider] ?? []).some(t=>registry.has(t.name))).map(u=>u.instance.provider)),
    })
  })
  app.use('/api', requireAuth(env.JWT_SECRET), workflowsRoutes(workflowsRouteOptions))

  // Live — the all-activity roster (docs/architecture/features/live-work.md
  // §3): sessions + workflow runs, tiered server-side per caller. Read-only.
  app.use('/api', requireAuth(env.JWT_SECRET), liveWorkRoutes())
  // Resolves the late-bound editor the skill-approvals mount above wraps —
  // refinement applies + attach-offer writes now share the builder's exact
  // validation bar (schema, page anchors, dependency preflight).
  late.applyWorkflowDefinitionEdit = createValidatedDefinitionEditor(workflowsRouteOptions)

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
    resolveGoalAuthoringAuthority: async ({ userId,workspaceId }) => {
      const assistantId = await workflowExecutorDeps.resolvePrimary(workspaceId)
      if (!assistantId) throw new Error('goal_authority_unavailable')
      return captureAuthoringAuthoritySystem({ userId,workspaceId,assistantId })
    },
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
    // Actor-authorized: a data-view row delete is the viewer's own mutation.
    softDeleteStore: createSoftDeleteStore({ authorize: authorizeBrainRowMutation }),
    provider,
    resolveBackgroundRuntime,
    get backgroundModel() { return backgroundModelFor(configuredProviders) },
    docPageStore: createDbDocPageStore(),
    jobStore,
    docEntityStore,
    // Manual "Sync to brain" — the runner runs in the background. Absent when
    // Pipeline B isn't wired (the route then 503s).
    ingestPage: ingestPageRunner
      ? ({ userId, pageId }) => ingestPageRunner({ userId, pageId })
      : undefined,
  }))
  app.use('/api', requireAuth(env.JWT_SECRET), internalLinkRoutes(internalLinkService))
  app.use('/api', requireAuth(env.JWT_SECRET), workspaceSearchRoutes({
    isMember: isWorkspaceMember,
    readItem: readSearchItem,
    search: createWorkspaceSearchService(createSearchAdapters(), { key: Buffer.from(env.JWT_SECRET) }),
  }))

  // Standalone Generate from Brain is open in both editions. Hosted injects
  // quote/gate/charge billing policy; OSS confirms the long-lived run but is
  // unmetered because the operator pays the configured model provider directly.
  app.use(
    '/api/workspaces/:workspaceId/blueprints',
    requireAuth(env.JWT_SECRET),
    generateSynthesisRoutes({
      getRole: (userId, workspaceId) => workspaceStore.getRole(userId, workspaceId),
      generateSynthesize,
      resolvePrimaryAssistantForWorkspace,
      pageTemplateStore,
      contextOnly: ports.memoryAllowance?.contextOnly,
      checkCreditBudget: ports.generateBilling ? ports.checkCreditBudget : undefined,
      billing: ports.generateBilling,
    }),
  )

  // Teamspaces (migration 313) — Notion-style page containers above the doc
  // page tree. Visibility rides RLS; sensitivity gates live in the routes.
  // See docs/architecture/features/teamspaces.md.
  app.use('/api', requireAuth(env.JWT_SECRET), teamspacesRoutes({
    teamspaceStore: createTeamspaceStore(),
    workspaceGroupStore,
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

  app.use('/api', requireAuth(env.JWT_SECRET), docThemesRoutes({
    blobClient: filesBlobClient ?? undefined,
    filesResolver: filesResolver ?? undefined,
    docThemesStore,
    workspaceStore,
    provider,
    backgroundModel,
    resolveBackgroundRuntime,
  }))

  const commentThreadStore = createDbCommentThreadStore()
  const docNotificationsStore = createDbDocNotificationsStore()
  app.use('/api', requireAuth(env.JWT_SECRET), commentRoutes({ commentThreadStore }))
  app.use(
    '/api',
    requireAuth(env.JWT_SECRET),
    inboxRoutes({
      commentThreadStore,
      docNotificationsStore,
      getInboxRetentionDays: getWorkspaceInboxRetentionDays,
    }),
  )
}
