/**
 * [COMP:api/page-templates-store] Custom page-templates store (migration 281).
 *
 * Mocks the pg client and verifies the SQL shape + params for each method and
 * the row → `CustomPageTemplate` mapping. Workspace-shared RLS isolation is
 * enforced by the `workspace_page_templates_workspace_member` policy at the DB
 * layer (the userId threaded into `queryWithRLS` is the principal); the
 * isolation itself is exercised by the integration harness, not this unit.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import { createDbPageTemplateStore } from '../page-templates-store.js'
import { queryWithRLS } from '../client.js'

const mockQueryWithRLS = vi.mocked(queryWithRLS)

const USER_ID = '00000000-0000-0000-0000-000000000001'
const WORKSPACE_ID = '00000000-0000-0000-0000-000000000003'
const TEMPLATE_ID = '00000000-0000-0000-0000-000000000009'
const NOW = new Date('2026-01-02T03:04:05.000Z')

beforeEach(() => {
  vi.clearAllMocks()
})

const store = createDbPageTemplateStore()

function summaryRow(over: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE_ID,
    workspace_id: WORKSPACE_ID,
    created_by: USER_ID,
    name: 'Sprint plan',
    description: 'two-week sprint',
    icon: '🏃',
    category: 'planning',
    created_at: NOW,
    updated_at: NOW,
    ...over,
  }
}

describe('[COMP:api/page-templates-store] page-templates store', () => {
  it('list selects summaries (no blocks) ordered by recency, scoped to the workspace', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [summaryRow()], rowCount: 1 } as never)
    const rows = await store.list(USER_ID, WORKSPACE_ID)
    const [user, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(user).toBe(USER_ID)
    expect(sql).toContain('FROM workspace_page_templates')
    expect(sql).not.toContain('blocks') // summary projection omits the heavy column
    expect(sql).toContain('ORDER BY updated_at DESC')
    expect(params).toEqual([WORKSPACE_ID])
    expect(rows[0]).toEqual({
      id: TEMPLATE_ID,
      workspaceId: WORKSPACE_ID,
      createdBy: USER_ID,
      name: 'Sprint plan',
      description: 'two-week sprint',
      icon: '🏃',
      category: 'planning',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
  })

  it('getById returns the full template with blocks, or null when missing', async () => {
    const blocks = [{ kind: 'heading', id: 'b1', level: 1, text: 'Sprint' }]
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [summaryRow({ blocks })], rowCount: 1 } as never)
    const tpl = await store.getById(USER_ID, TEMPLATE_ID)
    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain('blocks')
    expect(params).toEqual([TEMPLATE_ID])
    expect(tpl?.blocks).toEqual(blocks)

    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.getById(USER_ID, TEMPLATE_ID)).toBeNull()
  })

  it('create inserts the row + stringified blocks and returns the mapped record', async () => {
    const blocks = [{ kind: 'heading', id: 'b1', level: 1, text: 'Sprint' }]
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [summaryRow({ blocks })], rowCount: 1 } as never)
    const created = await store.create(USER_ID, {
      workspaceId: WORKSPACE_ID,
      name: 'Sprint plan',
      description: 'two-week sprint',
      icon: '🏃',
      category: 'planning',
      blocks: blocks as never,
    })
    const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain('INSERT INTO workspace_page_templates')
    expect(params).toEqual([
      WORKSPACE_ID,
      USER_ID,
      'Sprint plan',
      'two-week sprint',
      '🏃',
      'planning',
      JSON.stringify(blocks),
    ])
    expect(created.id).toBe(TEMPLATE_ID)
    expect(created.blocks).toEqual(blocks)
  })

  it('create coerces an absent description / icon to null', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({
      rows: [summaryRow({ description: null, icon: null, blocks: [] })],
      rowCount: 1,
    } as never)
    await store.create(USER_ID, {
      workspaceId: WORKSPACE_ID,
      name: 'No meta',
      category: 'team',
      blocks: [] as never,
    })
    const [, , params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(params[3]).toBeNull() // description
    expect(params[4]).toBeNull() // icon
  })

  it('remove returns true only when a row was deleted', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ id: TEMPLATE_ID }], rowCount: 1 } as never)
    expect(await store.remove(USER_ID, TEMPLATE_ID)).toBe(true)
    const [, sql] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
    expect(sql).toContain('DELETE FROM workspace_page_templates')

    mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.remove(USER_ID, TEMPLATE_ID)).toBe(false)
  })
})
