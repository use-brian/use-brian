/**
 * Pure, closed-world contracts for agent-native CRM operations.
 *
 * Every adapter submits one validated command with a server-constructed
 * workspace/actor/authority context. Flexible values are bounded here before
 * they reach the PostgreSQL transaction seam.
 *
 * [COMP:crm/operations-contract]
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'

export const CrmOperationsUuidSchema = z.string().uuid()
export const CrmOperationsStableKeySchema = z.string().trim().toLowerCase()
  .regex(/^[a-z][a-z0-9_-]{0,62}$/)
export const CrmOperationsInstantSchema = z.string().datetime({ offset: true })

export function boundedCrmObject(maxBytes: number) {
  return z.record(z.string().trim().min(1).max(100), z.unknown()).refine(
    (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes,
    `object must serialize to no more than ${maxBytes} bytes`,
  )
}

function boundedArray(maxItems: number, maxBytes: number) {
  return z.array(z.unknown()).max(maxItems).refine(
    (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes,
    `array must serialize to no more than ${maxBytes} bytes`,
  )
}

export const CrmOperationsActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), userId: CrmOperationsUuidSchema }),
  z.object({
    kind: z.literal('assistant'),
    assistantId: CrmOperationsUuidSchema,
    userId: CrmOperationsUuidSchema.optional(),
    sessionId: CrmOperationsUuidSchema,
  }),
  z.object({
    kind: z.literal('workflow'),
    workflowId: CrmOperationsUuidSchema,
    runId: CrmOperationsUuidSchema,
    userId: CrmOperationsUuidSchema.optional(),
  }),
  z.object({ kind: z.literal('brain_key'), credentialId: CrmOperationsUuidSchema }),
  z.object({
    kind: z.literal('oauth_token'),
    credentialId: CrmOperationsUuidSchema,
    userId: CrmOperationsUuidSchema.optional(),
  }),
  z.object({
    kind: z.literal('intake_key'),
    credentialId: CrmOperationsUuidSchema,
    definitionId: CrmOperationsUuidSchema,
  }),
  z.object({
    kind: z.literal('home_app'),
    credentialId: CrmOperationsUuidSchema,
    userId: CrmOperationsUuidSchema.optional(),
  }),
  z.object({
    kind: z.literal('provider'),
    provider: CrmOperationsStableKeySchema,
    eventId: z.string().trim().min(1).max(200),
  }),
])
export type CrmOperationsActor = z.infer<typeof CrmOperationsActorSchema>

export const CrmOperationsAuthoritySchema = z.object({
  role: z.enum(['member', 'admin', 'owner', 'system']),
  canWrite: z.boolean(),
  canConfigure: z.boolean(),
  trustedIdentitySources: z.array(CrmOperationsStableKeySchema).max(50).default([]),
})
export type CrmOperationsAuthority = z.infer<typeof CrmOperationsAuthoritySchema>

export const CrmOperationsContextSchema = z.object({
  workspaceId: CrmOperationsUuidSchema,
  actor: CrmOperationsActorSchema,
  authority: CrmOperationsAuthoritySchema,
  requestId: z.string().trim().min(1).max(200).optional(),
})
export type CrmOperationsContext = z.infer<typeof CrmOperationsContextSchema>

export const CrmIdentityPolicySchema = z.enum([
  'external_subject',
  'trusted_verified_email',
  'new_or_review',
])
export type CrmIdentityPolicy = z.infer<typeof CrmIdentityPolicySchema>

export const CrmIntakeFieldTypeSchema = z.enum([
  'text',
  'email',
  'phone',
  'number',
  'boolean',
  'date',
  'string_array',
])

export const CrmIntakeFieldMappingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('base_field'),
    field: z.enum(['name', 'email', 'phone', 'tags']),
  }),
  z.object({
    kind: z.literal('custom_field'),
    fieldKey: CrmOperationsStableKeySchema,
  }),
  z.object({ kind: z.literal('submission_only') }),
])

export const CrmIntakeFieldDefinitionSchema = z.object({
  key: CrmOperationsStableKeySchema,
  label: z.string().trim().min(1).max(200),
  type: CrmIntakeFieldTypeSchema,
  required: z.boolean().default(false),
  maxLength: z.number().int().min(1).max(20_000).optional(),
  options: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  mapping: CrmIntakeFieldMappingSchema,
}).superRefine((field, ctx) => {
  if (field.type === 'string_array' && field.mapping.kind === 'base_field'
    && field.mapping.field !== 'tags') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mapping'], message: 'string_array base mapping must target tags' })
  }
  if (field.options && !['text', 'string_array'].includes(field.type)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'options are valid only for text or string_array fields' })
  }
})
export type CrmIntakeFieldDefinition = z.infer<typeof CrmIntakeFieldDefinitionSchema>

export const CrmConsentAnswerMappingSchema = z.object({
  fieldKey: CrmOperationsStableKeySchema,
  grantedValue: z.union([z.string().max(200), z.boolean(), z.number()]),
  purposeKey: CrmOperationsStableKeySchema,
})

export const CrmFollowUpTaskTemplateSchema = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().max(5_000).default(''),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  tags: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
})

export const CrmIntakeDefinitionVersionInputSchema = z.object({
  fields: z.array(CrmIntakeFieldDefinitionSchema).min(1).max(100),
  identityPolicy: CrmIdentityPolicySchema,
  allowedIdentityProvider: CrmOperationsStableKeySchema.nullable().optional(),
  consentMappings: z.array(CrmConsentAnswerMappingSchema).max(50).default([]),
  queueKey: CrmOperationsStableKeySchema.default('general'),
  ownerUserId: CrmOperationsUuidSchema.nullable().optional(),
  followUpTaskTemplate: CrmFollowUpTaskTemplateSchema.nullable().optional(),
  followUpDueMinutes: z.number().int().min(0).max(525_600).nullable().optional(),
  maxPayloadBytes: z.number().int().min(1_024).max(1_048_576).default(65_536),
  workflowHint: z.string().trim().max(500).nullable().optional(),
}).superRefine((value, ctx) => {
  const keys = value.fields.map((field) => field.key)
  if (new Set(keys).size !== keys.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fields'], message: 'field keys must be unique' })
  }
  const known = new Set(keys)
  for (const [index, mapping] of value.consentMappings.entries()) {
    if (!known.has(mapping.fieldKey)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['consentMappings', index, 'fieldKey'], message: 'consent field must exist in the field catalog' })
    }
  }
  if (value.identityPolicy === 'external_subject' && !value.allowedIdentityProvider) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allowedIdentityProvider'], message: 'external_subject requires an allowed identity provider' })
  }
  if (value.identityPolicy !== 'external_subject' && value.allowedIdentityProvider) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['allowedIdentityProvider'], message: 'identity provider is only valid for external_subject' })
  }
})
export type CrmIntakeDefinitionVersionInput = z.infer<typeof CrmIntakeDefinitionVersionInputSchema>

export const SaveCrmIntakeDefinitionCommandSchema = z.object({
  kind: z.literal('save_intake_definition'),
  definitionId: CrmOperationsUuidSchema.optional(),
  definitionKey: CrmOperationsStableKeySchema,
  label: z.string().trim().min(1).max(200),
  active: z.boolean().default(true),
  expectedVersion: z.number().int().positive().optional(),
  definition: CrmIntakeDefinitionVersionInputSchema,
})

export const CreateCrmIntakeCredentialCommandSchema = z.object({
  kind: z.literal('create_intake_credential'),
  label: z.string().trim().min(1).max(200),
  definitionIds: z.array(CrmOperationsUuidSchema).min(1).max(50),
})

export const RevokeCrmIntakeCredentialCommandSchema = z.object({
  kind: z.literal('revoke_intake_credential'),
  credentialId: CrmOperationsUuidSchema,
})

export const CrmExternalIdentityClaimSchema = z.object({
  provider: CrmOperationsStableKeySchema,
  subject: z.string().trim().min(1).max(500),
})

export const RecordCrmSubmissionCommandSchema = z.object({
  kind: z.literal('record_submission'),
  definitionKey: CrmOperationsStableKeySchema,
  idempotencyKey: z.string().trim().min(1).max(200),
  fields: boundedCrmObject(1_048_576),
  externalIdentity: CrmExternalIdentityClaimSchema.optional(),
  submittedAt: CrmOperationsInstantSchema.optional(),
}).strict()
export type RecordCrmSubmissionCommand = z.infer<typeof RecordCrmSubmissionCommandSchema>

export const UpdateCrmSubmissionCommandSchema = z.object({
  kind: z.literal('update_submission'),
  submissionId: CrmOperationsUuidSchema,
  status: z.enum(['new', 'in_progress', 'resolved', 'spam']).optional(),
  queueKey: CrmOperationsStableKeySchema.optional(),
  ownerUserId: CrmOperationsUuidSchema.nullable().optional(),
  note: z.string().trim().min(1).max(20_000).optional(),
}).refine(
  (value) => value.status !== undefined || value.queueKey !== undefined
    || value.ownerUserId !== undefined || value.note !== undefined,
  'at least one submission change is required',
)

export const SaveCrmConsentPurposeCommandSchema = z.object({
  kind: z.literal('save_consent_purpose'),
  purposeId: CrmOperationsUuidSchema.optional(),
  purposeKey: CrmOperationsStableKeySchema,
  label: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5_000).default(''),
  requiresConsent: z.boolean().default(true),
  applicableChannels: z.array(z.enum([
    'email', 'sms', 'phone', 'whatsapp', 'telegram', 'slack',
  ])).max(6).default([]),
  wordingVersion: z.string().trim().min(1).max(100),
  wording: z.string().trim().min(1).max(20_000),
  archived: z.boolean().default(false),
})

export const RecordCrmConsentCommandSchema = z.object({
  kind: z.literal('record_consent'),
  contactId: CrmOperationsUuidSchema,
  purposeKey: CrmOperationsStableKeySchema,
  action: z.enum(['granted', 'withdrawn']),
  source: CrmOperationsStableKeySchema,
  occurredAt: CrmOperationsInstantSchema.optional(),
  provider: CrmOperationsStableKeySchema.optional(),
  providerEventId: z.string().trim().min(1).max(500).optional(),
  metadata: boundedCrmObject(8_000).default({}),
}).refine(
  (value) => (value.provider === undefined) === (value.providerEventId === undefined),
  'provider and providerEventId must be supplied together',
)

export const CrmSuppressionChannelSchema = z.enum([
  'all', 'email', 'sms', 'phone', 'whatsapp', 'telegram', 'slack',
])
export const CrmSuppressionReasonSchema = z.enum([
  'manual_do_not_contact', 'hard_bounce', 'soft_bounce', 'complaint',
  'provider_block', 'legal', 'invalid_address', 'other',
])

export const RecordCrmSuppressionCommandSchema = z.object({
  kind: z.literal('record_suppression'),
  contactId: CrmOperationsUuidSchema,
  channel: CrmSuppressionChannelSchema,
  action: z.enum(['suppressed', 'released']),
  reasonCode: CrmSuppressionReasonSchema,
  source: CrmOperationsStableKeySchema,
  occurredAt: CrmOperationsInstantSchema.optional(),
  provider: CrmOperationsStableKeySchema.optional(),
  providerEventId: z.string().trim().min(1).max(500).optional(),
  metadata: boundedCrmObject(8_000).default({}),
}).refine(
  (value) => (value.provider === undefined) === (value.providerEventId === undefined),
  'provider and providerEventId must be supplied together',
)

export const SaveCrmSegmentCommandSchema = z.object({
  kind: z.literal('save_segment'),
  segmentId: CrmOperationsUuidSchema.optional(),
  segmentKey: CrmOperationsStableKeySchema,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5_000).default(''),
  entityKind: z.enum(['person', 'company', 'deal']),
  predicate: boundedCrmObject(65_536),
  expectedVersion: z.number().int().positive().optional(),
})

export const ArchiveCrmSegmentCommandSchema = z.object({
  kind: z.literal('archive_segment'),
  segmentId: CrmOperationsUuidSchema,
  expectedVersion: z.number().int().positive().optional(),
})

export const GrantCrmEntitlementCommandSchema = z.object({
  kind: z.literal('grant_entitlement'),
  contactId: CrmOperationsUuidSchema,
  planId: CrmOperationsUuidSchema,
  idempotencyKey: z.string().trim().min(1).max(200),
  status: z.enum(['pending', 'active', 'expired', 'cancelled']).default('pending'),
  startsAt: CrmOperationsInstantSchema,
  endsAt: CrmOperationsInstantSchema.nullable().optional(),
  renewalMode: z.enum(['none', 'manual', 'auto']).default('none'),
  provider: CrmOperationsStableKeySchema.optional(),
  providerEntitlementId: z.string().trim().min(1).max(500).optional(),
}).refine(
  (value) => (value.provider === undefined) === (value.providerEntitlementId === undefined),
  'provider and providerEntitlementId must be supplied together',
).refine(
  (value) => !value.endsAt || value.startsAt < value.endsAt,
  'endsAt must be after startsAt',
)

export const UpdateCrmEntitlementCommandSchema = z.object({
  kind: z.literal('update_entitlement'),
  entitlementId: CrmOperationsUuidSchema,
  status: z.enum(['pending', 'active', 'expired', 'cancelled']).optional(),
  endsAt: CrmOperationsInstantSchema.nullable().optional(),
  renewalMode: z.enum(['none', 'manual', 'auto']).optional(),
}).refine(
  (value) => value.status !== undefined || value.endsAt !== undefined
    || value.renewalMode !== undefined,
  'at least one entitlement change is required',
)

export const RecordCrmParticipationCommandSchema = z.object({
  kind: z.literal('record_participation'),
  contactId: CrmOperationsUuidSchema,
  eventId: CrmOperationsUuidSchema,
  sourceKind: z.enum(['manual', 'form', 'workflow', 'import']),
  sourceId: z.string().trim().min(1).max(500),
  status: z.enum(['registered', 'attended', 'cancelled', 'no_show']).default('registered'),
  attendeeName: z.string().trim().min(1).max(200),
  attendeeEmail: z.string().trim().email().max(320).optional(),
  metadata: boundedCrmObject(4_000).default({}),
})

export const UpdateCrmParticipationCommandSchema = z.object({
  kind: z.literal('update_participation'),
  participationId: CrmOperationsUuidSchema,
  status: z.enum(['registered', 'attended', 'cancelled', 'no_show']),
})

const CRM_ENTITLEMENT_TRANSITIONS = {
  pending: new Set(['pending', 'active', 'cancelled']),
  active: new Set(['active', 'expired', 'cancelled']),
  expired: new Set(['expired']),
  cancelled: new Set(['cancelled']),
} satisfies Record<string, ReadonlySet<string>>

const CRM_PARTICIPATION_TRANSITIONS = {
  registered: new Set(['registered', 'attended', 'cancelled', 'no_show']),
  attended: new Set(['attended']),
  cancelled: new Set(['cancelled']),
  no_show: new Set(['no_show', 'attended']),
} satisfies Record<string, ReadonlySet<string>>

export function mayTransitionCrmEntitlement(from: string, to: string): boolean {
  return CRM_ENTITLEMENT_TRANSITIONS[from as keyof typeof CRM_ENTITLEMENT_TRANSITIONS]?.has(to) ?? false
}

export function mayTransitionCrmParticipation(from: string, to: string): boolean {
  return CRM_PARTICIPATION_TRANSITIONS[from as keyof typeof CRM_PARTICIPATION_TRANSITIONS]?.has(to) ?? false
}

export const SetDealPipelineStageCommandSchema = z.object({
  kind: z.literal('set_deal_pipeline_stage'),
  dealId: CrmOperationsUuidSchema,
  pipelineId: CrmOperationsUuidSchema,
  stageId: CrmOperationsUuidSchema,
})

// Several command schemas use cross-field refinements and therefore become
// ZodEffects. A regular union preserves those validations; discriminatedUnion
// cannot introspect a discriminator through ZodEffects in Zod 3.
export const CrmOperationsCommandSchema = z.union([
  SaveCrmIntakeDefinitionCommandSchema,
  CreateCrmIntakeCredentialCommandSchema,
  RevokeCrmIntakeCredentialCommandSchema,
  RecordCrmSubmissionCommandSchema,
  UpdateCrmSubmissionCommandSchema,
  SaveCrmConsentPurposeCommandSchema,
  RecordCrmConsentCommandSchema,
  RecordCrmSuppressionCommandSchema,
  SaveCrmSegmentCommandSchema,
  ArchiveCrmSegmentCommandSchema,
  GrantCrmEntitlementCommandSchema,
  UpdateCrmEntitlementCommandSchema,
  RecordCrmParticipationCommandSchema,
  UpdateCrmParticipationCommandSchema,
  SetDealPipelineStageCommandSchema,
])
export type CrmOperationsCommand = z.infer<typeof CrmOperationsCommandSchema>

export const CrmDomainEventTypeSchema = z.enum([
  'crm.submission.received',
  'crm.submission.updated',
  'crm.consent.changed',
  'crm.suppression.changed',
  'crm.entitlement.changed',
  'crm.participation.changed',
  'crm.deal.stage_changed',
])
export type CrmDomainEventType = z.infer<typeof CrmDomainEventTypeSchema>

export type CrmOperationsCommandResult = {
  command: CrmOperationsCommand['kind']
  record: Record<string, unknown>
  created: boolean
  duplicate: boolean
  emittedEventIds: string[]
  oneTimeSecret?: string
}

export interface CrmOperationsServicePort {
  execute(
    context: CrmOperationsContext,
    command: CrmOperationsCommand,
  ): Promise<CrmOperationsCommandResult>
}

export type CrmOperationsErrorCode =
  | 'invalid_input'
  | 'not_authorized'
  | 'not_found'
  | 'catalog_key_invalid'
  | 'conflict'
  | 'idempotency_conflict'
  | 'identity_conflict'
  | 'invalid_transition'
  | 'payload_too_large'
  | 'credential_revoked'
  | 'empty_import'

export class CrmOperationsError extends Error {
  constructor(
    readonly code: CrmOperationsErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'CrmOperationsError'
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

export function canonicalCrmRequest(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function crmOperationsSha256(value: unknown): string {
  return createHash('sha256').update(canonicalCrmRequest(value)).digest('hex')
}

export function actorAuditIdentity(actor: CrmOperationsActor): {
  actorKind: CrmOperationsActor['kind']
  actorCredentialId: string
  actingUserId: string | null
} {
  switch (actor.kind) {
    case 'user':
      return { actorKind: actor.kind, actorCredentialId: actor.userId, actingUserId: actor.userId }
    case 'assistant':
      return { actorKind: actor.kind, actorCredentialId: actor.assistantId, actingUserId: actor.userId ?? null }
    case 'workflow':
      return { actorKind: actor.kind, actorCredentialId: actor.runId, actingUserId: actor.userId ?? null }
    case 'brain_key':
    case 'intake_key':
      return { actorKind: actor.kind, actorCredentialId: actor.credentialId, actingUserId: null }
    case 'oauth_token':
    case 'home_app':
      return { actorKind: actor.kind, actorCredentialId: actor.credentialId, actingUserId: actor.userId ?? null }
    case 'provider':
      return { actorKind: actor.kind, actorCredentialId: actor.eventId, actingUserId: null }
  }
}

export function commandRequiresConfigurationAuthority(command: CrmOperationsCommand): boolean {
  return command.kind === 'save_intake_definition'
    || command.kind === 'create_intake_credential'
    || command.kind === 'revoke_intake_credential'
    || command.kind === 'save_consent_purpose'
}

export function assertCrmOperationsAuthority(
  context: CrmOperationsContext,
  command: CrmOperationsCommand,
): void {
  if (!context.authority.canWrite) {
    throw new CrmOperationsError('not_authorized', 'This principal has read-only CRM authority.')
  }
  if (commandRequiresConfigurationAuthority(command) && !context.authority.canConfigure) {
    throw new CrmOperationsError(
      'not_authorized',
      'This CRM configuration change requires workspace owner or admin authority.',
    )
  }
  if (context.actor.kind === 'intake_key' && command.kind !== 'record_submission') {
    throw new CrmOperationsError(
      'not_authorized',
      'An intake credential can only record a submission for its bound definition.',
    )
  }
}

export function parseCrmOperationsCommand(input: unknown): CrmOperationsCommand {
  const parsed = CrmOperationsCommandSchema.safeParse(input)
  if (parsed.success) return parsed.data
  throw new CrmOperationsError('invalid_input', 'CRM operation input is invalid.', {
    issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  })
}

export function boundedCatalogDetails(
  catalog: string,
  value: string,
  validValues: readonly string[],
): CrmOperationsError {
  return new CrmOperationsError(
    'catalog_key_invalid',
    `${catalog} value "${value}" is not valid. Use one of the returned valid values.`,
    { catalog, value, validValues: validValues.slice(0, 100) },
  )
}

export function assertBoundedArray(value: unknown): void {
  boundedArray(1_000, 131_072).parse(value)
}
