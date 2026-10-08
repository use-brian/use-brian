import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCrmOperationsTools, createCrmCredentialTools, createExecutionContext, executionToolContext,
  type CrmOperationsContext,
  type CrmOperationsReadPort,
  type CrmOperationsServicePort,
  type ToolContext,
} from '../../index.js'

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const USER_ID = '00000000-0000-4000-8000-000000000002'
const ASSISTANT_ID = '00000000-0000-4000-8000-000000000003'
const SESSION_ID = '00000000-0000-4000-8000-000000000004'
const CONTACT_ID = '00000000-0000-4000-8000-000000000005'
const CREDENTIAL_ID = '00000000-0000-4000-8000-000000000006'

function context(patch: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: USER_ID,
    assistantId: ASSISTANT_ID,
    sessionId: SESSION_ID,
    appId: ASSISTANT_ID,
    channelType: 'web',
    channelId: 'channel-1',
    workspaceId: WORKSPACE_ID,
    abortSignal: new AbortController().signal,
    ...patch,
  }
}

const reads: CrmOperationsReadPort = {
  listIntakeDefinitions: vi.fn(async () => ({ definitions: [{ definitionKey: 'website_contact' }], nextCursor: null })),
  listSubmissions: vi.fn(async () => ({ submissions: [{ id: 'submission-1' }], nextCursor: null })),
  getSubmission: vi.fn(async () => ({ id: 'submission-1' })),
  listConsentPurposes: vi.fn(async () => ({ purposes: [{ purposeKey: 'marketing' }], nextCursor: null })),
  getConsent: vi.fn(async () => ({ purposes: [], events: [], suppressions: [] })),
  checkSendability: vi.fn(async () => ({
    verdict: 'unknown' as const,
    reasons: ['consent_not_recorded' as const],
    effectiveSuppressionEventIds: [],
  })),
  listSegments: vi.fn(async () => ({ segments: [], catalog: [], nextCursor: null })),
  getSegment: vi.fn(async () => null),
  previewSegment: vi.fn(async () => ({ rows: [], count: 0, snapshotIds: [], nextCursor: null, snapshotNextCursor: null })),
  listEntitlementPlans: vi.fn(async () => ({ plans: [{ id: 'plan-1', planKey: 'member' }], nextCursor: null })),
  listEntitlements: vi.fn(async () => ({ entitlements: [{ id: 'entitlement-1', contactId: CONTACT_ID }], nextCursor: null })),
  listEvents: vi.fn(async () => ({ events: [{ id: 'event-1', slug: 'annual-meeting' }], nextCursor: null })),
  listParticipation: vi.fn(async () => ({ participation: [{ id: 'participation-1', contactId: CONTACT_ID }], nextCursor: null })),
  listPipelines: vi.fn(async () => ({ pipelines: [{ id: 'pipeline-1', stages: [{ id: 'stage-1' }] }], nextCursor: null })),
}
const execute = vi.fn<CrmOperationsServicePort['execute']>(async (_ctx, command) => ({
  command: command.kind,
  record: { id: 'record-1' },
  created: true,
  duplicate: false,
  emittedEventIds: [],
}))
const tools = createCrmOperationsTools({ reads, service: { execute } })

beforeEach(() => vi.clearAllMocks())

