import { describe, expect, it, vi } from 'vitest'
import { createOfficeGenerationWorker } from '../generation-worker.js'
import { createOfficeImportWorker } from '../import-worker.js'
import { createOfficeTemplateCompileWorker } from '../template-compile-worker.js'
import type { OfficeGenerationJobRow } from '../../db/office-generation.js'

describe('[COMP:api/office-generation] Office generation worker', () => {
  it('claims work, persists localized events, and records a terminal failure', async () => {
    const job = { id: '30000000-0000-4000-8000-000000000001', workspaceId: '30000000-0000-4000-8000-000000000002', artifactId: '30000000-0000-4000-8000-000000000003', initiatedByUserId: '30000000-0000-4000-8000-000000000004', assistantId: '30000000-0000-4000-8000-000000000005', jobKind: 'create', status: 'queued', stage: 'queued', brief: {}, authorityProjection: {}, templateVersionId: null, baseArtifactVersion: 0, checkpoint: {}, checkpointVersion: 0, leaseToken: null, leaseExpiresAt: null, cancelRequestedAt: null, errorCode: null, createdAt: new Date(), updatedAt: new Date() } as OfficeGenerationJobRow
    const store = { claim: vi.fn(async () => job), checkpoint: vi.fn(async () => true), appendEvent: vi.fn(async () => ({})), drainSteering: vi.fn(async () => []), finish: vi.fn(async () => true) }
    const worker = createOfficeGenerationWorker({ store, workerUserId: job.initiatedByUserId, buildPipelineDeps: () => ({
      resolveAuthority: vi.fn(async () => null), selectTemplate: vi.fn(), retrieveBrain: vi.fn(), inspectWebsite: vi.fn(), planClaims: vi.fn(), construct: vi.fn(), processMedia: vi.fn(), resolveResource: async () => null, cancelled: vi.fn(async () => false), commit: vi.fn(),
    }) })
    const status = await worker.runOnce()
    expect(status).toBe('failed')
    expect(store.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ code: 'office.job.failed', safeNarration: 'Generation failed' }))
    expect(store.finish).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', errorCode: 'brief_invalid' }))
  })

  it('consumes import and template-admission jobs through bounded workers', async () => {
    const base = { id: '30000000-0000-4000-8000-000000000011', workspaceId: '30000000-0000-4000-8000-000000000002', artifactId: '30000000-0000-4000-8000-000000000003', initiatedByUserId: '30000000-0000-4000-8000-000000000004', assistantId: null, status: 'queued', stage: 'queued', brief: {}, authorityProjection: {}, templateVersionId: null, baseArtifactVersion: 0, checkpoint: {}, checkpointVersion: 0, leaseToken: null, leaseExpiresAt: null, cancelRequestedAt: null, errorCode: null, createdAt: new Date(), updatedAt: new Date() }
    const importStore = { claim: vi.fn(async () => ({ ...base, jobKind: 'import' as const } as OfficeGenerationJobRow)), appendEvent: vi.fn(async () => ({})), finish: vi.fn(async () => true) }
    const importWorker = createOfficeImportWorker({ store: importStore as never, readSource: vi.fn(), initialize: vi.fn(), context: vi.fn() })
    await expect(importWorker(base.initiatedByUserId)).resolves.toBe(true)
    expect(importStore.finish).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', errorCode: 'import_failed' }))

    const templateJob = { ...base, id: '30000000-0000-4000-8000-000000000012', jobKind: 'template_compile' as const } as OfficeGenerationJobRow
    const templateDeps = { claim: vi.fn(async () => templateJob), getSnapshot: vi.fn(), getTemplate: vi.fn(), saveBundle: vi.fn(), addVersion: vi.fn(), appendEvent: vi.fn(async () => ({})), finish: vi.fn(async () => true) }
    const templateWorker = createOfficeTemplateCompileWorker(templateDeps)
    await expect(templateWorker(base.initiatedByUserId)).resolves.toBe(true)
    expect(templateDeps.finish).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', errorCode: 'template_compile_failed' }))
  })
})
