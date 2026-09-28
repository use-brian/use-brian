/**
 * Server-owned CRM import preflight and resumable commit.
 *
 * The browser only stages bytes and proposes a mapping. This service parses
 * the complete immutable file, owns row receipts/chunk checkpoints, and sends
 * operational evidence through CrmOperationsService.
 *
 * [COMP:crm/production-import]
 */

import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Pool, PoolClient } from 'pg'
import type {
  AccessContext,
  CrmOperationsContext,
  CrmOperationsServicePort,
  CrmHistoricalSubmissionImportPort,
  AssociationPromotionImportPort,
  AssociationSourceMembershipImportPort,
  AssociationSourceOrderImportPort,
  EntityLinksStore,
  FilesApi,
  StableExternalIdentity,
  CrmIntegrationGrant,
  CrmPage,
  CrmPageQuery,
} from '@use-brian/core'
import { AssociationPromotionImportSchema, AssociationSourceMembershipImportSchema, AssociationSourceOrderImportSchema, CrmIntegrationGrantsSchema, CrmOperationsError } from '@use-brian/core'
import { createCompany, createContact, createDeal, updateContact, type CrmWriteTransaction } from '../db/crm.js'
import { updateCrmCustomFields } from '../db/crm-r2.js'
import { getEntityById, updateEntity } from '../db/entities-store.js'
import { getPool, query } from '../db/client.js'
import { parseCsv } from '../linkedin-import/csv.js'
import { createCrmImportSources, type CrmImportSources } from '../db/crm-import-sources.js'
import { importGrantSnapshot, requireImportCeiling, requireImportOperation, requireImportRowAuthority } from './import-authority.js'
import { crmPageInstant, queryCrmPage } from './pagination.js'

const MAX_IMPORT_BYTES = 30 * 1024 * 1024
const MAX_IMPORT_ROWS = 100_000
const CHUNK_ROWS = 50
const SAMPLE_ERRORS = 25

const ImportEntityKindSchema = z.enum(['contact', 'company', 'deal', 'operations'])
export type CrmImportEntityKind = z.infer<typeof ImportEntityKindSchema>

const BASE_TARGETS = new Set([
  'name', 'email', 'phone', 'tags', 'domain', 'companyId', 'contactId',
  'stage', 'amount', 'currencyCode', 'closeDate', 'source', 'pipelineId',
  'stageId', 'identityProvider', 'identityProviderInstance', 'identitySubject',
  'consentPurposeKey', 'consentAction', 'consentSource', 'consentOccurredAt',
  'suppressionChannel', 'suppressionAction', 'suppressionReasonCode',
  'suppressionSource', 'suppressionOccurredAt', 'entitlementPlanId', 'entitlementIdempotencyKey',
  'entitlementStatus', 'entitlementStartsAt', 'entitlementEndsAt',
  'entitlementRenewalMode', 'participationEventId', 'participationSourceId',
  'participationStatus', 'participationHistoricalImport', 'participantName', 'participantEmail',
  'historicalSubmissionSource', 'historicalSubmissionSite', 'historicalSubmissionForm',
  'historicalSubmissionId', 'historicalSubmissionOccurredAt', 'historicalSubmissionStatus',
  'historicalSubmissionFieldsJson', 'historicalSubmissionSubject',
  'historicalSubmissionMessage', 'historicalSubmissionQueueKey',
  'sourceOrderSource', 'sourceOrderSite', 'sourceOrderId',
  'sourceOrderOccurredAt', 'sourceOrderStatus', 'sourceOrderCurrency',
  'sourceOrderSubtotalMinor', 'sourceOrderDiscountMinor', 'sourceOrderTotalMinor',
  'sourceOrderRefundedMinor', 'sourceOrderReservationExpiresAt',
  'sourceOrderProvider', 'sourceOrderProviderReference', 'sourceOrderLinesJson',
  'sourceOrderMetadataJson',
  'promotionSource', 'promotionSite', 'promotionId', 'promotionKey', 'promotionName',
  'promotionCodeDigest', 'promotionDiscountType', 'promotionPercentageBasisPoints',
  'promotionAmountMinor', 'promotionCurrency', 'promotionBuyQuantity', 'promotionGetQuantity',
  'promotionTargetKind', 'promotionTargetIdsJson', 'promotionRecurrenceMode',
  'promotionRecurrenceCycles', 'promotionApplyMode',
  'promotionValidFrom', 'promotionValidTo', 'promotionMaxUses', 'promotionMaxUsesPerContact',
  'promotionCombinesWithMemberPrice', 'promotionReleaseOnFullRefund', 'promotionStatus',
  'promotionSourceRedeemedUses', 'promotionSourceContactUsesJson',
  'sourceMembershipSource', 'sourceMembershipSite', 'sourceMembershipId',
  'sourceMembershipPlanId', 'sourceMembershipMemberId', 'sourceMembershipOrderId',
  'sourceMembershipSubscriptionId', 'sourceMembershipPaymentProvider',
  'sourceMembershipPaymentReference', 'sourceMembershipStatus',
  'sourceMembershipRenewalStatus', 'sourceMembershipPaymentStatus',
  'sourceMembershipRefundStatus', 'sourceMembershipPurchasedAt',
  'sourceMembershipCancelledAt', 'sourceMembershipRelationshipsJson',
  'sourceMembershipMetadataJson',
])

function validTarget(target: string): boolean {
  return BASE_TARGETS.has(target) || /^custom:[a-z][a-z0-9_-]{0,62}$/.test(target)
}

export const CrmImportMappingSchema = z.object({
  columns: z.record(z.string(), z.string().trim().min(1).max(100).nullable()),
  trustedIdentitySource: z.string().trim().toLowerCase()
    .regex(/^[a-z][a-z0-9_-]{0,62}$/).optional(),
}).strict().superRefine((mapping, ctx) => {
  const used = new Set<string>()
  for (const [index, target] of Object.entries(mapping.columns)) {
    if (!/^\d+$/.test(index)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['columns', index], message: 'column index must be a non-negative integer' })
    }
    if (target && !validTarget(target)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['columns', index], message: 'unknown import target' })
    }
    if (target && used.has(target)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['columns', index], message: 'an import target may be mapped once' })
    }
    if (target) used.add(target)
  }
})
export type CrmImportMapping = z.infer<typeof CrmImportMappingSchema>

const ImportInputSchema = z.object({
  stagedFileId: z.string().uuid().optional(),
  sourceId: z.string().uuid().optional(),
  entityKind: ImportEntityKindSchema,
  mapping: CrmImportMappingSchema,
}).strict()

const hasOneSource = (input: { stagedFileId?: string; sourceId?: string }) => !!input.stagedFileId !== !!input.sourceId
export const CrmImportPreflightSchema = ImportInputSchema.refine(hasOneSource, 'Choose exactly one import source.')
export const CrmImportConfirmSchema = ImportInputSchema.extend({
  confirmed: z.literal(true),
  dryRunHash: z.string().regex(/^[0-9a-f]{64}$/),
  confirmationKey: z.string().uuid().optional(),
}).strict().refine(hasOneSource, 'Choose exactly one import source.')

type ImportInput = z.infer<typeof CrmImportPreflightSchema>
type ConfirmInput = z.infer<typeof CrmImportConfirmSchema>

export type CrmImportError = {
  row: number
  code: string
  field?: string
  message: string
}

export type CrmImportDryRun = {
  dryRunHash: string
  bytes: number
  totalRows: number
  validRows: number
  failedRows: number
  headers: string[]
  sampleErrors: CrmImportError[]
}

export type CrmImportJob = {
  id: string
  workspaceId: string
  stagedFileId: string | null
  sourceId: string | null
  entityKind: CrmImportEntityKind
  status: 'ready' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed'
  privacyErased: boolean
  privacyErasedAt: Date | null
  mapping: CrmImportMapping
  totalRows: number
  processedRows: number
  succeededRows: number
  failedRows: number
  nextChunkIndex: number
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
}

type ImportJobRow = CrmImportJob & {
  mappingHash: string
  sourceHash: string
  confirmationKey: string | null
  createdByUserId: string | null
  integrationCredentialId: string | null
  integrationGrants: CrmIntegrationGrant[] | null
}

type ParsedImport = {
  bytes: Uint8Array
  sourceHash: string
  headers: string[]
  rows: Array<{ row: number; cells: string[]; malformedReason?: string }>
  sourceAuthority?: { credentialId: string; grants: CrmIntegrationGrant[] }
}

type ImportCustomDefinition = {
  fieldKey: string
  fieldType: 'text' | 'number' | 'date' | 'boolean' | 'single_select' | 'multi_select' | 'entity_reference'
  options: string[]
}

type ImportServiceContext = CrmOperationsContext

const IMPORT_RESULT_KINDS = [
  'contact', 'company', 'deal', 'consent', 'suppression', 'entitlement',
  'participation', 'submission', 'order', 'registration', 'promotion',
] as const
type ImportResultKind = typeof IMPORT_RESULT_KINDS[number]
type ImportResultRef = { kind: ImportResultKind; id: string; sourceId?: string }
type ImportRowResult = { entityId: string | null; resultRefs: ImportResultRef[] }

const ImportResultIdSchema = z.string().uuid()

function resultId(record: Record<string, unknown>, label: string): string {
  const parsed = ImportResultIdSchema.safeParse(record.id)
  if (!parsed.success) throw new Error(`${label} did not return a stable id.`)
  return parsed.data
}

function resultRef(kind: ImportResultKind, record: Record<string, unknown>, sourceId?: unknown): ImportResultRef {
  const ref: ImportResultRef = { kind, id: resultId(record, kind) }
  if (sourceId !== undefined) {
    if (typeof sourceId !== 'string' || sourceId.length < 1 || sourceId.length > 500) {
      throw new Error(`${kind} did not return a valid source id.`)
    }
    ref.sourceId = sourceId
  }
  return ref
}

