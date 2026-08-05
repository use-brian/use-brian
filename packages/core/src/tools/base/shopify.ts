/**
 * Shopify tools — store reads (products, orders, customers, inventory) plus
 * the safe v1 writes (product updates, draft orders, tags).
 *
 * Read tools are concurrency-safe; write tools require confirmation and are
 * additionally grant-gated via their `write` classification in
 * `OFFICIAL_CONNECTOR_TOOLS.shopify`. The `api` callback is injected by the
 * API layer so core stays free of network deps.
 *
 * See docs/architecture/integrations/shopify.md.
 */

import { z } from 'zod'
import { buildTool, type Tool, type ToolContext } from '../types.js'
import { type Json, asRows, str, num, bool, obj, projectList } from './_connector-result.js'

// ── Result projections ─────────────────────────────────────────
// The GraphQL queries already select only the needed fields, but connection
// wrappers (edges/node/pageInfo) and MoneyBag nesting are still noise the
// model re-reads every turn. Flatten to concise rows. See `_connector-result.ts`.

/** Rows of a GraphQL connection ({ edges: [{ node }] }). */
function connRows(raw: unknown): Json[] {
  const conn = (raw ?? {}) as Json
  return asRows(conn.edges)
    .map((e) => obj(e, 'node'))
    .filter((n): n is Json => n !== undefined)
}

/** Cursor info of a GraphQL connection, for the model to paginate honestly. */
function pageMeta(raw: unknown): { has_next_page: boolean; end_cursor?: string } {
  const pi = obj((raw ?? {}) as Json, 'pageInfo')
  const endCursor = str(pi, 'endCursor')
  return { has_next_page: bool(pi, 'hasNextPage') ?? false, ...(endCursor ? { end_cursor: endCursor } : {}) }
}

/** "12.50 USD" from a { amount, currencyCode } money object. */
function plainMoney(m: Json | undefined): string | undefined {
  const amount = str(m, 'amount')
  if (!amount) return undefined
  const currency = str(m, 'currencyCode')
  return currency ? `${amount} ${currency}` : amount
}

/** "12.50 USD" from a MoneyBag field ({ shopMoney: { amount, currencyCode } }). */
function money(o: Json | undefined, key: string): string | undefined {
  return plainMoney(obj(obj(o, key), 'shopMoney'))
}

/** Extract the trailing numeric id of a GID for query-syntax filters. */
function numericId(id: string): string | undefined {
  const m = /(\d+)$/.exec(id.trim())
  return m?.[1]
}

const productRow = (p: Json) => ({
  id: str(p, 'id'),
  title: str(p, 'title'),
  status: str(p, 'status'),
  vendor: str(p, 'vendor'),
  product_type: str(p, 'productType'),
  tags: p.tags,
  total_inventory: num(p, 'totalInventory'),
  price_min: plainMoney(obj(obj(p, 'priceRangeV2'), 'minVariantPrice')),
  price_max: plainMoney(obj(obj(p, 'priceRangeV2'), 'maxVariantPrice')),
  updated_at: str(p, 'updatedAt'),
})

const variantRow = (v: Json) => ({
  id: str(v, 'id'),
  title: str(v, 'title'),
  sku: str(v, 'sku'),
  price: str(v, 'price'),
  inventory_quantity: num(v, 'inventoryQuantity'),
  available_for_sale: bool(v, 'availableForSale'),
})

const orderRow = (o: Json) => ({
  id: str(o, 'id'),
  name: str(o, 'name'),
  created_at: str(o, 'createdAt'),
  financial_status: str(o, 'displayFinancialStatus'),
  fulfillment_status: str(o, 'displayFulfillmentStatus'),
  total: money(o, 'totalPriceSet'),
  customer: str(obj(o, 'customer'), 'displayName'),
  customer_email: str(obj(o, 'customer'), 'email'),
  items: connRows((o.lineItems ?? {}) as Json).map(
    (li) => `${num(li, 'quantity') ?? '?'}x ${str(li, 'title') ?? 'item'}`,
  ),
})

const customerRow = (c: Json) => ({
  id: str(c, 'id'),
  name: str(c, 'displayName'),
  email: str(c, 'email'),
  phone: str(c, 'phone'),
  // numberOfOrders is an UnsignedInt64 — arrives as a string.
  orders_count: str(c, 'numberOfOrders') ?? num(c, 'numberOfOrders'),
  total_spent: plainMoney(obj(c, 'amountSpent')),
  tags: c.tags,
  created_at: str(c, 'createdAt'),
})

const inventoryLevelRow = (v: Json) => ({
  variant_id: str(v, 'id'),
  sku: str(v, 'sku'),
  variant: str(v, 'title'),
  product: str(obj(v, 'product'), 'title'),
  total_available: num(v, 'inventoryQuantity'),
  locations: connRows(obj(obj(v, 'inventoryItem'), 'inventoryLevels')).map((lvl) => ({
    location: str(obj(lvl, 'location'), 'name'),
    ...Object.fromEntries(
      asRows(lvl.quantities).map((q) => [str(q, 'name') ?? 'available', num(q, 'quantity')]),
    ),
  })),
})

function projectConnection<U>(raw: unknown, limit: number, map: (row: Json) => U) {
  const rows = connRows(raw)
  return { ...projectList(rows, limit, map), ...pageMeta(raw) }
}

const collectionRow = (c: Json) => ({
  id: str(c, 'id'),
  title: str(c, 'title'),
  handle: str(c, 'handle'),
  products_count: num(obj(c, 'productsCount'), 'count'),
  updated_at: str(c, 'updatedAt'),
})

const draftOrderRow = (d: Json) => ({
  id: str(d, 'id'),
  name: str(d, 'name'),
  status: str(d, 'status'),
  total: money(d, 'totalPriceSet'),
  customer: str(obj(d, 'customer'), 'displayName'),
  customer_email: str(obj(d, 'customer'), 'email'),
  invoice_url: str(d, 'invoiceUrl'),
  created_at: str(d, 'createdAt'),
})

/** discountNodes row: the union member's fields live under `discount`. */
const discountRow = (n: Json) => {
  const d = obj(n, 'discount')
  const typename = str(d, '__typename') ?? ''
  return {
    id: str(n, 'id'),
    kind: typename.startsWith('DiscountAutomatic') ? 'automatic' : 'code',
    type: typename.replace(/^Discount(Code|Automatic)/, '') || undefined,
    title: str(d, 'title'),
    status: str(d, 'status'),
    summary: str(d, 'summary'),
    usage_count: num(d, 'asyncUsageCount'),
    usage_limit: num(d, 'usageLimit'),
    codes: connRows(obj(d, 'codes')).map((c) => str(c, 'code')),
    starts_at: str(d, 'startsAt'),
    ends_at: str(d, 'endsAt'),
  }
}

