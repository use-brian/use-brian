import { executeOfficeRelease, type OfficeReleaseRouteDeps } from '../routes/office-releases.js'
import { changeOfficeLifecycle, type OfficeLifecycleDeps } from './lifecycle.js'
import { workspaceCredentialDelegation } from '@use-brian/core'
import { captureOfficeWorkspaceAuthority } from './workspace-authority.js'
import { readOfficeClassification, restrictOfficeClassification, withOfficeClassificationActor } from './classification.js'
import {
  canRead,
  ContextScopeAccumulator,
  scopeGrantContains,
  type OfficeArtifactToolProjection,
  type OfficeToolPort,
  type ToolContext,
} from '@use-brian/core'
import type { OfficeArtifactSnapshot } from '@use-brian/office-model'
import { isDurableOfficeArtifact, type OfficeArtifactRow } from '../db/office-artifacts.js'
import { officeImportDiagnostics, officeGenerationInputQuestion } from '../db/office-generation.js'
import { readOfficeGenerationRecovery } from './generation-recovery.js'
import type { OfficeGenerationJobRow } from '../db/office-generation.js'
import type { ResolvedOfficeAccess } from './access.js'
import { createWorkspaceOfficeGeneration, createHumanOfficeGeneration, type OfficeHumanGenerationOptions, type OfficeGenerationRequest } from '../db/office-generation-admission.js'

export type OfficeServiceDeps = {
  updateCommentThread?: ReturnType<typeof import('../db/office-comments.js').createOfficeCommentStore>['updateThread']
  resolveComment?: ReturnType<typeof import('../db/office-comments.js').createOfficeCommentStore>['resolve']
  versions?: () => ReturnType<typeof import('./version-runtime.js').createOfficeVersionRuntime> | null
  release?: () => OfficeReleaseRouteDeps | null
  lifecycle?: OfficeLifecycleDeps
  getJob?(userId: string, jobId: string): Promise<OfficeGenerationJobRow | null>
  cancelJob?(userId: string, jobId: string): Promise<boolean>
  listVersions?(userId:string,artifactId:string):Promise<Record<string,unknown>[]>
  listThreads?(userId:string,artifactId:string):Promise<Record<string,unknown>[]>
  listSuggestions?(userId:string,artifactId:string):Promise<Record<string,unknown>[]>

  list?(userId:string,workspaceId:string,view:'active'|'archived',page:{limit:number;afterId?:string}):Promise<OfficeArtifactRow[]>

  generationAvailable(family?: 'document' | 'presentation' | 'spreadsheet'): boolean
  createShell(params: { userId: string; workspaceId: string; family: 'document' | 'presentation' | 'spreadsheet'; title: string; templateVersionId: string | null; capabilityVersion: number; sensitivity: 'public' | 'internal' | 'confidential'; visibilityUserIds?: string[]; requiredCompartments?: string[]; projectIds?: string[] }): Promise<OfficeArtifactRow>
  deleteEmptyShell(userId: string, artifactId: string): Promise<boolean>
  getArtifact(userId: string, artifactId: string): Promise<OfficeArtifactRow | null>
  raiseScope(params: { userId: string; artifactId: string; sensitivity: 'public' | 'internal' | 'confidential'; compartments: string[]; projectIds: string[] }): Promise<boolean>
  resolveAccess(userId: string, artifactId: string): Promise<ResolvedOfficeAccess | null>
  createJob(params: { userId: string; workspaceId: string; artifactId: string; assistantId: string | null; jobKind: OfficeGenerationJobRow['jobKind']; brief: unknown; authorityProjection: unknown; templateVersionId?: string; baseArtifactVersion?: number; idempotencyKey: string }): Promise<OfficeGenerationJobRow>
  latestJob(userId: string, artifactId: string): Promise<OfficeGenerationJobRow | null>
  /** Latest persisted event: the job state shown is status plus this, never a generic label. */
  latestJobEvent?(userId: string, jobId: string): Promise<{ code: string; safeNarration: string | null } | null>
  getSnapshot(userId: string, artifactId: string): Promise<{ snapshot: OfficeArtifactSnapshot; canonicalHash?:string } | null>
  captureObservation(userId:string, artifact:OfficeArtifactRow, canonicalHash?:string|null):Promise<import('@use-brian/core').ScopeSource|null>
  wakeGeneration?(userId: string): void
}

