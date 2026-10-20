/** Server-authoritative CRM collection invariants. [COMP:api/crm-page-http] */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ queryGated: vi.fn(), canonicalQuery: vi.fn() }))

vi.mock('../crm-reader.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../crm-reader.js')>(),
  queryLegacyCanonicalCrmSql: mocks.canonicalQuery,
  runLegacyCanonicalCrmRead: vi.fn(async (_ctx, run) => run()),
}))

vi.mock('../client.js', () => ({
  applyRLSGucs: vi.fn(),
  getPool: vi.fn(),
  query: vi.fn(),
  queryGated: mocks.queryGated,
  queryWithRLS: vi.fn(),
}))
vi.mock('../entities-store.js', () => ({
  getEntityById: vi.fn(),
  updateEntity: vi.fn(),
}))

import {
  getCrmSummary,
  listCrmRecordPage,
  lookupCrmRecords,
} from '../crm-r2.js'

const ctx = {
  userId: 'user-1', workspaceId: 'workspace-1',
  assistantId: 'assistant-1', assistantKind: 'standard' as const,
}

function deal(id: string, updatedAt = new Date('2026-08-24T10:00:00.000Z')) {
  return {
    id,
    kind: 'deal',
    name: `Deal ${id}`,
    attributes: { amount: '100', currency_code: 'USD' },
    archivedAt: null,
    updatedAt,
    sortValue: updatedAt,
  }
}

describe('[COMP:api/crm-page-http] CRM page store', () => {
  beforeEach(() => vi.resetAllMocks())
  afterEach(() => expect(mocks.queryGated).not.toHaveBeenCalled())

  it('traverses equal sort values with the stable id cursor and no overlap', async () => {
    mocks.canonicalQuery
      .mockResolvedValueOnce({ rows: [deal('00000000-0000-4000-8000-000000000003'), deal('00000000-0000-4000-8000-000000000002'), deal('00000000-0000-4000-8000-000000000001')] })
      .mockResolvedValueOnce({ rows: [deal('00000000-0000-4000-8000-000000000001')] })

    const first = await listCrmRecordPage(ctx, {
      kind: 'deal', limit: 2, sort: 'updated', direction: 'desc',
    })
    const second = await listCrmRecordPage(ctx, {
      kind: 'deal', limit: 2, sort: 'updated', direction: 'desc',
      cursor: first.nextCursor,
    })

    expect(first.items.map((row) => row.id)).toEqual([
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000002',
    ])
    expect(first.hasMore).toBe(true)
    expect(second.items.map((row) => row.id)).toEqual([
      '00000000-0000-4000-8000-000000000001',
    ])
    expect(second.hasMore).toBe(false)
    const [actor, fields, secondSql, secondValues] = mocks.canonicalQuery.mock.calls[1] as [unknown, unknown, string, unknown[]]
    expect(actor).toBe(ctx)
    expect(fields).toEqual([{ type: 'deal', fields: 'all' }])
    expect(secondSql).toContain('e.id <')
    expect(secondValues).toContain('00000000-0000-4000-8000-000000000002')
  })

  it('keeps access projection and canonical, custom, and searchable fields in the server query', async () => {
    mocks.canonicalQuery.mockResolvedValue({ rows: [] })

    await listCrmRecordPage(ctx, {
      kind: 'deal', limit: 50, sort: 'name', direction: 'asc',
      search: 'fictional', owners: ['user-2', 'none'],
      pipelineId: 'pipeline-1', stageIds: ['stage-1'], companyIds: ['company-1'],
      custom: { work_type: ['SaaS'], opportunity: ['__empty__'] },
      attention: 'stale',
    })

    const [actor, fields, sql, values] = mocks.canonicalQuery.mock.calls[0] as [unknown, unknown, string, unknown[]]
    expect(actor).toBe(ctx)
    expect(fields).toEqual([
      { type: 'deal', fields: 'all' },
      { type: 'person', fields: ['name'] },
      { type: 'company', fields: ['name'] },
    ])
    expect(sql).toContain('(e.workspace_id IS NULL OR e.workspace_id = $1)')
    expect(sql).toContain("crm_field_definitions")
    expect(sql).toContain("related.display_name ILIKE")
    expect(sql).toContain("e.attributes->>'owner_id'")
    expect(sql).toContain("e.attributes->'custom_fields'")
    expect(sql).toContain("interval '30 days'")
    expect(values).toEqual(expect.arrayContaining([
      'workspace-1', 'user-1', 'assistant-1', 'pipeline-1', ['stage-1'],
      'work_type', ['SaaS'],
    ]))
  })

  it('returns authoritative counts once per stage while preserving currency totals', async () => {
    mocks.canonicalQuery
      .mockResolvedValueOnce({ rows: [{
        deals: '3', contacts: '8', companies: '4', overdue: '1', stale: '2',
        noAmount: '1', orphaned: '3',
      }] })
      .mockResolvedValueOnce({ rows: [
        { stageId: 'stage-1', currency: 'USD', stageCount: '3', value: '1200' },
        { stageId: 'stage-1', currency: 'HKD', stageCount: '3', value: '7000' },
      ] })

    const summary = await getCrmSummary(ctx, 'pipeline-1')

    expect(summary.totals).toEqual({ deals: 3, contacts: 8, companies: 4 })
    expect(summary.attention).toEqual({ overdue: 1, stale: 2, noAmount: 1, orphaned: 3 })
    expect(summary.stages).toEqual([{
      stageId: 'stage-1', count: 3, values: { USD: 1200, HKD: 7000 },
    }])
    expect(mocks.canonicalQuery).toHaveBeenCalledTimes(2)
    for (const call of mocks.canonicalQuery.mock.calls) {
      expect(call[0]).toBe(ctx)
      expect(call[1]).toEqual([
        { type: 'person', fields: ['archivedAt', 'companyId'] },
        { type: 'company', fields: ['archivedAt'] },
        { type: 'deal', fields: ['archivedAt', 'pipelineId', 'pipelineStageId', 'stage', 'amount', 'closeDate', 'updatedAt', 'currencyCode'] },
      ])
      expect(call[3]).toContain('pipeline-1')
    }
  })

  it('bounds relationship lookup independently from collection pages', async () => {
    mocks.canonicalQuery.mockResolvedValue({ rows: [{ id: 'company-1', name: 'Example Co', hint: 'example.test' }] })

    const rows = await lookupCrmRecords({ ctx, kind: 'company', query: 'Example', limit: 500 })

    expect(rows).toEqual([{ id: 'company-1', name: 'Example Co', hint: 'example.test' }])
    const [actor, fields, sql, values] = mocks.canonicalQuery.mock.calls[0] as [unknown, unknown, string, unknown[]]
    expect(actor).toBe(ctx)
    expect(fields).toEqual([{ type: 'company', fields: ['name', 'aliases', 'archivedAt', 'domain'] }])
    expect(sql).toContain('ORDER BY lower(e.display_name), e.id')
    expect(values.at(-1)).toBe(100)
  })
})
