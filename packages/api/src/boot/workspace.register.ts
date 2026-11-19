/**
 * Workspace, grant, knowledge and internal-link stores.
 *
 * Boot register module registerWorkspace: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`WorkspaceScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { sanitize as sanitizeAnalytics } from '@use-brian/core/analytics/logger.js'
import type { SyncCredentials } from '@use-brian/core/knowledge/sync-worker.js'
import { createWorkspaceStore } from '../db/workspace-store.js'
import { createMeteredProfileStore } from '../db/metered-profile-store.js'
import { createWorkspaceModelDefaultsStore } from '../db/workspace-model-defaults-store.js'
import { createBrainEntryMutator } from '../brain-entry-mutation.js'
import { createWorkspaceAuditStore } from '../db/workspace-audit-store.js'
import { createWorkspaceDirectoryStore } from '../db/workspace-directory-store.js'
import { createConnectionStore } from '../db/connection-store.js'
import { createChatConfirmationStore } from '../db/chat-confirmation-store.js'
import { createDeferredConfirmationStore } from '../db/deferred-confirmation-store.js'
import { createDbKnowledgeStore } from '../db/knowledge-store.js'
import { createKnowledgeRepoWriter } from '../knowledge/repo-writer.js'
import { createDbKbMaintenanceStore } from '../knowledge/maintenance.js'
import { createDbKnowledgeCaptureRuleStore } from '../knowledge/capture-rules.js'
import { createRealtimeThreadTargetStore } from '../db/realtime-thread-target-store.js'
import { createSyncCredentialProvider } from '../knowledge/sync-credentials.js'
import { createChatLinkStore } from '../db/chat-link-store.js'
import { createExtractionApplicationStore } from '../db/extraction-application-store.js'
import { createIngestApplicationService } from '../ingest/application-service.js'
import { createPipelineBApplicationMutationPort } from '../ingest/pipeline-b-application-adapter.js'
import { createGoalDefaultBudgetStore } from '../db/goal-default-budget.js'
import { createInternalLinkService } from '../internal-link-service.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'
import type { WorkspaceScope } from './scope.js'

export async function registerWorkspace(scope: WorkspaceScope) {
  const {
    ports, env, analytics, entityLinksStore, connectorInstanceStore, channelRouteStore, episodesStore,
    internalLinkAliasStore, savedViewStore, late,
  } = scope
  const { createConnectorGrantStore } = await import('../db/connector-grant-store.js')
  const connectorGrantStore = createConnectorGrantStore()
  const workspaceStore = createWorkspaceStore({ connectorGrantStore, channelRouteStore })
  const ingestApplicationService = createIngestApplicationService({
    store: createExtractionApplicationStore(),
    episodes: episodesStore,
    mutateCandidate: createPipelineBApplicationMutationPort(),
    getWorkspaceRole: (userId, workspaceId) => workspaceStore.getRole(userId, workspaceId),
  })
  const brainEntryMutator = createBrainEntryMutator({
    workspaceStore,
    entityLinks: entityLinksStore,
  })
  const meteredProfileStore = createMeteredProfileStore()
  const modelDefaultsStore = createWorkspaceModelDefaultsStore()

  // ── KB sync-credential resolver ──
  // One open resolver serves the sync worker, knowledge routes, Home apps, and
  // repo writer in both editions. Hosted supplies no override or duplicate.
  const syncCredentials: SyncCredentials = ports.buildSyncCredentials
    ? ports.buildSyncCredentials({ connectorInstanceStore, connectorGrantStore })
    : createSyncCredentialProvider(connectorInstanceStore, connectorGrantStore)

  const workspaceDirectoryStore = createWorkspaceDirectoryStore(workspaceStore)

  const workspaceAuditStore = createWorkspaceAuditStore()
  const internalLinkService = createInternalLinkService({
    store: internalLinkAliasStore,
    workspaceStore,
    savedViewStore,
    auditStore: workspaceAuditStore,
    appOrigin: env.AUTHED_APP_URL ?? env.APP_URL,
    onAliasChanged: ({ workspaceId }) => {
      notifyWorkspaceChange(workspaceId, 'workspace_config', 'update')
    },
  })
  const rawGoalDefaultBudgetStore = createGoalDefaultBudgetStore()
  const goalDefaultBudgetStore = {
    get: rawGoalDefaultBudgetStore.get,
    async set(
      userId: string,
      workspaceId: string,
      patch: Parameters<typeof rawGoalDefaultBudgetStore.set>[2],
    ) {
      const result = await rawGoalDefaultBudgetStore.set(userId, workspaceId, patch)
      if (result.ok) {
        void workspaceAuditStore.append({
          workspaceId,
          actorUserId: userId,
          eventType: 'workspace.settings_changed',
          details: {
            goalDefaultBudget: result.budget,
            source: result.source,
          },
        }).catch((error) => {
          console.error('[goal-default-budget] audit append failed:', error)
        })
      }
      return result
    },
  }
  const connectionStore = createConnectionStore()
  const chatLinkStore = createChatLinkStore()
  const chatConfirmationStore = createChatConfirmationStore()
  const deferredConfirmationStore = createDeferredConfirmationStore()
  const knowledgeStore = createDbKnowledgeStore()
  const knowledgeCaptureRuleStore = createDbKnowledgeCaptureRuleStore()
  const realtimeThreadTargetStore = createRealtimeThreadTargetStore()
  const kbMaintenanceStore = createDbKbMaintenanceStore()

  // ── Assistant KB repo writer ──
  // Direct-commit write-back for the KB write tools (updateKnowledgeEntry /
  // addKnowledgeEntry repo mode), over the same `syncCredentials` resolver
  // the sync worker and edit-proposal routes use. Only interactive,
  // confirmation-capable surfaces receive it (web chat here; the platform
  // channel pipeline builds its own) — see
  // docs/architecture/features/knowledge-base.md → "Assistant direct edits".
  const knowledgeRepoWriter = createKnowledgeRepoWriter({
    store: knowledgeStore,
    syncCredentials,
    recordEvent: ({ userId, eventName, metadata }) => {
      const safe: Record<string, number | boolean | undefined | ReturnType<typeof sanitizeAnalytics>> = {}
      for (const [k, v] of Object.entries(metadata)) {
        if (typeof v === 'number' || typeof v === 'boolean' || v === undefined) safe[k] = v
        else if (v === null) safe[k] = undefined
        else safe[k] = sanitizeAnalytics(String(v)) // ids / repo / sha / op — metadata-only, no content
      }
      analytics.logEvent({ userId, eventName, metadata: safe })
    },
  })

  // gdriveFilesStore is closed (api-platform) and arrives via the port. Open
  // passes undefined; the open chat / executor / brain-mcp deps accept it as
  // optional.
  const gdriveFilesStore = ports.gdriveFilesStore
  late.syncWorkerRef = null

  return {
    connectorGrantStore, workspaceStore, workspaceAuditStore, knowledgeStore, syncCredentials,
    ingestApplicationService, workspaceDirectoryStore, gdriveFilesStore, deferredConfirmationStore,
    connectionStore, knowledgeRepoWriter, goalDefaultBudgetStore, realtimeThreadTargetStore,
    internalLinkService, meteredProfileStore, knowledgeCaptureRuleStore, brainEntryMutator, chatLinkStore,
    modelDefaultsStore, kbMaintenanceStore, chatConfirmationStore,
  } as const
}
