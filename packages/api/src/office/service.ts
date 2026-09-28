import {
  canRead,
  scopeGrantContains,
  type OfficeArtifactToolProjection,
  type OfficeToolPort,
} from '@use-brian/core'
import type { OfficeArtifactSnapshot } from '@use-brian/office-model'
import { isDurableOfficeArtifact, type OfficeArtifactRow } from '../db/office-artifacts.js'
import type { OfficeGenerationJobRow } from '../db/office-generation.js'
import type { ResolvedOfficeAccess } from './access.js'

export type OfficeServiceDeps = {
  generationAvailable(family?: 'document' | 'presentation' | 'spreadsheet'): boolean
  createShell(params: { userId: string; workspaceId: string; family: 'document' | 'presentation' | 'spreadsheet'; title: string; templateVersionId: string | null; capabilityVersion: number; sensitivity: 'public' | 'internal' | 'confidential'; visibilityUserIds?: string[]; requiredCompartments?: string[]; projectIds?: string[] }): Promise<OfficeArtifactRow>
  deleteEmptyShell(userId: string, artifactId: string): Promise<boolean>
  getArtifact(userId: string, artifactId: string): Promise<OfficeArtifactRow | null>
  raiseScope(params: { userId: string; artifactId: string; sensitivity: 'public' | 'internal' | 'confidential'; compartments: string[]; projectIds: string[] }): Promise<boolean>
  resolveAccess(userId: string, artifactId: string): Promise<ResolvedOfficeAccess | null>
  createJob(params: { userId: string; workspaceId: string; artifactId: string; assistantId: string | null; jobKind: OfficeGenerationJobRow['jobKind']; brief: unknown; authorityProjection: unknown; templateVersionId?: string; baseArtifactVersion?: number; idempotencyKey: string }): Promise<OfficeGenerationJobRow>
  latestJob(userId: string, artifactId: string): Promise<OfficeGenerationJobRow | null>
  getSnapshot(userId: string, artifactId: string): Promise<{ snapshot: OfficeArtifactSnapshot } | null>
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

export function createOfficeService(deps: OfficeServiceDeps): OfficeToolPort {
  return {
    async create(params) {
      if (!deps.generationAvailable(params.family)) throw new OfficeGenerationUnavailableError()
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
        job = await deps.createJob({ userId: params.userId, workspaceId: params.workspaceId, artifactId: artifact.id, assistantId: params.assistantId, jobKind: 'create', brief, authorityProjection: { sensitivity: params.sensitivity, visibilityUserIds: [], compartments: params.compartments, projectIds: params.projectIds, compartmentGrant: params.compartmentGrant, projectGrant: params.projectGrant, sourceHandles: params.sourceHandles }, templateVersionId: params.templateId, idempotencyKey: params.idempotencyKey })
      } catch (cause) {
        await deps.deleteEmptyShell(params.userId, artifact.id)
        throw cause
      }
      if (job.artifactId !== artifact.id) await deps.deleteEmptyShell(params.userId, artifact.id)
      deps.wakeGeneration?.(params.userId)
      return { artifactId: job.artifactId, jobId: job.id }
    },

    async get(params) {
      const [artifact, access] = await Promise.all([deps.getArtifact(params.userId, params.artifactId), deps.resolveAccess(params.userId, params.artifactId)])
      if (!artifact || !access || !artifactWithinTurnScope(artifact, params)) return null
      const [job, live] = await Promise.all([deps.latestJob(params.userId, params.artifactId), deps.getSnapshot(params.userId, params.artifactId)])
      return { artifactId: artifact.id, family: artifact.family, mode: artifact.mode, title: artifact.title, version: artifact.headVersion, lifecycleState: artifact.lifecycleState === 'purged' ? 'retained' : artifact.lifecycleState, role: access.role, ...(artifact.expiresAt ? { expiresAt: artifact.expiresAt.toISOString() } : {}), scopeEvidence: { sensitivity: artifact.sensitivity, compartments: artifact.compartments, projectIds: artifact.projectIds }, ...(live ? targetOutline(live.snapshot, params.targetOffset) : {}), job: job ? { id: job.id, status: job.status, stage: job.stage, errorCode: job.errorCode } : undefined }
    },

    async revise(params) {
      const [artifact, access] = await Promise.all([deps.getArtifact(params.userId, params.artifactId), deps.resolveAccess(params.userId, params.artifactId)])
      const durable = artifact ? isDurableOfficeArtifact(artifact) : false
      const pdfSession = artifact?.family === 'pdf' && artifact.mode === 'session'
      if (!artifact || !access || !artifactWithinTurnScope(artifact, params)
        || durable && !access.canComment
        || pdfSession && !access.canEdit
        || !durable && !pdfSession) return null
      if (artifact.headVersion !== params.expectedVersion) return 'version_conflict'
      if (pdfSession && params.targetIds.length === 0) return null
      if (durable) await deps.raiseScope({ userId: params.userId, artifactId: artifact.id, sensitivity: params.sensitivity, compartments: params.compartments, projectIds: params.projectIds })
      const job = await deps.createJob({ userId: params.userId, workspaceId: artifact.workspaceId, artifactId: artifact.id, assistantId: params.assistantId, jobKind: 'revise', brief: { instruction: params.instruction, targetIds: params.targetIds, expectedVersion: params.expectedVersion }, authorityProjection: { role: access.role, sensitivity: params.sensitivity, compartments: params.compartments, projectIds: params.projectIds, compartmentGrant: params.compartmentGrant, projectGrant: params.projectGrant }, baseArtifactVersion: artifact.headVersion, idempotencyKey: params.idempotencyKey })
      deps.wakeGeneration?.(params.userId)
      return { jobId: job.id, mode: pdfSession || access.canEdit ? 'direct' : 'proposal' }
    },
  }
}
