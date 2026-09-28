/**
 * Bounded contracts for the association-operations vertical.
 *
 * These schemas sit at the API/store boundary so a public-site adapter, a
 * migration job, and a future operator UI all submit the same records. Money
 * is always an integer in minor units; provider state is reconciled through a
 * named order transition; flexible source payloads are preserved only inside
 * bounded JSON objects.
 *
 * [COMP:crm/association-domain]
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { APP_LOCALES } from '@use-brian/shared'
import { CrmPageQuerySchema } from '../crm/pagination.js'
import { CrmIntegrationAuthoritySchema } from '../crm/integration-authority.js'

const UUID = z.string().uuid()
const StableKey = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{0,62}$/)
const ProviderKey = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{0,62}$/)
const Currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/)
const Instant = z.string().datetime({ offset: true })
const NonNegativeMinor = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

function boundedObject(maxBytes: number) {
  return z.record(z.string().min(1).max(100), z.unknown()).refine(
    (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes,
    `object must serialize to no more than ${maxBytes} bytes`,
  )
}

export const AssociationActorSchema = z.object({
  credentialKind: z.enum(['api_key', 'oauth_token', 'home_app', 'provider', 'user', 'assistant',
    'workflow', 'brain_key', 'intake_key', 'import', 'integration_key', 'system_job']),
  credentialId: z.string().trim().min(1).max(200),
  actingUserId: UUID.optional(),
  integration: CrmIntegrationAuthoritySchema.optional(),
})
export type AssociationActor = z.infer<typeof AssociationActorSchema>

export const AssociationExternalIdentityInputSchema = z.object({
  contactId: UUID,
  provider: ProviderKey,
  providerSubject: z.string().trim().min(1).max(500),
})
export type AssociationExternalIdentityInput = z.infer<typeof AssociationExternalIdentityInputSchema>

export const AssociationEnquiryCreateSchema = z.object({
  contactId: UUID,
  source: StableKey,
  sourceSubmissionId: z.string().trim().min(1).max(500),
  subject: z.string().trim().min(1).max(300),
  message: z.string().trim().min(1).max(20_000),
  queueKey: StableKey.default('general'),
  submittedAt: Instant.optional(),
  submittedData: boundedObject(32_000).default({}),
})
export type AssociationEnquiryCreateInput = z.infer<typeof AssociationEnquiryCreateSchema>

export const AssociationEnquiryStatusSchema = z.enum(['new', 'in_progress', 'resolved', 'spam'])
export type AssociationEnquiryStatus = z.infer<typeof AssociationEnquiryStatusSchema>

export const AssociationEnquiryUpdateSchema = z.object({
  status: AssociationEnquiryStatusSchema.optional(),
  queueKey: StableKey.optional(),
  ownerUserId: UUID.nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, 'at least one change is required')
export type AssociationEnquiryUpdateInput = z.infer<typeof AssociationEnquiryUpdateSchema>

export const AssociationEnquiryNoteInputSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
})
export type AssociationEnquiryNoteInput = z.infer<typeof AssociationEnquiryNoteInputSchema>

export const AssociationConsentInputSchema = z.object({
  contactId: UUID,
  purpose: StableKey,
  action: z.enum(['granted', 'withdrawn']),
  wordingVersion: z.string().trim().min(1).max(100),
  locale: z.enum(APP_LOCALES).optional(),
  source: StableKey,
  occurredAt: Instant.optional(),
  provider: ProviderKey.optional(),
  providerEventId: z.string().trim().min(1).max(500).optional(),
  metadata: boundedObject(8_000).default({}),
}).refine(
  (value) => (value.provider === undefined) === (value.providerEventId === undefined),
  'provider and providerEventId must be supplied together',
)
export type AssociationConsentInput = z.infer<typeof AssociationConsentInputSchema>

export const AssociationPlanInputSchema = z.object({
  key: StableKey,
  name: z.string().trim().min(1).max(200),
  currency: Currency,
  feeMinor: NonNegativeMinor,
  billingPeriod: z.enum(['one_time', 'monthly', 'annual', 'lifetime', 'manual']),
  benefits: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  eligibilityNote: z.string().trim().max(5_000).nullable().optional(),
  activeFrom: Instant.nullable().optional(),
  activeTo: Instant.nullable().optional(),
  published: z.boolean().default(false),
  provider: ProviderKey.optional(),
  providerPlanId: z.string().trim().min(1).max(500).optional(),
}).refine(
  (value) => !value.activeFrom || !value.activeTo || value.activeFrom < value.activeTo,
  'activeTo must be after activeFrom',
).refine(
  (value) => (value.provider === undefined) === (value.providerPlanId === undefined),
  'provider and providerPlanId must be supplied together',
)
export type AssociationPlanInput = z.infer<typeof AssociationPlanInputSchema>

export const AssociationMembershipInputSchema = z.object({
  contactId: UUID,
  planId: UUID,
  idempotencyKey: z.string().trim().min(1).max(200),
  status: z.enum(['pending', 'active', 'expired', 'cancelled']).default('pending'),
  startsAt: Instant,
  endsAt: Instant.nullable().optional(),
  renewalMode: z.enum(['none', 'manual', 'auto']).default('none'),
  provider: ProviderKey.optional(),
  providerMembershipId: z.string().trim().min(1).max(500).optional(),
  providerPeriodId: z.string().trim().min(1).max(500).optional(),
  predecessorId: UUID.optional(),
}).refine(
  (value) => !value.endsAt || value.startsAt < value.endsAt,
  'endsAt must be after startsAt',
).refine(
  (value) => (value.provider === undefined) === (value.providerMembershipId === undefined),
  'provider and providerMembershipId must be supplied together',
).refine(value => !value.providerPeriodId || (!!value.provider && !!value.endsAt), 'A provider period requires provider identity and a finite end').refine(value => !value.predecessorId || !!value.providerPeriodId, 'A predecessor requires a provider period')
export type AssociationMembershipInput = z.infer<typeof AssociationMembershipInputSchema>

export const AssociationMembershipUpdateSchema = z.object({
  status: z.enum(['pending', 'active', 'expired', 'cancelled']).optional(),
  endsAt: Instant.nullable().optional(),
  renewalMode: z.enum(['none', 'manual', 'auto']).optional(),
}).refine((value) => Object.keys(value).length > 0, 'at least one change is required')
export type AssociationMembershipUpdateInput = z.infer<typeof AssociationMembershipUpdateSchema>

export const AssociationSponsorshipAllocationStatusSchema = z.enum(['active', 'cancelled'])
export type AssociationSponsorshipAllocationStatus = z.infer<typeof AssociationSponsorshipAllocationStatusSchema>

export const AssociationSponsorshipAllocationCreateSchema = z.object({
  sponsorContactId: UUID,
  sponsorMembershipId: UUID,
  beneficiaryPlanId: UUID,
  idempotencyKey: z.string().trim().min(1).max(200),
  seatLimit: z.number().int().positive().max(10_000),
  startsAt: Instant,
  endsAt: Instant,
  invitationTtlHours: z.number().int().min(1).max(24 * 90).default(168),
}).strict().refine(value => Date.parse(value.startsAt) < Date.parse(value.endsAt), 'endsAt must be after startsAt')
export type AssociationSponsorshipAllocationCreateInput = z.infer<typeof AssociationSponsorshipAllocationCreateSchema>

export const AssociationSponsorshipInvitationStatusSchema = z.enum(['pending', 'redeemed', 'revoked'])
export type AssociationSponsorshipInvitationStatus = z.infer<typeof AssociationSponsorshipInvitationStatusSchema>

export const AssociationSponsorshipInvitationCreateSchema = z.object({
  allocationId: UUID,
  nomineeContactId: UUID,
  idempotencyKey: z.string().trim().min(1).max(200),
}).strict()
export type AssociationSponsorshipInvitationCreateInput = z.infer<typeof AssociationSponsorshipInvitationCreateSchema>

export const AssociationSponsorshipReasonSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(2_000),
}).strict()
export type AssociationSponsorshipReasonInput = z.infer<typeof AssociationSponsorshipReasonSchema>

export const AssociationSponsorshipRedemptionSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  contactId: UUID,
}).strict()
export type AssociationSponsorshipRedemptionInput = z.infer<typeof AssociationSponsorshipRedemptionSchema>

export const AssociationMembershipRescueStatusSchema = z.enum(['outstanding', 'settled', 'reversed', 'cancelled'])
export type AssociationMembershipRescueStatus = z.infer<typeof AssociationMembershipRescueStatusSchema>

export const AssociationMembershipRescueCreateSchema = z.object({
  contactId: UUID,
  planId: UUID,
  idempotencyKey: z.string().trim().min(1).max(200),
  startsAt: Instant,
  endsAt: Instant,
  dueAt: Instant,
  reason: z.string().trim().min(1).max(2_000),
}).strict().refine((value) => Date.parse(value.startsAt) < Date.parse(value.endsAt), 'endsAt must be after startsAt')
export type AssociationMembershipRescueCreateInput = z.infer<typeof AssociationMembershipRescueCreateSchema>

export const AssociationMembershipRescueSettlementSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  method: z.enum(['bank_transfer', 'cash', 'cheque', 'other']),
  evidenceReference: z.string().trim().min(1).max(500),
  amountMinor: z.number().int().positive().safe(),
  currency: Currency,
  occurredAt: Instant,
  note: z.string().trim().max(2_000).nullable().optional(),
}).strict()
export type AssociationMembershipRescueSettlementInput = z.infer<typeof AssociationMembershipRescueSettlementSchema>

export const AssociationMembershipRescueReversalSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  evidenceReference: z.string().trim().min(1).max(500),
  amountMinor: z.number().int().positive().safe(),
  currency: Currency,
  occurredAt: Instant,
  reason: z.string().trim().min(1).max(2_000),
}).strict()
export type AssociationMembershipRescueReversalInput = z.infer<typeof AssociationMembershipRescueReversalSchema>

export const AssociationMembershipRescueCancellationSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(2_000),
}).strict()
export type AssociationMembershipRescueCancellationInput = z.infer<typeof AssociationMembershipRescueCancellationSchema>

function validIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

export const AssociationEventInputSchema = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
  programmeKey: StableKey.nullable().optional(),
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(50_000).default(''),
  startsAt: Instant,
  endsAt: Instant,
  timezone: z.string().trim().min(1).max(100).refine(validIanaTimezone, 'timezone must be a valid IANA timezone'),
  mode: z.enum(['venue', 'online', 'hybrid']),
  venue: z.string().trim().max(2_000).nullable().optional(),
  onlineUrl: z.string().url().max(2_000).nullable().optional(),
  registrationOpensAt: Instant.nullable().optional(),
  registrationClosesAt: Instant.nullable().optional(),
  capacity: z.number().int().positive().max(1_000_000).nullable().optional(),
  status: z.enum(['draft', 'published', 'cancelled', 'completed']).default('draft'),
  canonicalUrl: z.string().url().max(2_000).nullable().optional(),
  metadata: boundedObject(16_000).default({}),
}).refine((value) => value.startsAt < value.endsAt, 'endsAt must be after startsAt')
  .refine(
    (value) => !value.registrationOpensAt || !value.registrationClosesAt
      || value.registrationOpensAt < value.registrationClosesAt,
    'registrationClosesAt must be after registrationOpensAt',
  )
export type AssociationEventInput = z.infer<typeof AssociationEventInputSchema>

export const AssociationTicketInputSchema = z.object({
  key: StableKey,
  name: z.string().trim().min(1).max(200),
  currency: Currency,
  priceMinor: NonNegativeMinor,
  memberPriceMinor: NonNegativeMinor.nullable().optional(),
  eligiblePlanKeys: z.array(StableKey).max(100).default([]),
  eligibilityRequired: z.boolean().optional(),
  eligibilityScope: z.enum(['buyer', 'attendees', 'buyer_and_attendees']).default('buyer'),
  capacity: z.number().int().positive().max(1_000_000).nullable().optional(),
  perOrderLimit: z.number().int().positive().max(1_000).default(10),
  saleStartsAt: Instant.nullable().optional(),
  saleEndsAt: Instant.nullable().optional(),
  status: z.enum(['draft', 'on_sale', 'sold_out', 'closed']).default('draft'),
}).refine(
  (value) => !value.saleStartsAt || !value.saleEndsAt || value.saleStartsAt < value.saleEndsAt,
  'saleEndsAt must be after saleStartsAt',
).superRefine((value, ctx) => {
  if (value.eligibilityRequired && value.eligiblePlanKeys.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['eligibilityRequired'], message: 'required eligibility needs eligible plan keys' })
  }
  if (value.eligibilityScope !== 'buyer' && value.eligiblePlanKeys.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['eligibilityScope'], message: 'attendee eligibility requires eligible plan keys' })
  }
}).transform((value) => ({
  ...value,
  // Older publishers already use eligiblePlanKeys for admission. Preserve
  // their fail-closed behavior unless a newer operator explicitly opts out.
  eligibilityRequired: value.eligibilityRequired ?? value.eligiblePlanKeys.length > 0,
}))
export type AssociationTicketInput = z.infer<typeof AssociationTicketInputSchema>

const PromotionCode = z.string().trim().min(3).max(100)

export const AssociationPromotionInputSchema = z.object({
  key: StableKey,
  name: z.string().trim().min(1).max(200),
  // Omit code on an update to preserve the existing secret. A new promotion
  // must supply one; the store persists only its keyed digest.
  code: PromotionCode.optional(),
  discountType: z.enum(['percentage', 'fixed_amount', 'full', 'buy_x_get_y']),
  percentageBasisPoints: z.number().int().min(1).max(10_000).nullable().optional(),
  amountMinor: NonNegativeMinor.nullable().optional(),
  currency: Currency.nullable().optional(),
  buyQuantity: z.number().int().min(1).max(1_000).nullable().optional(),
  getQuantity: z.number().int().min(1).max(1_000).nullable().optional(),
  targetKind: z.enum(['event', 'ticket', 'plan']),
  targetIds: z.array(UUID).min(1).max(100),
  recurrenceMode: z.enum(['once', 'forever', 'repeating']).default('once'),
  recurrenceCycles: z.number().int().min(2).max(120).nullable().optional(),
  applyMode: z.enum(['once_per_order', 'each_eligible_item']).default('each_eligible_item'),
  validFrom: Instant.nullable().optional(),
  validTo: Instant.nullable().optional(),
  maxUses: z.number().int().positive().max(1_000_000).nullable().optional(),
  maxUsesPerContact: z.number().int().positive().max(10_000).nullable().optional(),
  combinesWithMemberPrice: z.boolean().default(false),
  releaseOnFullRefund: z.boolean().default(false),
  status: z.enum(['draft', 'active', 'disabled']).default('draft'),
}).strict().superRefine((value, ctx) => {
  if (value.validFrom && value.validTo && value.validFrom >= value.validTo) {
    ctx.addIssue({ code: 'custom', path: ['validTo'], message: 'validTo must be after validFrom' })
  }
  if (value.discountType === 'percentage') {
    if (value.percentageBasisPoints == null) {
      ctx.addIssue({ code: 'custom', path: ['percentageBasisPoints'], message: 'percentage discount needs basis points' })
    }
    if (value.amountMinor != null || value.currency != null || value.buyQuantity != null || value.getQuantity != null) {
      ctx.addIssue({ code: 'custom', path: ['buyQuantity'], message: 'percentage discount cannot define quantity terms' })
    }
  } else if (value.discountType === 'fixed_amount') {
    if (value.amountMinor == null || value.amountMinor <= 0 || value.currency == null) {
      ctx.addIssue({ code: 'custom', path: ['amountMinor'], message: 'fixed discount needs a positive amount and currency' })
    }
    if (value.percentageBasisPoints != null || value.buyQuantity != null || value.getQuantity != null) {
      ctx.addIssue({ code: 'custom', path: ['discountType'], message: 'fixed discount cannot define percentage or quantity terms' })
    }
  } else if (value.discountType === 'buy_x_get_y') {
    if (value.buyQuantity == null || value.getQuantity == null) {
      ctx.addIssue({ code: 'custom', path: ['buyQuantity'], message: 'quantity discount needs buy and get quantities' })
    }
    if (value.percentageBasisPoints != null) {
      ctx.addIssue({ code: 'custom', path: ['percentageBasisPoints'], message: 'quantity discount cannot define a percentage' })
    }
    if (value.amountMinor != null || value.currency != null) {
      ctx.addIssue({ code: 'custom', path: ['amountMinor'], message: 'quantity discount cannot define a fixed amount' })
    }
  } else if (value.percentageBasisPoints != null || value.amountMinor != null || value.currency != null || value.buyQuantity != null || value.getQuantity != null) {
    ctx.addIssue({ code: 'custom', path: ['discountType'], message: 'full discount cannot define percentage or quantity terms' })
  }
  if (value.targetKind !== 'plan' && (value.recurrenceMode !== 'once' || value.recurrenceCycles != null)) {
    ctx.addIssue({ code: 'custom', path: ['recurrenceMode'], message: 'event and ticket promotions are one-time purchases' })
  }
  if ((value.recurrenceMode === 'repeating') !== (value.recurrenceCycles != null)) {
    ctx.addIssue({ code: 'custom', path: ['recurrenceCycles'], message: 'repeating promotions need an exact cycle count' })
  }
  if (value.targetKind === 'plan' && value.discountType === 'buy_x_get_y') {
    ctx.addIssue({ code: 'custom', path: ['discountType'], message: 'plan promotions cannot use quantity discounts' })
  }
  if (value.discountType === 'buy_x_get_y' && value.applyMode !== 'each_eligible_item') {
    ctx.addIssue({ code: 'custom', path: ['applyMode'], message: 'quantity discounts apply to each eligible item group' })
  }
})
export type AssociationPromotionInput = z.infer<typeof AssociationPromotionInputSchema>

const AssociationPromotionSourceContactUseSchema = z.object({
  contactId: UUID,
  uses: z.number().int().positive().max(1_000_000),
}).strict()

/** Immutable source evidence admitted only by the confirmed production
 * importer. The source tooling supplies the HMAC digest; plaintext codes must
 * never enter a staged Brian file or import receipt. */
