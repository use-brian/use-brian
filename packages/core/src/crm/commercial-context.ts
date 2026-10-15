/**
 * Commercial context contracts: seller profiles, customer accounts, accepted
 * commercial profile versions, bounded operation versions with accepted
 * instructions, and deterministic field resolution.
 *
 * Pure and closed-world. Resolution never reads a clock, never calls a model
 * and never infers a value from prose.
 * Spec: docs/architecture/features/crm-commercial-operations.md
 *
 * [COMP:crm/commercial-context]
 */

import { z } from 'zod'
import { CrmInvoiceTemplateMapSchema } from './invoice-template-map.js'

const Uuid = z.string().uuid()
const StableKey = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{0,62}$/)
const FieldKey = z.string().trim().regex(/^[a-z][a-z0-9_]{0,62}$/)
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}, 'Use a calendar date YYYY-MM-DD')
export const CrmDecimalStringSchema = z.string().regex(/^-?\d{1,18}(\.\d{1,6})?$/, 'Use a decimal string with at most 6 fractional digits')
const Sensitivity = z.enum(['public', 'internal', 'confidential'])

export const CRM_COMMERCIAL_FIELD_TYPES = ['string', 'text', 'date', 'decimal', 'currency', 'percent', 'boolean', 'reference'] as const
export const CrmCommercialFieldTypeSchema = z.enum(CRM_COMMERCIAL_FIELD_TYPES)
export type CrmCommercialFieldType = z.infer<typeof CrmCommercialFieldTypeSchema>

export const CrmCommercialFieldValueSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('string'), value: z.string().trim().min(1).max(500) }).strict(),
  z.object({ type: z.literal('text'), value: z.string().trim().min(1).max(5000) }).strict(),
  z.object({ type: z.literal('date'), value: IsoDate }).strict(),
  z.object({ type: z.literal('decimal'), value: CrmDecimalStringSchema }).strict(),
  z.object({ type: z.literal('currency'), value: z.string().regex(/^[A-Z]{3}$/, 'Use an ISO 4217 currency code') }).strict(),
  z.object({ type: z.literal('percent'), value: CrmDecimalStringSchema.refine((value) => Number(value) >= 0 && Number(value) <= 1, 'A percent is a fraction between 0 and 1') }).strict(),
  z.object({ type: z.literal('boolean'), value: z.boolean() }).strict(),
  z.object({ type: z.literal('reference'), value: z.object({ kind: z.enum(['company', 'deal', 'person', 'account', 'seller', 'page', 'file']), id: Uuid }).strict() }).strict(),
])
export type CrmCommercialFieldValue = z.infer<typeof CrmCommercialFieldValueSchema>

/** An explicit null records that a fact does not apply. Absent means unknown. */
export const CrmCommercialFieldEntrySchema = z.union([CrmCommercialFieldValueSchema, z.object({ type: CrmCommercialFieldTypeSchema, value: z.null() }).strict()])
export type CrmCommercialFieldEntry = z.infer<typeof CrmCommercialFieldEntrySchema>

export const CrmCommercialFieldsSchema = z.record(FieldKey, CrmCommercialFieldEntrySchema)
  .refine((value) => Object.keys(value).length <= 200, 'At most 200 fields')
export type CrmCommercialFields = z.infer<typeof CrmCommercialFieldsSchema>

export const CrmCommercialSourceEvidenceSchema = z.object({
  kind: z.enum(['manual', 'page', 'file', 'office_artifact', 'external']),
  id: z.string().trim().min(1).max(200).optional(),
  revision: z.string().trim().min(1).max(200).optional(),
  note: z.string().trim().min(1).max(2000).optional(),
}).strict()
export type CrmCommercialSourceEvidence = z.infer<typeof CrmCommercialSourceEvidenceSchema>

export const CrmClassificationSchema = z.object({
  sensitivity: Sensitivity.optional(),
  departmentId: Uuid.nullable().optional(),
}).strict()

