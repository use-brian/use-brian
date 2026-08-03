/**
 * [COMP:api/doc-inject] Doc inject — Phase 1 Batch 3.
 *
 * Verifies the inject function builds the 15 doc + entity tools and
 * pushes them into the chat session's tool registry. Stores are mocked
 * end-to-end; the inject path itself never touches pg.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

// Stub the pg client so any incidental store factory call doesn't try to
// connect during test bootstrap. `inject.ts` lazily-builds DB-backed stores
// when caller-supplied stores are absent — we pass mocks explicitly so this
// mock just exists for belt-and-braces.
vi.mock('../../db/client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import { injectDocTools } from '../inject.js'
import type {
  DocEntityStore,
  DocPageStore,
  CrmStore,
  SavedViewStore,
  TaskStore,
  Tool,
  WorkflowRunStore,
  WorkspaceDirectoryStore,
  LLMProvider,
} from '@use-brian/core'

// ── Minimal store stubs ─────────────────────────────────────────────
//
// Every method is a no-op vi.fn — the inject path doesn't call any of
// them (the tool factories are pure constructors). The stubs only exist
// to satisfy the type-shape so we don't pull in 1000+ lines of mock
// scaffolding.

function noopStore<T>(): T {
  return new Proxy(
    {},
    {
      get: () => vi.fn(),
    },
  ) as T
}

const docPageStore = noopStore<DocPageStore>()
const docEntityStore = noopStore<DocEntityStore>()
const savedViewStore = noopStore<SavedViewStore>()
const taskStore = noopStore<TaskStore>()
const crmStore = noopStore<CrmStore>()
const workflowRunStore = noopStore<WorkflowRunStore>()
const workspaceDirectory = noopStore<WorkspaceDirectoryStore>()

const baseOpts = {
  userId: 'user-1',
  assistant: {
    id: 'primary-1',
    kind: 'primary' as const,
    appType: null,
    workspaceId: 'ws-1',
  },
  // Doc tools inject on the doc SURFACE (any host assistant); the default
  // host in these tests is the workspace primary. Doc is a skill, not an app
  // type — the gate is `docSurface`, not `appType==='doc'`.
  docSurface: true,
  provider: noopStore<LLMProvider>(),
  backgroundModel: 'cheap-doc-editor',
  fallbackModel: 'standard-doc-editor',
  docPageStore,
  docEntityStore,
  savedViewStore,
  taskStore,
  crmStore,
  workflowRunStore,
  workspaceDirectory,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:api/doc-inject] injectDocTools', () => {
  it('injects nine reads plus one edit gateway and reports the count', async () => {
    const tools = new Map<string, Tool>()
    const result = await injectDocTools({ ...baseOpts, tools })

    expect(result.injected).toBe(true)
    expect(result.injectedCount).toBe(10)
    expect(tools.size).toBe(10)
  })

  it('keeps raw page mutations out of the conversational tool map', async () => {
    const tools = new Map<string, Tool>()
    await injectDocTools({ ...baseOpts, tools })

    expect(tools.has('delegateDocEdit')).toBe(true)
    expect(tools.has('renderPage')).toBe(false)
    expect(tools.has('patchPage')).toBe(false)
    expect(tools.has('getBlock')).toBe(true)
    expect(tools.has('queryDataBlock')).toBe(true)
    expect(tools.has('getCurrentPage')).toBe(true)
    expect(tools.has('getSection')).toBe(true)
    expect(tools.has('getBlockRange')).toBe(true)
    expect(tools.has('createSubPage')).toBe(false)
    expect(tools.has('exportPage')).toBe(true)
    expect(tools.has('importToPage')).toBe(false)
  })

  it('keeps entity reads but isolates entity mutations', async () => {
    const tools = new Map<string, Tool>()
    await injectDocTools({ ...baseOpts, tools })

    expect(tools.has('listEntityTypes')).toBe(true)
    expect(tools.has('createEntityType')).toBe(false)
    expect(tools.has('addProperty')).toBe(false)
    expect(tools.has('removeProperty')).toBe(false)
    expect(tools.has('renameProperty')).toBe(false)
    expect(tools.has('createEntity')).toBe(false)
    expect(tools.has('updateEntity')).toBe(false)
    expect(tools.has('deleteEntity')).toBe(false)
    expect(tools.has('queryEntities')).toBe(true)
    expect(tools.has('postComment')).toBe(false)
    expect(tools.has('resolveComment')).toBe(false)
    expect(tools.has('getCommentThread')).toBe(true)
  })

  it('injects fetchSiteIcon only when a FilesApi is wired', async () => {
    // Without filesApi (baseOpts): absent — the model must never see a tool
    // whose storage half can't run (tool-awareness rule).
    const bare = new Map<string, Tool>()
    await injectDocTools({ ...baseOpts, tools: bare })
    expect(bare.has('fetchSiteIcon')).toBe(false)

    // With filesApi: present, and the count reports it.
    const wired = new Map<string, Tool>()
    const result = await injectDocTools({
      ...baseOpts,
      tools: wired,
      filesApi: noopStore<import('@use-brian/core').FilesApi>(),
    })
    expect(wired.has('fetchSiteIcon')).toBe(true)
    expect(result.injectedCount).toBe(11)
  })

  it('removes the global renderView tool from the doc surface', async () => {
    // Mimic boot: `renderView` is a global tool registered once in
    // `apps/api/src/index.ts` and lands in the per-turn tool map for every
    // assistant. Seed a stub here the same way `apps/api` seeds the global
    // registry, then confirm the doc inject strips it — `renderView`
    // writes the frozen `saved_views.page` column the doc live editor
    // never reads, so doc authors data views via renderPage/patchPage.
    const tools = new Map<string, Tool>()
    const renderViewStub = { name: 'renderView' } as Tool
    tools.set(renderViewStub.name, renderViewStub)

    await injectDocTools({ ...baseOpts, tools })

    expect(tools.has('renderView')).toBe(false)
    // The compact gateway still lands — only the global renderView is removed.
    expect(tools.has('delegateDocEdit')).toBe(true)
    expect(tools.has('patchPage')).toBe(false)
  })

  it('no-ops off the doc surface and leaves a pre-seeded renderView intact', async () => {
    // Doc tools inject ONLY on the doc surface now (doc is a skill, not
    // an app type). Off-surface (no docSurface flag) the inject early-returns
    // and must NOT touch the global renderView — other surfaces (standard chat,
    // apps/web, "+ New draft") have no live Yjs doc, so saved_views.page IS the
    // right target for renderView there.
    const tools = new Map<string, Tool>()
    const renderViewStub = { name: 'renderView' } as Tool
    tools.set(renderViewStub.name, renderViewStub)

    const result = await injectDocTools({
      ...baseOpts,
      tools,
      docSurface: false,
    })

    expect(result.injected).toBe(false)
    expect(result.injectedCount).toBe(0)
    expect(tools.has('renderView')).toBe(true)
    expect(tools.get('renderView')).toBe(renderViewStub)
  })

  it('injects onto any host assistant on the surface (kind is not a gate)', async () => {
    // The skill model: whatever assistant is talking on the doc surface gets
    // the tools — primary (the default), standard, anything. Only the surface
    // flag + a bound workspace gate injection.
    const tools = new Map<string, Tool>()
    const result = await injectDocTools({
      ...baseOpts,
      tools,
      assistant: { id: 's-1', kind: 'standard', appType: null, workspaceId: 'ws-1' },
    })

    expect(result.injected).toBe(true)
    expect(result.injectedCount).toBe(10)
    expect(tools.has('delegateDocEdit')).toBe(true)
  })

  it('no-ops when assistant has no workspaceId', async () => {
    const tools = new Map<string, Tool>()
    const result = await injectDocTools({
      ...baseOpts,
      tools,
      assistant: { ...baseOpts.assistant, workspaceId: null },
    })

    expect(result.injected).toBe(false)
    expect(result.injectedCount).toBe(0)
    expect(tools.size).toBe(0)
  })

  it('preserves tools already in the registry', async () => {
    const tools = new Map<string, Tool>()
    const existing = { name: 'pre-existing' } as Tool
    tools.set(existing.name, existing)

    await injectDocTools({ ...baseOpts, tools })

    expect(tools.has('pre-existing')).toBe(true)
    expect(tools.get('pre-existing')).toBe(existing)
    expect(tools.size).toBe(11) // 10 injected + 1 pre-existing
  })

  it('fails closed by removing a pre-seeded raw mutation tool', async () => {
    const tools = new Map<string, Tool>()
    tools.set('patchPage', { name: 'patchPage' } as Tool)
    tools.set('postComment', { name: 'postComment' } as Tool)

    await injectDocTools({ ...baseOpts, tools })

    expect(tools.has('patchPage')).toBe(false)
    expect(tools.has('postComment')).toBe(false)
    expect(tools.has('delegateDocEdit')).toBe(true)
  })

})
