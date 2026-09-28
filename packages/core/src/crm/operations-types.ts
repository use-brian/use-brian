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
import { APP_LOCALES } from '@use-brian/shared'
import { campaignAttributionContextSchema } from '@use-brian/shared/campaigns'
import { CrmIntegrationAuthoritySchema, requireCrmIntegrationOperation, type CrmIntegrationOperation } from './integration-authority.js'
import { AssociationPlanInputSchema, AssociationEventInputSchema } from '../association/domain.js'
import { CrmConfigCommandSchema, isCrmConfigCommand } from './config-commands.js'
import { PreviewCrmImportFileCleanupCommandSchema, ExecuteCrmImportFileCleanupCommandSchema } from './file-cleanup-types.js'
import { CrmRetentionPolicySchema, PreviewCrmRetentionCommandSchema, ExecuteCrmRetentionCommandSchema } from './retention-types.js'

export const CrmOperationsUuidSchema = z.string().uuid()
export const CrmOperationsStableKeySchema = z.string().trim().toLowerCase()
  .regex(/^[a-z][a-z0-9_-]{0,62}$/)
export const CrmOperationsInstantSchema = z.string().datetime({ offset: true })
export const CrmWordingLocaleSchema = z.enum(APP_LOCALES)
export const CrmLocaleWordingsSchema = z.record(CrmWordingLocaleSchema, z.string().trim().min(1).max(20_000))
export const CrmEffectiveEntitlementQuerySchema = z.object({
  activeOnly: z.boolean().optional(),
  effectiveAt: CrmOperationsInstantSchema.optional(),
}).strict()
export type CrmEffectiveEntitlementQuery = z.infer<typeof CrmEffectiveEntitlementQuerySchema>


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
  z.object({ kind: z.literal('integration_key'), credentialId: CrmOperationsUuidSchema }),
  z.object({
    kind: z.literal('system_job'),
    job: z.enum(['association_expiry', 'association_reconciliation', 'entitlement_expiry', 'entitlement_reconciliation', 'crm_retention', 'crm_delivery']),
    runId: CrmOperationsUuidSchema,
  }),
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
  z.object({
    kind: z.literal('import'),
    jobId: CrmOperationsUuidSchema,
    userId: CrmOperationsUuidSchema,
  }),
])
export type CrmOperationsActor = z.infer<typeof CrmOperationsActorSchema>

/** Trusted native adapter ceiling, never command input. */
export const CrmNativeDeliveryAuthoritySchema = z.object({
  assistantId: CrmOperationsUuidSchema,
  mutationCompartments: z.array(z.string()).max(1000).nullable().default([]),
  compartments: z.array(z.string()).max(1000).nullable(),
  projectIds: z.array(CrmOperationsUuidSchema).max(1000).nullable(),
}).strict()
export type CrmNativeDeliveryAuthority = z.infer<typeof CrmNativeDeliveryAuthoritySchema>

export const CrmOperationsAuthoritySchema = z.object({
  role: z.enum(['member', 'admin', 'owner', 'system']),
  canWrite: z.boolean(),
  canConfigure: z.boolean(),
  trustedIdentitySources: z.array(CrmOperationsStableKeySchema).max(50).default([]),
  integration: CrmIntegrationAuthoritySchema.optional(),
  nativeDelivery: CrmNativeDeliveryAuthoritySchema.optional(),
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
  'existing_or_new',
])
export type CrmIdentityPolicy = z.infer<typeof CrmIdentityPolicySchema>

/** Policies that accept a claimed, unverified email: no verification key or
 *  proof, no owner acknowledgement. `new_or_review` always creates a contact;
 *  `existing_or_new` attaches to the single live match and only fills its
 *  empty fields, so a claim can never overwrite someone else's record. */
export function isUnverifiedIdentityPolicy(policy: CrmIdentityPolicy): boolean {
  return policy === 'new_or_review' || policy === 'existing_or_new'
}

export const CrmIntakeVerificationConfigSchema = z.object({
  keyId: CrmOperationsStableKeySchema,
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  maxAgeSeconds: z.number().int().min(1).max(86_400),
  acknowledged: z.literal(true),
}).strict()

