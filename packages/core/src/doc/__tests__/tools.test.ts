/**
 * [COMP:doc/tools] patchPage routing — Yjs gateway vs legacy CAS.
 *
 * Closes the `*(add)*` direct tool-execute gap tracked in
 * `docs/workflow/component-map.md` for `doc/tools`. Proves the
 * `patchPage` write-path fork:
 *
 *   - When a `docGateway` is wired (the page is open in the live
 *     collaborative Yjs editor), an `add` op carrying a `data` block
 *     routes through `gateway.applyOps` and NEVER touches the legacy
 *     `saved_views.page` CAS (`docPageStore.applyPatch`).
 *   - When no gateway is present (tests / smoke / scheduled-job
 *     contexts), the same call falls back to `docPageStore.applyPatch`
 *     — the atomic compare-and-swap path.
 *
 * Mocks mirror `views/__tests__/tools.test.ts` + `sub-page-tool.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest'
import type { CrmStore } from '../../crm/types.js'
import type { TaskStore } from '../../tasks/types.js'
import type { WorkflowRunStore } from '../../workflow/types.js'
import type { SavedViewStore } from '../../views/types.js'
import {
  createCreateSubPageTool,
  createGetBlockRangeTool,
  createGetCurrentPageTool,
  createGetSectionTool,
  createPatchPageTool,
  createRenderPageTool,
} from '../tools.js'
import type {
  DocGateway,
  DocPageStore,
  DocToolDeps,
} from '../tools.js'
import type { Page } from '../page-types.js'

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000010'
const USER_ID = '00000000-0000-0000-0000-000000000020'
const PAGE_ID = '00000000-0000-0000-0000-0000000000b1'

function ctx(overrides: { workspaceId?: string | null } = {}) {
  return {
    userId: USER_ID,
    assistantId: 'asst-1',
    sessionId: 'sess-1',
    appId: 'sidanclaw',
    channelType: 'web',
    channelId: 'web-1',
    workspaceId:
      overrides.workspaceId === undefined ? WORKSPACE_ID : overrides.workspaceId,
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
  }
}

function fakeSavedViewStore(): SavedViewStore {
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
    reparent: vi.fn().mockResolvedValue(true),
    reorderSiblings: vi.fn().mockResolvedValue(undefined),
    pruneExpiredDraftsSystem: vi.fn().mockResolvedValue([]),
  }
}

/** A page-store whose `getVersionedPage` returns the given page at version 1. */
function fakeDocPageStore(page: Page, version = 1): DocPageStore {
  return {
    getVersionedPage: vi.fn().mockResolvedValue({ page, version, title: 'Doc' }),
    applyPatch: vi.fn().mockResolvedValue({ newVersion: version + 1 }),
  }
}

function fakeDocGateway(): DocGateway {
  return {
    applyOps: vi
      .fn()
      .mockResolvedValue({ idMap: { 'tmp-1': 'real-1' }, skipped: [], version: 2 }),
  }
}

