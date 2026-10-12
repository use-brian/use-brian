import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { CRM_INTEGRATION_OPERATIONS, CRM_INTEGRATION_RESOURCE_CATALOG, type AssociationServicePort, type CrmIntegrationGrant,
  type CrmOperationsCommand, type CrmOperationsContext } from '@use-brian/core'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createDbCrmOperationsStore } from '../../db/crm-operations-store.js'
import { createCrmIntegrationStore } from '../../db/crm-integration-store.js'
import { createCrmGovernedReadStore } from '../../db/crm-governed-store.js'
import { createCrmReferenceReadStore } from '../../db/crm-business-reference-store.js'
import { createCrmErpReadStore } from '../../db/crm-erp-store.js'
import { runWithAgentAccess } from '../../db/agent-access-context.js'
import { crmIntegrationRoutes } from '../crm-integration.js'
import { crmOperationsRoutes } from '../crm-operations.js'
import { getAppPool, getPool } from '../../db/client.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 })
const appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL_APP })
const service = createCrmOperationsService(createDbCrmOperationsStore(pool))
const keys = createCrmIntegrationStore(pool, appPool)
const run = ((sql: string, values: unknown[]) => pool.query(sql, values)) as never
const governed = createCrmGovernedReadStore(run), references = createCrmReferenceReadStore(run), erp = createCrmErpReadStore(run)
afterAll(async () => { await Promise.all([pool.end(), appPool.end(), getAppPool().end(), getPool().end()]) })

const ALL: CrmIntegrationGrant[] = CRM_INTEGRATION_OPERATIONS.map((operation) => ({ operation,
  selectors: Object.fromEntries(CRM_INTEGRATION_RESOURCE_CATALOG[operation].map((dimension) => [dimension, 'all'])) }))
const UNAVAILABLE = 'The record is unavailable in your current scope.'
/** A successful HTTP command body; a refusal fails with its status and body visible. */
function body(response: { status: number; body: { record: Record<string, any> } }) {
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300)
  return response.body
}

