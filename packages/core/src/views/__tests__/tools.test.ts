/**
 * [COMP:views/tools] Q5 chat tools — renderView + saveView.
 */

import { describe, expect, it, vi } from 'vitest'
import type { CrmStore } from '../../crm/types.js'
import type { TaskStore } from '../../tasks/types.js'
import type { WorkflowRunStore } from '../../workflow/types.js'
import type { SavedView, SavedViewStore } from '../types.js'
import { createRenderChartTool, createRenderViewTool, createSaveViewTool } from '../tools.js'
import { viewPayloadSchema } from '../a2ui.js'

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000010'
const USER_ID = '00000000-0000-0000-0000-000000000020'

function ctx(
  overrides: { workspaceId?: string | null; channelType?: string; docViewId?: string | null } = {},
) {
  return {
    userId: USER_ID,
    assistantId: 'asst-1',
    sessionId: 'sess-1',
    appId: 'sidanclaw',
    channelType: overrides.channelType ?? 'web',
    channelId: 'web-1',
    workspaceId: overrides.workspaceId === undefined ? WORKSPACE_ID : overrides.workspaceId,
    docViewId: overrides.docViewId ?? null,
    abortSignal: new AbortController().signal,
  }
}

function fakeTaskStore(): TaskStore {
  return {
    create: vi.fn(),
    getById: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    update: vi.fn(),
  }
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
  }
}

