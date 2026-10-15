/** Classified Office file reads/writes and the exact-head release context.
 * Shared by the composition root and by in-process Office consumers (CRM
 * invoice issue) so one implementation serves every release caller.
 * [COMP:api/office-release] */
import { performance } from 'node:perf_hooks'
import type { BrandClaim } from '@use-brian/shared'
import { workspaceFileReadRevision, type createFilesApi } from '../files/files-api.js'

type FilesApi = ReturnType<typeof createFilesApi>
import { getWorkspaceMembershipWithClearanceSystem } from '../db/workspace-store.js'
import { getWorkspaceFileReadProjection } from '../db/workspace-files.js'
import { bindOfficeFile, classifyOfficeOutput, fileMatchesOfficeOutput, officeFileBindingRevision, officeOutputScopeRevision, type OfficeOutputScope } from './file-binding.js'
import { materializeOfficeTemplateBundleForGeneration } from './presentation-generation.js'
import type { Sensitivity } from '@use-brian/core'
import { createOfficeResourceReader } from './resource-read.js'
import { resolveOfficeAccess } from './access.js'
import { officeReleaseContextRevision, type OfficeReleaseContext } from '../routes/office-releases.js'
import type { createOfficeArtifactStore } from '../db/office-artifacts.js'
import type { createOfficeLiveStore } from '../db/office-live.js'
import type { createOfficeReleaseStore } from '../db/office-release.js'
import type { createOfficeTemplateStore } from '../db/office-templates.js'

export type OfficePdfSessionAssetReader = {
  read(params: { userId: string; workspaceId: string; fileId: string }): Promise<{ file: { mime: string; sha256: string } } & Record<string, unknown> | null>
}

export function createOfficeReleaseRuntime(deps: {
  filesApi: FilesApi
  artifacts: ReturnType<typeof createOfficeArtifactStore>
  live: ReturnType<typeof createOfficeLiveStore>
  releases: ReturnType<typeof createOfficeReleaseStore>
  templates: ReturnType<typeof createOfficeTemplateStore>
  brandClaims?: (userId: string, workspaceId: string) => Promise<readonly BrandClaim[] | undefined>
  /** Late-bound: PDF session assets are composed after this runtime. */
  pdfSessionAssets?: () => OfficePdfSessionAssetReader | null
}) {
  const { filesApi } = deps
  const readBoundOfficeFile = async (params: { userId: string; workspaceId: string; assistantId?: string | null; fileId: string }) => {
    const membership = await getWorkspaceMembershipWithClearanceSystem(params.userId, params.workspaceId)
    if (!membership) return null
    const clearance = membership.role === 'owner' || membership.role === 'admin' ? 'confidential' as const : membership.clearance
    const context = {
      workspaceId: params.workspaceId,
      userId: params.userId,
      assistantId: params.assistantId ?? null,
      assistantKind: 'standard' as const,
      clearance,
    }
    const read = await filesApi.readBytes(context, params.fileId)
    if (!read.ok || read.value.file.workspaceId !== params.workspaceId) return null
    const revision = workspaceFileReadRevision(read.value.file)
    const projectionStarted = performance.now()
    const projection = await getWorkspaceFileReadProjection({
      workspaceId: params.workspaceId,
      userId: params.userId,
      assistantId: params.assistantId ?? params.userId,
      assistantKind: 'standard',
      clearance,
    }, read.value.file.id)
    const validForMs = Math.floor(Math.min(30_000, projection?.validForMs ?? 0) - (performance.now() - projectionStarted))
    if (!projection || workspaceFileReadRevision(projection.file) !== revision || !Number.isFinite(validForMs) || validForMs <= 0) return null
    return { bytes: read.value.bytes, binding: bindOfficeFile(read.value.file, read.value.bytes), validForMs }
  }
  const saveClassifiedOfficeFile = async (params: {
    userId: string
    workspaceId: string
    path: string
    bytes: Uint8Array
    mime: string
    hash: string
    scope: OfficeOutputScope
  }): Promise<string> => {
    const membership = await getWorkspaceMembershipWithClearanceSystem(params.userId, params.workspaceId)
    if (!membership) throw new Error('Office output membership unavailable')
    const clearance = membership.role === 'owner' || membership.role === 'admin' ? 'confidential' as const : membership.clearance
    const context = {
      workspaceId: params.workspaceId,
      userId: params.userId,
      assistantKind: 'standard' as const,
      clearance,
      writeSensitivity: params.scope.sensitivity,
      writeCompartments: params.scope.compartments,
      writeProjectIds: params.scope.projectIds,
    }
    const existing = await filesApi.stat(context, params.path)
    if (existing.ok) {
      const read = await filesApi.readBytes(context, existing.value.id)
      if (!read.ok || !fileMatchesOfficeOutput(read.value.file, read.value.bytes, params)) {
        throw new Error('office_output_reuse_mismatch')
      }
      return read.value.file.id
    }
    const saved = await filesApi.writeBytes(context, {
      path: params.path,
      bytes: params.bytes,
      mime: params.mime,
      sensitivity: params.scope.sensitivity,
    })
    if (!saved.ok) throw new Error(`Office output save failed: ${saved.error.kind}`)
    return saved.value.id
  }
  const readOfficeResource = createOfficeResourceReader({
    filesApi, getResource: deps.templates.getResource,
    membership: getWorkspaceMembershipWithClearanceSystem,
    readProjection: getWorkspaceFileReadProjection,
  })
  const loadOfficeReleaseContext = async (userId: string, artifactId: string): Promise<OfficeReleaseContext | null> => {
    const [artifact, access, live, head] = await Promise.all([deps.artifacts.get(userId, artifactId), resolveOfficeAccess(userId, artifactId), deps.live.get(userId, artifactId), deps.artifacts.getHeadVersion(userId, artifactId)])
    if (!artifact || !access || !live) return null
    const [claims, media] = artifact.headVersionId ? await Promise.all([deps.releases.listClaims(userId, artifactId, artifact.headVersionId), deps.releases.listMedia(userId, artifactId, artifact.headVersionId)]) : [[], []]
    // The brand's APPROVED claims register (docs/architecture/features/brand.md
    // → "Claims reach the release gate"). Best-effort: a brand read failing must
    // not make a release impossible, and no brand simply contributes nothing.
    let brandClaims: readonly BrandClaim[] | undefined
    try {
      brandClaims = await deps.brandClaims?.(userId, artifact.workspaceId)
    } catch (err) {
      console.warn('[office-release] brand claims lookup failed:', err)
    }
    return { artifact: { ...artifact, headVersionId: head?.snapshotHash === live.canonicalHash ? artifact.headVersionId : null }, access, snapshot: live.snapshot, claims, brandClaims, media }
  }
  const revalidateOfficeRelease = async (params: {
    userId: string
    expected: OfficeReleaseContext
    releasedFileId?: string
    releasedHash?: string
    releasedMime?: string
  }): Promise<{ scope: OfficeOutputScope; validForMs: number } | null> => {
    const current = await loadOfficeReleaseContext(params.userId, params.expected.artifact.id)
    if (!current || officeReleaseContextRevision(current) !== officeReleaseContextRevision(params.expected)) return null
    const session = current.artifact.mode === 'session'
    const pdfSessionAssets = deps.pdfSessionAssets?.() ?? null
    const resourceReads = await Promise.all(current.snapshot.resources.map(async (ref) => {
      if (session && pdfSessionAssets) {
        const resource = await pdfSessionAssets.read({ userId: params.userId, workspaceId: current.artifact.workspaceId, fileId: ref.id })
        return resource && resource.file.mime === ref.mime && resource.file.sha256 === ref.hash ? resource : null
      }
      const resource = await readOfficeResource(params.userId, current.artifact.workspaceId, ref.id)
      return resource && resource.hash === ref.hash && resource.mime === ref.mime ? resource : null
    }))
    if (resourceReads.some((resource) => resource === null)) return null
    const scope = classifyOfficeOutput({
      sensitivity: current.artifact.sensitivity,
      compartments: current.artifact.compartments,
      projectIds: current.artifact.projectIds,
    }, ...resourceReads.flatMap((resource) => resource && 'binding' in resource ? [resource.binding as Parameters<typeof classifyOfficeOutput>[1]] : []))
    let validForMs = session && current.artifact.expiresAt
      ? Math.min(30_000, current.artifact.expiresAt.getTime() - Date.now())
      : resourceReads.reduce((ttl, resource) => Math.min(ttl, resource && 'validForMs' in resource ? resource.validForMs as number : ttl), 30_000)
    if (params.releasedFileId) {
      const output = await readBoundOfficeFile({ userId: params.userId, workspaceId: current.artifact.workspaceId, fileId: params.releasedFileId })
      if (!output || output.binding.hash !== params.releasedHash || output.binding.mime !== params.releasedMime ||
        officeOutputScopeRevision(output.binding) !== officeOutputScopeRevision(scope)) return null
      validForMs = Math.min(validForMs, output.validForMs)
    }
    return Number.isFinite(validForMs) && validForMs > 0 ? { scope, validForMs: Math.floor(validForMs) } : null
  }
  return { readBoundOfficeFile, saveClassifiedOfficeFile, readOfficeResource, loadOfficeReleaseContext, revalidateOfficeRelease }
}

