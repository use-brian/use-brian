import { describe, it, expect, vi } from 'vitest'
import { createShopifyTools, type ShopifyApi } from '../base/shopify.js'

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
    ...overrides,
  }
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
]
const WRITE_TOOLS = [
  'shopifyUpdateProduct',
  'shopifyCreateProduct',
  'shopifyCreateDraftOrder',
  'shopifySendDraftOrderInvoice',
  'shopifyAddTags',
  'shopifyUpdateCustomer',
  'shopifySetInventory',
  'shopifyCreateFulfillment',
  'shopifyCreateDiscountCode',
  'shopifyCreateContent',
]
const DESTRUCTIVE_TOOLS = ['shopifyCancelOrder', 'shopifyRefundOrder', 'shopifyCompleteDraftOrder']

describe('[COMP:tools/shopify] Shopify tools', () => {
  it('creates the full 29-tool catalog', () => {
    const tools = createShopifyTools(mockApi())
    expect(tools).toHaveLength(29)
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
})