export const CrmFieldBindingSchema = z.object({
  fieldKey: FieldKey,
  label: z.string().trim().min(1).max(200),
  type: CrmCommercialFieldTypeSchema,
  requiredFor: z.enum(['draft', 'issue', 'never']).default('never'),
  overridable: z.boolean().default(false),
  protected: z.boolean().default(false),
  sources: z.array(z.enum(['transaction', 'agreement', 'account', 'seller'])).min(1).max(4)
    .refine((values) => new Set(values).size === values.length, 'Sources must be unique')
    .default(['transaction', 'agreement', 'account', 'seller']),
  templateToken: z.string().regex(/^[A-Z][A-Z0-9_]{0,62}$/).optional(),
}).strict()
export type CrmFieldBinding = z.infer<typeof CrmFieldBindingSchema>

export const CrmOperationVersionInputSchema = z.object({
  instructions: z.string().trim().min(1).max(20_000),
  instructionSource: z.object({ pageId: Uuid, revision: z.string().trim().min(1).max(200) }).strict().nullable().default(null),
  fieldBindings: z.array(CrmFieldBindingSchema).min(1).max(200)
    .refine((values) => new Set(values.map((value) => value.fieldKey)).size === values.length, 'Field keys must be unique')
    .refine((values) => new Set(values.flatMap((value) => value.templateToken ? [value.templateToken] : [])).size
      === values.filter((value) => value.templateToken).length, 'Template tokens must be unique'),
  templateBinding: z.object({ templateId: Uuid, templateVersionId: Uuid.optional(), pdfPreset: z.enum(['invoice', 'worksheet']).default('invoice'),
    map: CrmInvoiceTemplateMapSchema.optional() }).strict().nullable().default(null),
  reviewPolicy: z.enum(['direct', 'exact_version_review']).default('direct'),
  referenceDefinitionKey: StableKey.nullable().default(null),
}).strict()
export type CrmOperationVersionInput = z.infer<typeof CrmOperationVersionInputSchema>

export const CRM_OPERATION_KINDS = ['invoice'] as const

// ── Commands ────────────────────────────────────────────────────────

const OperationId = Uuid

export const SaveCrmSellerProfileCommandSchema = z.object({
  kind: z.literal('save_seller_profile'),
  operationId: OperationId,
  sellerId: Uuid.optional(),
  expectedVersion: z.number().int().min(1).optional(),
  seller: z.object({
    sellerKey: StableKey,
    legalName: z.string().trim().min(1).max(300),
    displayName: z.string().trim().min(1).max(300),
    companyId: Uuid.nullable().default(null),
    timezone: z.string().trim().min(1).max(64).default('UTC'),
    status: z.enum(['active', 'archived']).default('active'),
  }).strict(),
  classification: CrmClassificationSchema.optional(),
}).strict().refine((value) => (value.sellerId === undefined) === (value.expectedVersion === undefined), 'sellerId and expectedVersion are supplied together')

export const SaveCrmCustomerAccountCommandSchema = z.object({
  kind: z.literal('save_customer_account'),
  operationId: OperationId,
  accountId: Uuid.optional(),
  expectedVersion: z.number().int().min(1).optional(),
  account: z.object({
    sellerKey: StableKey,
    companyId: Uuid,
    label: z.string().trim().min(1).max(300),
    billingContactId: Uuid.nullable().default(null),
    billingAddress: z.string().trim().min(1).max(2000).nullable().default(null),
    status: z.enum(['active', 'archived']).default('active'),
  }).strict(),
  classification: CrmClassificationSchema.optional(),
}).strict().refine((value) => (value.accountId === undefined) === (value.expectedVersion === undefined), 'accountId and expectedVersion are supplied together')

