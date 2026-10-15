/**
 * Brian and Brain-MCP tools for governed client/engagement changes, engagement
 * tracking, protected commercial values, recurring successors and billing.
 * Each submits the same typed command as the CRM UI and REST adapters. Review
 * decisions and governance configuration are human CRM actions: a tool
 * confirmation never establishes business approval.
 * Spec: docs/architecture/features/crm-commercial-operations.md -> Governed engagement and billing
 *
 * [COMP:crm/governed-records]
 */

import { z } from 'zod'
import { buildTool, type Tool, type ToolContext, type ToolInput } from '../tools/types.js'
import { missingToolCapability } from '../tools/capability-gate.js'
import { crmOperationsToolContext, crmOperationsToolFailure } from './operations-tools.js'
import type { CrmOperationsCommand, CrmOperationsServicePort } from './operations-types.js'
import { CrmDecimalStringSchema } from './commercial-context.js'
import {
  CrmBillingBalanceQuerySchema,
  CrmBillingRequestQuerySchema,
  CrmChangeRequestQuerySchema,
  CrmEngagementQuerySchema,
  type CrmChangeSet,
  type CrmGovernedReadPort,
} from './governed-records.js'

const Uuid = z.string().uuid()
const Key = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{0,62}$/)
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const Currency = z.string().regex(/^[A-Z]{3}$/)
const Reason = z.string().trim().min(1).max(2000)
const OperationId = Uuid.describe('Stable operation id. Reuse the SAME id when retrying an uncertain result; never invent a new one to retry.')
const Cursor = z.string().min(1).max(4096).optional()

const Engagement = z.object({
  service_category: Key.nullable().optional(), period_start: IsoDate.nullable().optional(), period_end: IsoDate.nullable().optional(),
  financial_period: z.string().trim().min(1).max(40).nullable().optional(), work_status: Key.nullable().optional(),
  deadline: IsoDate.nullable().optional(), owner_user_id: Uuid.nullable().optional(), participant_ids: z.array(Uuid).max(100).optional(),
}).strict()
type EngagementInput = z.infer<typeof Engagement>
const engagement = (input: EngagementInput) => {
  const out: Record<string, unknown> = {}
  const map: Record<string, string> = { service_category: 'serviceCategory', period_start: 'periodStart', period_end: 'periodEnd',
    financial_period: 'financialPeriod', work_status: 'workStatus', deadline: 'deadline', owner_user_id: 'ownerUserId', participant_ids: 'participantIds' }
  for (const [key, value] of Object.entries(input)) if (value !== undefined) out[map[key]!] = value
  return out
}
const Changes = z.object({
  name: z.string().trim().min(1).max(512).optional(),
  company_id: Uuid.optional().describe('Client company of a deal (required for a new engagement).'),
  domain: z.string().trim().min(1).max(253).nullable().optional(),
  engagement: Engagement.optional(),
  assign_references: z.array(z.object({ definition_key: Key, category_key: Key.optional(), business_date: IsoDate.optional() }).strict()).max(5).default([])
    .describe('Approval-time reference definitions to assign when the change is approved.'),
}).strict()
const changes = (input: z.infer<typeof Changes>): CrmChangeSet => ({
  ...(input.name !== undefined ? { name: input.name } : {}),
  ...(input.company_id !== undefined ? { companyId: input.company_id } : {}),
  ...(input.domain !== undefined ? { domain: input.domain } : {}),
  ...(input.engagement ? { engagement: engagement(input.engagement) } : {}),
  assignReferences: input.assign_references.map((reference) => ({ definitionKey: reference.definition_key,
    ...(reference.category_key ? { categoryKey: reference.category_key } : {}), ...(reference.business_date ? { businessDate: reference.business_date } : {}) })),
})

