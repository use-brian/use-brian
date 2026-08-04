import { describe, expect, it, vi } from 'vitest'
import { createOfficeGenerationWorker } from '../generation-worker.js'
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
})
