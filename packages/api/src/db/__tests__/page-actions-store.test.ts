import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import { createDbPageActionsStore } from '../page-actions-store.js'
import { queryWithRLS } from '../client.js'

const mockQueryWithRLS = vi.mocked(queryWithRLS)
const store = createDbPageActionsStore()

const ROW = {
  id: 'pa-1',
  workspace_id: 'ws-1',
  blueprint_id: 'bp-1',
  page_id: null,
  label: 'Send',
  icon: null,
  confirm_copy: null,
  action: { kind: 'workflow', workflowId: 'wf-1' },
  enabled: true,
  position: 0,
  created_by: 'u-1',
  created_at: new Date('2026-07-11T00:00:00Z'),
  updated_at: new Date('2026-07-11T00:00:00Z'),
}

beforeEach(() => {
  vi.clearAllMocks()
  mockQueryWithRLS.mockResolvedValue({ rows: [ROW] } as never)
})

describe('[COMP:api/page-actions-store] page actions store', () => {
  it('creates a blueprint-scoped binding and maps the row', async () => {
    const created = await store.create('u-1', {
      workspaceId: 'ws-1',
      blueprintId: 'bp-1',
      label: 'Send',
      action: { kind: 'workflow', workflowId: 'wf-1' },
    })
    expect(created).toMatchObject({ id: 'pa-1', blueprintId: 'bp-1', pageId: null, label: 'Send' })
    const params = mockQueryWithRLS.mock.calls[0][2] as unknown[]
    expect(params[0]).toBe('ws-1')
    expect(params[1]).toBe('bp-1')
    expect(params[2]).toBeNull()
    expect(params[8]).toBe('u-1')
  })

  it('resolveForPage unions page-scoped rows with blueprint-scoped rows via the record join', async () => {
    await store.resolveForPage('u-1', 'ws-1', 'page-1')
    const sql = mockQueryWithRLS.mock.calls[0][1] as string
    expect(sql).toContain('UNION ALL')
    expect(sql).toContain('JOIN blueprint_records br')
    expect(sql).toContain('br.page_id = $2')
    expect(mockQueryWithRLS.mock.calls[0][2]).toEqual(['ws-1', 'page-1'])
  })

  it('listForWorkflow filters on the action jsonb (the honesty read)', async () => {
    await store.listForWorkflow('u-1', 'ws-1', 'wf-1')
    const sql = mockQueryWithRLS.mock.calls[0][1] as string
    expect(sql).toContain("action->>'kind' = 'workflow'")
    expect(sql).toContain("action->>'workflowId' = $2")
  })

  it('update patches only provided fields (icon/confirmCopy honor explicit null)', async () => {
    await store.update('u-1', 'pa-1', { enabled: false, icon: null })
    const params = mockQueryWithRLS.mock.calls[0][2] as unknown[]
    // icon sentinel true (explicitly provided) with null value; confirm sentinel false.
    expect(params[2]).toBe(true)
    expect(params[3]).toBeNull()
    expect(params[4]).toBe(false)
    expect(params[7]).toBe(false)
  })

  it('delete returns whether a row was removed', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ id: 'pa-1' }] } as never)
    expect(await store.delete('u-1', 'pa-1')).toBe(true)
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [] } as never)
    expect(await store.delete('u-1', 'pa-2')).toBe(false)
  })
})
