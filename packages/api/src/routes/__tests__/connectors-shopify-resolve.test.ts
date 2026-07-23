import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { connectorRoutes } from '../connectors.js'
import type { ShopifyDomainResolution } from '../../shopify/resolve-domain.js'

/**
 * Route-glue coverage for POST /api/connectors/shopify/resolve-domain in the
 * OPEN (self-host) connectors router: auth gate + status-code mapping around
 * the injected resolver. The resolver's own logic is covered by
 * shopify/__tests__/resolve-domain.test.ts; this pins the HTTP contract the
 * connect form depends on. The closed edition mirrors it in
 * packages/api-platform/src/routes/__tests__/connectors-shopify-resolve.test.ts.
 */

const PATH = '/api/connectors/shopify/resolve-domain'
const ok = (shopDomain: string, source: 'direct' | 'redirect'): ShopifyDomainResolution => ({ ok: true, shopDomain, source })
const err = (reason: 'invalid_input' | 'blocked' | 'not_shopify' | 'fetch_failed'): ShopifyDomainResolution => ({ ok: false, reason })

function makeApp(opts: { userId?: string; resolve: (input: string) => Promise<ShopifyDomainResolution> }) {
  const app = express()
  app.use(express.json())
  if (opts.userId) {
    app.use((req, _res, next) => { (req as { userId?: string }).userId = opts.userId; next() })
  }
  app.use('/api/connectors', connectorRoutes({
    connectorStore: {} as never,
    connectorInstanceStore: {} as never,
    shopifyResolveDomain: opts.resolve,
  }))
  return app
}

describe('[COMP:api/shopify-domain-resolve] Shopify resolve-domain route (open edition)', () => {
  it('401 without auth', async () => {
    const app = makeApp({ resolve: async () => ok('x.myshopify.com', 'direct') })
    const res = await request(app).post(PATH).send({ input: 'gymshark.com' })
    expect(res.status).toBe(401)
  })

  it('400 invalid_input for missing or blank input', async () => {
    const app = makeApp({ userId: 'u1', resolve: async () => ok('x.myshopify.com', 'direct') })
    expect((await request(app).post(PATH).send({})).status).toBe(400)
    expect((await request(app).post(PATH).send({ input: '   ' })).status).toBe(400)
  })

  it('200 { shopDomain, source } on success', async () => {
    const app = makeApp({ userId: 'u1', resolve: async () => ok('gymsharkusa.myshopify.com', 'redirect') })
    const res = await request(app).post(PATH).send({ input: 'gymshark.com' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ shopDomain: 'gymsharkusa.myshopify.com', source: 'redirect' })
  })

  it('400 for blocked (SSRF), 422 for not_shopify and fetch_failed', async () => {
    const blocked = makeApp({ userId: 'u1', resolve: async () => err('blocked') })
    expect((await request(blocked).post(PATH).send({ input: '169.254.169.254' })).status).toBe(400)
    const notShop = makeApp({ userId: 'u1', resolve: async () => err('not_shopify') })
    expect((await request(notShop).post(PATH).send({ input: 'google.com' })).status).toBe(422)
    const failed = makeApp({ userId: 'u1', resolve: async () => err('fetch_failed') })
    expect((await request(failed).post(PATH).send({ input: 'brand.com' })).status).toBe(422)
  })

  it('502 when the resolver throws', async () => {
    const app = makeApp({ userId: 'u1', resolve: async () => { throw new Error('boom') } })
    const res = await request(app).post(PATH).send({ input: 'brand.com' })
    expect(res.status).toBe(502)
  })

  it('passes trimmed input to the resolver', async () => {
    const spy = vi.fn(async () => ok('x.myshopify.com', 'direct'))
    const app = makeApp({ userId: 'u1', resolve: spy })
    await request(app).post(PATH).send({ input: '  gymshark.com  ' })
    expect(spy).toHaveBeenCalledWith('gymshark.com')
  })
})
