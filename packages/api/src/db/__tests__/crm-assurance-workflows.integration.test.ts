import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { advanceWorkflowRun, createCrmOperationsTools, createCrmTools, createTaskTools, CrmOperationsCommandSchema, WorkflowDefinitionSchema,
  type CrmOperationsContext, type ExecutorDeps, type Tool, type ToolContext } from '@use-brian/core'
import { getPool, getAppPool } from '../client.js'
import { createDbWorkflowStore, createDbWorkflowRunStore } from '../workflow-store.js'
import { createPendingApprovalsStore } from '../pending-approvals-store.js'
import { createWorkspaceAuditStore } from '../workspace-audit-store.js'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createDbCrmIntakeReadStore } from '../crm-intake-store.js'
import { createDbCrmStore } from '../crm-store.js'
import { createDbTaskStore } from '../tasks-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createCrmDeliveryService } from '../../crm-operations/delivery-service.js'
import { withCrmMailAdmission } from '../../crm-operations/delivery-policy.js'
import { makeRequestApproval, resumeFromApproval, type ApprovalBridgeDeps } from '../../workflow/approval.js'
import { _resetCoalescerForTests } from '../../brain-stream/notify.js'
import { captureAuthoringAuthoritySystem, resolveWorkflowRunScope } from '../../context-scope/workflow-authority.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const recipes = JSON.parse(readFileSync(new URL('../../../../../scripts/crm/fixtures/association-workflows.json', import.meta.url), 'utf8')).recipes
const pool = getPool(), appPool = getAppPool()
const workflowStore = createDbWorkflowStore(), runStore = createDbWorkflowRunStore()

