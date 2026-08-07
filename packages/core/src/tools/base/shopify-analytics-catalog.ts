/**
 * ShopifyQL field catalog — the dictionary the model cannot get any other way.
 *
 * ShopifyQL has **no introspection**: `shopifyqlQuery` is the only root field,
 * `SHOW COLUMNS` and `SHOW *` are rejected, and a rejection names only the
 * column that was wrong, never one that would have been right. So a model
 * handed a free-form query tool has no route to the vocabulary except guessing,
 * and guessing does not converge — on 2026-08-07 an assistant spent twenty
 * minutes cycling `new_customers` → `customer_type` → `customer_type` against
 * the `customers` schema, each rejection telling it only that it was wrong
 * again. This table is what stops that.
 *
 * **Every name here was verified against a live store**, not copied from the
 * reference: each schema's full candidate list was submitted to the Admin API
 * and any name Shopify rejected was dropped. All 6 schemas / 78 metrics / 263
 * dimensions survived on 2026-08-07 against API 2026-04, so the published
 * reference was accurate — but it had already been wrong once about this field
 * (rows are keyed objects, not positional arrays), which is why it is checked
 * rather than trusted. Re-run `scripts/verify-shopifyql-catalog.mjs` when the
 * API version rolls.
 *
 * Scope is deliberate: these are the schemas the connector's use cases need.
 * A schema absent here is not necessarily invalid ShopifyQL — it is a schema we
 * cannot help the model spell, which is why the tool says so plainly instead of
 * letting it try its luck.
 *
 * See docs/architecture/integrations/shopify.md → "Storefront analytics".
 */

export type ShopifyqlSchemaName = keyof typeof SHOPIFYQL_CATALOG

