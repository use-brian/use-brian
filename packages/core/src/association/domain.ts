/** Shared CRM plan/event, actor and historical import contracts.
 * Retained physical names preserve compatibility with CRM storage.
 * [COMP:crm/association-domain]
 */
import { z } from 'zod'
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