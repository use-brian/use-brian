import { describe, expect, it, vi } from 'vitest'
import {
  CrmDecimalError,
  CrmInvoiceTemplateMapSchema,
  CrmOperationsCommandSchema,
  computeCrmInvoiceTotals,
  createCrmCommercialDocumentTools,
  crmCurrencyMinorUnits,
  crmDecimalAdd,
  crmDecimalMultiply,
  crmDecimalRound,
  crmReferenceDefinitionIssues,
  CrmReferenceDefinitionInputSchema,
  type CrmCommercialDocumentReadPort,
  type CrmOperationsServicePort,
  type ToolContext,
} from '../../index.js'

const UUID = '00000000-0000-4000-8000-000000000001'

describe('[COMP:crm/invoice-preparation] decimal money, template map and document tools', () => {
  it('rounds half away from zero exactly, never through floating point', () => {
    expect(crmDecimalRound('2.345', 2)).toBe('2.35')
    expect(crmDecimalRound('-2.345', 2)).toBe('-2.35')
    expect(crmDecimalRound('2.344999', 2)).toBe('2.34')
    expect(crmDecimalMultiply('1.005', '1000', 2)).toBe('1005.00')
    expect(crmDecimalAdd('0.1', '0.2', 2)).toBe('0.30')
    expect(crmDecimalMultiply('1.5', '333.333333', 2)).toBe('500.00')
    expect(crmDecimalRound('12.5', 0)).toBe('13')
  })

  it('computes line, subtotal and invoice-level tax with currency minor units', () => {
    const totals = computeCrmInvoiceTotals({ currency: 'HKD', taxRate: '0.075', lines: [
      { description: 'A', quantity: '2', unitPrice: '1250.005' }, { description: 'B', quantity: '1.5', unitPrice: '333.333333' }] })
    expect(totals).toMatchObject({ minorUnits: 2, subtotal: '3000.01', taxAmount: '225.00', total: '3225.01' })
    expect(totals.lines.map((line) => line.amount)).toEqual(['2500.01', '500.00'])
    expect(computeCrmInvoiceTotals({ currency: 'JPY', taxRate: '0.1', lines: [{ description: 'Y', quantity: '3', unitPrice: '333.5' }] }))
      .toMatchObject({ subtotal: '1001', taxAmount: '100', total: '1101' })
    expect(computeCrmInvoiceTotals({ currency: 'KWD', taxRate: '0', lines: [{ description: 'K', quantity: '1', unitPrice: '1.2345' }] }).total).toBe('1.235')
    expect(() => computeCrmInvoiceTotals({ currency: 'XTS', taxRate: '0', lines: [{ description: 'X', quantity: '1', unitPrice: '1' }] })).toThrow(CrmDecimalError)
    expect(crmCurrencyMinorUnits('XTS', 2)).toBe(2)
    expect(() => computeCrmInvoiceTotals({ currency: 'USD', taxRate: '1.5', lines: [{ description: 'X', quantity: '1', unitPrice: '1' }] })).toThrow(/fraction/)
    expect(() => computeCrmInvoiceTotals({ currency: 'USD', taxRate: '0', lines: [{ description: 'X', quantity: '1.1234567', unitPrice: '1' }] })).toThrow(/six/)
    expect(() => computeCrmInvoiceTotals({ currency: 'USD', taxRate: '0', lines: [] })).toThrow(/at least one line/)
  })

  it('accepts only the closed invoice path vocabulary and requires the issue-time tokens', () => {
    const map = { tokens: { INVOICE_NUMBER: 'invoice.number', ISSUE_DATE: 'invoice.issue_date', DESC: 'line.1.description', TERMS: 'field.payment_terms' } }
    expect(CrmInvoiceTemplateMapSchema.safeParse(map).success).toBe(true)
    expect(CrmInvoiceTemplateMapSchema.safeParse({ tokens: { ...map.tokens, X: 'buyer.attributes.secret' } }).success).toBe(false)
    expect(CrmInvoiceTemplateMapSchema.safeParse({ tokens: { ...map.tokens, X: 'line.31.description' } }).success).toBe(false)
    expect(CrmInvoiceTemplateMapSchema.safeParse({ tokens: { DESC: 'line.1.description' } }).success).toBe(false)
  })

  it('restricts invoice numbering to issue-time definitions', () => {
    const base = { definitionKey: 'invoice', label: 'Invoice', namespaceKey: 'invoices', assignmentMode: 'native', format: [{ kind: 'literal', text: 'INV-' }, { kind: 'counter', width: 6 }] }
    expect(crmReferenceDefinitionIssues(CrmReferenceDefinitionInputSchema.parse({ ...base, targetKinds: ['invoice'], assignmentEvent: 'issue' }))).toEqual([])
    expect(crmReferenceDefinitionIssues(CrmReferenceDefinitionInputSchema.parse({ ...base, targetKinds: ['invoice'], assignmentEvent: 'explicit' })).length).toBeGreaterThan(0)
    expect(crmReferenceDefinitionIssues(CrmReferenceDefinitionInputSchema.parse({ ...base, targetKinds: ['invoice', 'deal'], assignmentEvent: 'issue' })).length).toBeGreaterThan(0)
    expect(crmReferenceDefinitionIssues(CrmReferenceDefinitionInputSchema.parse({ ...base, targetKinds: ['deal'], assignmentEvent: 'issue' })).length).toBeGreaterThan(0)
  })

  it('submits typed document commands and gates issue on configure plus confirmation', async () => {
    const execute = vi.fn<CrmOperationsServicePort['execute']>(async (_ctx, command) => ({ command: command.kind, record: {}, created: true, duplicate: false, emittedEventIds: [] }))
    const tools = createCrmCommercialDocumentTools({ reads: {} as CrmCommercialDocumentReadPort, service: { execute } })
    const context = { userId: UUID, assistantId: UUID, sessionId: UUID, appId: UUID, channelType: 'web', attended: true, channelId: 'c', workspaceId: UUID,
      abortSignal: new AbortController().signal, activeCapabilities: new Set(['crm', 'home_app:crm:write']) } as ToolContext
    await tools.prepareCrmInvoice.execute({ operation_id: UUID, operation_key: 'invoice', account_id: UUID, lines: [{ description: 'X', quantity: '1', unit_price: '10.50' }] }, context)
    expect(execute.mock.calls[0]![1]).toMatchObject({ kind: 'prepare_commercial_document', lines: [{ description: 'X', quantity: '1', unitPrice: '10.50', dealId: null }] })
    expect(CrmOperationsCommandSchema.safeParse(execute.mock.calls[0]![1]).success).toBe(true)
    expect(tools.issueCrmInvoice.requiresConfirmation).toBe(true)
    expect(await tools.issueCrmInvoice.execute({ operation_id: UUID, preparation_id: UUID, expected_version: 1, issue_date: '2026-01-02' }, context))
      .toMatchObject({ isError: true, data: { requiredCapability: 'configure' } })
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
