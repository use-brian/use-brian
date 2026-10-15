/**
 * Governed client/engagement operations: bounded review policies, versioned
 * change requests, engagement extensions of canonical deals, protected
 * commercial values, recurring successors and the billing handoff.
 * Spec: docs/architecture/features/crm-commercial-operations.md -> Governed engagement and billing
 *
 * [COMP:crm/governed-records]
 */

import { z } from 'zod'
import { CrmDecimalStringSchema } from './commercial-context.js'

const Uuid = z.string().uuid()
const StableKey = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{0,62}$/)
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const Currency = z.string().regex(/^[A-Z]{3}$/)
const Reason = z.string().trim().min(1).max(2000)

export const CRM_GOVERNANCE_SUBJECTS = ['client_change', 'engagement_change', 'commercial_values', 'billing_request'] as const
export const CrmGovernanceSubjectSchema = z.enum(CRM_GOVERNANCE_SUBJECTS)
export type CrmGovernanceSubject = z.infer<typeof CrmGovernanceSubjectSchema>

/**
 * The finite review vocabulary. No quorum, parallel committees or programmable graphs.
 * `direct`: only actors whose role is in `directRoles` may change the subject, and they apply directly.
 * `single_review`: `directRoles` is the explicit direct-application exception; everyone else submits for one review.
 * `reviewer_then_finance` (billing only): a reviewer, then a finance reviewer, before ready to bill.
 */
export const CrmReviewPolicySchema = z.object({
  mode: z.enum(['direct', 'single_review', 'reviewer_then_finance']),
  /** Roles allowed to apply directly (direct mode, or the direct-application exception). */
  directRoles: z.array(z.enum(['owner', 'admin', 'member'])).max(3).default(['owner', 'admin']),
  /** A reviewer is an owner/admin, or a member of this department when set. */
  reviewerDepartmentId: Uuid.nullable().default(null),
  financeDepartmentId: Uuid.nullable().default(null),
  allowSelfReview: z.boolean().default(false),
}).strict().refine((value) => value.mode === 'reviewer_then_finance' || value.financeDepartmentId === null, 'Only the billing policy names a finance step')
export type CrmReviewPolicy = z.infer<typeof CrmReviewPolicySchema>

export const DEFAULT_CRM_REVIEW_POLICIES: Readonly<Record<CrmGovernanceSubject, CrmReviewPolicy>> = Object.freeze({
  client_change: { mode: 'single_review', directRoles: ['owner', 'admin'], reviewerDepartmentId: null, financeDepartmentId: null, allowSelfReview: false },
  engagement_change: { mode: 'single_review', directRoles: ['owner', 'admin'], reviewerDepartmentId: null, financeDepartmentId: null, allowSelfReview: false },
  commercial_values: { mode: 'single_review', directRoles: ['owner', 'admin'], reviewerDepartmentId: null, financeDepartmentId: null, allowSelfReview: false },
  billing_request: { mode: 'single_review', directRoles: [], reviewerDepartmentId: null, financeDepartmentId: null, allowSelfReview: false },
})

export const CrmEngagementCatalogKindSchema = z.enum(['service_category', 'work_status'])

const EngagementFields = z.object({
  serviceCategory: StableKey.nullable().optional(),
  periodStart: IsoDate.nullable().optional(),
  periodEnd: IsoDate.nullable().optional(),
  financialPeriod: z.string().trim().min(1).max(40).nullable().optional(),
  workStatus: StableKey.nullable().optional(),
  deadline: IsoDate.nullable().optional(),
  ownerUserId: Uuid.nullable().optional(),
  participantIds: z.array(Uuid).max(100).optional(),
}).strict()
export type CrmEngagementFields = z.infer<typeof EngagementFields>

/** A bounded change set: only these canonical fields can be changed through review. */
export const CrmChangeSetSchema = z.object({
  name: z.string().trim().min(1).max(512).optional(),
  companyId: Uuid.optional(),
  domain: z.string().trim().min(1).max(253).nullable().optional(),
  engagement: EngagementFields.optional(),
  /** Reference definitions (assignment event `approval`) to assign when the change is approved. */
  assignReferences: z.array(z.object({ definitionKey: StableKey, categoryKey: StableKey.optional(), businessDate: IsoDate.optional() }).strict()).max(5).default([]),
}).strict()
export type CrmChangeSet = z.infer<typeof CrmChangeSetSchema>

const Target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('company'), id: Uuid.optional() }).strict(),
  z.object({ kind: z.literal('deal'), id: Uuid.optional() }).strict(),
])