function makeSavedView(overrides: Partial<SavedView> & Pick<SavedView, 'name' | 'binding' | 'entity' | 'viewType'>): SavedView {
  return {
    id: 'sv-new',
    workspaceId: WORKSPACE_ID,
    createdBy: USER_ID,
    nameOrigin: 'placeholder',
    fullWidth: false,
    clearance: 'internal',
    description: null,
    icon: null,
    page: { blocks: [] },
    state: 'saved',
    originPrompt: null,
    autoPruneAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function fakeSavedViewStore(): SavedViewStore {
  return {
    create: vi.fn().mockImplementation(async ({ name, binding }) =>
      makeSavedView({
        name,
        entity: binding.entity,
        viewType: binding.viewType,
        binding,
        state: 'saved',
      }),
    ),
    getById: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    getPage: vi.fn().mockResolvedValue(null),
    updatePage: vi.fn().mockResolvedValue(true),
    setState: vi.fn().mockResolvedValue(true),
    setAutoPruneAt: vi.fn().mockResolvedValue(true),
    setAutoTitle: vi.fn().mockResolvedValue(null),
    createDraft: vi.fn().mockImplementation(async ({ name, binding, entity, viewType, page }) =>
      makeSavedView({
        name,
        entity,
        viewType,
        binding,
        page,
        state: 'draft',
        autoPruneAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }),
    ),
    reparent: vi.fn().mockResolvedValue(true),
    reorderSiblings: vi.fn().mockResolvedValue(undefined),
    pruneExpiredDraftsSystem: vi.fn().mockResolvedValue([]),
  }
}

function fakeWorkspaceDirectory() {
  return {
    listMembers: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    batchGet: vi.fn().mockResolvedValue(new Map()),
  }
}

function deps() {
  return {
    taskStore: fakeTaskStore(),
    crmStore: fakeCrmStore(),
    workflowRunStore: fakeWorkflowRunStore(),
    workspaceDirectory: fakeWorkspaceDirectory(),
    savedViewStore: fakeSavedViewStore(),
  }
}

describe('[COMP:views/tools] renderView', () => {
  it('returns isError when no workspace context', async () => {
    const tool = createRenderViewTool(deps())
    const res = await tool.execute(
      { binding: { entity: 'tasks', viewType: 'table' } },
      ctx({ workspaceId: null }),
    )
    expect(res.isError).toBe(true)
  })

  it('rejects an invalid binding shape', async () => {
    const tool = createRenderViewTool(deps())
    const res = await tool.execute(
      { binding: { entity: 'companies', viewType: 'board' } },
      ctx(),
    )
    expect(res.isError).toBe(true)
    const data = res.data as { ok?: boolean; errors?: string[] }
    expect(data.ok).toBe(false)
    expect(data.errors).toBeDefined()
  })

  it('returns an A2UI ViewPayload for tasks/table', async () => {
    const tool = createRenderViewTool(deps())
    const res = await tool.execute(
      { binding: { entity: 'tasks', viewType: 'table' } },
      ctx(),
    )
    expect(res.isError).toBeUndefined()
    const data = res.data as { kind: string; payload: unknown }
    expect(data.kind).toBe('view_payload')
    // Conformant against the v0.8 schema.
    expect(() => viewPayloadSchema.parse(data.payload)).not.toThrow()
  })

  it('emits onEvent on success', async () => {
    const onEvent = vi.fn()
    const d = { ...deps(), onEvent }
    const tool = createRenderViewTool(d)
    await tool.execute(
      { binding: { entity: 'deals', viewType: 'board', groupBy: 'stage' } },
      ctx(),
    )
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'view_rendered',
        entity: 'deals',
        viewType: 'board',
        viewId: 'sv-new',
      }),
      expect.objectContaining({ userId: USER_ID, channelType: 'web' }),
    )
  })

  it('creates a draft view and returns viewId alongside payload', async () => {
    const d = deps()
    const tool = createRenderViewTool(d)
    const res = await tool.execute(
      { binding: { entity: 'tasks', viewType: 'table' } },
      ctx(),
    )
    expect(res.isError).toBeUndefined()
    const data = res.data as { kind: string; viewId?: string }
    expect(data.kind).toBe('view_payload')
    expect(data.viewId).toBe('sv-new')
    expect(d.savedViewStore.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        entity: 'tasks',
        viewType: 'table',
      }),
    )
  })

  it('errors when draft creation fails (doc is draft-first; no inline fallback)', async () => {
    // Doc surface no longer inline-renders the widget — the draft on
    // the doc IS the render. If draft creation fails, surfacing
    // success would lie to the user, so we return an error result.
    const d = deps()
    ;(d.savedViewStore.createDraft as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db down'))
    const tool = createRenderViewTool(d)
    const res = await tool.execute(
      { binding: { entity: 'tasks', viewType: 'table' } },
      ctx(),
    )
    expect(res.isError).toBe(true)
    expect(typeof res.data).toBe('string')
    expect(res.data as string).toMatch(/db down/i)
  })

  it('skips draft creation in headless assistant-call sessions (payload only)', async () => {
    // Workflow `assistant_call` consults run with channelType
    // 'assistant-call' and no user in the loop — a draft minted there
    // would litter the doc sidebar on every scheduled fire (the
    // "workflow_runs/table — draft" hourly-trigger incident, 2026-06-10).
    const d = deps()
    const tool = createRenderViewTool(d)
    const res = await tool.execute(
      {
        binding: {
          entity: 'workflow_runs',
          viewType: 'table',
          filters: { workflowId: '00000000-0000-0000-0000-0000000000aa' },
        },
      },
      ctx({ channelType: 'assistant-call' }),
    )
    expect(res.isError).toBeUndefined()
    const data = res.data as { kind: string; action: string; viewId?: string }
    expect(data.kind).toBe('view_payload')
    expect(data.action).toBe('rendered')
    expect(data.viewId).toBeUndefined()
    expect(d.savedViewStore.createDraft).not.toHaveBeenCalled()
  })

  it('skips draft creation in cron sessions (payload only)', async () => {
    const d = deps()
    const tool = createRenderViewTool(d)
    const res = await tool.execute(
      { binding: { entity: 'tasks', viewType: 'table' } },
      ctx({ channelType: 'cron' }),
    )
    expect(res.isError).toBeUndefined()
    const data = res.data as { kind: string; action: string; viewId?: string }
    expect(data.kind).toBe('view_payload')
    expect(data.action).toBe('rendered')
    expect(data.viewId).toBeUndefined()
    expect(d.savedViewStore.createDraft).not.toHaveBeenCalled()
  })

  it('still emits view_rendered onEvent in headless sessions', async () => {
    const onEvent = vi.fn()
    const d = { ...deps(), onEvent }
    const tool = createRenderViewTool(d)
    await tool.execute(
      { binding: { entity: 'tasks', viewType: 'table' } },
      ctx({ channelType: 'assistant-call' }),
    )
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'view_rendered', entity: 'tasks', viewId: '' }),
      expect.objectContaining({ channelType: 'assistant-call' }),
    )
  })

  it('appends to the anchored page in a headless session (page-anchored workflow step)', async () => {
    // A docViewId in a headless session is a deliberate anchor (a workflow
    // step's `page` binding) — the block lands on that page, no draft.
    const d = deps()
    ;(d.savedViewStore.getPage as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      blocks: [{ kind: 'heading', id: 'h1', level: 1, text: 'Report' }],
    })
    const tool = createRenderViewTool(d)
    const res = await tool.execute(
      { binding: { entity: 'tasks', viewType: 'table' } },
      ctx({ channelType: 'assistant-call', docViewId: 'page-anchor-1' }),
    )
    expect(res.isError).toBeUndefined()
    const data = res.data as { action: string; viewId?: string }
    expect(data.action).toBe('appended')
    expect(data.viewId).toBe('page-anchor-1')
    expect(d.savedViewStore.updatePage).toHaveBeenCalledWith(
      USER_ID,
      'page-anchor-1',
      expect.objectContaining({
        blocks: expect.arrayContaining([expect.objectContaining({ kind: 'data' })]),
      }),
    )
    expect(d.savedViewStore.createDraft).not.toHaveBeenCalled()
  })

  it('falls to payload-only (never a draft) when the headless anchor is unreachable', async () => {
    // Regression guard for the hourly draft-minting incident: an anchored
    // headless session whose page was deleted must NOT mint a new draft.
    const d = deps() // fixture getPage resolves null by default
    const tool = createRenderViewTool(d)
    const res = await tool.execute(
      { binding: { entity: 'tasks', viewType: 'table' } },
      ctx({ channelType: 'assistant-call', docViewId: 'gone-page' }),
    )
    expect(res.isError).toBeUndefined()
    const data = res.data as { action: string; viewId?: string }
    expect(data.action).toBe('rendered')
    expect(data.viewId).toBeUndefined()
    expect(d.savedViewStore.createDraft).not.toHaveBeenCalled()
  })

  it('still creates a draft for an interactive session whose anchor is unreachable', async () => {
    // Interactive fall-through preserved: the user still gets a new draft.
    const d = deps()
    const tool = createRenderViewTool(d)
    const res = await tool.execute(
      { binding: { entity: 'tasks', viewType: 'table' } },
      ctx({ channelType: 'web', docViewId: 'gone-page' }),
    )
    expect(res.isError).toBeUndefined()
    const data = res.data as { action: string; viewId?: string }
    expect(data.action).toBe('created')
    expect(data.viewId).toBe('sv-new')
    expect(d.savedViewStore.createDraft).toHaveBeenCalled()
  })

  it('declares no required capability (free-tier)', () => {
    const tool = createRenderViewTool(deps())
    expect(tool.requiresCapability).toBeUndefined()
  })

  it('is not read-only and not concurrency-safe (writes a draft per call)', () => {
    // Notion-redesign: renderView creates a draft saved_views row server-side
    // on every successful invocation. It is therefore neither read-only nor
    // safe to fan out — two concurrent renders would produce two draft rows.
    const tool = createRenderViewTool(deps())
    expect(tool.isReadOnly).toBe(false)
    expect(tool.isConcurrencySafe).toBe(false)
  })
})

