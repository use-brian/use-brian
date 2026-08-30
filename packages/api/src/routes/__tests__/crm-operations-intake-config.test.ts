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
const SEGMENT_ID = '66666666-6666-4666-8666-666666666666'
const PLAN_ID = '77777777-7777-4777-8777-777777777777'
const ENTITLEMENT_ID = '88888888-8888-4888-8888-888888888888'
const EVENT_ID = '99999999-9999-4999-8999-999999999999'
const PARTICIPATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PIPELINE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const STAGE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const IMPORT_JOB_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

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
    listSegments: vi.fn().mockResolvedValue({ segments: [{ id: SEGMENT_ID, segmentKey: 'active_people' }], catalog: [{ family: 'base', field: 'name' }] }),
    getSegment: vi.fn().mockResolvedValue({ id: SEGMENT_ID, segmentKey: 'active_people' }),
    previewSegment: vi.fn().mockResolvedValue({ rows: [], count: 0, snapshotIds: [] }),
    listCrmEventFilterCatalog: vi.fn().mockResolvedValue({ eventTypes: ['crm.submission.received'], stableKeys: [] }),
    listEntitlementPlans: vi.fn().mockResolvedValue([{ id: PLAN_ID, planKey: 'member' }]),
    listEntitlements: vi.fn().mockResolvedValue([{ id: ENTITLEMENT_ID, contactId: CONTACT_ID }]),
    listEvents: vi.fn().mockResolvedValue([{ id: EVENT_ID, slug: 'annual-meeting' }]),
    listParticipation: vi.fn().mockResolvedValue([{ id: PARTICIPATION_ID, eventId: EVENT_ID }]),
    listPipelines: vi.fn().mockResolvedValue([{
      id: PIPELINE_ID, name: 'Renewals', stages: [{ id: STAGE_ID, name: 'Review' }],
    }]),
  }
  const importService = {
    dryRun: vi.fn().mockResolvedValue({
      dryRunHash: 'a'.repeat(64), bytes: 100, totalRows: 1,
      validRows: 1, failedRows: 0, headers: ['Name'], sampleErrors: [],
    }),
    confirm: vi.fn().mockResolvedValue({ id: IMPORT_JOB_ID, status: 'ready', totalRows: 1 }),
    resume: vi.fn().mockResolvedValue({ id: IMPORT_JOB_ID, status: 'completed', totalRows: 1, processedRows: 1 }),
    cancel: vi.fn(), list: vi.fn().mockResolvedValue([]), get: vi.fn(), errorsCsv: vi.fn(),
  }
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { req.userId = USER_ID; next() })
  app.use('/api/crm', crmOperationsRoutes({ workspaceStore, service, readStore, importService } as never))
  return { app, service, readStore, importService }
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

  it('exposes segment catalogs and preview while routing writes through the canonical service', async () => {
    const member = build('member')
    const list = await request(member.app)
      .get(`/api/crm/${WORKSPACE_ID}/operations/segments?entityKind=person`)
    const preview = await request(member.app)
      .get(`/api/crm/${WORKSPACE_ID}/operations/segments/${SEGMENT_ID}/preview?limit=10&snapshotLimit=100`)
    const saved = await request(member.app)
      .post(`/api/crm/${WORKSPACE_ID}/operations/segments`)
      .send({
        segmentKey: 'active_people', name: 'Active people', description: '', entityKind: 'person',
        predicate: { type: 'group', combinator: 'and', items: [
          { type: 'rule', family: 'base', field: 'name', operator: 'contains', value: 'Example' },
        ] },
      })
    expect(list.status).toBe(200)
    expect(preview.status).toBe(200)
    expect(member.readStore.listSegments).toHaveBeenCalledWith(WORKSPACE_ID, { entityKind: 'person', includeArchived: false })
    expect(member.readStore.previewSegment).toHaveBeenCalledWith(WORKSPACE_ID, SEGMENT_ID, { limit: 10, snapshotLimit: 100 })
    expect(saved.status).toBe(201)
    expect(member.service.execute).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID, actor: { kind: 'user', userId: USER_ID },
    }), expect.objectContaining({ kind: 'save_segment', segmentKey: 'active_people' }))
  })

  it('returns the closed CRM workflow filter catalog', async () => {
    const member = build('member')
    const response = await request(member.app)
      .get(`/api/crm/${WORKSPACE_ID}/operations/workflow-event-catalog`)
    expect(response.body).toEqual({ eventTypes: ['crm.submission.received'], stableKeys: [] })
    expect(member.readStore.listCrmEventFilterCatalog).toHaveBeenCalledWith(WORKSPACE_ID)
  })

  it('lists entitlement and participation state through workspace-qualified read ports', async () => {
    const member = build('member')
    const entitlements = await request(member.app)
      .get(`/api/crm/${WORKSPACE_ID}/operations/entitlements`)
      .query({ contactId: CONTACT_ID, status: 'active', limit: 25 })
    const participation = await request(member.app)
      .get(`/api/crm/${WORKSPACE_ID}/operations/participation`)
      .query({ eventId: EVENT_ID, sourceKind: 'commerce' })
    expect(entitlements.status).toBe(200)
    expect(participation.status).toBe(200)
    expect(member.readStore.listEntitlements).toHaveBeenCalledWith(WORKSPACE_ID, {
      contactId: CONTACT_ID, status: 'active', limit: 25,
    })
    expect(member.readStore.listParticipation).toHaveBeenCalledWith(WORKSPACE_ID, {
      eventId: EVENT_ID, sourceKind: 'commerce', limit: 50,
    })
  })

  it('lists custom pipeline catalogs and moves a deal through the canonical service', async () => {
    const member = build('member')
    const listed = await request(member.app)
      .get(`/api/crm/${WORKSPACE_ID}/operations/pipelines?entityKind=deal`)
    const moved = await request(member.app)
      .patch(`/api/crm/${WORKSPACE_ID}/operations/deals/${CONTACT_ID}/pipeline-stage`)
      .send({ pipelineId: PIPELINE_ID, stageId: STAGE_ID })
    expect(listed.status).toBe(200)
    expect(listed.body.pipelines[0]).toMatchObject({ id: PIPELINE_ID, name: 'Renewals' })
    expect(member.readStore.listPipelines).toHaveBeenCalledWith(WORKSPACE_ID, {
      entityKind: 'deal', includeArchived: false,
    })
    expect(moved.status).toBe(200)
    expect(member.service.execute).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID, actor: { kind: 'user', userId: USER_ID },
    }), {
      kind: 'set_deal_pipeline_stage', dealId: CONTACT_ID,
      pipelineId: PIPELINE_ID, stageId: STAGE_ID,
    })
  })

  it('keeps dry-run separate from confirmed resumable import processing', async () => {
    const owner = build()
    const input = {
      stagedFileId: DEFINITION_ID,
      entityKind: 'contact',
      mapping: { columns: { 0: 'name' } },
    }
    const checked = await request(owner.app)
      .post(`/api/crm/${WORKSPACE_ID}/operations/imports/dry-run`).send(input)
    const confirmed = await request(owner.app)
      .post(`/api/crm/${WORKSPACE_ID}/operations/imports`).send({
        ...input, confirmed: true, dryRunHash: 'a'.repeat(64),
      })
    const resumed = await request(owner.app)
      .post(`/api/crm/${WORKSPACE_ID}/operations/imports/${IMPORT_JOB_ID}/resume`)

    expect(checked.status).toBe(200)
    expect(confirmed.status).toBe(201)
    expect(resumed.body.status).toBe('completed')
    expect(owner.importService.dryRun).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID, actor: { kind: 'user', userId: USER_ID },
    }), input)
    expect(owner.importService.confirm).toHaveBeenCalledTimes(1)
    expect(owner.importService.resume).toHaveBeenCalledWith(expect.anything(), IMPORT_JOB_ID)
  })

  it('routes entitlement and non-commerce participation writes through the canonical service', async () => {
    const member = build('member')
    member.service.execute
      .mockResolvedValueOnce({ command: 'grant_entitlement', record: { id: ENTITLEMENT_ID }, created: true, duplicate: false, emittedEventIds: [] })
      .mockResolvedValueOnce({ command: 'record_participation', record: { id: PARTICIPATION_ID }, created: true, duplicate: false, emittedEventIds: [] })
    const entitlement = await request(member.app)
      .post(`/api/crm/${WORKSPACE_ID}/operations/entitlements`)
      .send({
        contactId: CONTACT_ID, planId: PLAN_ID, idempotencyKey: 'grant-1',
        startsAt: '2026-08-30T00:00:00.000Z', status: 'active',
      })
    const participation = await request(member.app)
      .post(`/api/crm/${WORKSPACE_ID}/operations/participation`)
      .send({
        contactId: CONTACT_ID, eventId: EVENT_ID, sourceKind: 'manual',
        sourceId: 'attendance-1', attendeeName: 'Example Person', status: 'attended',
      })
    expect(entitlement.status).toBe(201)
    expect(participation.status).toBe(201)
    expect(member.service.execute).toHaveBeenNthCalledWith(1, expect.objectContaining({
      workspaceId: WORKSPACE_ID, actor: { kind: 'user', userId: USER_ID },
    }), expect.objectContaining({ kind: 'grant_entitlement', contactId: CONTACT_ID, planId: PLAN_ID }))
    expect(member.service.execute).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({
      kind: 'record_participation', sourceKind: 'manual', sourceId: 'attendance-1',
    }))
  })

  it('rejects commerce fields on the generic participation route', async () => {
    const member = build('member')
    const response = await request(member.app)
      .post(`/api/crm/${WORKSPACE_ID}/operations/participation`)
      .send({
        contactId: CONTACT_ID, eventId: EVENT_ID, sourceKind: 'manual',
        sourceId: 'attendance-2', attendeeName: 'Example Person',
        ticketId: PLAN_ID,
      })
    expect(response.status).toBe(400)
    expect(member.service.execute).not.toHaveBeenCalled()
  })
})