export const AcceptCrmCommercialProfileCommandSchema = z.object({
  kind: z.literal('accept_commercial_profile'),
  operationId: OperationId,
  owner: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('seller'), sellerKey: StableKey }).strict(),
    z.object({ kind: z.literal('account'), accountId: Uuid }).strict(),
    z.object({ kind: z.literal('agreement'), accountId: Uuid, agreementKey: StableKey, dealIds: z.array(Uuid).max(50).default([]) }).strict(),
  ]),
  expectedCurrentVersion: z.number().int().min(0),
  fields: CrmCommercialFieldsSchema,
  effectiveFrom: IsoDate.nullable().default(null),
  effectiveTo: IsoDate.nullable().default(null),
  evidence: CrmCommercialSourceEvidenceSchema,
  classification: CrmClassificationSchema.optional(),
}).strict().refine((value) => !value.effectiveFrom || !value.effectiveTo || value.effectiveFrom <= value.effectiveTo, 'effectiveTo precedes effectiveFrom')

export const SaveCrmOperationDefinitionCommandSchema = z.object({
  kind: z.literal('save_operation_definition'),
  operationId: OperationId,
  operationKey: StableKey,
  operationKind: z.enum(CRM_OPERATION_KINDS),
  label: z.string().trim().min(1).max(200),
  expectedVersion: z.number().int().min(0),
  version: CrmOperationVersionInputSchema,
}).strict()

export const AcceptCrmOperationVersionCommandSchema = z.object({
  kind: z.literal('accept_operation_version'),
  operationId: OperationId,
  operationKey: StableKey,
  versionId: Uuid,
  expectedVersion: z.number().int().min(0),
}).strict()

export const CRM_COMMERCIAL_CONTEXT_COMMAND_KINDS = [
  'save_seller_profile', 'save_customer_account', 'accept_commercial_profile',
  'save_operation_definition', 'accept_operation_version',
] as const

export const CrmCommercialContextCommandSchema = z.union([
  SaveCrmSellerProfileCommandSchema,
  SaveCrmCustomerAccountCommandSchema,
  AcceptCrmCommercialProfileCommandSchema,
  SaveCrmOperationDefinitionCommandSchema,
  AcceptCrmOperationVersionCommandSchema,
])
export type CrmCommercialContextCommand = z.infer<typeof CrmCommercialContextCommandSchema>

export function isCrmCommercialContextCommand(command: { kind: string }): command is CrmCommercialContextCommand {
  return (CRM_COMMERCIAL_CONTEXT_COMMAND_KINDS as readonly string[]).includes(command.kind)
}

// ── Deterministic resolution ────────────────────────────────────────

export type CrmCommercialSourceKind = 'transaction' | 'agreement' | 'account' | 'seller'

export type CrmCommercialProfileSnapshot = {
  id: string
  ownerKind: 'seller' | 'account' | 'agreement'
  ownerId: string
  agreementKey: string | null
  dealIds: string[]
  version: number
  effectiveFrom: string | null
  effectiveTo: string | null
  fields: CrmCommercialFields
}

export type CrmResolvedField = {
  fieldKey: string
  type: CrmCommercialFieldType
  value: CrmCommercialFieldEntry['value'] | undefined
  source: { kind: CrmCommercialSourceKind; recordId: string | null; version: number | null; effectiveFrom: string | null } | null
  overridden: boolean
}

export type CrmResolutionQuestion = {
  fieldKey: string
  label: string
  kind: 'missing' | 'conflict' | 'review_required'
  requiredFor: 'draft' | 'issue' | 'never'
  question: string
  candidates?: Array<{ source: CrmCommercialSourceKind; recordId: string | null; value: unknown }>
}

export type CrmResolutionReceipt = {
  operationKey: string
  operationVersionId: string
  businessDate: string | null
  fields: Record<string, CrmResolvedField>
  questions: CrmResolutionQuestion[]
  draftReady: boolean
  issueReady: boolean
  profileVersions: Array<{ id: string; ownerKind: string; version: number }>
}

export class CrmOverrideNotPermittedError extends Error {
  readonly code = 'override_not_permitted'
  constructor(readonly fieldKeys: string[]) {
    super(`Transaction values are not permitted for: ${fieldKeys.join(', ')}`)
    this.name = 'CrmOverrideNotPermittedError'
  }
}