export const AssociationPromotionImportSchema = z.object({
  importJobId: UUID,
  importRow: z.number().int().positive(),
  source: StableKey,
  sourceSite: z.string().trim().min(1).max(500),
  sourcePromotionId: z.string().trim().min(1).max(500),
  codeDigest: z.string().regex(/^[0-9a-f]{64}$/),
  promotion: AssociationPromotionInputSchema,
  sourceRedeemedUses: z.number().int().nonnegative().max(1_000_000),
  sourceContactUses: z.array(AssociationPromotionSourceContactUseSchema).max(100_000).default([]),
}).strict().superRefine((value, ctx) => {
  if (value.promotion.code !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['promotion', 'code'], message: 'promotion imports accept only a keyed code digest' })
  }
  const contacts = new Set(value.sourceContactUses.map((entry) => entry.contactId))
  if (contacts.size !== value.sourceContactUses.length) {
    ctx.addIssue({ code: 'custom', path: ['sourceContactUses'], message: 'source contact usage must contain unique contact IDs' })
  }
  const attributedUses = value.sourceContactUses.reduce((sum, entry) => sum + entry.uses, 0)
  if (!Number.isSafeInteger(attributedUses) || attributedUses > value.sourceRedeemedUses) {
    ctx.addIssue({ code: 'custom', path: ['sourceContactUses'], message: 'attributed source usage cannot exceed total redeemed usage' })
  }
  if (value.promotion.maxUses !== null && value.promotion.maxUses !== undefined
    && value.sourceRedeemedUses > value.promotion.maxUses) {
    ctx.addIssue({ code: 'custom', path: ['sourceRedeemedUses'], message: 'source usage cannot exceed the global cap' })
  }
  if (value.promotion.maxUsesPerContact !== null && value.promotion.maxUsesPerContact !== undefined) {
    if (attributedUses !== value.sourceRedeemedUses) {
      ctx.addIssue({ code: 'custom', path: ['sourceContactUses'], message: 'per-contact caps require complete attributed source usage' })
    }
    if (value.sourceContactUses.some((entry) => entry.uses > value.promotion.maxUsesPerContact!)) {
      ctx.addIssue({ code: 'custom', path: ['sourceContactUses'], message: 'source contact usage cannot exceed the per-contact cap' })
    }
  }
})
export type AssociationPromotionImportInput = z.infer<typeof AssociationPromotionImportSchema>