function sourceRegistrationId(record: Record<string, unknown>): unknown {
  const metadata = record.attendeeMetadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined
  const historical = (metadata as Record<string, unknown>).historicalSource
  if (!historical || typeof historical !== 'object' || Array.isArray(historical)) return undefined
  return (historical as Record<string, unknown>).registrationId
}

function uniqueResultRefs(refs: ImportResultRef[]): ImportResultRef[] {
  const seen = new Set<string>()
  return refs.filter((ref) => {
    const key = JSON.stringify([ref.kind, ref.id, ref.sourceId ?? null])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonicalMapping(mapping: CrmImportMapping): string {
  const columns = Object.fromEntries(Object.entries(mapping.columns)
    .sort(([left], [right]) => Number(left) - Number(right)))
  return JSON.stringify({ columns, trustedIdentitySource: mapping.trustedIdentitySource ?? null })
}

function mappingHash(mapping: CrmImportMapping): string {
  return createHash('sha256').update(canonicalMapping(mapping)).digest('hex')
}

function dryRunHash(sourceHash: string, mapping: CrmImportMapping, entityKind: string): string {
  return createHash('sha256').update(`${sourceHash}:${entityKind}:${mappingHash(mapping)}`).digest('hex')
}

function rowHash(cells: string[], mapping: CrmImportMapping): string {
  return createHash('sha256').update(JSON.stringify([cells, canonicalMapping(mapping)])).digest('hex')
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function mappedValues(cells: string[], mapping: CrmImportMapping): Record<string, string> {
  const output: Record<string, string> = {}
  for (const [rawIndex, target] of Object.entries(mapping.columns)) {
    if (!target) continue
    const value = clean(cells[Number(rawIndex)])
    if (value !== undefined) output[target] = value
  }
  return output
}

function parseCustomValue(definition: ImportCustomDefinition, value: string): unknown {
  switch (definition.fieldType) {
    case 'text':
      if (value.length > 10_000) throw new Error('Text exceeds 10000 characters.')
      return value
    case 'number': {
      const parsed = Number(value)
      if (!Number.isFinite(parsed)) throw new Error('Number must be finite.')
      return parsed
    }
    case 'date': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Date must use YYYY-MM-DD.')
      const [year, month, day] = value.split('-').map(Number)
      const parsed = new Date(Date.UTC(year, month - 1, day))
      if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
        throw new Error('Date must be a real calendar day.')
      }
      return value
    }
    case 'boolean': {
      const normalized = value.trim().toLowerCase()
      if (['true', 'yes', '1', 'on'].includes(normalized)) return true
      if (['false', 'no', '0', 'off'].includes(normalized)) return false
      throw new Error('Boolean must be true/false, yes/no, 1/0, or on/off.')
    }
    case 'single_select':
      if (!definition.options.includes(value)) throw new Error(`Value must be one of: ${definition.options.join(', ')}.`)
      return value
    case 'multi_select': {
      const values = value.split(/[|;]/).map((item) => item.trim()).filter(Boolean)
      if (values.some((item) => !definition.options.includes(item))) {
        throw new Error(`Every value must be one of: ${definition.options.join(', ')}.`)
      }
      return values
    }
    case 'entity_reference':
      if (!isUuid(value)) throw new Error('Reference must be a visible CRM entity UUID.')
      return value
  }
}

function customValuesFor(
  values: Record<string, string>,
  catalog: ReadonlyMap<string, ImportCustomDefinition>,
): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [target, value] of Object.entries(values)) {
    if (!target.startsWith('custom:')) continue
    const key = target.slice('custom:'.length)
    const definition = catalog.get(key)
    if (!definition) throw new Error(`Unknown custom field '${key}'.`)
    output[key] = parseCustomValue(definition, value)
  }
  return output
}

function isUuid(value: string | undefined): boolean {
  return !!value && z.string().uuid().safeParse(value).success
}

