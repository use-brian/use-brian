import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { CrmOperationsError } from '@use-brian/core'
import { crmOperationsRoutes } from '../crm-operations.js'

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const DEFINITION_ID = '33333333-3333-4333-8333-333333333333'
const SUBMISSION_ID = '44444444-4444-4444-8444-444444444444'
const CONTACT_ID = '55555555-5555-4555-8555-555555555555'

function build(role: 'owner' | 'admin' | 'member' = 'owner') {
  const workspaceStore = { getRole: vi.fn().mockResolvedValue(role) }
  const service = { execute: vi.fn().mockResolvedValue({
    command: 'create_intake_credential', created: true, duplicate: false,
    emittedEventIds: [], record: { id: 'credential-1' }, oneTimeSecret: 'sk_intake_once',
  }) }
  const readStore = {
    authenticate: vi.fn(),
    listDefinitions: vi.fn().mockResolvedValue([{ id: DEFINITION_ID, definitionKey: 'contact_form' }]),
    listCredentials: vi.fn().mockResolvedValue([{ id: 'credential-1', prefix: 'sk_intake_abcd' }]),
    listSubmissions: vi.fn().mockResolvedValue([{ id: SUBMISSION_ID, contactId: CONTACT_ID }]),
    getSubmission: vi.fn().mockResolvedValue({ id: SUBMISSION_ID, contactId: CONTACT_ID, fields: { message: 'Hello' } }),
    listConsentPurposes: vi.fn().mockResolvedValue([{ purposeKey: 'marketing' }]),
    getConsent: vi.fn().mockResolvedValue({ purposes: [], events: [], suppressions: [] }),
    checkSendability: vi.fn().mockResolvedValue({ verdict: 'unknown', reasons: ['consent_not_recorded'], effectiveSuppressionEventIds: [] }),
  }
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.userId = USER_ID; next() })
  app.use('/api/crm', crmOperationsRoutes({ workspaceStore, service, readStore } as never))
  return { app, service, readStore }
}

describe('[COMP:api/crm-operations-route] intake configuration REST adapter', () => {
  it('lists definitions for members but keeps credentials admin-only', async () => {
    const member = build('member')
    expect((await request(member.app).get(`/api/crm/${WORKSPACE_ID}/operations/intake-definitions`)).status).toBe(200)
    expect((await request(member.app).get(`/api/crm/${WORKSPACE_ID}/operations/intake-credentials`)).status).toBe(403)
    expect(member.readStore.listCredentials).not.toHaveBeenCalled()
  })

  it('creates a credential through the canonical service and reveals its key once', async () => {
    const owner = build()
    const response = await request(owner.app)
      .post(`/api/crm/${WORKSPACE_ID}/operations/intake-credentials`)
      .send({ label: 'Website', definitionIds: [DEFINITION_ID] })
    expect(response.status).toBe(201)
    expect(response.body.key).toBe('sk_intake_once')
    expect(owner.service.execute).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID,
      actor: { kind: 'user', userId: USER_ID },
      authority: expect.objectContaining({ canConfigure: true }),
    }), { kind: 'create_intake_credential', label: 'Website', definitionIds: [DEFINITION_ID] })
  })

  it('does not accept request-owned authority fields', async () => {
    const owner = build()
    const response = await request(owner.app)
      .post(`/api/crm/${WORKSPACE_ID}/operations/intake-credentials`)
      .send({ label: 'Website', definitionIds: [DEFINITION_ID], actor: { kind: 'user' } })
    expect(response.status).toBe(400)
    expect(owner.service.execute).not.toHaveBeenCalled()
  })

  it('lists and reads submissions through workspace-qualified read ports', async () => {
    const member = build('member')
    const list = await request(member.app)
      .get(`/api/crm/${WORKSPACE_ID}/operations/submissions?status=new&limit=20`)
    const detail = await request(member.app)
      .get(`/api/crm/${WORKSPACE_ID}/operations/submissions/${SUBMISSION_ID}`)
    expect(list.status).toBe(200)
    expect(detail.status).toBe(200)
    expect(member.readStore.listSubmissions).toHaveBeenCalledWith(WORKSPACE_ID, {
      status: 'new', limit: 20,
    })
    expect(member.readStore.getSubmission).toHaveBeenCalledWith(WORKSPACE_ID, SUBMISSION_ID)
  })

  it('updates a submission only through the canonical service with a server actor', async () => {
    const member = build('member')
    const response = await request(member.app)
      .patch(`/api/crm/${WORKSPACE_ID}/operations/submissions/${SUBMISSION_ID}`)
      .send({ status: 'in_progress', note: 'Claimed for review' })
    expect(response.status).toBe(200)
    expect(member.service.execute).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID,
      actor: { kind: 'user', userId: USER_ID },
      authority: expect.objectContaining({ canWrite: true, canConfigure: false }),
    }), {
      kind: 'update_submission', submissionId: SUBMISSION_ID,
      status: 'in_progress', note: 'Claimed for review',
    })
  })

  it('keeps purpose configuration admin-only and exposes compliance reads to members', async () => {
    const member = build('member')
    member.service.execute.mockRejectedValueOnce(new CrmOperationsError(
      'not_authorized', 'This CRM configuration change requires workspace owner or admin authority.',
    ))
    const purpose = await request(member.app)
      .post(`/api/crm/${WORKSPACE_ID}/operations/consent-purposes`)
      .send({
        purposeKey: 'marketing', label: 'Marketing', description: '',
        requiresConsent: true, applicableChannels: ['email'],
        wordingVersion: 'v1', wording: 'I agree', archived: false,
      })
    expect(purpose.status).toBe(403)
    const compliance = await request(member.app)
      .get(`/api/crm/${WORKSPACE_ID}/operations/contacts/${CONTACT_ID}/compliance`)
    const sendability = await request(member.app)
      .get(`/api/crm/${WORKSPACE_ID}/operations/contacts/${CONTACT_ID}/sendability`)
      .query({ channel: 'email', purposeKey: 'marketing' })
    expect(compliance.status).toBe(200)
    expect(sendability.body.verdict).toBe('unknown')
  })
})
