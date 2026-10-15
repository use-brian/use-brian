import { describe, expect, it, vi } from 'vitest'
import {
  CrmCommercialFieldsSchema,
  CrmOperationVersionInputSchema,
  CrmOverrideNotPermittedError,
  createCrmCommercialContextTools,
  resolveCrmCommercialFields,
  type CrmCommercialContextReadPort,
  type CrmCommercialProfileSnapshot,
  type CrmOperationsServicePort,
  type ToolContext,
} from '../../index.js'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const USER_ID = '00000000-0000-4000-8000-000000000002'
const ACCOUNT_ID = '00000000-0000-4000-8000-000000000003'
const DEAL_ID = '00000000-0000-4000-8000-000000000004'

const bindings = CrmOperationVersionInputSchema.parse({
  instructions: 'Fixture procedure',
  fieldBindings: [
    { fieldKey: 'currency', label: 'Currency', type: 'currency', requiredFor: 'draft' },
    { fieldKey: 'rate', label: 'Rate', type: 'decimal', requiredFor: 'draft', protected: true, overridable: true },
    { fieldKey: 'po_number', label: 'Purchase order', type: 'string', requiredFor: 'issue', overridable: true },
    { fieldKey: 'notes', label: 'Notes', type: 'text' },
  ],
}).fieldBindings

const profile = (patch: Partial<CrmCommercialProfileSnapshot>): CrmCommercialProfileSnapshot => ({
  id: crypto.randomUUID(), ownerKind: 'account', ownerId: ACCOUNT_ID, agreementKey: null, dealIds: [], version: 1,
  effectiveFrom: null, effectiveTo: null, fields: {}, ...patch,
})
const resolve = (patch: Partial<Parameters<typeof resolveCrmCommercialFields>[0]>) => resolveCrmCommercialFields({
  operationKey: 'invoice', operationVersionId: 'version-1', bindings, businessDate: null, dealId: null,
  seller: null, account: null, agreements: [], transaction: {}, ...patch,
})

