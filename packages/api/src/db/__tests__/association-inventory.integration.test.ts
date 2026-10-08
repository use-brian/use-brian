import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { AssociationSourceOrderImportSchema, AssociationSourceMembershipImportSchema, type CrmOperationsContext, type CrmOperationsCommand } from '@use-brian/core'
import { getPool, getAppPool } from '../client.js'
import { runWithAgentAccess } from '../agent-access-context.js'
import { createAssociationWorkspaceModulesStore } from '../../association/workspace-module.js'
import { createAssociationStore } from '../association-store.js'
import { createCrmIntegrationStore } from '../crm-integration-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createDbCrmIntakeReadStore } from '../crm-intake-store.js'
import { EventInputSchema, TicketInputSchema, OrderCreateSchema, PlanInputSchema } from '../../association/domain.js'
import { _resetCoalescerForTests } from '../../brain-stream/notify.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), appPool = getAppPool(), modules = createAssociationWorkspaceModulesStore()
const commerce = createAssociationStore(), operations = createCrmOperationsService(createDbCrmOperationsStore())
const eventInput = { slug: 'fixture-event', title: 'Inventory fixture', startsAt: '2099-01-01T12:00:00Z', endsAt: '2099-01-01T14:00:00Z', timezone: 'UTC', mode: 'venue', status: 'published', capacity: 1 }
const ticketInput = { key: 'standard', name: 'Standard', currency: 'USD', priceMinor: 0, status: 'on_sale', capacity: 1 }
async function fixture(eventPatch: Record<string, unknown> = {}, withTicket = true, ticketPatch: Record<string, unknown> = {}) {
  const workspaceId = randomUUID(), userId = randomUUID(), contactId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Inventory fixture',$2)", [workspaceId, userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId])
  await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source) VALUES($1,$2,'person','Fictional attendee',$3,'manual')", [contactId, workspaceId, userId])
  await modules.act(workspaceId, userId, 'association', { action: 'enable', expectedVersion: 1 })
  const actor = { credentialKind: 'user' as const, credentialId: userId, actingUserId: userId }
  const event = await commerce.upsertEvent(workspaceId, EventInputSchema.parse({ ...eventInput, ...eventPatch }), actor)
  const eventId = String(event.record.id)
  const ticket = withTicket ? await commerce.upsertTicket(workspaceId, eventId, TicketInputSchema.parse({ ...ticketInput, ...ticketPatch }), actor) : null
  const ticketId = ticket ? String(ticket.record.id) : undefined
  const context: CrmOperationsContext = { workspaceId, actor: { kind: 'user', userId }, authority: { role: 'owner', canConfigure: true, canWrite: true, trustedIdentitySources: [] } }
  const order = (ids = [ticketId!], key = randomUUID(), useMemberPrice = false) => commerce.createOrder(workspaceId, OrderCreateSchema.parse({ contactId, idempotencyKey: key, lines: ids.map(id => ({ ticketId: id, quantity: 1, useMemberPrice, attendees: [{ contactId, name: 'Fictional attendee' }] })) }), actor)
  const participation = (patch: Partial<Extract<CrmOperationsCommand, { kind: 'record_participation' }>> = {}, ctx = context) => operations.execute(ctx, { kind: 'record_participation', eventId, contactId, sourceKind: 'manual', sourceId: randomUUID(), attendeeName: 'Fictional attendee', status: 'registered', metadata: {}, ...patch })
  return { workspaceId, userId, contactId, actor, context, eventId, ticketId, order, participation }
}
async function boundaries(workspaceId: string) {
  return (await pool.query("SELECT event_type,payload,event_key FROM crm_domain_event_outbox WHERE workspace_id=$1 AND event_type LIKE 'association.inventory.%' ORDER BY created_at,id", [workspaceId])).rows
}
async function blocked(fragment: string) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if ((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND position($1 in query)>0", [fragment])).rowCount) return
    await setTimeout(10)
  }
  throw Error('Expected a database row-lock wait')
}
describe('[COMP:crm/association-inventory] Actual admission and committed boundaries', () => {
  afterAll(async () => { _resetCoalescerForTests(); await pool.end(); await appPool.end() })
  it.each(['human-home', 'assistant-home', 'department-context'] as const)('[COMP:crm/association-source-scope] admits the %s destination on new operational records and preserves it on replay', async lane => {
    const f = await fixture({ capacity: 10 }, true, { capacity: 10 })
    const departmentId = randomUUID(), assistantId = randomUUID(), peerId = randomUUID()
    await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [f.workspaceId])
    await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fictional destination',$3,'team',$1::text,$4)", [departmentId, f.workspaceId, f.userId, `team:${departmentId}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Fictional destination','team',$3)", [f.workspaceId, `team:${departmentId}`, departmentId])
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store') ON CONFLICT DO NOTHING", [f.workspaceId, departmentId, f.userId])
    await pool.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance,home_department_id) VALUES($1,$2,'Fictional destination assistant','standard','internal',$3)", [assistantId, f.workspaceId, lane === 'assistant-home' ? departmentId : null])
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,assistant_id,clearance,origin) VALUES($1,$2,'assistant',$3,'internal','store')", [f.workspaceId, departmentId, assistantId])
    if (lane === 'human-home') await pool.query('UPDATE workspace_members SET home_department_id=$3 WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.userId, departmentId])
    const run = <T>(operation: () => T) => lane === 'human-home' ? operation() : runWithAgentAccess({ workspaceId: f.workspaceId, userId: f.userId,
      clearance: 'internal', compartments: [`team:${departmentId}`], projectIds: [], visibilityAssistantIds: [assistantId],
      departmentRead: { workspaceId: f.workspaceId, userId: f.userId, assistantId, base: 'internal', departments: { [departmentId]: 'internal' },
        contextDepartment: lane === 'department-context' ? departmentId : null, binding: null, cap: null } }, operation)
    expect((await pool.query('SELECT compartments FROM entities WHERE id=$1', [f.contactId])).rows[0].compartments).toEqual([])
    const key = randomUUID()
    let pendingOrder: ReturnType<typeof f.order>
    if (lane === 'human-home') {
      await pool.query('UPDATE workspace_members SET home_department_id=NULL WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.userId])
      const blocker = await pool.connect()
      try {
        await blocker.query('BEGIN')
        await blocker.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [f.workspaceId])
        await blocker.query('UPDATE workspace_members SET home_department_id=$3 WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.userId, departmentId])
        pendingOrder = run(() => f.order([f.ticketId!], key))
        await blocked('SELECT id FROM workspaces WHERE id=$1 AND department_read_v2 FOR UPDATE')
        expect((await pool.query('SELECT count(*)::int n FROM association_orders WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
        await blocker.query('COMMIT')
      } finally { await blocker.query('ROLLBACK'); blocker.release() }
    } else pendingOrder = run(() => f.order([f.ticketId!], key))
    const order = await pendingOrder!
    const plan = await commerce.upsertPlan(f.workspaceId, PlanInputSchema.parse({ key: 'destination-member', name: 'Fictional destination membership', currency: 'USD', feeMinor: 0, billingPeriod: 'manual' }), f.actor)
    await run(() => operations.execute(f.context, { kind: 'grant_entitlement', contactId: f.contactId, planId: String(plan.record.id),
      idempotencyKey: randomUUID(), status: 'active', startsAt: '2026-01-01T00:00:00Z', renewalMode: 'manual' }))
    for (const table of ['association_orders', 'association_registrations', 'association_memberships']) {
      const rows = (await pool.query(`SELECT scope_snapshot,scope_sources FROM ${table} WHERE workspace_id=$1`, [f.workspaceId])).rows
      expect(rows).toHaveLength(1)
      expect(rows[0].scope_snapshot.compartments).toEqual([`team:${departmentId}`])
      expect(rows[0].scope_sources[0].compartments).toEqual([])
    }
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [peerId])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','internal')", [f.workspaceId, peerId])
    const peer = { credentialKind: 'user' as const, credentialId: peerId, actingUserId: peerId }
    await expect(commerce.getOrder(f.workspaceId, String(order.record.id), peer)).rejects.toMatchObject({ code: 'not_authorized' })
    expect(await commerce.listOrders(f.workspaceId, { limit: 10, cursor: null }, peer)).toMatchObject({ items: [], total: 0 })
    expect(await commerce.listMemberships(f.workspaceId, f.contactId, {}, peer)).toEqual([])
    await pool.query('UPDATE workspace_members SET home_department_id=NULL WHERE workspace_id=$1', [f.workspaceId])
    await pool.query('UPDATE assistants SET home_department_id=NULL WHERE id=$1', [assistantId])
    expect(await run(() => f.order([f.ticketId!], key))).toMatchObject({ created: false, record: { id: order.record.id } })
    expect((await pool.query('SELECT scope_snapshot FROM association_orders WHERE id=$1', [order.record.id])).rows[0].scope_snapshot.compartments).toEqual([`team:${departmentId}`])
    // Current destination membership must not widen a frozen execution grant.
    const beforeDeniedBoundaries = await boundaries(f.workspaceId)
    await pool.query('UPDATE assistants SET home_department_id=$2 WHERE id=$1', [assistantId, departmentId])
    await expect(runWithAgentAccess({ workspaceId: f.workspaceId, userId: f.userId, clearance: 'internal', compartments: [], projectIds: [], visibilityAssistantIds: [assistantId],
      departmentRead: { workspaceId: f.workspaceId, userId: f.userId, assistantId, base: 'internal', departments: {}, contextDepartment: null, binding: null, cap: null } }, () => f.order()))
      .rejects.toMatchObject({ code: 'not_authorized' })
    expect((await pool.query('SELECT count(*)::int n FROM association_orders WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(1)
    expect((await pool.query('SELECT count(*)::int n FROM association_registrations WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(1)
    expect(await boundaries(f.workspaceId)).toEqual(beforeDeniedBoundaries)
  })

  it.each(['human', 'assistant'] as const)('[COMP:crm/association-source-scope] admits explicit %s destinations without lowering source floors or relocating replay', async lane => {
    const f = await fixture({ capacity: 10 }, true, { capacity: 10 })
    const sourceDepartment = randomUUID(), destinationDepartment = randomUUID(), custodian = randomUUID(), assistantId = randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [custodian])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')", [f.workspaceId, custodian])
    await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [f.workspaceId])
    for (const id of [sourceDepartment, destinationDepartment]) {
      await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fictional destination',$3,'team',$1::text,$4)", [id, f.workspaceId, custodian, `team:${id}`])
      await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Fictional destination','team',$3)", [f.workspaceId, `team:${id}`, id])
    }
    await pool.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Fictional chooser','standard','internal')", [assistantId, f.workspaceId])
    await pool.query('UPDATE entities SET compartments=$2 WHERE id=$1', [f.contactId, [`team:${sourceDepartment}`]])
    const grant = async (id: string) => {
      await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'internal','store') ON CONFLICT DO NOTHING", [f.workspaceId, id, f.userId])
      await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,assistant_id,clearance,origin) VALUES($1,$2,'assistant',$3,'internal','store') ON CONFLICT DO NOTHING", [f.workspaceId, id, assistantId])
    }
    await grant(sourceDepartment)
    const run = <T>(operation: () => T) => lane === 'human' ? operation() : runWithAgentAccess({ workspaceId: f.workspaceId, userId: f.userId,
      clearance: 'internal', compartments: null, projectIds: [], visibilityAssistantIds: [assistantId],
      departmentRead: { workspaceId: f.workspaceId, userId: f.userId, assistantId, base: 'internal', departments: { [sourceDepartment]: 'internal', [destinationDepartment]: 'internal' },
        contextDepartment: null, binding: null, cap: null } }, operation)
    const input = OrderCreateSchema.parse({ contactId: f.contactId, idempotencyKey: randomUUID(),
      destination: { kind: 'department', departmentId: destinationDepartment },
      lines: [{ ticketId: f.ticketId, quantity: 1, attendees: [{ contactId: f.contactId, name: 'Fictional attendee' }] }] })
    const create = (order = input) => run(() => commerce.createOrder(f.workspaceId, order, f.actor))
    const before = await boundaries(f.workspaceId)
    const preview = () => run(() => commerce.previewOrderDestinations(f.workspaceId, [f.contactId], f.actor))
    const missingDestination = await preview()
    expect(missingDestination.validForMs).toBe(30_000)
    expect(JSON.stringify(missingDestination)).not.toContain(destinationDepartment)
    await expect(create()).rejects.toMatchObject({ code: 'not_authorized' })
    expect((await pool.query('SELECT count(*)::int n FROM association_orders WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
    expect((await pool.query('SELECT count(*)::int n FROM association_registrations WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
    expect(await boundaries(f.workspaceId)).toEqual(before)
    await grant(destinationDepartment)
    if (lane === 'assistant') {
      await pool.query('DELETE FROM department_edges WHERE workspace_id=$1 AND department_id=$2 AND assistant_id=$3', [f.workspaceId, destinationDepartment, assistantId])
      await expect(create()).rejects.toMatchObject({ code: 'not_authorized' })
      expect((await pool.query('SELECT count(*)::int n FROM association_orders WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
      expect(await boundaries(f.workspaceId)).toEqual(before)
      await grant(destinationDepartment)
    }
    const allowedPreview = await preview()
    expect(allowedPreview.choices).toEqual(expect.arrayContaining([expect.objectContaining({ destination: { kind: 'department', departmentId: destinationDepartment } })]))
    expect((await pool.query('SELECT count(*)::int n FROM association_orders WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
    const created = await create()
    const expected = [sourceDepartment, destinationDepartment].map(id => `team:${id}`).sort()
    for (const table of ['association_orders', 'association_registrations']) {
      expect((await pool.query(`SELECT scope_snapshot FROM ${table} WHERE workspace_id=$1`, [f.workspaceId])).rows[0].scope_snapshot.compartments).toEqual(expected)
    }
    expect(await create()).toMatchObject({ created: false, record: { id: created.record.id } })
    await expect(create({ ...input, destination: { kind: 'general' } })).rejects.toMatchObject({ code: 'conflict' })
    await pool.query('UPDATE workspace_members SET home_department_id=$3 WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.userId, destinationDepartment])
    const general = await create({ ...input, idempotencyKey: randomUUID(), destination: { kind: 'general' } })
    expect((await pool.query('SELECT scope_snapshot FROM association_orders WHERE id=$1', [general.record.id])).rows[0].scope_snapshot.compartments).toEqual([`team:${sourceDepartment}`])
    // Downgrade keeps the configured home, unlike edge deletion which canonically clears it.
    await pool.query("UPDATE department_edges SET clearance='public' WHERE workspace_id=$1 AND department_id=$2 AND user_id=$3", [f.workspaceId, destinationDepartment, f.userId])
    await expect(create()).rejects.toMatchObject({ code: 'not_authorized' })
    // A protected source already supplies its destination; General sources exercise the unavailable home.
    await pool.query("UPDATE entities SET compartments='{}' WHERE id=$1", [f.contactId])
    const revokedPreview = await preview()
    expect(JSON.stringify(revokedPreview)).not.toContain(destinationDepartment)
    expect(revokedPreview.choices).not.toEqual(expect.arrayContaining([expect.objectContaining({ destination: null })]))
    expect(revokedPreview.choices).toEqual(expect.arrayContaining([expect.objectContaining({ destination: { kind: 'general' } })]))
    await pool.query('UPDATE entities SET compartments=$2 WHERE id=$1', [f.contactId, [`team:${sourceDepartment}`]])
    await pool.query('DELETE FROM department_edges WHERE workspace_id=$1 AND department_id=$2 AND user_id=$3', [f.workspaceId, sourceDepartment, f.userId])
    await expect(preview()).rejects.toMatchObject({ code: 'not_authorized' })
    expect((await pool.query('SELECT count(*)::int n FROM association_orders WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(2)
  })

  it.each(['project', 'assistant'] as const)('[COMP:crm/association-source-scope] preserves the %s execution ceiling on operational writes, counts and saved/live floors', async axis => {
    const f = await fixture({ capacity: 10 }, true, { capacity: 10 })
    const assistantId = randomUUID(), otherAssistant = randomUUID(), projectId = randomUUID()
    await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Fictional project','fictional project',$3)", [projectId, f.workspaceId, f.userId])
    await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [f.workspaceId])
    for (const id of [assistantId, otherAssistant]) await pool.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Fictional scope assistant','standard','confidential')", [id, f.workspaceId])
    const grant = { workspaceId: f.workspaceId, userId: f.userId, assistantId, base: 'confidential' as const, departments: {}, contextDepartment: null, binding: null, cap: null }
    const run = <T>(restricted: boolean, operation: () => T) => runWithAgentAccess({ workspaceId: f.workspaceId, userId: f.userId,
      clearance: 'confidential', compartments: null, mutationCompartments: null, projectIds: restricted ? [] : null,
      visibilityAssistantIds: restricted ? [assistantId] : null, departmentRead: grant }, operation)
    const keys = createCrmIntegrationStore(pool, appPool)
    const key = await run(true, () => keys.create(f.workspaceId, f.userId, {
      label: 'Fictional restricted integration', expiresAt: '2099-01-01T00:00:00Z',
      departmentBinding: { assistantId, departmentIds: [], cap: 'internal' },
      grants: [{ operation: 'association.read', selectors: { eventIds: 'all' } },
        { operation: 'association.orders.write', selectors: { eventIds: 'all' } },
        { operation: 'crm.entitlements.read', selectors: { planIds: 'all' } }],
    }))
    const principal = (await keys.authenticate(key.oneTimeSecret))!
    const integrationActor = { credentialKind: 'integration_key' as const, credentialId: principal.credentialId, integration: principal }
    const protect = () => pool.query('UPDATE entities SET project_ids=$2,assistant_id=$3 WHERE id=$1', [f.contactId, axis === 'project' ? [projectId] : [], axis === 'assistant' ? otherAssistant : null])
    const clear = () => pool.query("UPDATE entities SET project_ids='{}',assistant_id=NULL WHERE id=$1", [f.contactId])
    await protect()
    await expect(run(true, () => f.order())).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(commerce.createOrder(f.workspaceId, OrderCreateSchema.parse({ contactId: f.contactId,
      idempotencyKey: randomUUID(), lines: [{ ticketId: f.ticketId, quantity: 1, attendees: [{ contactId: f.contactId, name: 'Fictional attendee' }] }] }), integrationActor)).rejects.toMatchObject({ code: 'not_authorized' })
    expect((await pool.query('SELECT count(*)::int n FROM association_orders WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
    const order = await run(false, () => f.order())
    const plan = await commerce.upsertPlan(f.workspaceId, PlanInputSchema.parse({ key: 'scope-member', name: 'Fictional scope membership', currency: 'USD', feeMinor: 0, billingPeriod: 'manual' }), f.actor)
    const membership = await operations.execute(f.context, { kind: 'grant_entitlement', contactId: f.contactId, planId: String(plan.record.id),
      idempotencyKey: randomUUID(), status: 'active', startsAt: '2026-01-01T00:00:00Z', renewalMode: 'manual' })
    const assertHidden = async () => {
      // No HTTP wrapper or ambient execution context: the store reloads the saved key limits.
      await expect(commerce.getOrder(f.workspaceId, String(order.record.id), integrationActor)).rejects.toMatchObject({ code: 'not_authorized' })
      expect(await commerce.listOrders(f.workspaceId, { limit: 1, cursor: null }, integrationActor)).toMatchObject({ items: [], total: 0, financialSummary: [] })
      expect(await commerce.listOperationalRoster(f.workspaceId, f.eventId, { limit: 1, cursor: null }, integrationActor)).toMatchObject({ items: [] })
      expect(await commerce.listMemberships(f.workspaceId, f.contactId, {}, integrationActor)).toEqual([])

      await expect(run(true, () => commerce.getOrder(f.workspaceId, String(order.record.id), f.actor))).rejects.toMatchObject({ code: 'not_authorized' })
      expect(await run(true, () => commerce.listOrders(f.workspaceId, { limit: 10, cursor: null }, f.actor))).toMatchObject({ items: [], total: 0, financialSummary: [] })
      expect(await run(true, () => commerce.listOperationalRoster(f.workspaceId, f.eventId, { limit: 10, cursor: null }, f.actor))).toMatchObject({ items: [] })
      expect(await run(true, () => commerce.listMemberships(f.workspaceId, f.contactId, {}, f.actor))).toEqual([])
    }
    await assertHidden()
    // Declassifying the live contact must not lower any saved operational floor.
    await clear()
    await assertHidden()
    expect(await run(false, () => commerce.listOrders(f.workspaceId, { limit: 10, cursor: null }, f.actor))).toMatchObject({ total: 1 })
    expect(await run(false, () => commerce.listMemberships(f.workspaceId, f.contactId, {}, f.actor))).toMatchObject([{ id: membership.record.id }])
    // Keep only the parent's floor: the child roster still must not disclose it.
    await pool.query(`UPDATE association_registrations SET scope_snapshot=scope_snapshot || '{"projectIds":[],"assistantId":null}'::jsonb,
      scope_sources=(SELECT jsonb_agg(s || '{"projectIds":[],"assistantId":null}'::jsonb) FROM jsonb_array_elements(scope_sources) s) WHERE workspace_id=$1`, [f.workspaceId])
    await assertHidden()
    // With every saved floor cleared, a newly restricted live contact still hides all records.
    for (const table of ['association_orders', 'association_memberships']) await pool.query(`UPDATE ${table} SET scope_snapshot=scope_snapshot || '{"projectIds":[],"assistantId":null}'::jsonb,
      scope_sources=(SELECT jsonb_agg(s || '{"projectIds":[],"assistantId":null}'::jsonb) FROM jsonb_array_elements(scope_sources) s) WHERE workspace_id=$1`, [f.workspaceId])
    await protect()
    await assertHidden()
    await clear()
    const permitted = await commerce.createOrder(f.workspaceId, OrderCreateSchema.parse({ contactId: f.contactId,
      idempotencyKey: randomUUID(), lines: [{ ticketId: f.ticketId, quantity: 1, attendees: [{ contactId: f.contactId, name: 'Fictional attendee' }] }] }), integrationActor)
    expect(await commerce.getOrder(f.workspaceId, String(permitted.record.id), integrationActor)).toMatchObject({ id: permitted.record.id })
  })

  it('[COMP:crm/association-source-scope] retains confidential department access with public General clearance', async () => {
    const f = await fixture(), departmentId = randomUUID(), assistantId = randomUUID()
    await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [f.workspaceId])
    await pool.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Fictional department assistant','standard','public')", [assistantId, f.workspaceId])
    await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fictional department',$3,'team',$1::text,$4)", [departmentId, f.workspaceId, f.userId, `team:${departmentId}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Fictional department','team',$3)", [f.workspaceId, `team:${departmentId}`, departmentId])
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store') ON CONFLICT DO NOTHING", [f.workspaceId, departmentId, f.userId])
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,assistant_id,clearance,origin) VALUES($1,$2,'assistant',$3,'confidential','store')", [f.workspaceId, departmentId, assistantId])
    await pool.query("UPDATE entities SET sensitivity='confidential',compartments=$2 WHERE id=$1", [f.contactId, [`team:${departmentId}`]])
    await runWithAgentAccess({ workspaceId: f.workspaceId, userId: f.userId, clearance: 'public', compartments: [`team:${departmentId}`], projectIds: [], visibilityAssistantIds: [assistantId],
      departmentRead: { workspaceId: f.workspaceId, userId: f.userId, assistantId, base: 'public', departments: { [departmentId]: 'confidential' }, contextDepartment: null, binding: null, cap: null } }, async () => {
      const order = await f.order()
      expect(await commerce.getOrder(f.workspaceId, String(order.record.id), f.actor)).toMatchObject({ id: order.record.id })
      expect(await commerce.listOrders(f.workspaceId, { limit: 10, cursor: null }, f.actor)).toMatchObject({ total: 1 })
      expect(await commerce.listOperationalRoster(f.workspaceId, f.eventId, { limit: 10, cursor: null }, f.actor)).toMatchObject({ items: [expect.objectContaining({ orderId: order.record.id })] })
    })
  })

  it('[COMP:crm/association-source-scope] stores buyer and attendee protection on both order and registrations', async () => {
    const f = await fixture()
    const guest = randomUUID(), teamA = randomUUID(), teamB = randomUUID()
    for (const id of [teamA, teamB]) await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fictional department',$3,'team',$1::text,$4)", [id, f.workspaceId, f.userId, `team:${id}`])
    for (const id of [teamA, teamB]) await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Fictional department','team',$3)", [f.workspaceId, `team:${id}`, id])
    for (const id of [teamA, teamB]) await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store') ON CONFLICT DO NOTHING", [f.workspaceId, id, f.userId])
    await pool.query("UPDATE entities SET sensitivity='internal',compartments=$2 WHERE id=$1", [f.contactId, [`team:${teamA}`]])
    await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source,sensitivity,compartments) VALUES($1,$2,'person','Fictional protected guest',$3,'manual','confidential',$4)", [guest, f.workspaceId, f.userId, [`team:${teamB}`]])
    const order = await commerce.createOrder(f.workspaceId, OrderCreateSchema.parse({ contactId: f.contactId, idempotencyKey: randomUUID(),
      lines: [{ ticketId: f.ticketId, quantity: 1, attendees: [{ contactId: guest, name: 'Fictional protected guest' }] }] }), f.actor)
    const row = (await pool.query('SELECT scope_snapshot,scope_sources FROM association_orders WHERE id=$1', [order.record.id])).rows[0]
    expect(row.scope_snapshot.sensitivity).toBe('confidential')
    expect(row.scope_snapshot.compartments).toEqual([`team:${teamA}`, `team:${teamB}`].sort())
    expect(row.scope_sources.map((source: {resourceId:string}) => source.resourceId).sort()).toEqual([guest, f.contactId].sort())
    expect((await pool.query('SELECT scope_snapshot,scope_sources FROM association_registrations WHERE order_id=$1', [order.record.id])).rows).toEqual([row])
  })

  it('[COMP:crm/association-source-scope] refuses new orders without current source department membership, including owners', async () => {
    const f = await fixture({ capacity: 10 }, true, { capacity: 10 })
    const departmentId = randomUUID(), departmentOwnerId = randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [departmentOwnerId])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')", [f.workspaceId, departmentOwnerId])
    await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [f.workspaceId])
    await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fictional restricted department',$3,'team',$1::text,$4)", [departmentId, f.workspaceId, departmentOwnerId, `team:${departmentId}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Fictional restricted department','team',$3)", [f.workspaceId, `team:${departmentId}`, departmentId])
    await pool.query("UPDATE entities SET sensitivity='confidential',compartments=$2 WHERE id=$1", [f.contactId, [`team:${departmentId}`]])
    expect((await pool.query('SELECT compartments FROM entities WHERE id=$1', [f.contactId])).rows[0].compartments).toEqual([`team:${departmentId}`])
    expect((await pool.query('SELECT department_id FROM department_edges WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.userId])).rows).toEqual([])
    await expect(f.order()).rejects.toMatchObject({ code: 'not_authorized' })
    expect((await pool.query('SELECT count(*)::int n FROM association_orders WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'internal','store')", [f.workspaceId, departmentId, f.userId])
    await expect(f.order()).rejects.toMatchObject({ code: 'not_authorized' })
    await pool.query("UPDATE department_edges SET clearance='confidential' WHERE department_id=$1 AND user_id=$2", [departmentId, f.userId])
    await pool.query('UPDATE entities SET user_id=$2 WHERE id=$1', [f.contactId, departmentOwnerId])
    await expect(f.order()).rejects.toMatchObject({ code: 'not_authorized' })
    await pool.query('UPDATE entities SET user_id=NULL WHERE id=$1', [f.contactId])
    await expect(commerce.createOrder(f.workspaceId, OrderCreateSchema.parse({ contactId: f.contactId,
      idempotencyKey: randomUUID(), lines: [{ ticketId: f.ticketId, quantity: 1, attendees: [{ contactId: f.contactId, name: 'Fictional attendee' }] }] }),
    { credentialKind: 'assistant', credentialId: randomUUID(), actingUserId: f.userId })).rejects.toMatchObject({ code: 'not_authorized' })
    const directEvent = await commerce.upsertEvent(f.workspaceId, EventInputSchema.parse({ ...eventInput, slug: 'direct-fixture', capacity: null }), f.actor)
    const participationCommand = { kind: 'record_participation' as const, eventId: String(directEvent.record.id), contactId: f.contactId,
      sourceKind: 'manual' as const, sourceId: randomUUID(), attendeeName: 'Fictional direct attendee', status: 'registered' as const, metadata: {} }
    const direct = await operations.execute(f.context, participationCommand)
    const directId = String(direct.record.id)
    const readDirect = () => createDbCrmIntakeReadStore().listParticipation(f.workspaceId, { eventId: participationCommand.eventId, limit: 1 }, f.context.actor)
    expect(await readDirect()).toMatchObject({ participation: [{ id: directId }] })
    expect((await operations.execute(f.context, participationCommand)).duplicate).toBe(true)
    expect(await commerce.getRegistrationManagement(f.workspaceId, directId, f.actor)).toMatchObject({ sourceKind: 'manual' })
    expect(await commerce.listOperationalRoster(f.workspaceId, participationCommand.eventId, { limit: 10, cursor: null }, f.actor)).toMatchObject({ items: [{ id: directId }] })
    const directScope = (await pool.query('SELECT scope_snapshot,scope_sources FROM association_registrations WHERE id=$1', [directId])).rows[0]
    expect(directScope.scope_snapshot.compartments).toEqual([`team:${departmentId}`])
    expect(directScope.scope_snapshot.sensitivity).toBe('confidential')
    expect(directScope.scope_sources).toHaveLength(1)
    const membershipPlan = await commerce.upsertPlan(f.workspaceId, PlanInputSchema.parse({ key: 'fictional-member', name: 'Fictional membership', currency: 'USD', feeMinor: 0, billingPeriod: 'manual' }), f.actor)
    const entitlementCommand = { kind: 'grant_entitlement' as const, contactId: f.contactId, planId: String(membershipPlan.record.id),
      idempotencyKey: randomUUID(), status: 'active' as const, startsAt: '2026-01-01T00:00:00Z', renewalMode: 'manual' as const }
    const membership = await operations.execute(f.context, entitlementCommand)
    const membershipId = String(membership.record.id)
    expect((await operations.execute(f.context, entitlementCommand)).duplicate).toBe(true)
    const readMemberships = () => commerce.listMemberships(f.workspaceId, f.contactId, {}, f.actor)
    const readEntitlements = () => createDbCrmIntakeReadStore().listEntitlements(f.workspaceId, { contactId: f.contactId }, f.context.actor)
    expect(await readMemberships()).toMatchObject([{ id: membershipId }])
    expect(await readEntitlements()).toMatchObject({ entitlements: [{ id: membershipId }] })
    expect((await pool.query('SELECT scope_snapshot FROM association_memberships WHERE id=$1', [membershipId])).rows[0].scope_snapshot).toMatchObject({ sensitivity: 'confidential', compartments: [`team:${departmentId}`] })
    const retryKey = randomUUID()
    const saved = await f.order([f.ticketId!], retryKey)
    expect(saved.created).toBe(true)
    expect((await commerce.getOrder(f.workspaceId, String(saved.record.id), f.actor))?.id).toBe(saved.record.id)
    const registrationId = (await pool.query('SELECT id FROM association_registrations WHERE order_id=$1', [saved.record.id])).rows[0].id as string
    const registrations = () => commerce.listEventRegistrations(f.workspaceId, f.eventId, { limit: 1, cursor: null }, f.actor)
    const roster = () => commerce.listOperationalRoster(f.workspaceId, f.eventId, { limit: 1, cursor: null }, f.actor)
    expect(await registrations()).toMatchObject({ items: [{ id: registrationId }] })
    expect(await roster()).toMatchObject({ items: [{ id: registrationId }] })
    expect(await commerce.getRegistrationManagement(f.workspaceId, registrationId, f.actor)).toMatchObject({ sourceKind: 'commerce' })
    const list = () => commerce.listOrders(f.workspaceId, { limit: 1, cursor: null }, f.actor)
    expect(await list()).toMatchObject({ total: 1, items: [{ id: saved.record.id }], financialSummary: [{ orderCount: 1 }] })
    await pool.query("UPDATE department_edges SET expires_at=clock_timestamp()-interval '1 second' WHERE department_id=$1 AND user_id=$2", [departmentId, f.userId])
    expect(await readMemberships()).toEqual([])
    expect(await readEntitlements()).toMatchObject({ entitlements: [], nextCursor: null })
    await expect(operations.execute(f.context, entitlementCommand)).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(operations.execute(f.context, { ...entitlementCommand, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(operations.execute(f.context, { kind: 'update_entitlement', entitlementId: membershipId, status: 'cancelled' })).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(commerce.updateMembership(f.workspaceId, membershipId, { status: 'cancelled' }, f.actor)).rejects.toMatchObject({ code: 'not_authorized' })
    expect((await pool.query('SELECT status FROM association_memberships WHERE id=$1', [membershipId])).rows[0].status).toBe('active')
    expect(await readDirect()).toMatchObject({ participation: [], nextCursor: null })
    await expect(operations.execute(f.context, participationCommand)).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(operations.execute(f.context, { ...participationCommand, sourceId: randomUUID() })).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(operations.execute(f.context, { kind: 'update_participation', participationId: directId, status: 'attended' })).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(operations.execute(f.context, { kind: 'correct_participation_check_in', participationId: directId, expectedStatus: 'attended', reason: 'Fictional correction' })).rejects.toMatchObject({ code: 'not_authorized' })
    expect((await pool.query('SELECT status FROM association_registrations WHERE id=$1', [directId])).rows[0].status).toBe('registered')
    expect(await commerce.listOperationalRoster(f.workspaceId, participationCommand.eventId, { limit: 10, cursor: null }, f.actor)).toMatchObject({ items: [] })
    await expect(f.order()).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(f.order([f.ticketId!], retryKey)).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(commerce.getOrder(f.workspaceId, String(saved.record.id), f.actor)).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(commerce.cancelOrder(f.workspaceId, String(saved.record.id), f.actor)).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(commerce.confirmFreeOrder(f.workspaceId, String(saved.record.id), f.actor)).rejects.toMatchObject({ code: 'not_authorized' })
    expect(await registrations()).toMatchObject({ items: [], nextCursor: null })
    expect(await roster()).toMatchObject({ items: [], nextCursor: null })
    await expect(commerce.getRegistrationManagement(f.workspaceId, registrationId, f.actor)).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(commerce.updateRegistration(f.workspaceId, registrationId, { status: 'cancelled' }, f.actor)).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(commerce.correctRegistrationCheckIn(f.workspaceId, registrationId, { expectedStatus: 'checked_in', reason: 'Fictional correction' }, f.actor)).rejects.toMatchObject({ code: 'not_authorized' })
    expect((await pool.query('SELECT status FROM association_registrations WHERE id=$1', [registrationId])).rows[0].status).toBe('reserved')
    expect((await pool.query('SELECT status FROM association_orders WHERE id=$1', [saved.record.id])).rows[0].status).toBe('pending')
    expect(await list()).toMatchObject({ total: 0, items: [], financialSummary: [], nextCursor: null })
    // Loosening a source cannot retroactively loosen the stored order floor.
    await pool.query("UPDATE entities SET compartments='{}',sensitivity='internal' WHERE id=$1", [f.contactId])
    await expect(commerce.getOrder(f.workspaceId, String(saved.record.id), f.actor)).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(f.order([f.ticketId!], retryKey)).rejects.toMatchObject({ code: 'not_authorized' })
    expect(await list()).toMatchObject({ total: 0, items: [], financialSummary: [] })
    expect((await pool.query('SELECT count(*)::int n FROM association_orders WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(1)
  })

  it('[COMP:crm/association-source-scope] renews live sources for detail and replay and withholds legacy evidence', async () => {
    const f = await fixture()
    const key = randomUUID(), saved = await f.order([f.ticketId!], key), id = String(saved.record.id)
    expect((await f.order([f.ticketId!], key)).created).toBe(false)
    await pool.query('UPDATE entities SET scope_held=true WHERE id=$1', [f.contactId])
    expect(await commerce.listOrders(f.workspaceId, { limit: 1, cursor: null }, f.actor)).toMatchObject({ total: 0, items: [], financialSummary: [] })
    await expect(commerce.getOrder(f.workspaceId, id, f.actor)).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(f.order([f.ticketId!], key)).rejects.toMatchObject({ code: 'not_authorized' })
    await pool.query('UPDATE entities SET scope_held=false WHERE id=$1', [f.contactId])
    expect((await commerce.getOrder(f.workspaceId, id, f.actor))?.id).toBe(id)
    await pool.query('UPDATE association_orders SET scope_snapshot=NULL,scope_sources=NULL WHERE id=$1', [id])
    expect(await commerce.listOrders(f.workspaceId, { limit: 1, cursor: null }, f.actor)).toMatchObject({ total: 0, items: [], financialSummary: [] })
    const refusal = { code: 'not_authorized', details: { recovery: {
      preserveRequestIdentity: true, mutationRetry: 'never_automatic',
      historicalEvidence: 'original_trustworthy_evidence_required',
    } } }
    await expect(commerce.getOrder(f.workspaceId, id, f.actor)).rejects.toMatchObject(refusal)
    await expect(f.order([f.ticketId!], key)).rejects.toMatchObject(refusal)
    const retained = await pool.query('SELECT id,scope_snapshot,scope_sources FROM association_orders WHERE workspace_id=$1', [f.workspaceId])
    expect(retained.rows).toEqual([{ id, scope_snapshot: null, scope_sources: null }])
  })

  it('[COMP:crm/association-source-scope] protects ordinary and imported membership evidence and retries', async () => {
    const f = await fixture(), jobId = randomUUID()
    const plan = await commerce.upsertPlan(f.workspaceId, PlanInputSchema.parse({ key: 'fictional-member', name: 'Fictional membership', currency: 'USD', feeMinor: 0, billingPeriod: 'manual' }), f.actor)
    const ordinary = { contactId: f.contactId, planId: String(plan.record.id), idempotencyKey: randomUUID(), status: 'active' as const, startsAt: '2020-01-01T00:00:00Z', renewalMode: 'manual' as const }
    const manual = await commerce.createMembership(f.workspaceId, ordinary, f.actor)
    expect((await commerce.createMembership(f.workspaceId, ordinary, f.actor)).created).toBe(false)
    const { renewalMode, ...importFields } = ordinary
    const input = AssociationSourceMembershipImportSchema.parse({ ...importFields, targetRenewalMode: renewalMode, idempotencyKey: randomUUID(), importJobId: jobId, importRow: 1,
      source: 'fixture_import', sourceSite: 'https://members.example', sourceMembershipId: 'fictional-membership-1', sourcePlanId: 'fictional-plan-1',
      sourceStatus: 'active', sourceRenewalStatus: 'manual', purchasedAt: '2020-01-01T00:00:00Z' })
    const actor = { credentialKind: 'import' as const, credentialId: jobId, actingUserId: f.userId }
    const imported = await commerce.importSourceMembership(f.workspaceId, input, actor)
    expect((await commerce.importSourceMembership(f.workspaceId, input, actor)).created).toBe(false)
    for (const id of [manual.record.id, imported.record.id]) {
      const row = (await pool.query('SELECT scope_snapshot,scope_sources FROM association_memberships WHERE id=$1', [id])).rows[0]
      expect(row.scope_snapshot.sensitivity).toBe('internal')
      expect(row.scope_sources).toEqual([expect.objectContaining({ resourceId: f.contactId })])
    }
    expect(await commerce.listMemberships(f.workspaceId, f.contactId, {}, f.actor)).toHaveLength(2)
    await pool.query('UPDATE entities SET scope_held=true WHERE id=$1', [f.contactId])
    await expect(commerce.createMembership(f.workspaceId, ordinary, f.actor)).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(commerce.importSourceMembership(f.workspaceId, input, actor)).rejects.toMatchObject({ code: 'not_authorized' })
    expect(await commerce.listMemberships(f.workspaceId, f.contactId, {}, f.actor)).toEqual([])
  })

  it('[COMP:crm/association-source-scope] preserves imported order evidence and refuses replay after source revocation', async () => {
    const f = await fixture(), jobId = randomUUID()
    const input = AssociationSourceOrderImportSchema.parse({ importJobId: jobId, importRow: 1, contactId: f.contactId,
      source: 'fixture_import', sourceSite: 'https://tickets.example', sourceOrderId: 'fictional-order-1',
      occurredAt: '2020-01-01T00:00:00Z', status: 'paid', currency: 'USD', subtotalMinor: 0, discountMinor: 0, totalMinor: 0,
      lines: [{ ticketId: f.ticketId, quantity: 1, unitPriceMinor: 0, lineTotalMinor: 0,
        attendees: [{ contactId: f.contactId, name: 'Fictional imported attendee', sourceRegistrationId: 'fictional-registration-1', status: 'confirmed' }] }] })
    const actor = { credentialKind: 'import' as const, credentialId: jobId, actingUserId: f.userId }
    const saved = await commerce.importSourceOrder(f.workspaceId, input, actor)
    const evidence = (await pool.query('SELECT scope_snapshot,scope_sources FROM association_orders WHERE id=$1', [saved.record.id])).rows[0]
    expect(evidence.scope_sources).toEqual([expect.objectContaining({ resourceId: f.contactId })])
    expect((await pool.query('SELECT scope_snapshot,scope_sources FROM association_registrations WHERE order_id=$1', [saved.record.id])).rows).toEqual([evidence])
    expect((await commerce.importSourceOrder(f.workspaceId, input, actor)).created).toBe(false)
    await pool.query('UPDATE entities SET scope_held=true WHERE id=$1', [f.contactId])
    await expect(commerce.importSourceOrder(f.workspaceId, input, actor)).rejects.toMatchObject({ code: 'not_authorized' })
    expect((await pool.query('SELECT count(*)::int n FROM association_orders WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(1)
  })

  it('serializes different ticket types competing for the last event place', async () => {
    const f = await fixture({}, true, { capacity: 10 })
    const second = await commerce.upsertTicket(f.workspaceId, f.eventId, TicketInputSchema.parse({ ...ticketInput, key: 'second', capacity: 10 }), f.actor)
    const results = await Promise.allSettled([f.order(), f.order([String(second.record.id)])])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toMatchObject([{ reason: { code: 'not_available' } }])
    expect(await boundaries(f.workspaceId)).toMatchObject([{ event_type: 'association.inventory.sold_out', payload: { eventId: f.eventId, ticketId: null, capacity: 1, used: 1, revision: 1 } }])
    expect((await pool.query('SELECT count(*)::int n FROM association_registrations WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(1)
  })
  it('takes a consistent lock order for overlapping multi-ticket orders and releases exactly one boundary per scope', async () => {
    const f = await fixture({ capacity: 2 })
    const second = String((await commerce.upsertTicket(f.workspaceId, f.eventId, TicketInputSchema.parse({ ...ticketInput, key: 'second' }), f.actor)).record.id)
    const key = randomUUID(), results = await Promise.all([f.order([f.ticketId!, second], key), f.order([f.ticketId!, second], key)])
    expect(results.filter(r => r.created)).toHaveLength(1)
    const id = String(results[0].record.id)
    expect((await boundaries(f.workspaceId)).map(r => r.event_type)).toEqual(Array(3).fill('association.inventory.sold_out'))
    await commerce.cancelOrder(f.workspaceId, id, f.actor)
    await commerce.cancelOrder(f.workspaceId, id, f.actor)
    const events = await boundaries(f.workspaceId)
    expect(events.filter(r => r.event_type === 'association.inventory.available')).toHaveLength(3)
    expect(new Set(events.map(r => r.event_key)).size).toBe(6)
  })
  it.each([
    [{ registrationOpensAt: '2098-01-01T00:00:00Z' }, {}],
    [{ registrationClosesAt: '2000-01-01T00:00:00Z' }, {}],
    [{}, { saleStartsAt: '2098-01-01T00:00:00Z' }],
    [{}, { saleEndsAt: '2000-01-01T00:00:00Z' }],
    [{ startsAt: '1999-01-01T12:00:00Z', endsAt: '1999-01-01T14:00:00Z' }, {}],
  ])('enforces every event/ticket window and refuses ended events (%j)', async (ep, tp) => {
    const f = await fixture(ep, true, tp)
    await expect(f.order()).rejects.toMatchObject({ code: 'not_available' })
    expect(await boundaries(f.workspaceId)).toEqual([])
  })
  it('free confirmation preserves occupied stock without inventing payment evidence; expiry emits availability once', async () => {
    const f = await fixture(), reserved = await f.order(), id = String(reserved.record.id)
    await commerce.confirmFreeOrder(f.workspaceId, id, f.actor)
    await commerce.confirmFreeOrder(f.workspaceId, id, f.actor)
    expect(await boundaries(f.workspaceId)).toHaveLength(2)
    expect((await pool.query('SELECT count(*)::int n FROM association_provider_events WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
    const g = await fixture(), expiring = String((await g.order()).record.id)
    await pool.query("UPDATE association_orders SET reservation_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expiring])
    await pool.query("UPDATE association_registrations SET reservation_expires_at=clock_timestamp()-interval '1 second' WHERE order_id=$1", [expiring])
    const actor = { credentialKind: 'system_job' as const, credentialId: `association_expiry:${randomUUID()}` }
    await commerce.expireDueOrder(g.workspaceId, expiring, actor)
    await commerce.expireDueOrder(g.workspaceId, expiring, actor)
    expect((await boundaries(g.workspaceId)).filter(r => r.event_type === 'association.inventory.available')).toHaveLength(2)
  })
  it('rolls back stock and boundary events when order audit fails, then permits a retry', async () => {
    const f = await fixture()
    await pool.query("ALTER TABLE association_audit_log ADD CONSTRAINT fixture_refuse_inventory_audit CHECK(action<>'order.reserved') NOT VALID")
    try { await expect(f.order()).rejects.toThrow(); expect(await boundaries(f.workspaceId)).toEqual([]) }
    finally { await pool.query('ALTER TABLE association_audit_log DROP CONSTRAINT fixture_refuse_inventory_audit') }
    expect((await f.order()).created).toBe(true)
  })
  it('blocks generic live participation for capacity-only and ticket-only events on every source vocabulary', async () => {
    for (const f of [await fixture({}, false), await fixture({ capacity: null })]) {
      for (const sourceKind of ['manual', 'form', 'import', 'workflow'] as const) {
        await expect(f.participation({ sourceKind })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'association_order_required' } })
      }
      await expect(f.participation({ sourceKind: 'import', historicalImport: true })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'historical_event_not_ended' } })
      await expect(pool.query("INSERT INTO association_registrations(workspace_id,event_id,attendee_name,status,source_kind,source_id,request_fingerprint) VALUES($1,$2,'Fictional attendee','registered','manual',$3,'fixture')", [f.workspaceId, f.eventId, randomUUID()])).rejects.toMatchObject({ code: '23514' })
    }
  })
  it('keeps unconstrained participation and counts pre-existing admissions when capacity is later introduced', async () => {
    const f = await fixture({ capacity: null }, false), saved = await f.participation()
    expect(saved.record).toMatchObject({ historicalImport: false, status: 'registered' })
    await commerce.upsertEvent(f.workspaceId, EventInputSchema.parse(eventInput), f.actor)
    expect(await boundaries(f.workspaceId)).toMatchObject([{ payload: { used: 1, capacity: 1, revision: 1 } }])
    await operations.execute(f.context, { kind: 'update_participation', participationId: String(saved.record.id), status: 'cancelled' })
    expect((await boundaries(f.workspaceId)).filter(r => r.event_type === 'association.inventory.available')).toHaveLength(1)
    await expect(commerce.updateRegistration(f.workspaceId, String(saved.record.id), { status: 'checked_in' }, f.actor)).rejects.toMatchObject({ code: 'invalid_transition' })
  })
  it('corrects commerce and generic check-ins only from the expected state and retains the reason in audit', async () => {
    const commerceFixture = await fixture(), order = await commerceFixture.order(), orderId = String(order.record.id)
    await commerce.confirmFreeOrder(commerceFixture.workspaceId, orderId, commerceFixture.actor)
    const registrationId = String((await pool.query('SELECT id FROM association_registrations WHERE order_id=$1', [orderId])).rows[0].id)
    await commerce.updateRegistration(commerceFixture.workspaceId, registrationId, { status: 'checked_in' }, commerceFixture.actor)
    const corrected = await commerce.correctRegistrationCheckIn(commerceFixture.workspaceId, registrationId,
      { expectedStatus: 'checked_in', reason: 'Scanned the wrong badge' }, commerceFixture.actor)
    expect(corrected).toMatchObject({ status: 'confirmed', checkedInAt: null })
    await expect(commerce.correctRegistrationCheckIn(commerceFixture.workspaceId, registrationId,
      { expectedStatus: 'checked_in', reason: 'Repeated correction' }, commerceFixture.actor))
      .rejects.toMatchObject({ code: 'conflict', details: { currentStatus: 'confirmed' } })
    const genericFixture = await fixture({ capacity: null }, false), participation = await genericFixture.participation({ status: 'attended' })
    const participationId = String(participation.record.id)
    const generic = await operations.execute(genericFixture.context, { kind: 'correct_participation_check_in', participationId,
      expectedStatus: 'attended', reason: 'Marked the wrong attendee' })
    expect(generic.record).toMatchObject({ status: 'registered', checkedInAt: null })
    await expect(operations.execute(genericFixture.context, { kind: 'correct_participation_check_in', participationId,
      expectedStatus: 'attended', reason: 'Repeated correction' })).rejects.toMatchObject({ code: 'conflict', details: { currentStatus: 'registered' } })
    const audits = (await pool.query("SELECT action,metadata FROM association_audit_log WHERE (workspace_id=$1 OR workspace_id=$2) AND action IN('registration.check_in_corrected','crm.participation.check_in_corrected') ORDER BY action",
      [commerceFixture.workspaceId, genericFixture.workspaceId])).rows
    expect(audits).toEqual([
      { action: 'crm.participation.check_in_corrected', metadata: { from: 'attended', to: 'registered', reason: 'Marked the wrong attendee' } },
      { action: 'registration.check_in_corrected', metadata: { from: 'checked_in', to: 'confirmed', reason: 'Scanned the wrong badge' } },
    ])
  })
  it('requires an explicit human admin historical import, records provenance and never consumes stock', async () => {
    const f = await fixture({ startsAt: '1999-01-01T12:00:00Z', endsAt: '1999-01-01T14:00:00Z' })
    const patch = { sourceKind: 'import' as const, historicalImport: true, sourceId: randomUUID(), status: 'attended' as const }
    const saved = await f.participation(patch)
    expect(saved.record).toMatchObject({ historicalImport: true })
    expect((await f.participation(patch)).duplicate).toBe(true)
    expect(await boundaries(f.workspaceId)).toEqual([])
    expect((await pool.query('SELECT used FROM association_inventory_boundaries WHERE workspace_id=$1', [f.workspaceId])).rows.every(r => r.used === 0)).toBe(true)
    const foreign = await fixture()
    await expect(f.participation({ ...patch, sourceId: randomUUID() }, { ...f.context, actor: { kind: 'user', userId: foreign.userId } })).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(f.participation({ ...patch, sourceId: randomUUID() }, { ...f.context, actor: { kind: 'workflow', workflowId: randomUUID(), runId: randomUUID(), userId: f.userId } })).rejects.toMatchObject({ code: 'not_authorized' })
    await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.userId])
    await expect(f.participation(patch)).rejects.toMatchObject({ code: 'not_authorized' })
  })
  it('rechecks membership after waiting and refuses an expired discount without holding stock', async () => {
    const f = await fixture({}, true, { priceMinor: 1000, memberPriceMinor: 500 })
    const planId = (await pool.query("INSERT INTO association_membership_plans(workspace_id,plan_key,name,currency,fee_minor,billing_period) VALUES($1,'fixture','Fixture','USD',0,'annual') RETURNING id", [f.workspaceId])).rows[0].id
    const id = (await pool.query("INSERT INTO association_memberships(workspace_id,contact_id,plan_id,idempotency_key,request_fingerprint,status,starts_at,ends_at) VALUES($1,$2,$3,$4,repeat('a',64),'active',clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day') RETURNING id", [f.workspaceId, f.contactId, planId, randomUUID()])).rows[0].id
    const writer = await pool.connect(); let pending: ReturnType<typeof f.order> | undefined
    try {
      await writer.query('BEGIN')
      await writer.query("UPDATE association_memberships SET ends_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id])
      pending = f.order(undefined, undefined, true)
      const rejected = expect(pending).rejects.toMatchObject({ code: 'member_price_ineligible' })
      await blocked('contact_id=ANY')
      await writer.query('COMMIT'); await rejected
      expect(await boundaries(f.workspaceId)).toEqual([])
    } finally { await writer.query('ROLLBACK').catch(() => {}); writer.release(); if (pending) await pending.catch(() => {}) }
  })
  it('rechecks every attendee after a membership row-lock wait and refuses a concurrent revocation', async () => {
    const f = await fixture({}, true, { priceMinor: 1000, memberPriceMinor: 500 })
    const attendeeId = randomUUID()
    await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source) VALUES($1,$2,'person','Fictional member attendee',$3,'manual')", [attendeeId, f.workspaceId, f.userId])
    const planId = (await pool.query("INSERT INTO association_membership_plans(workspace_id,plan_key,name,currency,fee_minor,billing_period) VALUES($1,'fixture','Fixture','USD',0,'annual') RETURNING id", [f.workspaceId])).rows[0].id
    await pool.query("INSERT INTO association_memberships(workspace_id,contact_id,plan_id,idempotency_key,request_fingerprint,status,starts_at,ends_at) VALUES($1,$2,$3,$4,repeat('a',64),'active',clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day')", [f.workspaceId, f.contactId, planId, randomUUID()])
    const attendeeMembershipId = (await pool.query("INSERT INTO association_memberships(workspace_id,contact_id,plan_id,idempotency_key,request_fingerprint,status,starts_at,ends_at) VALUES($1,$2,$3,$4,repeat('b',64),'active',clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day') RETURNING id", [f.workspaceId, attendeeId, planId, randomUUID()])).rows[0].id
    await commerce.upsertTicket(f.workspaceId, f.eventId, TicketInputSchema.parse({ ...ticketInput,
      priceMinor: 1000, memberPriceMinor: 500, eligiblePlanKeys: ['fixture'], eligibilityRequired: true, eligibilityScope: 'buyer_and_attendees' }), f.actor)
    const input = OrderCreateSchema.parse({ contactId: f.contactId, idempotencyKey: randomUUID(), lines: [{
      ticketId: f.ticketId, quantity: 1, useMemberPrice: true,
      attendees: [{ contactId: attendeeId, name: 'Fictional member attendee' }],
    }] })
    const writer = await pool.connect(); let pending: ReturnType<typeof commerce.createOrder> | undefined
    try {
      await writer.query('BEGIN')
      await writer.query("UPDATE association_memberships SET status='cancelled' WHERE id=$1", [attendeeMembershipId])
      pending = commerce.createOrder(f.workspaceId, input, f.actor)
      const rejected = expect(pending).rejects.toMatchObject({ code: 'attendee_membership_ineligible', details: { attendeeIndex: 0 } })
      await blocked('contact_id=ANY')
      await writer.query('COMMIT'); await rejected
      expect(await boundaries(f.workspaceId)).toEqual([])
    } finally { await writer.query('ROLLBACK').catch(() => {}); writer.release(); if (pending) await pending.catch(() => {}) }
  })
  it('revalidates free-order expiry after a row-lock wait', async () => {
    const f = await fixture(), id = String((await f.order()).record.id), writer = await pool.connect()
    let pending: ReturnType<typeof commerce.confirmFreeOrder> | undefined
    try {
      await writer.query('BEGIN')
      await writer.query("UPDATE association_orders SET reservation_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [id])
      pending = commerce.confirmFreeOrder(f.workspaceId, id, f.actor)
      const rejected = expect(pending).rejects.toMatchObject({ code: 'not_available' })
      await blocked('SELECT status,total_minor::text')
      await writer.query('COMMIT'); await rejected
      expect((await commerce.getOrder(f.workspaceId, id))?.status).toBe('pending')
    } finally { await writer.query('ROLLBACK').catch(() => {}); writer.release(); if (pending) await pending.catch(() => {}) }
  })
  it('emits capacity changes once and refuses opposite-order overlapping checkout without deadlocking', async () => {
    const f = await fixture({ capacity: 2 })
    const second = String((await commerce.upsertTicket(f.workspaceId, f.eventId, TicketInputSchema.parse({ ...ticketInput, key: 'second' }), f.actor)).record.id)
    const raced = await Promise.allSettled([f.order([f.ticketId!, second]), f.order([second, f.ticketId!])])
    expect(raced.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(raced.filter(r => r.status === 'rejected')).toMatchObject([{ reason: { code: 'not_available' } }])
    await commerce.upsertEvent(f.workspaceId, EventInputSchema.parse({ ...eventInput, capacity: 3 }), f.actor)
    await commerce.upsertEvent(f.workspaceId, EventInputSchema.parse({ ...eventInput, capacity: 3 }), f.actor)
    expect((await boundaries(f.workspaceId)).filter(r => r.event_type === 'association.inventory.available')).toMatchObject([{ payload: { ticketId: null, revision: 2 } }])
  })
  it('isolates member reads by workspace and denies application-role boundary writes', async () => {
    const f = await fixture(), g = await fixture(), client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.current_user_id',$1,true)", [f.userId])
      expect((await client.query('SELECT id FROM association_inventory_boundaries WHERE workspace_id=$1', [f.workspaceId])).rowCount).toBe(2)
      expect((await client.query('SELECT id FROM association_inventory_boundaries WHERE workspace_id=$1', [g.workspaceId])).rowCount).toBe(0)
      expect((await client.query('UPDATE association_inventory_boundaries SET sold_out=true WHERE workspace_id=$1', [f.workspaceId])).rowCount).toBe(0)
    } finally { await client.query('ROLLBACK'); client.release() }
  })
})
