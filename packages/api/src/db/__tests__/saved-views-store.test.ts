/**
 * [COMP:api/saved-views-store] Saved-views store — Notion-redesign extensions.
 *
 * Mocks the pg client and verifies that the new page/state methods emit
 * the expected SQL shape + parameters.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import { createDbSavedViewStore } from '../saved-views-store.js'
import { query, queryWithRLS } from '../client.js'

const mockQuery = vi.mocked(query)
const mockQueryWithRLS = vi.mocked(queryWithRLS)

const USER_ID = '00000000-0000-0000-0000-000000000001'
const VIEW_ID = '00000000-0000-0000-0000-000000000002'
const WORKSPACE_ID = '00000000-0000-0000-0000-000000000003'

beforeEach(() => {
  vi.clearAllMocks()
})

const store = createDbSavedViewStore()

describe('[COMP:api/saved-views-store] page methods', () => {
  it('getPage returns the page JSON', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [{ page: { blocks: [{ kind: 'divider', id: 'b1' }] } }],
      rowCount: 1,
    } as never)
    const page = await store.getPage(USER_ID, VIEW_ID)
    expect(page).toEqual({ blocks: [{ kind: 'divider', id: 'b1' }] })
    const [, , params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(params).toEqual([VIEW_ID])
  })

  it('getPage returns null when row is missing', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.getPage(USER_ID, VIEW_ID)).toBeNull()
  })

  it('updatePage emits an UPDATE with stringified page', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ id: VIEW_ID }], rowCount: 1 } as never)
    const ok = await store.updatePage(USER_ID, VIEW_ID, { blocks: [] })
    expect(ok).toBe(true)
    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain('UPDATE saved_views SET page')
    expect(params).toEqual([JSON.stringify({ blocks: [] }), VIEW_ID])
  })

  it('updatePage returns false when row is hidden / missing', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.updatePage(USER_ID, VIEW_ID, { blocks: [] })).toBe(false)
  })

  it('setState updates the state column', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ id: VIEW_ID }], rowCount: 1 } as never)
    const ok = await store.setState(USER_ID, VIEW_ID, 'saved')
    expect(ok).toBe(true)
    const [, , params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(params).toEqual(['saved', VIEW_ID])
  })

  it('setAutoPruneAt passes through null to clear', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ id: VIEW_ID }], rowCount: 1 } as never)
    await store.setAutoPruneAt(USER_ID, VIEW_ID, null)
    const [, , params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(params).toEqual([null, VIEW_ID])
  })

  it('setAutoPruneAt passes a Date for scheduled prune', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ id: VIEW_ID }], rowCount: 1 } as never)
    const when = new Date('2026-06-25T00:00:00Z')
    await store.setAutoPruneAt(USER_ID, VIEW_ID, when)
    const [, , params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(params).toEqual([when, VIEW_ID])
  })
})

describe('[COMP:api/saved-views-store] createDraft', () => {
  it('inserts with state=draft and a 30-day default auto-prune', async () => {
    const now = new Date('2026-05-26T00:00:00Z')
    vi.setSystemTime(now)
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [{
        id: VIEW_ID,
        workspaceId: WORKSPACE_ID,
        createdBy: USER_ID,
        name: 'Untitled',
        description: null,
        entity: 'tasks',
        viewType: 'table',
        binding: { entity: 'tasks', viewType: 'table' },
        page: { blocks: [] },
        state: 'draft',
        autoPruneAt: new Date('2026-06-25T00:00:00Z'),
        createdAt: now,
        updatedAt: now,
      }],
      rowCount: 1,
    } as never)
    const created = await store.createDraft({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      name: 'Untitled',
      entity: 'tasks',
      viewType: 'table',
      binding: { entity: 'tasks', viewType: 'table' },
      page: { blocks: [] },
    })
    expect(created.state).toBe('draft')
    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain("'draft'")
    expect(params[0]).toBe(WORKSPACE_ID)
    // Trailing params (mig 279 + 283 + 313): auto_prune_at ($12), anchor_key
    // ($13, null on this non-workflow path), created_event_pending ($14, false
    // on this direct store call — only the interactive /views/draft route
    // defers), then the teamspace tri-state pair — explicit flag ($15, false =
    // let the SQL CASE inherit/default) + teamspace id ($16, null).
    expect(params[params.length - 1]).toBeNull()
    expect(params[params.length - 2]).toBe(false)
    expect(params[params.length - 3]).toBe(false)
    expect(params[params.length - 4]).toBeNull()
    const when = params[params.length - 5] as Date
    expect(when.getTime() - now.getTime()).toBe(30 * 24 * 60 * 60 * 1000)
    vi.useRealTimers()
  })

  it('respects custom autoPruneDays', async () => {
    const now = new Date('2026-05-26T00:00:00Z')
    vi.setSystemTime(now)
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [{
        id: VIEW_ID,
        workspaceId: WORKSPACE_ID,
        createdBy: USER_ID,
        name: 'X',
        description: null,
        entity: 'tasks',
        viewType: 'table',
        binding: { entity: 'tasks', viewType: 'table' },
        page: { blocks: [] },
        state: 'draft',
        autoPruneAt: new Date('2026-05-27T00:00:00Z'),
        createdAt: now,
        updatedAt: now,
      }],
      rowCount: 1,
    } as never)
    await store.createDraft({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      name: 'X',
      entity: 'tasks',
      viewType: 'table',
      binding: { entity: 'tasks', viewType: 'table' },
      page: { blocks: [] },
      autoPruneDays: 1,
    })
    const [, , params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    // Trailing params: auto_prune_at ($12), anchor_key ($13),
    // created_event_pending ($14), teamspace flag ($15) + id ($16).
    const when = params[params.length - 5] as Date
    expect(when.getTime() - now.getTime()).toBe(24 * 60 * 60 * 1000)
    vi.useRealTimers()
  })

  it('threads anchorKey to the trailing param + anchor_key column for per-workflow reuse (mig 279)', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [{
        id: VIEW_ID, workspaceId: WORKSPACE_ID, createdBy: USER_ID, name: 'Log',
        description: null, entity: 'tasks', viewType: 'table',
        binding: { entity: 'tasks', viewType: 'table' }, page: { blocks: [] },
        state: 'draft', autoPruneAt: new Date('2026-06-25T00:00:00Z'),
        createdAt: new Date(), updatedAt: new Date(),
      }],
      rowCount: 1,
    } as never)
    await store.createDraft({
      userId: USER_ID, workspaceId: WORKSPACE_ID, name: 'Log',
      entity: 'tasks', viewType: 'table',
      binding: { entity: 'tasks', viewType: 'table' },
      page: { blocks: [] },
      anchorKey: 'wf-1:s1',
    })
    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain('anchor_key')
    // anchor_key is $13 — ahead of created_event_pending ($14) and the
    // teamspace pair ($15/$16).
    expect(params[params.length - 4]).toBe('wf-1:s1')
  })

  it('threads an explicit teamspace placement to the trailing param pair (mig 313)', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [{
        id: VIEW_ID, workspaceId: WORKSPACE_ID, createdBy: USER_ID, name: 'Note',
        description: null, entity: 'tasks', viewType: 'table',
        binding: { entity: 'tasks', viewType: 'table' }, page: { blocks: [] },
        state: 'draft', autoPruneAt: new Date('2026-06-25T00:00:00Z'),
        createdAt: new Date(), updatedAt: new Date(),
      }],
      rowCount: 1,
    } as never)
    await store.createDraft({
      userId: USER_ID, workspaceId: WORKSPACE_ID, name: 'Note',
      entity: 'tasks', viewType: 'table',
      binding: { entity: 'tasks', viewType: 'table' },
      page: { blocks: [] },
      // Explicit private placement (the Private section's create) — the flag
      // must flip true so the SQL CASE takes the explicit NULL rather than
      // falling through to the General default.
      teamspaceId: null,
    })
    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain('teamspace_id')
    expect(params[params.length - 2]).toBe(true)
    expect(params[params.length - 1]).toBeNull()
  })

  it('findIdByAnchorKey resolves a page id by (workspace, anchor_key), RLS-scoped (mig 279)', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ id: VIEW_ID }], rowCount: 1 } as never)
    const id = await store.findIdByAnchorKey(USER_ID, WORKSPACE_ID, 'wf-1:s1')
    const [userId, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(userId).toBe(USER_ID)
    expect(sql).toContain('WHERE workspace_id = $1 AND anchor_key = $2')
    expect(params).toEqual([WORKSPACE_ID, 'wf-1:s1'])
    expect(id).toBe(VIEW_ID)
  })

  it('findIdByAnchorKey returns null when no page carries the key (mig 279)', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.findIdByAnchorKey(USER_ID, WORKSPACE_ID, 'wf-1:nope')).toBeNull()
  })

  it('inserts an explicit page icon (migration 211)', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [{
        id: VIEW_ID,
        workspaceId: WORKSPACE_ID,
        createdBy: USER_ID,
        name: 'Jeju Trip',
        nameOrigin: 'user',
        description: null,
        icon: '🌋',
        entity: 'tasks',
        viewType: 'table',
        binding: { entity: 'tasks', viewType: 'table' },
        page: { blocks: [] },
        state: 'draft',
        autoPruneAt: new Date('2026-06-25T00:00:00Z'),
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
      rowCount: 1,
    } as never)
    const created = await store.createDraft({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      name: 'Jeju Trip',
      nameOrigin: 'user',
      icon: '🌋',
      entity: 'tasks',
      viewType: 'table',
      binding: { entity: 'tasks', viewType: 'table' },
      page: { blocks: [] },
    })
    expect(created.icon).toBe('🌋')
    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain('icon')
    // VALUES order: …, nest_parent_id ($9), icon ($10), auto_prune_at ($11).
    expect(params[9]).toBe('🌋')
  })

  it('defaults icon to null when the caller passes none', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [{
        id: VIEW_ID,
        workspaceId: WORKSPACE_ID,
        createdBy: USER_ID,
        name: 'X',
        nameOrigin: 'placeholder',
        description: null,
        icon: null,
        entity: 'tasks',
        viewType: 'table',
        binding: { entity: 'tasks', viewType: 'table' },
        page: { blocks: [] },
        state: 'draft',
        autoPruneAt: new Date('2026-06-25T00:00:00Z'),
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
      rowCount: 1,
    } as never)
    await store.createDraft({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      name: 'X',
      entity: 'tasks',
      viewType: 'table',
      binding: { entity: 'tasks', viewType: 'table' },
      page: { blocks: [] },
    })
    const [, , params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(params[9]).toBeNull()
  })
})

describe('[COMP:api/saved-views-store] name_origin (auto-title)', () => {
  it('createDraft defaults name_origin to placeholder', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ id: VIEW_ID }], rowCount: 1 } as never)
    await store.createDraft({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      name: 'Untitled — draft',
      entity: 'tasks',
      viewType: 'table',
      binding: { entity: 'tasks', viewType: 'table' },
      page: { blocks: [] },
    })
    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain('name_origin')
    // VALUES order: workspaceId, createdBy, name, name_origin, …
    expect(params[3]).toBe('placeholder')
  })

  it('createDraft honors an explicit name_origin = user', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ id: VIEW_ID }], rowCount: 1 } as never)
    await store.createDraft({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      name: 'My Page',
      nameOrigin: 'user',
      entity: 'tasks',
      viewType: 'table',
      binding: { entity: 'tasks', viewType: 'table' },
      page: { blocks: [] },
    })
    const [, , params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(params[3]).toBe('user')
  })

  it('update writes name_origin when provided', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ id: VIEW_ID }], rowCount: 1 } as never)
    await store.update(USER_ID, VIEW_ID, { name: 'Renamed', nameOrigin: 'user' })
    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain('name_origin =')
    expect(params).toContain('user')
  })

  it('setAutoTitle commits the title + flips placeholder→auto via a guarded UPDATE', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [{ name: 'Generated Title', icon: null }],
      rowCount: 1,
    } as never)
    const result = await store.setAutoTitle(USER_ID, VIEW_ID, 'Generated Title')
    expect(result).toEqual({ name: 'Generated Title', icon: null })
    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain("name_origin = 'auto'")
    expect(sql).toContain("name_origin = 'placeholder'")
    // icon is COALESCE'd so a user-chosen emoji is never clobbered.
    expect(sql).toContain('icon = COALESCE(icon')
    // No suggested icon → the third param is null.
    expect(params).toEqual([VIEW_ID, 'Generated Title', null])
  })

  it('setAutoTitle fills the suggested emoji and returns it', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [{ name: 'Generated Title', icon: '📈' }],
      rowCount: 1,
    } as never)
    const result = await store.setAutoTitle(USER_ID, VIEW_ID, 'Generated Title', '📈')
    expect(result).toEqual({ name: 'Generated Title', icon: '📈' })
    const [, , params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(params).toEqual([VIEW_ID, 'Generated Title', '📈'])
  })

  it('setAutoTitle returns null when the guard no-ops (row already touched)', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.setAutoTitle(USER_ID, VIEW_ID, 'X')).toBeNull()
  })
})

describe('[COMP:api/saved-views-store] pruneExpiredDraftsSystem', () => {
  it('runs a system-bypass DELETE and returns the ids', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'v1' }, { id: 'v2' }],
      rowCount: 2,
    } as never)
    const ids = await store.pruneExpiredDraftsSystem()
    expect(ids).toEqual(['v1', 'v2'])
    const [sql] = mockQuery.mock.calls[0] as [string]
    expect(sql).toContain('DELETE FROM saved_views')
    expect(sql).toContain("state = 'draft'")
    expect(sql).toContain('auto_prune_at < now()')
  })

  it('spares expired drafts that have a saved ancestor (kept by ancestry)', async () => {
    // The delete must exclude candidates whose nest_parent_id chain reaches a
    // saved page — climbed via a depth-capped recursive CTE so a child filed
    // inside a Favorites subtree is never pruned. Mirrors the client-side
    // `savedAncestorIds` rule.
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await store.pruneExpiredDraftsSystem()
    const [sql] = mockQuery.mock.calls[0] as [string]
    expect(sql).toContain('WITH RECURSIVE')
    // Walks ancestors and keeps any candidate with a saved ancestor.
    expect(sql).toContain("ancestor_state = 'saved'")
    // Depth cap so a corrupt parent cycle still terminates.
    expect(sql).toContain('a.depth < 100')
    // Kept candidates are excluded from the delete set.
    expect(sql).toContain('NOT IN (SELECT candidate_id FROM kept)')
  })
})

describe('[COMP:api/saved-views-store] list filters', () => {
  it('defaults to state=saved', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await store.list({ userId: USER_ID, workspaceId: WORKSPACE_ID })
    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain('AND state =')
    // Expect: workspaceId, 'saved', limit.
    expect(params).toEqual([WORKSPACE_ID, 'saved', 100])
  })

  it("state='all' omits the state predicate", async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await store.list({ userId: USER_ID, workspaceId: WORKSPACE_ID, state: 'all' })
    const [, sql] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).not.toContain('AND state =')
  })

  it("state='draft' filters to drafts", async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await store.list({ userId: USER_ID, workspaceId: WORKSPACE_ID, state: 'draft' })
    const [, , params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(params).toContain('draft')
  })
})

describe('[COMP:api/saved-views-store] page-lifecycle emit (writtenBy → isSystem)', () => {
  const ROW = {
    id: VIEW_ID,
    workspaceId: WORKSPACE_ID,
    createdBy: USER_ID,
    name: 'Spec',
    nameOrigin: 'user',
    description: null,
    icon: null,
    entity: 'tasks',
    viewType: 'table',
    binding: { entity: 'tasks', viewType: 'table' },
    page: { blocks: [] },
    state: 'draft',
    nestParentId: null,
    position: 0,
    autoPruneAt: new Date('2026-06-25T00:00:00Z'),
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  const draftArgs = {
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    name: 'Spec',
    entity: 'tasks' as const,
    viewType: 'table' as const,
    binding: { entity: 'tasks' as const, viewType: 'table' as const },
    page: { blocks: [] },
  }

  it('defaults to a human write (isSystem=false) when writtenBy is omitted', async () => {
    const onPageLifecycle = vi.fn()
    const s = createDbSavedViewStore({ onPageLifecycle })
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [ROW], rowCount: 1 } as never)
    await s.createDraft(draftArgs)
    expect(onPageLifecycle).toHaveBeenCalledTimes(1)
    expect(onPageLifecycle.mock.calls[0][0]).toMatchObject({
      action: 'created',
      isSystem: false,
    })
  })

  it("marks isSystem=true when writtenBy: 'system' (the page self-loop guard)", async () => {
    const onPageLifecycle = vi.fn()
    const s = createDbSavedViewStore({ onPageLifecycle })
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [ROW], rowCount: 1 } as never)
    await s.createDraft({ ...draftArgs, writtenBy: 'system' })
    expect(onPageLifecycle.mock.calls[0][0]).toMatchObject({
      action: 'created',
      isSystem: true,
    })
  })

  it("update threads writtenBy: 'system' to the emitted event", async () => {
    const onPageLifecycle = vi.fn()
    const s = createDbSavedViewStore({ onPageLifecycle })
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [ROW], rowCount: 1 } as never)
    await s.update(USER_ID, VIEW_ID, { name: 'Renamed' }, 'system')
    expect(onPageLifecycle.mock.calls[0][0]).toMatchObject({
      action: 'updated',
      isSystem: true,
    })
  })

  // ── Deferred `created` (interactive drafts) — migration 283 ──────────

  it('deferCreatedEvent skips the immediate emit and marks the row pending', async () => {
    const onPageLifecycle = vi.fn()
    const s = createDbSavedViewStore({ onPageLifecycle })
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [{ ...ROW, createdEventPending: true }],
      rowCount: 1,
    } as never)
    await s.createDraft({ ...draftArgs, deferCreatedEvent: true })
    // No `created` fires at creation — the client commits it later.
    expect(onPageLifecycle).not.toHaveBeenCalled()
    // The defer flag rides the $14 INSERT param (ahead of the mig-313
    // teamspace pair $15/$16).
    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain('created_event_pending')
    expect(params[params.length - 3]).toBe(true)
  })

  it('commitCreatedEvent emits `created` once when it wins the flip', async () => {
    const onPageLifecycle = vi.fn()
    const s = createDbSavedViewStore({ onPageLifecycle })
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [{ ...ROW, nestParentId: 'parent-1' }],
      rowCount: 1,
    } as never)
    const fired = await s.commitCreatedEvent(USER_ID, VIEW_ID)
    expect(fired).toBe(true)
    // Guarded UPDATE: only flips a still-pending row.
    const [, sql] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain('created_event_pending = false')
    expect(sql).toContain('created_event_pending = true')
    expect(onPageLifecycle).toHaveBeenCalledTimes(1)
    expect(onPageLifecycle.mock.calls[0][0]).toMatchObject({
      action: 'created',
      parentId: 'parent-1',
      // Interactive-only path → always a human write, fires default subscriptions.
      isSystem: false,
    })
  })

  it('commitCreatedEvent is a no-op when the row is already committed / hidden', async () => {
    const onPageLifecycle = vi.fn()
    const s = createDbSavedViewStore({ onPageLifecycle })
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    const fired = await s.commitCreatedEvent(USER_ID, VIEW_ID)
    expect(fired).toBe(false)
    expect(onPageLifecycle).not.toHaveBeenCalled()
  })
})
