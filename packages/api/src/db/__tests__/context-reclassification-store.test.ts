import { beforeEach, describe, expect, it, vi } from 'vitest'
import { queryWithRLS } from '../client.js'
import {
  classifyScopeChange,
  createDbContextReclassificationStore,
} from '../context-reclassification-store.js'

const db = vi.hoisted(() => ({
  queryWithRLS: vi.fn(),
  clientQuery: vi.fn(),
  connect: vi.fn(),
  rollbackAndRelease: vi.fn(),
}))

vi.mock('../client.js', () => ({
  queryWithRLS: db.queryWithRLS,
  applyRLSGucs: vi.fn(),
  getAppPool: () => ({ connect: db.connect }),
  rollbackAndRelease: db.rollbackAndRelease,
}))

describe('[COMP:brain/context-reclassification] scope change audit', () => {
  beforeEach(() => {
    vi.mocked(queryWithRLS).mockReset()
    db.clientQuery.mockReset()
    db.connect.mockReset()
    db.rollbackAndRelease.mockReset()
    db.connect.mockResolvedValue({ query: db.clientQuery })
  })

  it('classifies Team removal and Project-to-General as widening', () => {
    expect(classifyScopeChange(
      { compartments: ['sales', 'finance'], projectIds: [] },
      { compartments: ['sales'], projectIds: [] },
    )).toBe('widening')
    expect(classifyScopeChange(
      { compartments: [], projectIds: ['p-1'] },
      { compartments: [], projectIds: [] },
    )).toBe('widening')
  })

  it('classifies Project A to B as lateral and General to A as narrowing', () => {
    expect(classifyScopeChange(
      { compartments: [], projectIds: ['p-1'] },
      { compartments: [], projectIds: ['p-2'] },
    )).toBe('lateral')
    expect(classifyScopeChange(
      { compartments: [], projectIds: [] },
      { compartments: [], projectIds: ['p-1'] },
    )).toBe('narrowing')
  })

  it('requires a real change and a reason', async () => {
    const store = createDbContextReclassificationStore()
    await expect(store.append('u-1', {
      workspaceId: 'w-1',
      primitive: 'memory',
      rowId: 'm-1',
      previous: { compartments: [], projectIds: [] },
      next: { compartments: [], projectIds: [] },
      reason: 'none',
    })).rejects.toThrow('context_scope_unchanged')
    await expect(store.append('u-1', {
      workspaceId: 'w-1',
      primitive: 'memory',
      rowId: 'm-1',
      previous: { compartments: [], projectIds: [] },
      next: { compartments: ['team:sales'], projectIds: [] },
      reason: '  ',
    })).rejects.toThrow('context_scope_reason_required')
  })

  it('preserves non-Team compartment requirements in both the row and audit', async () => {
    const createdAt = new Date('2026-08-26T00:00:00.000Z')
    db.clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({
        rows: [{ role: 'admin', grant: null, clearance: 'confidential' }],
      })
      .mockResolvedValueOnce({ rows: [{ compartmentKey: 'team:new' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ compartments: ['legacy:partner', 'team:old'], projectIds: [] }],
      })
      .mockResolvedValueOnce({ rows: [{ key: 'team:old' }, { key: 'team:new' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'audit-1', createdAt }] })
      .mockResolvedValueOnce({ rows: [] }) // COMMIT

    const event = await createDbContextReclassificationStore().reclassify('user-1', {
      workspaceId: 'workspace-1',
      primitive: 'memory',
      rowId: 'memory-1',
      teamIds: ['team-id-new'],
      projectIds: [],
      reason: 'Move the assertion to the current Team',
      confirmed: true,
    })

    const update = db.clientQuery.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('UPDATE memories'),
    )
    expect(update?.[1]).toEqual([
      ['legacy:partner', 'team:new'],
      [],
      'memory-1',
      'workspace-1',
    ])
    expect(event.next.compartments).toEqual(['legacy:partner', 'team:new'])
    expect(event.kind).toBe('widening')
  })

  it('reads scope requirements only through sensitivity and effective-Team gates', async () => {
    db.queryWithRLS.mockResolvedValue({
      rows: [{ compartments: ['team:allowed'], projectIds: ['project-1'] }],
    })

    const requirements = await createDbContextReclassificationStore().getRequirements('user-1', {
      workspaceId: 'workspace-1',
      primitive: 'file',
      rowId: 'file-1',
    })

    expect(requirements).toEqual({ compartments: ['team:allowed'], projectIds: ['project-1'] })
    const [rlsUserId, sql, values] = db.queryWithRLS.mock.calls[0]
    expect(rlsUserId).toBe('user-1')
    expect(sql).toContain('sensitivity_rank(r.sensitivity)')
    expect(sql).toContain('effective_member_team_compartments')
    expect(values).toEqual(['file-1', 'user-1', 'workspace-1'])
  })
})
