/**
 * [COMP:views/aggregations] Pure aggregation reducers + resolveAggregation.
 *
 * The reducers are pure: feed them synthetic rows, assert exact groups.
 * `resolveAggregation` drives the reducers through fake stores so we
 * exercise the entity-loading shim without touching the DB.
 */

import { describe, expect, it } from 'vitest'
import type { CrmStore } from '../../crm/types.js'
import type { AccessContext } from '../../security/access-context.js'
import type { TaskStore } from '../../tasks/types.js'
import {
  aggregateBindingSchema,
  avgBy,
  countBy,
  resolveAggregation,
  seriesByDate,
  sumBy,
  type AggregationDeps,
} from '../aggregations.js'

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001'
const USER_ID = '00000000-0000-0000-0000-000000000002'

const accessContext: AccessContext = {
  workspaceId: WORKSPACE_ID,
  userId: USER_ID,
  assistantId: USER_ID,
  assistantKind: 'primary',
  clearance: undefined,
}

// ── Pure reducer tests ────────────────────────────────────────────────

describe('[COMP:views/aggregations] countBy', () => {
  it('counts rows grouped by a string field', () => {
    const rows = [
      { id: '1', status: 'todo' },
      { id: '2', status: 'todo' },
      { id: '3', status: 'in_progress' },
      { id: '4', status: 'done' },
      { id: '5', status: 'done' },
      { id: '6', status: 'done' },
    ]
    const result = countBy(rows, 'status')
    // Sorted by descending count.
    expect(result.groups).toEqual([
      { label: 'done', value: 3 },
      { label: 'todo', value: 2 },
      { label: 'in_progress', value: 1 },
    ])
    expect(result.total).toBe(6)
  })

  it('handles missing/undefined groupBy values with sentinel label', () => {
    const rows = [
      { id: '1', stage: 'lead' },
      { id: '2' },
      { id: '3', stage: null },
    ]
    const result = countBy(rows, 'stage')
    expect(result.groups.find((g) => g.label === '∅')?.value).toBe(2)
    expect(result.groups.find((g) => g.label === 'lead')?.value).toBe(1)
    expect(result.total).toBe(3)
  })

  it('returns empty groups + total=0 for empty input', () => {
    expect(countBy([], 'status')).toEqual({ groups: [], total: 0 })
  })
})

describe('[COMP:views/aggregations] sumBy', () => {
  it('sums numeric measure by group', () => {
    const rows = [
      { stage: 'won', amount: 1000 },
      { stage: 'won', amount: 500 },
      { stage: 'lost', amount: 200 },
      { stage: 'proposal', amount: 750 },
      { stage: 'proposal', amount: 250 },
    ]
    const result = sumBy(rows, 'stage', 'amount')
    expect(result.groups).toEqual([
      { label: 'won', value: 1500 },
      { label: 'proposal', value: 1000 },
      { label: 'lost', value: 200 },
    ])
    expect(result.total).toBe(2700)
  })

  it('treats non-numeric measure values as 0', () => {
    const rows = [
      { stage: 'won', amount: 100 },
      { stage: 'won', amount: null },
      { stage: 'won', amount: 'bogus' },
    ]
    const result = sumBy(rows, 'stage', 'amount')
    expect(result.groups).toEqual([{ label: 'won', value: 100 }])
    expect(result.total).toBe(100)
  })
})

describe('[COMP:views/aggregations] avgBy', () => {
  it('averages numeric measure by group, skipping non-numeric values', () => {
    const rows = [
      { stage: 'won', amount: 100 },
      { stage: 'won', amount: 200 },
      { stage: 'won', amount: null },
      { stage: 'lost', amount: 50 },
    ]
    const result = avgBy(rows, 'stage', 'amount')
    // won: (100+200)/2 = 150 ; lost: 50
    expect(result.groups).toEqual([
      { label: 'won', value: 150 },
      { label: 'lost', value: 50 },
    ])
  })
})

describe('[COMP:views/aggregations] seriesByDate', () => {
  it('buckets by day in chronological order', () => {
    const rows = [
      { closeDate: '2026-05-01T10:00:00Z', amount: 100 },
      { closeDate: '2026-05-01T15:00:00Z', amount: 200 },
      { closeDate: '2026-05-03T09:00:00Z', amount: 50 },
      { closeDate: '2026-05-02T12:00:00Z', amount: 75 },
    ]
    const result = seriesByDate(rows, 'closeDate', 'day')
    expect(result.groups).toEqual([
      { label: '2026-05-01', value: 2 },
      { label: '2026-05-02', value: 1 },
      { label: '2026-05-03', value: 1 },
    ])
  })

  it('buckets by month and sums the optional measure', () => {
    const rows = [
      { closeDate: '2026-04-15T00:00:00Z', amount: 100 },
      { closeDate: '2026-05-02T00:00:00Z', amount: 50 },
      { closeDate: '2026-05-28T00:00:00Z', amount: 200 },
    ]
    const result = seriesByDate(rows, 'closeDate', 'month', 'amount')
    expect(result.groups).toEqual([
      { label: '2026-04', value: 100 },
      { label: '2026-05', value: 250 },
    ])
  })

  it('buckets by ISO week (Monday-start, UTC)', () => {
    // 2026-05-04 is a Monday; 2026-05-06 falls in the same week.
    const rows = [
      { d: '2026-05-04T00:00:00Z' }, // Mon week of 2026-05-04
      { d: '2026-05-06T00:00:00Z' }, // Wed same week
      { d: '2026-05-11T00:00:00Z' }, // Mon next week
    ]
    const result = seriesByDate(rows, 'd', 'week')
    expect(result.groups).toEqual([
      { label: '2026-05-04', value: 2 },
      { label: '2026-05-11', value: 1 },
    ])
  })

  it('drops rows with non-date groupBy values', () => {
    const rows = [
      { d: '2026-05-01T00:00:00Z' },
      { d: 'not-a-date' },
      { d: null },
    ]
    const result = seriesByDate(rows, 'd', 'day')
    expect(result.groups).toEqual([{ label: '2026-05-01', value: 1 }])
  })
})

