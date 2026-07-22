import { describe, expect, it } from 'vitest'

import { episodeEnvelopeSchema } from '../../../schemas.js'
import {
  shopifyDefaultRules,
  shopifyFilterImplementations,
  shopifyIngestAdapter,
  normalizeShopifyWebhook,
  toShopifyEpisodeEnvelope,
} from '../index.js'
import type {
  ShopifyDeliveryContext,
  ShopifyNormalizedEvent,
  ShopifyWebhookInput,
} from '../types.js'

const SHOP = 'acme.myshopify.com'
const RECEIVED_AT = new Date('2026-07-20T20:00:00.000Z')

function makeCtx(overrides: Partial<ShopifyDeliveryContext> = {}): ShopifyDeliveryContext {
  return {
    workspace_id: 'ws-1',
    user_id: 'u-1',
    assistant_id: null,
    created_by_user_id: 'u-1',
    created_by_assistant_id: null,
    connector_id: 'shopify-instance-1',
    shop_domain: SHOP,
    ...overrides,
  }
}

function makeInput(opts: {
  topic: string
  payload: Record<string, unknown>
  ctx?: Partial<ShopifyDeliveryContext>
}): ShopifyWebhookInput {
  return {
    topic: opts.topic,
    payload: opts.payload,
    shopDomain: SHOP,
    deliveryContext: makeCtx(opts.ctx),
  }
}

/** An orders/create body carrying customer PII that must never survive normalize. */
function orderWithPii(): Record<string, unknown> {
  return {
    id: 8209829119461540,
    name: '#1042',
    order_number: 1042,
    total_price: '532.00',
    subtotal_price: '500.00',
    total_tax: '32.00',
    currency: 'USD',
    financial_status: 'paid',
    fulfillment_status: null,
    created_at: '2026-07-20T10:00:00-04:00',
    customer: {
      first_name: 'Jane',
      last_name: 'Doe',
      email: 'jane@example.com',
      phone: '+15551234567',
    },
    email: 'jane@example.com',
    contact_email: 'jane@example.com',
    phone: '+15551234567',
    billing_address: { address1: '1 Main St', city: 'Anytown', zip: '00000', name: 'Jane Doe' },
    shipping_address: { address1: '1 Main St', city: 'Anytown', zip: '00000', name: 'Jane Doe' },
    line_items: [
      { title: 'Blue Widget', quantity: 2, price: '200.00', sku: 'BW-1', vendor: 'Acme' },
      { title: 'Red Gadget', quantity: 1, price: '132.00' },
    ],
  }
}