function deps(over: Partial<DocToolDeps> = {}): DocToolDeps {
  return {
    savedViewStore: fakeSavedViewStore(),
    docPageStore: fakeDocPageStore({ blocks: [] }),
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

/** An `add` op that drops a `data` block (tasks/table) onto the page. */
const addDataBlockOps = [
  {
    op: 'add' as const,
    after: 'end' as const,
    block: {
      kind: 'data' as const,
      id: 'tmp-1',
      binding: { entity: 'tasks' as const, viewType: 'table' as const },
    },
  },
]

describe('[COMP:doc/tools] patchPage write-path routing', () => {
  it('routes a data-block add through the Yjs gateway and skips the legacy CAS when a gateway is wired', async () => {
    const gateway = fakeDocGateway()
    const d = deps({ docGateway: gateway })
    const tool = createPatchPageTool(d)

    const res = await tool.execute(
      { pageId: PAGE_ID, ops: addDataBlockOps, expectedVersion: 1 },
      ctx(),
    )

    expect(res.isError).toBeUndefined()
    const data = res.data as { kind: string; pageId: string; version: number }
    expect(data.kind).toBe('doc_patch')
    expect(data.pageId).toBe(PAGE_ID)
    expect(data.version).toBe(2)

    // The gateway IS the write path...
    expect(gateway.applyOps).toHaveBeenCalledTimes(1)
    expect(gateway.applyOps).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        pageId: PAGE_ID,
        ops: addDataBlockOps,
      }),
    )
    // ...and the legacy compare-and-swap is NOT touched.
    expect(d.docPageStore.applyPatch).not.toHaveBeenCalled()
  })

  it('falls back to the legacy docPageStore.applyPatch CAS when no gateway is present', async () => {
    const d = deps() // no docGateway
    const tool = createPatchPageTool(d)

    const res = await tool.execute(
      { pageId: PAGE_ID, ops: addDataBlockOps, expectedVersion: 1 },
      ctx(),
    )

    expect(res.isError).toBeUndefined()
    const data = res.data as { kind: string; pageId: string; version: number }
    expect(data.kind).toBe('doc_patch')
    expect(data.version).toBe(2)

    // The CAS path IS the write path when no live-doc gateway is wired.
    expect(d.docPageStore.applyPatch).toHaveBeenCalledTimes(1)
    expect(d.docPageStore.applyPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        pageId: PAGE_ID,
        expectedVersion: 1,
      }),
    )
  })

  it('errors without a workspace context (gate)', async () => {
    const gateway = fakeDocGateway()
    const tool = createPatchPageTool(deps({ docGateway: gateway }))
    const res = await tool.execute(
      { pageId: PAGE_ID, ops: addDataBlockOps, expectedVersion: 1 },
      ctx({ workspaceId: null }),
    )
    expect(res.isError).toBe(true)
    expect(gateway.applyOps).not.toHaveBeenCalled()
  })

  // A block present in the SERVER snapshot (so the per-op pre-walk applies the
  // op and the CAS-path `appliedOps.length === 0` guard does NOT fire) but
  // deleted in the LIVE Y.Doc (so the gateway skips it). This snapshot/live-doc
  // divergence is the exact condition the prod incident hit.
  const PAGE_WITH_LIVE_BLOCK = {
    blocks: [{ kind: 'text', id: 'b1', text: 'orig' }],
  } as unknown as Page

  it('returns invalid_ops (isError) when EVERY gateway op is skipped — no silent no-op doc_patch', async () => {
    // Regression: prod incident 2026-06-11 (session d98e2acd). On a live
    // collaborative page the model patched a block a prior edit had already
    // deleted in the Y.Doc. The op applied to the server snapshot (pre-walk)
    // but the gateway skipped it, and the tool still returned a success-shaped
    // `doc_patch` (empty changed/removed) — NO error signal — so the model
    // looped re-issuing the same stale op, and the loop-detector's failure fuse
    // (fed by tool `isError` via recordOutcome) never tripped: the turn churned
    // 16 times and a weak model leaked an internal directive as its reply. The
    // all-skipped no-op must surface as invalid_ops / isError so the model
    // re-anchors AND the fuse can trip on repeats. Mirrors the CAS-path guard.
    // See tools.ts gateway path + engine/loop-detector.ts.
    const gateway: DocGateway = {
      applyOps: vi.fn().mockResolvedValue({
        idMap: {},
        version: 5,
        skipped: [{ opIndex: 0, reason: 'edit-target-missing' }],
      }),
    }
    const tool = createPatchPageTool(
      deps({ docGateway: gateway, docPageStore: fakeDocPageStore(PAGE_WITH_LIVE_BLOCK) }),
    )

    const res = await tool.execute(
      {
        pageId: PAGE_ID,
        expectedVersion: 1,
        ops: [{ op: 'edit' as const, blockId: 'b1', patch: { text: 'x' } }],
      } as Parameters<typeof tool.execute>[0],
      ctx(),
    )

    // The gateway WAS consulted (pre-walk passed) and reported all ops skipped.
    expect(gateway.applyOps).toHaveBeenCalledTimes(1)
    expect(res.isError).toBe(true)
    const data = res.data as { kind: string; skipped: unknown[]; outline: unknown }
    expect(data.kind).toBe('invalid_ops')
    expect(data.skipped).toHaveLength(1)
    expect(data.outline).toBeDefined()
  })

  it('keeps the success doc_patch when only SOME gateway ops are skipped (guard does not over-fire)', async () => {
    // A productive patch where one op was stale must stay a success — otherwise
    // the loop-detector would see a spurious error on a turn that made progress.
    const gateway: DocGateway = {
      applyOps: vi.fn().mockResolvedValue({
        idMap: { 'tmp-1': 'real-1' },
        version: 6,
        skipped: [{ opIndex: 0, reason: 'delete-target-missing' }],
      }),
    }
    const tool = createPatchPageTool(
      deps({ docGateway: gateway, docPageStore: fakeDocPageStore(PAGE_WITH_LIVE_BLOCK) }),
    )

    const res = await tool.execute(
      {
        pageId: PAGE_ID,
        expectedVersion: 1,
        ops: [
          { op: 'delete' as const, blockId: 'b1' },
          {
            op: 'add' as const,
            after: 'end' as const,
            block: { kind: 'text' as const, id: 'tmp-1', text: 'added' },
          },
        ],
      } as Parameters<typeof tool.execute>[0],
      ctx(),
    )

    expect(res.isError).toBeUndefined()
    const data = res.data as { kind: string; skipped?: unknown[] }
    expect(data.kind).toBe('doc_patch')
    expect(data.skipped).toHaveLength(1)
  })

  it('builds the delta from the gateway live page, not a stale snapshot re-read', async () => {
    // Root fix for the read-after-write gap: the gateway returns the
    // authoritative post-apply page from the live in-memory doc, and patchPage
    // must build its delta/outline from THAT — not a second getVersionedPage
    // read of the debounced `documents.snapshot_json`, which lags ~2s and showed
    // the model a stale page (it re-targeted already-deleted blocks and looped;
    // prod incident 2026-06-11). See tools.ts gateway path + doc-sync apply.
    const gateway: DocGateway = {
      applyOps: vi.fn().mockResolvedValue({
        idMap: {},
        version: 9,
        skipped: [],
        page: { blocks: [{ kind: 'text', id: 'b1', text: 'live-truth' }] },
        title: 'Doc',
      }),
    }
    const store = fakeDocPageStore(PAGE_WITH_LIVE_BLOCK)
    const tool = createPatchPageTool(deps({ docGateway: gateway, docPageStore: store }))

    const res = await tool.execute(
      {
        pageId: PAGE_ID,
        expectedVersion: 1,
        ops: [{ op: 'edit' as const, blockId: 'b1', patch: { text: 'new' } }],
      } as Parameters<typeof tool.execute>[0],
      ctx(),
    )

    expect(res.isError).toBeUndefined()
    const data = res.data as { kind: string; version: number; changed: unknown[] }
    expect(data.kind).toBe('doc_patch')
    expect(data.version).toBe(9)
    // getVersionedPage was consulted ONCE — the initial load. The gateway's live
    // page supplied the post-apply state, so NO stale snapshot re-read happened.
    expect(store.getVersionedPage).toHaveBeenCalledTimes(1)
    // ...and the delta reflects the gateway's live block, not the snapshot.
    expect(JSON.stringify(data.changed)).toContain('live-truth')
  })
})

