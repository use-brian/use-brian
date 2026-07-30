import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { connectorRoutes } from '../connectors.js'
import type { ConnectorStore } from '../../db/connector-store.js'
import type { ConnectorInstanceStore } from '../../db/connector-instance-store.js'

/**
 * Verify-before-store on a PASTED Shopify token, OPEN (self-host) edition.
 *
 * The pasted Admin API token is the connector's only credential (the OAuth
 * connect path is not offered — docs/architecture/integrations/shopify.md →
 * "Auth model"), so `store-credentials` probes it against the store before
 * persisting anything. Without that, a typo'd token produces an instance that
 * reads "Connected" and fails at the first tool call.
 *
 * The closed edition mirrors this in
 * packages/api-platform/src/routes/__tests__/connectors-shopify-verify.test.ts;
 * the two routers are a hand-maintained fork, so both need the coverage.
 */

const PATH = '/api/connectors/shopify/store-credentials'
const SHOP = 'teststore.myshopify.com'

type Identity = { name?: string; myshopifyDomain?: string }

function makeApp(verify: (auth: { accessToken: string; shopDomain: string }) => Promise<Identity>) {
  const createUserInstance = vi.fn().mockResolvedValue({ id: 'i1' })
  const setConfig = vi.fn().mockResolvedValue(undefined)
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as { userId?: string }).userId = 'u1'; next() })
  app.use('/api/connectors', connectorRoutes({
    connectorStore: { getConfig: vi.fn().mockResolvedValue({}), setConfig } as unknown as ConnectorStore,
    connectorInstanceStore: {
      listForUser: vi.fn().mockResolvedValue([]),
      listByUser: vi.fn().mockResolvedValue([]),
      createUserInstance,
      update: vi.fn().mockResolvedValue({ id: 'i1' }),
    } as unknown as ConnectorInstanceStore,
    shopifyVerifyToken: verify,
  }))
  return { app, createUserInstance }
}

describe('[COMP:api/shopify-oauth] Shopify pasted-token verification (open edition)', () => {
  it('stores the credentials when Shopify accepts the token', async () => {
    const verify = vi.fn().mockResolvedValue({ name: 'Test Store', myshopifyDomain: SHOP })
    const { app, createUserInstance } = makeApp(verify)

    const res = await request(app).post(PATH).send({
      shopifyTokens: { accessToken: 'shpat_good', shopDomain: SHOP },
    })

    expect(res.status).toBe(200)
    // The probe is handed the very token being stored, against the very shop.
    expect(verify).toHaveBeenCalledWith({ accessToken: 'shpat_good', shopDomain: SHOP })
    expect(createUserInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'shopify',
        credentials: expect.objectContaining({ client_id: 'shopify_token' }),
      }),
    )
  })

  it('400 invalid_token and stores NOTHING when Shopify rejects the token', async () => {
    // The whole point: a bad paste must not produce a "Connected" instance.
    const { app, createUserInstance } = makeApp(async () => { throw new Error('Shopify API error (401): invalid or expired token') })

    const res = await request(app).post(PATH).send({
      shopifyTokens: { accessToken: 'shpat_typo', shopDomain: SHOP },
    })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'invalid_token' })
    expect(createUserInstance).not.toHaveBeenCalled()
  })

  it("adopts Shopify's canonical host over the one the user typed", async () => {
    // A branded domain resolves to a handle that is often not the brand name,
    // and config.shopDomain is the key webhook routing resolves on, so the
    // store's own answer has to win.
    const { app, createUserInstance } = makeApp(async () => ({ myshopifyDomain: 'weareallbirds.myshopify.com' }))

    const res = await request(app).post(PATH).send({
      shopifyTokens: { accessToken: 'shpat_good', shopDomain: 'allbirds.myshopify.com' },
    })

    expect(res.status).toBe(200)
    const arg = createUserInstance.mock.calls[0]![0] as {
      label?: string
      connectedEmail?: string | null
      credentials: { client_secret: string }
    }
    expect(arg.label).toBe('weareallbirds.myshopify.com')
    expect(arg.connectedEmail).toBe('weareallbirds.myshopify.com')
    expect(JSON.parse(arg.credentials.client_secret)).toMatchObject({
      shopDomain: 'weareallbirds.myshopify.com',
    })
  })

  it('skips the probe for a managed (OAuth) tuple', async () => {
    // Managed tuples only arrive from the OAuth callback, which already proved
    // the token by fetching shop identity. Re-probing here would spend a
    // request on a path this route does not own.
    const verify = vi.fn().mockResolvedValue({ myshopifyDomain: SHOP })
    const { app, createUserInstance } = makeApp(verify)

    const res = await request(app).post(PATH).send({
      shopifyTokens: {
        accessToken: 'shpat_expiring',
        refreshToken: 'shprt_rotating',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        shopDomain: SHOP,
      },
    })

    expect(res.status).toBe(200)
    expect(verify).not.toHaveBeenCalled()
    expect(createUserInstance).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: expect.objectContaining({ client_id: 'shopify_oauth' }) }),
    )
  })

  it('rejects a missing token or a non-myshopify domain before probing', async () => {
    const verify = vi.fn().mockResolvedValue({ myshopifyDomain: SHOP })
    const { app } = makeApp(verify)

    expect((await request(app).post(PATH).send({ shopifyTokens: { shopDomain: SHOP } })).status).toBe(400)
    expect((await request(app).post(PATH).send({ shopifyTokens: { accessToken: 'shpat_x', shopDomain: 'notashop.example' } })).status).toBe(400)
    expect(verify).not.toHaveBeenCalled()
  })
})