describe('[COMP:brain/source-adapters/shopify] Shopify source adapter', () => {
  describe('normalize — topic mapping', () => {
    const cases: Array<[string, ShopifyNormalizedEvent['event_type']]> = [
      ['orders/create', 'order.created'],
      ['orders/fulfilled', 'order.fulfilled'],
      ['orders/cancelled', 'order.cancelled'],
      ['refunds/create', 'refund.created'],
      ['disputes/create', 'dispute.created'],
    ]

    for (const [topic, expected] of cases) {
      it(`${topic} → "${expected}"`, () => {
        const ev = normalizeShopifyWebhook(makeInput({ topic, payload: {} }), RECEIVED_AT)
        expect(ev?.event_type).toBe(expected)
      })
    }

    it('app/uninstalled (lifecycle) → null', () => {
      expect(
        normalizeShopifyWebhook(makeInput({ topic: 'app/uninstalled', payload: {} }), RECEIVED_AT),
      ).toBeNull()
    })

    it('customers/redact (compliance) → null', () => {
      expect(
        normalizeShopifyWebhook(makeInput({ topic: 'customers/redact', payload: {} }), RECEIVED_AT),
      ).toBeNull()
    })

    it('inventory_levels/update (unknown topic) → null', () => {
      expect(
        normalizeShopifyWebhook(
          makeInput({ topic: 'inventory_levels/update', payload: {} }),
          RECEIVED_AT,
        ),
      ).toBeNull()
    })
  })

  describe('normalize — order value + fields', () => {
    it('parses name, total, currency, item titles, and count', () => {
      const ev = normalizeShopifyWebhook(
        makeInput({ topic: 'orders/create', payload: orderWithPii() }),
        RECEIVED_AT,
      )!
      expect(ev.order_name).toBe('#1042')
      expect(ev.total_amount).toBe(532)
      expect(ev.currency).toBe('USD')
      expect(ev.item_titles).toEqual(['Blue Widget', 'Red Gadget'])
      expect(ev.items_count).toBe(2)
      expect(ev.occurred_at).toEqual(new Date('2026-07-20T10:00:00-04:00'))
    })

    it('caps item_titles at 10', () => {
      const line_items = Array.from({ length: 15 }, (_, i) => ({ title: `Item ${i}`, quantity: 1 }))
      const ev = normalizeShopifyWebhook(
        makeInput({ topic: 'orders/create', payload: { name: '#2', total_price: '10.00', line_items } }),
        RECEIVED_AT,
      )!
      expect(ev.item_titles).toHaveLength(10)
      expect(ev.items_count).toBe(15)
    })

    it('refund sums transaction amounts and carries order_id, order_name null', () => {
      const ev = normalizeShopifyWebhook(
        makeInput({
          topic: 'refunds/create',
          payload: { order_id: 8209829119461540, transactions: [{ amount: '10.00' }, { amount: '5.50' }] },
        }),
        RECEIVED_AT,
      )!
      expect(ev.event_type).toBe('refund.created')
      expect(ev.total_amount).toBe(15.5)
      expect(ev.order_name).toBeNull()
      expect(ev.payload.order_id).toBe(8209829119461540)
    })

    it('refund with no transactions → total_amount null', () => {
      const ev = normalizeShopifyWebhook(
        makeInput({ topic: 'refunds/create', payload: { order_id: 1 } }),
        RECEIVED_AT,
      )!
      expect(ev.total_amount).toBeNull()
    })

    it('dispute parses amount + currency, order_name null', () => {
      const ev = normalizeShopifyWebhook(
        makeInput({ topic: 'disputes/create', payload: { amount: '99.99', currency: 'USD' } }),
        RECEIVED_AT,
      )!
      expect(ev.event_type).toBe('dispute.created')
      expect(ev.total_amount).toBe(99.99)
      expect(ev.currency).toBe('USD')
      expect(ev.order_name).toBeNull()
    })

    it('falls back to receivedAt when no timestamp present', () => {
      const ev = normalizeShopifyWebhook(
        makeInput({ topic: 'orders/create', payload: { name: '#3', total_price: '1.00' } }),
        RECEIVED_AT,
      )!
      expect(ev.occurred_at).toEqual(RECEIVED_AT)
    })
  })

  describe('PII redaction (D10 / §7)', () => {
    it('strips customer name/email/phone/address from event and envelope', () => {
      const ev = normalizeShopifyWebhook(
        makeInput({ topic: 'orders/create', payload: orderWithPii() }),
        RECEIVED_AT,
      )!
      const envelope = toShopifyEpisodeEnvelope(ev, makeCtx())

      for (const json of [JSON.stringify(ev), JSON.stringify(envelope)]) {
        expect(json).not.toContain('jane@example.com')
        expect(json).not.toContain('Jane')
        expect(json).not.toContain('Main St')
        expect(json).not.toContain('customer')
        expect(json).not.toContain('billing_address')
        expect(json).not.toContain('shipping_address')
        expect(json).not.toContain('contact_email')
        expect(json).not.toContain('+15551234567')
      }

      // The redacted payload keeps operational metadata + reduced line items only.
      expect(ev.payload).toMatchObject({ name: '#1042', total_price: '532.00', currency: 'USD' })
      expect(ev.payload.line_items).toEqual([
        { title: 'Blue Widget', quantity: 2, price: '200.00' },
        { title: 'Red Gadget', quantity: 1, price: '132.00' },
      ])
      expect(ev.payload.customer).toBeUndefined()
      expect(ev.payload.email).toBeUndefined()
    })
  })

  describe('filter implementations', () => {
    function orderEvent(overrides: Partial<ShopifyNormalizedEvent> = {}): ShopifyNormalizedEvent {
      return {
        event_type: 'order.created',
        occurred_at: RECEIVED_AT,
        shop_domain: SHOP,
        order_name: '#1042',
        total_amount: 532,
        currency: 'USD',
        item_titles: ['Blue Widget'],
        items_count: 1,
        payload: {},
        ...overrides,
      }
    }

    it('event_type matches and misses', () => {
      expect(
        shopifyFilterImplementations.event_type(orderEvent(), { values: ['order.created'] }),
      ).toBe(true)
      expect(
        shopifyFilterImplementations.event_type(orderEvent(), { values: ['order.cancelled'] }),
      ).toBe(false)
    })

    it('order_value_gte matches at and above the threshold (boundary inclusive)', () => {
      expect(shopifyFilterImplementations.order_value_gte(orderEvent(), { amount: 500 })).toBe(true)
      expect(shopifyFilterImplementations.order_value_gte(orderEvent(), { amount: 532 })).toBe(true)
      expect(shopifyFilterImplementations.order_value_gte(orderEvent(), { amount: 600 })).toBe(false)
    })

    it('order_value_gte is false when the event has a null amount (refund/dispute)', () => {
      expect(
        shopifyFilterImplementations.order_value_gte(orderEvent({ total_amount: null }), {
          amount: 500,
        }),
      ).toBe(false)
    })

    it('order_value_gte is false when the threshold param is missing/non-numeric', () => {
      expect(
        shopifyFilterImplementations.order_value_gte(orderEvent(), {} as { amount: number }),
      ).toBe(false)
    })
  })

  describe('default rules — digest-first (§7)', () => {
    it('has 4 rules in order, disputes alert first, digest last', () => {
      expect(shopifyDefaultRules).toHaveLength(4)
      expect(shopifyDefaultRules[0]).toMatchObject({
        filter_type: 'event_type',
        params: { values: ['dispute.created'] },
        routing_mode: 'realtime',
        alert: true,
      })
      expect(shopifyDefaultRules[1]).toMatchObject({
        filter_type: 'event_type',
        params: { values: ['order.cancelled', 'refund.created'] },
        routing_mode: 'realtime',
      })
      expect(shopifyDefaultRules[2]).toMatchObject({
        filter_type: 'order_value_gte',
        params: { amount: 500 },
        routing_mode: 'realtime',
        alert: true,
      })
      expect(shopifyDefaultRules[3]).toMatchObject({
        filter_type: 'always',
        routing_mode: 'scheduled',
        routing_schedule: '0 18 * * *',
      })
    })
  })

  describe('envelope — connector_action shape', () => {
    it('order → connector_action with external_id = order name, default sensitivity internal', () => {
      const ev = normalizeShopifyWebhook(
        makeInput({ topic: 'orders/create', payload: orderWithPii() }),
        RECEIVED_AT,
      )!
      const envelope = toShopifyEpisodeEnvelope(ev, makeCtx())
      expect(envelope.source_kind).toBe('connector_action')
      expect(envelope.source_ref).toMatchObject({
        source_kind: 'connector_action',
        connector_id: 'shopify-instance-1',
        action_kind: 'order.created',
        shop_domain: SHOP,
        external_id: '#1042',
      })
      expect(envelope.actors).toEqual([])
      expect(envelope.sensitivity).toBe('internal')
      expect(() => episodeEnvelopeSchema.parse(envelope)).not.toThrow()
    })

    it('honors an explicit sensitivity from the delivery context', () => {
      const ev = normalizeShopifyWebhook(
        makeInput({ topic: 'disputes/create', payload: { amount: '10.00' } }),
        RECEIVED_AT,
      )!
      const envelope = toShopifyEpisodeEnvelope(ev, makeCtx({ sensitivity: 'confidential' }))
      expect(envelope.sensitivity).toBe('confidential')
    })

    it('omits external_id when there is no order name (refund/dispute)', () => {
      const ev = normalizeShopifyWebhook(
        makeInput({ topic: 'refunds/create', payload: { order_id: 1, transactions: [{ amount: '5.00' }] } }),
        RECEIVED_AT,
      )!
      const envelope = toShopifyEpisodeEnvelope(ev, makeCtx())
      expect(envelope.source_ref.external_id).toBeUndefined()
      expect(() => episodeEnvelopeSchema.parse(envelope)).not.toThrow()
    })
  })

  describe('adapter.receive — orchestration', () => {
    it('returns [] for a topic outside the rule templates', async () => {
      await expect(
        shopifyIngestAdapter.receive(makeInput({ topic: 'app/uninstalled', payload: {} })),
      ).resolves.toEqual([])
    })

    it('emits one envelope for a mapped topic', async () => {
      const [envelope] = await shopifyIngestAdapter.receive(
        makeInput({ topic: 'orders/create', payload: orderWithPii() }),
      )
      expect(envelope.source_ref).toMatchObject({ action_kind: 'order.created', external_id: '#1042' })
    })
  })
})
