import { readFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
}))

import { query } from '../client.js'
import { createOssUsageStore, getWorkspaceTokenUsage } from '../oss-usage-store.js'

const mockQuery = vi.mocked(query)
const baseParams = {
  userId: '00000000-0000-4000-8000-000000000001',
  assistantId: '00000000-0000-4000-8000-000000000002',
  sessionId: 'workflow_run_00000000-0000-4000-8000-000000000003',
  model: 'gemini-flash',
  inputTokens: 1_000,
  outputTokens: 200,
  actualCostUsd: 0.001,
  source: 'included',
}

beforeEach(() => {
  mockQuery.mockReset()
})

describe('[COMP:goals/oss-metering] standalone usage store', () => {
  it('records attributed COGS locally without hosted billing side effects', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ workspace_id: 'ws_1', user_id: baseParams.userId }],
      rowCount: 1,
    } as never)

    await createOssUsageStore().recordUsage(baseParams)

    expect(mockQuery).toHaveBeenCalledOnce()
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('INSERT INTO oss_usage_tracking')
    expect(sql).not.toContain('daily_usage')
    expect(sql).not.toContain('credit')
    expect(params).toContain(baseParams.sessionId)
    expect(params).toContain(baseParams.actualCostUsd)
  })

  it('attributes workspace-only background usage to its oldest assistant', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ workspace_id: 'ws_1', user_id: baseParams.userId }],
      rowCount: 1,
    } as never)

    await createOssUsageStore().recordUsage({
      ...baseParams,
      assistantId: '',
      workspaceId: '00000000-0000-4000-8000-000000000004',
      source: 'overhead:embedding',
    })

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('ORDER BY created_at ASC')
    expect(params[2]).toBe('00000000-0000-4000-8000-000000000004')
  })

  it('refuses unattributable usage instead of writing an orphan row', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await createOssUsageStore().recordUsage({
      ...baseParams,
      assistantId: '',
    })

    expect(mockQuery).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no assistantId and no workspaceId'))
    warn.mockRestore()
  })

  it('sums a workflow session and excludes overhead from the goal budget', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0.7500000000' }], rowCount: 1 } as never)

    const total = await createOssUsageStore().getSessionCostUsd(baseParams.sessionId)

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('FROM oss_usage_tracking')
    expect(sql).toContain('session_id = $1')
    expect(sql).toContain("source NOT LIKE 'overhead:%'")
    expect(params).toEqual([baseParams.sessionId])
    expect(total).toBe(0.75)
  })

  it('defines a text session key and no hosted billing tables in the migration', async () => {
    const sql = await readFile(
      new URL('../../../migrations/476_oss_usage_tracking.sql', import.meta.url),
      'utf8',
    )

    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public\.oss_usage_tracking/)
    expect(sql).toMatch(/session_id TEXT/)
    expect(sql).toContain('ON DELETE CASCADE')
    expect(sql).not.toMatch(/CREATE TABLE[^;]*daily_usage/i)
    expect(sql).not.toMatch(/credits?_/i)
  })
})


describe('[COMP:goals/oss-metering] workspace model usage estimates', () => {
  it('groups by recorded model, excludes separate cache counters and preserves partial costs', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [
      { model: 'gemini-flash', tokens: '1500', estimated_cost_usd: '0.001234', has_unpriced_usage: false },
      { model: 'mixed-model', tokens: '200', estimated_cost_usd: '0.02', has_unpriced_usage: true },
      { model: 'custom:endpoint', tokens: '300', estimated_cost_usd: null, has_unpriced_usage: true },
    ] } as never)
    const result = await getWorkspaceTokenUsage('workspace-a', new Date('2026-08-31T00:00:00Z'))
    expect(result.models).toEqual([
      { model: 'gemini-flash', modelName: 'Gemini 3 Flash', tokens: 1500, estimatedCostUsd: 0.001234, hasUnpricedUsage: false },
      { model: 'mixed-model', modelName: 'mixed-model', tokens: 200, estimatedCostUsd: 0.02, hasUnpricedUsage: true },
      { model: 'custom:endpoint', modelName: 'custom:endpoint', tokens: 300, estimatedCostUsd: null, hasUnpricedUsage: true },
    ])
    expect(result.estimatedCostUsd).toBeCloseTo(0.021234)
    expect(result.hasUnpricedUsage).toBe(true)
    const [sql, params] = mockQuery.mock.calls[0]
    expect(sql).toContain('SUM(input_tokens + output_tokens)')
    expect(sql).toContain('SUM(NULLIF(actual_cost_usd, 0))')
    expect(sql).toContain('BOOL_OR(actual_cost_usd = 0)')
    expect(sql).toContain('GROUP BY model')
    expect(sql).not.toContain('cache_read_tokens')
    expect(sql).not.toContain('overhead:')
    expect(params).toEqual(['workspace-a', '2026-08-01T00:00:00.000Z', '2026-08-31T00:00:00.000Z'])
  })
  it('does not report free inference when every recorded cost is zero', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ model: 'custom:model', tokens: '100', estimated_cost_usd: null, has_unpriced_usage: true }] } as never)
    expect(await getWorkspaceTokenUsage('workspace-a')).toMatchObject({ estimatedCostUsd: null, hasUnpricedUsage: true })
  })
  it('returns no models and a zero total only for an empty window', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    expect(await getWorkspaceTokenUsage('workspace-a')).toMatchObject({ models: [], estimatedCostUsd: 0, hasUnpricedUsage: false })
  })
})
