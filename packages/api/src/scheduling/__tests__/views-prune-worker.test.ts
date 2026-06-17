/**
 * [COMP:scheduling/views-prune-worker] Daily prune of expired draft views.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { SavedViewStore } from '@sidanclaw/core'
import { createViewsPruneWorker } from '../views-prune-worker.js'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function fakeStore(): SavedViewStore {
  return {
    create: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    getPage: vi.fn(),
    updatePage: vi.fn(),
    setState: vi.fn(),
    setAutoPruneAt: vi.fn(),
    createDraft: vi.fn(),
    pruneExpiredDraftsSystem: vi.fn().mockResolvedValue([]),
  } as unknown as SavedViewStore
}

describe('[COMP:scheduling/views-prune-worker] tick', () => {
  it('calls pruneExpiredDraftsSystem on every tick', async () => {
    const store = fakeStore()
    const worker = createViewsPruneWorker({ savedViewStore: store, runImmediately: false })
    await worker.tick()
    expect(store.pruneExpiredDraftsSystem).toHaveBeenCalledTimes(1)
  })

  it('does not crash when the store throws', async () => {
    const store = fakeStore()
    ;(store.pruneExpiredDraftsSystem as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db down'))
    const onError = vi.fn()
    const worker = createViewsPruneWorker({ savedViewStore: store, runImmediately: false, onError })
    await expect(worker.tick()).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalled()
  })

  it('skips overlapping ticks (no concurrent runs)', async () => {
    const store = fakeStore()
    // Use a deferred promise so the second tick attempts to start while the first is running.
    let resolve!: (ids: string[]) => void
    ;(store.pruneExpiredDraftsSystem as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<string[]>((r) => { resolve = r }),
    )
    const worker = createViewsPruneWorker({ savedViewStore: store, runImmediately: false })
    const first = worker.tick()
    // Second tick attempt — should early-out because `running` flag is set.
    const second = worker.tick()
    resolve([])
    await Promise.all([first, second])
    expect(store.pruneExpiredDraftsSystem).toHaveBeenCalledTimes(1)
  })
})

describe('[COMP:scheduling/views-prune-worker] lifecycle', () => {
  it('start() schedules a setInterval at intervalMs; stop() clears it', () => {
    const store = fakeStore()
    const worker = createViewsPruneWorker({
      savedViewStore: store,
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
    const worker = createViewsPruneWorker({
      savedViewStore: store,
      intervalMs: 1000,
      runImmediately: true,
    })
    worker.start()
    // The boot tick is void-fired; allow the microtask to land.
    await Promise.resolve()
    expect(store.pruneExpiredDraftsSystem).toHaveBeenCalled()
    worker.stop()
  })
})
