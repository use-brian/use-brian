/**
 * Microsoft Teams glue for the connector_instance substrate.
 *
 * Each Teams `channel_integrations` row is paired with one workspace-scoped
 * `connector_instance` row, so the passive-ingest producer (`dispatchMsTeamsIngest`)
 * has a CI id to route against. Mirrors `ensureSlackConnectorInstance`, with one
 * difference: Teams is NOT yet in the `INGEST_SOURCE_PROVIDERS` registry, so no
 * `DEFAULT_INGEST_RULES` are seeded here — the closed Pipeline-C rules engine for
 * Teams is a follow-up (docs/architecture/channels/msteams.md → "Passive ingest").
 * Until then the CI exists (ingest can be enabled/observed) but carries no rules.
 *
 * Idempotent: re-running on an already-linked integration returns the existing id.
 *
 * [COMP:api/msteams-connector-instance]
 */

import { query, queryWithRLS } from '../db/client.js'

export type EnsureMsTeamsCiInput = {
  channelIntegrationId: string
  actingUserId: string
}

export async function ensureMsTeamsConnectorInstance(input: EnsureMsTeamsCiInput): Promise<string> {
  // 1. Short-circuit if already linked.
  const linked = await query<{ id: string | null; workspace_id: string }>(
    `SELECT ci.connector_instance_id AS id, c.workspace_id
       FROM channel_integrations ci
       JOIN channels c ON c.id = ci.channel_id
      WHERE ci.id = $1`,
    [input.channelIntegrationId],
  )
  const row = linked.rows[0]
  if (!row) {
    throw new Error(`ensureMsTeamsConnectorInstance: no channel_integrations row for id=${input.channelIntegrationId}`)
  }
  if (row.id) return row.id

  const meta = await query<{ team_name: string | null; team_id: string | null; has_ingest: boolean }>(
    `SELECT ci.team_name, ci.team_id,
            ('ingest' = ANY (c.enabled_capabilities)) AS has_ingest
       FROM channel_integrations ci
       JOIN channels c ON c.id = ci.channel_id
      WHERE ci.id = $1`,
    [input.channelIntegrationId],
  )
  const m = meta.rows[0]

  // 2. Create the workspace-scoped CI (provider 'msteams'). No ingest_rules
  //    seeding — see the file header.
  const ci = await queryWithRLS<{ id: string }>(
    input.actingUserId,
    `INSERT INTO connector_instance
       (scope, workspace_id, provider, label, sensitivity, connected,
        ingestion_enabled, created_by, config)
     VALUES ('workspace', $1, 'msteams', $2, 'internal', true, $3, $4, $5::jsonb)
     RETURNING id`,
    [
      row.workspace_id,
      m.team_name ?? 'Microsoft Teams',
      m.has_ingest,
      input.actingUserId,
      JSON.stringify({ channel_integration_id: input.channelIntegrationId, msteams_tenant_id: m.team_id }),
    ],
  )
  const connectorInstanceId = ci.rows[0].id

  // 3. Wire the link (system-level).
  await query(`UPDATE channel_integrations SET connector_instance_id = $1 WHERE id = $2`, [
    connectorInstanceId,
    input.channelIntegrationId,
  ])

  return connectorInstanceId
}