describe('[COMP:crm/commercial-context] deterministic field resolution and tools', () => {
  it('applies transaction, agreement, account and seller precedence with provenance', () => {
    const seller = profile({ ownerKind: 'seller', fields: { currency: { type: 'currency', value: 'HKD' }, rate: { type: 'decimal', value: '100' } } })
    const account = profile({ fields: { rate: { type: 'decimal', value: '120' } } })
    const agreement = profile({ ownerKind: 'agreement', agreementKey: 'a', dealIds: [DEAL_ID], effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30',
      fields: { rate: { type: 'decimal', value: '150' } } })
    const inside = resolve({ seller, account, agreements: [agreement], dealId: DEAL_ID, businessDate: '2026-02-01', transaction: { po_number: { type: 'string', value: 'PO-1' } } })
    expect(inside.fields.rate).toMatchObject({ value: '150', source: { kind: 'agreement', recordId: agreement.id } })
    expect(inside.fields.currency).toMatchObject({ value: 'HKD', source: { kind: 'seller' } })
    expect(inside.fields.po_number).toMatchObject({ value: 'PO-1', overridden: true })
    expect(inside).toMatchObject({ draftReady: true, issueReady: true })
    expect(resolve({ seller, account, agreements: [agreement], dealId: DEAL_ID, businessDate: '2026-07-01' }).fields.rate.value).toBe('120')
    expect(resolve({ seller, account, agreements: [agreement], dealId: null, businessDate: '2026-02-01' }).fields.rate.value).toBe('120')
    expect(resolve({ seller, account, agreements: [agreement], dealId: DEAL_ID }).fields.rate.value).toBe('120')
  })

  it('refuses non-overridable values, turns protected contradictions into review and conflicts into questions', () => {
    expect(() => resolve({ transaction: { currency: { type: 'currency', value: 'USD' } } })).toThrow(CrmOverrideNotPermittedError)
    expect(() => resolve({ transaction: { unknown_field: { type: 'string', value: 'x' } } })).toThrow(CrmOverrideNotPermittedError)
    const agreement = profile({ ownerKind: 'agreement', agreementKey: 'a', fields: { rate: { type: 'decimal', value: '150' } } })
    const reviewed = resolve({ agreements: [agreement], transaction: { rate: { type: 'decimal', value: '90' } } })
    expect(reviewed.fields.rate).toMatchObject({ value: '150', overridden: false })
    expect(reviewed.questions).toContainEqual(expect.objectContaining({ fieldKey: 'rate', kind: 'review_required' }))
    expect(resolve({ agreements: [agreement], transaction: { rate: { type: 'decimal', value: '150' } } }).fields.rate.overridden).toBe(true)
    const other = profile({ ownerKind: 'agreement', agreementKey: 'b', fields: { rate: { type: 'decimal', value: '140' } } })
    const conflicted = resolve({ agreements: [agreement, other] })
    expect(conflicted.questions).toContainEqual(expect.objectContaining({ fieldKey: 'rate', kind: 'conflict' }))
    expect(conflicted.draftReady).toBe(false)
    const same = profile({ ownerKind: 'agreement', agreementKey: 'c', fields: { rate: { type: 'decimal', value: '150' } } })
    expect(resolve({ agreements: [agreement, same] }).fields.rate.value).toBe('150')
  })

  it('keeps explicit null distinct from missing and never coerces types', () => {
    const account = profile({ fields: { po_number: { type: 'string', value: null }, currency: { type: 'string', value: 'HKD' } } })
    const receipt = resolve({ account })
    expect(receipt.fields.po_number).toMatchObject({ value: null, source: { kind: 'account' } })
    expect(receipt.fields.currency.value).toBeUndefined()
    expect(receipt.questions.map((question) => question.fieldKey)).toEqual(['currency', 'rate'])
    expect(CrmCommercialFieldsSchema.safeParse({ rate: { type: 'decimal', value: '1.1234567' } }).success).toBe(false)
    expect(CrmCommercialFieldsSchema.safeParse({ tax: { type: 'percent', value: '1.5' } }).success).toBe(false)
    expect(CrmCommercialFieldsSchema.safeParse({ total: { type: 'decimal', value: '=SUM(A1)' } }).success).toBe(false)
  })

  it('bounds operation versions and exposes no acceptance tool', async () => {
    expect(CrmOperationVersionInputSchema.safeParse({ instructions: 'x'.repeat(20_001), fieldBindings: bindings }).success).toBe(false)
    expect(CrmOperationVersionInputSchema.safeParse({ instructions: 'x', fieldBindings: Array.from({ length: 201 }, (_, index) => ({ fieldKey: `f${index}`, label: 'F', type: 'string' })) }).success).toBe(false)
    const reads = { resolve: vi.fn(async () => ({})) } as unknown as CrmCommercialContextReadPort
    const execute = vi.fn<CrmOperationsServicePort['execute']>(async (_ctx, command) => ({ command: command.kind, record: {}, created: true, duplicate: false, emittedEventIds: [] }))
    const tools = createCrmCommercialContextTools({ reads, service: { execute } })
    expect(Object.keys(tools)).not.toContain('acceptCrmOperationVersion')
    expect(tools.proposeCrmOperationVersion.requiresConfirmation).toBe(true)
    const context = { userId: USER_ID, assistantId: USER_ID, sessionId: USER_ID, appId: USER_ID, channelType: 'web', attended: true, channelId: 'c',
      workspaceId: WORKSPACE_ID, abortSignal: new AbortController().signal } as ToolContext
    await tools.resolveCrmCommercialFields.execute({ operation_key: 'invoice', account_id: ACCOUNT_ID }, context)
    expect(reads.resolve).toHaveBeenCalledWith(WORKSPACE_ID, { userId: USER_ID }, expect.objectContaining({ operationKey: 'invoice', accountId: ACCOUNT_ID }))
    expect(await tools.acceptCrmCommercialProfile.execute({ operation_id: crypto.randomUUID(), owner: { kind: 'account', account_id: ACCOUNT_ID },
      expected_current_version: 0, fields: {}, evidence: { kind: 'manual' } }, { ...context, activeCapabilities: new Set(['crm', 'home_app:crm:write']) }))
      .toMatchObject({ isError: true, data: { requiredCapability: 'configure' } })
    expect(execute).not.toHaveBeenCalled()
  })
})
