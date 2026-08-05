import { describe, expect, it, vi } from 'vitest'
import { exportOfficePresentation } from '@use-brian/core'
import type { PresentationSnapshot } from '@use-brian/office-model'
import { createOfficeGenerationWorker } from '../generation-worker.js'
import { createOfficeImportWorker } from '../import-worker.js'
import { createOfficeService } from '../service.js'
import { createOfficeTemplateCompileWorker } from '../template-compile-worker.js'
import type { OfficeGenerationJobRow } from '../../db/office-generation.js'

describe('[COMP:api/office-generation] Office generation worker', () => {
  it('removes an empty artifact shell when durable job admission fails', async () => {
    const failure = new Error('job insert failed')
    const deps = {
      generationAvailable: vi.fn(() => true),
      createShell: vi.fn(async () => ({ id: 'artifact-1' } as never)),
      deleteEmptyShell: vi.fn(async () => true),
      createJob: vi.fn(async () => { throw failure }),
      getArtifact: vi.fn(), resolveAccess: vi.fn(), latestJob: vi.fn(),
    }
    const service = createOfficeService(deps)
    await expect(service.create({
      userId: 'user-1', assistantId: 'assistant-1', workspaceId: 'workspace-1',
      family: 'presentation', outcome: 'Company introduction', audience: 'Public',
      sourceHandles: [], canonicalWebsite: 'https://example.com', companyHasNoWebsite: false,
      idempotencyKey: 'request-12345678',
    })).rejects.toBe(failure)
    expect(deps.deleteEmptyShell).toHaveBeenCalledWith('user-1', 'artifact-1')
  })

  it('rejects creation before writing a shell when no runner is configured', async () => {
    const deps = {
      generationAvailable: vi.fn(() => false),
      createShell: vi.fn(), deleteEmptyShell: vi.fn(), createJob: vi.fn(),
      getArtifact: vi.fn(), resolveAccess: vi.fn(), latestJob: vi.fn(),
    }
    const service = createOfficeService(deps as never)
    await expect(service.create({
      userId: 'user-1', assistantId: 'assistant-1', workspaceId: 'workspace-1',
      family: 'presentation', outcome: 'Company introduction', audience: 'Public',
      sourceHandles: [], canonicalWebsite: 'https://example.com', companyHasNoWebsite: false,
      idempotencyKey: 'request-12345678',
    })).rejects.toMatchObject({ code: 'office_generation_unavailable' })
    expect(deps.createShell).not.toHaveBeenCalled()
  })

  it('removes the speculative shell when an idempotent retry returns the original job', async () => {
    const deps = {
      generationAvailable: vi.fn(() => true),
      createShell: vi.fn(async () => ({ id: 'new-shell' } as never)),
      deleteEmptyShell: vi.fn(async () => true),
      createJob: vi.fn(async () => ({ id: 'original-job', artifactId: 'original-artifact' } as never)),
      getArtifact: vi.fn(), resolveAccess: vi.fn(), latestJob: vi.fn(),
    }
    const service = createOfficeService(deps)
    await expect(service.create({
      userId: 'user-1', assistantId: 'assistant-1', workspaceId: 'workspace-1',
      family: 'document', outcome: 'Board memo', audience: 'Board', sourceHandles: [],
      canonicalWebsite: 'https://example.com', companyHasNoWebsite: false,
      idempotencyKey: 'request-12345678',
    })).resolves.toEqual({ artifactId: 'original-artifact', jobId: 'original-job' })
    expect(deps.deleteEmptyShell).toHaveBeenCalledWith('user-1', 'new-shell')
  })

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
    const templateDeps = { claim: vi.fn(async () => templateJob), getSnapshot: vi.fn(), getTemplate: vi.fn(), readSource: vi.fn(), initialize: vi.fn(), saveBundle: vi.fn(), addVersion: vi.fn(), appendEvent: vi.fn(async () => ({})), finish: vi.fn(async () => true) }
    const templateWorker = createOfficeTemplateCompileWorker(templateDeps)
    await expect(templateWorker(base.initiatedByUserId)).resolves.toBe(true)
    expect(templateDeps.finish).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', errorCode: 'template_compile_failed' }))
  })

  it('imports an uploaded PPTX into the linked template draft before admission', async () => {
    const workspaceId = '30000000-0000-4000-8000-000000000102'
    const artifactId = '30000000-0000-4000-8000-000000000103'
    const userId = '30000000-0000-4000-8000-000000000104'
    const templateId = '30000000-0000-4000-8000-000000000105'
    const source: PresentationSnapshot = {
      schemaVersion: 1,
      capabilityVersion: 1,
      artifactId: '30000000-0000-4000-8000-000000000106',
      workspaceId,
      family: 'presentation',
      locale: 'en-US',
      defaultLanguage: 'en-US',
      templateVersionId: null,
      rootId: '30000000-0000-4000-8000-000000000107',
      title: 'Uploaded deck',
      resources: [],
      accessibility: { title: 'Uploaded deck' },
      slideSize: { widthPt: 960, heightPt: 540 },
      themeId: '30000000-0000-4000-8000-000000000108',
      masters: [{ id: '30000000-0000-4000-8000-000000000109', name: 'Master', lockedObjectIds: [] }],
      layouts: [{ id: '30000000-0000-4000-8000-000000000110', masterId: '30000000-0000-4000-8000-000000000109', name: 'Blank', placeholderIds: [] }],
      slides: [{ id: '30000000-0000-4000-8000-000000000111', title: 'Imported slide', masterId: '30000000-0000-4000-8000-000000000109', layoutId: '30000000-0000-4000-8000-000000000110', objects: [], readingOrder: [], notes: [] }],
    }
    const uploaded = await exportOfficePresentation(source)
    const job = {
      id: '30000000-0000-4000-8000-000000000101', workspaceId, artifactId, initiatedByUserId: userId,
      assistantId: null, jobKind: 'template_compile', status: 'queued', stage: 'queued',
      brief: { templateId, source: { kind: 'upload', fileId: '30000000-0000-4000-8000-000000000112' } },
      authorityProjection: {}, templateVersionId: null, baseArtifactVersion: 0, checkpoint: {}, checkpointVersion: 0,
      leaseToken: null, leaseExpiresAt: null, cancelRequestedAt: null, errorCode: null, createdAt: new Date(), updatedAt: new Date(),
    } as OfficeGenerationJobRow
    const deps = {
      claim: vi.fn(async () => job),
      getSnapshot: vi.fn(),
      getTemplate: vi.fn(async () => ({ id: templateId, workspaceId, family: 'presentation' as const, name: 'Company deck', description: 'Use for company introductions', sensitivity: 'internal' as const, draftArtifactId: artifactId })),
      readSource: vi.fn(async () => uploaded.bytes),
      initialize: vi.fn(async () => undefined),
      saveBundle: vi.fn(async () => '30000000-0000-4000-8000-000000000113'),
      addVersion: vi.fn(async () => ({ id: '30000000-0000-4000-8000-000000000114', version: 1 })),
      appendEvent: vi.fn(async () => ({})),
      finish: vi.fn(async () => true),
    }

    await expect(createOfficeTemplateCompileWorker(deps)(userId)).resolves.toBe(true)

    expect(deps.readSource).toHaveBeenCalledWith(expect.objectContaining({ fileId: '30000000-0000-4000-8000-000000000112' }))
    expect(deps.initialize).toHaveBeenCalledWith(expect.objectContaining({ artifactId, snapshot: expect.objectContaining({ artifactId, workspaceId, title: 'Company deck', family: 'presentation' }) }))
    const initialized = (deps.initialize.mock.calls as unknown as Array<[{ snapshot: PresentationSnapshot }]>)[0]?.[0].snapshot
    expect(initialized?.family === 'presentation' ? initialized.slides[0]?.title : null).toBe('Imported slide')
    expect(deps.getSnapshot).not.toHaveBeenCalled()
    expect(deps.addVersion).toHaveBeenCalledWith(expect.objectContaining({ status: 'admitted' }))
    expect(deps.finish).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
  })
})
