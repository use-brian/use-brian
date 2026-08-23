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
    'text', 'number', 'date', 'boolean', 'single_select', 'multi_select',
  ],
  addCrmDealParticipant: vi.fn(),
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
  getCrmReport: vi.fn(),
  listCrmDealParticipants: vi.fn(),
  listCrmR2Records: vi.fn(),
  listCrmSavedViews: vi.fn(),
  listCrmTimeline: vi.fn(),
  removeCrmDealParticipant: vi.fn(),
  setCrmArchived: vi.fn(),
  setCrmDealPipelineStage: vi.fn(),
  updateCrmCustomFields: vi.fn(),
  updateCrmStage: vi.fn(),
}))

import { crmRoutes } from '../crm.js'
import { resolveWorkspaceViewpoint } from '../../db/workspace-viewpoint.js'
import { createDeal } from '../../db/crm.js'
import { getEntityById, updateEntity } from '../../db/entities-store.js'
import { appendCrmActivity, createCrmPipeline, getCrmConfig } from '../../db/crm-r2.js'

const WS = 'd126f352-7f5c-48b2-88d0-66694be0c93d'
const CTX = { userId: 'user-1', workspaceId: WS }
const CONFIG = { pipelines: [], fields: [] }

function makeApp(role: string | null = 'member', authenticated = true) {
  const workspaceStore = { getRole: vi.fn().mockResolvedValue(role) }
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
    expect(getCrmConfig).toHaveBeenCalledWith(CTX.userId, WS)
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
  })
})
