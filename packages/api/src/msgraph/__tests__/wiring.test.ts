/**
 * Production wiring for the Microsoft Graph connector.
 *
 * The client's own unit tests inject a passthrough `retry`, so they never
 * exercise the default. These do: they prove `fetchWithRetry` is actually
 * wired in, and that it fails fast on a dead credential instead of spending
 * the backoff budget on it.
 *
 * Port conformance against packages/core is covered in client.test.ts.
 * See docs/plans/msteams-connector.md §5 P1.
 */

import { describe, it, expect } from 'vitest'
import { createMsGraphClient } from '../client.js'

describe('[COMP:msgraph/wiring] Graph client default transport', () => {
  it('retries a throttled request through the real backoff', async () => {
    // No `retry` injected, so this is the production path. Retry-After: 0
    // keeps the test off real timers while still proving the 429 was retried
    // rather than surfaced to the caller.
    let attempts = 0
    const client = createMsGraphClient({
      getAccessToken: async () => 'token',
      fetchImpl: async () => {
        attempts++
        if (attempts < 3) {
          return new Response('throttled', {
            status: 429,
            headers: { 'Retry-After': '0' },
          })
        }
        return new Response(JSON.stringify({ value: [{ id: 'team-1' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    })

    const teams = await client.listTeams({})

    expect(attempts).toBe(3)
    expect(teams).toEqual({ value: [{ id: 'team-1' }] })
  })

  it('does not burn retry attempts on a dead credential', async () => {
    // 401 is not retryable. The whole point of the non-429 4xx rule is that a
    // revoked consent surfaces immediately so the instance can be marked
    // auth_failed on the first turn rather than the fourth.
    let calls = 0
    const client = createMsGraphClient({
      getAccessToken: async () => 'token',
      fetchImpl: async () => {
        calls++
        return new Response('unauthorized', { status: 401 })
      },
    })

    await expect(client.listTeams({})).rejects.toThrow(/reconnect/i)
    expect(calls).toBe(1)
  })
})
