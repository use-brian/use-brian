import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProtectedFillService } from '../../../../core/src/sandbox/protected-fill.js'
import { protectedBrowserFillRoutes } from '../../routes/protected-browser-fill.js'
import { signBrowserExtSessionToken } from '../../auth/browser-ext-pair-token.js'
import { createRelayCommandTransport } from '../relay-transport.js'

afterEach(() => vi.unstubAllGlobals())

describe('actual extension coordinator with backend auth/resolve/complete', () => {
  it.each([true, false])('recovers backend reservation after human approval=%s', async approved => {
    // Runtime-only cross-project boundary: the extension owns its Chrome/DOM
    // compilation, not the API's Node-only rootDir. Vitest loads its real source.
    const extensionSource = '../../../../../apps/browser-extension/src/protected-fill.ts'
    const { ProtectedFill, LOCK_KEY, BROWSER_SESSION_KEY } = await import(extensionSource)
    const scope = { userId: 'u', workspaceId: 'w', sessionId: 's', taskId: 't', browserProfileId: 'p', destinationOrigin: 'https://example.com' }
    const { userId: _, ...binding } = scope
    const token = signBrowserExtSessionToken(scope, 'secret')
    const stored: Record<string, unknown> = { sessionToken: token, protectedApiBase: 'https://api.example.com' }
    const storage = {
      get: async (key: string | string[]) => Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, structuredClone(stored[k])])),
      set: async (values: Record<string, unknown>) => { Object.assign(stored, structuredClone(values)) },
      remove: async (key: string) => { delete stored[key] },
    }
    const extension = new ProtectedFill(storage as ConstructorParameters<typeof ProtectedFill>[0])
    let tabs = [{ id: 1 }]
    vi.stubGlobal('chrome', { storage: { session: { get: async () => ({ [BROWSER_SESSION_KEY]: '12345678-1234-1234-1234-123456789abc' }) } }, action: { setBadgeText: async () => {} }, runtime: { getURL: (p: string) => p },
      windows: { create: async () => { extension.approve(approved) } },
      tabs: { query: async () => tabs, remove: async () => { tabs = [] } },
    })
    const service = createProtectedFillService({ authorize: async () => true, validateSource: async () => true, readSource: async () => 'SECRET_SENTINEL' })
    const app = express().use(express.json()).use('/api/protected-browser-fill', protectedBrowserFillRoutes({ service, jwtSecret: 'secret', extensionOrigins: new Set(['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']), onComplete: async () => {}, userAuth: (req, _res, next) => { req.userId = 'u'; next() } }))
    const paths: string[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname
      paths.push(path)
      const headers = new Headers(init.headers)
      const result = await request(app).post(path).set('Authorization', headers.get('Authorization')!).set('Origin', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').send(JSON.parse(String(init.body)))
      return new Response(JSON.stringify(result.body), { status: result.status })
    })
    const issued = await service.create(scope, [{ kind: 'crm', entityId: 'entity', field: 'email' }])
    const values: unknown[] = []
    const transport = createRelayCommandTransport({ relayUrl: 'https://relay.example', relaySecret: 'secret', protectedFill: service,
      fetchImpl: async (_url, init) => {
        const command = JSON.parse(String(init?.body))
        try {
          const data = await extension.fill(command.args, () => [1], async () => async (items: Array<{ ref: string; value: string }>) => { values.push(...items) })
          return new Response(JSON.stringify({ ok: true, data }))
        } catch { return new Response(JSON.stringify({ ok: false, error: 'Protected fill unavailable', code: 'protected_fill_denied' })) }
      },
    })
    const result = await transport.send({ userId: 'u', browserProfileId: 'p', op: 'browserFillReference', args: { ...binding, items: [{ referenceId: issued.references[0]!.referenceId, ref: '@e1' }] } })
    expect(result.ok).toBe(approved)
    expect(JSON.stringify({ result, stored, issued })).not.toContain('SECRET_SENTINEL')
    expect(values).toEqual(approved ? [{ ref: '@e1', value: 'SECRET_SENTINEL' }] : [])
    expect(paths.includes('/api/protected-browser-fill/resolve')).toBe(approved)
    expect(service.isLocked(scope)).toBe(true)
    expect(stored[LOCK_KEY]).toBeTruthy()
    await extension.complete(async () => {})
    expect(service.isLocked(scope)).toBe(false)
    expect(stored[LOCK_KEY]).toBeUndefined()
    expect(tabs).toHaveLength(0)
  })
})