async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), assistantId = randomUUID(), contactId = randomUUID(), connectorInstanceId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Workflow acceptance',$2)", [workspaceId, userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId])
  await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind) VALUES($1,$2,$3,'Fixture assistant','primary')", [assistantId, workspaceId, userId])
  await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,canonical_id,created_by_user_id,source) VALUES($1,$2,'person','Fictional Member','member@example.com',$3,'manual')", [contactId, workspaceId, userId])
  const capabilities = ['crm', 'home_app:crm:read', 'home_app:crm:write', 'tasks', 'home_app:tasks:read', 'home_app:tasks:write']
  for (const capability of capabilities) await pool.query('INSERT INTO assistant_capabilities(assistant_id,capability,granted_by_user_id) VALUES($1,$2,$3)', [assistantId, capability, userId])
  await pool.query("INSERT INTO connector_instance(id,scope,workspace_id,provider,label,connected,connected_email,credentials) VALUES($1,'workspace',$2,'gmail','Fixture mailbox',true,'sender@example.com',$3)", [connectorInstanceId, workspaceId, Buffer.alloc(1)])
  await pool.query("INSERT INTO assistant_connector_grants(assistant_id,connector_id,allowed_actions,granted_by_user_id) VALUES($1,'gmail',ARRAY['gmailSendMessage'],$2)", [assistantId, userId])
  const send = vi.fn(async () => ({ id: 'fictional-accepted' }))
  const deliveries = createCrmDeliveryService(async (_admission, value) => ({
    send: scope => withCrmMailAdmission(scope, 'gmail', { to: value.to, cc: value.cc, bcc: value.bcc, crmPurposeKey: value.purposeKey }, send),
    receipt: () => ({ evidence: 'provider_accepted', messageId: 'fictional-accepted' }),
  }))
  const service = createCrmOperationsService(createDbCrmOperationsStore(), { deliveries }), reads = createDbCrmIntakeReadStore()
  const owner: CrmOperationsContext = { workspaceId, actor: { kind: 'user', userId }, authority: { role: 'owner', canWrite: true, canConfigure: true, trustedIdentitySources: [] } }
  const command = (input: unknown) => service.execute(owner, CrmOperationsCommandSchema.parse(input))
  for (const purposeKey of ['operator_notice', 'member_updates']) {
    await command({ kind: 'save_consent_purpose', purposeKey, label: 'Fixture purpose', wordingVersion: '1', wording: 'Fixture consent', applicableChannels: ['email'] })
    await command({ kind: 'record_consent', contactId, purposeKey, action: 'granted', source: 'fixture' })
  }
  await command({ kind: 'save_managed_mailbox_policy', connectorInstanceId, providerKey: 'outreach', expectedVersion: 0, confirmed: true, managed: true, purposeKeys: ['operator_notice', 'member_updates'] })
  const native = { ...createCrmOperationsTools({ service, reads, deliveries }), ...createCrmTools(createDbCrmStore()), ...createTaskTools(createDbTaskStore()) }
  // The fixture registry supplies the grants that the real bootstrap wrapper
  // resolves. Canonical stores still revalidate persisted write authority.
  const registry = new Map<string, Tool>(Object.entries(native).map(([name, tool]) => [name, { ...tool,
    execute: (input: unknown, context: ToolContext) => tool.execute(input, { ...context, activeCapabilities: new Set(capabilities) }),
  }]))
  const context: ToolContext = { workspaceId, userId, assistantId, sessionId: randomUUID(), appId: 'fixture', channelType: 'workflow', channelId: 'fixture', abortSignal: new AbortController().signal, activeCapabilities: new Set(capabilities) }
  const consult = vi.fn<ExecutorDeps['consultTransport']['send']>(async () => { throw new Error('Unexpected model call') })
  const channel = vi.fn<NonNullable<ExecutorDeps['deliverToChannel']>>(async p => ({ status: 'delivered', channelType: p.channelType, channelId: p.channelId, messageId: 'fixture-message' }))
  const deps: ExecutorDeps = { workflowStore, runStore, resolvePrimary: async () => assistantId, resolveRunScope: resolveWorkflowRunScope, buildToolRegistry: async () => registry, consultTransport: { send: consult }, deliverToChannel: channel }
  const bridge: ApprovalBridgeDeps = { approvalsStore: createPendingApprovalsStore(), auditStore: createWorkspaceAuditStore(), workflowStore, runStore,
    resolvePrimary: deps.resolvePrimary, buildToolRegistry: deps.buildToolRegistry, executorDeps: deps, deliveries: async () => {} }
  deps.requestApproval = makeRequestApproval(bridge)
  async function start(key: string, input?: Record<string, unknown>, edit?: (value: any) => void) {
    const recipe = structuredClone(recipes.find((r: any) => r.key === key))
    for (const step of recipe.definition.steps) if (step.toolName === 'sendCrmMessage') {
      step.arguments.connectorInstanceId = connectorInstanceId
      if (key === 'submission_notification') step.arguments.to = ['member@example.com']
    }
    edit?.(recipe)
    const authoringAuthority = await captureAuthoringAuthoritySystem({userId,workspaceId,assistantId})
    const workflow = await workflowStore.create({ userId, workspaceId, name: recipe.name, definition: WorkflowDefinitionSchema.parse(recipe.definition),authoringAuthority })
    const run = await runStore.createRun({ workflowId: workflow.id, workspaceId, triggeredBy: userId, triggerKind: 'manual', input: input ?? recipe.sampleInput })
    const outcome = await advanceWorkflowRun(deps, run.id)
    expect(outcome.kind, JSON.stringify(outcome)).not.toBe('failed')
    return { run, outcome }
  }
  async function approve(runId: string, expectFailure = false) {
    const rows = await pool.query("SELECT id FROM pending_approvals WHERE workflow_run_id=$1 AND status='pending'", [runId])
    expect(rows.rows).toHaveLength(1)
    await resumeFromApproval(bridge, rows.rows[0].id, 'approved', userId)
    const run = await runStore.getRunSystem(runId)
    if (run?.status === 'failed' && !expectFailure) throw new Error(JSON.stringify(run.error))
    return run
  }
  return { workspaceId, userId, contactId, connectorInstanceId, command, start, approve, send, deps, registry, context, consult, channel }
}

