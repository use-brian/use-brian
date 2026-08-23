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
  credentialKind: z.enum(['api_key', 'oauth_token', 'home_app', 'provider']),
  credentialId: z.string().trim().min(1).max(200),
  actingUserId: UUID.optional(),
})
export type AssociationActor = z.infer<typeof AssociationActorSchema>

export const ExternalIdentityInputSchema = z.object({
  contactId: UUID,
  provider: ProviderKey,
  providerSubject: z.string().trim().min(1).max(500),
})
export type ExternalIdentityInput = z.infer<typeof ExternalIdentityInputSchema>

export const EnquiryCreateSchema = z.object({
  contactId: UUID,
  source: StableKey,
  sourceSubmissionId: z.string().trim().min(1).max(500),
  subject: z.string().trim().min(1).max(300),
  message: z.string().trim().min(1).max(20_000),
  queueKey: StableKey.default('general'),
  submittedAt: Instant.optional(),
  submittedData: boundedObject(32_000).default({}),
})
export type EnquiryCreateInput = z.infer<typeof EnquiryCreateSchema>

export const EnquiryStatusSchema = z.enum(['new', 'in_progress', 'resolved', 'spam'])
export type EnquiryStatus = z.infer<typeof EnquiryStatusSchema>

export const EnquiryUpdateSchema = z.object({
  status: EnquiryStatusSchema.optional(),
  queueKey: StableKey.optional(),
  ownerUserId: UUID.nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, 'at least one change is required')
export type EnquiryUpdateInput = z.infer<typeof EnquiryUpdateSchema>

export const EnquiryNoteInputSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
})
export type EnquiryNoteInput = z.infer<typeof EnquiryNoteInputSchema>

export const ConsentInputSchema = z.object({
  contactId: UUID,
  purpose: StableKey,
  action: z.enum(['granted', 'withdrawn']),
  wordingVersion: z.string().trim().min(1).max(100),
  source: StableKey,
  occurredAt: Instant.optional(),
  provider: ProviderKey.optional(),
  providerEventId: z.string().trim().min(1).max(500).optional(),
  metadata: boundedObject(8_000).default({}),
}).refine(
  (value) => (value.provider === undefined) === (value.providerEventId === undefined),
  'provider and providerEventId must be supplied together',
)
export type ConsentInput = z.infer<typeof ConsentInputSchema>

