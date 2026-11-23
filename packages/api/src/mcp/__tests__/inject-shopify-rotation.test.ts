import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Tool, ToolContext } from '@use-brian/agent-runtime/tools/types.js'
const mocks = vi.hoisted(() => ({ generic: vi.fn(), shop: vi.fn(), addProductImage: vi.fn() }))
vi.mock('../../shopify/client.js', async original => ({
  ...await original<typeof import('../../shopify/client.js')>(),
  createShopifyTokenManager: mocks.generic, getShop: mocks.shop, addProductImage: mocks.addProductImage,
}))
import { composeForTest } from './surface-harness.js'
import { composeResumeCapabilities } from '../surface.js'
import { resolveResumeOutcomeNote } from '../../routes/session-resume-replay.js'
import { packShopifyTokens } from '../../shopify/client.js'

beforeEach(() => { vi.clearAllMocks(); mocks.shop.mockResolvedValue({}); mocks.generic.mockReturnValue({ getAuth: async () => ({ accessToken: 'legacy', shopDomain: 'fixture.myshopify.com' }) }) })

async function inject(path: string, result: 'short' | 'valid' | 'static' | 'missing' | 'error', durable = true) {
  const overlay = path.split('-')[0]
  const extra = path.endsWith('extra')
  const instances = ['primary', 'extra'].map((id, i) => ({ id, provider: 'shopify', connectorId: 'shopify', label: id, name: id,
    connected: true, custom: false, url: null, createdAt: new Date(i), healthStatus: 'ok', compartments: [], projectIds: [] }))
  const credentials = { type: 'oauth', client_id: 'shopify_oauth', client_secret: packShopifyTokens({ shopDomain: 'fixture.myshopify.com', accessToken: 'durable',
    ...(result === 'static' ? {} : { refreshToken: 'refresh', expiresAt: new Date(Date.now() + (result === 'short' ? 56000 : 3600000)).toISOString() }) }) }
  const refresh = vi.fn(async () => { if (result === 'error') throw new Error('connector_rotation_uncertain'); return result === 'missing' ? null : credentials })
  const persist = vi.fn(), load = vi.fn(async () => credentials)
  const tools = new Map<string, Tool>()
  await composeForTest({ userId: 'user', assistantId: 'assistant', tools, keepBuiltinsDirect: true,
    ...(overlay === 'grant' || overlay === 'workspace' ? { assistantTeamId: 'workspace' } : {}),
    connectorStore: { list: vi.fn(async () => instances), getCredentials: load, upsert: persist } as never,
    settingsStore: new Proxy({}, { get: (_target, key) => vi.fn().mockResolvedValue(key === 'getPolicies' ? [] : undefined) }) as never,
    connectorInstanceStore: { listByWorkspaceSystem: vi.fn(async () => overlay === 'workspace' ? instances : []),
      getCredentialsSystem: load, updateCredentialsSystem: persist,
      ...(durable ? { refreshShopifyCredentialsSystem: refresh } : {}) } as never,
    ...(overlay === 'grant' ? { connectorGrantStore: { listForTargetSystem: vi.fn(async () => instances.map(instance => ({ instance, grantedByUserId: 'grantor', compartments: [], projectIds: [] }))) } as never } : {}),
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

describe('[COMP:api/mcp-surface] Approved Shopify image attachment', () => {
  it('resolves an approved tool by name and promotes the original upload bytes before calling Shopify', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
    const file = { id: 'fictional-workspace-image', name: 'fictional-image.png', mime: 'image/png' }
    const cached = { id: 'fictional-upload', sessionId: 'session', fileName: file.name, mimeType: file.mime, sizeBytes: bytes.length,
      content: `data:image/png;base64,${bytes.toString('base64')}`, summary: null }
    const readCachedFile = vi.fn(async () => cached)
    const readBytes = vi.fn().mockResolvedValueOnce({ ok: false, error: { kind: 'not_found', reference: cached.id } })
      .mockResolvedValueOnce({ ok: true, value: { file, bytes } })
    const writeBytes = vi.fn().mockResolvedValue({ ok: true, value: file })
    const connecting = { id: 'fictional-shop', provider: 'shopify', label: 'Fictional shop', config: {}, connected: true, custom: false,
      url: null, healthStatus: 'ok', compartments: [], projectIds: [], createdAt: new Date(0) }
    const credentials = { type: 'oauth', client_id: 'shopify_oauth', client_secret: packShopifyTokens({
      shopDomain: 'fixture.myshopify.com', accessToken: 'fake' }) }
    mocks.addProductImage.mockResolvedValueOnce({ product: { id: 'fictional-product' } })
    const tools = new Map<string, Tool>()
    await composeResumeCapabilities({ userId: 'user', assistantId: 'assistant', assistantTeamId: 'workspace', tools,
      suspendedToolName: 'shopifyAddProductImage',
      connectorStore: { list: async () => [] } as never,
      connectorInstanceStore: { listByWorkspaceSystem: async () => [connecting], getSystem: async () => connecting,
        refreshShopifyCredentialsSystem: async () => credentials, markHealth: async () => {} } as never,
      settingsStore: new Proxy({}, { get: (_target, key) => vi.fn().mockResolvedValue(key === 'getPolicies' ? [] : undefined) }) as never,
      filesApi: { readBytes, writeBytes } as never, readCachedFile, policyReader: async () => [], actionGrantReader: null,
    })
    expect([...tools.keys()]).toEqual(['shopifyAddProductImage'])
    const outcome = await resolveResumeOutcomeNote(tools, { approvalId: 'approval', approvalKind: 'tool_invocation',
      approvalStatus: 'approved', suspendedToolName: 'shopifyAddProductImage', rejectReason: null, answerText: null,
      suspendedToolInput: { productId: 'fictional-product', file: cached.id } },
    { userId: 'user', assistantId: 'assistant', workspaceId: 'workspace' } as ToolContext)
    expect(outcome).toContain('executed successfully')
    expect(readCachedFile).toHaveBeenCalledExactlyOnceWith(cached.id, expect.objectContaining({ workspaceId: 'workspace', userId: 'user' }))
    expect(writeBytes).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ workspaceId: 'workspace' }), expect.objectContaining({ bytes }))
    expect(mocks.addProductImage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ shopDomain: 'fixture.myshopify.com' }),
      expect.objectContaining({ bytes, filename: file.name, mimeType: file.mime }))
  })
})