describe('[COMP:crm/operations-tools] canonical CRM operation tools', () => {
  it('registers the closed CRM operations surface under the CRM capability', () => {
    expect(Object.keys(tools)).toEqual([
      'listCrmIntakeDefinitions', 'listCrmSubmissions', 'getCrmSubmission',
      'listCrmConsentPurposes', 'getCrmConsent', 'checkCrmSendability',
      'listCrmSegments', 'previewCrmSegment',
      'listCrmEntitlementPlans', 'listCrmEntitlements',
      'listCrmEvents', 'listCrmParticipation',
      'listCrmPipelines',
      'recordCrmSubmission', 'updateCrmSubmission', 'recordCrmConsent',
      'recordCrmSuppression', 'saveCrmSegment', 'archiveCrmSegment',
      'grantCrmEntitlement', 'updateCrmEntitlement',
      'recordCrmParticipation', 'updateCrmParticipation',
      'setDealPipelineStage',
      'saveCrmEntitlementPlan', 'saveCrmEvent', 'sendCrmMessage', 'getCrmDelivery',
    ])
    expect(Object.values(tools).filter(tool => !['saveCrmEntitlementPlan', 'saveCrmEvent'].includes(tool.name)).every((tool) => tool.requiresCapability === 'crm')).toBe(true)
    expect(tools.listCrmSubmissions.isReadOnly).toBe(true)
    expect(tools.updateCrmSubmission.isReadOnly).toBe(false)
  })

  it('requires configure plus CRM write grants for generic catalog saves without Association', async () => {
    const plan = { key: 'fictional-member', name: 'Example Membership', currency: 'USD', feeMinor: 0, billingPeriod: 'manual' }
    const required = ['configure', 'crm', 'home_app:crm:write']
    for (const missing of required) {
      expect(await tools.saveCrmEntitlementPlan.execute({ plan }, context({ activeCapabilities: new Set(required.filter(cap => cap !== missing)) })))
        .toMatchObject({ isError: true, data: { error: 'not_authorized', requiredCapability: missing } })
    }
    expect(execute).not.toHaveBeenCalled()
    await tools.saveCrmEntitlementPlan.execute({ plan }, context({ activeCapabilities: new Set(required) }))
    expect(execute.mock.calls[0]?.[0]).toMatchObject({ actor: { kind: 'assistant', assistantId: ASSISTANT_ID }, authority: { role: 'member', canConfigure: true } })
    expect(execute.mock.calls[0]?.[1]).toMatchObject({ kind: 'save_entitlement_plan', key: 'fictional-member' })
    await tools.saveCrmEvent.execute({ event: { slug: 'example-meeting', title: 'Example Meeting', startsAt: '2026-10-01T10:00:00Z',
      endsAt: '2026-10-01T11:00:00Z', timezone: 'UTC', mode: 'venue' } }, context({ activeCapabilities: new Set(required) }))
    expect(execute.mock.calls[1]?.[1]).toMatchObject({ kind: 'save_event', slug: 'example-meeting' })
  })

  it('passes bounded read filters to the workspace-scoped read port', async () => {
    const output = await tools.listCrmSubmissions.execute({
      status: 'new', definition_key: 'website_contact', limit: 20,
    }, context())
    expect(output.isError).toBeFalsy()
    expect(reads.listSubmissions).toHaveBeenCalledWith(WORKSPACE_ID, {
      status: 'new', definitionKey: 'website_contact', ownerUserId: undefined, limit: 20,
      cursor: undefined, createdAfter: undefined, createdBefore: undefined,
    }, { kind: 'assistant', assistantId: ASSISTANT_ID, userId: USER_ID, sessionId: SESSION_ID })
  })

  it('forwards effective access filters while keeping the returned raw lifecycle status', async () => {
    vi.mocked(reads.listEntitlements).mockResolvedValueOnce({ entitlements: [{ status: 'active', isEffective: false }], nextCursor: null })
    const result = await tools.listCrmEntitlements.execute({ active_only: true, effective_at: '2026-01-01T00:00:00Z' }, context())
    expect(reads.listEntitlements).toHaveBeenCalledWith(WORKSPACE_ID, expect.objectContaining({ activeOnly: true, effectiveAt: '2026-01-01T00:00:00Z' }), { kind: 'assistant', assistantId: ASSISTANT_ID, userId: USER_ID, sessionId: SESSION_ID })
    expect(result.data).toEqual({ entitlements: [{ status: 'active', isEffective: false }], nextCursor: null })
  })

  it('derives the assistant actor and authority instead of accepting them as input', async () => {
    await tools.updateCrmSubmission.execute({
      submission_id: CONTACT_ID,
      status: 'in_progress',
    }, context())
    const [serviceContext, command] = execute.mock.calls[0] as [CrmOperationsContext, Record<string, unknown>]
    expect(serviceContext).toMatchObject({
      workspaceId: WORKSPACE_ID,
      actor: { kind: 'assistant', assistantId: ASSISTANT_ID, userId: USER_ID, sessionId: SESSION_ID },
      authority: { canWrite: true, canConfigure: false },
    })
    expect(command).toMatchObject({ kind: 'update_submission', submissionId: CONTACT_ID, status: 'in_progress' })
    expect(command).not.toHaveProperty('workspaceId')
    expect(command).not.toHaveProperty('actor')
  })

  it('exposes a named page and forwards the cursor and time window without widening the query', async () => {
    vi.mocked(reads.listEvents).mockResolvedValueOnce({ events: [{ id: 'fixture-event' }], nextCursor: 'next-page' })
    const output = await tools.listCrmEvents.execute({ cursor: 'previous-page', limit: 17,
      status: 'published', created_after: '2026-01-01T00:00:00Z' }, context())
    expect(output.data).toEqual({ events: [{ id: 'fixture-event' }], nextCursor: 'next-page' })
    expect(reads.listEvents).toHaveBeenCalledWith(WORKSPACE_ID, { cursor: 'previous-page', limit: 17,
      status: 'published', createdAfter: '2026-01-01T00:00:00Z', createdBefore: undefined })
  })

  it('preserves the authenticated Brain credential family in service audit context', async () => {
    await tools.recordCrmConsent.execute({
      contact_id: CONTACT_ID,
      purpose_key: 'marketing',
      action: 'granted',
      source: 'brain_mcp',
      locale: 'ja',
      metadata: {},
    }, context({
      channelType: 'programmatic',
      channelId: CREDENTIAL_ID,
      programmaticPrincipal: {
        kind: 'oauth_token', credentialId: CREDENTIAL_ID, userId: USER_ID,
      },
    }))
    expect(execute.mock.calls[0]?.[1]).toMatchObject({ kind: 'record_consent', locale: 'ja' })
    expect(execute.mock.calls[0]?.[0].actor).toEqual({
      kind: 'oauth_token', credentialId: CREDENTIAL_ID, userId: USER_ID,
    })
  })

  it('confirmation-gates withdrawal and suppression release without gating safer inverses', async () => {
    await expect(tools.recordCrmConsent.resolveConfirmation!(context(), {
      contact_id: CONTACT_ID, purpose_key: 'marketing', action: 'withdrawn', source: 'manual', metadata: {},
    })).resolves.toBe(true)
    await expect(tools.recordCrmConsent.resolveConfirmation!(context(), {
      contact_id: CONTACT_ID, purpose_key: 'marketing', action: 'granted', source: 'manual', metadata: {},
    })).resolves.toBe(false)
    await expect(tools.recordCrmSuppression.resolveConfirmation!(context(), {
      contact_id: CONTACT_ID, channel: 'email', action: 'released', reason_code: 'manual_do_not_contact', source: 'manual', metadata: {},
    })).resolves.toBe(true)
    await expect(tools.updateCrmEntitlement.resolveConfirmation!(context(), {
      entitlement_id: CONTACT_ID, status: 'cancelled',
    })).resolves.toBe(true)
  })

  it('preserves assistant and programmatic principals for participation discovery', async () => {
    const input = { limit: 10 }
    await tools.listCrmParticipation.execute(input, context())
    expect(reads.listParticipation).toHaveBeenLastCalledWith(WORKSPACE_ID, expect.objectContaining({ limit: 10 }),
      { kind: 'assistant', assistantId: ASSISTANT_ID, userId: USER_ID, sessionId: SESSION_ID })
    await tools.listCrmParticipation.execute(input, context({ programmaticPrincipal: { kind: 'brain_key', credentialId: CREDENTIAL_ID } }))
    expect(reads.listParticipation).toHaveBeenLastCalledWith(WORKSPACE_ID, expect.any(Object),
      { kind: 'brain_key', credentialId: CREDENTIAL_ID })
  })

  it('uses stable generic ids and excludes commerce fields from participation writes', async () => {
    await tools.recordCrmParticipation.execute({
      contact_id: CONTACT_ID,
      event_id: '00000000-0000-4000-8000-000000000007',
      source_kind: 'workflow',
      source_id: 'run-1',
      attendee_name: 'Example Person',
      metadata: {},
    }, context())
    expect(execute).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      kind: 'record_participation', contactId: CONTACT_ID,
      sourceKind: 'workflow', sourceId: 'run-1',
    }))
    const invalid = tools.recordCrmParticipation.inputSchema.safeParse({
      contact_id: CONTACT_ID,
      event_id: '00000000-0000-4000-8000-000000000007',
      source_kind: 'commerce',
      source_id: 'order-line-1',
      attendee_name: 'Example Person',
      ticket_id: '00000000-0000-4000-8000-000000000008',
      metadata: {},
    })
    expect(invalid.success).toBe(false)
  })

  it('enumerates custom stages and moves deals only by catalog ids', async () => {
    await tools.listCrmPipelines.execute({ entity_kind: 'deal', include_archived: false }, context())
    expect(reads.listPipelines).toHaveBeenCalledWith(WORKSPACE_ID, {
      entityKind: 'deal', includeArchived: false, limit: undefined,
      cursor: undefined, createdAfter: undefined, createdBefore: undefined,
    })
    const stageId = '00000000-0000-4000-8000-000000000007'
    const pipelineId = '00000000-0000-4000-8000-000000000008'
    await tools.setDealPipelineStage.execute({
      deal_id: CONTACT_ID, pipeline_id: pipelineId, stage_id: stageId,
    }, context())
    expect(execute).toHaveBeenLastCalledWith(expect.anything(), {
      kind: 'set_deal_pipeline_stage', dealId: CONTACT_ID,
      pipelineId, stageId,
    })
  })

  it('preserves a typed scope refusal with recovery instead of leaking source errors', async () => {
    execute.mockRejectedValueOnce(Object.assign(new Error('Hidden source details'), { code: 'scope_operation_denied' }))
    const result = await tools.setDealPipelineStage.execute({ deal_id: CONTACT_ID,
      pipeline_id: '00000000-0000-4000-8000-000000000007', stage_id: '00000000-0000-4000-8000-000000000008' }, context())
    expect(result).toEqual({ isError: true, data: {
      error: 'scope_operation_denied', message: expect.stringContaining('administrator'),
    } })
    expect(JSON.stringify(result)).not.toContain('Hidden source')
  })
})