export class OfficeGenerationUnavailableError extends Error {
  readonly code = 'office_generation_unavailable'

  constructor() {
    super('Office generation is unavailable because no generation runner is configured')
  }
}

function titleFromOutcome(outcome: string, family: 'document' | 'presentation' | 'spreadsheet'): string {
  const line = outcome.trim().split(/[\n.!?]/)[0]?.trim()
  return (line || (family === 'document' ? 'Untitled document' : family === 'presentation' ? 'Untitled presentation' : 'Untitled spreadsheet')).slice(0, 1_000)
}

const TARGET_LIMIT = 1_000

function artifactWithinTurnScope(
  artifact: OfficeArtifactRow,
  scope: {
    clearance?: 'public' | 'internal' | 'confidential'
    compartmentGrant?: string[] | null
    projectGrant?: string[] | null
  },
): boolean {
  return (
    (scope.clearance === undefined || canRead(scope.clearance, artifact.sensitivity))
    && scopeGrantContains(scope.compartmentGrant, artifact.compartments)
    && scopeGrantContains(scope.projectGrant, artifact.projectIds)
  )
}

function targetOutline(snapshot: OfficeArtifactSnapshot, offset = 0): Pick<OfficeArtifactToolProjection, 'sourceHash' | 'targets' | 'targetsTruncated' | 'nextTargetOffset'> {
  const targets: NonNullable<OfficeArtifactToolProjection['targets']> = []
  let targetCount = 0
  const add = (target: NonNullable<OfficeArtifactToolProjection['targets']>[number]) => {
    if (targetCount >= offset && targets.length < TARGET_LIMIT) targets.push(target)
    targetCount += 1
  }
  if (snapshot.family === 'document') {
    for (const [sectionIndex, section] of snapshot.sections.entries()) {
      add({ id: section.id, kind: 'section', label: `Section ${sectionIndex + 1}` })
      for (const [nodeIndex, node] of section.nodes.entries()) {
        const text = node.kind === 'paragraph' || node.kind === 'heading' ? node.runs.map((run) => run.text).join('')
          : node.kind === 'list' ? node.items.map((item) => item.runs.map((run) => run.text).join('')).join(' / ')
          : node.kind === 'table' ? node.rows.flatMap((row) => row.cells).map((cell) => cell.runs.map((run) => run.text).join('')).join(' / ')
          : node.kind === 'image' || node.kind === 'video' ? node.altText
          : node.kind === 'chart' ? node.title : node.kind === 'pageBreak' ? 'Page break' : 'Section break'
        add({ id: node.id, kind: node.kind, label: text.trim().slice(0, 240) || `${node.kind} ${nodeIndex + 1}`, parentId: section.id })
        if (node.kind === 'list') for (const [itemIndex, item] of node.items.entries()) add({ id: item.id, kind: 'listItem', label: item.runs.map((run) => run.text).join('').trim().slice(0, 240) || `List item ${itemIndex + 1}`, parentId: node.id })
        if (node.kind === 'table') for (const [cellIndex, cell] of node.rows.flatMap((row) => row.cells).entries()) add({ id: cell.id, kind: 'tableCell', label: cell.runs.map((run) => run.text).join('').trim().slice(0, 240) || `Table cell ${cellIndex + 1}`, parentId: node.id })
      }
    }
  } else if (snapshot.family === 'presentation') {
    add({ id: snapshot.rootId, kind: 'theme', label: 'Presentation theme' })
    for (const master of snapshot.masters) add({ id: master.id, kind: 'master', label: master.name, parentId: snapshot.rootId })
    for (const layout of snapshot.layouts) add({ id: layout.id, kind: 'layout', label: layout.name, parentId: layout.masterId })
    for (const [slideIndex, slide] of snapshot.slides.entries()) {
      add({ id: slide.id, kind: 'slide', label: `${slideIndex + 1}. ${slide.title}` })
      for (const [objectIndex, object] of slide.objects.entries()) {
        const text = object.kind === 'text' ? object.runs.map((run) => run.text).join('') : object.kind === 'shape' ? object.text.map((run) => run.text).join('') : object.kind === 'chart' ? object.title : 'altText' in object ? object.altText : ''
        const master = snapshot.masters.find((candidate) => candidate.id === slide.masterId)
        add({ id: object.id, kind: object.kind, label: text.trim().slice(0, 240) || `${object.kind} ${objectIndex + 1}`, parentId: slide.id, locked: object.locked || master?.lockedObjectIds.includes(object.id) })
      }
    }
  } else if (snapshot.family === 'spreadsheet') {
    for (const [sheetIndex, sheet] of snapshot.worksheets.entries()) {
      add({ id: sheet.id, kind: 'worksheet', label: `${sheetIndex + 1}. ${sheet.name}` })
      for (const table of sheet.tables ?? []) add({ id: table.id, kind: 'spreadsheetTable', label: `${table.name} ${table.ref}; columns ${table.columns.map(c => `${c.id}:${c.name}`).join(', ')}`.slice(0, 240), parentId: sheet.id })
      for (const cell of sheet.cells) add({ id: cell.id, kind: cell.formula ? 'formulaCell' : 'cell', label: `${sheet.name}!${cell.address}: ${cell.formula ? `=${cell.formula}` : String(cell.value ?? '')}`.slice(0, 240), parentId: sheet.id, locked: cell.locked })
      for (const image of sheet.images) add({ id: image.id, kind: 'worksheetImage', label: image.altText || 'Decorative worksheet image', parentId: sheet.id })
    }
  } else {
    for (const [pageIndex, page] of snapshot.pages.entries()) {
      add({ id: page.id, kind: 'pdfPage', label: `Page ${pageIndex + 1}`, pageNumber: pageIndex + 1, pageOrder: pageIndex, rotation: page.rotation, rect: page.cropBox })
      for (const field of page.fields) {
        if (field.kind === 'signature') continue
        const widget = field.widgets.find((candidate) => candidate.pageId === page.id)
        add({ id: field.id, kind: `pdfField:${field.kind}`, label: field.label, parentId: page.id, locked: field.readOnly, value: field.value, ...(field.allowedOptions ? { options: field.allowedOptions } : {}), pageNumber: pageIndex + 1, ...(widget ? { rect: widget.rect } : {}) })
      }
      for (const overlay of page.overlays) {
        if (overlay.kind === 'signature') continue
        const label = overlay.kind === 'text' ? overlay.text : overlay.kind === 'date' ? overlay.date : `PDF ${overlay.kind}`
        add({ id: overlay.id, kind: `pdfOverlay:${overlay.kind}`, label: label.slice(0, 240), parentId: page.id, pageNumber: pageIndex + 1, rect: overlay.rect, rotation: overlay.rotation, ...('resourceId' in overlay ? { resourceId: overlay.resourceId } : {}) })
      }
      for (const target of page.placementTargets) add({ id: target.id, kind: 'pdfSignatureTarget', label: `Signature target on page ${pageIndex + 1}`, parentId: page.id, pageNumber: pageIndex + 1, rect: target.rect })
    }
  }
  const nextTargetOffset = offset + targets.length < targetCount ? offset + targets.length : undefined
  return { ...(snapshot.family === 'pdf' ? { sourceHash: snapshot.source.sha256 } : {}), targets, targetsTruncated: nextTargetOffset !== undefined, nextTargetOffset }
}

