/**
 * Pure-unit shape tests for brain-inbox-store. No DB required — these
 * catch the obvious "added a primitive to the BrainInboxPrimitive type
 * but forgot to handle it everywhere" mistake that breaks the inbox
 * detail page silently.
 *
 * Integration tests against actual migration 174 partial indexes are
 * still tracked as a gap in docs/workflow/component-map.md.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../client.js', () => ({
  applyRLSGucs: vi.fn(),
  getAppPool: vi.fn(),
  getPool: vi.fn(),
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import {
  countBrainInbox,
  getBrainInboxRow,
  listBrainInbox,
  primitiveToTable,
  type BrainInboxPrimitive,
} from '../brain-inbox-store.js'
import { queryWithRLS } from '../client.js'

const mockQueryWithRLS = vi.mocked(queryWithRLS)
const ACCESS = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  assistantId: '',
  assistantKind: 'primary' as const,
  clearance: 'internal' as const,
  compartments: ['Finance'],
  mutationCompartments: [],
  projectIds: ['33333333-3333-4333-8333-333333333333'],
}

beforeEach(() => {
  mockQueryWithRLS.mockReset()
  mockQueryWithRLS.mockResolvedValue({ rows: [], rowCount: 0 } as never)
})

const ALL_PRIMITIVES: BrainInboxPrimitive[] = [
  'memory',
  'entity',
  'entity_link',
  'task',
  'contact',
  'company',
  'deal',
  'workspace_file',
]

describe('[COMP:brain/inbox-store] BrainInboxPrimitive shape', () => {
  it('primitiveToTable returns a non-empty string for every primitive', () => {
    for (const p of ALL_PRIMITIVES) {
      const table = primitiveToTable(p)
      expect(table).toBeTypeOf('string')
      expect(table.length).toBeGreaterThan(0)
    }
  })

  it('primitiveToTable resolves to the expected per-primitive table', () => {
    expect(primitiveToTable('memory')).toBe('memories')
    expect(primitiveToTable('entity')).toBe('entities')
    expect(primitiveToTable('entity_link')).toBe('entity_links')
    expect(primitiveToTable('task')).toBe('tasks')
    // Post CRM→entity unification the CRM primitives resolve to `entities`.
    expect(primitiveToTable('contact')).toBe('entities')
    expect(primitiveToTable('company')).toBe('entities')
    expect(primitiveToTable('deal')).toBe('entities')
    expect(primitiveToTable('workspace_file')).toBe('workspace_files')
  })
})

describe('[COMP:brain/inbox-store] current-source operation scope', () => {
  it('uses the authenticated app-role projection for list and count with identical holding gates', async () => {
    await listBrainInbox({
      workspaceId: ACCESS.workspaceId,
      userId: ACCESS.userId,
      access: ACCESS,
    })
    await countBrainInbox({
      workspaceId: ACCESS.workspaceId,
      userId: ACCESS.userId,
      access: ACCESS,
    })

    expect(mockQueryWithRLS).toHaveBeenCalledTimes(2)
    for (const [actor, sql, params] of mockQueryWithRLS.mock.calls) {
      expect(actor).toBe(ACCESS.userId)
      expect(sql).toContain('NOT scope_held')
      expect(sql).toContain('compartments <@')
      expect(sql).toContain('project_ids <@')
      expect(params).toContainEqual(['Finance'])
      expect(params).toContainEqual(ACCESS.projectIds)
    }
  })

  it('uses mutation compartments for a write preflight instead of read-grant compartments', async () => {
    await getBrainInboxRow({
      workspaceId: ACCESS.workspaceId,
      userId: ACCESS.userId,
      primitive: 'task',
      rowId: '44444444-4444-4444-8444-444444444444',
      access: ACCESS,
      operation: 'mutation',
    })

    const [actor, sql, params] = mockQueryWithRLS.mock.calls[0]!
    expect(actor).toBe(ACCESS.userId)
    expect(sql).toContain('NOT scope_held')
    expect(params).toContainEqual([])
    expect(params).not.toContainEqual(['Finance'])
  })
})
