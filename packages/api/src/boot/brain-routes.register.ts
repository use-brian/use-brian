/**
 * Brain, CRM, home, handles, memory and knowledge routes.
 *
 * Boot register module registerBrainRoutes: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`BrainRoutesScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { captureAuthoringAuthoritySystem } from '../context-scope/workflow-authority.js'
import { BACKGROUND_MODEL } from '../model-resolution.js'
import { assembleHomeSignals } from '../home/signals.js'
import { runHomeRefresh } from '../home/refresh.js'
import { isWorkspaceMember } from '../db/home-store.js'
import { requireAuth } from '../auth/middleware.js'
import { createWorkspaceModulesStore } from '../db/workspace-modules-store.js'
import { createMemoryExportObserver } from '../memory-bulk-export.js'
import { lazyRoutes } from './lazy.js'
import type { BrainRoutesScope } from './scope.js'

// Router modules that load on their mount's first request (deployment.md ->
// "Boot composition" -> "Lazy routers and workers"); the mounts below are unchanged.
const brainRoutes = lazyRoutes(() => import('../routes/brain.js'), 'brainRoutes')
const brainInboxRoutes = lazyRoutes(() => import('../routes/brain-inbox.js'), 'brainInboxRoutes')
const crmRoutes = lazyRoutes(() => import('../routes/crm.js'), 'crmRoutes')
const crmOperationsRoutes = lazyRoutes(() => import('../routes/crm-operations.js'), 'crmOperationsRoutes')
const taskGuardrailRoutes = lazyRoutes(() => import('../routes/task-guardrails.js'), 'taskGuardrailRoutes')
const homeRoutes = lazyRoutes(() => import('../routes/home.js'), 'homeRoutes')
const homeDockRoutes = lazyRoutes(() => import('../routes/home-dock.js'), 'homeDockRoutes')
const memoryRoutes = lazyRoutes(() => import('../routes/memories.js'), 'memoryRoutes')
const knowledgeRoutes = lazyRoutes(() => import('../routes/knowledge.js'), 'knowledgeRoutes')
const workspaceKnowledgeRoutes = lazyRoutes(() => import('../routes/knowledge.js'), 'workspaceKnowledgeRoutes')
const brandRoutes = lazyRoutes(() => import('../routes/brand.js'), 'brandRoutes')
const handleRoutes = lazyRoutes(() => import('../routes/handles.js'), 'handleRoutes')
const chatLinkRoutes = lazyRoutes(() => import('../routes/chat-links.js'), 'chatLinkRoutes')
const workspaceModuleRoutes = lazyRoutes(() => import('../routes/workspace-modules.js'), 'workspaceModuleRoutes')
const crmIntegrationCredentialRoutes = lazyRoutes(() => import('../routes/crm-integration.js'), 'crmIntegrationCredentialRoutes')

export function registerBrainRoutes(scope: BrainRoutesScope) {
  const {
    ports, env, app, provider, crmDeliveries, resolvePrimaryAssistantForWorkspace, entityLinksStore,
    entitiesStore, connectorInstanceStore, workspaceSkillStore, workspaceSkillFilesStore, workflowStore,
    connectorGrantStore, workspaceStore, savedViewStore, knowledgeStore, syncCredentials, jobStore,
    resolveBackgroundRuntime, filesApi, retrievalStore, knowledgeRepoWriter, crmIntakeReadStore,
    entityKindClassifier, crmOperationsService, crmIntegrationStore, crmEmailDraftStore,
    knowledgeCaptureRuleStore, brainEntryMutator, crmProductionImports, workspaceRouter, chatLinkStore,
    homeDockStore, kbMaintenanceStore, late,
  } = scope
  // (The public /api/brain/stream SSE mount lives ABOVE the bare `/api`
  // requireAuth guards — see the block next to workflowWebhookRoutes.)
  app.use('/api/brain', requireAuth(env.JWT_SECRET), brainRoutes({
    entitiesStore, entityLinksStore, retrievalStore, knowledgeStore, workspaceSkillStore, workspaceSkillFilesStore, connectorInstanceStore,
    bulkMemoryExport: ports.bulkMemoryExport,
    observeMemoryExport: ports.bulkMemoryExport ? createMemoryExportObserver(scope.analytics) : undefined,
    memoryContextTelemetry: ports.observeMemoryContextCopy ? { secret: env.JWT_SECRET, observe: ports.observeMemoryContextCopy } : undefined,
  }))
  app.use('/api/crm', requireAuth(env.JWT_SECRET), crmRoutes({
    workspaceStore,
    entityLinks: entityLinksStore,
    emailDraftStore: crmEmailDraftStore,
    crmOperationsService,
  }))
  app.use('/api/workspaces', requireAuth(env.JWT_SECRET), workspaceModuleRoutes({
    workspaceStore, modules: createWorkspaceModulesStore(),
  }))
  app.use('/api/crm', requireAuth(env.JWT_SECRET), crmIntegrationCredentialRoutes({ workspaceStore, credentials: crmIntegrationStore }))
  app.use('/api/crm', requireAuth(env.JWT_SECRET), crmOperationsRoutes({
    deliveries: crmDeliveries,
    workspaceStore,
    service: crmOperationsService,
    readStore: crmIntakeReadStore,
    importService: crmProductionImports,
  }))
  // Brain inbox (verification surface). Open + hosted share this one mount: the
  // route's deps are all open (brain-inbox-store / entities-store / crm / sessions /
  // notify). `entityKindClassifier` is boot's own; `pendingClassificationStore` is
  // an optional closed port (undefined in OSS → classify/pending endpoints no-op).
  app.use('/api/brain-inbox', requireAuth(env.JWT_SECRET), brainInboxRoutes({
    workspaceStore,
    entityKindClassifier,
    pendingClassificationStore: ports.pendingClassificationStore,
    filesApi,
    entityLinks: entityLinksStore,
    workspaceSkillStore,
    brainEntryMutator,
  }))
  // Task guardrails — rules, the suggestions tray, and the rejection log.
  // Authenticated, so it mounts here without tripping the public-route
  // ordering trap. Spec: docs/architecture/features/task-guardrails.md
  app.use('/api/task-guardrails', requireAuth(env.JWT_SECRET), taskGuardrailRoutes({
    workspaceStore,
  }))
  app.use('/api/home', requireAuth(env.JWT_SECRET), homeRoutes())
  app.use('/api/home-dock', requireAuth(env.JWT_SECRET), homeDockRoutes({
    homeDockStore,
    isWorkspaceMember,
    assembleSignals: (userId, workspaceId) =>
      assembleHomeSignals(userId, workspaceId, { workflowStore, savedViewStore }),
    refresh: async (userId, workspaceId) => {
      const signals = await assembleHomeSignals(userId, workspaceId, { workflowStore, savedViewStore })
      const assistantId = await resolvePrimaryAssistantForWorkspace(workspaceId)
      const runtime = await resolveBackgroundRuntime(workspaceId)
      await runHomeRefresh({
        userId,
        workspaceId,
        assistantId,
        provider: runtime?.provider ?? provider,
        model: runtime?.selector ?? BACKGROUND_MODEL,
        homeDockStore,
        signals,
      })
    },
  }))

  app.use('/api/teams', requireAuth(env.JWT_SECRET), workspaceRouter) // legacy

  app.use('/api/handles', requireAuth(env.JWT_SECRET), handleRoutes())
  app.use('/api/assistants/:assistantId/chat-links', requireAuth(env.JWT_SECRET), chatLinkRoutes({ chatLinkStore }))

  app.use('/api/assistants/:assistantId/memories', requireAuth(env.JWT_SECRET), memoryRoutes())

  app.use('/api/assistants/:assistantId/knowledge', requireAuth(env.JWT_SECRET), knowledgeRoutes({
    knowledgeStore,
    connectorInstanceStore,
    connectorGrantStore,
    triggerSync: async () => { if (late.syncWorkerRef) await late.syncWorkerRef.tick() },
  }))

  // workspace-scoped knowledge route resolves edit-proposal PATs through the
  // same `syncCredentials` resolver the sync worker uses.
  // Brand primitive — one open router mounted here so both editions serve it
  // (never on the forked /api/connectors pair; see routes/brand.ts).
  app.use('/api/workspaces/:workspaceId/brand', requireAuth(env.JWT_SECRET), brandRoutes())

  app.use('/api/workspaces/:workspaceId/knowledge', requireAuth(env.JWT_SECRET), workspaceKnowledgeRoutes({
    knowledgeStore,
    knowledgeCaptureRuleStore,
    allowLocalSources: env.LOCAL_FILESYSTEM_SOURCES_ENABLED === true,
    connectorInstanceStore,
    connectorGrantStore,
    syncCredentials,
    knowledgeRepoWriter,
    triggerSync: async () => { if (late.syncWorkerRef) await late.syncWorkerRef.tick() },
    // Self-maintain agents (mig 411): config store + the workflow store the
    // materialized workflow writes through + schedule reconciliation deps.
    kbMaintenanceStore,
    workflowStore,
    jobStore,
    resolvePrimary: resolvePrimaryAssistantForWorkspace,
    resolveAuthoringAuthority: async ({ userId,workspaceId }) => {
      const assistantId = await resolvePrimaryAssistantForWorkspace(workspaceId)
      if (!assistantId) throw new Error('workflow_authority_unavailable')
      return captureAuthoringAuthoritySystem({ userId,workspaceId,assistantId })
    },
  }))
}