describe('[COMP:crm/operations-tools] Managed delivery adapters',()=>{
  const input={deliveryId:'88888888-8888-4888-8888-888888888888',connectorInstanceId:'99999999-9999-4999-8999-999999999999',purposeKey:'updates',to:['person@example.com'],subject:'Fixture',body:'Fixture'}
  it('keeps native authority out of the schema and preserves the original principal and turn ceiling',async()=>{
    expect(tools.sendCrmMessage.requiresConfirmation).toBe(true)
    expect(tools.sendCrmMessage.inputSchema.safeParse({...input,nativeDelivery:{assistantId:CONTACT_ID}}).success).toBe(false)
    const ctx=context({activeCapabilities:new Set(['crm','home_app:crm:write']),compartments:['team:product'],mutationCompartments:[],projectIds:[],programmaticPrincipal:{kind:'brain_key',credentialId:CONTACT_ID}})
    await tools.sendCrmMessage.execute(input,ctx)
    expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({actor:{kind:'brain_key',credentialId:CONTACT_ID},authority:expect.objectContaining({nativeDelivery:{assistantId:ctx.assistantId,compartments:['team:product'],mutationCompartments:[],projectIds:[]}})}),expect.objectContaining({...input,kind:'send_message',cc:[],bcc:[]}))
  })
  it('pins the trusted execution department and visibility ceiling into native delivery context',async()=>{
    const department='00000000-0000-4000-8000-000000000007'
    const execution=createExecutionContext({
      identity:{kind:'attended',principal:{kind:'workspace_member',userId:USER_ID}},
      ownership:{kind:'workspace',workspaceId:WORKSPACE_ID},
      access:{workspaceId:WORKSPACE_ID,userId:USER_ID,assistantId:ASSISTANT_ID,assistantKind:'standard',
        clearance:'internal',compartments:null,mutationCompartments:null,projectIds:[],visibilityAssistantIds:[ASSISTANT_ID],
        departmentRead:{workspaceId:WORKSPACE_ID,userId:USER_ID,assistantId:ASSISTANT_ID,base:'public',
          departments:{[department]:'internal'},contextDepartment:department,binding:[department],cap:'internal'}},
      writeDefaults:{compartments:[],projectIds:[]},
      authority:{assertCurrent:async()=>{},execute:async operation=>operation()},
      lifecycle:{sessionId:SESSION_ID,channelType:'web',channelId:'fixture',abortSignal:new AbortController().signal},
    })
    const ctx=context({...executionToolContext(execution,{appId:'fixture'}),activeCapabilities:new Set(['crm','home_app:crm:write'])})
    await tools.sendCrmMessage.execute(input,ctx)
    const saved=execute.mock.calls[0][0].authority.nativeDelivery!.authoringAuthority!
    expect(saved.ceiling.departmentRead).toEqual(execution.security.ceiling.departmentRead)
    expect(saved.ceiling.projectIds).toEqual([])
    expect(saved.ceiling.visibilityAssistantIds).toEqual([ASSISTANT_ID])
  })
  it('refuses a revoked CRM child grant on direct invocation before the command',async()=>{
    expect(await tools.sendCrmMessage.execute(input,context({activeCapabilities:new Set(['crm'])}))).toMatchObject({isError:true,data:{error:'not_authorized'}})
    expect(execute).not.toHaveBeenCalled()
  })
  it('uses the original id for receipt inspection and does not dispatch',async()=>{
    const get=vi.fn(async()=>null)
    const receiptTools=createCrmOperationsTools({reads,service:{execute},deliveries:{get,send:vi.fn()}})
    expect(await receiptTools.getCrmDelivery.execute({deliveryId:input.deliveryId},context({activeCapabilities:new Set(['crm','home_app:crm:read'])}))).toMatchObject({data:{receipt:null}})
    expect(get).toHaveBeenCalledWith(expect.anything(),input.deliveryId)
    expect(execute).not.toHaveBeenCalled()
  })
})