export const CrmIntakeIdentityProofSchema = z.object({
  keyId: CrmOperationsStableKeySchema,
  definitionVersion: z.number().int().positive(),
  verifiedAt: CrmOperationsInstantSchema,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict()
export type CrmIntakeIdentityProof = z.infer<typeof CrmIntakeIdentityProofSchema>

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

export const CrmIntakeAttachmentPolicySchema = z.object({
  key: CrmOperationsStableKeySchema,
  label: z.string().trim().min(1).max(200),
  required: z.boolean().default(false),
  maxBytes: z.number().int().min(1).max(1_048_576),
  mimeTypes: z.array(z.enum(['image/jpeg', 'image/png', 'image/webp'])).min(1).max(3),
}).strict().superRefine((policy, ctx) => {
  if (new Set(policy.mimeTypes).size !== policy.mimeTypes.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mimeTypes'], message: 'attachment MIME types must be unique' })
  }
})
export type CrmIntakeAttachmentPolicy = z.infer<typeof CrmIntakeAttachmentPolicySchema>

export const CrmSubmissionAttachmentSchema = z.object({
  key: CrmOperationsStableKeySchema,
  name: z.string().trim().min(1).max(200)
    .refine((value) => !/[\\/\u0000-\u001f\u007f]/.test(value), 'attachment name must not contain a path or control character'),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  contentBase64: z.string().min(4).max(1_398_104)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, 'attachment must use canonical base64'),
}).strict()
export type CrmSubmissionAttachment = z.infer<typeof CrmSubmissionAttachmentSchema>

export const CrmConsentAnswerMappingSchema = z.object({
  fieldKey: CrmOperationsStableKeySchema,
  grantedValue: z.union([z.string().max(200), z.boolean(), z.number()]),
  purposeKey: CrmOperationsStableKeySchema,
  locale: CrmWordingLocaleSchema.optional(),
  localeFieldKey: CrmOperationsStableKeySchema.optional(),
}).refine((value) => value.locale === undefined || value.localeFieldKey === undefined,
  'choose a fixed locale or a locale field, not both')

export const CrmFollowUpTaskTemplateSchema = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().max(5_000).default(''),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  tags: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
})

export const CrmIntakeDefinitionVersionInputSchema = z.object({
  fields: z.array(CrmIntakeFieldDefinitionSchema).min(1).max(100),
  attachments: z.array(CrmIntakeAttachmentPolicySchema).max(5).optional(),
  identityPolicy: CrmIdentityPolicySchema,
  identityVerification: CrmIntakeVerificationConfigSchema.optional(),
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
  const attachmentKeys = (value.attachments ?? []).map((attachment) => attachment.key)
  if (new Set(attachmentKeys).size !== attachmentKeys.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['attachments'], message: 'attachment keys must be unique' })
  }
  if (attachmentKeys.some((key) => known.has(key))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['attachments'], message: 'attachment keys must not duplicate field keys' })
  }
  for (const [index, mapping] of value.consentMappings.entries()) {
    if (!known.has(mapping.fieldKey)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['consentMappings', index, 'fieldKey'], message: 'consent field must exist in the field catalog' })
    }
    if (mapping.localeFieldKey) {
      const field = value.fields.find((item) => item.key === mapping.localeFieldKey)
      if (!field || field.type !== 'text' || !field.required || !field.options?.length
        || field.options.some((option) => !CrmWordingLocaleSchema.safeParse(option).success)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['consentMappings', index, 'localeFieldKey'], message: 'locale field must be required text with supported locale options' })
      }
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
  rotateFromCredentialId: CrmOperationsUuidSchema.optional(),
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
}).strict()

export const RecordCrmSubmissionCommandSchema = z.object({
  kind: z.literal('record_submission'),
  definitionKey: CrmOperationsStableKeySchema,
  idempotencyKey: z.string().trim().min(1).max(200),
  fields: boundedCrmObject(1_048_576),
  attachments: z.array(CrmSubmissionAttachmentSchema).max(5).optional(),
  externalIdentity: CrmExternalIdentityClaimSchema.optional(),
  identityProof: CrmIntakeIdentityProofSchema.optional(),
  submittedAt: CrmOperationsInstantSchema.optional(),
  campaignAttribution: campaignAttributionContextSchema.optional(),
}).strict()
export type RecordCrmSubmissionCommand = z.infer<typeof RecordCrmSubmissionCommandSchema>