/** An agreement applies to the deal it names and to the business date it covers. Undated agreements always apply. */
function applies(profile: CrmCommercialProfileSnapshot, businessDate: string | null, dealId: string | null): boolean {
  if (profile.dealIds.length && (!dealId || !profile.dealIds.includes(dealId))) return false
  if (!businessDate) return profile.effectiveFrom === null && profile.effectiveTo === null
  if (profile.effectiveFrom && businessDate < profile.effectiveFrom) return false
  if (profile.effectiveTo && businessDate > profile.effectiveTo) return false
  return true
}

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

/**
 * Resolve every bound field. Higher sources win; a refused override throws;
 * protected contradictions and agreement conflicts become questions.
 */
export function resolveCrmCommercialFields(input: {
  operationKey: string
  operationVersionId: string
  bindings: readonly CrmFieldBinding[]
  businessDate: string | null
  dealId: string | null
  seller: CrmCommercialProfileSnapshot | null
  account: CrmCommercialProfileSnapshot | null
  agreements: readonly CrmCommercialProfileSnapshot[]
  transaction: CrmCommercialFields
}): CrmResolutionReceipt {
  const bindingKeys = new Set(input.bindings.map((binding) => binding.fieldKey))
  const unknown = Object.keys(input.transaction).filter((key) => !bindingKeys.has(key))
  const refused = input.bindings.filter((binding) => Object.hasOwn(input.transaction, binding.fieldKey)
    && (!binding.overridable || !binding.sources.includes('transaction'))).map((binding) => binding.fieldKey)
  if (unknown.length || refused.length) throw new CrmOverrideNotPermittedError([...unknown, ...refused])
  const agreements = input.agreements.filter((profile) => applies(profile, input.businessDate, input.dealId))
  const fields: Record<string, CrmResolvedField> = {}
  const questions: CrmResolutionQuestion[] = []
  for (const binding of input.bindings) {
    const typed = (entry: CrmCommercialFieldEntry | undefined) => entry && entry.type === binding.type ? entry : undefined
    const transaction = typed(input.transaction[binding.fieldKey])
    const agreementValues = binding.sources.includes('agreement')
      ? agreements.flatMap((profile) => { const entry = typed(profile.fields[binding.fieldKey]); return entry ? [{ profile, entry }] : [] })
      : []
    const distinctAgreements = agreementValues.filter((candidate, index) => agreementValues.findIndex((other) => same(other.entry.value, candidate.entry.value)) === index)
    let resolved: CrmResolvedField = { fieldKey: binding.fieldKey, type: binding.type, value: undefined, source: null, overridden: false }
    let blocked = false
    if (distinctAgreements.length > 1) {
      questions.push({ fieldKey: binding.fieldKey, label: binding.label, kind: 'conflict', requiredFor: binding.requiredFor,
        question: `Two applicable agreements disagree on ${binding.label}. Which one applies?`,
        candidates: distinctAgreements.map(({ profile, entry }) => ({ source: 'agreement' as const, recordId: profile.id, value: entry.value })) })
      blocked = true
    }
    if (!blocked && transaction) {
      const agreement = distinctAgreements[0]
      if (binding.protected && agreement && !same(agreement.entry.value, transaction.value)) {
        questions.push({ fieldKey: binding.fieldKey, label: binding.label, kind: 'review_required', requiredFor: binding.requiredFor,
          question: `${binding.label} is a protected agreement term. Changing it needs the declared review, not a transaction value.`,
          candidates: [{ source: 'agreement', recordId: agreement.profile.id, value: agreement.entry.value }, { source: 'transaction', recordId: null, value: transaction.value }] })
        resolved = { ...resolved, value: agreement.entry.value,
          source: { kind: 'agreement', recordId: agreement.profile.id, version: agreement.profile.version, effectiveFrom: agreement.profile.effectiveFrom } }
      } else {
        resolved = { ...resolved, value: transaction.value, source: { kind: 'transaction', recordId: null, version: null, effectiveFrom: null }, overridden: true }
      }
    } else if (!blocked) {
      for (const sourceKind of binding.sources) {
        if (sourceKind === 'transaction') continue
        const candidate = sourceKind === 'agreement' ? distinctAgreements[0] && { profile: distinctAgreements[0].profile, entry: distinctAgreements[0].entry }
          : (() => { const profile = sourceKind === 'account' ? input.account : input.seller; const entry = profile ? typed(profile.fields[binding.fieldKey]) : undefined; return profile && entry ? { profile, entry } : undefined })()
        if (!candidate) continue
        resolved = { ...resolved, value: candidate.entry.value,
          source: { kind: sourceKind, recordId: candidate.profile.id, version: candidate.profile.version, effectiveFrom: candidate.profile.effectiveFrom } }
        break
      }
    }
    fields[binding.fieldKey] = resolved
    if (!blocked && resolved.value === undefined && binding.requiredFor !== 'never') {
      questions.push({ fieldKey: binding.fieldKey, label: binding.label, kind: 'missing', requiredFor: binding.requiredFor,
        question: `${binding.label} is needed ${binding.requiredFor === 'draft' ? 'for a draft' : 'before issue'} and has no accepted value. What is it?` })
    }
  }
  const unresolved = (stage: 'draft' | 'issue') => questions.some((question) =>
    question.kind !== 'review_required' && (question.requiredFor === stage || (stage === 'issue' && question.requiredFor === 'draft')))
  const used = [input.seller, input.account, ...agreements].filter((profile): profile is CrmCommercialProfileSnapshot => profile !== null)
  return {
    operationKey: input.operationKey,
    operationVersionId: input.operationVersionId,
    businessDate: input.businessDate,
    fields,
    questions,
    draftReady: !unresolved('draft') && !questions.some((question) => question.kind === 'conflict' && question.requiredFor === 'draft'),
    issueReady: !unresolved('issue') && !questions.some((question) => question.kind === 'conflict' || question.kind === 'review_required'),
    profileVersions: used.map((profile) => ({ id: profile.id, ownerKind: profile.ownerKind, version: profile.version })),
  }
}

