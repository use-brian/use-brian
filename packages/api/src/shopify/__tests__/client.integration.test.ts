/**
 * Live Shopify integration suite — runs against a real (dev) store when
 * SHOPIFY_TEST_SHOP_DOMAIN + SHOPIFY_TEST_ACCESS_TOKEN are set; skips
 * otherwise. The mocked twin of the "last 5 orders" path always runs in
 * client.test.ts. Component tag: [COMP:api/shopify-client].
 */

import { describe, it, expect } from 'vitest'
import {
  normalizeShopDomain,
  getShop,
  listOrders,
  listProducts,
  type ShopifyAuth,
} from '../client.js'

const shopDomain = normalizeShopDomain(process.env.SHOPIFY_TEST_SHOP_DOMAIN ?? '')
const accessToken = process.env.SHOPIFY_TEST_ACCESS_TOKEN ?? ''

const ok = !!shopDomain && !!accessToken
const describeIf = ok ? describe : describe.skip
if (!ok) {
  console.log('[shopify.integration] skipped — set SHOPIFY_TEST_SHOP_DOMAIN + SHOPIFY_TEST_ACCESS_TOKEN (dev store shpat_ token) to run live')
}

const AUTH: ShopifyAuth = { shopDomain: shopDomain ?? '', accessToken }

describeIf('[COMP:api/shopify-client] Shopify live dev-store', () => {
  it('getShop returns the connected store identity', async () => {
    const shop = (await getShop(AUTH)) as { name?: string; myshopifyDomain?: string }
    expect(shop.myshopifyDomain).toBe(shopDomain)
    expect(shop.name).toBeTruthy()
  })

  it('listOrders answers the "last 5 orders" ask', async () => {
    const orders = (await listOrders(AUTH, { first: 5 })) as {
      edges?: Array<{ node?: { id?: string; name?: string } }>
      pageInfo?: { hasNextPage?: boolean }
    }
    expect(Array.isArray(orders.edges)).toBe(true)
    // A fresh dev store may legitimately have zero orders; the contract is
    // shape, not count.
    for (const edge of orders.edges ?? []) {
      expect(edge.node?.id).toMatch(/^gid:\/\/shopify\/Order\//)
      expect(edge.node?.name).toBeTruthy()
    }
  })

  it('listProducts returns projected-queryable rows', async () => {
    const products = (await listProducts(AUTH, { first: 3 })) as {
      edges?: Array<{ node?: { id?: string; title?: string } }>
    }
    expect(Array.isArray(products.edges)).toBe(true)
  })
})
