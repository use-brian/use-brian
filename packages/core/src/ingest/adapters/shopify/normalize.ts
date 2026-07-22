/**
 * Parse a Shopify webhook delivery into a typed `ShopifyNormalizedEvent`.
 *
 * Returns `null` for any topic not represented in the default rule
 * templates — the orchestrator emits no envelope for those, the route
 * handler actions the lifecycle/compliance topics on its own.
 *
 * Topic map (token strings match the rule templates exactly so the
 * `event_type` filter fires):
 *
 *   orders/create      → 'order.created'
 *   orders/fulfilled   → 'order.fulfilled'
 *   orders/cancelled   → 'order.cancelled'
 *   refunds/create     → 'refund.created'
 *   disputes/create    → 'dispute.created'
 *   app/uninstalled    → null   (lifecycle — route drops subscriptions)
 *   customers/*         → null   (compliance trio — handled route-side)
 *   anything else       → null
 *
 * PII discipline (D10 / §7 — critical): the normalized event NEVER carries
 * customer name/email/phone/address. `payload` is a whitelist-redacted copy
 * built by `redactPayload` — no Episode holds customer PII until Shopify's
 * protected-customer-data Level 2 review clears.
 *
 * The delivery is already parsed and HMAC-verified at the route (D9), so
 * there is no raw body to `JSON.parse` and no signature to check here.
 *
 * [COMP:brain/source-adapters/shopify]
 */

import type { ShopifyEventType, ShopifyNormalizedEvent, ShopifyWebhookInput } from './types.js'

// ── Topic map ─────────────────────────────────────────────────────────

const TOPIC_TO_EVENT: Record<string, ShopifyEventType | undefined> = {
  'orders/create': 'order.created',
  'orders/fulfilled': 'order.fulfilled',
  'orders/cancelled': 'order.cancelled',
  'refunds/create': 'refund.created',
  'disputes/create': 'dispute.created',
}

/**
 * Whitelist of scalar keys copied verbatim into the redacted payload. Every
 * key is order/refund/dispute operational metadata — none is customer PII.
 * `customer`, `email`, `contact_email`, `phone`, `billing_address`,
 * `shipping_address` are deliberately absent and never copied.
 */
const REDACT_SCALAR_KEYS = [
  'id',
  'name',
  'order_number',
  'created_at',
  'financial_status',
  'fulfillment_status',
  'total_price',
  'subtotal_price',
  'total_tax',
  'currency',
  'cancelled_at',
  'cancel_reason',
  'order_id',
  'amount',
  'reason',
  'status',
  'type',
] as const

// ── Helpers ──────────────────────────────────────────────────────────

function parseAmount(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const n = parseFloat(v)
    return Number.isNaN(n) ? null : n
  }
  return null
}

function parseTimestamp(v: unknown, fallback: Date): Date {
  if (typeof v !== 'string' || v.length === 0) return fallback
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? fallback : d
}

function readString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/**
 * Build the PII-free passthrough copy: whitelisted scalar keys plus a
 * `line_items` array reduced to `{ title, quantity, price }`. Anything not
 * on the whitelist — including every customer-identifying field — is dropped.
 */
function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of REDACT_SCALAR_KEYS) {
    if (payload[key] !== undefined) out[key] = payload[key]
  }
  const lineItems = payload.line_items
  if (Array.isArray(lineItems)) {
    out.line_items = lineItems.map((li) => {
      const item = (li ?? {}) as Record<string, unknown>
      const reduced: Record<string, unknown> = {}
      if (item.title !== undefined) reduced.title = item.title
      if (item.quantity !== undefined) reduced.quantity = item.quantity
      if (item.price !== undefined) reduced.price = item.price
      return reduced
    })
  }
  return out
}

function lineItemTitles(payload: Record<string, unknown>): string[] {
  const lineItems = Array.isArray(payload.line_items) ? payload.line_items : []
  return lineItems
    .map((li) => (li as Record<string, unknown> | null)?.title)
    .filter((t): t is string => typeof t === 'string')
    .slice(0, 10)
}

// ── Per-event normalizers ─────────────────────────────────────────────

function normalizeOrder(
  event_type: ShopifyEventType,
  payload: Record<string, unknown>,
  shopDomain: string,
  receivedAt: Date,
): ShopifyNormalizedEvent {
  const lineItems = Array.isArray(payload.line_items) ? payload.line_items : []
  const occurred_at = parseTimestamp(payload.created_at ?? payload.updated_at, receivedAt)
  return {
    event_type,
    occurred_at,
    shop_domain: shopDomain,
    order_name: readString(payload.name),
    total_amount: parseAmount(payload.total_price),
    currency: readString(payload.currency),
    item_titles: lineItemTitles(payload),
    items_count: lineItems.length,
    payload: redactPayload(payload),
  }
}

function normalizeRefund(
  payload: Record<string, unknown>,
  shopDomain: string,
  receivedAt: Date,
): ShopifyNormalizedEvent {
  const transactions = Array.isArray(payload.transactions) ? payload.transactions : []
  let total_amount: number | null = null
  let seen = false
  let sum = 0
  for (const t of transactions) {
    const amt = parseAmount((t as Record<string, unknown> | null)?.amount)
    if (amt !== null) {
      sum += amt
      seen = true
    }
  }
  if (seen) total_amount = sum
  const occurred_at = parseTimestamp(payload.created_at ?? payload.processed_at, receivedAt)
  return {
    event_type: 'refund.created',
    occurred_at,
    shop_domain: shopDomain,
    order_name: null,
    total_amount,
    currency: readString(payload.currency),
    item_titles: [],
    items_count: null,
    payload: redactPayload(payload),
  }
}

function normalizeDispute(
  payload: Record<string, unknown>,
  shopDomain: string,
  receivedAt: Date,
): ShopifyNormalizedEvent {
  const occurred_at = parseTimestamp(payload.created_at ?? payload.initiated_at, receivedAt)
  return {
    event_type: 'dispute.created',
    occurred_at,
    shop_domain: shopDomain,
    order_name: null,
    total_amount: parseAmount(payload.amount),
    currency: readString(payload.currency),
    item_titles: [],
    items_count: null,
    payload: redactPayload(payload),
  }
}

// ── Public entry point ───────────────────────────────────────────────

export function normalizeShopifyWebhook(
  input: ShopifyWebhookInput,
  receivedAt: Date = new Date(),
): ShopifyNormalizedEvent | null {
  const event_type = TOPIC_TO_EVENT[input.topic]
  if (!event_type) return null

  const payload = input.payload ?? {}
  switch (event_type) {
    case 'order.created':
    case 'order.fulfilled':
    case 'order.cancelled':
      return normalizeOrder(event_type, payload, input.shopDomain, receivedAt)
    case 'refund.created':
      return normalizeRefund(payload, input.shopDomain, receivedAt)
    case 'dispute.created':
      return normalizeDispute(payload, input.shopDomain, receivedAt)
  }
}
