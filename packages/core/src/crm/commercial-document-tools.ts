/**
 * Brian and Brain-MCP tools for commercial document preparation and invoice
 * issue. Each submits the same typed command as the CRM UI and REST adapters;
 * issue, retry and void need configure authority and the user's confirmation.
 * Spec: docs/architecture/features/crm-commercial-operations.md -> Invoice preparation
 *
 * [COMP:crm/invoice-preparation]
 */

import { z } from 'zod'
import { buildTool, type Tool, type ToolContext, type ToolInput } from '../tools/types.js'
import { missingToolCapability } from '../tools/capability-gate.js'
import { crmOperationsToolContext, crmOperationsToolFailure } from './operations-tools.js'
import type { CrmOperationsCommand, CrmOperationsServicePort } from './operations-types.js'
import { CrmCommercialFieldsSchema, CrmDecimalStringSchema, type CrmCommercialFields } from './commercial-context.js'
import { CrmInvoiceListQuerySchema, type CrmCommercialDocumentReadPort } from './invoice-preparation.js'

const Uuid = z.string().uuid()
const Key = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{0,62}$/)
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const OperationId = Uuid.describe('Stable operation id. Reuse the SAME id when retrying an uncertain result; never invent a new one to retry.')
const Lines = z.array(z.object({ description: z.string().trim().min(1).max(500), quantity: CrmDecimalStringSchema, unit_price: CrmDecimalStringSchema,
  deal_id: Uuid.nullable().default(null) }).strict()).max(30).default([])
const Content = {
  deal_ids: z.array(Uuid).max(50).default([]),
  service_period_start: IsoDate.nullable().default(null),
  service_period_end: IsoDate.nullable().default(null),
  lines: Lines,
  values: CrmCommercialFieldsSchema.default({}).describe('Only values the user explicitly gave for fields the operation lets a transaction set.'),
  allocations: z.array(z.object({ deal_id: Uuid, amount: CrmDecimalStringSchema }).strict()).max(50).default([]),
}
type ContentInput = { deal_ids: string[]; service_period_start: string | null; service_period_end: string | null
  lines: Array<{ description: string; quantity: string; unit_price: string; deal_id: string | null }>; values: CrmCommercialFields; allocations: Array<{ deal_id: string; amount: string }> }
const content = (input: ContentInput) => ({ dealIds: input.deal_ids, servicePeriodStart: input.service_period_start, servicePeriodEnd: input.service_period_end,
  lines: input.lines.map((line) => ({ description: line.description, quantity: line.quantity, unitPrice: line.unit_price, dealId: line.deal_id })),
  values: input.values, allocations: input.allocations.map((allocation) => ({ dealId: allocation.deal_id, amount: allocation.amount })) })

export type CrmCommercialDocumentTools = {
  getCrmPreparation: Tool
  listCrmInvoices: Tool
  prepareCrmInvoice: Tool
  reviseCrmPreparation: Tool
  markCrmPreparationReady: Tool
  issueCrmInvoice: Tool
  retryCrmInvoiceIssue: Tool
  voidCrmInvoice: Tool
}

function notScoped() {
  return { isError: true as const, data: 'Commercial documents require a workspace-scoped assistant or programmatic credential.' }
}

