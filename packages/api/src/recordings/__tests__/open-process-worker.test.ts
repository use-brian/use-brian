import { describe, expect, it, vi } from 'vitest'
import { createOpenRecordingProcessWorker } from '../recording-process-worker.js'

describe('[COMP:recordings/open-process-worker] recording queue drain', () => {
  it('drains jobs and parks prerequisite failures through markFailed', async () => {
    const jobs = [{ id: 'job-1', recordingId: 'rec-1' } as never, null]
    const markFailed = vi.fn(async () => ({ retrying: false }))
    const worker = createOpenRecordingProcessWorker({
      claim: vi.fn(async () => jobs.shift() ?? null),
      process: vi.fn(async () => { throw new Error('ffmpeg prerequisite failed') }),
      markDone: vi.fn(async () => {}),
      markFailed,
    })
    await worker.tick()
    expect(markFailed).toHaveBeenCalledWith('job-1', 'ffmpeg prerequisite failed')
  })
})
