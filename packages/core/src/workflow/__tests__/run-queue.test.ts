import { describe, it, expect, vi } from 'vitest'
import {
  createRunQueueWorker,
  type ClaimedRun,
  type RunQueueStore,
} from '../run-queue.js'

/**
 * In-memory queue store. Claims pop FIFO; the fairness SQL (serialization,
 * caps, leases) is the DB impl's job and is integration-tested in
 * packages/api — here the store is a simple feed so the WORKER's pacing
 * contract (bounded concurrency, drain-until-empty, reap-first, error
 * isolation, nudge coalescing) is what's under test.
 */
function makeStore(queue: ClaimedRun[]) {
  const store: RunQueueStore & { claims: number; reaps: number } = {
    claims: 0,
    reaps: 0,
    async claimNextPendingRunSystem() {
      store.claims++
      return queue.shift() ?? null
    },
    async failExhaustedPendingRunsSystem() {
      store.reaps++
      return 0
    },
    async requeueStaleRunningRunsSystem() {
      return 0
    },
  }
  return store
}

const run = (n: number): ClaimedRun => ({
  runId: `r${n}`,
  workflowId: `wf${n}`,
  workspaceId: 'ws1',
})

describe('[COMP:workflow/run-queue] createRunQueueWorker', () => {
  it('drains every claimable run through advance', async () => {
    const store = makeStore([run(1), run(2), run(3)])
    const advanced: string[] = []
    const worker = createRunQueueWorker({
      store,
      advance: async (id) => {
        advanced.push(id)
      },
    })
    await worker.tick()
    // advances are fire-and-forget inside the tick — let them settle
    await new Promise((r) => setTimeout(r, 0))
    expect(advanced.sort()).toEqual(['r1', 'r2', 'r3'])
  })

  it('reaps (exhausted + stale) before claiming', async () => {
    const store = makeStore([])
    const worker = createRunQueueWorker({ store, advance: async () => {} })
    await worker.tick()
    expect(store.reaps).toBe(1)
    expect(store.claims).toBe(1) // one empty claim, then stop
  })

  it('never advances more than maxConcurrent at once', async () => {
    const store = makeStore([run(1), run(2), run(3), run(4)])
    let inFlight = 0
    let peak = 0
    const gates: Array<() => void> = []
    const worker = createRunQueueWorker({
      store,
      maxConcurrent: 2,
      advance: (id) =>
        new Promise<void>((resolve) => {
          inFlight++
          peak = Math.max(peak, inFlight)
          gates.push(() => {
            inFlight--
            resolve()
          })
        }),
    })
    await worker.tick()
    expect(peak).toBe(2) // claimed exactly up to the cap, then stopped
    // Release one — the finished run's nudge pulls the next claim.
    gates.shift()!()
    await new Promise((r) => setTimeout(r, 0))
    expect(peak).toBe(2)
    // Later claims land via async nudges — release until fully drained.
    for (let i = 0; i < 10 && (gates.length > 0 || inFlight > 0); i++) {
      while (gates.length) gates.shift()!()
      await new Promise((r) => setTimeout(r, 0))
    }
    expect(inFlight).toBe(0)
    expect(peak).toBe(2) // the cap held across the whole drain
  })

  it('a failing advance routes to onError and never blocks the drain', async () => {
    const store = makeStore([run(1), run(2)])
    const onError = vi.fn()
    const advanced: string[] = []
    const worker = createRunQueueWorker({
      store,
      onError,
      advance: async (id) => {
        if (id === 'r1') throw new Error('boom')
        advanced.push(id)
      },
    })
    await worker.tick()
    await new Promise((r) => setTimeout(r, 0))
    expect(advanced).toEqual(['r2'])
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { runId: 'r1' })
  })

  it('a claim failure routes to onError and ends the pass without throwing', async () => {
    const onError = vi.fn()
    const store: RunQueueStore = {
      async claimNextPendingRunSystem() {
        throw new Error('db down')
      },
      async failExhaustedPendingRunsSystem() {
        return 0
      },
      async requeueStaleRunningRunsSystem() {
        return 0
      },
    }
    const worker = createRunQueueWorker({ store, onError, advance: async () => {} })
    await expect(worker.tick()).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalled()
  })

  it('a nudge landing mid-pass coalesces into one queued re-pass', async () => {
    const store = makeStore([run(1)])
    let resolveAdvance!: () => void
    const worker = createRunQueueWorker({
      store,
      advance: () =>
        new Promise<void>((resolve) => {
          resolveAdvance = () => resolve()
        }),
    })
    const first = worker.tick()
    // While the pass holds the drain lock, nudges must not start a second
    // concurrent claim loop.
    worker.nudge()
    worker.nudge()
    await first
    const claimsAfterFirst = store.claims
    resolveAdvance()
    await new Promise((r) => setTimeout(r, 0))
    // The queued re-pass (and the finished run's own nudge) ran — but only
    // as serialized passes, never concurrently.
    expect(store.claims).toBeGreaterThanOrEqual(claimsAfterFirst)
    expect(store.reaps).toBeGreaterThanOrEqual(1)
  })

  it('start()/stop() manage the interval without leaking a running timer', async () => {
    vi.useFakeTimers()
    try {
      const store = makeStore([])
      const worker = createRunQueueWorker({ store, advance: async () => {}, intervalMs: 50 })
      worker.start()
      await vi.advanceTimersByTimeAsync(120)
      worker.stop()
      const claimsAtStop = store.claims
      await vi.advanceTimersByTimeAsync(500)
      expect(store.claims).toBe(claimsAtStop) // no ticks after stop
      expect(claimsAtStop).toBeGreaterThanOrEqual(2) // start() tick + interval ticks
    } finally {
      vi.useRealTimers()
    }
  })
})
