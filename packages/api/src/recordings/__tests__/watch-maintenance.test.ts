import { afterEach, describe, expect, it, vi } from 'vitest'
import { startWatchCleanup } from '../watch-maintenance.js'
afterEach(() => vi.useRealTimers())
describe('watch retention lifecycle', () => {
  it('runs at boot and on schedule without overlap, then stops and drains', async () => {
    vi.useFakeTimers()
    let finish!: () => void
    const cleanup = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const stop = startWatchCleanup(cleanup, 100)
    expect(cleanup).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(cleanup).toHaveBeenCalledTimes(1)
    finish(); await Promise.resolve(); await Promise.resolve()
    await vi.advanceTimersByTimeAsync(100)
    expect(cleanup).toHaveBeenCalledTimes(2)
    const stopping = stop()
    finish(); await stopping
    await vi.advanceTimersByTimeAsync(1000)
    expect(cleanup).toHaveBeenCalledTimes(2)
  })
})
