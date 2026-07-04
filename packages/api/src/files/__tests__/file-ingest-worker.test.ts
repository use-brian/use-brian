import { describe, it, expect, vi } from 'vitest'
import { createFileIngestWorker, type FileIngestWorkerDeps } from '../file-ingest-worker.js'
import type { FileIngestJob } from '../../db/file-ingest-jobs-store.js'

function job(over: Partial<FileIngestJob> = {}): FileIngestJob {
  return {
    id: 'job-1',
    fileId: 'file-1',
    workspaceId: 'ws-1',
    actingUserId: 'u-1',
    assistantId: 'a-1',
    sourceLabel: 'upload',
    status: 'processing',
    attempts: 1,
    lastError: null,
    ...over,
  }
}

/** A successful readBytes result carrying just the fields the worker reads. */
function readOk(mime: string, name = 'q3.md', path = '/uploads/q3.md') {
  return { ok: true, value: { file: { mime, name, path }, bytes: Buffer.from('x') } } as never
}

/** Base deps with every collaborator mocked; a text job that would fully index. */
function baseDeps(over: Partial<FileIngestWorkerDeps> = {}): FileIngestWorkerDeps {
  return {
    claim: vi.fn(),
    markDone: vi.fn(async () => {}),
    markFailed: vi.fn(async () => ({ retrying: false })),
    filesApi: { readBytes: vi.fn(async () => readOk('text/markdown')) },
    parse: vi.fn(async () => ({ text: 'hello world', summary: 's' })),
    index: vi.fn(async () => ({ segmentsInserted: 1, segmentCount: 1, truncated: false })),
    setIndexing: vi.fn(async () => {}),
    brainIngest: vi.fn(async () => ({ episodeId: 'ep-1' }) as never),
    stampSourceEpisode: vi.fn(async () => {}),
    ...over,
  }
}

/** A one-shot queue: yields `j` once, then drains empty. */
function claimOnce(j: FileIngestJob) {
  return vi.fn<() => Promise<FileIngestJob | null>>().mockResolvedValueOnce(j).mockResolvedValue(null)
}

describe('[COMP:files/file-ingest-worker] file-ingest drain loop', () => {
  it('claim -> parse -> index -> brainIngest -> stamp -> done for a text artifact', async () => {
    const deps = baseDeps({ claim: claimOnce(job()) })
    const w = createFileIngestWorker(deps)
    await w.tick()

    expect(deps.parse).toHaveBeenCalledWith(expect.any(Buffer), 'text/markdown', 'q3.md')
    expect(deps.index).toHaveBeenCalledWith({
      fileId: 'file-1', workspaceId: 'ws-1', text: 'hello world', actingUserId: 'u-1',
    })
    expect(deps.brainIngest).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'ws-1', userId: 'u-1', assistantId: 'a-1',
      sourceKind: 'file_upload',
      sourceRef: { file_id: 'file-1', path: '/uploads/q3.md' },
      contentRef: { source_kind: 'file_upload', file_id: 'file-1', text: 'hello world' },
    }))
    expect(deps.stampSourceEpisode).toHaveBeenCalledWith('file-1', 'ws-1', 'ep-1')
    expect(deps.markDone).toHaveBeenCalledWith('job-1')
    expect(deps.markFailed).not.toHaveBeenCalled()
  })

  it('store-only when no brainIngest port: chunks but skips decomposition', async () => {
    const deps = baseDeps({ claim: claimOnce(job()), brainIngest: undefined })
    const w = createFileIngestWorker(deps)
    await w.tick()

    expect(deps.index).toHaveBeenCalledTimes(1)
    expect(deps.stampSourceEpisode).not.toHaveBeenCalled()
    expect(deps.markDone).toHaveBeenCalledWith('job-1')
  })

  it('skips decomposition when the job carries no assistant', async () => {
    const deps = baseDeps({ claim: claimOnce(job({ assistantId: null })) })
    const w = createFileIngestWorker(deps)
    await w.tick()

    expect(deps.index).toHaveBeenCalledTimes(1)
    expect(deps.brainIngest).not.toHaveBeenCalled()
    expect(deps.markDone).toHaveBeenCalledWith('job-1')
  })

  it('PDF with no distill port is store-only: no chunk, no decompose, marked done', async () => {
    const deps = baseDeps({
      claim: claimOnce(job()),
      filesApi: { readBytes: vi.fn(async () => readOk('application/pdf', 'report.pdf')) },
      distill: undefined,
    })
    const w = createFileIngestWorker(deps)
    await w.tick()

    expect(deps.parse).not.toHaveBeenCalled()
    expect(deps.index).not.toHaveBeenCalled()
    expect(deps.brainIngest).not.toHaveBeenCalled()
    expect(deps.setIndexing).toHaveBeenCalledWith('file-1', expect.objectContaining({ status: 'skipped', reason: 'store_only_needs_distill' }))
    expect(deps.markDone).toHaveBeenCalledWith('job-1')
  })

  it('audio/video is skipped entirely (owned by the recording pipeline)', async () => {
    const deps = baseDeps({
      claim: claimOnce(job()),
      filesApi: { readBytes: vi.fn(async () => readOk('audio/mpeg', 'memo.mp3')) },
    })
    const w = createFileIngestWorker(deps)
    await w.tick()

    expect(deps.parse).not.toHaveBeenCalled()
    expect(deps.index).not.toHaveBeenCalled()
    expect(deps.setIndexing).toHaveBeenCalledWith('file-1', expect.objectContaining({ status: 'skipped', reason: 'media_owned_by_recordings' }))
    expect(deps.markDone).toHaveBeenCalledWith('job-1')
  })

  it('a processing error marks the job failed AND stamps metadata.indexing failed', async () => {
    const deps = baseDeps({
      claim: claimOnce(job()),
      filesApi: { readBytes: vi.fn(async () => ({ ok: false, error: { kind: 'not_found', reference: 'file-1' } }) as never) },
      markFailed: vi.fn(async () => ({ retrying: true })),
    })
    const w = createFileIngestWorker(deps)
    await w.tick()

    expect(deps.markFailed).toHaveBeenCalledWith('job-1', expect.stringContaining('readBytes'))
    expect(deps.setIndexing).toHaveBeenCalledWith('file-1', expect.objectContaining({ status: 'failed' }))
    expect(deps.markDone).not.toHaveBeenCalled()
  })

  it('re-entry guard: a second tick while one is running is a no-op', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const deps = baseDeps({
      claim: vi.fn<() => Promise<FileIngestJob | null>>().mockResolvedValueOnce(job()).mockResolvedValue(null),
      index: vi.fn(async () => { await gate; return { segmentsInserted: 1, segmentCount: 1, truncated: false } }),
    })
    const w = createFileIngestWorker(deps)

    const first = w.tick()
    const second = w.tick() // running guard → immediate no-op
    release()
    await Promise.all([first, second])

    expect(deps.index).toHaveBeenCalledTimes(1)
  })
})