// ── Read port ───────────────────────────────────────────────────────

export const CrmAccountListQuerySchema = z.object({
  companyId: Uuid.optional(),
  sellerKey: StableKey.optional(),
  includeArchived: z.union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')]).default(false),
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict()
export type CrmAccountListQuery = z.infer<typeof CrmAccountListQuerySchema>

export const CrmCommercialProfileQuerySchema = z.object({
  sellerKey: StableKey.optional(),
  accountId: Uuid.optional(),
  includeSuperseded: z.union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')]).default(false),
}).strict().refine((value) => value.sellerKey !== undefined || value.accountId !== undefined, 'Supply sellerKey or accountId')
export type CrmCommercialProfileQuery = z.infer<typeof CrmCommercialProfileQuerySchema>

export const CrmResolutionQuerySchema = z.object({
  operationKey: StableKey,
  accountId: Uuid,
  dealId: Uuid.optional(),
  businessDate: IsoDate.optional(),
}).strict()
export type CrmResolutionQuery = z.infer<typeof CrmResolutionQuerySchema>

export type CrmCommercialViewer = { userId: string; canConfigure?: boolean }

export type CrmCommercialContextReadPort = {
  listAccounts(workspaceId: string, viewer: CrmCommercialViewer, query: CrmAccountListQuery): Promise<{ schemaVersion: 1; accounts: Array<Record<string, unknown>>; nextCursor: string | null }>
  getAccount(workspaceId: string, viewer: CrmCommercialViewer, accountId: string): Promise<Record<string, unknown> | null>
  listSellers(workspaceId: string, viewer: CrmCommercialViewer): Promise<{ schemaVersion: 1; sellers: Array<Record<string, unknown>> }>
  listProfiles(workspaceId: string, viewer: CrmCommercialViewer, query: CrmCommercialProfileQuery): Promise<{ schemaVersion: 1; profiles: Array<Record<string, unknown>> }>
  listOperationDefinitions(workspaceId: string, viewer: CrmCommercialViewer): Promise<{ schemaVersion: 1; operations: Array<Record<string, unknown>> }>
  resolve(workspaceId: string, viewer: CrmCommercialViewer, query: CrmResolutionQuery & { transaction?: CrmCommercialFields }): Promise<CrmResolutionReceipt>
}
