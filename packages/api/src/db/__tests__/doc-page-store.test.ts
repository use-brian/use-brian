/**
 * [COMP:api/doc-page-store] Doc page store — Phase 1 Batch 2.
 *
 * Mocks the pg client and verifies the versioned-read + atomic-CAS write
 * paths emit the expected SQL shape + parameters.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import { createDbDocPageStore } from '../doc-page-store.js'
import { queryWithRLS } from '../client.js'
import type { Page, UndoEntry } from '@sidanclaw/core'

const mockQueryWithRLS = vi.mocked(queryWithRLS)

const USER_ID = '00000000-0000-0000-0000-000000000001'
const PAGE_ID = '00000000-0000-0000-0000-000000000002'

const SAMPLE_PAGE: Page = {
  blocks: [
    { kind: 'heading', id: 'b1', level: 1, text: 'Hello' },
    { kind: 'text', id: 'b2', text: 'World' },
  ],
}

const SAMPLE_UNDO: UndoEntry = {
  appliedAt: '2026-05-27T00:00:00.000Z',
  resultingVersion: 2,
  inverseOps: [{ op: 'delete', blockId: 'b2' }],
  idMap: {},
}

beforeEach(() => {
  vi.clearAllMocks()
})

const store = createDbDocPageStore()

describe('[COMP:api/doc-page-store] getVersionedPage', () => {
  it('returns page + version + title for a fresh row', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [
        {
          page: SAMPLE_PAGE,
          version: 1,
          name: 'My draft',
          nameOrigin: 'user',
          icon: '🌋',
        },
      ],
      rowCount: 1,
    } as never)

    const result = await store.getVersionedPage(USER_ID, PAGE_ID)

    expect(result).toEqual({
      page: SAMPLE_PAGE,
      version: 1,
      title: 'My draft',
      nameOrigin: 'user',
      icon: '🌋',
    })

    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    // Reads now prefer the live Yjs snapshot (documents) and fall
    // back to the legacy saved_views page columns via COALESCE. `name_origin`
    // (migration 218, auto-title) + `icon` (migration 211) are read straight
    // from saved_views; the latter seeds the `setIcon` op's undo capture.
    expect(sql).toContain('FROM saved_views sv')
    expect(sql).toContain('LEFT JOIN documents cd')
    expect(sql).toContain('sv.name_origin')
    expect(sql).toContain('sv.icon')
    expect(sql).toContain('WHERE sv.id = $1')
    expect(params).toEqual([PAGE_ID])
  })

  it('returns null when the row is missing or RLS-hidden', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.getVersionedPage(USER_ID, PAGE_ID)).toBeNull()
  })

  it('defaults title to "Untitled" when name is null', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [{ page: SAMPLE_PAGE, version: 3, name: null }],
      rowCount: 1,
    } as never)
    const result = await store.getVersionedPage(USER_ID, PAGE_ID)
    expect(result?.title).toBe('Untitled')
  })

  it('hands a pre-doc row back as an empty page (page JSONB is null)', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [{ page: null, version: 1, name: 'Legacy view', nameOrigin: null, icon: null }],
      rowCount: 1,
    } as never)
    const result = await store.getVersionedPage(USER_ID, PAGE_ID)
    expect(result).toEqual({
      page: { blocks: [] },
      version: 1,
      title: 'Legacy view',
      // A null name_origin (defensive — column is NOT NULL post-migration)
      // defaults to 'placeholder'.
      nameOrigin: 'placeholder',
      icon: null,
    })
  })
})

describe('[COMP:api/doc-page-store] applyPatch', () => {
  it('atomic CAS succeeds on matching version and returns the bumped value', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [{ version: 2 }],
      rowCount: 1,
    } as never)

    const result = await store.applyPatch({
      userId: USER_ID,
      pageId: PAGE_ID,
      expectedVersion: 1,
      nextPage: SAMPLE_PAGE,
      undo: SAMPLE_UNDO,
    })

    expect(result).toEqual({ newVersion: 2 })

    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain('UPDATE saved_views')
    expect(sql).toContain('SET page')
    expect(sql).toContain('version    = version + 1')
    expect(sql).toContain('last_undo  = $2::jsonb')
    expect(sql).toContain('WHERE id = $3')
    expect(sql).toContain('AND version = $4')
    expect(sql).toContain('RETURNING version')

    expect(JSON.parse(params[0] as string)).toEqual(SAMPLE_PAGE)
    expect(JSON.parse(params[1] as string)).toEqual(SAMPLE_UNDO)
    expect(params[2]).toBe(PAGE_ID)
    expect(params[3]).toBe(1)
  })

  it('returns null when the version check fails (0 rows affected)', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

    const result = await store.applyPatch({
      userId: USER_ID,
      pageId: PAGE_ID,
      expectedVersion: 1,
      nextPage: SAMPLE_PAGE,
      undo: SAMPLE_UNDO,
    })

    expect(result).toBeNull()
  })

  it('serialises the undo payload as JSONB', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [{ version: 5 }],
      rowCount: 1,
    } as never)
    const richUndo: UndoEntry = {
      appliedAt: '2026-05-27T12:00:00.000Z',
      resultingVersion: 5,
      inverseOps: [
        { op: 'add', after: 'start', block: { kind: 'divider', id: 'b3' } },
        { op: 'edit', blockId: 'b1', patch: { text: 'Old' } },
      ],
      idMap: { 'tmp-1': 'real-1' },
    }
    await store.applyPatch({
      userId: USER_ID,
      pageId: PAGE_ID,
      expectedVersion: 4,
      nextPage: SAMPLE_PAGE,
      undo: richUndo,
    })
    const [, , params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    const decoded = JSON.parse(params[1] as string)
    expect(decoded).toEqual(richUndo)
  })

  it('routes through queryWithRLS with the caller userId', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [{ version: 2 }],
      rowCount: 1,
    } as never)
    await store.applyPatch({
      userId: USER_ID,
      pageId: PAGE_ID,
      expectedVersion: 1,
      nextPage: SAMPLE_PAGE,
      undo: SAMPLE_UNDO,
    })
    expect(mockQueryWithRLS.mock.calls[0][0]).toBe(USER_ID)
  })
})
