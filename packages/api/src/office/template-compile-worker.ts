/** Template-mode admission worker for scratch/promote/upload jobs.
 * [COMP:api/office-generation] */
import { createHash, randomUUID } from 'node:crypto'
import {
  compileOfficeTemplate,
  inferOfficeTemplateRouting,
  importOfficeDocument,
  importOfficePresentation,
  importOfficeSpreadsheet,
  officeTemplateRoutingDiagnostics,
  type ExtractedOfficeResource,
  type OfficeTemplateAdmissionReceipt,
  type OfficeTemplateResourceAdmission,
} from '@use-brian/core'
import { OfficeTemplateRoutingDraftSchema, type OfficeArtifactSnapshot } from '@use-brian/office-model'
import type { OfficeGenerationJobRow } from '../db/office-generation.js'

export type OfficeTemplateCompileWorkerDeps = {
  claim(params: { userId: string; leaseToken: string; leaseMs: number; jobKinds: OfficeGenerationJobRow['jobKind'][] }): Promise<OfficeGenerationJobRow | null>
  getSnapshot(userId: string, artifactId: string): Promise<{ snapshot: OfficeArtifactSnapshot } | null>
  getTemplate(userId: string, templateId: string): Promise<{ id: string; workspaceId: string; family: 'document' | 'presentation' | 'spreadsheet'; name: string; description: string; sensitivity: 'public' | 'internal' | 'confidential'; draftArtifactId: string | null } | null>
  readSource(params: { userId: string; workspaceId: string; assistantId: string | null; fileId: string }): Promise<Uint8Array>
  initialize(params: { userId: string; artifactId: string; snapshot: OfficeArtifactSnapshot }): Promise<void>
  saveImportedResource(params: { userId: string; workspaceId: string; resource: ExtractedOfficeResource }): Promise<OfficeTemplateResourceAdmission>
  loadResourceAdmissions(params: { userId: string; workspaceId: string; resourceIds: string[] }): Promise<OfficeTemplateResourceAdmission[]>
  getDraftRouting(userId: string, templateId: string): Promise<unknown | null>
  saveDraftRouting(params: { userId: string; templateId: string; routing: unknown }): Promise<boolean>
  saveBundle(params: { userId: string; workspaceId: string; templateId: string; hash: string; bytes: Uint8Array }): Promise<string>
  addVersion(params: { userId: string; templateId: string; workspaceId: string; bundleFileId: string; bundleHash: string; capabilityVersion: number; locales: string[]; tags: string[]; whenToUse: string[]; whenNotToUse: string[]; exampleRequests: string[]; fieldSchema: unknown; admissionReceipt: OfficeTemplateAdmissionReceipt; provenance: unknown; status: 'draft' | 'admitted' }): Promise<unknown>
  appendEvent(params: { userId: string; jobId: string; workspaceId: string; code: string; values: Record<string, string | number | boolean>; actorType: 'system'; safeNarration: string }): Promise<unknown>
  finish(params: { userId: string; jobId: string; leaseToken: string; status: 'completed' | 'failed'; stage: string; errorCode?: string; errorDetail?: string }): Promise<boolean>
  leaseMs?: number
}

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
    try {
      const brief = job.brief as { templateId?: unknown; source?: { kind?: unknown; fileId?: unknown } }
      if (typeof brief.templateId !== 'string') throw new Error('invalid_template_compile_brief')
      const template = await deps.getTemplate(userId, brief.templateId)
      if (!template || template.workspaceId !== job.workspaceId || template.draftArtifactId !== job.artifactId) throw new Error('template_compile_source_not_found')
      let live: { snapshot: OfficeArtifactSnapshot } | null
      let resourceAdmissions: OfficeTemplateResourceAdmission[] = []
      if (brief.source?.kind === 'upload') {
        if (typeof brief.source.fileId !== 'string') throw new Error('invalid_template_upload_brief')
        const bytes = await deps.readSource({ userId, workspaceId: job.workspaceId, assistantId: job.assistantId, fileId: brief.source.fileId })
        const context = { artifactId: job.artifactId, workspaceId: job.workspaceId, templateVersionId: null, locale: 'en-US', defaultLanguage: 'en-US', title: template.name }
        const imported = template.family === 'document'
          ? await importOfficeDocument(bytes, context)
          : template.family === 'presentation'
            ? await importOfficePresentation(bytes, context)
            : await importOfficeSpreadsheet(bytes, context)
        if (!imported.ok || !imported.snapshot) throw new Error(imported.diagnostics.map((item) => `${item.path}: ${item.message}`).join('; ') || 'template_upload_import_failed')
        resourceAdmissions = await Promise.all(imported.resources.map((resource) => deps.saveImportedResource({ userId, workspaceId: job.workspaceId, resource })))
        const snapshot: OfficeArtifactSnapshot = remapSnapshotResources({
          ...imported.snapshot,
          artifactId: job.artifactId,
          workspaceId: job.workspaceId,
          templateVersionId: null,
          title: template.name,
          accessibility: { ...imported.snapshot.accessibility, title: template.name },
        }, resourceAdmissions, imported.resources)
        await deps.initialize({ userId, artifactId: job.artifactId, snapshot })
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
      const compiled = await compileOfficeTemplate({
        authoringPath: routing.source === 'upload' ? 'upload' : routing.source === 'promote' ? 'promote_version' : 'scratch',
        draft,
        resources: resourceAdmissions,
      })
      const bundleBytes = new TextEncoder().encode(JSON.stringify(compiled.bundle ?? draft))
      const bundleHash = createHash('sha256').update(bundleBytes).digest('hex')
      const bundleFileId = await deps.saveBundle({ userId, workspaceId: job.workspaceId, templateId: template.id, hash: bundleHash, bytes: bundleBytes })
      await deps.addVersion({
        userId,
        templateId: template.id,
        workspaceId: job.workspaceId,
        bundleFileId,
        bundleHash,
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
      await deps.appendEvent({ userId, jobId: job.id, workspaceId: job.workspaceId, code: 'office.job.failed', values: { code: 'template_compile_failed' }, actorType: 'system', safeNarration: 'Template admission failed' })
      await deps.finish({ userId, jobId: job.id, leaseToken, status: 'failed', stage: 'failed', errorCode: 'template_compile_failed', errorDetail: cause instanceof Error ? cause.message : String(cause) })
    }
    return true
  }
}