describe('[COMP:doc/tools] patchPage tolerant application (stale targets skipped)', () => {
  // A page with one real block, so a delete/edit of any OTHER id is "stale".
  const PAGE_WITH_BLOCK = {
    blocks: [{ kind: 'text', id: 'keep-1', text: 'keep' }],
  } as unknown as Page

  it('skips a stale delete and still commits the valid ops (no whole-patch reject)', async () => {
    const d = deps({ docPageStore: fakeDocPageStore(PAGE_WITH_BLOCK) })
    const tool = createPatchPageTool(d)

    const res = await tool.execute(
      {
        pageId: PAGE_ID,
        expectedVersion: 1,
        ops: [
          { op: 'delete' as const, blockId: 'ghost-block' }, // target no longer exists
          {
            op: 'add' as const,
            after: 'end' as const,
            block: { kind: 'text' as const, id: 'tmp-new', text: 'added' },
          },
        ],
      } as Parameters<typeof tool.execute>[0],
      ctx(),
    )

    expect(res.isError).toBeUndefined()
    const data = res.data as {
      kind: string
      skipped?: { op: string; reason: string }[]
    }
    expect(data.kind).toBe('doc_patch')
    // The stale delete is reported as skipped, not fatal to the whole patch.
    expect(data.skipped).toBeDefined()
    expect(data.skipped).toHaveLength(1)
    expect(data.skipped![0].op).toBe('delete')
    expect(data.skipped![0].reason).toMatch(/not found/)
    // ...and the valid add still committed.
    expect(d.docPageStore.applyPatch).toHaveBeenCalledTimes(1)
  })

  it('returns invalid_ops with a fresh outline when EVERY op is stale (nothing committed)', async () => {
    const d = deps({ docPageStore: fakeDocPageStore(PAGE_WITH_BLOCK) })
    const tool = createPatchPageTool(d)

    const res = await tool.execute(
      {
        pageId: PAGE_ID,
        expectedVersion: 1,
        ops: [{ op: 'edit' as const, blockId: 'ghost-block', patch: { text: 'x' } }],
      } as Parameters<typeof tool.execute>[0],
      ctx(),
    )

    expect(res.isError).toBe(true)
    const data = res.data as { kind: string; skipped: unknown[]; outline: unknown }
    expect(data.kind).toBe('invalid_ops')
    expect(data.skipped).toHaveLength(1)
    expect(data.outline).toBeDefined()
    // Nothing applied → no write attempted.
    expect(d.docPageStore.applyPatch).not.toHaveBeenCalled()
  })
})