/** Select semantic content only; resource storage and signature payloads are not model inputs. */
function selectedContent(snapshot: OfficeArtifactSnapshot, targetIds: string[]): NonNullable<OfficeArtifactToolProjection['selection']> {
  const roots = snapshot.family === 'document' ? snapshot.sections
    : snapshot.family === 'presentation' ? [...snapshot.masters, ...snapshot.layouts, ...snapshot.slides]
    : snapshot.family === 'spreadsheet' ? snapshot.worksheets
    : snapshot.pages.map(page => ({ ...page, fields: page.fields.filter(field => field.kind !== 'signature'), overlays: page.overlays.filter(overlay => overlay.kind !== 'signature') }))
  const records = new Map<string, unknown>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (typeof record.id === 'string') records.set(record.id, record)
    Object.values(record).forEach(visit)
  }
  visit(roots)
  if (snapshot.family === 'presentation') records.set(snapshot.rootId, { rootId: snapshot.rootId, themeId: snapshot.themeId, slideSize: snapshot.slideSize })
  const selection: NonNullable<OfficeArtifactToolProjection['selection']> = { targets: [], missingTargetIds: [], oversizedTargetIds: [] }
  let remaining = 32 * 1024
  for (const id of new Set(targetIds)) {
    const content = records.get(id)
    if (!content) { selection.missingTargetIds.push(id); continue }
    const size = Buffer.byteLength(JSON.stringify(content), 'utf8')
    if (size > remaining) { selection.oversizedTargetIds.push(id); continue }
    remaining -= size
    selection.targets.push({ id, content })
  }
  return selection
}

