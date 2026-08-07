import { describe, it, expect, vi } from 'vitest'
import { createShopifyTools, type ShopifyApi } from '../base/shopify.js'
import { SHOPIFYQL_SCHEMAS } from '../base/shopify-analytics-catalog.js'

function mockApi(overrides: Partial<ShopifyApi> = {}): ShopifyApi {
  const emptyConn = { edges: [], pageInfo: { hasNextPage: false } }
  return {
    getShop: vi.fn().mockResolvedValue({ name: 'Test Store', myshopifyDomain: 'test.myshopify.com', currencyCode: 'USD' }),
    listProducts: vi.fn().mockResolvedValue(emptyConn),
    getProduct: vi.fn().mockResolvedValue({ id: 'gid://shopify/Product/1', title: 'Widget' }),
    listOrders: vi.fn().mockResolvedValue(emptyConn),
    getOrder: vi.fn().mockResolvedValue({ id: 'gid://shopify/Order/1', name: '#1001' }),
    searchCustomers: vi.fn().mockResolvedValue(emptyConn),
    getCustomer: vi.fn().mockResolvedValue({ id: 'gid://shopify/Customer/1', displayName: 'Jane' }),
    getInventoryLevels: vi.fn().mockResolvedValue(emptyConn),
    listCollections: vi.fn().mockResolvedValue(emptyConn),
    listDraftOrders: vi.fn().mockResolvedValue(emptyConn),
    listDiscounts: vi.fn().mockResolvedValue(emptyConn),
    listAbandonedCheckouts: vi.fn().mockResolvedValue(emptyConn),
    getPayoutsSummary: vi.fn().mockResolvedValue({ balance: [], payouts: emptyConn }),
    listDisputes: vi.fn().mockResolvedValue({ disputes: emptyConn }),
    listContent: vi.fn().mockResolvedValue(emptyConn),
    fetchOrdersRange: vi.fn().mockResolvedValue({ orders: [], truncated: false }),
    storefrontFunnel: vi.fn().mockResolvedValue({ columns: [], rows: [], shopifyql: 'FROM sessions SHOW sessions' }),
    runAnalyticsQuery: vi.fn().mockResolvedValue({ columns: [], rows: [] }),
    updateProduct: vi.fn().mockResolvedValue({ product: { id: 'gid://shopify/Product/1', title: 'Widget' } }),
    createProduct: vi.fn().mockResolvedValue({ product: { id: 'gid://shopify/Product/2', title: 'New', status: 'DRAFT' } }),
    createDraftOrder: vi.fn().mockResolvedValue({ draftOrder: { id: 'gid://shopify/DraftOrder/9', name: '#D9' } }),
    sendDraftOrderInvoice: vi.fn().mockResolvedValue({ draftOrder: { id: 'gid://shopify/DraftOrder/9' } }),
    addTags: vi.fn().mockResolvedValue({ node: { id: 'gid://shopify/Order/1' } }),
    updateCustomer: vi.fn().mockResolvedValue({ customer: { id: 'gid://shopify/Customer/1' } }),
    setInventoryQuantity: vi.fn().mockResolvedValue({}),
    createFulfillment: vi.fn().mockResolvedValue({ fulfillment: { id: 'gid://shopify/Fulfillment/1', status: 'SUCCESS' } }),
    createDiscountCode: vi.fn().mockResolvedValue({ codeDiscountNode: { id: 'gid://shopify/DiscountCodeNode/1' } }),
    createContent: vi.fn().mockResolvedValue({ page: { id: 'gid://shopify/OnlineStorePage/1', title: 'About' } }),
    cancelOrder: vi.fn().mockResolvedValue({ job: { id: 'j1' } }),
    refundOrder: vi.fn().mockResolvedValue({ refund: { id: 'gid://shopify/Refund/1' } }),
    completeDraftOrder: vi.fn().mockResolvedValue({ draftOrder: { id: 'gid://shopify/DraftOrder/9', status: 'COMPLETED' } }),
    addProductImage: vi.fn().mockResolvedValue({ product: { id: 'gid://shopify/Product/2' } }),
    setVariantPrice: vi.fn().mockResolvedValue({
      productVariants: [{ id: 'gid://shopify/ProductVariant/5', title: 'Default Title', price: '439.00' }],
    }),
    publishProduct: vi.fn().mockResolvedValue({
      published_to: 'gid://shopify/Publication/1', product_status: 'ACTIVE', visible: true,
    }),
    setProductMetafields: vi.fn().mockResolvedValue({
      metafields: [{ id: 'gid://shopify/Metafield/1', namespace: 'custom', key: 'ingredients', type: 'multi_line_text_field' }],
    }),
    setProductOptions: vi.fn().mockResolvedValue({
      product: { options: [{ name: 'Pack', optionValues: [{ name: '250g' }] }] },
    }),
    listThemes: vi.fn().mockResolvedValue([
      { id: 'gid://shopify/OnlineStoreTheme/1', name: 'Dawn', role: 'MAIN' },
    ]),
    readProductTemplate: vi.fn().mockResolvedValue({
      themeId: 'gid://shopify/OnlineStoreTheme/1', themeName: 'Dawn',
      filename: 'templates/product.json', content: '{"sections":{},"order":[]}',
    }),
    createProductTemplate: vi.fn().mockResolvedValue({
      theme: 'Dawn', filename: 'templates/product.demo.json', suffix: 'demo',
    }),
    setProductTemplate: vi.fn().mockResolvedValue({
      product: { id: 'gid://shopify/Product/2', templateSuffix: 'demo' },
    }),
    ...overrides,
  }
}

