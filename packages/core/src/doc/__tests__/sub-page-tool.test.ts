/**
 * [COMP:doc/sub-page-tool] createSubPage — Notion sub-page primitive.
 *
 * Verifies the tool persists a draft nested under its parent
 * (`nestParentId = parentPageId`) and returns the pinned
 * `{ pageId, version, outline }` shape. Mock stores mirror the
 * `views/__tests__/tools.test.ts` setup.
 */

import { describe, expect, it, vi } from 'vitest'
import type { CrmStore } from '../../crm/types.js'
import type { TaskStore } from '../../tasks/types.js'
import type { WorkflowRunStore } from '../../workflow/types.js'
import type { SavedView, SavedViewStore } from '../../views/types.js'
import { createDocTools, createCreateSubPageTool } from '../tools.js'
import type { DocPageStore, DocToolDeps } from '../tools.js'
import { outlineSchema } from '../page-schemas.js'

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000010'
const USER_ID = '00000000-0000-0000-0000-000000000020'
const PARENT_ID = '00000000-0000-0000-0000-0000000000a1'

function ctx(overrides: { workspaceId?: string | null } = {}) {
  return {
    userId: USER_ID,
    assistantId: 'asst-1',
    sessionId: 'sess-1',
    appId: 'Use Brian',
    channelType: 'web',
    channelId: 'web-1',
    workspaceId: overrides.workspaceId === undefined ? WORKSPACE_ID : overrides.workspaceId,
    abortSignal: new AbortController().signal,
  }
}

function fakeTaskStore(): TaskStore {
  return { create: vi.fn(), getById: vi.fn(), list: vi.fn().mockResolvedValue([]), update: vi.fn() }
}

function fakeCrmStore(): CrmStore {
  const empty = vi.fn().mockResolvedValue([])
  return {
    createCompany: vi.fn(),
    getCompanyById: vi.fn(),
    listCompanies: empty,
    updateCompany: vi.fn(),
    createContact: vi.fn(),
    getContactById: vi.fn(),
    listContacts: empty,
    updateContact: vi.fn(),
    createDeal: vi.fn(),
    getDealById: vi.fn(),
    listDeals: empty,
    updateDeal: vi.fn(),
    setDealStage: vi.fn(),
    batchLabels: vi.fn().mockResolvedValue(new Map()),
  }
}