/** Immutable membership lineage admitted only by the confirmed production
 * importer. Source payment identifiers remain evidence; they never bind the
 * canonical entitlement to a provider or authorize a future charge. */
export const AssociationSourceMembershipImportSchema = z.object({
  importJobId: UUID,
  importRow: z.number().int().positive(),
  contactId: UUID,
  planId: UUID,
  idempotencyKey: z.string().trim().min(1).max(200),
  status: z.enum(['pending', 'active', 'expired', 'cancelled']),
  startsAt: Instant,
  endsAt: Instant.optional(),
  targetRenewalMode: z.enum(['none', 'manual']).default('none'),
  source: StableKey,
  sourceSite: z.string().trim().min(1).max(500),
  sourceMembershipId: z.string().trim().min(1).max(500),
  sourcePlanId: z.string().trim().min(1).max(500),
  sourceMemberId: z.string().trim().min(1).max(500).optional(),
  sourceOrderId: z.string().trim().min(1).max(500).optional(),
  sourceSubscriptionId: z.string().trim().min(1).max(500).optional(),
  sourcePaymentProvider: ProviderKey.optional(),
  sourcePaymentReference: z.string().trim().min(1).max(500).optional(),
  sourceStatus: z.string().trim().min(1).max(100),
  sourceRenewalStatus: z.string().trim().min(1).max(100),
  sourcePaymentStatus: z.string().trim().min(1).max(100).optional(),
  sourceRefundStatus: z.string().trim().min(1).max(100).optional(),
  purchasedAt: Instant,
  cancelledAt: Instant.optional(),
  relationships: boundedObject(8_000).default({}),
  metadata: boundedObject(16_000).default({}),
}).strict().superRefine((value, ctx) => {
  if ((value.sourcePaymentProvider === undefined) !== (value.sourcePaymentReference === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['sourcePaymentProvider'], message: 'source payment provider and reference must be supplied together' })
  }
  if (value.endsAt && Date.parse(value.startsAt) >= Date.parse(value.endsAt)) {
    ctx.addIssue({ code: 'custom', path: ['endsAt'], message: 'endsAt must be after startsAt' })
  }
  if (value.cancelledAt && Date.parse(value.cancelledAt) < Date.parse(value.purchasedAt)) {
    ctx.addIssue({ code: 'custom', path: ['cancelledAt'], message: 'cancelledAt cannot precede purchasedAt' })
  }
})
export type AssociationSourceMembershipImportInput = z.infer<typeof AssociationSourceMembershipImportSchema>