const HistoricalSubmissionFieldsSchema = z.record(
  z.string().trim().min(1).max(500),
  z.unknown(),
).refine(
  (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 1_048_576,
  'Historical submission data must be no more than 1 MiB.',
)

function historicalSubmissionFields(raw: string | undefined): Record<string, unknown> {
  if (!raw) throw new Error('Historical submission data is required.')
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch { throw new Error('Historical submission data must be a JSON object.') }
  const result = HistoricalSubmissionFieldsSchema.safeParse(parsed)
  if (!result.success) throw new Error(result.error.issues[0]?.message ?? 'Historical submission data is invalid.')
  return result.data
}

function jsonValue(raw: string | undefined, label: string, fallback?: unknown): unknown {
  if (!raw) {
    if (fallback !== undefined) return fallback
    throw new Error(`${label} is required.`)
  }
  try { return JSON.parse(raw) }
  catch { throw new Error(`${label} must contain valid JSON.`) }
}

function sourceOrderInput(values: Record<string, string>, importJobId: string, importRow: number) {
  return AssociationSourceOrderImportSchema.parse({
    importJobId,
    importRow,
    contactId: values.contactId,
    source: values.sourceOrderSource,
    sourceSite: values.sourceOrderSite,
    sourceOrderId: values.sourceOrderId,
    occurredAt: values.sourceOrderOccurredAt,
    status: values.sourceOrderStatus,
    currency: values.sourceOrderCurrency,
    subtotalMinor: Number(values.sourceOrderSubtotalMinor),
    discountMinor: Number(values.sourceOrderDiscountMinor ?? '0'),
    totalMinor: Number(values.sourceOrderTotalMinor),
    refundedMinor: Number(values.sourceOrderRefundedMinor ?? '0'),
    reservationExpiresAt: values.sourceOrderReservationExpiresAt,
    provider: values.sourceOrderProvider,
    providerReference: values.sourceOrderProviderReference,
    lines: jsonValue(values.sourceOrderLinesJson, 'Source order lines'),
    metadata: jsonValue(values.sourceOrderMetadataJson, 'Source order metadata', {}),
  })
}

function sourceMembershipInput(values: Record<string, string>, importJobId: string, importRow: number) {
  return AssociationSourceMembershipImportSchema.parse({
    importJobId,
    importRow,
    contactId: values.contactId,
    planId: values.entitlementPlanId,
    idempotencyKey: values.entitlementIdempotencyKey,
    status: values.entitlementStatus ?? 'pending',
    startsAt: values.entitlementStartsAt,
    endsAt: values.entitlementEndsAt,
    targetRenewalMode: values.entitlementRenewalMode ?? 'none',
    source: values.sourceMembershipSource,
    sourceSite: values.sourceMembershipSite,
    sourceMembershipId: values.sourceMembershipId,
    sourcePlanId: values.sourceMembershipPlanId,
    sourceMemberId: values.sourceMembershipMemberId,
    sourceOrderId: values.sourceMembershipOrderId,
    sourceSubscriptionId: values.sourceMembershipSubscriptionId,
    sourcePaymentProvider: values.sourceMembershipPaymentProvider,
    sourcePaymentReference: values.sourceMembershipPaymentReference,
    sourceStatus: values.sourceMembershipStatus,
    sourceRenewalStatus: values.sourceMembershipRenewalStatus,
    sourcePaymentStatus: values.sourceMembershipPaymentStatus,
    sourceRefundStatus: values.sourceMembershipRefundStatus,
    purchasedAt: values.sourceMembershipPurchasedAt,
    cancelledAt: values.sourceMembershipCancelledAt,
    relationships: jsonValue(values.sourceMembershipRelationshipsJson, 'Source membership relationships', {}),
    metadata: jsonValue(values.sourceMembershipMetadataJson, 'Source membership metadata', {}),
  })
}

function importBoolean(raw: string | undefined, label: string): boolean {
  const normalized = raw?.trim().toLowerCase()
  if (['true', 'yes', '1', 'on'].includes(normalized ?? '')) return true
  if (['false', 'no', '0', 'off'].includes(normalized ?? '')) return false
  throw new Error(`${label} must be true/false, yes/no, 1/0, or on/off.`)
}

function optionalNumber(raw: string | undefined): number | undefined {
  return raw === undefined ? undefined : Number(raw)
}

function promotionImportInput(values: Record<string, string>, importJobId: string, importRow: number) {
  return AssociationPromotionImportSchema.parse({
    importJobId,
    importRow,
    source: values.promotionSource,
    sourceSite: values.promotionSite,
    sourcePromotionId: values.promotionId,
    codeDigest: values.promotionCodeDigest,
    promotion: {
      key: values.promotionKey,
      name: values.promotionName,
      discountType: values.promotionDiscountType,
      percentageBasisPoints: optionalNumber(values.promotionPercentageBasisPoints),
      amountMinor: optionalNumber(values.promotionAmountMinor),
      currency: values.promotionCurrency,
      buyQuantity: optionalNumber(values.promotionBuyQuantity),
      getQuantity: optionalNumber(values.promotionGetQuantity),
      targetKind: values.promotionTargetKind,
      targetIds: jsonValue(values.promotionTargetIdsJson, 'Promotion target IDs'),
      recurrenceMode: values.promotionRecurrenceMode,
      recurrenceCycles: optionalNumber(values.promotionRecurrenceCycles),
      applyMode: values.promotionApplyMode,
      validFrom: values.promotionValidFrom,
      validTo: values.promotionValidTo,
      maxUses: optionalNumber(values.promotionMaxUses),
      maxUsesPerContact: optionalNumber(values.promotionMaxUsesPerContact),
      combinesWithMemberPrice: importBoolean(values.promotionCombinesWithMemberPrice, 'Promotion member-price combination'),
      releaseOnFullRefund: importBoolean(values.promotionReleaseOnFullRefund, 'Promotion refund release'),
      status: values.promotionStatus,
    },
    sourceRedeemedUses: Number(values.promotionSourceRedeemedUses),
    sourceContactUses: jsonValue(values.promotionSourceContactUsesJson, 'Promotion source contact usage', []),
  })
}

function validateMappedRow(
  kind: CrmImportEntityKind,
  row: { row: number; cells: string[]; malformedReason?: string },
  mapping: CrmImportMapping,
  customCatalog: ReadonlyMap<string, ImportCustomDefinition> = new Map(),
): CrmImportError[] {
  const values = mappedValues(row.cells, mapping)
  const errors: CrmImportError[] = []
  const add = (code: string, message: string, field?: string) => errors.push({ row: row.row, code, message, ...(field ? { field } : {}) })
  if (row.malformedReason) add('malformed_csv', 'The CSV record is malformed.')
  if (kind !== 'operations' && !values.name) add('required_field', 'Name is required.', 'name')
  if (values.amount !== undefined && (!Number.isFinite(Number(values.amount)) || Number(values.amount) < 0)) {
    add('invalid_number', 'Amount must be a non-negative number.', 'amount')
  }
  if (values.closeDate !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.closeDate)) {
    add('invalid_date', 'Close date must use YYYY-MM-DD.', 'closeDate')
  }
  for (const field of ['companyId', 'contactId', 'pipelineId', 'stageId', 'entitlementPlanId', 'participationEventId']) {
    if (values[field] !== undefined && !isUuid(values[field])) add('invalid_id', 'The value must be a UUID.', field)
  }
  if ((values.pipelineId === undefined) !== (values.stageId === undefined)) {
    add('incomplete_pipeline', 'Pipeline and stage IDs must be mapped together.', 'pipelineId')
  }
  const identity = [values.identityProvider, values.identityProviderInstance, values.identitySubject]
  if (identity.some(Boolean) && !identity.every(Boolean)) {
    add('incomplete_identity', 'Provider, provider instance, and subject are required together.', 'identityProvider')
  }
  if (mapping.trustedIdentitySource && values.identityProvider
    && values.identityProvider !== mapping.trustedIdentitySource) {
    add('identity_source_mismatch', 'The mapped identity provider must match the confirmed trusted source.', 'identityProvider')
  }
  const hasConsent = values.consentPurposeKey || values.consentAction || values.consentSource || values.consentOccurredAt
  if (hasConsent && !(values.consentPurposeKey && values.consentAction && values.consentSource)) {
    add('incomplete_consent', 'Consent purpose, action, and source are required together.', 'consentPurposeKey')
  }
  if (values.consentAction && !['granted', 'withdrawn'].includes(values.consentAction)) {
    add('invalid_consent_action', 'Consent action must be granted or withdrawn.', 'consentAction')
  }
  if (values.consentPurposeKey && !/^[a-z][a-z0-9_-]{0,62}$/.test(values.consentPurposeKey)) {
    add('invalid_catalog_key', 'Consent purpose must be a stable catalog key.', 'consentPurposeKey')
  }
  const hasSuppression = values.suppressionChannel || values.suppressionAction || values.suppressionReasonCode || values.suppressionSource || values.suppressionOccurredAt
  if (hasSuppression && !(values.suppressionChannel && values.suppressionAction && values.suppressionReasonCode && values.suppressionSource)) {
    add('incomplete_suppression', 'Suppression channel, action, reason, and source are required together.', 'suppressionChannel')
  }
  if (values.suppressionChannel && !['all', 'email', 'sms', 'phone', 'whatsapp', 'telegram', 'slack'].includes(values.suppressionChannel)) {
    add('invalid_suppression_channel', 'Suppression channel is outside the supported catalog.', 'suppressionChannel')
  }
  if (values.suppressionAction && !['suppressed', 'released'].includes(values.suppressionAction)) {
    add('invalid_suppression_action', 'Suppression action must be suppressed or released.', 'suppressionAction')
  }
  if (values.suppressionReasonCode && ![
    'manual_do_not_contact', 'hard_bounce', 'soft_bounce', 'complaint',
    'provider_block', 'legal', 'invalid_address', 'other',
  ].includes(values.suppressionReasonCode)) {
    add('invalid_suppression_reason', 'Suppression reason is outside the supported catalog.', 'suppressionReasonCode')
  }
  for (const field of ['consentOccurredAt', 'suppressionOccurredAt']) {
    if (!values[field]) continue
    try { crmPageInstant(values[field]) }
    catch { add('invalid_instant', 'Value must be an ISO timestamp with a timezone and at most six fractional digits.', field) }
  }
  const hasEntitlement = values.entitlementPlanId || values.entitlementIdempotencyKey || values.entitlementStartsAt
  if (hasEntitlement && !(values.entitlementPlanId && values.entitlementIdempotencyKey && values.entitlementStartsAt)) {
    add('incomplete_entitlement', 'Entitlement plan, idempotency key, and start time are required together.', 'entitlementPlanId')
  }
  if (values.entitlementStatus && !['pending', 'active', 'expired', 'cancelled'].includes(values.entitlementStatus)) {
    add('invalid_entitlement_status', 'Entitlement status is outside the supported catalog.', 'entitlementStatus')
  }
  if (values.entitlementRenewalMode && !['none', 'manual', 'auto'].includes(values.entitlementRenewalMode)) {
    add('invalid_renewal_mode', 'Renewal mode must be none, manual, or auto.', 'entitlementRenewalMode')
  }
  for (const field of ['entitlementStartsAt', 'entitlementEndsAt']) {
    if (values[field] && Number.isNaN(Date.parse(values[field]))) add('invalid_instant', 'Value must be an ISO timestamp.', field)
  }
  const sourceMembershipFields = [
    values.sourceMembershipSource, values.sourceMembershipSite, values.sourceMembershipId,
    values.sourceMembershipPlanId, values.sourceMembershipMemberId, values.sourceMembershipOrderId,
    values.sourceMembershipSubscriptionId, values.sourceMembershipPaymentProvider,
    values.sourceMembershipPaymentReference, values.sourceMembershipStatus,
    values.sourceMembershipRenewalStatus, values.sourceMembershipPaymentStatus,
    values.sourceMembershipRefundStatus, values.sourceMembershipPurchasedAt,
    values.sourceMembershipCancelledAt, values.sourceMembershipRelationshipsJson,
    values.sourceMembershipMetadataJson,
  ]
  const hasSourceMembership = sourceMembershipFields.some((value) => value !== undefined)
  if (hasSourceMembership && !(
    values.sourceMembershipSource && values.sourceMembershipSite && values.sourceMembershipId
    && values.sourceMembershipPlanId && values.sourceMembershipStatus
    && values.sourceMembershipRenewalStatus && values.sourceMembershipPurchasedAt
    && values.entitlementPlanId && values.entitlementIdempotencyKey && values.entitlementStartsAt
  )) add('incomplete_source_membership', 'Source membership identity, plan, status, renewal state, purchase time, and target entitlement are required together.', 'sourceMembershipSource')
  if (hasSourceMembership) {
    if (kind !== 'operations') add('invalid_source_membership_kind', 'Source memberships require an operations import.', 'sourceMembershipSource')
    try { sourceMembershipInput(values, '00000000-0000-4000-8000-000000000000', row.row) }
    catch (error) { add('invalid_source_membership', error instanceof Error ? error.message : 'Source membership evidence is invalid.', 'sourceMembershipSource') }
  }
  const hasParticipation = values.participationEventId || values.participationSourceId || values.participationStatus || values.participationHistoricalImport
  if (hasParticipation && !(values.participationEventId && values.participationSourceId && values.participantName)) {
    add('incomplete_participation', 'Participation event, source, and attendee name are required together.', 'participationEventId')
  }
  if (values.participationStatus && !['registered', 'attended', 'cancelled', 'no_show'].includes(values.participationStatus)) {
    add('invalid_participation_status', 'Participation status is outside the supported catalog.', 'participationStatus')
  }
  if (values.participationHistoricalImport && !['true', 'false'].includes(values.participationHistoricalImport)) {
    add('invalid_historical_import', 'Historical import must be true or false.', 'participationHistoricalImport')
  }
  if (values.participantEmail && !z.string().email().safeParse(values.participantEmail).success) {
    add('invalid_email', 'Participant email is invalid.', 'participantEmail')
  }
  const hasHistoricalSubmission = [
    values.historicalSubmissionSource, values.historicalSubmissionSite,
    values.historicalSubmissionForm, values.historicalSubmissionId,
    values.historicalSubmissionOccurredAt, values.historicalSubmissionStatus,
    values.historicalSubmissionFieldsJson,
  ].some(Boolean)
  if (hasHistoricalSubmission && !(
    values.historicalSubmissionSource && values.historicalSubmissionSite
    && values.historicalSubmissionForm && values.historicalSubmissionId
    && values.historicalSubmissionOccurredAt && values.historicalSubmissionStatus
    && values.historicalSubmissionFieldsJson
  )) add('incomplete_historical_submission', 'Historical submission source, site, form, ID, time, state, and JSON data are required together.', 'historicalSubmissionSource')
  if (values.historicalSubmissionSource && !/^[a-z][a-z0-9_-]{0,62}$/.test(values.historicalSubmissionSource)) {
    add('invalid_catalog_key', 'Historical submission source must be a stable source key.', 'historicalSubmissionSource')
  }
  for (const field of ['historicalSubmissionSite', 'historicalSubmissionForm', 'historicalSubmissionId']) {
    if (values[field] && values[field].length > 500) add('value_too_long', 'Historical source identifiers are limited to 500 characters.', field)
  }
  if (values.historicalSubmissionOccurredAt) {
    try { crmPageInstant(values.historicalSubmissionOccurredAt) }
    catch { add('invalid_instant', 'Historical submission time must be an ISO timestamp with a timezone and at most six fractional digits.', 'historicalSubmissionOccurredAt') }
  }
  if (values.historicalSubmissionStatus && !['new', 'in_progress', 'resolved', 'spam'].includes(values.historicalSubmissionStatus)) {
    add('invalid_submission_status', 'Historical submission state must be new, in_progress, resolved, or spam.', 'historicalSubmissionStatus')
  }
  if (values.historicalSubmissionSubject && values.historicalSubmissionSubject.length > 300) {
    add('value_too_long', 'Historical submission subject is limited to 300 characters.', 'historicalSubmissionSubject')
  }
  if (values.historicalSubmissionMessage && values.historicalSubmissionMessage.length > 20_000) {
    add('value_too_long', 'Historical submission message is limited to 20000 characters.', 'historicalSubmissionMessage')
  }
  if (values.historicalSubmissionQueueKey && !/^[a-z][a-z0-9_-]{0,62}$/.test(values.historicalSubmissionQueueKey)) {
    add('invalid_catalog_key', 'Historical submission queue must be a stable key.', 'historicalSubmissionQueueKey')
  }
  if (values.historicalSubmissionFieldsJson) {
    try { historicalSubmissionFields(values.historicalSubmissionFieldsJson) }
    catch (error) { add('invalid_submission_data', error instanceof Error ? error.message : 'Historical submission data is invalid.', 'historicalSubmissionFieldsJson') }
  }
  const sourceOrderFields = [
    values.sourceOrderSource, values.sourceOrderSite, values.sourceOrderId,
    values.sourceOrderOccurredAt, values.sourceOrderStatus, values.sourceOrderCurrency,
    values.sourceOrderSubtotalMinor, values.sourceOrderDiscountMinor, values.sourceOrderTotalMinor,
    values.sourceOrderRefundedMinor, values.sourceOrderReservationExpiresAt,
    values.sourceOrderProvider, values.sourceOrderProviderReference,
    values.sourceOrderLinesJson, values.sourceOrderMetadataJson,
  ]
  const hasSourceOrder = sourceOrderFields.some(Boolean)
  if (hasSourceOrder && !(
    values.sourceOrderSource && values.sourceOrderSite && values.sourceOrderId
    && values.sourceOrderOccurredAt && values.sourceOrderStatus && values.sourceOrderCurrency
    && values.sourceOrderSubtotalMinor && values.sourceOrderTotalMinor && values.sourceOrderLinesJson
  )) add('incomplete_source_order', 'Source order source, site, ID, time, state, currency, subtotal, total, and line JSON are required together.', 'sourceOrderSource')
  if (hasSourceOrder) {
    try { sourceOrderInput(values, '00000000-0000-4000-8000-000000000000', row.row) }
    catch (error) { add('invalid_source_order', error instanceof Error ? error.message : 'Source order evidence is invalid.', 'sourceOrderLinesJson') }
  }
  const promotionFields = [
    values.promotionSource, values.promotionSite, values.promotionId, values.promotionKey,
    values.promotionName, values.promotionCodeDigest, values.promotionDiscountType,
    values.promotionPercentageBasisPoints, values.promotionAmountMinor, values.promotionCurrency,
    values.promotionBuyQuantity, values.promotionGetQuantity, values.promotionTargetKind,
    values.promotionTargetIdsJson, values.promotionRecurrenceMode, values.promotionRecurrenceCycles,
    values.promotionApplyMode, values.promotionValidFrom,
    values.promotionValidTo, values.promotionMaxUses, values.promotionMaxUsesPerContact,
    values.promotionCombinesWithMemberPrice, values.promotionReleaseOnFullRefund,
    values.promotionStatus, values.promotionSourceRedeemedUses, values.promotionSourceContactUsesJson,
  ]
  const hasPromotion = promotionFields.some((value) => value !== undefined)
  if (hasPromotion && !(
    values.promotionSource && values.promotionSite && values.promotionId
    && values.promotionKey && values.promotionName && values.promotionCodeDigest
    && values.promotionDiscountType && values.promotionTargetKind && values.promotionTargetIdsJson
    && values.promotionCombinesWithMemberPrice && values.promotionReleaseOnFullRefund
    && values.promotionStatus && values.promotionSourceRedeemedUses !== undefined
  )) add('incomplete_promotion', 'Source, site, promotion ID, key, name, digest, rule, targets, policies, status, and redeemed usage are required together.', 'promotionSource')
  if (hasPromotion) {
    if (kind !== 'operations') add('invalid_promotion_kind', 'Promotions require an operations import.', 'promotionSource')
    if (values.contactId || hasConsent || hasSuppression || hasEntitlement || hasParticipation
      || hasHistoricalSubmission || hasSourceOrder) {
      add('mixed_promotion', 'A promotion import row cannot contain contact or other operations evidence.', 'promotionSource')
    }
    try { promotionImportInput(values, '00000000-0000-4000-8000-000000000000', row.row) }
    catch (error) { add('invalid_promotion', error instanceof Error ? error.message : 'Promotion evidence is invalid.', 'promotionSource') }
  }
  if (values.currencyCode && !/^[a-z]{3}$/i.test(values.currencyCode)) {
    add('invalid_currency', 'Currency must be a three-letter ISO code.', 'currencyCode')
  }
  try {
    customValuesFor(values, customCatalog)
  } catch (error) {
    add('invalid_custom_value', error instanceof Error ? error.message : 'Custom field value is invalid.')
  }
  if (kind === 'operations' && !hasPromotion && !isUuid(values.contactId)) {
    add('required_field', 'Operations rows require a contact UUID.', 'contactId')
  }
  if (kind === 'operations' && !(hasConsent || hasSuppression || hasEntitlement || hasParticipation || hasHistoricalSubmission || hasSourceOrder || hasPromotion)) {
    add('required_operation', 'An operations row must contain consent, suppression, entitlement, participation, historical submission, source order, or promotion evidence.')
  }
  return errors
}