describe('[COMP:doc/tools] follow-up tag is stripped from authored content', () => {
  const TAG = '<followup>["What is X?", "What is Y?"]</followup>'

  it('renderPage strips the <followup> chip tag from text blocks before persisting', async () => {
    const saved = fakeSavedViewStore()
    const tool = createRenderPageTool(deps({ savedViewStore: saved }))

    await tool.execute(
      {
        page: {
          blocks: [
            { kind: 'text', id: 'tmp-1', text: `About SIDAN.\n\n${TAG}` },
            { kind: 'heading', id: 'tmp-2', level: 1, text: `Goals ${TAG}` },
          ],
        },
        title: 'SIDAN',
      } as Parameters<typeof tool.execute>[0],
      ctx(),
    )

    expect(saved.createDraft).toHaveBeenCalledTimes(1)
    const persisted = (saved.createDraft as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .page as Page
    const text0 = (persisted.blocks[0] as { text: string }).text
    const text1 = (persisted.blocks[1] as { text: string }).text
    expect(text0).toBe('About SIDAN.')
    expect(text1).toBe('Goals')
    expect(JSON.stringify(persisted)).not.toContain('<followup')
  })

  it('patchPage strips the <followup> tag from an add op block before it reaches the gateway', async () => {
    const gateway = fakeDocGateway()
    const tool = createPatchPageTool(deps({ docGateway: gateway }))

    await tool.execute(
      {
        pageId: PAGE_ID,
        expectedVersion: 1,
        ops: [
          {
            op: 'add' as const,
            after: 'end' as const,
            block: { kind: 'text' as const, id: 'tmp-9', text: `Note ${TAG}` },
          },
        ],
      } as Parameters<typeof tool.execute>[0],
      ctx(),
    )

    expect(gateway.applyOps).toHaveBeenCalledTimes(1)
    const sentOps = (gateway.applyOps as ReturnType<typeof vi.fn>).mock.calls[0][0].ops
    expect(JSON.stringify(sentOps)).not.toContain('<followup')
    expect(sentOps[0].block.text).toBe('Note')
  })
})

describe('[COMP:doc/tools] page icon — renderPage / createSubPage', () => {
  it('renderPage threads an explicit `icon` into createDraft', async () => {
    const saved = fakeSavedViewStore()
    const tool = createRenderPageTool(deps({ savedViewStore: saved }))

    await tool.execute(
      {
        page: { blocks: [{ kind: 'text', id: 'tmp-1', text: 'Body' }] },
        title: 'Jeju Trip',
        icon: '🌋',
      } as Parameters<typeof tool.execute>[0],
      ctx(),
    )

    expect(saved.createDraft).toHaveBeenCalledTimes(1)
    const draftArg = (saved.createDraft as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(draftArg.icon).toBe('🌋')
    // The title is NOT decorated with the emoji — that's the whole point.
    expect(draftArg.name).toBe('Jeju Trip')
  })

  it('renderPage passes icon: null when none is given', async () => {
    const saved = fakeSavedViewStore()
    const tool = createRenderPageTool(deps({ savedViewStore: saved }))

    await tool.execute(
      { page: { blocks: [] }, title: 'Plain' } as Parameters<typeof tool.execute>[0],
      ctx(),
    )

    const draftArg = (saved.createDraft as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(draftArg.icon).toBeNull()
  })

  it('createSubPage threads an explicit `icon` into createDraft', async () => {
    const saved = fakeSavedViewStore()
    // The parent must be visible for the nest to proceed.
    ;(saved.getById as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: PAGE_ID,
      workspaceId: WORKSPACE_ID,
    })
    ;(saved.createDraft as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'child-1',
    })
    const tool = createCreateSubPageTool(deps({ savedViewStore: saved }))

    await tool.execute(
      {
        parentPageId: PAGE_ID,
        title: 'Logistics',
        icon: '🧳',
      } as Parameters<typeof tool.execute>[0],
      ctx(),
    )

    expect(saved.createDraft).toHaveBeenCalledTimes(1)
    const draftArg = (saved.createDraft as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(draftArg.icon).toBe('🧳')
    expect(draftArg.nestParentId).toBe(PAGE_ID)
  })
})

describe('[COMP:doc/tools] patchPage setIcon op', () => {
  const setIconOps = [{ op: 'setIcon' as const, icon: '🌋' }]

  it('persists the icon to saved_views via update on the legacy CAS path', async () => {
    const saved = fakeSavedViewStore()
    const d = deps({ savedViewStore: saved }) // no gateway → CAS path
    const tool = createPatchPageTool(d)

    const res = await tool.execute(
      { pageId: PAGE_ID, ops: setIconOps, expectedVersion: 1 },
      ctx(),
    )

    expect(res.isError).toBeUndefined()
    expect(saved.update).toHaveBeenCalledTimes(1)
    expect(saved.update).toHaveBeenCalledWith(
      USER_ID,
      PAGE_ID,
      expect.objectContaining({ icon: '🌋' }),
    )
    // The blocks themselves are unchanged — it's a metadata-only patch.
    expect(d.docPageStore.applyPatch).toHaveBeenCalledTimes(1)
  })

  it('persists the icon AND is filtered out of the Yjs gateway payload', async () => {
    const gateway = fakeDocGateway()
    const saved = fakeSavedViewStore()
    const tool = createPatchPageTool(deps({ docGateway: gateway, savedViewStore: saved }))

    await tool.execute(
      {
        pageId: PAGE_ID,
        // a real block add alongside the setIcon, to prove only setIcon is dropped
        ops: [
          {
            op: 'add' as const,
            after: 'end' as const,
            block: { kind: 'text' as const, id: 'tmp-1', text: 'Hi' },
          },
          ...setIconOps,
        ],
        expectedVersion: 1,
      } as Parameters<typeof tool.execute>[0],
      ctx(),
    )

    // The icon still lands in saved_views...
    expect(saved.update).toHaveBeenCalledWith(
      USER_ID,
      PAGE_ID,
      expect.objectContaining({ icon: '🌋' }),
    )
    // ...but the setIcon op never reaches the live Y.Doc (no representation).
    expect(gateway.applyOps).toHaveBeenCalledTimes(1)
    const sentOps = (gateway.applyOps as ReturnType<typeof vi.fn>).mock.calls[0][0].ops
    expect(sentOps.some((o: { op: string }) => o.op === 'setIcon')).toBe(false)
    expect(sentOps).toHaveLength(1)
    expect(sentOps[0].op).toBe('add')
  })

  it('clears the icon when setIcon carries null', async () => {
    const saved = fakeSavedViewStore()
    const tool = createPatchPageTool(deps({ savedViewStore: saved }))

    await tool.execute(
      { pageId: PAGE_ID, ops: [{ op: 'setIcon' as const, icon: null }], expectedVersion: 1 },
      ctx(),
    )

    expect(saved.update).toHaveBeenCalledWith(
      USER_ID,
      PAGE_ID,
      expect.objectContaining({ icon: null }),
    )
  })
})

describe('[COMP:doc/tools] page_patched meta — live title/icon streaming signal', () => {
  // The chat route streams `page_patched.meta` to open clients (tabs /
  // breadcrumb / sidebar) the instant a setTitle/setIcon commits. It must be
  // present ONLY when a metadata op ran, and carry the committed values.
  const patchedEvent = (onEvent: ReturnType<typeof vi.fn>) =>
    onEvent.mock.calls.find(
      (c) => (c[0] as { type?: string })?.type === 'page_patched',
    )?.[0] as
      | { meta?: { title: string; icon: string | null; nameOrigin: string } }
      | undefined

  it('carries meta { title, icon: null, nameOrigin: "user" } on a setTitle patch', async () => {
    const onEvent = vi.fn()
    const tool = createPatchPageTool(deps({ onEvent }))
    await tool.execute(
      { pageId: PAGE_ID, ops: [{ op: 'setTitle' as const, title: 'Renamed' }], expectedVersion: 1 },
      ctx(),
    )
    expect(patchedEvent(onEvent)?.meta).toEqual({
      title: 'Renamed',
      icon: null,
      nameOrigin: 'user',
    })
  })

  it('carries the committed icon on a setIcon patch', async () => {
    const onEvent = vi.fn()
    const tool = createPatchPageTool(deps({ onEvent }))
    await tool.execute(
      { pageId: PAGE_ID, ops: [{ op: 'setIcon' as const, icon: '🌋' }], expectedVersion: 1 },
      ctx(),
    )
    expect(patchedEvent(onEvent)?.meta?.icon).toBe('🌋')
  })

  it('omits meta for a block-only patch (no setTitle/setIcon)', async () => {
    const onEvent = vi.fn()
    const tool = createPatchPageTool(deps({ onEvent }))
    await tool.execute(
      { pageId: PAGE_ID, ops: addDataBlockOps, expectedVersion: 1 },
      ctx(),
    )
    const evt = patchedEvent(onEvent)
    expect(evt).toBeDefined()
    expect(evt?.meta).toBeUndefined()
  })

  it('emits meta on the Yjs gateway path too', async () => {
    const onEvent = vi.fn()
    const tool = createPatchPageTool(deps({ onEvent, docGateway: fakeDocGateway() }))
    await tool.execute(
      { pageId: PAGE_ID, ops: [{ op: 'setIcon' as const, icon: '🌋' }], expectedVersion: 1 },
      ctx(),
    )
    expect(patchedEvent(onEvent)?.meta?.icon).toBe('🌋')
  })
})

describe('[COMP:doc/tools] patchPage anchor-pinning (stale-page fix)', () => {
  const STALE_PAGE_ID = '00000000-0000-0000-0000-0000000000ff'

  it('redirects a stale model-supplied pageId to the anchor (the open page)', async () => {
    // The model recalls an old pageId from context (resumed session) and tries
    // to edit it. With an anchor set (the page the user is looking at) and the id
    // neither the anchor nor a same-turn page, the edit redirects to the anchor
    // so it lands where the user is looking, not on an orphan / wrong page.
    const gateway = fakeDocGateway()
    const tool = createPatchPageTool(deps({ docGateway: gateway, anchorPageId: PAGE_ID }))

    const res = await tool.execute(
      { pageId: STALE_PAGE_ID, ops: addDataBlockOps, expectedVersion: 1 },
      ctx(),
    )

    expect(res.isError).toBeUndefined()
    expect(gateway.applyOps).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: PAGE_ID }),
    )
  })

  it('allows patching a page created earlier in the same turn (not redirected)', async () => {
    // renderPage / createSubPage register the new id in turnCreatedPageIds, so a
    // legitimate "create a sub-page and fill it in" flow still edits the new page.
    const gateway = fakeDocGateway()
    const tool = createPatchPageTool(
      deps({
        docGateway: gateway,
        anchorPageId: PAGE_ID,
        turnCreatedPageIds: new Set([STALE_PAGE_ID]),
      }),
    )

    await tool.execute(
      { pageId: STALE_PAGE_ID, ops: addDataBlockOps, expectedVersion: 1 },
      ctx(),
    )

    expect(gateway.applyOps).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: STALE_PAGE_ID }),
    )
  })

  it('trusts the model pageId when no anchor is set (new-draft turn)', async () => {
    const gateway = fakeDocGateway()
    const tool = createPatchPageTool(deps({ docGateway: gateway }))

    await tool.execute(
      { pageId: STALE_PAGE_ID, ops: addDataBlockOps, expectedVersion: 1 },
      ctx(),
    )

    expect(gateway.applyOps).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: STALE_PAGE_ID }),
    )
  })

  it('does not redirect when the model already targets the anchor', async () => {
    const gateway = fakeDocGateway()
    const tool = createPatchPageTool(deps({ docGateway: gateway, anchorPageId: PAGE_ID }))

    await tool.execute(
      { pageId: PAGE_ID, ops: addDataBlockOps, expectedVersion: 1 },
      ctx(),
    )

    expect(gateway.applyOps).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: PAGE_ID }),
    )
  })
})

