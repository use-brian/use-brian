/**
 * Feishu metadata connector-instance provisioning.
 *
 * [COMP:api/feishu-connector-instance]
 * [COMP:api/channel-connector-instance]
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
const queryWithRLS = vi.fn()

vi.mock('../../db/client.js', () => ({
  query: (...args: unknown[]) => query(...args),
  queryWithRLS: (...args: unknown[]) => queryWithRLS(...args),
}))

const { ensureFeishuConnectorInstance } = await import('../feishu-connector-instance.js')

beforeEach(() => vi.clearAllMocks())

describe('[COMP:api/feishu-connector-instance] ensureFeishuConnectorInstance', () => {
  it('creates a disabled, rule-less CI and links it without copying credentials', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: null, workspace_id: 'workspace-1' }] })
    query.mockResolvedValueOnce({
      rows: [{ team_name: 'Operations bot', team_id: 'cli_app', has_ingest: true }],
    })
    queryWithRLS.mockResolvedValueOnce({ rows: [{ id: 'ci_feishu' }] })
    query.mockResolvedValueOnce({ rows: [] })

    await expect(ensureFeishuConnectorInstance({
      channelIntegrationId: 'integration-1',
      actingUserId: 'owner-1',
    })).resolves.toBe('ci_feishu')

    const sql = String(queryWithRLS.mock.calls[0][1])
    const params = queryWithRLS.mock.calls[0][2] as unknown[]
    expect(sql).toContain("'feishu'")
    expect(params[2]).toBe(false)
    expect(JSON.parse(params[4] as string)).toEqual({
      channel_integration_id: 'integration-1',
      feishu_app_id: 'cli_app',
    })
    expect(sql).not.toContain('app_secret')
    expect(queryWithRLS).toHaveBeenCalledOnce()
    expect(query.mock.calls.some((call) => String(call[0]).includes('INSERT INTO ingest_rules')))
      .toBe(false)
  })
})
