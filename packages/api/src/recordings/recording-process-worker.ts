// [COMP:recordings/open-process-worker] - bounded, single-concurrency queue drain.

import type { RecordingJob } from '../db/recording-jobs-store.js'

export function createOpenRecordingProcessWorker(deps: {
  claim: () => Promise<RecordingJob | null>
  process: (job: RecordingJob) => Promise<void>
  markDone: (id: string) => Promise<void>
  markFailed: (id: string, error: string) => Promise<{ retrying: boolean }>
  intervalMs?: number
}) {
  let timer: ReturnType<typeof setInterval> | undefined
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      for (;;) {
        const job = await deps.claim()
        if (!job) break
        try {
          await deps.process(job)
          await deps.markDone(job.id)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const result = await deps.markFailed(job.id, message)
          console.error(`[recording-process-worker] job ${job.id} failed (${result.retrying ? 'retrying' : 'terminal'}): ${message}`)
        }
      }
    } catch (err) {
      console.error('[recording-process-worker] claim failed:', err)
    } finally {
      running = false
    }
  }
  return {
    tick,
    start() {
      if (timer) return
      timer = setInterval(() => void tick(), deps.intervalMs ?? 15_000)
      void tick()
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = undefined
    },
    isRunning: () => running,
  }
}