export const AssociationMembershipCheckoutCreateSchema = z.object({
  contactId: UUID,
  planId: UUID,
  idempotencyKey: z.string().trim().min(1).max(200),
  reservationMinutes: z.number().int().min(1).max(120).default(30),
  promotionCode: PromotionCode,
}).strict()
export type AssociationMembershipCheckoutCreateInput = z.infer<typeof AssociationMembershipCheckoutCreateSchema>

export const AssociationMembershipCheckoutProviderBindingSchema = z.object({
  provider: ProviderKey,
  providerReference: z.string().trim().min(1).max(500),
  providerCouponReference: z.string().trim().min(1).max(500),
  amountMinor: NonNegativeMinor,
  currency: Currency,
}).strict()
export type AssociationMembershipCheckoutProviderBindingInput = z.infer<typeof AssociationMembershipCheckoutProviderBindingSchema>

export const AssociationOrderAttendeeSchema = z.object({
  contactId: UUID.optional(),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320).optional(),
  metadata: boundedObject(4_000).default({}),
})

export const AssociationOrderLineInputSchema = z.object({
  ticketId: UUID,
  quantity: z.number().int().positive().max(1_000),
  useMemberPrice: z.boolean().default(false),
  attendees: z.array(AssociationOrderAttendeeSchema).min(1).max(1_000),
}).refine((value) => value.quantity === value.attendees.length, {
  message: 'quantity must equal attendees length',
  path: ['attendees'],
})