/** Internal production-import envelope. It is deliberately absent from the
 * public CRM command union and tool/REST adapters. */
export const ImportHistoricalCrmSubmissionSchema = z.object({
  importJobId: CrmOperationsUuidSchema,
  importRow: z.number().int().positive(),
  contactId: CrmOperationsUuidSchema,
  source: CrmOperationsStableKeySchema,
  sourceSite: z.string().trim().min(1).max(500),
  sourceForm: z.string().trim().min(1).max(500),
  sourceSubmissionId: z.string().trim().min(1).max(500),
  submittedAt: CrmOperationsInstantSchema,
  status: z.enum(['new', 'in_progress', 'resolved', 'spam']),
  fields: boundedCrmObject(1_048_576),
  subject: z.string().trim().min(1).max(300).default('Historical form submission'),
  message: z.string().trim().min(1).max(20_000).default('Imported historical form submission.'),
  queueKey: CrmOperationsStableKeySchema.default('general'),
}).strict()
export type ImportHistoricalCrmSubmission = z.infer<typeof ImportHistoricalCrmSubmissionSchema>
export type ImportHistoricalCrmSubmissionResult = {
  record: Record<string, unknown>
  created: boolean
  duplicate: boolean
}

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
  defaultLocale: CrmWordingLocaleSchema.nullable().optional(),
  localeWordings: CrmLocaleWordingsSchema.optional(),
  archived: z.boolean().default(false),
}).strict()

export const RecordCrmConsentCommandSchema = z.object({
  kind: z.literal('record_consent'),
  contactId: CrmOperationsUuidSchema,
  purposeKey: CrmOperationsStableKeySchema,
  locale: CrmWordingLocaleSchema.optional(),
  action: z.enum(['granted', 'withdrawn']),
  source: CrmOperationsStableKeySchema,
  occurredAt: CrmOperationsInstantSchema.optional(),
  provider: CrmOperationsStableKeySchema.optional(),
  providerEventId: z.string().trim().min(1).max(500).optional(),
  metadata: boundedCrmObject(8_000).default({}),
}).strict().refine(
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
  providerPeriodId: z.string().trim().min(1).max(500).optional(),
  predecessorId: CrmOperationsUuidSchema.optional(),
}).refine(
  (value) => (value.provider === undefined) === (value.providerEntitlementId === undefined),
  'provider and providerEntitlementId must be supplied together',
).refine(value => !value.providerPeriodId || (!!value.provider && !!value.endsAt), 'A provider period requires provider identity and a finite end').refine(value => !value.predecessorId || !!value.providerPeriodId, 'A predecessor requires a provider period').refine(
  (value) => !value.endsAt || value.startsAt < value.endsAt,
  'endsAt must be after startsAt',
)

export const ExpireDueCrmEntitlementCommandSchema=z.object({kind:z.literal('expire_due_entitlement'),entitlementId:CrmOperationsUuidSchema}).strict()

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
  historicalImport:z.boolean().optional(),
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

export const CorrectCrmParticipationCheckInCommandSchema = z.object({
  kind: z.literal('correct_participation_check_in'),
  participationId: CrmOperationsUuidSchema,
  expectedStatus: z.literal('attended'),
  reason: z.string().trim().min(5).max(500),
}).strict()

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
export const SaveCrmEntitlementPlanCommandSchema = AssociationPlanInputSchema.and(z.object({ kind: z.literal('save_entitlement_plan') }))
export const SaveCrmEventCommandSchema = AssociationEventInputSchema.and(z.object({ kind: z.literal('save_event') }))

export const CrmIntakeReplayPolicySchema = z.object({
  retentionSeconds: z.number().int().min(1).max(2147483647),
}).strict().nullable()
export const SaveCrmPrivacyPolicyCommandSchema = z.object({
  kind: z.literal('save_privacy_policy'),
  expectedVersion: z.number().int().min(0).max(2147483646),
  confirmed: z.literal(true),
  intakeReplay: CrmIntakeReplayPolicySchema,
  addressSuppression: CrmIntakeReplayPolicySchema.optional(),
  retention: CrmRetentionPolicySchema.nullable().optional(),
  importSourceErasure: z.object({
    receiptRetentionSeconds: z.number().int().min(1).max(2147483647),
    heldSourceIds: z.array(CrmOperationsUuidSchema).max(250)
      .refine(ids => new Set(ids.map(id => id.toLowerCase())).size === ids.length, 'Source holds must be distinct.'),
  }).strict().nullable().optional(),
}).strict()

