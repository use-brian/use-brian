import { describe, expect, it } from 'vitest'
import { AssociationCommandSchema } from '../operations.js'
import { AssociationOrderFinancialSummarySchema, AssociationProviderFinancialEventInputSchema } from '../domain.js'
import { ProviderInboxEnvelopeSchema } from '../provider-inbox.js'

const event = {
  provider: 'stripe', providerReference: 'cs_fixture', adjustmentReference: 're_fixture',
  eventId: 'evt_fixture', kind: 'refund' as const, status: 'succeeded' as const,
  amountMinor: 400, currency: 'USD', occurredAt: '2026-09-01T01:00:00Z', metadata: {},
}

describe('association financial evidence contracts', () => {
  it('admits a closed refund command and order inbox envelope', () => {
    expect(AssociationProviderFinancialEventInputSchema.parse(event)).toEqual(event)
    expect(AssociationCommandSchema.parse({ kind: 'reconcile_provider_financial_event',
      orderId: '11111111-1111-4111-8111-111111111111', event })).toMatchObject({ event })
    expect(ProviderInboxEnvelopeSchema.parse({ target: 'order',
      orderId: '11111111-1111-4111-8111-111111111111', event })).toMatchObject({ event })
  })

  it('rejects mixed refund/dispute states, zero money, lowercase currency and extra payload', () => {
    for (const candidate of [
      { ...event, status: 'open' },
      { ...event, kind: 'dispute', status: 'succeeded' },
      { ...event, amountMinor: 0 },
      { ...event, currency: 'usd' },
      { ...event, rawProviderObject: {} },
    ]) expect(AssociationProviderFinancialEventInputSchema.safeParse(candidate).success).toBe(false)
  })

  it('keeps aggregate money as exact nonnegative decimal strings', () => {
    const summary = { currency: 'USD', orderCount: 3, settledOrderCount: 2, subtotalMinor: '2000', discountMinor: '200',
      grossMinor: '1800', refundedMinor: '400', netMinor: '1400', pendingMinor: '100' }
    expect(AssociationOrderFinancialSummarySchema.parse(summary)).toEqual(summary)
    expect(AssociationOrderFinancialSummarySchema.safeParse({ ...summary, netMinor: '-1' }).success).toBe(false)
  })
})
