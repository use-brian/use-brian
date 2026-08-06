import { describe, expect, it, vi } from 'vitest'

const stores = vi.hoisted(() => ({
  createEpisode: vi.fn(),
  createRecording: vi.fn(),
  enqueueRecordingJob: vi.fn(),
  countRecentRecordingJobs: vi.fn(async () => 0),
  enqueueFileIngestJob: vi.fn(),
  countRecentFileIngestJobs: vi.fn(async () => 0),
}))
vi.mock('../../db/episodes-store.js', () => ({ createEpisode: stores.createEpisode }))
vi.mock('../../db/recordings-store.js', () => ({ createRecording: stores.createRecording }))
vi.mock('../../db/recording-jobs-store.js', () => ({
  enqueueRecordingJob: stores.enqueueRecordingJob,
  countRecentRecordingJobs: stores.countRecentRecordingJobs,
}))
vi.mock('../../db/file-ingest-jobs-store.js', () => ({
  enqueueFileIngestJob: stores.enqueueFileIngestJob,
  countRecentFileIngestJobs: stores.countRecentFileIngestJobs,
}))

import { createOpenChannelMediaIntakeDeps } from '../channel-media-deps.js'

describe('[COMP:brain/open-channel-media-deps] open intake composition', () => {
  it('uses open recording stores without hosted policy hooks', () => {
    const deps = createOpenChannelMediaIntakeDeps({ filesResolver: {} as never })

    expect(deps.createEpisode).toBe(stores.createEpisode)
    expect(deps.createRecording).toBe(stores.createRecording)
    expect(deps.enqueueRecordingJob).toBe(stores.enqueueRecordingJob)
    expect(deps.preflightConfirm).toBeUndefined()
    expect(deps.checkQuota).toBeTypeOf('function')
  })

  it('never hands byte-detected inline media to Pipeline B on the no-filesApi path', async () => {
    // `parseFileContent` returns BASE64 for a PDF or an image - that string is
    // meant for an `image` ContentBlock, not for decomposition. Without
    // `filesApi` there is no file-ingest worker to distill it properly, and
    // the old path fed the base64 straight to the brain, which ingested
    // garbage and said nothing.
    const brainIngestor = vi.fn(async () => undefined)
    const deps = createOpenChannelMediaIntakeDeps({
      filesResolver: {
        forWorkspace: async () => ({ gcs: { readBlob: async () => ({ bytes: Buffer.from('%PDF-1.4 x') }) } }),
      } as never,
      brainIngestor: brainIngestor as never,
    })

    const result = await deps.ingestDocument!({
      gcsKey: 'k',
      // Exercise byte authority too: the transport label and extension lie.
      mime: 'text/plain',
      fileName: 'download.txt',
      workspaceId: 'ws-1',
      assistantId: 'a-1',
      actingUserId: 'u-1',
      sensitivity: 'internal',
    } as never)

    expect(result).toEqual({ status: 'store_only_needs_distill' })
    expect(brainIngestor).not.toHaveBeenCalled()
  })

  it('still decomposes a real text document on the same path', async () => {
    const brainIngestor = vi.fn(async () => undefined)
    const deps = createOpenChannelMediaIntakeDeps({
      filesResolver: {
        forWorkspace: async () => ({ gcs: { readBlob: async () => ({ bytes: Buffer.from('hello notes') }) } }),
      } as never,
      brainIngestor: brainIngestor as never,
    })

    const result = await deps.ingestDocument!({
      gcsKey: 'k',
      mime: 'text/plain',
      fileName: 'notes.txt',
      workspaceId: 'ws-1',
      assistantId: 'a-1',
      actingUserId: 'u-1',
      sensitivity: 'internal',
    } as never)

    expect(result).toMatchObject({ status: 'accepted' })
    expect(brainIngestor).toHaveBeenCalledOnce()
  })
})