describe('[COMP:crm/assurance-workflows] Complete recipes through the durable workflow engine', () => {
  afterAll(async () => { _resetCoalescerForTests(); await pool.end(); await appPool.end() })
  it('pauses notification for approval, resumes once and records a single managed receipt and timeline entry', async () => {
    const f = await fixture(), deliveryId = randomUUID()
    const { run, outcome } = await f.start('submission_notification', { event: { domainEventId: deliveryId, submissionId: randomUUID() } })
    expect(outcome).toMatchObject({ kind: 'paused', reason: 'approval' }); expect(f.send).not.toHaveBeenCalled()
    expect(await f.approve(run.id)).toMatchObject({ status: 'completed' })
    await advanceWorkflowRun(f.deps, run.id)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect((await pool.query('SELECT status FROM crm_delivery_receipts WHERE workspace_id=$1 AND delivery_id=$2', [f.workspaceId, deliveryId])).rows).toEqual([{ status: 'sent' }])
    expect((await pool.query("SELECT id FROM association_audit_log WHERE workspace_id=$1 AND action='crm.delivery.accepted'", [f.workspaceId])).rows).toHaveLength(1)
  })
  it('converts registration through the typed command and preserves stable source replay across separate runs', async () => {
    const f = await fixture()
    const event = (await f.command({ kind: 'save_event', slug: 'fictional-event', title: 'Fictional Event', startsAt: '2099-01-01T10:00:00Z', endsAt: '2099-01-01T11:00:00Z', timezone: 'UTC', mode: 'venue', status: 'published' })).record
    const input = { contactId: f.contactId, eventId: event.id, registrationSourceId: 'fictional-registration', attendeeName: 'Fictional Member' }
    for (let i = 0; i < 2; i++) expect((await f.start('event_registration', input)).outcome).toMatchObject({ kind: 'completed' })
    expect((await pool.query('SELECT id FROM association_registrations WHERE workspace_id=$1', [f.workspaceId])).rows).toHaveLength(1)
  })
  it('creates the attributed onboarding task only for effective membership and stops after expiry', async () => {
    const f = await fixture()
    const plan = (await f.command({ kind: 'save_entitlement_plan', key: 'member', name: 'Member', currency: 'USD', feeMinor: 0, billingPeriod: 'manual' })).record
    const membership = (await f.command({ kind: 'grant_entitlement', contactId: f.contactId, planId: plan.id, idempotencyKey: 'fixture-member', status: 'active', startsAt: '2020-01-01T00:00:00Z' })).record
    const input = { event: { contactId: f.contactId, planId: plan.id, entitlementId: membership.id, status: 'active' } }
    const first = await f.start('membership_onboarding', input)
    expect(first.outcome).toMatchObject({ kind: 'completed' })
    const tasks = await pool.query('SELECT title,attributes,source_session_id FROM tasks WHERE workspace_id=$1', [f.workspaceId])
    expect(tasks.rows).toEqual([expect.objectContaining({ title: 'Welcome Fictional Member', source_session_id: null, attributes: expect.objectContaining({ crm_contact_id: f.contactId, crm_entitlement_id: membership.id }) })])
    await f.command({ kind: 'update_entitlement', entitlementId: membership.id, status: 'expired' })
    const next = await f.start('membership_onboarding', input)
    expect(next.outcome).toMatchObject({ kind: 'completed' })
    expect((await runStore.listStepRuns(f.userId, next.run.id)).map(s => s.stepId)).toEqual(['effective', 'eligible'])
    expect((await pool.query('SELECT id FROM tasks WHERE workspace_id=$1', [f.workspaceId])).rows).toHaveLength(1)
  })
  it('executes the digest with paginated real segment inputs and a fake consult/channel, without mutation tools', async () => {
    const f = await fixture(), segmentId = randomUUID()
    await pool.query("INSERT INTO entities(workspace_id,kind,display_name,created_by_user_id,source) SELECT $1,'deal','Fictional deal '||n,$2,'manual' FROM generate_series(1,105) n", [f.workspaceId, f.userId])
    await pool.query("INSERT INTO crm_segments(id,workspace_id,segment_key,name,entity_kind,predicate) VALUES($1,$2,'deals','Fictional deals','deal',$3)", [segmentId, f.workspaceId, JSON.stringify({ type: 'group', combinator: 'and', items: [{ type: 'rule', family: 'base', field: 'name', operator: 'contains', value: 'Fictional' }] })])
    const ids: string[] = []
    f.consult.mockImplementation(async request => {
      expect(request.allowedTools).toEqual(['listCrmSegments', 'previewCrmSegment'])
      expect(JSON.stringify(request)).toContain(segmentId)
      let cursor: string | undefined
      do {
        const tool = f.registry.get('previewCrmSegment')!
        const result = await tool.execute(tool.inputSchema.parse({ segment_id: segmentId, limit: 40, cursor }), f.context)
        expect(result.isError, JSON.stringify(result.data)).not.toBe(true)
        const page = result.data as { rows: Array<{ id: string }>; nextCursor: string | null }
        ids.push(...page.rows.map(row => row.id)); cursor = page.nextCursor ?? undefined
      } while (cursor)
      return { task: { taskId: randomUUID(), contextId: randomUUID(), status: { state: 'completed', timestamp: new Date().toISOString() }, artifacts: [], history: [{ messageId: randomUUID(), role: 'agent', parts: [{ kind: 'text', text: `Reviewed ${ids.length} fictional deals.` }] }] } }
    })
    expect((await f.start('weekly_deal_digest', {}, recipe => { recipe.definition.steps[0].prompt = recipe.definition.steps[0].prompt.replace('00000007-0000-4000-8000-000000000001', segmentId) })).outcome).toMatchObject({ kind: 'completed' })
    expect(new Set(ids).size).toBe(105)
    expect(f.channel).toHaveBeenCalledWith(expect.objectContaining({ text: 'Reviewed 105 fictional deals.', channelId: 'fictional-operator-digest' }))
    expect(f.send).not.toHaveBeenCalled()
  })
  it('completes allowed outreach with a durable receipt after human approval', async () => {
    const f = await fixture(), deliveryId = randomUUID()
    const { run, outcome } = await f.start('managed_outreach', { contactId: f.contactId, deliveryId, recipient: 'member@example.com', subject: 'Fictional update', body: 'Requested update.' })
    expect(outcome).toMatchObject({ kind: 'paused', reason: 'approval' })
    expect(await f.approve(run.id)).toMatchObject({ status: 'completed' })
    expect(f.send).toHaveBeenCalledTimes(1)
    expect((await pool.query('SELECT status FROM crm_delivery_receipts WHERE workspace_id=$1 AND delivery_id=$2', [f.workspaceId, deliveryId])).rows).toEqual([{ status: 'sent' }])
  })
  it('rechecks withdrawal after outreach preview and approval, refusing transport before receipt admission', async () => {
    const f = await fixture(), deliveryId = randomUUID()
    const input = { contactId: f.contactId, deliveryId, recipient: 'member@example.com', subject: 'Fictional update', body: 'Requested update.' }
    const { run, outcome } = await f.start('managed_outreach', input)
    expect(outcome).toMatchObject({ kind: 'paused', reason: 'approval' })
    await f.command({ kind: 'record_consent', contactId: f.contactId, purposeKey: 'member_updates', action: 'withdrawn', source: 'fixture' })
    expect(await f.approve(run.id, true)).toMatchObject({ status: 'failed', error: { reason: 'tool_returned_error_after_resume' } })
    expect(f.send).not.toHaveBeenCalled()
    expect((await pool.query('SELECT status FROM crm_delivery_receipts WHERE workspace_id=$1 AND delivery_id=$2', [f.workspaceId, deliveryId])).rows).toEqual([])
    const next = await f.start('managed_outreach', { ...input, deliveryId: randomUUID() })
    expect(next.outcome).toMatchObject({ kind: 'completed' })
    expect((await runStore.listStepRuns(f.userId, next.run.id)).map(s => s.stepId)).toEqual(['preview', 'allowed'])
  })
})
