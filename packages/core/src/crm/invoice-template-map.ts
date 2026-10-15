/**
 * The staged Office template map for invoice preparation: template tokens to
 * a closed vocabulary of invoice paths, plus reconciliation cells.
 * Spec: docs/architecture/features/crm-commercial-operations.md -> Invoice preparation
 *
 * [COMP:crm/invoice-preparation]
 */

import { z } from 'zod'

const Token = z.string().regex(/^[A-Z][A-Z0-9_]{0,62}$/)
export const CRM_INVOICE_MAX_LINES = 30

/** Invoice values the specialization provides. Line slots are 1-based. No arbitrary paths. */
const SYSTEM_PATHS = [
  'invoice.number', 'invoice.issue_date', 'invoice.currency', 'invoice.service_period_start', 'invoice.service_period_end',
  'invoice.subtotal', 'invoice.tax_rate', 'invoice.tax_amount', 'invoice.total',
  'seller.legal_name', 'seller.display_name', 'buyer.name', 'buyer.account_label', 'buyer.billing_address',
] as const
export const CrmInvoiceFieldPathSchema = z.union([
  z.enum(SYSTEM_PATHS),
  z.string().regex(/^line\.([1-9]|[12][0-9]|30)\.(description|quantity|unit_price|amount)$/),
  z.string().regex(/^field\.[a-z][a-z0-9_]{0,62}$/),
])
export type CrmInvoiceFieldPath = z.infer<typeof CrmInvoiceFieldPathSchema>

/** Tokens the draft leaves to issue. The draft shows a bracketed marker the invoice PDF preflight rejects. */
export const CRM_INVOICE_ISSUE_PATHS = ['invoice.number', 'invoice.issue_date'] as const

export const CrmInvoiceTemplateMapSchema = z.object({
  tokens: z.record(Token, CrmInvoiceFieldPathSchema).refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 300, '1 to 300 tokens'),
  reconcile: z.array(z.object({
    path: z.union([z.enum(['invoice.subtotal', 'invoice.tax_amount', 'invoice.total']), z.string().regex(/^line\.([1-9]|[12][0-9]|30)\.amount$/)]),
    cell: z.string().regex(/^[^!]{1,31}![A-Z]{1,3}[1-9][0-9]{0,6}$/),
  }).strict()).max(40).default([]),
  sheetName: z.string().trim().min(1).max(31).default('Invoice'),
  printArea: z.string().regex(/^[A-Z]{1,3}[1-9][0-9]{0,6}:[A-Z]{1,3}[1-9][0-9]{0,6}$/).default('A1:H48'),
  minorUnits: z.number().int().min(0).max(4).nullable().default(null),
}).strict().refine((value) => {
  const paths = Object.values(value.tokens)
  return CRM_INVOICE_ISSUE_PATHS.every((path) => paths.includes(path))
}, 'The template map must place the invoice number and issue date')
export type CrmInvoiceTemplateMap = z.infer<typeof CrmInvoiceTemplateMapSchema>