describe('[COMP:views/render-chart-tool] renderChart', () => {
  it('returns isError when no workspace context', async () => {
    const tool = createRenderChartTool(deps())
    const res = await tool.execute(
      {
        kind: 'bar',
        binding: { entity: 'tasks', op: 'count_by', groupBy: 'status' },
      },
      ctx({ workspaceId: null }),
    )
    expect(res.isError).toBe(true)
  })

  it('rejects an invalid aggregation binding shape', async () => {
    const tool = createRenderChartTool(deps())
    const res = await tool.execute(
      {
        kind: 'bar',
        binding: { entity: 'workflow_runs', op: 'count_by', groupBy: 'status' },
      },
      ctx(),
    )
    expect(res.isError).toBe(true)
    const data = res.data as { ok?: boolean; errors?: string[] }
    expect(data.ok).toBe(false)
    expect(data.errors).toBeDefined()
  })

  it('returns a chart_bar widget payload for kind=bar', async () => {
    const tool = createRenderChartTool(deps())
    const res = await tool.execute(
      {
        kind: 'bar',
        title: 'Tasks by status',
        binding: { entity: 'tasks', op: 'count_by', groupBy: 'status' },
      },
      ctx(),
    )
    expect(res.isError).toBeUndefined()
    const data = res.data as { kind: string; payload: { root: { type: string } }; chartKind: string }
    expect(data.kind).toBe('view_payload')
    expect(data.payload.root.type).toBe('chart_bar')
    expect(data.chartKind).toBe('bar')
    expect(() => viewPayloadSchema.parse(data.payload)).not.toThrow()
  })

  it('returns a kpi widget payload for kind=kpi', async () => {
    const tool = createRenderChartTool(deps())
    const res = await tool.execute(
      {
        kind: 'kpi',
        binding: { entity: 'tasks', op: 'count_by', groupBy: 'status' },
      },
      ctx(),
    )
    const data = res.data as { payload: { root: { type: string } } }
    expect(data.payload.root.type).toBe('kpi')
  })

  it('creates a draft page with a chart block and returns viewId', async () => {
    const d = deps()
    const tool = createRenderChartTool(d)
    const res = await tool.execute(
      {
        kind: 'pie',
        binding: { entity: 'deals', op: 'sum_by', groupBy: 'stage', measure: 'amount' },
      },
      ctx(),
    )
    expect(res.isError).toBeUndefined()
    const data = res.data as { viewId?: string }
    expect(data.viewId).toBe('sv-new')
    expect(d.savedViewStore.createDraft).toHaveBeenCalled()
    const callArgs = (d.savedViewStore.createDraft as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(callArgs.page.blocks[0].kind).toBe('chart')
    expect(callArgs.page.blocks[0].chartType).toBe('pie')
  })

  it('emits chart_rendered onEvent', async () => {
    const onEvent = vi.fn()
    const d = { ...deps(), onEvent }
    const tool = createRenderChartTool(d)
    await tool.execute(
      {
        kind: 'line',
        binding: {
          entity: 'deals',
          op: 'series_by_date',
          groupBy: 'closeDate',
          bucket: 'week',
          measure: 'amount',
        },
      },
      ctx(),
    )
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chart_rendered',
        entity: 'deals',
        chartKind: 'line',
      }),
      expect.any(Object),
    )
  })

  it('skips draft creation in headless sessions (payload only, mirrors renderView)', async () => {
    const d = deps()
    const tool = createRenderChartTool(d)
    const res = await tool.execute(
      {
        kind: 'bar',
        binding: { entity: 'tasks', op: 'count_by', groupBy: 'status' },
      },
      ctx({ channelType: 'assistant-call' }),
    )
    expect(res.isError).toBeUndefined()
    const data = res.data as { kind: string; viewId?: string; payload: { root: { type: string } } }
    expect(data.kind).toBe('view_payload')
    expect(data.viewId).toBeUndefined()
    expect(data.payload.root.type).toBe('chart_bar')
    expect(d.savedViewStore.createDraft).not.toHaveBeenCalled()
  })

  it('appends a chart block to the anchored page in a headless session', async () => {
    const d = deps()
    ;(d.savedViewStore.getPage as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      blocks: [],
    })
    const tool = createRenderChartTool(d)
    const res = await tool.execute(
      {
        kind: 'bar',
        binding: { entity: 'tasks', op: 'count_by', groupBy: 'status' },
      },
      ctx({ channelType: 'assistant-call', docViewId: 'page-anchor-1' }),
    )
    expect(res.isError).toBeUndefined()
    const data = res.data as { action?: string; viewId?: string }
    expect(data.action).toBe('appended')
    expect(data.viewId).toBe('page-anchor-1')
    const pageArg = (d.savedViewStore.updatePage as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(pageArg.blocks[0]).toMatchObject({ kind: 'chart', chartType: 'bar' })
    expect(d.savedViewStore.createDraft).not.toHaveBeenCalled()
  })

  it('appends (not a separate draft) in an interactive doc-anchored session', async () => {
    // Deliberate alignment with renderView's "doc drafts are containers":
    // renderChart used to mint a separate draft even with an active anchor.
    const d = deps()
    ;(d.savedViewStore.getPage as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      blocks: [],
    })
    const tool = createRenderChartTool(d)
    const res = await tool.execute(
      {
        kind: 'kpi',
        binding: { entity: 'tasks', op: 'count_by', groupBy: 'status' },
      },
      ctx({ channelType: 'web', docViewId: 'active-draft-1' }),
    )
    const data = res.data as { action?: string; viewId?: string }
    expect(data.action).toBe('appended')
    expect(data.viewId).toBe('active-draft-1')
    expect(d.savedViewStore.createDraft).not.toHaveBeenCalled()
  })

  it('declares no required capability (free-tier mirror of renderView)', () => {
    const tool = createRenderChartTool(deps())
    expect(tool.requiresCapability).toBeUndefined()
  })
})