export const AssociationOrderCreateSchema = z.object({
  contactId: UUID,
  idempotencyKey: z.string().trim().min(1).max(200),
  reservationMinutes: z.number().int().min(1).max(120).default(20),
  promotionCode: PromotionCode.optional(),
  lines: z.array(AssociationOrderLineInputSchema).min(1).max(50),
  metadata: boundedObject(16_000).default({}),
}).refine(
  (value) => new Set(value.lines.map((line) => line.ticketId)).size === value.lines.length,
  'each ticket may appear only once per order',
)
export type AssociationOrderCreateInput = z.infer<typeof AssociationOrderCreateSchema>

export const AssociationOrderStatusSchema = z.enum(['pending', 'paid', 'failed', 'cancelled', 'refunded'])
export type AssociationOrderStatus = z.infer<typeof AssociationOrderStatusSchema>

const AssociationSourceOrderRegistrationStatusSchema = z.enum([
  'reserved', 'confirmed', 'cancelled', 'refunded', 'checked_in',
])

export const AssociationSourceOrderAttendeeSchema = z.object({
  sourceRegistrationId: z.string().trim().min(1).max(500),
  contactId: UUID.optional(),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320).optional(),
  status: AssociationSourceOrderRegistrationStatusSchema,
  checkedInAt: Instant.optional(),
  metadata: boundedObject(4_000).default({}),
}).strict().refine(
  (value) => (value.status === 'checked_in') === (value.checkedInAt !== undefined),
  'checkedInAt must be supplied exactly when status is checked_in',
)

