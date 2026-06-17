/**
 * Unit tests for the workspace skill files store.
 * Component tag: [COMP:api/workspace-skill-files-store].
 *
 * Mocks `query` / `queryWithRLS`. Verifies the pointer-expansion contract
 * (getByPointer keyed on workspaceSkillId + kind + name), upsert against
 * the (workspace_skill_id, kind, name) UNIQUE, the kind filter, and the
 * dual system / RLS read paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import { createDbWorkspaceSkillFilesStore } from '../workspace-skill-files-store.js'
import { query, queryWithRLS } from '../client.js'

const mockQuery = vi.mocked(query)
const mockRls = vi.mocked(queryWithRLS)

function fileRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'f-1',
    workspaceSkillId: 'sk-1',
    kind: 'template',
    name: 'weekly-status.md',
    content: '# Weekly status',
    description: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...over,
  }
}

beforeEach(() => {
  mockQuery.mockReset()
  mockRls.mockReset()
})

const store = createDbWorkspaceSkillFilesStore()

describe('[COMP:api/workspace-skill-files-store] list', () => {
  it('uses query (system bypass) when no actingUserId', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [fileRow()], rowCount: 1 } as never)
    const out = await store.list('sk-1')
    expect(out[0].name).toBe('weekly-status.md')
    expect(mockQuery.mock.calls[0][1]).toEqual(['sk-1'])
  })

  it('uses queryWithRLS when actingUserId is provided', async () => {
    mockRls.mockResolvedValueOnce({ rows: [fileRow()], rowCount: 1 } as never)
    await store.list('sk-1', { actingUserId: 'u-1' })
    expect(mockRls.mock.calls[0][0]).toBe('u-1')
  })
})

describe('[COMP:api/workspace-skill-files-store] getByPointer — pointer expansion contract', () => {
  it('looks up by (workspaceSkillId, kind, name)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [fileRow()], rowCount: 1 } as never)
    const out = await store.getByPointer('sk-1', { kind: 'template', name: 'weekly-status.md' })
    expect(out?.kind).toBe('template')
    expect(mockQuery.mock.calls[0][1]).toEqual(['sk-1', 'template', 'weekly-status.md'])
  })

  it('returns null on miss', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(
      await store.getByPointer('sk-1', { kind: 'template', name: 'ghost.md' }),
    ).toBeNull()
  })
})

describe('[COMP:api/workspace-skill-files-store] upsert', () => {
  it('uses INSERT ... ON CONFLICT against the (skill, kind, name) UNIQUE', async () => {
    mockRls.mockResolvedValueOnce({ rows: [fileRow()], rowCount: 1 } as never)
    await store.upsert('u-1', {
      workspaceSkillId: 'sk-1',
      kind: 'template',
      name: 'weekly-status.md',
      content: 'body',
    })
    const sql = mockRls.mock.calls[0][1] as string
    expect(sql).toContain('ON CONFLICT (workspace_skill_id, kind, name) DO UPDATE')
  })

  it('passes null description when not supplied', async () => {
    mockRls.mockResolvedValueOnce({ rows: [fileRow()], rowCount: 1 } as never)
    await store.upsert('u-1', {
      workspaceSkillId: 'sk-1',
      kind: 'reference',
      name: 'index.md',
      content: 'body',
    })
    const params = mockRls.mock.calls[0][2]
    expect(params?.[4]).toBeNull()
  })
})

describe('[COMP:api/workspace-skill-files-store] delete + listByKind', () => {
  it('delete reports whether a row was removed', async () => {
    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    expect(await store.delete('u-1', 'sk-1', 'template', 'weekly-status.md')).toBe(true)
    mockRls.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.delete('u-1', 'sk-1', 'template', 'ghost.md')).toBe(false)
  })

  it('listByKind filters on the kind column', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [fileRow({ kind: 'script' })], rowCount: 1 } as never)
    const out = await store.listByKind('sk-1', 'script')
    expect(out[0].kind).toBe('script')
    expect(mockQuery.mock.calls[0][1]).toEqual(['sk-1', 'script'])
  })
})