export const SHOPIFYQL_CATALOG = {
  sessions: {
    metrics: [
      'added_to_cart_rate',
      'average_session_duration',
      'bounce_rate',
      'bounces',
      'checkout_conversion_rate',
      'completed_checkout_rate',
      'conversion_rate',
      'online_store_visitors',
      'pageviews',
      'pageviews_per_session',
      'reached_checkout_rate',
      'sessions',
      'sessions_that_completed_checkout',
      'sessions_that_reached_and_completed_checkout',
      'sessions_that_reached_checkout',
      'sessions_with_cart_additions',
    ],
    dimensions: [
      'channel_handle',
      'customer_account_status',
      'customer_amount_spent',
      'customer_cities',
      'customer_cohort_month',
      'customer_cohort_quarter',
      'customer_cohort_week',
      'customer_countries',
      'customer_email',
      'customer_email_domain',
      'customer_email_subscription_status',
      'customer_first_order_date',
      'customer_id',
      'customer_language',
      'customer_last_order_date',
      'customer_name',
      'customer_number_of_orders',
      'customer_regions',
      'customer_sms_subscription_status',
      'customer_tag',
      'customer_tags',
      'day',
      'day_of_week',
      'first_order_sales_channel',
      'hour',
      'hour_of_day',
      'human_or_bot_session',
      'landing_page_path',
      'landing_page_type',
      'landing_page_url',
      'marketing_activity_channel',
      'marketing_activity_id',
      'marketing_activity_status',
      'marketing_activity_title',
      'marketing_automation_id',
      'marketing_delivery_channel',
      'marketing_event_id',
      'marketing_platform',
      'minute',
      'month',
      'month_of_year',
      'predicted_spend_tier',
      'quarter',
      'referrer_domain',
      'referrer_name',
      'referrer_path',
      'referrer_site',
      'referrer_source',
      'referrer_terms',
      'referrer_url',
      'referring_channel',
      'referring_medium',
      'referring_platform',
      'rfm_group',
      'rollout_id',
      'rollout_ids',
      'rollout_treatment_id',
      'rollout_treatment_ids',
      'second',
      'session_api_client',
      'session_bounced',
      'session_city',
      'session_country',
      'session_country_code',
      'session_device_browser',
      'session_device_browser_version',
      'session_device_os',
      'session_device_os_version',
      'session_device_type',
      'session_duration',
      'session_id',
      'session_region',
      'shop_id',
      'shop_name',
      'traffic_type',
      'utm_campaign',
      'utm_content',
      'utm_medium',
      'utm_source',
      'utm_term',
      'week',
      'week_of_year',
      'year',
    ],
  },
  customers: {
    metrics: [
      'days_since_last_order',
      'new_customer_records',
      'percent_of_customers',
      'total_amount_spent',
      'total_amount_spent_per_order',
      'total_number_of_orders',
    ],
    dimensions: [
      'abandoned_checkout_date',
      'customer_account_status',
      'customer_added_date',
      'customer_amount_spent',
      'customer_cities',
      'customer_city',
      'customer_cohort_month',
      'customer_cohort_quarter',
      'customer_cohort_week',
      'customer_countries',
      'customer_country',
      'customer_created_by_app_id',
      'customer_email',
      'customer_email_domain',
      'customer_email_subscription_status',
      'customer_first_order_date',
      'customer_id',
      'customer_language',
      'customer_last_order_date',
      'customer_name',
      'customer_number_of_orders',
      'customer_region',
      'customer_regions',
      'customer_sms_subscription_status',
      'customer_tag',
      'customer_tags',
      'day',
      'day_of_week',
      'hour',
      'hour_of_day',
      'minute',
      'month',
      'month_of_year',
      'predicted_spend_tier',
      'quarter',
      'rfm_group',
      'second',
      'shop_id',
      'shop_name',
      'week',
      'week_of_year',
      'year',
    ],
  },
  sales: {
    metrics: [
      'amount_spent_per_customer',
      'average_order_value',
      'cost_of_goods_sold',
      'customers',
      'discounts',
      'duties',
      'gross_margin',
      'gross_profit',
      'gross_returns',
      'gross_sales',
      'line_item_discounts',
      'net_items_sold',
      'net_returns',
      'net_sales',
      'new_customers',
      'number_of_orders_per_customer',
      'order_level_discounts',
      'orders',
      'orders_first_time',
      'orders_returning',
      'quantity_ordered',
      'quantity_ordered_per_order',
      'quantity_returned',
      'returning_customer_rate',
      'returning_customers',
      'returns',
      'shipping_charges',
      'taxes',
      'tips',
      'total_returns',
      'total_sales',
      'total_sales_first_time',
      'total_sales_returning',
    ],
    dimensions: [
      'billing_country',
      'channel_id',
      'customer_cohort_month',
      'customer_email',
      'customer_id',
      'customer_name',
      'day',
      'day_of_week',
      'discount_code',
      'discount_type',
      'hour',
      'hour_of_day',
      'is_discounted_sale',
      'is_pos_sale',
      'is_return_related',
      'market',
      'month',
      'month_of_year',
      'months_since_first_purchase',
      'new_or_returning_customer',
      'order_fulfillment_status',
      'order_id',
      'order_name',
      'order_payment_status',
      'order_referrer_source',
      'order_risk_level',
      'order_sales_channel',
      'order_tag',
      'order_tags',
      'order_utm_campaign',
      'order_utm_medium',
      'order_utm_source',
      'product_collection',
      'product_id',
      'product_tag',
      'product_title',
      'product_type',
      'product_variant_id',
      'product_variant_sku',
      'product_variant_title',
      'product_vendor',
      'quarter',
      'referring_channel',
      'return_reason',
      'rfm_group',
      'sales_channel',
      'shipping_city',
      'shipping_country',
      'shipping_region',
      'subscription_or_one_time',
      'traffic_type',
      'week',
      'week_of_year',
      'year',
    ],
  },
  campaign_sessions: {
    metrics: [
      'campaign_added_to_cart_rate',
      'campaign_average_session_duration',
      'campaign_bounce_rate',
      'campaign_bounces',
      'campaign_checkout_conversion_rate',
      'campaign_completed_checkout_rate',
      'campaign_conversion_rate',
      'campaign_online_store_visitors',
      'campaign_pageviews',
      'campaign_pageviews_per_session',
      'campaign_reached_checkout_rate',
      'campaign_sessions',
      'campaign_sessions_that_completed_checkout',
      'campaign_sessions_that_reached_and_completed_checkout',
      'campaign_sessions_that_reached_checkout',
      'campaign_sessions_with_cart_additions',
    ],
    dimensions: [
      'campaign_id',
      'customer_id',
      'day',
      'day_of_week',
      'hour',
      'hour_of_day',
      'landing_page_path',
      'landing_page_type',
      'landing_page_url',
      'minute',
      'month',
      'month_of_year',
      'quarter',
      'referrer_domain',
      'referrer_name',
      'referrer_path',
      'referrer_site',
      'referrer_source',
      'referrer_terms',
      'referrer_url',
      'referring_channel',
      'referring_medium',
      'referring_platform',
      'second',
      'session_api_client',
      'session_bounced',
      'session_city',
      'session_country',
      'session_country_code',
      'session_device_browser',
      'session_device_browser_version',
      'session_device_os',
      'session_device_os_version',
      'session_device_type',
      'session_duration',
      'session_id',
      'session_region',
      'shop_id',
      'shop_name',
      'traffic_type',
      'utm_campaign',
      'utm_content',
      'utm_medium',
      'utm_source',
      'utm_term',
      'week',
      'week_of_year',
      'year',
    ],
  },
  searches: {
    metrics: [
      'searches',
    ],
    dimensions: [
      'day',
      'day_of_week',
      'hour',
      'hour_of_day',
      'is_article_search_query',
      'is_page_search_query',
      'is_product_search_query',
      'minute',
      'month',
      'month_of_year',
      'quarter',
      'search_query',
      'search_query_intent',
      'search_results_were_returned',
      'second',
      'shop_id',
      'shop_name',
      'week',
      'week_of_year',
      'year',
    ],
  },
  chargebacks: {
    metrics: [
      'chargeback_amount',
      'chargeback_rate',
      'chargebacks',
      'fraudulent_chargeback_rate',
      'fraudulent_chargebacks',
      'successful_transactions',
    ],
    dimensions: [
      'chargeback_reason',
      'day',
      'day_of_week',
      'hour',
      'hour_of_day',
      'is_rapid_dispute_resolution',
      'minute',
      'month',
      'month_of_year',
      'quarter',
      'second',
      'shop_id',
      'shop_name',
      'week',
      'week_of_year',
      'year',
    ],
  },
} as const satisfies Record<string, { metrics: readonly string[]; dimensions: readonly string[] }>

