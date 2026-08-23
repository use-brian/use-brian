import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import type { BrainAuth } from '../../brain-mcp/auth.js'
import type { BrainKeyStore } from '../../db/brain-keys-store.js'
import type { AssociationStore } from '../../db/association-store.js'
import { AssociationError } from '../../association/domain.js'
import { associationRoutes } from '../association.js'

const WID = '11111111-1111-4111-8111-111111111111'
const OTHER_WID = '22222222-2222-4222-8222-222222222222'
const CONTACT_ID = '33333333-3333-4333-8333-333333333333'
const RECORD_ID = '44444444-4444-4444-8444-444444444444'

function auth(overrides: Partial<BrainAuth> = {}): BrainAuth {
  return {
    keyId: 'brain-key-1',
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
    listMemberships: vi.fn(),
    updateMembership: vi.fn(),
    upsertEvent: vi.fn(),
    listEvents: vi.fn(),
    upsertTicket: vi.fn(),
    listTickets: vi.fn(),
    createOrder: vi.fn(),
    getOrder: vi.fn(),
    reconcileProviderEvent: vi.fn(),
    listEventRegistrations: vi.fn(),
    updateRegistration: vi.fn(),
    listNotifications: vi.fn(),
  }
}

function makeApp(store: AssociationStore, resolvedAuth: BrainAuth | null = auth()) {
  const app = express()
  app.use(express.json())
  app.use('/api/association', associationRoutes({
    brainKeyStore: {} as BrainKeyStore,
    store,
    authenticate: vi.fn().mockResolvedValue(resolvedAuth),
  }))
  return app
}

describe('[COMP:api/association-route] credential and workspace authority', () => {
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
      { credentialKind: 'api_key', credentialId: 'brain-key-1' },
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
    })
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
      { credentialKind: 'api_key', credentialId: 'brain-key-1' },
    )
  })
})