describe('[COMP:crm/operations-tools] credential lifecycle tools', () => {
  const preview = vi.fn(async () => ({ choices: [], validForMs: 30000 }))
  const create = vi.fn(async () => ({ id: CREDENTIAL_ID, oneTimeSecret: 'fictional-once-only' }))
  const list = vi.fn(async () => ({ credentials: [], nextCursor: null }))
  const revoke = vi.fn(async () => ({ revoked: true }))
  const native = createCrmCredentialTools({ preview, create, list, revoke })
  const capabilities = ['configure', 'crm', 'home_app:crm:write']
  const attended = () => context({ assistantKind: 'primary', clearance: 'internal', compartments: null,
    mutationCompartments: null, projectIds: [], visibilityAssistantIds: null, activeCapabilities: new Set(capabilities) })
  const request = { requestId: CONTACT_ID, label: 'Fictional reader', expiresAt: '2099-01-01T00:00:00Z',
    grants: [{ operation: 'crm.records.read', selectors: {} }], departmentBinding: { departmentIds: [], cap: 'internal' } }
  it('requires every capability and trusted attended authoring before calling the port', async () => {
    for (const missing of capabilities) {
      expect(await native.createCrmCredential.execute(request, { ...attended(), activeCapabilities: new Set(capabilities.filter(cap => cap !== missing)) }))
        .toMatchObject({ isError: true, data: { error: 'not_authorized' } })
    }
    for (const ctx of [context({ activeCapabilities: new Set(capabilities) }),
      { ...attended(), channelType: 'workflow' as const },
      { ...attended(), programmaticPrincipal: { kind: 'brain_key' as const, credentialId: CREDENTIAL_ID } }]) {
      expect(await native.createCrmCredential.execute(request, ctx)).toMatchObject({ isError: true, data: { error: 'not_authorized' } })
    }
    expect(create).not.toHaveBeenCalled()
  })
  it('keeps model input separate from pinned authority and requires a stable issuance identity', async () => {
    expect(await native.createCrmCredential.execute({ ...request, requestId: undefined }, attended())).toMatchObject({ isError: true, data: { error: 'invalid_input' } })
    expect(await native.createCrmCredential.execute({ ...request, authoringAuthority: {} }, attended())).toMatchObject({ isError: true, data: { error: 'invalid_input' } })
    expect(await native.createCrmCredential.execute(request, attended())).toMatchObject({ data: { id: CREDENTIAL_ID, oneTimeSecret: 'fictional-once-only' } })
    expect(create).toHaveBeenCalledWith(request, expect.objectContaining({ assistantId: ASSISTANT_ID,
      ceiling: expect.objectContaining({ workspaceId: WORKSPACE_ID, userId: USER_ID, projectIds: [] }) }), undefined)
    await native.previewCrmCredentialBindings.execute({}, attended())
    await native.listCrmCredentials.execute({}, attended())
    await native.revokeCrmCredential.execute({ credentialId: CREDENTIAL_ID }, attended())
    expect(preview).toHaveBeenCalledOnce(); expect(list).toHaveBeenCalledOnce(); expect(revoke).toHaveBeenCalledOnce()
  })
})
