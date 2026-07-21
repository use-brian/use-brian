/**
 * [COMP:api/views-routes] Q5 Views routes — auth, validation, payload build.
 */

import { describe, it, expect, vi, beforeEach, type Mocked } from 'vitest'
import express from 'express'
import request from 'supertest'

vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

// Linking a recording (migration 339) validates it via getRecording under the
// caller's RLS — so a recording the user cannot see returns null and the link
// is rejected. Mocked so the route test can drive both branches.
const getRecording = vi.fn()
vi.mock('../../db/recordings-store.js', () => ({
  getRecording: (...a: unknown[]) => getRecording(...a),
}))

import { viewsRoutes } from '../views.js'
import type { CrmStore, SavedView, SavedViewStore, SoftDeleteRepository, TaskStore, WorkflowRunStore } from '@use-brian/core'
import type { WorkspaceStore } from '../../db/workspace-store.js'

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000010'
const USER_ID = '00000000-0000-0000-0000-000000000020'

function fakeSavedViewStore(): Mocked<SavedViewStore> {
  return {
    create: vi.fn(),
    getById: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    getPage: vi.fn(),
    updatePage: vi.fn(),
    setState: vi.fn(),
    setAutoPruneAt: vi.fn(),
    setAutoTitle: vi.fn(),
    createDraft: vi.fn(),
    findIdByAnchorKey: vi.fn(),
    commitCreatedEvent: vi.fn(),
    reparent: vi.fn(),
    reorderSiblings: vi.fn(),
    pruneExpiredDraftsSystem: vi.fn(),
    getBrainSyncStateSystem: vi.fn(),
    markBrainIngestedSystem: vi.fn(),
    getPageEventContextSystem: vi.fn(),
  }
}

function fakeTaskStore(): Mocked<TaskStore> {
  return {
    create: vi.fn(),
    getById: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
  }
}

function fakeCrmStore(): Mocked<CrmStore> {
  return {
    createCompany: vi.fn(),
    getCompanyById: vi.fn(),
    listCompanies: vi.fn().mockResolvedValue([]),
    updateCompany: vi.fn(),
    createContact: vi.fn(),
    getContactById: vi.fn(),
    listContacts: vi.fn().mockResolvedValue([]),
    updateContact: vi.fn(),
    createDeal: vi.fn(),
    getDealById: vi.fn(),
    listDeals: vi.fn().mockResolvedValue([]),
    updateDeal: vi.fn(),
    setDealStage: vi.fn(),
    batchLabels: vi.fn().mockResolvedValue(new Map()),
  }
}

function fakeWorkflowRunStore(): Mocked<WorkflowRunStore> {
  return {
    createRun: vi.fn(),
    getRunById: vi.fn(),
    getRunSystem: vi.fn(),
    updateRun: vi.fn(),
    createStepRun: vi.fn(),
    updateStepRun: vi.fn(),
    listStepRuns: vi.fn(),
    listRunsForWorkflow: vi.fn().mockResolvedValue([]),
    listRunsForPage: vi.fn().mockResolvedValue([]),
    getLatestOutcomeForWorkflowSystem: vi.fn().mockResolvedValue(null),
  }
}

function fakeSoftDeleteStore(): Mocked<SoftDeleteRepository> {
  return {
    readForSoftDelete: vi.fn(),
    readForAuthorshipDelete: vi.fn(),
    applySoftDelete: vi.fn().mockResolvedValue(undefined),
    applyHardPurge: vi.fn().mockResolvedValue(undefined),
  }
}

function fakeWorkspaceStore(role: 'owner' | 'admin' | 'member' | null): WorkspaceStore {
  // Only the methods used by the routes need to behave; everything else is a stub.
  const stub = vi.fn()
  return {
    create: stub,
    list: stub,
    get: stub,
    update: stub,
    delete: stub,
    listMembers: stub,
    addMember: stub,
    removeMember: stub,
    updateMemberRole: stub,
    updateMemberDraftPermission: stub,
    getRole: vi.fn().mockResolvedValue(role),
    getMembership: stub,
    adoptAssistant: stub,
    removeAssistant: stub,
    getByIdSystem: stub,
    countFreeOwned: stub,
  } as unknown as WorkspaceStore
}

type Stores = {
  savedViewStore: ReturnType<typeof fakeSavedViewStore>
  taskStore: ReturnType<typeof fakeTaskStore>
  crmStore: ReturnType<typeof fakeCrmStore>
  workflowRunStore: ReturnType<typeof fakeWorkflowRunStore>
  workspaceStore: WorkspaceStore
  softDeleteStore: ReturnType<typeof fakeSoftDeleteStore>
  workspaceDirectory: {
    listMembers: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
    batchGet: ReturnType<typeof vi.fn>
  }
}

function fakeWorkspaceDirectory(): Stores['workspaceDirectory'] {
  return {
    listMembers: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    batchGet: vi.fn().mockResolvedValue(new Map()),
  }
}

function makeApp(opts: {
  userId: string | null
  /** Use undefined to default to 'member'; pass `null` explicitly to test the not-a-member case. */
  role?: 'owner' | 'admin' | 'member' | null
  stores?: Partial<Stores>
  /** Auto-title endpoint deps (migration 218). Omit → endpoint returns 503. */
  autoTitle?: { provider?: unknown; docPageStore?: unknown }
  /** Custom page templates store (migration 281). Omit → routes return 503. */
  pageTemplateStore?: unknown
  /** Blueprint records store (migration 307). Omit → records routes return 503. */
  blueprintRecordStore?: unknown
  /** Page grant store (sharing/publish). Omit → share routes return 503 and
   *  GET /views/:id reports `published: false`. */
  pageGrantStore?: unknown
}): { app: express.Express; stores: Stores } {
  const resolvedRole = 'role' in opts ? opts.role ?? null : 'member'
  const stores: Stores = {
    savedViewStore: opts.stores?.savedViewStore ?? fakeSavedViewStore(),
    taskStore: opts.stores?.taskStore ?? fakeTaskStore(),
    crmStore: opts.stores?.crmStore ?? fakeCrmStore(),
    workflowRunStore: opts.stores?.workflowRunStore ?? fakeWorkflowRunStore(),
    workspaceStore: opts.stores?.workspaceStore ?? fakeWorkspaceStore(resolvedRole),
    softDeleteStore: opts.stores?.softDeleteStore ?? fakeSoftDeleteStore(),
    workspaceDirectory: opts.stores?.workspaceDirectory ?? fakeWorkspaceDirectory(),
  }
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    if (opts.userId) {
      ;(req as unknown as { userId: string }).userId = opts.userId
    }
    next()
  })
  app.use(
    '/api',
    viewsRoutes({
      ...stores,
      ...(opts.autoTitle?.provider
        ? { provider: opts.autoTitle.provider as never }
        : {}),
      ...(opts.autoTitle?.docPageStore
        ? { docPageStore: opts.autoTitle.docPageStore as never }
        : {}),
      ...(opts.pageTemplateStore
        ? { pageTemplateStore: opts.pageTemplateStore as never }
        : {}),
      ...(opts.blueprintRecordStore
        ? { blueprintRecordStore: opts.blueprintRecordStore as never }
        : {}),
      ...(opts.pageGrantStore
        ? { pageGrantStore: opts.pageGrantStore as never }
        : {}),
    }),
  )
  return { app, stores }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:api/views-routes] auth', () => {
  it('returns 401 when no userId on request', async () => {
    const { app } = makeApp({ userId: null })
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/saved-views`)
    expect(res.status).toBe(401)
  })

  it('returns 403 when user is not a workspace member', async () => {
    const { app } = makeApp({ userId: USER_ID, role: null })
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/saved-views`)
    expect(res.status).toBe(403)
  })
})