const checkoutRow = (c: Json) => ({
  id: str(c, 'id'),
  created_at: str(c, 'createdAt'),
  total: money(c, 'totalPriceSet'),
  customer: str(obj(c, 'customer'), 'displayName'),
  customer_email: str(obj(c, 'customer'), 'email'),
  items: connRows(obj(c, 'lineItems')).map(
    (li) => `${num(li, 'quantity') ?? '?'}x ${str(li, 'title') ?? 'item'}`,
  ),
  recovery_url: str(c, 'abandonedCheckoutUrl'),
})

const disputeRow = (d: Json) => ({
  id: str(d, 'id'),
  status: str(d, 'status'),
  type: str(d, 'type'),
  amount: plainMoney(obj(d, 'amount')),
  reason: str(obj(d, 'reasonDetails'), 'reason'),
  evidence_due_by: str(d, 'evidenceDueBy'),
  order: str(obj(d, 'order'), 'name'),
  order_id: str(obj(d, 'order'), 'id'),
})

// ── API port ───────────────────────────────────────────────────

type ShopifyListParams = { query?: string; first?: number; cursor?: string }

export type ShopifyApi = {
  getShop(): Promise<unknown>
  listProducts(params: ShopifyListParams): Promise<unknown>
  getProduct(productId: string): Promise<unknown>
  listOrders(params: ShopifyListParams): Promise<unknown>
  getOrder(orderId: string): Promise<unknown>
  searchCustomers(params: ShopifyListParams): Promise<unknown>
  getCustomer(customerId: string): Promise<unknown>
  getInventoryLevels(params: { query?: string; first?: number }): Promise<unknown>
  listCollections(params: ShopifyListParams): Promise<unknown>
  listDraftOrders(params: ShopifyListParams): Promise<unknown>
  listDiscounts(params: ShopifyListParams): Promise<unknown>
  listAbandonedCheckouts(params: ShopifyListParams): Promise<unknown>
  getPayoutsSummary(params: { first?: number }): Promise<unknown>
  listDisputes(params: { first?: number }): Promise<unknown>
  listContent(params: { kind: 'pages' | 'articles' | 'blogs'; query?: string; first?: number; cursor?: string }): Promise<unknown>
  fetchOrdersRange(params: { query?: string; maxOrders?: number }): Promise<{ orders: unknown[]; truncated: boolean }>
  updateProduct(params: {
    id: string
    title?: string
    descriptionHtml?: string
    tags?: string[]
    status?: 'ACTIVE' | 'ARCHIVED' | 'DRAFT'
    seoTitle?: string
    seoDescription?: string
  }): Promise<unknown>
  createProduct(params: {
    title: string
    descriptionHtml?: string
    vendor?: string
    productType?: string
    tags?: string[]
    status?: 'ACTIVE' | 'ARCHIVED' | 'DRAFT'
  }): Promise<unknown>
  createDraftOrder(params: {
    lineItems: Array<{ variantId?: string; quantity: number; title?: string; originalUnitPrice?: string }>
    customerId?: string
    email?: string
    note?: string
    tags?: string[]
  }): Promise<unknown>
  sendDraftOrderInvoice(draftOrderId: string): Promise<unknown>
  addTags(resource: 'order' | 'customer' | 'product', resourceId: string, tags: string[]): Promise<unknown>
  updateCustomer(params: { id: string; note?: string; tags?: string[] }): Promise<unknown>
  setInventoryQuantity(params: { variantId: string; locationId?: string; quantity: number }): Promise<unknown>
  createFulfillment(params: {
    orderId: string
    trackingNumber?: string
    trackingCompany?: string
    trackingUrl?: string
    notifyCustomer?: boolean
  }): Promise<unknown>
  createDiscountCode(params: {
    code: string
    title?: string
    percentage?: number
    amount?: string
    startsAt?: string
    endsAt?: string
    usageLimit?: number
    appliesOncePerCustomer?: boolean
  }): Promise<unknown>
  createContent(params: { kind: 'page' | 'article'; title: string; body: string; publish?: boolean; blogId?: string }): Promise<unknown>
  cancelOrder(params: {
    orderId: string
    reason?: 'CUSTOMER' | 'DECLINED' | 'FRAUD' | 'INVENTORY' | 'OTHER' | 'STAFF'
    restock?: boolean
    refund?: boolean
    notifyCustomer?: boolean
    staffNote?: string
  }): Promise<unknown>
  refundOrder(params: {
    orderId: string
    lineItems?: Array<{ lineItemId: string; quantity: number }>
    notify?: boolean
    note?: string
  }): Promise<unknown>
  completeDraftOrder(params: { draftOrderId: string; paymentPending?: boolean }): Promise<unknown>
  // ── Product authoring ──
  addProductImage(params: {
    productId: string
    bytes: Uint8Array
    filename: string
    mimeType: string
    alt?: string
  }): Promise<unknown>
  setVariantPrice(params: {
    productId: string
    variantId?: string
    price: string
    compareAtPrice?: string
    sku?: string
  }): Promise<unknown>
  publishProduct(params: { productId: string; publicationId?: string }): Promise<unknown>
  setProductMetafields(params: {
    productId: string
    metafields: Array<{ namespace: string; key: string; type: string; value: string }>
  }): Promise<unknown>
  setProductOptions(params: {
    productId: string
    optionId?: string
    name?: string
    values?: string[]
  }): Promise<unknown>
  // ── Theme product templates ──
  listThemes(): Promise<Array<{ id: string; name: string; role: string }>>
  readProductTemplate(params: { themeId?: string; suffix?: string }): Promise<unknown>
  createProductTemplate(params: { themeId?: string; suffix: string; template: string }): Promise<unknown>
  setProductTemplate(params: { productId: string; templateSuffix: string | null }): Promise<unknown>
}

/**
 * Byte source for `shopifyAddProductImage`. Deliberately narrower than
 * `FilesApi`: the tool needs one read, and taking the whole interface would
 * couple every Shopify wiring site to the files subsystem.
 *
 * Chat attachments are NOT a valid source — they live in `file_cache` and
 * expire after 7 days. The model saves the photo to the brain first.
 */
export type ShopifyFileBytesReader = (
  context: ToolContext,
  idOrPath: string,
) => Promise<{ bytes: Uint8Array; fileName: string; mimeType: string } | { error: string }>

