/**
 * Background-lane admission semaphore.
 * Component tag: [COMP:platform/background-lane].
 *
 * B3 of docs/plans/corpus-substrate-hardening.md §4 — the companion to lowering
 * the workers pool cap from 3 to 2. The ~19 tick loops in the workers process
 * must not be able to demand checkouts all at once.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  backgroundLaneStats,
  configureBackgroundLane,
  DEFAULT_BACKGROUND_LANE_CONCURRENCY,
  resolveBackgroundLaneConcurrency,
  runInBackgroundLane,
} from '../background-lane.js'

/** A task that blocks until the test releases it. */
function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

beforeEach(() => {
  configureBackgroundLane({ limit: 2 })
})

describe('[COMP:platform/background-lane] Background lane admission', () => {
  it('defaults to the workers pool cap and rejects garbage', () => {
    expect(DEFAULT_BACKGROUND_LANE_CONCURRENCY).toBe(2)
    expect(resolveBackgroundLaneConcurrency('3')).toBe(3)
    for (const raw of [undefined, '', 'lots', '-1', '2.5']) {
      expect(resolveBackgroundLaneConcurrency(raw), String(raw)).toBe(
        DEFAULT_BACKGROUND_LANE_CONCURRENCY,
      )
    }
    // 0 would wedge every background loop forever — a worse failure than an
    // unbounded lane, so it is treated as unset.
    expect(resolveBackgroundLaneConcurrency('0')).toBe(DEFAULT_BACKGROUND_LANE_CONCURRENCY)
  })

  it('never runs more than `limit` tasks at once', async () => {
    let concurrent = 0
    let peak = 0
    const gates = Array.from({ length: 6 }, () => gate())
    const runs = gates.map((g) =>
      runInBackgroundLane(async () => {
        concurrent += 1
        peak = Math.max(peak, concurrent)
        await g.promise
        concurrent -= 1
      }),
    )
    // Let the admitted pair start.
    await Promise.resolve()
    expect(backgroundLaneStats().inFlight).toBe(2)
    expect(backgroundLaneStats().queued).toBe(4)
    for (const g of gates) g.open()
    await Promise.all(runs)
    expect(peak).toBe(2)
    expect(backgroundLaneStats()).toEqual({ limit: 2, inFlight: 0, queued: 0 })
  })

  it('hands the slot to the next waiter instead of letting a new caller jump in', async () => {
    // Regression guard for the decrement-then-wake hole: a woken waiter resumes
    // on a later microtask, so a caller arriving in between could take the
    // freed slot and push the lane to limit + 1.
    configureBackgroundLane({ limit: 1 })
    let peak = 0
    let concurrent = 0
    const first = gate()
    const track = async (block?: Promise<void>) => {
      concurrent += 1
      peak = Math.max(peak, concurrent)
      if (block) await block
      concurrent -= 1
    }
    const a = runInBackgroundLane(() => track(first.promise))
    const b = runInBackgroundLane(() => track())
    await Promise.resolve()
    first.open()
    // `c` arrives exactly in the window where the slot is being handed to `b`.
    const c = runInBackgroundLane(() => track())
    await Promise.all([a, b, c])
    expect(peak).toBe(1)
  })

  it('is FIFO, so a waiting loop cannot starve behind a busier one', async () => {
    configureBackgroundLane({ limit: 1 })
    const order: string[] = []
    const hold = gate()
    const running = runInBackgroundLane(async () => {
      order.push('first')
      await hold.promise
    })
    await Promise.resolve()
    const queued = ['a', 'b', 'c'].map((name) =>
      runInBackgroundLane(async () => {
        order.push(name)
      }),
    )
    hold.open()
    await Promise.all([running, ...queued])
    expect(order).toEqual(['first', 'a', 'b', 'c'])
  })

  it('frees the slot when a task throws', async () => {
    configureBackgroundLane({ limit: 1 })
    await expect(
      runInBackgroundLane(async () => {
        throw new Error('tick exploded')
      }),
    ).rejects.toThrow('tick exploded')
    expect(backgroundLaneStats()).toEqual({ limit: 1, inFlight: 0, queued: 0 })
    // ...and the lane still admits work afterwards.
    await expect(runInBackgroundLane(async () => 'ok')).resolves.toBe('ok')
  })
})