async function fixture() {
  const workspaceId = randomUUID(), owner = randomUUID(), member = randomUUID(), assistantId = randomUUID()
  for (const id of [owner, member]) await pool.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'test',$1::text)", [id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional authority fixture',$2)", [workspaceId, owner])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'member','internal')", [workspaceId, owner, member])
  await pool.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Fictional assistant','primary','internal')", [assistantId, workspaceId])
  const entity = async (kind: 'company' | 'deal', name: string, sensitivity: string, attributes: Record<string, unknown> = {}) => {
    const id = randomUUID()
    await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source,attributes,sensitivity) VALUES($1,$2,$3,$4,$5,'manual',$6::jsonb,$7)`,
      [id, workspaceId, kind, name, owner, JSON.stringify(attributes), sensitivity])
    return id
  }
  const company = await entity('company', 'Example Authority Client Limited', 'internal')
  const open = await entity('deal', 'Example open engagement', 'internal', { company_id: company })
  const secret = await entity('deal', 'Example restricted engagement', 'confidential', { company_id: company })
  const user = (userId: string, role: 'owner' | 'member'): CrmOperationsContext => ({ workspaceId, actor: { kind: 'user', userId },
    authority: { role, canWrite: true, canConfigure: role === 'owner', trustedIdentitySources: [] } })
  const agentScope = { workspaceId, userId: member, clearance: 'internal', compartments: null, mutationCompartments: null, projectIds: null, visibilityAssistantIds: null }
  const callers = {
    member: (command: Record<string, unknown>) => service.execute(user(member, 'member'), { operationId: randomUUID(), ...command } as CrmOperationsCommand),
    assistant: (command: Record<string, unknown>) => runWithAgentAccess(agentScope, () => service.execute({ workspaceId,
      actor: { kind: 'assistant', assistantId, userId: member, sessionId: randomUUID() }, authority: { role: 'member', canWrite: true, canConfigure: false, trustedIdentitySources: [] } },
      { operationId: randomUUID(), ...command } as CrmOperationsCommand)),
    workflow: (command: Record<string, unknown>) => runWithAgentAccess(agentScope, () => service.execute({ workspaceId,
      actor: { kind: 'workflow', workflowId: randomUUID(), runId: randomUUID(), userId: member }, authority: { role: 'member', canWrite: true, canConfigure: false, trustedIdentitySources: [] } },
      { operationId: randomUUID(), ...command } as CrmOperationsCommand)),
  }
  const ownerExec = (command: Record<string, unknown>) => service.execute(user(owner, 'owner'), { operationId: randomUUID(), ...command } as CrmOperationsCommand)
  // An internal-cap integration key bound to the member's department view, and the same key used by the enrolled member.
  const key = await keys.create(workspaceId, owner, { label: 'Fictional internal key', expiresAt: '2099-01-01T00:00:00Z', grants: ALL,
    departmentBinding: { departmentIds: [], cap: 'internal', assistantId } })
  const app = express()
  app.use(express.json())
  app.use('/api/crm/integration', crmIntegrationRoutes({ credentials: keys, service, association: {} as AssociationServicePort }))
  app.use((req, _res, next) => { (req as { userId?: string }).userId = req.get('x-test-user') ?? undefined; next() })
  app.use('/api/crm', crmOperationsRoutes({ service, readStore: {} as never,
    workspaceStore: { getRole: async (userId: string, ws: string) => (await pool.query('SELECT role FROM workspace_members WHERE user_id=$1 AND workspace_id=$2', [userId, ws])).rows[0]?.role ?? null } as never }))
  const integration = (body: Record<string, unknown>, viewer?: string) => {
    const call = request(app).post('/api/crm/integration/operations/commands').set('Authorization', `Bearer ${key.oneTimeSecret}`)
    if (viewer) call.set('x-crm-viewer', viewer).set('x-crm-binding', 'authority-erp')
    return call.send({ operationId: randomUUID(), ...body })
  }
  const memberHttp = (body: Record<string, unknown>, userId = member) => request(app).post(`/api/crm/${workspaceId}/operations/commands`).set('x-test-user', userId)
    .send({ operationId: randomUUID(), ...body })
  return { workspaceId, owner, member, assistantId, company, open, secret, callers, ownerExec, key, integration, memberHttp, app }
}

describe('[COMP:api/crm-commercial-authority] equivalent commercial authority across callers', () => {
  it('A1 gives member, assistant, workflow, integration and enrolled-viewer callers the same effective authority', async () => {
    const f = await fixture()
    const change = (name: string) => ({ kind: 'save_change_request', target: { kind: 'deal', id: f.open }, changes: { name } })
    // Every caller can draft on the visible engagement, through its own entry point.
    const results = [
      (await f.callers.member(change('Member draft'))).record.request,
      (await f.callers.assistant(change('Assistant draft'))).record.request,
      (await f.callers.workflow(change('Workflow draft'))).record.request,
      body(await f.memberHttp(change('HTTP member draft'))).record.request,
      body(await f.integration(change('Integration draft'))).record.request,
    ] as Array<{ state: string; targetId: string }>
    expect(results.map((row) => [row.state, row.targetId])).toEqual(Array(5).fill(['draft', f.open]))
    // Every caller gets the same content-free refusal for the confidential engagement and for an id that does not exist.
    const hidden = { ...change('Hidden'), target: { kind: 'deal', id: f.secret } }, missing = { ...change('Missing'), target: { kind: 'deal', id: randomUUID() } }
    for (const command of [hidden, missing]) {
      for (const [name, caller] of Object.entries(f.callers)) {
        const outcome = await caller(command).then(() => 'resolved', (error: { code?: string; message?: string }) => `${error.code}:${error.message}`)
        expect(`${name}:${outcome}`).toBe(`${name}:not_found:${UNAVAILABLE}`)
      }
      const http = await f.memberHttp(command)
      expect([http.status, http.body.error]).toEqual([404, 'not_found'])
      const integration = await f.integration(command)
      expect([integration.status, integration.body.error]).toEqual([404, 'not_found'])
    }
    // Only a human reviewer decides; agents, workflows and keys cannot establish approval.
    const toReview = (await f.callers.member(change('To review'))).record.request as { id: string }
    const submitted = (await f.callers.member({ kind: 'submit_change_request', requestId: toReview.id, expectedVersion: 1 })).record.request as { id: string; revision: number }
    const decide = { kind: 'decide_change_request', requestId: submitted.id, expectedRevision: submitted.revision, decision: 'approve' }
    await expect(f.callers.assistant(decide)).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(f.callers.workflow(decide)).rejects.toMatchObject({ code: 'not_authorized' })
    expect((await f.integration(decide)).status).toBe(403)
    // An enrolled viewer acts as that member, so its authority equals the member's own.
    await f.ownerExec({ kind: 'stage_erp_import', bindingKey: 'authority-erp', records: { clients: [], engagements: [] } })
    await pool.query('UPDATE crm_provider_bindings SET integration_credential_id=$2 WHERE workspace_id=$1', [f.workspaceId, f.key.id])
    await f.callers.member({ kind: 'enroll_erp_viewer', bindingKey: 'authority-erp', legacyUserId: 'legacy-member' })
    const viewerDraft = await f.integration(change('Viewer draft'), 'legacy-member')
    expect(viewerDraft.body.record.request).toMatchObject({ state: 'draft', authorUserId: f.member })
    expect((await f.integration(hidden, 'legacy-member')).status).toBe(404)
    expect((await f.integration(decide, 'legacy-member')).body).toMatchObject({ error: 'not_authorized' })
    // The viewer's write is audited as the member, with the credential it came through.
    const audit = (await pool.query("SELECT metadata->>'viaCredentialId' AS via FROM association_audit_log WHERE workspace_id=$1 AND action='crm.change_request.created' AND acting_user_id=$2",
      [f.workspaceId, f.member])).rows.map((row) => row.via)
    expect(audit.filter((via) => via === f.key.id)).toHaveLength(1)
    // Nobody can enroll a viewer on someone else's behalf.
    await expect(f.callers.assistant({ kind: 'enroll_erp_viewer', bindingKey: 'authority-erp', legacyUserId: 'other' })).rejects.toMatchObject({ code: 'not_authorized' })
    expect((await f.integration({ kind: 'enroll_erp_viewer', bindingKey: 'authority-erp', legacyUserId: 'other' })).status).toBe(403)
  })

  it('A2 stops revoked, removed and newly restricted callers with content-free refusals, including for history', async () => {
    const f = await fixture()
    await f.ownerExec({ kind: 'save_reference_definition', definition: { definitionKey: 'job', label: 'Job', targetKinds: ['deal'], assignmentMode: 'manual', namespaceKey: 'jobs' } })
    await f.ownerExec({ kind: 'assign_business_reference', definitionKey: 'job', target: { kind: 'deal', id: f.open }, value: 'JOB-77' })
    const draft = (await f.callers.member({ kind: 'save_change_request', target: { kind: 'deal', id: f.open }, changes: { name: 'Before restriction' } })).record.request as { id: string }
    const billing = (await f.ownerExec({ kind: 'create_billing_request', dealId: f.open, amount: '100', currency: 'HKD', description: 'Fictional', submit: false })).record.request as { id: string }
    expect((await governed.getChangeRequest(f.workspaceId, { userId: f.member }, draft.id))).not.toBeNull()
    // The engagement becomes confidential: its requests, billing and references vanish for the internal member, current and historical alike.
    await pool.query("UPDATE entities SET sensitivity='confidential' WHERE id=$1", [f.open])
    expect(await governed.getChangeRequest(f.workspaceId, { userId: f.member }, draft.id)).toBeNull()
    expect((await governed.listChangeRequests(f.workspaceId, { userId: f.member }, { targetId: f.open, reviewable: false, limit: 50 })).requests).toEqual([])
    expect((await governed.listBillingRequests(f.workspaceId, { userId: f.member }, { dealId: f.open, limit: 50 })).requests).toEqual([])
    expect((await references.lookup(f.workspaceId, { userId: f.member }, { q: 'JOB-77', match: 'exact', includeFormer: true, limit: 50 })).references).toEqual([])
    await expect(f.callers.member({ kind: 'withdraw_change_request', requestId: draft.id, expectedVersion: 1, reason: 'Gone' })).rejects.toMatchObject({ code: 'not_found', message: UNAVAILABLE })
    await expect(f.callers.member({ kind: 'cancel_billing_request', requestId: billing.id, expectedVersion: 1, reason: 'Gone' })).rejects.toMatchObject({ code: 'not_found', message: UNAVAILABLE })
    // The owner still sees all of it.
    expect(await governed.getChangeRequest(f.workspaceId, { userId: f.owner }, draft.id)).not.toBeNull()
    // Removal from the workspace and credential revocation stop new commands.
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.member])
    expect((await f.memberHttp({ kind: 'save_change_request', target: { kind: 'company', id: f.company }, changes: { name: 'After removal' } })).status).toBe(404)
    await keys.revoke(f.workspaceId, f.owner, f.key.id)
    const revoked = await f.integration({ kind: 'save_change_request', target: { kind: 'company', id: f.company }, changes: { name: 'After revoke' } })
    expect(revoked.status).toBe(401)
  })

  it('A3 keeps protected data out of restricted lists, searches, history, exports and projections', async () => {
    const f = await fixture()
    for (const dealId of [f.open, f.secret]) {
      await f.ownerExec({ kind: 'set_commercial_values', dealId, values: [{ valueKind: 'confirmed', expectedVersion: 0, amount: '7777', currency: 'HKD' }],
        evidence: { source: 'fixture', reason: 'Fictional fee' } })
    }
    await f.ownerExec({ kind: 'save_reference_definition', definition: { definitionKey: 'job', label: 'Job', targetKinds: ['deal'], assignmentMode: 'manual', namespaceKey: 'jobs' } })
    await f.ownerExec({ kind: 'assign_business_reference', definitionKey: 'job', target: { kind: 'deal', id: f.secret }, value: 'SECRET-1' })
    await f.ownerExec({ kind: 'create_billing_request', dealId: f.secret, amount: '500', currency: 'HKD', description: 'Fictional restricted billing', submit: false })
    // Lists: the internal member sees the open engagement without fees and nothing of the restricted one.
    const engagements = await governed.listEngagements(f.workspaceId, { userId: f.member }, { companyId: f.company, includeCommercialValues: true, limit: 50 } as never)
    const visible = await governed.listEngagements(f.workspaceId, { userId: f.member }, { dealId: f.open, includeCommercialValues: true, limit: 50 })
    expect(visible.engagements[0]).toMatchObject({ id: f.open, commercialValues: [] })
    expect(JSON.stringify(engagements)).not.toContain(f.secret)
    expect((await governed.listBillingRequests(f.workspaceId, { userId: f.member }, { limit: 50 })).requests).toEqual([])
    const balance = await governed.billingBalance(f.workspaceId, { userId: f.member }, { companyId: f.company })
    expect(JSON.stringify(balance)).not.toContain('7777')
    // Search and history.
    expect((await references.lookup(f.workspaceId, { userId: f.member }, { q: 'SECRET-1', match: 'exact', includeFormer: true, limit: 50 })).references).toEqual([])
    const audit = (await pool.query("SELECT metadata::text AS m FROM association_audit_log WHERE workspace_id=$1 AND action='crm.commercial_values.set'", [f.workspaceId])).rows
    expect(audit.every((row) => !row.m.includes('7777'))).toBe(true)
    // Projections and exports for retained applications never carry fees, and skip what the reader cannot see.
    await f.ownerExec({ kind: 'stage_erp_import', bindingKey: 'authority-erp', records: { clients: [], engagements: [] } })
    await pool.query("UPDATE entities SET display_name=display_name||' (2026)' WHERE workspace_id=$1 AND kind='deal'", [f.workspaceId])
    const feed = await erp.listProjectionEvents(f.workspaceId, { userId: f.member }, { bindingKey: 'authority-erp', limit: 100 })
    expect(feed.events.map((event) => event.subjectId)).toEqual([f.open])
    expect(JSON.stringify(feed)).not.toMatch(/7777|SECRET-1/)
    const ownerFeed = await erp.listProjectionEvents(f.workspaceId, { userId: f.owner }, { bindingKey: 'authority-erp', limit: 100 })
    expect(new Set(ownerFeed.events.map((event) => event.subjectId))).toEqual(new Set([f.open, f.secret]))
    expect(JSON.stringify(ownerFeed)).not.toContain('7777')
    // The integration key is capped at internal: its reads match the member's.
    const integrationEngagements = await request(f.app).get('/api/crm/integration/operations/engagements').query({ dealId: f.secret })
      .set('Authorization', `Bearer ${f.key.oneTimeSecret}`)
    expect(integrationEngagements.body.engagements).toEqual([])
  })
})