export type CrmGovernedRecordTools = {
  listCrmChangeRequests: Tool
  getCrmChangeRequest: Tool
  listCrmEngagements: Tool
  listCrmBillingRequests: Tool
  getCrmBillingBalance: Tool
  previewCrmRecurringSuccessors: Tool
  saveCrmChangeRequest: Tool
  submitCrmChangeRequest: Tool
  withdrawCrmChangeRequest: Tool
  updateCrmEngagementTracking: Tool
  setCrmCommercialValues: Tool
  commitCrmRecurringSuccessors: Tool
  saveCrmBillingRequest: Tool
  cancelCrmBillingRequest: Tool
  recordCrmExternalInvoice: Tool
  correctCrmExternalInvoiceReference: Tool
}

function notScoped() {
  return { isError: true as const, data: 'Governed CRM records require a workspace-scoped assistant or programmatic credential.' }
}

export function createCrmGovernedRecordTools(options: { reads: CrmGovernedReadPort; service: CrmOperationsServicePort }): CrmGovernedRecordTools {
  function read<Input extends z.ZodType>(description: string, inputSchema: Input,
    run: (workspaceId: string, viewer: { userId: string }, input: z.infer<Input>) => Promise<unknown>): Omit<ToolInput<Input>, 'name' | 'isReadOnly'> {
    return {
      description, inputSchema, requiresCapability: 'crm', homeAppToolSet: { app: 'crm', set: 'read' },
      async execute(input, context: ToolContext) {
        if (!context.workspaceId || !context.userId) return notScoped()
        try { return { data: await run(context.workspaceId, { userId: context.userId }, inputSchema.parse(input)) } }
        catch (error) { return crmOperationsToolFailure(error) }
      },
    }
  }
  function command<Input extends z.ZodType>(description: string, inputSchema: Input,
    toCommand: (input: z.infer<Input>) => CrmOperationsCommand, confirm: boolean): Omit<ToolInput<Input>, 'name' | 'isReadOnly'> {
    const gate = { requiresCapability: 'crm', homeAppToolSet: { app: 'crm', set: 'write' } } as const
    return {
      description, inputSchema, ...gate, requiresConfirmation: confirm,
      async execute(input, context) {
        const missing = missingToolCapability(gate as unknown as Tool, context.activeCapabilities)
        if (missing) return { isError: true, data: { error: 'not_authorized', requiredCapability: missing } }
        const caller = crmOperationsToolContext(context)
        if (!caller) return notScoped()
        try { return { data: await options.service.execute(caller, toCommand(inputSchema.parse(input))) } }
        catch (error) { return crmOperationsToolFailure(error) }
      },
    }
  }
  const missing = (what: string) => ({ error: 'not_found', message: `The ${what} is unavailable in your current scope.` })

  const listCrmChangeRequests: Tool = buildTool({ name: 'listCrmChangeRequests', isReadOnly: true, ...read(
    'List governed client and engagement change requests visible in your scope (state, target, revision, author). Filter by state or target. Follow nextCursor until null.',
    CrmChangeRequestQuerySchema.omit({ cursor: true }).extend({ cursor: Cursor }),
    (workspaceId, viewer, input) => options.reads.listChangeRequests(workspaceId, viewer, input)) })
  const getCrmChangeRequest: Tool = buildTool({ name: 'getCrmChangeRequest', isReadOnly: true, ...read(
    'Read one change request: its draft, every submitted revision with the frozen current and proposed values, and the decisions with their reasons.',
    z.object({ request_id: Uuid }).strict(),
    async (workspaceId, viewer, input) => (await options.reads.getChangeRequest(workspaceId, viewer, input.request_id)) ?? missing('change request')) })
  const listCrmEngagements: Tool = buildTool({ name: 'listCrmEngagements', isReadOnly: true, ...read(
    'List engagements (deals with service category, period, financial period, work status, deadline, owner and participants). Work status is delivery progress, separate from the sales pipeline stage. Protected fees are not included. Follow nextCursor until null.',
    CrmEngagementQuerySchema.omit({ cursor: true }).extend({ cursor: Cursor }),
    (workspaceId, viewer, input) => options.reads.listEngagements(workspaceId, viewer, input)) })
  const listCrmBillingRequests: Tool = buildTool({ name: 'listCrmBillingRequests', isReadOnly: true, ...read(
    'List billing requests (draft, review, ready_to_bill, invoiced, returned, cancelled) visible in your scope, with their pinned reviewed amounts. Follow nextCursor until null.',
    CrmBillingRequestQuerySchema.omit({ cursor: true }).extend({ cursor: Cursor }),
    (workspaceId, viewer, input) => options.reads.listBillingRequests(workspaceId, viewer, input)) })
  const getCrmBillingBalance: Tool = buildTool({ name: 'getCrmBillingBalance', isReadOnly: true, ...read(
    'Read the unbilled balance per currency for a deal or a company: confirmed fee minus invoiced allocations. A missing confirmed fee is reported as absent, never as zero.',
    z.object({ deal_id: Uuid.optional(), company_id: Uuid.optional() }).strict(),
    (workspaceId, viewer, input) => options.reads.billingBalance(workspaceId, viewer, CrmBillingBalanceQuerySchema.parse({ dealId: input.deal_id, companyId: input.company_id }))) })
  const previewCrmRecurringSuccessors: Tool = buildTool({ name: 'previewCrmRecurringSuccessors', isReadOnly: true, ...read(
    'Preview recurring successors for a period: which source engagements would get a new successor, which already have one, and which cannot (with a reason). Nothing is created.',
    z.object({ source_deal_ids: z.array(Uuid).min(1).max(200), period_key: z.string().trim().min(1).max(40) }).strict(),
    (workspaceId, viewer, input) => options.reads.previewRecurringSuccessors(workspaceId, viewer, { sourceDealIds: input.source_deal_ids, periodKey: input.period_key })) })

  const saveCrmChangeRequest: Tool = buildTool({ name: 'saveCrmChangeRequest', isReadOnly: false, ...command(
    'Draft a governed change to a client company or engagement (deal): name, domain, client company, engagement fields and approval-time references. Omit target id to propose a new record. Pass request_id with expected_version to edit a draft or returned request. Nothing changes until it is submitted and applied.',
    z.object({ operation_id: OperationId, target_kind: z.enum(['company', 'deal']), target_id: Uuid.optional(),
      request_id: Uuid.optional(), expected_version: z.number().int().min(1).optional(), changes: Changes, note: z.string().trim().max(2000).optional() }).strict(),
    (input) => ({ kind: 'save_change_request', operationId: input.operation_id, ...(input.request_id ? { requestId: input.request_id, expectedVersion: input.expected_version } : {}),
      target: { kind: input.target_kind, ...(input.target_id ? { id: input.target_id } : {}) }, changes: changes(input.changes), ...(input.note ? { note: input.note } : {}) }) as CrmOperationsCommand, false) })
  const submitCrmChangeRequest: Tool = buildTool({ name: 'submitCrmChangeRequest', isReadOnly: false, ...command(
    'Submit a draft or returned change request for review. Its current and proposed values are frozen as a new revision. If the workspace policy lets this actor apply directly, the change is applied now with that evidence; otherwise a configured reviewer decides in CRM.',
    z.object({ operation_id: OperationId, request_id: Uuid, expected_version: z.number().int().min(1) }).strict(),
    (input) => ({ kind: 'submit_change_request', operationId: input.operation_id, requestId: input.request_id, expectedVersion: input.expected_version }), true) })
  const withdrawCrmChangeRequest: Tool = buildTool({ name: 'withdrawCrmChangeRequest', isReadOnly: false, ...command(
    'Withdraw your own undecided change request with a reason.',
    z.object({ operation_id: OperationId, request_id: Uuid, expected_version: z.number().int().min(1), reason: Reason }).strict(),
    (input) => ({ kind: 'withdraw_change_request', operationId: input.operation_id, requestId: input.request_id, expectedVersion: input.expected_version, reason: input.reason }), false) })
  const updateCrmEngagementTracking: Tool = buildTool({ name: 'updateCrmEngagementTracking', isReadOnly: false, ...command(
    'Update routine engagement tracking (work status, deadline, owner, participants) with the engagement expected_version (0 when it has no tracking yet). Protected fees and governed fields are never touched by this.',
    z.object({ operation_id: OperationId, deal_id: Uuid, expected_version: z.number().int().min(0),
      tracking: Engagement.pick({ work_status: true, deadline: true, owner_user_id: true, participant_ids: true }) }).strict(),
    (input) => ({ kind: 'update_engagement_tracking', operationId: input.operation_id, dealId: input.deal_id, expectedVersion: input.expected_version,
      tracking: engagement(input.tracking) }) as CrmOperationsCommand, false) })
  const setCrmCommercialValues: Tool = buildTool({ name: 'setCrmCommercialValues', isReadOnly: false, ...command(
    'Set protected quoted, confirmed or outsource amounts on an engagement as decimal strings with currency, each with its expected_version (0 when unset). Pass amount null to record an explicit absence; never use 0 for unknown. Needs evidence (source and reason), a reviewer or direct-application role, and the user\'s confirmation.',
    z.object({ operation_id: OperationId, deal_id: Uuid, values: z.array(z.object({ value_kind: z.enum(['quoted', 'confirmed', 'outsource']),
      expected_version: z.number().int().min(0), amount: CrmDecimalStringSchema.nullable(), currency: Currency }).strict()).min(1).max(3),
    evidence_source: z.string().trim().min(1).max(200), reason: Reason }).strict(),
    (input) => ({ kind: 'set_commercial_values', operationId: input.operation_id, dealId: input.deal_id,
      values: input.values.map((value) => ({ valueKind: value.value_kind, expectedVersion: value.expected_version, amount: value.amount, currency: value.currency, rate: null })),
      evidence: { source: input.evidence_source, reason: input.reason } }), true) })
  const commitCrmRecurringSuccessors: Tool = buildTool({ name: 'commitCrmRecurringSuccessors', isReadOnly: false, ...command(
    'Create recurring successor engagements for one period from previewed sources, at most once per source and period. Existing successors are reported, not duplicated. Only the listed carry-forward fields are copied; invoices, receipts and financial assumptions never are. Needs the user\'s confirmation.',
    z.object({ operation_id: OperationId, source_deal_ids: z.array(Uuid).min(1).max(200),
      period: z.object({ key: z.string().trim().min(1).max(40), period_start: IsoDate, period_end: IsoDate, financial_period: z.string().trim().min(1).max(40).nullable().default(null),
        deadline: IsoDate.nullable().default(null) }).strict(),
      carry_forward: z.array(z.enum(['serviceCategory', 'owner', 'participants', 'quotedFee'])).max(4).default(['serviceCategory', 'owner', 'participants']) }).strict(),
    (input) => ({ kind: 'commit_recurring_successors', operationId: input.operation_id, sourceDealIds: input.source_deal_ids,
      period: { key: input.period.key, periodStart: input.period.period_start, periodEnd: input.period.period_end, financialPeriod: input.period.financial_period, deadline: input.period.deadline },
      carryForward: input.carry_forward }), true) })
  const saveCrmBillingRequest: Tool = buildTool({ name: 'saveCrmBillingRequest', isReadOnly: false, ...command(
    'Create a ready-to-bill request for an engagement with the intended amount (decimal string), currency and description, or revise a draft/returned one with request_id and expected_version. With submit it goes to the configured review; reviewers decide in CRM. This never issues or records an invoice.',
    z.object({ operation_id: OperationId, deal_id: Uuid, amount: CrmDecimalStringSchema, currency: Currency, description: z.string().trim().min(1).max(2000),
      submit: z.boolean().default(true), request_id: Uuid.optional(), expected_version: z.number().int().min(1).optional() }).strict(),
    (input) => ({ kind: 'create_billing_request', operationId: input.operation_id, dealId: input.deal_id, amount: input.amount, currency: input.currency,
      description: input.description, submit: input.submit, ...(input.request_id ? { requestId: input.request_id, expectedVersion: input.expected_version } : {}) }) as CrmOperationsCommand, false) })
  const cancelCrmBillingRequest: Tool = buildTool({ name: 'cancelCrmBillingRequest', isReadOnly: false, ...command(
    'Cancel a billing request that has not been invoiced, with a reason.',
    z.object({ operation_id: OperationId, request_id: Uuid, expected_version: z.number().int().min(1), reason: Reason }).strict(),
    (input) => ({ kind: 'cancel_billing_request', operationId: input.operation_id, requestId: input.request_id, expectedVersion: input.expected_version, reason: input.reason }), false) })
  const recordCrmExternalInvoice: Tool = buildTool({ name: 'recordCrmExternalInvoice', isReadOnly: false, ...command(
    'Record an invoice that an external provider already issued (provider, remote id, number, issue date, total) with its allocations to engagements. An allocation naming a ready billing request closes it, once, for exactly its reviewed amount. Replaying the same provider and remote id returns the existing record. Needs the user\'s confirmation.',
    z.object({ operation_id: OperationId, account_id: Uuid, provider: Key, remote_id: z.string().trim().min(1).max(500), number: z.string().trim().min(1).max(128),
      issue_date: IsoDate, currency: Currency, total: CrmDecimalStringSchema,
      allocations: z.array(z.object({ deal_id: Uuid, amount: CrmDecimalStringSchema, billing_request_id: Uuid.optional() }).strict()).min(1).max(50) }).strict(),
    (input) => ({ kind: 'record_external_invoice', operationId: input.operation_id, accountId: input.account_id, provider: input.provider, remoteId: input.remote_id,
      number: input.number, issueDate: input.issue_date, currency: input.currency, total: input.total,
      allocations: input.allocations.map((allocation) => ({ dealId: allocation.deal_id, amount: allocation.amount, ...(allocation.billing_request_id ? { billingRequestId: allocation.billing_request_id } : {}) })) }), true) })
  const correctCrmExternalInvoiceReference: Tool = buildTool({ name: 'correctCrmExternalInvoiceReference', isReadOnly: false, ...command(
    'Correct a mistakenly recorded external invoice reference: fix its number and/or reopen billing requests that were wrongly closed by it. The external invoice record is never deleted or voided; the correction is audited. Needs the user\'s confirmation.',
    z.object({ operation_id: OperationId, invoice_id: Uuid, expected_version: z.number().int().min(1), number: z.string().trim().min(1).max(128).optional(),
      reopen_billing_request_ids: z.array(Uuid).max(50).default([]), reason: Reason }).strict(),
    (input) => ({ kind: 'correct_external_invoice_reference', operationId: input.operation_id, invoiceId: input.invoice_id, expectedVersion: input.expected_version,
      ...(input.number ? { number: input.number } : {}), reopenBillingRequestIds: input.reopen_billing_request_ids, reason: input.reason }), true) })

  return {
    listCrmChangeRequests, getCrmChangeRequest, listCrmEngagements, listCrmBillingRequests, getCrmBillingBalance, previewCrmRecurringSuccessors,
    saveCrmChangeRequest, submitCrmChangeRequest, withdrawCrmChangeRequest, updateCrmEngagementTracking, setCrmCommercialValues,
    commitCrmRecurringSuccessors, saveCrmBillingRequest, cancelCrmBillingRequest, recordCrmExternalInvoice, correctCrmExternalInvoiceReference,
  }
}
