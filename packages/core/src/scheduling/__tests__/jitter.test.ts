/**
 * Jittered interval + background-lane admission.
 * Component tag: [COMP:platform/worker-jitter].
 *
 * Jitter spreads the FIRST tick of every interval-driven worker so ~19 loops
 * booted in one event-loop turn don't fire on the same boundary. It says
 * nothing about steady state, which is why every tick is also admitted through
 * the background lane and a loop skips its turn while its previous tick is
 * still settling (B3 — docs/plans/corpus-substrate-hardening.md §4).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { startJitteredInterval, stopJitteredInterval } from '../jitter.js'
import { backgroundLaneStats, configureBackgroundLane } from '../background-lane.js'

/** Drain pending microtasks without advancing fake timers. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'] })
  configureBackgroundLane({ limit: 2 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('[COMP:platform/worker-jitter] Jittered interval', () => {
  it('rejects a non-positive interval instead of collapsing the jitter range', () => {
    expect(() => startJitteredInterval(() => {}, 0)).toThrow(/intervalMs must be > 0/)
    expect(() => startJitteredInterval(() => {}, -1)).toThrow(/intervalMs must be > 0/)
  })

  it('defers the first tick into [0, intervalMs) and then runs every interval', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    const fn = vi.fn()
    const handle = startJitteredInterval(fn, 1000)
    // Not on the boot boundary — that alignment is the whole reason this exists.
    expect(fn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(499)
    expect(fn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(fn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    expect(fn).toHaveBeenCalledTimes(2)
    stopJitteredInterval(handle)
  })

  it('skips a tick while the previous one is still in flight', async () => {
    // Without this guard a loop whose tick outlives its interval enqueues a
    // fresh lane waiter every period, re-creating unbounded backlog one level
    // above the lane.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const fn = vi.fn(() => blocked)
    const handle = startJitteredInterval(fn, 100)
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    expect(fn).toHaveBeenCalledTimes(1)

    // Five intervals pass while the first tick is still running.
    await vi.advanceTimersByTimeAsync(500)
    await flush()
    expect(fn).toHaveBeenCalledTimes(1)
    expect(backgroundLaneStats().queued).toBe(0)

    release()
    await flush()
    await vi.advanceTimersByTimeAsync(100)
    await flush()
    expect(fn).toHaveBeenCalledTimes(2)
    stopJitteredInterval(handle)
  })

  it('admits ticks through the background lane', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    configureBackgroundLane({ limit: 1 })
    let concurrent = 0
    let peak = 0
    const gates: Array<() => void> = []
    const fn = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          concurrent += 1
          peak = Math.max(peak, concurrent)
          gates.push(() => {
            concurrent -= 1
            resolve()
          })
        }),
    )
    // Two independent loops, both firing immediately.
    const a = startJitteredInterval(fn, 1000)
    const b = startJitteredInterval(fn, 1000)
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    expect(peak).toBe(1)
    expect(backgroundLaneStats().queued).toBe(1)
    for (const open of [...gates]) open()
    await flush()
    expect(peak).toBe(1)
    stopJitteredInterval(a)
    stopJitteredInterval(b)
  })

  it('keeps ticking after a tick throws, and stop() is idempotent', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const fn = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined)
    const handle = startJitteredInterval(fn, 100)
    await vi.advanceTimersByTimeAsync(0)
    await flush()
    await vi.advanceTimersByTimeAsync(100)
    await flush()
    expect(fn).toHaveBeenCalledTimes(2)
    stopJitteredInterval(handle)
    stopJitteredInterval(handle)
    await vi.advanceTimersByTimeAsync(500)
    await flush()
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
