import { describe, expect, it } from 'vitest'
import {
  AssociationEventInputSchema as EventInputSchema,
  AssociationPromotionImportSchema as PromotionImportSchema,
  AssociationPromotionInputSchema as PromotionInputSchema,
  AssociationSourceMembershipImportSchema as SourceMembershipImportSchema,
} from '@use-brian/core/association/domain.js'

const CONTACT_ID = '11111111-1111-4111-8111-111111111111'
const TICKET_ID = '22222222-2222-4222-8222-222222222222'

describe('[COMP:crm/association-domain] bounded domain contracts', () => {

  it('rejects invalid event windows', () => {
    expect(EventInputSchema.safeParse({
      slug: 'annual-forum',
      title: 'Annual Forum',
      startsAt: '2027-02-02T11:00:00.000Z',
      endsAt: '2027-02-02T10:00:00.000Z',
      timezone: 'Asia/Hong_Kong',
      mode: 'venue',
    }).success).toBe(false)

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
      source: 'wix', sourceSite: 'association.example', sourcePromotionId: 'coupon-1',
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
      source: 'wix', sourceSite: 'association.example', sourceMembershipId: 'source-1',
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
})