/** Read an admitted template version's bundle under its source authority. */
export function createOfficeTemplateBundleReader(deps: {
  filesApi: FilesApi
  templates: ReturnType<typeof createOfficeTemplateStore>
  artifacts: ReturnType<typeof createOfficeArtifactStore>
}) {
  return async (userId: string, workspaceId: string, versionId: string, onSource?: (scope: OfficeOutputScope, revision: string) => void,
    execution?: { assistantId: string; clearance: Sensitivity; compartments?: string[] | null; projectIds?: string[] | null }) => {
    const version = await deps.templates.getVersion(userId, versionId)
    if (!version || version.workspaceId !== workspaceId || version.status !== 'admitted') return null
    const read = await deps.filesApi.readBytes({ workspaceId, userId, assistantKind: 'standard', clearance: 'confidential', ...execution }, version.bundleFileId)
    if (!read.ok) throw new Error(`Office template bundle unavailable: ${read.error.kind}`)
    const templateRoot = await deps.templates.get(userId, version.templateId)
    const root = templateRoot?.draftArtifactId ? await deps.artifacts.get(userId, templateRoot.draftArtifactId) : null
    if (!templateRoot || !root || root.workspaceId !== workspaceId) throw new Error('Office template source unavailable')
    const binding = bindOfficeFile(read.value.file, read.value.bytes)
    const sourceScope = classifyOfficeOutput(binding, root)
    onSource?.(sourceScope, JSON.stringify([officeFileBindingRevision(binding), root.id, root.sensitivity, [...root.compartments].sort(), [...root.projectIds].sort(), templateRoot.lifecycleState]))
    const stored = JSON.parse(new TextDecoder().decode(read.value.bytes))
    return materializeOfficeTemplateBundleForGeneration(stored, { id: version.id, version: version.version, status: 'admitted' })
  }
}
