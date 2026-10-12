import { describe, expect, it, vi } from 'vitest'
import {
  CrmChangeSetSchema,
  CrmOperationsCommandSchema,
  CrmReviewPolicySchema,
  DEFAULT_CRM_REVIEW_POLICIES,
  commandRequiresConfigurationAuthority,
  createCrmGovernedRecordTools,
  isCrmGovernedCommand,
  type CrmGovernedReadPort,
  type CrmOperationsServicePort,
  type ToolContext,
} from '../../index.js'

const UUID = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'

describe('[COMP:crm/governed-records] governed change, engagement and billing contracts', () => {
  it('keeps the review vocabulary finite and finance steps billing-only', () => {
    expect(CrmReviewPolicySchema.safeParse({ mode: 'quorum' }).success).toBe(false)
    expect(CrmReviewPolicySchema.safeParse({ mode: 'single_review', financeDepartmentId: UUID }).success).toBe(false)
    expect(CrmReviewPolicySchema.parse({ mode: 'reviewer_then_finance', financeDepartmentId: UUID })).toMatchObject({ directRoles: ['owner', 'admin'], allowSelfReview: false })
    expect(DEFAULT_CRM_REVIEW_POLICIES.billing_request).toMatchObject({ mode: 'single_review', directRoles: [] })
  })

  it('bounds change sets to canonical fields and never carries fees', () => {
    expect(CrmChangeSetSchema.safeParse({ engagement: { confirmedFee: '1' } }).success).toBe(false)
    expect(CrmChangeSetSchema.safeParse({ amount: 10 }).success).toBe(false)
    expect(CrmChangeSetSchema.parse({ name: 'Example', engagement: { workStatus: 'Fieldwork' } })).toMatchObject({ engagement: { workStatus: 'fieldwork' }, assignReferences: [] })
  })

  it('routes governed commands through the closed union with explicit configuration authority', () => {
    const save = CrmOperationsCommandSchema.parse({ kind: 'save_governance_policy', operationId: UUID, subject: 'client_change', expectedVersion: 0, policy: { mode: 'direct' } })
    expect(isCrmGovernedCommand(save)).toBe(true)
    expect(commandRequiresConfigurationAuthority(save)).toBe(true)
    const tracking = CrmOperationsCommandSchema.parse({ kind: 'update_engagement_tracking', operationId: UUID, dealId: UUID, expectedVersion: 0, tracking: { workStatus: 'fieldwork' } })
    expect(commandRequiresConfigurationAuthority(tracking)).toBe(false)
    expect(CrmOperationsCommandSchema.safeParse({ kind: 'decide_change_request', operationId: UUID, requestId: UUID, expectedRevision: 1, decision: 'reject' }).success).toBe(false)
    expect(CrmOperationsCommandSchema.safeParse({ kind: 'create_billing_request', operationId: UUID, dealId: UUID, amount: '1', currency: 'HKD', description: 'x', requestId: UUID }).success).toBe(false)
  })

  it('maps tools to the same commands, gates consequential ones on confirmation and exposes no review or policy tool', async () => {
    const execute = vi.fn(async (_context: unknown, _command: unknown) => ({ command: 'save_change_request' as const, record: {}, created: true, duplicate: false, emittedEventIds: [] }))
    const service: CrmOperationsServicePort = { execute }
    const reads = { listChangeRequests: vi.fn(), getChangeRequest: vi.fn(async () => null), listEngagements: vi.fn(), listBillingRequests: vi.fn(),
      billingBalance: vi.fn(async () => ({})), previewRecurringSuccessors: vi.fn(), listCatalogs: vi.fn() } as unknown as CrmGovernedReadPort
    const tools = createCrmGovernedRecordTools({ reads, service })
    expect(Object.keys(tools).some((name) => /decide|policy|catalog/i.test(name))).toBe(false)
    expect(tools.setCrmCommercialValues.requiresConfirmation).toBe(true)
    expect(tools.recordCrmExternalInvoice.requiresConfirmation).toBe(true)
    expect(tools.commitCrmRecurringSuccessors.requiresConfirmation).toBe(true)
    expect(tools.saveCrmChangeRequest.requiresConfirmation).toBe(false)
    const context = { userId: UUID, assistantId: UUID, sessionId: UUID, appId: UUID, channelType: 'web', attended: true, channelId: 'c', workspaceId: UUID,
      abortSignal: new AbortController().signal, activeCapabilities: new Set(['crm', 'home_app:crm:write']) } as ToolContext
    await tools.saveCrmChangeRequest.execute({ operation_id: UUID, target_kind: 'deal', target_id: OTHER,
      changes: { engagement: { service_category: 'audit', participant_ids: [UUID] }, assign_references: [{ definition_key: 'job-code' }] } }, context)
    expect(execute.mock.calls[0]![1]).toEqual({ kind: 'save_change_request', operationId: UUID, target: { kind: 'deal', id: OTHER },
      changes: { engagement: { serviceCategory: 'audit', participantIds: [UUID] }, assignReferences: [{ definitionKey: 'job-code' }] } })
    await tools.recordCrmExternalInvoice.execute({ operation_id: UUID, account_id: UUID, provider: 'example-ledger', remote_id: 'R-1', number: 'EXT-1', issue_date: '2026-01-02',
      currency: 'HKD', total: '10', allocations: [{ deal_id: OTHER, amount: '10', billing_request_id: UUID }] }, context)
    expect(execute.mock.calls[1]![1]).toMatchObject({ kind: 'record_external_invoice', allocations: [{ dealId: OTHER, amount: '10', billingRequestId: UUID }] })
    await tools.getCrmBillingBalance.execute({ deal_id: OTHER }, context)
    expect(reads.billingBalance).toHaveBeenCalledWith(UUID, { userId: UUID }, { dealId: OTHER })
    expect(await tools.getCrmChangeRequest.execute({ request_id: UUID }, context)).toMatchObject({ data: { error: 'not_found' } })
  })
})