/** A `readFileBytes` that always succeeds, for the image-upload happy path. */
function mockFileReader(overrides: { mimeType?: string; fileName?: string } = {}) {
  return vi.fn().mockResolvedValue({
    bytes: new Uint8Array([1, 2, 3]),
    fileName: overrides.fileName ?? 'hojicha.jpg',
    mimeType: overrides.mimeType ?? 'image/jpeg',
  })
}

const READ_TOOLS = [
  'shopifyGetShop',
  'shopifyListProducts',
  'shopifyGetProduct',
  'shopifyListOrders',
  'shopifyGetOrder',
  'shopifySearchCustomers',
  'shopifyGetCustomer',
  'shopifyGetInventoryLevels',
  'shopifyListCollections',
  'shopifyListDraftOrders',
  'shopifyListDiscounts',
  'shopifyListAbandonedCheckouts',
  'shopifyGetPayoutsSummary',
  'shopifyListDisputes',
  'shopifyListContent',
  'shopifySalesReport',
  'shopifyStorefrontFunnel',
  'shopifyAnalyticsQuery',
  'shopifyListThemes',
  'shopifyReadProductTemplate',
]
const WRITE_TOOLS = [
  'shopifyUpdateProduct',
  'shopifyCreateProduct',
  'shopifyAddProductImage',
  'shopifySetProductPrice',
  'shopifyPublishProduct',
  'shopifySetProductMetafields',
  'shopifySetProductOptions',
  'shopifySetProductTemplate',
  'shopifyCreateDraftOrder',
  'shopifySendDraftOrderInvoice',
  'shopifyAddTags',
  'shopifyUpdateCustomer',
  'shopifySetInventory',
  'shopifyCreateFulfillment',
  'shopifyCreateDiscountCode',
  'shopifyCreateContent',
]
const DESTRUCTIVE_TOOLS = [
  'shopifyCancelOrder', 'shopifyRefundOrder', 'shopifyCompleteDraftOrder',
  // Writes a file into the theme customers are served from. A broken page is
  // invisible in the Shopify admin, so this sits with the destructive verbs.
  'shopifyCreateProductTemplate',
]

