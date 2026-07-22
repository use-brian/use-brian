/**
 * Shopify source adapter (§7 / P3).
 *
 * Receives a webhook delivery and emits zero or one `EpisodeEnvelope` for
 * Pipeline B. Unlike the GitHub adapter there is **no signature step here**:
 * Shopify signs deliveries with the *app* client secret (there is no
 * per-instance secret to hold), so the HMAC is verified in the API route
 * against `SHOPIFY_CLIENT_SECRET` before this adapter runs (decision D9).
 * `receive` therefore trusts its input and only maps the topic.
 *
 * Spec: docs/architecture/integrations/shopify.md + docs/plans/shopify-connector.md §7, §12.
 *
 * [COMP:brain/source-adapters/shopify]
 */

import type { EpisodeEnvelope } from '../../types.js'

import { shopifyDefaultRules } from './default-rules.js'
import { toShopifyEpisodeEnvelope } from './envelope.js'
import { shopifyFilterImplementations } from './filters.js'
import { normalizeShopifyWebhook } from './normalize.js'
import type { ShopifyConnectorAdapter, ShopifyWebhookInput } from './types.js'

async function receive(input: ShopifyWebhookInput): Promise<EpisodeEnvelope[]> {
  const event = normalizeShopifyWebhook(input)
  if (event === null) return []
  return [toShopifyEpisodeEnvelope(event, input.deliveryContext)]
}

export const shopifyIngestAdapter: ShopifyConnectorAdapter = {
  source: 'shopify',
  receive,
  filterImplementations: shopifyFilterImplementations,
  defaultRules: shopifyDefaultRules,
}

export {
  shopifyDefaultRules,
  shopifyFilterImplementations,
  normalizeShopifyWebhook,
  toShopifyEpisodeEnvelope,
}
export type {
  ShopifyConnectorAdapter,
  ShopifyDefaultRule,
  ShopifyDeliveryContext,
  ShopifyEventType,
  ShopifyEventTypeFilterParams,
  ShopifyFilterImplementations,
  ShopifyNormalizedEvent,
  ShopifyOrderValueGteFilterParams,
  ShopifyWebhookInput,
} from './types.js'
