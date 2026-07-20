/**
 * Unit tests for `ensureSlackConnectorInstance` — provisions the
 * workspace-scoped `connector_instance` paired with a Slack
 * `channel_integrations` row (migration 182).
 *
 * Locks in:
 *   - idempotency: an already-linked integration returns its existing CI
 *     id and writes nothing
 *   - the CI is created workspace-scoped with provider 'slack', carrying
 *     the channel-integration id + team id in config
 *   - default-SEED: unlike WhatsApp, Slack seeds `DEFAULT_INGEST_RULES.slack`
 *     into `ingest_rules` (a single multi-row insert), so a freshly-
 *     connected workspace has its daily-digest catchall from the start
 *   - the link is wired (channel_integrations.connector_instance_id)
 *
 * Mirrors the WhatsApp sibling test; the meaningful divergence is the
 * rule-seed assertion (Slack seeds, WhatsApp drops).
 *
 * [COMP:api/slack-connector-instance]
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DEFAULT_INGEST_RULES } from '@use-brian/core'

const query = vi.fn()
const queryWithRLS = vi.fn()

vi.mock('../../db/client.js', () => ({
  query: (...args: unknown[]) => query(...args),
  queryWithRLS: (...args: unknown[]) => queryWithRLS(...args),
}))

const { ensureSlackConnectorInstance } = await import('../slack-connector-instance.js')

const CI_ID = 'ci_slack_new'
const INTEGRATION_ID = 'int_1'
const ACTOR = 'u_owner'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:api/slack-connector-instance] ensureSlackConnectorInstance', () => {
  it('short-circuits when the integration already has a CI', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'ci_existing', workspace_id: 'w_1' }] })

    const id = await ensureSlackConnectorInstance({
      channelIntegrationId: INTEGRATION_ID,
      actingUserId: ACTOR,
    })

    expect(id).toBe('ci_existing')
    // No CI insert, no rule seed, no link update.
    expect(queryWithRLS).not.toHaveBeenCalled()
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('creates the workspace CI (provider slack), seeds default rules, and links it', async () => {
    // 1. linked lookup → not yet linked
    query.mockResolvedValueOnce({ rows: [{ id: null, workspace_id: 'w_1' }] })
    // 2. meta lookup
    query.mockResolvedValueOnce({ rows: [{ team_name: 'Acme HQ', team_id: 'T123', has_ingest: true }] })
    // 3. CI insert (queryWithRLS)
    queryWithRLS.mockResolvedValueOnce({ rows: [{ id: CI_ID }] })
    // 4. ingest_rules presence probe (query) — closed-overlay table exists here
    query.mockResolvedValueOnce({ rows: [{ t: 'ingest_rules' }] })
    // 5. ingest_rules seed (queryWithRLS)
    queryWithRLS.mockResolvedValueOnce({ rows: [] })
    // 6. link update (query)
    query.mockResolvedValueOnce({ rows: [] })

    const id = await ensureSlackConnectorInstance({
      channelIntegrationId: INTEGRATION_ID,
      actingUserId: ACTOR,
    })

    expect(id).toBe(CI_ID)

    // CI insert ran workspace-scoped with provider 'slack' + config carrying
    // the integration + team id.
    const ciCall = queryWithRLS.mock.calls[0]
    const ciSql = ciCall[1] as string
    expect(ciSql).toContain('INSERT INTO connector_instance')
    expect(ciSql).toContain("'slack'")
    expect(ciSql).toContain("'workspace'")
    const ciParams = ciCall[2] as unknown[]
    expect(ciParams[0]).toBe('w_1') // workspace_id
    expect(ciParams[1]).toBe('Acme HQ') // label from team_name
    const config = JSON.parse(ciParams[4] as string)
    expect(config).toMatchObject({ channel_integration_id: INTEGRATION_ID, slack_team_id: 'T123' })

    // Default-SEED: ingest_rules IS inserted (one multi-row insert) with the
    // slack defaults and provider 'slack'.
    const ruleSeed = queryWithRLS.mock.calls.find((c) =>
      String(c[1]).includes('INSERT INTO ingest_rules'),
    )
    expect(ruleSeed).toBeTruthy()
    const ruleValues = ruleSeed?.[2] as unknown[]
    // params = [connectorInstanceId, 'slack', ...6 per template]
    expect(ruleValues[0]).toBe(CI_ID)
    expect(ruleValues[1]).toBe('slack')
    expect(ruleValues.length).toBe(2 + DEFAULT_INGEST_RULES.slack.length * 6)

    // The link is wired.
    const linkUpdate = query.mock.calls.find((c) =>
      String(c[0]).includes('UPDATE channel_integrations SET connector_instance_id'),
    )
    expect(linkUpdate).toBeTruthy()
    expect(linkUpdate?.[1]).toEqual([CI_ID, INTEGRATION_ID])
  })

  it('falls back to a "Slack" label when team_name is null', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: null, workspace_id: 'w_1' }] })
    query.mockResolvedValueOnce({ rows: [{ team_name: null, team_id: null, has_ingest: false }] })
    queryWithRLS.mockResolvedValueOnce({ rows: [{ id: CI_ID }] })
    query.mockResolvedValueOnce({ rows: [{ t: 'ingest_rules' }] }) // regclass probe
    queryWithRLS.mockResolvedValueOnce({ rows: [] })
    query.mockResolvedValueOnce({ rows: [] })

    await ensureSlackConnectorInstance({ channelIntegrationId: INTEGRATION_ID, actingUserId: ACTOR })

    const ciParams = queryWithRLS.mock.calls[0][2] as unknown[]
    expect(ciParams[1]).toBe('Slack')
    // has_ingest=false threads ingestion_enabled=false.
    expect(ciParams[2]).toBe(false)
  })

  it('throws when the integration row is missing', async () => {
    query.mockResolvedValueOnce({ rows: [] })
    await expect(
      ensureSlackConnectorInstance({ channelIntegrationId: 'missing', actingUserId: ACTOR }),
    ).rejects.toThrow(/no channel_integrations row/)
  })
})