describe('[COMP:views/tools] saveView', () => {
  it('declares requiresCapability:"views"', () => {
    const tool = createSaveViewTool(deps())
    expect(tool.requiresCapability).toBe('views')
  })

  it('persists a valid binding', async () => {
    const d = deps()
    const tool = createSaveViewTool(d)
    const res = await tool.execute(
      {
        name: 'Open Tasks',
        binding: { entity: 'tasks', viewType: 'table' },
      },
      ctx(),
    )
    expect(res.isError).toBeUndefined()
    const data = res.data as { id: string; url: string }
    expect(data.id).toBe('sv-new')
    expect(data.url).toBe(`/w/${WORKSPACE_ID}/p/sv-new`)
    expect(d.savedViewStore.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        workspaceId: WORKSPACE_ID,
        name: 'Open Tasks',
        binding: { entity: 'tasks', viewType: 'table' },
      }),
    )
  })

  it('rejects an invalid binding before calling the store', async () => {
    const d = deps()
    const tool = createSaveViewTool(d)
    const res = await tool.execute(
      { name: 'X', binding: { entity: 'workflow_runs', viewType: 'board' } },
      ctx(),
    )
    expect(res.isError).toBe(true)
    expect(d.savedViewStore.create).not.toHaveBeenCalled()
  })

  it('emits onEvent on save', async () => {
    const onEvent = vi.fn()
    const d = { ...deps(), onEvent }
    const tool = createSaveViewTool(d)
    await tool.execute(
      {
        name: 'Pipeline',
        binding: { entity: 'deals', viewType: 'board', groupBy: 'stage' },
      },
      ctx(),
    )
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'view_saved',
        viewId: 'sv-new',
        entity: 'deals',
        viewType: 'board',
      }),
      expect.any(Object),
    )
  })
})
