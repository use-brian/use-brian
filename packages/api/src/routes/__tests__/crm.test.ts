/**
 * CRM R2 route authority tests.
 *
 * [COMP:api/crm-r2-route]
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { createTestApp } from './helpers.js'

vi.mock('../../db/workspace-viewpoint.js', () => ({
  resolveWorkspaceViewpoint: vi.fn(),
}))
vi.mock('../../db/crm.js', () => ({
  createCompany: vi.fn(),
  createContact: vi.fn(),
  createDeal: vi.fn(),
  updateCompany: vi.fn(),
  updateContact: vi.fn(),
  updateDeal: vi.fn(),
}))
vi.mock('../../db/entities-store.js', () => ({
  getEntityById: vi.fn(),
  updateEntity: vi.fn(),
}))
vi.mock('../../db/entity-merge-store.js', () => ({
  createEntityMergeStore: vi.fn(() => ({})),
}))
vi.mock('../../brain-stream/notify.js', () => ({
  notifyBrainInboxChange: vi.fn(),
}))
vi.mock('../../db/crm-r2.js', () => ({
  CRM_FIELD_TYPES: [
    'text', 'number', 'date', 'boolean', 'single_select', 'multi_select', 'entity_reference',
  ],
  CRM_PRESET_IDS: ['services_saas', 'enterprise_sales', 'partnership_referral'],
  CRM_REFERENCE_KINDS: ['person', 'company', 'deal'],
  addCrmDealParticipant: vi.fn(),
  applyCrmFieldPreset: vi.fn(),
  appendCrmActivity: vi.fn(),
  archiveCrmFieldDefinition: vi.fn(),
  createCrmFieldDefinition: vi.fn(),
  createCrmPipeline: vi.fn(),
  createCrmSavedView: vi.fn(),
  createCrmStage: vi.fn(),
  crmRowsToCsv: vi.fn(),
  deleteCrmSavedView: vi.fn(),
  findCrmDuplicateGroups: vi.fn(),
  getCrmConfig: vi.fn(),
  getCrmR2Record: vi.fn(),
  getCrmReport: vi.fn(),
  getCrmSummary: vi.fn(),
  listCrmDealParticipants: vi.fn(),
  listCrmRecordPage: vi.fn(),
  listCrmRecordRelationships: vi.fn(),
  listCrmR2Records: vi.fn(),
  listCrmSavedViews: vi.fn(),
  listCrmTimeline: vi.fn(),
  lookupCrmRecords: vi.fn(),
  removeCrmDealParticipant: vi.fn(),
  reorderCrmFields: vi.fn(),
  reorderCrmPipelines: vi.fn(),
  reorderCrmStages: vi.fn(),
  restoreCrmFieldDefinition: vi.fn(),
  setCrmArchived: vi.fn(),
  setCrmDealPipelineStage: vi.fn(),
  setCrmDealPrimaryContact: vi.fn(),
  setCrmStageArchived: vi.fn(),
  updateCrmCustomFields: vi.fn(),
  updateCrmFieldDefinition: vi.fn(),
  updateCrmPipeline: vi.fn(),
  updateCrmStage: vi.fn(),
  validateCrmCustomFieldValues: vi.fn(),
}))

import { crmRoutes } from '../crm.js'
import { resolveWorkspaceViewpoint } from '../../db/workspace-viewpoint.js'
import { createDeal, updateContact, updateDeal } from '../../db/crm.js'
import { getEntityById, updateEntity } from '../../db/entities-store.js'
import {
  appendCrmActivity,
  applyCrmFieldPreset,
  createCrmPipeline,
  getCrmConfig,
  getCrmR2Record,
  getCrmSummary,
  listCrmDealParticipants,
  listCrmRecordPage,
  listCrmRecordRelationships,
  listCrmR2Records,
  lookupCrmRecords,
  setCrmDealPrimaryContact,
  updateCrmPipeline,
  validateCrmCustomFieldValues,
} from '../../db/crm-r2.js'

const WS = 'd126f352-7f5c-48b2-88d0-66694be0c93d'
const CTX = { userId: 'user-1', workspaceId: WS }
const CONFIG = { pipelines: [], fields: [] }

function makeApp(role: string | null = 'member', authenticated = true) {
  const workspaceStore = {
    getRole: vi.fn(async (userId: string) => userId === CTX.userId ? role : null),
  }
  return createTestApp(
    '/api/crm',
    crmRoutes({ workspaceStore: workspaceStore as never }),
    authenticated ? { userId: CTX.userId } : undefined,
  )
}

describe('[COMP:api/crm-r2-route] CRM R2 route authority', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveWorkspaceViewpoint).mockResolvedValue(CTX as never)
    vi.mocked(getCrmConfig).mockResolvedValue(CONFIG)
    vi.mocked(validateCrmCustomFieldValues).mockResolvedValue([])
  })

  it('requires authentication and workspace membership', async () => {
    const unauthenticated = await request(makeApp('member', false))
      .get(`/api/crm/${WS}/config`)
    expect(unauthenticated.status).toBe(401)

    const nonMember = await request(makeApp(null))
      .get(`/api/crm/${WS}/config`)
    expect(nonMember.status).toBe(403)
    expect(resolveWorkspaceViewpoint).not.toHaveBeenCalled()
  })

  it('lets a member read access-scoped configuration', async () => {
    const response = await request(makeApp())
      .get(`/api/crm/${WS}/config`)

    expect(response.status).toBe(200)
    expect(response.body).toEqual(CONFIG)
    expect(getCrmConfig).toHaveBeenCalledWith(CTX.userId, WS, false)
  })

  it('reserves pipeline configuration for owners and admins', async () => {
    const memberResponse = await request(makeApp('member'))
      .post(`/api/crm/${WS}/pipelines`)
      .send({ name: 'Renewals' })
    expect(memberResponse.status).toBe(403)
    expect(createCrmPipeline).not.toHaveBeenCalled()

    vi.mocked(createCrmPipeline).mockResolvedValue({
      id: 'pipeline-1',
      name: 'Renewals',
      isDefault: false,
      position: 1,
      stages: [],
    })
    const adminResponse = await request(makeApp('admin'))
      .post(`/api/crm/${WS}/pipelines`)
      .send({ name: 'Renewals' })
    expect(adminResponse.status).toBe(201)
    expect(createCrmPipeline).toHaveBeenCalledWith({ ...CTX, name: 'Renewals' })
  })

  it('creates a deal in the pipeline that owns the requested stable stage', async () => {
    vi.mocked(getCrmConfig).mockResolvedValue({
      fields: [],
      pipelines: [
        {
          id: 'pipeline-default', name: 'Sales', isDefault: true, position: 0,
          stages: [{ id: 'stage-lead', pipelineId: 'pipeline-default', name: 'Lead', legacyKey: 'lead', category: 'open', position: 0, probability: 10, requiredFields: [] }],
        },
        {
          id: 'pipeline-renewals', name: 'Renewals', isDefault: false, position: 1,
          stages: [{ id: 'stage-review', pipelineId: 'pipeline-renewals', name: 'Review', legacyKey: null, category: 'open', position: 0, probability: 65, requiredFields: [] }],
        },
      ],
    } as never)
    vi.mocked(createDeal).mockResolvedValue({ id: 'deal-1', contactId: null } as never)
    vi.mocked(getEntityById).mockResolvedValue({
      id: 'deal-1', attributes: {},
    } as never)
    vi.mocked(updateEntity).mockResolvedValue({} as never)

    const response = await request(makeApp())
      .post(`/api/crm/${WS}/records`)
      .send({ kind: 'deal', name: 'Annual renewal', pipelineStageId: 'stage-review', currencyCode: 'eur' })

    expect(response.status).toBe(201)
    expect(updateEntity).toHaveBeenCalledWith(
      CTX.userId,
      'deal-1',
      expect.objectContaining({
        attributes: expect.objectContaining({
          pipeline_id: 'pipeline-renewals',
          pipeline_stage_id: 'stage-review',
          currency_code: 'EUR',
        }),
      }),
      CTX,
    )
    expect(appendCrmActivity).toHaveBeenCalledWith(expect.objectContaining({
      entityId: 'deal-1',
      activityType: 'field_change',
    }))
    expect(validateCrmCustomFieldValues).toHaveBeenCalledWith({
      ctx: CTX,
      entityKind: 'deal',
      values: {},
      requireAll: true,
    })
  })

  it('reserves reusable field presets for admins and reports idempotent results', async () => {
    const denied = await request(makeApp('member'))
      .post(`/api/crm/${WS}/field-presets/services_saas`)
    expect(denied.status).toBe(403)

    vi.mocked(applyCrmFieldPreset).mockResolvedValue({
      created: ['work_type'], skipped: ['opportunity_type'], revived: [], conflicts: [],
    })
    const applied = await request(makeApp('admin'))
      .post(`/api/crm/${WS}/field-presets/services_saas`)
    expect(applied.status).toBe(200)
    expect(applied.body.created).toEqual(['work_type'])
    expect(applyCrmFieldPreset).toHaveBeenCalledWith({
      userId: CTX.userId,
      workspaceId: WS,
      presetId: 'services_saas',
    })
  })
})

describe('[COMP:api/crm-config-http] CRM configuration HTTP boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveWorkspaceViewpoint).mockResolvedValue(CTX as never)
  })

  it('keeps lifecycle mutations admin-only', async () => {
    const denied = await request(makeApp('member'))
      .patch(`/api/crm/${WS}/pipelines/pipeline-1`)
      .send({ name: 'Renewals' })
    expect(denied.status).toBe(403)
    expect(updateCrmPipeline).not.toHaveBeenCalled()

    vi.mocked(updateCrmPipeline).mockResolvedValue(true)
    const allowed = await request(makeApp('admin'))
      .patch(`/api/crm/${WS}/pipelines/pipeline-1`)
      .send({ name: 'Renewals' })
    expect(allowed.status).toBe(200)
    expect(updateCrmPipeline).toHaveBeenCalledWith({
      userId: CTX.userId,
      workspaceId: WS,
      pipelineId: 'pipeline-1',
      name: 'Renewals',
    })
  })
})

describe('[COMP:api/crm-page-http] CRM collection HTTP boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveWorkspaceViewpoint).mockResolvedValue(CTX as never)
  })

  it('activates keyset paging only when kind is supplied and forwards URL filters', async () => {
    vi.mocked(listCrmRecordPage).mockResolvedValue({
      items: [], nextCursor: 'next-page', hasMore: true,
    })

    const response = await request(makeApp()).get(
      `/api/crm/${WS}/records?kind=deal&limit=500&sort=amount&direction=asc`
      + `&pipeline=pipeline-1&stage=stage-1,stage-2&company=none&owner=user-2,none`
      + `&filter=overdue&cf.work_type=SaaS&q=fictional`,
    )

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ items: [], nextCursor: 'next-page', hasMore: true })
    expect(listCrmRecordPage).toHaveBeenCalledWith(CTX, expect.objectContaining({
      kind: 'deal', limit: 100, sort: 'amount', direction: 'asc',
      pipelineId: 'pipeline-1', stageIds: ['stage-1', 'stage-2'],
      companyIds: ['none'], owners: ['user-2', 'none'], attention: 'overdue',
      custom: { work_type: ['SaaS'] }, search: 'fictional',
    }))
  })

  it('keeps the no-kind compatibility response outside the main paged contract', async () => {
    vi.mocked(listCrmR2Records).mockResolvedValue([])

    const response = await request(makeApp()).get(`/api/crm/${WS}/records`)

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ deals: [], contacts: [], companies: [] })
    expect(listCrmR2Records).toHaveBeenCalledWith(CTX, { includeArchived: false })
    expect(listCrmRecordPage).not.toHaveBeenCalled()
  })

  it('serves access-scoped summary and bounded lookup resources', async () => {
    vi.mocked(getCrmSummary).mockResolvedValue({
      totals: { deals: 2, contacts: 4, companies: 1 },
      attention: { overdue: 1, stale: 0, noAmount: 1, orphaned: 2 },
      stages: [],
    })
    vi.mocked(lookupCrmRecords).mockResolvedValue([])

    const summary = await request(makeApp()).get(`/api/crm/${WS}/summary?pipeline=pipeline-1`)
    const lookup = await request(makeApp()).get(`/api/crm/${WS}/lookup?kind=contact&limit=900&q=fic`)

    expect(summary.status).toBe(200)
    expect(getCrmSummary).toHaveBeenCalledWith(CTX, 'pipeline-1')
    expect(lookup.status).toBe(200)
    expect(lookupCrmRecords).toHaveBeenCalledWith({
      ctx: CTX, kind: 'person', query: 'fic', limit: 100,
    })
  })

  it('rejects invalid kind, sort, direction, cursor, and limit shapes', async () => {
    expect((await request(makeApp()).get(`/api/crm/${WS}/records?kind=unknown`)).status).toBe(400)
    expect((await request(makeApp()).get(`/api/crm/${WS}/records?kind=contact&sort=amount`)).status).toBe(400)
    expect((await request(makeApp()).get(`/api/crm/${WS}/records?kind=deal&direction=sideways`)).status).toBe(400)
    expect((await request(makeApp()).get(`/api/crm/${WS}/records?kind=deal&limit=0`)).status).toBe(400)
    expect((await request(makeApp()).get(`/api/crm/${WS}/lookup?kind=company&limit=nope`)).status).toBe(400)
    vi.mocked(listCrmRecordPage).mockRejectedValueOnce(new Error('Invalid CRM cursor'))
    expect((await request(makeApp()).get(`/api/crm/${WS}/records?kind=deal&cursor=bad`)).status).toBe(400)
  })
})

describe('[COMP:api/crm-record-http] canonical CRM record HTTP boundary', () => {
  const beforeContact = {
    id: 'contact-1',
    kind: 'person' as const,
    name: 'Fictional Contact',
    attributes: { email: 'old@example.test', tags: [] },
    archivedAt: null,
    updatedAt: '2026-08-20T00:00:00.000Z',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveWorkspaceViewpoint).mockResolvedValue(CTX as never)
    vi.mocked(listCrmRecordRelationships).mockResolvedValue({
      contacts: [], companies: [], deals: [],
    })
    vi.mocked(listCrmDealParticipants).mockResolvedValue([])
    vi.mocked(appendCrmActivity).mockResolvedValue(null)
    vi.mocked(setCrmDealPrimaryContact).mockResolvedValue(true)
  })

  it('cold-loads one visible deal with direct relationships and participants', async () => {
    const deal = {
      id: 'deal-1', kind: 'deal' as const, name: 'Example engagement',
      attributes: { contact_id: 'contact-1', currency_code: 'HKD' },
      archivedAt: null, updatedAt: '2026-08-20T00:00:00.000Z',
    }
    vi.mocked(getCrmR2Record).mockResolvedValue(deal)
    vi.mocked(listCrmRecordRelationships).mockResolvedValue({
      contacts: [beforeContact], companies: [], deals: [],
    })
    vi.mocked(listCrmDealParticipants).mockResolvedValue([{
      contactId: 'contact-1', role: 'Sponsor', isPrimary: true,
      name: 'Fictional Contact', email: 'old@example.test',
    }])

    const response = await request(makeApp()).get(`/api/crm/${WS}/records/deal-1`)

    expect(response.status).toBe(200)
    expect(response.body.record).toMatchObject({ id: 'deal-1', kind: 'deal', currencyCode: 'HKD' })
    expect(response.body.relationships.contacts[0]).toMatchObject({ id: 'contact-1', kind: 'contact' })
    expect(response.body.participants[0]).toMatchObject({ role: 'Sponsor', isPrimary: true })
  })

  it('rejects kind-specific field drift and inactive owners', async () => {
    vi.mocked(getCrmR2Record).mockResolvedValue(beforeContact)

    const wrongField = await request(makeApp())
      .patch(`/api/crm/${WS}/records/contact-1`)
      .send({ amount: 50 })
    expect(wrongField.status).toBe(400)
    expect(wrongField.body.error).toContain('Unsupported fields')

    const inactiveOwner = await request(makeApp())
      .patch(`/api/crm/${WS}/records/contact-1`)
      .send({ ownerId: 'former-member' })
    expect(inactiveOwner.status).toBe(400)
    expect(inactiveOwner.body.error).toContain('active workspace member')
  })

  it('patches through the typed helper, reconciles the returned record, and logs each changed field', async () => {
    const afterContact = {
      ...beforeContact,
      attributes: { ...beforeContact.attributes, email: 'new@example.test' },
      updatedAt: '2026-08-24T00:00:00.000Z',
    }
    vi.mocked(getCrmR2Record)
      .mockResolvedValueOnce(beforeContact)
      .mockResolvedValueOnce(afterContact)
    vi.mocked(updateContact).mockResolvedValue({ id: 'contact-1' } as never)
    vi.mocked(getEntityById).mockResolvedValue({
      id: 'contact-1', kind: 'person', attributes: afterContact.attributes,
    } as never)

    const response = await request(makeApp())
      .patch(`/api/crm/${WS}/records/contact-1`)
      .send({ email: 'new@example.test' })

    expect(response.status).toBe(200)
    expect(response.body.record.email).toBe('new@example.test')
    expect(updateContact).toHaveBeenCalledWith(
      CTX.userId,
      'contact-1',
      { email: 'new@example.test' },
      undefined,
      CTX,
    )
    expect(appendCrmActivity).toHaveBeenCalledTimes(1)
    expect(appendCrmActivity).toHaveBeenCalledWith(expect.objectContaining({
      entityId: 'contact-1',
      metadata: { field: 'email', before: 'old@example.test', after: 'new@example.test' },
    }))
  })

  it('clears a deal primary contact through the atomic participant boundary', async () => {
    const beforeDeal = {
      id: 'deal-1', kind: 'deal' as const, name: 'Example engagement',
      attributes: { contact_id: 'contact-1' }, archivedAt: null,
      updatedAt: '2026-08-20T00:00:00.000Z',
    }
    const afterDeal = {
      ...beforeDeal,
      attributes: {},
      updatedAt: '2026-08-24T00:00:00.000Z',
    }
    vi.mocked(getCrmR2Record)
      .mockResolvedValueOnce(beforeDeal)
      .mockResolvedValueOnce(afterDeal)
    vi.mocked(setCrmDealPrimaryContact).mockResolvedValue(true)
    vi.mocked(updateDeal).mockResolvedValue({ id: 'deal-1' } as never)
    vi.mocked(getEntityById).mockResolvedValue({
      id: 'deal-1', kind: 'deal', attributes: {},
    } as never)

    const response = await request(makeApp())
      .patch(`/api/crm/${WS}/records/deal-1`)
      .send({ contactId: null })

    expect(response.status).toBe(200)
    expect(setCrmDealPrimaryContact).toHaveBeenCalledWith({
      ctx: CTX, dealId: 'deal-1', contactId: null,
    })
    expect(updateDeal).toHaveBeenCalledWith(
      CTX.userId, 'deal-1', { contactId: null }, undefined, CTX,
    )
    expect(appendCrmActivity).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { field: 'contactId', before: 'contact-1', after: null },
    }))
  })
})
