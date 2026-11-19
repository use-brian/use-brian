/**
 * Brain tools, file blob backends, Files API and file tools.
 *
 * Boot register module registerFiles: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`FilesScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import type { Tool } from '@use-brian/agent-runtime/tools/types.js'
import { sanitize as sanitizeAnalytics } from '@use-brian/core/analytics/logger.js'
import { createMemoryTools } from '@use-brian/core/memory/tools.js'
import { createRetrievalTools } from '@use-brian/core/retrieval/tools.js'
import type { FileToolPolicy } from '@use-brian/core/workspace-files/tool-helpers.js'
import { createFileTools } from '@use-brian/core/workspace-files/tools.js'
import { createEngineeringArchivePublisher } from '../engineering-history/publisher.js'
import { createEngineeringHistoryService } from '../engineering-history/service.js'
import { OFFICIAL_CONNECTOR_TOOLS, APP_LEVEL_ASSISTANT_ID } from '@use-brian/shared'
import { findAssistantById, listAccessibleAssistants } from '../db/users.js'
import { resolveTurnScopeSystem } from '../context-scope/resolve-turn-scope.js'
import { createSaveChatMediaTool } from '@use-brian/core/workspace-files/save-chat-media.js'
import { createGcsFilesClient } from '../files/gcs-client.js'
import { initLedgerRuntime } from '../ledger/runtime.js'
import { resolveLocalFilesBaseDir, createLocalFilesClient } from '../files/local-files-client.js'
import { azureBlobOptionsFromEnv, createAzureBlobFilesClient } from '../files/azure-blob-client.js'
import { createS3FilesClient } from '../files/s3-client.js'
import { s3OptionsFromEnv } from '../files/s3-env.js'
import { createSingletonFilesClientResolver, createFilesApi } from '../files/files-api.js'
import { createChunkedFileUploadService } from '../files/chunked-upload.js'
import type { FileIngestor } from '../files/ingest-file.js'
import { type WorkspaceStorageBinding, createCachedByoFilesResolver } from '../files/byo-files-resolver.js'
import { resolveDurableOfficeAccess } from '../office/access.js'
import { createStructuredDocumentRuntime } from '../structured-documents/runtime.js'
import { createStructuredOcrConnectorResolver } from '../structured-documents/connector.js'
import { query } from '../db/client.js'
import { lazyRoutes } from './lazy.js'
import { lazyFunction } from '@use-brian/agent-runtime/tools/lazy-implementation.js'
import type { FilesScope } from './scope.js'

// Router modules that load on their mount's first request (deployment.md ->
// "Boot composition" -> "Lazy routers and workers"); the mounts below are unchanged.
const localFilesTransferRoutes = lazyRoutes(() => import('../routes/local-files-transfer.js'), 'localFilesTransferRoutes')

export function registerFiles(scope: FilesScope) {
  const {
    ports, env, messageStoreClient, app, analytics, entityLinksStore, entitiesStore, selectMediaBackend,
    connectorInstanceStore, connectorGrantStore, workspaceStore, workspaceAuditStore, fileStore,
    workspaceFilesStore, allTools, officeArtifactStore, officeLiveStore, mcpSettingsStore,
    resolveOfficeToolPolicy, memoryStore, brainEpisodeIngestor, runWorkers, retrievalStore,
    assistantConnectorStore, workspaceToolPolicyStore, capabilityStore, workspaceFileUploadsStore,
    docPageStore, officeLifecycleWorker, late,
  } = scope
  // ── Brain-MCP-dedicated tool instances ──
  const brainMemoryTools = createMemoryTools(memoryStore, { entityStore: entitiesStore, entityLinksStore })
  const brainRetrievalTools = createRetrievalTools(retrievalStore)

  // ── Workspace filesystem ──
  const configuredLocalFilesDir = env.LOCAL_FILES_DIR?.trim()
  const localFilesDir = resolveLocalFilesBaseDir(configuredLocalFilesDir)
  const gcsBucket = env.GCS_FILES_BUCKET?.trim()
  if ([gcsBucket, env.AZURE_BLOB_CONTAINER?.trim(), env.S3_FILES_BUCKET?.trim()].filter(Boolean).length > 1) {
    throw new Error('[files] GCS_FILES_BUCKET, AZURE_BLOB_CONTAINER, and S3_FILES_BUCKET are mutually exclusive — pick one app-default blob store')
  }
  // Fail closed on incomplete cloud configuration instead of falling back to disk.
  const azureBlobOptions = azureBlobOptionsFromEnv(env)
  const s3Options = s3OptionsFromEnv(env)
  const cloudBlobConfigured = Boolean(gcsBucket) || azureBlobOptions !== null || s3Options !== null
  const localFilesClient = !cloudBlobConfigured && !(process.env.K_SERVICE && !configuredLocalFilesDir)
    ? createLocalFilesClient({
        baseDir: localFilesDir,
        apiUrl: env.LOCAL_FILES_PUBLIC_URL?.trim() || env.API_URL,
        signingSecret: env.JWT_SECRET,
      })
    : null
  const filesBlobClient = gcsBucket
    ? createGcsFilesClient({ bucket: gcsBucket, projectId: process.env.GOOGLE_CLOUD_PROJECT })
    : azureBlobOptions
      ? createAzureBlobFilesClient(azureBlobOptions)
      : s3Options
        ? createS3FilesClient(s3Options)
        : localFilesClient
  if (azureBlobOptions) {
    console.log(`[files] using Azure Blob container ${azureBlobOptions.container} for workspace files.`)
  } else if (s3Options) {
    console.log(`[files] using S3 bucket ${s3Options.bucket} for workspace files.`)
  } else if (localFilesClient) {
    const mode = configuredLocalFilesDir ? 'configured self-hosted storage' : 'ephemeral dev fallback'
    console.warn(`[files] no cloud default configured — using local-disk file storage at ${localFilesDir} (${mode}).`)
  }
  // Turn ledger rides the same storage decision as workspace files —
  // injected here so lanes never re-derive the driver from env.
  if (filesBlobClient) initLedgerRuntime(filesBlobClient)
  if (localFilesClient) {
    // Signed bearer URLs keep direct browser/connector transfers working without
    // exposing file:// paths. Mount before authenticated /api catch-all guards.
    app.use('/api/local-files', localFilesTransferRoutes({
      client: localFilesClient,
      signingSecret: env.JWT_SECRET,
    }))
  }
  let brainFileTools:
    | Pick<
        ReturnType<typeof createFileTools>,
        'fileWrite' | 'fileAppend' | 'fileRead' | 'fileReadBytes' | 'fileSearch' | 'fileSetMeta' | 'fileDelete' | 'saveFileToBrain' | 'saveFileBytes'
      >
        & { saveChatMedia?: Tool }
    | null = null
  let fileIngestor: unknown = null
  if (filesBlobClient) {
    // Workspace GCS/S3/local bindings override the deployment default.
    // The binding lookup reads encrypted connector_instance credentials;
    // unbound workspaces use the singleton default below.
    const defaultFilesResolver = createSingletonFilesClientResolver(
      filesBlobClient,
      gcsBucket || azureBlobOptions?.container || s3Options?.bucket || localFilesDir,
      gcsBucket ? 'gs' : azureBlobOptions ? 'az' : s3Options ? 's3' : 'file',
    )
    const lookupStorageBinding = async (workspaceId: string): Promise<WorkspaceStorageBinding | null> => {
      // A binding resolves only while we hold the key. Disconnect wipes the key
      // (credential type 'none'), so a disconnected workspace returns null here
      // and falls back to the app default bucket for both reads and writes —
      // its BYO files go dormant until a reconnect re-supplies the key. GCS
      // takes precedence when a workspace somehow has both bindings connected.
      const gcsInst = await connectorInstanceStore.findByWorkspaceProviderSystem(workspaceId, 'gcs')
      if (gcsInst) {
        const creds = await connectorInstanceStore.getAuthCredentialsSystem(gcsInst.id)
        if (creds && creds.type === 'gcs') {
          return { kind: 'gcs', credentials: creds.serviceAccountKey, bucket: creds.bucket, projectId: creds.projectId }
        }
      }
      const s3Inst = await connectorInstanceStore.findByWorkspaceProviderSystem(workspaceId, 's3')
      if (s3Inst) {
        const creds = await connectorInstanceStore.getAuthCredentialsSystem(s3Inst.id)
        if (creds && creds.type === 's3') {
          return {
            kind: 's3',
            credentials: creds.accessKey,
            bucket: creds.bucket,
            region: creds.region,
            endpoint: creds.endpoint,
            forcePathStyle: creds.forcePathStyle,
          }
        }
      }
      const localInst = await connectorInstanceStore.findByWorkspaceProviderSystem(workspaceId, 'local')
      if (localInst) {
        const creds = await connectorInstanceStore.getAuthCredentialsSystem(localInst.id)
        if (creds && creds.type === 'local') {
          return { kind: 'local', path: creds.path }
        }
      }
      return null
    }
    late.filesResolver = createCachedByoFilesResolver({ lookup: lookupStorageBinding, fallback: defaultFilesResolver })
    // One storage cap shared by both quota gates (fileWrite / fileAppend and
    // the chunked Work Bench uploads) so they cannot disagree. Hosted injects
    // the plan-derived resolver; the open default is no cap at all.
    const storageLimitBytesFor: (workspaceId: string) => Promise<number> =
      ports.storageLimitBytesFor ?? (async () => Number.POSITIVE_INFINITY)
    late.filesApi = createFilesApi({
      resolver: late.filesResolver,
      store: workspaceFilesStore,
      auditStore: workspaceAuditStore,
      storageLimitBytesFor,
    })
    late.chunkedFileUploads = createChunkedFileUploadService({
      resolver: late.filesResolver,
      filesStore: workspaceFilesStore,
      uploadsStore: workspaceFileUploadsStore,
      auditStore: workspaceAuditStore,
      storageLimitBytesFor,
    })
    // Effective allow/ask/block for a files tool — the same L1 (app-level
    // sentinel) + L2 (per-assistant) strictest-wins resolution the Studio /
    // Assistant tool-policy UIs display and write (`mcp_tool_settings`,
    // serverName='files'). Without this hook those toggles were stored but
    // never read at execution (static requiresConfirmation flags only).
    // See docs/architecture/features/files.md → "Connector-style governance".
    // The one connector id this resolver serves — NOT an "all built-ins"
    // list (see the builtin-id-sets invariant); the policy rows are keyed
    // by this serverName in mcp_tool_settings.
    const FILES_CONNECTOR_ID = 'files'
    const filesToolDefaults = new Map(
      (OFFICIAL_CONNECTOR_TOOLS[FILES_CONNECTOR_ID] ?? []).map((t) => [t.name, t.defaultPolicy]),
    )
    const POLICY_STRICTNESS: Record<string, number> = { allow: 0, ask: 1, block: 2 }
    const strictestFilePolicy = (a: FileToolPolicy, b: FileToolPolicy): FileToolPolicy =>
      (POLICY_STRICTNESS[a] ?? 0) >= (POLICY_STRICTNESS[b] ?? 0) ? a : b
    const resolveFilesToolPolicy = async (
      toolName: string,
      context: { userId: string; assistantId: string },
    ): Promise<FileToolPolicy> => {
      const fallback = (filesToolDefaults.get(toolName) ?? 'ask') as FileToolPolicy
      const [l1, l2] = await Promise.all([
        mcpSettingsStore.getPolicy({
          assistantId: APP_LEVEL_ASSISTANT_ID, userId: context.userId,
          serverName: FILES_CONNECTOR_ID, toolName,
        }),
        mcpSettingsStore.getPolicy({
          assistantId: context.assistantId, userId: context.userId,
          serverName: FILES_CONNECTOR_ID, toolName,
        }),
      ])
      return strictestFilePolicy(
        (l1?.policy as FileToolPolicy) ?? fallback,
        (l2?.policy as FileToolPolicy) ?? fallback,
      )
    }
    late.engineeringArchive=createEngineeringArchivePublisher(late.filesApi)
    late.engineeringHistory=createEngineeringHistoryService({files:late.filesApi,cursorSecret:env.JWT_SECRET})
    if(runWorkers){let draining=false;const timer=setInterval(()=>{if(draining||!late.engineeringArchive)return;draining=true
      void (async()=>{for(let i=0;i<10;i++){try{if(!await late.engineeringArchive!.drain())break}catch{break}}})().finally(()=>{draining=false})
    },30_000);timer.unref()}
    const fileTools = createFileTools(late.filesApi, {
      transfers: late.chunkedFileUploads,
      entityLinks: entityLinksStore,
      readCachedFile: (id, ctx) => fileStore.get(id, ctx),
      resolvePolicy: resolveFilesToolPolicy,
      // renderPdf({ pageId }): read the live merged doc page (RLS by userId)
      // and hand its Block[] to the PDF spoke. Same reader the doc tools use.
      readDocPage: async (userId, pageId) => {
        const current = await docPageStore.getVersionedPage(userId, pageId)
        return current ? { title: current.title, page: current.page } : null
      },
      onEvent: (evt, ctx) => {
        const base = { userId: ctx.userId, assistantId: ctx.assistantId, sessionId: ctx.sessionId, channelType: ctx.channelType }
        if (evt.type === 'file_created') {
          analytics.logEvent({ ...base, eventName: 'file_created', metadata: { file_id: sanitizeAnalytics(evt.fileId), path: sanitizeAnalytics(evt.path), size_bytes: evt.sizeBytes } })
        } else if (evt.type === 'file_appended') {
          analytics.logEvent({ ...base, eventName: 'file_appended', metadata: { file_id: sanitizeAnalytics(evt.fileId), path: sanitizeAnalytics(evt.path), size_bytes: evt.sizeBytes } })
        } else if (evt.type === 'file_meta_updated') {
          analytics.logEvent({ ...base, eventName: 'file_meta_updated', metadata: { file_id: sanitizeAnalytics(evt.fileId), path: sanitizeAnalytics(evt.path), fields: sanitizeAnalytics(evt.fields.join(',')) } })
        } else if (evt.type === 'file_deleted') {
          analytics.logEvent({ ...base, eventName: 'file_deleted', metadata: { file_id: sanitizeAnalytics(evt.fileId), path: sanitizeAnalytics(evt.path) } })
        } else if (evt.type === 'file_searched') {
          analytics.logEvent({ ...base, eventName: 'file_searched', metadata: { result_count: evt.resultCount, hit: evt.resultCount > 0, has_query: Boolean(evt.query) } })
        }
      },
    })
    allTools.set('startFileUpload', fileTools.startFileUpload)
    allTools.set('getFileUploadParts', fileTools.getFileUploadParts)
    allTools.set('completeFileUpload', fileTools.completeFileUpload)
    allTools.set('abortFileUpload', fileTools.abortFileUpload)
    allTools.set('getFileDownload', fileTools.getFileDownload)
    allTools.set('fileWrite', fileTools.fileWrite)
    allTools.set('fileAppend', fileTools.fileAppend)
    allTools.set('fileRead', fileTools.fileRead)
    allTools.set('fileReadBytes', fileTools.fileReadBytes)
    allTools.set('fileSearch', fileTools.fileSearch)
    allTools.set('fileSetMeta', fileTools.fileSetMeta)
    allTools.set('fileDelete', fileTools.fileDelete)
    allTools.set('saveFileToBrain', fileTools.saveFileToBrain)
    allTools.set('sendFile', fileTools.sendFile)
    allTools.set('renderPdf', fileTools.renderPdf)
    {
      late.structuredDocumentRuntime = createStructuredDocumentRuntime({
        connectors: createStructuredOcrConnectorResolver({
          instanceStore: connectorInstanceStore, grantStore: connectorGrantStore,
          assistantStore: assistantConnectorStore, settingsStore: mcpSettingsStore, workspacePolicyStore: workspaceToolPolicyStore,
        }), files: late.filesApi, tools: allTools,
        async resolveContext(saved) {
          if (!saved.assistantId || !await workspaceStore.getRole(saved.userId, saved.workspaceId)) throw new Error('Source authority unavailable')
          const assistant = await findAssistantById(saved.assistantId)
          if (!assistant || assistant.workspaceId !== saved.workspaceId || assistant.kind !== saved.assistantKind ||
              !(await listAccessibleAssistants(saved.userId)).some(a => a.id === assistant.id) ||
              !(await capabilityStore.listActive(assistant.id)).includes('files') ||
              await resolveFilesToolPolicy('startDocumentExtraction', { userId: saved.userId, assistantId: assistant.id }) === 'block') throw new Error('Source authority unavailable')
          const scope = await resolveTurnScopeSystem({ userId: saved.userId, assistant, workspaceId: saved.workspaceId,
            key: { contextGroupId: null, contextProjectId: null } })
          // Service intersects these fresh ceilings with the immutable turn grants.
          return { userId: saved.userId, workspaceId: saved.workspaceId, assistantId: assistant.id, assistantKind: assistant.kind,
            clearance: scope.access.clearance, compartments: scope.effectiveCompartments, projectIds: scope.effectiveProjectIds,
            mutationCompartments: scope.access.mutationCompartments }
        },
        resolvePolicy: (name, context) => name === 'proposeOfficeEvidenceFill'
          ? resolveOfficeToolPolicy(name, context) : resolveFilesToolPolicy(name, context),
        async getOffice(userId, artifactId) {
          const [artifact, access, live] = await Promise.all([
            officeArtifactStore.get(userId, artifactId), resolveDurableOfficeAccess(userId, artifactId), officeLiveStore.get(userId, artifactId),
          ])
          return artifact && access && live ? { artifact, access, live } : null
        },
        async pendingActors() {
          const result = await query<{ userId: string }>(`SELECT user_id AS "userId" FROM structured_document_extractions
            WHERE status IN ('queued','submitting','running','archiving') AND next_attempt_at <= now()
              AND (lease_expires_at IS NULL OR lease_expires_at <= now())
            GROUP BY user_id ORDER BY min(next_attempt_at) LIMIT 20`)
          return result.rows.map(row => row.userId)
        },
        warn: () => console.warn('[structured-documents] Worker scheduling failed; no source content logged.'),
      })
      if (runWorkers) late.structuredDocumentRuntime.start()
    }
    // Archive media retrieval needs BOTH seams: the store (bytes) and the
    // file layer (where sendFile and the web Files view can reach them) —
    // which is why it registers here and not with the read-only archive
    // tools at their earlier block.
    if (messageStoreClient) {
      allTools.set('saveChatMedia', createSaveChatMediaTool({ client: messageStoreClient, filesApi: late.filesApi, resolvePolicy: resolveFilesToolPolicy }))
    }
    brainFileTools = {
      fileWrite: fileTools.fileWrite,
      fileAppend: fileTools.fileAppend,
      fileRead: fileTools.fileRead,
      fileReadBytes: fileTools.fileReadBytes,
      fileSearch: fileTools.fileSearch,
      fileSetMeta: fileTools.fileSetMeta,
      fileDelete: fileTools.fileDelete,
      saveFileToBrain: fileTools.saveFileToBrain,
      saveFileBytes: fileTools.saveFileBytes,
      saveChatMedia: allTools.get('saveChatMedia'),
    }

    // Direct file ingest is open: store the original bytes, derive text, then
    // run the same boot-built Pipeline B ingestor used by brain MCP and docs.
    // The ingestor and its parsers/distiller (every document format's
    // extractor, media backends) load on the first ingest, not at boot
    // (M4 step 5); `filesApi` and the ingestor port are bound now as before.
    if (brainEpisodeIngestor) {
      const filesApi = late.filesApi
      const ingest = brainEpisodeIngestor
      fileIngestor = lazyFunction<FileIngestor>('The file ingest pipeline', async () => {
        const [{ createFileIngestor }, { distillFileToText }] = await Promise.all([
          import('../files/ingest-file.js'),
          import('@use-brian/core/files/distill.js'),
        ])
        return createFileIngestor({
          filesApi,
          ingest,
          distill: async ({ buffer, mime }) =>
            (await distillFileToText({ buffer, mime }, { backend: selectMediaBackend(mime) })).text,
        })
      })
    }
  }

  if (runWorkers) officeLifecycleWorker.start()

  return {
    gcsBucket, filesBlobClient, brainFileTools, fileIngestor, brainMemoryTools, brainRetrievalTools,
    filesResolver: late.filesResolver, filesApi: late.filesApi, chunkedFileUploads: late.chunkedFileUploads,
    engineeringHistory: late.engineeringHistory, structuredDocumentRuntime: late.structuredDocumentRuntime,
  } as const
}