export function createShopifyTools(
  api: ShopifyApi,
  opts?: { readFileBytes?: ShopifyFileBytesReader },
): Tool[] {
  const getShop = buildTool({
    name: 'shopifyGetShop',
    description:
      'Get the connected Shopify store: name, myshopify domain, primary domain, plan, currency, and timezone. ' +
      'Cheap connection sanity check.',
    inputSchema: z.object({}),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 10_000,

    async execute() {
      try {
        const s = ((await api.getShop()) ?? {}) as Json
        return { data: {
          name: str(s, 'name'),
          myshopify_domain: str(s, 'myshopifyDomain'),
          primary_domain: str(obj(s, 'primaryDomain'), 'host'),
          currency: str(s, 'currencyCode'),
          timezone: str(s, 'ianaTimezone'),
          plan: str(obj(s, 'plan'), 'displayName'),
        } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const listProducts = buildTool({
    name: 'shopifyListProducts',
    description:
      'Search and list products in the Shopify store. Supports Shopify search query syntax via `query` ' +
      '(e.g. "status:active", "title:*shirt*", "tag:summer", "vendor:Acme"). Returns concise product rows ' +
      'with price range and total inventory.',
    inputSchema: z.object({
      query: z.string().optional().describe('Shopify product search query (e.g. "status:active tag:sale").'),
      first: z.number().optional().describe('Rows per page (default 10, max 50).'),
      cursor: z.string().optional().describe('Pagination cursor (`end_cursor` from the previous page).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const first = Math.min(input.first ?? 10, 50)
        const data = await api.listProducts({ ...input, first })
        return { data: projectConnection(data, first, productRow) }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const getProduct = buildTool({
    name: 'shopifyGetProduct',
    description:
      'Get a Shopify product by id, including description, SEO fields, and variants with SKU, price, and ' +
      'inventory quantity. Accepts a numeric id or a gid://shopify/Product/... id.',
    inputSchema: z.object({
      productId: z.string().describe('Product id (numeric or GID).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const p = ((await api.getProduct(input.productId)) ?? {}) as Json
        if (!p.id) return { data: 'Shopify error: product not found', isError: true }
        return { data: {
          ...productRow(p),
          description: str(p, 'description'),
          url: str(p, 'onlineStoreUrl'),
          seo_title: str(obj(p, 'seo'), 'title'),
          seo_description: str(obj(p, 'seo'), 'description'),
          created_at: str(p, 'createdAt'),
          variants: connRows((p.variants ?? {}) as Json).map(variantRow),
        } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const listOrders = buildTool({
    name: 'shopifyListOrders',
    description:
      'List Shopify orders, newest first. Supports Shopify search query syntax via `query` ' +
      '(e.g. "created_at:>=2026-07-01", "financial_status:paid", "fulfillment_status:unfulfilled", ' +
      '"name:#1042" to find an order by its number). ' +
      'Note: until the app is approved for full order history, Shopify only returns roughly the last 60 days of orders.',
    inputSchema: z.object({
      query: z.string().optional().describe('Shopify order search query (date, status, name, customer filters).'),
      first: z.number().optional().describe('Rows per page (default 10, max 50).'),
      cursor: z.string().optional().describe('Pagination cursor (`end_cursor` from the previous page).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const first = Math.min(input.first ?? 10, 50)
        const data = await api.listOrders({ ...input, first })
        return { data: projectConnection(data, first, orderRow) }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const getOrder = buildTool({
    name: 'shopifyGetOrder',
    description:
      'Get a Shopify order by id: line items, customer, shipping address, fulfillment status with tracking ' +
      'numbers, totals (subtotal, shipping, tax), and risk flag. Accepts a numeric id or GID. ' +
      'To look up an order by its number (#1042), first find its id via shopifyListOrders with query "name:#1042".',
    inputSchema: z.object({
      orderId: z.string().describe('Order id (numeric or GID) — not the #1234 order number.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const o = ((await api.getOrder(input.orderId)) ?? {}) as Json
        if (!o.id) return { data: 'Shopify error: order not found', isError: true }
        return { data: {
          ...orderRow(o),
          email: str(o, 'email'),
          phone: str(o, 'phone'),
          note: str(o, 'note'),
          tags: o.tags,
          cancelled_at: str(o, 'cancelledAt'),
          subtotal: money(o, 'subtotalPriceSet'),
          shipping: money(o, 'totalShippingPriceSet'),
          tax: money(o, 'totalTaxSet'),
          shipping_address: obj(o, 'shippingAddress'),
          line_items: connRows((o.lineItems ?? {}) as Json).map((li) => ({
            title: str(li, 'title'),
            quantity: num(li, 'quantity'),
            sku: str(li, 'sku'),
            unit_price: money(li, 'discountedUnitPriceSet'),
          })),
          fulfillments: asRows(o.fulfillments).map((f) => ({
            status: str(f, 'status'),
            created_at: str(f, 'createdAt'),
            tracking: asRows(f.trackingInfo).map((t) => ({
              number: str(t, 'number'),
              url: str(t, 'url'),
              company: str(t, 'company'),
            })),
          })),
          risk: str(obj(o, 'risk'), 'recommendation'),
        } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const searchCustomers = buildTool({
    name: 'shopifySearchCustomers',
    description:
      'Search Shopify customers by email, name, phone, or tag using Shopify query syntax ' +
      '(e.g. "email:jane@example.com", "tag:vip", or a bare name). Returns order count and total spent per customer. ' +
      'Customer name/email fields can be null until Shopify grants the app access to protected customer data.',
    inputSchema: z.object({
      query: z.string().describe('Customer search query (email, name, phone, or tag filter).'),
      first: z.number().optional().describe('Rows per page (default 10, max 50).'),
      cursor: z.string().optional().describe('Pagination cursor (`end_cursor` from the previous page).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const first = Math.min(input.first ?? 10, 50)
        const data = await api.searchCustomers({ ...input, first })
        return { data: projectConnection(data, first, customerRow) }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const getCustomer = buildTool({
    name: 'shopifyGetCustomer',
    description:
      'Get a Shopify customer by id: contact details, note, tags, order count, total spent, and last order. ' +
      'Accepts a numeric id or GID.',
    inputSchema: z.object({
      customerId: z.string().describe('Customer id (numeric or GID).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const c = ((await api.getCustomer(input.customerId)) ?? {}) as Json
        if (!c.id) return { data: 'Shopify error: customer not found', isError: true }
        const lastOrder = obj(c, 'lastOrder')
        return { data: {
          ...customerRow(c),
          first_name: str(c, 'firstName'),
          last_name: str(c, 'lastName'),
          note: str(c, 'note'),
          verified_email: bool(c, 'verifiedEmail'),
          location: obj(c, 'defaultAddress'),
          last_order: lastOrder
            ? { id: str(lastOrder, 'id'), name: str(lastOrder, 'name'), created_at: str(lastOrder, 'createdAt') }
            : undefined,
        } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const getInventoryLevels = buildTool({
    name: 'shopifyGetInventoryLevels',
    description:
      'Get inventory quantities for product variants, with per-location available counts. ' +
      'Filter by productId or sku (at least one recommended; without a filter returns the first variants).',
    inputSchema: z.object({
      productId: z.string().optional().describe('Limit to one product (numeric id or GID).'),
      sku: z.string().optional().describe('Limit to one SKU.'),
      first: z.number().optional().describe('Variants per page (default 20, max 50).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const filters: string[] = []
        if (input.productId) {
          const pid = numericId(input.productId)
          if (!pid) return { data: 'Shopify error: productId must be a numeric id or GID', isError: true }
          filters.push(`product_id:${pid}`)
        }
        if (input.sku) filters.push(`sku:${input.sku}`)
        const first = Math.min(input.first ?? 20, 50)
        const data = await api.getInventoryLevels({
          query: filters.length ? filters.join(' ') : undefined,
          first,
        })
        return { data: projectConnection(data, first, inventoryLevelRow) }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const updateProductTool = buildTool({
    name: 'shopifyUpdateProduct',
    description:
      'Update a Shopify product: title, description, tags, status (ACTIVE / DRAFT / ARCHIVED — archiving is ' +
      'how products are retired; there is no delete), or SEO fields. Only the fields provided change. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      productId: z.string().describe('Product id (numeric or GID).'),
      title: z.string().optional().describe('New product title.'),
      description: z.string().optional().describe('New product description (HTML allowed).'),
      tags: z.array(z.string()).optional().describe('Replacement tag list (overwrites existing tags).'),
      status: z.enum(['ACTIVE', 'ARCHIVED', 'DRAFT']).optional().describe('Product status.'),
      seoTitle: z.string().optional().describe('SEO page title.'),
      seoDescription: z.string().optional().describe('SEO meta description.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const data = ((await api.updateProduct({
          id: input.productId,
          title: input.title,
          descriptionHtml: input.description,
          tags: input.tags,
          status: input.status,
          seoTitle: input.seoTitle,
          seoDescription: input.seoDescription,
        })) ?? {}) as Json
        const p = obj(data, 'product')
        return { data: {
          id: str(p, 'id'),
          title: str(p, 'title'),
          status: str(p, 'status'),
          tags: p?.tags,
          updated_at: str(p, 'updatedAt'),
        } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const createDraftOrderTool = buildTool({
    name: 'shopifyCreateDraftOrder',
    description:
      'Create a Shopify draft order — a quote or invoice the merchant can send or complete later. ' +
      'This never charges anyone. Line items reference a product variant id, or use title + originalUnitPrice ' +
      'for custom items. Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      lineItems: z.array(z.object({
        variantId: z.string().optional().describe('Product variant id (numeric or GID). Omit for a custom item.'),
        quantity: z.number().describe('Quantity.'),
        title: z.string().optional().describe('Custom item title (when no variantId).'),
        originalUnitPrice: z.string().optional().describe('Custom item unit price, decimal string (when no variantId).'),
      })).min(1).describe('Items on the draft order.'),
      customerId: z.string().optional().describe('Attach an existing customer (numeric id or GID).'),
      email: z.string().optional().describe('Customer email (used for the invoice).'),
      note: z.string().optional().describe('Internal note on the draft order.'),
      tags: z.array(z.string()).optional().describe('Tags for the draft order.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const data = ((await api.createDraftOrder(input)) ?? {}) as Json
        const d = obj(data, 'draftOrder')
        return { data: {
          id: str(d, 'id'),
          name: str(d, 'name'),
          status: str(d, 'status'),
          invoice_url: str(d, 'invoiceUrl'),
          total: money(d, 'totalPriceSet'),
        } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const addTagsTool = buildTool({
    name: 'shopifyAddTags',
    description:
      'Add tags to a Shopify order, customer, or product (existing tags are kept). ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      resource: z.enum(['order', 'customer', 'product']).describe('What to tag.'),
      resourceId: z.string().describe('Resource id (numeric or GID).'),
      tags: z.array(z.string()).min(1).describe('Tags to add.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const data = ((await api.addTags(input.resource, input.resourceId, input.tags)) ?? {}) as Json
        return { data: {
          id: str(obj(data, 'node'), 'id'),
          tags_added: input.tags,
        } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const listCollections = buildTool({
    name: 'shopifyListCollections',
    description: 'List product collections in the Shopify store, with product counts. Supports Shopify query syntax via `query` (e.g. "title:Summer*").',
    inputSchema: z.object({
      query: z.string().optional().describe('Collection search query.'),
      first: z.number().optional().describe('Rows per page (default 10, max 50).'),
      cursor: z.string().optional().describe('Pagination cursor.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,
    async execute(input) {
      try {
        const first = Math.min(input.first ?? 10, 50)
        return { data: projectConnection(await api.listCollections({ ...input, first }), first, collectionRow) }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const listDraftOrdersTool = buildTool({
    name: 'shopifyListDraftOrders',
    description: 'List Shopify draft orders (open quotes and invoices) with status, total, customer, and invoice URL. Query syntax supported (e.g. "status:open").',
    inputSchema: z.object({
      query: z.string().optional().describe('Draft order search query.'),
      first: z.number().optional().describe('Rows per page (default 10, max 50).'),
      cursor: z.string().optional().describe('Pagination cursor.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,
    async execute(input) {
      try {
        const first = Math.min(input.first ?? 10, 50)
        return { data: projectConnection(await api.listDraftOrders({ ...input, first }), first, draftOrderRow) }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const listDiscountsTool = buildTool({
    name: 'shopifyListDiscounts',
    description:
      'List Shopify discounts and promo codes - both code discounts and automatic discounts - with status, codes, usage counts, and validity window. ' +
      'To look up one promo code, pass its code as the query (e.g. "SUMMER20").',
    inputSchema: z.object({
      query: z.string().optional().describe('Discount search query (a code, title, or filter like "status:active").'),
      first: z.number().optional().describe('Rows per page (default 10, max 50).'),
      cursor: z.string().optional().describe('Pagination cursor.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,
    async execute(input) {
      try {
        const first = Math.min(input.first ?? 10, 50)
        return { data: projectConnection(await api.listDiscounts({ ...input, first }), first, discountRow) }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const listAbandonedCheckoutsTool = buildTool({
    name: 'shopifyListAbandonedCheckouts',
    description: 'List abandoned checkouts with cart value, items, customer contact, and the recovery URL - the raw material for recovery outreach.',
    inputSchema: z.object({
      query: z.string().optional().describe('Search query (e.g. "created_at:>=2026-07-01").'),
      first: z.number().optional().describe('Rows per page (default 10, max 50).'),
      cursor: z.string().optional().describe('Pagination cursor.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,
    async execute(input) {
      try {
        const first = Math.min(input.first ?? 10, 50)
        return { data: projectConnection(await api.listAbandonedCheckouts({ ...input, first }), first, checkoutRow) }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const getPayoutsSummaryTool = buildTool({
    name: 'shopifyGetPayoutsSummary',
    description: 'Get the Shopify Payments balance and recent payouts (read-only by API design). Only works for stores on Shopify Payments.',
    inputSchema: z.object({
      first: z.number().optional().describe('Recent payouts to return (default 10, max 25).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,
    async execute(input) {
      try {
        const account = (await api.getPayoutsSummary({ first: Math.min(input.first ?? 10, 25) })) as Json | null
        if (!account) return { data: 'Shopify error: this store does not use Shopify Payments', isError: true }
        return { data: {
          balance: asRows(account.balance).map((b) => plainMoney(b)),
          payout_interval: str(obj(account, 'payoutSchedule'), 'interval'),
          payouts: connRows(obj(account, 'payouts')).map((p) => ({
            id: str(p, 'id'),
            issued_at: str(p, 'issuedAt'),
            status: str(p, 'status'),
            net: plainMoney(obj(p, 'net')),
          })),
        } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const listDisputesTool = buildTool({
    name: 'shopifyListDisputes',
    description: 'List Shopify Payments disputes and chargebacks with amount, reason, status, and evidence deadline. Only works for stores on Shopify Payments.',
    inputSchema: z.object({
      first: z.number().optional().describe('Rows to return (default 10, max 25).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,
    async execute(input) {
      try {
        const account = (await api.listDisputes({ first: Math.min(input.first ?? 10, 25) })) as Json | null
        if (!account) return { data: 'Shopify error: this store does not use Shopify Payments', isError: true }
        return { data: connRows(obj(account, 'disputes')).map(disputeRow) }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const listContentTool = buildTool({
    name: 'shopifyListContent',
    description: 'List online-store content: pages, blog articles, or blogs (pick with `kind`).',
    inputSchema: z.object({
      kind: z.enum(['pages', 'articles', 'blogs']).describe('Content type to list.'),
      query: z.string().optional().describe('Search query (pages/articles only).'),
      first: z.number().optional().describe('Rows per page (default 10, max 50).'),
      cursor: z.string().optional().describe('Pagination cursor.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,
    async execute(input) {
      try {
        const first = Math.min(input.first ?? 10, 50)
        const data = await api.listContent({ ...input, first })
        return { data: projectConnection(data, first, (n) => ({
          id: str(n, 'id'),
          title: str(n, 'title'),
          handle: str(n, 'handle'),
          blog: str(obj(n, 'blog'), 'title'),
          published_at: str(n, 'publishedAt'),
          updated_at: str(n, 'updatedAt'),
        })) }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const salesReportTool = buildTool({
    name: 'shopifySalesReport',
    description:
      'Aggregate sales over a date range: order count, revenue, average order value, and top items by quantity. ' +
      'Computed from order data (never store analytics). Covers up to 500 orders per call and reports truncation honestly - ' +
      'for bigger ranges, narrow the dates. Note: without extended order-history approval Shopify only returns roughly the last 60 days.',
    inputSchema: z.object({
      since: z.string().optional().describe('Start date (YYYY-MM-DD, inclusive).'),
      until: z.string().optional().describe('End date (YYYY-MM-DD, inclusive).'),
      query: z.string().optional().describe('Extra Shopify order query filters (e.g. "financial_status:paid").'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 60_000,
    async execute(input) {
      try {
        const filters: string[] = []
        if (input.since) filters.push(`created_at:>=${input.since}`)
        if (input.until) filters.push(`created_at:<=${input.until}`)
        if (input.query) filters.push(input.query)
        const { orders, truncated } = await api.fetchOrdersRange({
          query: filters.length ? filters.join(' ') : undefined,
          maxOrders: 500,
        })
        let revenue = 0
        let currency: string | undefined
        const itemQty = new Map<string, number>()
        for (const raw of orders) {
          const o = (raw ?? {}) as Json
          const m = obj(obj(o, 'totalPriceSet'), 'shopMoney')
          const amount = Number.parseFloat(str(m, 'amount') ?? '')
          if (Number.isFinite(amount)) revenue += amount
          currency = currency ?? str(m, 'currencyCode')
          for (const li of connRows(obj(o, 'lineItems'))) {
            const title = str(li, 'title') ?? 'item'
            itemQty.set(title, (itemQty.get(title) ?? 0) + (num(li, 'quantity') ?? 0))
          }
        }
        const count = orders.length
        return { data: {
          orders_count: count,
          revenue: `${revenue.toFixed(2)}${currency ? ` ${currency}` : ''}`,
          average_order_value: count > 0 ? `${(revenue / count).toFixed(2)}${currency ? ` ${currency}` : ''}` : undefined,
          top_items: [...itemQty.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([title, qty]) => ({ title, quantity: qty })),
          truncated,
          ...(truncated ? { note: 'More than 500 orders matched - figures cover the first 500. Narrow the date range for exact numbers.' } : {}),
        } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const createProductTool = buildTool({
    name: 'shopifyCreateProduct',
    description:
      'Create a new Shopify product (title, description, vendor, type, tags, status - defaults to DRAFT so nothing goes live unreviewed). ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      title: z.string().describe('Product title.'),
      description: z.string().optional().describe('Product description (HTML allowed).'),
      vendor: z.string().optional().describe('Vendor name.'),
      productType: z.string().optional().describe('Product type/category.'),
      tags: z.array(z.string()).optional().describe('Tags.'),
      status: z.enum(['ACTIVE', 'ARCHIVED', 'DRAFT']).optional().describe('Status (default DRAFT).'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,
    async execute(input) {
      try {
        const data = ((await api.createProduct({
          title: input.title,
          descriptionHtml: input.description,
          vendor: input.vendor,
          productType: input.productType,
          tags: input.tags,
          status: input.status ?? 'DRAFT',
        })) ?? {}) as Json
        const p = obj(data, 'product')
        return { data: { id: str(p, 'id'), title: str(p, 'title'), handle: str(p, 'handle'), status: str(p, 'status') } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  // ── Product authoring ────────────────────────────────────────
  // `shopifyCreateProduct` alone yields a product that cannot be sold: no
  // image, no price, and unpublished regardless of `status`. These four finish
  // the job. See docs/architecture/integrations/shopify.md → "Product authoring".

  const addProductImageTool = buildTool({
    name: 'shopifyAddProductImage',
    description:
      'Add an image to a Shopify product from a file already saved in the workspace brain. ' +
      'The file must be a workspace file - pass its id or absolute workspace path. ' +
      'If the user just attached a photo to this chat, save it with saveFileToBrain FIRST, then call this with the saved path: ' +
      'chat attachments are temporary and cannot be uploaded. ' +
      'Shopify processes the image asynchronously, so it may take a few seconds to appear on the product. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      productId: z.string().describe('Product id (numeric or GID).'),
      file: z.string().describe('Workspace file id (UUID) or absolute workspace path of the image.'),
      alt: z.string().optional().describe('Alt text for accessibility and SEO.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 60_000,
    async execute(input, context) {
      // No reader wired: say so. Silently omitting the tool would leave the
      // model asserting it uploaded an image it never touched.
      if (!opts?.readFileBytes) {
        return {
          data: 'Product images cannot be uploaded from this context - workspace file access is not available here. Ask the user to add the image in Shopify admin.',
          isError: true,
        }
      }
      try {
        const file = await opts.readFileBytes(context, input.file)
        if ('error' in file) return { data: file.error, isError: true }
        if (!file.mimeType.startsWith('image/')) {
          return { data: `That file is ${file.mimeType}, not an image. Shopify product media must be an image file.`, isError: true }
        }
        const data = ((await api.addProductImage({
          productId: input.productId,
          bytes: file.bytes,
          filename: file.fileName,
          mimeType: file.mimeType,
          alt: input.alt,
        })) ?? {}) as Json
        const p = obj(data, 'product')
        return { data: {
          product_id: str(p, 'id'),
          uploaded: file.fileName,
          note: 'Shopify processes product images asynchronously - it may take a few seconds to appear.',
        } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const setProductPriceTool = buildTool({
    name: 'shopifySetProductPrice',
    description:
      'Set the price of a Shopify product variant (and optionally its compare-at price and SKU). ' +
      'A newly created product has no price until this runs, so it cannot be sold. ' +
      'Omit variantId for a single-variant product; a product with several variants requires one (the error lists them). ' +
      'Prices are plain decimal strings in the store currency, e.g. "439.00" - never include a currency symbol. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      productId: z.string().describe('Product id (numeric or GID).'),
      price: z.string().describe('Price as a decimal string in the store currency, e.g. "439.00".'),
      compareAtPrice: z.string().optional().describe('Optional strike-through "was" price, same format.'),
      sku: z.string().optional().describe('Optional SKU for the variant.'),
      variantId: z.string().optional().describe('Variant id - required only when the product has more than one variant.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,
    async execute(input) {
      try {
        const data = ((await api.setVariantPrice(input)) ?? {}) as Json
        const variants = asRows(data.productVariants).map((v) => ({
          id: str(v, 'id'),
          title: str(v, 'title'),
          price: str(v, 'price'),
          compare_at_price: str(v, 'compareAtPrice'),
        }))
        return { data: { variants } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const publishProductTool = buildTool({
    name: 'shopifyPublishProduct',
    description:
      'Publish a Shopify product to the Online Store so customers can see and buy it. ' +
      'Shopify creates products unpublished no matter what status they have, so a new product stays invisible on the storefront until this runs. ' +
      'Publishing is necessary but not sufficient: a product whose status is DRAFT stays invisible even after publishing. ' +
      'New products are created as DRAFT, so set the status to ACTIVE with shopifyUpdateProduct as well - this tool reports whether that is still needed. ' +
      'Check the product has an image and a price before publishing. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      productId: z.string().describe('Product id (numeric or GID).'),
      publicationId: z.string().optional().describe('Sales channel publication id. Defaults to the Online Store.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,
    async execute(input) {
      try {
        const data = ((await api.publishProduct(input)) ?? {}) as Json
        const status = str(data, 'product_status')
        const visible = bool(data, 'visible') === true
        return { data: {
          published_to: str(data, 'published_to'),
          product_status: status,
          visible,
          // Not a hedge — a DRAFT product is genuinely not on the storefront
          // after a successful publish. Saying "published" without this reads
          // to the user as "live", and they will go looking for it.
          note: visible
            ? 'Published and visible on the storefront.'
            : `Published, but the product status is ${status ?? 'not ACTIVE'} so it is NOT visible to customers yet. Set the status to ACTIVE with shopifyUpdateProduct to make it live.`,
        } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const setProductMetafieldsTool = buildTool({
    name: 'shopifySetProductMetafields',
    description:
      'Set structured metafields on a Shopify product (ingredients, nutrition, FAQ, and similar). ' +
      'IMPORTANT: a metafield only appears on the storefront if the product theme template is built to read that exact namespace and key. ' +
      'Writing one does not put anything on the page by itself - if the user expects it visible, tell them their theme must reference it. ' +
      'Common types: single_line_text_field, multi_line_text_field, rich_text_field, number_decimal, json, boolean. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      productId: z.string().describe('Product id (numeric or GID).'),
      metafields: z.array(z.object({
        namespace: z.string().describe('Metafield namespace, e.g. "custom".'),
        key: z.string().describe('Metafield key, e.g. "ingredients".'),
        type: z.string().describe('Shopify metafield type, e.g. "multi_line_text_field".'),
        value: z.string().describe('Value as a string; JSON types take a JSON-encoded string.'),
      })).min(1).describe('Metafields to set (existing namespace/key pairs are overwritten).'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 20_000,
    async execute(input) {
      try {
        const data = ((await api.setProductMetafields(input)) ?? {}) as Json
        const metafields = asRows(data.metafields).map((m) => ({
          namespace: str(m, 'namespace'),
          key: str(m, 'key'),
          type: str(m, 'type'),
        }))
        return { data: {
          metafields,
          note: 'Written to the product. These render on the storefront only if the theme template reads them.',
        } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const setProductOptionsTool = buildTool({
    name: 'shopifySetProductOptions',
    description:
      'Rename a Shopify product\'s option and its values - the labels shown on the storefront variant picker. ' +
      'New products always start with the placeholder option "Title" with the single value "Default Title", which looks unfinished on a real listing; ' +
      'set something meaningful like name "Size" with values ["250g"]. ' +
      'This RENAMES existing values, it does not add new variants. Single-option products only unless you pass optionId. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      productId: z.string().describe('Product id (numeric or GID).'),
      name: z.string().optional().describe('New option name, e.g. "Size" or "Pack".'),
      values: z.array(z.string()).optional().describe('New value labels, in the option\'s existing order. Cannot be longer than the current value list.'),
      optionId: z.string().optional().describe('Option id - required only when the product has more than one option.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,
    async execute(input) {
      try {
        const data = ((await api.setProductOptions(input)) ?? {}) as Json
        const options = asRows(obj(data, 'product')?.options).map((o) => ({
          name: str(o, 'name'),
          values: asRows(o.optionValues).map((v) => str(v, 'name')),
        }))
        return { data: { options } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  // ── Theme product templates ──────────────────────────────────
  // The only theme surface here, and deliberately narrow: a rich product page
  // is theme sections on a per-product template, so authoring one is the
  // difference between "the product exists" and "the page looks right". It is
  // also the one write that can break a storefront for every visitor.

  const listThemesTool = buildTool({
    name: 'shopifyListThemes',
    description:
      'List the store\'s online store themes with their ids and roles. The MAIN theme is the live one customers see. ' +
      'Use before reading or creating a product page template when the user has more than one theme.',
    inputSchema: z.object({}),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 15_000,
    async execute() {
      try {
        const themes = await api.listThemes()
        return { data: { themes } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const readProductTemplateTool = buildTool({
    name: 'shopifyReadProductTemplate',
    description:
      'Read a product page template from the theme, as JSON. Omit suffix for the theme default (templates/product.json), ' +
      'or pass the suffix of an existing product\'s template to use its page layout as the model for a new one. ' +
      'To give a new product a rich page: read the template of a product whose page already looks right, edit the section settings text, ' +
      'then write it with shopifyCreateProductTemplate. Always clone from the SAME theme - section types differ between themes.',
    inputSchema: z.object({
      suffix: z.string().optional().describe('Template suffix to read, e.g. "detox-protein-mix". Omit for the theme default.'),
      themeId: z.string().optional().describe('Theme id. Defaults to the live (MAIN) theme.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 20_000,
    async execute(input) {
      try {
        const data = ((await api.readProductTemplate(input)) ?? {}) as Json
        return { data: {
          theme: str(data, 'themeName'),
          theme_id: str(data, 'themeId'),
          filename: str(data, 'filename'),
          template: str(data, 'content'),
        } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const createProductTemplateTool = buildTool({
    name: 'shopifyCreateProductTemplate',
    description:
      'Create a NEW product page template in the theme, then point a product at it with shopifySetProductTemplate. ' +
      'This writes a file into the live theme, so build the template by reading an existing one with shopifyReadProductTemplate and editing its section settings - do not write one from scratch. ' +
      'Only product templates can be written; existing templates are never overwritten (they may be another product\'s live page), and every section type must already exist in that theme. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      suffix: z.string().describe('New template suffix, lowercase with hyphens, e.g. "hojicha-black-maca". Becomes templates/product.<suffix>.json.'),
      template: z.string().describe('The complete template JSON: a "sections" object and an "order" array.'),
      themeId: z.string().optional().describe('Theme id. Defaults to the live (MAIN) theme.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    // Destructive, not merely write: this lands in the theme customers are
    // served from, and a bad page is not visible in the Shopify admin.
    requiresConfirmation: true,
    timeoutMs: 30_000,
    async execute(input) {
      try {
        const data = ((await api.createProductTemplate(input)) ?? {}) as Json
        return { data: {
          theme: str(data, 'theme'),
          filename: str(data, 'filename'),
          suffix: str(data, 'suffix'),
          note: 'Created. The page does not change until a product is pointed at it with shopifySetProductTemplate.',
        } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const setProductTemplateTool = buildTool({
    name: 'shopifySetProductTemplate',
    description:
      'Point a Shopify product at a page template, changing the layout its product page uses. ' +
      'Pass the suffix of a template that already exists in the theme; pass null to go back to the theme default. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      productId: z.string().describe('Product id (numeric or GID).'),
      templateSuffix: z.string().nullable().describe('Template suffix, e.g. "hojicha-black-maca", or null for the theme default.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,
    async execute(input) {
      try {
        const data = ((await api.setProductTemplate(input)) ?? {}) as Json
        const p = obj(data, 'product')
        return { data: { id: str(p, 'id'), template_suffix: str(p, 'templateSuffix') ?? '(theme default)' } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const sendDraftOrderInvoiceTool = buildTool({
    name: 'shopifySendDraftOrderInvoice',
    description:
      'Email the invoice for a Shopify draft order to its customer. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      draftOrderId: z.string().describe('Draft order id (numeric or GID).'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,
    async execute(input) {
      try {
        const data = ((await api.sendDraftOrderInvoice(input.draftOrderId)) ?? {}) as Json
        const d = obj(data, 'draftOrder')
        return { data: { id: str(d, 'id'), name: str(d, 'name'), invoice_url: str(d, 'invoiceUrl'), invoice_sent_at: str(d, 'invoiceSentAt') } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const updateCustomerTool = buildTool({
    name: 'shopifyUpdateCustomer',
    description:
      'Update a Shopify customer\'s note or tags. Marketing consent is deliberately not writable. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      customerId: z.string().describe('Customer id (numeric or GID).'),
      note: z.string().optional().describe('Replacement customer note.'),
      tags: z.array(z.string()).optional().describe('Replacement tag list (overwrites existing tags; to only add, use shopifyAddTags).'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,
    async execute(input) {
      try {
        const data = ((await api.updateCustomer({ id: input.customerId, note: input.note, tags: input.tags })) ?? {}) as Json
        const c = obj(data, 'customer')
        return { data: { id: str(c, 'id'), name: str(c, 'displayName'), note: str(c, 'note'), tags: c?.tags } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const setInventoryTool = buildTool({
    name: 'shopifySetInventory',
    description:
      'Set the available inventory quantity for a product variant at a location. If the variant is stocked at more than one ' +
      'location, pass locationId (the error lists the options). ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      variantId: z.string().describe('Product variant id (numeric or GID).'),
      quantity: z.number().describe('New available quantity (absolute, not a delta).'),
      locationId: z.string().optional().describe('Location id (needed when stocked at several locations).'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,
    async execute(input) {
      try {
        await api.setInventoryQuantity(input)
        return { data: { variant_id: input.variantId, available: input.quantity } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const createFulfillmentTool = buildTool({
    name: 'shopifyCreateFulfillment',
    description:
      'Mark a Shopify order fulfilled (all open fulfillment orders), optionally with a tracking number and customer notification. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      orderId: z.string().describe('Order id (numeric or GID).'),
      trackingNumber: z.string().optional().describe('Tracking number.'),
      trackingCompany: z.string().optional().describe('Carrier name (e.g. "SF Express", "DHL").'),
      trackingUrl: z.string().optional().describe('Tracking URL.'),
      notifyCustomer: z.boolean().optional().describe('Email the customer the shipment notification (default false).'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 20_000,
    async execute(input) {
      try {
        const data = ((await api.createFulfillment(input)) ?? {}) as Json
        const f = obj(data, 'fulfillment')
        return { data: {
          id: str(f, 'id'),
          status: str(f, 'status'),
          tracking: asRows(f?.trackingInfo).map((t) => ({ number: str(t, 'number'), company: str(t, 'company'), url: str(t, 'url') })),
        } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const createDiscountCodeTool = buildTool({
    name: 'shopifyCreateDiscountCode',
    description:
      'Create a Shopify promo code: percentage off (percentage) or a fixed amount off (amount), storewide, all customers, ' +
      'with optional usage limit and validity window. ' +
      'A discount value is REQUIRED: pass exactly one of percentage or amount. If the user asked for a promo code ' +
      'without saying how much off, ask them before calling this. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z
      .object({
        code: z.string().describe('The promo code customers type (e.g. "SUMMER20").'),
        title: z.string().optional().describe('Internal title (defaults to the code).'),
        percentage: z.number().optional().describe('Percent off, 0-100. Pass exactly one of percentage or amount.'),
        amount: z.string().optional().describe('Fixed amount off in shop currency, decimal string (e.g. "10.00").'),
        startsAt: z
          .string()
          .optional()
          .describe(
            'When the code STARTS working (ISO timestamp, default now). "starting in three days" sets this; ' +
            'a code that merely RUNS FOR three days leaves this at now.',
          ),
        endsAt: z
          .string()
          .optional()
          .describe(
            'When the code STOPS working (ISO timestamp, default no end). A code that runs "for three days" ' +
            'sets this to three days from the start.',
          ),
        usageLimit: z.number().optional().describe('Total redemption cap.'),
        appliesOncePerCustomer: z.boolean().optional().describe('One redemption per customer (default false).'),
      })
      // Shopify requires a value and rejects both-at-once. Enforcing it here
      // turns a wasted round trip (the client throws, the model retries) into
      // a schema rejection the model can correct before any call goes out.
      .refine(
        (v) => (typeof v.percentage === 'number') !== (typeof v.amount === 'string' && v.amount.length > 0),
        { message: 'Pass exactly one of percentage or amount.' },
      ),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,
    async execute(input) {
      try {
        const data = ((await api.createDiscountCode(input)) ?? {}) as Json
        const node = obj(data, 'codeDiscountNode')
        const d = obj(node, 'codeDiscount')
        return { data: {
          id: str(node, 'id'),
          code: connRows(obj(d, 'codes')).map((c) => str(c, 'code'))[0] ?? input.code,
          title: str(d, 'title'),
          status: str(d, 'status'),
          starts_at: str(d, 'startsAt'),
          ends_at: str(d, 'endsAt'),
          usage_limit: num(d, 'usageLimit'),
        } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const createContentTool = buildTool({
    name: 'shopifyCreateContent',
    description:
      'Create an online-store page or blog article (articles land on the shop\'s first blog unless blogId is given). ' +
      'Defaults to unpublished draft. Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      kind: z.enum(['page', 'article']).describe('What to create.'),
      title: z.string().describe('Title.'),
      body: z.string().describe('Body (HTML allowed).'),
      publish: z.boolean().optional().describe('Publish immediately (default false = draft).'),
      blogId: z.string().optional().describe('Blog id for articles (defaults to the first blog).'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,
    async execute(input) {
      try {
        const data = ((await api.createContent(input)) ?? {}) as Json
        const n = obj(data, 'page') ?? obj(data, 'article')
        return { data: { id: str(n, 'id'), title: str(n, 'title'), handle: str(n, 'handle'), published: input.publish ?? false } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const cancelOrderTool = buildTool({
    name: 'shopifyCancelOrder',
    description:
      'Cancel a Shopify order, with restock, refund, and customer-notification options. This is destructive and cannot be undone. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      orderId: z.string().describe('Order id (numeric or GID).'),
      reason: z.enum(['CUSTOMER', 'DECLINED', 'FRAUD', 'INVENTORY', 'OTHER', 'STAFF']).optional().describe('Cancellation reason (default OTHER).'),
      restock: z.boolean().optional().describe('Restock the items (default true).'),
      refund: z.boolean().optional().describe('Refund the payment (default true).'),
      notifyCustomer: z.boolean().optional().describe('Notify the customer (default true).'),
      staffNote: z.string().optional().describe('Internal note.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 20_000,
    async execute(input) {
      try {
        await api.cancelOrder(input)
        return { data: {
          order_id: input.orderId,
          cancelled: true,
          restocked: input.restock ?? true,
          refunded: input.refund ?? true,
          customer_notified: input.notifyCustomer ?? true,
        } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const refundOrderTool = buildTool({
    name: 'shopifyRefundOrder',
    description:
      'Refund a Shopify order - the full order by default, or specific line items. Amounts come from Shopify\'s suggested ' +
      'refund, so gateway fees and prior partial refunds are respected. This moves real money and cannot be undone. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      orderId: z.string().describe('Order id (numeric or GID).'),
      lineItems: z.array(z.object({
        lineItemId: z.string().describe('Line item id (numeric or GID).'),
        quantity: z.number().describe('Quantity to refund.'),
      })).optional().describe('Refund only these line items (omit for a full refund).'),
      notify: z.boolean().optional().describe('Notify the customer (default true).'),
      note: z.string().optional().describe('Refund note.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 20_000,
    async execute(input) {
      try {
        const data = ((await api.refundOrder(input)) ?? {}) as Json
        const r = obj(data, 'refund')
        return { data: {
          refund_id: str(r, 'id'),
          refunded: money(r, 'totalRefundedSet'),
          order_id: input.orderId,
        } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const completeDraftOrderTool = buildTool({
    name: 'shopifyCompleteDraftOrder',
    description:
      'Convert a Shopify draft order into a real order (marked payment-pending by default - it creates a payable order, ' +
      'which is why this is destructive, not a plain write). ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      draftOrderId: z.string().describe('Draft order id (numeric or GID).'),
      paymentPending: z.boolean().optional().describe('Mark the order payment-pending (default true) instead of paid.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,
    async execute(input) {
      try {
        const data = ((await api.completeDraftOrder(input)) ?? {}) as Json
        const d = obj(data, 'draftOrder')
        const o = obj(d, 'order')
        return { data: {
          draft_order_id: str(d, 'id'),
          status: str(d, 'status'),
          order_id: str(o, 'id'),
          order_name: str(o, 'name'),
        } }
      } catch (err) {
        return { data: `Shopify error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  return [
    getShop,
    listProducts,
    getProduct,
    listOrders,
    getOrder,
    searchCustomers,
    getCustomer,
    getInventoryLevels,
    listCollections,
    listDraftOrdersTool,
    listDiscountsTool,
    listAbandonedCheckoutsTool,
    getPayoutsSummaryTool,
    listDisputesTool,
    listContentTool,
    salesReportTool,
    updateProductTool,
    createProductTool,
    addProductImageTool,
    setProductPriceTool,
    publishProductTool,
    setProductMetafieldsTool,
    setProductOptionsTool,
    listThemesTool,
    readProductTemplateTool,
    createProductTemplateTool,
    setProductTemplateTool,
    createDraftOrderTool,
    sendDraftOrderInvoiceTool,
    addTagsTool,
    updateCustomerTool,
    setInventoryTool,
    createFulfillmentTool,
    createDiscountCodeTool,
    createContentTool,
    cancelOrderTool,
    refundOrderTool,
    completeDraftOrderTool,
  ]
}