// ── resolveAggregation against fake stores ────────────────────────────

function fakeTaskStore(rows: unknown[]): TaskStore {
  return {
    async create() { throw new Error('not used') },
    async getById() { return null },
    list: async () => rows as never[],
    async update() { return null },
  }
}

function fakeCrmStore(opts: { deals?: unknown[] } = {}): CrmStore {
  const empty = async () => []
  return {
    async createCompany() { throw new Error('not used') },
    async getCompanyById() { return null },
    listCompanies: empty,
    async updateCompany() { return null },
    async createContact() { throw new Error('not used') },
    async getContactById() { return null },
    listContacts: empty,
    async updateContact() { return null },
    async createDeal() { throw new Error('not used') },
    async getDealById() { return null },
    listDeals: async () => (opts.deals ?? []) as never[],
    async updateDeal() { return null },
    async setDealStage() { return null },
    async batchLabels() { return new Map() },
  } as unknown as CrmStore
}

function deps(opts: {
  taskRows?: unknown[]
  dealRows?: unknown[]
} = {}): AggregationDeps {
  return {
    taskStore: fakeTaskStore(opts.taskRows ?? []),
    crmStore: fakeCrmStore({ deals: opts.dealRows ?? [] }),
    accessContext,
  }
}

describe('[COMP:views/aggregations] resolveAggregation', () => {
  it('count_by — loads tasks and groups by status', async () => {
    const taskRows = [
      { id: '1', status: 'todo' },
      { id: '2', status: 'todo' },
      { id: '3', status: 'done' },
    ]
    const result = await resolveAggregation(
      { entity: 'tasks', op: 'count_by', groupBy: 'status' },
      deps({ taskRows }),
    )
    expect(result.total).toBe(3)
    expect(result.groups).toEqual([
      { label: 'todo', value: 2 },
      { label: 'done', value: 1 },
    ])
  })

  it('sum_by — loads deals and sums amount by stage', async () => {
    const dealRows = [
      { id: '1', stage: 'won', amount: 1000 },
      { id: '2', stage: 'won', amount: 500 },
      { id: '3', stage: 'proposal', amount: 250 },
    ]
    const result = await resolveAggregation(
      { entity: 'deals', op: 'sum_by', groupBy: 'stage', measure: 'amount' },
      deps({ dealRows }),
    )
    expect(result.groups).toEqual([
      { label: 'won', value: 1500 },
      { label: 'proposal', value: 250 },
    ])
    expect(result.total).toBe(1750)
  })

  it('series_by_date — buckets deal close dates by week', async () => {
    const dealRows = [
      { id: '1', closeDate: new Date('2026-05-04T00:00:00Z'), amount: 100 },
      { id: '2', closeDate: new Date('2026-05-05T00:00:00Z'), amount: 200 },
      { id: '3', closeDate: new Date('2026-05-11T00:00:00Z'), amount: 50 },
    ]
    const result = await resolveAggregation(
      {
        entity: 'deals',
        op: 'series_by_date',
        groupBy: 'closeDate',
        bucket: 'week',
        measure: 'amount',
      },
      deps({ dealRows }),
    )
    expect(result.groups).toEqual([
      { label: '2026-05-04', value: 300 },
      { label: '2026-05-11', value: 50 },
    ])
  })

  it('applies in-memory filters', async () => {
    const taskRows = [
      { id: '1', status: 'todo', assigneeId: 'a' },
      { id: '2', status: 'todo', assigneeId: 'b' },
      { id: '3', status: 'done', assigneeId: 'a' },
    ]
    const result = await resolveAggregation(
      {
        entity: 'tasks',
        op: 'count_by',
        groupBy: 'status',
        filters: { assigneeId: 'a' },
      },
      deps({ taskRows }),
    )
    expect(result.total).toBe(2)
    expect(result.groups).toEqual([
      { label: 'todo', value: 1 },
      { label: 'done', value: 1 },
    ])
  })

  it('throws when sum_by is missing measure', async () => {
    await expect(
      resolveAggregation(
        { entity: 'tasks', op: 'sum_by', groupBy: 'status' },
        deps(),
      ),
    ).rejects.toThrow(/measure/)
  })
})

describe('[COMP:views/aggregations] aggregateBindingSchema', () => {
  it('accepts a minimal count_by binding', () => {
    expect(
      aggregateBindingSchema.safeParse({
        entity: 'tasks',
        op: 'count_by',
        groupBy: 'status',
      }).success,
    ).toBe(true)
  })

  it('accepts a series_by_date with bucket + measure', () => {
    expect(
      aggregateBindingSchema.safeParse({
        entity: 'deals',
        op: 'series_by_date',
        groupBy: 'closeDate',
        bucket: 'month',
        measure: 'amount',
      }).success,
    ).toBe(true)
  })

  it('rejects unknown entity', () => {
    expect(
      aggregateBindingSchema.safeParse({
        entity: 'workflow_runs',
        op: 'count_by',
        groupBy: 'status',
      }).success,
    ).toBe(false)
  })

  it('rejects unknown op', () => {
    expect(
      aggregateBindingSchema.safeParse({
        entity: 'tasks',
        op: 'percentile',
        groupBy: 'status',
      }).success,
    ).toBe(false)
  })
})