describe('[COMP:api/views-routes] custom page templates', () => {
  function fakePageTemplateStore() {
    return { list: vi.fn(), getById: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() }
  }
  const TEMPLATE_ID = '00000000-0000-0000-0000-0000000000aa'
  const VALID_BODY = {
    name: 'Sprint plan',
    category: 'planning',
    blocks: [{ kind: 'heading', id: 'b1', level: 1, text: 'Sprint' }],
  }

  it('returns 503 when the store is not wired', async () => {
    const { app } = makeApp({ userId: USER_ID })
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/page-templates`)
    expect(res.status).toBe(503)
  })

  it('GET list returns the workspace custom templates for a member', async () => {
    const store = fakePageTemplateStore()
    store.list.mockResolvedValue([{ id: TEMPLATE_ID, name: 'Sprint plan' }])
    const { app } = makeApp({ userId: USER_ID, pageTemplateStore: store })
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/page-templates`)
    expect(res.status).toBe(200)
    expect(res.body.templates).toHaveLength(1)
    expect(store.list).toHaveBeenCalledWith(USER_ID, WORKSPACE_ID)
  })

  it('GET list is 403 for a non-member', async () => {
    const { app } = makeApp({ userId: USER_ID, role: null, pageTemplateStore: fakePageTemplateStore() })
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/page-templates`)
    expect(res.status).toBe(403)
  })

  it('POST create persists a valid template (save-as-template / from-scratch share this route)', async () => {
    const store = fakePageTemplateStore()
    store.create.mockResolvedValue({ id: TEMPLATE_ID, ...VALID_BODY })
    const { app } = makeApp({ userId: USER_ID, pageTemplateStore: store })
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/page-templates`)
      .send(VALID_BODY)
    expect(res.status).toBe(201)
    expect(store.create).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ workspaceId: WORKSPACE_ID, name: 'Sprint plan', category: 'planning' }),
    )
  })

  it('POST create rejects an invalid body (bad category) without writing', async () => {
    const store = fakePageTemplateStore()
    const { app } = makeApp({ userId: USER_ID, pageTemplateStore: store })
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/page-templates`)
      .send({ ...VALID_BODY, category: 'nonsense' })
    expect(res.status).toBe(400)
    expect(store.create).not.toHaveBeenCalled()
  })

  it('PATCH updates only the sent keys and returns the updated template', async () => {
    const store = fakePageTemplateStore()
    store.getById.mockResolvedValue({ id: TEMPLATE_ID, workspaceId: WORKSPACE_ID })
    store.update.mockResolvedValue({ id: TEMPLATE_ID, name: 'Renamed' })
    const { app } = makeApp({ userId: USER_ID, pageTemplateStore: store })
    const res = await request(app)
      .patch(`/api/workspaces/${WORKSPACE_ID}/page-templates/${TEMPLATE_ID}`)
      .send({ name: 'Renamed' })
    expect(res.status).toBe(200)
    expect(res.body.template.name).toBe('Renamed')
    expect(store.update).toHaveBeenCalledWith(USER_ID, TEMPLATE_ID, { name: 'Renamed' })
  })

  it('PATCH with extraction but no blocks regenerates the authoring skeleton', async () => {
    const store = fakePageTemplateStore()
    store.getById.mockResolvedValue({ id: TEMPLATE_ID, workspaceId: WORKSPACE_ID })
    store.update.mockResolvedValue({ id: TEMPLATE_ID })
    const { app } = makeApp({ userId: USER_ID, pageTemplateStore: store })
    const extraction = {
      fields: [
        { key: 'summary', heading: 'Summary', instruction: 'Sum it up', type: 'markdown' },
      ],
      capture: [],
    }
    const res = await request(app)
      .patch(`/api/workspaces/${WORKSPACE_ID}/page-templates/${TEMPLATE_ID}`)
      .send({ extraction })
    expect(res.status).toBe(200)
    const patch = store.update.mock.calls[0][2]
    // The derived skeleton pairs each field's heading with its extraction slot
    // so the WYSIWYG round-trip (blocksToExtractionSpec) still yields the spec.
    expect(patch.blocks.map((b: { kind: string }) => b.kind)).toEqual(['heading', 'extraction_slot'])
    expect(patch.blocks[0].text).toBe('Summary')
    expect(patch.blocks[1].fieldKey).toBe('summary')
  })

  it('PATCH is 404 for a template outside the route workspace and 400 for an empty patch', async () => {
    const store = fakePageTemplateStore()
    store.getById.mockResolvedValue({ id: TEMPLATE_ID, workspaceId: 'other-workspace' })
    const { app } = makeApp({ userId: USER_ID, pageTemplateStore: store })
    const cross = await request(app)
      .patch(`/api/workspaces/${WORKSPACE_ID}/page-templates/${TEMPLATE_ID}`)
      .send({ name: 'Renamed' })
    expect(cross.status).toBe(404)
    expect(store.update).not.toHaveBeenCalled()

    store.getById.mockResolvedValue({ id: TEMPLATE_ID, workspaceId: WORKSPACE_ID })
    const empty = await request(app)
      .patch(`/api/workspaces/${WORKSPACE_ID}/page-templates/${TEMPLATE_ID}`)
      .send({})
    expect(empty.status).toBe(400)
    expect(store.update).not.toHaveBeenCalled()
  })

  it('DELETE returns 404 when the template is missing', async () => {
    const store = fakePageTemplateStore()
    store.remove.mockResolvedValue(false)
    const { app } = makeApp({ userId: USER_ID, pageTemplateStore: store })
    const res = await request(app).delete(
      `/api/workspaces/${WORKSPACE_ID}/page-templates/${TEMPLATE_ID}`,
    )
    expect(res.status).toBe(404)
  })
})

describe('[COMP:api/views-routes] blueprint records', () => {
  const BLUEPRINT_ID = '00000000-0000-0000-0000-0000000000bb'
  const RECORD_ID = '00000000-0000-0000-0000-0000000000cc'
  const RECORD = {
    id: RECORD_ID,
    workspaceId: WORKSPACE_ID,
    blueprintId: BLUEPRINT_ID,
    specSnapshot: [
      { key: 'summary', heading: 'Summary', instruction: 's', type: 'markdown', required: true },
    ],
    subject: 'Acme',
    anchorKey: `generate-synthesis:${WORKSPACE_ID}:${BLUEPRINT_ID}:acme`,
    fields: { summary: 'All good.' },
    status: 'complete' as const,
    missing: [] as string[],
    sourceKind: 'workflow' as const,
    sourceId: 'run-1',
    sensitivity: 'internal',
    pageId: null,
    createdBy: USER_ID,
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:00.000Z',
  }
  function fakeRecordStore() {
    return {
      ensure: vi.fn(),
      mergeFields: vi.fn(),
      finalize: vi.fn().mockResolvedValue(null),
      getById: vi.fn().mockResolvedValue(RECORD),
      getByAnchor: vi.fn(),
      getLatestForSource: vi.fn(),
      getLatestBySubject: vi.fn(),
      listForBlueprint: vi.fn().mockResolvedValue([RECORD]),
    }
  }

  it('GET records returns 503 when the store is not wired', async () => {
    const { app } = makeApp({ userId: USER_ID })
    const res = await request(app).get(
      `/api/workspaces/${WORKSPACE_ID}/blueprints/${BLUEPRINT_ID}/records`,
    )
    expect(res.status).toBe(503)
  })

  it('GET records lists a blueprint\'s records for a member (403 for non-members)', async () => {
    const store = fakeRecordStore()
    const { app } = makeApp({ userId: USER_ID, blueprintRecordStore: store })
    const res = await request(app).get(
      `/api/workspaces/${WORKSPACE_ID}/blueprints/${BLUEPRINT_ID}/records`,
    )
    expect(res.status).toBe(200)
    expect(res.body.records).toHaveLength(1)
    expect(res.body.records[0]).toMatchObject({ id: RECORD_ID, subject: 'Acme', status: 'complete' })
    expect(store.listForBlueprint).toHaveBeenCalledWith(USER_ID, WORKSPACE_ID, BLUEPRINT_ID)

    const { app: nonMember } = makeApp({ userId: USER_ID, role: null, blueprintRecordStore: store })
    const denied = await request(nonMember).get(
      `/api/workspaces/${WORKSPACE_ID}/blueprints/${BLUEPRINT_ID}/records`,
    )
    expect(denied.status).toBe(403)
  })

  it('POST open-page mints the projection on the record anchor and links it back', async () => {
    const store = fakeRecordStore()
    const docPageStore = {
      getVersionedPage: vi.fn().mockResolvedValue({ page: { blocks: [] }, version: 3, title: 'Acme', nameOrigin: 'placeholder' }),
      applyPatch: vi.fn().mockResolvedValue({ newVersion: 4 }),
    }
    const { app, stores } = makeApp({
      userId: USER_ID,
      blueprintRecordStore: store,
      autoTitle: { docPageStore },
    })
    stores.savedViewStore.findIdByAnchorKey.mockResolvedValue(null)
    stores.savedViewStore.createDraft.mockResolvedValue({ id: 'page-9' } as SavedView)

    const res = await request(app).post(
      `/api/workspaces/${WORKSPACE_ID}/blueprint-records/${RECORD_ID}/page`,
    )
    expect(res.status).toBe(200)
    expect(res.body.pageId).toBe('page-9')
    // Page minted on the RECORD's own anchor (converges with any later fill).
    expect(stores.savedViewStore.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ anchorKey: RECORD.anchorKey, name: 'Acme' }),
    )
    // The projection wrote the record's blocks, and the record linked the page.
    expect(docPageStore.applyPatch).toHaveBeenCalledTimes(1)
    expect(docPageStore.applyPatch.mock.calls[0][0].nextPage.blocks.length).toBeGreaterThan(0)
    expect(store.finalize).toHaveBeenCalledWith(USER_ID, RECORD_ID, {
      status: 'complete',
      missing: [],
      pageId: 'page-9',
    })
  })
})

describe('[COMP:api/views-routes] saved-views CRUD', () => {
  it('GET list returns saved views for workspace member', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.list.mockResolvedValueOnce([
      {
        id: 'sv-1',
        workspaceId: WORKSPACE_ID,
        name: 'Open Tasks',
        nameOrigin: 'user',
        description: null,
        icon: '🚀',
        entity: 'tasks',
        viewType: 'table',
        state: 'saved',
        updatedAt: new Date('2026-05-09T10:00:00Z'),
      },
    ])
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/saved-views`)
    expect(res.status).toBe(200)
    expect(res.body.savedViews).toHaveLength(1)
    expect(res.body.savedViews[0].id).toBe('sv-1')
    expect(res.body.savedViews[0].icon).toBe('🚀')
    // Provenance rides the list so the sidebar can pick the generic draft glyph.
    expect(res.body.savedViews[0].nameOrigin).toBe('user')
  })

  it('GET list carries teamspaceId so the sidebar can group pages by section (mig 313)', async () => {
    // Regression: the hand-built list projection once dropped teamspaceId, so
    // every page collapsed into the Private group (all teamspaces rendered
    // empty) and a drag into a teamspace never stuck across the reload.
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.list.mockResolvedValueOnce([
      {
        id: 'sv-filed', workspaceId: WORKSPACE_ID, name: 'Filed', nameOrigin: 'user',
        description: null, icon: null, entity: 'tasks', viewType: 'table', state: 'saved',
        nestParentId: null, position: 0, teamspaceId: 'ts-general',
        updatedAt: new Date('2026-07-09T10:00:00Z'),
      },
      {
        id: 'sv-private', workspaceId: WORKSPACE_ID, name: 'Private one', nameOrigin: 'user',
        description: null, icon: null, entity: 'tasks', viewType: 'table', state: 'saved',
        nestParentId: null, position: 1, teamspaceId: null,
        updatedAt: new Date('2026-07-09T10:00:00Z'),
      },
    ])
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/saved-views`)
    expect(res.status).toBe(200)
    expect(res.body.savedViews[0].teamspaceId).toBe('ts-general')
    // A private page carries an explicit null (not absent) so the client's
    // `teamspaceId ?? null` grouping is unambiguous.
    expect(res.body.savedViews[1].teamspaceId).toBeNull()
  })

  it('GET list returns icon: null when the page has no icon', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.list.mockResolvedValueOnce([
      {
        id: 'sv-noicon',
        workspaceId: WORKSPACE_ID,
        name: 'No Icon',
        nameOrigin: 'placeholder',
        description: null,
        icon: null,
        entity: 'tasks',
        viewType: 'table',
        state: 'saved',
        updatedAt: new Date('2026-05-09T10:00:00Z'),
      },
    ])
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/saved-views`)
    expect(res.status).toBe(200)
    expect(res.body.savedViews[0].icon).toBeNull()
  })

  it('POST create rejects invalid binding', async () => {
    const { app } = makeApp({ userId: USER_ID })
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/saved-views`)
      .send({
        name: 'Bad',
        binding: { entity: 'companies', viewType: 'board' }, // companies/board rejected
      })
    expect(res.status).toBe(400)
  })

  it('POST create persists valid binding', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    const created: SavedView = {
      id: 'sv-2',
      workspaceId: WORKSPACE_ID,
      createdBy: USER_ID,
      nameOrigin: 'placeholder',
    anchorKey: null,
    linkedRecordingId: null,
      fullWidth: false,
      clearance: 'internal',
      name: 'Open Tasks',
      description: null,
      icon: null,
      entity: 'tasks',
      viewType: 'table',
      binding: { entity: 'tasks', viewType: 'table' },
      page: { blocks: [] },
      state: 'saved',
      originPrompt: null,
      brainSyncEnabled: false,
      brainLastIngestHash: null,
      brainLastIngestAt: null,
      createdEventPending: false,
      autoPruneAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    stores.savedViewStore.create.mockResolvedValueOnce(created)
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/saved-views`)
      .send({
        name: 'Open Tasks',
        binding: { entity: 'tasks', viewType: 'table' },
      })
    expect(res.status).toBe(201)
    expect(res.body.id).toBe('sv-2')
    expect(stores.savedViewStore.create).toHaveBeenCalledWith({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      name: 'Open Tasks',
      description: null,
      binding: { entity: 'tasks', viewType: 'table' },
    })
  })

  it('GET payload builds A2UI ViewPayload from saved view binding', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.getById.mockResolvedValueOnce({
      id: 'sv-3',
      workspaceId: WORKSPACE_ID,
      createdBy: USER_ID,
      nameOrigin: 'placeholder',
    anchorKey: null,
    linkedRecordingId: null,
      fullWidth: false,
      clearance: 'internal',
      name: 'Open Tasks',
      description: null,
      icon: null,
      entity: 'tasks',
      viewType: 'table',
      binding: { entity: 'tasks', viewType: 'table' },
      // Legacy alias must keep its single-table response shape — drop page
      // so the route's `view.page ? renderPage : buildPayload` falls into
      // the buildPayload branch (which roots the response on a TableWidget).
      page: null,
      state: 'saved',
      originPrompt: null,
      brainSyncEnabled: false,
      brainLastIngestHash: null,
      brainLastIngestAt: null,
      createdEventPending: false,
      autoPruneAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const res = await request(app).get('/api/saved-views/sv-3/payload')
    expect(res.status).toBe(200)
    expect(res.body.a2ui).toBe('0.8')
    expect(res.body.root.type).toBe('table')
  })

  it('DELETE returns 404 when row missing', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.remove.mockResolvedValueOnce(false)
    const res = await request(app).delete('/api/saved-views/sv-missing')
    expect(res.status).toBe(404)
  })
})

