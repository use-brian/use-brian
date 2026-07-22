/**
 * Default Shopify rules — digest-first (§7). Order events are individually
 * low-signal, so only the high-signal minority lands as its own episode; the
 * rest folds into a daily digest.
 *
 *   1. event_type      { dispute.created }               → realtime + alert   (chargeback)
 *   2. event_type      { order.cancelled, refund.created } → realtime
 *   3. order_value_gte { amount: 500 }                    → realtime + alert   ("order over $500 just landed")
 *   4. always                                             → scheduled '0 18 * * *'  (daily digest at 18:00)
 *
 * Seeded per `connector_instance` when a new Shopify connector lands;
 * founder customises the value threshold + schedule via the agent.
 *
 * [COMP:brain/source-adapters/shopify]
 */

import type { ShopifyDefaultRule } from './types.js'

export const shopifyDefaultRules: ReadonlyArray<ShopifyDefaultRule> = [
  {
    filter_type: 'event_type',
    params: { values: ['dispute.created'] },
    routing_mode: 'realtime',
    alert: true,
  },
  {
    filter_type: 'event_type',
    params: { values: ['order.cancelled', 'refund.created'] },
    routing_mode: 'realtime',
  },
  {
    filter_type: 'order_value_gte',
    params: { amount: 500 },
    routing_mode: 'realtime',
    alert: true,
  },
  {
    filter_type: 'always',
    params: {},
    routing_mode: 'scheduled',
    routing_schedule: '0 18 * * *',
  },
]
