/**
 * Shopify, CRM integration, brain MCP, engines MCP, OAuth and application routes.
 *
 * Boot register module registerIntegrationRoutes: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`IntegrationRoutesScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { pinAccessCeiling } from '@use-brian/agent-runtime/security/access-ceiling.js'
import { type Sensitivity, minSensitivity } from '@use-brian/agent-runtime/security/sensitivity.js'
import type { EnginesEnv } from '@use-brian/core/engines/ask-engines.js'
import { ctxFor as workspaceFilesCtxFor } from '@use-brian/core/workspace-files/tool-helpers.js'
import { ApplicationPlatformService } from '../application-platform/service.js'
import { createCanonicalNativeApplicationModule } from '../application-platform/native-adapters.js'
import { createCanonicalGenericApplicationModule } from '../application-platform/generic-adapter.js'
import { buildHomeApplicationMcpProfile } from '../application-platform/mcp.js'
import { ApplicationManagementService } from '../application-platform/management.js'
import { connectorActorMetadataRoutes } from '../application-platform/connector-actor-metadata.js'
import { findAssistantById } from '../db/users.js'
import { createMemoryExportObserver } from '../memory-bulk-export.js'
import { resolveTurnScopeSystem } from '../context-scope/resolve-turn-scope.js'
import { createCrmOperationsService } from '../crm-operations/service.js'
import { createCrmProductionImportService } from '../crm-operations/import-service.js'
import { createCrmImportSources } from '../db/crm-import-sources.js'
import { createDbCrmOperationsStore } from '../db/crm-operations-store.js'
import { getHomeApp, consumeHomeAppBudget } from '../db/home-apps-store.js'
import { requireAuth } from '../auth/middleware.js'
import { createStoreToolResolver } from '../home-apps/store-tools-resolver.js'
import { agentAllowedToolsFor } from '../brain-mcp/store-tools.js'
import type { AppStoreScope } from '@use-brian/brian-app'
import { resolveWriteTarget } from '../brain-mcp/tools.js'
import { enginesMcpEnabled, enginesMcpRoutes } from '../engines-mcp/server.js'
import { createDbOAuthAuthorizationStore } from '../db/oauth-authorization-store.js'
import { oauthMetadataRoutes, oauthRoutes } from '../brain-mcp/oauth/index.js'
import { getPool } from '../db/client.js'
import { lazyRoutes } from './lazy.js'
import type { IntegrationRoutesScope } from './scope.js'

// Router modules that load on their mount's first request (deployment.md ->
// "Boot composition" -> "Lazy routers and workers"); the mounts below are unchanged.
const externalServicesRoutes = lazyRoutes(() => import('../routes/external-services.js'), 'externalServicesRoutes')
const applicationPlatformRoutes = lazyRoutes(() => import('../routes/application-platform.js'), 'applicationPlatformRoutes')
const learnJapaneseRoutes = lazyRoutes(() => import('../routes/learn-japanese.js'), 'learnJapaneseRoutes')
const brainMcpRoutes = lazyRoutes(() => import('../brain-mcp/server.js'), 'brainMcpRoutes')
const crmIntegrationRoutes = lazyRoutes(() => import('../routes/crm-integration.js'), 'crmIntegrationRoutes')
const appsShopifyRoutes = lazyRoutes(() => import('../routes/apps-shopify.js'), 'appsShopifyRoutes')

export function registerIntegrationRoutes(scope: IntegrationRoutesScope) {
  const {
    opts, env, app, externalCredentialPool, managedEngineProviders, crmDeliveries, entityLinksStore,
    sharedEmbedder, connectorInstanceStore, connectorGrantStore, workspaceStore, savedViewStore,
    mcpSettingsStore, brainEpisodeIngestor, pageTemplateStore, filesApi, connectorStore,
    assistantConnectorStore, workspaceToolPolicyStore, assistantConnectorGrantsStore, calleeExecutor,
    taskTools, brandTools, taskExecutionTools, externalProgressTools, researchTools, approvalReviewTools,
    crmOperationsService, crmTools, crmOperationsTools, crmBusinessReferenceTools, crmCommercialContextTools,
    crmCommercialDocumentTools, crmDeliveryOversightTools, crmGovernedRecordTools, crmIntegrationStore,
    crmCredentialTools, engineeringHistory, docPageStore, brainFileTools, browserSkillsStore, brainKeyStore,
    agentToolset, brainMemoryTools, brainRetrievalTools, workspaceMcpProfile, oauthAuthorizationStore,
    docGateway, programmaticCapture, captureConfiguration, oauthClientStore,
  } = scope
  // ── Shopify store access, shared by BOTH surfaces that have it ──────────
  //
  // ONE resolver instance, deliberately. The sandboxed Home-app bridge
  // (brain-MCP, `authKind: 'home_app'`) and the built-in Shopify app's route
  // (`/api/apps/shopify`) must reach exactly the same tools under the same
  // four filters — workspace exposure ∩ connector action grants ∩ tier ∩ NOT
  // destructive. Constructing a second resolver beside this one would compile,
  // pass every test, and drift the day someone changes one call site's deps.
  //
  // Bound to the workspace primary assistant, so its connector action grants
  // apply before the caller's own tier narrows further.
  const shopifyStoreTools = createStoreToolResolver({
    connectorStore,
    settingsStore: mcpSettingsStore,
    assistantConnectorStore,
    assistantConnectorGrantsStore,
    // The three below are load-bearing together with the resolver's
    // `assistantTeamId`. That field suppresses the owner-personal base load
    // (the connector boundary); THESE are the overlays that put the
    // workspace's own connectors back. Passing the boundary without the
    // overlays fails closed but renders the feature permanently inert — a
    // caller with store scope would see zero tools forever, with nothing in
    // the UI explaining why.
    connectorGrantStore,
    connectorInstanceStore,
    workspaceToolPolicyStore,
  })

  // The assistant consult, capped at the CALLER's own tool ceiling via
  // `allowedTools`, so the model can reason and chain calls but cannot reach
  // anything the direct tool gate refused. Without that cap this is a ladder
  // around every rule in `store-tools.ts`, destructive tools included.
  const askShopifyAssistant = async (params: {
    workspaceId: string
    storeScope: AppStoreScope
    task: string
    callerSessionId: string
    userId: string
    maxClearance?: Sensitivity | null
  }): Promise<string> => {
    const target = await resolveWriteTarget(params.workspaceId)
    if (!target) throw new Error('This workspace has no assistant to ask.')
    const assistant = await findAssistantById(target.assistantId)
    if (!assistant) throw new Error('This workspace has no assistant to ask.')
    const scope = await resolveTurnScopeSystem({
      userId: params.userId, assistant, workspaceId: params.workspaceId,
    })
    const ceiling = pinAccessCeiling(scope.access)
    if (params.maxClearance != null) {
      ceiling.clearance = minSensitivity(ceiling.clearance, params.maxClearance)
    }
    return calleeExecutor({
      callerAssistantId: target.assistantId,
      callerUserId: params.userId,
      callerAccessCeiling: ceiling,
      calleeAssistantId: target.assistantId,
      question: params.task,
      callerSessionId: params.callerSessionId,
      allowedTools: agentAllowedToolsFor('shopify', params.storeScope),
    })
  }

  // The built-in Shopify app's data path. Per-route `requireAuth` (never a bare
  // `app.use('/api', requireAuth, …)`, which would 401 later-registered public
  // routes — see CLAUDE.md → route mount order).
  app.use('/api/apps/shopify', appsShopifyRoutes({
    requireAuth: requireAuth(env.JWT_SECRET),
    storeTools: shopifyStoreTools,
    askAssistant: ({ workspaceId, storeScope, task, userId }) =>
      askShopifyAssistant({ workspaceId, storeScope, task, userId, callerSessionId: 'app:shopify' }),
  }))

  const crmImportSources = createCrmImportSources()
  const crmProductionImports = createCrmProductionImportService({
    filesApi: filesApi ?? undefined, sources: crmImportSources,
    operationsForTransaction: (client) => createCrmOperationsService(createDbCrmOperationsStore(getPool(), client)),
    entityLinks: entityLinksStore,
  })
  app.use('/api/crm/integration', crmIntegrationRoutes({
    deliveries: crmDeliveries,
    credentials: crmIntegrationStore, service: crmOperationsService,
    imports: crmProductionImports, importSources: crmImportSources,
  }))

  app.use('/api/brain/mcp', brainMcpRoutes({
    resourceMetadataUrl: new URL('/.well-known/oauth-protected-resource', env.API_URL).href,
    memoryAllowance: scope.ports.memoryAllowance,
    bulkMemoryExport: scope.ports.bulkMemoryExport ? {
      entitled: scope.ports.bulkMemoryExport,
      observe: createMemoryExportObserver(scope.analytics),
      appOrigin: env.AUTHED_APP_URL ?? env.APP_URL,
      workspaceStore,
    } : undefined,
    workspaceProfile: workspaceMcpProfile,
    brainKeyStore,
    authorizationStore: oauthAuthorizationStore,
    // Custom Home app bridge. Without this the bridge-token path in
    // `authenticateBrainRequest` is skipped and every custom app 401s — the
    // documented `ub:token` → `POST /api/brain/mcp` sample simply could not
    // work. `getApp` reads the live row so a revoked grant takes effect on the
    // next call, and the budget charge matches the KV endpoints.
    ...(env.JWT_SECRET
      ? {
          homeApps: {
            secret: env.JWT_SECRET,
            getApp: async (appId: string) => {
              const row = await getHomeApp(appId)
              if (!row) return null
              return {
                id: row.id,
                workspaceId: row.workspaceId,
                status: row.status,
                grantedScopes: row.grantedScopes
                  ? {
                      data: row.grantedScopes.data,
                      store: row.grantedScopes.store,
                      agent: row.grantedScopes.agent,
                    }
                  : null,
                maxClearance: row.maxClearance,
              }
            },
            consumeBudget: async (appId: string) => consumeHomeAppBudget(appId),
            applicationProfile: req => buildHomeApplicationMcpProfile(req, env.JWT_SECRET, applicationService),
          },
        }
      : {}),
    memoryTools: brainMemoryTools,
    taskTools,
    taskExecutionTools: { ...taskExecutionTools, ...externalProgressTools },
    researchTools,
    approvalReviewTools,
    crmTools: { ...crmTools, ...crmOperationsTools, ...crmBusinessReferenceTools, ...crmCommercialContextTools, ...crmCommercialDocumentTools, ...crmGovernedRecordTools, ...crmDeliveryOversightTools },
    credentialTools: crmCredentialTools,
    retrievalTools: brainRetrievalTools,
    fileTools: brainFileTools ?? undefined,
    // Brand primitive (D8): `getBrand` on both key scopes, `saveBrandDraft`
    // on write keys. Draft-only — the supplier flow is that an agency session
    // pushes a draft into the client's workspace and the CLIENT approves it in
    // their own Studio, so no approve tool exists on this surface.
    brandTools: { getBrand: brandTools.getBrand, updateBrandDraft: brandTools.updateBrandDraft },
    // Doc-page tools (readPage / editPage / deletePage) reuse the same RLS-gated
    // stores and live DocGateway as chat. Production edits therefore land in
    // the authoritative Y.Doc; the legacy CAS remains only for deployments
    // without doc-sync. See brain-mcp/tools.ts → buildDocPageTools.
    docTools: { savedViewStore, docPageStore, docGateway, pageTemplateStore },
    ingest: brainEpisodeIngestor,
    programmaticCapture,
    captureConfiguration,
    engineeringHistory:async(auth,input,ctx)=>{
      if(!engineeringHistory)throw new Error('history_unavailable')
      return engineeringHistory.execute({...workspaceFilesCtxFor(ctx),principalRef:`${auth.authKind}:${auth.keyId}`,readOnly:auth.scope!=='read_write',origin:'programmatic'},input)
    },
    agentTools: { reads: agentToolset.reads, writes: agentToolset.writes },
    // Powers the searchRecording tool's vector arm (recording-to-brain).
    embedder: sharedEmbedder,
    // Computer-use R2: writeBrowserSkill — the OSS authoring skill's sync tool.
    browserSkills: browserSkillsStore,
    // Commerce-store tools for a granted custom Home app. Bound to the
    // workspace primary assistant, so its connector action grants apply
    // before the app's own `scopes.store` tier narrows further.
    storeTools: shopifyStoreTools,
    // `scopes.agent: 'ask'` — the app hands a task to the workspace assistant.
    agentTask: ({ workspaceId, storeScope, appId, task, actingUserId, maxClearance }) => {
      if (!actingUserId) throw new Error('caller_authority_missing')
      return askShopifyAssistant({
        workspaceId, storeScope, task, userId: actingUserId, maxClearance,
        callerSessionId: `home-app:${appId}`,
      })
    },
  }))

  // AI Engines MCP — read-only observation of external answer engines,
  // registered in a workspace as a custom connector. Dark by default: the
  // route exists only when ENGINES_MCP_SECRET plus at least one engine
  // credential are set (docs/architecture/integrations/engines-mcp.md).
  if (enginesMcpEnabled(process.env as EnginesEnv, managedEngineProviders)) {
    app.use(
      '/api/engines/mcp',
      enginesMcpRoutes(
        process.env as EnginesEnv,
        externalCredentialPool,
        managedEngineProviders,
      ),
    )
  }

  app.use(oauthMetadataRoutes({ apiUrl: env.API_URL, webUrl: env.APP_URL, assistantWorkspaceOAuth: true }))
  app.use(connectorActorMetadataRoutes(env.API_URL))
  const applicationService = new ApplicationPlatformService([
    createCanonicalNativeApplicationModule(), createCanonicalGenericApplicationModule(), ...(opts.applicationModules ?? []),
  ])
  app.use('/api/external-services',externalServicesRoutes({clientStore:oauthClientStore,workspaceStore,requireAuth:requireAuth(env.JWT_SECRET),signingSecret:env.JWT_SECRET,webAppUrl:env.AUTHED_APP_URL??env.APP_URL,origins:[env.APP_URL,env.AUTHED_APP_URL].filter(Boolean) as string[]}))
  app.use('/api/applications', applicationPlatformRoutes({ service: applicationService,
    home: { signingSecret: env.JWT_SECRET, consumeBudget: consumeHomeAppBudget },
    oauth: { clientStore: oauthClientStore, workspaceStore, signingSecret: env.JWT_SECRET, webAppUrl: env.APP_URL,
      requireAuth: requireAuth(env.JWT_SECRET) },
    management: { service: new ApplicationManagementService(applicationService), requireAuth: requireAuth(env.JWT_SECRET),
      origins: [env.APP_URL, env.AUTHED_APP_URL].filter(Boolean) as string[] } }))
  app.use('/api/v1/assistants/:assistantId/oauth', (req,res,next) => {
    const assistantId = req.params.assistantId
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(assistantId)) { res.status(404).end(); return }
    return oauthRoutes({ assistantId, workspaceProfile: workspaceMcpProfile, clientStore: oauthClientStore,
      authorizationStore: createDbOAuthAuthorizationStore({ audience: 'assistant', assistantId }),workspaceStore,
      signingSecret: env.JWT_SECRET,webAppUrl: env.AUTHED_APP_URL ?? env.APP_URL,requireAuth: requireAuth(env.JWT_SECRET) })(req,res,next)
  })
  app.use('/api/brain/oauth', oauthRoutes({
    workspaceProfile: workspaceMcpProfile,
    preferredWorkspaceId: scope.ports.accountContinuation?.preferredBrainWorkspaceId,
    memoryOnly: scope.ports.memoryAllowance?.contextOnly,
    clientStore: oauthClientStore,
    authorizationStore: oauthAuthorizationStore,
    workspaceStore,
    signingSecret: env.JWT_SECRET ?? 'dev-oauth-signing-secret',
    webAppUrl: env.AUTHED_APP_URL ?? env.APP_URL,
    requireAuth: requireAuth(env.JWT_SECRET),
  }))
  app.use('/api/apps/learn-japanese', learnJapaneseRoutes({
    brainKeyStore,
    authorizationStore: oauthAuthorizationStore,
    workspaceStore,
    webAppUrl: env.APP_URL,
  }))

  return { crmProductionImports } as const
}
