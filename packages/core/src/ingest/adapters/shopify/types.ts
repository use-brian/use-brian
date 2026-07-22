/**
 * Local type vocabulary for the Shopify source adapter.
 *
 * Mirrors the GitHub adapter's shape (a normalized event, a per-delivery
 * context the HTTP route injects, framework-agnostic primitive input,
 * per-filter param shapes, default-rule descriptors, and the adapter
 * object) so a follow-up can fold both under the canonical
 * `ConnectorAdapter` interface mechanically.
 *
 * Unlike GitHub, there is no per-instance HMAC secret here: Shopify signs
 * deliveries with the *app* client secret, verified in the API route
 * before this adapter runs (decision D9) — so the delivery context carries
 * no secret and `receive` does no signature work.
 *
 * Spec: docs/architecture/integrations/shopify.md + docs/plans/shopify-connector.md §7, §12 (D9/D10).
 *
 * [COMP:brain/source-adapters/shopify]
 */

import type { EpisodeEnvelope } from '../../types.js'
import type { Sensitivity } from '../../../security/sensitivity.js'

/**
 * Filter-time event type tokens — the topic map in `normalize.ts` reconciles
 * Shopify's webhook topic strings (`orders/create`, …) onto these so the
 * `event_type` filter and default rules fire against a stable vocabulary:
 *   - `order.created`, `order.fulfilled`, `order.cancelled` — the operational pulse
 *   - `refund.created`
 *   - `dispute.created` — always high-signal (chargeback)
 */
export type ShopifyEventType =
  | 'order.created'
  | 'order.fulfilled'
  | 'order.cancelled'
  | 'refund.created'
  | 'dispute.created'

/**
 * Normalized webhook event handed to filters + envelope mapper.
 *
 * `payload` is a **redacted** passthrough copy (see `normalize.ts`): it never
 * carries customer name/email/phone/address. No customer PII lives in an
 * Episode until Shopify's protected-customer-data Level 2 review clears
 * (decision D10 / §7).
 */
export type ShopifyNormalizedEvent = {
  event_type: ShopifyEventType
  occurred_at: Date
  shop_domain: string
  order_name: string | null
  total_amount: number | null
  currency: string | null
  item_titles: string[]
  items_count: number | null
  /** Redacted, PII-free copy of the delivery body; kept for envelope lookups. */
  payload: Record<string, unknown>
}

/**
 * Context the HTTP route injects per delivery. Carries everything the
 * webhook payload does not know about: visibility ids, the connector id
 * stamped into `source_ref`, and the shop domain.
 *
 * No `hmac_secret` (cf. GitHub): the app-secret-keyed HMAC is verified at
 * the route, not here (D9).
 */
export type ShopifyDeliveryContext = {
  workspace_id: string
  user_id: string | null
  assistant_id: string | null
  created_by_user_id: string
  created_by_assistant_id: string | null
  /** Defaults to `'internal'` when omitted. */
  sensitivity?: Sensitivity
  /** Connector id stamped into `source_ref` for `connector_action` envelopes. */
  connector_id: string
  /** The delivering shop, e.g. `acme.myshopify.com`. */
  shop_domain: string
}

/**
 * Adapter entry-point input — primitives only, framework-agnostic.
 *
 * `payload` arrives already parsed and HMAC-verified: the route validates
 * the delivery against the app client secret (D9) before calling `receive`,
 * so there is no raw body / signature to check here — only the topic to map.
 */
export type ShopifyWebhookInput = {
  topic: string
  payload: Record<string, unknown>
  shopDomain: string
  deliveryContext: ShopifyDeliveryContext
}

/** `event_type` filter param — matches `event.event_type` against a set. */
export type ShopifyEventTypeFilterParams = {
  values: string[]
}

/** `order_value_gte` filter param — a numeric threshold on `event.total_amount`. */
export type ShopifyOrderValueGteFilterParams = {
  amount: number
}

export type ShopifyFilterImplementations = {
  event_type: (event: ShopifyNormalizedEvent, params: ShopifyEventTypeFilterParams) => boolean
  order_value_gte: (
    event: ShopifyNormalizedEvent,
    params: ShopifyOrderValueGteFilterParams,
  ) => boolean
}

/** Default rule template descriptor — matches the shared ingest rule schema. */
export type ShopifyDefaultRule = {
  filter_type: 'event_type' | 'order_value_gte' | 'always'
  params: Record<string, unknown>
  routing_mode: 'realtime' | 'scheduled' | 'drop'
  routing_schedule?: string
  alert?: boolean
}

/**
 * Adapter shape — local to this module until the canonical
 * `ConnectorAdapter` interface lands.
 */
export type ShopifyConnectorAdapter = {
  source: 'shopify'
  receive(input: ShopifyWebhookInput): Promise<EpisodeEnvelope[]>
  filterImplementations: ShopifyFilterImplementations
  defaultRules: ReadonlyArray<ShopifyDefaultRule>
}