describe('server lock recovery after delivery failed before extension received the request', () => {
  it.each(['policyFailure', 'deliveryFailure', 'uncertainDisclosure'])('%s can be recovered by authenticated human action without unlocking possible disclosure', async mode => {
    const extensionSource = '../../../../../apps/browser-extension/src/protected-fill.ts'
    const { ProtectedFill, LOCK_KEY, BROWSER_SESSION_KEY } = await import(extensionSource)
    const scope = { userId: 'u', workspaceId: 'w', sessionId: 's', taskId: 't', browserProfileId: 'p', destinationOrigin: 'https://example.com' }
    const { userId: _, ...binding } = scope
    const token = signBrowserExtSessionToken(scope, 'secret')
    const stored: Record<string, unknown> = { sessionToken: token, protectedApiBase: 'https://api.example.com' }
    const storage = {
      get: async (key: string | string[]) => Object.fromEntries((Array.isArray(key) ? key : [key]).map(k => [k, structuredClone(stored[k])])),
      set: async (values: Record<string, unknown>) => { Object.assign(stored, structuredClone(values)) },
      remove: async (key: string) => { delete stored[key] },
    }
    const extension = new ProtectedFill(storage as ConstructorParameters<typeof ProtectedFill>[0])
    let tabs = [{ id: 101 }, { id: 202 }]
    const keeperUrl = 'chrome-extension://id/popup.html#protected-cleanup'
    vi.stubGlobal('chrome', { storage: { session: { get: async () => ({ [BROWSER_SESSION_KEY]: '12345678-1234-1234-1234-123456789abc' }) } },
      action: { setBadgeText: async () => {} }, runtime: { getURL: (p: string) => `chrome-extension://id/${p}` },
      windows: { create: async () => { tabs.push({ id: 900 }); return { tabs: [{ id: 900 }] } } },
      tabs: { query: async () => tabs, get: async () => ({ id: 900, url: keeperUrl }), remove: async (ids: number[]) => { tabs = tabs.filter(t => !ids.includes(t.id)) } },
    })
    const service = createProtectedFillService({ authorize: async () => true, authorizeRecovery: async () => true,
      validateSource: async () => true, readSource: async () => 'SECRET_SENTINEL' })
    let retired = false
    const app = express().use(express.json()).use('/api/protected-browser-fill', protectedBrowserFillRoutes({ service, jwtSecret: 'secret', extensionOrigins: new Set(['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']), onComplete: async sessionId => { expect(sessionId).toBe('s'); retired = true }, userAuth: (_req, _res, next) => next() }))
    const requests: string[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      requests.push(new URL(url).pathname)
      const result = await request(app).post(new URL(url).pathname).set('Authorization', new Headers(init.headers).get('Authorization')!).set('Origin', 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa').send(JSON.parse(String(init.body)))
      return new Response(JSON.stringify(result.body), { status: result.status })
    })
    const issued = await service.create(scope, [{ kind: 'crm', entityId: 'entity', field: 'email' }])
    const items = [{ referenceId: issued.references[0]!.referenceId, ref: '@e1' }]
    const transport = createRelayCommandTransport({ relayUrl: 'https://relay.example', relaySecret: 'secret', protectedFill: service,
      resolveLocalControlMode: async () => { if (mode === 'policyFailure') throw new Error('policy unavailable'); return 'task_tabs' },
      fetchImpl: async () => { throw new Error('delivery uncertain') },
    })
    expect((await transport.send({ userId: 'u', browserProfileId: 'p', op: 'browserFillReference', args: { ...binding, items } })).ok).toBe(false)
    expect(service.isLocked(scope)).toBe(true)
    expect(stored[LOCK_KEY]).toBeUndefined()
    if (mode === 'uncertainDisclosure') await service.resolve(scope, items) // response delivered or lost; never assumed safe
    const recovered = await extension.recoverServer()
    if (mode === 'uncertainDisclosure') {
      expect(recovered).toBe('cleanup_required')
      expect(service.isLocked(scope)).toBe(true)
      expect(stored[LOCK_KEY]).toMatchObject({ tabIds: [] })
      expect((stored[LOCK_KEY] as { browserSessionId?: string }).browserSessionId).toBeUndefined()
      await expect(extension.complete(async () => {})).rejects.toThrow('Protected fill unavailable')
      expect(requests).toEqual(['/api/protected-browser-fill/recover'])
      expect(tabs).toHaveLength(2)
      await extension.complete(async () => {}, true)
      expect(tabs).toEqual([{ id: 900 }])
    } else {
      expect(recovered).toBe('cancelled')
      expect(stored[LOCK_KEY]).toBeUndefined()
      expect(tabs).toHaveLength(2)
    }
    expect(service.isLocked(scope)).toBe(false)
    expect(retired).toBe(true)
    await expect(service.resolve(scope, items)).rejects.toThrow('Protected fill unavailable')
    await expect(service.reserve(scope, items)).rejects.toThrow('Protected fill unavailable')
    expect(JSON.stringify({ stored, recovered })).not.toContain('SECRET_SENTINEL')
  })
})
