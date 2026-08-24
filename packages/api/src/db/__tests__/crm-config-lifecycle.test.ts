/** Reversible CRM configuration invariants. [COMP:api/crm-config-http] */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const clientQuery = vi.fn()
  const release = vi.fn()
  return {
    clientQuery,
    release,
    connect: vi.fn(async () => ({ query: clientQuery, release })),
    queryWithRLS: vi.fn(),
  }
})

vi.mock('../client.js', () => ({
  applyRLSGucs: vi.fn(),
  getPool: vi.fn(() => ({ connect: mocks.connect })),
  query: vi.fn(),
  queryGated: vi.fn(),
  queryWithRLS: mocks.queryWithRLS,
}))
vi.mock('../entities-store.js', () => ({
  getEntityById: vi.fn(),
  updateEntity: vi.fn(),
}))

import {
  reorderCrmPipelines,
  restoreCrmFieldDefinition,
  setCrmStageArchived,
  updateCrmFieldDefinition,
  updateCrmPipeline,
} from '../crm-r2.js'

const base = { userId: 'user-1', workspaceId: 'workspace-1' }

describe('[COMP:api/crm-config-http] reversible CRM configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.clientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    mocks.queryWithRLS.mockReset()
  })

  it('rewrites a complete pipeline order to dense zero-based positions', async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM crm_pipelines')) {
        return { rows: [{ id: 'pipeline-a' }, { id: 'pipeline-b' }, { id: 'pipeline-c' }] }
      }
      return { rows: [], rowCount: 0 }
    })

    await reorderCrmPipelines({
      ...base,
      orderedIds: ['pipeline-c', 'pipeline-a', 'pipeline-b'],
    })

    const positionWrites = mocks.clientQuery.mock.calls.filter(([sql]) =>
      String(sql).includes('SET position = $3'))
    expect(positionWrites.map(([, values]) => values)).toEqual([
      ['pipeline-c', 'workspace-1', 0],
      ['pipeline-a', 'workspace-1', 1],
      ['pipeline-b', 'workspace-1', 2],
    ])
    expect(mocks.clientQuery.mock.calls.at(-1)?.[0]).toBe('COMMIT')
  })

  it('blocks default-pipeline archive and a stage referenced by live deals', async () => {
    mocks.clientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    mocks.clientQuery.mockResolvedValueOnce({ rows: [{ isDefault: true, archivedAt: null }] })
    await expect(updateCrmPipeline({
      ...base, pipelineId: 'pipeline-default', archived: true,
    })).rejects.toThrow('default pipeline')
    expect(mocks.clientQuery.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true)

    vi.clearAllMocks()
    mocks.clientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    mocks.clientQuery.mockResolvedValueOnce({ rows: [{ pipelineId: 'pipeline-a', archivedAt: null }] })
    mocks.clientQuery.mockResolvedValueOnce({ rows: [{ count: '2' }] })
    await expect(setCrmStageArchived({
      ...base, stageId: 'stage-used', archived: true,
    })).rejects.toThrow('Move 2 live deals')
  })

  it('rejects removal of a select option still used by live records', async () => {
    mocks.queryWithRLS
      .mockResolvedValueOnce({ rows: [{
        id: 'field-1', entityKind: 'deal', fieldKey: 'tier', label: 'Tier',
        fieldType: 'single_select', options: ['A', 'B'], isRequired: false,
        position: 0, archivedAt: null,
      }] })
      .mockResolvedValueOnce({ rows: [{ count: '3' }] })

    await expect(updateCrmFieldDefinition({
      ...base, fieldId: 'field-1', options: ['A'],
    })).rejects.toThrow('used by 3 live records')
  })

  it('keeps archived fields recoverable but enforces the live-field cap on restore', async () => {
    mocks.clientQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 })
    mocks.clientQuery.mockResolvedValueOnce({ rows: [{ entityKind: 'company' }] })
    mocks.clientQuery.mockResolvedValueOnce({ rows: [{ count: '50' }] })

    await expect(restoreCrmFieldDefinition(
      base.userId, base.workspaceId, 'field-archived',
    )).rejects.toThrow('Custom field limit reached')
    expect(mocks.clientQuery.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true)
  })
})
