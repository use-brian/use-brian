import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import type { BrainAuth } from '../../brain-mcp/auth.js'
import type { BrainKeyStore } from '../../db/brain-keys-store.js'
import type { AssociationStore } from '../../db/association-store.js'
import { AssociationError } from '../../association/domain.js'
import { WorkspaceModuleError } from '../../db/workspace-modules-store.js'
import { CrmOperationsError, type CrmOperationsServicePort } from '@use-brian/core'
import { associationRoutes } from '../association.js'

const WID = '11111111-1111-4111-8111-111111111111'
const OTHER_WID = '22222222-2222-4222-8222-222222222222'
const CONTACT_ID = '33333333-3333-4333-8333-333333333333'
const RECORD_ID = '44444444-4444-4444-8444-444444444444'

function auth(overrides: Partial<BrainAuth> = {}): BrainAuth {
  return {
    keyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    workspaceId: WID,
    scope: 'read_write',
    maxClearance: 'internal',
    authKind: 'api_key',
    storeScope: 'none',
    agentScope: 'none',
    ...overrides,
  }
}

function fakeStore(): AssociationStore {
  return {
    linkExternalIdentity: vi.fn(),
    resolveExternalIdentity: vi.fn(),
    createEnquiry: vi.fn(),
    listEnquiries: vi.fn(),
    updateEnquiry: vi.fn(),
    addEnquiryNote: vi.fn(),
    listEnquiryNotes: vi.fn(),
    appendConsent: vi.fn(),
    listConsents: vi.fn(),
    upsertPlan: vi.fn(),
    listPlans: vi.fn(),
    createMembership: vi.fn(),
    importSourceMembership: vi.fn(),
    listMemberships: vi.fn(),
    updateMembership: vi.fn(),
    listSponsorshipAllocations: vi.fn(),
    createSponsorshipAllocation: vi.fn(),
    cancelSponsorshipAllocation: vi.fn(),
    listSponsorshipInvitations: vi.fn(),
    issueSponsorshipInvitation: vi.fn(),
    revokeSponsorshipInvitation: vi.fn(),
    redeemSponsorshipInvitation: vi.fn(),
    listMembershipRescues: vi.fn(),
    createMembershipRescue: vi.fn(),
    settleMembershipRescue: vi.fn(),
    reverseMembershipRescue: vi.fn(),
    cancelMembershipRescue: vi.fn(),
    upsertEvent: vi.fn(),
    listEvents: vi.fn(),
    upsertTicket: vi.fn(),
    listTickets: vi.fn(),
    upsertPromotion: vi.fn(),
    importPromotion: vi.fn(),
    listPromotions: vi.fn(),
    reserveMembershipCheckout: vi.fn(),
    bindMembershipCheckoutProvider: vi.fn(),
    listWaitlist: vi.fn(),
    offerWaitlistPlace: vi.fn(),
    previewOrderDestinations: vi.fn(),
    createOrder: vi.fn(),
    importSourceOrder: vi.fn(),
    getOrder: vi.fn(),
    listOrders: vi.fn(),
    expireDueOrder: vi.fn(),
    cancelOrder: vi.fn(),
    confirmFreeOrder: vi.fn(),
    reconcileProviderEvent: vi.fn(),
    reconcileProviderFinancialEvent: vi.fn(),
    bindOrderProvider: vi.fn(),
    reconcileProviderEntitlement: vi.fn(),
    retryProviderEventReceipt: vi.fn(),
    resolveProviderReceipt: vi.fn(),
    listProviderReceipts: vi.fn(),
    listEventRegistrations: vi.fn(),
    listOperationalRoster: vi.fn(),
    getRegistrationManagement: vi.fn().mockResolvedValue({ sourceKind: 'commerce' }),
    updateRegistration: vi.fn(),
    correctRegistrationCheckIn: vi.fn(),
    listNotifications: vi.fn(),
  }
}

function makeApp(
  store: AssociationStore,
  resolvedAuth: BrainAuth | null = auth(),
  crmService?: CrmOperationsServicePort,
) {
  const app = express()
  app.use(express.json())
  app.use('/api/association', associationRoutes({
    brainKeyStore: {} as BrainKeyStore,
    store,
    ...(crmService ? { crmService } : {}),
    authenticate: vi.fn().mockResolvedValue(resolvedAuth),
  }))
  return app
}

