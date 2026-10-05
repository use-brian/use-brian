/** Template-mode admission worker for scratch/promote/upload jobs.
 * [COMP:api/office-generation] */
import { createHash, randomUUID } from 'node:crypto'
import {
  compileOfficeTemplate,
  canRead,
  scopeGrantContains,
  inferOfficeTemplateRouting,
  importOfficeDocument,
  importOfficePresentation,
  importOfficeSpreadsheet,
  officeTemplateRoutingDiagnostics,
  type ExtractedOfficeResource,
  type OfficeTemplateAdmissionReceipt,
  type OfficeTemplateResourceAdmission,
  type BrandTypographyContext,
} from '@use-brian/core'
import { getBrandStore } from '../db/brand-store.js'
import { OfficeTemplateRoutingDraftSchema, type OfficeImportDiagnostic, type OfficeArtifactSnapshot } from '@use-brian/office-model'
import type { OfficeGenerationJobRow } from '../db/office-generation.js'
import type { OfficeArtifactRow } from '../db/office-artifacts.js'
import { classifyOfficeOutput, officeFileBindingRevision, sameOfficeFileBinding, type OfficeFileBinding, type OfficeOutputScope } from './file-binding.js'

type BoundTemplateResourceAdmission = OfficeTemplateResourceAdmission & { sourceBinding: OfficeFileBinding }

export type OfficeTemplateCompileWorkerDeps = {
  claim(params: { userId: string; leaseToken: string; leaseMs: number; jobKinds: OfficeGenerationJobRow['jobKind'][] }): Promise<OfficeGenerationJobRow | null>
  getSnapshot(userId: string, artifactId: string): Promise<{ snapshot: OfficeArtifactSnapshot } | null>
  getTemplate(userId: string, templateId: string): Promise<{ id: string; workspaceId: string; family: 'document' | 'presentation' | 'spreadsheet'; name: string; description: string; sensitivity: 'public' | 'internal' | 'confidential'; draftArtifactId: string | null } | null>
  getArtifact(userId: string, artifactId: string): Promise<OfficeArtifactRow | null>
  raiseArtifactScope(params: { userId: string; artifactId: string; sensitivity: OfficeOutputScope['sensitivity']; compartments: string[]; projectIds: string[] }): Promise<boolean>
  readSource(params: { userId: string; workspaceId: string; assistantId: string | null; fileId: string }): Promise<{ bytes: Uint8Array; binding: OfficeFileBinding }>
  initialize(params: { userId: string; artifactId: string; snapshot: OfficeArtifactSnapshot; expectedSeq?: number }): Promise<void>
  saveImportedResource(params: { userId: string; workspaceId: string; assistantId: string | null; resource: ExtractedOfficeResource; sourceBinding: OfficeFileBinding; scope: OfficeOutputScope }): Promise<OfficeTemplateResourceAdmission>
  loadResourceAdmissions(params: { userId: string; workspaceId: string; resourceIds: string[] }): Promise<BoundTemplateResourceAdmission[]>
  getDraftRouting(userId: string, templateId: string): Promise<unknown | null>
  saveDraftRouting(params: { userId: string; templateId: string; routing: unknown }): Promise<boolean>
  saveBundle(params: { userId: string; workspaceId: string; templateId: string; hash: string; bytes: Uint8Array; scope: OfficeOutputScope }): Promise<string>
  addVersion(params: { userId: string; templateId: string; workspaceId: string; bundleFileId: string; bundleHash: string; capabilityVersion: number; locales: string[]; tags: string[]; whenToUse: string[]; whenNotToUse: string[]; exampleRequests: string[]; fieldSchema: unknown; admissionReceipt: OfficeTemplateAdmissionReceipt; provenance: unknown; resourceIds: string[]; status: 'draft' | 'admitted' }): Promise<unknown>
  appendEvent(params: { userId: string; jobId: string; workspaceId: string; code: string; values: Record<string, string | number | boolean>; actorType: 'system'; safeNarration: string }): Promise<unknown>
  finish(params: { userId: string; jobId: string; leaseToken: string; status: 'completed' | 'failed'; stage: string; errorCode?: string; errorDetail?: string; importDiagnostics?: OfficeImportDiagnostic[] }): Promise<boolean>
  leaseMs?: number
}