describe('[COMP:api/views-routes] saved-views icon', () => {
  it('PATCH /saved-views/:id sets an emoji icon and returns it in metadata', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    const updated: SavedView = {
      id: 'sv-icon',
      workspaceId: WORKSPACE_ID,
      createdBy: USER_ID,
      nameOrigin: 'placeholder',
    anchorKey: null,
    linkedRecordingId: null,
      fullWidth: false,
      clearance: 'internal',
      name: 'Open Tasks',
      description: null,
      icon: '🚀',
      entity: 'tasks',
      viewType: 'table',
      binding: { entity: 'tasks', viewType: 'table' },
      page: { blocks: [] },
      state: 'saved',
      originPrompt: null,
      brainSyncEnabled: false,
      brainLastIngestHash: null,
      brainLastIngestAt: null,
      createdEventPending: false,
      autoPruneAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    stores.savedViewStore.update.mockResolvedValueOnce(updated)
    const res = await request(app).patch('/api/saved-views/sv-icon').send({ icon: '🚀' })
    expect(res.status).toBe(200)
    expect(stores.savedViewStore.update).toHaveBeenCalledWith(
      USER_ID,
      'sv-icon',
      expect.objectContaining({ icon: '🚀' }),
    )
    expect(res.body.icon).toBe('🚀')
  })

  it('PATCH /saved-views/:id clears the icon when passed null', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    const cleared: SavedView = {
      id: 'sv-icon',
      workspaceId: WORKSPACE_ID,
      createdBy: USER_ID,
      nameOrigin: 'placeholder',
    anchorKey: null,
    linkedRecordingId: null,
      fullWidth: false,
      clearance: 'internal',
      name: 'Open Tasks',
      description: null,
      icon: null,
      entity: 'tasks',
      viewType: 'table',
      binding: { entity: 'tasks', viewType: 'table' },
      page: { blocks: [] },
      state: 'saved',
      originPrompt: null,
      brainSyncEnabled: false,
      brainLastIngestHash: null,
      brainLastIngestAt: null,
      createdEventPending: false,
      autoPruneAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }
    stores.savedViewStore.update.mockResolvedValueOnce(cleared)
    const res = await request(app).patch('/api/saved-views/sv-icon').send({ icon: null })
    expect(res.status).toBe(200)
    expect(stores.savedViewStore.update).toHaveBeenCalledWith(
      USER_ID,
      'sv-icon',
      expect.objectContaining({ icon: null }),
    )
    expect(res.body.icon).toBeNull()
  })

  it('PATCH /saved-views/:id rejects an over-long icon string', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    const res = await request(app)
      .patch('/api/saved-views/sv-icon')
      .send({ icon: 'x'.repeat(17) })
    expect(res.status).toBe(400)
    expect(stores.savedViewStore.update).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/views-routes] link a recording (migration 339)', () => {
  const REC_ID = '00000000-0000-0000-0000-0000000000aa'
  function view(over: Partial<SavedView> = {}): SavedView {
    return {
      id: 'pg-1', workspaceId: WORKSPACE_ID, createdBy: USER_ID, name: 'Notes',
      nameOrigin: 'user', description: null, icon: null, anchorKey: null,
      linkedRecordingId: null, fullWidth: false, clearance: 'internal',
      entity: 'tasks', viewType: 'table', binding: { entity: 'tasks', viewType: 'table' },
      page: { blocks: [] }, state: 'saved', originPrompt: null, brainSyncEnabled: false,
      brainLastIngestHash: null, brainLastIngestAt: null, createdEventPending: false,
      autoPruneAt: null, createdAt: new Date(), updatedAt: new Date(),
      nestParentId: null, position: 0, teamspaceId: null, ...over,
    } as SavedView
  }

  it('links a recording in the page workspace and echoes it back', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.getById.mockResolvedValue(view())
    getRecording.mockResolvedValue({ id: REC_ID, workspaceId: WORKSPACE_ID })
    stores.savedViewStore.update.mockResolvedValue(view({ linkedRecordingId: REC_ID }))

    const res = await request(app).patch('/api/saved-views/pg-1').send({ linkedRecordingId: REC_ID })
    expect(res.status).toBe(200)
    expect(getRecording).toHaveBeenCalledWith(USER_ID, REC_ID)
    expect(stores.savedViewStore.update).toHaveBeenCalledWith(
      USER_ID, 'pg-1', expect.objectContaining({ linkedRecordingId: REC_ID }),
    )
    // The whitelist must forward it, or the doc shell never sees the link.
    expect(res.body.linkedRecordingId).toBe(REC_ID)
  })

  it('rejects a recording in a DIFFERENT workspace and never writes the link', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.getById.mockResolvedValue(view())
    // The recording is visible to the user but belongs elsewhere — a page must
    // not point its viewers at a recording they open into another workspace.
    getRecording.mockResolvedValue({ id: REC_ID, workspaceId: 'other-workspace' })

    const res = await request(app).patch('/api/saved-views/pg-1').send({ linkedRecordingId: REC_ID })
    expect(res.status).toBe(400)
    expect(stores.savedViewStore.update).not.toHaveBeenCalled()
  })

  it('rejects a recording the caller cannot see (getRecording null)', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.getById.mockResolvedValue(view())
    getRecording.mockResolvedValue(null) // RLS miss — not a member of its workspace

    const res = await request(app).patch('/api/saved-views/pg-1').send({ linkedRecordingId: REC_ID })
    expect(res.status).toBe(400)
    expect(stores.savedViewStore.update).not.toHaveBeenCalled()
  })

  it('unlinks (null) without a recording lookup', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.update.mockResolvedValue(view({ linkedRecordingId: null }))

    const res = await request(app).patch('/api/saved-views/pg-1').send({ linkedRecordingId: null })
    expect(res.status).toBe(200)
    // Unlink has nothing to validate — skip the (potentially RLS-heavy) fetch.
    expect(getRecording).not.toHaveBeenCalled()
    expect(stores.savedViewStore.update).toHaveBeenCalledWith(
      USER_ID, 'pg-1', expect.objectContaining({ linkedRecordingId: null }),
    )
  })

  it('rejects a non-uuid recording id at the schema before any lookup', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    const res = await request(app).patch('/api/saved-views/pg-1').send({ linkedRecordingId: 'not-a-uuid' })
    expect(res.status).toBe(400)
    expect(getRecording).not.toHaveBeenCalled()
    expect(stores.savedViewStore.update).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/views-routes] ad-hoc render', () => {
  it('rejects an invalid binding payload', async () => {
    const { app } = makeApp({ userId: USER_ID })
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/views/render`)
      .send({ entity: 'workflow_runs', viewType: 'board' }) // not allowed
    expect(res.status).toBe(400)
  })

  it('returns A2UI payload for a valid binding', async () => {
    const { app } = makeApp({ userId: USER_ID })
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/views/render`)
      .send({ entity: 'tasks', viewType: 'board', groupBy: 'status' })
    expect(res.status).toBe(200)
    expect(res.body.a2ui).toBe('0.8')
    expect(res.body.root.type).toBe('board')
    expect(res.body.root.groupBy).toBe('status')
  })

  it('emits inline-edit options on the status select column', async () => {
    // The renderer's inline `select` editor reads `column.options` to show
    // the dropdown popover; buildPayload must source them from the entity enum.
    const { app } = makeApp({ userId: USER_ID })
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/views/render`)
      .send({ entity: 'tasks', viewType: 'table' })
    expect(res.status).toBe(200)
    const statusCol = (res.body.root.columns as { field: string; options?: string[] }[]).find(
      (c) => c.field === 'status',
    )
    expect(statusCol?.options).toEqual(['todo', 'in_progress', 'blocked', 'done', 'archived'])
  })
})

describe('[COMP:api/views-routes] board-drop writes', () => {
  it('PATCH /tasks/:id rejects empty body', async () => {
    const { app } = makeApp({ userId: USER_ID })
    const res = await request(app).patch('/api/tasks/t-1').send({})
    expect(res.status).toBe(400)
  })

  it('PATCH /deals/:id/stage rejects missing stage', async () => {
    const { app } = makeApp({ userId: USER_ID })
    const res = await request(app).patch('/api/deals/d-1/stage').send({})
    expect(res.status).toBe(400)
  })

  it('PATCH /tasks/:id calls task store update with new status', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.taskStore.update.mockResolvedValueOnce({
      id: 't-1',
      workspaceId: WORKSPACE_ID,
      title: 'X',
      status: 'in_progress',
      assigneeId: null,
      due: null,
      tags: [],
      parentId: null,
      externalRef: {},
      attributes: {},
      createdAt: new Date(),
      updatedAt: new Date('2026-05-09T11:00:00Z'),
    })
    const res = await request(app)
      .patch('/api/tasks/t-1')
      .send({ status: 'in_progress' })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('in_progress')
    expect(stores.taskStore.update).toHaveBeenCalledWith(USER_ID, 't-1', { status: 'in_progress' })
  })

  it('PATCH /deals/:id/stage calls setDealStage', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.crmStore.setDealStage.mockResolvedValueOnce({
      id: 'd-1',
      workspaceId: WORKSPACE_ID,
      entityId: null,
      contactId: null,
      companyId: null,
      stage: 'won',
      amount: null,
      closeDate: null,
      externalRef: {},
      createdAt: new Date(),
      updatedAt: new Date('2026-05-09T11:00:00Z'),
    })
    const res = await request(app)
      .patch('/api/deals/d-1/stage')
      .send({ stage: 'won' })
    expect(res.status).toBe(200)
    expect(res.body.stage).toBe('won')
    expect(stores.crmStore.setDealStage).toHaveBeenCalledWith(USER_ID, 'd-1', 'won')
  })

  it('PATCH /deals/:id/stage returns 404 when deal not found', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.crmStore.setDealStage.mockResolvedValueOnce(null)
    const res = await request(app)
      .patch('/api/deals/d-missing/stage')
      .send({ stage: 'won' })
    expect(res.status).toBe(404)
  })
})

// ── Phase 2 — Inline cell edit PATCH endpoints ─────────────────────────

describe('[COMP:api/views-routes] inline cell edit — tasks', () => {
  it('PATCH /tasks/:id rejects unknown fields', async () => {
    const { app } = makeApp({ userId: USER_ID })
    const res = await request(app).patch('/api/tasks/t-1').send({ totallyMadeUp: 1 })
    expect(res.status).toBe(400)
  })

  it('PATCH /tasks/:id supports broader patches (title + tags + due)', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.taskStore.update.mockResolvedValueOnce({
      id: 't-1',
      workspaceId: WORKSPACE_ID,
      title: 'Renamed',
      status: 'todo',
      assigneeId: null,
      due: new Date('2026-06-01T00:00:00Z'),
      tags: ['urgent'],
      parentId: null,
      externalRef: {},
      attributes: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const res = await request(app)
      .patch('/api/tasks/t-1')
      .send({ title: 'Renamed', tags: ['urgent'], due: '2026-06-01T00:00:00Z' })
    expect(res.status).toBe(200)
    expect(stores.taskStore.update).toHaveBeenCalledWith(
      USER_ID,
      't-1',
      expect.objectContaining({
        title: 'Renamed',
        tags: ['urgent'],
      }),
    )
    const dueArg = (stores.taskStore.update.mock.calls[0]?.[2] ?? {}) as { due?: Date | null }
    expect(dueArg.due).toBeInstanceOf(Date)
    expect(res.body.title).toBe('Renamed')
    expect(res.body.tags).toEqual(['urgent'])
  })

  it('PATCH /tasks/:id accepts null due to clear the field', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.taskStore.update.mockResolvedValueOnce({
      id: 't-2',
      workspaceId: WORKSPACE_ID,
      title: 'X',
      status: 'todo',
      assigneeId: null,
      due: null,
      tags: [],
      parentId: null,
      externalRef: {},
      attributes: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const res = await request(app).patch('/api/tasks/t-2').send({ due: null })
    expect(res.status).toBe(200)
    const dueArg = (stores.taskStore.update.mock.calls[0]?.[2] ?? {}) as { due?: Date | null }
    expect(dueArg.due).toBeNull()
  })

  it('PATCH /tasks/:id returns 404 when missing', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.taskStore.update.mockResolvedValueOnce(null)
    const res = await request(app).patch('/api/tasks/t-x').send({ title: 'Y' })
    expect(res.status).toBe(404)
  })
})

describe('[COMP:api/views-routes] inline cell edit — contacts', () => {
  it('PATCH /contacts/:id updates the name + tags', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.crmStore.updateContact.mockResolvedValueOnce({
      id: 'c-1',
      workspaceId: WORKSPACE_ID,
      entityId: null,
      name: 'Renamed',
      email: null,
      phone: null,
      companyId: null,
      tags: ['lead'],
      externalRef: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const res = await request(app)
      .patch('/api/contacts/c-1')
      .send({ name: 'Renamed', tags: ['lead'] })
    expect(res.status).toBe(200)
    expect(stores.crmStore.updateContact).toHaveBeenCalledWith(
      USER_ID,
      'c-1',
      { name: 'Renamed', tags: ['lead'] },
    )
    expect(res.body.name).toBe('Renamed')
  })

  it('PATCH /contacts/:id returns 404 when missing', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.crmStore.updateContact.mockResolvedValueOnce(null)
    const res = await request(app).patch('/api/contacts/c-x').send({ name: 'Y' })
    expect(res.status).toBe(404)
  })

  it('PATCH /contacts/:id rejects empty patch', async () => {
    const { app } = makeApp({ userId: USER_ID })
    const res = await request(app).patch('/api/contacts/c-1').send({})
    expect(res.status).toBe(400)
  })
})

describe('[COMP:api/views-routes] inline cell edit — companies', () => {
  it('PATCH /companies/:id updates name + domain', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.crmStore.updateCompany.mockResolvedValueOnce({
      id: 'co-1',
      workspaceId: WORKSPACE_ID,
      entityId: null,
      name: 'Acme Co',
      domain: 'acme.com',
      tags: [],
      externalRef: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const res = await request(app)
      .patch('/api/companies/co-1')
      .send({ name: 'Acme Co', domain: 'acme.com' })
    expect(res.status).toBe(200)
    expect(stores.crmStore.updateCompany).toHaveBeenCalledWith(
      USER_ID,
      'co-1',
      { name: 'Acme Co', domain: 'acme.com' },
    )
    expect(res.body.domain).toBe('acme.com')
  })

  it('PATCH /companies/:id rejects empty patch', async () => {
    const { app } = makeApp({ userId: USER_ID })
    const res = await request(app).patch('/api/companies/co-1').send({})
    expect(res.status).toBe(400)
  })
})

describe('[COMP:api/views-routes] inline cell edit — deals (combined)', () => {
  it('PATCH /deals/:id sets amount + closeDate via updateDeal', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.crmStore.updateDeal.mockResolvedValueOnce({
      id: 'd-1',
      workspaceId: WORKSPACE_ID,
      entityId: null,
      contactId: null,
      companyId: null,
      stage: 'qualified',
      amount: 5000,
      closeDate: new Date('2026-12-01T00:00:00Z'),
      externalRef: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const res = await request(app)
      .patch('/api/deals/d-1')
      .send({ amount: 5000, closeDate: '2026-12-01T00:00:00Z' })
    expect(res.status).toBe(200)
    expect(stores.crmStore.updateDeal).toHaveBeenCalled()
    expect(res.body.amount).toBe(5000)
  })

  it('PATCH /deals/:id routes stage changes through setDealStage', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.crmStore.setDealStage.mockResolvedValueOnce({
      id: 'd-2',
      workspaceId: WORKSPACE_ID,
      entityId: null,
      contactId: null,
      companyId: null,
      stage: 'won',
      amount: null,
      closeDate: null,
      externalRef: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const res = await request(app).patch('/api/deals/d-2').send({ stage: 'won' })
    expect(res.status).toBe(200)
    expect(stores.crmStore.setDealStage).toHaveBeenCalledWith(USER_ID, 'd-2', 'won')
    expect(res.body.stage).toBe('won')
  })

  it('PATCH /deals/:id rejects an unknown stage', async () => {
    const { app } = makeApp({ userId: USER_ID })
    const res = await request(app).patch('/api/deals/d-1').send({ stage: 'unknown' })
    expect(res.status).toBe(400)
  })

  it('PATCH /deals/:id rejects empty patch', async () => {
    const { app } = makeApp({ userId: USER_ID })
    const res = await request(app).patch('/api/deals/d-1').send({})
    expect(res.status).toBe(400)
  })

  it('PATCH /deals/:id returns 404 when missing', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.crmStore.updateDeal.mockResolvedValueOnce(null)
    const res = await request(app).patch('/api/deals/d-x').send({ amount: 100 })
    expect(res.status).toBe(404)
  })
})

// ── Phase 3 — row create ("+ Add row") ─────────────────────────────────

describe('[COMP:api/views-routes] row create', () => {
  it('POST /tasks rejects a missing workspaceId', async () => {
    const { app } = makeApp({ userId: USER_ID })
    const res = await request(app).post('/api/tasks').send({})
    expect(res.status).toBe(400)
  })

  it('POST /tasks requires workspace membership', async () => {
    const { app } = makeApp({ userId: USER_ID, role: null })
    const res = await request(app).post('/api/tasks').send({ workspaceId: WORKSPACE_ID })
    expect(res.status).toBe(403)
  })

  it('POST /tasks creates a task with a placeholder title default', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.taskStore.create.mockResolvedValueOnce({
      id: 't-new',
      workspaceId: WORKSPACE_ID,
      title: 'Untitled task',
      status: 'todo',
      assigneeId: null,
      due: null,
      tags: [],
      parentId: null,
      externalRef: {},
      attributes: {},
      createdAt: new Date(),
      updatedAt: new Date('2026-05-29T10:00:00Z'),
    })
    const res = await request(app).post('/api/tasks').send({ workspaceId: WORKSPACE_ID })
    expect(res.status).toBe(201)
    expect(res.body.id).toBe('t-new')
    expect(stores.taskStore.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        title: 'Untitled task',
        status: 'todo',
      }),
    )
  })

  it('POST /deals creates a deal defaulting to the lead stage', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.crmStore.createDeal.mockResolvedValueOnce({
      id: 'd-new',
      workspaceId: WORKSPACE_ID,
      entityId: null,
      contactId: null,
      companyId: null,
      stage: 'lead',
      amount: null,
      closeDate: null,
      externalRef: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const res = await request(app).post('/api/deals').send({ workspaceId: WORKSPACE_ID })
    expect(res.status).toBe(201)
    expect(res.body.stage).toBe('lead')
    expect(stores.crmStore.createDeal).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, workspaceId: WORKSPACE_ID, stage: 'lead' }),
    )
  })

  it('POST /contacts creates a contact with a placeholder name', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.crmStore.createContact.mockResolvedValueOnce({
      id: 'c-new',
      workspaceId: WORKSPACE_ID,
      entityId: null,
      name: 'Untitled contact',
      email: null,
      phone: null,
      companyId: null,
      tags: [],
      externalRef: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const res = await request(app).post('/api/contacts').send({ workspaceId: WORKSPACE_ID })
    expect(res.status).toBe(201)
    expect(res.body.name).toBe('Untitled contact')
  })

  it('POST /tasks rejects an unknown status', async () => {
    const { app } = makeApp({ userId: USER_ID })
    const res = await request(app)
      .post('/api/tasks')
      .send({ workspaceId: WORKSPACE_ID, status: 'nope' })
    expect(res.status).toBe(400)
  })
})

// ── Phase 3 — row delete (soft-delete via D.4) ─────────────────────────

describe('[COMP:api/views-routes] row delete', () => {
  it('DELETE /tasks/:id rejects a missing workspaceId', async () => {
    const { app } = makeApp({ userId: USER_ID })
    const res = await request(app).delete('/api/tasks/t-1')
    expect(res.status).toBe(400)
  })

  it('DELETE /tasks/:id requires workspace membership', async () => {
    const { app } = makeApp({ userId: USER_ID, role: null })
    const res = await request(app).delete(`/api/tasks/t-1?workspaceId=${WORKSPACE_ID}`)
    expect(res.status).toBe(403)
  })

  it('DELETE /tasks/:id soft-deletes via the task primitive', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.softDeleteStore.readForSoftDelete.mockResolvedValueOnce({
      primitive: 'task',
      rowId: 't-1',
      workspaceId: WORKSPACE_ID,
      validTo: null,
      retractedAt: null,
      createdByUserId: USER_ID,
    })
    const res = await request(app).delete(`/api/tasks/t-1?workspaceId=${WORKSPACE_ID}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(stores.softDeleteStore.applySoftDelete).toHaveBeenCalledWith(
      expect.objectContaining({ primitive: 'task', rowId: 't-1', workspaceId: WORKSPACE_ID }),
    )
  })

  it('DELETE /deals/:id maps to the deal primitive', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.softDeleteStore.readForSoftDelete.mockResolvedValueOnce({
      primitive: 'deal',
      rowId: 'd-1',
      workspaceId: WORKSPACE_ID,
      validTo: null,
      retractedAt: null,
      createdByUserId: USER_ID,
    })
    const res = await request(app).delete(`/api/deals/d-1?workspaceId=${WORKSPACE_ID}`)
    expect(res.status).toBe(200)
    const arg = (stores.softDeleteStore.applySoftDelete.mock.calls[0]?.[0] ?? {}) as { primitive?: string }
    expect(arg.primitive).toBe('deal')
  })

  it('DELETE /tasks/:id returns 404 when the row is unknown', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.softDeleteStore.readForSoftDelete.mockResolvedValueOnce(null)
    const res = await request(app).delete(`/api/tasks/t-missing?workspaceId=${WORKSPACE_ID}`)
    expect(res.status).toBe(404)
  })

  it('DELETE /tasks/:id is idempotent when the row is already soft-deleted', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.softDeleteStore.readForSoftDelete.mockResolvedValueOnce({
      primitive: 'task',
      rowId: 't-1',
      workspaceId: WORKSPACE_ID,
      validTo: new Date(),
      retractedAt: null,
      createdByUserId: USER_ID,
    })
    const res = await request(app).delete(`/api/tasks/t-1?workspaceId=${WORKSPACE_ID}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(stores.softDeleteStore.applySoftDelete).not.toHaveBeenCalled()
  })
})

// ── Notion-redesign — page-model routes ────────────────────────────────

function savedViewFixture(overrides: Partial<SavedView> = {}): SavedView {
  return {
    id: 'sv-page-1',
    workspaceId: WORKSPACE_ID,
    createdBy: USER_ID,
    name: 'Untitled — draft',
    nameOrigin: 'placeholder',
    anchorKey: null,
    linkedRecordingId: null,
    fullWidth: false,
    clearance: 'internal',
    description: null,
    icon: null,
    entity: 'tasks',
    viewType: 'table',
    binding: { entity: 'tasks', viewType: 'table' },
    page: { blocks: [] },
    state: 'draft',
    originPrompt: null,
    brainSyncEnabled: false,
    brainLastIngestHash: null,
    brainLastIngestAt: null,
    createdEventPending: false,
    autoPruneAt: new Date('2026-06-25T00:00:00Z'),
    createdAt: new Date('2026-05-26T00:00:00Z'),
    updatedAt: new Date('2026-05-26T00:00:00Z'),
    ...overrides,
  }
}

describe('[COMP:api/views-routes] view-page metadata', () => {
  it('GET /views/:id returns metadata for a workspace member', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.getById.mockResolvedValueOnce(savedViewFixture({ icon: '📊' }))
    const res = await request(app).get('/api/views/sv-page-1')
    expect(res.status).toBe(200)
    expect(res.body.id).toBe('sv-page-1')
    expect(res.body.state).toBe('draft')
    expect(res.body.icon).toBe('📊')
    expect(res.body.autoPruneAt).toBe('2026-06-25T00:00:00.000Z')
    // No pageGrantStore wired → the resolved publish state defaults to false.
    expect(res.body.published).toBe(false)
  })

  it('GET /views/:id reports published: true when the cascade resolver finds a live grant', async () => {
    const pageGrantStore = {
      resolvePublishedPage: vi.fn().mockResolvedValue({ pageId: 'sv-page-1', role: 'view' }),
    }
    const { app, stores } = makeApp({ userId: USER_ID, pageGrantStore })
    stores.savedViewStore.getById.mockResolvedValueOnce(savedViewFixture())
    const res = await request(app).get('/api/views/sv-page-1')
    expect(res.status).toBe(200)
    expect(res.body.published).toBe(true)
    expect(pageGrantStore.resolvePublishedPage).toHaveBeenCalledWith('sv-page-1')
  })

  it('GET /views/:id reports published: false when the resolver finds nothing', async () => {
    const pageGrantStore = {
      resolvePublishedPage: vi.fn().mockResolvedValue(null),
    }
    const { app, stores } = makeApp({ userId: USER_ID, pageGrantStore })
    stores.savedViewStore.getById.mockResolvedValueOnce(savedViewFixture())
    const res = await request(app).get('/api/views/sv-page-1')
    expect(res.status).toBe(200)
    expect(res.body.published).toBe(false)
  })

  it('GET /views/:id returns 404 when missing', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.getById.mockResolvedValueOnce(null)
    const res = await request(app).get('/api/views/missing')
    expect(res.status).toBe(404)
  })

  it('GET /views/:id/payload renders a container-rooted payload', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.getById.mockResolvedValueOnce(savedViewFixture({
      page: {
        blocks: [
          { kind: 'heading', id: 'h1', level: 1, text: 'Untitled' },
          { kind: 'data', id: 'd1', binding: { entity: 'tasks', viewType: 'table' } },
        ],
      },
    }))
    const res = await request(app).get('/api/views/sv-page-1/payload')
    expect(res.status).toBe(200)
    expect(res.body.a2ui).toBe('0.8')
    expect(res.body.root.type).toBe('container')
    expect(res.body.root.children).toHaveLength(2)
    expect(res.body.root.children[0].type).toBe('heading')
    expect(res.body.root.children[1].type).toBe('table')
  })
})

describe('[COMP:api/views-routes] view-page edits', () => {
  it('PATCH /views/:id/page rejects invalid page bodies', async () => {
    const { app } = makeApp({ userId: USER_ID })
    const res = await request(app)
      .patch('/api/views/sv-page-1/page')
      .send({ page: { blocks: [{ kind: 'mystery', id: 'b1' }] } })
    expect(res.status).toBe(400)
  })

  it('PATCH /views/:id/page persists a valid page and returns fresh metadata', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.updatePage.mockResolvedValueOnce(true)
    const updated = savedViewFixture({
      page: { blocks: [{ kind: 'divider', id: 'd1' }] },
    })
    stores.savedViewStore.getById.mockResolvedValueOnce(updated)
    const res = await request(app)
      .patch('/api/views/sv-page-1/page')
      .send({ page: { blocks: [{ kind: 'divider', id: 'd1' }] } })
    expect(res.status).toBe(200)
    expect(stores.savedViewStore.updatePage).toHaveBeenCalledWith(
      USER_ID,
      'sv-page-1',
      { blocks: [{ kind: 'divider', id: 'd1' }] },
    )
    expect(res.body.id).toBe('sv-page-1')
  })

  it('PATCH /views/:id/page returns 404 when row missing', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.updatePage.mockResolvedValueOnce(false)
    const res = await request(app)
      .patch('/api/views/sv-page-1/page')
      .send({ page: { blocks: [] } })
    expect(res.status).toBe(404)
  })

  it('PATCH /views/:id/save flips state and clears auto-prune', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.setState.mockResolvedValueOnce(true)
    stores.savedViewStore.setAutoPruneAt.mockResolvedValueOnce(true)
    stores.savedViewStore.getById.mockResolvedValueOnce(savedViewFixture({
      state: 'saved',
      autoPruneAt: null,
    }))
    const res = await request(app).patch('/api/views/sv-page-1/save')
    expect(res.status).toBe(200)
    expect(stores.savedViewStore.setState).toHaveBeenCalledWith(USER_ID, 'sv-page-1', 'saved')
    expect(stores.savedViewStore.setAutoPruneAt).toHaveBeenCalledWith(USER_ID, 'sv-page-1', null)
    expect(res.body.state).toBe('saved')
    expect(res.body.autoPruneAt).toBeNull()
  })

  it('PATCH /views/:id/unsave sets state to draft and schedules auto-prune', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.setState.mockResolvedValueOnce(true)
    stores.savedViewStore.setAutoPruneAt.mockResolvedValueOnce(true)
    stores.savedViewStore.getById.mockResolvedValueOnce(savedViewFixture({ state: 'draft' }))
    const res = await request(app).patch('/api/views/sv-page-1/unsave')
    expect(res.status).toBe(200)
    expect(stores.savedViewStore.setState).toHaveBeenCalledWith(USER_ID, 'sv-page-1', 'draft')
    // setAutoPruneAt called with a Date instance.
    const [, , when] = (stores.savedViewStore.setAutoPruneAt.mock.calls[0] ?? []) as [string, string, Date]
    expect(when).toBeInstanceOf(Date)
  })

  it('PATCH /views/:id/save returns 404 when row missing', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.setState.mockResolvedValueOnce(false)
    const res = await request(app).patch('/api/views/sv-page-1/save')
    expect(res.status).toBe(404)
  })
})

describe('[COMP:api/views-routes] reparent (page tree)', () => {
  const PARENT_ID = '00000000-0000-0000-0000-0000000000a1'

  it('rejects a non-UUID nestParentId', async () => {
    const { app } = makeApp({ userId: USER_ID })
    const res = await request(app)
      .patch('/api/views/sv-page-1/reparent')
      .send({ nestParentId: 'not-a-uuid', position: 0 })
    expect(res.status).toBe(400)
  })

  it('rejects a negative position', async () => {
    const { app } = makeApp({ userId: USER_ID })
    const res = await request(app)
      .patch('/api/views/sv-page-1/reparent')
      .send({ nestParentId: null, position: -1 })
    expect(res.status).toBe(400)
  })

  it('404s when the page is not visible', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.getById.mockResolvedValueOnce(null)
    const res = await request(app)
      .patch('/api/views/sv-page-1/reparent')
      .send({ nestParentId: null, position: 0 })
    expect(res.status).toBe(404)
  })

  it('400s on a cycle rejection (store returns false for a visible row)', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.getById.mockResolvedValueOnce(savedViewFixture())
    stores.savedViewStore.reparent.mockResolvedValueOnce(false)
    const res = await request(app)
      .patch('/api/views/sv-page-1/reparent')
      .send({ nestParentId: PARENT_ID, position: 0 })
    expect(res.status).toBe(400)
  })

  it('moves the page and returns fresh metadata', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.getById.mockResolvedValueOnce(savedViewFixture())
    stores.savedViewStore.reparent.mockResolvedValueOnce(true)
    stores.savedViewStore.getById.mockResolvedValueOnce(
      savedViewFixture({ nestParentId: PARENT_ID, position: 2 }),
    )
    const res = await request(app)
      .patch('/api/views/sv-page-1/reparent')
      .send({ nestParentId: PARENT_ID, position: 2 })
    expect(res.status).toBe(200)
    // Trailing args: writtenBy (undefined = 'user' default) + the mig-313
    // teamspace destination (undefined = adopt the parent's teamspace).
    expect(stores.savedViewStore.reparent).toHaveBeenCalledWith(
      USER_ID,
      'sv-page-1',
      PARENT_ID,
      2,
      undefined,
      undefined,
    )
    expect(res.body.nestParentId).toBe(PARENT_ID)
    expect(res.body.position).toBe(2)
  })

  it('accepts nestParentId: null to promote to root', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.getById.mockResolvedValueOnce(savedViewFixture({ nestParentId: PARENT_ID }))
    stores.savedViewStore.reparent.mockResolvedValueOnce(true)
    stores.savedViewStore.getById.mockResolvedValueOnce(savedViewFixture({ nestParentId: null, position: 0 }))
    const res = await request(app)
      .patch('/api/views/sv-page-1/reparent')
      .send({ nestParentId: null, position: 0 })
    expect(res.status).toBe(200)
    expect(stores.savedViewStore.reparent).toHaveBeenCalledWith(USER_ID, 'sv-page-1', null, 0, undefined, undefined)
    expect(res.body.nestParentId).toBeNull()
  })
})

describe('[COMP:api/views-routes] create draft', () => {
  it('POST /workspaces/:wid/views/draft requires workspace membership', async () => {
    const { app } = makeApp({ userId: USER_ID, role: null })
    const res = await request(app).post(`/api/workspaces/${WORKSPACE_ID}/views/draft`).send({})
    expect(res.status).toBe(403)
  })

  it('POST /workspaces/:wid/views/draft creates an empty draft with defaults', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.createDraft.mockResolvedValueOnce(savedViewFixture())
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/views/draft`)
      .send({})
    expect(res.status).toBe(201)
    expect(stores.savedViewStore.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        entity: 'tasks',
        viewType: 'table',
        page: { blocks: [] },
      }),
    )
  })

  it('POST /workspaces/:wid/views/draft defers the created event (interactive create, mig 283)', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.createDraft.mockResolvedValueOnce(savedViewFixture())
    await request(app).post(`/api/workspaces/${WORKSPACE_ID}/views/draft`).send({})
    expect(stores.savedViewStore.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ deferCreatedEvent: true }),
    )
  })

  it('POST /views/:id/commit-created fires the deferred created event and returns the flip result', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.commitCreatedEvent.mockResolvedValueOnce(true)
    const res = await request(app).post(`/api/views/sv-page-1/commit-created`).send({})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ committed: true })
    expect(stores.savedViewStore.commitCreatedEvent).toHaveBeenCalledWith(USER_ID, 'sv-page-1')
  })

  it('POST /views/:id/commit-created reports committed=false when the row already fired', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.commitCreatedEvent.mockResolvedValueOnce(false)
    const res = await request(app).post(`/api/views/sv-page-1/commit-created`).send({})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ committed: false })
  })

  it('POST /workspaces/:wid/views/draft accepts a custom binding', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.createDraft.mockResolvedValueOnce(savedViewFixture({
      entity: 'deals',
      viewType: 'board',
      binding: { entity: 'deals', viewType: 'board', groupBy: 'stage' },
    }))
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/views/draft`)
      .send({ binding: { entity: 'deals', viewType: 'board', groupBy: 'stage' } })
    expect(res.status).toBe(201)
    const args = (stores.savedViewStore.createDraft.mock.calls[0]?.[0] ?? {}) as { entity?: string }
    expect(args.entity).toBe('deals')
  })

  it('POST /workspaces/:wid/views/draft rejects a bad binding', async () => {
    const { app } = makeApp({ userId: USER_ID })
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/views/draft`)
      .send({ binding: { entity: 'companies', viewType: 'board' } })
    expect(res.status).toBe(400)
  })

  it('POST /workspaces/:wid/views/draft passes nestParentId through to createDraft', async () => {
    const nestParentId = '00000000-0000-0000-0000-0000000000a1'
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.createDraft.mockResolvedValueOnce(savedViewFixture({ nestParentId }))
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/views/draft`)
      .send({ name: 'Child', nestParentId })
    expect(res.status).toBe(201)
    expect(stores.savedViewStore.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ nestParentId }),
    )
    expect(res.body.nestParentId).toBe(nestParentId)
  })

  it('POST /workspaces/:wid/views/draft rejects a non-UUID nestParentId', async () => {
    const { app } = makeApp({ userId: USER_ID })
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/views/draft`)
      .send({ nestParentId: 'nope' })
    expect(res.status).toBe(400)
  })
})

