import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createAssociationTools, createCrmOperationsTools, type CrmOperationsReadPort, type ToolContext, type Tool } from '@use-brian/core'
import { getPool, getAppPool } from '../client.js'
import { runWithAgentAccess } from '../agent-access-context.js'
import { seedBuiltinPrimitiveCapabilities } from '../capability-seed.js'
import { createAssociationWorkspaceModulesStore } from '../../association/workspace-module.js'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createAssociationService } from '../../association/service.js'
import { _resetCoalescerForTests } from '../../brain-stream/notify.js'
import * as notifications from '../../brain-stream/notify.js'
import { loadDepartmentSnapshot, resolveDepartmentReadGrant } from '../../context-scope/department-resolver.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), appPool = getAppPool(), modules = createAssociationWorkspaceModulesStore()
const crmService = createCrmOperationsService(createDbCrmOperationsStore())
const tools = createAssociationTools(createAssociationService({ crmService }))
const crmTools = createCrmOperationsTools({ service: crmService, reads: {} as CrmOperationsReadPort })
const grants = ['association', 'home_app:association:read', 'home_app:association:write', 'crm', 'home_app:crm:read', 'home_app:crm:write', 'configure']
async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), assistantId = randomUUID(), contactId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Native commerce fixture',$2)", [workspaceId, userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId])
  await pool.query("INSERT INTO assistants(id,name,workspace_id,kind,owner_user_id) VALUES($1,'Fixture assistant',$2,'primary',$3)", [assistantId, workspaceId, userId])
  await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source) VALUES($1,$2,'person','Example Attendee',$3,'manual')", [contactId, workspaceId, userId])
  await seedBuiltinPrimitiveCapabilities((sql, params) => pool.query(sql, params), assistantId, userId)
  async function context(): Promise<ToolContext> {
    const rows = await pool.query('SELECT capability FROM assistant_capabilities WHERE assistant_id=$1 AND revoked_at IS NULL', [assistantId])
    return { workspaceId, userId, assistantId, sessionId: randomUUID(), appId: assistantId, channelType: 'workflow', channelId: 'fixture',
      abortSignal: new AbortController().signal, activeCapabilities: new Set(rows.rows.map(row => row.capability)) }
  }
  async function grant() {
    for (const capability of grants) await pool.query(`INSERT INTO assistant_capabilities(assistant_id,capability,granted_by_user_id)
      VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [assistantId, capability, userId])
  }
  // The runtime supplies this trusted ceiling outside the tool. Direct tool
  // fixtures must preserve that boundary as well as capability metadata.
  const call = async (tool: Tool, input: unknown = {}) => runWithAgentAccess({
    workspaceId, userId, clearance: 'internal', compartments: [], projectIds: [], visibilityAssistantIds: [assistantId],
    departmentRead: { workspaceId, userId, assistantId, base: 'internal', departments: {}, contextDepartment: null, binding: null, cap: null },
  }, async () => tool.execute(input, await context()))
  return { workspaceId, userId, assistantId, contactId, call, grant, context }
}
function record(output: Awaited<ReturnType<Tool['execute']>>) {
  expect(output.isError, JSON.stringify(output.data)).not.toBe(true)
  return (output.data as { record: Record<string, unknown> }).record
}

describe('[COMP:crm/association-tools] Native tools through real canonical transactions', () => {
  it('renews human and assistant departments on native creation and exact-request recovery', async () => {
    const f = await fixture(); await f.grant()
    const event = record(await f.call(crmTools.saveCrmEvent, { event: { slug: 'department-meeting', title: 'Fictional meeting',
      startsAt: '2099-01-01T10:00:00Z', endsAt: '2099-01-01T11:00:00Z', timezone: 'UTC', mode: 'venue', status: 'published', capacity: 10 } }))
    await modules.act(f.workspaceId, f.userId, 'association', { action: 'enable', expectedVersion: 1 })
    const ticket = record(await f.call(tools.saveAssociationTicket, { eventId: event.id,
      ticket: { key: 'standard', name: 'Standard', currency: 'USD', priceMinor: 0, capacity: 10, status: 'on_sale' } }))
    const custodian = randomUUID(), departmentId = randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [custodian])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')", [f.workspaceId,custodian])
    await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [f.workspaceId])
    await pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId,f.userId])
    await pool.query("UPDATE assistants SET clearance='public',kind='standard' WHERE id=$1", [f.assistantId])
    await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Cedar',$3,'team',$1::text,$4)",
      [departmentId,f.workspaceId,custodian,`team:${departmentId}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Cedar','team',$3)",
      [f.workspaceId,`team:${departmentId}`,departmentId])
    await pool.query("UPDATE entities SET sensitivity='confidential',compartments=$2 WHERE id=$1", [f.contactId,[`team:${departmentId}`]])
    let frozen: ReturnType<typeof resolveDepartmentReadGrant> | undefined
    const call = async (tool: Tool, input: unknown, retain = false) => {
      const identity = { workspaceId:f.workspaceId, userId:f.userId, assistantId:f.assistantId }
      const {snapshot,principal} = await loadDepartmentSnapshot(
        <R>(sql:string,params:unknown[])=>pool.query(sql,params) as unknown as Promise<{rows:R[]}>,identity)
      const departmentRead = frozen ?? resolveDepartmentReadGrant(snapshot,principal,identity,new Date())
      if (retain) frozen = departmentRead
      expect(departmentRead.base).toBe('public')
      return runWithAgentAccess({...identity,clearance:'confidential',compartments:[`team:${departmentId}`],
        projectIds:[],visibilityAssistantIds:[f.assistantId],departmentRead},async()=>tool.execute(input,await f.context()))
    }
    const input = {order:{contactId:f.contactId,idempotencyKey:randomUUID(),lines:[{ticketId:ticket.id,quantity:1,attendees:[{contactId:f.contactId,name:'Fictional attendee'}]}]}}
    const denied = {isError:true,data:{error:'not_authorized'}}
    expect(await call(tools.createAssociationOrder,input)).toMatchObject(denied)
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store')", [f.workspaceId,departmentId,f.userId])
    expect(await call(tools.createAssociationOrder,input)).toMatchObject(denied)
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,assistant_id,clearance,origin) VALUES($1,$2,'assistant',$3,'internal','store')", [f.workspaceId,departmentId,f.assistantId])
    expect(await call(tools.createAssociationOrder,input)).toMatchObject(denied)
    expect((await pool.query('SELECT count(*)::int n FROM association_orders WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(0)
    await pool.query("UPDATE department_edges SET clearance='confidential' WHERE workspace_id=$1 AND assistant_id=$2",[f.workspaceId,f.assistantId])
    // Keep this admitted turn ceiling through later live revocation/recovery.
    const order=record(await call(tools.createAssociationOrder,input,true))
    expect(record(await call(tools.createAssociationOrder,input)).id).toBe(order.id)
    await pool.query("UPDATE entities SET sensitivity='public',compartments='{}' WHERE id=$1",[f.contactId])
    await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND assistant_id=$2",[f.workspaceId,f.assistantId])
    expect(await call(tools.getAssociationOrder,{orderId:order.id})).toMatchObject({isError:true,data:{error:'not_authorized',details:{recovery:{preserveRequestIdentity:true,mutationRetry:'never_automatic'}}}})
    expect(await call(tools.listAssociationOrders,{})).toMatchObject({data:{items:[],nextCursor:null,financialSummary:[]}})
    expect(await call(tools.createAssociationOrder,input)).toMatchObject(denied)
    await pool.query('UPDATE department_edges SET expires_at=NULL WHERE workspace_id=$1 AND assistant_id=$2',[f.workspaceId,f.assistantId])
    expect(record(await call(tools.createAssociationOrder,input)).id).toBe(order.id)
    // Staff reservation creation separately requires management authority.
    // Ordinary members can still read at their higher department clearance.
    await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.userId])
    expect(record(await call(tools.getAssociationOrder,{orderId:order.id})).id).toBe(order.id)
    expect(await call(tools.listAssociationOrders,{})).toMatchObject({data:{items:[{id:order.id}],nextCursor:null}})
    await pool.query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.userId])
    expect(await call(tools.getAssociationOrder,{orderId:order.id})).toMatchObject(denied)
    expect((await pool.query('SELECT scope_snapshot FROM association_orders WHERE workspace_id=$1',[f.workspaceId])).rows)
      .toEqual([{scope_snapshot:expect.objectContaining({sensitivity:'confidential',compartments:[`team:${departmentId}`]})}])
  })
  afterAll(async () => { _resetCoalescerForTests(); await pool.end(); await appPool.end() })
  it('does not seed Association and does not grant it through workspace enablement', async () => {
    const f = await fixture()
    expect([...(await f.context()).activeCapabilities!].some(cap => cap.includes('association'))).toBe(false)
    const before = (await pool.query('SELECT home_apps FROM workspaces WHERE id=$1', [f.workspaceId])).rows
    const notified = vi.spyOn(notifications, 'notifyWorkspaceChange')
    try {
      await modules.act(f.workspaceId, f.userId, 'association', { action: 'enable', expectedVersion: 1 })
      expect(notified).toHaveBeenCalledExactlyOnceWith(f.workspaceId, 'workspace_config', 'update')
      expect((await pool.query('SELECT state FROM workspace_modules WHERE workspace_id=$1', [f.workspaceId])).rows[0].state).toBe('enabled')
      await modules.act(f.workspaceId, f.userId, 'association', { action: 'enable', expectedVersion: 2 })
      await expect(modules.act(f.workspaceId, f.userId, 'association', { action: 'request_disable', expectedVersion: 1 })).rejects.toMatchObject({ code: 'stale_module_version' })
      expect(notified).toHaveBeenCalledTimes(1)
    } finally { notified.mockRestore() }
    expect(await f.call(tools.getAssociationModuleStatus)).toMatchObject({ isError: true, data: { error: 'not_authorized' } })
    expect((await pool.query('SELECT home_apps FROM workspaces WHERE id=$1', [f.workspaceId])).rows).toEqual(before)
  })
  it('configures generic catalogs while disabled, reserves once, and preserves shutdown recovery and actor attribution', async () => {
    const f = await fixture(); await f.grant()
    const plan = record(await f.call(crmTools.saveCrmEntitlementPlan, { plan: { key: 'example-member', name: 'Example Membership', currency: 'USD', feeMinor: 0, billingPeriod: 'manual' } }))
    expect(plan.id).toBeTruthy()
    const event = record(await f.call(crmTools.saveCrmEvent, { event: { slug: 'example-meeting', title: 'Example Meeting', startsAt: '2099-01-01T10:00:00Z',
      endsAt: '2099-01-01T11:00:00Z', timezone: 'UTC', mode: 'venue', status: 'published', capacity: 1 } }))
    const ticketInput = { eventId: event.id, ticket: { key: 'standard', name: 'Standard', currency: 'USD', priceMinor: 0, capacity: 1, status: 'on_sale' } }
    expect(await f.call(tools.saveAssociationTicket, ticketInput)).toMatchObject({ isError: true, data: { error: 'module_disabled' } })
    await modules.act(f.workspaceId, f.userId, 'association', { action: 'enable', expectedVersion: 1 })
    const ticket = record(await f.call(tools.saveAssociationTicket, ticketInput))
    const input = { order: { contactId: f.contactId, idempotencyKey: randomUUID(), lines: [
      { ticketId: ticket.id, quantity: 1, attendees: [{ contactId: f.contactId, name: 'Example Attendee' }] },
    ] } }
    const order = record(await f.call(tools.createAssociationOrder, input))
    expect(record(await f.call(tools.createAssociationOrder, input)).id).toBe(order.id)
    const privateAssistantId = randomUUID()
    await pool.query("INSERT INTO assistants(id,name,workspace_id,kind,owner_user_id) VALUES($1,'Fictional private assistant',$2,'standard',$3)", [privateAssistantId, f.workspaceId, f.userId])
    await pool.query('UPDATE entities SET assistant_id=$2 WHERE id=$1', [f.contactId, privateAssistantId])
    expect(await f.call(tools.getAssociationOrder, { orderId: order.id })).toMatchObject({ isError: true, data: { error: 'not_authorized' } })
    await pool.query('UPDATE entities SET assistant_id=NULL WHERE id=$1', [f.contactId])
    await modules.act(f.workspaceId, f.userId, 'association', { action: 'request_disable', expectedVersion: 2 })
    expect(record(await f.call(tools.getAssociationOrder, { orderId: order.id })).status).toBe('pending')
    expect(await f.call(tools.createAssociationOrder, { order: { ...input.order, idempotencyKey: randomUUID() } }))
      .toMatchObject({ isError: true, data: { error: 'module_draining' } })
    expect(record(await f.call(tools.cancelAssociationOrder, { orderId: order.id })).status).toBe('cancelled')
    await modules.act(f.workspaceId, f.userId, 'association', { action: 'finish_disable', expectedVersion: 3 })
    expect(record(await f.call(tools.getAssociationOrder, { orderId: order.id })).status).toBe('cancelled')
    const audit = await pool.query("SELECT actor_kind,actor_credential_id FROM association_audit_log WHERE workspace_id=$1 AND subject_kind IN('event','entitlement_plan','order')", [f.workspaceId])
    expect(audit.rows.length).toBeGreaterThanOrEqual(4)
    expect(audit.rows.every(row => row.actor_kind === 'assistant' && row.actor_credential_id === f.assistantId)).toBe(true)
    await pool.query("UPDATE assistant_capabilities SET revoked_at=now() WHERE assistant_id=$1 AND capability='home_app:association:read'", [f.assistantId])
    expect(await f.call(tools.getAssociationOrder, { orderId: order.id })).toMatchObject({ isError: true, data: { error: 'not_authorized' } })
  })
})