const artifactOutputScope = (artifact: OfficeArtifactRow): OfficeOutputScope => ({
  sensitivity: artifact.sensitivity,
  compartments: artifact.compartments,
  projectIds: artifact.projectIds,
})

const compileInputRevision = (input: {
  template: unknown
  artifact: unknown
  snapshot: OfficeArtifactSnapshot
  resources: readonly BoundTemplateResourceAdmission[]
}) => JSON.stringify({
  template: input.template,
  artifact: input.artifact,
  snapshot: input.snapshot,
  resources: input.resources.map(({ sourceBinding, bytes: _bytes, ...resource }) => ({
    ...resource,
    sourceBinding: officeFileBindingRevision(sourceBinding),
  })),
})

function remapSnapshotResources(snapshot: OfficeArtifactSnapshot, admissions: readonly OfficeTemplateResourceAdmission[], extracted: readonly ExtractedOfficeResource[]): OfficeArtifactSnapshot {
  const ids = new Map(extracted.map((resource, index) => [resource.ref.id, admissions[index]?.id ?? resource.ref.id]))
  if (ids.size === 0) return snapshot
  const remapped = structuredClone(snapshot) as OfficeArtifactSnapshot
  remapped.resources = remapped.resources.map((resource) => ({ ...resource, id: ids.get(resource.id) ?? resource.id }))
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (!Array.isArray(value)) {
      const object = value as Record<string, unknown>
      for (const key of ['resourceId', 'posterResourceId', 'captionsResourceId']) {
        if (typeof object[key] === 'string') object[key] = ids.get(object[key] as string) ?? object[key]
      }
    }
    for (const child of Object.values(value)) visit(child)
  }
  visit(remapped)
  return remapped
}