describe('[COMP:tools/shopify] Shopify tools', () => {
  it('creates the full 40-tool catalog', () => {
    const tools = createShopifyTools(mockApi())
    expect(tools).toHaveLength(40)
    expect(tools.map((t) => t.name).sort()).toEqual(
      [...READ_TOOLS, ...WRITE_TOOLS, ...DESTRUCTIVE_TOOLS].sort(),
    )
  })

  it('read tools are read-only + concurrency-safe; writes and destructive require confirmation', () => {
    const tools = createShopifyTools(mockApi())
    for (const tool of tools) {
      if (READ_TOOLS.includes(tool.name)) {
        expect(tool.isReadOnly, tool.name).toBe(true)
        expect(tool.isConcurrencySafe, tool.name).toBe(true)
        expect(tool.requiresConfirmation, tool.name).toBe(false)
      } else {
        expect(tool.isReadOnly, tool.name).toBe(false)
        expect(tool.isConcurrencySafe, tool.name).toBe(false)
        expect(tool.requiresConfirmation, tool.name).toBe(true)
      }
    }
  })

  it('write + destructive descriptions mention the Approve/Deny prompt, never "Requires confirmation"', () => {
    const tools = createShopifyTools(mockApi())
    for (const tool of tools) {
      expect(tool.description).not.toMatch(/requires confirmation/i)
      if (WRITE_TOOLS.includes(tool.name) || DESTRUCTIVE_TOOLS.includes(tool.name)) {
        expect(tool.description, tool.name).toMatch(/Approve\/Deny/)
      }
    }
  })

  // ── Product authoring ──────────────────────────────────────
  // A product created through the connector has no image, no price, and is
  // unpublished. These four tools are what make it sellable, so each failure
  // mode has to be loud rather than a cheerful-looking empty result.

  it('shopifyAddProductImage uploads the workspace file it was handed', async () => {
    const addProductImage = vi.fn().mockResolvedValue({ product: { id: 'gid://shopify/Product/2' } })
    const readFileBytes = mockFileReader()
    const tool = createShopifyTools(mockApi({ addProductImage }), { readFileBytes }).find(
      (t) => t.name === 'shopifyAddProductImage',
    )!
    const result = await tool.execute(
      { productId: '2', file: '/products/hojicha.jpg', alt: 'Hojicha Black Maca pouch' },
      {} as never,
    )
    expect(readFileBytes).toHaveBeenCalledWith(expect.anything(), '/products/hojicha.jpg')
    expect(addProductImage).toHaveBeenCalledWith(expect.objectContaining({
      productId: '2',
      filename: 'hojicha.jpg',
      mimeType: 'image/jpeg',
      alt: 'Hojicha Black Maca pouch',
    }))
    expect(result.isError).toBeFalsy()
    expect(result.data).toMatchObject({ uploaded: 'hojicha.jpg' })
  })

  it('shopifyAddProductImage reports honestly when no file reader is wired', async () => {
    // Silently omitting the tool would leave the model free to claim it
    // attached an image it never touched.
    const addProductImage = vi.fn()
    const tool = createShopifyTools(mockApi({ addProductImage })).find(
      (t) => t.name === 'shopifyAddProductImage',
    )!
    const result = await tool.execute({ productId: '2', file: 'abc' }, {} as never)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/not available/i)
    expect(addProductImage).not.toHaveBeenCalled()
  })

  it('shopifyAddProductImage refuses a non-image file before uploading anything', async () => {
    const addProductImage = vi.fn()
    const readFileBytes = mockFileReader({ mimeType: 'application/pdf', fileName: 'spec.pdf' })
    const tool = createShopifyTools(mockApi({ addProductImage }), { readFileBytes }).find(
      (t) => t.name === 'shopifyAddProductImage',
    )!
    const result = await tool.execute({ productId: '2', file: 'spec.pdf' }, {} as never)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/not an image/i)
    expect(addProductImage).not.toHaveBeenCalled()
  })

  it('shopifyAddProductImage surfaces a file-read failure instead of uploading', async () => {
    const addProductImage = vi.fn()
    const readFileBytes = vi.fn().mockResolvedValue({ error: 'File /nope.jpg not found in this workspace.' })
    const tool = createShopifyTools(mockApi({ addProductImage }), { readFileBytes }).find(
      (t) => t.name === 'shopifyAddProductImage',
    )!
    const result = await tool.execute({ productId: '2', file: '/nope.jpg' }, {} as never)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/not found/i)
    expect(addProductImage).not.toHaveBeenCalled()
  })

  it('shopifySetProductPrice projects the priced variant back', async () => {
    const tool = createShopifyTools(mockApi()).find((t) => t.name === 'shopifySetProductPrice')!
    const result = await tool.execute({ productId: '2', price: '439.00' }, {} as never)
    expect(result.data).toMatchObject({
      variants: [{ id: 'gid://shopify/ProductVariant/5', price: '439.00' }],
    })
  })

  it('shopifySetProductPrice relays a multi-variant refusal rather than guessing', async () => {
    const setVariantPrice = vi.fn().mockRejectedValue(
      new Error('Shopify API error: product has 3 variants - pass variantId. Variants: 1包 (gid://shopify/ProductVariant/5)'),
    )
    const tool = createShopifyTools(mockApi({ setVariantPrice })).find(
      (t) => t.name === 'shopifySetProductPrice',
    )!
    const result = await tool.execute({ productId: '2', price: '439.00' }, {} as never)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/pass variantId/)
  })

  it('shopifyPublishProduct says a DRAFT product is still not visible', async () => {
    // Verified live 2026-08-05: publishing a DRAFT succeeds and records the
    // publication, but the storefront shows nothing until status is ACTIVE.
    // Since products are created DRAFT, reporting a bare "published" here
    // sends the owner looking for a product that is not there.
    const publishProduct = vi.fn().mockResolvedValue({
      published_to: 'gid://shopify/Publication/1', product_status: 'DRAFT', visible: false,
    })
    const tool = createShopifyTools(mockApi({ publishProduct })).find(
      (t) => t.name === 'shopifyPublishProduct',
    )!
    const result = await tool.execute({ productId: '2' }, {} as never)
    expect(result.isError).toBeFalsy()
    const data = result.data as { visible: boolean; note: string }
    expect(data.visible).toBe(false)
    expect(data.note).toMatch(/NOT visible/)
    expect(data.note).toMatch(/shopifyUpdateProduct/)
  })

  it('shopifyPublishProduct confirms visibility for an ACTIVE product', async () => {
    const tool = createShopifyTools(mockApi()).find((t) => t.name === 'shopifyPublishProduct')!
    const result = await tool.execute({ productId: '2' }, {} as never)
    const data = result.data as { visible: boolean; note: string }
    expect(data.visible).toBe(true)
    expect(data.note).toMatch(/visible on the storefront/)
  })

  it('shopifyPublishProduct relays a missing Online Store channel', async () => {
    const publishProduct = vi.fn().mockRejectedValue(
      new Error('Shopify API error: this store has no Online Store sales channel, so a product cannot be published to a storefront. Channels found: none'),
    )
    const tool = createShopifyTools(mockApi({ publishProduct })).find(
      (t) => t.name === 'shopifyPublishProduct',
    )!
    const result = await tool.execute({ productId: '2' }, {} as never)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/no Online Store sales channel/)
  })

  it('shopifySetProductMetafields warns that the theme decides visibility', async () => {
    // A successful write is NOT a visible section. Without this note the model
    // tells the merchant the page is updated when nothing rendered.
    const tool = createShopifyTools(mockApi()).find((t) => t.name === 'shopifySetProductMetafields')!
    expect(tool.description).toMatch(/theme/i)
    const result = await tool.execute(
      { productId: '2', metafields: [{ namespace: 'custom', key: 'ingredients', type: 'multi_line_text_field', value: '焙茶, 黑瑪卡' }] },
      {} as never,
    )
    expect(result.data).toMatchObject({
      metafields: [{ namespace: 'custom', key: 'ingredients' }],
    })
    expect(String((result.data as { note?: string }).note)).toMatch(/theme/i)
  })

  it('shopifyCreateDiscountCode rejects a missing or doubled discount value at the schema', async () => {
    // A value-less "create a promo code XYZ" used to reach the client and come
    // back as an error tool-result, costing a round trip. The refine turns it
    // into a schema rejection the model can fix before any call goes out.
    const tool = createShopifyTools(mockApi()).find((t) => t.name === 'shopifyCreateDiscountCode')!
    expect(() => tool.inputSchema.parse({ code: 'XYZ' })).toThrow(/exactly one/i)
    expect(() => tool.inputSchema.parse({ code: 'XYZ', percentage: 10, amount: '5.00' })).toThrow(/exactly one/i)
    expect(() => tool.inputSchema.parse({ code: 'XYZ', percentage: 10 })).not.toThrow()
    expect(() => tool.inputSchema.parse({ code: 'XYZ', amount: '5.00' })).not.toThrow()
  })

  it('shopifyCreateDiscountCode forwards the validity window and projects it back', async () => {
    const createDiscountCode = vi.fn().mockResolvedValue({
      codeDiscountNode: {
        id: 'gid://shopify/DiscountCodeNode/1',
        codeDiscount: {
          title: 'XYZ', status: 'ACTIVE',
          startsAt: '2026-07-28T00:00:00Z', endsAt: '2026-07-31T00:00:00Z',
          usageLimit: null,
          codes: { edges: [{ node: { code: 'XYZ' } }] },
        },
      },
    })
    const tool = createShopifyTools(mockApi({ createDiscountCode })).find(
      (t) => t.name === 'shopifyCreateDiscountCode',
    )!
    const result = await tool.execute(
      { code: 'XYZ', percentage: 10, startsAt: '2026-07-28T00:00:00Z', endsAt: '2026-07-31T00:00:00Z' },
      {} as never,
    )
    expect(createDiscountCode).toHaveBeenCalledWith(
      expect.objectContaining({ startsAt: '2026-07-28T00:00:00Z', endsAt: '2026-07-31T00:00:00Z' }),
    )
    // The model needs the window back to ground "valid until ..." in its reply.
    expect(result.data).toMatchObject({
      code: 'XYZ', status: 'ACTIVE',
      starts_at: '2026-07-28T00:00:00Z', ends_at: '2026-07-31T00:00:00Z',
    })
  })

  it('shopifyListDiscounts projects code + automatic discount union members', async () => {
    const api = mockApi({
      listDiscounts: vi.fn().mockResolvedValue({
        pageInfo: { hasNextPage: false },
        edges: [
          { node: {
            id: 'gid://shopify/DiscountCodeNode/1',
            discount: {
              __typename: 'DiscountCodeBasic',
              title: 'Summer sale', status: 'ACTIVE', summary: '20% off',
              asyncUsageCount: 7, usageLimit: 100,
              startsAt: '2026-07-01T00:00:00Z', endsAt: '2026-08-01T00:00:00Z',
              codes: { edges: [{ node: { code: 'SUMMER20' } }] },
            },
          } },
          { node: {
            id: 'gid://shopify/DiscountAutomaticNode/2',
            discount: { __typename: 'DiscountAutomaticBasic', title: 'Auto 5%', status: 'ACTIVE' },
          } },
        ],
      }),
    })
    const tool = createShopifyTools(api).find((t) => t.name === 'shopifyListDiscounts')!
    const result = await tool.execute({ query: 'SUMMER20' }, {} as never)
    const data = result.data as { items: Array<Record<string, unknown>> }
    expect(data.items[0]).toMatchObject({
      kind: 'code', type: 'Basic', title: 'Summer sale', status: 'ACTIVE',
      usage_count: 7, usage_limit: 100, codes: ['SUMMER20'],
    })
    expect(data.items[1]).toMatchObject({ kind: 'automatic', title: 'Auto 5%' })
    expect(api.listDiscounts).toHaveBeenCalledWith({ query: 'SUMMER20', first: 10 })
  })

  it('shopifySalesReport aggregates count, revenue, average, and top items', async () => {
    const order = (amount: string, items: Array<[string, number]>) => ({
      totalPriceSet: { shopMoney: { amount, currencyCode: 'USD' } },
      lineItems: { edges: items.map(([title, quantity]) => ({ node: { title, quantity } })) },
    })
    const api = mockApi({
      fetchOrdersRange: vi.fn().mockResolvedValue({
        orders: [order('10.00', [['Widget', 2]]), order('30.00', [['Widget', 1], ['Gadget', 5]])],
        truncated: false,
      }),
    })
    const tool = createShopifyTools(api).find((t) => t.name === 'shopifySalesReport')!
    const result = await tool.execute({ since: '2026-07-01', until: '2026-07-31' }, {} as never)
    const data = result.data as Record<string, unknown>
    expect(data.orders_count).toBe(2)
    expect(data.revenue).toBe('40.00 USD')
    expect(data.average_order_value).toBe('20.00 USD')
    expect(data.top_items).toEqual([
      { title: 'Gadget', quantity: 5 },
      { title: 'Widget', quantity: 3 },
    ])
    expect(api.fetchOrdersRange).toHaveBeenCalledWith({
      query: 'created_at:>=2026-07-01 created_at:<=2026-07-31',
      maxOrders: 500,
    })
  })

  const FUNNEL_COLUMNS = [
    { name: 'sessions', dataType: 'INTEGER' },
    { name: 'sessions_with_cart_additions', dataType: 'INTEGER' },
    { name: 'sessions_that_reached_checkout', dataType: 'INTEGER' },
    { name: 'sessions_that_completed_checkout', dataType: 'INTEGER' },
  ]

  it('shopifyStorefrontFunnel derives the cart drop-off from Shopify\'s real row shape', async () => {
    // Rows come back keyed by column name with STRING values - verified live,
    // and the opposite of what this test originally asserted. Positional
    // indexing produced undefined for every column and failed silently.
    const api = mockApi({
      storefrontFunnel: vi.fn().mockResolvedValue({
        columns: FUNNEL_COLUMNS,
        rows: [{
          sessions: '1000',
          sessions_with_cart_additions: '180',
          sessions_that_reached_checkout: '60',
          sessions_that_completed_checkout: '42',
        }],
        shopifyql: 'FROM sessions SHOW ...',
      }),
    })
    const tool = createShopifyTools(api).find((t) => t.name === 'shopifyStorefrontFunnel')!
    const result = await tool.execute({ since: '-7d' }, {} as never)
    const data = result.data as Record<string, unknown>
    const rows = data.rows as Array<Record<string, unknown>>
    expect(rows[0].sessions).toBe('1000')
    // 180 added to cart, only 60 ever reached checkout.
    expect(rows[0].added_to_cart_but_never_reached_checkout).toBe(120)
    expect(rows[0].reached_checkout_but_never_completed).toBe(18)
    expect(data.no_human_sessions).toBeUndefined()
  })

  it('shopifyStorefrontFunnel still handles positional rows', async () => {
    // Defensive: the GraphQL field is opaque JSON, so the shape is not a
    // contract. Zipping against columns keeps an array form working.
    const api = mockApi({
      storefrontFunnel: vi.fn().mockResolvedValue({
        columns: FUNNEL_COLUMNS,
        rows: [[1000, 180, 60, 42]],
        shopifyql: 'FROM sessions SHOW ...',
      }),
    })
    const tool = createShopifyTools(api).find((t) => t.name === 'shopifyStorefrontFunnel')!
    const result = await tool.execute({}, {} as never)
    const rows = (result.data as Record<string, unknown>).rows as Array<Record<string, unknown>>
    expect(rows[0].sessions).toBe(1000)
    expect(rows[0].added_to_cart_but_never_reached_checkout).toBe(120)
  })

  it('shopifyStorefrontFunnel names an all-bot store rather than reporting a bare zero', async () => {
    // A store whose every visit was a bot returns zero sessions once the bot
    // filter applies - and Shopify drops the column list too when a filtered
    // group matches nothing, so the result looks broken unless it is named.
    const api = mockApi({
      storefrontFunnel: vi.fn().mockResolvedValue({
        columns: [{ name: 'sessions', dataType: 'INTEGER' }],
        rows: [{ sessions: '0' }],
        shopifyql: 'FROM sessions SHOW ...',
      }),
    })
    const tool = createShopifyTools(api).find((t) => t.name === 'shopifyStorefrontFunnel')!
    const result = await tool.execute({}, {} as never)
    expect(String((result.data as Record<string, unknown>).no_human_sessions)).toMatch(/not a failed query/i)
  })

  it('shopifyStorefrontFunnel states that cart abandoners cannot be contacted', async () => {
    const tool = createShopifyTools(mockApi()).find((t) => t.name === 'shopifyStorefrontFunnel')!
    const result = await tool.execute({}, {} as never)
    const note = String((result.data as Record<string, unknown>).note)
    expect(note).toMatch(/cannot be identified or contacted/i)
    // The description must steer the model off the wrong tool for "who abandoned?".
    expect(tool.description).toMatch(/shopifyListAbandonedCheckouts/)
  })

  it('shopifyAnalyticsQuery reports a rejected query as an error, never as empty data', async () => {
    const api = mockApi({
      runAnalyticsQuery: vi.fn().mockRejectedValue(
        new Error("ShopifyQL query was rejected: unknown field 'sesions'"),
      ),
    })
    const tool = createShopifyTools(api).find((t) => t.name === 'shopifyAnalyticsQuery')!
    const result = await tool.execute({ query: 'FROM sessions SHOW sesions' }, {} as never)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/rejected/i)
    // The specific failure must survive to the model so it can fix the query.
    expect(String(result.data)).toMatch(/sesions/)
  })

  /** Shopify's real rejection wording for an unknown column. */
  const columnNotFound = (col: string) =>
    new Error(`ShopifyQL query was rejected: Column Not Found: Column '${col}' not found`)

  it('shopifyAnalyticsQuery says WHERE a column lives when it belongs to another schema', async () => {
    // The exact 20-minute loop: `new_customers` is a real metric, but of
    // `sales`, not `customers`. Naming the right schema ends it in one step.
    const api = mockApi({ runAnalyticsQuery: vi.fn().mockRejectedValue(columnNotFound('new_customers')) })
    const tool = createShopifyTools(api).find((t) => t.name === 'shopifyAnalyticsQuery')!
    const result = await tool.execute(
      { query: 'FROM customers SHOW new_customers SINCE -6m UNTIL today' }, {} as never,
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('"sales"')
    expect(String(result.data)).toContain('new_customer_records')
  })

  it('shopifyAnalyticsQuery offers the nearest real names for an invented column', async () => {
    // `customer_type` exists in no schema at all - the model made it up.
    const api = mockApi({ runAnalyticsQuery: vi.fn().mockRejectedValue(columnNotFound('customer_type')) })
    const tool = createShopifyTools(api).find((t) => t.name === 'shopifyAnalyticsQuery')!
    const result = await tool.execute(
      { query: 'FROM customers SHOW total_amount_spent GROUP BY customer_type SINCE -6m UNTIL today' }, {} as never,
    )
    const data = String(result.data)
    expect(data).toMatch(/closest names/i)
    // The full metric list is short enough to state outright, and is what SHOW needs.
    expect(data).toContain('new_customer_records')
    expect(data).toMatch(/cannot be guessed/i)
  })

  it('shopifyAnalyticsQuery stops after repeated rejections instead of looping', async () => {
    // Each rejection reads as "almost right, try again", so nothing about a
    // single failure tells the model to stop. The cap is what does.
    const api = mockApi({ runAnalyticsQuery: vi.fn().mockRejectedValue(columnNotFound('nope')) })
    const tool = createShopifyTools(api).find((t) => t.name === 'shopifyAnalyticsQuery')!
    const q = { query: 'FROM customers SHOW nope SINCE -6m UNTIL today' }
    for (let i = 0; i < 3; i++) await tool.execute(q, {} as never)
    const result = await tool.execute(q, {} as never)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/stopping/i)
    expect(String(result.data)).toMatch(/do not try another spelling/i)
    // The cap must not spend another call on a query it has already refused.
    expect(api.runAnalyticsQuery).toHaveBeenCalledTimes(3)
  })

  it('shopifyAnalyticsQuery resets the rejection count after a success', async () => {
    const runAnalyticsQuery = vi.fn()
      .mockRejectedValueOnce(columnNotFound('nope'))
      .mockResolvedValueOnce({ columns: [{ name: 'sessions', dataType: 'INTEGER' }], rows: [{ sessions: '5' }] })
      .mockRejectedValue(columnNotFound('nope'))
    const tool = createShopifyTools(mockApi({ runAnalyticsQuery })).find((t) => t.name === 'shopifyAnalyticsQuery')!
    await tool.execute({ query: 'FROM sessions SHOW nope SINCE -7d UNTIL today' }, {} as never)
    await tool.execute({ query: 'FROM sessions SHOW sessions SINCE -7d UNTIL today' }, {} as never)
    // Two more failures must not trip a limit that a success already cleared.
    await tool.execute({ query: 'FROM sessions SHOW nope SINCE -7d UNTIL today' }, {} as never)
    const result = await tool.execute({ query: 'FROM sessions SHOW nope SINCE -7d UNTIL today' }, {} as never)
    expect(String(result.data)).not.toMatch(/stopping/i)
  })

  it('shopifyAnalyticsQuery refuses a non-existent schema without calling Shopify', async () => {
    // "orders" and "products" read like obvious schemas and are not - the tool
    // description used to claim both, which is how the model learned them.
    const api = mockApi()
    const tool = createShopifyTools(api).find((t) => t.name === 'shopifyAnalyticsQuery')!
    const result = await tool.execute({ query: 'FROM orders SHOW orders SINCE -30d UNTIL today' }, {} as never)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('"sales"')
    expect(api.runAnalyticsQuery).not.toHaveBeenCalled()
  })

  it('shopifyAnalyticsQuery advertises only schemas it can spell for', async () => {
    const tool = createShopifyTools(mockApi()).find((t) => t.name === 'shopifyAnalyticsQuery')!
    for (const schema of SHOPIFYQL_SCHEMAS) expect(tool.description).toContain(schema)
    // The two that never existed must not reappear as advertised schemas.
    expect(tool.description).toMatch(/no "orders" or "products" schema/i)
  })

  it('shopifyGetPayoutsSummary flags non-Shopify-Payments stores honestly', async () => {
    const api = mockApi({ getPayoutsSummary: vi.fn().mockResolvedValue(null) })
    const tool = createShopifyTools(api).find((t) => t.name === 'shopifyGetPayoutsSummary')!
    const result = await tool.execute({}, {} as never)
    expect(result.isError).toBe(true)
    expect(result.data).toMatch(/Shopify Payments/)
  })

  it('shopifyListOrders states the 60-day history window honestly', () => {
    const tool = createShopifyTools(mockApi()).find((t) => t.name === 'shopifyListOrders')!
    expect(tool.description).toMatch(/60 days/)
  })

  it('projects order connections to concise rows with cursor info', async () => {
    const api = mockApi({
      listOrders: vi.fn().mockResolvedValue({
        pageInfo: { hasNextPage: true, endCursor: 'cur123' },
        edges: [{
          node: {
            id: 'gid://shopify/Order/1001',
            name: '#1001',
            createdAt: '2026-07-01T00:00:00Z',
            displayFinancialStatus: 'PAID',
            displayFulfillmentStatus: 'UNFULFILLED',
            totalPriceSet: { shopMoney: { amount: '42.50', currencyCode: 'USD' } },
            customer: { displayName: 'Jane Doe', email: 'jane@example.com' },
            lineItems: { edges: [{ node: { title: 'Widget', quantity: 2 } }] },
            extraneous: 'dropped',
          },
        }],
      }),
    })
    const tool = createShopifyTools(api).find((t) => t.name === 'shopifyListOrders')!
    const result = await tool.execute({ first: 5 }, {} as never)
    const data = result.data as {
      items: Array<Record<string, unknown>>
      has_next_page: boolean
      end_cursor?: string
      returned: number
    }
    expect(data.returned).toBe(1)
    expect(data.has_next_page).toBe(true)
    expect(data.end_cursor).toBe('cur123')
    expect(data.items[0]).toMatchObject({
      id: 'gid://shopify/Order/1001',
      name: '#1001',
      financial_status: 'PAID',
      fulfillment_status: 'UNFULFILLED',
      total: '42.50 USD',
      customer: 'Jane Doe',
      items: ['2x Widget'],
    })
    expect(data.items[0]).not.toHaveProperty('extraneous')
  })

  it('passes list filters through to the api', async () => {
    const api = mockApi()
    const tool = createShopifyTools(api).find((t) => t.name === 'shopifyListOrders')!
    await tool.execute({ query: 'name:#1042', first: 3, cursor: 'c' }, {} as never)
    expect(api.listOrders).toHaveBeenCalledWith({ query: 'name:#1042', first: 3, cursor: 'c' })
  })

  it('shopifyGetInventoryLevels builds the variant query from productId/sku', async () => {
    const api = mockApi()
    const tool = createShopifyTools(api).find((t) => t.name === 'shopifyGetInventoryLevels')!
    await tool.execute({ productId: 'gid://shopify/Product/55', sku: 'SKU-1' }, {} as never)
    expect(api.getInventoryLevels).toHaveBeenCalledWith({ query: 'product_id:55 sku:SKU-1', first: 20 })
  })

  it('shopifyUpdateProduct maps description to descriptionHtml and only sends set fields', async () => {
    const api = mockApi()
    const tool = createShopifyTools(api).find((t) => t.name === 'shopifyUpdateProduct')!
    await tool.execute({ productId: '9', description: '<p>New</p>', status: 'ARCHIVED' }, {} as never)
    expect(api.updateProduct).toHaveBeenCalledWith({
      id: '9',
      title: undefined,
      descriptionHtml: '<p>New</p>',
      tags: undefined,
      status: 'ARCHIVED',
      seoTitle: undefined,
      seoDescription: undefined,
    })
  })

  it('returns isError when the api rejects, with the Shopify error prefix', async () => {
    const api = mockApi({ listOrders: vi.fn().mockRejectedValue(new Error('THROTTLED')) })
    const tool = createShopifyTools(api).find((t) => t.name === 'shopifyListOrders')!
    const result = await tool.execute({}, {} as never)
    expect(result.isError).toBe(true)
    expect(result.data).toBe('Shopify error: THROTTLED')
  })

  it('shopifyGetOrder flags a not-found order instead of returning an empty row', async () => {
    const api = mockApi({ getOrder: vi.fn().mockResolvedValue(null) })
    const tool = createShopifyTools(api).find((t) => t.name === 'shopifyGetOrder')!
    const result = await tool.execute({ orderId: '404' }, {} as never)
    expect(result.isError).toBe(true)
  })
  it('shopifyAddProductImage turns a not-found reference into the saveFileToBrain step', async () => {
    // The failure this replaces: a merchant's assistant was handed a chat
    // attachment id, got a bare "not found", read that as a wrong reference,
    // and retried with other references six times without ever promoting the
    // file. The remedy has to travel with the error.
    const addProductImage = vi.fn()
    const readFileBytes = vi.fn().mockResolvedValue({
      error: 'File f4e9383d-aa37-498b-92c2-3dc10b19ef77 not found in this workspace.',
      notFound: true,
    })
    const tool = createShopifyTools(mockApi({ addProductImage }), { readFileBytes }).find(
      (t) => t.name === 'shopifyAddProductImage',
    )!
    const result = await tool.execute(
      { productId: '2', file: 'f4e9383d-aa37-498b-92c2-3dc10b19ef77' },
      {} as never,
    )
    expect(result.isError).toBe(true)
    const msg = String(result.data)
    expect(msg).toContain('saveFileToBrain')
    // The id must be echoed, so the next call needs no guessing.
    expect(msg).toContain('f4e9383d-aa37-498b-92c2-3dc10b19ef77')
    expect(msg).toMatch(/do not retry this tool with the same id/i)
    expect(addProductImage).not.toHaveBeenCalled()
  })

  it('shopifyAddProductImage does not suggest saveFileToBrain for failures that are not a missing file', async () => {
    // A quota or permission error has nothing to do with promotion; pointing
    // at saveFileToBrain there would send the model down a dead end of its own.
    const addProductImage = vi.fn()
    const readFileBytes = vi.fn().mockResolvedValue({ error: 'Workspace storage quota exceeded.' })
    const tool = createShopifyTools(mockApi({ addProductImage }), { readFileBytes }).find(
      (t) => t.name === 'shopifyAddProductImage',
    )!
    const result = await tool.execute({ productId: '2', file: '/products/x.jpg' }, {} as never)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toBe('Workspace storage quota exceeded.')
    expect(String(result.data)).not.toContain('saveFileToBrain')
  })

})
