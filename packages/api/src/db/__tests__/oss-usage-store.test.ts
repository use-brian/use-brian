import { readFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
}))

import { query } from '../client.js'
import { createOssUsageStore } from '../oss-usage-store.js'

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
