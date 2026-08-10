import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../client.js', () => ({ query: vi.fn() }))

import { query } from '../client.js'
import {
  enqueueGDriveLazyEnrichment,
  enqueueGDriveOfflineEnrichment,
  getGDriveEnrichmentStatus,
  markGDriveEnrichmentFailed,
} from '../gdrive-enrichment-store.js'

const mockQuery = vi.mocked(query)

describe('[COMP:integrations/gdrive-enrichment] Drive enrichment ledger', () => {
  beforeEach(() => vi.clearAllMocks())

  it('deduplicates lazy reads by the version-unique conflict key', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    const result = await enqueueGDriveLazyEnrichment({
      workspaceId: 'ws-1', connectorInstanceId: 'ci-1', actingUserId: 'u-1',
      assistantId: 'a-1', externalFileId: 'drive-1', sourceVersion: '128',
      fileName: 'Renewal playbook', mimeType: 'text/plain',
    })
    expect(result).toEqual({ enqueued: false, jobId: null })
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (workspace_id, connector_instance_id, external_file_id, source_version)'),
      expect.arrayContaining(['ws-1', 'ci-1', 'drive-1', '128']),
    )
  })

  it('authorizes an admin then bulk-inserts validated offline entries', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ role: 'admin' }] } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'job-1' }] } as never)
    const result = await enqueueGDriveOfflineEnrichment({
      actingUserId: 'u-1', workspaceId: 'ws-1', connectorInstanceId: 'ci-1',
      files: [{
        fileId: 'drive-1', version: '128', name: 'Renewal playbook',
        mimeType: 'text/plain', summary: 'Renewal instructions.',
      }],
    })
    expect(result).toEqual({ accepted: 1, skipped: 0 })
    expect(mockQuery.mock.calls[1]?.[0]).toContain("'offline_bundle'")
    expect(mockQuery.mock.calls[1]?.[0]).toContain('c.active = true')
  })

  it('reports per-status counts for the exact workspace and instance', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ role: 'owner' }] } as never)
      .mockResolvedValueOnce({ rows: [
        { status: 'done', count: '8', last_updated_at: new Date('2026-08-10T09:00:00Z') },
        { status: 'pending', count: '2', last_updated_at: new Date('2026-08-10T10:00:00Z') },
      ] } as never)
    expect(await getGDriveEnrichmentStatus({
      actingUserId: 'u-1', workspaceId: 'ws-1', connectorInstanceId: 'ci-1',
    })).toEqual({
      pending: 2, processing: 0, done: 8, failed: 0, superseded: 0,
      total: 10, lastUpdatedAt: '2026-08-10T10:00:00.000Z',
    })
  })

  it('retries a failed job below the bounded attempt cap', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ attempts: 1 }] } as never)
    expect(await markGDriveEnrichmentFailed('job-1', 'network error')).toEqual({ retrying: true })
  })
})
