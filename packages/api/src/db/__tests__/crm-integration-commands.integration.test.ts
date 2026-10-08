import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { AssociationCommandSchema, CrmOperationsCommandSchema, CRM_INTEGRATION_OPERATIONS, CRM_INTEGRATION_RESOURCE_CATALOG,
  type CrmIntegrationGrant, type AssociationContext } from '@use-brian/core'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createDbCrmIntakeReadStore } from '../crm-intake-store.js'
import { createCrmIntegrationRecordReadStore } from '../crm-integration-records.js'
import { createAssociationService } from '../../association/service.js'
import { createAssociationStore } from '../association-store.js'
import { createAssociationWorkspaceModulesStore } from '../../association/workspace-module.js'
import { createCrmIntegrationStore } from '../crm-integration-store.js'
import { crmIntegrationContext } from '../../routes/crm-integration.js'
import { getPool } from '../client.js'
import { EventInputSchema, OrderCreateSchema, TicketInputSchema } from '../../association/domain.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const app = new pg.Pool({ connectionString: process.env.DATABASE_URL_APP })
const crm = createCrmOperationsService(createDbCrmOperationsStore(pool))
const commerce = createAssociationStore(pool)
const modules = createAssociationWorkspaceModulesStore(pool, app)
const keys = createCrmIntegrationStore(pool, app)
const association = createAssociationService({ crmService: crm, store: commerce, modules })
const legacy = { credentialKind: 'api_key' as const, credentialId: 'fixture' }
const event = (slug: string) => EventInputSchema.parse({ slug, title: slug, startsAt: '2099-01-01T12:00:00Z', endsAt: '2099-01-01T14:00:00Z', timezone: 'UTC', mode: 'venue', status: 'published', capacity: 100 })
const ticket = TicketInputSchema.parse({ key: 'general', name: 'General', currency: 'USD', priceMinor: 0, status: 'on_sale', capacity: 100 })
async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), contactId = randomUUID()
  await pool.query('INSERT INTO users (id,auth_provider_id) VALUES ($1::uuid,$1::text)', [userId])
  await pool.query(`INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'Command fixture',$2)`, [workspaceId, userId])
  await pool.query(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'owner')`, [workspaceId, userId])
  await pool.query(`INSERT INTO entities (id,workspace_id,kind,display_name,created_by_user_id,source) VALUES ($1,$2,'person','Fixture person',$3,'manual')`, [contactId, workspaceId, userId])
  const allGrants: CrmIntegrationGrant[] = CRM_INTEGRATION_OPERATIONS.map((operation) => ({ operation,
    selectors: Object.fromEntries(CRM_INTEGRATION_RESOURCE_CATALOG[operation].map((dimension) => [dimension, 'all'])) }))
  const credential = await keys.create(workspaceId, userId, { label: 'Fixture command key', expiresAt: '2099-01-01T00:00:00Z', grants: allGrants })
  const credentialId = credential.id
  const context = (grants: CrmIntegrationGrant[]) => crmIntegrationContext({ workspaceId, credentialId, grants })
  const vertical = (grants: CrmIntegrationGrant[]): AssociationContext => {
    const ctx = context(grants)
    return { ...ctx, authority: { ...ctx.authority, canRead: true, canReconcileProvider: true } }
  }
  const reads = (grants: CrmIntegrationGrant[]) => createDbCrmIntakeReadStore({ workspaceId, credentialId, grants })
  return { workspaceId, userId, credentialId, contactId, context, vertical, reads, allGrants }
}

async function blockedBy(pid: number): Promise<number> {
  for (let attempt=0;attempt<200;attempt++) {
    const rows=await pool.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
      WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'`,[pid])
    if (rows.rows[0]) return rows.rows[0].pid
    await setTimeout(10)
  }
  throw new Error('Fixture did not reach the intended PostgreSQL lock wait')
}

