/**
 * [COMP:scheduling/cleanup-worker] Daily reap of disabled scheduled_jobs rows.
 *
 * Post nag-chain collapse (2026-05) `scheduled_jobs` is the control plane
 * for actively-firing schedules, not a history table. One-shots delete on
 * completion; this worker GCs the disabled tail at 24h cadence with a 30d
 * TTL. Audit lives in `workflow_runs` + `analytics_events`.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { JobStore } from '@use-brian/core'
import { createCleanupWorker, DISABLED_TTL_MS } from '../cleanup-worker.js'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function fakeStore(): JobStore {
  return {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    getDueJobs: vi.fn(),
    markCompleted: vi.fn(),
    markFailed: vi.fn(),
    setState: vi.fn(),
    listActiveNagsForUser: vi.fn(),
    purgeDisabledOlderThan: vi.fn().mockResolvedValue(0),
    countEnabledRecurring: vi.fn().mockResolvedValue(0),
  } as unknown as JobStore
}

describe('[COMP:scheduling/cleanup-worker] tick', () => {
  it('calls purgeDisabledOlderThan with a cutoff 30d in the past', async () => {
    const store = fakeStore()
    const worker = createCleanupWorker({ jobStore: store, runImmediately: false })

    const before = Date.now()
    await worker.tick()
    const after = Date.now()

    expect(store.purgeDisabledOlderThan).toHaveBeenCalledTimes(1)
    const cutoff = (store.purgeDisabledOlderThan as ReturnType<typeof vi.fn>).mock.calls[0][0] as Date
    expect(cutoff).toBeInstanceOf(Date)
    // Cutoff is `now - 30d` — allow a small window for the wall clock.
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - DISABLED_TTL_MS - 200)
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - DISABLED_TTL_MS + 200)
  })

  it('does not crash when the store throws', async () => {
    const store = fakeStore()
    ;(store.purgeDisabledOlderThan as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db down'))
    const onError = vi.fn()
    const worker = createCleanupWorker({ jobStore: store, runImmediately: false, onError })
    await expect(worker.tick()).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalled()
  })

  it('skips overlapping ticks (re-entry guard)', async () => {
    const store = fakeStore()
    let resolve!: (n: number) => void
    ;(store.purgeDisabledOlderThan as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<number>((r) => { resolve = r }),
    )
    const worker = createCleanupWorker({ jobStore: store, runImmediately: false })

    const first = worker.tick()
    // Second tick attempt — should early-out because `running` flag is set.
    const second = worker.tick()
    resolve(0)
    await Promise.all([first, second])

    expect(store.purgeDisabledOlderThan).toHaveBeenCalledTimes(1)
  })
})

describe('[COMP:scheduling/cleanup-worker] lifecycle', () => {
  it('start() schedules a setInterval at intervalMs; stop() clears it', () => {
    const store = fakeStore()
    const worker = createCleanupWorker({
      jobStore: store,
      intervalMs: 1000,
      runImmediately: false,
    })
    expect(worker.isRunning).toBe(false)
    worker.start()
    expect(worker.isRunning).toBe(true)
    worker.stop()
    expect(worker.isRunning).toBe(false)
  })

  it('start() with runImmediately:true fires a tick on boot', async () => {
    const store = fakeStore()
    const worker = createCleanupWorker({
      jobStore: store,
      intervalMs: 1000,
      runImmediately: true,
    })
    worker.start()
    // Boot tick is void-fired; flush microtasks.
    await Promise.resolve()
    expect(store.purgeDisabledOlderThan).toHaveBeenCalled()
    worker.stop()
  })
})
