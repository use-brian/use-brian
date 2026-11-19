/**
 * Office runtime, workers and /api/office routes.
 *
 * Boot register module registerOfficeRoutes: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`OfficeRoutesScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { createOfficeVersionRuntime } from '../office/version-runtime.js'
import { minSensitivity } from '@use-brian/agent-runtime/security/sensitivity.js'
import { buildBrandVoiceFragment } from '@use-brian/core/brand/context-builder.js'
import { runOfficeEdit } from '@use-brian/core/office/generation/edit-runner.js'
import { validateRenderedPdf } from '@use-brian/core/office/pdf/validate.js'
import { createPdfWriterPort } from '@use-brian/core/office/pdf/writer.js'
import { bindDepartmentOfficeKnowledge } from '../office/generation-evidence.js'
import { getWorkspaceMembershipWithClearanceSystem } from '../db/workspace-store.js'
import { createTemplateImportRecovery } from '../office/template-import-recovery.js'
import {
  publishDepartmentOfficeSnapshot, checkPromptOnlyAuthority, executePromptOnlyGeneration,
} from '../office/generation-publication.js'
import { randomUUID, createHash } from 'node:crypto'
import { APP_LEVEL_ASSISTANT_ID } from '@use-brian/shared'
import { getWorkspacePrimaryAssistant } from '../db/users.js'
import { BACKGROUND_MODEL } from '../model-resolution.js'
import { requireAuth } from '../auth/middleware.js'
import { isDurableOfficeArtifact } from '../db/office-artifacts.js'
import { readWorkspaceMemberDirectory } from '../db/workspace-member-directory.js'
import { getBrandStore } from '../db/brand-store.js'
import { deriveOfficeSnapshot } from '../office/release.js'
import { resolveDurableOfficeAccess, resolveOfficeAccess } from '../office/access.js'
import { canBootPdfEditingSession, createPdfSessionService } from '../office/pdf-session-service.js'
import { PDF_SESSION_FILE_METADATA } from '../office/pdf-session-assets.js'
import { officeJobStreamRoutes, officeJobStreamRead } from '../routes/office-job-stream.js'
import {
  findOfficeArtifactSessionSystem, ensureOfficeArtifactSessionSystem,
} from '../db/office-artifact-sessions.js'
import { startOfficeJobEventBus } from '../office/job-event-bus.js'
import { createPublishedOfficeTemplateReader } from '../office/published-template.js'
import { createOfficeCommentAnchorWriter } from '../office/comment-anchor-storage.js'
import { createOfficeCommentVersionResolver } from '../office/comment-version.js'
import { createOfficeImportWorker } from '../office/import-worker.js'
import { createOfficeTemplateCompileWorker } from '../office/template-compile-worker.js'
import { createOfficeGenerationWorker } from '../office/generation-worker.js'
import { createOfficeRevisionWorker } from '../office/revision-worker.js'
import { generateDocumentFromTemplate } from '../office/document-generation.js'
import { generatePresentationFromTemplate } from '../office/presentation-generation.js'
import { generateSpreadsheetFromTemplate } from '../office/spreadsheet-generation.js'
import { generateAssistantOfficeCommands } from '../office/command-revision.js'
import {
  replaceLiveOfficeSnapshot, officeSuggestionApplied, applyLiveOfficeSuggestion,
} from '../office/live-sync.js'
import { officeOfflineRoutes, officeOfflineContextRevision } from '../routes/office-offline.js'
import { createOfficeReleaseRuntime, createOfficeTemplateBundleReader } from '../office/release-runtime.js'
import { createCrmOfficeBindingFromOffice } from '../crm-operations/office-binding.js'
import {
  sameOfficeFileBinding, classifyOfficeOutput, officeScopePathSegment, officeOutputScopeRevision,
} from '../office/file-binding.js'
import { readOfficeProjection } from '../db/office-read-projection.js'
import { internalOfficeCheckpointRoutes } from '../routes/internal-office-checkpoint.js'
import {
  snapshotToYDoc, officeStateVector, encodeOfficeState, type OfficeArtifactSnapshot,
} from '@use-brian/office-model'
import { createOfficeSearchProjector } from '../workspace-search/office-projection.js'
import { queryWithRLS, query } from '../db/client.js'
import { lazyRoutes } from './lazy.js'
import type { OfficeRoutesScope } from './scope.js'

// Router modules that load on their mount's first request (deployment.md ->
// "Boot composition" -> "Lazy routers and workers"); the mounts below are unchanged.
const officeArtifactRoutes = lazyRoutes(() => import('../routes/office-artifacts.js'), 'officeArtifactRoutes')
const officePdfSessionRoutes = lazyRoutes(() => import('../routes/office-pdf-sessions.js'), 'officePdfSessionRoutes')
const officeJobRoutes = lazyRoutes(() => import('../routes/office-jobs.js'), 'officeJobRoutes')
const officeConversationRoutes = lazyRoutes(() => import('../routes/office-conversation.js'), 'officeConversationRoutes')
const officeTemplateRoutes = lazyRoutes(() => import('../routes/office-templates.js'), 'officeTemplateRoutes')
const officeCollaborationRoutes = lazyRoutes(() => import('../routes/office-collaboration.js'), 'officeCollaborationRoutes')
const officeImportRoutes = lazyRoutes(() => import('../routes/office-imports.js'), 'officeImportRoutes')
const officeReleaseRoutes = lazyRoutes(() => import('../routes/office-releases.js'), 'officeReleaseRoutes')
const officeLifecycleRoutes = lazyRoutes(() => import('../routes/office-lifecycle.js'), 'officeLifecycleRoutes')
const officeResourceRoutes = lazyRoutes(() => import('../routes/office-resources.js'), 'officeResourceRoutes')

export function registerOfficeRoutes(scope: OfficeRoutesScope) {
  const {
    ports, env, app, provider, crmDocumentRuntime, knowledgeStore, resolveBackgroundRuntime, fileStore,
    filesResolver, officeArtifactStore, officeReleaseStore, officeCommentStore, officeLifecycle,
    officeGenerationStore, officeGenerationAvailable, officeLiveStore, officeService, runWorkers, filesApi,
    structuredDocumentRuntime, getAssistantClearance, officeTemplateStore, officePdfSessionStore, late,
  } = scope
  const officeVersionRuntime = filesApi ? createOfficeVersionRuntime({ files: filesApi, artifacts: officeArtifactStore, replaceLive: replaceLiveOfficeSnapshot }) : null
  late.officeVersionRuntime = officeVersionRuntime
  const readOfficeVersionSnapshot = async (userId: string, artifactId: string, versionId: string) =>
    officeVersionRuntime?.read(userId, artifactId, versionId) ?? null
  const officeSearchProjector = createOfficeSearchProjector(async (userId, artifactId, versionId) =>
    (await readOfficeVersionSnapshot(userId, artifactId, versionId))?.snapshot ?? null)
  if (runWorkers) officeSearchProjector.start()
  app.use('/api/office', requireAuth(env.JWT_SECRET), officeArtifactRoutes({
    service: officeService,
    generationAvailable: officeGenerationAvailable,
    async list(userId, workspaceId, view) {
      const artifacts = await officeArtifactStore.list(userId, workspaceId, view)
      const visible = await Promise.all(artifacts.map((artifact) => officeService.get({ userId, artifactId: artifact.id })))
      return visible.filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== null)
    },
    restoreVersion: async params => officeVersionRuntime?.restore(params) ?? null,
    getArtifact: officeArtifactStore.get,
    resolveAccess: resolveDurableOfficeAccess,
    listVersions: officeArtifactStore.listVersions,
    async previewVersion({ userId, artifactId, versionId }) {
      return (await readOfficeVersionSnapshot(userId, artifactId, versionId))?.snapshot ?? null
    },
    nameVersion: officeArtifactStore.nameVersion,
    async copyVersion({ userId, artifactId, versionId, title }) {
      if (!filesApi) return null
      const [artifact, loaded] = await Promise.all([
        officeArtifactStore.get(userId, artifactId),
        readOfficeVersionSnapshot(userId, artifactId, versionId),
      ])
      if (!artifact || !isDurableOfficeArtifact(artifact) || !loaded) return null
      const copiedArtifactId=randomUUID(),copiedVersionId=randomUUID()
      const snapshot = deriveOfficeSnapshot({ source: loaded.snapshot, artifactId: copiedArtifactId, title })
      const bytes = new TextEncoder().encode(JSON.stringify(snapshot))
      const hash = createHash('sha256').update(bytes).digest('hex')
      const saved = await filesApi.writeBytes({ workspaceId: artifact.workspaceId, userId, assistantKind: 'standard', clearance: 'confidential', writeCompartments: artifact.compartments, writeProjectIds: artifact.projectIds }, { path: `/office/artifacts/${copiedArtifactId}/versions/1-${hash}.json`, bytes, mime: 'application/json', sensitivity: artifact.sensitivity })
      if (!saved.ok) throw new Error(`Office version copy save failed: ${saved.error.kind}`)
      const doc = snapshotToYDoc(snapshot)
      const version=await officeArtifactStore.createCopiedArtifact({userId,artifactId:copiedArtifactId,versionId:copiedVersionId,workspaceId:artifact.workspaceId,family:artifact.family,title,
        templateVersionId:artifact.templateVersionId,capabilityVersion:artifact.capabilityVersion,sensitivity:artifact.sensitivity,
        compartments:artifact.compartments,projectIds:artifact.projectIds,snapshotFileId:saved.value.id,snapshotHash:hash,
        operationClock:officeStateVector(doc),schemaVersion:snapshot.schemaVersion,snapshotCapabilityVersion:snapshot.capabilityVersion,
        liveUpdate:encodeOfficeState(doc),liveStateVector:officeStateVector(doc),sourceArtifactId:artifactId,sourceVersionId:versionId})
      if(!version)throw new Error('Office version copy publication failed')
      return { artifactId: copiedArtifactId, version: version.version }
    },
    async listSharing(userId, artifactId) {
      const artifact = await officeArtifactStore.get(userId, artifactId)
      if (!artifact || !isDurableOfficeArtifact(artifact)) return {status:'unavailable' as const}
      const [grants,directory]=await Promise.all([officeArtifactStore.listGrants(userId,artifactId),readWorkspaceMemberDirectory(userId,artifact.workspaceId)])
      if(directory.status===409)return {status:'changed' as const}
      if(directory.status!==200)return {status:'unavailable' as const}
      return {status:'ok' as const,workspaceId:artifact.workspaceId,validForMs:directory.body.validForMs,
        defaultWorkspaceRole:artifact.defaultWorkspaceRole,grants,
        members:directory.body.members.map(({userId:memberUserId,name,email})=>({userId:memberUserId,userName:name,email,isOwner:artifact.ownerUserId===memberUserId}))}
    },
    async setGrant({ userId, artifactId, targetUserId, role, reason }) {
      const artifact = await officeArtifactStore.get(userId, artifactId)
      if (!artifact || !isDurableOfficeArtifact(artifact)) return false
      if (artifact.ownerUserId === targetUserId) return false
      return officeArtifactStore.setGrant({ userId, artifactId, workspaceId: artifact.workspaceId, targetUserId, role, reason })
    },
    async revokeGrant({ userId, artifactId, targetUserId }) {
      const artifact = await officeArtifactStore.get(userId, artifactId)
      if (!artifact || !isDurableOfficeArtifact(artifact) || artifact.ownerUserId === targetUserId) return false
      return officeArtifactStore.revokeGrant({ userId, artifactId, targetUserId })
    },
    setDefaultWorkspaceRole: officeArtifactStore.setDefaultWorkspaceRole,
    async canRestoreVersion(userId, artifactId) {
      return (await resolveDurableOfficeAccess(userId, artifactId))?.canEdit ?? false
    },
  }))
  // The file's shared Brian conversation: artifact-scoped routes only (D4).
  app.use('/api/office', requireAuth(env.JWT_SECRET), officeConversationRoutes({
    resolveAccess: resolveOfficeAccess,
    findSession: findOfficeArtifactSessionSystem,
    ensureSession: ensureOfficeArtifactSessionSystem,
    workspaceAssistant: getWorkspacePrimaryAssistant,
  }))
  app.use('/api/office', requireAuth(env.JWT_SECRET), officeJobRoutes({
    get: officeGenerationStore.get,
    events: officeGenerationStore.listEvents,
    latestEvent: officeGenerationStore.latestEvent,
    steer: officeGenerationStore.steer,
    wake: userId => late.wakeOfficeGeneration?.(userId),
    cancel: officeGenerationStore.cancel,
  }))
  // Late-bound: PDF session assets compose on top of the classified writer below.
  let officePdfSessionReader: import('../office/release-runtime.js').OfficePdfSessionAssetReader | null = null
  const officeReleaseRuntime = filesApi ? createOfficeReleaseRuntime({
    filesApi, artifacts: officeArtifactStore, live: officeLiveStore, releases: officeReleaseStore, templates: officeTemplateStore,
    brandClaims: async (userId, workspaceId) => (await getBrandStore().get(userId, workspaceId))?.activeRecord?.claims,
    pdfSessionAssets: () => officePdfSessionReader,
  }) : null
  const readBoundOfficeFile = officeReleaseRuntime?.readBoundOfficeFile ?? null
  const saveClassifiedOfficeFile = officeReleaseRuntime?.saveClassifiedOfficeFile ?? null
  const pdfSessionFiles = filesApi
  const pdfSessionAssets = pdfSessionFiles && saveClassifiedOfficeFile ? {
    async write(params: Parameters<import('../office/pdf-session-assets.js').PdfSessionAssetPort['write']>[0]) {
      const membership = await getWorkspaceMembershipWithClearanceSystem(params.userId, params.workspaceId)
      if (!membership) throw new Error('PDF session membership unavailable')
      const clearance = membership.role === 'owner' || membership.role === 'admin' ? 'confidential' as const : membership.clearance
      const saved = await pdfSessionFiles.writeBytes({
        workspaceId: params.workspaceId,
        userId: params.userId,
        assistantKind: 'standard',
        clearance,
        writeSensitivity: params.sensitivity,
        writeCompartments: params.compartments,
        writeProjectIds: params.projectIds,
      }, {
        path: params.path,
        bytes: params.bytes,
        mime: params.mime,
        sensitivity: params.sensitivity,
        sessionOwned: true,
      })
      if (!saved.ok) throw new Error(`PDF session asset save failed: ${saved.error.kind}`)
      return { id: saved.value.id, path: saved.value.path, storageUri: saved.value.storageUri, mime: saved.value.mime, sha256: createHash('sha256').update(params.bytes).digest('hex') }
    },
    async read(params: Parameters<import('../office/pdf-session-assets.js').PdfSessionAssetPort['read']>[0]) {
      const membership = await getWorkspaceMembershipWithClearanceSystem(params.userId, params.workspaceId)
      if (!membership) return null
      const clearance = membership.role === 'owner' || membership.role === 'admin' ? 'confidential' as const : membership.clearance
      const result = await pdfSessionFiles.readBytes({ workspaceId: params.workspaceId, userId: params.userId, assistantKind: 'standard', clearance }, params.fileId)
      if (!result.ok || !result.value.file.path.startsWith('/office/sessions/')
        || result.value.file.metadata.officeSession !== true || result.value.file.metadata.noIndex !== true) return null
      return { bytes: result.value.bytes, file: { id: result.value.file.id, path: result.value.file.path, storageUri: result.value.file.storageUri, mime: result.value.file.mime, sha256: createHash('sha256').update(result.value.bytes).digest('hex') } }
    },
    async delete(params: Parameters<import('../office/pdf-session-assets.js').PdfSessionAssetPort['delete']>[0]) {
      const membership = await getWorkspaceMembershipWithClearanceSystem(params.userId, params.workspaceId)
      if (!membership) return
      const clearance = membership.role === 'owner' || membership.role === 'admin' ? 'confidential' as const : membership.clearance
      await pdfSessionFiles.delete({ workspaceId: params.workspaceId, userId: params.userId, assistantKind: 'standard', clearance }, params.fileId)
    },
    async saveDurable(params: Parameters<import('../office/pdf-session-assets.js').PdfSessionAssetPort['saveDurable']>[0]) {
      const id = await saveClassifiedOfficeFile({
        userId: params.userId,
        workspaceId: params.workspaceId,
        path: params.path,
        bytes: params.bytes,
        mime: params.mime,
        hash: createHash('sha256').update(params.bytes).digest('hex'),
        scope: { sensitivity: params.sensitivity, compartments: params.compartments, projectIds: params.projectIds },
      })
      return { id }
    },
  } satisfies import('../office/pdf-session-assets.js').PdfSessionAssetPort : null
  officePdfSessionReader = pdfSessionAssets as unknown as typeof officePdfSessionReader
  const pdfSessionService = pdfSessionAssets && canBootPdfEditingSession() ? createPdfSessionService({
    sessions: officePdfSessionStore,
    live: officeLiveStore,
    assets: pdfSessionAssets,
    async assertWorkspaceMember({ userId, workspaceId }) {
      return Boolean(await getWorkspaceMembershipWithClearanceSystem(userId, workspaceId))
    },
    async resolveSource({ userId, workspaceId, source }) {
      const membership = await getWorkspaceMembershipWithClearanceSystem(userId, workspaceId)
      if (!membership) return null
      const clearance = membership.role === 'owner' || membership.role === 'admin' ? 'confidential' as const : membership.clearance
      if (source.kind === 'workspace_file') {
        const result = await pdfSessionFiles!.readBytes({ workspaceId, userId, assistantKind: 'standard', clearance }, source.id)
        if (!result.ok || result.value.file.workspaceId !== workspaceId || result.value.file.path.startsWith('/office/sessions/')) return null
        return { bytes: result.value.bytes, mime: result.value.file.mime, fileName: result.value.file.name,
          sensitivity: result.value.file.sensitivity, compartments: result.value.file.compartments ?? [], projectIds: result.value.file.projectIds ?? [] }
      }
      const access = { workspaceId, userId, assistantId: APP_LEVEL_ASSISTANT_ID, assistantKind: 'standard' as const, clearance }
      const cached = await fileStore.get(source.id, access)
      if (!cached) return null
      if (source.expectedSessionId && cached.sessionId !== source.expectedSessionId) return null
      const encoded = await fileStore.getOriginalContent?.(source.id, access) ?? cached.content
      const match = encoded.match(/^data:([^;]+);base64,([A-Za-z0-9+/=\r\n]+)$/)
      if (!match || match[1] !== cached.mimeType) return null
      return { bytes: Buffer.from(match[2]!, 'base64'), mime: cached.mimeType, fileName: cached.fileName,
        sensitivity: cached.sensitivity ?? 'internal', compartments: cached.compartments ?? [], projectIds: cached.projectIds ?? [] }
    },
  }) : null
  late.pdfSessionToolRuntime = pdfSessionService
  if (pdfSessionService) app.use('/api/office', requireAuth(env.JWT_SECRET), officePdfSessionRoutes({ service: pdfSessionService }))
  const officeImportWorker = filesApi ? createOfficeImportWorker({
    store: officeGenerationStore,
    async readSource({ userId, workspaceId, assistantId, fileId }) {
      const result = await filesApi!.readBytes({ workspaceId, userId, assistantId, assistantKind: 'standard', clearance: 'confidential' }, fileId)
      if (!result.ok) throw new Error(`Office import source unavailable: ${result.error.kind}`)
      return result.value.bytes
    },
    initialize: officeLiveStore.initialize,
    async context({ userId, artifactId, templateVersionId }) {
      const artifact = await officeArtifactStore.get(userId, artifactId)
      if (!artifact) throw new Error('Office import artifact not found')
      return { artifactId, workspaceId: artifact.workspaceId, templateVersionId, locale: 'en', defaultLanguage: 'en', title: artifact.title }
    },
  }) : null
  const officeTemplateCompileWorker = filesApi ? createOfficeTemplateCompileWorker({
    claim: officeGenerationStore.claim,
    getSnapshot: officeLiveStore.get,
    getTemplate: officeTemplateStore.get,
    getArtifact: officeArtifactStore.get,
    raiseArtifactScope: officeArtifactStore.raiseScope,
    async readSource({ userId, workspaceId, assistantId, fileId }) {
      const result = await readBoundOfficeFile!({ userId, workspaceId, assistantId, fileId })
      if (!result) throw new Error('Office template source unavailable')
      return result
    },
    initialize: officeLiveStore.initialize,
    getDraftRouting: officeTemplateStore.getDraftRouting,
    saveDraftRouting: officeTemplateStore.saveDraftRouting,
    async saveImportedResource({ userId, workspaceId, assistantId, resource, sourceBinding, scope }) {
      const source = await readBoundOfficeFile!({ userId, workspaceId, assistantId, fileId: sourceBinding.fileId })
      if (!source || !sameOfficeFileBinding(source.binding, sourceBinding)) throw new Error('office_source_changed')
      const resourceScope = classifyOfficeOutput(scope, { sensitivity: resource.ref.sensitivity, compartments: [], projectIds: [] })
      const path = `/office/resources/${officeScopePathSegment(resourceScope)}/${resource.ref.hash}`
      const fileId = await saveClassifiedOfficeFile!({ userId, workspaceId, path, bytes: resource.bytes, mime: resource.ref.mime, hash: resource.ref.hash, scope: resourceScope })
      const persisted = await officeTemplateStore.addResource({
        userId, workspaceId, kind: 'brand_media', name: resource.sourcePart, fileId,
        hash: resource.ref.hash, mime: resource.ref.mime,
        licence: { name: 'Workspace-uploaded source file' }, embeddingRights: 'allowed', sensitivity: resourceScope.sensitivity,
      })
      return {
        id: persisted.id, bytes: resource.bytes, hash: resource.ref.hash, mime: resource.ref.mime,
        licence: { name: 'Workspace-uploaded source file' }, embeddingRights: 'allowed',
      }
    },
    async loadResourceAdmissions({ userId, workspaceId, resourceIds }) {
      return Promise.all(resourceIds.map(async (resourceId) => {
        const resource = await officeTemplateStore.getResource(userId, resourceId)
        if (!resource || resource.workspaceId !== workspaceId || !resource.fileId) throw new Error(`Office template resource ${resourceId} is unavailable`)
        const read = await readBoundOfficeFile!({ userId, workspaceId, fileId: resource.fileId })
        if (!read || read.binding.hash !== resource.hash || read.binding.mime !== resource.mime) throw new Error(`Office template resource ${resourceId} is unavailable`)
        const name = typeof resource.licence?.name === 'string' && resource.licence.name.trim() ? resource.licence.name : 'Workspace resource'
        return {
          id: resource.id,
          bytes: read.bytes,
          hash: resource.hash,
          mime: resource.mime,
          licence: {
            name,
            ...(typeof resource.licence?.url === 'string' ? { url: resource.licence.url } : {}),
            ...(typeof resource.licence?.attribution === 'string' ? { attribution: resource.licence.attribution } : {}),
          },
          embeddingRights: resource.embeddingRights,
          sourceBinding: read.binding,
        }
      }))
    },
    async saveBundle({ userId, workspaceId, templateId, hash, bytes, scope }) {
      const path = `/office/templates/${templateId}/${officeScopePathSegment(scope)}/${hash}.json`
      return saveClassifiedOfficeFile!({ userId, workspaceId, path, bytes, mime: 'application/json', hash, scope })
    },
    addVersion: officeTemplateStore.addVersion,
    appendEvent: officeGenerationStore.appendEvent,
    finish: officeGenerationStore.finish,
  }) : null
  const commitGeneratedOfficeSnapshot = async (params: { job: import('../db/office-generation.js').OfficeGenerationJobRow; snapshot: OfficeArtifactSnapshot; expectedVersion: number; expectedSeq?: number; kind: 'generation' | 'revision'; authority?: import('@use-brian/core/office/generation/contracts.js').OfficeAuthorityProjection }) => {
    if(params.kind==='generation' && (params.job.authorityProjection as {creationBinding?:{protocol?:string}})?.creationBinding?.protocol==='office_department_v2') {
      if(!filesResolver || !params.job.leaseToken) throw new Error('Office storage or lease unavailable')
      return publishDepartmentOfficeSnapshot({job:params.job,leaseToken:params.job.leaseToken,snapshot:params.snapshot,resolver:filesResolver,
        storageLimitBytes:ports.storageLimitBytesFor?await ports.storageLimitBytesFor(params.job.workspaceId):Number.POSITIVE_INFINITY})
    }
    if (!filesApi) throw new Error('Office file storage is unavailable')
    if (params.snapshot.family === 'pdf') {
      if (params.kind !== 'revision' || params.expectedSeq === undefined || !pdfSessionService) throw new Error('PDF session revision runtime is unavailable')
      return pdfSessionService.commitRevision({
        userId: params.job.initiatedByUserId,
        assistantId: params.job.assistantId ?? APP_LEVEL_ASSISTANT_ID,
        artifactId: params.job.artifactId,
        expectedVersion: params.expectedVersion,
        expectedSeq: params.expectedSeq,
        snapshot: params.snapshot,
      })
    }
    const bytes = new TextEncoder().encode(JSON.stringify(params.snapshot))
    const hash = createHash('sha256').update(bytes).digest('hex')
    const storedAuthority = params.job.authorityProjection as {
      sensitivity?: unknown
      compartments?: unknown
      projectIds?: unknown
    }
    const compartments = params.authority?.compartments ??
      (Array.isArray(storedAuthority.compartments)
        ? storedAuthority.compartments.filter((value): value is string => typeof value === 'string')
        : [])
    const projectIds = params.authority?.projectIds ??
      (Array.isArray(storedAuthority.projectIds)
        ? storedAuthority.projectIds.filter((value): value is string => typeof value === 'string')
        : [])
    const sensitivity = params.authority?.sensitivity ??
      (storedAuthority.sensitivity === 'public' || storedAuthority.sensitivity === 'confidential'
        ? storedAuthority.sensitivity
        : 'internal')
    if (!await officeArtifactStore.raiseScope({
      userId: params.job.initiatedByUserId,
      artifactId: params.job.artifactId,
      sensitivity,
      compartments,
      projectIds,
    })) throw new Error('Office classification could not be persisted')
    const fileContext = {
      workspaceId: params.job.workspaceId,
      userId: params.job.initiatedByUserId,
      assistantKind: 'standard' as const,
      clearance: 'confidential' as const,
      writeCompartments: compartments,
      writeProjectIds: projectIds,
    }
    const saved = await filesApi.writeBytes(fileContext, {
      path: `/office/artifacts/${params.job.artifactId}/versions/${params.expectedVersion + 1}-${hash}.json`,
      bytes,
      mime: 'application/json',
      sensitivity: 'confidential',
    })
    if (!saved.ok) throw new Error(`Office snapshot save failed: ${saved.error.kind}`)
    const committed = await officeArtifactStore.commitVersion({
      userId: params.job.initiatedByUserId,
      artifactId: params.job.artifactId,
      snapshotTitle: params.snapshot.title,
      expectedVersion: params.expectedVersion,
      snapshotFileId: saved.value.id,
      snapshotHash: hash,
      operationClock: officeStateVector(snapshotToYDoc(params.snapshot)),
      schemaVersion: params.snapshot.schemaVersion,
      capabilityVersion: params.snapshot.capabilityVersion,
      origin: params.kind === 'generation' ? 'generation' : 'ai',
      authorType: params.job.assistantId ? 'assistant' : 'system',
      authorAssistantId: params.job.assistantId ?? undefined,
      summary: params.kind === 'generation' ? 'Office artifact generated' : 'Brian revision',
      checkpointKind: params.kind,
    })
    if (!committed) {
      await filesApi.delete(fileContext, saved.value.id).catch(() => undefined)
      throw new Error('Office snapshot version conflict')
    }
    const liveResult = await replaceLiveOfficeSnapshot(params.snapshot, { expectedVersion: committed.version, canonicalHash: hash })
    if (liveResult === 'disabled') {
      await officeLiveStore.initialize({ userId: params.job.initiatedByUserId, artifactId: params.job.artifactId, snapshot: params.snapshot })
    }
    return committed
  }
  const officeTemplateBundleReader = filesApi ? createOfficeTemplateBundleReader({ filesApi, templates: officeTemplateStore, artifacts: officeArtifactStore }) : null
  const readOfficeTemplateBundle: NonNullable<typeof officeTemplateBundleReader> = async (...args) => officeTemplateBundleReader ? officeTemplateBundleReader(...args) : null
  const createGenerationRunner = (userId: string) => createOfficeGenerationWorker({
    store: officeGenerationStore,
    workerUserId: userId,
    async executePromptOnly(job,leaseToken) {
      if (!filesResolver) throw new Error('Office storage unavailable')
      await checkPromptOnlyAuthority(job,leaseToken)
      const runtime=await resolveBackgroundRuntime(job.workspaceId)
      await executePromptOnlyGeneration({job,leaseToken,provider:runtime?.provider ?? provider,model:runtime?.selector ?? BACKGROUND_MODEL,
        resolver:filesResolver,storageLimitBytes:ports.storageLimitBytesFor ? await ports.storageLimitBytesFor(job.workspaceId) : Number.POSITIVE_INFINITY})
    },
    buildPipelineDeps(job) {
      let templateSource: { versionId: string; revision: string } | undefined
      let fitPolicy: import('@use-brian/core/office/generation/pipeline.js').OfficeGenerationFitPolicy = { eligibleTargetIds: [], maxAttempts: 1 }
      const onFitPolicy = (policy: import('@use-brian/core/office/generation/pipeline.js').OfficeGenerationFitPolicy) => { fitPolicy = policy }
      return {
        fitRepairPolicy: () => fitPolicy,
        async resolveAuthority() {
          const membership = await getWorkspaceMembershipWithClearanceSystem(job.initiatedByUserId, job.workspaceId)
          if (!membership) return null
          const humanClearance = membership.clearance
          const clearance = job.assistantId ? minSensitivity(humanClearance, await getAssistantClearance(job.assistantId)) : humanClearance
          const projection = job.authorityProjection as { sensitivity?: unknown; visibilityUserIds?: unknown; compartments?: unknown; projectIds?: unknown; compartmentGrant?: unknown; projectGrant?: unknown; sourceHandles?: unknown }
          return {
            clearance,
            sensitivity: projection.sensitivity === 'public' || projection.sensitivity === 'confidential' ? projection.sensitivity : 'internal',
            visibilityUserIds: Array.isArray(projection.visibilityUserIds) ? projection.visibilityUserIds.filter((value): value is string => typeof value === 'string') : [],
            compartments: Array.isArray(projection.compartments) ? projection.compartments.filter((value): value is string => typeof value === 'string') : [],
            projectIds: Array.isArray(projection.projectIds) ? projection.projectIds.filter((value): value is string => typeof value === 'string') : [],
            compartmentGrant: projection.compartmentGrant === null
              ? null
              : Array.isArray(projection.compartmentGrant)
                ? projection.compartmentGrant.filter((value): value is string => typeof value === 'string')
                : null,
            projectGrant: projection.projectGrant === null
              ? null
              : Array.isArray(projection.projectGrant)
                ? projection.projectGrant.filter((value): value is string => typeof value === 'string')
                : null,
            sourceHandles: Array.isArray(projection.sourceHandles) ? projection.sourceHandles.filter((value): value is string => typeof value === 'string') : [],
          }
        },
        async selectTemplate(brief, authority) {
          if (!brief.templateId) return { ambiguous: [] }
          let sourceScope: import('../office/file-binding.js').OfficeOutputScope | undefined
          const template = await readOfficeTemplateBundle(job.initiatedByUserId, job.workspaceId, brief.templateId, (scope, revision) => {
            sourceScope = scope
            templateSource = { versionId: brief.templateId!, revision }
          }, { assistantId: brief.assistantId, clearance: authority.clearance ?? authority.sensitivity, compartments: authority.compartmentGrant, projectIds: authority.projectGrant })
          return template ? { template, sourceScope } : { ambiguous: [] }
        },
        async retrieveBrain(brief, authority) {
          const context = {
            workspaceId: job.workspaceId,
            userId: job.initiatedByUserId,
            assistantId: brief.assistantId,
            assistantKind: 'app' as const,
            clearance: authority.sensitivity,
            compartments: authority.compartmentGrant ?? null,
            projectIds: authority.projectGrant ?? null,
          }
          const explicitIds = brief.sourceHandles.flatMap((handle) => {
            const match = handle.match(/^knowledge:([0-9a-f-]{36})$/i)
            return match?.[1] ? [match[1]] : []
          })
          const stopwords = new Set(['about', 'after', 'again', 'also', 'and', 'audience', 'create', 'deck', 'for', 'from', 'generate', 'help', 'intro', 'introduction', 'into', 'make', 'presentation', 'public', 'slide', 'slides', 'that', 'the', 'this', 'to', 'with'])
          const terms = [...new Set(`${brief.outcome} ${brief.audience} ${brief.additionalContext ?? ''}`.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])]
            .filter((term) => !stopwords.has(term))
            .slice(0, 8)
          const [explicit, searched] = await Promise.all([
            Promise.all(explicitIds.map((id) => knowledgeStore.getById(context, id).catch(() => null))),
            Promise.all(terms.map((term) => knowledgeStore.search(context, term, 4).catch(() => []))),
          ])
          const entries = new Map([...explicit.filter((entry) => entry !== null), ...searched.flat()].map((entry) => [entry.id, entry]))
          const evidence = [...entries.values()].slice(0, 12).map((entry) => ({
            handle: `knowledge:${entry.id}`,
            excerpt: [entry.title, entry.summary, entry.content].filter(Boolean).join('\n').slice(0, 4_000),
            sensitivity: entry.sensitivity,
            compartments: entry.compartments,
            projectIds: entry.projectIds,
          }))
          await bindDepartmentOfficeKnowledge(job,evidence)
          return evidence
        },
        async inspectUrl(url) {
          const response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'UseBrian-Office/1.0' } })
          if (!response.ok) throw new Error(`Reference URL returned ${response.status}`)
          const excerpt = (await response.text()).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8_000)
          return [{ url, excerpt }]
        },
        async planClaims(brief, evidence) {
          return [
            { objectHint: brief.family, text: brief.outcome, classification: 'user_attested' as const, confidence: 1, sourceHandles: brief.sourceHandles },
            ...(brief.additionalContext ? [{ objectHint: brief.family, text: brief.additionalContext, classification: 'user_attested' as const, confidence: 1, sourceHandles: brief.sourceHandles }] : []),
            ...evidence.brain.map((entry) => ({ objectHint: brief.family, text: entry.excerpt.slice(0, 1_000), classification: 'evidence_supported' as const, confidence: 0.9, sourceHandles: [entry.handle] })),
            ...evidence.website.map((entry) => ({ objectHint: brief.family, text: entry.excerpt.slice(0, 1_000), classification: 'evidence_supported' as const, confidence: 0.8, sourceHandles: [entry.url] })),
          ].slice(0, 100)
        },
        async construct(brief, evidence, claims, template) {
          const brandVoice = await resolveBrandVoice(job.initiatedByUserId, job.workspaceId)
          const runtime = await resolveBackgroundRuntime(job.workspaceId)
          const generationProvider = runtime?.provider ?? provider
          const generationModel = runtime?.selector ?? BACKGROUND_MODEL
          if (brief.family === 'document') return generateDocumentFromTemplate({ onFitPolicy, provider: generationProvider, model: generationModel, artifactId: job.artifactId, workspaceId: job.workspaceId, templateVersionId: template.id, outcome: brief.outcome, audience: brief.audience, additionalContext: brief.additionalContext, template, brandVoice })
          if (brief.family === 'presentation') return generatePresentationFromTemplate({ onFitPolicy, provider: generationProvider, model: generationModel, artifactId: job.artifactId, workspaceId: job.workspaceId, templateVersionId: template.id, outcome: brief.outcome, audience: brief.audience, additionalContext: brief.additionalContext, evidence, claims, template, brandVoice })
          return generateSpreadsheetFromTemplate({ provider: generationProvider, model: generationModel, artifactId: job.artifactId, workspaceId: job.workspaceId, templateVersionId: template.id, outcome: brief.outcome, audience: brief.audience, additionalContext: brief.additionalContext, evidence, template, brandVoice })
        },
        async processMedia(snapshot) { return snapshot },
        async resolveResource(resourceId) {
          const resource = await officeTemplateStore.getResource(job.initiatedByUserId, resourceId)
          if (!resource?.fileId || resource.workspaceId !== job.workspaceId) return null
          const read = await filesApi!.readBytes({ workspaceId: job.workspaceId, userId: job.initiatedByUserId, assistantKind: 'standard', clearance: 'confidential' }, resource.fileId)
          return read.ok ? { bytes: read.value.bytes, mime: resource.mime } : null
        },
        async cancelled() { return Boolean((await officeGenerationStore.get(job.initiatedByUserId, job.id))?.cancelRequestedAt) },
        async commit(snapshot, { authority }) {
          if (!templateSource) throw new Error('Office template source unavailable')
          let revision: string | undefined
          await readOfficeTemplateBundle(job.initiatedByUserId, job.workspaceId, templateSource.versionId, (_scope, value) => { revision = value })
          if (revision !== templateSource.revision) throw new Error('Office template classification changed; start generation again')
          const committed = await commitGeneratedOfficeSnapshot({ job, snapshot, expectedVersion: 0, kind: 'generation', authority })
          return { artifactId: job.artifactId, version: committed.version }
        },
      }
    },
  })
  /**
   * The brand voice fragment for an Office generation or revision.
   *
   * Office generation builds its own system prompts and never routes through
   * `buildFullSystemPrompt`, so the `# Brand` L1 block never reached it: the
   * assistant honoured the brand voice in chat and ignored it when generating
   * the company's documents. Resolved per job, best-effort — a brand read
   * failing must not fail a generation, and no approved brand adds nothing.
   */
  const resolveBrandVoice = async (userId: string, workspaceId: string): Promise<string | null> => {
    try {
      const record = (await getBrandStore().get(userId, workspaceId))?.activeRecord ?? null
      return buildBrandVoiceFragment(record)
    } catch (err) {
      console.warn('[office] brand voice lookup failed:', err)
      return null
    }
  }

  const officeRevisionWorker = filesApi ? createOfficeRevisionWorker({
    get: officeGenerationStore.get,
    claim: officeGenerationStore.claim,
    getSnapshot: officeLiveStore.get,
    async revise({ snapshot, targetIds, instruction, currentVersion, versionDrifted, job }) {
      if (snapshot.family === 'pdf' && versionDrifted) throw new Error('revision_version_conflict')
      const brandVoice = await resolveBrandVoice(job.initiatedByUserId, job.workspaceId)
      const runtime = await resolveBackgroundRuntime(job.workspaceId)
      const role = (job.authorityProjection as { role?: unknown }).role === 'comment' ? 'comment' as const : 'edit' as const
      const assistantId = job.assistantId ?? APP_LEVEL_ASSISTANT_ID
      const template = snapshot.templateVersionId ? await readOfficeTemplateBundle(job.initiatedByUserId, job.workspaceId, snapshot.templateVersionId) : null
      if (snapshot.templateVersionId && !template) throw new Error('Revision template lock policy is unavailable')
      const lockedTargetIds = [...(template?.lockedObjectIds ?? []), ...(template?.fields.filter(field => field.locked).flatMap(field => field.targetIds) ?? [])]
      const revision = await runOfficeEdit({
        artifactId: job.artifactId,
        assistantId,
        baseVersion: currentVersion,
        currentVersion,
        role,
        instruction,
        targetIds,
        changedObjectIdsSinceBase: versionDrifted ? targetIds : [],
        threadExcerpt: [],
        templateConstraints: [],
        evidencePacket: [],
        snapshot,
      }, ({ instruction: nextInstruction, targetIds: nextTargetIds, snapshot: nextSnapshot }) => generateAssistantOfficeCommands({
        provider: runtime?.provider ?? provider,
        model: runtime?.selector ?? BACKGROUND_MODEL,
        snapshot: nextSnapshot,
        baseVersion: currentVersion,
        assistantId,
        targetIds: nextTargetIds,
        lockedTargetIds,
        instruction: nextInstruction,
        operations: (job.brief as {commandOperations?:unknown[]}).commandOperations,
        brandVoice,
        // The command planner derives bounded repair eligibility from the
        // selected scope (including explicit section/slide descendants).
        async validateCandidate(candidate) {
          if (candidate.family === 'pdf') {
            if (!pdfSessionService) throw new Error('PDF session revision runtime is unavailable')
            // Full writer + independent reopen validation also runs in the
            // atomic commit. This pre-commit pass keeps a bad candidate out of
            // the revision result before any session-owned snapshot is stored.
            const current = await officeLiveStore.get(job.initiatedByUserId, job.artifactId)
            if (!current || current.baseVersion !== currentVersion) throw new Error('revision_version_conflict')
            const source = await pdfSessionService.readSource(job.initiatedByUserId, job.artifactId)
            const assets = await officePdfSessionStore.listAssets(job.initiatedByUserId, job.artifactId)
            const writer = createPdfWriterPort({ resolveResource: async resourceId => {
              const tracked = assets.find(asset => asset.fileId === resourceId && asset.role === 'signature')
              if (!tracked || !pdfSessionAssets) return null
              const value = await pdfSessionAssets.read({ userId: job.initiatedByUserId, workspaceId: job.workspaceId, fileId: resourceId })
              if (!value || value.file.sha256 !== tracked.contentSha256 || value.file.mime !== 'image/png') return null
              return { bytes: value.bytes, mime: value.file.mime, sha256: tracked.contentSha256 }
            } })
            await validateRenderedPdf(candidate, await writer.render(source.bytes, candidate))
            return
          }
          const { validateOfficeInternalCandidateRendering } = await import('../office/render-validation.js')
          const rendered = await validateOfficeInternalCandidateRendering({
            snapshot: candidate,
            fitBudget: { readabilityReference: nextSnapshot },
            resolveResource: resourceId => readOfficeResource(job.initiatedByUserId, job.workspaceId, resourceId),
          })
          if (!rendered.receipt.ok) throw new Error(`Office revision rendering failed: ${rendered.receipt.issues.map(i => `${i.code}: ${i.message}`).join('; ')}`)
        },
      }))
      return { ...revision, affectedObjectIds: [...new Set([...revision.affectedObjectIds, ...revision.commands.flatMap(command => command.kind === 'appendSpreadsheetRecords' ? [command.tableId] : [])])] }
    },
    async commit({ job, snapshot, expectedVersion, expectedSeq }) {
      return (await commitGeneratedOfficeSnapshot({ job, snapshot, expectedVersion, expectedSeq, kind: 'revision' })).version
    },
    async propose({ job, baseVersion, commands, affectedObjectIds }) {
      const head = await officeArtifactStore.getHeadVersion(job.initiatedByUserId, job.artifactId)
      if (!head || head.version !== baseVersion) throw new Error('Office revision proposal version conflict')
      const commandBatch = commands.length === 1 ? commands[0]! : {
        commandId: randomUUID(), artifactId: job.artifactId, baseVersion,
        actor: { type: 'assistant' as const, id: job.assistantId ?? APP_LEVEL_ASSISTANT_ID }, origin: 'ai' as const,
        kind: 'batch' as const, commands,
      }
      await officeCommentStore.createSuggestion({
        userId: job.initiatedByUserId,
        workspaceId: job.workspaceId,
        artifactId: job.artifactId,
        baseVersionId: head.id,
        proposedByType: 'assistant',
        proposedByAssistantId: job.assistantId ?? undefined,
        commandBatch,
        affectedObjectIds,
      })
    },
    appendEvent: officeGenerationStore.appendEvent,
    finish: officeGenerationStore.finish,
  }) : null
  if (filesApi) late.wakeOfficeGeneration = (userId: string) => {
    void (async () => {
      const generation = createGenerationRunner(userId)
      while (await generation.runOnce() !== 'idle') { /* drain creation jobs for this member */ }
      while (officeRevisionWorker && await officeRevisionWorker(userId)) { /* drain revision jobs for this member */ }
    })().catch((error) => console.error('[office-generation-worker]', error))
  }
  const wakeImport = (userId: string) => {
    if (officeImportWorker) void (async () => {
      while (await officeImportWorker(userId)) { /* drain eligible imports for this member */ }
    })().catch((error) => console.error('[office-import-worker]', error))
  }
  const wakeTemplateCompile = (userId: string) => {
    if (officeTemplateCompileWorker) void (async () => {
      while (await officeTemplateCompileWorker(userId)) { /* drain eligible template compilations for this member */ }
    })().catch((error) => console.error('[office-template-compile-worker]', error))
  }
  // Per-job progress stream (office.md "Live job progress"). Mounted after the
  // wakers so a stalled job resumes for its initiator when anyone looks at it.
  startOfficeJobEventBus()
  app.use('/api/office', requireAuth(env.JWT_SECRET), officeJobStreamRoutes({
    read: officeJobStreamRead(officeGenerationStore),
    wake: job => {
      if (job.jobKind === 'import') wakeImport(job.initiatedByUserId)
      else if (job.jobKind === 'template_compile') wakeTemplateCompile(job.initiatedByUserId)
      else if (job.jobKind === 'create' || job.jobKind === 'revise') late.wakeOfficeGeneration?.(job.initiatedByUserId)
    },
  }))
  const retryOfficeTemplateImport = createTemplateImportRecovery({
    getJob: officeGenerationStore.get,
    getArtifact: officeArtifactStore.get,
    canEdit: async (userId, artifactId) => Boolean((await resolveOfficeAccess(userId, artifactId))?.canEdit),
    readSource: async input => readBoundOfficeFile ? readBoundOfficeFile(input) : null,
    retry: officeGenerationStore.retryTemplateImport,
    wake: wakeTemplateCompile,
  })
  late.retryOfficeTemplateImport = retryOfficeTemplateImport
  const readPublishedOfficeTemplate = createPublishedOfficeTemplateReader({
    getTemplate: officeTemplateStore.get,
    getVersion: officeTemplateStore.getVersion,
    readBundle: readOfficeTemplateBundle,
  })
  app.use('/api/office', requireAuth(env.JWT_SECRET), officeTemplateRoutes({
    readPublished: readPublishedOfficeTemplate,
    list: officeTemplateStore.list,
    retryImport: retryOfficeTemplateImport,
    getTemplate: officeTemplateStore.get,
    getArtifact: officeArtifactStore.get,
    getSnapshot: officeLiveStore.get,
    createDraft: officeTemplateStore.createDraft,
    createTemplateShell: officeArtifactStore.createShell,
    initializeDraft: officeLiveStore.initializeIfMissing,
    getDraftRouting: officeTemplateStore.getDraftRouting,
    saveDraftRouting: officeTemplateStore.saveDraftRouting,
    deleteEmptyDraft: officeTemplateStore.deleteEmptyDraft,
    deleteEmptyShell: officeArtifactStore.deleteEmptyShell,
    createCompileJob: officeGenerationStore.create,
    wakeCompile: wakeTemplateCompile,
    transitionLifecycle: officeTemplateStore.transitionLifecycle,
  }))
  app.use('/api/office', requireAuth(env.JWT_SECRET), officeCollaborationRoutes({
    getArtifact: officeArtifactStore.get,
    resolveAccess: resolveOfficeAccess,
    resolveCollaborationAccess: resolveDurableOfficeAccess,
    getSnapshot: officeLiveStore.get,
    appendCommand: officeLiveStore.appendCommand,
    listThreads: officeCommentStore.listThreads,
    getThreadContext: officeCommentStore.getThreadContext,
    getMessageContext: officeCommentStore.getMessageContext,
    ensureCommentVersion: createOfficeCommentVersionResolver({
      getLive: officeLiveStore.getOfflineSource,
      getArtifact: officeArtifactStore.get,
      anchorDraft: officeArtifactStore.anchorDraft,
      canComment: async (userId, artifactId) => Boolean((await resolveDurableOfficeAccess(userId, artifactId))?.canComment),
      persist: createOfficeCommentAnchorWriter({
        filesApi,
        membership: getWorkspaceMembershipWithClearanceSystem,
        authorizePath: async (userId, workspaceId, path) => {
          const result = await queryWithRLS<{ allowed: boolean }>(userId,
            'SELECT office_anchor_file_scope_allows($1,$2,true) AS allowed', [workspaceId, path])
          return result.rows[0]?.allowed === true
        },
      }),
    }),
    createThread: officeCommentStore.createThread,
    reply: officeCommentStore.reply,
    resolve: officeCommentStore.resolve,
    updateThread: officeCommentStore.updateThread,
    react: officeCommentStore.react,
    detachMissingTargets: officeCommentStore.detachMissingTargets,
    listSuggestions: officeCommentStore.listSuggestions,
    getSuggestion: officeCommentStore.getSuggestion,
    verifyEvidenceSuggestion: async (userId, suggestionId, command) =>
      await structuredDocumentRuntime?.verifySuggestion(userId, suggestionId, command) ?? false,
    suggestionAlreadyApplied: (userId, artifactId, suggestionId) => officeSuggestionApplied(userId, artifactId, suggestionId),
    createSuggestion: officeCommentStore.createSuggestion,
    decideSuggestion: officeCommentStore.decideSuggestion,
    async applySuggestion({ userId, artifactId, suggestionId, command }) {
      const result = await applyLiveOfficeSuggestion(userId, artifactId, suggestionId, command)
      if (result === 'disabled') throw new Error('Office suggestion application requires doc-sync')
      return result
    },
    service: officeService,
  }))
  app.use('/api/office', requireAuth(env.JWT_SECRET), officeImportRoutes({
    available: () => Boolean(officeImportWorker),
    createShell: officeArtifactStore.createShell,
    deleteEmptyShell: officeArtifactStore.deleteEmptyShell,
    createJob: officeGenerationStore.create,
    wake: wakeImport,
  }))
  app.use('/', internalOfficeCheckpointRoutes({
    sharedSecret: process.env.DOC_SYNC_SECRET,
    async checkpoint(artifactId, expectedVersion, canonicalHash) {
      if (!filesApi) return 'not_found'
      const raw = await query<{ id: string; workspaceId: string; ownerUserId: string; mode: 'artifact' | 'template' | 'session'; headVersion: number; headSnapshotHash: string | null; compartments: string[]; projectIds: string[] }>(`
        SELECT a.id,a.workspace_id AS "workspaceId",a.owner_user_id AS "ownerUserId",
               a.mode,a.head_version::int AS "headVersion",v.snapshot_hash AS "headSnapshotHash",
               a.compartments, a.project_ids AS "projectIds"
          FROM office_artifacts a
          LEFT JOIN office_artifact_versions v ON v.id=a.head_version_id
         WHERE a.id=$1 AND a.lifecycle_state='active'
      `, [artifactId])
      const artifact = raw.rows[0]
      if (!artifact) return 'not_found'
      const live = await officeLiveStore.getOfflineSource(artifact.ownerUserId, artifactId)
      if (!live) return 'not_found'
      const bytes = new TextEncoder().encode(JSON.stringify(live.snapshot))
      const actualHash = createHash('sha256').update(bytes).digest('hex')
      if (actualHash !== canonicalHash) return 'conflict'
      // Legacy initialization could hash the input snapshot's serialization.
      // Only repair that metadata if the exact verified Y.Doc still owns the row.
      const rebase = (version: number) => query(`WITH current_head AS MATERIALIZED (
          SELECT id FROM office_artifacts WHERE id=$1 AND head_version=$2 AND owner_user_id=$6
            AND lifecycle_state='active' FOR SHARE
        ) UPDATE office_collab_documents d
        SET base_version=$2, canonical_hash=CASE WHEN d.seq=$3 AND d.ydoc=$4 THEN $5 ELSE d.canonical_hash END,
            updated_at=now()
        FROM current_head h WHERE d.artifact_id=h.id AND d.base_version<=$2`,
        [artifactId, version, live.seq, Buffer.from(live.update), canonicalHash, artifact.ownerUserId])
      // Replacing a connected Y.Doc after generation/revision dirties the
      // in-memory document even though its materialized bytes already ARE the
      // immutable head. Rebase the live row and acknowledge that settle
      // without appending a duplicate manual checkpoint.
      if (artifact.headSnapshotHash === canonicalHash) {
        await rebase(artifact.headVersion)
        return { version: artifact.headVersion }
      }
      // A prior settle may have advanced the immutable head while this newer
      // settle was already in flight. The API updates live.baseVersion after
      // every successful checkpoint, so rebasing is safe only when that live
      // base equals the current head and the requested hash is still the exact
      // live hash. Otherwise this remains a hard CAS conflict.
      const casVersion = artifact.headVersion === expectedVersion ? expectedVersion : live.baseVersion === artifact.headVersion ? artifact.headVersion : null
      if (casVersion === null) return 'conflict'
      const fileContext = { workspaceId: artifact.workspaceId, userId: artifact.ownerUserId, assistantKind: 'standard' as const, clearance: 'confidential' as const, writeCompartments: artifact.compartments, writeProjectIds: artifact.projectIds }
      const session = artifact.mode === 'session'
      const saved = await filesApi.writeBytes(fileContext, { path: session
        ? `/office/sessions/${artifactId}/snapshot/${casVersion + 1}-${canonicalHash}.json`
        : `/office/artifacts/${artifactId}/versions/${casVersion + 1}-${canonicalHash}.json`,
        bytes, mime: 'application/json', sensitivity: 'confidential', ...(session ? { sessionOwned: true as const } : {}) })
      if (!saved.ok) throw new Error(`Office checkpoint save failed: ${saved.error.kind}`)
      if (session && !await officePdfSessionStore.trackAsset({ userId: artifact.ownerUserId, artifactId, fileId: saved.value.id, role: 'snapshot', contentSha256: canonicalHash })) {
        throw new Error('PDF session checkpoint tracking failed')
      }
      const version = await officeArtifactStore.commitVersion({ userId: artifact.ownerUserId, artifactId, snapshotTitle: live.snapshot.title, expectedVersion: casVersion, snapshotFileId: saved.value.id, snapshotHash: canonicalHash, operationClock: live.stateVector, schemaVersion: live.snapshot.schemaVersion, capabilityVersion: live.snapshot.capabilityVersion, origin: 'manual', authorType: 'system', summary: 'Collaborative editing checkpoint' })
      if (!version) {
        await filesApi.delete(fileContext, saved.value.id).catch(() => undefined)
        return 'conflict'
      }
      await rebase(version.version)
      return { version: version.version }
    },
  }))
  const readOfficeResource = officeReleaseRuntime?.readOfficeResource ?? (async () => null)
  if (filesApi) app.use('/api/office', requireAuth(env.JWT_SECRET), officeResourceRoutes({
    async load(userId, artifactId, published) {
      const [artifact, access, live] = await Promise.all([
        officeArtifactStore.get(userId, artifactId),
        resolveDurableOfficeAccess(userId, artifactId),
        officeLiveStore.get(userId, artifactId),
      ])
      if (!artifact || !access) return null
      if (published) {
        const template = await officeTemplateStore.get(userId, published.templateId)
        if (template?.draftArtifactId !== artifactId) return null
        const source = await readPublishedOfficeTemplate(userId, published.templateId, published.versionId)
        return source ? { artifact, access, snapshot: source.bundle.snapshot } : null
      }
      return live ? { artifact, access, snapshot: live.snapshot } : null
    },
    async readUpload(userId, workspaceId, fileId) {
      return readBoundOfficeFile!({ userId, workspaceId, fileId })
    },
    async persistImage({ userId, workspaceId, scope, image }) {
      const path = `/office/resources/${officeScopePathSegment(scope)}/${image.hash}`
      const fileId = await saveClassifiedOfficeFile!({ userId, workspaceId, path, bytes: image.bytes, mime: image.mime, hash: image.hash, scope })
      return officeTemplateStore.addResource({
        userId,
        workspaceId,
        kind: 'brand_media',
        name: `Uploaded image ${image.hash.slice(0, 12)}`,
        fileId,
        hash: image.hash,
        mime: image.mime,
        licence: { name: 'Workspace-uploaded image', provenance: 'workspace-upload' },
        provenance: { source: 'workspace-upload', normalized: true },
        embeddingRights: 'allowed',
        sensitivity: scope.sensitivity,
      })
    },
    readResource: readOfficeResource,
  }))
  const loadOfficeReleaseContext = async (userId: string, artifactId: string) => officeReleaseRuntime ? officeReleaseRuntime.loadOfficeReleaseContext(userId, artifactId) : null
  const revalidateOfficeRelease: import('../routes/office-releases.js').OfficeReleaseRouteDeps['revalidate'] = async (params) =>
    officeReleaseRuntime ? officeReleaseRuntime.revalidateOfficeRelease(params) : null
  const officeReleaseDeps: import('../routes/office-releases.js').OfficeReleaseRouteDeps | null = filesApi ? {
    load: loadOfficeReleaseContext,
    resolveResource: (userId, workspaceId) => async (resourceId) => readOfficeResource(userId, workspaceId, resourceId),
    revalidate: revalidateOfficeRelease,
    async saveReleasedFile(params) {
      const { userId, workspaceId, artifactId, version, action, extension, mime, bytes, scope, session } = params
      if (session && pdfSessionAssets) {
        return (await pdfSessionAssets.write({ userId, workspaceId,
          path: `/office/sessions/${artifactId}/release/v${version}-${action}-${randomUUID()}.${extension}`,
          bytes, mime, sensitivity: scope.sensitivity, compartments: scope.compartments, projectIds: scope.projectIds,
          metadata: PDF_SESSION_FILE_METADATA })).id
      }
      return officeReleaseRuntime!.saveOfficeReleaseFile(params)
    },
    async loadPdf({ userId, context }) {
      if (!pdfSessionService || !pdfSessionAssets || context.snapshot.family !== 'pdf') return null
      const source = await pdfSessionService.readSource(userId, context.artifact.id)
      const assets = await officePdfSessionStore.listAssets(userId, context.artifact.id)
      return { sourceBytes: source.bytes, writer: createPdfWriterPort({ resolveResource: async resourceId => {
        const tracked = assets.find(asset => asset.fileId === resourceId && asset.role === 'signature')
        if (!tracked) return null
        const value = await pdfSessionAssets.read({ userId, workspaceId: context.artifact.workspaceId, fileId: resourceId })
        if (!value || (value.file.mime !== 'image/png' && value.file.mime !== 'image/jpeg')) return null
        return { bytes: value.bytes, mime: value.file.mime, sha256: tracked.contentSha256 }
      } }) }
    },
    trackPdfRelease: ({ userId, artifactId, fileId, sha256 }) => officePdfSessionStore.trackAsset({ userId, artifactId, fileId, role: 'release', contentSha256: sha256 }),
    createRecord: officeReleaseStore.createRelease,
    async createDerivative({ userId, source, title, sensitivity, selectedObjectIds, visibilityUserIds }) {
      if (!isDurableOfficeArtifact(source.artifact)) throw new Error('PDF sessions cannot create Office derivatives')
      const shell = await officeArtifactStore.createShell({ userId, workspaceId: source.artifact.workspaceId, family: source.artifact.family, title, templateVersionId: source.artifact.templateVersionId, capabilityVersion: source.artifact.capabilityVersion, sensitivity, visibilityUserIds, requiredCompartments: source.artifact.compartments, projectIds: source.artifact.projectIds })
      const snapshot = deriveOfficeSnapshot({ source: source.snapshot, artifactId: shell.id, title, selectedObjectIds: selectedObjectIds.length ? selectedObjectIds : undefined })
      const bytes = new TextEncoder().encode(JSON.stringify(snapshot))
      const hash = createHash('sha256').update(bytes).digest('hex')
      const saved = await filesApi!.writeBytes({ workspaceId: shell.workspaceId, userId, assistantKind: 'standard', clearance: 'confidential', writeCompartments: shell.compartments, writeProjectIds: shell.projectIds }, { path: `/office/artifacts/${shell.id}/versions/1-${hash}.json`, bytes, mime: 'application/json', sensitivity })
      if (!saved.ok) throw new Error(`Office derivative snapshot save failed: ${saved.error.kind}`)
      const doc = snapshotToYDoc(snapshot)
      const version = await officeArtifactStore.commitVersion({ userId, artifactId: shell.id, snapshotTitle: snapshot.title, expectedVersion: 0, snapshotFileId: saved.value.id, snapshotHash: hash, operationClock: officeStateVector(doc), schemaVersion: snapshot.schemaVersion, capabilityVersion: snapshot.capabilityVersion, origin: 'manual', authorType: 'user', authorUserId: userId, summary: `Reviewed derivative of ${source.artifact.id}`, checkpointKind: 'release' })
      if (!version) throw new Error('Office derivative version conflict')
      await Promise.all([
        officeLiveStore.initialize({ userId, artifactId: shell.id, snapshot }),
        officeArtifactStore.addSource({ userId, artifactId: shell.id, artifactVersionId: version.id, workspaceId: shell.workspaceId, sourceArtifactId: source.artifact.id, sourceVersion: String(source.artifact.headVersion), sensitivity }),
      ])
      return { artifactId: shell.id, version: version.version }
    },
  } : null
  late.officeReleaseDeps = officeReleaseDeps
  if (officeReleaseDeps) app.use('/api/office', requireAuth(env.JWT_SECRET), officeReleaseRoutes(officeReleaseDeps))
  if (officeReleaseDeps && filesApi && officeTemplateBundleReader) {
    crmDocumentRuntime.binding = createCrmOfficeBindingFromOffice({ filesApi, artifacts: officeArtifactStore, live: officeLiveStore,
      readTemplateBundle: (userId, workspaceId, versionId) => officeTemplateBundleReader(userId, workspaceId, versionId), releaseDeps: officeReleaseDeps })
  }
  app.use('/api/office', requireAuth(env.JWT_SECRET), officeLifecycleRoutes(officeLifecycle))
  const loadOfficeOfflineContext = async (userId: string, artifactId: string) => {
    const reply = await readOfficeProjection(userId, async () => {
      const [artifact, access, live, comments, history] = await Promise.all([
        officeArtifactStore.get(userId, artifactId),
        resolveDurableOfficeAccess(userId, artifactId),
        officeLiveStore.getOfflineSource(userId, artifactId),
        officeCommentStore.listThreads(userId, artifactId),
        officeArtifactStore.listVersions(userId, artifactId),
      ])
      return artifact && access && live
        ? { workspaceId: artifact.workspaceId, body: { artifact, access, snapshot: live.snapshot, update: live.update, stateVector: live.stateVector, seq: live.seq, comments, history } }
        : { status: 404, body: { error: 'Office artifact not found' } }
    })
    return (reply.status ?? 200) < 400 && reply.validForMs && typeof reply.body === 'object'
      ? { ...(reply.body as Omit<import('../routes/office-offline.js').OfficeOfflineContext, 'validForMs'>), validForMs: reply.validForMs }
      : null
  }
  if (filesApi) app.use('/api/office', requireAuth(env.JWT_SECRET), officeOfflineRoutes({
    signingSecret: env.JWT_SECRET,
    load: loadOfficeOfflineContext,
    getArtifact: officeArtifactStore.get,
    readResource: readOfficeResource,
    async revalidatePackage({ userId, expected, resourceBindings, packageFileId, packageHash }) {
      const current = await loadOfficeOfflineContext(userId, expected.artifact.id)
      if (!current || officeOfflineContextRevision(current) !== officeOfflineContextRevision(expected) || resourceBindings.length !== current.snapshot.resources.length) return null
      const resources = await Promise.all(current.snapshot.resources.map((ref, index) => readOfficeResource(userId, current.artifact.workspaceId, ref.id).then(resource =>
        resource && resource.hash === ref.hash && resource.mime === ref.mime && sameOfficeFileBinding(resource.binding, resourceBindings[index]!) ? resource : null)))
      if (resources.some(resource => !resource)) return null
      const scope = classifyOfficeOutput({ sensitivity: current.artifact.sensitivity, compartments: current.artifact.compartments, projectIds: current.artifact.projectIds }, ...resourceBindings)
      let validForMs = Math.min(current.validForMs, ...resources.map(resource => resource!.validForMs))
      if (packageFileId) {
        const output = await readBoundOfficeFile!({ userId, workspaceId: current.artifact.workspaceId, fileId: packageFileId })
        if (!output || output.binding.hash !== packageHash || output.binding.mime !== 'application/json' || officeOutputScopeRevision(output.binding) !== officeOutputScopeRevision(scope)) return null
        validForMs = Math.min(validForMs, output.validForMs)
      }
      return Number.isFinite(validForMs) && validForMs > 0 ? { scope, validForMs: Math.floor(validForMs) } : null
    },
    async savePackage({ userId, workspaceId, artifactId, deviceId, bytes, hash, scope }) {
      return saveClassifiedOfficeFile!({ userId, workspaceId, path: `/office/offline/${artifactId}/${officeScopePathSegment(scope)}/${encodeURIComponent(deviceId)}-${hash}.json`, bytes, mime: 'application/json', hash, scope })
    },
    upsert: officeReleaseStore.upsertOfflinePackage,
    getPackage: officeReleaseStore.getOfflinePackage,
    resolveAccess: resolveDurableOfficeAccess,
    syncCommands: officeLiveStore.appendOfflineCommands,
    async createRecovery({ userId, artifactId, sourceVersionId, title, snapshot: sourceSnapshot }) {
      const [artifact, access, sourceVersion] = await Promise.all([
        officeArtifactStore.get(userId, artifactId),
        resolveDurableOfficeAccess(userId, artifactId),
        officeArtifactStore.getVersionSource(userId, artifactId, sourceVersionId),
      ])
      if (!artifact || !isDurableOfficeArtifact(artifact) || !access?.canEdit || artifact.lifecycleState !== 'active' || !sourceVersion || sourceVersion.workspaceId !== artifact.workspaceId) return null
      const initialRevision = JSON.stringify({ artifact, access, sourceVersion })
      const resourceReads = await Promise.all(sourceSnapshot.resources.map(async ref => {
        const resource = await readOfficeResource(userId, artifact.workspaceId, ref.id)
        return resource && resource.hash === ref.hash && resource.mime === ref.mime ? resource : null
      }))
      if (resourceReads.some(resource => !resource)) return null
      const scope = classifyOfficeOutput({ sensitivity: artifact.sensitivity, compartments: artifact.compartments, projectIds: artifact.projectIds }, ...resourceReads.map(resource => resource!.binding))
      const recoveryArtifactId = randomUUID(), recoveryVersionId = randomUUID()
      const snapshot = deriveOfficeSnapshot({ source: sourceSnapshot, artifactId: recoveryArtifactId, title })
      const bytes = new TextEncoder().encode(JSON.stringify(snapshot))
      const hash = createHash('sha256').update(bytes).digest('hex')
      const fileId = await saveClassifiedOfficeFile!({ userId, workspaceId: artifact.workspaceId, path: `/office/artifacts/${recoveryArtifactId}/versions/1-${hash}.json`, bytes, mime: 'application/json', hash, scope })
      const [currentArtifact, currentAccess, currentSourceVersion, currentResources] = await Promise.all([
        officeArtifactStore.get(userId, artifactId),
        resolveDurableOfficeAccess(userId, artifactId),
        officeArtifactStore.getVersionSource(userId, artifactId, sourceVersionId),
        Promise.all(sourceSnapshot.resources.map(ref => readOfficeResource(userId, artifact.workspaceId, ref.id))),
      ])
      if (!currentArtifact || !isDurableOfficeArtifact(currentArtifact) || !currentAccess?.canEdit || !currentSourceVersion || JSON.stringify({ artifact: currentArtifact, access: currentAccess, sourceVersion: currentSourceVersion }) !== initialRevision ||
        currentResources.some((resource, index) => !resource || !sameOfficeFileBinding(resource.binding, resourceReads[index]!.binding))) return null
      const doc = snapshotToYDoc(snapshot)
      const created = await officeArtifactStore.createCopiedArtifact({ userId, artifactId: recoveryArtifactId, versionId: recoveryVersionId,
        workspaceId: artifact.workspaceId, family: artifact.family, title, templateVersionId: artifact.templateVersionId,
        capabilityVersion: artifact.capabilityVersion, sensitivity: scope.sensitivity, compartments: scope.compartments,
        projectIds: scope.projectIds, snapshotFileId: fileId, snapshotHash: hash, operationClock: officeStateVector(doc),
        schemaVersion: snapshot.schemaVersion, snapshotCapabilityVersion: snapshot.capabilityVersion,
        liveUpdate: encodeOfficeState(doc), liveStateVector: officeStateVector(doc), sourceArtifactId: artifactId, sourceVersionId })
      return created ? { artifactId: recoveryArtifactId } : null
    },
  }))

  return { officeSearchProjector } as const
}
