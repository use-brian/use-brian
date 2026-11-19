import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pool = vi.hoisted(() => ({ waitingCount: 0 }))
vi.mock('../../db/client.js', () => ({ getAppPool: () => pool }))

const {
  OptionalEvidenceDeferred, enterOptionalEvidenceSlot, isOptionalEvidence, optionalEvidenceState,
  resetOptionalEvidenceStateForTests, runOptionalEvidence, yieldOptionalEvidence,
} = await import('../optional-evidence.js')

function client(blocking = false) {
  return { query: vi.fn(async () => ({ rows: [{ blocking }] })) } as unknown as { query: ReturnType<typeof vi.fn> } & Parameters<typeof yieldOptionalEvidence>[0]
}

describe('[COMP:api/optional-evidence-lane] optional decoration yields to foreground admission', () => {
  beforeEach(() => { resetOptionalEvidenceStateForTests(); pool.waitingCount = 0 })
  afterEach(() => { vi.useRealTimers() })

  it('is a no-op without SQL outside the optional lane, so foreground validation is unchanged', async () => {
    const c = client(true)
    pool.waitingCount = 3
    expect(isOptionalEvidence()).toBe(false)
    await yieldOptionalEvidence(c)
    const release = await enterOptionalEvidenceSlot(c)
    release(true)
    expect(c.query).not.toHaveBeenCalled()
    expect(optionalEvidenceState()).toMatchObject({ active: 0, deferrals: 0 })
  })

  it('defers with the 55P03 withhold code when its own transaction blocks another backend, then backs off', async () => {
    const blocking = client(true)
    const error = await runOptionalEvidence({}, () => yieldOptionalEvidence(blocking)).catch(e => e)
    expect(error).toBeInstanceOf(OptionalEvidenceDeferred)
    expect(error).toMatchObject({ code: '55P03', deferral: 'blocking_foreground', retrySafe: true })
    // The backoff window defers later optional work at entry, before any SQL.
    const idle = client(false)
    await expect(runOptionalEvidence({}, () => yieldOptionalEvidence(idle))).rejects.toMatchObject({ deferral: 'backoff' })
    expect(idle.query).not.toHaveBeenCalled()
  })

  it('yields to queued app-pool checkouts and to its own aborted request', async () => {
    pool.waitingCount = 1
    await expect(runOptionalEvidence({}, () => yieldOptionalEvidence(client(false)))).rejects.toMatchObject({ deferral: 'pool_waiters' })
    resetOptionalEvidenceStateForTests(); pool.waitingCount = 0
    const abort = new AbortController(); abort.abort()
    await expect(runOptionalEvidence({ signal: abort.signal }, () => yieldOptionalEvidence())).rejects.toMatchObject({ deferral: 'aborted' })
    // A request's own abort is not foreground pressure.
    expect(optionalEvidenceState().backoffUntil).toBe(0)
  })

  it('runs one optional heavy validation per installation; a waiter proceeds after release or defers at its bound', async () => {
    const order: string[] = []
    const first = runOptionalEvidence({}, async () => {
      const release = await enterOptionalEvidenceSlot(client(false))
      order.push('first:start')
      await new Promise(resolve => setTimeout(resolve, 150))
      order.push('first:end'); release(true)
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    const second = runOptionalEvidence({}, async () => {
      const release = await enterOptionalEvidenceSlot(client(false))
      order.push('second:start'); release(true)
    })
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second:start'])

    const holder = runOptionalEvidence({}, async () => {
      const release = await enterOptionalEvidenceSlot(client(false))
      await new Promise(resolve => setTimeout(resolve, 400)); release(true)
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    await expect(runOptionalEvidence({ waitMs: 150 }, () => enterOptionalEvidenceSlot(client(false)))).rejects.toMatchObject({ deferral: 'slot_wait' })
    await holder
    expect(optionalEvidenceState()).toMatchObject({ active: 0 })
  })

  it('a waiting holder defers as soon as it blocks someone instead of keeping its locks', async () => {
    const holder = runOptionalEvidence({}, async () => {
      const release = await enterOptionalEvidenceSlot(client(false))
      await new Promise(resolve => setTimeout(resolve, 2_000)); release(true)
    })
    await new Promise(resolve => setTimeout(resolve, 10))
    const started = Date.now()
    await expect(runOptionalEvidence({}, async () => {
      const waiting = client(false)
      waiting.query.mockResolvedValueOnce({ rows: [{ blocking: false }] }).mockResolvedValue({ rows: [{ blocking: true }] })
      await enterOptionalEvidenceSlot(waiting)
    })).rejects.toMatchObject({ deferral: 'blocking_foreground' })
    expect(Date.now() - started).toBeLessThan(1_500)
    await holder
  })

  it('a completed optional validation resets the backoff window', async () => {
    await runOptionalEvidence({}, () => yieldOptionalEvidence(client(true))).catch(() => {})
    expect(optionalEvidenceState().backoffUntil).toBeGreaterThan(Date.now())
    vi.useFakeTimers({ now: Date.now() + 60_000, toFake: ['Date'] })
    await runOptionalEvidence({}, async () => { const release = await enterOptionalEvidenceSlot(client(false)); release(true) })
    expect(optionalEvidenceState().backoffUntil).toBe(0)
  })
})
