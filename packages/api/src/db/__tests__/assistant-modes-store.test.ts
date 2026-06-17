/**
 * Unit tests for the assistant-modes store.
 * Component tag: [COMP:api/assistant-modes-store].
 *
 * Mocks the bare `query` helper (the store deliberately bypasses RLS so
 * cross-workspace consult resolution can look up a mode by id). Verifies
 * createAssistantModesStore: the name-ordered list, the get row/null map,
 * create's column defaults (exposed_tools → [], freshness → 'live', the
 * boolean/null fallbacks), update's dynamic SET + no-field re-read, and
 * delete's rowCount boolean.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
}))

import { createAssistantModesStore } from '../assistant-modes-store.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)
const store = createAssistantModesStore()

function modeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'mode-1',
    assistantId: 'a-1',
    name: 'Sales digest',
    description: null,
    exposedTools: [],
    freshness: 'live',
    requireApproval: false,
    allowOnwardConsults: false,
    knowledgeMaxSensitivity: null,
    memoryCategories: null,
    createdAt: new Date('2026-05-16T00:00:00Z'),
    updatedAt: new Date('2026-05-16T00:00:00Z'),
    ...over,
  }
}

beforeEach(() => {
  mockQuery.mockReset()
})

describe('[COMP:api/assistant-modes-store] createAssistantModesStore', () => {
  it('list scopes to the assistant and orders by name', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [modeRow()], rowCount: 1 } as never)
    const out = await store.list('a-1')
    expect(out).toHaveLength(1)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('FROM assistant_modes')
    expect(sql).toContain('assistant_id = $1')
    expect(sql).toContain('ORDER BY name ASC')
    expect(params).toEqual(['a-1'])
  })

  it('get returns the row, or null when absent', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [modeRow()], rowCount: 1 } as never)
    expect((await store.get('mode-1'))?.id).toBe('mode-1')
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.get('ghost')).toBeNull()
  })

  it('create applies the column defaults for omitted optional fields', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [modeRow()], rowCount: 1 } as never)
    await store.create({ assistantId: 'a-1', name: 'Sales digest' })
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('INSERT INTO assistant_modes')
    expect(params).toEqual([
      'a-1', // assistant_id
      'Sales digest', // name
      null, // description
      [], // exposed_tools
      'live', // freshness
      false, // require_approval
      false, // allow_onward_consults
      null, // knowledge_max_sensitivity
      null, // memory_categories
    ])
  })

  it('create forwards explicitly supplied fields', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [modeRow()], rowCount: 1 } as never)
    await store.create({
      assistantId: 'a-1',
      name: 'Snapshot mode',
      description: 'curated bundle',
      exposedTools: ['search', 'getEntity'],
      freshness: 'snapshot',
      requireApproval: true,
      allowOnwardConsults: true,
      knowledgeMaxSensitivity: 'internal',
      memoryCategories: ['crm'],
    })
    const params = mockQuery.mock.calls[0][1]
    expect(params).toEqual([
      'a-1',
      'Snapshot mode',
      'curated bundle',
      ['search', 'getEntity'],
      'snapshot',
      true,
      true,
      'internal',
      ['crm'],
    ])
  })

  it('update builds a dynamic SET for the supplied fields and bumps updated_at', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [modeRow({ name: 'Renamed' })], rowCount: 1 } as never)
    const out = await store.update('mode-1', { name: 'Renamed', freshness: 'snapshot' })
    expect(out?.name).toBe('Renamed')
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('UPDATE assistant_modes SET')
    expect(sql).toContain('name = $2')
    expect(sql).toContain('freshness = $3')
    expect(sql).toContain('updated_at = now()')
    expect(sql).toContain('WHERE id = $1')
    expect(params).toEqual(['mode-1', 'Renamed', 'snapshot'])
  })

  it('update re-reads the current row when no fields are supplied', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [modeRow()], rowCount: 1 } as never)
    await store.update('mode-1', {})
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).not.toContain('UPDATE')
    expect(sql).toContain('SELECT')
    expect(params).toEqual(['mode-1'])
  })

  it('delete reports whether a row was removed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    expect(await store.delete('mode-1')).toBe(true)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.delete('ghost')).toBe(false)
  })
})
