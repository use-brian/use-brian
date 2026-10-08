import { describe, expect, it, vi } from 'vitest'
import { createRelayCommandTransport, relayExtensionStatus, supportsProtectedFill } from '../relay-transport.js'
import type { LocalBrowserControlMode } from '@use-brian/core'

describe('[COMP:sandbox/local-browser] Relay command profile policy', () => {
  it('resolves local-control mode on every command instead of trusting assistant input', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const urls: string[] = []
    let mode: LocalBrowserControlMode = 'task_tabs'
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(_url))
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
      taskId: 'local-fictional-task',
    })
    mode = 'full_browser'
    await transport.send({
      userId: 'user-1',
      browserProfileId: 'profile-1',
      op: 'listTabs',
    })

    expect(urls).toEqual(['https://relay.example/internal/browser/task-command', 'https://relay.example/internal/browser/command'])
    expect(bodies[0]?.taskId).toBe('local-fictional-task')
    expect(bodies[1]).not.toHaveProperty('taskId')
    expect(bodies.map((body) => body.controlMode)).toEqual(['task_tabs', 'full_browser'])
    expect(bodies.every((body) => body.browserProfileId === 'profile-1')).toBe(true)
  })
  it('refuses an old relay without retrying the command on its unbound endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('Not found', { status: 404 }))
    const transport = createRelayCommandTransport({ relayUrl: 'https://relay.example', relaySecret: 'fictional', fetchImpl })
    expect(await transport.send({ userId: 'user', browserProfileId: 'profile', taskId: 'task', op: 'navigate', args: { url: 'https://portal.example' } }))
      .toMatchObject({ ok: false, code: 'not_configured' })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://relay.example/internal/browser/task-command')
  })

})


describe('protected fill explicit capability eligibility', () => {
  it.each([undefined, { protectedFillV1: false }, { protectedFillV1: 'true' }, { protectedFillV1: true }])('requires a true capability, not origin/build alone: %j', async capabilities => {
    const origin = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const status = await relayExtensionStatus({ relayUrl: 'https://relay.example', relaySecret: 'secret', userId: 'u',
      fetchImpl: async () => new Response(JSON.stringify({ connected: true, extensionOrigin: origin, build: 'current', staleBuild: false, capabilities })),
    })
    expect(supportsProtectedFill(status, new Set([origin]))).toBe(capabilities?.protectedFillV1 === true)
    expect(supportsProtectedFill(status, new Set())).toBe(false)
    expect(supportsProtectedFill(status && { ...status, connected: false }, new Set([origin]))).toBe(false)
  })
})
