/** Template-mode admission worker for scratch/promote/upload jobs.
 * [COMP:api/office-generation] */
import { createHash, randomUUID } from 'node:crypto'
import {
  compileOfficeTemplate,
  type OfficeTemplateAdmissionReceipt,
} from '@use-brian/core'
import type { OfficeArtifactSnapshot } from '@use-brian/office-model'
import type { OfficeGenerationJobRow } from '../db/office-generation.js'

export type OfficeTemplateCompileWorkerDeps = {
  claim(params: { userId: string; leaseToken: string; leaseMs: number; jobKinds: OfficeGenerationJobRow['jobKind'][] }): Promise<OfficeGenerationJobRow | null>
  getSnapshot(userId: string, artifactId: string): Promise<{ snapshot: OfficeArtifactSnapshot } | null>
  getTemplate(userId: string, templateId: string): Promise<{ id: string; workspaceId: string; name: string; description: string; sensitivity: 'public' | 'internal' | 'confidential' } | null>
  saveBundle(params: { userId: string; workspaceId: string; templateId: string; hash: string; bytes: Uint8Array }): Promise<string>
  addVersion(params: { userId: string; templateId: string; workspaceId: string; bundleFileId: string; bundleHash: string; capabilityVersion: number; locales: string[]; tags: string[]; whenToUse: string[]; whenNotToUse: string[]; exampleRequests: string[]; fieldSchema: unknown; admissionReceipt: OfficeTemplateAdmissionReceipt; provenance: unknown; status: 'draft' | 'admitted' }): Promise<unknown>
  appendEvent(params: { userId: string; jobId: string; workspaceId: string; code: string; values: Record<string, string | number | boolean>; actorType: 'system'; safeNarration: string }): Promise<unknown>
  finish(params: { userId: string; jobId: string; leaseToken: string; status: 'completed' | 'failed'; stage: string; errorCode?: string; errorDetail?: string }): Promise<boolean>
  leaseMs?: number
}

export function createOfficeTemplateCompileWorker(deps: OfficeTemplateCompileWorkerDeps) {
  return async function runOne(userId: string): Promise<boolean> {
    const leaseToken = randomUUID()
    const job = await deps.claim({ userId, leaseToken, leaseMs: deps.leaseMs ?? 120_000, jobKinds: ['template_compile'] })
    if (!job) return false
    try {
      const brief = job.brief as { templateId?: unknown; source?: { kind?: unknown } }
      if (typeof brief.templateId !== 'string') throw new Error('invalid_template_compile_brief')
      const [live, template] = await Promise.all([
        deps.getSnapshot(userId, job.artifactId),
        deps.getTemplate(userId, brief.templateId),
      ])
      if (!live || !template || template.workspaceId !== job.workspaceId) throw new Error('template_compile_source_not_found')
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
        fields: [],
        snapshot: live.snapshot,
        resources: live.snapshot.resources,
        lockedObjectIds: [],
        allowedRepeatTargetIds: [],
        requiredEvidence: [],
        sensitivity: template.sensitivity,
        visibilityUserIds: [],
        capabilityVersion: live.snapshot.capabilityVersion,
        sourceHash,
      }
      const compiled = await compileOfficeTemplate({
        authoringPath: brief.source?.kind === 'upload' ? 'upload' : brief.source?.kind === 'promote' ? 'promote_version' : 'scratch',
        draft,
        resources: [],
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