export const SaveCrmChangeRequestCommandSchema = z.object({
  kind: z.literal('save_change_request'), operationId: Uuid,
  requestId: Uuid.optional(), expectedVersion: z.number().int().min(1).optional(),
  target: Target, changes: CrmChangeSetSchema, note: z.string().trim().max(2000).optional(),
}).strict().refine((value) => (value.requestId === undefined) === (value.expectedVersion === undefined), 'requestId and expectedVersion are supplied together')
export const SubmitCrmChangeRequestCommandSchema = z.object({ kind: z.literal('submit_change_request'), operationId: Uuid, requestId: Uuid, expectedVersion: z.number().int().min(1) }).strict()
export const DecideCrmChangeRequestCommandSchema = z.object({
  kind: z.literal('decide_change_request'), operationId: Uuid, requestId: Uuid, expectedRevision: z.number().int().min(1),
  decision: z.enum(['approve', 'return', 'reject']), reason: Reason.optional(),
}).strict().refine((value) => value.decision === 'approve' || value.reason !== undefined, 'Returning or rejecting needs a reason')
export const WithdrawCrmChangeRequestCommandSchema = z.object({ kind: z.literal('withdraw_change_request'), operationId: Uuid, requestId: Uuid, expectedVersion: z.number().int().min(1), reason: Reason }).strict()
export const UpdateCrmEngagementTrackingCommandSchema = z.object({
  kind: z.literal('update_engagement_tracking'), operationId: Uuid, dealId: Uuid, expectedVersion: z.number().int().min(0),
  tracking: EngagementFields.pick({ workStatus: true, deadline: true, participantIds: true, ownerUserId: true }),
}).strict()
export const SetCrmCommercialValuesCommandSchema = z.object({
  kind: z.literal('set_commercial_values'), operationId: Uuid, dealId: Uuid,
  values: z.array(z.object({
    valueKind: z.enum(['quoted', 'confirmed', 'outsource']),
    expectedVersion: z.number().int().min(0),
    amount: CrmDecimalStringSchema.nullable(),
    currency: Currency,
    rate: z.object({ toCurrency: Currency, rate: CrmDecimalStringSchema, rateDate: IsoDate, source: z.string().trim().min(1).max(200) }).strict().nullable().default(null),
  }).strict()).min(1).max(3),
  evidence: z.object({ source: z.string().trim().min(1).max(200), reason: Reason }).strict(),
  sensitivity: z.enum(['internal', 'confidential']).optional(),
}).strict()
export const CommitCrmRecurringSuccessorsCommandSchema = z.object({
  kind: z.literal('commit_recurring_successors'), operationId: Uuid,
  sourceDealIds: z.array(Uuid).min(1).max(200),
  period: z.object({ key: z.string().trim().min(1).max(40), periodStart: IsoDate, periodEnd: IsoDate, financialPeriod: z.string().trim().min(1).max(40).nullable().default(null), deadline: IsoDate.nullable().default(null) }).strict(),
  carryForward: z.array(z.enum(['serviceCategory', 'owner', 'participants', 'quotedFee'])).max(4).default(['serviceCategory', 'owner', 'participants']),
}).strict()
export const SaveCrmGovernancePolicyCommandSchema = z.object({
  kind: z.literal('save_governance_policy'), operationId: Uuid, subject: CrmGovernanceSubjectSchema, expectedVersion: z.number().int().min(0), policy: CrmReviewPolicySchema,
}).strict()
export const SaveCrmEngagementCatalogCommandSchema = z.object({
  kind: z.literal('save_engagement_catalog'), operationId: Uuid, catalog: CrmEngagementCatalogKindSchema, expectedVersion: z.number().int().min(0),
  entries: z.array(z.object({ key: StableKey, label: z.string().trim().min(1).max(200), archived: z.boolean().default(false) }).strict()).min(1).max(200),
}).strict()
/** Create a billing request, or revise a draft/returned one (requestId + expectedVersion), optionally submitting it. */
export const CreateCrmBillingRequestCommandSchema = z.object({
  kind: z.literal('create_billing_request'), operationId: Uuid, dealId: Uuid, amount: CrmDecimalStringSchema, currency: Currency,
  description: z.string().trim().min(1).max(2000), submit: z.boolean().default(true),
  requestId: Uuid.optional(), expectedVersion: z.number().int().min(1).optional(),
}).strict().refine((value) => (value.requestId === undefined) === (value.expectedVersion === undefined), 'requestId and expectedVersion are supplied together')
export const DecideCrmBillingRequestCommandSchema = z.object({
  kind: z.literal('decide_billing_request'), operationId: Uuid, requestId: Uuid, expectedVersion: z.number().int().min(1),
  decision: z.enum(['approve', 'return']), reason: Reason.optional(),
}).strict().refine((value) => value.decision === 'approve' || value.reason !== undefined, 'Returning needs a reason')
export const CancelCrmBillingRequestCommandSchema = z.object({ kind: z.literal('cancel_billing_request'), operationId: Uuid, requestId: Uuid, expectedVersion: z.number().int().min(1), reason: Reason }).strict()
export const RecordCrmExternalInvoiceCommandSchema = z.object({
  kind: z.literal('record_external_invoice'), operationId: Uuid, accountId: Uuid,
  provider: StableKey, remoteId: z.string().trim().min(1).max(500), number: z.string().trim().min(1).max(128), issueDate: IsoDate,
  currency: Currency, total: CrmDecimalStringSchema,
  allocations: z.array(z.object({ dealId: Uuid, amount: CrmDecimalStringSchema, billingRequestId: Uuid.optional() }).strict()).min(1).max(50),
}).strict()
export const CorrectCrmExternalInvoiceReferenceCommandSchema = z.object({
  kind: z.literal('correct_external_invoice_reference'), operationId: Uuid, invoiceId: Uuid, expectedVersion: z.number().int().min(1),
  number: z.string().trim().min(1).max(128).optional(), reopenBillingRequestIds: z.array(Uuid).max(50).default([]), reason: Reason,
}).strict()

