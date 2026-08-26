import { beforeEach, describe, expect, it, vi } from 'vitest'
import { queryWithRLS } from '../client.js'
import {
  classifyScopeChange,
  createDbContextReclassificationStore,
} from '../context-reclassification-store.js'

vi.mock('../client.js', () => ({ queryWithRLS: vi.fn() }))

describe('[COMP:brain/context-reclassification] scope change audit', () => {
  beforeEach(() => vi.mocked(queryWithRLS).mockReset())

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
})
