/**
 * Office stores, lifecycle worker, service and Office tools.
 *
 * Boot register module registerOfficeTools: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`OfficeToolsScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { type OfficeToolPolicy, createOfficeTools } from '@use-brian/core/office/tools.js'
import { resumeOfficeGeneration } from '../office/generation-recovery.js'
import { withOfficeClassificationActor } from '../office/classification.js'
import { OFFICIAL_CONNECTOR_TOOLS, APP_LEVEL_ASSISTANT_ID } from '@use-brian/shared'
import { createOfficeArtifactStore } from '../db/office-artifacts.js'
import { OFFICE_LIFECYCLE_SWEEP_SQL } from '../db/office-lifecycle.js'
import { createOfficeTemplateStore } from '../db/office-templates.js'
import { createOfficeGenerationStore } from '../db/office-generation.js'
import { createOfficeCommentStore } from '../db/office-comments.js'
import { createOfficeLiveStore } from '../db/office-live.js'
import { createOfficePdfSessionStore } from '../db/office-pdf-sessions.js'
import { createOfficeReleaseStore } from '../db/office-release.js'
import { createOfficeService } from '../office/service.js'
import { createOfficeTemplateDiscovery } from '../office/template-discovery.js'
import { createChatOfficeGeneration } from '../office/chat-generation.js'
import {
  createOfficeLifecycleWorker, purgeExpiredPdfSessions, runPdfPurgeBlobWorker,
} from '../office/lifecycle-worker.js'
import { resolveDurableOfficeAccess, resolveOfficeAccess } from '../office/access.js'
import type { createPdfSessionService } from '../office/pdf-session-service.js'
import type { createStructuredDocumentRuntime } from '../structured-documents/runtime.js'
import { query, getPool } from '../db/client.js'
import type { OfficeToolsScope } from './scope.js'

export function registerOfficeTools(scope: OfficeToolsScope) {
  const { env, allTools, mcpSettingsStore, late } = scope
  const officeArtifactStore = createOfficeArtifactStore()
  const officeTemplateStore = createOfficeTemplateStore()
  const officeGenerationStore = createOfficeGenerationStore()
  const officeCommentStore = createOfficeCommentStore()
  const officeLiveStore = createOfficeLiveStore()
  const officePdfSessionStore = createOfficePdfSessionStore()
  late.pdfSessionToolRuntime = null
  late.structuredDocumentRuntime = null
  const officeReleaseStore = createOfficeReleaseStore()
  const officeLifecycleWorker = createOfficeLifecycleWorker({
    async sweep() {
      const result = await query<{ advanced: number }>(OFFICE_LIFECYCLE_SWEEP_SQL)
      const client = await getPool().connect()
      try {
        const purged = await purgeExpiredPdfSessions(client)
        if (late.filesResolver) {
          await runPdfPurgeBlobWorker({
            client,
            async deleteObject(storageUri, storageKey) {
              const storage = await late.filesResolver!.forUri(storageKey.split('/')[0]!, storageUri)
              await storage.deleteBlob(storageKey)
            },
          })
        }
        return Number(result.rows[0]?.advanced ?? 0) + purged
      } finally { client.release() }
    },
  })
  late.wakeOfficeGeneration = null
  const officeGenerationAvailable = (_family?: 'document' | 'presentation' | 'spreadsheet') => late.wakeOfficeGeneration !== null
  const officeLifecycle = { resolveAccess: resolveDurableOfficeAccess, transition: officeArtifactStore.transitionLifecycle, revokeOffline: officeReleaseStore.revokeOfflinePackages }
  const officeService = createOfficeService({updateCommentThread:officeCommentStore.updateThread,resolveComment:officeCommentStore.resolve,versions:() => late.officeVersionRuntime,release:() => late.officeReleaseDeps,lifecycle:officeLifecycle,getJob:officeGenerationStore.get,cancelJob:officeGenerationStore.cancel,listVersions:officeArtifactStore.listVersions,listThreads:officeCommentStore.listThreads,listSuggestions:officeCommentStore.listSuggestions,captureObservation:officeArtifactStore.captureObservation,list:officeArtifactStore.list,
    generationAvailable: officeGenerationAvailable,
    createShell: officeArtifactStore.createShell,
    deleteEmptyShell: officeArtifactStore.deleteEmptyShell,
    getArtifact: officeArtifactStore.get,
    raiseScope: officeArtifactStore.raiseScope,
    resolveAccess: resolveOfficeAccess,
    createJob: officeGenerationStore.create,
    latestJob: officeGenerationStore.latestForArtifact,
    latestJobEvent: officeGenerationStore.latestEvent,
    getSnapshot: officeLiveStore.get,
    wakeGeneration(userId) { late.wakeOfficeGeneration?.(userId) },
  })
  // Effective allow/ask/block for an Office tool — the same L1 (app-level
  // sentinel) + L2 (per-assistant) strictest-wins resolution the files and
  // computer primitives use, over `mcp_tool_settings` with serverName='office'.
  // The Studio / Assistant governance tables have always WRITTEN these rows;
  // until this hook existed nothing read them, so a blocked Office tool still
  // ran. Same defect the files resolver below was added to fix.
  const OFFICE_CONNECTOR_ID = 'office'
  const officeToolDefaults = new Map(
    (OFFICIAL_CONNECTOR_TOOLS[OFFICE_CONNECTOR_ID] ?? []).map((t) => [t.name, t.defaultPolicy]),
  )
  const OFFICE_POLICY_STRICTNESS: Record<string, number> = { allow: 0, ask: 1, block: 2 }
  const resolveOfficeToolPolicy = async (
    toolName: string,
    context: { userId: string; assistantId: string },
  ): Promise<OfficeToolPolicy> => {
    const fallback = (officeToolDefaults.get(toolName) ?? 'allow') as OfficeToolPolicy
    const [l1, l2] = await Promise.all([
      mcpSettingsStore.getPolicy({
        assistantId: APP_LEVEL_ASSISTANT_ID, userId: context.userId,
        serverName: OFFICE_CONNECTOR_ID, toolName,
      }),
      mcpSettingsStore.getPolicy({
        assistantId: context.assistantId, userId: context.userId,
        serverName: OFFICE_CONNECTOR_ID, toolName,
      }),
    ])
    const a = (l1?.policy as OfficeToolPolicy) ?? fallback
    const b = (l2?.policy as OfficeToolPolicy) ?? fallback
    return (OFFICE_POLICY_STRICTNESS[a] ?? 0) >= (OFFICE_POLICY_STRICTNESS[b] ?? 0) ? a : b
  }
  for (const tool of createOfficeTools({
    port: {
      ...officeService,
      listTemplates: createOfficeTemplateDiscovery(),
      async createFromContext(context,input) {
        const created = await createChatOfficeGeneration(context,input)
        if (!created) return officeService.create(input)
        late.wakeOfficeGeneration?.(context.userId)
        return created
      },
      async resumeGeneration(context,input) {
        const result=await withOfficeClassificationActor(context,()=>resumeOfficeGeneration(context.userId,input))
        late.wakeOfficeGeneration?.(context.userId)
        return result
      },
      async retryTemplateImport(input) { return late.retryOfficeTemplateImport(input) },
      async openPdfSession(params) {
        if (!late.pdfSessionToolRuntime) throw new Error('PDF editing sessions are unavailable')
        return late.pdfSessionToolRuntime.create({
          userId: params.userId,
          workspaceId: params.workspaceId,
          source: { kind: 'file_cache', id: params.sourceAttachmentId, expectedSessionId: params.sessionId },
          ...(params.signatureAttachmentId ? { signatureSource: { kind: 'file_cache' as const, id: params.signatureAttachmentId, expectedSessionId: params.sessionId } } : {}),
          title: params.title,
          sensitivity: 'internal',
          idempotencyKey: params.idempotencyKey,
          signal: params.signal,
        })
      },
      async describePdfSignature(params) {
        return late.pdfSessionToolRuntime?.describeSignature(params) ?? null
      },
      async placePdfSignature(params) {
        return late.pdfSessionToolRuntime?.placeSignature(params) ?? null
      },
    },
    appOrigin: env.AUTHED_APP_URL ?? env.APP_URL,
    resolvePolicy: resolveOfficeToolPolicy,
  })) {
    allTools.set(tool.name, tool)
  }

  return {
    officeArtifactStore, officeReleaseStore, officeCommentStore, officeLifecycle, officeGenerationStore,
    officeGenerationAvailable, officeLiveStore, officeService, resolveOfficeToolPolicy,
    officeLifecycleWorker, officeTemplateStore, officePdfSessionStore,
  } as const
}
