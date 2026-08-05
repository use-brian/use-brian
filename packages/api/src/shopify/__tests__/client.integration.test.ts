/**
 * Live Shopify integration suite — runs against a real (dev) store when
 * SHOPIFY_TEST_SHOP_DOMAIN + SHOPIFY_TEST_ACCESS_TOKEN are set; skips
 * otherwise. The mocked twin of the "last 5 orders" path always runs in
 * client.test.ts. Component tag: [COMP:api/shopify-client].
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  normalizeShopDomain,
  shopifyGraphql,
  getShop,
  listOrders,
  listProducts,
  createProduct,
  updateProduct,
  addProductImage,
  setVariantPrice,
  publishProduct,
  setProductMetafields,
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

  // ── Product authoring, live ────────────────────────────────
  //
  // The mocked twin in client.test.ts proves the request shapes. Only this can
  // prove the parts a mock cannot reach: that the staged-upload multipart POST
  // is accepted by the real bucket, that write_publications was actually
  // granted, that 'Online Store' is the label this store's publication carries,
  // and that metafieldsSet accepts the types we send.
  //
  // It CREATES a product and leaves it ARCHIVED (there is no productDelete in
  // the client). Run against a dev/test store only.
  it('creates, images, prices, publishes, and annotates a product', { timeout: 120_000 }, async () => {
    const created = (await createProduct(AUTH, {
      title: 'Use Brian e2e product authoring check',
      descriptionHtml: '<p>Created by the live integration suite. Safe to delete.</p>',
      vendor: 'Use Brian',
      productType: 'Test',
      tags: ['use-brian-e2e'],
      status: 'DRAFT',
    })) as { product?: { id?: string; handle?: string } }
    const productId = created.product?.id
    expect(productId).toMatch(/^gid:\/\/shopify\/Product\//)

    try {
      // 1. Image — the staged-upload path. SHOPIFY_TEST_IMAGE_PATH lets a real
      //    product photo drive this; otherwise a generated 1x1 PNG.
      const imagePath = process.env.SHOPIFY_TEST_IMAGE_PATH
      const bytes = imagePath
        ? new Uint8Array(readFileSync(imagePath))
        : new Uint8Array(Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64',
          ))
      await addProductImage(AUTH, {
        productId: productId!,
        bytes,
        filename: imagePath ? 'product.jpg' : 'pixel.png',
        mimeType: imagePath ? 'image/jpeg' : 'image/png',
        alt: 'Use Brian e2e check',
      })

      // 2. Price — resolves the lone default variant.
      const priced = (await setVariantPrice(AUTH, {
        productId: productId!,
        price: '439.00',
        sku: 'UB-E2E-1',
      })) as { productVariants?: Array<{ price?: string }> }
      expect(priced.productVariants?.[0]?.price).toBe('439.00')

      // 3. Metafields — the types have to be ones Shopify accepts.
      await setProductMetafields(AUTH, {
        productId: productId!,
        metafields: [
          { namespace: 'custom', key: 'ub_e2e_note', type: 'multi_line_text_field', value: 'live check' },
        ],
      })

      // 4. Publish — needs write_publications, and needs the publication lookup
      //    to have matched this store's Online Store channel.
      //
      // Publishing while DRAFT is deliberately exercised first: it succeeds,
      // and it does NOT make the product visible. That combination is why the
      // return value carries `visible` rather than a bare success.
      const draftPublish = (await publishProduct(AUTH, { productId: productId! })) as {
        published_to?: string; product_status?: string; visible?: boolean
      }
      expect(draftPublish.published_to).toMatch(/^gid:\/\/shopify\/Publication\//)
      expect(draftPublish.product_status).toBe('DRAFT')
      expect(draftPublish.visible).toBe(false)

      // 5. Activate — the step a "create a product" request actually needs, and
      //    the one that makes the publication take effect.
      await updateProduct(AUTH, { id: productId!, status: 'ACTIVE' })

      // Assert publication from SHOPIFY's side, not ours. `published_to` is
      // echoed from our own lookup, so on its own it proves nothing about
      // whether the product actually reached a channel. This has to run BEFORE
      // the archive below — archiving unpublishes from every sales channel.
      const state = await shopifyGraphql<{
        product?: {
          variants?: { edges?: Array<{ node?: { price?: string } }> }
          resourcePublications?: { edges?: Array<{ node?: { isPublished?: boolean; publication?: { name?: string } } }> }
        }
      }>(AUTH, `
        query E2EProductState($id: ID!) {
          product(id: $id) {
            variants(first: 2) { edges { node { price } } }
            resourcePublications(first: 10) { edges { node { isPublished publication { name } } } }
          }
        }
      `, { id: productId })

      expect(state.product?.variants?.edges?.[0]?.node?.price).toBe('439.00')
      const live = (state.product?.resourcePublications?.edges ?? [])
        .map((e) => e.node)
        .filter((n) => n?.isPublished)
      expect(live.length).toBeGreaterThan(0)
      expect(live.map((n) => n?.publication?.name)).toContain('Online Store')
    } finally {
      // Archive rather than leave an ACTIVE test product on the storefront.
      await updateProduct(AUTH, { id: productId!, status: 'ARCHIVED' }).catch(() => {})
    }
  })
})
