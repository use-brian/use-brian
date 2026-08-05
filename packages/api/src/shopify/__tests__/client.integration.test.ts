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
  setProductOptions,
  listThemes,
  readProductTemplate,
  createProductTemplate,
  setProductTemplate,
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

      // 6. Options — a real listing needs meaningful picker labels, not the
      //    placeholder "Title" / "Default Title" productCreate leaves behind.
      const renamed = (await setProductOptions(AUTH, {
        productId: productId!, name: 'Pack', values: ['250g'],
      })) as { product?: { options?: Array<{ name?: string; optionValues?: Array<{ name?: string }> }> } }
      expect(renamed.product?.options?.[0]?.name).toBe('Pack')
      expect(renamed.product?.options?.[0]?.optionValues?.[0]?.name).toBe('250g')
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

  // ── Theme product templates, live ──────────────────────────
  //
  // This writes a real file into a real theme, so it is the one place the
  // containment can be proven rather than asserted: the suffix gate, the
  // no-overwrite refusal, the section-type check, and that a cloned template
  // actually attaches to a product. Cleans up after itself.
  //
  // Needs read_themes + write_themes, which are NOT in the connector's default
  // scope list (see builtin-connectors.ts) — without them Shopify answers with
  // its own scope error and this row fails loudly rather than silently passing.
  it('clones a product template, attaches it, and refuses to overwrite', { timeout: 120_000 }, async () => {
    const themes = await listThemes(AUTH)
    expect(themes.length).toBeGreaterThan(0)
    const main = themes.find((t) => t.role === 'MAIN')
    expect(main, 'store needs a published theme').toBeTruthy()

    const base = await readProductTemplate(AUTH, {})
    expect(base.filename).toBe('templates/product.json')

    const suffix = 'ub-e2e-clone'
    const product = (await createProduct(AUTH, {
      title: 'Use Brian e2e template check',
      tags: ['use-brian-e2e'],
      status: 'DRAFT',
    })) as { product?: { id?: string } }
    const productId = product.product?.id

    try {
      const created = (await createProductTemplate(AUTH, {
        suffix,
        template: base.content,
      })) as { filename?: string }
      expect(created.filename).toBe(`templates/product.${suffix}.json`)

      // Create-only: the second write must be refused, not silently applied.
      await expect(createProductTemplate(AUTH, { suffix, template: base.content }))
        .rejects.toThrow(/already exists/)

      const attached = (await setProductTemplate(AUTH, { productId: productId!, templateSuffix: suffix })) as {
        product?: { templateSuffix?: string }
      }
      expect(attached.product?.templateSuffix).toBe(suffix)

      // Reading it back through the same gate proves the file is really there.
      const readBack = await readProductTemplate(AUTH, { suffix })
      expect(readBack.filename).toBe(`templates/product.${suffix}.json`)
      expect(readBack.content.length).toBeGreaterThan(0)
    } finally {
      if (productId) {
        await setProductTemplate(AUTH, { productId, templateSuffix: null }).catch(() => {})
        await updateProduct(AUTH, { id: productId, status: 'ARCHIVED' }).catch(() => {})
      }
      // Remove the template file — leaving test artefacts in a live theme is
      // exactly the mess this capability has to avoid.
      await shopifyGraphql(AUTH, `
        mutation CleanupE2ETemplate($themeId: ID!, $files: [String!]!) {
          themeFilesDelete(themeId: $themeId, files: $files) { deletedThemeFiles { filename } userErrors { message } }
        }
      `, { themeId: main!.id, files: [`templates/product.${suffix}.json`] }).catch(() => {})
    }
  })
})
