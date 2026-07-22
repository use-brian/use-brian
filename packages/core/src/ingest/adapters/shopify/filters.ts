/**
 * Shopify source-specific filter implementations (§7):
 *
 *   event_type      { values: string[] }    ← matches `event.event_type`
 *   order_value_gte { amount: number }       ← `event.total_amount >= amount`
 *
 * All pure functions: (event, params) → boolean. No I/O. `order_value_gte`
 * returns `false` unless both the event's `total_amount` and the param
 * `amount` are finite numbers (a refund/dispute with a null amount, or a
 * missing/non-numeric threshold, never matches).
 *
 * [COMP:brain/source-adapters/shopify]
 */

import type { ShopifyFilterImplementations } from './types.js'

export const shopifyFilterImplementations: ShopifyFilterImplementations = {
  event_type: (event, params) => params.values.includes(event.event_type),
  order_value_gte: (event, params) =>
    typeof event.total_amount === 'number' &&
    typeof params.amount === 'number' &&
    event.total_amount >= params.amount,
}
