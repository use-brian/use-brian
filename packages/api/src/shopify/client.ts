/**
 * Shopify Admin GraphQL client — thin fetch wrappers + token management +
 * webhook/OAuth HMAC verification.
 *
 * Rules (docs/architecture/integrations/shopify.md → "GraphQL client rules"):
 * GraphQL only (REST is legacy), version-pinned to SHOPIFY_API_VERSION (roll
 * quarterly), single THROTTLED retry paced by `extensions.cost.throttleStatus`,
 * cursor pagination, no SDK, no ShopifyQL.
 *
 * Auth: one credential tuple per shop in the connector_instance envelope.
 * Pasted `shpat_` tokens are static (no refreshToken/expiresAt). OAuth-minted
 * tokens are expiring (~1h) with a 90-day ROTATING refresh token — the
 * manager MUST persist the new tuple before using it (Fathom hazard: a lost
 * persist bricks the connection).
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export const SHOPIFY_API_VERSION = '2026-04'

const REFRESH_LEEWAY_MS = 60_000  // Refresh if the access token expires within 60s
const THROTTLE_BACKOFF_CAP_MS = 10_000

// ── Shop domain ──────────────────────────────────────────────

/**
 * Normalize user input ("mystore", "mystore.myshopify.com", a pasted admin
 * URL) to the canonical `{shop}.myshopify.com` host, or null when it cannot
 * be one. Custom storefront domains are rejected on purpose — OAuth and the
 * Admin API are addressed by the myshopify.com domain only.
 */
export function normalizeShopDomain(input: string): string | null {
  let s = input.trim().toLowerCase()
  if (!s) return null
  s = s.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '')
  // "admin.shopify.com/store/<handle>" URLs lose their path above; a bare
  // "admin.shopify.com" host is not a shop.
  if (s === 'admin.shopify.com') return null
  if (!s.includes('.')) s = `${s}.myshopify.com`
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s)) return null
  return s
}

/** Coerce a bare numeric id (or an existing gid) to a Shopify GID. */
export function toShopifyGid(kind: string, id: string): string {
  const trimmed = id.trim()
  if (trimmed.startsWith('gid://')) return trimmed
  if (/^\d+$/.test(trimmed)) return `gid://shopify/${kind}/${trimmed}`
  return trimmed
}

// ── Credential tuple ─────────────────────────────────────────

/**
 * The JSON tuple stored (encrypted) in `connector_instance.credentials.client_secret`.
 * Static pasted tokens carry no refreshToken/expiresAt; the shape IS the
 * discriminator (`client_id` is provenance only).
 */
export type ShopifyTokens = {
  accessToken: string
  refreshToken?: string
  expiresAt?: string  // ISO timestamp
  shopDomain: string
}

/** What every API call needs. */
export type ShopifyAuth = {
  accessToken: string
  shopDomain: string
}

export function packShopifyTokens(tokens: ShopifyTokens): string {
  return JSON.stringify({
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
    shopDomain: tokens.shopDomain,
  })
}

export function unpackShopifyTokens(blob: string): ShopifyTokens | null {
  try {
    const parsed = JSON.parse(blob) as Partial<ShopifyTokens>
    if (typeof parsed.accessToken !== 'string' || typeof parsed.shopDomain !== 'string') return null
    const managed = typeof parsed.refreshToken === 'string' && typeof parsed.expiresAt === 'string'
    return {
      accessToken: parsed.accessToken,
      shopDomain: parsed.shopDomain,
      ...(managed ? { refreshToken: parsed.refreshToken, expiresAt: parsed.expiresAt } : {}),
    }
  } catch {
    return null  // malformed payload = "no tokens"
  }
}

/** True when the tuple is an expiring OAuth token (vs a static pasted one). */
export function isManagedShopifyTokens(tokens: ShopifyTokens): boolean {
  return typeof tokens.refreshToken === 'string' && typeof tokens.expiresAt === 'string'
}

// ── OAuth token endpoint ─────────────────────────────────────

type ShopifyAccessTokenResponse = {
  access_token: string
  scope?: string
  expires_in?: number         // seconds; present for expiring offline tokens
  refresh_token?: string      // present for expiring offline tokens
}

function tokensFromResponse(shopDomain: string, data: ShopifyAccessTokenResponse): ShopifyTokens {
  if (!data.access_token) {
    throw new Error('Shopify token endpoint returned an incomplete payload')
  }
  if (data.refresh_token && typeof data.expires_in === 'number') {
    const expiresInMs = Math.max(0, data.expires_in * 1000)
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
      shopDomain,
    }
  }
  // Legacy non-expiring offline token — store as static.
  return { accessToken: data.access_token, shopDomain }
}

