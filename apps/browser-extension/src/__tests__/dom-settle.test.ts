// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settleBeforeSnapshot, waitForDomQuiet } from '../dom-settle.js'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('bounded DOM settling', () => {
  it('waits 100ms after the last asynchronous DOM mutation and disconnects', async () => {
    vi.useFakeTimers()
    const disconnect = vi.spyOn(MutationObserver.prototype, 'disconnect')
    const done = vi.fn()
    const pending = waitForDomQuiet(100, 750).then(done)
    await vi.advanceTimersByTimeAsync(70)
    document.body.textContent = 'Next page'
    await Promise.resolve() // deliver MutationObserver microtask
    await vi.advanceTimersByTimeAsync(99)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(done).toHaveBeenCalledOnce()
    expect(disconnect).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('caps continuous DOM mutations at 750ms rather than waiting forever', async () => {
    vi.useFakeTimers()
    const done = vi.fn()
    const pending = waitForDomQuiet(100, 750).then(done)
    for (let i = 0; i < 14; i++) {
      await vi.advanceTimersByTimeAsync(50)
      document.body.textContent = `Animation frame ${i}`
      await Promise.resolve()
    }
    await vi.advanceTimersByTimeAsync(49)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(done).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('host deadline bounds suspended background-page timers or an unanswered CDP call', async () => {
    vi.useFakeTimers()
    const done = vi.fn()
    const pending = settleBeforeSnapshot(() => new Promise(() => {})).then(done)
    await vi.advanceTimersByTimeAsync(749)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(done).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('settle errors are best effort and clear the host deadline', async () => {
    vi.useFakeTimers()
    await expect(settleBeforeSnapshot(async () => { throw new Error('Context destroyed') })).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('observer setup errors are harmless', async () => {
    vi.spyOn(MutationObserver.prototype, 'observe').mockImplementation(() => { throw new Error('Unavailable') })
    await expect(waitForDomQuiet(100, 750)).resolves.toBeUndefined()
  })
})