export const ReleaseCrmAddressSuppressionCommandSchema = z.object({
  kind: z.literal('release_address_suppression'),
  tombstoneId: CrmOperationsUuidSchema,
  confirmed: z.literal(true),
  evidenceKind: z.enum(['consent_event', 'workspace_file']),
  evidenceId: CrmOperationsUuidSchema,
}).strict()

export const SaveCrmMailboxIntegrationGrantCommandSchema = z.object({
  kind: z.literal('save_mailbox_integration_grant'),
  credentialId: CrmOperationsUuidSchema,
  connectorInstanceId: CrmOperationsUuidSchema,
  expectedVersion: z.number().int().min(0).max(2147483646),
  confirmed: z.literal(true),
  enabled: z.boolean(),
}).strict()

const DeliveryAddress = z.string().trim().email().max(320).refine(value => !/[\r\n]/.test(value))
const DeliveryAttachment = z.object({
  filename: z.string().min(1).max(255).refine(value => !/[\r\n\0]/.test(value)),
  mime: z.string().min(1).max(150).regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/),
  contentBase64: z.string().max(8 * 1024 * 1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict()
export const SendCrmMessageInputSchema = z.object({
  deliveryId: CrmOperationsUuidSchema,
  connectorInstanceId: CrmOperationsUuidSchema,
  purposeKey: CrmOperationsStableKeySchema,
  templateKey: CrmOperationsStableKeySchema.optional(),
  to: z.array(DeliveryAddress).min(1).max(1000),
  cc: z.array(DeliveryAddress).max(1000).default([]),
  bcc: z.array(DeliveryAddress).max(1000).default([]),
  subject: z.string().max(998).refine(value => !/[\r\n\0]/.test(value)),
  body: z.string().max(200_000),
  attachments: z.array(DeliveryAttachment).max(20).default([]),
}).strict()
const CampaignMailProjectionSchema = z.object({
  text: z.string().max(200_000),
  html: z.string().max(400_000),
  unsubscribeUrl: z.string().url().max(2_048),
  oneClick: z.boolean(),
  replyTo: DeliveryAddress.optional(),
}).strict()
/** Server-authored transport detail. It is deliberately absent from the public tool input schema. */
export const SendCrmMessageCommandSchema = SendCrmMessageInputSchema.extend({
  kind:z.literal('send_message'),
  campaignMail: CampaignMailProjectionSchema.optional(),
}).superRefine((value,ctx) => {
  if(value.to.length+value.cc.length+value.bcc.length>1000) ctx.addIssue({code:z.ZodIssueCode.custom,message:'A delivery may contain at most 1000 recipients.'})
  if(new TextEncoder().encode(JSON.stringify(value)).byteLength>8*1024*1024) ctx.addIssue({code:z.ZodIssueCode.custom,message:'A delivery envelope may contain at most 8 MiB.'})
})
export type SendCrmMessageCommand = z.infer<typeof SendCrmMessageCommandSchema>
export type CrmDeliveryReceipt = {
  deliveryId: string; connectorInstanceId: string; providerKey: string; purposeKey: string;
  status: 'pending'|'dispatching'|'sent'|'blocked'|'failed'|'needs_reconciliation';
  errorCode: string|null; providerReceipt: Record<string,unknown>|null;
  acceptedAt: string|null; confirmedAt: string|null; redactedAt: string|null;
  createdAt: string; updatedAt: string;
}
export type CrmDeliveryServicePort = {
  send(context: CrmOperationsContext, command: SendCrmMessageCommand): Promise<{receipt: CrmDeliveryReceipt; duplicate: boolean}>
  get(context: CrmOperationsContext, deliveryId: string): Promise<CrmDeliveryReceipt|null>
}

export const SaveCrmManagedMailboxPolicyCommandSchema = z.object({
  kind: z.literal('save_managed_mailbox_policy'),
  connectorInstanceId: CrmOperationsUuidSchema,
  providerKey: CrmOperationsStableKeySchema,
  expectedVersion: z.number().int().min(0).max(2147483646),
  confirmed: z.literal(true),
  managed: z.boolean(),
  purposeKeys: z.array(CrmOperationsStableKeySchema).max(200),
  templatePurposes: z.record(CrmOperationsStableKeySchema, CrmOperationsStableKeySchema).default({}),
}).strict().superRefine((policy, ctx) => {
  if (policy.managed && !policy.purposeKeys.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['purposeKeys'], message: 'Managed mail requires explicit purposes.' })
  if (new Set(policy.purposeKeys).size !== policy.purposeKeys.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['purposeKeys'], message: 'Purposes must be unique.' })
  if (Object.keys(policy.templatePurposes).length > 200 || Object.values(policy.templatePurposes).some((key) => !policy.purposeKeys.includes(key))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['templatePurposes'], message: 'Templates must map to an allowed purpose, with at most 200 mappings.' })
  }
})

