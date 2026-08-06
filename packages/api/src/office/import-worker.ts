/** Bounded DOCX/PPTX/XLSX worker: parse, canonicalize, preflight, then initialize collaboration. [COMP:api/office-generation] */
import { randomUUID } from 'node:crypto'
import { importOfficeDocument, importOfficePresentation, importOfficeSpreadsheet, type OfficeImportContext } from '@use-brian/core'
import type { OfficeArtifactSnapshot } from '@use-brian/office-model'
import type { createOfficeGenerationStore } from '../db/office-generation.js'

type Store = ReturnType<typeof createOfficeGenerationStore>
export type OfficeImportWorkerDeps = {
  store: Store
  readSource(params: { userId: string; workspaceId: string; assistantId: string | null; fileId: string }): Promise<Uint8Array>
  initialize(params: { userId: string; artifactId: string; snapshot: OfficeArtifactSnapshot }): Promise<void>
  context(params: { userId: string; artifactId: string; templateVersionId: string }): Promise<OfficeImportContext>
  leaseMs?: number
}

export function createOfficeImportWorker(deps: OfficeImportWorkerDeps) {
  return async function runOne(userId: string): Promise<boolean> {
    const leaseToken = randomUUID()
    const job = await deps.store.claim({ userId, leaseToken, leaseMs: deps.leaseMs ?? 120_000, jobKinds: ['import'] })
    if (!job) return false
    try {
      const brief = job.brief as { sourceFileId?: unknown; family?: unknown }
      if (typeof brief.sourceFileId !== 'string' || (brief.family !== 'document' && brief.family !== 'presentation' && brief.family !== 'spreadsheet') || !job.templateVersionId) throw new Error('invalid_import_brief')
      const [bytes, context] = await Promise.all([deps.readSource({ userId, workspaceId: job.workspaceId, assistantId: job.assistantId, fileId: brief.sourceFileId }), deps.context({ userId, artifactId: job.artifactId, templateVersionId: job.templateVersionId })])
      const result = brief.family === 'document' ? await importOfficeDocument(bytes, context) : brief.family === 'presentation' ? await importOfficePresentation(bytes, context) : await importOfficeSpreadsheet(bytes, context)
      if (!result.ok || !result.snapshot) throw new Error(result.diagnostics.map((item) => `${item.path}: ${item.message}`).join('; ') || 'office_import_failed')
      await deps.initialize({ userId, artifactId: job.artifactId, snapshot: result.snapshot })
      await deps.store.appendEvent({ userId, jobId: job.id, workspaceId: job.workspaceId, code: 'office.job.completed', values: { family: brief.family }, actorType: 'system', safeNarration: 'Import completed' })
      await deps.store.finish({ userId, jobId: job.id, leaseToken, status: 'completed', stage: 'completed' })
    } catch (cause) {
      await deps.store.appendEvent({ userId, jobId: job.id, workspaceId: job.workspaceId, code: 'office.job.failed', values: { code: 'import_failed' }, actorType: 'system', safeNarration: 'Import failed' })
      await deps.store.finish({ userId, jobId: job.id, leaseToken, status: 'failed', stage: 'failed', errorCode: 'import_failed', errorDetail: cause instanceof Error ? cause.message : String(cause) })
    }
    return true
  }
}
