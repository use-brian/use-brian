import { describe, expect, it, vi } from 'vitest'

import {
  createCircuitBreaker,
  createInMemoryCounterStore,
} from '../circuit-breaker.js'

describe('[COMP:classification/circuit-breaker] createCircuitBreaker', () => {
  it('reports not tripped initially', async () => {
    const breaker = createCircuitBreaker(createInMemoryCounterStore())
    expect(await breaker.isTripped('ws-1', 'rule-x')).toBe(false)
  })

  it('record returns false until the hourly cap is reached', async () => {
    const breaker = createCircuitBreaker(createInMemoryCounterStore(), { hourlyCap: 5 })
    for (let i = 0; i < 4; i++) {
      const tripped = await breaker.record('ws-1', 'rule-x', 'self_heal')
      expect(tripped).toBe(false)
    }
    // 5th increment crosses the cap
    const tripped = await breaker.record('ws-1', 'rule-x', 'self_heal')
    expect(tripped).toBe(true)
  })

  it('trips → subsequent isTripped returns true within suspension window', async () => {
    const breaker = createCircuitBreaker(createInMemoryCounterStore(), {
      hourlyCap: 2,
      suspensionMs: 1000,
    })
    await breaker.record('ws-1', 'rule-x', 'self_heal')
    await breaker.record('ws-1', 'rule-x', 'self_heal')
    expect(await breaker.isTripped('ws-1', 'rule-x')).toBe(true)
  })

  it('suspension expires after suspensionMs', async () => {
    const fakeNow = vi.fn<() => Date>()
    fakeNow.mockReturnValue(new Date('2026-05-28T10:00:00Z'))

    const breaker = createCircuitBreaker(createInMemoryCounterStore(), {
      hourlyCap: 2,
      suspensionMs: 1000,
      now: fakeNow,
    })
    await breaker.record('ws-1', 'rule-x', 'self_heal')
    await breaker.record('ws-1', 'rule-x', 'self_heal')
    expect(await breaker.isTripped('ws-1', 'rule-x')).toBe(true)

    // Advance clock past suspension
    fakeNow.mockReturnValue(new Date('2026-05-28T10:00:02Z'))
    expect(await breaker.isTripped('ws-1', 'rule-x')).toBe(false)
  })

  it('per-workspace isolation — one workspace tripping does not affect another', async () => {
    const breaker = createCircuitBreaker(createInMemoryCounterStore(), { hourlyCap: 2 })
    await breaker.record('ws-1', 'rule-x', 'self_heal')
    await breaker.record('ws-1', 'rule-x', 'self_heal')
    expect(await breaker.isTripped('ws-1', 'rule-x')).toBe(true)
    expect(await breaker.isTripped('ws-2', 'rule-x')).toBe(false)
  })

  it('per-rule isolation — one rule tripping does not affect others', async () => {
    const breaker = createCircuitBreaker(createInMemoryCounterStore(), { hourlyCap: 2 })
    await breaker.record('ws-1', 'rule-a', 'self_heal')
    await breaker.record('ws-1', 'rule-a', 'self_heal')
    expect(await breaker.isTripped('ws-1', 'rule-a')).toBe(true)
    expect(await breaker.isTripped('ws-1', 'rule-b')).toBe(false)
  })

  it('reset clears suspension', async () => {
    const breaker = createCircuitBreaker(createInMemoryCounterStore(), { hourlyCap: 2 })
    await breaker.record('ws-1', 'rule-x', 'self_heal')
    await breaker.record('ws-1', 'rule-x', 'self_heal')
    expect(await breaker.isTripped('ws-1', 'rule-x')).toBe(true)

    await breaker.reset('admin', 'ws-1', 'rule-x')
    expect(await breaker.isTripped('ws-1', 'rule-x')).toBe(false)
  })

  it('emits analytics event when tripped', async () => {
    const logEvent = vi.fn()
    const breaker = createCircuitBreaker(createInMemoryCounterStore(), {
      hourlyCap: 2,
      analytics: { logEvent } as unknown as import('../../analytics/logger.js').AnalyticsLogger,
    })
    await breaker.record('ws-1', 'rule-x', 'self_heal')
    await breaker.record('ws-1', 'rule-x', 'self_heal')
    expect(logEvent).toHaveBeenCalledOnce()
    expect(logEvent.mock.calls[0]![0].eventName).toBe('classifier_circuit_breaker_tripped')
    expect(logEvent.mock.calls[0]![0].metadata.observed_count_per_hour).toBe(2)
  })

  it('prune drops counter rows older than 7 days', async () => {
    const fakeNow = vi.fn<() => Date>()
    fakeNow.mockReturnValue(new Date('2026-05-28T10:00:00Z'))
    const store = createInMemoryCounterStore()
    const breaker = createCircuitBreaker(store, { now: fakeNow })

    // Increment in a window 8 days ago
    fakeNow.mockReturnValue(new Date('2026-05-20T10:00:00Z'))
    await breaker.record('ws-1', 'rule-x', 'self_heal')

    // Now back to today; prune should remove the old row
    fakeNow.mockReturnValue(new Date('2026-05-28T10:00:00Z'))
    const pruned = await breaker.prune()
    expect(pruned).toBe(1)
  })
})
