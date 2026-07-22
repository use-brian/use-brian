/**
 * Map `ShopifyNormalizedEvent` → `EpisodeEnvelope`.
 *
 * Every Shopify event is a `connector_action` — store events are workflow
 * signals, not KB documents, so they never touch `kb_chunks`. (GitHub is
 * the exception: default-branch pushes route to `github_sync`; Shopify has
 * no such content-sync arm.)
 *
 * `actors` is empty: pre-Level-2 we hold no customer identity safe to stamp
 * as a per-person actor (§7 / D10 PII discipline).
 *
 * [COMP:brain/source-adapters/shopify]
 */

import type { EpisodeEnvelope } from '../../types.js'
import type { ShopifyDeliveryContext, ShopifyNormalizedEvent } from './types.js'

function summaryFor(event: ShopifyNormalizedEvent): string {
  const total =
    event.total_amount !== null
      ? `${event.total_amount}${event.currency ? ` ${event.currency}` : ''}`
      : null
  return JSON.stringify({
    action: event.event_type,
    shop: event.shop_domain,
    order: event.order_name,
    total,
    items_count: event.items_count,
    items: event.item_titles,
  })
}

function sourceRefFor(
  event: ShopifyNormalizedEvent,
  ctx: ShopifyDeliveryContext,
): Record<string, unknown> {
  const ref: Record<string, unknown> = {
    source_kind: 'connector_action',
    connector_id: ctx.connector_id,
    action_kind: event.event_type,
    shop_domain: event.shop_domain,
  }
  if (event.order_name) ref.external_id = event.order_name
  return ref
}

export function toShopifyEpisodeEnvelope(
  event: ShopifyNormalizedEvent,
  ctx: ShopifyDeliveryContext,
): EpisodeEnvelope {
  return {
    source_kind: 'connector_action',
    source_ref: sourceRefFor(event, ctx),
    occurred_at: event.occurred_at,
    actors: [],
    content: {
      raw: summaryFor(event),
      attachments: [],
    },
    sensitivity: ctx.sensitivity ?? 'internal',
    user_id: ctx.user_id,
    assistant_id: ctx.assistant_id,
    workspace_id: ctx.workspace_id,
    created_by_user_id: ctx.created_by_user_id,
    created_by_assistant_id: ctx.created_by_assistant_id,
  }
}
