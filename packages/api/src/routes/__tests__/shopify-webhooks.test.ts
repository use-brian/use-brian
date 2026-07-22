/**
 * Shopify compliance webhook receiver tests.
 * Component tag: [COMP:api/shopify-webhooks].
 *
 * Covers the HMAC gate (base64 over the RAW body, keyed by the app client
 * secret), the fail-closed inert mode (no secret configured → 401, never a
 * crash), and the `shop/redact` purge path (instance resolved by
 * config.shopDomain, deleted via the system-level writer).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createHmac } from 'node:crypto'
import { shopifyWebhookRoutes, findShopifyInstancesByShopDomain } from '../shopify-webhooks.js'
import type { ConnectorInstanceStore, ConnectorInstance } from '../../db/connector-instance-store.js'

const SECRET = 'shopify-app-secret'
const SHOP = 'teststore.myshopify.com'

function instanceRow(overrides: Partial<ConnectorInstance> = {}): ConnectorInstance {
  return {
    id: 'inst-1',
    provider: 'shopify',
    config: { shopDomain: SHOP },
    connected: true,
  } as unknown as ConnectorInstance
}

function mockStore(instances: ConnectorInstance[] = []) {
  return {
    listByProviderSystem: vi.fn().mockResolvedValue(instances),
    deleteSystem: vi.fn().mockResolvedValue(undefined),
  } as unknown as ConnectorInstanceStore & {
    listByProviderSystem: ReturnType<typeof vi.fn>
    deleteSystem: ReturnType<typeof vi.fn>
  }
}

function buildApp(store: ConnectorInstanceStore, secret: string | undefined) {
  const app = express()
  // Mirror boot.ts: global json parser stashing the raw bytes for HMAC.
  app.use(express.json({
    verify: (req, _res, buf) => {
      ;(req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8')
    },
  }))
  app.use('/webhook/shopify', shopifyWebhookRoutes({
    connectorInstanceStore: store,
    getClientSecret: () => secret,
  }))
  return app
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64')
}

async function flushAsync() {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

describe('[COMP:api/shopify-webhooks] Shopify compliance webhook receiver', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects every delivery with 401 when no client secret is configured (inert mode)', async () => {
    const store = mockStore([instanceRow()])
    const body = JSON.stringify({ shop_domain: SHOP })
    const res = await request(buildApp(store, undefined))
      .post('/webhook/shopify')
      .set('Content-Type', 'application/json')
      .set('X-Shopify-Topic', 'shop/redact')
      .set('X-Shopify-Shop-Domain', SHOP)
      .set('X-Shopify-Hmac-Sha256', sign(body, SECRET))
      .send(body)
    expect(res.status).toBe(401)
    await flushAsync()
    expect(store.deleteSystem).not.toHaveBeenCalled()
  })

  it('rejects a bad signature with 401', async () => {
    const store = mockStore([instanceRow()])
    const body = JSON.stringify({ shop_domain: SHOP })
    const res = await request(buildApp(store, SECRET))
      .post('/webhook/shopify')
      .set('Content-Type', 'application/json')
      .set('X-Shopify-Topic', 'shop/redact')
      .set('X-Shopify-Hmac-Sha256', sign(body + 'tamper', SECRET))
      .send(body)
    expect(res.status).toBe(401)
    await flushAsync()
    expect(store.deleteSystem).not.toHaveBeenCalled()
  })

  it('acks the customer compliance topics with 200 and touches nothing', async () => {
    const store = mockStore([instanceRow()])
    for (const topic of ['customers/data_request', 'customers/redact']) {
      const body = JSON.stringify({ shop_domain: SHOP, customer: { id: 1 } })
      const res = await request(buildApp(store, SECRET))
        .post('/webhook/shopify')
        .set('Content-Type', 'application/json')
        .set('X-Shopify-Topic', topic)
        .set('X-Shopify-Shop-Domain', SHOP)
        .set('X-Shopify-Hmac-Sha256', sign(body, SECRET))
        .send(body)
      expect(res.status, topic).toBe(200)
    }
    await flushAsync()
    expect(store.deleteSystem).not.toHaveBeenCalled()
  })

  it('shop/redact purges every instance bound to the shop domain', async () => {
    const store = mockStore([
      instanceRow(),
      { ...instanceRow(), id: 'inst-2' } as ConnectorInstance,
      { ...instanceRow(), id: 'other-shop', config: { shopDomain: 'other.myshopify.com' } } as ConnectorInstance,
    ])
    const body = JSON.stringify({ shop_domain: SHOP })
    const res = await request(buildApp(store, SECRET))
      .post('/webhook/shopify')
      .set('Content-Type', 'application/json')
      .set('X-Shopify-Topic', 'shop/redact')
      .set('X-Shopify-Shop-Domain', SHOP)
      .set('X-Shopify-Hmac-Sha256', sign(body, SECRET))
      .send(body)
    expect(res.status).toBe(200)
    await vi.waitFor(() => {
      expect(store.deleteSystem).toHaveBeenCalledTimes(2)
    })
    expect(store.deleteSystem).toHaveBeenCalledWith('inst-1')
    expect(store.deleteSystem).toHaveBeenCalledWith('inst-2')
    expect(store.deleteSystem).not.toHaveBeenCalledWith('other-shop')
  })

  it('acks unknown topics with 200 (future ingest topics slot in without 4xx noise)', async () => {
    const store = mockStore()
    const body = JSON.stringify({ id: 1 })
    const res = await request(buildApp(store, SECRET))
      .post('/webhook/shopify')
      .set('Content-Type', 'application/json')
      .set('X-Shopify-Topic', 'orders/create')
      .set('X-Shopify-Shop-Domain', SHOP)
      .set('X-Shopify-Hmac-Sha256', sign(body, SECRET))
      .send(body)
    expect(res.status).toBe(200)
  })

  it('findShopifyInstancesByShopDomain matches on normalized config.shopDomain', async () => {
    const store = mockStore([
      instanceRow(),
      { ...instanceRow(), id: 'no-config', config: {} } as ConnectorInstance,
    ])
    const hits = await findShopifyInstancesByShopDomain(store, 'TESTSTORE.myshopify.com')
    expect(hits.map((h) => h.id)).toEqual(['inst-1'])
    expect(await findShopifyInstancesByShopDomain(store, 'not-a-shop')).toEqual([])
  })
})