export function createOfficeTemplateCompileWorker(deps: OfficeTemplateCompileWorkerDeps) {
  return async function runOne(userId: string): Promise<boolean> {
    const leaseToken = randomUUID()
    const job = await deps.claim({ userId, leaseToken, leaseMs: deps.leaseMs ?? 120_000, jobKinds: ['template_compile'] })
    if (!job) return false
    let importDiagnostics: OfficeImportDiagnostic[] | undefined
    try {
      const brief = job.brief as { templateId?: unknown; source?: { kind?: unknown; fileId?: unknown } }
      if (typeof brief.templateId !== 'string') throw new Error('invalid_template_compile_brief')
      const template = await deps.getTemplate(userId, brief.templateId)
      if (!template || template.workspaceId !== job.workspaceId || template.draftArtifactId !== job.artifactId) throw new Error('template_compile_source_not_found')
      const artifact = await deps.getArtifact(userId, job.artifactId)
      if (!artifact || artifact.workspaceId !== job.workspaceId || artifact.mode !== 'template' || artifact.lifecycleState !== 'active') throw new Error('template_compile_source_not_found')
      let live: { snapshot: OfficeArtifactSnapshot } | null
      let resourceAdmissions: BoundTemplateResourceAdmission[] = []
      if (brief.source?.kind === 'upload') {
        if (typeof brief.source.fileId !== 'string') throw new Error('invalid_template_upload_brief')
        const source = await deps.readSource({ userId, workspaceId: job.workspaceId, assistantId: job.assistantId, fileId: brief.source.fileId })
        const retryScope = (job.authorityProjection as { retryScope?: { clearance?: 'public' | 'internal' | 'confidential'; compartmentGrant?: string[] | null; projectGrant?: string[] | null } })?.retryScope
        if (retryScope) for (const scope of [artifact, source.binding]) {
          if (retryScope.clearance && !canRead(retryScope.clearance,scope.sensitivity) || !scopeGrantContains(retryScope.compartmentGrant,scope.compartments) || !scopeGrantContains(retryScope.projectGrant,scope.projectIds)) throw new Error('office_template_retry_scope_denied')
        }
        const context = { artifactId: job.artifactId, workspaceId: job.workspaceId, templateVersionId: null, locale: 'en-US', defaultLanguage: 'en-US', title: template.name }
        const imported = template.family === 'document'
          ? await importOfficeDocument(source.bytes, context)
          : template.family === 'presentation'
            ? await importOfficePresentation(source.bytes, context)
            : await importOfficeSpreadsheet(source.bytes, context)
        if (!imported.ok || !imported.snapshot) {
          importDiagnostics = imported.diagnostics.filter(item => item.severity === 'error').slice(0, 20).map(item => ({
            reason: item.message.startsWith('Conditional-format rule ') ? 'conditional_format'
              : item.message.startsWith('Workbook protection ') ? 'workbook_protection'
              : item.message.startsWith('Worksheet protection ') ? 'worksheet_protection'
              : item.code.startsWith('package.') ? 'unsupported_content' : 'invalid_file',
            ...(/^[A-Za-z0-9_./-]{1,200}$/.test(item.path) ? { part: item.path } : {}),
          }))
          throw new Error(imported.diagnostics.map((item) => `${item.path}: ${item.message}`).join('; ') || 'template_upload_import_failed')
        }
        const currentSource = await deps.readSource({ userId, workspaceId: job.workspaceId, assistantId: job.assistantId, fileId: brief.source.fileId })
        const currentTemplate = await deps.getTemplate(userId, brief.templateId)
        const currentArtifact = await deps.getArtifact(userId, job.artifactId)
        if (!sameOfficeFileBinding(source.binding, currentSource.binding) || JSON.stringify(currentTemplate) !== JSON.stringify(template) || JSON.stringify(currentArtifact) !== JSON.stringify(artifact)) throw new Error('office_source_changed')
        const scope = classifyOfficeOutput(artifactOutputScope(artifact), source.binding)
        if (!await deps.raiseArtifactScope({ userId, artifactId: artifact.id, ...scope })) throw new Error('office_projection_changed')
        resourceAdmissions = (await Promise.all(imported.resources.map(async (resource) => {
          const admission = await deps.saveImportedResource({ userId, workspaceId: job.workspaceId, assistantId: job.assistantId, resource, sourceBinding: source.binding, scope })
          return { ...admission, sourceBinding: source.binding }
        })))
        const snapshot: OfficeArtifactSnapshot = remapSnapshotResources({
          ...imported.snapshot,
          artifactId: job.artifactId,
          workspaceId: job.workspaceId,
          templateVersionId: null,
          title: template.name,
          accessibility: { ...imported.snapshot.accessibility, title: template.name },
        }, resourceAdmissions, imported.resources)
        const [finalSource, finalTemplate, finalArtifact] = await Promise.all([
          deps.readSource({ userId, workspaceId: job.workspaceId, assistantId: job.assistantId, fileId: brief.source.fileId }),
          deps.getTemplate(userId, brief.templateId),
          deps.getArtifact(userId, job.artifactId),
        ])
        if (!sameOfficeFileBinding(source.binding, finalSource.binding) || JSON.stringify(finalTemplate) !== JSON.stringify(template) ||
          !finalArtifact || JSON.stringify(artifactOutputScope(finalArtifact)) !== JSON.stringify(scope)) throw new Error('office_source_changed')
        await deps.initialize({ userId, artifactId: job.artifactId, snapshot, expectedSeq: 1 })
        live = { snapshot }
        const routing = inferOfficeTemplateRouting(snapshot, 'upload')
        if (!await deps.saveDraftRouting({ userId, templateId: template.id, routing })) throw new Error('template_routing_not_saved')
        await deps.appendEvent({ userId, jobId: job.id, workspaceId: job.workspaceId, code: 'office.job.completed', values: { kind: 'template_routing_analysis' }, actorType: 'system', safeNarration: 'Template routing ready for review' })
        await deps.finish({ userId, jobId: job.id, leaseToken, status: 'completed', stage: 'completed' })
        return true
      } else {
        live = await deps.getSnapshot(userId, job.artifactId)
      }
      if (!live || live.snapshot.family !== template.family) throw new Error('template_compile_source_not_found')
      let routingInput = await deps.getDraftRouting(userId, template.id)
      if (!routingInput) {
        routingInput = inferOfficeTemplateRouting(live.snapshot, brief.source?.kind === 'promote' ? 'promote' : 'scratch')
        if (!await deps.saveDraftRouting({ userId, templateId: template.id, routing: routingInput })) throw new Error('template_routing_not_saved')
      }
      const routing = OfficeTemplateRoutingDraftSchema.parse(routingInput)
      const routingDiagnostics = officeTemplateRoutingDiagnostics(live.snapshot, routing)
      if (routingDiagnostics.length > 0) throw new Error(routingDiagnostics.join('; '))
      resourceAdmissions = await deps.loadResourceAdmissions({ userId, workspaceId: job.workspaceId, resourceIds: live.snapshot.resources.map((resource) => resource.id) })
      const inputRevision = compileInputRevision({ template, artifact, snapshot: live.snapshot, resources: resourceAdmissions })
      const sourceHash = createHash('sha256').update(JSON.stringify(live.snapshot)).digest('hex')
      const draft = {
        id: template.id,
        workspaceId: template.workspaceId,
        family: live.snapshot.family,
        version: 1,
        status: 'draft' as const,
        name: template.name,
        description: template.description,
        tags: ['workspace'],
        locales: [live.snapshot.locale],
        whenToUse: [template.description],
        whenNotToUse: ['When another admitted template is a better match'],
        exampleRequests: [`Create ${template.name}`],
        fields: routing.fields,
        slideRecipes: routing.slideRecipes,
        snapshot: live.snapshot,
        resources: live.snapshot.resources,
        lockedObjectIds: live.snapshot.family === 'presentation' ? live.snapshot.slides.flatMap((slide) => slide.objects.filter((object) => object.locked).map((object) => object.id)) : [],
        allowedRepeatTargetIds: routing.slideRecipes.filter((recipe) => recipe.enabled && recipe.repeatable).map((recipe) => recipe.slideId),
        requiredEvidence: [],
        sensitivity: template.sensitivity,
        visibilityUserIds: [],
        capabilityVersion: live.snapshot.capabilityVersion,
        sourceHash,
      }
      // The brand's APPROVED typography + rights registers
      // (docs/architecture/features/brand.md → "Typography reaches the template
      // compiler"). Best-effort and warning-only: a brand read failing must not
      // fail template admission, and no brand contributes nothing.
      let brand: BrandTypographyContext | undefined
      try {
        const record = (await getBrandStore().get(userId, job.workspaceId))?.activeRecord
        if (record) brand = { typography: record.typography, rights: record.rights }
      } catch (err) {
        console.warn('[office-template] brand typography lookup failed:', err)
      }
      const compiled = await compileOfficeTemplate({
        authoringPath: routing.source === 'upload' ? 'upload' : routing.source === 'promote' ? 'promote_version' : 'scratch',
        draft,
        resources: resourceAdmissions,
        brand,
      })
      const bundleBytes = new TextEncoder().encode(JSON.stringify(compiled.bundle ?? draft))
      const bundleHash = createHash('sha256').update(bundleBytes).digest('hex')
      const [checkedTemplate, checkedArtifact, checkedLive, checkedResources] = await Promise.all([
        deps.getTemplate(userId, template.id),
        deps.getArtifact(userId, artifact.id),
        deps.getSnapshot(userId, artifact.id),
        deps.loadResourceAdmissions({ userId, workspaceId: job.workspaceId, resourceIds: live.snapshot.resources.map((resource) => resource.id) }),
      ])
      if (!checkedTemplate || !checkedArtifact || !checkedLive || compileInputRevision({ template: checkedTemplate, artifact: checkedArtifact, snapshot: checkedLive.snapshot, resources: checkedResources }) !== inputRevision) throw new Error('office_projection_changed')
      const scope = classifyOfficeOutput(artifactOutputScope(artifact), ...resourceAdmissions.map(({ sourceBinding }) => sourceBinding))
      if (!await deps.raiseArtifactScope({ userId, artifactId: artifact.id, ...scope })) throw new Error('office_projection_changed')
      const raisedArtifact = await deps.getArtifact(userId, artifact.id)
      if (!raisedArtifact || JSON.stringify(artifactOutputScope(raisedArtifact)) !== JSON.stringify(scope)) throw new Error('office_projection_changed')
      const bundleFileId = await deps.saveBundle({ userId, workspaceId: job.workspaceId, templateId: template.id, hash: bundleHash, bytes: bundleBytes, scope })
      const [finalTemplate, finalArtifact, finalLive, finalResources] = await Promise.all([
        deps.getTemplate(userId, template.id),
        deps.getArtifact(userId, artifact.id),
        deps.getSnapshot(userId, artifact.id),
        deps.loadResourceAdmissions({ userId, workspaceId: job.workspaceId, resourceIds: live.snapshot.resources.map((resource) => resource.id) }),
      ])
      if (!finalTemplate || !finalArtifact || !finalLive || compileInputRevision({ template: finalTemplate, artifact: finalArtifact, snapshot: finalLive.snapshot, resources: finalResources }) !==
        compileInputRevision({ template, artifact: raisedArtifact, snapshot: live.snapshot, resources: resourceAdmissions })) throw new Error('office_projection_changed')
      await deps.addVersion({
        userId,
        templateId: template.id,
        workspaceId: job.workspaceId,
        bundleFileId,
        bundleHash,
        resourceIds: live.snapshot.resources.map(resource => resource.id),
        capabilityVersion: live.snapshot.capabilityVersion,
        locales: draft.locales,
        tags: draft.tags,
        whenToUse: draft.whenToUse,
        whenNotToUse: draft.whenNotToUse,
        exampleRequests: draft.exampleRequests,
        fieldSchema: draft.fields,
        admissionReceipt: compiled.receipt,
        provenance: { authoringPath: compiled.receipt.authoringPath, sourceHash },
        status: compiled.receipt.ok ? 'admitted' : 'draft',
      })
      if (!compiled.receipt.ok) throw new Error(compiled.receipt.diagnostics.map((item) => `${item.path}: ${item.message}`).join('; ') || 'template_admission_failed')
      await deps.appendEvent({ userId, jobId: job.id, workspaceId: job.workspaceId, code: 'office.job.completed', values: { kind: 'template_compile' }, actorType: 'system', safeNarration: 'Template admitted' })
      await deps.finish({ userId, jobId: job.id, leaseToken, status: 'completed', stage: 'completed' })
    } catch (cause) {
      const errorDetail = cause instanceof Error ? cause.message : String(cause)
      // Briefs can be malformed; only project string IDs into the backend log.
      const brief = job.brief as { templateId?: unknown; source?: { fileId?: unknown } | null } | null
      console.error('[office-template] compile failed', {
        jobId: job.id,
        workspaceId: job.workspaceId,
        artifactId: job.artifactId,
        templateId: typeof brief?.templateId === 'string' ? brief.templateId : undefined,
        sourceFileId: typeof brief?.source?.fileId === 'string' ? brief.source.fileId : undefined,
        errorDetail,
      })
      await deps.appendEvent({ userId, jobId: job.id, workspaceId: job.workspaceId, code: 'office.job.failed', values: { code: 'template_compile_failed' }, actorType: 'system', safeNarration: 'Template admission failed' })
      await deps.finish({ userId, jobId: job.id, leaseToken, status: 'failed', stage: 'failed', errorCode: 'template_compile_failed', errorDetail, ...(importDiagnostics ? { importDiagnostics } : {}) })
    }
    return true
  }
}