export const SHOPIFYQL_SCHEMAS = Object.keys(SHOPIFYQL_CATALOG) as ShopifyqlSchemaName[]

/** The schema a query reads, or null when there is no parseable `FROM`. */
export function schemaOfQuery(query: string): string | null {
  return query.match(/\bFROM\s+([a-z_][a-z0-9_]*)/i)?.[1]?.toLowerCase() ?? null
}

/** The column name Shopify rejected, or null when the error is not a column problem. */
export function rejectedColumn(message: string): string | null {
  return message.match(/Column '([^']+)' not found/)?.[1] ?? null
}

/** Every schema in the catalog that does define `column` — the "wrong table" case. */
export function schemasDefining(column: string): ShopifyqlSchemaName[] {
  return SHOPIFYQL_SCHEMAS.filter((s) => {
    const { metrics, dimensions } = SHOPIFYQL_CATALOG[s]
    return (metrics as readonly string[]).includes(column) || (dimensions as readonly string[]).includes(column)
  })
}

/** Levenshtein distance, capped — only used to rank short field names. */
function editDistance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = tmp
    }
  }
  return prev[b.length]
}

/** Closest names within one schema, nearest first. */
export function closestFields(schema: ShopifyqlSchemaName, column: string, limit = 6): string[] {
  const all = [...SHOPIFYQL_CATALOG[schema].metrics, ...SHOPIFYQL_CATALOG[schema].dimensions] as readonly string[]
  return [...all]
    .map((name) => ({ name, d: editDistance(column.toLowerCase(), name.toLowerCase()) }))
    .sort((a, b) => a.d - b.d || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((x) => x.name)
}
