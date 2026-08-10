import { describe, expect, it } from 'vitest'
import { createRelayCommandTransport } from '../relay-transport.js'
import type { LocalBrowserControlMode } from '@use-brian/core'

describe('[COMP:sandbox/local-browser] Relay command profile policy', () => {
  it('resolves local-control mode on every command instead of trusting assistant input', async () => {
    const bodies: Array<Record<string, unknown>> = []
    let mode: LocalBrowserControlMode = 'task_tabs'
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
      return new Response(JSON.stringify({ ok: true, data: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    const transport = createRelayCommandTransport({
      relayUrl: 'https://relay.example',
      relaySecret: 'secret',
      fetchImpl,
      resolveLocalControlMode: async () => mode,
    })

    await transport.send({
      userId: 'user-1',
      browserProfileId: 'profile-1',
      op: 'listTabs',
    })
    mode = 'full_browser'
    await transport.send({
      userId: 'user-1',
      browserProfileId: 'profile-1',
      op: 'listTabs',
    })

    expect(bodies.map((body) => body.controlMode)).toEqual(['task_tabs', 'full_browser'])
    expect(bodies.every((body) => body.browserProfileId === 'profile-1')).toBe(true)
  })
})