export const AssociationSourceOrderLineSchema = z.object({
  ticketId: UUID,
  quantity: z.number().int().positive().max(1_000),
  unitPriceMinor: NonNegativeMinor,
  discountMinor: NonNegativeMinor.default(0),
  lineTotalMinor: NonNegativeMinor,
  attendees: z.array(AssociationSourceOrderAttendeeSchema).min(1).max(1_000),
}).strict().superRefine((value, ctx) => {
  if (value.quantity !== value.attendees.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['attendees'], message: 'quantity must equal attendees length' })
  }
  const gross = value.unitPriceMinor * value.quantity
  if (!Number.isSafeInteger(gross) || value.discountMinor > gross
    || value.lineTotalMinor !== gross - value.discountMinor) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lineTotalMinor'], message: 'line money must reconcile exactly' })
  }
  if (new Set(value.attendees.map((attendee) => attendee.sourceRegistrationId)).size !== value.attendees.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['attendees'], message: 'source registration IDs must be unique within a line' })
  }
})

/** Immutable source evidence admitted only by the confirmed production importer. */
export const AssociationSourceOrderImportSchema = z.object({
  importJobId: UUID,
  importRow: z.number().int().positive(),
  contactId: UUID,
  source: StableKey,
  sourceSite: z.string().trim().min(1).max(500),
  sourceOrderId: z.string().trim().min(1).max(500),
  occurredAt: Instant,
  status: AssociationOrderStatusSchema,
  currency: Currency,
  subtotalMinor: NonNegativeMinor,
  discountMinor: NonNegativeMinor,
  totalMinor: NonNegativeMinor,
  refundedMinor: NonNegativeMinor.default(0),
  reservationExpiresAt: Instant.optional(),
  provider: ProviderKey.optional(),
  providerReference: z.string().trim().min(1).max(500).optional(),
  lines: z.array(AssociationSourceOrderLineSchema).min(1).max(50),
  metadata: boundedObject(16_000).default({}),
}).strict().superRefine((value, ctx) => {
  if ((value.provider === undefined) !== (value.providerReference === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['provider'], message: 'provider and providerReference must be supplied together' })
  }
  if ((value.status === 'pending') !== (value.reservationExpiresAt !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reservationExpiresAt'], message: 'only a pending source order has a reservation expiry' })
  }
  if (new Set(value.lines.map((line) => line.ticketId)).size !== value.lines.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lines'], message: 'each ticket may appear only once per order' })
  }
  const registrationIds = value.lines.flatMap((line) => line.attendees.map((attendee) => attendee.sourceRegistrationId))
  if (new Set(registrationIds).size !== registrationIds.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lines'], message: 'source registration IDs must be unique within an order' })
  }
  const subtotal = value.lines.reduce((sum, line) => sum + line.unitPriceMinor * line.quantity, 0)
  const discount = value.lines.reduce((sum, line) => sum + line.discountMinor, 0)
  const total = value.lines.reduce((sum, line) => sum + line.lineTotalMinor, 0)
  if (![subtotal, discount, total].every(Number.isSafeInteger)
    || subtotal !== value.subtotalMinor || discount !== value.discountMinor
    || total !== value.totalMinor || total !== subtotal - discount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['totalMinor'], message: 'order and line money must reconcile exactly' })
  }
  if (value.refundedMinor > value.totalMinor
    || (value.status === 'refunded' && value.refundedMinor !== value.totalMinor)
    || (value.status !== 'paid' && value.status !== 'refunded' && value.refundedMinor !== 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['refundedMinor'], message: 'refund total does not match the source order state' })
  }
  const allowed: Record<AssociationOrderStatus, ReadonlySet<string>> = {
    pending: new Set(['reserved', 'cancelled']),
    paid: new Set(['confirmed', 'checked_in', 'cancelled', 'refunded']),
    failed: new Set(['cancelled']),
    cancelled: new Set(['cancelled']),
    refunded: new Set(['refunded', 'cancelled']),
  }
  value.lines.forEach((line, lineIndex) => line.attendees.forEach((attendee, attendeeIndex) => {
    if (!allowed[value.status].has(attendee.status)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lines', lineIndex, 'attendees', attendeeIndex, 'status'], message: 'attendee state conflicts with the source order state' })
    }
  }))
})
export type AssociationSourceOrderImportInput = z.infer<typeof AssociationSourceOrderImportSchema>

