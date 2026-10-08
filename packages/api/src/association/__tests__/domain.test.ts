import { describe, expect, it } from 'vitest'
import {
  associationFingerprint,
  ListPageSchema,
  EnquiryCreateSchema,
  EventInputSchema,
  mayTransitionRegistration,
  mayTransitionOrder,
  OrderCreateSchema,
  ProviderEventInputSchema,
  PromotionImportSchema,
  PromotionInputSchema,
  SourceMembershipImportSchema,
  TicketInputSchema,
} from '../domain.js'

const CONTACT_ID = '11111111-1111-4111-8111-111111111111'
const TICKET_ID = '22222222-2222-4222-8222-222222222222'

describe('[COMP:crm/association-domain] bounded domain contracts', () => {
  it('requires an exact, bounded monetary identity on normalized provider evidence', () => {
    const event = { provider: 'fixture', providerReference: 'fictional-object', amountMinor: 1000, currency: 'USD', eventId: 'fictional-event', targetStatus: 'paid', occurredAt: '2026-09-01T00:00:00Z' }
    expect(ProviderEventInputSchema.safeParse(event).success).toBe(true)
    for (const patch of [{ amountMinor: undefined }, { amountMinor: -1 }, { amountMinor: Number.MAX_SAFE_INTEGER + 1 }, { currency: 'usd' }, { providerReference: undefined }, { redirectPaid: true }])
      expect(ProviderEventInputSchema.safeParse({ ...event, ...patch }).success).toBe(false)
  })
  it('applies deterministic intake defaults', () => {
    const parsed = EnquiryCreateSchema.parse({
      contactId: CONTACT_ID,
      source: 'website',
      sourceSubmissionId: 'submission-1',
      subject: 'Membership question',
      message: 'Could you tell me which plan applies?',
    })
    expect(parsed.queueKey).toBe('general')
    expect(parsed.submittedData).toEqual({})
  })

  it('rejects invalid event windows and oversized flexible payloads', () => {
    expect(EventInputSchema.safeParse({
      slug: 'annual-forum',
      title: 'Annual Forum',
      startsAt: '2027-02-02T11:00:00.000Z',
      endsAt: '2027-02-02T10:00:00.000Z',
      timezone: 'Asia/Hong_Kong',
      mode: 'venue',
    }).success).toBe(false)

    expect(EnquiryCreateSchema.safeParse({
      contactId: CONTACT_ID,
      source: 'website',
      sourceSubmissionId: 'submission-2',
      subject: 'Question',
      message: 'Hello',
      submittedData: { importBlob: 'x'.repeat(33_000) },
    }).success).toBe(false)
  })

  it('distinguishes an explicit order destination from omission and rejects ambiguous choices', () => {
    const order = { contactId: CONTACT_ID, idempotencyKey: 'destination-choice', lines: [{ ticketId: TICKET_ID, quantity: 1, attendees: [{ name: 'Fictional attendee' }] }] }
    expect(OrderCreateSchema.parse(order).destination).toBeUndefined()
    for (const destination of [{ kind: 'general' }, { kind: 'department', departmentId: CONTACT_ID }]) {
      expect(OrderCreateSchema.parse({ ...order, destination }).destination).toEqual(destination)
    }
    for (const destination of [null, { kind: 'department' }, { kind: 'general', departmentId: CONTACT_ID }, { kind: 'department', departmentId: 'unavailable' }]) {
      expect(OrderCreateSchema.safeParse({ ...order, destination }).success).toBe(false)
    }
  })

  it('requires one attendee per reserved place', () => {
    const result = OrderCreateSchema.safeParse({
      contactId: CONTACT_ID,
      idempotencyKey: 'checkout-1',
      lines: [{
        ticketId: TICKET_ID,
        quantity: 2,
        attendees: [{ name: 'Example Attendee' }],
      }],
    })
    expect(result.success).toBe(false)
  })

  it('defaults ticket eligibility to the buyer and bounds attendee admission', () => {
    const base = { key: 'member', name: 'Member ticket', currency: 'USD', priceMinor: 100 }
    expect(TicketInputSchema.parse(base)).toMatchObject({ eligibilityRequired: false, eligibilityScope: 'buyer' })
    expect(TicketInputSchema.parse({ ...base, memberPriceMinor: 25, eligiblePlanKeys: ['member'] }).eligibilityRequired).toBe(true)
    expect(TicketInputSchema.safeParse({ ...base, memberPriceMinor: 25, eligiblePlanKeys: ['member'], eligibilityRequired: true, eligibilityScope: 'buyer_and_attendees' }).success).toBe(true)
    expect(TicketInputSchema.safeParse({ ...base, eligibilityRequired: true }).success).toBe(false)
    expect(TicketInputSchema.safeParse({ ...base, memberPriceMinor: 25, eligibilityScope: 'attendees' }).success).toBe(false)
  })

  it('requires explicit, bounded promotion terms without accepting a stored-code field', () => {
    const base = { key: 'member-ten', name: 'Member 10%', code: 'EXAMPLE10', discountType: 'percentage' as const,
      percentageBasisPoints: 1_000, targetKind: 'event' as const, targetIds: [TICKET_ID] }
    expect(PromotionInputSchema.parse(base)).toMatchObject({ combinesWithMemberPrice: false, releaseOnFullRefund: false, status: 'draft' })
    expect(PromotionInputSchema.safeParse({ ...base, percentageBasisPoints: null }).success).toBe(false)
    expect(PromotionInputSchema.safeParse({ ...base, discountType: 'full', percentageBasisPoints: 1_000 }).success).toBe(false)
    expect(PromotionInputSchema.safeParse({ ...base, discountType: 'buy_x_get_y', percentageBasisPoints: undefined, buyQuantity: 1, getQuantity: 1 }).success).toBe(true)
    expect(PromotionInputSchema.safeParse({ ...base, discountType: 'fixed_amount', percentageBasisPoints: undefined,
      amountMinor: 2_500, currency: 'HKD', targetKind: 'plan', recurrenceMode: 'repeating', recurrenceCycles: 3,
      applyMode: 'once_per_order' }).success).toBe(true)
    expect(PromotionInputSchema.safeParse({ ...base, targetKind: 'plan', recurrenceMode: 'repeating' }).success).toBe(false)
    expect(PromotionInputSchema.safeParse({ ...base, targetKind: 'event', recurrenceMode: 'forever' }).success).toBe(false)
    expect(PromotionInputSchema.safeParse({ ...base, codeDigest: 'a'.repeat(64) }).success).toBe(false)
  })

  it('admits digest-only promotion imports and requires complete history for per-contact caps', () => {
    const promotion = {
      key: 'member-ten', name: 'Member 10%', discountType: 'percentage' as const,
      percentageBasisPoints: 1_000, targetKind: 'event' as const, targetIds: [TICKET_ID],
      maxUses: 20, maxUsesPerContact: 2, status: 'active' as const,
    }
    const source = {
      importJobId: '33333333-3333-4333-8333-333333333333', importRow: 2,
      source: 'wix', sourceSite: 'oasahk.org', sourcePromotionId: 'coupon-1',
      codeDigest: 'a'.repeat(64), promotion, sourceRedeemedUses: 2,
      sourceContactUses: [{ contactId: CONTACT_ID, uses: 2 }],
    }
    expect(PromotionImportSchema.parse(source)).toMatchObject(source)
    expect(PromotionImportSchema.safeParse({ ...source, promotion: { ...promotion, code: 'PLAINTEXT' } }).success).toBe(false)
    expect(PromotionImportSchema.safeParse({ ...source, sourceContactUses: [] }).success).toBe(false)
    expect(PromotionImportSchema.safeParse({ ...source, sourceRedeemedUses: 21 }).success).toBe(false)
    expect(PromotionImportSchema.safeParse({ ...source,
      sourceContactUses: [{ contactId: CONTACT_ID, uses: 3 }] }).success).toBe(false)
  })

  it('separates imported membership lineage from provider and automatic-renewal authority', () => {
    const source = {
      importJobId: '33333333-3333-4333-8333-333333333333', importRow: 2,
      contactId: CONTACT_ID, planId: TICKET_ID, idempotencyKey: 'wix-membership:source-1',
      status: 'active' as const, startsAt: '2026-08-01T00:00:00Z', endsAt: '2027-08-01T00:00:00Z',
      source: 'wix', sourceSite: 'oasahk.org', sourceMembershipId: 'source-1',
      sourcePlanId: 'plan-1', sourceSubscriptionId: 'subscription-1',
      sourcePaymentProvider: 'stripe', sourcePaymentReference: 'sub_source_1',
      sourceStatus: 'ACTIVE', sourceRenewalStatus: 'AUTO_RENEWING',
      purchasedAt: '2026-08-01T00:00:00Z', relationships: { companyId: 'company-1' },
    }
    expect(SourceMembershipImportSchema.parse(source)).toMatchObject({ ...source, targetRenewalMode: 'none' })
    expect(SourceMembershipImportSchema.safeParse({ ...source, targetRenewalMode: 'auto' }).success).toBe(false)
    expect(SourceMembershipImportSchema.safeParse({ ...source, sourcePaymentReference: undefined }).success).toBe(false)
    expect(SourceMembershipImportSchema.safeParse({ ...source, cancelledAt: '2026-07-01T00:00:00Z' }).success).toBe(false)
  })

  it('fingerprints equivalent object key order identically', () => {
    expect(associationFingerprint({ b: 2, a: { d: 4, c: 3 } })).toBe(
      associationFingerprint({ a: { c: 3, d: 4 }, b: 2 }),
    )
  })

  it('permits only named order transitions', () => {
    expect(mayTransitionOrder('pending', 'paid')).toBe(true)
    expect(mayTransitionOrder('paid', 'refunded')).toBe(true)
    expect(mayTransitionOrder('paid', 'failed')).toBe(false)
    expect(mayTransitionOrder('refunded', 'paid')).toBe(false)
    expect(mayTransitionRegistration('confirmed', 'checked_in')).toBe(true)
    expect(mayTransitionRegistration('reserved', 'checked_in')).toBe(false)
  })

  it('requires an IANA timezone instead of an arbitrary display label', () => {
    const base = {
      slug: 'annual-forum',
      title: 'Annual Forum',
      startsAt: '2027-02-02T10:00:00.000Z',
      endsAt: '2027-02-02T11:00:00.000Z',
      mode: 'venue' as const,
    }
    expect(EventInputSchema.safeParse({ ...base, timezone: 'Asia/Hong_Kong' }).success).toBe(true)
    expect(EventInputSchema.safeParse({ ...base, timezone: 'Hong Kong time' }).success).toBe(false)
  })

  it('bounds page inputs while leaving query binding to the authoritative store', () => {
    expect(ListPageSchema.parse({ limit: 7, cursor: 'opaque', createdAfter: '2026-01-01T00:00:00Z' }))
      .toEqual({ limit: 7, cursor: 'opaque', createdAfter: '2026-01-01T00:00:00Z' })
    expect(ListPageSchema.safeParse({ limit: 101 }).success).toBe(false)
    expect(ListPageSchema.safeParse({ cursor: 'x'.repeat(4097) }).success).toBe(false)
  })
})
