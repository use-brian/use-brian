import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  SHOPIFY_API_VERSION,
  normalizeShopDomain,
  toShopifyGid,
  packShopifyTokens,
  unpackShopifyTokens,
  isManagedShopifyTokens,
  exchangeShopifyAuthorizationCode,
  refreshShopifyTokens,
  createShopifyTokenManager,
  shopifyGraphql,
  listOrders,
  updateProduct,
  addTags,
  verifyShopifyWebhookHmac,
  verifyShopifyOAuthQueryHmac,
  buildShopifyAuthorizeUrl,
  type ShopifyTokens,
  type ShopifyAuth,
} from '../client.js'
import { createHmac } from 'node:crypto'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  }
}

beforeEach(() => {
  mockFetch.mockReset()
})

const SHOP = 'teststore.myshopify.com'
const AUTH: ShopifyAuth = { accessToken: 'shpat_static_token', shopDomain: SHOP }
const GRAPHQL_URL = `https://${SHOP}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`

describe('[COMP:api/shopify-client] Shopify GraphQL client', () => {
  // ── Shop domain normalization ────────────────────────────

  it('normalizeShopDomain canonicalizes bare handles, hosts, and URLs', () => {
    expect(normalizeShopDomain('teststore')).toBe(SHOP)
    expect(normalizeShopDomain('TestStore.MYSHOPIFY.com')).toBe(SHOP)
    expect(normalizeShopDomain('https://teststore.myshopify.com/admin')).toBe(SHOP)
    expect(normalizeShopDomain('  teststore.myshopify.com  ')).toBe(SHOP)
  })

  it('normalizeShopDomain rejects non-myshopify hosts and injection shapes', () => {
    expect(normalizeShopDomain('')).toBeNull()
    expect(normalizeShopDomain('mystore.com')).toBeNull()
    expect(normalizeShopDomain('admin.shopify.com')).toBeNull()
    expect(normalizeShopDomain('evil.com/#.myshopify.com')).toBeNull()
    expect(normalizeShopDomain('evil.com?x=.myshopify.com')).toBeNull()
    expect(normalizeShopDomain('sub.domain.myshopify.com')).toBeNull()
  })

  it('toShopifyGid coerces numeric ids and passes GIDs through', () => {
    expect(toShopifyGid('Order', '123')).toBe('gid://shopify/Order/123')
    expect(toShopifyGid('Order', 'gid://shopify/Order/123')).toBe('gid://shopify/Order/123')
  })

  // ── Credential tuple ─────────────────────────────────────

  it('pack/unpack roundtrips a managed tuple and a static tuple', () => {
    const managed: ShopifyTokens = {
      accessToken: 'at', refreshToken: 'rt', expiresAt: new Date().toISOString(), shopDomain: SHOP,
    }
    expect(unpackShopifyTokens(packShopifyTokens(managed))).toEqual(managed)
    expect(isManagedShopifyTokens(managed)).toBe(true)

    const staticTuple: ShopifyTokens = { accessToken: 'shpat_abc', shopDomain: SHOP }
    const unpacked = unpackShopifyTokens(packShopifyTokens(staticTuple))
    expect(unpacked).toEqual(staticTuple)
    expect(unpacked && isManagedShopifyTokens(unpacked)).toBe(false)
  })

  it('unpackShopifyTokens returns null on malformed payloads', () => {
    expect(unpackShopifyTokens('not json')).toBeNull()
    expect(unpackShopifyTokens('{}')).toBeNull()
    expect(unpackShopifyTokens('{"accessToken":"a"}')).toBeNull()  // no shopDomain
  })

  // ── OAuth token endpoint ─────────────────────────────────

  it('exchangeShopifyAuthorizationCode posts to the per-shop token endpoint', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'read_products',
    }))
    const tokens = await exchangeShopifyAuthorizationCode({
      shopDomain: SHOP, code: 'c0de', clientId: 'cid', clientSecret: 'csec',
    })
    expect(mockFetch).toHaveBeenCalledWith(
      `https://${SHOP}/admin/oauth/access_token`,
      expect.objectContaining({ method: 'POST' }),
    )
    const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body)
    expect(body).toEqual({ client_id: 'cid', client_secret: 'csec', code: 'c0de' })
    expect(tokens.refreshToken).toBe('rt')
    expect(tokens.shopDomain).toBe(SHOP)
    expect(Date.parse(tokens.expiresAt as string)).toBeGreaterThan(Date.now())
  })

  it('exchange maps a legacy non-expiring response to a static tuple', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ access_token: 'legacy_at', scope: 'read_products' }))
    const tokens = await exchangeShopifyAuthorizationCode({
      shopDomain: SHOP, code: 'c', clientId: 'cid', clientSecret: 'csec',
    })
    expect(tokens).toEqual({ accessToken: 'legacy_at', shopDomain: SHOP })
    expect(isManagedShopifyTokens(tokens)).toBe(false)
  })

  it('refreshShopifyTokens posts grant_type=refresh_token', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      access_token: 'new_at', refresh_token: 'new_rt', expires_in: 3600,
    }))
    const tokens = await refreshShopifyTokens({
      shopDomain: SHOP, refreshToken: 'old_rt', clientId: 'cid', clientSecret: 'csec',
    })
    const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body)
    expect(body.grant_type).toBe('refresh_token')
    expect(body.refresh_token).toBe('old_rt')
    expect(tokens.refreshToken).toBe('new_rt')
  })

  // ── Token manager (rotate-and-persist) ───────────────────

  it('manager passes a static shpat_ tuple through with no refresh and no config', async () => {
    const persist = vi.fn()
    const mgr = createShopifyTokenManager({
      getAppConfig: () => undefined,
      store: {
        async getTokens() { return { accessToken: 'shpat_x', shopDomain: SHOP } },
        persistTokens: persist,
      },
    })
    expect(await mgr.getAuth()).toEqual({ accessToken: 'shpat_x', shopDomain: SHOP })
    expect(persist).not.toHaveBeenCalled()
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('manager returns a still-valid managed token without refreshing', async () => {
    const future = new Date(Date.now() + 10 * 60_000).toISOString()
    const mgr = createShopifyTokenManager({
      getAppConfig: () => ({ clientId: 'cid', clientSecret: 'csec' }),
      store: {
        async getTokens() { return { accessToken: 'at', refreshToken: 'rt', expiresAt: future, shopDomain: SHOP } },
        async persistTokens() {},
      },
    })
    expect((await mgr.getAuth()).accessToken).toBe('at')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('manager refreshes an expired tuple and PERSISTS the rotation before returning', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    let stored: ShopifyTokens = { accessToken: 'old_at', refreshToken: 'old_rt', expiresAt: past, shopDomain: SHOP }
    const order: string[] = []
    mockFetch.mockImplementation(async () => {
      order.push('refresh-call')
      return jsonResponse({ access_token: 'rot_at', refresh_token: 'rot_rt', expires_in: 3600 })
    })

    const mgr = createShopifyTokenManager({
      getAppConfig: () => ({ clientId: 'cid', clientSecret: 'csec' }),
      store: {
        async getTokens() { return stored },
        async persistTokens(t) { order.push('persist'); stored = t },
      },
    })

    const auth = await mgr.getAuth()
    expect(auth.accessToken).toBe('rot_at')
    // Rotation invariant: the new tuple must be persisted BEFORE first use —
    // a lost persist bricks the connection (one-time-use refresh tokens).
    expect(order).toEqual(['refresh-call', 'persist'])
    expect(stored.refreshToken).toBe('rot_rt')
    expect(stored.shopDomain).toBe(SHOP)
  })

  it('manager with an expired managed tuple and NO app config throws a reconnect error', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const mgr = createShopifyTokenManager({
      getAppConfig: () => undefined,
      store: {
        async getTokens() { return { accessToken: 'at', refreshToken: 'rt', expiresAt: past, shopDomain: SHOP } },
        async persistTokens() {},
      },
    })
    await expect(mgr.getAuth()).rejects.toThrow(/token expired/i)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('manager throws when nothing is stored', async () => {
    const mgr = createShopifyTokenManager({
      getAppConfig: () => undefined,
      store: { async getTokens() { return null }, async persistTokens() {} },
    })
    await expect(mgr.getAuth()).rejects.toThrow(/Shopify not connected/)
  })

  // ── GraphQL transport ────────────────────────────────────

  it('shopifyGraphql posts the version-pinned endpoint with the access-token header', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: { shop: { name: 'Test' } } }))
    const data = await shopifyGraphql<{ shop: { name: string } }>(AUTH, 'query { shop { name } }')
    expect(mockFetch).toHaveBeenCalledWith(GRAPHQL_URL, expect.objectContaining({ method: 'POST' }))
    const init = mockFetch.mock.calls[0][1] as { headers: Record<string, string> }
    expect(init.headers['X-Shopify-Access-Token']).toBe(AUTH.accessToken)
    expect(data.shop.name).toBe('Test')
  })

  it('retries ONCE on THROTTLED with a backoff from throttleStatus, then succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({
        errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
        extensions: { cost: { requestedQueryCost: 100, throttleStatus: { currentlyAvailable: 90, restoreRate: 50 } } },
      }))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }))

    const started = Date.now()
    const data = await shopifyGraphql<{ ok: boolean }>(AUTH, 'query { x }')
    expect(data.ok).toBe(true)
    expect(mockFetch).toHaveBeenCalledTimes(2)
    // (100-90)/50 = 0.2s deficit, floored at 250ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(240)
  })

  it('surfaces a second consecutive THROTTLED as an error', async () => {
    const throttled = () => jsonResponse({
      errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }],
      extensions: { cost: { requestedQueryCost: 10, throttleStatus: { currentlyAvailable: 5, restoreRate: 50 } } },
    })
    mockFetch.mockResolvedValueOnce(throttled()).mockResolvedValueOnce(throttled())
    await expect(shopifyGraphql(AUTH, 'query { x }')).rejects.toThrow(/THROTTLED/)
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('maps 401 to the credential-dead phrasing the health probe keys on', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ errors: [{ message: 'unauthorized' }] }, 401))
    await expect(shopifyGraphql(AUTH, 'query { x }')).rejects.toThrow(/\(401\).*invalid or expired/)
  })

  it('surfaces GraphQL errors as thrown errors', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ errors: [{ message: "Field 'nope' doesn't exist" }] }))
    await expect(shopifyGraphql(AUTH, 'query { nope }')).rejects.toThrow(/Shopify API error/)
  })

  // ── Queries + mutations ──────────────────────────────────

  it('listOrders passes filters/cursor and returns the connection', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: { orders: { edges: [], pageInfo: { hasNextPage: false } } } }))
    await listOrders(AUTH, { query: 'financial_status:paid', first: 5, cursor: 'cur' })
    const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body)
    expect(body.variables).toEqual({ first: 5, after: 'cur', query: 'financial_status:paid' })
  })

  it('updateProduct throws on userErrors instead of returning silently', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: { productUpdate: { product: null, userErrors: [{ field: ['title'], message: 'is too long' }] } },
    }))
    await expect(updateProduct(AUTH, { id: '42', title: 'x' })).rejects.toThrow(/title: is too long/)
  })

  it('addTags maps the resource kind to the right GID', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: { tagsAdd: { node: { id: 'gid://shopify/Customer/7' }, userErrors: [] } },
    }))
    await addTags(AUTH, 'customer', '7', ['vip'])
    const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body)
    expect(body.variables.id).toBe('gid://shopify/Customer/7')
    expect(body.variables.tags).toEqual(['vip'])
  })

  // ── P4/P5 client surface ─────────────────────────────────

  it('createDiscountCode requires exactly one of percentage or amount and maps percentage to 0-1', async () => {
    const { createDiscountCode } = await import('../client.js')
    await expect(createDiscountCode(AUTH, { code: 'X' })).rejects.toThrow(/exactly one/)
    await expect(createDiscountCode(AUTH, { code: 'X', percentage: 20, amount: '5' })).rejects.toThrow(/exactly one/)

    mockFetch.mockResolvedValue(jsonResponse({
      data: { discountCodeBasicCreate: { codeDiscountNode: { id: 'gid://shopify/DiscountCodeNode/1' }, userErrors: [] } },
    }))
    await createDiscountCode(AUTH, { code: 'SUMMER20', percentage: 20, usageLimit: 50 })
    const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body)
    const input = body.variables.basicCodeDiscount
    expect(input.code).toBe('SUMMER20')
    expect(input.customerGets.value).toEqual({ percentage: 0.2 })
    expect(input.usageLimit).toBe(50)
    expect(input.customerSelection).toEqual({ all: true })
  })

  it('setInventoryQuantity resolves the location and demands one when ambiguous', async () => {
    const { setInventoryQuantity } = await import('../client.js')
    const twoLocations = {
      data: { productVariant: { inventoryItem: { id: 'gid://shopify/InventoryItem/9', inventoryLevels: { edges: [
        { node: { location: { id: 'gid://shopify/Location/1', name: 'HK' } } },
        { node: { location: { id: 'gid://shopify/Location/2', name: 'SG' } } },
      ] } } } },
    }
    mockFetch.mockResolvedValueOnce(jsonResponse(twoLocations))
    await expect(setInventoryQuantity(AUTH, { variantId: '5', quantity: 10 })).rejects.toThrow(/2 locations/)

    mockFetch
      .mockResolvedValueOnce(jsonResponse(twoLocations))
      .mockResolvedValueOnce(jsonResponse({ data: { inventorySetQuantities: { inventoryAdjustmentGroup: {}, userErrors: [] } } }))
    await setInventoryQuantity(AUTH, { variantId: '5', quantity: 10, locationId: '2' })
    const body = JSON.parse((mockFetch.mock.calls[2][1] as { body: string }).body)
    expect(body.variables.input.quantities).toEqual([
      { inventoryItemId: 'gid://shopify/InventoryItem/9', locationId: 'gid://shopify/Location/2', quantity: 10 },
    ])
    expect(body.variables.input.name).toBe('available')
  })

  it('refundOrder builds refundCreate from the suggestedRefund transactions', async () => {
    const { refundOrder } = await import('../client.js')
    mockFetch
      .mockResolvedValueOnce(jsonResponse({
        data: { order: { suggestedRefund: {
          amountSet: { shopMoney: { amount: '42.00', currencyCode: 'USD' } },
          suggestedTransactions: [{
            amountSet: { shopMoney: { amount: '42.00' } },
            gateway: 'shopify_payments',
            parentTransaction: { id: 'gid://shopify/OrderTransaction/7' },
          }],
          refundLineItems: [{ lineItem: { id: 'gid://shopify/LineItem/3' }, quantity: 2 }],
        } } },
      }))
      .mockResolvedValueOnce(jsonResponse({
        data: { refundCreate: { refund: { id: 'gid://shopify/Refund/1', totalRefundedSet: { shopMoney: { amount: '42.00', currencyCode: 'USD' } } }, userErrors: [] } },
      }))

    await refundOrder(AUTH, { orderId: '1042' })
    const body = JSON.parse((mockFetch.mock.calls[1][1] as { body: string }).body)
    expect(body.variables.input.transactions).toEqual([{
      orderId: 'gid://shopify/Order/1042',
      parentId: 'gid://shopify/OrderTransaction/7',
      amount: '42.00',
      gateway: 'shopify_payments',
      kind: 'REFUND',
    }])
    expect(body.variables.input.refundLineItems).toEqual([{ lineItemId: 'gid://shopify/LineItem/3', quantity: 2 }])
    expect(body.variables.input.shipping).toEqual({ fullRefund: true })
  })

  it('refundOrder refuses when nothing is refundable', async () => {
    const { refundOrder } = await import('../client.js')
    mockFetch.mockResolvedValueOnce(jsonResponse({
      data: { order: { suggestedRefund: { suggestedTransactions: [], refundLineItems: [] } } },
    }))
    await expect(refundOrder(AUTH, { orderId: '1' })).rejects.toThrow(/nothing refundable/i)
  })

  it('cancelOrder surfaces orderCancelUserErrors (the mutation-specific error key)', async () => {
    const { cancelOrder } = await import('../client.js')
    mockFetch.mockResolvedValue(jsonResponse({
      data: { orderCancel: { job: null, orderCancelUserErrors: [{ field: null, message: 'Order is already cancelled' }], userErrors: [] } },
    }))
    await expect(cancelOrder(AUTH, { orderId: '1' })).rejects.toThrow(/already cancelled/)
  })

  it('fetchOrdersRange paginates with the cursor and reports truncation', async () => {
    const { fetchOrdersRange } = await import('../client.js')
    const page = (n: number, hasNext: boolean) => jsonResponse({
      data: { orders: {
        pageInfo: { hasNextPage: hasNext, endCursor: `c${n}` },
        edges: Array.from({ length: 50 }, (_, i) => ({ node: { id: `o${n}-${i}` } })),
      } },
    })
    mockFetch.mockResolvedValueOnce(page(1, true)).mockResolvedValueOnce(page(2, true))
    const result = await fetchOrdersRange(AUTH, { query: 'created_at:>=2026-07-01', maxOrders: 100 })
    expect(result.orders).toHaveLength(100)
    expect(result.truncated).toBe(true)
    const secondBody = JSON.parse((mockFetch.mock.calls[1][1] as { body: string }).body)
    expect(secondBody.variables.after).toBe('c1')
  })

  it('createIngestWebhookSubscriptions treats already-taken as subscribed and isolates failures', async () => {
    const { createIngestWebhookSubscriptions } = await import('../client.js')
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ data: { webhookSubscriptionCreate: { webhookSubscription: { id: 'w1' }, userErrors: [] } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ message: 'Address for this topic has already been taken' }] } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ message: 'Invalid callback url' }] } } }))
    const results = await createIngestWebhookSubscriptions(AUTH, 'https://api.example.com/webhook/shopify', [
      'orders/create', 'orders/fulfilled', 'disputes/create',
    ])
    expect(results).toEqual([
      { topic: 'orders/create', ok: true },
      { topic: 'orders/fulfilled', ok: true },
      { topic: 'disputes/create', ok: false, error: 'Invalid callback url' },
    ])
  })

  // ── Webhook + OAuth HMAC ─────────────────────────────────

  it('verifyShopifyWebhookHmac accepts a valid base64 signature and rejects everything else', () => {
    const secret = 'shh'
    const body = JSON.stringify({ shop_domain: SHOP })
    const good = createHmac('sha256', secret).update(body).digest('base64')

    expect(verifyShopifyWebhookHmac(body, good, secret)).toBe(true)
    expect(verifyShopifyWebhookHmac(Buffer.from(body, 'utf8'), good, secret)).toBe(true)
    expect(verifyShopifyWebhookHmac(body + ' ', good, secret)).toBe(false)   // tampered body
    expect(verifyShopifyWebhookHmac(body, good, 'wrong')).toBe(false)        // wrong secret
    expect(verifyShopifyWebhookHmac(body, undefined, secret)).toBe(false)    // missing header
    expect(verifyShopifyWebhookHmac(body, good, undefined)).toBe(false)      // unset secret (inert mode)
  })

  it('verifyShopifyOAuthQueryHmac verifies the sorted query string minus hmac', () => {
    const secret = 'csec'
    const params: Record<string, string> = {
      code: 'c0de', shop: SHOP, state: 'shopify:ws:nonce', timestamp: '1700000000',
    }
    const message = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&')
    const good = createHmac('sha256', secret).update(message).digest('hex')

    expect(verifyShopifyOAuthQueryHmac({ ...params, hmac: good }, secret)).toBe(true)
    expect(verifyShopifyOAuthQueryHmac({ ...params, hmac: good, code: 'evil' }, secret)).toBe(false)
    expect(verifyShopifyOAuthQueryHmac({ ...params, hmac: 'deadbeef' }, secret)).toBe(false)
    expect(verifyShopifyOAuthQueryHmac({ ...params }, secret)).toBe(false)
    expect(verifyShopifyOAuthQueryHmac({ ...params, hmac: good }, undefined)).toBe(false)
  })

  it('buildShopifyAuthorizeUrl targets the per-shop authorize endpoint with comma scopes', () => {
    const url = buildShopifyAuthorizeUrl({
      shopDomain: SHOP,
      clientId: 'cid',
      redirectUri: 'https://app.example.com/api/auth/callback/shopify',
      scopes: ['read_products', 'read_orders'],
      state: 'st',
    })
    const parsed = new URL(url)
    expect(parsed.origin).toBe(`https://${SHOP}`)
    expect(parsed.pathname).toBe('/admin/oauth/authorize')
    expect(parsed.searchParams.get('scope')).toBe('read_products,read_orders')
    expect(parsed.searchParams.get('client_id')).toBe('cid')
  })

  // ── End-to-end (mocked GraphQL): the "last 5 orders" path ──
  // Tool factory → real client → mocked endpoint. The live twin runs in
  // client.integration.test.ts against a dev store when SHOPIFY_TEST_* is set.

  // The cold @use-brian/core barrel import can exceed the 5s default under
  // full-suite fan-out load, so this row gets an explicit timeout.
  it('answers "last 5 orders" through the tool + client against a mocked GraphQL endpoint', { timeout: 20_000 }, async () => {
    const { createShopifyTools } = await import('@use-brian/core')
    mockFetch.mockResolvedValue(jsonResponse({
      data: {
        orders: {
          pageInfo: { hasNextPage: false, endCursor: null },
          edges: [{
            node: {
              id: 'gid://shopify/Order/1042',
              name: '#1042',
              createdAt: '2026-07-20T10:00:00Z',
              displayFinancialStatus: 'PAID',
              displayFulfillmentStatus: 'FULFILLED',
              totalPriceSet: { shopMoney: { amount: '99.00', currencyCode: 'USD' } },
              customer: { id: 'gid://shopify/Customer/7', displayName: 'Jane Doe', email: 'jane@example.com' },
              lineItems: { edges: [{ node: { title: 'Widget', quantity: 1 } }] },
            },
          }],
        },
      },
    }))

    const nullApi = async () => null
    const tools = createShopifyTools({
      getShop: nullApi,
      listProducts: nullApi,
      getProduct: nullApi,
      listOrders: async (params) => listOrders(AUTH, params),
      getOrder: nullApi,
      searchCustomers: nullApi,
      getCustomer: nullApi,
      getInventoryLevels: nullApi,
      listCollections: nullApi,
      listDraftOrders: nullApi,
      listDiscounts: nullApi,
      listAbandonedCheckouts: nullApi,
      getPayoutsSummary: nullApi,
      listDisputes: nullApi,
      listContent: nullApi,
      fetchOrdersRange: async () => ({ orders: [], truncated: false }),
      updateProduct: nullApi,
      createProduct: nullApi,
      createDraftOrder: nullApi,
      sendDraftOrderInvoice: nullApi,
      addTags: nullApi,
      updateCustomer: nullApi,
      setInventoryQuantity: nullApi,
      createFulfillment: nullApi,
      createDiscountCode: nullApi,
      createContent: nullApi,
      cancelOrder: nullApi,
      refundOrder: nullApi,
      completeDraftOrder: nullApi,
    })
    const listOrdersTool = tools.find((t) => t.name === 'shopifyListOrders')!
    const result = await listOrdersTool.execute({ first: 5 }, {} as never)

    expect(result.isError).toBeFalsy()
    const data = result.data as { items: Array<{ name?: string; total?: string }>; returned: number }
    expect(data.returned).toBe(1)
    expect(data.items[0].name).toBe('#1042')
    expect(data.items[0].total).toBe('99.00 USD')
    expect(mockFetch).toHaveBeenCalledWith(GRAPHQL_URL, expect.objectContaining({ method: 'POST' }))
    const sent = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body)
    expect(sent.variables.first).toBe(5)
  })
})
