/**
 * Shared channel -> connector_instance provisioning.
 *
 * Slack, WhatsApp, and Feishu all keep channel credentials exclusively on
 * `channel_integrations` while Pipeline C rules live on a metadata-only
 * workspace `connector_instance`. This helper owns that common lifecycle so a
 * new channel source does not copy the same insert/seed/link transaction.
 *
 * [COMP:api/channel-connector-instance]
 */

import { DEFAULT_INGEST_RULES, type IngestSourceProvider } from '@use-brian/core'
import { query, queryWithRLS } from '../db/client.js'

export type EnsureChannelConnectorInstanceInput = {
  channelIntegrationId: string
  actingUserId: string
  provider: Extract<IngestSourceProvider, 'slack' | 'whatsapp' | 'feishu'>
  fallbackLabel: string
  /** Feishu is default-off until an observed group is explicitly enabled. */
  initialIngestionEnabled?: boolean
  buildConfig?: (meta: { teamId: string | null }) => Record<string, unknown>
}

export async function ensureChannelConnectorInstance(
  input: EnsureChannelConnectorInstanceInput,
): Promise<string> {
  const linked = await query<{ id: string | null; workspace_id: string }>(
    `SELECT ci.connector_instance_id AS id, c.workspace_id
       FROM channel_integrations ci
       JOIN channels c ON c.id = ci.channel_id
      WHERE ci.id = $1`,
    [input.channelIntegrationId],
  )
  const row = linked.rows[0]
  if (!row) {
    throw new Error(
      `ensureChannelConnectorInstance: no channel_integrations row for id=${input.channelIntegrationId}`,
    )
  }
  if (row.id) return row.id

  const meta = await query<{
    team_name: string | null
    team_id: string | null
    has_ingest: boolean
  }>(
    `SELECT ci.team_name, ci.team_id,
            ('ingest' = ANY (c.enabled_capabilities)) AS has_ingest
       FROM channel_integrations ci
       JOIN channels c ON c.id = ci.channel_id
      WHERE ci.id = $1`,
    [input.channelIntegrationId],
  )
  const m = meta.rows[0]
  if (!m) {
    throw new Error(
      `ensureChannelConnectorInstance: integration metadata disappeared for id=${input.channelIntegrationId}`,
    )
  }

  const config = {
    channel_integration_id: input.channelIntegrationId,
    ...(input.buildConfig?.({ teamId: m.team_id }) ?? {}),
  }
  const ingestionEnabled = input.initialIngestionEnabled ?? m.has_ingest
  // `provider` is a compile-time closed union owned by this module, not user
  // input. Keeping it as a SQL literal preserves the stable statement shape
  // the existing Slack/WhatsApp contract tests assert.
  const ci = await queryWithRLS<{ id: string }>(
    input.actingUserId,
    `INSERT INTO connector_instance
       (scope, workspace_id, provider, label, sensitivity, connected,
        ingestion_enabled, created_by, config)
     VALUES ('workspace', $1, '${input.provider}', $2, 'internal', true, $3, $4, $5::jsonb)
     RETURNING id`,
    [
      row.workspace_id,
      m.team_name ?? input.fallbackLabel,
      ingestionEnabled,
      input.actingUserId,
      JSON.stringify(config),
    ],
  )
  const connectorInstanceId = ci.rows[0].id

  const templates = DEFAULT_INGEST_RULES[input.provider]
  if (templates.length > 0) {
    // The rules table is a hosted Pipeline-C overlay. OSS still creates the
    // metadata CI so channel state stays edition-neutral, but skips seeding
    // when the overlay is absent.
    const hasIngestRules =
      (await query<{ t: string | null }>(`SELECT to_regclass('public.ingest_rules') AS t`))
        .rows[0]?.t != null
    if (hasIngestRules) {
      const values: unknown[] = [connectorInstanceId, input.provider]
      const tuples = templates.map((template, index) => {
        const base = 3 + index * 6
        values.push(
          index,
          template.filter_type,
          JSON.stringify(template.filter_params),
          template.routing_mode,
          template.routing_schedule ?? null,
          template.alert ?? false,
        )
        return `($1, $2, $${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`
      })
      await queryWithRLS(
        input.actingUserId,
        `INSERT INTO ingest_rules
           (connector_instance_id, source, rule_order, filter_type,
            filter_params, routing_mode, routing_schedule, alert)
         VALUES ${tuples.join(', ')}`,
        values,
      )
    }
  }

  await query(
    `UPDATE channel_integrations SET connector_instance_id = $1 WHERE id = $2`,
    [connectorInstanceId, input.channelIntegrationId],
  )
  return connectorInstanceId
}
