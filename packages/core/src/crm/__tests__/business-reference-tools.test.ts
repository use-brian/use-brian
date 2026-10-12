import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AssignCrmBusinessReferenceCommandSchema,
  CrmOperationsCommandSchema,
  CrmReferenceDefinitionInputSchema,
  assertCrmOperationsAuthority,
  createCrmBusinessReferenceTools,
  crmReferenceDefinitionIssues,
  crmReferencePartitionKey,
  explainCrmReferenceFormat,
  formatCrmBusinessReference,
  normalizeCrmBusinessReference,
  presentCrmBusinessReference,
  resolveCrmBusinessDate,
  type CrmOperationsContext,
  type CrmOperationsServicePort,
  type CrmReferenceReadPort,
  type ToolContext,
} from '../../index.js'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const USER_ID = '00000000-0000-4000-8000-000000000002'
const ASSISTANT_ID = '00000000-0000-4000-8000-000000000003'
const SESSION_ID = '00000000-0000-4000-8000-000000000004'
const COMPANY_ID = '00000000-0000-4000-8000-000000000005'
const OPERATION_ID = '00000000-0000-4000-8000-000000000006'

function context(patch: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: USER_ID, assistantId: ASSISTANT_ID, sessionId: SESSION_ID, appId: ASSISTANT_ID,
    channelType: 'web', attended: true, channelId: 'channel-1', workspaceId: WORKSPACE_ID,
    abortSignal: new AbortController().signal, ...patch,
  }
}

const reads: CrmReferenceReadPort = {
  listDefinitions: vi.fn(async () => ({ schemaVersion: 1 as const, definitions: [] })),
  preview: vi.fn(async () => ({ reserves: false })),
  lookup: vi.fn(async () => ({ schemaVersion: 1 as const, references: [], nextCursor: null })),
  history: vi.fn(async () => null),
}
const execute = vi.fn<CrmOperationsServicePort['execute']>(async (_ctx, command) => ({
  command: command.kind, record: {}, created: true, duplicate: false, emittedEventIds: [],
}))
const tools = createCrmBusinessReferenceTools({ reads, service: { execute } })
beforeEach(() => vi.clearAllMocks())

const customer = CrmReferenceDefinitionInputSchema.parse({
  definitionKey: 'customer', label: 'Customer', targetKinds: ['company'], assignmentMode: 'native', namespaceKey: 'customers',
  format: [{ kind: 'literal', text: 'C-' }, { kind: 'counter', width: 5 }],
})

