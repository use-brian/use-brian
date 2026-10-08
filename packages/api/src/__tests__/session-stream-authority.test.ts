import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionStreamAuthority } from '../session-stream-authority.js'

afterEach(() => vi.useRealTimers())
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
describe('[COMP:api/session-stream-authority] open stream revocation', () => {
  it('checks every queued payload in order and drops payloads after revocation', async () => {
    const authorize = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
    const close = vi.fn(), seen: number[] = []
    const guard = createSessionStreamAuthority(authorize, close)
    guard.run(() => seen.push(1)); guard.run(() => seen.push(2)); guard.run(() => seen.push(3))
    await flush()
    expect(seen).toEqual([1]); expect(authorize).toHaveBeenCalledTimes(2); expect(close).toHaveBeenCalledOnce()
  })
  it('fails closed on an authority read error', async () => {
    const close = vi.fn(), send = vi.fn()
    createSessionStreamAuthority(async () => { throw new Error('offline') }, close).run(send)
    await flush(); expect(send).not.toHaveBeenCalled(); expect(close).toHaveBeenCalledOnce()
  })
  it('discards a successful read that arrives after disconnection', async () => {
    let resolve!: (allowed: boolean) => void
    const send = vi.fn(), close = vi.fn()
    const guard = createSessionStreamAuthority(() => new Promise(done => { resolve = done }), close)
    guard.run(send); await flush(); guard.dispose(); resolve(true); await flush()
    expect(send).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled()
  })
  it('bounds stalled authority checks and ignores a late successful read', async () => {
    vi.useFakeTimers()
    let resolve!: (allowed: boolean) => void
    const close = vi.fn(), send = vi.fn()
    const guard = createSessionStreamAuthority(() => new Promise(done => { resolve = done }), close)
    guard.run(send); await flush(); await vi.advanceTimersByTimeAsync(5_000)
    resolve(true); await flush()
    expect(close).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled()
  })
  it('closes on queue overload without releasing unchecked payloads', async () => {
    const close = vi.fn(), send = vi.fn()
    const guard = createSessionStreamAuthority(async () => true, close)
    for (let i = 0; i < 65; i++) guard.run(send)
    await flush(); expect(close).toHaveBeenCalledOnce(); expect(send).not.toHaveBeenCalled()
  })
})