async function workspaceEffects(workspaceId: string) {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM association_events WHERE workspace_id=$1) AS events,
    (SELECT count(*)::int FROM association_audit_log WHERE workspace_id=$1) AS audit,
    (SELECT count(*)::int FROM crm_domain_event_outbox WHERE workspace_id=$1) AS outbox`,[workspaceId])).rows[0]
}

describe('[COMP:api/crm-integration-auth] Actual command and joined resource isolation', () => {
  afterAll(async () => { await Promise.all([pool.end(), app.end(), getPool().end()]) })
  it('retains a narrower caller Project ceiling across direct CRM read-store invocations', async () => {
    const f = await fixture(), project = randomUUID()
    await pool.query('INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,$3,lower($3),$4)', [project, f.workspaceId, 'Fictional protected project', f.userId])
    await pool.query('UPDATE entities SET project_ids=ARRAY[$2::uuid] WHERE id=$1', [f.contactId, project])
    const context = f.context(f.allGrants)
    await crm.execute(context, CrmOperationsCommandSchema.parse({ kind: 'save_consent_purpose', purposeKey: 'updates', label: 'Updates', wordingVersion: '1', wording: 'Fictional consent wording' }))
    await crm.execute(context, CrmOperationsCommandSchema.parse({ kind: 'record_consent', contactId: f.contactId, purposeKey: 'updates', action: 'granted', source: 'fixture' }))
    const principal = { workspaceId: f.workspaceId, credentialId: f.credentialId, grants: f.allGrants,
      executionLimits: { clearance: 'internal' as const, compartments: null, mutationCompartments: null,
        projectIds: [] as string[], visibilityAssistantIds: null, sharedAudience: false } }
    const narrowed = createDbCrmIntakeReadStore(principal)
    // The store pins a copy rather than retaining a caller-mutable array.
    principal.executionLimits.projectIds.push(project)
    await expect(narrowed.getConsent(f.workspaceId, f.contactId)).rejects.toMatchObject({ code: 'not_authorized' })
    expect((await f.reads(f.allGrants).getConsent(f.workspaceId, f.contactId)).events).toHaveLength(1)
    await expect(narrowed.getConsent(f.workspaceId, f.contactId)).rejects.toMatchObject({ code: 'not_authorized' })
  })

  it('preserves finite consent selectors and current key authority for evidence reduction',async()=>{
    const f=await fixture(),ctx=f.context(f.allGrants)
    for(const purposeKey of ['updates','other_fixture']) {
      await crm.execute(ctx,CrmOperationsCommandSchema.parse({kind:'save_consent_purpose',purposeKey,label:purposeKey,wordingVersion:'1',wording:'Fictional consent wording'}))
      await crm.execute(ctx,CrmOperationsCommandSchema.parse({kind:'record_consent',contactId:f.contactId,purposeKey,action:'granted',source:'fixture'}))
    }
    const reads=f.reads([{operation:'crm.consent.read',selectors:{purposeKeys:['updates']}}])
    const evidence=await reads.getConsent(f.workspaceId,f.contactId)
    expect(evidence.events.map(row=>row.purposeKey)).toEqual(['updates'])
    expect(evidence.purposes.map(row=>row.purposeKey)).toEqual(['updates'])
    await expect(reads.checkSendability(f.workspaceId,f.contactId,'email','other_fixture')).rejects.toMatchObject({code:'integration_scope_denied'})
    expect((await reads.checkSendability(f.workspaceId,f.contactId,'email','updates')).reasons).toContain('contact_method_missing')
    await expect(createDbCrmIntakeReadStore().getConsent(f.workspaceId,f.contactId)).rejects.toMatchObject({code:'not_authorized'})
    await keys.revoke(f.workspaceId,f.userId,f.credentialId)
    await expect(reads.getConsent(f.workspaceId,f.contactId)).rejects.toMatchObject({code:'credential_revoked'})
  })

  it('keeps generic catalogs available while disabled and enforces configuration resource selectors inside the transaction', async () => {
    const f = await fixture()
    const ctx = f.context([{ operation: 'crm.catalog.configure', selectors: { eventIds: 'all', planIds: 'all' } }])
    const created = await crm.execute(ctx, CrmOperationsCommandSchema.parse({ kind: 'save_event', ...event('allowed') }))
    const id = String(created.record.id)
    const limited = f.context([{ operation: 'crm.catalog.configure', selectors: { eventIds: [id] } }])
    await crm.execute(limited, CrmOperationsCommandSchema.parse({ kind: 'save_event', ...event('allowed'), title: 'Updated fixture' }))
    const before = await pool.query('SELECT count(*) FROM association_audit_log WHERE workspace_id=$1', [f.workspaceId])
    await expect(crm.execute(limited, CrmOperationsCommandSchema.parse({ kind: 'save_event', ...event('not-selected') }))).rejects.toMatchObject({ code: 'integration_scope_denied' })
    const after = await pool.query('SELECT count(*) FROM association_audit_log WHERE workspace_id=$1', [f.workspaceId])
    expect(after.rows).toEqual(before.rows)
    expect((await modules.get(f.workspaceId, 'association')).state).toBe('disabled')
    const audit = await pool.query('SELECT actor_kind,actor_credential_id FROM association_audit_log WHERE workspace_id=$1', [f.workspaceId])
    expect(audit.rows).toHaveLength(2)
    expect(audit.rows.every((row) => row.actor_kind === 'integration_key' && row.actor_credential_id === f.credentialId)).toBe(true)
  })
  it('refuses stale revoked, expired, nonexistent and foreign-workspace principals without domain or audit changes', async () => {
    const f=await fixture(), context=f.context(f.allGrants)
    const command=CrmOperationsCommandSchema.parse({ kind: 'save_event',...event('stale') })
    const before=await workspaceEffects(f.workspaceId)
    await keys.revoke(f.workspaceId,f.userId,f.credentialId)
    await expect(crm.execute(context,command)).rejects.toMatchObject({ code: 'credential_revoked' })
    const expired=await fixture()
    await pool.query(`UPDATE crm_integration_credentials SET created_at=clock_timestamp()-interval '1 day',
      expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`,[expired.credentialId])
    await expect(crm.execute(expired.context(expired.allGrants),command)).rejects.toMatchObject({ code: 'credential_revoked' })
    const live=await fixture()
    await expect(crm.execute({ ...live.context(live.allGrants),workspaceId: f.workspaceId },command)).rejects.toMatchObject({ code: 'credential_revoked' })
    await expect(crm.execute(crmIntegrationContext({ workspaceId: f.workspaceId,credentialId: randomUUID(),grants: f.allGrants }),command))
      .rejects.toMatchObject({ code: 'credential_revoked' })
    expect(await workspaceEffects(f.workspaceId)).toEqual(before)
    expect(await workspaceEffects(expired.workspaceId)).toEqual({ events: 0,audit: 0,outbox: 0 })
  })

  it('requires current stored grants as well as a request ceiling and fails closed on malformed persisted authority', async () => {
    const f=await fixture(), created=await commerce.upsertEvent(f.workspaceId,event('restricted'),legacy)
    const other=await commerce.upsertEvent(f.workspaceId,event('other'),legacy)
    const issued=await keys.create(f.workspaceId,f.userId,{ label: 'Narrow fixture',expiresAt: '2099-01-01T00:00:00Z',
      grants: [{ operation: 'crm.catalog.configure',selectors: { eventIds: [String(created.record.id)] } }] })
    const exaggerated=crmIntegrationContext({ workspaceId: f.workspaceId,credentialId: issued.id,grants: f.allGrants })
    const before=await workspaceEffects(f.workspaceId)
    await expect(crm.execute(exaggerated,CrmOperationsCommandSchema.parse({ kind: 'save_event',...event('other') })))
      .rejects.toMatchObject({ code: 'integration_scope_denied',dimension: 'eventIds' })
    const readOnly=await keys.create(f.workspaceId,f.userId,{ label: 'Read fixture',expiresAt: '2099-01-01T00:00:00Z',
      grants: [{ operation: 'crm.records.read',selectors: {} }] })
    await expect(crm.execute(crmIntegrationContext({ workspaceId: f.workspaceId,credentialId: readOnly.id,grants: f.allGrants }),
      CrmOperationsCommandSchema.parse({ kind: 'save_event',...event('restricted') }))).rejects.toMatchObject({ code: 'integration_scope_denied' })
    // Simulate corrupt persisted authority without changing the immutable-grant trigger.
    await pool.query('DELETE FROM crm_integration_credential_grants WHERE credential_id=$1',[issued.id])
    await pool.query(`INSERT INTO crm_integration_credential_grants(workspace_id,credential_id,operation,selectors)
      VALUES($1,$2,'crm.catalog.configure','{"eventIds":[]}')`,[f.workspaceId,issued.id])
    await expect(crm.execute(exaggerated,CrmOperationsCommandSchema.parse({ kind: 'save_event',...event('restricted') })))
      .rejects.toMatchObject({ code: 'credential_revoked' })
    expect(other.record.id).not.toBe(created.record.id)
    expect(await workspaceEffects(f.workspaceId)).toEqual(before)
  })

  it('checks expiry after waiting for the credential lock, not before the wait', async () => {
    const f=await fixture(), locker=await pool.connect()
    let pending: Promise<unknown> | undefined
    try {
      await locker.query('BEGIN')
      await locker.query(`UPDATE crm_integration_credentials SET created_at=clock_timestamp()-interval '1 day',
        expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1`,[f.credentialId])
      const pid=(await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending=crm.execute(f.context(f.allGrants),CrmOperationsCommandSchema.parse({ kind: 'save_event',...event('expired-after-wait') }))
        .then((value) => value,(error) => error)
      await blockedBy(pid)
      await locker.query(`SELECT pg_sleep(greatest(0,extract(epoch FROM (expires_at-clock_timestamp())))+0.025)
        FROM crm_integration_credentials WHERE id=$1`,[f.credentialId])
      await locker.query('COMMIT')
      expect(await pending).toMatchObject({ code: 'credential_revoked' })
      expect(await workspaceEffects(f.workspaceId)).toEqual({ events: 0,audit: 0,outbox: 0 })
    } finally { await locker.query('ROLLBACK'); locker.release(); await pending }
  },15_000)

  it('renews retained catalog reads and intersects current and original resource selectors', async () => {
    const f = await fixture()
    for (const slug of ['cedar-event', 'harbor-event']) {
      await crm.execute(f.context(f.allGrants), CrmOperationsCommandSchema.parse({ kind: 'save_event', ...event(slug) }))
    }
    const ids = (await pool.query('SELECT id FROM association_events WHERE workspace_id=$1 ORDER BY slug', [f.workspaceId])).rows.map(row => row.id)
    const broad = f.reads(f.allGrants)
    const original: CrmIntegrationGrant[] = [{ operation: 'crm.catalog.read', selectors: { eventIds: [ids[0]] } }]
    const narrow = f.reads(original)
    original[0].selectors.eventIds = 'all'
    expect((await narrow.listEvents(f.workspaceId)).events.map(row => row.id)).toEqual([ids[0]])
    const issued = await keys.create(f.workspaceId, f.userId, { label: 'Harbor catalog reader', expiresAt: '2099-01-01T00:00:00Z',
      grants: [{ operation: 'crm.catalog.read', selectors: { eventIds: [ids[1]] } }] })
    const exaggerated = createDbCrmIntakeReadStore({ workspaceId: f.workspaceId, credentialId: issued.id, grants: f.allGrants })
    const disjoint = createDbCrmIntakeReadStore({ workspaceId: f.workspaceId, credentialId: issued.id,
      grants: [{ operation: 'crm.catalog.read', selectors: { eventIds: [ids[0]] } }] })
    expect((await exaggerated.listEvents(f.workspaceId)).events.map(row => row.id)).toEqual([ids[1]])
    expect((await disjoint.listEvents(f.workspaceId)).events).toEqual([])
    await keys.revoke(f.workspaceId, f.userId, f.credentialId)
    await expect(broad.listEvents(f.workspaceId)).rejects.toMatchObject({ code: 'credential_revoked' })
  })

  it.each(['revoke', 'remove-operation'] as const)('withholds a catalog read when %s wins while its query waits', async change => {
    const f = await fixture(), locker = await pool.connect()
    let pending: Promise<unknown> | undefined
    try {
      await locker.query('BEGIN')
      await locker.query('LOCK TABLE crm_intake_definitions IN ACCESS EXCLUSIVE MODE')
      const pid = (await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending = f.reads(f.allGrants).listDefinitions(f.workspaceId).then(value => value, error => error)
      await blockedBy(pid)
      if (change === 'revoke') await keys.revoke(f.workspaceId, f.userId, f.credentialId)
      else await pool.query("DELETE FROM crm_integration_credential_grants WHERE credential_id=$1 AND operation='crm.catalog.read'", [f.credentialId])
      await locker.query('COMMIT')
      expect(await pending).toMatchObject({ code: change === 'revoke' ? 'credential_revoked' : 'not_authorized' })
    } finally { await locker.query('ROLLBACK'); locker.release(); await pending }
  }, 15_000)

  it('refuses a waiting command when revocation wins admission', async () => {
    const f=await fixture(), locker=await pool.connect()
    let pending: Promise<unknown> | undefined
    try {
      await locker.query('BEGIN')
      await locker.query('UPDATE crm_integration_credentials SET revoked_at=clock_timestamp() WHERE id=$1',[f.credentialId])
      const pid=(await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending=crm.execute(f.context(f.allGrants),CrmOperationsCommandSchema.parse({ kind: 'save_event',...event('revoked-while-waiting') }))
        .then((value) => value,(error) => error)
      await blockedBy(pid)
      await locker.query('COMMIT')
      expect(await pending).toMatchObject({ code: 'credential_revoked' })
      expect(await workspaceEffects(f.workspaceId)).toEqual({ events: 0,audit: 0,outbox: 0 })
    } finally { await locker.query('ROLLBACK'); locker.release(); await pending }
  },15_000)

  it('lets an admitted command commit before revocation returns without blocking another workspace', async () => {
    const f=await fixture(), other=await fixture(), stored=await commerce.upsertEvent(f.workspaceId,event('admitted'),legacy), locker=await pool.connect()
    let write: Promise<unknown> | undefined, revoke: Promise<unknown> | undefined
    try {
      await locker.query('BEGIN')
      await locker.query('SELECT id FROM association_events WHERE id=$1 FOR UPDATE',[stored.record.id])
      const pid=(await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      write=crm.execute(f.context(f.allGrants),CrmOperationsCommandSchema.parse({ kind: 'save_event',...event('admitted'),title: 'Admitted update' }))
      const writer=await blockedBy(pid)
      revoke=keys.revoke(f.workspaceId,f.userId,f.credentialId)
      await blockedBy(writer)
      expect((await crm.execute(other.context(other.allGrants),CrmOperationsCommandSchema.parse({ kind: 'save_event',...event('independent') }))).created).toBe(true)
      await locker.query('COMMIT')
      expect(await write).toMatchObject({ record: { title: 'Admitted update' } })
      expect(await revoke).toBe(true)
      await expect(crm.execute(f.context(f.allGrants),CrmOperationsCommandSchema.parse({ kind: 'save_event',...event('after-revocation') })))
        .rejects.toMatchObject({ code: 'credential_revoked' })
      expect(await workspaceEffects(f.workspaceId)).toEqual({ events: 1,audit: 2,outbox: 0 })
    } finally { await locker.query('ROLLBACK'); locker.release(); await Promise.allSettled([write,revoke]) }
  },15_000)

  it('rechecks stale credentials before every commerce mutation including exact order and provider replay', async () => {
    const f=await fixture()
    await modules.act(f.workspaceId, f.userId, 'association', { action: 'enable',expectedVersion: 1 })
    const e=await commerce.upsertEvent(f.workspaceId,event('commerce-admission'),legacy), eventId=String(e.record.id)
    const t=await commerce.upsertTicket(f.workspaceId,eventId,{ ...ticket, priceMinor: 100 },legacy)
    const input=OrderCreateSchema.parse({ contactId: f.contactId,idempotencyKey: randomUUID(),lines: [
      { ticketId: t.record.id,quantity: 1,attendees: [{ name: 'Fixture attendee' }] },
    ] })
    const order=await commerce.createOrder(f.workspaceId,input,{ credentialKind: 'user', credentialId: f.userId, actingUserId: f.userId }), orderId=String(order.record.id)
    const registrationId=String((order.record.registrations as Array<{ id: string }>)[0].id)
    const provider={ provider: 'fixture',providerReference: 'fictional-object', amountMinor: 100, currency: 'USD',eventId: 'fixture_payment',targetStatus: 'paid',occurredAt: '2026-09-08T00:00:00Z' }
    await association.execute(f.vertical(f.allGrants), AssociationCommandSchema.parse({ kind: 'bind_order_provider', orderId, binding: { provider: provider.provider, providerReference: provider.providerReference, amountMinor: provider.amountMinor, currency: provider.currency } }))
    const paid=await association.execute(f.vertical(f.allGrants),AssociationCommandSchema.parse({ kind: 'reconcile_provider_event',orderId,event: provider }))
    expect(paid.record?.status).toBe('paid')
    const otherEvent=await commerce.upsertEvent(f.workspaceId,event('unrelated-grant'),legacy)
    const narrow=await keys.create(f.workspaceId,f.userId,{ label: 'Unrelated commerce fixture',expiresAt: '2099-01-01T00:00:00Z',grants: [
      { operation: 'crm.catalog.configure',selectors: { eventIds: [String(otherEvent.record.id)] } },
      { operation: 'association.orders.write',selectors: { eventIds: [String(otherEvent.record.id)] } },
      { operation: 'association.provider_events.write',selectors: { eventIds: [String(otherEvent.record.id)],providerKeys: ['fixture'] } },
    ] })
    const exaggerated=crmIntegrationContext({ workspaceId: f.workspaceId,credentialId: narrow.id,grants: f.allGrants })
    const narrowContext: AssociationContext={ ...exaggerated,authority: { ...exaggerated.authority,canRead: true,canReconcileProvider: true } }
    const commands=[
      { kind: 'save_ticket',eventId,ticket },
      { kind: 'create_order',order: { ...input,idempotencyKey: randomUUID() } },
      { kind: 'create_order',order: input },
      { kind: 'cancel_order',orderId },
      { kind: 'confirm_free_order',orderId },
      { kind: 'reconcile_provider_event',orderId,event: provider },
      { kind: 'update_registration',registrationId,update: { status: 'checked_in' } },
    ].map((command) => AssociationCommandSchema.parse(command))
    const before=await workspaceEffects(f.workspaceId)
    for (const command of commands) await expect(association.execute(narrowContext,command)).rejects.toMatchObject({ code: 'integration_scope_denied' })
    await keys.revoke(f.workspaceId,f.userId,f.credentialId)
    for (const command of commands) await expect(association.execute(f.vertical(f.allGrants),command)).rejects.toMatchObject({ code: 'credential_revoked' })
    expect(await workspaceEffects(f.workspaceId)).toEqual(before)
    expect((await commerce.getOrder(f.workspaceId,orderId))?.status).toBe('paid')
    expect((await pool.query('SELECT count(*)::int AS count FROM association_orders WHERE workspace_id=$1',[f.workspaceId])).rows[0].count).toBe(1)
  })
  it('filters catalog and entitlement lists before LIMIT and checks workspace even for an empty selector', async () => {
    const f = await fixture()
    const created = []
    for (const slug of ['first', 'second', 'third']) created.push(await commerce.upsertEvent(f.workspaceId, event(slug), legacy))
    const allowed = String(created[0].record.id)
    const read = f.reads([{ operation: 'crm.catalog.read', selectors: { eventIds: [allowed] } }])
    expect((await read.listEvents(f.workspaceId, { limit: 1 })).events.map((row) => row.id)).toEqual([allowed])
    expect(await read.listEntitlementPlans(f.workspaceId)).toEqual({ plans: [], nextCursor: null })
    await expect(read.listEvents(randomUUID())).rejects.toMatchObject({ code: 'integration_scope_denied' })
    await expect(read.listEntitlements(f.workspaceId)).rejects.toMatchObject({ code: 'integration_scope_denied' })
  })
  it('rejects consent and trusted-identity escalation through intake configuration before any evidence is written', async () => {
    const f = await fixture()
    const limited = f.context([{ operation: 'crm.catalog.configure', selectors: { definitionIds: 'all' } }])
    const definition = { fields: [{ key: 'choice', label: 'Choice', type: 'boolean', mapping: { kind: 'submission_only' } }],
      identityPolicy: 'new_or_review', consentMappings: [{ fieldKey: 'choice', grantedValue: true, purposeKey: 'updates' }] }
    await expect(crm.execute(limited, CrmOperationsCommandSchema.parse({ kind: 'save_intake_definition', definitionKey: 'fixture', label: 'Fixture', definition })))
      .rejects.toMatchObject({ code: 'integration_scope_denied' })
    await expect(crm.execute(limited, CrmOperationsCommandSchema.parse({ kind: 'save_intake_definition', definitionKey: 'fixture', label: 'Fixture',
      definition: { ...definition, consentMappings: [], identityPolicy: 'trusted_verified_email' } })))
      .rejects.toMatchObject({ code: 'not_authorized' })
    expect((await pool.query('SELECT count(*)::int AS count FROM crm_intake_definitions WHERE workspace_id=$1', [f.workspaceId])).rows[0].count).toBe(0)
    expect((await pool.query('SELECT count(*)::int AS count FROM association_audit_log WHERE workspace_id=$1', [f.workspaceId])).rows[0].count).toBe(0)
  })
  it('reads only CRM records in the credential workspace and traverses equal-microsecond timestamps without omission', async () => {
    const f = await fixture(), other = await fixture()
    const principal = { workspaceId: f.workspaceId, credentialId: f.credentialId,
      grants: [{ operation: 'crm.records.read' as const, selectors: {} }] }
    const records = createCrmIntegrationRecordReadStore(principal, pool)
    await pool.query(`INSERT INTO entities (workspace_id,kind,display_name,created_by_user_id,source,created_at)
      SELECT $1,'person','Fixture '||n,$2,'manual','2026-01-01T00:00:00.123456Z'::timestamptz FROM generate_series(1,102) n`, [f.workspaceId, f.userId])
    const seen: string[] = []
    let cursor: string | undefined
    do {
      const page = await records.list({ limit: 10, cursor })
      seen.push(...page.records.map((row) => String(row.id)))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(seen).toHaveLength(103)
    expect(new Set(seen).size).toBe(103)
    expect(await records.get(other.contactId)).toBeNull()
    expect(await records.get(f.contactId)).toMatchObject({ id: f.contactId, kind: 'person' })
    expect(await records.fields()).toEqual({ fields: [], nextCursor: null })
    await expect(records.list({ kind: 'knowledge' })).rejects.toThrow()
    await expect(createCrmIntegrationRecordReadStore({ ...principal, grants: [{ operation: 'association.read', selectors: { eventIds: 'all' } }] }, pool).get(f.contactId))
      .rejects.toMatchObject({ code: 'integration_scope_denied' })
  })
  it('bounds member profiles to one workspace and records field-only audited edits with stale-write protection', async () => {
    const f = await fixture(), other = await fixture()
    await pool.query(`UPDATE entities SET canonical_id='member@example.test', attributes=$3::jsonb
      WHERE workspace_id=$1 AND id=$2`, [f.workspaceId, f.contactId, JSON.stringify({
      email: 'member@example.test', phone: '+852 2000 0000', private_note: 'must remain private',
      custom_fields: { organisation_name: 'Example Org', position: 'Member', private_field: 'must remain private' },
    })])
    const principal = { workspaceId: f.workspaceId, credentialId: f.credentialId, grants: [
      { operation: 'crm.records.read' as const, selectors: {} },
      { operation: 'crm.records.write' as const, selectors: {} },
    ] }
    const profiles = createCrmIntegrationRecordReadStore(principal, pool)
    const before = await profiles.getMemberProfile(f.contactId)
    expect(before).toMatchObject({
      contactId: f.contactId, name: 'Fixture person', email: 'member@example.test',
      phone: '+852 2000 0000', organisationName: 'Example Org', position: 'Member', mailingAddress: null,
    })
    expect(await profiles.getMemberProfile(other.contactId)).toBeNull()

    const updated = await profiles.updateMemberProfile(f.contactId, {
      expectedUpdatedAt: before!.updatedAt,
      name: 'Updated member',
      phone: null,
      mailingAddress: 'Fixture address',
    })
    expect(updated).toMatchObject({ name: 'Updated member', phone: null, mailingAddress: 'Fixture address' })
    await expect(profiles.updateMemberProfile(f.contactId, {
      expectedUpdatedAt: before!.updatedAt,
      position: 'Stale edit',
    })).rejects.toMatchObject({ code: 'conflict' })
    const stored = await pool.query<{ attributes: Record<string, unknown> }>(
      'SELECT attributes FROM entities WHERE workspace_id=$1 AND id=$2', [f.workspaceId, f.contactId])
    expect(stored.rows[0].attributes).toMatchObject({
      email: 'member@example.test', private_note: 'must remain private',
      custom_fields: { organisation_name: 'Example Org', position: 'Member', mailing_address: 'Fixture address', private_field: 'must remain private' },
    })
    const audit = await pool.query<{ actor_kind: string; actor_credential_id: string; metadata: Record<string, unknown> }>(
      `SELECT actor_kind,actor_credential_id,metadata FROM association_audit_log
        WHERE workspace_id=$1 AND action='crm.member_profile.updated' AND subject_id=$2`, [f.workspaceId, f.contactId])
    expect(audit.rows).toEqual([{
      actor_kind: 'integration_key', actor_credential_id: f.credentialId,
      metadata: { fields: ['mailingAddress', 'name', 'phone'] },
    }])
    const verificationId = randomUUID()
    const emailUpdated = await profiles.updateMemberVerifiedEmail(f.contactId, {
      expectedUpdatedAt: updated!.updatedAt,
      email: 'New.Member@Example.test',
      verificationId,
    })
    expect(emailUpdated).toMatchObject({ email: 'new.member@example.test' })
    expect(await profiles.updateMemberVerifiedEmail(f.contactId, {
      expectedUpdatedAt: before!.updatedAt,
      email: 'new.member@example.test',
      verificationId,
    })).toMatchObject({ email: 'new.member@example.test' })
    const storedEmail = await pool.query<{ canonical_id: string; attributes: Record<string, unknown> }>(
      'SELECT canonical_id,attributes FROM entities WHERE workspace_id=$1 AND id=$2', [f.workspaceId, f.contactId])
    expect(storedEmail.rows[0]).toMatchObject({
      canonical_id: 'new.member@example.test', attributes: { email: 'new.member@example.test', private_note: 'must remain private' },
    })
    const emailAudit = await pool.query<{ actor_kind: string; actor_credential_id: string; metadata: Record<string, unknown> }>(
      `SELECT actor_kind,actor_credential_id,metadata FROM association_audit_log
        WHERE workspace_id=$1 AND action='crm.member_profile.email_verified' AND subject_id=$2`, [f.workspaceId, f.contactId])
    expect(emailAudit.rows).toEqual([{
      actor_kind: 'integration_key', actor_credential_id: f.credentialId,
      metadata: { fields: ['email'], verificationId },
    }])
    const duplicateId = randomUUID()
    await pool.query(`INSERT INTO entities
      (id,workspace_id,kind,display_name,canonical_id,attributes,created_by_user_id,source)
      VALUES($1,$2,'person','Duplicate email',$3,$4::jsonb,$5,'manual')`,
    [duplicateId, f.workspaceId, 'duplicate@example.test', JSON.stringify({ email: 'duplicate@example.test' }), f.userId])
    await expect(profiles.updateMemberVerifiedEmail(f.contactId, {
      expectedUpdatedAt: emailUpdated!.updatedAt,
      email: 'duplicate@example.test',
      verificationId: randomUUID(),
    })).rejects.toMatchObject({ code: 'conflict', details: { reason: 'email_already_linked' } })
    await expect(createCrmIntegrationRecordReadStore({
      ...principal, grants: [{ operation: 'crm.records.read' as const, selectors: {} }],
    }, pool).updateMemberProfile(f.contactId, {
      expectedUpdatedAt: emailUpdated!.updatedAt, name: 'Forbidden edit',
    })).rejects.toMatchObject({ code: 'integration_scope_denied' })
    await keys.revoke(f.workspaceId, f.userId, f.credentialId)
    await expect(profiles.updateMemberProfile(f.contactId, {
      expectedUpdatedAt: emailUpdated!.updatedAt, name: 'Revoked edit',
    })).rejects.toMatchObject({ code: 'credential_revoked' })
    await expect(profiles.getMemberProfile(f.contactId)).rejects.toMatchObject({ code: 'credential_revoked' })
    expect((await pool.query('SELECT display_name FROM entities WHERE id=$1', [f.contactId])).rows[0].display_name).toBe('Updated member')
  })
  it('bounds traversal across new inserts and label edits, rejects cross-query cursors and pages all field definitions', async () => {
    const f = await fixture()
    const principal = { workspaceId: f.workspaceId, credentialId: f.credentialId,
      grants: [{ operation: 'crm.records.read' as const, selectors: {} }] }
    const records = createCrmIntegrationRecordReadStore(principal, pool)
    await pool.query(`INSERT INTO entities (workspace_id,kind,display_name,created_by_user_id,source,created_at)
      SELECT $1,'person','Fixture '||n,$2,'manual','2026-01-01T00:00:00.123456Z'::timestamptz FROM generate_series(1,105) n`, [f.workspaceId, f.userId])
    const first = await records.list({ limit: 7 })
    expect(first.nextCursor).toBeTruthy()
    await pool.query(`UPDATE entities SET display_name='Renamed fixture' WHERE workspace_id=$1`, [f.workspaceId])
    const newer = await pool.query(`INSERT INTO entities (workspace_id,kind,display_name,created_by_user_id,source,created_at)
      VALUES ($1,'person','New fixture',$2,'manual','2099-01-01T00:00:00Z') RETURNING id`, [f.workspaceId, f.userId])
    const ids = first.records.map((row) => row.id)
    let cursor = first.nextCursor
    while (cursor) {
      const page = await records.list({ limit: 19, cursor })
      ids.push(...page.records.map((row) => row.id))
      cursor = page.nextCursor
    }
    expect(ids).toHaveLength(106)
    expect(new Set(ids).size).toBe(106)
    expect(ids).not.toContain(newer.rows[0].id)
    for (const input of [{ kind: 'company' }, { query: 'Renamed' }, { includeArchived: 'true' }, { createdAfter: '2025-01-01T00:00:00Z' }]) {
      await expect(records.list({ ...input, cursor: first.nextCursor })).rejects.toMatchObject({ code: 'invalid_input' })
    }
    await expect(records.fields({ cursor: first.nextCursor })).rejects.toMatchObject({ code: 'invalid_input' })
    const otherWorkspace = createCrmIntegrationRecordReadStore({ ...principal, workspaceId: randomUUID() }, pool)
    await expect(otherWorkspace.list({ cursor: first.nextCursor })).rejects.toMatchObject({ code: 'credential_revoked' })
    await pool.query(`INSERT INTO crm_field_definitions (workspace_id,entity_kind,field_key,label,field_type)
      SELECT $1,'person','fixture_'||n,'Fixture '||n,'text' FROM generate_series(1,105) n`, [f.workspaceId])
    const fields: unknown[] = []
    cursor = null
    do {
      const page = await records.fields({ limit: 17, cursor: cursor ?? undefined })
      fields.push(...page.fields.map((row) => row.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(fields).toHaveLength(105)
    expect(new Set(fields).size).toBe(105)
    const window = await records.list({ limit: 100, createdAfter: '2026-01-01T00:00:00.123456Z', createdBefore: '2026-01-01T00:00:00.123457Z' })
    expect(window.records).toHaveLength(100)
    expect((await records.list({ limit: 100, createdAfter: '2026-01-01T00:00:00.123456Z', createdBefore: '2026-01-01T00:00:00.123457Z', cursor: window.nextCursor })).records).toHaveLength(5)
  })
  it('prevents ticket, mixed-order, by-id, provider and registration traversal across event grants', async () => {
    const f = await fixture()
    await modules.act(f.workspaceId, f.userId, 'association', { action: 'enable', expectedVersion: 1 })
    const a = await commerce.upsertEvent(f.workspaceId, event('event-a'), legacy)
    const b = await commerce.upsertEvent(f.workspaceId, event('event-b'), legacy)
    const aid = String(a.record.id), bid = String(b.record.id)
    const ta = await commerce.upsertTicket(f.workspaceId, aid, ticket, legacy)
    const tb = await commerce.upsertTicket(f.workspaceId, bid, ticket, legacy)
    const lines = [ta, tb].map((row) => ({ ticketId: row.record.id, quantity: 1, attendees: [{ name: 'Fixture attendee' }] }))
    const input = OrderCreateSchema.parse({ contactId: f.contactId, idempotencyKey: randomUUID(), lines })
    const grants: CrmIntegrationGrant[] = [
      { operation: 'association.read', selectors: { eventIds: [aid] } },
      { operation: 'association.orders.write', selectors: { eventIds: [aid] } },
      { operation: 'crm.catalog.configure', selectors: { eventIds: [aid] } },
      { operation: 'association.provider_events.write', selectors: { eventIds: [aid], providerKeys: ['fixture'] } },
    ]
    const ctx = f.vertical(grants)
    await expect(association.execute(ctx, { kind: 'create_order', order: input })).rejects.toMatchObject({ code: 'integration_scope_denied' })
    expect((await pool.query('SELECT count(*)::int AS count FROM association_orders WHERE workspace_id=$1', [f.workspaceId])).rows[0].count).toBe(0)
    await expect(association.execute(ctx, { kind: 'save_ticket', eventId: bid, ticket })).rejects.toMatchObject({ code: 'integration_scope_denied' })
    const mixed = await commerce.createOrder(f.workspaceId, input, { credentialKind: 'user', credentialId: f.userId, actingUserId: f.userId })
    const orderId = String(mixed.record.id)
    expect((await association.execute(ctx, AssociationCommandSchema.parse({ kind: 'list_orders', limit: 1 }))).items).toEqual([])
    await expect(association.execute(ctx, { kind: 'get_order', orderId })).rejects.toMatchObject({ code: 'integration_scope_denied' })
    await expect(association.execute(ctx, { kind: 'cancel_order', orderId })).rejects.toMatchObject({ code: 'integration_scope_denied' })
    const registrationId = String((mixed.record.registrations as Array<{ id: string; eventId: string }>).find((row) => row.eventId === bid)!.id)
    await expect(association.execute(ctx, { kind: 'update_registration', registrationId, update: { status: 'cancelled' } })).rejects.toMatchObject({ code: 'integration_scope_denied' })
    const single = await commerce.createOrder(f.workspaceId, OrderCreateSchema.parse({ ...input, idempotencyKey: randomUUID(), lines: [lines[0]] }), { credentialKind: 'user', credentialId: f.userId, actingUserId: f.userId })
    const singleId = String(single.record.id)
    await expect(association.execute(ctx, AssociationCommandSchema.parse({ kind: 'reconcile_provider_event', orderId: singleId,
      event: { provider: 'ungranted', providerReference: 'fixture-object', amountMinor: 100, currency: 'USD', eventId: 'evt-1', targetStatus: 'paid', occurredAt: '2026-09-08T00:00:00Z' } }))).rejects.toMatchObject({ code: 'integration_scope_denied' })
    const page = await association.execute(ctx, AssociationCommandSchema.parse({ kind: 'module_blockers', limit: 1 }))
    expect(page.pendingOrders).toBe(1)
    expect(page.items?.[0].id).toBe(singleId)
    await modules.act(f.workspaceId, f.userId, 'association', { action: 'request_disable', expectedVersion: 2 })
    await association.execute(ctx, { kind: 'confirm_free_order', orderId: singleId })
    expect((await commerce.getOrder(f.workspaceId, singleId))?.status).toBe('paid')
    expect((await pool.query('SELECT count(*)::int AS count FROM association_provider_events WHERE workspace_id=$1', [f.workspaceId])).rows[0].count).toBe(0)
  })
})
