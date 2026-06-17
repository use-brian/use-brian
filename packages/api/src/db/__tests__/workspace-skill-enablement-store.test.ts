/**
 * Unit tests for the workspace skill enablement store.
 * Component tag: [COMP:api/workspace-skill-enablement-store].
 *
 * Mocks `query` / `queryWithRLS`. Verifies the per-assistant filtering,
 * idempotent enable upsert, and the disable / disableAll mutations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import { createDbWorkspaceSkillEnablementStore } from '../workspace-skill-enablement-store.js'
import { query, queryWithRLS } from '../client.js'

const mockQuery = vi.mocked(query)
const mockRls = vi.mocked(queryWithRLS)

beforeEach(() => {
  mockQuery.mockReset()
  mockRls.mockReset()
})

const store = createDbWorkspaceSkillEnablementStore()

function enablementRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceSkillId: 'sk-1',
    assistantId: 'a-1',
    enabledAt: new Date('2026-01-01'),
    enabledByUserId: 'u-1',
    ...over,
  }
}

describe('[COMP:api/workspace-skill-enablement-store] listForAssistant', () => {
  it('filters rows by assistant_id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [enablementRow()], rowCount: 1 } as never)
    const out = await store.listForAssistant('a-1')
    expect(out[0].assistantId).toBe('a-1')
    expect(mockQuery.mock.calls[0][1]).toEqual(['a-1'])
  })

  it('routes through RLS when actingUserId is supplied', async () => {
    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await store.listForAssistant('a-1', { actingUserId: 'u-1' })
    expect(mockRls.mock.calls[0][0]).toBe('u-1')
  })
})

describe('[COMP:api/workspace-skill-enablement-store] isEnabled', () => {
  it('returns true when the (skill, assistant) pair exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 } as never)
    expect(await store.isEnabled('sk-1', 'a-1')).toBe(true)
  })

  it('returns false when missing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.isEnabled('sk-1', 'a-1')).toBe(false)
  })
})

describe('[COMP:api/workspace-skill-enablement-store] enable / disable / disableAll', () => {
  it('enable uses INSERT ... ON CONFLICT against the composite PK', async () => {
    mockRls.mockResolvedValueOnce({ rows: [enablementRow()], rowCount: 1 } as never)
    await store.enable('sk-1', 'a-1', 'u-1')
    const sql = mockRls.mock.calls[0][1] as string
    expect(sql).toContain('ON CONFLICT (workspace_skill_id, assistant_id) DO UPDATE')
    expect(mockRls.mock.calls[0][2]).toEqual(['sk-1', 'a-1', 'u-1'])
  })

  it('disable reports whether the row was deleted', async () => {
    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    expect(await store.disable('sk-1', 'a-1', 'u-1')).toBe(true)
    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.disable('sk-1', 'a-ghost', 'u-1')).toBe(false)
  })

  it('disableAll removes every enablement row for a skill (system-level)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 3 } as never)
    expect(await store.disableAll('sk-1')).toBe(3)
    expect(mockQuery.mock.calls[0][0]).toContain(
      'DELETE FROM workspace_skill_enablement WHERE workspace_skill_id = $1',
    )
  })
})
