import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { associationWaitlistDefinition, AssociationWaitlistOfferInputSchema, CrmOperationsCommandSchema, type CrmOperationsContext, type AssociationActor } from '@use-brian/core'
import { getPool, getAppPool } from '../client.js'
import { createAssociationWorkspaceModulesStore } from '../../association/workspace-module.js'
import { createAssociationStore } from '../association-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createCrmIntegrationStore } from '../crm-integration-store.js'
import { EventInputSchema, TicketInputSchema } from '../../association/domain.js'
import { _resetCoalescerForTests } from '../../brain-stream/notify.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), appPool = getAppPool(), modules = createAssociationWorkspaceModulesStore()
const commerce = createAssociationStore(), operations = createCrmOperationsService(createDbCrmOperationsStore()), keys = createCrmIntegrationStore()
async function fixture(capacity = 1) {
  const workspaceId = randomUUID(), userId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Waitlist fixture',$2)", [workspaceId, userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId])
  await modules.act(workspaceId, userId, 'association', { action: 'enable', expectedVersion: 1 })
  const actor: AssociationActor = { credentialKind: 'user', credentialId: userId, actingUserId: userId }
  const eventId = String((await commerce.upsertEvent(workspaceId, EventInputSchema.parse({ slug: 'fixture', title: 'Waitlist fixture', startsAt: '2099-01-01T12:00:00Z', endsAt: '2099-01-01T14:00:00Z', timezone: 'UTC', mode: 'venue', status: 'published', capacity }), actor)).record.id)
  const ticketId = String((await commerce.upsertTicket(workspaceId, eventId, TicketInputSchema.parse({ key: 'standard', name: 'Standard', currency: 'USD', priceMinor: 0, status: 'on_sale', capacity }), actor)).record.id)
  const context: CrmOperationsContext = { workspaceId, actor: { kind: 'user', userId }, authority: { role: 'owner', canConfigure: true, canWrite: true, trustedIdentitySources: [] } }
  await operations.execute(context, CrmOperationsCommandSchema.parse({ kind: 'save_consent_purpose', purposeKey: 'updates', label: 'Updates', wordingVersion: '1', wording: 'Fixture wording' }))
  const definition = associationWaitlistDefinition({ eventId, ticketId, purposeKey: 'updates' })
  const definitionId = String((await operations.execute(context, CrmOperationsCommandSchema.parse({ kind: 'save_intake_definition', definitionKey: 'waitlist', label: 'Waitlist fixture', definition }))).record.id)
  const submit = async () => (await operations.execute(context, { kind: 'record_submission', definitionKey: 'waitlist', idempotencyKey: randomUUID(), fields: { name: 'Fictional guest', email: `${randomUUID()}@example.com`, updates_consent: true, association_event_id: eventId, association_ticket_id: ticketId } })).record
  const submission = await submit(), submissionId = String(submission.submissionId), contactId = String(submission.contactId)
  const offer = (promotionId = randomUUID(), id = submissionId, actorOverride = actor, patch = {}) => commerce.offerWaitlistPlace(workspaceId, AssociationWaitlistOfferInputSchema.parse({ submissionId: id, promotionId, ...patch }), actorOverride)
  return { workspaceId, userId, actor, context, eventId, ticketId, definitionId, definition, submissionId, contactId, submit, offer }
}
async function effects(ws: string) {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM entities WHERE workspace_id=$1 AND kind='person') people,
    (SELECT count(*)::int FROM association_orders WHERE workspace_id=$1) orders,
    (SELECT count(*)::int FROM association_registrations WHERE workspace_id=$1) registrations,
    (SELECT count(*)::int FROM association_waitlist_offers WHERE workspace_id=$1) offers,
    (SELECT count(*)::int FROM association_audit_log WHERE workspace_id=$1 AND action='waitlist.offered') audit`, [ws])).rows[0]
}
describe('[COMP:crm/association-waitlist] Actual intake-backed offers', () => {
  afterAll(async () => { _resetCoalescerForTests(); await pool.end(); await appPool.end() })
  it('filters protected waitlist sources before paging and restores the existing offer state after reauthorization', async () => {
    const f = await fixture(), offered = await f.offer(), department = randomUUID(), custodian = randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [custodian])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')", [f.workspaceId, custodian])
    await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Cedar',$3,'team',$1::text,$4)", [department, f.workspaceId, custodian, `team:${department}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Cedar','team',$3)", [f.workspaceId, `team:${department}`, department])
    await pool.query('UPDATE entities SET compartments=$2 WHERE id=$1', [f.contactId, [`team:${department}`]])
    expect(await commerce.listWaitlist(f.workspaceId, { limit: 1, cursor: null }, f.actor)).toMatchObject({ items: [], nextCursor: null })
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'internal','store')", [f.workspaceId, department, f.userId])
    expect((await commerce.listWaitlist(f.workspaceId, { limit: 1, cursor: null }, f.actor)).items).toMatchObject([
      { id: f.submissionId, waitlistState: 'offered', orderId: offered.record.orderId },
    ])
    expect(await effects(f.workspaceId)).toEqual({ people: 1, orders: 1, registrations: 1, offers: 1, audit: 1 })
    await pool.query('UPDATE workspace_members SET home_department_id=$3 WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.userId, department])
    const protectedSubmission = await f.submit()
    await pool.query('UPDATE workspace_members SET home_department_id=NULL WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.userId])
    await commerce.cancelOrder(f.workspaceId, String(offered.record.orderId), f.actor)
    await pool.query("UPDATE entities SET compartments='{}' WHERE id=$1", [protectedSubmission.contactId])
    await pool.query('DELETE FROM department_edges WHERE department_id=$1 AND user_id=$2', [department, f.userId])
    const promotionId = randomUUID(), submissionId = String(protectedSubmission.submissionId)
    await expect(f.offer(promotionId, submissionId)).rejects.toMatchObject({ code: 'not_authorized' })
    expect((await commerce.listWaitlist(f.workspaceId, { limit: 100, cursor: null }, f.actor)).items.map(row => row.id)).not.toContain(submissionId)
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'internal','store')", [f.workspaceId, department, f.userId])
    const restored = await f.offer(promotionId, submissionId)
    expect((await pool.query('SELECT scope_snapshot FROM association_orders WHERE id=$1', [restored.record.orderId])).rows[0].scope_snapshot.compartments).toEqual([`team:${department}`])
    expect((await f.offer(promotionId, submissionId)).created).toBe(false)
  })
  it('preserves the intake person and atomically links one ordinary order through concurrent retries', async () => {
    const f = await fixture(), promotionId = randomUUID(), result = await Promise.all([f.offer(promotionId), f.offer(promotionId)])
    expect(result.filter(r => r.created)).toHaveLength(1)
    expect(result[0].record.id).toBe(result[1].record.id)
    expect(result[0].record.order).toMatchObject({ contactId: f.contactId, status: 'pending', totalMinor: '0' })
    expect(await effects(f.workspaceId)).toEqual({ people: 1, orders: 1, registrations: 1, offers: 1, audit: 1 })
    expect((await commerce.listWaitlist(f.workspaceId, { limit: 100, cursor: null }, f.actor)).items).toMatchObject([{ id: f.submissionId, waitlistState: 'offered', orderId: result[0].record.orderId }])
    await expect(f.offer(promotionId, f.submissionId, f.actor, { reservationMinutes: 30 })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await commerce.confirmFreeOrder(f.workspaceId, String(result[0].record.orderId), f.actor)
    expect((await commerce.listWaitlist(f.workspaceId, { limit: 100, cursor: null }, f.actor)).items).toMatchObject([{ waitlistState: 'converted' }])
    expect((await pool.query('SELECT id FROM association_provider_events WHERE workspace_id=$1', [f.workspaceId])).rows).toEqual([])
  })
  it('serializes different promotion identities for one submission and different submissions for the last place', async () => {
    const f = await fixture(), raced = await Promise.allSettled([f.offer(), f.offer()])
    expect(raced.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(raced.filter(r => r.status === 'rejected')).toMatchObject([{ reason: { code: 'conflict', details: { reason: 'waitlist_offer_exists' } } }])
    const g = await fixture(), second = await g.submit(), contested = await Promise.allSettled([g.offer(), g.offer(randomUUID(), String(second.submissionId))])
    expect(contested.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(contested.filter(r => r.status === 'rejected')).toMatchObject([{ reason: { code: 'not_available' } }])
    expect(await effects(g.workspaceId)).toMatchObject({ people: 2, orders: 1, offers: 1, registrations: 1 })
  })
  it('rolls back the order, inventory and link if the offer audit fails, and safely retries', async () => {
    const f = await fixture(), promotionId = randomUUID()
    await pool.query("ALTER TABLE association_audit_log ADD CONSTRAINT fixture_refuse_waitlist_audit CHECK(action<>'waitlist.offered') NOT VALID")
    try { await expect(f.offer(promotionId)).rejects.toThrow(); expect(await effects(f.workspaceId)).toEqual({ people: 1, orders: 0, registrations: 0, offers: 0, audit: 0 }) }
    finally { await pool.query('ALTER TABLE association_audit_log DROP CONSTRAINT fixture_refuse_waitlist_audit') }
    expect((await f.offer(promotionId)).created).toBe(true)
  })
  it('requires a new explicit promotion after cancellation, keeps old replay stable and denies new work while disabled', async () => {
    const f = await fixture(), promotionId = randomUUID(), first = await f.offer(promotionId)
    await commerce.cancelOrder(f.workspaceId, String(first.record.orderId), f.actor)
    const second = await f.offer()
    expect(second.record.orderId).not.toBe(first.record.orderId)
    await commerce.cancelOrder(f.workspaceId, String(second.record.orderId), f.actor)
    const state = await modules.get(f.workspaceId, 'association')
    await modules.act(f.workspaceId, f.userId, 'association', { action: 'request_disable', expectedVersion: state.version })
    expect((await f.offer(promotionId)).record.orderId).toBe(first.record.orderId)
    await expect(f.offer()).rejects.toMatchObject({ code: 'module_disabled' })
    const queued = await f.submit()
    expect(queued.submissionId).toBeTruthy()
  })
  it('refuses closed or tampered submissions and uses the original version after definition edits', async () => {
    const f = await fixture()
    await pool.query("UPDATE association_enquiries SET status='resolved' WHERE id=$1", [f.submissionId])
    await expect(f.offer()).rejects.toMatchObject({ details: { reason: 'waitlist_source_changed' } })
    expect((await commerce.listWaitlist(f.workspaceId, { limit: 100, cursor: null }, f.actor)).items).toEqual([])
    expect((await commerce.listWaitlist(f.workspaceId, { limit: 100, cursor: null, includeClosed: true }, f.actor)).items).toMatchObject([{ waitlistState: 'closed' }])
    const g = await fixture()
    await operations.execute(g.context, CrmOperationsCommandSchema.parse({ kind: 'save_intake_definition', definitionId: g.definitionId, definitionKey: 'waitlist', label: 'Updated fixture', expectedVersion: 1, definition: { ...g.definition, queueKey: 'other' } }))
    expect((await g.offer()).created).toBe(true)
    const h = await fixture()
    await pool.query("UPDATE association_enquiries SET submitted_data=jsonb_set(submitted_data,'{association_ticket_id}',to_jsonb($2::text)) WHERE id=$1", [h.submissionId, randomUUID()])
    await expect(h.offer()).rejects.toMatchObject({ details: { reason: 'waitlist_definition_required' } })
  })
  it('rechecks legacy credential grants before fresh or replayed offers and requires both event and definition authority', async () => {
    const f = await fixture()
    // Unbound integration credentials are intentionally unavailable under v2.
    await pool.query('UPDATE workspaces SET department_read_v2=false WHERE id=$1', [f.workspaceId])
    const create = async (definitionId = f.definitionId) => {
      const credential = await keys.create(f.workspaceId, f.userId, { label: 'Waitlist backend', expiresAt: '2099-01-01T00:00:00Z', grants: [
        { operation: 'association.orders.write', selectors: { eventIds: [f.eventId] } },
        { operation: 'crm.submissions.write', selectors: { definitionIds: [definitionId] } }] })
      const principal = (await keys.authenticate(credential.oneTimeSecret))!
      return { credentialKind: 'integration_key' as const, credentialId: principal.credentialId, integration: principal }
    }
    const otherDefinition = await operations.execute(f.context, CrmOperationsCommandSchema.parse({ kind: 'save_intake_definition', definitionKey: 'other', label: 'Other fixture', definition: f.definition }))
    const wrong = await create(String(otherDefinition.record.id))
    await expect(f.offer(randomUUID(), f.submissionId, wrong)).rejects.toMatchObject({ code: 'integration_scope_denied' })
    const actor = await create(), promotionId = randomUUID()
    expect((await f.offer(promotionId, f.submissionId, actor)).created).toBe(true)
    await keys.revoke(f.workspaceId, f.userId, actor.credentialId)
    await expect(f.offer(promotionId, f.submissionId, actor)).rejects.toMatchObject({ code: 'credential_revoked' })
    await expect(f.offer(randomUUID(), f.submissionId, actor)).rejects.toMatchObject({ code: 'credential_revoked' })
  })
  it('traverses more than 100 submissions with scoped filters before the limit and rejects changed cursor filters', async () => {
    const f = await fixture()
    await pool.query(`INSERT INTO association_enquiries(workspace_id,contact_id,source,source_submission_id,request_fingerprint,subject,message,queue_key,status,submitted_data,definition_id,definition_version_id,definition_schema_snapshot,scope_snapshot,scope_sources)
      SELECT workspace_id,contact_id,source,gen_random_uuid()::text,request_fingerprint,subject,message,queue_key,status,submitted_data,definition_id,definition_version_id,definition_schema_snapshot,scope_snapshot,scope_sources
      FROM association_enquiries CROSS JOIN generate_series(1,104) WHERE id=$1`, [f.submissionId])
    const first = await commerce.listWaitlist(f.workspaceId, { limit: 100, cursor: null, allowedEventIds: [f.eventId], allowedDefinitionIds: [f.definitionId] }, f.actor)
    const next = await commerce.listWaitlist(f.workspaceId, { limit: 100, cursor: first.nextCursor, allowedEventIds: [f.eventId], allowedDefinitionIds: [f.definitionId] }, f.actor)
    expect(first.items).toHaveLength(100); expect(next.items).toHaveLength(5); expect(next.nextCursor).toBeNull()
    expect(new Set([...first.items, ...next.items].map(r => r.id)).size).toBe(105)
    expect((await commerce.listWaitlist(f.workspaceId, { limit: 100, cursor: null, allowedDefinitionIds: [randomUUID()] }, f.actor)).items).toEqual([])
    await expect(commerce.listWaitlist(f.workspaceId, { limit: 100, cursor: first.nextCursor, eventId: f.eventId }, f.actor)).rejects.toMatchObject({ code: 'invalid_input' })
  })
  it('enforces immutable links, workspace foreign keys and member read-only RLS', async () => {
    const f = await fixture(), g = await fixture(), offer = await f.offer(), other = await g.offer(), client = await appPool.connect()
    await expect(pool.query('UPDATE association_waitlist_offers SET promotion_id=$2 WHERE id=$1', [offer.record.id, randomUUID()])).rejects.toMatchObject({ code: '23514' })
    await expect(pool.query(`INSERT INTO association_waitlist_offers(workspace_id,submission_id,ticket_id,promotion_id,order_id,request_fingerprint,actor_kind,actor_credential_id)
      VALUES($1,$2,$3,$4,$5,repeat('a',64),'user',$6)`, [f.workspaceId, g.submissionId, f.ticketId, randomUUID(), other.record.orderId, f.userId])).rejects.toMatchObject({ code: '23503' })
    try {
      await client.query('BEGIN'); await client.query("SELECT set_config('app.current_user_id',$1,true)", [f.userId])
      expect((await client.query('SELECT id FROM association_waitlist_offers WHERE workspace_id=$1', [f.workspaceId])).rowCount).toBe(1)
      expect((await client.query('SELECT id FROM association_waitlist_offers WHERE workspace_id=$1', [g.workspaceId])).rowCount).toBe(0)
      expect((await client.query('DELETE FROM association_waitlist_offers WHERE workspace_id=$1', [f.workspaceId])).rowCount).toBe(0)
    } finally { await client.query('ROLLBACK'); client.release() }
  })
})