export const CRM_GOVERNED_COMMAND_KINDS = [
  'save_change_request', 'submit_change_request', 'decide_change_request', 'withdraw_change_request', 'update_engagement_tracking',
  'set_commercial_values', 'commit_recurring_successors', 'save_governance_policy', 'save_engagement_catalog',
  'create_billing_request', 'decide_billing_request', 'cancel_billing_request', 'record_external_invoice', 'correct_external_invoice_reference',
] as const

export const CrmGovernedCommandSchema = z.union([
  SaveCrmChangeRequestCommandSchema, SubmitCrmChangeRequestCommandSchema, DecideCrmChangeRequestCommandSchema, WithdrawCrmChangeRequestCommandSchema,
  UpdateCrmEngagementTrackingCommandSchema, SetCrmCommercialValuesCommandSchema, CommitCrmRecurringSuccessorsCommandSchema,
  SaveCrmGovernancePolicyCommandSchema, SaveCrmEngagementCatalogCommandSchema, CreateCrmBillingRequestCommandSchema,
  DecideCrmBillingRequestCommandSchema, CancelCrmBillingRequestCommandSchema, RecordCrmExternalInvoiceCommandSchema,
  CorrectCrmExternalInvoiceReferenceCommandSchema,
])
export type CrmGovernedCommand = z.infer<typeof CrmGovernedCommandSchema>

export function isCrmGovernedCommand(command: { kind: string }): command is CrmGovernedCommand {
  return (CRM_GOVERNED_COMMAND_KINDS as readonly string[]).includes(command.kind)
}

// ── Reads ───────────────────────────────────────────────────────────

export const CrmChangeRequestQuerySchema = z.object({
  state: z.enum(['draft', 'submitted', 'returned', 'approved', 'rejected', 'withdrawn']).optional(),
  targetId: Uuid.optional(),
  reviewable: z.union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')]).default(false),
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict()
const BooleanQuery = z.union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')])
/** With `dealId` the deal is returned even before it has tracking (version 0). Commercial values are included only when asked, under their own protection. */
export const CrmEngagementQuerySchema = z.object({
  dealId: Uuid.optional(), includeCommercialValues: BooleanQuery.default(false),
  companyId: Uuid.optional(), workStatus: StableKey.optional(), serviceCategory: StableKey.optional(), financialPeriod: z.string().trim().min(1).max(40).optional(),
  cursor: z.string().min(1).max(4096).optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict()
export const CrmBillingRequestQuerySchema = z.object({
  state: z.enum(['draft', 'review', 'ready_to_bill', 'invoiced', 'returned', 'cancelled']).optional(), dealId: Uuid.optional(),
  cursor: z.string().min(1).max(4096).optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict()
export const CrmBillingBalanceQuerySchema = z.object({ dealId: Uuid.optional(), companyId: Uuid.optional() }).strict()
  .refine((value) => value.dealId !== undefined || value.companyId !== undefined, 'Supply dealId or companyId')
export const CrmRecurringPreviewQuerySchema = z.object({
  sourceDealIds: z.union([Uuid, z.array(Uuid)]).transform((value) => Array.isArray(value) ? value : [value]),
  periodKey: z.string().trim().min(1).max(40),
}).strict()

export type CrmGovernedViewer = { userId: string; role?: string }
export type CrmGovernedReadPort = {
  listChangeRequests(workspaceId: string, viewer: CrmGovernedViewer, query: z.infer<typeof CrmChangeRequestQuerySchema>): Promise<{ schemaVersion: 1; requests: Array<Record<string, unknown>>; nextCursor: string | null }>
  getChangeRequest(workspaceId: string, viewer: CrmGovernedViewer, requestId: string): Promise<Record<string, unknown> | null>
  listEngagements(workspaceId: string, viewer: CrmGovernedViewer, query: z.infer<typeof CrmEngagementQuerySchema>): Promise<{ schemaVersion: 1; engagements: Array<Record<string, unknown>>; nextCursor: string | null }>
  listBillingRequests(workspaceId: string, viewer: CrmGovernedViewer, query: z.infer<typeof CrmBillingRequestQuerySchema>): Promise<{ schemaVersion: 1; requests: Array<Record<string, unknown>>; nextCursor: string | null }>
  billingBalance(workspaceId: string, viewer: CrmGovernedViewer, query: z.infer<typeof CrmBillingBalanceQuerySchema>): Promise<Record<string, unknown>>
  previewRecurringSuccessors(workspaceId: string, viewer: CrmGovernedViewer, query: z.infer<typeof CrmRecurringPreviewQuerySchema>): Promise<Record<string, unknown>>
  listCatalogs(workspaceId: string): Promise<{ schemaVersion: 1; catalogs: Array<Record<string, unknown>>; policies: Array<Record<string, unknown>> }>
}