export const PreviewCrmContactErasureCommandSchema = z.object({
  kind:z.literal('preview_contact_erasure'),
  contactId:CrmOperationsUuidSchema,
}).strict()
export const EraseCrmContactWithPreviewCommandSchema = z.object({
  kind:z.literal('erase_contact_with_preview'),
  contactId:CrmOperationsUuidSchema,
  previewId:CrmOperationsUuidSchema,
  previewHash:z.string().regex(/^[a-f0-9]{64}$/),
  confirmed:z.literal(true),
}).strict()
export type CrmPrivacyDomainReview = {domain:string;action:'delete'|'redact'|'retire'|'retain'|'blocked';count:number}
export type CrmPrivacyBlocker = {domain:string;reason:string;count:number}
export type CrmErasurePreview = {
  id:string;workspaceId:string;contactId:string;previewHash:string;expiresAt:string;
  policyVersion:number;domains:CrmPrivacyDomainReview[];blockers:CrmPrivacyBlocker[];scopeLimits:string[];status:'ready'|'blocked'
}
export interface CrmPrivacyServicePort {
  preview(context:CrmOperationsContext,command:z.infer<typeof PreviewCrmContactErasureCommandSchema>):Promise<CrmErasurePreview>
  erase(context:CrmOperationsContext,command:z.infer<typeof EraseCrmContactWithPreviewCommandSchema>):Promise<{receipt:Record<string,unknown>;duplicate:boolean}>
}

