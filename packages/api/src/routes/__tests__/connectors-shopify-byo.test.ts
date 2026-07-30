import { describe, it, expect, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { connectorRoutes } from '../connectors.js'
import { unpackShopifyAppCredentials, unpackShopifyTokens } from '../../shopify/client.js'
import type { ConnectorStore } from '../../db/connector-store.js'
import type { ConnectorInstanceStore } from '../../db/connector-instance-store.js'

/**
 * Per-merchant Shopify app credentials (BYO client id + secret), OPEN edition.
 *
 * Step 1 of the BYO connect stores the merchant's app pair BEFORE the authorize
 * redirect, when no token exists yet; the callback then lands the token and the
 * pair must survive. See docs/architecture/integrations/shopify.md →
 * "Per-merchant app credentials". The closed edition mirrors this in
 * packages/api-platform/src/routes/__tests__/connectors-shopify-byo.test.ts.
 */

const APP_PATH = '/api/connectors/shopify/app-credentials'
const STORE_PATH = '/api/connectors/shopify/store-credentials'
const SHOP = 'teststore.myshopify.com'
const IID = '11111111-1111-1111-1111-111111111111'

function makeApp(over: { storedBlob?: string } = {}) {
  const createUserInstance = vi.fn().mockResolvedValue({ id: IID })
  const update = vi.fn().mockResolvedValue({ id: IID })
  const getAuthCredentialsSystem = vi.fn().mockResolvedValue(
    over.storedBlob ? { type: 'oauth', client_id: 'shopify_byo_pending', client_secret: over.storedBlob } : null,
  )
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { (req as { userId?: string }).userId = 'u1'; next() })
  app.use('/api/connectors', connectorRoutes({
    connectorStore: { getConfig: vi.fn().mockResolvedValue({}), setConfig: vi.fn() } as unknown as ConnectorStore,
    connectorInstanceStore: {
      listForUser: vi.fn().mockResolvedValue([]),
      listByUser: vi.fn().mockResolvedValue([]),
      createUserInstance,
      update,
      getAuthCredentialsSystem,
      setConfig: vi.fn().mockResolvedValue(undefined),
    } as unknown as ConnectorInstanceStore,
    // The pasted-token probe: never reached on the BYO path, but the route needs it.
    shopifyVerifyToken: vi.fn().mockResolvedValue({ myshopifyDomain: SHOP }),
  }))
  return { app, createUserInstance, update, getAuthCredentialsSystem }
}