function csvCell(value: unknown): string {
  const text = value == null ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function jobProjection(row: ImportJobRow): CrmImportJob {
  const { mappingHash: _mappingHash, sourceHash: _sourceHash, createdByUserId: _createdBy,
    confirmationKey: _confirmationKey, integrationCredentialId: _credential,
    integrationGrants: _grants, ...job } = row
  return job
}

export type CrmProductionImportService = ReturnType<typeof createCrmProductionImportService>

export function createCrmProductionImportService(deps: {
  filesApi?: FilesApi
  sources?: CrmImportSources
  operationsForTransaction: (client: PoolClient) => CrmOperationsServicePort & CrmHistoricalSubmissionImportPort
  associationForTransaction?: (client: PoolClient) => AssociationSourceOrderImportPort & AssociationPromotionImportPort & AssociationSourceMembershipImportPort
  pool?: Pool
  entityLinks?: EntityLinksStore
}) {
  const sources = () => deps.sources ?? createCrmImportSources()
  function isTransientImportFailure(error: unknown): boolean {
    const code = (error as { code?: string })?.code ?? ''
    return ['40001', '40P01', '57P01', '57P02', '57P03'].includes(code) || code.startsWith('08')
  }
  async function importTransaction<T>(context: ImportServiceContext,
    run: (current: ImportServiceContext, client: PoolClient, effects: Array<() => void>) => Promise<T>,
  ): Promise<T> {
    const client = await (deps.pool ?? getPool()).connect()
    const effects: Array<() => void> = []
    let result: T
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.system_bypass','true',true)`)
      if (context.actor.kind === 'user') {
        const member = await client.query<{ role: string }>(`SELECT role FROM workspace_members
          WHERE workspace_id=$1 AND user_id=$2 FOR SHARE`, [context.workspaceId, context.actor.userId])
        if (!member.rows[0]) throw new CrmOperationsError('not_authorized', 'Current workspace membership is required for imports.')
        context = { ...context, authority: { ...context.authority, role: member.rows[0].role as CrmOperationsContext['authority']['role'] } }
      } else if (context.actor.kind === 'integration_key') {
        const credential = await client.query(`SELECT id FROM crm_integration_credentials
          WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() FOR SHARE`,
        [context.workspaceId, context.actor.credentialId])
        if (!credential.rowCount) throw new CrmOperationsError('not_authorized', 'The import credential is no longer active.')
        const rows = await client.query(`SELECT operation,selectors FROM crm_integration_credential_grants
          WHERE workspace_id=$1 AND credential_id=$2 ORDER BY operation FOR SHARE`, [context.workspaceId, context.actor.credentialId])
        const grants = CrmIntegrationGrantsSchema.parse(rows.rows)
        requireImportCeiling({ credentialId: context.actor.credentialId, grants },
          context.authority.integration ? importGrantSnapshot(context.authority.integration) : undefined)
      }
      result = await run(context, client, effects)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      if ((error as { code?: string })?.code === '55P03') throw new CrmOperationsError('conflict', 'Import job is already processing.', { reason: 'import_processing' })
      throw error
    } finally { client.release() }
    for (const effect of effects) effect()
    return result
  }
  async function checkpoint(client: PoolClient, workspaceId: string, job: ImportJobRow, terminal: boolean): Promise<void> {
    await client.query(`UPDATE crm_import_jobs SET status=$3,
      processed_rows=(SELECT count(*) FROM crm_import_rows WHERE workspace_id=$1 AND job_id=$2),
      succeeded_rows=(SELECT count(*) FROM crm_import_rows WHERE workspace_id=$1 AND job_id=$2 AND status='completed'),
      failed_rows=(SELECT count(*) FROM crm_import_rows WHERE workspace_id=$1 AND job_id=$2 AND status='failed'),
      next_chunk_index=$4,completed_at=CASE WHEN $3='completed' THEN now() ELSE NULL END
      WHERE workspace_id=$1 AND id=$2`, [workspaceId, job.id, terminal ? 'completed' : 'paused', job.nextChunkIndex + 1])
  }
  function sourceContext(context: ImportServiceContext, source: { credentialId: string; grants: CrmIntegrationGrant[] }): ImportServiceContext {
    // Even a broader replacement key or member must keep this source's ceiling.
    const grants = requireImportCeiling(context.authority.integration ?? source, source.grants)
    return { ...context, authority: { ...context.authority, canConfigure: false,
      trustedIdentitySources: [], integration: {
        credentialId: context.actor.kind === 'integration_key' ? context.actor.credentialId : source.credentialId,
        grants,
      } } }
  }
  function jobContext(context: ImportServiceContext, job: ImportJobRow, mode: 'read' | 'write'): ImportServiceContext {
    requireImportOperation(context, mode === 'read' ? 'crm.imports.read' : 'crm.imports.write')
    if (job.privacyErased) {
      if (context.authority.integration && context.authority.integration.credentialId !== job.integrationCredentialId) {
        throw new CrmOperationsError('not_authorized', 'This erased import receipt belongs to another credential.')
      }
      return context
    }
    if (!job.sourceId) {
      if (context.authority.integration) throw new CrmOperationsError('not_authorized', 'CRM keys cannot access member file imports.')
      return context
    }
    if (!job.integrationCredentialId || !job.integrationGrants) throw new CrmOperationsError('not_authorized', 'Import job authority is unavailable.')
    const original = { credentialId: job.integrationCredentialId, grants: job.integrationGrants }
    requireImportCeiling(context.authority.integration ?? original, original.grants, context.authority.integration ? mode : 'write')
    return mode === 'write' ? sourceContext(context, original) : context
  }

  async function customCatalogFor(
    context: ImportServiceContext,
    input: ImportInput,
    client?: PoolClient,
  ): Promise<ReadonlyMap<string, ImportCustomDefinition>> {
    const requested = [...new Set(Object.values(input.mapping.columns)
      .filter((target): target is string => typeof target === 'string' && target.startsWith('custom:'))
      .map((target) => target.slice('custom:'.length)))]
    if (requested.length === 0) return new Map()
    if (input.entityKind === 'operations') throw new Error('Operations-only imports cannot map custom entity fields.')
    const entityKind = input.entityKind === 'contact' ? 'person' : input.entityKind
    const result = await (client ? client.query.bind(client) : query)<{
      fieldKey: string
      fieldType: ImportCustomDefinition['fieldType']
      options: unknown
    }>(
      `SELECT field_key AS "fieldKey",field_type AS "fieldType",options
         FROM crm_field_definitions
        WHERE workspace_id=$1 AND entity_kind=$2 AND archived_at IS NULL
          AND field_key=ANY($3::text[])`,
      [context.workspaceId, entityKind, requested],
    )
    const catalog = new Map(result.rows.map((field) => [field.fieldKey, {
      fieldKey: field.fieldKey,
      fieldType: field.fieldType,
      options: Array.isArray(field.options)
        ? field.options.filter((option): option is string => typeof option === 'string') : [],
    }]))
    const missing = requested.filter((key) => !catalog.has(key))
    if (missing.length > 0) throw new Error(`Unknown custom import fields: ${missing.join(', ')}.`)
    return catalog
  }

  async function parseStaged(context: ImportServiceContext, input: ImportInput): Promise<ParsedImport> {
    requireImportOperation(context, 'crm.imports.write')
    let bytes: Uint8Array
    let sourceAuthority: ParsedImport['sourceAuthority']
    if (input.sourceId) {
      const source = await sources().read(context, input.sourceId)
      sourceAuthority = { credentialId: source.credentialId, grants: source.integrationGrants }
      bytes = source.bytes
    } else {
      if (context.actor.kind !== 'user' || context.authority.integration) throw new CrmOperationsError('not_authorized', 'CRM keys must use a CRM import source.')
      if (!deps.filesApi || !input.stagedFileId) throw new CrmOperationsError('not_found', 'The staged import file is unavailable.')
      const read = await deps.filesApi.readBytes({
        workspaceId: context.workspaceId, userId: context.actor.userId,
        assistantKind: 'primary', clearance: 'confidential',
      }, input.stagedFileId)
      if (!read.ok) throw new Error('The staged import file is unavailable.')
      bytes = read.value.bytes
    }
    if (bytes.byteLength > MAX_IMPORT_BYTES) throw new Error('CRM imports are limited to 30 MB per staged file.')
    const records = parseCsv(Buffer.from(bytes).toString('utf8'))
    const headerIndex = records.findIndex((record) => record.cells.some((cell) => cell.trim()))
    if (headerIndex < 0) throw new Error('The staged CSV is empty.')
    const headers = records[headerIndex].cells.map((header, index) => clean(header) ?? `Column ${index + 1}`)
    const rows = records.slice(headerIndex + 1)
      .filter((record) => record.cells.some((cell) => cell.trim()))
      .map((record, index) => ({ row: index + 2, cells: record.cells, malformedReason: record.malformedReason }))
    if (rows.length > MAX_IMPORT_ROWS) throw new Error('CRM imports are limited to 100000 data rows per job.')
    for (const rawIndex of Object.keys(input.mapping.columns)) {
      if (Number(rawIndex) >= headers.length) throw new Error(`Mapped column ${rawIndex} does not exist in the staged file.`)
    }
    return { bytes, sourceHash: hashBytes(bytes), headers, rows, sourceAuthority }
  }

  async function dryRun(context: ImportServiceContext, rawInput: ImportInput): Promise<CrmImportDryRun> {
    requireImportOperation(context, 'crm.imports.write')
    const input = CrmImportPreflightSchema.parse(rawInput)
    if (input.mapping.trustedIdentitySource && !context.authority.canConfigure) {
      throw new CrmOperationsError('not_authorized', 'Trusted identity imports require workspace owner or admin authority.')
    }
    const parsed = await parseStaged(context, input)
    if (parsed.sourceAuthority) context = sourceContext(context, parsed.sourceAuthority)
    // Reject an unauthorized mapping before returning any source-derived data.
    requireImportRowAuthority(context, input.entityKind, {}, input.mapping.trustedIdentitySource)
    const customCatalog = await customCatalogFor(context, input)
    let failedRows = 0
    const sampleErrors: CrmImportError[] = []
    for (const row of parsed.rows) {
      requireImportRowAuthority(context, input.entityKind, mappedValues(row.cells, input.mapping), input.mapping.trustedIdentitySource)
      const errors = validateMappedRow(input.entityKind, row, input.mapping, customCatalog)
      if (errors.length > 0) {
        failedRows += 1
        sampleErrors.push(...errors.slice(0, Math.max(0, SAMPLE_ERRORS - sampleErrors.length)))
      }
    }
    return {
      dryRunHash: dryRunHash(parsed.sourceHash, input.mapping, input.entityKind),
      bytes: parsed.bytes.byteLength,
      totalRows: parsed.rows.length,
      validRows: parsed.rows.length - failedRows,
      failedRows,
      headers: parsed.headers,
      sampleErrors,
    }
  }

  async function loadJob(workspaceId: string, jobId: string, client?: PoolClient, lock = false): Promise<ImportJobRow | null> {
    const result = await (client ? client.query.bind(client) : query)<ImportJobRow>(
      `SELECT id, workspace_id AS "workspaceId", staged_file_id AS "stagedFileId",
              source_id AS "sourceId", integration_credential_id AS "integrationCredentialId", integration_grants AS "integrationGrants",
              entity_kind AS "entityKind", status, privacy_erased AS "privacyErased", privacy_erased_at AS "privacyErasedAt", mapping, mapping_hash AS "mappingHash",
              source_hash AS "sourceHash", confirmation_key AS "confirmationKey", total_rows AS "totalRows",
              processed_rows AS "processedRows", succeeded_rows AS "succeededRows",
              failed_rows AS "failedRows", next_chunk_index AS "nextChunkIndex",
              created_by_user_id AS "createdByUserId", created_at AS "createdAt",
              updated_at AS "updatedAt", completed_at AS "completedAt"
         FROM crm_import_jobs WHERE workspace_id=$1 AND id=$2${lock ? ' FOR UPDATE NOWAIT' : ''}`,
      [workspaceId, jobId],
    )
    return result.rows[0] ?? null
  }

  async function confirm(context: ImportServiceContext, rawInput: ConfirmInput): Promise<CrmImportJob> {
    const input = CrmImportConfirmSchema.parse(rawInput)
    const preflightInput: ImportInput = {
      stagedFileId: input.stagedFileId,
      sourceId: input.sourceId,
      entityKind: input.entityKind,
      mapping: input.mapping,
    }
    const checked = await dryRun(context, preflightInput)
    if (checked.dryRunHash !== input.dryRunHash) throw new Error('The staged file or mapping changed after dry run. Run the dry run again.')
    const parsed = await parseStaged(context, preflightInput)
    const id = randomUUID()
    const result = await query<ImportJobRow>(
      `INSERT INTO crm_import_jobs (
         id, workspace_id, staged_file_id, entity_kind, status, mapping,
         mapping_hash, source_hash, trusted_identity, total_rows,
         created_by_user_id, confirmed_by_user_id, source_id, integration_credential_id, integration_grants,
         confirmation_key
       ) VALUES ($1,$2,$3,$4,'ready',$5::jsonb,$6,$7,$8,$9,$10,$10,$11,$12,$13::jsonb,$14)
       ON CONFLICT (workspace_id,confirmation_key) WHERE confirmation_key IS NOT NULL DO NOTHING
       RETURNING id, workspace_id AS "workspaceId", staged_file_id AS "stagedFileId",
         source_id AS "sourceId", integration_credential_id AS "integrationCredentialId", integration_grants AS "integrationGrants",
         entity_kind AS "entityKind", status, privacy_erased AS "privacyErased", privacy_erased_at AS "privacyErasedAt", mapping, mapping_hash AS "mappingHash",
         source_hash AS "sourceHash", confirmation_key AS "confirmationKey", total_rows AS "totalRows",
         processed_rows AS "processedRows", succeeded_rows AS "succeededRows",
         failed_rows AS "failedRows", next_chunk_index AS "nextChunkIndex",
         created_by_user_id AS "createdByUserId", created_at AS "createdAt",
         updated_at AS "updatedAt", completed_at AS "completedAt"`,
      [id, context.workspaceId, input.stagedFileId ?? null, input.entityKind, JSON.stringify(input.mapping),
        mappingHash(input.mapping), parsed.sourceHash, !!input.mapping.trustedIdentitySource,
        parsed.rows.length, context.actor.kind === 'user' ? context.actor.userId : null, input.sourceId ?? null,
        parsed.sourceAuthority?.credentialId ?? null, parsed.sourceAuthority ? JSON.stringify(parsed.sourceAuthority.grants) : null,
        input.confirmationKey ?? null],
    ).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === '55000' && error.message === 'import_source_retired') {
        throw new CrmOperationsError('conflict', 'The CRM import source was erased before confirmation. Its receipt cannot restore the CSV.', { reason: 'import_source_retired' })
      }
      throw error
    })
    if (result.rows[0]) {
      console.info('[crm-import] job confirmed', { workspaceId: context.workspaceId, jobId: id, totalRows: parsed.rows.length })
      return jobProjection(result.rows[0])
    }
    if (!input.confirmationKey) throw new Error('CRM import confirmation returned no job.')
    const replay = await query<ImportJobRow>(
      `SELECT id, workspace_id AS "workspaceId", staged_file_id AS "stagedFileId",
              source_id AS "sourceId", integration_credential_id AS "integrationCredentialId", integration_grants AS "integrationGrants",
              entity_kind AS "entityKind", status, privacy_erased AS "privacyErased", privacy_erased_at AS "privacyErasedAt", mapping, mapping_hash AS "mappingHash",
              source_hash AS "sourceHash", confirmation_key AS "confirmationKey", total_rows AS "totalRows",
              processed_rows AS "processedRows", succeeded_rows AS "succeededRows",
              failed_rows AS "failedRows", next_chunk_index AS "nextChunkIndex",
              created_by_user_id AS "createdByUserId", created_at AS "createdAt",
              updated_at AS "updatedAt", completed_at AS "completedAt"
         FROM crm_import_jobs WHERE workspace_id=$1 AND confirmation_key=$2`,
      [context.workspaceId, input.confirmationKey],
    )
    const existing = replay.rows[0]
    const sameActor = context.actor.kind === 'user'
      ? existing?.createdByUserId === context.actor.userId
      : existing?.integrationCredentialId === parsed.sourceAuthority?.credentialId
    if (!existing || existing.privacyErased || !sameActor
      || existing.stagedFileId !== (input.stagedFileId ?? null)
      || existing.sourceId !== (input.sourceId ?? null)
      || existing.entityKind !== input.entityKind
      || existing.mappingHash !== mappingHash(input.mapping)
      || existing.sourceHash !== parsed.sourceHash) {
      throw new CrmOperationsError('idempotency_conflict', 'This import confirmation key was already used for different input or authority.')
    }
    jobContext(context, existing, 'write')
    return jobProjection(existing)
  }

  async function findImportedEntity(workspaceId: string, importKey: string, client: PoolClient): Promise<string | null> {
    const found = await client.query<{ id: string }>(
      `SELECT id FROM entities
        WHERE workspace_id=$1 AND valid_to IS NULL
          AND attributes->'external_ref'->>'import_key'=$2
        ORDER BY created_at LIMIT 1`,
      [workspaceId, importKey],
    )
    return found.rows[0]?.id ?? null
  }

  async function findUniqueTrustedEmailContact(
    workspaceId: string,
    email: string,
    client: PoolClient,
  ): Promise<{ id: string; attributes: Record<string, unknown> } | null> {
    const normalized = email.trim().toLowerCase()
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['crm-intake-identity', workspaceId, 'email', normalized])])
    const found = await client.query<{ id: string; attributes: Record<string, unknown> }>(
      `SELECT id,attributes FROM entities
        WHERE workspace_id=$1 AND kind='person' AND valid_to IS NULL
          AND retracted_at IS NULL AND NOT (attributes ? 'crm_archived_at')
          AND lower(btrim(COALESCE(NULLIF(btrim(attributes->>'email'),''),canonical_id,'')))=$2
        ORDER BY created_at,id LIMIT 2 FOR UPDATE`,
      [workspaceId, normalized],
    )
    if (found.rows.length > 1) throw new CrmOperationsError('conflict', 'Multiple live contacts match this email; review is required.', { reason: 'identity_review_required' })
    return found.rows[0] ?? null
  }

  async function executeRow(
    context: ImportServiceContext,
    job: ImportJobRow,
    row: { row: number; cells: string[] },
    customCatalog: ReadonlyMap<string, ImportCustomDefinition>,
    transaction: CrmWriteTransaction,
    operations: CrmOperationsServicePort & CrmHistoricalSubmissionImportPort,
    association?: AssociationSourceOrderImportPort & AssociationPromotionImportPort & AssociationSourceMembershipImportPort,
  ): Promise<ImportRowResult> {
    const values = mappedValues(row.cells, job.mapping)
    requireImportRowAuthority(context, job.entityKind, values, job.mapping.trustedIdentitySource)
    const attributionUserId = context.actor.kind === 'user' ? context.actor.userId : await sources().attributionUser(context, transaction.client)
    const access: AccessContext = {
      workspaceId: context.workspaceId,
      userId: attributionUserId,
      assistantId: '',
      assistantKind: 'primary',
      clearance: 'confidential',
    }
    const importKey = `${job.id}:${row.row}`
    let entityId = await findImportedEntity(context.workspaceId, importKey, transaction.client)
    const resultRefs: ImportResultRef[] = []
    if (!entityId && job.entityKind === 'contact') {
      let stableIdentity: StableExternalIdentity | undefined
      if (job.mapping.trustedIdentitySource && values.identityProvider && values.identityProviderInstance && values.identitySubject) {
        stableIdentity = {
          provider: values.identityProvider,
          providerInstanceKey: values.identityProviderInstance,
          subjectId: values.identitySubject,
        }
      }
      const tags = values.tags?.split(/[|;]/).map((tag) => tag.trim()).filter(Boolean)
      const externalRef = { import_key: importKey, import_job_id: job.id, row_number: row.row }
      const trustedMatch = !stableIdentity && job.mapping.trustedIdentitySource && values.email
        ? await findUniqueTrustedEmailContact(context.workspaceId, values.email, transaction.client)
        : null
      if (trustedMatch) {
        const currentTags = Array.isArray(trustedMatch.attributes.tags)
          ? trustedMatch.attributes.tags.filter((tag): tag is string => typeof tag === 'string') : []
        const currentExternalRef = trustedMatch.attributes.external_ref
          && typeof trustedMatch.attributes.external_ref === 'object'
          && !Array.isArray(trustedMatch.attributes.external_ref)
          ? trustedMatch.attributes.external_ref as Record<string, unknown> : {}
        const record = await updateContact(attributionUserId, trustedMatch.id, {
          name: values.name,
          email: values.email,
          phone: values.phone,
          companyId: values.companyId,
          tags: [...new Set([...currentTags, ...(tags ?? [])])],
          externalRef: { ...currentExternalRef, ...externalRef },
        }, deps.entityLinks, access, transaction.client, undefined, transaction.afterCommit)
        if (!record) throw new Error('The trusted email contact is no longer available.')
        entityId = record.id
      } else {
        const record = await createContact(attributionUserId, {
          workspaceId: context.workspaceId,
          name: values.name,
          email: values.email,
          phone: values.phone,
          companyId: values.companyId,
          tags,
          externalRef,
          stableIdentity,
          access,
        }, deps.entityLinks, transaction)
        entityId = record.id
      }
    } else if (!entityId && job.entityKind === 'company') {
      const record = await createCompany(attributionUserId, {
        workspaceId: context.workspaceId,
        name: values.name,
        domain: values.domain,
        tags: values.tags?.split(/[|;]/).map((tag) => tag.trim()).filter(Boolean),
        externalRef: { import_key: importKey, import_job_id: job.id, row_number: row.row },
        access,
      }, transaction)
      entityId = record.id
    } else if (!entityId && job.entityKind === 'deal') {
      const legacyStage = ['lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost'].includes(values.stage)
        ? values.stage as 'lead' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost'
        : 'lead'
      const record = await createDeal(attributionUserId, {
        workspaceId: context.workspaceId,
        access,
        contactId: values.contactId,
        companyId: values.companyId,
        stage: legacyStage,
        amount: values.amount ? Number(values.amount) : undefined,
        closeDate: values.closeDate ? new Date(`${values.closeDate}T00:00:00Z`) : undefined,
        externalRef: { import_key: importKey, import_job_id: job.id, row_number: row.row },
      }, deps.entityLinks, transaction)
      entityId = record.id
      const entity = await getEntityById(access, entityId, {}, transaction.client)
      if (entity) {
        await updateEntity(attributionUserId, entityId, {
          displayName: values.name,
          attributes: {
            ...entity.attributes,
            ...(values.currencyCode ? { currency_code: values.currencyCode.toUpperCase() } : {}),
            ...(values.source ? { source: values.source } : {}),
          },
        }, access, transaction.client)
      }
    }

    const customValues = customValuesFor(values, customCatalog)
    if (entityId && Object.keys(customValues).length > 0) {
      await updateCrmCustomFields({ ctx: access, entityId, values: customValues }, transaction.client)
    }

    const contactId = job.entityKind === 'contact' ? entityId : values.contactId
    if (entityId && job.entityKind !== 'operations') resultRefs.push({ kind: job.entityKind, id: entityId })
    if (contactId && job.entityKind === 'operations') resultRefs.push({ kind: 'contact', id: contactId })
    const importContext: CrmOperationsContext = {
      ...context,
      actor: context.actor.kind === 'user' ? { kind: 'import', jobId: job.id, userId: context.actor.userId } : context.actor,
    }
    if (job.entityKind === 'deal' && entityId && values.pipelineId && values.stageId) {
      await operations.execute(importContext, {
        kind: 'set_deal_pipeline_stage', dealId: entityId,
        pipelineId: values.pipelineId, stageId: values.stageId,
      })
    }
    if (contactId && values.consentPurposeKey) {
      const saved = await operations.execute(importContext, {
        kind: 'record_consent', contactId, purposeKey: values.consentPurposeKey,
        action: values.consentAction as 'granted' | 'withdrawn', source: values.consentSource,
        provider: 'import', providerEventId: `${job.id}:${row.row}:consent:${values.consentPurposeKey}`,
        ...(values.consentOccurredAt ? { occurredAt: values.consentOccurredAt } : {}),
        metadata: { importJobId: job.id, importRow: row.row },
      })
      resultRefs.push(resultRef('consent', saved.record))
    }
    if (contactId && values.suppressionChannel) {
      const saved = await operations.execute(importContext, {
        kind: 'record_suppression', contactId,
        channel: values.suppressionChannel as 'all' | 'email' | 'sms' | 'phone' | 'whatsapp' | 'telegram' | 'slack',
        action: values.suppressionAction as 'suppressed' | 'released',
        reasonCode: values.suppressionReasonCode as 'manual_do_not_contact' | 'hard_bounce' | 'soft_bounce' | 'complaint' | 'provider_block' | 'legal' | 'invalid_address' | 'other',
        source: values.suppressionSource,
        provider: 'import', providerEventId: `${job.id}:${row.row}:suppression:${values.suppressionChannel}`,
        ...(values.suppressionOccurredAt ? { occurredAt: values.suppressionOccurredAt } : {}),
        metadata: { importJobId: job.id, importRow: row.row },
      })
      resultRefs.push(resultRef('suppression', saved.record))
    }
    if (contactId && values.entitlementPlanId && !values.sourceMembershipSource) {
      const saved = await operations.execute(importContext, {
        kind: 'grant_entitlement', contactId, planId: values.entitlementPlanId,
        idempotencyKey: values.entitlementIdempotencyKey,
        status: (values.entitlementStatus || 'pending') as 'pending' | 'active' | 'expired' | 'cancelled',
        startsAt: values.entitlementStartsAt,
        endsAt: values.entitlementEndsAt || undefined,
        renewalMode: (values.entitlementRenewalMode || 'none') as 'none' | 'manual' | 'auto',
      })
      resultRefs.push(resultRef('entitlement', saved.record))
    }
    if (contactId && values.sourceMembershipSource) {
      if (!association) throw new Error('Association source membership importer is unavailable.')
      const saved = await association.importSourceMembership({
        workspaceId: context.workspaceId,
        actor: importContext.actor,
        authority: { ...context.authority, canRead: true, canReconcileProvider: false },
      }, sourceMembershipInput(values, job.id, row.row))
      resultRefs.push(resultRef('entitlement', saved.record, values.sourceMembershipId))
    }
    if (contactId && values.participationEventId) {
      const saved = await operations.execute(importContext, {
        kind: 'record_participation', contactId, eventId: values.participationEventId,
        sourceKind: 'import', sourceId: values.participationSourceId,
        ...(values.participationHistoricalImport === 'true' ? { historicalImport: true } : {}),
        status: (values.participationStatus || 'registered') as 'registered' | 'attended' | 'cancelled' | 'no_show',
        attendeeName: values.participantName,
        attendeeEmail: values.participantEmail,
        metadata: { importJobId: job.id, importRow: row.row },
      })
      resultRefs.push(resultRef('participation', saved.record, values.participationSourceId))
    }
    if (contactId && values.historicalSubmissionSource) {
      const saved = await operations.importHistoricalSubmission(importContext, {
        importJobId: job.id,
        importRow: row.row,
        contactId,
        source: values.historicalSubmissionSource,
        sourceSite: values.historicalSubmissionSite,
        sourceForm: values.historicalSubmissionForm,
        sourceSubmissionId: values.historicalSubmissionId,
        submittedAt: values.historicalSubmissionOccurredAt,
        status: values.historicalSubmissionStatus as 'new' | 'in_progress' | 'resolved' | 'spam',
        fields: historicalSubmissionFields(values.historicalSubmissionFieldsJson),
        subject: values.historicalSubmissionSubject ?? 'Historical form submission',
        message: values.historicalSubmissionMessage ?? 'Imported historical form submission.',
        queueKey: values.historicalSubmissionQueueKey ?? 'general',
      })
      resultRefs.push(resultRef('submission', saved.record, values.historicalSubmissionId))
    }
    if (contactId && values.sourceOrderSource) {
      if (!association) throw new Error('Association source order importer is unavailable.')
      const saved = await association.importSourceOrder({
        workspaceId: context.workspaceId,
        actor: importContext.actor,
        authority: { ...context.authority, canRead: true, canReconcileProvider: false },
      }, sourceOrderInput(values, job.id, row.row))
      resultRefs.push(resultRef('order', saved.record, values.sourceOrderId))
      const registrations = saved.record.registrations
      if (!Array.isArray(registrations)) throw new Error('Source order did not return its registrations.')
      for (const registration of registrations) {
        if (!registration || typeof registration !== 'object' || Array.isArray(registration)) {
          throw new Error('Source order returned an invalid registration.')
        }
        const record = registration as Record<string, unknown>
        resultRefs.push(resultRef('registration', record, sourceRegistrationId(record)))
      }
    }
    if (values.promotionSource) {
      if (!association) throw new Error('Association promotion importer is unavailable.')
      const saved = await association.importPromotion({
        workspaceId: context.workspaceId,
        actor: importContext.actor,
        authority: { ...context.authority, canRead: true, canReconcileProvider: false },
      }, promotionImportInput(values, job.id, row.row))
      resultRefs.push(resultRef('promotion', saved.record, values.promotionId))
    }
    return { entityId: entityId ?? contactId ?? null, resultRefs: uniqueResultRefs(resultRefs) }
  }

  async function resume(context: ImportServiceContext, jobId: string): Promise<CrmImportJob> {
    requireImportOperation(context, 'crm.imports.write')
    // Files can use the same bounded pool. Finish their I/O before holding a
    // connection; source/mapping immutability and hashes are rechecked below.
    const initial = await loadJob(context.workspaceId, jobId)
    if (!initial) throw new CrmOperationsError('not_found', 'Import job was not found.')
    const sourceAuthorityContext = jobContext(context, initial, 'write')
    const parsed = ['completed', 'cancelled'].includes(initial.status) ? null : await parseStaged(sourceAuthorityContext, {
      stagedFileId: initial.stagedFileId ?? undefined, sourceId: initial.sourceId ?? undefined,
      entityKind: initial.entityKind, mapping: initial.mapping,
    })
    return importTransaction(context, async (current, client, effects) => {
      context = current
      const job = await loadJob(context.workspaceId, jobId, client, true)
      if (!job) throw new Error('Import job was not found.')
      context = jobContext(context, job, 'write')
      if (job.mapping.trustedIdentitySource && (context.actor.kind !== 'user' || !['owner', 'admin'].includes(context.authority.role))) {
        throw new CrmOperationsError('not_authorized', 'A current owner or admin is required for trusted identity imports.')
      }
      if (job.status === 'completed' || job.status === 'cancelled') return jobProjection(job)
      if (!parsed || job.mappingHash !== initial.mappingHash || job.sourceHash !== initial.sourceHash) {
        throw new CrmOperationsError('conflict', 'Import source or mapping changed. Read the job again before retrying.')
      }
      const claimed = await client.query<{ id: string }>(
        `UPDATE crm_import_jobs SET status='running'
          WHERE workspace_id=$1 AND id=$2
            AND status NOT IN ('completed','cancelled')
          RETURNING id`,
        [context.workspaceId, jobId],
      )
      if (!claimed.rows[0]) throw new Error('Import job is already processing.')
      if (parsed.sourceHash !== job.sourceHash) {
        await client.query(`UPDATE crm_import_jobs SET status='failed' WHERE workspace_id=$1 AND id=$2`, [context.workspaceId, job.id])
        throw new Error('The staged import file changed after confirmation.')
      }
      const customCatalog = await customCatalogFor(context, {
        stagedFileId: job.stagedFileId ?? undefined, sourceId: job.sourceId ?? undefined,
        entityKind: job.entityKind,
        mapping: job.mapping,
      }, client)
      const start = job.nextChunkIndex * CHUNK_ROWS
      const rows = parsed.rows.slice(start, start + CHUNK_ROWS)
      const chunkHash = hashBytes(Buffer.from(JSON.stringify(rows.map((row) => row.cells))))
      const chunk = await client.query<{ id: string; status: string; inputHash: string }>(
        `INSERT INTO crm_import_chunks (workspace_id,job_id,chunk_index,input_hash,status,started_at)
         VALUES ($1,$2,$3,$4,'running',now())
         ON CONFLICT (job_id,chunk_index) DO UPDATE SET
           status=CASE WHEN crm_import_chunks.status='completed' THEN 'completed' ELSE 'running' END,
           started_at=CASE WHEN crm_import_chunks.status='completed' THEN crm_import_chunks.started_at ELSE now() END
         RETURNING id,status,input_hash AS "inputHash"`,
        [context.workspaceId, job.id, job.nextChunkIndex, chunkHash],
      )
      if (chunk.rows[0].inputHash !== chunkHash) throw new Error('Import chunk input changed after confirmation.')
      if (chunk.rows[0].status === 'completed') {
        await checkpoint(client, context.workspaceId, job, start + rows.length >= parsed.rows.length)
        return jobProjection((await loadJob(context.workspaceId, job.id, client))!)
      }
      let succeeded = 0
      let failed = 0
      for (const row of rows) {
        const inputHash = rowHash(row.cells, job.mapping)
        const receipt = await client.query<{ status: string; inputHash: string }>(
          `SELECT status,input_hash AS "inputHash" FROM crm_import_rows
            WHERE workspace_id=$1 AND job_id=$2 AND row_number=$3`,
          [context.workspaceId, job.id, row.row],
        )
        if (receipt.rows[0]) {
          if (receipt.rows[0].inputHash !== inputHash) throw new Error('Import row input changed after confirmation.')
          if (receipt.rows[0].status === 'completed') succeeded += 1
          else failed += 1
          continue
        }
        const validation = validateMappedRow(job.entityKind, row, job.mapping, customCatalog)
        const effectStart = effects.length
        await client.query('SAVEPOINT crm_import_row')
        try {
          if (validation.length > 0) throw new Error(validation.map((error) => error.message).join(' '))
          const rowResult = await executeRow(context, job, row, customCatalog,
            { client, afterCommit: (effect) => { effects.push(effect) } },
            deps.operationsForTransaction(client), deps.associationForTransaction?.(client))
          await client.query(
            `INSERT INTO crm_import_rows (workspace_id,job_id,row_number,input_hash,status,entity_id,result_refs)
             VALUES ($1,$2,$3,$4,'completed',$5,$6::jsonb)
             ON CONFLICT (job_id,row_number) DO NOTHING`,
            [context.workspaceId, job.id, row.row, inputHash, rowResult.entityId, JSON.stringify(rowResult.resultRefs)],
          )
          await client.query('RELEASE SAVEPOINT crm_import_row')
          succeeded += 1
        } catch (error) {
          if (isTransientImportFailure(error)) throw error
          await client.query('ROLLBACK TO SAVEPOINT crm_import_row')
          effects.length = effectStart
          const first = validation[0]
          const message = error instanceof Error ? error.message.slice(0, 1000) : 'Import row failed.'
          await client.query(
            `INSERT INTO crm_import_rows (workspace_id,job_id,row_number,input_hash,status)
             VALUES ($1,$2,$3,$4,'failed') ON CONFLICT (job_id,row_number) DO NOTHING`,
            [context.workspaceId, job.id, row.row, inputHash],
          )
          await client.query(
            `INSERT INTO crm_import_errors (workspace_id,job_id,row_number,error_code,field_key,message,row_snapshot)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
            [context.workspaceId, job.id, row.row, first?.code ?? 'command_failed',
              first?.field?.replace(/[^a-z0-9_]/gi, '_').toLowerCase() ?? null,
              message, JSON.stringify(mappedValues(row.cells, job.mapping))],
          )
          await client.query('RELEASE SAVEPOINT crm_import_row')
          failed += 1
        }
      }
      const processed = rows.length
      const terminal = start + processed >= parsed.rows.length
      await client.query(
        `UPDATE crm_import_chunks SET status='completed',processed_rows=$4,succeeded_rows=$5,
           failed_rows=$6,completed_at=now() WHERE workspace_id=$1 AND job_id=$2 AND chunk_index=$3`,
        [context.workspaceId, job.id, job.nextChunkIndex, processed, succeeded, failed],
      )
      await checkpoint(client, context.workspaceId, job, terminal)
      console.info('[crm-import] chunk processed', {
        workspaceId: context.workspaceId, jobId: job.id, chunkIndex: job.nextChunkIndex,
        processedRows: processed, failedRows: failed,
      })
      return jobProjection((await loadJob(context.workspaceId, job.id, client))!)
    })
  }

  async function cancel(context: ImportServiceContext, jobId: string): Promise<CrmImportJob> {
    requireImportOperation(context, 'crm.imports.write')
    return importTransaction(context, async (current, client) => {
      context = current
      const original = await loadJob(context.workspaceId, jobId, client)
      if (!original) throw new CrmOperationsError('not_found', 'Import job was not found.')
      jobContext(context, original, 'write')
      await client.query(
        `UPDATE crm_import_jobs SET status='cancelled'
          WHERE workspace_id=$1 AND id=$2 AND status NOT IN ('completed','cancelled')`,
        [context.workspaceId, jobId],
      )
      const job = await loadJob(context.workspaceId, jobId, client)
      if (!job) throw new Error('Import job was not found.')
      return jobProjection(job)
    })
  }

  async function list(context: ImportServiceContext, filters: CrmPageQuery = {}): Promise<CrmPage<'jobs', CrmImportJob>> {
    requireImportOperation(context, 'crm.imports.read')
    const grants = context.authority.integration?.grants.map((grant) => ({ operation: grant.operation,
      selectors: Object.fromEntries(Object.entries(grant.selectors).sort(([a], [b]) => a.localeCompare(b))
        .map(([key, selected]) => [key, Array.isArray(selected) ? [...selected].sort() : selected])),
    })).sort((a, b) => a.operation.localeCompare(b.operation))
    const result = await queryCrmPage<'jobs', ImportJobRow>(query, {
      workspaceId: context.workspaceId, resource: 'crm.imports', key: 'jobs', query: filters,
      sql: `SELECT id,workspace_id AS "workspaceId",staged_file_id AS "stagedFileId",
         source_id AS "sourceId",integration_credential_id AS "integrationCredentialId",integration_grants AS "integrationGrants",
         entity_kind AS "entityKind",status,privacy_erased AS "privacyErased",privacy_erased_at AS "privacyErasedAt",mapping,mapping_hash AS "mappingHash",
         source_hash AS "sourceHash",confirmation_key AS "confirmationKey",total_rows AS "totalRows",processed_rows AS "processedRows",
         succeeded_rows AS "succeededRows",failed_rows AS "failedRows",
         next_chunk_index AS "nextChunkIndex",created_by_user_id AS "createdByUserId",
         created_at AS "createdAt",updated_at AS "updatedAt",completed_at AS "completedAt"
       FROM crm_import_jobs j WHERE workspace_id=$1
         AND ($2::jsonb IS NULL OR (j.privacy_erased AND j.integration_credential_id=$3::uuid) OR (source_id IS NOT NULL AND integration_grants IS NOT NULL
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(j.integration_grants) required WHERE required->>'operation'='crm.imports.write')
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(j.integration_grants) required
              WHERE NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements($2::jsonb) allowed
                 WHERE allowed->>'operation'=regexp_replace(required->>'operation','\\.write$','.read')
                   AND NOT EXISTS (
                     SELECT 1 FROM jsonb_each(required->'selectors') dimension
                      WHERE NOT coalesce(allowed->'selectors'->dimension.key='"all"'::jsonb
                        OR (allowed->'selectors'->dimension.key) @> dimension.value,false)
                   )
              )
           )))`,
      params: [context.workspaceId, grants ? JSON.stringify(grants) : null, context.authority.integration?.credentialId ?? null],
    })
    return { ...result, jobs: result.jobs.map((row) => { jobContext(context, row, 'read'); return jobProjection(row) }) }
  }

  async function get(context: ImportServiceContext, jobId: string): Promise<CrmImportJob | null> {
    requireImportOperation(context, 'crm.imports.read')
    const job = await loadJob(context.workspaceId, jobId)
    if (job) jobContext(context, job, 'read')
    return job ? jobProjection(job) : null
  }

  async function errorsCsv(context: ImportServiceContext, jobId: string): Promise<string | null> {
    requireImportOperation(context, 'crm.imports.read')
    const job = await loadJob(context.workspaceId, jobId)
    if (!job) return null
    jobContext(context, job, 'read')
    const result = await query<{ rowNumber: number; errorCode: string; fieldKey: string | null; message: string; rowSnapshot: Record<string, unknown> }>(
      `SELECT row_number AS "rowNumber",error_code AS "errorCode",field_key AS "fieldKey",
              message,row_snapshot AS "rowSnapshot"
         FROM crm_import_errors WHERE workspace_id=$1 AND job_id=$2 ORDER BY row_number,id`,
      [context.workspaceId, jobId],
    )
    return [
      ['row', 'error_code', 'field', 'message', 'mapped_values'].join(','),
      ...result.rows.map((row) => [row.rowNumber, row.errorCode, row.fieldKey, row.message, JSON.stringify(row.rowSnapshot)].map(csvCell).join(',')),
    ].join('\r\n')
  }

  async function resultsCsv(context: ImportServiceContext, jobId: string): Promise<string | null> {
    requireImportOperation(context, 'crm.imports.read')
    const job = await loadJob(context.workspaceId, jobId)
    if (!job) return null
    jobContext(context, job, 'read')
    const result = await query<{ rowNumber: number; status: string; inputHash: string; resultRefs: ImportResultRef[] }>(
      `SELECT row_number AS "rowNumber",status,input_hash AS "inputHash",result_refs AS "resultRefs"
         FROM crm_import_rows WHERE workspace_id=$1 AND job_id=$2 ORDER BY row_number`,
      [context.workspaceId, jobId],
    )
    return [
      ['row', 'status', 'input_hash', 'result_refs'].join(','),
      ...result.rows.map((row) => [row.rowNumber, row.status, row.inputHash, JSON.stringify(row.resultRefs)].map(csvCell).join(',')),
    ].join('\r\n')
  }

  return { dryRun, confirm, resume, cancel, list, get, errorsCsv, resultsCsv }
}
