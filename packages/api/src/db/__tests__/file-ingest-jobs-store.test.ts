import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
}))

import {
  enqueueFileIngestJob,
  claimNextFileIngestJob,
  markFileIngestJobFailed,
  markFileIngestJobDone,
  getFileIngestJob,
  countRecentFileIngestJobs,
  FILE_INGEST_JOB_MAX_ATTEMPTS,
} from '../file-ingest-jobs-store.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:files/file-ingest-jobs-store] file-ingest job queue', () => {
  it('enqueue returns the new job id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'job-1' }] } as never)
    const res = await enqueueFileIngestJob({ fileId: 'file-1', workspaceId: 'ws-1', actingUserId: 'u-1' })
    expect(res).toEqual({ enqueued: true, jobId: 'job-1' })
  })

  it('enqueue is idempotent — ON CONFLICT DO NOTHING yields enqueued:false', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    const res = await enqueueFileIngestJob({ fileId: 'file-1', workspaceId: 'ws-1', actingUserId: 'u-1' })
    expect(res).toEqual({ enqueued: false, jobId: null })
  })

  it('enqueue defaults source_label to "upload" and assistant_id to NULL', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'job-1' }] } as never)
    await enqueueFileIngestJob({ fileId: 'file-1', workspaceId: 'ws-1', actingUserId: 'u-1' })
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO file_ingest_jobs'),
      ['file-1', 'ws-1', 'u-1', null, 'upload'],
    )
  })

  it('enqueue forwards assistant_id and a custom source_label', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'job-2' }] } as never)
    await enqueueFileIngestJob({
      fileId: 'file-1', workspaceId: 'ws-1', actingUserId: 'u-1', assistantId: 'a-1', sourceLabel: 'paste',
    })
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO file_ingest_jobs'),
      ['file-1', 'ws-1', 'u-1', 'a-1', 'paste'],
    )
  })

  it('claim returns the mapped job or null when the queue is empty', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'job-1', fileId: 'file-1', workspaceId: 'ws-1', actingUserId: 'u-1', assistantId: null, sourceLabel: 'upload', status: 'processing', attempts: 1, lastError: null },
      ],
    } as never)
    expect(await claimNextFileIngestJob()).toMatchObject({ id: 'job-1', status: 'processing', attempts: 1 })

    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    expect(await claimNextFileIngestJob()).toBeNull()
  })

  it('markFailed re-queues while attempts remain, parks at the cap', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ attempts: 1 }] } as never)
    expect(await markFileIngestJobFailed('job-1', 'boom')).toEqual({ retrying: true })

    mockQuery.mockResolvedValueOnce({ rows: [{ attempts: FILE_INGEST_JOB_MAX_ATTEMPTS }] } as never)
    expect(await markFileIngestJobFailed('job-1', 'boom')).toEqual({ retrying: false })
  })

  it('markDone issues the update', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    await markFileIngestJobDone('job-1')
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining("status = 'done'"), ['job-1'])
  })

  it('getFileIngestJob maps a row or returns null', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'job-1', fileId: 'file-1', workspaceId: 'ws-1', actingUserId: 'u-1', assistantId: 'a-1', sourceLabel: 'upload', status: 'done', attempts: 1, lastError: null }],
    } as never)
    expect(await getFileIngestJob('job-1')).toMatchObject({ id: 'job-1', status: 'done', assistantId: 'a-1' })

    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    expect(await getFileIngestJob('nope')).toBeNull()
  })

  it('countRecentFileIngestJobs coerces the count and passes an ISO cutoff', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '4' }] } as never)
    const since = Date.UTC(2026, 0, 1)
    expect(await countRecentFileIngestJobs('ws-1', since)).toBe(4)
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('count(*)'),
      ['ws-1', new Date(since).toISOString()],
    )
  })
})
