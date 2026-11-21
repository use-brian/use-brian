/**
 * [COMP:api/channel-connector-instance]
 * [COMP:api/slack-connector-instance]
 * [COMP:api/whatsapp-connector-instance]
 * [COMP:api/feishu-connector-instance]
 * [COMP:api/msteams-connector-instance]
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_INGEST_RULES } from '@use-brian/core/ingest/default-rules.js'
import { ensureFeishuConnectorInstance } from '../feishu-connector-instance.js'
import { ensureMsTeamsConnectorInstance } from '../msteams-connector-instance.js'
import { ensureSlackConnectorInstance } from '../slack-connector-instance.js'
import { ensureWhatsappConnectorInstance } from '../whatsapp-connector-instance.js'

const { query, queryWithRLS } = vi.hoisted(() => ({ query: vi.fn(), queryWithRLS: vi.fn() }))
vi.mock('../../db/client.js', () => ({ query, queryWithRLS }))

const input = { channelIntegrationId: 'integration-1', actingUserId: 'owner-1' }
const workspaceId = 'workspace-1'
const instanceId = 'connector-1'

beforeEach(() => vi.resetAllMocks())

function mockProvision(teamName: string | null, teamId: string | null, capability: boolean, seedRules = false) {
  query.mockResolvedValueOnce({ rows: [{ id: null, workspace_id: workspaceId }] })
  query.mockResolvedValueOnce({ rows: [{ team_name: teamName, team_id: teamId, has_ingest: capability }] })
  queryWithRLS.mockResolvedValueOnce({ rows: [{ id: instanceId }] })
  if (seedRules) {
    query.mockResolvedValueOnce({ rows: [{ t: 'ingest_rules' }] })
    queryWithRLS.mockResolvedValueOnce({ rows: [] })
  }
  query.mockResolvedValueOnce({ rows: [] })
}

function assertProvision(provider: string, label: string, enabled: boolean, config: Record<string, unknown>) {
  const [actor, sql, params] = queryWithRLS.mock.calls[0]
  expect(actor).toBe(input.actingUserId)
  expect(sql).toContain('INSERT INTO connector_instance')
  expect(sql).toContain(`VALUES ('workspace', $1, '${provider}'`)
  expect(params.slice(0, 4)).toEqual([workspaceId, label, enabled, input.actingUserId])
  expect(JSON.parse(params[4])).toEqual({ channel_integration_id: input.channelIntegrationId, ...config })
  expect(query).toHaveBeenLastCalledWith(
    expect.stringContaining('UPDATE channel_integrations SET connector_instance_id'),
    [instanceId, input.channelIntegrationId],
  )
}

describe('[COMP:api/channel-connector-instance] channel provisioning', () => {
  const providers = [
    ['Slack', ensureSlackConnectorInstance],
    ['WhatsApp', ensureWhatsappConnectorInstance],
    ['Teams', ensureMsTeamsConnectorInstance],
  ] as const

  it.each(providers)('%s reuses an already-linked instance without writing', async (_provider, ensure) => {
    query.mockResolvedValueOnce({ rows: [{ id: instanceId, workspace_id: workspaceId }] })
    await expect(ensure(input)).resolves.toBe(instanceId)
    expect(queryWithRLS).not.toHaveBeenCalled()
    expect(query).toHaveBeenCalledOnce()
  })

  it.each(providers)('%s refuses a missing integration', async (_provider, ensure) => {
    query.mockResolvedValueOnce({ rows: [] })
    await expect(ensure(input)).rejects.toThrow(/no channel_integrations row/)
    expect(queryWithRLS).not.toHaveBeenCalled()
  })

  it.each([
    { teamName: 'Fictional Slack site', teamId: 'slack-team', capability: true, label: 'Fictional Slack site' },
    { teamName: null, teamId: null, capability: false, label: 'Slack' },
  ])('Slack seeds defaults with label $label', async ({ teamName, teamId, capability, label }) => {
    mockProvision(teamName, teamId, capability, true)
    await expect(ensureSlackConnectorInstance(input)).resolves.toBe(instanceId)
    assertProvision('slack', label, capability, { slack_team_id: teamId })
    const [, sql, values] = queryWithRLS.mock.calls[1]
    expect(sql).toContain('INSERT INTO ingest_rules')
    expect(values.slice(0, 2)).toEqual([instanceId, 'slack'])
    expect(values).toHaveLength(2 + DEFAULT_INGEST_RULES.slack.length * 6)
  })

  it.each([
    {
      provider: 'whatsapp', ensure: ensureWhatsappConnectorInstance,
      teamName: 'WhatsApp', teamId: null, capability: true,
      label: 'WhatsApp', enabled: true, config: {},
    },
    {
      provider: 'feishu', ensure: ensureFeishuConnectorInstance,
      teamName: 'Fictional Feishu bot', teamId: 'feishu-app', capability: true,
      label: 'Fictional Feishu bot', enabled: false, config: { feishu_app_id: 'feishu-app' },
    },
    {
      provider: 'msteams', ensure: ensureMsTeamsConnectorInstance,
      teamName: null, teamId: 'teams-tenant', capability: true,
      label: 'Microsoft Teams', enabled: true, config: { msteams_tenant_id: 'teams-tenant' },
    },
    {
      provider: 'msteams', ensure: ensureMsTeamsConnectorInstance,
      teamName: 'Fictional Teams bot', teamId: 'teams-tenant', capability: false,
      label: 'Fictional Teams bot', enabled: false, config: { msteams_tenant_id: 'teams-tenant' },
    },
  ])('$provider creates a metadata-only instance with label $label and no rules', async (row) => {
    mockProvision(row.teamName, row.teamId, row.capability)
    await expect(row.ensure(input)).resolves.toBe(instanceId)
    assertProvision(row.provider, row.label, row.enabled, row.config)
    expect(queryWithRLS).toHaveBeenCalledOnce()
    expect(query).toHaveBeenCalledTimes(3)
    expect(queryWithRLS.mock.calls[0][1]).not.toContain('app_secret')
  })
})
