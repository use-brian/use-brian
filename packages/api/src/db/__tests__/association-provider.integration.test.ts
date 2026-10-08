import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { AssociationOperationalRosterRowSchema, type AssociationActor, type AssociationProviderEventInput, type AssociationProviderFinancialEventInput } from '@use-brian/core'
import { getPool, getAppPool } from '../client.js'
import { createAssociationWorkspaceModulesStore } from '../../association/workspace-module.js'
import { createAssociationStore } from '../association-store.js'
import { createCrmIntegrationStore } from '../crm-integration-store.js'
import { EventInputSchema, TicketInputSchema, OrderCreateSchema } from '../../association/domain.js'
import { _resetCoalescerForTests } from '../../brain-stream/notify.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), appPool = getAppPool(), modules = createAssociationWorkspaceModulesStore(), store = createAssociationStore(), keys = createCrmIntegrationStore()
async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), contactId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Provider fixture',$2)", [workspaceId, userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId])
  await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,created_by_user_id,source) VALUES($1,$2,'person','Fictional buyer',$3,'manual')", [contactId, workspaceId, userId])
  await modules.act(workspaceId, userId, 'association', { action: 'enable', expectedVersion: 1 })
  const human: AssociationActor = { credentialKind: 'user', credentialId: userId, actingUserId: userId }
  const issued = await keys.create(workspaceId,userId,{label:'Fictional provider backend',expiresAt:'2099-01-01T00:00:00Z',
    departmentBinding:{departmentIds:[],cap:'internal'},grants:[
      {operation:'association.read',selectors:{eventIds:'all'}},
      {operation:'association.orders.write',selectors:{eventIds:'all'}},
      // This fixture exercises object/money/replay identity across providers;
      // the dedicated scoped-credential case below tests provider restrictions.
      {operation:'association.provider_events.write',selectors:{eventIds:'all',providerKeys:'all'}},
    ]})
  const integration = (await keys.authenticate(issued.oneTimeSecret))!
  const actor: AssociationActor = {credentialKind:'integration_key',credentialId:integration.credentialId,integration}
  const eventId = String((await store.upsertEvent(workspaceId, EventInputSchema.parse({ slug: 'fixture', title: 'Provider fixture', startsAt: '2099-01-01T12:00:00Z', endsAt: '2099-01-01T14:00:00Z', timezone: 'UTC', mode: 'venue', status: 'published', capacity: 10 }), human)).record.id)
  const ticketId = String((await store.upsertTicket(workspaceId, eventId, TicketInputSchema.parse({ key: 'standard', name: 'Standard', currency: 'USD', priceMinor: 1000, status: 'on_sale', capacity: 10 }), human)).record.id)
  const order = async (attendee: Record<string, unknown> = {}) => String((await store.createOrder(workspaceId, OrderCreateSchema.parse({ contactId, idempotencyKey: randomUUID(), metadata: { ticketingConsent: true, policyVersion: 'ticketing-v1', policyAcceptedAt: '2026-09-01T10:00:00Z' }, lines: [{ ticketId, quantity: 1, attendees: [{ contactId, name: 'Fictional buyer', email: 'buyer@example.com', metadata: { marketingConsent: false, phone: '+852 0000 0000', organisation: 'Fictional Org', jobTitle: 'Tester', questionResponses: { accessibility: 'None' }, ...attendee } }] }] }), human)).record.id)
  const orderId = await order(), binding = { provider: 'fixture', providerReference: randomUUID(), amountMinor: 1000, currency: 'USD' }
  const bind = (id = orderId, patch = {}, a = actor) => store.bindOrderProvider(workspaceId, id, { ...binding, ...patch }, a)
  const evidence: AssociationProviderEventInput = { ...binding, eventId: randomUUID(), targetStatus: 'paid', occurredAt: '2026-09-01T12:00:00.000001Z', metadata: {} }
  const apply = (patch: Partial<AssociationProviderEventInput> = {}, id = orderId, a = actor) => store.reconcileProviderEvent(workspaceId, id, { ...evidence, ...patch }, a)
  const financialEvidence: AssociationProviderFinancialEventInput = { provider: binding.provider,
    providerReference: binding.providerReference, adjustmentReference: randomUUID(), eventId: randomUUID(),
    kind: 'refund', status: 'succeeded', amountMinor: 400, currency: 'USD',
    occurredAt: '2026-09-01T13:00:00.000001Z', metadata: {} }
  const applyFinancial = (patch: Partial<AssociationProviderFinancialEventInput> = {}, id = orderId, a = actor) =>
    store.reconcileProviderFinancialEvent(workspaceId, id, { ...financialEvidence, ...patch }, a)
  return { workspaceId, userId, human, actor, eventId, orderId, binding, evidence, financialEvidence, order, bind, apply, applyFinancial }
}
async function counts(ws: string) {
  return (await pool.query(`SELECT
    (SELECT count(*)::int FROM association_provider_events WHERE workspace_id=$1) evidence,
    (SELECT count(*)::int FROM association_audit_log WHERE workspace_id=$1 AND action IN('order.paid','order.refunded')) transitions,
    (SELECT count(*)::int FROM association_notification_outbox WHERE workspace_id=$1 AND source_kind='order') notifications`, [ws])).rows[0]
}
describe('[COMP:crm/association-provider] Actual provider object and money admission', () => {
  afterAll(async () => { _resetCoalescerForTests(); await pool.end(); await appPool.end() })
  it('requires a prior bound object and exact canonical money before any payment effect', async () => {
    const f = await fixture()
    await expect(f.apply()).rejects.toMatchObject({ code: 'conflict' })
    for (const patch of [{ amountMinor: 999 }, { currency: 'EUR' }]) await expect(f.bind(undefined, patch)).rejects.toMatchObject({ code: 'conflict' })
    expect((await f.bind()).created).toBe(true)
    expect((await f.bind()).created).toBe(false)
    for (const patch of [{ amountMinor: 999 }, { currency: 'EUR' }, { providerReference: 'different' }, { provider: 'other' }]) await expect(f.apply({ ...patch, eventId: randomUUID() })).rejects.toMatchObject({ code: 'conflict' })
    expect(await counts(f.workspaceId)).toEqual({ evidence: 0, transitions: 0, notifications: 0 })
    expect((await f.apply()).record.status).toBe('paid')
  })
  it('deduplicates concurrent event ids and semantic duplicates without repeating transitions or notifications', async () => {
    const f = await fixture(); await f.bind()
    const results = await Promise.allSettled([f.apply(), f.apply()])
    expect(results.filter(r => r.status === 'fulfilled' && r.value.created)).toHaveLength(1)
    for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'conflict', details: { reason: 'provider_event_processing' } })
    expect((await f.apply()).created).toBe(false)
    for (const patch of [{ occurredAt: '2026-09-01T12:00:00.000002Z' }, { metadata: { changed: true } }]) await expect(f.apply(patch)).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await f.apply({ eventId: randomUUID() })
    expect(await counts(f.workspaceId)).toEqual({ evidence: 2, transitions: 1, notifications: 2 })
    await expect(pool.query("UPDATE association_provider_events SET metadata='{}' WHERE workspace_id=$1", [f.workspaceId])).rejects.toMatchObject({ code: '23514' })
  })
  it('serializes competing bindings and prevents database rebinds or changing bound money', async () => {
    const f = await fixture(), second = await f.order(), results = await Promise.allSettled([f.bind(), f.bind(second)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toMatchObject([{ reason: { code: 'conflict' } }])
    const bound = (await pool.query('SELECT id FROM association_orders WHERE workspace_id=$1 AND provider_reference=$2', [f.workspaceId, f.binding.providerReference])).rows[0].id
    await expect(pool.query('UPDATE association_orders SET total_minor=999 WHERE id=$1', [bound])).rejects.toMatchObject({ code: '23514' })
    await expect(pool.query('UPDATE association_orders SET provider_reference=$2 WHERE id=$1', [bound, randomUUID()])).rejects.toMatchObject({ code: '23514' })
    await expect(f.bind(bound, { providerReference: 'other' })).rejects.toMatchObject({ code: 'conflict' })
  })
  it('retains bound recovery after disable and refunds checked-in registrations exactly once', async () => {
    const f = await fixture(); await f.bind(); await f.apply()
    await modules.act(f.workspaceId, f.userId, 'association', { action: 'request_disable', expectedVersion: 2 })
    expect((await f.bind()).created).toBe(false)
    const registration = (await pool.query('SELECT id FROM association_registrations WHERE order_id=$1', [f.orderId])).rows[0].id
    await store.updateRegistration(f.workspaceId, registration, { status: 'checked_in' }, f.human)
    const refund = { eventId: randomUUID(), targetStatus: 'refunded' as const }
    expect((await f.apply(refund)).record).toMatchObject({ status: 'refunded', refundedMinor: '1000', refundState: 'full' })
    await f.apply(refund)
    expect((await pool.query('SELECT status FROM association_registrations WHERE id=$1', [registration])).rows[0].status).toBe('refunded')
    expect((await f.applyFinancial({ kind: 'dispute', status: 'open', amountMinor: 1000, eventId: randomUUID() })).record)
      .toMatchObject({ status: 'refunded', refundedMinor: '1000', refundState: 'full', disputeState: 'open' })
    expect(await counts(f.workspaceId)).toEqual({ evidence: 3, transitions: 2, notifications: 2 })
    await expect(f.apply({ eventId: randomUUID() })).rejects.toMatchObject({ code: 'invalid_transition' })
  })
  it('summarizes partial refund state and releases attendance only at the exact full total', async () => {
    const f = await fixture(); await f.bind(); await f.apply()
    const registration = (await pool.query('SELECT id FROM association_registrations WHERE order_id=$1', [f.orderId])).rows[0].id
    await store.updateRegistration(f.workspaceId, registration, { status: 'checked_in' }, f.human)
    const partial = await f.applyFinancial()
    expect(partial.record).toMatchObject({ status: 'paid', refundedMinor: '400', refundState: 'partial', disputeState: 'none' })
    expect((await pool.query('SELECT status FROM association_registrations WHERE id=$1', [registration])).rows[0].status).toBe('checked_in')
    await expect(f.applyFinancial({ eventId: randomUUID(), status: 'failed',
      occurredAt: '2026-09-01T13:30:00.000001Z' })).rejects.toMatchObject({ code: 'conflict', details: { receiptState: 'needs_reconciliation' } })
    expect(await store.getOrder(f.workspaceId, f.orderId)).toMatchObject({ refundedMinor: '400', refundState: 'partial' })
    const failed = await f.applyFinancial({ eventId: randomUUID(), adjustmentReference: randomUUID(), status: 'failed', amountMinor: 100,
      occurredAt: '2026-09-01T13:45:00.000001Z' })
    expect(failed.record).toMatchObject({ status: 'paid', refundedMinor: '400', refundState: 'partial_failed' })
    const remainder = randomUUID()
    const pending = await f.applyFinancial({ eventId: randomUUID(), adjustmentReference: remainder, status: 'pending', amountMinor: 600,
      occurredAt: '2026-09-01T14:00:00.000001Z' })
    expect(pending.record).toMatchObject({ status: 'paid', refundedMinor: '400', refundState: 'partial_pending' })
    const completedEventId = randomUUID()
    const completed = await f.applyFinancial({ eventId: completedEventId, adjustmentReference: remainder, status: 'succeeded', amountMinor: 600,
      occurredAt: '2026-09-01T15:00:00.000001Z' })
    expect(completed.record).toMatchObject({ status: 'refunded', refundedMinor: '1000', refundState: 'full' })
    expect((await store.listOrders(f.workspaceId, { limit: 10, cursor: null, eventId: f.eventId })).financialSummary)
      .toEqual([{ currency: 'USD', orderCount: 1, settledOrderCount: 1, subtotalMinor: '1000', discountMinor: '0',
        grossMinor: '1000', refundedMinor: '1000', netMinor: '0', pendingMinor: '0' }])
    expect((await pool.query('SELECT status FROM association_registrations WHERE id=$1', [registration])).rows[0].status).toBe('refunded')
    expect((await store.listTickets(f.workspaceId, f.eventId))[0]).toMatchObject({ reservedCount: 0, available: 10 })
    expect((await f.applyFinancial({ eventId: completedEventId, adjustmentReference: remainder, status: 'succeeded', amountMinor: 600,
      occurredAt: '2026-09-01T15:00:00.000001Z' })).created).toBe(false)
    await expect(f.applyFinancial({ eventId: completedEventId, adjustmentReference: remainder, status: 'failed', amountMinor: 600,
      occurredAt: '2026-09-01T15:00:00.000001Z' })).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })
  it('pages a complete operational roster with ticket, order, contact and form evidence regardless of consent or state', async () => {
    const f = await fixture()
    const secondOrder = await f.order({ marketingConsent: true, jobTitle: 'Second role' })
    const secondRegistration = (await pool.query('SELECT id FROM association_registrations WHERE order_id=$1', [secondOrder])).rows[0].id
    await store.updateRegistration(f.workspaceId, secondRegistration, { status: 'cancelled' }, f.human)
    const first = await store.listOperationalRoster(f.workspaceId, f.eventId, { limit: 1, cursor: null })
    expect(first.nextCursor).toEqual(expect.any(String))
    const second = await store.listOperationalRoster(f.workspaceId, f.eventId, { limit: 1, cursor: first.nextCursor })
    const rows = [...first.items, ...second.items].map(row => AssociationOperationalRosterRowSchema.parse(row))
    expect(rows).toHaveLength(2)
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ orderId: f.orderId, ticketKey: 'standard', ticketName: 'Standard', attendeeEmail: 'buyer@example.com',
        phone: '+852 0000 0000', organisation: 'Fictional Org', jobTitle: 'Tester', marketingConsent: false,
        ticketingConsent: true, policyVersion: 'ticketing-v1', questionResponses: { accessibility: 'None' }, status: 'reserved' }),
      expect.objectContaining({ orderId: secondOrder, marketingConsent: true, jobTitle: 'Second role', status: 'cancelled' }),
    ]))
  })
  it('records dispute outcomes without inferring attendance or order transitions', async () => {
    const f = await fixture(); await f.bind(); await f.apply()
    const dispute = randomUUID()
    const opened = await f.applyFinancial({ kind: 'dispute', status: 'open', adjustmentReference: dispute,
      eventId: randomUUID(), amountMinor: 1000 })
    expect(opened.record).toMatchObject({ status: 'paid', refundState: 'none', disputeState: 'open' })
    const won = await f.applyFinancial({ kind: 'dispute', status: 'won', adjustmentReference: dispute,
      eventId: randomUUID(), amountMinor: 1000, occurredAt: '2026-09-01T14:00:00.000001Z' })
    expect(won.record).toMatchObject({ status: 'paid', refundState: 'none', disputeState: 'won' })
    const staleOpen = await f.applyFinancial({ kind: 'dispute', status: 'open', adjustmentReference: dispute,
      eventId: randomUUID(), amountMinor: 1000, occurredAt: '2026-09-01T13:30:00.000001Z' })
    expect(staleOpen.record).toMatchObject({ status: 'paid', refundState: 'none', disputeState: 'won' })
    expect((await pool.query('SELECT status FROM association_registrations WHERE order_id=$1', [f.orderId])).rows[0].status).toBe('confirmed')
    await expect(f.applyFinancial({ kind: 'dispute', status: 'lost', adjustmentReference: dispute,
      eventId: randomUUID(), amountMinor: 1000, occurredAt: '2026-09-01T15:00:00.000001Z' }))
      .rejects.toMatchObject({ code: 'conflict', details: { receiptState: 'needs_reconciliation' } })
    await expect(f.applyFinancial({ kind: 'dispute', status: 'lost', adjustmentReference: dispute,
      eventId: randomUUID(), amountMinor: 1000 }, undefined, f.human)).rejects.toMatchObject({ code: 'not_authorized' })
  })
  it('parks contradictory cumulative refund evidence for exact receipt reconciliation', async () => {
    const f = await fixture(); await f.bind(); await f.apply(); await f.applyFinancial()
    const eventId = randomUUID()
    await expect(f.applyFinancial({ adjustmentReference: randomUUID(), eventId, amountMinor: 700,
      occurredAt: '2026-09-01T14:00:00.000001Z' })).rejects.toMatchObject({ code: 'conflict', details: { receiptState: 'needs_reconciliation' } })
    expect(await store.getOrder(f.workspaceId, f.orderId)).toMatchObject({ status: 'paid', refundedMinor: '400', refundState: 'partial' })
    expect((await pool.query('SELECT state,last_error_code FROM association_integration_events WHERE workspace_id=$1 AND provider_event_id=$2',
      [f.workspaceId, eventId])).rows[0]).toEqual({ state: 'needs_reconciliation', last_error_code: 'conflict' })
  })
  it('refuses late success, new expired bindings and human payment assertions', async () => {
    const f = await fixture(); await f.bind()
    await pool.query("UPDATE association_orders SET reservation_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [f.orderId])
    await expect(f.apply()).rejects.toMatchObject({ code: 'not_available' })
    const second = await f.order()
    await pool.query("UPDATE association_orders SET reservation_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [second])
    await expect(f.bind(second, { providerReference: randomUUID() })).rejects.toMatchObject({ code: 'not_available' })
    await expect(f.bind(undefined, {}, f.human)).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(f.apply({}, undefined, f.human)).rejects.toMatchObject({ code: 'not_authorized' })
    expect(await counts(f.workspaceId)).toEqual({ evidence: 0, transitions: 0, notifications: 0 })
  })
  it('rechecks provider/event credential ceilings and revocation on binding and event replay', async () => {
    const f = await fixture(), issued = await keys.create(f.workspaceId, f.userId, { label: 'Provider backend', expiresAt: '2099-01-01T00:00:00Z', grants: [{ operation: 'association.provider_events.write', selectors: { eventIds: [f.eventId], providerKeys: ['fixture'] } }] })
    const integration = (await keys.authenticate(issued.oneTimeSecret))!, actor: AssociationActor = { credentialKind: 'integration_key', credentialId: integration.credentialId, integration }
    await f.bind(undefined, {}, actor); await f.apply({}, undefined, actor)
    await expect(f.apply({ provider: 'other' }, undefined, actor)).rejects.toMatchObject({ code: 'integration_scope_denied' })
    await keys.revoke(f.workspaceId, f.userId, actor.credentialId)
    await expect(f.bind(undefined, {}, actor)).rejects.toMatchObject({ code: 'credential_revoked' })
    await expect(f.apply({}, undefined, actor)).rejects.toMatchObject({ code: 'credential_revoked' })
  })
  it('rolls back bound provider state or payment evidence when audit fails, then retries safely', async () => {
    const f = await fixture()
    await pool.query("ALTER TABLE association_audit_log ADD CONSTRAINT fixture_refuse_provider_audit CHECK(action NOT IN('order.provider_bound','order.paid')) NOT VALID")
    try { await expect(f.bind()).rejects.toThrow(); expect((await store.getOrder(f.workspaceId, f.orderId))?.providerReference).toBeNull() }
    finally { await pool.query('ALTER TABLE association_audit_log DROP CONSTRAINT fixture_refuse_provider_audit') }
    await f.bind()
    await pool.query("ALTER TABLE association_audit_log ADD CONSTRAINT fixture_refuse_provider_audit CHECK(action<>'order.paid') NOT VALID")
    try { await expect(f.apply()).rejects.toThrow(); expect(await counts(f.workspaceId)).toEqual({ evidence: 0, transitions: 0, notifications: 0 }) }
    finally { await pool.query('ALTER TABLE association_audit_log DROP CONSTRAINT fixture_refuse_provider_audit') }
    expect((await f.apply()).record.status).toBe('paid')
  })
  it('compares every retained legacy evidence field without inventing a historical fingerprint', async () => {
    const f = await fixture(); await f.bind(); await f.apply()
    const legacyId = randomUUID()
    await pool.query(`INSERT INTO association_provider_events(workspace_id,order_id,provider,provider_event_id,target_status,provider_reference,occurred_at,metadata)
      VALUES($1,$2,$3,$4,'paid',$5,$6,'{}')`, [f.workspaceId, f.orderId, f.binding.provider, legacyId, f.binding.providerReference, f.evidence.occurredAt])
    expect((await f.apply({ eventId: legacyId })).created).toBe(false)
    await expect(f.apply({ eventId: legacyId, occurredAt: '2026-09-01T12:00:00.000002Z' })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(f.apply({ eventId: legacyId, metadata: { changed: true } })).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect((await pool.query('SELECT request_fingerprint FROM association_provider_events WHERE workspace_id=$1 AND provider_event_id=$2', [f.workspaceId, legacyId])).rows[0].request_fingerprint).toBeNull()
  })
  it('serializes one provider event identity presented concurrently for different bound orders', async () => {
    const f = await fixture(), second = await f.order(), secondReference = randomUUID()
    await f.bind(); await f.bind(second, { providerReference: secondReference })
    const results = await Promise.allSettled([f.apply(), f.apply({ providerReference: secondReference }, second)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toMatchObject([{ reason: { code: 'idempotency_conflict' } }])
    expect(await counts(f.workspaceId)).toEqual({ evidence: 1, transitions: 1, notifications: 2 })
  })
})