function fakeWorkflowRunStore(): WorkflowRunStore {
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

function fakeDocPageStore(): DocPageStore {
  return { getVersionedPage: vi.fn(), applyPatch: vi.fn() }
}

function makeSavedView(over: Partial<SavedView>): SavedView {
  return {
    id: 'sv-child',
    workspaceId: WORKSPACE_ID,
    createdBy: USER_ID,
    name: 'Untitled',
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
    nestParentId: null,
    position: 0,
    originPrompt: null,
    autoPruneAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    brainSyncEnabled: false,
    brainLastIngestHash: null,
    brainLastIngestAt: null,
    createdEventPending: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }
}

function fakeSavedViewStore(opts: { parentExists?: boolean } = {}): SavedViewStore {
  const parentExists = opts.parentExists ?? true
  return {
    create: vi.fn(),
    getById: vi.fn().mockImplementation(async (_userId: string, id: string) =>
      parentExists && id === PARENT_ID ? makeSavedView({ id: PARENT_ID, name: 'Parent' }) : null,
    ),
    list: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    getPage: vi.fn(),
    updatePage: vi.fn(),
    setState: vi.fn(),
    setAutoPruneAt: vi.fn(),
    setAutoTitle: vi.fn(),
    createDraft: vi.fn().mockImplementation(async ({ name, entity, viewType, binding, page, nestParentId }) =>
      makeSavedView({ id: 'sv-child', name, entity, viewType, binding, page, nestParentId: nestParentId ?? null }),
    ),
    findIdByAnchorKey: vi.fn().mockResolvedValue(null),
    commitCreatedEvent: vi.fn().mockResolvedValue(true),
    reparent: vi.fn().mockResolvedValue(true),
    reorderSiblings: vi.fn().mockResolvedValue(undefined),
    pruneExpiredDraftsSystem: vi.fn().mockResolvedValue([]),
    getBrainSyncStateSystem: vi.fn().mockResolvedValue(null),
    markBrainIngestedSystem: vi.fn().mockResolvedValue(true),
    getPageEventContextSystem: vi.fn().mockResolvedValue(null),
  }
}

function deps(over: Partial<DocToolDeps> = {}): DocToolDeps {
  return {
    savedViewStore: fakeSavedViewStore(),
    docPageStore: fakeDocPageStore(),
    taskStore: fakeTaskStore(),
    crmStore: fakeCrmStore(),
    workflowRunStore: fakeWorkflowRunStore(),
    workspaceDirectory: {
      listMembers: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      batchGet: vi.fn().mockResolvedValue(new Map()),
    },
    ...over,
  }
}

describe('[COMP:doc/sub-page-tool] createSubPage happy path', () => {
  it('persists a draft nested under the parent and returns pageId/version/outline', async () => {
    const d = deps()
    const tool = createCreateSubPageTool(d)
    const res = await tool.execute(
      { parentPageId: PARENT_ID, title: 'Q3 Planning' },
      ctx(),
    )

    expect(res.isError).toBeUndefined()
    const data = res.data as { kind: string; pageId: string; version: number; outline: unknown }
    expect(data.kind).toBe('doc_sub_page')
    expect(data.pageId).toBe('sv-child')
    expect(data.version).toBe(1)
    expect(() => outlineSchema.parse(data.outline)).not.toThrow()

    expect(d.savedViewStore.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        name: 'Q3 Planning',
        nestParentId: PARENT_ID,
      }),
    )
  })

  it('seeds the draft with the supplied page when provided', async () => {
    const d = deps()
    const tool = createCreateSubPageTool(d)
    const res = await tool.execute(
      {
        parentPageId: PARENT_ID,
        title: 'Seeded',
        page: { blocks: [{ kind: 'heading', id: 'h1', level: 1, text: 'Hi' }] },
      },
      ctx(),
    )
    expect(res.isError).toBeUndefined()
    expect(d.savedViewStore.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        page: { blocks: [{ kind: 'heading', id: 'h1', level: 1, text: 'Hi' }] },
        nestParentId: PARENT_ID,
      }),
    )
  })

  it('emits a sub_page_created event on success', async () => {
    const onEvent = vi.fn()
    const tool = createCreateSubPageTool(deps({ onEvent }))
    await tool.execute({ parentPageId: PARENT_ID, title: 'X' }, ctx())
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sub_page_created', parentPageId: PARENT_ID, pageId: 'sv-child' }),
      expect.objectContaining({ userId: USER_ID }),
    )
  })
})

describe('[COMP:doc/sub-page-tool] createSubPage guards', () => {
  it('errors when no workspace context', async () => {
    const tool = createCreateSubPageTool(deps())
    const res = await tool.execute(
      { parentPageId: PARENT_ID, title: 'X' },
      ctx({ workspaceId: null }),
    )
    expect(res.isError).toBe(true)
  })

  it('errors when the parent page is not visible / missing', async () => {
    const d = deps({ savedViewStore: fakeSavedViewStore({ parentExists: false }) })
    const tool = createCreateSubPageTool(d)
    const res = await tool.execute({ parentPageId: PARENT_ID, title: 'X' }, ctx())
    expect(res.isError).toBe(true)
    expect(d.savedViewStore.createDraft).not.toHaveBeenCalled()
  })
})

describe('[COMP:doc/sub-page-tool] createDocTools includes createSubPage', () => {
  it('exposes the sixth tool', () => {
    const tools = createDocTools(deps())
    expect(tools.createSubPage.name).toBe('createSubPage')
  })
})