describe('[COMP:crm/business-reference-tools] reference contract and tools', () => {
  it('normalizes presentation and namespace keys deterministically', () => {
    expect(presentCrmBusinessReference('  ＩＮＶ－2026\t 000123 ')).toBe('INV-2026 000123')
    expect(normalizeCrmBusinessReference('INV-2026-000123')).toBe(normalizeCrmBusinessReference(' inv-2026-000123 '))
    expect(AssignCrmBusinessReferenceCommandSchema.safeParse({ kind: 'assign_business_reference', operationId: OPERATION_ID,
      definitionKey: 'customer', target: { kind: 'company', id: COMPANY_ID }, value: 'bad\u0007value' }).success).toBe(false)
  })

  it('formats the closed AST and masks the counter in previews', () => {
    const date = resolveCrmBusinessDate('2026-03-04', 'UTC')
    const format = [{ kind: 'parent', definitionKey: 'customer' }, { kind: 'literal', text: '-' }, { kind: 'category' },
      { kind: 'literal', text: '-' }, { kind: 'date', part: 'yyyy' }, { kind: 'literal', text: '-' }, { kind: 'counter', width: 3 }] as const
    expect(formatCrmBusinessReference([...format], { counter: 3, businessDate: date, parentValue: 'C-00042', categoryCode: 'ADVISORY' }))
      .toBe('C-00042-ADVISORY-2026-003')
    expect(() => formatCrmBusinessReference([{ kind: 'counter', width: 2 }], { counter: 100 })).toThrow(/outgrown/)
    expect(() => formatCrmBusinessReference([...format], { counter: 1, parentValue: 'C-1', categoryCode: 'X' })).toThrow(/business date/)
    expect(explainCrmReferenceFormat([...format], { businessDate: date, parentValue: 'C-00042', categoryCode: 'AUDIT' }).maskedExample)
      .toBe('C-00042-AUDIT-2026-###')
  })

  it('derives the business date in the definition timezone and never from the host clock', () => {
    expect(resolveCrmBusinessDate('2025-12-31T17:30:00Z', 'Asia/Hong_Kong')).toMatchObject({ date: '2026-01-01', year: 2026 })
    expect(resolveCrmBusinessDate('2025-12-31T17:30:00Z', 'UTC')).toMatchObject({ date: '2025-12-31', year: 2025 })
    expect(() => resolveCrmBusinessDate('2026-02-30', 'UTC')).toThrow()
    expect(crmReferencePartitionKey(['service_category', 'business_year'], { businessDate: resolveCrmBusinessDate('2026-01-01', 'UTC'), categoryKey: 'audit' }))
      .toBe('year=2026|category=audit')
    expect(crmReferencePartitionKey([], {})).toBe('all')
    expect(() => crmReferencePartitionKey(['parent_target'], {})).toThrow(/parent/)
  })

  it('rejects inadmissible definitions without inventing defaults', () => {
    expect(crmReferenceDefinitionIssues(customer)).toEqual([])
    expect(crmReferenceDefinitionIssues({ ...customer, format: [{ kind: 'literal', text: 'C-' }] })).toEqual([{ path: 'format', message: expect.stringContaining('exactly one counter') }])
    expect(crmReferenceDefinitionIssues({ ...customer, format: [{ kind: 'parent', definitionKey: 'other' }, { kind: 'counter', width: 3 }] }))
      .toContainEqual({ path: 'format', message: expect.stringContaining('parent') })
    expect(crmReferenceDefinitionIssues({ ...customer, partitionDimensions: ['service_category'] }))
      .toContainEqual({ path: 'categories', message: expect.stringContaining('category catalog') })
    expect(CrmReferenceDefinitionInputSchema.safeParse({ ...customer, timezone: 'Mars/Olympus' }).success).toBe(false)
    expect(CrmReferenceDefinitionInputSchema.safeParse({ ...customer, format: [{ kind: 'expression', text: '1+1' }] }).success).toBe(false)
  })

  it('routes reference commands through the closed union and configuration authority', () => {
    const save = CrmOperationsCommandSchema.parse({ kind: 'save_reference_definition', operationId: OPERATION_ID, definition: customer })
    const member: CrmOperationsContext = { workspaceId: WORKSPACE_ID, actor: { kind: 'user', userId: USER_ID },
      authority: { role: 'member', canWrite: true, canConfigure: false, trustedIdentitySources: [] } }
    expect(() => assertCrmOperationsAuthority(member, save)).toThrow(/owner or admin/)
    const assign = CrmOperationsCommandSchema.parse({ kind: 'assign_business_reference', operationId: OPERATION_ID, definitionKey: 'customer', target: { kind: 'company', id: COMPANY_ID } })
    expect(() => assertCrmOperationsAuthority(member, assign)).not.toThrow()
    const integration: CrmOperationsContext = { ...member, actor: { kind: 'integration_key', credentialId: OPERATION_ID },
      authority: { ...member.authority, role: 'system', integration: { credentialId: OPERATION_ID, grants: [{ operation: 'crm.records.write', selectors: {} }] } } }
    expect(() => assertCrmOperationsAuthority(integration, assign)).toThrow(/crm.references.write/)
  })

  it('submits assignment with the assistant actor and stable operation id', async () => {
    const result = await tools.assignCrmReference.execute({ operation_id: OPERATION_ID, definition_key: 'customer', target_kind: 'company', target_id: COMPANY_ID },
      context({ activeCapabilities: new Set(['crm', 'home_app:crm:write']) }))
    expect(result.isError).toBeUndefined()
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ actor: { kind: 'assistant', assistantId: ASSISTANT_ID, userId: USER_ID, sessionId: SESSION_ID } }),
      expect.objectContaining({ kind: 'assign_business_reference', operationId: OPERATION_ID, target: { kind: 'company', id: COMPANY_ID } }))
  })

  it('gates configuration tools on the configure capability and the user confirmation', async () => {
    expect(tools.saveCrmReferenceDefinition.requiresConfirmation).toBe(true)
    expect(tools.assignCrmReference.requiresConfirmation).toBe(false)
    const input = { operation_id: OPERATION_ID, definition: customer }
    expect(await tools.saveCrmReferenceDefinition.execute(input, context({ activeCapabilities: new Set(['crm', 'home_app:crm:write']) })))
      .toMatchObject({ isError: true, data: { error: 'not_authorized', requiredCapability: 'configure' } })
    expect(execute).not.toHaveBeenCalled()
    await tools.saveCrmReferenceDefinition.execute(input, context({ activeCapabilities: new Set(['configure', 'crm', 'home_app:crm:write']) }))
    expect(execute.mock.calls[0]![0].authority.canConfigure).toBe(true)
  })

  it('reads through the scoped read port with the acting user and never reserves on preview', async () => {
    await tools.previewCrmReference.execute({ definition_key: 'customer' }, context())
    expect(reads.preview).toHaveBeenCalledWith(WORKSPACE_ID, { userId: USER_ID }, expect.objectContaining({ definitionKey: 'customer' }))
    await tools.findCrmReference.execute({ code: 'C-00042' }, context())
    expect(reads.lookup).toHaveBeenCalledWith(WORKSPACE_ID, { userId: USER_ID }, expect.objectContaining({ q: 'C-00042', match: 'exact', includeFormer: true }))
    expect(execute).not.toHaveBeenCalled()
    expect(await tools.findCrmReference.execute({ code: 'x' }, context({ workspaceId: undefined }))).toMatchObject({ isError: true })
  })
})
