/**
 * Unit tests for the Microsoft Graph retry/backoff helper.
 * Component tag: [COMP:msgraph/backoff].
 *
 * `sleep`, `random`, and `now` are injected so every assertion is against a
 * known-good literal delay rather than a recomputation of the implementation's
 * own arithmetic.
 */

import { describe, it, expect, vi } from 'vitest'
import { fetchWithRetry } from '../backoff.js'

describe('[COMP:msgraph/backoff] Graph retry + backoff', () => {
  it('returns a 200 immediately and calls doFetch exactly once', async () => {
    const doFetch = vi.fn(async () => new Response(null, { status: 200 }))
    const sleepCalls: number[] = []

    const res = await fetchWithRetry(doFetch, {
      sleep: async (ms) => { sleepCalls.push(ms) },
    })

    expect(res.status).toBe(200)
    expect(doFetch).toHaveBeenCalledTimes(1)
    expect(sleepCalls).toEqual([])
  })

  it('honors a numeric Retry-After (seconds) on a 429, then returns the retried 200', async () => {
    const responses = [
      new Response(null, { status: 429, headers: { 'Retry-After': '2' } }),
      new Response(null, { status: 200 }),
    ]
    const doFetch = vi.fn(async () => responses.shift() as Response)
    const sleepCalls: number[] = []

    const res = await fetchWithRetry(doFetch, {
      sleep: async (ms) => { sleepCalls.push(ms) },
    })

    expect(sleepCalls).toEqual([2000])
    expect(res.status).toBe(200)
    expect(doFetch).toHaveBeenCalledTimes(2)
  })

  it('honors an HTTP-date Retry-After as a delta against the injected clock', async () => {
    const responses = [
      new Response(null, {
        status: 429,
        headers: { 'Retry-After': 'Wed, 23 Jul 2026 04:00:10 GMT' },
      }),
      new Response(null, { status: 200 }),
    ]
    const doFetch = vi.fn(async () => responses.shift() as Response)
    const sleepCalls: number[] = []

    const res = await fetchWithRetry(doFetch, {
      sleep: async (ms) => { sleepCalls.push(ms) },
      // Ten seconds before the header's instant.
      now: () => Date.UTC(2026, 6, 23, 4, 0, 0),
    })

    expect(sleepCalls).toEqual([10_000])
    expect(res.status).toBe(200)
    expect(doFetch).toHaveBeenCalledTimes(2)
  })

  it('falls back to exponential backoff when a 429 carries no Retry-After', async () => {
    const throttled = () => new Response(null, { status: 429 })

    // random() === 0.5 is the centre of the jitter window, so the delays land
    // exactly on base, 2x base, 4x base.
    const centred: number[] = []
    await fetchWithRetry(async () => throttled(), {
      baseDelayMs: 1000,
      sleep: async (ms) => { centred.push(ms) },
      random: () => 0.5,
    })
    expect(centred).toEqual([1000, 2000, 4000])

    // The jitter window is +/-25% around each of those.
    const low: number[] = []
    await fetchWithRetry(async () => throttled(), {
      baseDelayMs: 1000,
      sleep: async (ms) => { low.push(ms) },
      random: () => 0,
    })
    expect(low).toEqual([750, 1500, 3000])

    const high: number[] = []
    await fetchWithRetry(async () => throttled(), {
      baseDelayMs: 1000,
      sleep: async (ms) => { high.push(ms) },
      random: () => 1,
    })
    expect(high).toEqual([1250, 2500, 5000])
  })

  it('clamps every delay at maxDelayMs, including a long Retry-After', async () => {
    const responses = [
      new Response(null, { status: 429, headers: { 'Retry-After': '3600' } }),
      new Response(null, { status: 200 }),
    ]
    const doFetch = vi.fn(async () => responses.shift() as Response)
    const retryAfterSleeps: number[] = []

    // An hour-long Retry-After must not park the worker for an hour.
    await fetchWithRetry(doFetch, {
      sleep: async (ms) => { retryAfterSleeps.push(ms) },
    })
    expect(retryAfterSleeps).toEqual([60_000])

    // The exponential path is clamped by the same ceiling.
    const backoffSleeps: number[] = []
    await fetchWithRetry(async () => new Response(null, { status: 429 }), {
      baseDelayMs: 1000,
      maxDelayMs: 2500,
      sleep: async (ms) => { backoffSleeps.push(ms) },
      random: () => 0.5,
    })
    expect(backoffSleeps).toEqual([1000, 2000, 2500])
  })

  it('retries 5xx but returns a non-429 4xx immediately', async () => {
    for (const status of [401, 404]) {
      const doFetch = vi.fn(async () => new Response(null, { status }))
      const sleepCalls: number[] = []

      const res = await fetchWithRetry(doFetch, {
        sleep: async (ms) => { sleepCalls.push(ms) },
      })

      // A dead credential must not burn the whole backoff budget.
      expect(res.status).toBe(status)
      expect(doFetch).toHaveBeenCalledTimes(1)
      expect(sleepCalls).toEqual([])
    }

    const responses = [
      new Response(null, { status: 503 }),
      new Response(null, { status: 200 }),
    ]
    const doFetch = vi.fn(async () => responses.shift() as Response)
    const sleepCalls: number[] = []

    const res = await fetchWithRetry(doFetch, {
      baseDelayMs: 1000,
      sleep: async (ms) => { sleepCalls.push(ms) },
      random: () => 0.5,
    })

    expect(res.status).toBe(200)
    expect(doFetch).toHaveBeenCalledTimes(2)
    expect(sleepCalls).toEqual([1000])
  })

  it('returns the last still-failing response after maxAttempts, without throwing', async () => {
    let attempt = 0
    const doFetch = vi.fn(async () => {
      attempt += 1
      return new Response(null, {
        status: 429,
        headers: { 'Retry-After': '1', 'x-attempt': String(attempt) },
      })
    })
    const sleepCalls: number[] = []

    const res = await fetchWithRetry(doFetch, {
      maxAttempts: 3,
      sleep: async (ms) => { sleepCalls.push(ms) },
    })

    // Seam 2 classifies the real response, so it must be handed back, not thrown.
    expect(res.status).toBe(429)
    expect(res.headers.get('x-attempt')).toBe('3')
    expect(doFetch).toHaveBeenCalledTimes(3)
    expect(sleepCalls).toEqual([1000, 1000])
  })

  it('retries a rejected doFetch like a 5xx, and propagates the final rejection', async () => {
    let call = 0
    const flaky = vi.fn(async () => {
      call += 1
      if (call <= 2) throw new Error(`socket hang up ${call}`)
      return new Response(null, { status: 200 })
    })
    const sleepCalls: number[] = []

    const res = await fetchWithRetry(flaky, {
      baseDelayMs: 1000,
      sleep: async (ms) => { sleepCalls.push(ms) },
      random: () => 0.5,
    })

    expect(res.status).toBe(200)
    expect(flaky).toHaveBeenCalledTimes(3)
    expect(sleepCalls).toEqual([1000, 2000])

    let attempt = 0
    const alwaysDown = vi.fn(async (): Promise<Response> => {
      attempt += 1
      throw new Error(`ECONNREFUSED ${attempt}`)
    })
    const deadSleeps: number[] = []

    await expect(
      fetchWithRetry(alwaysDown, {
        maxAttempts: 3,
        baseDelayMs: 1000,
        sleep: async (ms) => { deadSleeps.push(ms) },
        random: () => 0.5,
      }),
    ).rejects.toThrow('ECONNREFUSED 3')

    expect(alwaysDown).toHaveBeenCalledTimes(3)
    expect(deadSleeps).toEqual([1000, 2000])
  })
})