const AggregateMinor = z.string().regex(/^(0|[1-9]\d*)$/)
export const AssociationOrderFinancialSummarySchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  orderCount: z.number().int().nonnegative(),
  settledOrderCount: z.number().int().nonnegative(),
  subtotalMinor: AggregateMinor,
  discountMinor: AggregateMinor,
  grossMinor: AggregateMinor,
  refundedMinor: AggregateMinor,
  netMinor: AggregateMinor,
  pendingMinor: AggregateMinor,
}).strict()
export type AssociationOrderFinancialSummary = z.infer<typeof AssociationOrderFinancialSummarySchema>

export const AssociationProviderBindingInputSchema = z.object({
  provider: ProviderKey,
  providerReference: z.string().trim().min(1).max(500),
  amountMinor: z.number().int().nonnegative().safe(),
  currency: z.string().regex(/^[A-Z]{3}$/),
}).strict()
export type AssociationProviderBindingInput = z.infer<typeof AssociationProviderBindingInputSchema>

export const AssociationProviderEventInputSchema = AssociationProviderBindingInputSchema.extend({
  eventId: z.string().trim().min(1).max(500),
  targetStatus: z.enum(['paid', 'failed', 'cancelled', 'refunded']),
  occurredAt: Instant,
  metadata: boundedObject(8_000).default({}),
})
export type AssociationProviderEventInput = z.infer<typeof AssociationProviderEventInputSchema>