describe('[COMP:doc/tools] patchPage returns a delta, not the whole-page outline', () => {
  const PAGE_TWO_BLOCKS = {
    blocks: [
      { kind: 'text', id: 'b1', text: 'one' },
      { kind: 'text', id: 'b2', text: 'two' },
    ],
  } as unknown as Page

  it('returns only changed/removed ids on the CAS path (no full outline echo)', async () => {
    const d = deps({ docPageStore: fakeDocPageStore(PAGE_TWO_BLOCKS) })
    const tool = createPatchPageTool(d)

    const res = await tool.execute(
      {
        pageId: PAGE_ID,
        expectedVersion: 1,
        ops: [
          { op: 'edit' as const, blockId: 'b1', patch: { text: 'ONE' } }, // edit
          {
            op: 'add' as const,
            after: 'end' as const,
            block: { kind: 'text' as const, id: 'tmp-x', text: 'three' },
          }, // add
          { op: 'delete' as const, blockId: 'b2' }, // delete
        ],
      } as Parameters<typeof tool.execute>[0],
      ctx(),
    )

    expect(res.isError).toBeUndefined()
    const data = res.data as {
      kind: string
      changed: { id: string }[]
      removed: string[]
      idMap: Record<string, string>
      outline?: unknown
    }
    expect(data.kind).toBe('doc_patch')
    // The whole-page outline is GONE from the success result — that is the
    // token-ballast lever (the live outline is in the system prompt instead).
    expect(data.outline).toBeUndefined()

    const changedIds = data.changed.map((e) => e.id)
    // The edited block (b1) and the added block (tmp-x → real id) are changed.
    expect(changedIds).toContain('b1')
    const addedRealId = data.idMap['tmp-x']
    expect(addedRealId).toBeDefined()
    expect(changedIds).toContain(addedRealId)
    // Exactly the two touched blocks — nothing else from the page.
    expect(changedIds).toHaveLength(2)
    // The deleted block is reported in removed.
    expect(data.removed).toEqual(['b2'])
  })

  it('returns a delta + merged idMap on the Yjs gateway path (diffs vs the re-read snapshot)', async () => {
    const pre = { blocks: [{ kind: 'text', id: 'b1', text: 'one' }] } as unknown as Page
    // The re-read (2nd getVersionedPage call) is the merged CRDT post-patch:
    // it carries the gateway-added block `real-1` AND a block `concurrent-x`
    // that NO op created — simulating a collaborator's concurrent edit.
    const reread = {
      blocks: [
        { kind: 'text', id: 'b1', text: 'one' },
        { kind: 'data', id: 'real-1', binding: { entity: 'tasks', viewType: 'table' } },
        { kind: 'text', id: 'concurrent-x', text: 'from another editor' },
      ],
    } as unknown as Page
    const getVersionedPage = vi
      .fn()
      .mockResolvedValueOnce({ page: pre, version: 1, title: 'Doc' })
      .mockResolvedValueOnce({ page: reread, version: 2, title: 'Doc' })
    const docPageStore = {
      getVersionedPage,
      applyPatch: vi.fn(),
    } as unknown as DocPageStore
    const gateway: DocGateway = {
      applyOps: vi
        .fn()
        .mockResolvedValue({ idMap: { 'tmp-1': 'real-1' }, skipped: [], version: 2 }),
    }
    const d = deps({ docPageStore, docGateway: gateway })
    const tool = createPatchPageTool(d)

    const res = await tool.execute(
      { pageId: PAGE_ID, ops: addDataBlockOps, expectedVersion: 1 },
      ctx(),
    )

    expect(res.isError).toBeUndefined()
    const data = res.data as {
      kind: string
      changed: { id: string }[]
      removed: string[]
      idMap: Record<string, string>
      outline?: unknown
    }
    expect(data.kind).toBe('doc_patch')
    expect(data.outline).toBeUndefined()
    // Merged idMap: the gateway's tmp-1 -> real-1 wins.
    expect(data.idMap['tmp-1']).toBe('real-1')
    const changedIds = data.changed.map((e) => e.id)
    // The gateway-added block is in the delta...
    expect(changedIds).toContain('real-1')
    // ...and so is the concurrent collaborator's block — by design: the Yjs
    // path diffs against the merged re-read, so concurrent edits legitimately
    // surface in `changed` (a bounded, safe over-report on a live page).
    expect(changedIds).toContain('concurrent-x')
    expect(data.removed).toEqual([])
  })

  it('a metadata-only setTitle patch yields an empty delta (no block touched)', async () => {
    const d = deps({ docPageStore: fakeDocPageStore(PAGE_TWO_BLOCKS) })
    const tool = createPatchPageTool(d)

    const res = await tool.execute(
      {
        pageId: PAGE_ID,
        expectedVersion: 1,
        ops: [{ op: 'setTitle' as const, title: 'Renamed' }],
      } as Parameters<typeof tool.execute>[0],
      ctx(),
    )

    expect(res.isError).toBeUndefined()
    const data = res.data as {
      kind: string
      changed: unknown[]
      removed: unknown[]
      outline?: unknown
    }
    expect(data.kind).toBe('doc_patch')
    expect(data.changed).toEqual([])
    expect(data.removed).toEqual([])
    expect(data.outline).toBeUndefined()
  })
})

