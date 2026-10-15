/**
 * Invoice preparation contracts: the closed invoice field vocabulary, the
 * staged Office template binding, preparation and issue commands, and the
 * deterministic preparation payload.
 * Spec: docs/architecture/features/crm-commercial-operations.md -> Invoice preparation
 *
 * [COMP:crm/invoice-preparation]
 */

import { z } from 'zod'
import { CrmCommercialFieldsSchema, CrmDecimalStringSchema } from './commercial-context.js'
import { CRM_INVOICE_MAX_LINES } from './invoice-template-map.js'

const Uuid = z.string().uuid()
const StableKey = z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{0,62}$/)
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const CrmInvoiceLineInputSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: CrmDecimalStringSchema,
  unitPrice: CrmDecimalStringSchema,
  dealId: Uuid.nullable().default(null),
}).strict()

const PreparationContent = {
  dealIds: z.array(Uuid).max(50).default([]),
  servicePeriodStart: IsoDate.nullable().default(null),
  servicePeriodEnd: IsoDate.nullable().default(null),
  lines: z.array(CrmInvoiceLineInputSchema).max(CRM_INVOICE_MAX_LINES).default([]),
  values: CrmCommercialFieldsSchema.default({}),
  /** Per-deal amounts; naming a ready billing request closes it at issue, once, for exactly its reviewed amount. */
  allocations: z.array(z.object({ dealId: Uuid, amount: CrmDecimalStringSchema, billingRequestId: Uuid.optional() }).strict()).max(50).default([]),
}

export const PrepareCrmCommercialDocumentCommandSchema = z.object({
  kind: z.literal('prepare_commercial_document'),
  operationId: Uuid,
  operationKey: StableKey,
  accountId: Uuid,
  title: z.string().trim().min(1).max(300).optional(),
  ...PreparationContent,
}).strict()

export const ReviseCrmCommercialPreparationCommandSchema = z.object({
  kind: z.literal('revise_commercial_preparation'),
  operationId: Uuid,
  preparationId: Uuid,
  expectedVersion: z.number().int().min(1),
  ...PreparationContent,
}).strict()

export const MarkCrmPreparationReadyCommandSchema = z.object({
  kind: z.literal('mark_preparation_ready'),
  operationId: Uuid,
  preparationId: Uuid,
  expectedVersion: z.number().int().min(1),
}).strict()

export const IssueCrmInvoiceCommandSchema = z.object({
  kind: z.literal('issue_invoice'),
  operationId: Uuid,
  preparationId: Uuid,
  expectedVersion: z.number().int().min(1),
  issueDate: IsoDate,
  value: z.string().trim().min(1).max(128).optional(),
  external: z.object({ provider: StableKey, remoteId: z.string().trim().min(1).max(500) }).strict().optional(),
}).strict()

export const RetryCrmInvoiceIssueCommandSchema = z.object({
  kind: z.literal('retry_invoice_issue'),
  operationId: Uuid,
  invoiceId: Uuid,
  expectedVersion: z.number().int().min(1),
}).strict()

export const VoidCrmInvoiceCommandSchema = z.object({
  kind: z.literal('void_invoice'),
  operationId: Uuid,
  invoiceId: Uuid,
  expectedVersion: z.number().int().min(1),
  reason: z.string().trim().min(1).max(2000),
}).strict()

export const CRM_COMMERCIAL_DOCUMENT_COMMAND_KINDS = [
  'prepare_commercial_document', 'revise_commercial_preparation', 'mark_preparation_ready',
  'issue_invoice', 'retry_invoice_issue', 'void_invoice',
] as const

export const CrmCommercialDocumentCommandSchema = z.union([
  PrepareCrmCommercialDocumentCommandSchema,
  ReviseCrmCommercialPreparationCommandSchema,
  MarkCrmPreparationReadyCommandSchema,
  IssueCrmInvoiceCommandSchema,
  RetryCrmInvoiceIssueCommandSchema,
  VoidCrmInvoiceCommandSchema,
])
export type CrmCommercialDocumentCommand = z.infer<typeof CrmCommercialDocumentCommandSchema>

export function isCrmCommercialDocumentCommand(command: { kind: string }): command is CrmCommercialDocumentCommand {
  return (CRM_COMMERCIAL_DOCUMENT_COMMAND_KINDS as readonly string[]).includes(command.kind)
}

export const CRM_INVOICE_STATES = ['draft', 'ready', 'issue_pending', 'issue_failed', 'issued', 'voided'] as const
export type CrmInvoiceState = typeof CRM_INVOICE_STATES[number]

export const CrmInvoiceListQuerySchema = z.object({
  accountId: Uuid.optional(),
  dealId: Uuid.optional(),
  state: z.enum(CRM_INVOICE_STATES).optional(),
  number: z.string().trim().min(1).max(128).optional(),
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict()
export type CrmInvoiceListQuery = z.infer<typeof CrmInvoiceListQuerySchema>

export type CrmDocumentViewer = { userId: string }

export type CrmCommercialDocumentReadPort = {
  getPreparation(workspaceId: string, viewer: CrmDocumentViewer, preparationId: string): Promise<Record<string, unknown> | null>
  listInvoices(workspaceId: string, viewer: CrmDocumentViewer, query: CrmInvoiceListQuery): Promise<{ schemaVersion: 1; invoices: Array<Record<string, unknown>>; nextCursor: string | null }>
  getInvoice(workspaceId: string, viewer: CrmDocumentViewer, invoiceId: string): Promise<Record<string, unknown> | null>
}
