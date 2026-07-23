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
})