// ── Auto-title (migration 218) ─────────────────────────────────────────

/** Minimal provider whose stream emits `title` then a usage message_end. */
function titleProvider(title: string) {
  return {
    createSession: () => ({ thoughtSignature: undefined }),
    async *stream() {
      yield { type: 'text_delta', text: title }
      yield {
        type: 'message_end',
        stopReason: 'end_turn',
        usage: { inputTokens: 60, outputTokens: 4 },
      }
    },
  }
}

function placeholderPageStore(text: string) {
  return {
    getVersionedPage: vi.fn().mockResolvedValue({
      page: { blocks: [{ kind: 'text', id: 't', text }] },
      version: 1,
      title: 'Untitled',
      nameOrigin: 'placeholder',
    anchorKey: null,
    linkedRecordingId: null,
      fullWidth: false,
    }),
    applyPatch: vi.fn(),
  }
}

describe('[COMP:api/doc-auto-title] name-origin provenance', () => {
  it('PATCH /saved-views/:id with a name stamps name_origin = user', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.update.mockResolvedValueOnce(
      savedViewFixture({ name: 'My Title', nameOrigin: 'user' }),
    )
    const res = await request(app).patch('/api/saved-views/sv-1').send({ name: 'My Title' })
    expect(res.status).toBe(200)
    expect(stores.savedViewStore.update).toHaveBeenCalledWith(
      USER_ID,
      'sv-1',
      expect.objectContaining({ name: 'My Title', nameOrigin: 'user' }),
    )
  })

  it('PATCH /saved-views/:id with only an icon does NOT touch name_origin', async () => {
    const { app, stores } = makeApp({ userId: USER_ID })
    stores.savedViewStore.update.mockResolvedValueOnce(savedViewFixture({ icon: '🚀' }))
    await request(app).patch('/api/saved-views/sv-1').send({ icon: '🚀' })
    const fields = stores.savedViewStore.update.mock.calls[0][2]
    expect(fields).not.toHaveProperty('nameOrigin')
  })
})

