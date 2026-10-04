import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Tool } from '@use-brian/core'
const mocks = vi.hoisted(() => ({ generic: vi.fn(), shop: vi.fn() }))
vi.mock('../../shopify/client.js', async original => ({
  ...await original<typeof import('../../shopify/client.js')>(),
  createShopifyTokenManager: mocks.generic, getShop: mocks.shop,
}))
import { injectMcpTools } from '../inject.js'
import { packShopifyTokens } from '../../shopify/client.js'

beforeEach(() => { vi.clearAllMocks(); mocks.shop.mockResolvedValue({}); mocks.generic.mockReturnValue({ getAuth: async () => ({ accessToken: 'legacy', shopDomain: 'fixture.myshopify.com' }) }) })

async function inject(path: string, result: 'short' | 'valid' | 'static' | 'missing' | 'error', durable = true) {
  const overlay = path.split('-')[0]
  const extra = path.endsWith('extra')
  const instances = ['primary', 'extra'].map((id, i) => ({ id, provider: 'shopify', connectorId: 'shopify', label: id, name: id,
    connected: true, custom: false, url: null, createdAt: new Date(i), healthStatus: 'ok' }))
  const credentials = { type: 'oauth', client_id: 'shopify_oauth', client_secret: packShopifyTokens({ shopDomain: 'fixture.myshopify.com', accessToken: 'durable',
    ...(result === 'static' ? {} : { refreshToken: 'refresh', expiresAt: new Date(Date.now() + (result === 'short' ? 56000 : 3600000)).toISOString() }) }) }
  const refresh = vi.fn(async () => { if (result === 'error') throw new Error('connector_rotation_uncertain'); return result === 'missing' ? null : credentials })
  const persist = vi.fn(), load = vi.fn(async () => credentials)
  const tools = new Map<string, Tool>()
  await injectMcpTools({ userId: 'user', assistantId: 'assistant', tools, keepBuiltinsDirect: true,
    ...(overlay === 'grant' || overlay === 'workspace' ? { assistantTeamId: 'workspace' } : {}),
    connectorStore: { list: vi.fn(async () => instances), getCredentials: load, upsert: persist } as never,
    settingsStore: new Proxy({}, { get: () => vi.fn().mockResolvedValue(undefined) }) as never,
    connectorInstanceStore: { listByWorkspaceSystem: vi.fn(async () => overlay === 'workspace' ? instances : []),
      getCredentialsSystem: load, updateCredentialsSystem: persist,
      ...(durable ? { refreshShopifyCredentialsSystem: refresh } : {}) } as never,
    ...(overlay === 'grant' ? { connectorGrantStore: { listForTargetSystem: vi.fn(async () => instances.map(instance => ({ instance, grantedByUserId: 'grantor' }))) } as never } : {}),
  })
  const name = extra ? [...tools.keys()].find(name => name.startsWith('shopifyGetShop__extra'))! : 'shopifyGetShop'
  expect(tools.has(name)).toBe(true)
  await tools.get(name)!.execute({}, {} as never).catch(() => undefined)
  return { refresh, persist, load }
}

describe('Shopify MCP durable rotation boundary', () => {
  it.each(['primary', 'grant', 'workspace', 'extra', 'grant-extra', 'workspace-extra'])('%s never falls back to generic refresh', async path => {
    for (const result of ['short', 'valid', 'static', 'missing', 'error'] as const) {
      vi.clearAllMocks()
      const { refresh, persist, load } = await inject(path, result)
      expect(refresh).toHaveBeenCalledWith(path.endsWith('extra') ? 'extra' : 'primary')
      expect(mocks.generic).not.toHaveBeenCalled()
      expect(persist).not.toHaveBeenCalled()
      expect(load).not.toHaveBeenCalled()
      expect(mocks.shop).toHaveBeenCalledTimes(result === 'valid' || result === 'static' ? 1 : 0)
    }
  })
  it('retains the legacy manager when no durable store is installed', async () => {
    await inject('primary', 'static', false)
    expect(mocks.generic).toHaveBeenCalled()
    expect(mocks.shop).toHaveBeenCalledWith({ accessToken: 'legacy', shopDomain: 'fixture.myshopify.com' })
  })
})
