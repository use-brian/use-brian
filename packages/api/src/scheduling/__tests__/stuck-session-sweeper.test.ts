import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createStuckSessionSweeper, DEFAULT_STALE_AFTER_MS, DEFAULT_INTERVAL_MS } from '../stuck-session-sweeper.js'

describe('[COMP:scheduling/stuck-session-sweeper] createStuckSessionSweeper', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('passes the configured staleAfterMs to the SQL helper', async () => {
    const sweep = vi.fn().mockResolvedValue([])
    const sweeper = createStuckSessionSweeper({
      sweep,
      staleAfterMs: 90_000,
      onError: () => {},
    })

    await sweeper.tick()

    expect(sweep).toHaveBeenCalledTimes(1)
    expect(sweep).toHaveBeenCalledWith(90_000)
  })

  it('publishes turn_completed only for draft-mode sessions, not regular web sessions', async () => {
    const sweep = vi.fn().mockResolvedValue([
      { id: 'draft-1', mode: 'draft', userId: 'user-a' },
      { id: 'web-1', mode: null, userId: 'user-b' },
      { id: 'draft-2', mode: 'draft', userId: 'user-c' },
    ])
    const publish = vi.fn()
    const sweeper = createStuckSessionSweeper({
      sweep,
      publishDraftTurnCompleted: publish,
      onError: () => {},
    })

    await sweeper.tick()

    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenCalledWith('draft-1')
    expect(publish).toHaveBeenCalledWith('draft-2')
    expect(publish).not.toHaveBeenCalledWith('web-1')
  })

  it('survives a SQL error without crashing — the next tick still runs', async () => {
    let attempt = 0
    const sweep = vi.fn().mockImplementation(() => {
      attempt += 1
      if (attempt === 1) return Promise.reject(new Error('connection reset'))
      return Promise.resolve([])
    })
    const onError = vi.fn()
    const sweeper = createStuckSessionSweeper({
      sweep,
      onError,
    })

    await sweeper.tick()
    await sweeper.tick()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(sweep).toHaveBeenCalledTimes(2)
  })

  it('survives a publish error per row without aborting the rest of the batch', async () => {
    const sweep = vi.fn().mockResolvedValue([
      { id: 'draft-bad', mode: 'draft', userId: 'user-a' },
      { id: 'draft-good', mode: 'draft', userId: 'user-b' },
    ])
    const publish = vi.fn()
      .mockImplementationOnce(() => { throw new Error('subscriber crashed') })
      .mockImplementationOnce(() => { /* succeeds */ })
    const onError = vi.fn()
    const sweeper = createStuckSessionSweeper({
      sweep,
      publishDraftTurnCompleted: publish,
      onError,
    })

    await sweeper.tick()

    expect(publish).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledTimes(1)
  })

  it('serialises overlapping ticks — a slow sweep does not let a second one start in parallel', async () => {
    let resolveFirst: () => void = () => {}
    const sweep = vi.fn()
      .mockImplementationOnce(() => new Promise<never[]>((resolve) => {
        resolveFirst = () => resolve([])
      }))
      .mockResolvedValue([])
    const sweeper = createStuckSessionSweeper({
      sweep,
      onError: () => {},
    })

    const first = sweeper.tick()
    const second = sweeper.tick() // should no-op while first is still running
    expect(sweep).toHaveBeenCalledTimes(1)

    resolveFirst()
    await first
    await second

    // After the first tick completes, a fresh tick should be allowed.
    await sweeper.tick()
    expect(sweep).toHaveBeenCalledTimes(2)
  })

  it('start() schedules a setInterval at intervalMs; stop() clears it', async () => {
    const sweep = vi.fn().mockResolvedValue([])
    const sweeper = createStuckSessionSweeper({
      sweep,
      intervalMs: 1_000,
      onError: () => {},
    })

    expect(sweeper.isRunning).toBe(false)
    sweeper.start()
    expect(sweeper.isRunning).toBe(true)
    // Boot tick fires immediately. Flush its pending microtasks before
    // advancing the timer so the in-flight `running` flag clears, otherwise
    // the next interval-driven tick is skipped by the serialisation guard.
    await vi.advanceTimersByTimeAsync(0)
    expect(sweep).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(sweep).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(sweep).toHaveBeenCalledTimes(3)

    sweeper.stop()
    expect(sweeper.isRunning).toBe(false)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(sweep).toHaveBeenCalledTimes(3) // no further ticks after stop
  })

  it('exports defaults that match Cloud Run\'s 300s cap with safety margin', () => {
    expect(DEFAULT_STALE_AFTER_MS).toBeGreaterThan(300_000)
    expect(DEFAULT_INTERVAL_MS).toBe(60_000)
  })
})
