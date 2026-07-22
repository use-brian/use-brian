/**
 * Shopify webhook receiver — the mandatory compliance topics
 * (`customers/data_request`, `customers/redact`, `shop/redact`).
 *
 * Mounted PUBLIC at `/webhook/shopify` (apps/api `mountClosedRoutes`, next to
 * the Stripe receiver — NOT under `/api/*`, so the bare `/api` requireAuth
 * guards can never shadow it). Shopify signs every delivery with
 * `X-Shopify-Hmac-Sha256` (base64 HMAC-SHA256 of the raw body, keyed by the
 * app client secret) and expects a 2xx within ~5s — verify, ack, then act.
 *
 * With no app client secret configured (`SHOPIFY_CLIENT_ID`/`SECRET` unset —
 * P0 registration pending) the receiver fails CLOSED: every delivery gets a
 * 401 and a one-time log line. Code-complete but inert.
 *
 * v1 actions (docs/architecture/integrations/shopify.md → "Compliance webhook
 * receiver"): the customer topics only ack — v1 persists no customer data
 * (tools cache nothing; the ingest adapter is P3, which wires these to the
 * erasure/export surface). `shop/redact` purges the shop's connector
 * instance(s). Ingest topics (orders/create, app/uninstalled, …) are P3 and
 * slot into the same topic switch.
 *
 * Component tag: [COMP:api/shopify-webhooks].
 */

import { Router } from 'express'
import { getConnectorConfig } from '../connector-config.js'
import { normalizeShopDomain, verifyShopifyWebhookHmac } from '../shopify/client.js'
import type { ConnectorInstanceStore } from '../db/connector-instance-store.js'

export type ShopifyWebhookRouteOptions = {
  connectorInstanceStore: ConnectorInstanceStore
  /**
   * Resolves the app client secret keying the HMAC. Defaults to
   * `getConnectorConfig('shopify')` (file → SHOPIFY_CLIENT_SECRET env).
   * Test seam.
   */
  getClientSecret?: () => string | undefined
  /**
   * P3 ingest seam: fired (after the 200 ack) for every verified
   * NON-compliance topic — the platform wires the Pipeline B handler
   * (`createShopifyWebhookIngestHandler`) here. Absent → deliveries are
   * acked and dropped (compliance handling is unaffected).
   */
  onIngestEvent?: (topic: string, shopDomain: string, payload: unknown) => Promise<void>
}

/** Resolve every connector instance bound to a shop domain (config.shopDomain). */
export async function findShopifyInstancesByShopDomain(
  store: ConnectorInstanceStore,
  shopDomain: string,
): Promise<Array<{ id: string }>> {
  const normalized = normalizeShopDomain(shopDomain)
  if (!normalized) return []
  const instances = await store.listByProviderSystem('shopify')
  return instances.filter((inst) => {
    const cfg = (inst.config ?? {}) as { shopDomain?: unknown }
    return typeof cfg.shopDomain === 'string' && normalizeShopDomain(cfg.shopDomain) === normalized
  })
}

export function shopifyWebhookRoutes(options: ShopifyWebhookRouteOptions): Router {
  const router = Router()
  const getClientSecret =
    options.getClientSecret ?? (() => getConnectorConfig('shopify')?.clientSecret)
  let warnedInert = false

  router.post('/', (req, res) => {
    const clientSecret = getClientSecret()
    if (!clientSecret) {
      // Inert mode (P0 registration pending): fail closed. Shopify keeps
      // retrying / flags the endpoint, which is honest — we cannot verify.
      if (!warnedInert) {
        warnedInert = true
        console.warn('[shopify-webhook] SHOPIFY_CLIENT_SECRET not configured; rejecting deliveries (401)')
      }
      res.status(401).json({ error: 'Webhook verification not configured' })
      return
    }

    // Raw body captured by the global express.json verify hook; fall back to
    // a Buffer body for a route-level raw parser (workflow-webhooks pattern).
    const rawBody = (req as typeof req & { rawBody?: string }).rawBody
    const body: Buffer | string | null =
      typeof rawBody === 'string' ? rawBody
        : Buffer.isBuffer(req.body) ? req.body
          : null
    if (body === null) {
      console.error('[shopify-webhook] raw body not captured; HMAC verification impossible')
      res.status(500).json({ error: 'Missing raw body' })
      return
    }

    if (!verifyShopifyWebhookHmac(body, req.header('x-shopify-hmac-sha256'), clientSecret)) {
      res.status(401).json({ error: 'Invalid signature' })
      return
    }

    const topic = req.header('x-shopify-topic') ?? ''
    const shopDomain = req.header('x-shopify-shop-domain') ?? ''
    const payload = req.body

    // Ack immediately (Shopify's ~5s timeout), then act.
    res.status(200).send('ok')

    void handleTopic(topic, shopDomain, payload, options).catch((err) => {
      console.error(`[shopify-webhook] ${topic} handling failed:`, err)
    })
  })

  return router
}

async function handleTopic(
  topic: string,
  shopDomain: string,
  payload: unknown,
  options: ShopifyWebhookRouteOptions,
): Promise<void> {
  const store = options.connectorInstanceStore
  switch (topic) {
    case 'customers/data_request':
      // Ingested episodes deliberately carry no customer PII until the
      // protected-customer-data Level 2 review clears (adapter redaction,
      // plan §7/D10), so there is nothing customer-linked to export yet.
      // When PII starts flowing post-Level-2, this wires to the export
      // surface. Logged for the 30-day compliance audit trail.
      console.log(`[shopify-webhook] customers/data_request from ${shopDomain}: no stored customer PII (pre-Level-2 redaction)`)
      return
    case 'customers/redact':
      // Same reasoning: the adapter strips customer fields before anything
      // is persisted, so episodes hold order metadata only.
      console.log(`[shopify-webhook] customers/redact from ${shopDomain}: no stored customer PII (pre-Level-2 redaction)`)
      return
    case 'shop/redact': {
      // ~48h after uninstall: purge every instance bound to the shop.
      const instances = await findShopifyInstancesByShopDomain(store, shopDomain)
      for (const inst of instances) {
        await store.deleteSystem(inst.id)
      }
      console.log(`[shopify-webhook] shop/redact from ${shopDomain}: purged ${instances.length} connector instance(s)`)
      return
    }
    case 'app/uninstalled': {
      // Lifecycle: the token is dead the moment the app is uninstalled —
      // mark the instance(s) disconnected so injection stops cleanly.
      // Shopify drops the API-created webhook subscriptions itself.
      const instances = await findShopifyInstancesByShopDomain(store, shopDomain)
      for (const inst of instances) {
        await store.setConnectedSystem(inst.id, false)
      }
      console.log(`[shopify-webhook] app/uninstalled from ${shopDomain}: disconnected ${instances.length} instance(s)`)
      return
    }
    default:
      // Ingest topics (orders/*, refunds/create, disputes/create) → the
      // Pipeline B seam when wired; unknown topics are acked and logged.
      if (options.onIngestEvent) {
        await options.onIngestEvent(topic, shopDomain, payload)
        return
      }
      console.log(`[shopify-webhook] unhandled topic ${topic} from ${shopDomain}`)
  }
}
