import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Pool } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { type AssociationActor, type AssociationProviderEventInput, ProviderEntitlementEventSchema } from '@use-brian/core'
import { getPool, getAppPool } from '../client.js'
import { createAssociationWorkspaceModulesStore } from '../../association/workspace-module.js'
import { createAssociationStore } from '../association-store.js'
import { createProviderEntitlementInbox } from '../../association/provider-entitlements.js'
import { createProviderInboxWorker } from '../../association/provider-inbox-worker.js'
import { createCrmIntegrationStore } from '../crm-integration-store.js'
import { assertCrmPrivacySubjectAuthority } from '../../crm-operations/privacy-subject-authority.js'
import { EventInputSchema, TicketInputSchema, OrderCreateSchema } from '../../association/domain.js'
import { _resetCoalescerForTests } from '../../brain-stream/notify.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), appPool = getAppPool(), modules = createAssociationWorkspaceModulesStore()
const providerEntitlements = createProviderEntitlementInbox(pool)
const store = createAssociationStore(pool, undefined, { providerEntitlements })
const keys = createCrmIntegrationStore()
async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), contactId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Provider fixture',$2)", [workspaceId, userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId])
  await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source) VALUES($1,$2,'person','Fictional buyer',$3,'manual')", [contactId, workspaceId, userId])
  await modules.act(workspaceId, userId, 'association', { action: 'enable', expectedVersion: 1 })
  const human: AssociationActor = { credentialKind: 'user', credentialId: userId, actingUserId: userId }
  const issued = await keys.create(workspaceId, userId, {
    label: 'Provider fixture backend', expiresAt: '2099-01-01T00:00:00Z',
    departmentBinding: { departmentIds: [], cap: 'internal' },
    grants: [
      { operation: 'association.provider_events.write', selectors: { providerKeys: ['fixture'], eventIds: 'all' } },
      { operation: 'association.orders.write', selectors: { eventIds: 'all' } },
      { operation: 'crm.entitlements.write', selectors: { planIds: 'all' } },
    ],
  })
  const integration = (await keys.authenticate(issued.oneTimeSecret))!
  const actor: AssociationActor = { credentialKind: 'integration_key', credentialId: integration.credentialId, integration }
  const eventId = String((await store.upsertEvent(workspaceId, EventInputSchema.parse({ slug: 'fixture', title: 'Provider fixture', startsAt: '2099-01-01T12:00:00Z', endsAt: '2099-01-01T14:00:00Z', timezone: 'UTC', mode: 'venue', status: 'published', capacity: 10 }), human)).record.id)
  const ticketId = String((await store.upsertTicket(workspaceId, eventId, TicketInputSchema.parse({ key: 'standard', name: 'Standard', currency: 'USD', priceMinor: 1000, status: 'on_sale', capacity: 10 }), human)).record.id)
  const order = async () => String((await store.createOrder(workspaceId, OrderCreateSchema.parse({ contactId, idempotencyKey: randomUUID(), lines: [{ ticketId, quantity: 1, attendees: [{ contactId, name: 'Fictional buyer' }] }] }), human)).record.id)
  const orderId = await order(), binding = { provider: 'fixture', providerReference: randomUUID(), amountMinor: 1000, currency: 'USD' }
  const bind = (id = orderId, patch = {}, a = actor) => store.bindOrderProvider(workspaceId, id, { ...binding, ...patch }, a)
  const evidence: AssociationProviderEventInput = { ...binding, eventId: randomUUID(), targetStatus: 'paid', occurredAt: '2026-09-01T12:00:00.000001Z', metadata: {} }
  const apply = (patch: Partial<AssociationProviderEventInput> = {}, id = orderId, a = actor) => store.reconcileProviderEvent(workspaceId, id, { ...evidence, ...patch }, a)
  return { workspaceId, userId, contactId, human, actor, eventId, orderId, binding, evidence, order, bind, apply }
}
async function counts(ws: string) {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM association_provider_events WHERE workspace_id=$1) evidence,
    (SELECT count(*)::int FROM association_audit_log WHERE workspace_id=$1 AND action IN('order.paid','order.refunded')) transitions,
    (SELECT count(*)::int FROM association_notification_outbox WHERE workspace_id=$1 AND source_kind='order') notifications`, [ws])).rows[0]
}
function faultPool(mode: 'admission_commit' | 'acknowledgement' | 'applied_commit'): Pool {
  let fired = false
  return { query: pool.query.bind(pool), connect: async () => {
    const client = await pool.connect(); let applied = false
    return { release: client.release.bind(client), query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("SET state='applied'")) {
        applied = true
        if (!fired && mode === 'acknowledgement') { fired = true; throw Object.assign(Error('private database error'), { code: '40001' }) }
      }
      const result = await client.query(sql, params)
      if (!fired && sql === 'COMMIT' && (mode === 'admission_commit' || (mode === 'applied_commit' && applied))) {
        fired = true; throw Object.assign(Error('private connection error after commit'), { code: '08006' })
      }
      return result
    } }
  } } as unknown as Pool
}
async function receipt(ws: string, eventId: string) {
  return (await pool.query('SELECT * FROM association_integration_events WHERE workspace_id=$1 AND provider_event_id=$2', [ws, eventId])).rows[0]
}
async function pending(f: Awaited<ReturnType<typeof fixture>>, actor = f.actor) {
  await f.bind()
  const failingPool = faultPool('admission_commit')
  await expect(createAssociationStore(failingPool, undefined, {
    providerEntitlements: createProviderEntitlementInbox(failingPool),
  }).reconcileProviderEvent(f.workspaceId, f.orderId, f.evidence, actor)).rejects.toThrow()
  const saved = await receipt(f.workspaceId, f.evidence.eventId)
  expect(saved.state).toBe('pending')
  return saved
}
async function membership(f: Awaited<ReturnType<typeof fixture>>) {
  const planId = (await pool.query("INSERT INTO association_membership_plans(workspace_id,plan_key,name,currency,fee_minor,billing_period) VALUES($1,'standard','Fictional plan','USD',1000,'annual') RETURNING id", [f.workspaceId])).rows[0].id
  const contactId = (await store.getOrder(f.workspaceId, f.orderId))!.contactId
  const event = ProviderEntitlementEventSchema.parse({ provider: 'fixture', eventId: randomUUID(), providerReference: 'fictional-subscription', providerPeriodId: 'period-1', occurredAt: '2026-09-01T12:00:00.000001Z',
    command: { kind: 'grant_entitlement', contactId, planId, idempotencyKey: randomUUID(), provider: 'fixture', providerEntitlementId: 'fictional-subscription', providerPeriodId: 'period-1', status: 'active', startsAt: '2026-01-01T00:00:00Z', endsAt: '2099-01-01T00:00:00Z', renewalMode: 'auto' } })
  const service = createProviderEntitlementInbox(pool)
  return { event, planId, service, submit: (input = event) => service.submit(f.workspaceId, input, f.actor) }
}
describe('[COMP:crm/provider-inbox] Actual durable normalized receipts', () => {
  afterAll(async () => { _resetCoalescerForTests(); await pool.end(); await appPool.end() })
  it('retains a pending entitlement receipt floor through declassification and replacement recovery', async () => {
    const f = await fixture(), department = randomUUID(), custodian = randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [custodian])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')", [f.workspaceId, custodian])
    await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Cedar',$3,'team',$1::text,$4)", [department, f.workspaceId, custodian, `team:${department}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Cedar','team',$3)", [f.workspaceId, `team:${department}`, department])
    const grant = () => pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'internal','store')", [f.workspaceId, department, f.userId])
    const revoke = () => pool.query('DELETE FROM department_edges WHERE department_id=$1 AND user_id=$2', [department, f.userId])
    await grant()
    await pool.query('UPDATE entities SET compartments=$2 WHERE id=$1', [f.contactId, [`team:${department}`]])
    const m = await membership(f)
    const issued = await keys.create(f.workspaceId, f.userId, { label: 'Scoped entitlement backend', expiresAt: '2099-01-01T00:00:00Z',
      departmentBinding: { departmentIds: [department], cap: 'internal' }, grants: [
        { operation: 'association.provider_events.write', selectors: { providerKeys: ['fixture'] } },
        { operation: 'crm.entitlements.write', selectors: { planIds: [m.planId] } },
      ] })
    const integration = (await keys.authenticate(issued.oneTimeSecret))!
    const scoped: AssociationActor = { credentialKind: 'integration_key', credentialId: integration.credentialId, integration }
    await expect(createProviderEntitlementInbox(faultPool('admission_commit')).submit(f.workspaceId, m.event, scoped)).rejects.toThrow()
    const saved = await receipt(f.workspaceId, m.event.eventId)
    expect(saved.state).toBe('pending')
    expect(saved.scope_snapshot.compartments).toEqual([`team:${department}`])
    await expect(pool.query("UPDATE association_integration_events SET scope_snapshot=jsonb_set(scope_snapshot,'{compartments}','[]') WHERE id=$1", [saved.id])).rejects.toThrow('immutable')
    await pool.query("UPDATE entities SET compartments='{}' WHERE id=$1", [f.contactId])
    await expect(m.submit()).rejects.toMatchObject({ code: 'not_authorized' })
    await revoke()
    await expect(m.service.submit(f.workspaceId, m.event, scoped)).rejects.toMatchObject({ code: 'not_authorized' })
    expect(await store.listProviderReceipts(f.workspaceId, { limit: 1, cursor: null }, f.human)).toMatchObject({ items: [], nextCursor: null })
    await expect(store.resolveProviderReceipt(f.workspaceId, saved.id, f.human)).rejects.toMatchObject({ code: 'not_authorized' })
    const privacyClient = await pool.connect()
    try {
      await privacyClient.query('BEGIN')
      await expect(assertCrmPrivacySubjectAuthority(privacyClient, {
        workspaceId: f.workspaceId, actor: { kind: 'user', userId: f.userId },
        authority: { role: 'owner', canWrite: true, canConfigure: true, trustedIdentitySources: [] },
      }, f.contactId)).rejects.toMatchObject({ code: 'not_authorized' })
    } finally { await privacyClient.query('ROLLBACK'); privacyClient.release() }
    expect((await receipt(f.workspaceId, m.event.eventId))).toMatchObject({ state: 'pending', attempts: 0 })
    expect((await pool.query('SELECT count(*)::int n FROM association_memberships WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
    await grant()
    expect((await store.listProviderReceipts(f.workspaceId, { limit: 1, cursor: null }, f.human)).items).toMatchObject([{ id: saved.id }])
    const applied = await m.service.submit(f.workspaceId, m.event, scoped)
    expect(applied.receipt).toMatchObject({ id: saved.id, state: 'applied', attempts: 1 })
    expect((await pool.query('SELECT scope_snapshot FROM association_memberships WHERE id=$1', [applied.record.id])).rows[0].scope_snapshot.compartments).toEqual([`team:${department}`])
    await expect(m.submit()).rejects.toMatchObject({ code: 'not_authorized' })
    expect((await m.service.submit(f.workspaceId, m.event, scoped)).created).toBe(false)
    expect((await pool.query("SELECT count(*)::int n FROM association_audit_log WHERE workspace_id=$1 AND action='crm.entitlement.changed'", [f.workspaceId])).rows[0].n).toBe(1)
  })
  it('admits saved order and current entitlement sources before retaining provider evidence', async () => {
    const f = await fixture(), department = randomUUID(), custodian = randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [custodian])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')", [f.workspaceId, custodian])
    await pool.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Cedar',$3,'team',$1::text,$4)", [department, f.workspaceId, custodian, `team:${department}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Cedar','team',$3)", [f.workspaceId, `team:${department}`, department])
    await pool.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'internal','store')", [f.workspaceId, department, f.userId])
    await pool.query('UPDATE entities SET compartments=$2 WHERE id=$1', [f.contactId, [`team:${department}`]])
    const protectedOrder = await f.order(), m = await membership(f)
    const before = await counts(f.workspaceId)
    await expect(f.apply({}, protectedOrder)).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(m.submit()).rejects.toMatchObject({ code: 'not_authorized' })
    expect((await pool.query('SELECT count(*)::int n FROM association_integration_events WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
    expect(await counts(f.workspaceId)).toEqual(before)
    // Current declassification cannot erase the order's original floor.
    await pool.query("UPDATE entities SET compartments='{}' WHERE id=$1", [f.contactId])
    await expect(f.apply({}, protectedOrder)).rejects.toMatchObject({ code: 'not_authorized' })
    const issued = await keys.create(f.workspaceId, f.userId, { label: 'Scoped provider backend', expiresAt: '2099-01-01T00:00:00Z',
      departmentBinding: { departmentIds: [department], cap: 'internal' }, grants: [
        { operation: 'association.provider_events.write', selectors: { providerKeys: ['fixture'], eventIds: [f.eventId] } },
        { operation: 'association.orders.write', selectors: { eventIds: [f.eventId] } },
      ] })
    const integration = (await keys.authenticate(issued.oneTimeSecret))!
    const scoped: AssociationActor = { credentialKind: 'integration_key', credentialId: integration.credentialId, integration }
    await f.bind(protectedOrder, {}, scoped)
    expect((await f.apply({}, protectedOrder, scoped)).receipt?.state).toBe('applied')
    await pool.query('DELETE FROM department_edges WHERE department_id=$1 AND user_id=$2', [department, f.userId])
    await expect(f.apply({}, protectedOrder, scoped)).rejects.toMatchObject({ code: 'not_authorized' })
    expect(await counts(f.workspaceId)).toEqual({ evidence: 1, transitions: 1, notifications: 2 })
  })
  it('reconciles missed fake-provider order and membership events through actual canonical transactions', async () => {
    const { ProviderCheckpoint, createFakeProvider, createProviderReconciler } = await import(new URL('../../../../../scripts/crm/provider-reference.mjs', import.meta.url).href)
    const f = await fixture(), m = await membership(f); await f.bind()
    const root = mkdtempSync(join(tmpdir(), 'provider-db-reference-'))
    const provider = createFakeProvider({ provider: 'fixture', webhookSecret: 'fictional_webhook_secret_for_local_tests_only', events: [
      { target: 'order', orderId: f.orderId, event: f.evidence }, { target: 'entitlement', event: m.event },
    ] })
    const checkpoint = new ProviderCheckpoint({ databasePath: join(root, 'checkpoint.sqlite'), sourceId: 'fictional-provider', provider: 'fixture', workspaceId: f.workspaceId, apiUrl: 'http://127.0.0.1:4444' })
    const client = { forward: async (envelope: { target: string; event: unknown; orderId?: string }) => {
      try {
        const result = envelope.target === 'order' ? await store.reconcileProviderEvent(f.workspaceId, envelope.orderId!, envelope.event as AssociationProviderEventInput, f.actor)
          : await m.submit(ProviderEntitlementEventSchema.parse(envelope.event))
        return result.receipt
      } catch (error) {
        const details = (error as { details?: { receiptId: string; receiptState: string } }).details
        if (details?.receiptId) return { id: details.receiptId, state: details.receiptState }
        throw error
      }
    } }
    try {
      const worker = createProviderReconciler({ provider, checkpoint, client, pageSize: 1 })
      const signed = provider.signWebhook({ target: 'order', orderId: f.orderId, event: f.evidence })
      expect((await worker.receiveWebhook(signed.body, signed.signature)).state).toBe('applied')
      expect(await worker.reconcile()).toMatchObject({ state: 'caught_up', processed: 2 })
      expect(await counts(f.workspaceId)).toEqual({ evidence: 1, transitions: 1, notifications: 2 })
      provider.append({ target: 'order', orderId: f.orderId, event: { ...f.evidence, eventId: randomUUID(), targetStatus: 'refunded' } })
      provider.append({ target: 'order', orderId: f.orderId, event: { ...f.evidence, eventId: randomUUID() } })
      expect(await worker.reconcile()).toMatchObject({ state: 'caught_up', processed: 2 })
      expect((await store.getOrder(f.workspaceId, f.orderId))?.status).toBe('refunded')
      expect(checkpoint.issues().items).toMatchObject([{ cursor: 4, state: 'needs_reconciliation' }])
      expect((await receipt(f.workspaceId, m.event.eventId)).state).toBe('applied')
    } finally { checkpoint.close(); rmSync(root, { recursive: true, force: true }) }
  })
  it('retains invalid evidence as a reconciliation receipt and retries the same input after the binding is repaired', async () => {
    const f = await fixture()
    const key = await keys.create(f.workspaceId, f.userId, { label: 'Provider inbox backend', expiresAt: '2099-01-01T00:00:00Z',
      grants: [{ operation: 'association.provider_events.write', selectors: { providerKeys: ['fixture'], eventIds: [f.eventId] } }] })
    const integration = (await keys.authenticate(key.oneTimeSecret))!
    const backend = { credentialKind: 'integration_key' as const, credentialId: integration.credentialId, integration }
    await expect(f.apply({}, undefined, backend)).rejects.toMatchObject({ code: 'conflict', details: { receiptState: 'needs_reconciliation' } })
    const failed = await receipt(f.workspaceId, f.evidence.eventId)
    expect(failed).toMatchObject({ state: 'needs_reconciliation', attempts: 1, last_error_code: 'conflict' })
    await expect(store.retryProviderEventReceipt(f.workspaceId, failed.id)).rejects.toMatchObject({ code: 'conflict' })
    expect((await receipt(f.workspaceId, f.evidence.eventId)).attempts).toBe(1)
    await expect(f.apply({ amountMinor: 999 }, undefined, backend)).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await f.bind()
    const applied = await store.resolveProviderReceipt(f.workspaceId, failed.id, f.human)
    expect(applied).toMatchObject({ created: true, receipt: { id: failed.id, state: 'applied', attempts: 2 } })
    expect((await store.resolveProviderReceipt(f.workspaceId, failed.id, f.human)).created).toBe(false)
    expect(await counts(f.workspaceId)).toEqual({ evidence: 1, transitions: 1, notifications: 2 })
    expect((await pool.query("SELECT count(*)::int n FROM association_audit_log WHERE workspace_id=$1 AND action='provider_receipt.retry_requested'", [f.workspaceId])).rows[0].n).toBe(2)
    const persisted = await receipt(f.workspaceId, f.evidence.eventId)
    expect(persisted.admitted_actor).toEqual(failed.admitted_actor)
    expect(JSON.stringify(persisted)).not.toContain('private database error')
  })
  it('requires current backend authority when the stored credential expires', async () => {
    const f = await fixture()
    await expect(f.apply()).rejects.toMatchObject({ code: 'conflict' })
    const failed = await receipt(f.workspaceId, f.evidence.eventId)
    await f.bind()
    await pool.query("UPDATE crm_integration_credentials SET expires_at=created_at+interval '1 millisecond' WHERE id=$1", [f.actor.credentialId])
    await expect(store.resolveProviderReceipt(f.workspaceId, failed.id, f.human)).rejects.toMatchObject({ code: 'credential_revoked' })
    expect(await counts(f.workspaceId)).toEqual({ evidence: 0, transitions: 0, notifications: 0 })
    const issued = await keys.create(f.workspaceId, f.userId, { label: 'Replacement provider backend', expiresAt: '2099-01-01T00:00:00Z',
      departmentBinding: { departmentIds: [], cap: 'internal' },
      grants: [{ operation: 'association.provider_events.write', selectors: { providerKeys: ['fixture'], eventIds: [f.eventId] } }] })
    const integration = (await keys.authenticate(issued.oneTimeSecret))!
    expect((await f.apply({}, undefined, { credentialKind: 'integration_key', credentialId: integration.credentialId, integration })).receipt)
      .toMatchObject({ id: failed.id, state: 'applied' })
    expect((await receipt(f.workspaceId, f.evidence.eventId)).admitted_actor.credentialId).toBe(f.actor.credentialId)
  })
  it('rolls back domain effects when receipt acknowledgement fails and retries without duplicating evidence', async () => {
    const f = await fixture(); await f.bind()
    const failingPool = faultPool('acknowledgement')
    await expect(createAssociationStore(failingPool, undefined, {
      providerEntitlements: createProviderEntitlementInbox(failingPool),
    }).reconcileProviderEvent(f.workspaceId, f.orderId, f.evidence, f.actor)).rejects.toMatchObject({ details: { receiptState: 'retry' } })
    expect(await counts(f.workspaceId)).toEqual({ evidence: 0, transitions: 0, notifications: 0 })
    expect((await receipt(f.workspaceId, f.evidence.eventId))).toMatchObject({ state: 'retry', last_error_code: 'transient_failure', attempts: 1 })
    expect((await f.apply()).receipt).toMatchObject({ state: 'applied', attempts: 2 })
    expect(await counts(f.workspaceId)).toEqual({ evidence: 1, transitions: 1, notifications: 2 })
  })
  it('recognizes a lost response after the atomic commit and does not repeat the paid transition', async () => {
    const f = await fixture(); await f.bind()
    const failingPool = faultPool('applied_commit')
    await expect(createAssociationStore(failingPool, undefined, {
      providerEntitlements: createProviderEntitlementInbox(failingPool),
    }).reconcileProviderEvent(f.workspaceId, f.orderId, f.evidence, f.actor)).rejects.toMatchObject({ details: { receiptState: 'applied' } })
    expect((await f.apply())).toMatchObject({ created: false, receipt: { state: 'applied', attempts: 1 } })
    expect(await counts(f.workspaceId)).toEqual({ evidence: 1, transitions: 1, notifications: 2 })
  })
  it('recovers durable pending and abandoned leases across competing workers without a second payment', async () => {
    const f = await fixture(), saved = await pending(f)
    await pool.query("UPDATE association_integration_events SET state='processing',lease_token=$2,lease_expires_at=clock_timestamp()-interval '1 second',attempts=1,cycle_attempts=1 WHERE id=$1", [saved.id, randomUUID()])
    const results = await Promise.allSettled([store.retryProviderEventReceipt(f.workspaceId, saved.id), store.retryProviderEventReceipt(f.workspaceId, saved.id)])
    expect(results.some(r => r.status === 'fulfilled')).toBe(true)
    expect((await receipt(f.workspaceId, f.evidence.eventId)).state).toBe('applied')
    expect(await counts(f.workspaceId)).toEqual({ evidence: 1, transitions: 1, notifications: 2 })
    const g = await fixture(), queued = await pending(g), worker = createProviderInboxWorker({
      process: (workspaceId, receiptId) => store.retryProviderEventReceipt(workspaceId, receiptId),
    })
    expect(await worker.tick()).toBeGreaterThanOrEqual(1)
    expect((await receipt(g.workspaceId, g.evidence.eventId))).toMatchObject({ id: queued.id, state: 'applied' })
  })
  it('stops automatic processing after revocation, then permits exact reauthorization without changing original provenance', async () => {
    const f = await fixture()
    const issue = async () => {
      const key = await keys.create(f.workspaceId, f.userId, { label: 'Provider inbox backend', expiresAt: '2099-01-01T00:00:00Z', grants: [{ operation: 'association.provider_events.write', selectors: { providerKeys: ['fixture'], eventIds: [f.eventId] } }] })
      const integration = (await keys.authenticate(key.oneTimeSecret))!
      return { credentialKind: 'integration_key' as const, credentialId: integration.credentialId, integration }
    }
    const actor = await issue(), saved = await pending(f, actor)
    await keys.revoke(f.workspaceId, f.userId, actor.credentialId)
    await expect(store.retryProviderEventReceipt(f.workspaceId, saved.id)).rejects.toMatchObject({ code: 'credential_revoked' })
    expect((await receipt(f.workspaceId, f.evidence.eventId))).toMatchObject({ state: 'needs_reconciliation', last_error_code: 'credential_revoked', attempts: 0 })
    await expect(store.resolveProviderReceipt(f.workspaceId, saved.id, f.human)).rejects.toMatchObject({ code: 'credential_revoked' })
    expect((await receipt(f.workspaceId, f.evidence.eventId))).toMatchObject({ state: 'needs_reconciliation', last_error_code: 'credential_revoked', attempts: 0 })
    const replacement = await issue()
    expect((await f.apply({}, undefined, replacement)).receipt).toMatchObject({ state: 'applied' })
    const after = await receipt(f.workspaceId, f.evidence.eventId)
    expect(after.admitted_actor.credentialId).toBe(actor.credentialId)
    expect(after.execution_actor.credentialId).toBe(replacement.credentialId)
    expect(await counts(f.workspaceId)).toEqual({ evidence: 1, transitions: 1, notifications: 2 })
  })
  it('caps abandoned automatic attempts and requires an explicit backend retry to restart a cycle', async () => {
    const f = await fixture(), saved = await pending(f)
    await pool.query("UPDATE association_integration_events SET state='processing',lease_token=$2,lease_expires_at=clock_timestamp()-interval '1 second',attempts=8,cycle_attempts=8 WHERE id=$1", [saved.id, randomUUID()])
    await expect(store.retryProviderEventReceipt(f.workspaceId, saved.id)).rejects.toMatchObject({ code: 'conflict' })
    expect((await receipt(f.workspaceId, f.evidence.eventId))).toMatchObject({ state: 'needs_reconciliation', last_error_code: 'attempt_limit', attempts: 8 })
    expect((await f.apply()).receipt).toMatchObject({ state: 'applied', attempts: 9 })
  })
  it('applies provider periods while commerce is disabled, suppresses semantic duplicates and preserves terminal renewal lineage', async () => {
    const f = await fixture(), m = await membership(f)
    await store.cancelOrder(f.workspaceId, f.orderId, f.human)
    await modules.act(f.workspaceId, f.userId, 'association', { action: 'request_disable', expectedVersion: 2 })
    const grant = await m.submit(), id = String(grant.record.id)
    expect(grant).toMatchObject({ receipt: { state: 'applied', entitlementId: id }, record: { providerPeriodId: 'period-1', status: 'active' } })
    await m.submit({ ...m.event, eventId: randomUUID() })
    const update = ProviderEntitlementEventSchema.parse({ ...m.event, eventId: randomUUID(), occurredAt: '2026-09-02T00:00:00Z', command: { kind: 'update_entitlement', entitlementId: id, renewalMode: 'none' } })
    await m.submit(update); await m.submit({ ...update, eventId: randomUUID() })
    expect((await pool.query("SELECT count(*)::int n FROM association_audit_log WHERE workspace_id=$1 AND action='crm.entitlement.changed'", [f.workspaceId])).rows[0].n).toBe(2)
    await m.submit(ProviderEntitlementEventSchema.parse({ ...update, eventId: randomUUID(), occurredAt: '2026-09-03T00:00:00Z', command: { kind: 'update_entitlement', entitlementId: id, status: 'cancelled' } }))
    const next = ProviderEntitlementEventSchema.parse({ ...m.event, eventId: randomUUID(), occurredAt: '2026-09-04T00:00:00Z', providerPeriodId: 'period-2', command: { ...m.event.command, idempotencyKey: randomUUID(), providerPeriodId: 'period-2', predecessorId: id, startsAt: '2027-01-01T00:00:00Z' } })
    const renewed = await m.submit(next)
    expect(renewed.record).toMatchObject({ predecessorId: id, providerPeriodId: 'period-2', status: 'active' })
    expect(renewed.record.id).not.toBe(id)
  })
  it('retains verified membership refunds and disputes for policy review without changing the entitlement', async () => {
    const f = await fixture(), m = await membership(f), granted = await m.submit(), id = String(granted.record.id)
    await m.submit(ProviderEntitlementEventSchema.parse({
      ...m.event,
      eventId: randomUUID(),
      occurredAt: '2026-09-03T00:00:00Z',
      command: { kind: 'update_entitlement', entitlementId: id, renewalMode: 'none' },
    }))
    const before = await pool.query('SELECT status,ends_at,renewal_mode FROM association_memberships WHERE workspace_id=$1 AND id=$2', [f.workspaceId, id])
    const review = ProviderEntitlementEventSchema.parse({
      ...m.event,
      eventId: randomUUID(),
      occurredAt: '2026-09-02T00:00:00Z',
      command: {
        kind: 'review_entitlement_financial_event', entitlementId: id,
        adjustmentReference: 'fictional-refund', adjustmentKind: 'refund', adjustmentStatus: 'succeeded',
        amountMinor: 1000, currency: 'USD', paymentIntentId: 'fictional-payment-intent',
      },
    })
    const reviewed = await m.submit(review)
    expect(reviewed).toMatchObject({ created: false, record: { id, status: 'active' }, receipt: {
      state: 'needs_reconciliation', attempts: 1, errorCode: 'membership_refund_policy_pending', entitlementId: id,
    } })
    expect((await pool.query('SELECT status,ends_at,renewal_mode FROM association_memberships WHERE workspace_id=$1 AND id=$2', [f.workspaceId, id])).rows)
      .toEqual(before.rows)
    expect((await m.submit(review)).receipt).toMatchObject({
      state: 'needs_reconciliation', attempts: 2, errorCode: 'membership_refund_policy_pending',
    })
    expect((await pool.query("SELECT count(*)::int n FROM association_audit_log WHERE workspace_id=$1 AND action='crm.entitlement.changed'", [f.workspaceId])).rows[0].n).toBe(2)
    const dispute = ProviderEntitlementEventSchema.parse({
      ...review,
      eventId: randomUUID(),
      occurredAt: '2026-09-04T00:00:00Z',
      command: { ...review.command, adjustmentReference: 'fictional-dispute', adjustmentKind: 'dispute', adjustmentStatus: 'open' },
    })
    expect((await m.submit(dispute)).receipt).toMatchObject({
      state: 'needs_reconciliation', errorCode: 'membership_dispute_policy_pending', entitlementId: id,
    })
  })
  it('rejects mismatched periods and out-of-order entitlement changes with durable visible receipts', async () => {
    const f = await fixture(), m = await membership(f), id = String((await m.submit()).record.id)
    const update = ProviderEntitlementEventSchema.parse({ ...m.event, eventId: randomUUID(), occurredAt: '2026-09-03T00:00:00Z', command: { kind: 'update_entitlement', entitlementId: id, renewalMode: 'none' } })
    await m.submit(update)
    const wrong = { ...update, providerPeriodId: 'unknown-period', eventId: randomUUID() }
    await expect(m.submit(wrong)).rejects.toMatchObject({ code: 'conflict', details: { receiptState: 'needs_reconciliation' } })
    const older = ProviderEntitlementEventSchema.parse({ ...update, eventId: randomUUID(), occurredAt: '2026-09-02T00:00:00Z', command: { kind: 'update_entitlement', entitlementId: id, renewalMode: 'auto' } })
    await expect(m.submit(older)).rejects.toMatchObject({ code: 'conflict', details: { reason: 'provider_event_out_of_order' } })
    expect((await receipt(f.workspaceId, older.eventId)).state).toBe('needs_reconciliation')
    await expect(m.service.submit(f.workspaceId, update, f.human)).rejects.toMatchObject({ code: 'not_authorized' })
  })
  it('revalidates membership plan authority before replay and prevents ungranted receipt reads', async () => {
    const f = await fixture(), m = await membership(f)
    const issued = await keys.create(f.workspaceId, f.userId, { label: 'Provider membership backend', expiresAt: '2099-01-01T00:00:00Z', grants: [
      { operation: 'association.provider_events.write', selectors: { providerKeys: ['fixture'] } },
      { operation: 'crm.entitlements.write', selectors: { planIds: [m.planId] } },
    ] })
    const integration = (await keys.authenticate(issued.oneTimeSecret))!, actor: AssociationActor = { credentialKind: 'integration_key', credentialId: integration.credentialId, integration }
    const result = await m.service.submit(f.workspaceId, m.event, actor)
    expect((await store.listProviderReceipts(f.workspaceId, { limit: 100, cursor: null, allowedEventIds: [], allowedPlanIds: [m.planId] }, f.human)).items).toMatchObject([{ id: result.receipt.id }])
    expect((await store.listProviderReceipts(f.workspaceId, { limit: 100, cursor: null, allowedEventIds: [], allowedPlanIds: [] }, f.human)).items).toEqual([])
    await pool.query("DELETE FROM crm_integration_credential_grants WHERE workspace_id=$1 AND credential_id=$2 AND operation='crm.entitlements.write'", [f.workspaceId, actor.credentialId])
    await expect(m.service.submit(f.workspaceId, m.event, actor)).rejects.toMatchObject({ code: 'integration_scope_denied' })
    expect((await receipt(f.workspaceId, m.event.eventId))).toMatchObject({ state: 'applied', attempts: 1 })
  })
  it('paginates receipt history under event/plan ceilings and enforces immutable workspace-isolated rows', async () => {
    const f = await fixture(); await f.bind(); await f.apply()
    await pool.query(`INSERT INTO association_integration_events(workspace_id,provider,provider_event_id,provider_reference,occurred_at,target_kind,order_id,contact_id,
      request_fingerprint,normalized_payload,admitted_actor,execution_actor,state,attempts,cycle_attempts,applied_at,scope_snapshot,scope_sources)
      SELECT workspace_id,provider,'fixture-'||n,provider_reference,occurred_at,target_kind,order_id,contact_id,
      repeat('a',64),normalized_payload,admitted_actor,execution_actor,'applied',1,1,clock_timestamp(),scope_snapshot,scope_sources
      FROM association_integration_events CROSS JOIN generate_series(1,104) n WHERE workspace_id=$1`, [f.workspaceId])
    const first = await store.listProviderReceipts(f.workspaceId, { limit: 100, cursor: null, allowedEventIds: [f.eventId], allowedPlanIds: [] }, f.human)
    const second = await store.listProviderReceipts(f.workspaceId, { limit: 100, cursor: first.nextCursor, allowedEventIds: [f.eventId], allowedPlanIds: [] }, f.human)
    expect(first.items).toHaveLength(100); expect(second.items).toHaveLength(5); expect(second.nextCursor).toBeNull()
    expect(JSON.stringify(first.items)).not.toContain('normalized_payload')
    expect((await store.listProviderReceipts(f.workspaceId, { limit: 100, cursor: null, allowedEventIds: [], allowedPlanIds: [] }, f.human)).items).toEqual([])
    const g = await fixture(), client = await appPool.connect()
    await expect(pool.query("UPDATE association_integration_events SET state='pending' WHERE workspace_id=$1", [f.workspaceId])).rejects.toMatchObject({ code: '23514' })
    try {
      await client.query('BEGIN'); await client.query("SELECT set_config('app.current_user_id',$1,true)", [g.userId])
      expect((await client.query('SELECT id FROM association_integration_events WHERE workspace_id=$1', [f.workspaceId])).rowCount).toBe(0)
      expect((await client.query('DELETE FROM association_integration_events WHERE workspace_id=$1', [f.workspaceId])).rowCount).toBe(0)
    } finally { await client.query('ROLLBACK'); client.release() }
  })
})