describe('[COMP:doc/section-read] getSection / getBlockRange', () => {
  // h1 (L1) > [a1, a2, h2 (L2) > [b1]] ; then h3 (L1) > [c1]
  const STRUCTURED = {
    blocks: [
      { kind: 'heading', id: 'h1', level: 1, text: 'Alpha' },
      { kind: 'text', id: 'a1', text: 'a one' },
      { kind: 'text', id: 'a2', text: 'a two' },
      { kind: 'heading', id: 'h2', level: 2, text: 'Alpha sub' },
      { kind: 'text', id: 'b1', text: 'b one' },
      { kind: 'heading', id: 'h3', level: 1, text: 'Gamma' },
      { kind: 'text', id: 'c1', text: 'c one' },
    ],
  } as unknown as Page

  it('getSection returns the heading + its subtree (until the next same-or-higher heading)', async () => {
    const d = deps({ docPageStore: fakeDocPageStore(STRUCTURED) })
    const tool = createGetSectionTool(d)
    const res = await tool.execute(
      { pageId: PAGE_ID, headingId: 'h1' } as Parameters<typeof tool.execute>[0],
      ctx(),
    )
    expect(res.isError).toBeUndefined()
    const data = res.data as { kind: string; blocks: { id: string }[]; version: number }
    expect(data.kind).toBe('doc_section')
    // h1 owns a1, a2, the nested h2 (L2 > L1), and b1 — stops at h3 (L1).
    expect(data.blocks.map((b) => b.id)).toEqual(['h1', 'a1', 'a2', 'h2', 'b1'])
  })

  it('getSection on a nested heading stops at the next same-or-higher heading', async () => {
    const d = deps({ docPageStore: fakeDocPageStore(STRUCTURED) })
    const tool = createGetSectionTool(d)
    const res = await tool.execute(
      { pageId: PAGE_ID, headingId: 'h2' } as Parameters<typeof tool.execute>[0],
      ctx(),
    )
    const data = res.data as { blocks: { id: string }[] }
    expect(data.blocks.map((b) => b.id)).toEqual(['h2', 'b1'])
  })

  it('getSection errors when the id is not a heading', async () => {
    const d = deps({ docPageStore: fakeDocPageStore(STRUCTURED) })
    const tool = createGetSectionTool(d)
    const res = await tool.execute(
      { pageId: PAGE_ID, headingId: 'a1' } as Parameters<typeof tool.execute>[0],
      ctx(),
    )
    expect(res.isError).toBe(true)
    expect(String(res.data)).toMatch(/not a heading/)
  })

  it('getBlockRange returns the inclusive span in document order', async () => {
    const d = deps({ docPageStore: fakeDocPageStore(STRUCTURED) })
    const tool = createGetBlockRangeTool(d)
    const res = await tool.execute(
      { pageId: PAGE_ID, fromBlockId: 'a1', toBlockId: 'b1' } as Parameters<typeof tool.execute>[0],
      ctx(),
    )
    expect(res.isError).toBeUndefined()
    const data = res.data as { kind: string; blocks: { id: string }[] }
    expect(data.kind).toBe('doc_block_range')
    expect(data.blocks.map((b) => b.id)).toEqual(['a1', 'a2', 'h2', 'b1'])
  })

  it('getBlockRange errors when endpoints are reversed', async () => {
    const d = deps({ docPageStore: fakeDocPageStore(STRUCTURED) })
    const tool = createGetBlockRangeTool(d)
    const res = await tool.execute(
      { pageId: PAGE_ID, fromBlockId: 'b1', toBlockId: 'a1' } as Parameters<typeof tool.execute>[0],
      ctx(),
    )
    expect(res.isError).toBe(true)
    expect(String(res.data)).toMatch(/document order/)
  })

  it('getBlockRange errors when an endpoint is missing', async () => {
    const d = deps({ docPageStore: fakeDocPageStore(STRUCTURED) })
    const tool = createGetBlockRangeTool(d)
    const res = await tool.execute(
      { pageId: PAGE_ID, fromBlockId: 'ghost', toBlockId: 'a1' } as Parameters<typeof tool.execute>[0],
      ctx(),
    )
    expect(res.isError).toBe(true)
  })
})