export function createCrmCommercialDocumentTools(options: { reads: CrmCommercialDocumentReadPort; service: CrmOperationsServicePort }): CrmCommercialDocumentTools {
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
    toCommand: (input: z.infer<Input>) => CrmOperationsCommand, issuing: boolean): Omit<ToolInput<Input>, 'name' | 'isReadOnly'> {
    const gate = { requiresCapability: issuing ? 'configure' : 'crm', homeAppToolSet: { app: 'crm', set: 'write' } } as const
    return {
      description, inputSchema, ...gate, requiresConfirmation: issuing,
      async execute(input, context) {
        const missing = missingToolCapability(gate as unknown as Tool, context.activeCapabilities)
        if (missing) return { isError: true, data: { error: 'not_authorized', requiredCapability: missing } }
        const caller = crmOperationsToolContext(context)
        if (!caller) return notScoped()
        try {
          return { data: await options.service.execute(issuing ? { ...caller, authority: { ...caller.authority, canConfigure: true } } : caller, toCommand(inputSchema.parse(input))) }
        } catch (error) { return crmOperationsToolFailure(error) }
      },
    }
  }

  const getCrmPreparation: Tool = buildTool({ name: 'getCrmPreparation', isReadOnly: true, ...read(
    'Read a commercial preparation: its current version, every resolved field with its source, decimal totals, open questions, the Office draft link, and the invoice state, number and issue attempts. Ask the user the listed questions; never answer them yourself.',
    z.object({ preparation_id: Uuid }).strict(),
    async (workspaceId, viewer, input) => (await options.reads.getPreparation(workspaceId, viewer, input.preparation_id)) ?? { error: 'not_found', message: 'The preparation is unavailable in your current scope.' }) })
  const listCrmInvoices: Tool = buildTool({ name: 'listCrmInvoices', isReadOnly: true, ...read(
    'List invoices visible in your current scope (state, number, issue date, totals, release references), filtered by account, deal, state or exact number. Issued is not sent and neither is paid. Follow nextCursor until null.',
    CrmInvoiceListQuerySchema.omit({ cursor: true }).extend({ cursor: z.string().min(1).max(4096).optional() }),
    (workspaceId, viewer, input) => options.reads.listInvoices(workspaceId, viewer, input)) })
  const prepareCrmInvoice: Tool = buildTool({ name: 'prepareCrmInvoice', isReadOnly: false, ...command(
    'Prepare an invoice for one customer account with the accepted invoice operation: authorized deals, service period and line items (decimal strings). Fields resolve deterministically from accepted terms; the result lists any missing facts as questions. When draft facts are complete an editable Office draft is created without an invoice number or issue date. This never issues, numbers or sends anything.',
    z.object({ operation_id: OperationId, operation_key: Key, account_id: Uuid, title: z.string().trim().min(1).max(300).optional(), ...Content }).strict(),
    (input) => ({ kind: 'prepare_commercial_document', operationId: input.operation_id, operationKey: input.operation_key, accountId: input.account_id,
      title: input.title, ...content(input) }), false) })
  const reviseCrmPreparation: Tool = buildTool({ name: 'reviseCrmPreparation', isReadOnly: false, ...command(
    'Store a new complete version of a preparation (all deals, lines, values and allocations, not a patch) with its expected_version. The Office draft\'s bound cells are rewritten; other edits in the workbook survive. A revision after review returns the preparation to draft.',
    z.object({ operation_id: OperationId, preparation_id: Uuid, expected_version: z.number().int().min(1), ...Content }).strict(),
    (input) => ({ kind: 'revise_commercial_preparation', operationId: input.operation_id, preparationId: input.preparation_id,
      expectedVersion: input.expected_version, ...content(input) }), false) })
  const markCrmPreparationReady: Tool = buildTool({ name: 'markCrmPreparationReady', isReadOnly: false, ...command(
    'Mark the exact reviewed version of a preparation ready for issue after the user has reviewed its Office draft. Under an exact-version review policy a workspace owner or admin other than the version author must do this in CRM.',
    z.object({ operation_id: OperationId, preparation_id: Uuid, expected_version: z.number().int().min(1) }).strict(),
    (input) => ({ kind: 'mark_preparation_ready', operationId: input.operation_id, preparationId: input.preparation_id, expectedVersion: input.expected_version }), false) })
  const issueCrmInvoice: Tool = buildTool({ name: 'issueCrmInvoice', isReadOnly: false, ...command(
    'Issue a ready invoice: allocate its official number through the configured numbering, fix the explicit issue date, freeze the commercial payload and release the workbook and invoice PDF through Office. Requires configure authority, the reviewed expected_version, an issue_date the user gave, and the user\'s confirmation. Issued does not mean sent or paid. If rendering fails the number stays and retryCrmInvoiceIssue resumes it.',
    z.object({ operation_id: OperationId, preparation_id: Uuid, expected_version: z.number().int().min(1), issue_date: IsoDate }).strict(),
    (input) => ({ kind: 'issue_invoice', operationId: input.operation_id, preparationId: input.preparation_id, expectedVersion: input.expected_version,
      issueDate: input.issue_date }), true) })
  const retryCrmInvoiceIssue: Tool = buildTool({ name: 'retryCrmInvoiceIssue', isReadOnly: false, ...command(
    'Retry rendering and release of an invoice whose issue failed, with the same number and frozen payload. Read the invoice first; never retry an invoice that is still issuing. Requires configure authority and the user\'s confirmation.',
    z.object({ operation_id: OperationId, invoice_id: Uuid, expected_version: z.number().int().min(1) }).strict(),
    (input) => ({ kind: 'retry_invoice_issue', operationId: input.operation_id, invoiceId: input.invoice_id, expectedVersion: input.expected_version }), true) })
  const voidCrmInvoice: Tool = buildTool({ name: 'voidCrmInvoice', isReadOnly: false, ...command(
    'Void an issued invoice with a reason. Its identity, number and payload are kept; this is not a credit note or refund. Requires configure authority and the user\'s confirmation.',
    z.object({ operation_id: OperationId, invoice_id: Uuid, expected_version: z.number().int().min(1), reason: z.string().trim().min(1).max(2000) }).strict(),
    (input) => ({ kind: 'void_invoice', operationId: input.operation_id, invoiceId: input.invoice_id, expectedVersion: input.expected_version, reason: input.reason }), true) })

  return { getCrmPreparation, listCrmInvoices, prepareCrmInvoice, reviseCrmPreparation, markCrmPreparationReady, issueCrmInvoice, retryCrmInvoiceIssue, voidCrmInvoice }
}