describe('[COMP:api/association-route] credential and workspace authority', () => {
  it('preserves durable receipt creation, pagination and retry details at the compatibility boundary', async () => {
    const store = fakeStore(), app = makeApp(store)
    const event = { provider: 'fixture', providerReference: 'fictional-subscription', providerPeriodId: 'period-1', eventId: 'event-1', occurredAt: '2026-09-09T00:00:00Z', command: { kind: 'update_entitlement', entitlementId: RECORD_ID, status: 'cancelled' } }
    vi.mocked(store.reconcileProviderEntitlement).mockResolvedValue({ record: { id: RECORD_ID }, created: true, receipt: { id: CONTACT_ID, state: 'applied' } })
    const accepted = await request(app).post('/api/association/provider-entitlement-events').send(event)
    expect(accepted.status).toBe(201)
    expect(accepted.body).toMatchObject({ entitlement: { id: RECORD_ID }, receipt: { id: CONTACT_ID, state: 'applied' } })
    vi.mocked(store.listProviderReceipts).mockResolvedValue({ items: [{ id: CONTACT_ID, state: 'applied' }], nextCursor: null })
    expect((await request(app).get('/api/association/provider-receipts?limit=10&state=applied')).body).toMatchObject({ receipts: [{ id: CONTACT_ID }], nextCursor: null })
    vi.mocked(store.reconcileProviderEntitlement).mockRejectedValue(new CrmOperationsError('conflict', 'Provider receipt is processing.', { reason: 'provider_event_processing', receiptId: CONTACT_ID, receiptState: 'processing' }))
    const busy = await request(app).post('/api/association/provider-entitlement-events').send(event)
    expect(busy.status).toBe(409)
    expect(busy.body.details).toMatchObject({ receiptId: CONTACT_ID, receiptState: 'processing' })
    expect((await request(makeApp(store, auth({ scope: 'read' }))).post('/api/association/provider-entitlement-events').send(event)).status).toBe(403)
  })
  it('accepts backend binding and rejects incomplete payment evidence before the store', async () => {
    const store = fakeStore(), binding = { provider: 'fixture', providerReference: 'fictional-object', amountMinor: 1000, currency: 'USD' }
    vi.mocked(store.bindOrderProvider).mockResolvedValue({ record: { id: RECORD_ID, ...binding }, created: true })
    const response = await request(makeApp(store)).post(`/api/association/orders/${RECORD_ID}/provider-binding`).send(binding)
    expect(response.status).toBe(201)
    expect(store.bindOrderProvider).toHaveBeenCalledWith(WID, RECORD_ID, binding, expect.objectContaining({ credentialKind: 'brain_key' }))
    const rejected = await request(makeApp(store)).post(`/api/association/orders/${RECORD_ID}/provider-events`).send({ provider: 'fixture', eventId: 'fictional-event', targetStatus: 'paid', occurredAt: '2026-09-01T00:00:00Z' })
    expect(rejected.status).toBe(400)
    expect(store.reconcileProviderEvent).not.toHaveBeenCalled()
  })
  it('accepts only a closed normalized financial event at the backend route', async () => {
    const store = fakeStore(), event = { provider: 'stripe', providerReference: 'cs_fixture', adjustmentReference: 're_fixture',
      eventId: 'evt_fixture', kind: 'refund' as const, status: 'succeeded' as const, amountMinor: 400,
      currency: 'USD', occurredAt: '2026-09-01T01:00:00Z', metadata: {} }
    vi.mocked(store.reconcileProviderFinancialEvent).mockResolvedValue({ record: { id: RECORD_ID, refundState: 'partial' }, created: true,
      receipt: { id: CONTACT_ID, state: 'applied' } })
    const accepted = await request(makeApp(store)).post(`/api/association/orders/${RECORD_ID}/provider-financial-events`).send(event)
    expect(accepted.status).toBe(201)
    expect(accepted.body).toMatchObject({ order: { id: RECORD_ID, refundState: 'partial' }, reconciled: true,
      receipt: { id: CONTACT_ID, state: 'applied' } })
    expect(store.reconcileProviderFinancialEvent).toHaveBeenCalledWith(WID, RECORD_ID, event, expect.objectContaining({ credentialKind: 'brain_key' }))
    const rejected = await request(makeApp(store)).post(`/api/association/orders/${RECORD_ID}/provider-financial-events`)
      .send({ ...event, status: 'open' })
    expect(rejected.status).toBe(400)
    expect(store.reconcileProviderFinancialEvent).toHaveBeenCalledTimes(1)
  })
  it('routes destination discovery before order identity lookup with the actual credential', async () => {
    const store = fakeStore()
    vi.mocked(store.previewOrderDestinations).mockResolvedValue({ choices: [], validForMs: 30_000 })
    const response = await request(makeApp(store, auth({ scope: 'read' }))).get(`/api/association/orders/destinations?contactIds=${CONTACT_ID}`)
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ choices: [], validForMs: 30_000 })
    expect(store.previewOrderDestinations).toHaveBeenCalledWith(WID, [CONTACT_ID], expect.objectContaining({ credentialId: auth().keyId }))
    expect(store.getOrder).not.toHaveBeenCalled()
  })

  it('returns canonical financial totals with the filtered order page', async () => {
    const store = fakeStore()
    vi.mocked(store.listOrders).mockResolvedValue({ items: [{ id: RECORD_ID, status: 'paid' }], nextCursor: null, total: 1,
      financialSummary: [{ currency: 'USD', orderCount: 1, settledOrderCount: 1, subtotalMinor: '1200',
        discountMinor: '200', grossMinor: '1000', refundedMinor: '400', netMinor: '600', pendingMinor: '0' }] })
    const response = await request(makeApp(store, auth({ scope: 'read' }))).get('/api/association/orders')
      .query({ eventId: RECORD_ID, status: 'paid', limit: '10' })
    expect(response.status).toBe(200)
    expect(response.body).toMatchObject({ orders: [{ id: RECORD_ID }], financialSummary: [{ currency: 'USD', netMinor: '600' }] })
    expect(store.listOrders).toHaveBeenCalledWith(WID, expect.objectContaining({ eventId: RECORD_ID, status: 'paid', limit: 10 }), expect.objectContaining({ credentialKind: 'brain_key' }))
  })
  it('adapts paginated waitlist reads and explicit offers through the shared command service', async () => {
    const store = fakeStore()
    vi.mocked(store.listWaitlist).mockResolvedValue({ items: [{ id: RECORD_ID, waitlistState: 'waiting' }], nextCursor: null })
    vi.mocked(store.offerWaitlistPlace).mockResolvedValue({ record: { orderId: CONTACT_ID }, created: true })
    const app = makeApp(store)
    const page = await request(app).get('/api/association/waitlist').query({ includeClosed: 'true', limit: '10' })
    expect(page.status).toBe(200)
    expect(page.body).toMatchObject({ submissions: [{ id: RECORD_ID }], nextCursor: null })
    expect(store.listWaitlist).toHaveBeenCalledWith(WID, expect.objectContaining({ includeClosed: true, limit: 10 }), expect.objectContaining({ credentialKind: 'brain_key' }))
    const offered = await request(app).post(`/api/association/waitlist/${RECORD_ID}/offer`).send({ promotionId: CONTACT_ID })
    expect(offered.status).toBe(201)
    expect(store.offerWaitlistPlace).toHaveBeenCalledWith(WID, expect.objectContaining({ submissionId: RECORD_ID, promotionId: CONTACT_ID, reservationMinutes: 20 }), expect.any(Object))
    expect((await request(makeApp(store, auth({ scope: 'read' }))).post(`/api/association/waitlist/${RECORD_ID}/offer`).send({ promotionId: CONTACT_ID })).status).toBe(403)
  })
  it('lists retired notifications with their prior delivery state through the compatibility route', async () => {
    const store=fakeStore()
    vi.mocked(store.listNotifications).mockResolvedValue({items:[{id:RECORD_ID,status:'retired',retiredFromStatus:'sending',retiredAt:'2026-01-01T00:00:00Z'}],nextCursor:null})
    const result=await request(makeApp(store,auth({scope:'read'}))).get('/api/association/notifications').query({status:'retired',limit:'10'})
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({notifications:[{status:'retired',retiredFromStatus:'sending'}],nextCursor:null})
    expect(store.listNotifications).toHaveBeenCalledWith(WID,expect.objectContaining({status:'retired',limit:10}),expect.objectContaining({credentialKind:'api_key'}))
  })

  it('requires a valid Brain credential', async () => {
    const store = fakeStore()
    const response = await request(makeApp(store, null)).get('/api/association/events')
    expect(response.status).toBe(401)
    expect(store.listEvents).not.toHaveBeenCalled()
  })

  it('allows reads but blocks mutations for a read-only credential', async () => {
    const store = fakeStore()
    vi.mocked(store.listEvents).mockResolvedValue({ items: [], nextCursor: null })
    const app = makeApp(store, auth({ scope: 'read' }))

    expect((await request(app).get('/api/association/events')).status).toBe(200)
    expect((await request(app).post('/api/association/enquiries').send({})).status).toBe(403)
    expect(store.createEnquiry).not.toHaveBeenCalled()
  })

  it('derives workspace and actor exclusively from the credential', async () => {
    const store = fakeStore()
    vi.mocked(store.createEnquiry).mockResolvedValue({
      record: { id: RECORD_ID, status: 'new' },
      created: true,
    })
    const response = await request(makeApp(store))
      .post('/api/association/enquiries')
      .send({
        workspaceId: OTHER_WID,
        contactId: CONTACT_ID,
        source: 'website',
        sourceSubmissionId: 'submission-1',
        subject: 'Question',
        message: 'Please contact me',
      })

    expect(response.status).toBe(201)
    expect(store.createEnquiry).toHaveBeenCalledWith(
      WID,
      expect.not.objectContaining({ workspaceId: OTHER_WID }),
      { credentialKind: 'api_key', credentialId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    )
  })

  it('returns an idempotent replay as 200 rather than a second creation', async () => {
    const store = fakeStore()
    vi.mocked(store.appendConsent).mockResolvedValue({
      record: { id: RECORD_ID, action: 'granted' },
      created: false,
    })
    const response = await request(makeApp(store))
      .post('/api/association/consents')
      .send({
        contactId: CONTACT_ID,
        purpose: 'newsletter',
        action: 'granted',
        wordingVersion: '2027-01',
        source: 'website',
        provider: 'wix',
        providerEventId: 'consent-1',
      })
    expect(response.status).toBe(200)
    expect(response.body.created).toBe(false)
  })

  it('validates order attendee quantity before the store is called', async () => {
    const store = fakeStore()
    const response = await request(makeApp(store))
      .post('/api/association/orders')
      .send({
        contactId: CONTACT_ID,
        idempotencyKey: 'checkout-1',
        lines: [{ ticketId: RECORD_ID, quantity: 2, attendees: [{ name: 'Example Person' }] }],
      })
    expect(response.status).toBe(400)
    expect(store.createOrder).not.toHaveBeenCalled()
  })

  it('maps deterministic business conflicts without leaking a 500', async () => {
    const store = fakeStore()
    vi.mocked(store.createOrder).mockRejectedValue(
      new AssociationError('not_available', 'ticket capacity is exhausted', { ticketId: RECORD_ID }),
    )
    const response = await request(makeApp(store))
      .post('/api/association/orders')
      .send({
        contactId: CONTACT_ID,
        idempotencyKey: 'checkout-2',
        lines: [{ ticketId: RECORD_ID, quantity: 1, attendees: [{ name: 'Example Person' }] }],
      })
    expect(response.status).toBe(422)
    expect(response.body).toMatchObject({
      error: 'not_available',
      details: { ticketId: RECORD_ID },
    })
  })

  it('bounds list size and passes an opaque cursor only after validation', async () => {
    const store = fakeStore()
    vi.mocked(store.listEnquiries).mockResolvedValue({ items: [], nextCursor: null })
    const invalid = await request(makeApp(store)).get('/api/association/enquiries?limit=101')
    expect(invalid.status).toBe(400)

    const response = await request(makeApp(store)).get('/api/association/enquiries?limit=25&status=new')
    expect(response.status).toBe(200)
    expect(store.listEnquiries).toHaveBeenLastCalledWith(WID, {
      limit: 25,
      cursor: null,
      status: 'new',
    }, { credentialKind: 'api_key', credentialId: auth().keyId })
  })

  it('keeps check-in as an audited registration mutation instead of a browser flag', async () => {
    const store = fakeStore()
    vi.mocked(store.updateRegistration).mockResolvedValue({
      id: RECORD_ID,
      status: 'checked_in',
    })
    const response = await request(makeApp(store))
      .patch(`/api/association/registrations/${RECORD_ID}`)
      .send({ status: 'checked_in' })
    expect(response.status).toBe(200)
    expect(store.updateRegistration).toHaveBeenCalledWith(
      WID,
      RECORD_ID,
      { status: 'checked_in' },
      { credentialKind: 'brain_key', credentialId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    )
  })

  it('adapts membership writes to the canonical entitlement command without changing the API shape', async () => {
    const store = fakeStore()
    const execute = vi.fn<CrmOperationsServicePort['execute']>().mockResolvedValue({
      command: 'grant_entitlement', created: true, duplicate: false,
      emittedEventIds: ['event-1'],
      record: {
        id: RECORD_ID, contactId: CONTACT_ID,
        planId: '55555555-5555-4555-8555-555555555555', planKey: 'member',
        idempotencyKey: 'membership-1',
        providerEntitlementId: 'provider-member-1', status: 'active',
      },
    })
    const response = await request(makeApp(store, auth(), { execute }))
      .post('/api/association/memberships')
      .send({
        contactId: CONTACT_ID,
        planId: '55555555-5555-4555-8555-555555555555',
        idempotencyKey: 'membership-1', status: 'active',
        startsAt: '2026-08-30T00:00:00.000Z',
        provider: 'example_provider', providerMembershipId: 'provider-member-1',
      })
    expect(response.status).toBe(201)
    expect(response.body.membership).toMatchObject({
      id: RECORD_ID, workspaceId: WID, planKey: 'member',
      idempotencyKey: 'membership-1',
      providerMembershipId: 'provider-member-1', status: 'active',
    })
    expect(response.body.membership).not.toHaveProperty('providerEntitlementId')
    expect(store.createMembership).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WID,
      actor: { kind: 'brain_key', credentialId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    }), expect.objectContaining({
      kind: 'grant_entitlement', contactId: CONTACT_ID,
      providerEntitlementId: 'provider-member-1',
    }))
  })

  it('delegates non-commerce registration lifecycle writes to canonical participation commands', async () => {
    const store = fakeStore()
    vi.mocked(store.getRegistrationManagement).mockResolvedValue({ sourceKind: 'manual' })
    const execute = vi.fn<CrmOperationsServicePort['execute']>().mockResolvedValue({
      command: 'update_participation', created: false, duplicate: false,
      emittedEventIds: ['event-2'],
      record: {
        id: RECORD_ID, contactId: CONTACT_ID, eventId: '55555555-5555-4555-8555-555555555555',
        attendeeName: 'Example Person', metadata: {}, status: 'attended', sourceKind: 'manual',
        checkedInAt: '2026-08-30T02:00:00.000Z',
      },
    })
    const response = await request(makeApp(store, auth(), { execute }))
      .patch(`/api/association/registrations/${RECORD_ID}`)
      .send({ status: 'checked_in' })
    expect(response.status).toBe(200)
    expect(response.body.registration).toMatchObject({
      id: RECORD_ID, workspaceId: WID, attendeeContactId: CONTACT_ID, status: 'checked_in',
      checkedInAt: '2026-08-30T02:00:00.000Z', orderId: null, ticketId: null,
    })
    expect(store.updateRegistration).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledWith(expect.anything(), {
      kind: 'update_participation', participationId: RECORD_ID, status: 'attended',
    })
  })
  it.each(['module_disabled', 'module_draining'] as const)('returns a 409 for %s at the existing commerce route', async (code) => {
    const store = fakeStore()
    vi.mocked(store.upsertTicket).mockRejectedValue(new WorkspaceModuleError(code, 'Module unavailable'))
    const response = await request(makeApp(store))
      .post(`/api/association/events/${RECORD_ID}/tickets`)
      .send({ key: 'standard', name: 'Standard', currency: 'USD', priceMinor: 0 })
    expect(response.status).toBe(409)
    expect(response.body.error).toBe(code)
  })

})
