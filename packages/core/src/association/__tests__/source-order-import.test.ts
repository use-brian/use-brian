import { describe, expect, it } from 'vitest'
import { AssociationSourceOrderImportSchema } from '../domain.js'

const id = (digit: number) => `00000000-0000-4000-8000-00000000000${digit}`
const sourceOrder = {
  importJobId: id(1),
  importRow: 2,
  contactId: id(2),
  source: 'wix',
  sourceSite: 'oasahk_org',
  sourceOrderId: 'wix-order-42',
  occurredAt: '2026-08-01T10:00:00Z',
  status: 'paid' as const,
  currency: 'HKD',
  subtotalMinor: 2_000,
  discountMinor: 400,
  totalMinor: 1_600,
  refundedMinor: 200,
  provider: 'stripe',
  providerReference: 'pi_source_42',
  lines: [{
    ticketId: id(3), quantity: 2, unitPriceMinor: 1_000,
    discountMinor: 400, lineTotalMinor: 1_600,
    attendees: [
      { sourceRegistrationId: 'booking-1', contactId: id(2), name: 'First Person', status: 'confirmed' as const },
      { sourceRegistrationId: 'booking-2', name: 'Second Person', email: 'second@example.com', status: 'checked_in' as const, checkedInAt: '2026-08-02T10:00:00Z' },
    ],
  }],
}

describe('[COMP:crm/production-import] source order evidence', () => {
  it('accepts exact discounted and partially refunded source money', () => {
    expect(AssociationSourceOrderImportSchema.parse(sourceOrder)).toMatchObject(sourceOrder)
  })

  it('requires line and order money to reconcile', () => {
    expect(AssociationSourceOrderImportSchema.safeParse({ ...sourceOrder, totalMinor: 1_599 }).success).toBe(false)
    expect(AssociationSourceOrderImportSchema.safeParse({ ...sourceOrder,
      lines: [{ ...sourceOrder.lines[0], lineTotalMinor: 1_599 }] }).success).toBe(false)
  })

  it('requires provider and reservation evidence in complete pairs', () => {
    expect(AssociationSourceOrderImportSchema.safeParse({ ...sourceOrder, providerReference: undefined }).success).toBe(false)
    expect(AssociationSourceOrderImportSchema.safeParse({ ...sourceOrder, status: 'pending', refundedMinor: 0 }).success).toBe(false)
  })

  it('rejects attendee state conflicts and reused source registrations', () => {
    const duplicate = { ...sourceOrder, lines: [{ ...sourceOrder.lines[0], attendees: [
      sourceOrder.lines[0].attendees[0],
      { ...sourceOrder.lines[0].attendees[1], sourceRegistrationId: 'booking-1' },
    ] }] }
    expect(AssociationSourceOrderImportSchema.safeParse(duplicate).success).toBe(false)
    expect(AssociationSourceOrderImportSchema.safeParse({ ...sourceOrder, lines: [{
      ...sourceOrder.lines[0], attendees: sourceOrder.lines[0].attendees.map((attendee) => ({ ...attendee, status: 'reserved' })),
    }] }).success).toBe(false)
  })
})