export const AssociationProviderFinancialEventInputSchema = z.object({
  provider: ProviderKey,
  providerReference: z.string().trim().min(1).max(500),
  adjustmentReference: z.string().trim().min(1).max(500),
  eventId: z.string().trim().min(1).max(500),
  kind: z.enum(['refund', 'dispute']),
  status: z.enum(['pending', 'succeeded', 'failed', 'cancelled', 'open', 'won', 'lost', 'prevented']),
  amountMinor: z.number().int().positive().safe(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  occurredAt: Instant,
  metadata: boundedObject(8_000).default({}),
}).strict().superRefine((value, ctx) => {
  const allowed = value.kind === 'refund'
    ? ['pending', 'succeeded', 'failed', 'cancelled']
    : ['open', 'won', 'lost', 'prevented']
  if (!allowed.includes(value.status)) ctx.addIssue({ code: 'custom', path: ['status'], message: 'Financial status does not match its kind.' })
})
export type AssociationProviderFinancialEventInput = z.infer<typeof AssociationProviderFinancialEventInputSchema>

export const AssociationRegistrationStatusSchema = z.enum([
  'reserved', 'confirmed', 'cancelled', 'refunded', 'checked_in',
])
export type AssociationRegistrationStatus = z.infer<typeof AssociationRegistrationStatusSchema>

export const AssociationOperationalRosterRowSchema = z.object({
  id: UUID,
  eventId: UUID,
  orderId: UUID.nullable(),
  orderLineId: UUID.nullable(),
  ticketId: UUID.nullable(),
  ticketKey: z.string().nullable(),
  ticketName: z.string().nullable(),
  buyerContactId: UUID.nullable(),
  attendeeContactId: UUID.nullable(),
  attendeeName: z.string(),
  attendeeEmail: z.string().nullable(),
  phone: z.string().nullable(),
  organisation: z.string().nullable(),
  jobTitle: z.string().nullable(),
  status: z.enum(['reserved', 'confirmed', 'cancelled', 'refunded', 'checked_in', 'registered', 'attended', 'no_show']),
  checkedInAt: z.union([z.string(), z.date()]).nullable(),
  sourceKind: z.string(),
  sourceId: z.string().nullable(),
  historicalImport: z.boolean(),
  marketingConsent: z.boolean().nullable(),
  ticketingConsent: z.boolean().nullable(),
  policyVersion: z.string().nullable(),
  policyAcceptedAt: z.string().nullable(),
  questionResponses: z.unknown().nullable(),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]),
}).strict()
export type AssociationOperationalRosterRow = z.infer<typeof AssociationOperationalRosterRowSchema>

export const AssociationRegistrationUpdateSchema = z.object({
  status: z.enum(['cancelled', 'checked_in']),
})
export type AssociationRegistrationUpdateInput = z.infer<typeof AssociationRegistrationUpdateSchema>

export const AssociationCheckInCorrectionSchema = z.object({
  expectedStatus: z.enum(['checked_in', 'attended']),
  reason: z.string().trim().min(5).max(500),
}).strict()
export type AssociationCheckInCorrectionInput = z.infer<typeof AssociationCheckInCorrectionSchema>

export const AssociationListPageSchema = CrmPageQuerySchema.strip()

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    )
  }
  return value
}

export function associationFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

const ORDER_TRANSITIONS: Record<AssociationOrderStatus, ReadonlySet<AssociationOrderStatus>> = {
  pending: new Set(['pending', 'paid', 'failed', 'cancelled']),
  paid: new Set(['paid', 'refunded']),
  failed: new Set(['failed']),
  cancelled: new Set(['cancelled']),
  refunded: new Set(['refunded']),
}

export function mayTransitionAssociationOrder(from: AssociationOrderStatus, to: AssociationOrderStatus): boolean {
  return ORDER_TRANSITIONS[from].has(to)
}

const REGISTRATION_TRANSITIONS: Record<AssociationRegistrationStatus, ReadonlySet<AssociationRegistrationStatus>> = {
  reserved: new Set(['reserved', 'confirmed', 'cancelled']),
  confirmed: new Set(['confirmed', 'cancelled', 'refunded', 'checked_in']),
  checked_in: new Set(['checked_in', 'refunded']),
  cancelled: new Set(['cancelled']),
  refunded: new Set(['refunded']),
}

export function mayTransitionAssociationRegistration(
  from: AssociationRegistrationStatus,
  to: AssociationRegistrationStatus,
): boolean {
  return REGISTRATION_TRANSITIONS[from].has(to)
}

export type AssociationErrorCode =
  | 'not_found'
  | 'conflict'
  | 'invalid_transition'
  | 'contact_required'
  | 'not_available'
  | 'member_price_ineligible'
  | 'attendee_membership_ineligible'
  | 'promotion_invalid'
  | 'promotion_not_applicable'
  | 'promotion_exhausted'
  | 'invalid_edit'

export class AssociationError extends Error {
  constructor(
    readonly code: AssociationErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AssociationError'
  }
}