async function tokenEndpointCall(shopDomain: string, body: Record<string, string>): Promise<ShopifyTokens> {
  const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Shopify token endpoint failed (${res.status}): ${err.slice(0, 300)}`)
  }
  return tokensFromResponse(shopDomain, (await res.json()) as ShopifyAccessTokenResponse)
}

export async function exchangeShopifyAuthorizationCode(params: {
  shopDomain: string
  code: string
  clientId: string
  clientSecret: string
}): Promise<ShopifyTokens> {
  return tokenEndpointCall(params.shopDomain, {
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
  })
}

export async function refreshShopifyTokens(params: {
  shopDomain: string
  refreshToken: string
  clientId: string
  clientSecret: string
}): Promise<ShopifyTokens> {
  return tokenEndpointCall(params.shopDomain, {
    client_id: params.clientId,
    client_secret: params.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
  })
}

// ── Token manager (rotate-and-persist) ───────────────────────

export type ShopifyTokenStore = {
  getTokens(): Promise<ShopifyTokens | null>
  persistTokens(tokens: ShopifyTokens): Promise<void>
}

export type ShopifyTokenManager = {
  /** Get a usable access token + shop domain, refreshing (and persisting) if needed. */
  getAuth(): Promise<ShopifyAuth>
}

export function createShopifyTokenManager(params: {
  store: ShopifyTokenStore
  /**
   * Lazily resolves the Shopify app credentials (getConnectorConfig('shopify')).
   * Only consulted when a managed tuple needs a refresh — static pasted
   * tokens work with no app registration at all.
   */
  getAppConfig: () => { clientId: string; clientSecret: string } | undefined
}): ShopifyTokenManager {
  return {
    async getAuth(): Promise<ShopifyAuth> {
      const current = await params.store.getTokens()
      if (!current) throw new Error('Shopify not connected')

      if (!isManagedShopifyTokens(current)) {
        return { accessToken: current.accessToken, shopDomain: current.shopDomain }
      }

      const expiresAtMs = Date.parse(current.expiresAt as string)
      const stillValid = Number.isFinite(expiresAtMs) && expiresAtMs - Date.now() > REFRESH_LEEWAY_MS
      if (stillValid) {
        return { accessToken: current.accessToken, shopDomain: current.shopDomain }
      }

      const cfg = params.getAppConfig()
      if (!cfg) {
        // Managed tuple but the server has no app credentials (env unset).
        // Inside the leeway window the current token may still work — use it
        // rather than failing a call that would have succeeded.
        if (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()) {
          return { accessToken: current.accessToken, shopDomain: current.shopDomain }
        }
        throw new Error(
          'Shopify access token expired and SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET are not configured to refresh it. Reconnect Shopify in Studio → Connectors.',
        )
      }

      const next = await refreshShopifyTokens({
        shopDomain: current.shopDomain,
        refreshToken: current.refreshToken as string,
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
      })
      // Rotation invariant: persist BEFORE first use. If this write fails the
      // old refresh token is already burned and the user must reconnect —
      // failing loudly here beats silently continuing with a tuple we cannot
      // recover next call.
      await params.store.persistTokens(next)
      return { accessToken: next.accessToken, shopDomain: next.shopDomain }
    },
  }
}

// ── GraphQL transport ────────────────────────────────────────

type GraphqlErrorEntry = { message?: string; extensions?: { code?: string } }
type GraphqlResponse = {
  data?: unknown
  errors?: GraphqlErrorEntry[]
  extensions?: {
    cost?: {
      requestedQueryCost?: number
      throttleStatus?: { maximumAvailable?: number; currentlyAvailable?: number; restoreRate?: number }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait suggested by a THROTTLED response: the point deficit divided by the
 * restore rate, capped. Falls back to 1s when the cost extension is absent.
 */
function throttleBackoffMs(payload: GraphqlResponse): number {
  const cost = payload.extensions?.cost
  const requested = cost?.requestedQueryCost
  const available = cost?.throttleStatus?.currentlyAvailable
  const restoreRate = cost?.throttleStatus?.restoreRate
  if (
    typeof requested === 'number' && typeof available === 'number' &&
    typeof restoreRate === 'number' && restoreRate > 0
  ) {
    const ms = Math.ceil(Math.max(0, requested - available) / restoreRate * 1000)
    return Math.min(Math.max(ms, 250), THROTTLE_BACKOFF_CAP_MS)
  }
  return 1_000
}

function isThrottled(payload: GraphqlResponse): boolean {
  return (payload.errors ?? []).some((e) => e.extensions?.code === 'THROTTLED')
}

/**
 * Execute one GraphQL operation against the shop's Admin API. Retries ONCE on
 * THROTTLED (self-paced from `throttleStatus`); surfaces auth failures with
 * the `(401)` / "invalid or expired" phrasing the connector-health probe keys
 * on. Returns the `data` payload.
 */
export async function shopifyGraphql<T = unknown>(
  auth: ShopifyAuth,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  let attempt = 0
  for (;;) {
    attempt += 1
    const res = await fetch(`https://${auth.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Shopify-Access-Token': auth.accessToken,
      },
      body: JSON.stringify({ query, variables: variables ?? {} }),
    })

    if (res.status === 401 || res.status === 403) {
      const err = await res.text()
      console.warn(`[shopify] ${auth.shopDomain} → ${res.status}: ${err.slice(0, 200)}`)
      throw new Error(
        `Shopify auth error (${res.status}): the access token is invalid or expired. Reconnect Shopify in Studio → Connectors.`,
      )
    }
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Shopify API error (${res.status}): ${err.slice(0, 300)}`)
    }

    const payload = (await res.json()) as GraphqlResponse

    if (isThrottled(payload)) {
      if (attempt >= 2) {
        throw new Error('Shopify API error: THROTTLED (query-cost budget exhausted; retry later)')
      }
      await sleep(throttleBackoffMs(payload))
      continue
    }

    if (payload.errors?.length) {
      const messages = payload.errors.map((e) => e.message ?? 'unknown error').join('; ')
      throw new Error(`Shopify API error: ${messages.slice(0, 300)}`)
    }

    return (payload.data ?? {}) as T
  }
}

/**
 * Throw when a mutation payload carries `userErrors` — a failed write must be
 * loud, never silently partial.
 */
function expectNoUserErrors(data: unknown, mutationKey: string): void {
  const payload = (data as Record<string, unknown> | undefined)?.[mutationKey] as
    | { userErrors?: Array<{ field?: string[] | null; message?: string }> }
    | undefined
  const userErrors = payload?.userErrors ?? []
  if (userErrors.length > 0) {
    const detail = userErrors
      .map((e) => `${(e.field ?? []).join('.') || 'input'}: ${e.message ?? 'invalid'}`)
      .join('; ')
    throw new Error(`Shopify API error: ${detail.slice(0, 300)}`)
  }
}

// ── Queries (v1 read slice) ──────────────────────────────────

export async function getShop(auth: ShopifyAuth): Promise<unknown> {
  const data = await shopifyGraphql<{ shop?: unknown }>(auth, `
    query ShopInfo {
      shop {
        name
        myshopifyDomain
        primaryDomain { host }
        currencyCode
        ianaTimezone
        plan { displayName }
      }
    }
  `)
  return data.shop
}

export type ShopifyListParams = { query?: string; first?: number; cursor?: string }

export async function listProducts(auth: ShopifyAuth, params: ShopifyListParams = {}): Promise<unknown> {
  const data = await shopifyGraphql<{ products?: unknown }>(auth, `
    query ListProducts($first: Int!, $after: String, $query: String) {
      products(first: $first, after: $after, query: $query) {
        pageInfo { hasNextPage endCursor }
        edges { node {
          id title handle status vendor productType tags totalInventory updatedAt
          priceRangeV2 {
            minVariantPrice { amount currencyCode }
            maxVariantPrice { amount currencyCode }
          }
        } }
      }
    }
  `, { first: params.first ?? 10, after: params.cursor ?? null, query: params.query ?? null })
  return data.products
}

export async function getProduct(auth: ShopifyAuth, productId: string): Promise<unknown> {
  const data = await shopifyGraphql<{ product?: unknown }>(auth, `
    query GetProduct($id: ID!) {
      product(id: $id) {
        id title handle status vendor productType tags totalInventory
        description
        onlineStoreUrl
        seo { title description }
        createdAt updatedAt
        variants(first: 50) {
          edges { node { id title sku price inventoryQuantity availableForSale } }
        }
      }
    }
  `, { id: toShopifyGid('Product', productId) })
  return data.product
}

export async function listOrders(auth: ShopifyAuth, params: ShopifyListParams = {}): Promise<unknown> {
  const data = await shopifyGraphql<{ orders?: unknown }>(auth, `
    query ListOrders($first: Int!, $after: String, $query: String) {
      orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
        pageInfo { hasNextPage endCursor }
        edges { node {
          id name createdAt
          displayFinancialStatus displayFulfillmentStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          customer { id displayName email }
          lineItems(first: 5) { edges { node { title quantity } } }
        } }
      }
    }
  `, { first: params.first ?? 10, after: params.cursor ?? null, query: params.query ?? null })
  return data.orders
}

export async function getOrder(auth: ShopifyAuth, orderId: string): Promise<unknown> {
  const data = await shopifyGraphql<{ order?: unknown }>(auth, `
    query GetOrder($id: ID!) {
      order(id: $id) {
        id name createdAt closedAt cancelledAt
        displayFinancialStatus displayFulfillmentStatus
        email phone note tags
        subtotalPriceSet { shopMoney { amount currencyCode } }
        totalShippingPriceSet { shopMoney { amount currencyCode } }
        totalTaxSet { shopMoney { amount currencyCode } }
        totalPriceSet { shopMoney { amount currencyCode } }
        customer { id displayName email numberOfOrders }
        shippingAddress { name city provinceCode countryCodeV2 }
        lineItems(first: 50) {
          edges { node { title quantity sku discountedUnitPriceSet { shopMoney { amount currencyCode } } } }
        }
        fulfillments { status createdAt trackingInfo { number url company } }
        risk { recommendation }
      }
    }
  `, { id: toShopifyGid('Order', orderId) })
  return data.order
}

export async function searchCustomers(auth: ShopifyAuth, params: ShopifyListParams = {}): Promise<unknown> {
  const data = await shopifyGraphql<{ customers?: unknown }>(auth, `
    query SearchCustomers($first: Int!, $after: String, $query: String) {
      customers(first: $first, after: $after, query: $query) {
        pageInfo { hasNextPage endCursor }
        edges { node {
          id displayName email phone
          numberOfOrders
          amountSpent { amount currencyCode }
          tags createdAt
        } }
      }
    }
  `, { first: params.first ?? 10, after: params.cursor ?? null, query: params.query ?? null })
  return data.customers
}

export async function getCustomer(auth: ShopifyAuth, customerId: string): Promise<unknown> {
  const data = await shopifyGraphql<{ customer?: unknown }>(auth, `
    query GetCustomer($id: ID!) {
      customer(id: $id) {
        id displayName firstName lastName email phone note verifiedEmail
        numberOfOrders
        amountSpent { amount currencyCode }
        tags createdAt updatedAt
        defaultAddress { city provinceCode countryCodeV2 }
        lastOrder { id name createdAt }
      }
    }
  `, { id: toShopifyGid('Customer', customerId) })
  return data.customer
}

/**
 * Inventory by variant search (`product_id:` / `sku:` query syntax), with
 * per-location available quantities.
 */
export async function getInventoryLevels(auth: ShopifyAuth, params: ShopifyListParams = {}): Promise<unknown> {
  const data = await shopifyGraphql<{ productVariants?: unknown }>(auth, `
    query InventoryLevels($first: Int!, $query: String) {
      productVariants(first: $first, query: $query) {
        pageInfo { hasNextPage endCursor }
        edges { node {
          id title sku inventoryQuantity
          product { id title }
          inventoryItem {
            inventoryLevels(first: 10) {
              edges { node {
                location { name }
                quantities(names: ["available"]) { name quantity }
              } }
            }
          }
        } }
      }
    }
  `, { first: params.first ?? 20, query: params.query ?? null })
  return data.productVariants
}

// ── Mutations (v1 write slice) ───────────────────────────────

export type ShopifyProductUpdateParams = {
  id: string
  title?: string
  descriptionHtml?: string
  tags?: string[]
  status?: 'ACTIVE' | 'ARCHIVED' | 'DRAFT'
  seoTitle?: string
  seoDescription?: string
}

export async function updateProduct(auth: ShopifyAuth, params: ShopifyProductUpdateParams): Promise<unknown> {
  const product: Record<string, unknown> = { id: toShopifyGid('Product', params.id) }
  if (params.title !== undefined) product.title = params.title
  if (params.descriptionHtml !== undefined) product.descriptionHtml = params.descriptionHtml
  if (params.tags !== undefined) product.tags = params.tags
  if (params.status !== undefined) product.status = params.status
  if (params.seoTitle !== undefined || params.seoDescription !== undefined) {
    product.seo = {
      ...(params.seoTitle !== undefined ? { title: params.seoTitle } : {}),
      ...(params.seoDescription !== undefined ? { description: params.seoDescription } : {}),
    }
  }
  const data = await shopifyGraphql(auth, `
    mutation UpdateProduct($product: ProductUpdateInput!) {
      productUpdate(product: $product) {
        product { id title status tags updatedAt }
        userErrors { field message }
      }
    }
  `, { product })
  expectNoUserErrors(data, 'productUpdate')
  return (data as Record<string, unknown>).productUpdate
}

export type ShopifyDraftOrderLineItem = {
  variantId?: string
  quantity: number
  title?: string
  originalUnitPrice?: string
}

export type ShopifyDraftOrderParams = {
  lineItems: ShopifyDraftOrderLineItem[]
  customerId?: string
  email?: string
  note?: string
  tags?: string[]
}

export async function createDraftOrder(auth: ShopifyAuth, params: ShopifyDraftOrderParams): Promise<unknown> {
  const input: Record<string, unknown> = {
    lineItems: params.lineItems.map((li) => ({
      quantity: li.quantity,
      ...(li.variantId ? { variantId: toShopifyGid('ProductVariant', li.variantId) } : {}),
      ...(li.title ? { title: li.title } : {}),
      ...(li.originalUnitPrice ? { originalUnitPrice: li.originalUnitPrice } : {}),
    })),
  }
  if (params.customerId) {
    input.purchasingEntity = { customerId: toShopifyGid('Customer', params.customerId) }
  }
  if (params.email) input.email = params.email
  if (params.note) input.note = params.note
  if (params.tags) input.tags = params.tags
  const data = await shopifyGraphql(auth, `
    mutation CreateDraftOrder($input: DraftOrderInput!) {
      draftOrderCreate(input: $input) {
        draftOrder {
          id name status invoiceUrl
          totalPriceSet { shopMoney { amount currencyCode } }
        }
        userErrors { field message }
      }
    }
  `, { input })
  expectNoUserErrors(data, 'draftOrderCreate')
  return (data as Record<string, unknown>).draftOrderCreate
}

export type ShopifyTaggableResource = 'order' | 'customer' | 'product'

const TAGGABLE_GID_KIND: Record<ShopifyTaggableResource, string> = {
  order: 'Order',
  customer: 'Customer',
  product: 'Product',
}

export async function addTags(
  auth: ShopifyAuth,
  resource: ShopifyTaggableResource,
  resourceId: string,
  tags: string[],
): Promise<unknown> {
  const data = await shopifyGraphql(auth, `
    mutation AddTags($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        node { id }
        userErrors { field message }
      }
    }
  `, { id: toShopifyGid(TAGGABLE_GID_KIND[resource], resourceId), tags })
  expectNoUserErrors(data, 'tagsAdd')
  return (data as Record<string, unknown>).tagsAdd
}

// ── Queries (P4 catalog) ─────────────────────────────────────

export async function listCollections(auth: ShopifyAuth, params: ShopifyListParams = {}): Promise<unknown> {
  const data = await shopifyGraphql<{ collections?: unknown }>(auth, `
    query ListCollections($first: Int!, $after: String, $query: String) {
      collections(first: $first, after: $after, query: $query) {
        pageInfo { hasNextPage endCursor }
        edges { node { id title handle updatedAt productsCount { count } } }
      }
    }
  `, { first: params.first ?? 10, after: params.cursor ?? null, query: params.query ?? null })
  return data.collections
}

export async function listDraftOrders(auth: ShopifyAuth, params: ShopifyListParams = {}): Promise<unknown> {
  const data = await shopifyGraphql<{ draftOrders?: unknown }>(auth, `
    query ListDraftOrders($first: Int!, $after: String, $query: String) {
      draftOrders(first: $first, after: $after, query: $query) {
        pageInfo { hasNextPage endCursor }
        edges { node {
          id name status invoiceUrl createdAt updatedAt
          totalPriceSet { shopMoney { amount currencyCode } }
          customer { displayName email }
        } }
      }
    }
  `, { first: params.first ?? 10, after: params.cursor ?? null, query: params.query ?? null })
  return data.draftOrders
}

export async function listDiscounts(auth: ShopifyAuth, params: ShopifyListParams = {}): Promise<unknown> {
  const data = await shopifyGraphql<{ discountNodes?: unknown }>(auth, `
    query ListDiscounts($first: Int!, $after: String, $query: String) {
      discountNodes(first: $first, after: $after, query: $query) {
        pageInfo { hasNextPage endCursor }
        edges { node {
          id
          discount {
            __typename
            ... on DiscountCodeBasic {
              title status summary asyncUsageCount usageLimit startsAt endsAt
              codes(first: 5) { edges { node { code } } }
            }
            ... on DiscountCodeFreeShipping {
              title status summary asyncUsageCount startsAt endsAt
              codes(first: 5) { edges { node { code } } }
            }
            ... on DiscountCodeBxgy {
              title status summary asyncUsageCount startsAt endsAt
              codes(first: 5) { edges { node { code } } }
            }
            ... on DiscountAutomaticBasic { title status startsAt endsAt }
            ... on DiscountAutomaticFreeShipping { title status startsAt endsAt }
            ... on DiscountAutomaticBxgy { title status startsAt endsAt }
          }
        } }
      }
    }
  `, { first: params.first ?? 10, after: params.cursor ?? null, query: params.query ?? null })
  return data.discountNodes
}

export async function listAbandonedCheckouts(auth: ShopifyAuth, params: ShopifyListParams = {}): Promise<unknown> {
  const data = await shopifyGraphql<{ abandonedCheckouts?: unknown }>(auth, `
    query ListAbandonedCheckouts($first: Int!, $after: String, $query: String) {
      abandonedCheckouts(first: $first, after: $after, query: $query) {
        pageInfo { hasNextPage endCursor }
        edges { node {
          id createdAt abandonedCheckoutUrl
          totalPriceSet { shopMoney { amount currencyCode } }
          lineItems(first: 5) { edges { node { title quantity } } }
          customer { displayName email }
        } }
      }
    }
  `, { first: params.first ?? 10, after: params.cursor ?? null, query: params.query ?? null })
  return data.abandonedCheckouts
}

/** Shopify Payments balance + recent payouts. Null when the shop doesn't use Shopify Payments. */
export async function getPayoutsSummary(auth: ShopifyAuth, params: { first?: number } = {}): Promise<unknown> {
  const data = await shopifyGraphql<{ shopifyPaymentsAccount?: unknown }>(auth, `
    query PayoutsSummary($first: Int!) {
      shopifyPaymentsAccount {
        balance { amount currencyCode }
        payoutSchedule { interval }
        payouts(first: $first) {
          edges { node { id issuedAt status net { amount currencyCode } } }
        }
      }
    }
  `, { first: params.first ?? 10 })
  return data.shopifyPaymentsAccount
}

/** Shopify Payments disputes/chargebacks. Null account when not on Shopify Payments. */
export async function listDisputes(auth: ShopifyAuth, params: { first?: number } = {}): Promise<unknown> {
  const data = await shopifyGraphql<{ shopifyPaymentsAccount?: unknown }>(auth, `
    query ListDisputes($first: Int!) {
      shopifyPaymentsAccount {
        disputes(first: $first) {
          edges { node {
            id status type evidenceDueBy
            amount { amount currencyCode }
            reasonDetails { reason }
            order { id name }
          } }
        }
      }
    }
  `, { first: params.first ?? 10 })
  return data.shopifyPaymentsAccount
}

export type ShopifyContentKind = 'pages' | 'articles' | 'blogs'

export async function listContent(
  auth: ShopifyAuth,
  params: { kind: ShopifyContentKind; query?: string; first?: number; cursor?: string },
): Promise<unknown> {
  const first = params.first ?? 10
  const after = params.cursor ?? null
  if (params.kind === 'pages') {
    const data = await shopifyGraphql<{ pages?: unknown }>(auth, `
      query ListPages($first: Int!, $after: String, $query: String) {
        pages(first: $first, after: $after, query: $query) {
          pageInfo { hasNextPage endCursor }
          edges { node { id title handle updatedAt } }
        }
      }
    `, { first, after, query: params.query ?? null })
    return data.pages
  }
  if (params.kind === 'articles') {
    const data = await shopifyGraphql<{ articles?: unknown }>(auth, `
      query ListArticles($first: Int!, $after: String, $query: String) {
        articles(first: $first, after: $after, query: $query) {
          pageInfo { hasNextPage endCursor }
          edges { node { id title handle publishedAt blog { title } } }
        }
      }
    `, { first, after, query: params.query ?? null })
    return data.articles
  }
  const data = await shopifyGraphql<{ blogs?: unknown }>(auth, `
    query ListBlogs($first: Int!, $after: String) {
      blogs(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        edges { node { id title handle } }
      }
    }
  `, { first, after })
  return data.blogs
}

/**
 * Paginated order fetch for the small-range sales report: loops cursor pages
 * (never ShopifyQL, never the bucket-bypassing bulk API - that is the P6
 * path) up to `maxOrders`, reporting truncation honestly.
 */
export async function fetchOrdersRange(
  auth: ShopifyAuth,
  params: { query?: string; maxOrders?: number },
): Promise<{ orders: unknown[]; truncated: boolean }> {
  const maxOrders = Math.min(params.maxOrders ?? 200, 500)
  const orders: unknown[] = []
  let cursor: string | null = null
  for (;;) {
    const data: { orders?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; edges?: Array<{ node?: unknown }> } } =
      await shopifyGraphql(auth, `
        query ReportOrders($first: Int!, $after: String, $query: String) {
          orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
            pageInfo { hasNextPage endCursor }
            edges { node {
              id createdAt displayFinancialStatus
              totalPriceSet { shopMoney { amount currencyCode } }
              lineItems(first: 10) { edges { node { title quantity } } }
            } }
          }
        }
      `, { first: Math.min(50, maxOrders - orders.length), after: cursor, query: params.query ?? null })
    const page = data.orders
    for (const edge of page?.edges ?? []) {
      if (edge?.node) orders.push(edge.node)
    }
    const hasNext = page?.pageInfo?.hasNextPage === true
    cursor = page?.pageInfo?.endCursor ?? null
    if (!hasNext || !cursor || orders.length >= maxOrders) {
      return { orders, truncated: hasNext && orders.length >= maxOrders }
    }
  }
}

// ── Mutations (P4 writes) ────────────────────────────────────

export async function createProduct(auth: ShopifyAuth, params: {
  title: string
  descriptionHtml?: string
  vendor?: string
  productType?: string
  tags?: string[]
  status?: 'ACTIVE' | 'ARCHIVED' | 'DRAFT'
}): Promise<unknown> {
  const data = await shopifyGraphql(auth, `
    mutation CreateProduct($product: ProductCreateInput!) {
      productCreate(product: $product) {
        product { id title handle status }
        userErrors { field message }
      }
    }
  `, { product: params })
  expectNoUserErrors(data, 'productCreate')
  return (data as Record<string, unknown>).productCreate
}

export async function sendDraftOrderInvoice(auth: ShopifyAuth, draftOrderId: string): Promise<unknown> {
  const data = await shopifyGraphql(auth, `
    mutation SendDraftOrderInvoice($id: ID!) {
      draftOrderInvoiceSend(id: $id) {
        draftOrder { id name invoiceUrl invoiceSentAt }
        userErrors { field message }
      }
    }
  `, { id: toShopifyGid('DraftOrder', draftOrderId) })
  expectNoUserErrors(data, 'draftOrderInvoiceSend')
  return (data as Record<string, unknown>).draftOrderInvoiceSend
}

/** Notes + tags only - marketing consent is deliberately not writable (plan §5). */
export async function updateCustomer(auth: ShopifyAuth, params: {
  id: string
  note?: string
  tags?: string[]
}): Promise<unknown> {
  const input: Record<string, unknown> = { id: toShopifyGid('Customer', params.id) }
  if (params.note !== undefined) input.note = params.note
  if (params.tags !== undefined) input.tags = params.tags
  const data = await shopifyGraphql(auth, `
    mutation UpdateCustomer($input: CustomerInput!) {
      customerUpdate(input: $input) {
        customer { id displayName note tags }
        userErrors { field message }
      }
    }
  `, { input })
  expectNoUserErrors(data, 'customerUpdate')
  return (data as Record<string, unknown>).customerUpdate
}

/**
 * Set the available quantity for a variant. Resolves the variant's inventory
 * item + location first; when the variant is stocked at several locations a
 * locationId is required (the error lists them).
 */
export async function setInventoryQuantity(auth: ShopifyAuth, params: {
  variantId: string
  locationId?: string
  quantity: number
}): Promise<unknown> {
  const lookup = await shopifyGraphql<{
    productVariant?: {
      inventoryItem?: {
        id?: string
        inventoryLevels?: { edges?: Array<{ node?: { location?: { id?: string; name?: string } } }> }
      }
    }
  }>(auth, `
    query VariantInventoryItem($id: ID!) {
      productVariant(id: $id) {
        inventoryItem {
          id
          inventoryLevels(first: 10) { edges { node { location { id name } } } }
        }
      }
    }
  `, { id: toShopifyGid('ProductVariant', params.variantId) })

  const item = lookup.productVariant?.inventoryItem
  if (!item?.id) throw new Error('Shopify API error: variant not found (check the variant id)')
  const locations = (item.inventoryLevels?.edges ?? [])
    .map((e) => e?.node?.location)
    .filter((l): l is { id?: string; name?: string } => !!l?.id)
  let locationId = params.locationId ? toShopifyGid('Location', params.locationId) : undefined
  if (!locationId) {
    if (locations.length !== 1) {
      const names = locations.map((l) => `${l.name} (${l.id})`).join(', ')
      throw new Error(`Shopify API error: variant is stocked at ${locations.length} locations - pass locationId. Locations: ${names || 'none'}`)
    }
    locationId = locations[0].id
  }

  const data = await shopifyGraphql(auth, `
    mutation SetInventory($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) {
        inventoryAdjustmentGroup { createdAt reason }
        userErrors { field message }
      }
    }
  `, {
    input: {
      name: 'available',
      reason: 'correction',
      ignoreCompareQuantity: true,
      quantities: [{ inventoryItemId: item.id, locationId, quantity: params.quantity }],
    },
  })
  expectNoUserErrors(data, 'inventorySetQuantities')
  return (data as Record<string, unknown>).inventorySetQuantities
}

/**
 * Fulfill every open fulfillment order on an order (whole-order fulfillment),
 * optionally attaching tracking + notifying the customer.
 */
export async function createFulfillment(auth: ShopifyAuth, params: {
  orderId: string
  trackingNumber?: string
  trackingCompany?: string
  trackingUrl?: string
  notifyCustomer?: boolean
}): Promise<unknown> {
  const lookup = await shopifyGraphql<{
    order?: { fulfillmentOrders?: { edges?: Array<{ node?: { id?: string; status?: string } }> } }
  }>(auth, `
    query OpenFulfillmentOrders($id: ID!) {
      order(id: $id) {
        fulfillmentOrders(first: 10) { edges { node { id status } } }
      }
    }
  `, { id: toShopifyGid('Order', params.orderId) })

  const open = (lookup.order?.fulfillmentOrders?.edges ?? [])
    .map((e) => e?.node)
    .filter((n): n is { id: string; status?: string } =>
      !!n?.id && (n.status === 'OPEN' || n.status === 'IN_PROGRESS'))
  if (open.length === 0) {
    throw new Error('Shopify API error: no open fulfillment orders on this order (already fulfilled or cancelled)')
  }

  const trackingInfo =
    params.trackingNumber || params.trackingCompany || params.trackingUrl
      ? {
          ...(params.trackingNumber ? { number: params.trackingNumber } : {}),
          ...(params.trackingCompany ? { company: params.trackingCompany } : {}),
          ...(params.trackingUrl ? { url: params.trackingUrl } : {}),
        }
      : undefined

  const data = await shopifyGraphql(auth, `
    mutation CreateFulfillment($fulfillment: FulfillmentInput!) {
      fulfillmentCreate(fulfillment: $fulfillment) {
        fulfillment { id status trackingInfo { number company url } }
        userErrors { field message }
      }
    }
  `, {
    fulfillment: {
      lineItemsByFulfillmentOrder: open.map((fo) => ({ fulfillmentOrderId: fo.id })),
      notifyCustomer: params.notifyCustomer ?? false,
      ...(trackingInfo ? { trackingInfo } : {}),
    },
  })
  expectNoUserErrors(data, 'fulfillmentCreate')
  return (data as Record<string, unknown>).fulfillmentCreate
}

/** Basic code discount: percentage OR fixed amount off, storewide, all customers. */
export async function createDiscountCode(auth: ShopifyAuth, params: {
  code: string
  title?: string
  percentage?: number      // 0-100
  amount?: string          // fixed amount in shop currency (decimal string)
  startsAt?: string
  endsAt?: string
  usageLimit?: number
  appliesOncePerCustomer?: boolean
}): Promise<unknown> {
  const hasPct = typeof params.percentage === 'number'
  const hasAmt = typeof params.amount === 'string' && params.amount.length > 0
  if (hasPct === hasAmt) {
    throw new Error('Shopify API error: pass exactly one of percentage or amount')
  }
  const value = hasPct
    ? { percentage: Math.min(Math.max(params.percentage as number, 0), 100) / 100 }
    : { discountAmount: { amount: params.amount, appliesOnEachItem: false } }
  const data = await shopifyGraphql(auth, `
    mutation CreateDiscountCode($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode {
          id
          codeDiscount {
            ... on DiscountCodeBasic {
              title status startsAt endsAt usageLimit
              codes(first: 1) { edges { node { code } } }
            }
          }
        }
        userErrors { field message }
      }
    }
  `, {
    basicCodeDiscount: {
      title: params.title ?? params.code,
      code: params.code,
      startsAt: params.startsAt ?? new Date().toISOString(),
      ...(params.endsAt ? { endsAt: params.endsAt } : {}),
      ...(params.usageLimit ? { usageLimit: params.usageLimit } : {}),
      appliesOncePerCustomer: params.appliesOncePerCustomer ?? false,
      customerSelection: { all: true },
      customerGets: { items: { all: true }, value },
    },
  })
  expectNoUserErrors(data, 'discountCodeBasicCreate')
  return (data as Record<string, unknown>).discountCodeBasicCreate
}

/** Online-store page or blog article (article resolves the shop's first blog when none given). */
export async function createContent(auth: ShopifyAuth, params: {
  kind: 'page' | 'article'
  title: string
  body: string
  publish?: boolean
  blogId?: string
}): Promise<unknown> {
  if (params.kind === 'page') {
    const data = await shopifyGraphql(auth, `
      mutation CreatePage($page: PageCreateInput!) {
        pageCreate(page: $page) {
          page { id title handle }
          userErrors { field message }
        }
      }
    `, { page: { title: params.title, body: params.body, isPublished: params.publish ?? false } })
    expectNoUserErrors(data, 'pageCreate')
    return (data as Record<string, unknown>).pageCreate
  }

  let blogId = params.blogId ? toShopifyGid('Blog', params.blogId) : undefined
  if (!blogId) {
    const blogs = await shopifyGraphql<{ blogs?: { edges?: Array<{ node?: { id?: string } }> } }>(auth, `
      query FirstBlog { blogs(first: 1) { edges { node { id } } } }
    `)
    blogId = blogs.blogs?.edges?.[0]?.node?.id
    if (!blogId) throw new Error('Shopify API error: the store has no blog - create one in Shopify admin first, or pass blogId')
  }
  const data = await shopifyGraphql(auth, `
    mutation CreateArticle($article: ArticleCreateInput!) {
      articleCreate(article: $article) {
        article { id title handle }
        userErrors { field message }
      }
    }
  `, { article: { blogId, title: params.title, body: params.body, isPublished: params.publish ?? false } })
  expectNoUserErrors(data, 'articleCreate')
  return (data as Record<string, unknown>).articleCreate
}

// ── Mutations (Tier D - destructive) ─────────────────────────

export type ShopifyCancelReason = 'CUSTOMER' | 'DECLINED' | 'FRAUD' | 'INVENTORY' | 'OTHER' | 'STAFF'

export async function cancelOrder(auth: ShopifyAuth, params: {
  orderId: string
  reason?: ShopifyCancelReason
  restock?: boolean
  refund?: boolean
  notifyCustomer?: boolean
  staffNote?: string
}): Promise<unknown> {
  const data = await shopifyGraphql(auth, `
    mutation CancelOrder($orderId: ID!, $reason: OrderCancelReason!, $restock: Boolean!, $refund: Boolean!, $notifyCustomer: Boolean, $staffNote: String) {
      orderCancel(orderId: $orderId, reason: $reason, restock: $restock, refund: $refund, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
        job { id }
        orderCancelUserErrors { field message }
        userErrors { field message }
      }
    }
  `, {
    orderId: toShopifyGid('Order', params.orderId),
    reason: params.reason ?? 'OTHER',
    restock: params.restock ?? true,
    refund: params.refund ?? true,
    notifyCustomer: params.notifyCustomer ?? true,
    staffNote: params.staffNote ?? null,
  })
  // orderCancel reports through its own error key alongside the generic one.
  const payload = (data as Record<string, unknown>).orderCancel as
    | { orderCancelUserErrors?: Array<{ field?: string[] | null; message?: string }> }
    | undefined
  const cancelErrors = payload?.orderCancelUserErrors ?? []
  if (cancelErrors.length > 0) {
    throw new Error(`Shopify API error: ${cancelErrors.map((e) => e.message ?? 'invalid').join('; ').slice(0, 300)}`)
  }
  expectNoUserErrors(data, 'orderCancel')
  return (data as Record<string, unknown>).orderCancel
}

/**
 * Refund an order - full by default, or specific line items. Amounts and
 * gateway transactions come from Shopify's own `suggestedRefund` so the money
 * math is theirs, not ours.
 */
export async function refundOrder(auth: ShopifyAuth, params: {
  orderId: string
  lineItems?: Array<{ lineItemId: string; quantity: number }>
  notify?: boolean
  note?: string
}): Promise<unknown> {
  const orderId = toShopifyGid('Order', params.orderId)
  const partial = !!params.lineItems?.length
  const refundLineItemsArg = partial
    ? params.lineItems!.map((li) => ({ lineItemId: toShopifyGid('LineItem', li.lineItemId), quantity: li.quantity }))
    : undefined

  const lookup = await shopifyGraphql<{
    order?: {
      suggestedRefund?: {
        amountSet?: { shopMoney?: { amount?: string; currencyCode?: string } }
        suggestedTransactions?: Array<{
          amountSet?: { shopMoney?: { amount?: string } }
          gateway?: string
          parentTransaction?: { id?: string }
        }>
        refundLineItems?: Array<{ lineItem?: { id?: string }; quantity?: number }>
      }
    }
  }>(auth, `
    query SuggestedRefund($id: ID!, $refundLineItems: [RefundLineItemInput!], $suggestFullRefund: Boolean) {
      order(id: $id) {
        suggestedRefund(refundLineItems: $refundLineItems, suggestFullRefund: $suggestFullRefund) {
          amountSet { shopMoney { amount currencyCode } }
          suggestedTransactions {
            amountSet { shopMoney { amount } }
            gateway
            parentTransaction { id }
          }
          refundLineItems { lineItem { id } quantity }
        }
      }
    }
  `, {
    id: orderId,
    refundLineItems: refundLineItemsArg ?? null,
    suggestFullRefund: partial ? null : true,
  })

  const suggested = lookup.order?.suggestedRefund
  if (!suggested) throw new Error('Shopify API error: order not found or nothing refundable')
  const transactions = (suggested.suggestedTransactions ?? [])
    .filter((t) => t.parentTransaction?.id && t.amountSet?.shopMoney?.amount)
    .map((t) => ({
      orderId,
      parentId: t.parentTransaction!.id,
      amount: t.amountSet!.shopMoney!.amount,
      gateway: t.gateway,
      kind: 'REFUND',
    }))
  if (transactions.length === 0) {
    throw new Error('Shopify API error: nothing refundable on this order (already refunded or unpaid)')
  }

  const data = await shopifyGraphql(auth, `
    mutation RefundOrder($input: RefundInput!) {
      refundCreate(input: $input) {
        refund {
          id
          totalRefundedSet { shopMoney { amount currencyCode } }
        }
        userErrors { field message }
      }
    }
  `, {
    input: {
      orderId,
      notify: params.notify ?? true,
      ...(params.note ? { note: params.note } : {}),
      refundLineItems: (suggested.refundLineItems ?? [])
        .filter((li) => li.lineItem?.id && typeof li.quantity === 'number')
        .map((li) => ({ lineItemId: li.lineItem!.id, quantity: li.quantity })),
      ...(partial ? {} : { shipping: { fullRefund: true } }),
      transactions,
    },
  })
  expectNoUserErrors(data, 'refundCreate')
  return (data as Record<string, unknown>).refundCreate
}

export async function completeDraftOrder(auth: ShopifyAuth, params: {
  draftOrderId: string
  paymentPending?: boolean
}): Promise<unknown> {
  const data = await shopifyGraphql(auth, `
    mutation CompleteDraftOrder($id: ID!, $paymentPending: Boolean) {
      draftOrderComplete(id: $id, paymentPending: $paymentPending) {
        draftOrder { id name status order { id name } }
        userErrors { field message }
      }
    }
  `, {
    id: toShopifyGid('DraftOrder', params.draftOrderId),
    paymentPending: params.paymentPending ?? true,
  })
  expectNoUserErrors(data, 'draftOrderComplete')
  return (data as Record<string, unknown>).draftOrderComplete
}

// ── Webhook subscriptions (P3 ingest) ────────────────────────

/** Our webhook topic strings → the GraphQL WebhookSubscriptionTopic enum. */
export const SHOPIFY_INGEST_TOPIC_ENUM: Record<string, string> = {
  'orders/create': 'ORDERS_CREATE',
  'orders/fulfilled': 'ORDERS_FULFILLED',
  'orders/cancelled': 'ORDERS_CANCELLED',
  'refunds/create': 'REFUNDS_CREATE',
  'disputes/create': 'DISPUTES_CREATE',
  'app/uninstalled': 'APP_UNINSTALLED',
}

/**
 * Subscribe the app to the ingest topics on one shop (compliance topics are
 * app-config-level in the Dev Dashboard and cannot be subscribed via API).
 * Idempotent: an already-taken address error counts as subscribed. Returns
 * per-topic results so a partial failure is visible, never throwing for one
 * bad topic.
 */
export async function createIngestWebhookSubscriptions(
  auth: ShopifyAuth,
  callbackUrl: string,
  topics: string[] = Object.keys(SHOPIFY_INGEST_TOPIC_ENUM),
): Promise<Array<{ topic: string; ok: boolean; error?: string }>> {
  const results: Array<{ topic: string; ok: boolean; error?: string }> = []
  for (const topic of topics) {
    const topicEnum = SHOPIFY_INGEST_TOPIC_ENUM[topic]
    if (!topicEnum) {
      results.push({ topic, ok: false, error: 'unknown topic' })
      continue
    }
    try {
      const data = await shopifyGraphql<{
        webhookSubscriptionCreate?: { userErrors?: Array<{ message?: string }> }
      }>(auth, `
        mutation SubscribeTopic($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
          webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
            webhookSubscription { id }
            userErrors { field message }
          }
        }
      `, { topic: topicEnum, webhookSubscription: { callbackUrl, format: 'JSON' } })
      const errs = data.webhookSubscriptionCreate?.userErrors ?? []
      const alreadyTaken = errs.some((e) => /taken|exists/i.test(e.message ?? ''))
      results.push(
        errs.length === 0 || alreadyTaken
          ? { topic, ok: true }
          : { topic, ok: false, error: errs.map((e) => e.message).join('; ') },
      )
    } catch (err) {
      results.push({ topic, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return results
}

// ── Webhook + OAuth HMAC verification ────────────────────────

/**
 * Verify an inbound webhook's `X-Shopify-Hmac-Sha256` header: base64
 * HMAC-SHA256 of the RAW request body, keyed by the app client secret.
 * Timing-safe; false on any missing input.
 */
export function verifyShopifyWebhookHmac(
  rawBody: Buffer | string,
  hmacHeader: string | undefined,
  clientSecret: string | undefined,
): boolean {
  if (!hmacHeader || !clientSecret) return false
  const digest = createHmac('sha256', clientSecret).update(rawBody).digest('base64')
  const a = Buffer.from(digest, 'utf8')
  const b = Buffer.from(hmacHeader, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Verify the `hmac` query param on the OAuth callback: hex HMAC-SHA256 of the
 * sorted `key=value` query string with `hmac` (and legacy `signature`)
 * removed, keyed by the app client secret.
 */
export function verifyShopifyOAuthQueryHmac(
  query: Record<string, string | string[] | undefined>,
  clientSecret: string | undefined,
): boolean {
  const provided = query.hmac
  if (typeof provided !== 'string' || !provided || !clientSecret) return false
  const message = Object.keys(query)
    .filter((k) => k !== 'hmac' && k !== 'signature' && query[k] !== undefined)
    .sort()
    .map((k) => {
      const v = query[k]
      return `${k}=${Array.isArray(v) ? v.join(',') : v}`
    })
    .join('&')
  const digest = createHmac('sha256', clientSecret).update(message).digest('hex')
  const a = Buffer.from(digest, 'utf8')
  const b = Buffer.from(provided.toLowerCase(), 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Build the per-shop authorize URL (the connect dialog redirects here). */
export function buildShopifyAuthorizeUrl(params: {
  shopDomain: string
  clientId: string
  redirectUri: string
  scopes: string[]
  state: string
}): string {
  const qs = new URLSearchParams({
    client_id: params.clientId,
    scope: params.scopes.join(','),
    redirect_uri: params.redirectUri,
    state: params.state,
  })
  return `https://${params.shopDomain}/admin/oauth/authorize?${qs.toString()}`
}

/** Fetch shop identity for `config.connectedEmail` at callback time. */
export async function getShopIdentity(auth: ShopifyAuth): Promise<{ name?: string; myshopifyDomain?: string }> {
  const shop = (await getShop(auth)) as { name?: string; myshopifyDomain?: string } | undefined
  return { name: shop?.name, myshopifyDomain: shop?.myshopifyDomain }
}