describe('[COMP:doc/tools] getCurrentPage fields projection', () => {
  const PAGE_ONE = {
    blocks: [{ kind: 'text', id: 'b1', text: 'hi' }],
  } as unknown as Page

  it('defaults to outline-only (omits the expensive full-page JSON)', async () => {
    const d = deps({ docPageStore: fakeDocPageStore(PAGE_ONE) })
    const tool = createGetCurrentPageTool(d)

    const res = await tool.execute(
      { pageId: PAGE_ID } as Parameters<typeof tool.execute>[0],
      ctx(),
    )

    expect(res.isError).toBeUndefined()
    const data = res.data as {
      kind: string
      outline: unknown
      version: number
      page?: unknown
    }
    expect(data.kind).toBe('doc_current_page')
    expect(data.outline).toBeDefined()
    expect(data.version).toBe(1)
    expect(data.page).toBeUndefined()
  })

  it('returns the full page only when fields: "full"', async () => {
    const d = deps({ docPageStore: fakeDocPageStore(PAGE_ONE) })
    const tool = createGetCurrentPageTool(d)

    const res = await tool.execute(
      { pageId: PAGE_ID, fields: 'full' } as Parameters<typeof tool.execute>[0],
      ctx(),
    )

    const data = res.data as { page?: { blocks: unknown[] }; outline: unknown }
    expect(data.page).toBeDefined()
    expect(data.page!.blocks).toHaveLength(1)
    expect(data.outline).toBeDefined()
  })
})