describe('[COMP:api/shopify-byo-credentials] Shopify per-merchant app credentials (open edition)', () => {
  it('stores the app pair with NO token and leaves the instance disconnected', async () => {
    const { app, createUserInstance } = makeApp()

    const res = await request(app).post(APP_PATH).send({
      shopDomain: SHOP, clientId: 'merchant_cid', clientSecret: 'shpss_merchant',
    })

    expect(res.status).toBe(200)
    const arg = createUserInstance.mock.calls[0]![0] as {
      connected: boolean
      config: Record<string, unknown>
      credentials: { client_secret: string }
    }
    // Nothing may claim a working connection before a token lands.
    expect(arg.connected).toBe(false)
    // The webhook routing key is set now, so a delivery mid-flow still resolves.
    expect(arg.config).toMatchObject({ shopDomain: SHOP })
    expect(unpackShopifyAppCredentials(arg.credentials.client_secret)).toEqual({
      clientId: 'merchant_cid', clientSecret: 'shpss_merchant',
    })
    // And the strict reader must still say "not connected" for this blob.
    expect(unpackShopifyTokens(arg.credentials.client_secret)).toBeNull()
  })

  it('rejects a bad shop domain, a half pair, and CR/LF injection', async () => {
    const { app, createUserInstance } = makeApp()

    const bad = [
      { shopDomain: 'notashop.example', clientId: 'c', clientSecret: 's' },
      { shopDomain: SHOP, clientId: 'c' },
      { shopDomain: SHOP, clientSecret: 's' },
      // The secret keys an HMAC and the id goes into an authorize URL, so CR/LF
      // is the header/URL-injection shape to block.
      { shopDomain: SHOP, clientId: 'c\r\nX-Evil: 1', clientSecret: 's' },
      { shopDomain: SHOP, clientId: 'c', clientSecret: 's\nX-Evil: 1' },
      { shopDomain: SHOP, clientId: 'c', clientSecret: 'x'.repeat(8193) },
    ]
    for (const payload of bad) {
      expect((await request(app).post(APP_PATH).send(payload)).status).toBe(400)
    }
    expect(createUserInstance).not.toHaveBeenCalled()
  })

  it('401s without auth', async () => {
    const app = express()
    app.use(express.json())
    app.use('/api/connectors', connectorRoutes({
      connectorStore: {} as unknown as ConnectorStore,
      connectorInstanceStore: {} as unknown as ConnectorInstanceStore,
    }))
    const res = await request(app).post(APP_PATH).send({ shopDomain: SHOP, clientId: 'c', clientSecret: 's' })
    expect(res.status).toBe(401)
  })

  it('carries the app pair into the token envelope when the callback stores the token', async () => {
    const { app, createUserInstance } = makeApp()

    const res = await request(app).post(STORE_PATH).send({
      shopifyTokens: {
        accessToken: 'shpat_from_merchant_app',
        refreshToken: 'shprt_r',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        shopDomain: SHOP,
      },
      shopifyApp: { clientId: 'merchant_cid', clientSecret: 'shpss_merchant' },
    })

    expect(res.status).toBe(200)
    const arg = createUserInstance.mock.calls[0]![0] as { credentials: { client_secret: string } }
    expect(unpackShopifyTokens(arg.credentials.client_secret)).toMatchObject({
      accessToken: 'shpat_from_merchant_app',
      appClientId: 'merchant_cid',
      appClientSecret: 'shpss_merchant',
    })
  })

  it('re-reads a STORED pair when the caller omits it, so a reconnect cannot strip it', async () => {
    // store-credentials rewrites the envelope wholesale. Without this, a
    // reconnect that sends only a token would erase the app pair and silently
    // break every later refresh and webhook verification for the instance.
    const stored = JSON.stringify({
      shopDomain: SHOP, appClientId: 'merchant_cid', appClientSecret: 'shpss_merchant',
    })
    const { app, update, getAuthCredentialsSystem } = makeApp({ storedBlob: stored })

    const res = await request(app).post(STORE_PATH).send({
      shopifyTokens: { accessToken: 'shpat_new', shopDomain: SHOP },
      instanceId: IID,
    })

    expect(res.status).toBe(200)
    expect(getAuthCredentialsSystem).toHaveBeenCalledWith(IID)
    const patch = update.mock.calls[0]![2] as { credentials: { client_secret: string } }
    expect(unpackShopifyTokens(patch.credentials.client_secret)).toMatchObject({
      accessToken: 'shpat_new',
      appClientId: 'merchant_cid',
      appClientSecret: 'shpss_merchant',
    })
  })

  it('a plain pasted-token connect stores no app pair at all', async () => {
    // The legacy escape hatch must stay pair-free rather than inheriting one.
    const { app, createUserInstance } = makeApp()

    await request(app).post(STORE_PATH).send({
      shopifyTokens: { accessToken: 'shpat_pasted', shopDomain: SHOP },
    })

    const arg = createUserInstance.mock.calls[0]![0] as { credentials: { client_secret: string } }
    expect(unpackShopifyAppCredentials(arg.credentials.client_secret)).toBeNull()
  })

  it('reads the pair off a DISCONNECTED instance (the accessor trap)', async () => {
    // Step 1 leaves the instance `connected: false` on purpose, and
    // `getCredentialsSystem` filters `connected = true`. Using it here returned
    // null and surfaced as `app_credentials_missing` after a fully successful
    // Shopify consent — an otherwise correct connect failing at the last hop.
    // The store method must be the one WITHOUT the connected filter.
    const stored = JSON.stringify({
      shopDomain: SHOP, appClientId: 'merchant_cid', appClientSecret: 'shpss_merchant',
    });
    const { app, getAuthCredentialsSystem } = makeApp({ storedBlob: stored });

    // oauth-callback is the path that reads it back; a bad accessor 400s here.
    const res = await request(app).post('/api/connectors/shopify/oauth-callback').send({
      instanceId: IID,
      params: { code: 'c0de', shop: SHOP, hmac: 'deadbeef', state: 'x' },
    });

    expect(getAuthCredentialsSystem).toHaveBeenCalledWith(IID);
    // The pair WAS found, so we get as far as the HMAC gate rather than
    // bailing out with app_credentials_missing.
    expect(res.body.error).not.toBe('app_credentials_missing');
    expect(res.body.error).toBe('invalid_hmac');
  });
});
