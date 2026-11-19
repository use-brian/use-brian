import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { query, claim } = vi.hoisted(() => ({ query: vi.fn(), claim: vi.fn() }))
vi.mock('../../db/client.js', () => ({ query }))
vi.mock('../../db/sessions.js', () => ({
  claimTurnLeaseOutcome: claim,
  touchTurnLease: vi.fn(),
  releaseTurnOutcome: vi.fn(),
  TURN_HEARTBEAT_INTERVAL_MS: 20_000,
}))

import { takeTurnLease, waitForTurnSlot } from '../lease.js'

beforeEach(() => {
  vi.useFakeTimers()
  query.mockReset().mockResolvedValue({ rows: [{ status: 'running' }] })
  claim.mockReset().mockResolvedValue(null)
})
afterEach(() => vi.useRealTimers())

describe('[COMP:api/turn-kernel] original request cancellation while queued', () => {
  it('does not claim or poll for an already-aborted request', async () => {
    const controller = new AbortController(), reason = new Error('disconnected')
    controller.abort(reason)
    await expect(takeTurnLease({ sessionId: 'session', admission: 'room',
      signal: controller.signal, waitForSlot: waitForTurnSlot })).rejects.toBe(reason)
    await expect(waitForTurnSlot('session', { signal: controller.signal })).rejects.toBe(reason)
    expect(claim).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })

  it('cancels the polling timer without claiming the next available slot', async () => {
    const controller = new AbortController(), reason = new Error('disconnected')
    const pending = takeTurnLease({ sessionId: 'session', admission: 'room',
      signal: controller.signal, waitForSlot: waitForTurnSlot })
    const refused = expect(pending).rejects.toBe(reason)
    await vi.advanceTimersByTimeAsync(0)
    expect(query).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(1)
    controller.abort(reason)
    await refused
    expect(vi.getTimerCount()).toBe(0)
    query.mockResolvedValue({ rows: [{ status: 'idle' }] })
    await vi.advanceTimersByTimeAsync(240_000)
    expect(claim).toHaveBeenCalledOnce()
    expect(query).toHaveBeenCalledOnce()
  })

  it('refuses after a custom wait returns if its original request was aborted', async () => {
    const controller = new AbortController(), reason = new Error('disconnected')
    const wait = vi.fn(async (_id: string, opts?: { signal?: AbortSignal }) => {
      expect(opts?.signal).toBe(controller.signal)
      controller.abort(reason)
      return true
    })
    await expect(takeTurnLease({ sessionId: 'session', admission: 'personal',
      signal: controller.signal, waitForSlot: wait })).rejects.toBe(reason)
    expect(claim).toHaveBeenCalledOnce()
  })

  it('does not start waiting when cancellation races an unsuccessful claim', async () => {
    const controller = new AbortController(), reason = new Error('disconnected')
    claim.mockImplementation(async () => { controller.abort(reason); return null })
    const wait = vi.fn()
    await expect(takeTurnLease({ sessionId: 'session', admission: 'room',
      signal: controller.signal, waitForSlot: wait })).rejects.toBe(reason)
    expect(wait).not.toHaveBeenCalled()
  })

  it('returns a successfully acquired token for exact-owner cleanup when abort races its acknowledgement', async () => {
    const controller = new AbortController()
    claim.mockImplementation(async () => {
      controller.abort(new Error('disconnected'))
      return { token: 'original-token', turnId: null }
    })
    await expect(takeTurnLease({ sessionId: 'session', admission: 'room',
      signal: controller.signal, waitForSlot: waitForTurnSlot }))
      .resolves.toMatchObject({ taken: true, token: 'original-token' })
    expect(query).not.toHaveBeenCalled()
  })

  it('does not accept a delayed idle read after cancellation', async () => {
    const controller = new AbortController(), reason = new Error('disconnected')
    let release!: (value: { rows: { status: string }[] }) => void
    query.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const pending = waitForTurnSlot('session', { signal: controller.signal })
    const refused = expect(pending).rejects.toBe(reason)
    controller.abort(reason)
    release({ rows: [{ status: 'idle' }] })
    await refused
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves successful queue admission and removes the polling listener', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    claim.mockResolvedValueOnce(null).mockResolvedValueOnce({ token: 'next-token', turnId: null })
    query.mockResolvedValueOnce({ rows: [{ status: 'running' }] }).mockResolvedValueOnce({ rows: [{ status: 'idle' }] })
    const pending = takeTurnLease({ sessionId: 'session', admission: 'room',
      signal: controller.signal, waitForSlot: waitForTurnSlot })
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(pending).resolves.toMatchObject({ taken: true, token: 'next-token' })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the existing wait deadline without leaving a polling timer', async () => {
    const pending = waitForTurnSlot('session', { timeoutMs: 100, pollMs: 2_000 })
    await vi.advanceTimersByTimeAsync(100)
    await expect(pending).resolves.toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