describe('[COMP:api/doc-auto-title] POST /saved-views/:id/auto-title', () => {
  it('401 when unauthenticated', async () => {
    const { app } = makeApp({ userId: null })
    const res = await request(app).post('/api/saved-views/sv-1/auto-title').send({})
    expect(res.status).toBe(401)
  })

  it('503 when the endpoint is not configured (no provider / page store)', async () => {
    const { app } = makeApp({ userId: USER_ID })
    const res = await request(app).post('/api/saved-views/sv-1/auto-title').send({})
    expect(res.status).toBe(503)
  })

  it('generates + commits a title for a placeholder page over the threshold', async () => {
    const docPageStore = placeholderPageStore(
      'Quarterly revenue review and planning notes for the enterprise segment. '.repeat(10),
    )
    const { app, stores } = makeApp({
      userId: USER_ID,
      autoTitle: { provider: titleProvider('Quarterly Revenue Review'), docPageStore },
    })
    stores.savedViewStore.setAutoTitle.mockResolvedValueOnce({
      name: 'Quarterly Revenue Review',
      icon: null,
    })
    const res = await request(app).post('/api/saved-views/sv-1/auto-title').send({})
    expect(res.status).toBe(200)
    // No emoji from the model → icon null in the response and the commit call.
    expect(res.body).toEqual({ applied: true, title: 'Quarterly Revenue Review', icon: null })
    expect(stores.savedViewStore.setAutoTitle).toHaveBeenCalledWith(
      USER_ID,
      'sv-1',
      'Quarterly Revenue Review',
      null,
    )
  })

  it('returns + commits a model-suggested emoji icon alongside the title', async () => {
    const docPageStore = placeholderPageStore(
      'Quarterly revenue review and planning notes for the enterprise segment. '.repeat(10),
    )
    const { app, stores } = makeApp({
      userId: USER_ID,
      autoTitle: { provider: titleProvider('📈 Quarterly Revenue Review'), docPageStore },
    })
    stores.savedViewStore.setAutoTitle.mockResolvedValueOnce({
      name: 'Quarterly Revenue Review',
      icon: '📈',
    })
    const res = await request(app).post('/api/saved-views/sv-1/auto-title').send({})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ applied: true, title: 'Quarterly Revenue Review', icon: '📈' })
    expect(stores.savedViewStore.setAutoTitle).toHaveBeenCalledWith(
      USER_ID,
      'sv-1',
      'Quarterly Revenue Review',
      '📈',
    )
  })

  it('returns applied:false for a too-thin page (below the threshold)', async () => {
    const docPageStore = placeholderPageStore('tiny')
    const { app, stores } = makeApp({
      userId: USER_ID,
      autoTitle: { provider: titleProvider('Whatever'), docPageStore },
    })
    const res = await request(app).post('/api/saved-views/sv-1/auto-title').send({})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ applied: false, title: null, icon: null })
    expect(stores.savedViewStore.setAutoTitle).not.toHaveBeenCalled()
  })
})