export type OfficeService = OfficeToolPort & {
  createAuthenticated?(input: OfficeGenerationRequest, proof: OfficeHumanGenerationOptions): Promise<{artifactId:string;jobId:string} | null>
}

export function createOfficeService(deps: OfficeServiceDeps): OfficeService {
  async function changeComment(context: ToolContext, input: Parameters<NonNullable<OfficeToolPort['resolveComment']>>[1] | Parameters<NonNullable<OfficeToolPort['assignComment']>>[1]) {
    if (!context.workspaceId) return null
    await context.authority?.assertCurrent()
    const artifact = await deps.getArtifact(context.userId, input.artifactId)
    if (!artifact || artifact.workspaceId !== context.workspaceId || artifact.lifecycleState !== 'active'
      || !artifactWithinTurnScope(artifact, { clearance: context.clearance, compartmentGrant: context.compartments ?? null,
        projectGrant: context.projectIds ?? null }) || !(await deps.resolveAccess(context.userId, artifact.id))?.canComment) return null
    const observation = await deps.captureObservation(context.userId, artifact)
    if (!observation) return null
    await context.authority?.assertCurrent()
    const trusted = { userId: context.userId, actorAssistantId: context.assistantId,
      workspaceDelegation: workspaceCredentialDelegation(context.executionContext), admissionObservationId: observation.resourceId,
      sharedAudience: context.executionContext?.security.access.sharedAudience === true }
    const changed = 'resolved' in input ? await deps.resolveComment!({ ...input, ...trusted })
      : await deps.updateCommentThread!({ ...input, ...trusted })
    return changed ? { scopeEvidence: { sources: [observation], sensitivity: artifact.sensitivity,
      compartments: artifact.compartments, projectIds: artifact.projectIds } } : null
  }
  return {
    resolveComment: deps.resolveComment ? changeComment : undefined,
    assignComment: deps.updateCommentThread ? changeComment : undefined,
    restoreVersion: deps.versions ? async (context, input) => {
      if (!context.workspaceId) return null
      await context.executionContext?.security.authority.assertCurrent()
      const artifact = await deps.getArtifact(context.userId, input.artifactId)
      if (!artifact || !isDurableOfficeArtifact(artifact) || artifact.lifecycleState !== 'active'
        || artifact.workspaceId !== context.workspaceId || !artifactWithinTurnScope(artifact, {
          clearance: context.clearance, compartmentGrant: context.compartments ?? null, projectGrant: context.projectIds ?? null,
        }) || !(await deps.resolveAccess(context.userId, artifact.id))?.canEdit) return null
      if (artifact.headVersion !== input.expectedVersion) return 'version_conflict'
      const runtime = deps.versions!(); if (!runtime) return null
      const observation = await deps.captureObservation(context.userId, artifact)
      if (!observation) return null
      return await runtime.restore({ ...input, context, userId: context.userId, actorAssistantId: context.assistantId,
        admissionObservationId: observation.resourceId, summary: 'Restored saved version through Brian' }) ?? 'version_conflict'
    } : undefined,
    exportArtifact: deps.release ? async (context, input) => {
      if (!context.workspaceId || input.acknowledgeCodes?.length && context.approvedToolInvocation?.toolName !== 'exportOfficeArtifact') return null
      await context.executionContext?.security.authority.assertCurrent()
      const artifact = await deps.getArtifact(context.userId, input.artifactId)
      if (!artifact || artifact.workspaceId !== context.workspaceId || !artifactWithinTurnScope(artifact, {
        clearance: context.clearance, compartmentGrant: context.compartments ?? null, projectGrant: context.projectIds ?? null,
      })) return null
      const release = deps.release!(); if (!release) return null
      const observation = await deps.captureObservation(context.userId, artifact)
      if (!observation) return null
      const current = async () => { await context.executionContext?.security.authority.assertCurrent() }
      const outcome = await executeOfficeRelease({ ...release,
        revalidate: async params => { await current(); const result = await release.revalidate(params); await current(); return result },
        saveReleasedFile: async params => { await current(); return release.saveReleasedFile(params) },
        createRecord: async params => { await current(); return release.createRecord(params) },
      }, { userId: context.userId, actorAssistantId: context.assistantId,
        artifactId: artifact.id, request: { expectedVersion: input.expectedVersion, action: 'export',
          destination: { sensitivity: artifact.sensitivity, external: false }, format: input.format,
          spreadsheetPdf: input.spreadsheetPdf,
          ...(input.acknowledgeCodes?.length ? { acknowledgement: { version: input.expectedVersion, action: 'export', codes: input.acknowledgeCodes } } : {}) } })
      return { ...outcome, scopeEvidence: { sources: [observation], sensitivity: artifact.sensitivity, compartments: artifact.compartments, projectIds: artifact.projectIds } }
    } : undefined,
    changeLifecycle: deps.lifecycle ? async (context, input) => {
      if (!context.workspaceId) return null
      await context.executionContext?.security.authority.assertCurrent()
      const artifact = await deps.getArtifact(context.userId, input.artifactId)
      if (!artifact || artifact.workspaceId !== context.workspaceId
        || !artifactWithinTurnScope(artifact, { clearance: context.clearance, compartmentGrant: context.compartments ?? null, projectGrant: context.projectIds ?? null })) return null
      const result = await changeOfficeLifecycle(deps.lifecycle!, { ...input, userId: context.userId,
        workspaceId: context.workspaceId, actorAssistantId: context.assistantId, reason: 'Requested through the assistant lifecycle command' })
      if (result.status !== 200) return null
      const state = { archive: 'archived', unarchive: 'active', trash: 'trash', restore: 'active', purge: 'purged' }[input.action]
      return { artifactId: artifact.id, lifecycleState: state }
    } : undefined,
    cancelJob: deps.getJob && deps.cancelJob ? async (context, input) => {
      const artifact = await deps.getArtifact(context.userId, input.artifactId)
      if (!artifact || artifact.workspaceId !== context.workspaceId || !artifactWithinTurnScope(artifact, {
        clearance: context.clearance, compartmentGrant: context.compartments ?? null, projectGrant: context.projectIds ?? null,
      })) return false
      const access = await deps.resolveAccess(context.userId, input.artifactId)
      if (!access?.canEdit) return false
      const job = await deps.getJob!(context.userId, input.jobId)
      if (!job || job.artifactId !== artifact.id || job.workspaceId !== artifact.workspaceId) return false
      return deps.cancelJob!(context.userId, job.id)
    } : undefined,
    inspectClassification: (actor,id) => withOfficeClassificationActor(actor,()=>readOfficeClassification(actor.userId,id)),
    restrictClassification: (actor,input) => withOfficeClassificationActor(actor,()=>restrictOfficeClassification(actor.userId,input)),
    async createAuthenticated(input, proof) {
      if (!deps.generationAvailable(input.family)) throw new OfficeGenerationUnavailableError()
      const created = await createHumanOfficeGeneration(input, proof)
      if (created) deps.wakeGeneration?.(input.userId)
      return created
    },
    async create(params) {
      if (!deps.generationAvailable(params.family)) throw new OfficeGenerationUnavailableError()
      if (workspaceCredentialDelegation(params.context?.executionContext)) {
        const created=await createWorkspaceOfficeGeneration(params,params.context!)
        if(!created)throw new Error('office_generation_admission_required')
        deps.wakeGeneration?.(params.userId)
        return created
      }
      const artifact = await deps.createShell({ userId: params.userId, workspaceId: params.workspaceId, family: params.family, title: titleFromOutcome(params.outcome, params.family), templateVersionId: params.templateId ?? null, capabilityVersion: 1, sensitivity: params.sensitivity, requiredCompartments: params.compartments, projectIds: params.projectIds })
      const brief = {
        workspaceId: params.workspaceId,
        actingUserId: params.userId,
        assistantId: params.assistantId,
        family: params.family,
        outcome: params.outcome,
        audience: params.audience,
        sourceHandles: params.sourceHandles,
        requestedSensitivityFloor: params.sensitivity,
        templateId: params.templateId,
        additionalContext: params.additionalContext,
        idempotencyKey: params.idempotencyKey,
      }
      let job: OfficeGenerationJobRow
      try {
        job = await deps.createJob({ userId: params.userId, workspaceId: params.workspaceId, artifactId: artifact.id, assistantId: params.assistantId, jobKind: 'create', brief, authorityProjection: { ...await captureOfficeWorkspaceAuthority(params.context), sensitivity: artifact.sensitivity, visibilityUserIds: [], compartments: artifact.compartments, projectIds: artifact.projectIds, compartmentGrant: params.compartmentGrant, projectGrant: params.projectGrant, sourceHandles: params.sourceHandles }, templateVersionId: params.templateId, idempotencyKey: params.idempotencyKey })
      } catch (cause) {
        await deps.deleteEmptyShell(params.userId, artifact.id)
        throw cause
      }
      if (job.artifactId !== artifact.id) await deps.deleteEmptyShell(params.userId, artifact.id)
      deps.wakeGeneration?.(params.userId)
      return { artifactId: job.artifactId, jobId: job.id }
    },

    inspectReview: deps.listVersions&&deps.listThreads&&deps.listSuggestions ? async(context,input)=>{
      const artifact=await deps.getArtifact(context.userId,input.artifactId)
      if(!artifact||artifact.workspaceId!==context.workspaceId
        ||!artifactWithinTurnScope(artifact,{clearance:context.clearance,compartmentGrant:context.compartments??null,projectGrant:context.projectIds??null})
        ||!await deps.resolveAccess(context.userId,artifact.id))return null
      const before=await deps.captureObservation(context.userId,artifact)
      if(!before)return null
      const read=input.kind==='history'?deps.listVersions!:input.kind==='comments'?deps.listThreads!:deps.listSuggestions!
      const rows=await read(context.userId,artifact.id)
      const after=await deps.captureObservation(context.userId,artifact)
      if(!after||after.version!==before.version||JSON.stringify(after)!==JSON.stringify(before))return null
      const windowLimit=input.kind==='history'?200:500
      const end=Math.min(input.offset+input.limit,rows.length)
      return{items:rows.slice(input.offset,end),...(end<rows.length?{nextOffset:end}:{}),windowLimit,windowLimitReached:rows.length===windowLimit,
        scopeEvidence:{sources:[before],sensitivity:before.sensitivity,compartments:before.compartments,projectIds:before.projectIds}}
    }:undefined,

    list: deps.list ? async (context,input) => {
      if(!context.workspaceId)throw new Error('office_workspace_required')
      const candidates=await deps.list!(context.userId,context.workspaceId,input.view,{limit:input.limit+1,afterId:input.cursor})
      const page=candidates.slice(0,input.limit),artifacts:OfficeArtifactToolProjection[]=[]
      for(const artifact of page){
        if(!artifactWithinTurnScope(artifact,{clearance:context.clearance,compartmentGrant:context.compartments??null,projectGrant:context.projectIds??null}))continue
        const access=await deps.resolveAccess(context.userId,artifact.id)
        if(!access)continue
        const observation=await deps.captureObservation(context.userId,artifact)
        if(!observation)continue
        artifacts.push({artifactId:artifact.id,family:artifact.family,mode:artifact.mode,title:artifact.title,version:artifact.headVersion,
          lifecycleState:input.view,role:access.role,scopeEvidence:{sources:[observation],sensitivity:observation.sensitivity,
            compartments:observation.compartments,projectIds:observation.projectIds}})
      }
      return {artifacts,...(candidates.length>input.limit?{nextCursor:page.at(-1)!.id}:{})}
    } : undefined,

    async get(params) {
      const [artifact, access] = await Promise.all([deps.getArtifact(params.userId, params.artifactId), deps.resolveAccess(params.userId, params.artifactId)])
      if (!artifact || !access || (params.context && artifact.workspaceId !== params.context.workspaceId) || !artifactWithinTurnScope(artifact, params)) return null
      const before = params.context ? await deps.captureObservation(params.userId, artifact) : undefined
      if (params.context && !before) return null
      if (params.versionId && (!isDurableOfficeArtifact(artifact) || !deps.versions?.())) return null
      const historical = params.versionId ? await deps.versions!()!.read(params.userId, artifact.id, params.versionId, params.context) : null
      if (params.versionId && !historical) return null
      const [job, live] = await Promise.all([deps.latestJob(params.userId, params.artifactId), deps.getSnapshot(params.userId, params.artifactId)])
      const recovery = job?.status === 'needs_input' && job.errorCode === 'template_ambiguous'
        ? await readOfficeGenerationRecovery(params.userId,artifact.id,job.id,params) : undefined
      const latest = job && deps.latestJobEvent ? await deps.latestJobEvent(params.userId, job.id) : null
      const observation=params.context ? await deps.captureObservation(params.userId,artifact,live?.canonicalHash ?? null) : undefined
      if(params.context && (!observation || observation.version !== before?.version || JSON.stringify(observation) !== JSON.stringify(before)))return null
      const content = historical?.snapshot ?? live?.snapshot
      const evidence = new ContextScopeAccumulator(observation
        ? { sensitivity: observation.sensitivity, compartments: observation.compartments, projectIds: observation.projectIds, sources: [observation] }
        : { sensitivity: artifact.sensitivity, compartments: artifact.compartments, projectIds: artifact.projectIds })
      evidence.note(historical?.scopeEvidence)
      return { artifactId: artifact.id, family: artifact.family, mode: artifact.mode, title: historical?.snapshot.title ?? artifact.title, version: historical?.source.version ?? artifact.headVersion, sensitivity: artifact.sensitivity, ...(historical ? { versionId: params.versionId, currentVersion: artifact.headVersion } : {}), lifecycleState: artifact.lifecycleState === 'purged' ? 'retained' : artifact.lifecycleState, role: access.role, ...(artifact.expiresAt ? { expiresAt: artifact.expiresAt.toISOString() } : {}), scopeEvidence: evidence.evidence, ...(content && !params.targetIds ? targetOutline(content, params.targetOffset) : {}), ...(params.targetIds && content ? { selection: selectedContent(content, params.targetIds) } : {}), job: job ? { id: job.id, status: job.status, stage: job.stage, errorCode: job.errorCode, inputQuestion:officeGenerationInputQuestion(job), ...(latest ? { latestEvent: { code: latest.code, safeNarration: latest.safeNarration } } : {}), ...recovery, ...(officeImportDiagnostics(job.checkpoint).length ? { importDiagnostics: officeImportDiagnostics(job.checkpoint) } : {}) } : undefined }
    },

    async revise(params) {
      const [artifact, access] = await Promise.all([deps.getArtifact(params.userId, params.artifactId), deps.resolveAccess(params.userId, params.artifactId)])
      const durable = artifact ? isDurableOfficeArtifact(artifact) : false
      const pdfSession = artifact?.family === 'pdf' && artifact.mode === 'session'
      if (!artifact || !access || (params.context && artifact.workspaceId !== params.context.workspaceId) || !artifactWithinTurnScope(artifact, params)
        || durable && !access.canComment
        || pdfSession && !access.canEdit
        || !durable && !pdfSession) return null
      if (artifact.headVersion !== params.expectedVersion) return 'version_conflict'
      if (pdfSession && params.targetIds.length === 0) return null
      if (durable) await deps.raiseScope({ userId: params.userId, artifactId: artifact.id, sensitivity: params.sensitivity, compartments: params.compartments, projectIds: params.projectIds })
      const job = await deps.createJob({ userId: params.userId, workspaceId: artifact.workspaceId, artifactId: artifact.id, assistantId: params.assistantId, jobKind: 'revise', brief: { instruction: params.instruction, ...(params.commandOperations?{commandOperations:params.commandOperations}:{}), targetIds: params.targetIds, expectedVersion: params.expectedVersion }, authorityProjection: { ...await captureOfficeWorkspaceAuthority(params.context), role: access.role, sensitivity: params.sensitivity, compartments: params.compartments, projectIds: params.projectIds, compartmentGrant: params.compartmentGrant, projectGrant: params.projectGrant }, baseArtifactVersion: artifact.headVersion, idempotencyKey: params.idempotencyKey })
      deps.wakeGeneration?.(params.userId)
      return { jobId: job.id, mode: pdfSession || access.canEdit ? 'direct' : 'proposal' }
    },
  }
}