export const PlanInputSchema = z.object({
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
export type PlanInput = z.infer<typeof PlanInputSchema>

export const MembershipInputSchema = z.object({
  contactId: UUID,
  planId: UUID,
  idempotencyKey: z.string().trim().min(1).max(200),
  status: z.enum(['pending', 'active', 'expired', 'cancelled']).default('pending'),
  startsAt: Instant,
  endsAt: Instant.nullable().optional(),
  renewalMode: z.enum(['none', 'manual', 'auto']).default('none'),
  provider: ProviderKey.optional(),
  providerMembershipId: z.string().trim().min(1).max(500).optional(),
}).refine(
  (value) => !value.endsAt || value.startsAt < value.endsAt,
  'endsAt must be after startsAt',
).refine(
  (value) => (value.provider === undefined) === (value.providerMembershipId === undefined),
  'provider and providerMembershipId must be supplied together',
)
export type MembershipInput = z.infer<typeof MembershipInputSchema>

export const MembershipUpdateSchema = z.object({
  status: z.enum(['pending', 'active', 'expired', 'cancelled']).optional(),
  endsAt: Instant.nullable().optional(),
  renewalMode: z.enum(['none', 'manual', 'auto']).optional(),
}).refine((value) => Object.keys(value).length > 0, 'at least one change is required')
export type MembershipUpdateInput = z.infer<typeof MembershipUpdateSchema>

function validIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

export const EventInputSchema = z.object({
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
export type EventInput = z.infer<typeof EventInputSchema>

export const TicketInputSchema = z.object({
  key: StableKey,
  name: z.string().trim().min(1).max(200),
  currency: Currency,
  priceMinor: NonNegativeMinor,
  memberPriceMinor: NonNegativeMinor.nullable().optional(),
  eligiblePlanKeys: z.array(StableKey).max(100).default([]),
  capacity: z.number().int().positive().max(1_000_000).nullable().optional(),
  perOrderLimit: z.number().int().positive().max(1_000).default(10),
  saleStartsAt: Instant.nullable().optional(),
  saleEndsAt: Instant.nullable().optional(),
  status: z.enum(['draft', 'on_sale', 'sold_out', 'closed']).default('draft'),
}).refine(
  (value) => !value.saleStartsAt || !value.saleEndsAt || value.saleStartsAt < value.saleEndsAt,
  'saleEndsAt must be after saleStartsAt',
)
export type TicketInput = z.infer<typeof TicketInputSchema>

export const OrderAttendeeSchema = z.object({
  contactId: UUID.optional(),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(320).optional(),
  metadata: boundedObject(4_000).default({}),
})

export const OrderLineInputSchema = z.object({
  ticketId: UUID,
  quantity: z.number().int().positive().max(1_000),
  useMemberPrice: z.boolean().default(false),
  attendees: z.array(OrderAttendeeSchema).min(1).max(1_000),
}).refine((value) => value.quantity === value.attendees.length, {
  message: 'quantity must equal attendees length',
  path: ['attendees'],
})

export const OrderCreateSchema = z.object({
  contactId: UUID,
  idempotencyKey: z.string().trim().min(1).max(200),
  reservationMinutes: z.number().int().min(1).max(120).default(20),
  lines: z.array(OrderLineInputSchema).min(1).max(50),
  metadata: boundedObject(16_000).default({}),
}).refine(
  (value) => new Set(value.lines.map((line) => line.ticketId)).size === value.lines.length,
  'each ticket may appear only once per order',
)
export type OrderCreateInput = z.infer<typeof OrderCreateSchema>

export const OrderStatusSchema = z.enum(['pending', 'paid', 'failed', 'cancelled', 'refunded'])
export type OrderStatus = z.infer<typeof OrderStatusSchema>

export const ProviderEventInputSchema = z.object({
  provider: ProviderKey,
  eventId: z.string().trim().min(1).max(500),
  targetStatus: z.enum(['paid', 'failed', 'cancelled', 'refunded']),
  occurredAt: Instant,
  providerReference: z.string().trim().min(1).max(500).optional(),
  metadata: boundedObject(8_000).default({}),
})
export type ProviderEventInput = z.infer<typeof ProviderEventInputSchema>

export const RegistrationStatusSchema = z.enum([
  'reserved', 'confirmed', 'cancelled', 'refunded', 'checked_in',
])
export type RegistrationStatus = z.infer<typeof RegistrationStatusSchema>

export const RegistrationUpdateSchema = z.object({
  status: z.enum(['cancelled', 'checked_in']),
})
export type RegistrationUpdateInput = z.infer<typeof RegistrationUpdateSchema>

export const ListPageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).max(1_000).optional(),
})

export type AssociationCursor = { createdAt: string; id: string }

export function encodeAssociationCursor(cursor: AssociationCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

export function decodeAssociationCursor(raw: string | undefined): AssociationCursor | null {
  if (!raw) return null
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    const parsed = z.object({ createdAt: Instant, id: UUID }).safeParse(value)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

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

const ORDER_TRANSITIONS: Record<OrderStatus, ReadonlySet<OrderStatus>> = {
  pending: new Set(['pending', 'paid', 'failed', 'cancelled']),
  paid: new Set(['paid', 'refunded']),
  failed: new Set(['failed']),
  cancelled: new Set(['cancelled']),
  refunded: new Set(['refunded']),
}

export function mayTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].has(to)
}

const REGISTRATION_TRANSITIONS: Record<RegistrationStatus, ReadonlySet<RegistrationStatus>> = {
  reserved: new Set(['reserved', 'confirmed', 'cancelled']),
  confirmed: new Set(['confirmed', 'cancelled', 'refunded', 'checked_in']),
  checked_in: new Set(['checked_in', 'refunded']),
  cancelled: new Set(['cancelled']),
  refunded: new Set(['refunded']),
}

export function mayTransitionRegistration(
  from: RegistrationStatus,
  to: RegistrationStatus,
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