export const CrmOperationsCommandSchema = z.union([
  PreviewCrmImportFileCleanupCommandSchema,
  ExecuteCrmImportFileCleanupCommandSchema,
  PreviewCrmRetentionCommandSchema,
  ExecuteCrmRetentionCommandSchema,
  PreviewCrmContactErasureCommandSchema,
  EraseCrmContactWithPreviewCommandSchema,
  CrmConfigCommandSchema,
  SaveCrmPrivacyPolicyCommandSchema,
  ReleaseCrmAddressSuppressionCommandSchema,
  SaveCrmManagedMailboxPolicyCommandSchema,
  SaveCrmMailboxIntegrationGrantCommandSchema,
  SendCrmMessageCommandSchema,
  SaveCrmEntitlementPlanCommandSchema,
  SaveCrmEventCommandSchema,
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
  ExpireDueCrmEntitlementCommandSchema,
  GrantCrmEntitlementCommandSchema,
  UpdateCrmEntitlementCommandSchema,
  RecordCrmParticipationCommandSchema,
  UpdateCrmParticipationCommandSchema,
  CorrectCrmParticipationCheckInCommandSchema,
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
  'association.inventory.sold_out',
  'association.inventory.available',
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

/** Internal port used only by the confirmed production-import service. */
export interface CrmHistoricalSubmissionImportPort {
  importHistoricalSubmission(
    context: CrmOperationsContext,
    input: ImportHistoricalCrmSubmission,
  ): Promise<ImportHistoricalCrmSubmissionResult>
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
    case 'integration_key':
    case 'intake_key':
      return { actorKind: actor.kind, actorCredentialId: actor.credentialId, actingUserId: null }
    case 'oauth_token':
    case 'home_app':
      return { actorKind: actor.kind, actorCredentialId: actor.credentialId, actingUserId: actor.userId ?? null }
    case 'provider':
      return { actorKind: actor.kind, actorCredentialId: actor.eventId, actingUserId: null }
    case 'import':
      return { actorKind: actor.kind, actorCredentialId: actor.jobId, actingUserId: actor.userId }
    case 'system_job':
      return { actorKind: actor.kind, actorCredentialId: `${actor.job}:${actor.runId}`, actingUserId: null }
  }
}

export function commandRequiresConfigurationAuthority(command: CrmOperationsCommand): boolean {
  return isCrmConfigCommand(command) || command.kind === 'save_entitlement_plan'
    || command.kind === 'save_event'
    || command.kind === 'save_intake_definition'
    || command.kind === 'create_intake_credential'
    || command.kind === 'revoke_intake_credential'
    || command.kind === 'save_consent_purpose'
    || command.kind === 'save_privacy_policy'
    || command.kind === 'preview_import_file_cleanup'
    || command.kind === 'execute_import_file_cleanup'
    || command.kind === 'preview_retention'
    || command.kind === 'execute_retention'
    || command.kind === 'preview_contact_erasure'
    || command.kind === 'erase_contact_with_preview'
    || command.kind === 'release_address_suppression'
    || command.kind === 'save_managed_mailbox_policy'
    || command.kind === 'save_mailbox_integration_grant'
}

export function assertCrmOperationsAuthority(
  context: CrmOperationsContext,
  command: CrmOperationsCommand,
): void {
  if(command.kind==='expire_due_entitlement' && !(context.actor.kind==='system_job' && context.actor.job==='entitlement_expiry')) {
    throw new CrmOperationsError('not_authorized','Due entitlement expiry requires its dedicated system job.')
  }
  if (['preview_import_file_cleanup', 'execute_import_file_cleanup', 'preview_retention', 'execute_retention', 'preview_contact_erasure', 'erase_contact_with_preview', 'save_privacy_policy', 'release_address_suppression', 'save_managed_mailbox_policy', 'save_mailbox_integration_grant', 'correct_participation_check_in'].includes(command.kind) && (context.actor.kind !== 'user'
    || !['owner', 'admin'].includes(context.authority.role))) {
    throw new CrmOperationsError('not_authorized', 'This reviewed operation requires a workspace owner or admin member.')
  }
  if (context.actor.kind === 'integration_key' && context.authority.integration?.credentialId !== context.actor.credentialId) {
    throw new CrmOperationsError('not_authorized', 'Integration authority must come from its authenticated credential.')
  }
  if (context.authority.integration) {
    const operations: Partial<Record<CrmOperationsCommand['kind'], CrmIntegrationOperation>> = {
      send_message: 'crm.delivery.dispatch',
      create_record_field: 'crm.catalog.configure', update_record_field: 'crm.catalog.configure',
      set_record_field_archived: 'crm.catalog.configure', create_pipeline: 'crm.catalog.configure',
      update_pipeline: 'crm.catalog.configure', create_pipeline_stage: 'crm.catalog.configure',
      update_pipeline_stage: 'crm.catalog.configure',
      save_intake_definition: 'crm.catalog.configure', save_consent_purpose: 'crm.catalog.configure',
      save_entitlement_plan: 'crm.catalog.configure', save_event: 'crm.catalog.configure',
      record_submission: 'crm.submissions.write', update_submission: 'crm.submissions.write',
      record_consent: 'crm.consent.write', record_suppression: 'crm.consent.write',
      save_segment: 'crm.records.write', archive_segment: 'crm.records.write',
      grant_entitlement: 'crm.entitlements.write', update_entitlement: 'crm.entitlements.write',
      record_participation: 'crm.participation.write', update_participation: 'crm.participation.write',
      set_deal_pipeline_stage: 'crm.records.write',
    }
    const operation = operations[command.kind]
    if (!operation) throw new CrmOperationsError('not_authorized', 'This operation is not available to integration credentials.')
    requireCrmIntegrationOperation(context.authority.integration, operation)
    if (context.authority.trustedIdentitySources.length) {
      throw new CrmOperationsError('not_authorized', 'Integration configuration cannot nominate trusted identity sources.')
    }
  }
  if (context.actor.kind === 'system_job') {
    const expiry = context.actor.job === 'entitlement_expiry' && command.kind === 'expire_due_entitlement'
    const reconcile = context.actor.job === 'entitlement_reconciliation' && ['grant_entitlement', 'update_entitlement'].includes(command.kind)
    if (!expiry && !reconcile) throw new CrmOperationsError('not_authorized', 'This job cannot perform that CRM command.')
  }
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
