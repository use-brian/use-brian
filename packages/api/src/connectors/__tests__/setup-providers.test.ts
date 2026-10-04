import { beforeEach, describe, expect, it, vi } from 'vitest'
const api = vi.hoisted(() => ({ graphql: vi.fn(), exchange: vi.fn(), hmac: vi.fn() }))
vi.mock('../../shopify/client.js', async original => {
  const real = await original<typeof import('../../shopify/client.js')>()
  return { ...real, shopifyGraphql: api.graphql, exchangeShopifyAuthorizationCode: api.exchange, verifyShopifyOAuthQueryHmac: api.hmac }
})
import { connectorSetupProviders } from '../setup-providers.js'
const provider = connectorSetupProviders().get('shopify')!
const callback = { state: 'opaque-setup.opaque-nonce' }
beforeEach(() => {
  vi.clearAllMocks()
  api.hmac.mockReturnValue(true)
  api.exchange.mockResolvedValue({ accessToken: 'secret', refreshToken: 'refresh', expiresAt: '2030-01-01' })
  api.graphql.mockResolvedValue({ shop: { id: 'gid://shopify/Shop/1', myshopifyDomain: 'test.myshopify.com' }, currentAppInstallation: { accessScopes: [{ handle: 'read_products' }] } })
})
describe('Shopify setup proof adapter (no catalog certification)', () => {
  it('proves account, canonical root and actual permission set, not client labels', async () => {
    const result = await provider.verify({ shopDomain: 'test.myshopify.com', accessToken: 'secret' }, callback)
    expect(result.account).toMatchObject({ subject: 'gid://shopify/Shop/1', roots: ['test.myshopify.com'], permissions: ['read_products'] })
    expect(JSON.stringify(result.account)).not.toContain('secret')
    expect(api.exchange).not.toHaveBeenCalled()
  })
  it('exchanges a bound signed OAuth callback and preserves refresh/app secrets only in credentials', async () => {
    const result = await provider.verify({ kind: 'oauth', params: { state: callback.state, code: 'code', shop: 'test.myshopify.com' }, clientId: 'app', clientSecret: 'app-secret' }, callback)
    expect(api.exchange).toHaveBeenCalledTimes(1)
    expect(result.credentials).toMatchObject({ type: 'oauth', client_id: 'shopify_oauth' })
    expect(JSON.stringify(result.account)).not.toContain('app-secret')
    expect(result.config).toEqual({ shopDomain: 'test.myshopify.com', byoApp: true })
  })
  it('rejects cross-setup OAuth state or invalid signature before exchanging any code', async () => {
    const proof = { kind: 'oauth', params: { state: 'other-state', code: 'code', shop: 'test.myshopify.com' }, clientId: 'app', clientSecret: 'secret' }
    await expect(provider.verify(proof, callback)).rejects.toThrow('connector_setup_evidence_invalid')
    api.hmac.mockReturnValue(false)
    await expect(provider.verify({ ...proof, params: { ...proof.params, state: callback.state } }, callback)).rejects.toThrow('connector_setup_evidence_invalid')
    expect(api.exchange).not.toHaveBeenCalled()
  })
  it('denies unverifiable or substituted roots and never trusts supplied permissions', async () => {
    api.graphql.mockResolvedValue({ shop: { id: 'shop', myshopifyDomain: 'other.myshopify.com' } })
    await expect(provider.verify({ shopDomain: 'test.myshopify.com', accessToken: 'secret' }, callback)).rejects.toThrow()
    await expect(provider.verify({ shopDomain: 'test.myshopify.com', accessToken: 'secret', permissions: ['all'] }, callback)).rejects.toThrow()
  })
})
