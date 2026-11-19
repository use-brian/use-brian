/**
 * Assistant, skill, workspace, external-app, invitation and computer routes.
 *
 * Boot register module registerWorkspaceRoutes: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`WorkspaceRoutesScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { resolveHumanBrowserProfileDepartmentRead } from '../sandbox/profile-authority.js'
import { resolveCrmDestination, previewCrmDestination } from '../crm-operations/creation-destination.js'
import { relayExtensionStatus } from '../sandbox/relay-transport.js'
import { createHmac } from 'node:crypto'
import { seedBuiltinPrimitiveCapabilities } from '../db/capability-seed.js'
import { listAccessibleAssistants } from '../db/users.js'
import { usesOpenStandaloneRoutes } from '../edition.js'
import { workspaceRoutes } from '../routes/workspaces.js'
import { createExternalAppRecordsStore } from '../external-app-records/store.js'
import { externalAppDocumentRoutes, authorizeDocumentHuman } from '../external-app-documents/routes.js'
import { createDocumentService } from '../external-app-documents/service.js'
import { externalAppConfiguration } from '../external-app-documents/configuration.js'
import { createCalendarCredentials } from '../external-app-calendar/credentials.js'
import { createWorkspaceInvitationStore } from '../db/workspace-invitation-store.js'
import { getSkillDraftContext } from '../skills/draft-context.js'
import { loadConnectorRegistry } from '../registry/load-registry.js'
import { requireAuth, optionalAuth } from '../auth/middleware.js'
import { listUsableWorkspaceConnectors } from '../connectors/usable-connectors.js'
import type { ValidatedDefinitionEditor } from '../routes/workflows.js'
import { queryWithRLS, query } from '../db/client.js'
import { lazyRoutes } from './lazy.js'
import type { WorkspaceRoutesScope } from './scope.js'

// Router modules that load on their mount's first request (deployment.md ->
// "Boot composition" -> "Lazy routers and workers"); the mounts below are unchanged.
const externalApprovalSourceRoutes = lazyRoutes(() => import('../external-approvals/source-routes.js'), 'externalApprovalSourceRoutes')
const engineeringHistoryRoutes = lazyRoutes(() => import('../routes/engineering-history.js'), 'engineeringHistoryRoutes')
const protectedBrowserFillRoutes = lazyRoutes(() => import('../routes/protected-browser-fill.js'), 'protectedBrowserFillRoutes')
const browserExtensionAuthorityRoutes = lazyRoutes(() => import('../routes/browser-extension.js'), 'browserExtensionAuthorityRoutes')
const browserExtensionRoutes = lazyRoutes(() => import('../routes/browser-extension.js'), 'browserExtensionRoutes')
const computerRoutes = lazyRoutes(() => import('../routes/computer.js'), 'computerRoutes')
const assistantRoutes = lazyRoutes(() => import('../routes/assistants.js'), 'assistantRoutes')
const assistantConnectorGrantsRoutes = lazyRoutes(() => import('../routes/assistant-connector-grants.js'), 'assistantConnectorGrantsRoutes')
const skillRoutes = lazyRoutes(() => import('../routes/skills.js'), 'skillRoutes')
const externalAppCalendarRoutes = lazyRoutes(() => import('../external-app-calendar/routes.js'), 'externalAppCalendarRoutes')
const externalAppRecordsRoutes = lazyRoutes(() => import('../external-app-records/routes.js'), 'externalAppRecordsRoutes')
const workspaceIconRoutes = lazyRoutes(() => import('../routes/workspace-icon.js'), 'workspaceIconRoutes')
const invitationRoutes = lazyRoutes(() => import('../routes/invitations.js'), 'invitationRoutes')
const skillApprovalsRoutes = lazyRoutes(() => import('../routes/skill-approvals.js'), 'skillApprovalsRoutes')
const memberConnectorInstanceRoutes = lazyRoutes(() => import('../routes/connector-instances.js'), 'memberConnectorInstanceRoutes')
const workspaceConnectorInstanceRoutes = lazyRoutes(() => import('../routes/connector-instances.js'), 'workspaceConnectorInstanceRoutes')
const brainKeysRoutes = lazyRoutes(() => import('../routes/brain-keys.js'), 'brainKeysRoutes')
const programmaticCaptureRoutes = lazyRoutes(() => import('../routes/programmatic-capture.js'), 'programmaticCaptureRoutes')
const workspaceLlmKeysRoutes = lazyRoutes(() => import('../routes/workspace-llm-keys.js'), 'workspaceLlmKeysRoutes')
const workspaceCustomLlmEndpointsRoutes = lazyRoutes(() => import('../routes/workspace-custom-llm-endpoints.js'), 'workspaceCustomLlmEndpointsRoutes')
const compartmentRoutes = lazyRoutes(() => import('../routes/compartments.js'), 'compartmentRoutes')
const oauthAuthorizationsRoutes = lazyRoutes(() => import('../routes/oauth-authorizations.js'), 'oauthAuthorizationsRoutes')

export function registerWorkspaceRoutes(scope: WorkspaceRoutesScope) {
  const {
    opts, ports, env, app, provider, analytics, syncNativeSlashCommands, entityLinksStore, decisionRuntime,
    connectorInstanceStore, workspaceSkillStore, workspaceSkillFilesStore, skillStore, workflowStore,
    llmProviderSettingsStore, customLlmEndpointStore, customLlmNetworkPolicy, resolveWorkspaceCustomLlm,
    profile, emailAuth, connectorGrantStore, workspaceStore, workspaceAuditStore, jobStore, fileStore,
    filesResolver, mcpSettingsStore, programmaticCaptureStore, pageTemplateStore, pendingApprovalsStore,
    filesApi, connectorStore, assistantConnectorStore, workspaceToolPolicyStore,
    assistantConnectorGrantsStore, capabilityStore, workspaceSkillEnablementStore, connectionStore,
    externalApprovalSources, filesBlobClient, engineeringHistory, browserRelayUrl, protectedExtensionOrigins,
    protectedBrowserSupported, localComputerTasks, protectedFill, sandboxProvider, sandboxOrchestrator,
    browserAuthBroker, discardBrowserTask, localBrowserProvider, computerTools, browserSkillsStore,
    brainKeyStore, communitySkillRegistry, voiceTranscription, workspaceMcpProfile, oauthAuthorizationStore,
    compartmentStore, late,
  } = scope
  // GET/POST /api/assistants (inline)
  app.get('/api/assistants', requireAuth(env.JWT_SECRET), async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    try {
      const rawWorkspaceId = req.query.workspaceId
      const workspaceId =
        typeof rawWorkspaceId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawWorkspaceId)
          ? rawWorkspaceId
          : null
      if (typeof rawWorkspaceId === 'string' && rawWorkspaceId !== '' && !workspaceId) {
        res.status(400).json({ error: 'Invalid workspaceId' })
        return
      }
      const rows = await listAccessibleAssistants(userId, workspaceId)
      res.json({
        assistants: rows.map((r) => ({
          id: r.id, name: r.name, role: r.role,
          placementDepartmentId: r.placementDepartmentId, placementDepartmentName: r.placementDepartmentName,
          description: r.systemPrompt ? r.systemPrompt.slice(0, 120) : null,
          memoryCount: r.memoryCount, iconSeed: r.iconSeed ?? 0,
          workspaceId: r.workspaceId,
          defaultModelAlias: r.defaultModelAlias,
          clearance: r.clearance, kind: r.kind, appType: r.appType,
        })),
      })
    } catch (err) {
      console.error('[assistants] list failed:', err)
      res.status(500).json({ error: 'Failed to list assistants' })
    }
  })

  app.post('/api/assistants', requireAuth(env.JWT_SECRET), async (req, res) => {
    const userId = req.userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    try {
      const { name, kind, workspaceId, appType } = req.body as {
        name?: string; kind?: string; workspaceId?: string; appType?: string
      }
      if (kind !== 'app') {
        res.status(400).json({
          error: 'POST /api/assistants only creates kind=\'app\' assistants. For standard team assistants, POST /api/workspaces/:id/assistants.',
          code: 'STANDARD_ASSISTANT_CREATE_MOVED',
        })
        return
      }
      if (!workspaceId) {
        res.status(400).json({
          error: 'kind=\'app\' requires workspaceId — distribution assistants are team-owned.',
          code: 'APP_REQUIRES_TEAM',
        })
        return
      }
      const { isAppType, defaultClearanceForAppType } = await import('@use-brian/shared')
      if (appType !== undefined && appType !== null && !isAppType(appType)) {
        res.status(400).json({
          error: `Unknown app type: ${String(appType)}. Supported: distribution.`,
          code: 'UNKNOWN_APP_TYPE',
        })
        return
      }
      const resolvedAppType = appType && isAppType(appType) ? appType : 'distribution'
      const teamRole = await queryWithRLS<{ role: string }>(
        userId,
        `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
        [workspaceId, userId],
      )
      if (teamRole.rows.length === 0) {
        res.status(403).json({ error: 'You are not a member of the target team.' })
        return
      }
      if (!['owner', 'admin'].includes(teamRole.rows[0].role)) {
        res.status(403).json({
          error: 'Only team admins or owners can create distribution apps.',
          code: 'APP_REQUIRES_TEAM_ADMIN',
        })
        return
      }
      const assistantName = name?.trim() || 'New Assistant'
      const iconSeed = Math.floor(Math.random() * 1000000)
      const appClearance = defaultClearanceForAppType(resolvedAppType)
      const result = await query<{ id: string }>(
        `INSERT INTO assistants (name, owner_user_id, icon_seed, kind, app_type, workspace_id, clearance)
         VALUES ($1, NULL, $2, 'app', $3, $4, $5) RETURNING id`,
        [assistantName, iconSeed, resolvedAppType, workspaceId, appClearance],
      )
      const assistantId = result.rows[0].id
      // App specialists deliberately get no §17 primitives, but the built-in
      // primitives (office / computer) were injected unconditionally before the
      // off switch existed — seed them so an app assistant keeps what it had.
      await seedBuiltinPrimitiveCapabilities(
        (sql, params) => query(sql, params as never[]),
        assistantId,
        userId,
        'built-in primitive — default-on at app-assistant creation',
      )
      await connectionStore.seedWorkspacePrimaryFollows(workspaceId).catch((err) =>
        console.warn('[assistants] seedWorkspacePrimaryFollows failed:', err),
      )
      res.json({ id: assistantId, name: assistantName, iconSeed, kind: 'app', appType: resolvedAppType, workspaceId })
    } catch (err) {
      console.error('[assistants] create failed:', err)
      res.status(500).json({ error: 'Failed to create assistant' })
    }
  })

  const connectorRegistry = loadConnectorRegistry()
  app.use('/api/assistants', requireAuth(env.JWT_SECRET), assistantRoutes({
    teardownRules: ports.assistantTeardownRules,
    assistantConnectorStore,
    connectorStore,
    connectorInstanceStore,
    connectorGrantStore,
    mcpSettingsStore,
    workspaceToolPolicyStore,
    workspaceStore,
    registry: connectorRegistry,
    jobStore,
    skillStore,
    communitySkills: communitySkillRegistry,
    workspaceSkillStore,
    workspaceSkillEnablementStore,
    // mig 492: the assistant-side disable has to materialise an
    // `all_assistants` skill into per-assistant rows before clearing the flag.
    listWorkspaceAssistants: async (userId, workspaceId) =>
      (await listAccessibleAssistants(userId, workspaceId)).map((a) => ({
        id: a.id,
        name: a.name,
      })),
    capabilityStore,
    assistantConnectorGrantsStore,
    analytics,
  }))
  app.use(
    '/api/assistant-connector-grants',
    requireAuth(env.JWT_SECRET),
    assistantConnectorGrantsRoutes({ store: assistantConnectorGrantsStore }),
  )

  // Late-bound (origin-aware induction): the validated definition editor is
  // assembled with the workflows route options further down this function;
  // this router mounts earlier (it must out-rank the bare `/api/skills`
  // mount), so the wrapper defers resolution to request time — by which the
  // assignment below has run.
  // `applyWorkflowDefinitionEdit` is late-bound: see BootLate (boot/late.ts).
  app.use('/api/skills/approvals', requireAuth(env.JWT_SECRET), skillApprovalsRoutes({
    approvalsStore: pendingApprovalsStore,
    workspaceStore,
    workspaceSkillStore,
    fileStore: workspaceSkillFilesStore,
    enablementStore: workspaceSkillEnablementStore,
    entityLinks: entityLinksStore,
    workflowStore,
    applyDefinitionEdit: (params) =>
      late.applyWorkflowDefinitionEdit
        ? late.applyWorkflowDefinitionEdit(params)
        : Promise.resolve({ ok: false as const, error: 'Workflow edit path not initialized' }),
  }))
  app.use('/api/skills', requireAuth(env.JWT_SECRET), skillRoutes({
    skillStore,
    decisionRuntime,
    syncNativeSlashCommands,
    communityRegistry: communitySkillRegistry,
    workspaceSkillStore,
    workspaceStore,
    pageTemplateStore,
    workspaceSkillEnablementStore,
    listWorkspaceAssistants: async (userId, workspaceId) =>
      (await listAccessibleAssistants(userId, workspaceId)).map((a) => ({ id: a.id, name: a.name })),
    draftProvider: provider,
    resolveWorkspaceCustomLlm,
    getDraftContext: getSkillDraftContext,
    fileStore,
    voiceTranscription,
    checkUsageBudget: ports.checkCreditBudget,
    // Skill import (GitHub / URL): the connector stores back the GitHub
    // browse + PAT resolution; the files store backs imported support files.
    connectorInstanceStore,
    connectorGrantStore,
    workspaceSkillFilesStore,
  }))

  const workspaceInvitationStore = createWorkspaceInvitationStore()
  if (usesOpenStandaloneRoutes(profile)) {
    const connectorInstanceRouteOptions = {
      connectorInstanceStore,
      connectorStore,
      connectorGrantStore,
      workspaceStore,
      auditStore: workspaceAuditStore,
      workspaceToolPolicyStore,
    }
    app.use(
      '/api/connector-instances',
      requireAuth(env.JWT_SECRET),
      memberConnectorInstanceRoutes(connectorInstanceRouteOptions),
    )
    app.use(
      '/api/workspaces/:workspaceId/connectors',
      requireAuth(env.JWT_SECRET),
      workspaceConnectorInstanceRoutes(connectorInstanceRouteOptions),
    )
  }
  const workspaceRouter = workspaceRoutes({
    workspaceStore,
    auditStore: workspaceAuditStore,
    invitationStore: workspaceInvitationStore,
    smtpClient: emailAuth?.smtpClient,
    appUrl: env.AUTH_PORTAL_URL ?? env.APP_URL,
    blobClient: filesBlobClient ?? undefined,
    filesResolver: filesResolver ?? undefined,
  })
  app.use('/api/workspaces', requireAuth(env.JWT_SECRET), workspaceIconRoutes({
    workspaceStore,
    auditStore: workspaceAuditStore,
    blobClient: filesBlobClient ?? undefined,
    filesResolver: filesResolver ?? undefined,
  }))
  app.use('/api/workspaces', requireAuth(env.JWT_SECRET), workspaceRouter)
  app.use('/api/external-app', externalAppCalendarRoutes({
    jwtSecret: env.JWT_SECRET,
    withCalendar: createCalendarCredentials({
      workspaceStore,
      instances: connectorInstanceStore,
      listUsable: (userId, workspaceId) => listUsableWorkspaceConnectors({ connectorInstanceStore, connectorGrantStore, userId, workspaceId }),
    }),
  }))

  const externalApps = opts.externalApps ?? externalAppConfiguration()
  app.use('/api/external-app', externalAppRecordsRoutes({
    jwtSecret: env.JWT_SECRET,
    store: createExternalAppRecordsStore({ sources: externalApps.sources }),
  }))
  if (filesApi) app.use('/api/external-app', externalAppDocumentRoutes({
    jwtSecret: env.JWT_SECRET,
    service: createDocumentService({
      ...externalApps.documents, files: filesApi, authorize: authorizeDocumentHuman,
      locatorSecret: createHmac('sha256', env.JWT_SECRET).update('external-app-documents-v1').digest('hex'),
    }),
  }))
  else app.use('/api/external-app/workspaces/:workspaceId/documents', requireAuth(env.JWT_SECRET), (_req, res) => {
    res.status(503).json({ error: 'document_storage_unavailable' })
  })

  const invitationRouter = invitationRoutes({
    invitationStore: workspaceInvitationStore,
    workspaceStore,
    auditStore: workspaceAuditStore,
  })
  app.use('/api/invitations', optionalAuth(env.JWT_SECRET), invitationRouter)

  app.use('/api/workspaces/:workspaceId/brain-keys', requireAuth(env.JWT_SECRET), brainKeysRoutes({ brainKeyStore, workspaceStore, workspaceProfile: workspaceMcpProfile }))
  app.use('/api/workspaces/:workspaceId/external-approval-sources', requireAuth(env.JWT_SECRET), externalApprovalSourceRoutes({ workspaceStore, store: externalApprovalSources }))
  if(engineeringHistory)app.use('/api/workspaces/:workspaceId/engineering-history',requireAuth(env.JWT_SECRET),engineeringHistoryRoutes({service:engineeringHistory,workspaceStore}))
  app.use(
    '/api/workspaces/:workspaceId/programmatic-capture-profiles',
    requireAuth(env.JWT_SECRET),
    programmaticCaptureRoutes({ store: programmaticCaptureStore, workspaceStore }),
  )

  if (llmProviderSettingsStore) {
    app.use('/api/workspaces/:workspaceId/llm-keys', requireAuth(env.JWT_SECRET), workspaceLlmKeysRoutes({ llmProviderSettingsStore, workspaceStore }))
  }
  app.use(
    '/api/workspaces/:workspaceId/custom-llm-endpoints',
    requireAuth(env.JWT_SECRET),
    workspaceCustomLlmEndpointsRoutes({
      endpointStore: customLlmEndpointStore,
      workspaceStore,
      networkPolicy: customLlmNetworkPolicy,
    }),
  )

  app.use('/api/workspaces/:workspaceId/compartments', requireAuth(env.JWT_SECRET), compartmentRoutes({ compartmentStore, workspaceStore }))
  app.use('/api/workspaces/:workspaceId/oauth-authorizations', requireAuth(env.JWT_SECRET), oauthAuthorizationsRoutes({
    authorizationStore: oauthAuthorizationStore,
    workspaceStore,
  }))

  // Browser-extension pairing (computer-use local mode, P1.3). The relay's
  // WS endpoint derives from the HTTP base: https://relay → wss://relay/ext.
  const browserRelayWsUrl = browserRelayUrl
    ? `${browserRelayUrl.replace(/\/$/, '').replace(/^http/, 'ws')}/ext`
    : null
  // Take-Over live view + backend toggle + Profile-Management
  // (computer-use.md §5, §7; R2-3/R2-4).
  if (protectedFill) {
    app.use('/api/protected-browser-fill', protectedBrowserFillRoutes({
      service: protectedFill, jwtSecret: env.JWT_SECRET, userAuth: requireAuth(env.JWT_SECRET),
      extensionOrigins: protectedExtensionOrigins,
      onComplete: async (sessionId) => { localComputerTasks.complete(sessionId); computerTools.clearSessionTrace(sessionId) },
    }))
  }
  app.use('/api/computer', requireAuth(env.JWT_SECRET), computerRoutes({
    discardTask: discardBrowserTask,
    protectedFillEnabled: Boolean(protectedFill),
    protectedBrowserSupported,
    protectedFillBlocked: (userId, sessionId) => protectedFill?.isSessionLocked(userId, sessionId) ?? false,
    orchestrator: sandboxOrchestrator,
    provider: sandboxProvider,
    localProvider: localBrowserProvider,
    localTasks: localComputerTasks,
    localStatus:
      browserRelayUrl && env.BROWSER_RELAY_SECRET
        ? (userId, browserProfileId) =>
            relayExtensionStatus({
              relayUrl: browserRelayUrl as string,
              relaySecret: env.BROWSER_RELAY_SECRET as string,
              userId,
              ...(browserProfileId ? { browserProfileId } : {}),
            })
        : null,
    vault: ports.browserSessionVault ?? null,
    profileStore: ports.browserProfileStore ?? null,
    credentials: ports.browserCredentialStore ?? null,
    authBroker: browserAuthBroker,
    grants: ports.browserSkillGrantStore ?? null,
    skills: browserSkillsStore,
    getProfileReadGrant: resolveHumanBrowserProfileDepartmentRead,
    admitProfileDestination: async (userId, workspaceId, destination) => {
      await resolveCrmDestination(userId, workspaceId, destination)
    },
    previewProfileDestination: previewCrmDestination,
    getWorkspaceRole: (userId, workspaceId) => workspaceStore.getRole(userId, workspaceId),
    setSessionBackend: (sessionId, backend) => {
      if (backend !== 'local') localComputerTasks.complete(sessionId)
      computerTools.setSessionBackendOverride(sessionId, backend)
    },
  }))

  app.use('/api/browser-extension', browserExtensionAuthorityRoutes({
    jwtSecret: env.JWT_SECRET,
    workspaceStore,
    profileStore: ports.browserProfileStore ?? null,
    getProfileReadGrant: resolveHumanBrowserProfileDepartmentRead,
  }))
  app.use('/api/browser-extension', requireAuth(env.JWT_SECRET), browserExtensionRoutes({
    jwtSecret: env.JWT_SECRET,
    workspaceStore,
    profileStore: ports.browserProfileStore ?? null,
    getProfileReadGrant: resolveHumanBrowserProfileDepartmentRead,
    relayWsUrl: browserRelayWsUrl,
    extensionStatus:
      browserRelayUrl && env.BROWSER_RELAY_SECRET
        ? (userId, options) =>
            relayExtensionStatus({
              relayUrl: browserRelayUrl as string,
              relaySecret: env.BROWSER_RELAY_SECRET as string,
              userId,
              ...options,
            })
        : null,
  }))

  return { workspaceRouter } as const
}
