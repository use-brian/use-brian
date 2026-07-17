/**
 * Slack-side glue for the connector_instance substrate (migration 182).
 *
 * Each Slack `channel_integrations` row is paired with one
 * workspace-scoped `connector_instance` row that owns its `ingest_rules`.
 * The webhook ingestor reads rules off the CI; the cron-fired batch path
 * keys `pending_ingest_batches` on `ingest_rules.id`. Without a CI, Slack
 * channel ingest can only do realtime — the previous shape of the world
 * before this substrate landed.
 *
 * The migration backfills existing installs. This helper provisions the
 * CI for new installs (and is idempotent — safe to call again on a
 * re-install of the same channel).
 *
 * Side-effects, in order: insert `connector_instance` row, seed
 * `ingest_rules` from `DEFAULT_INGEST_RULES.slack`, update
 * `channel_integrations.connector_instance_id` to point at it.
 *
 * [COMP:api/slack-connector-instance]
 */

import { DEFAULT_INGEST_RULES } from '@use-brian/core'
import { query, queryWithRLS } from '../db/client.js'

export type EnsureSlackCiInput = {
  /** The Slack `channel_integrations.id` just created/refreshed. */
  channelIntegrationId: string
  /** Workspace admin/owner authorizing the connect — used for RLS + audit. */
  actingUserId: string
}

/**
 * Ensure a `connector_instance` exists for this Slack
 * `channel_integrations` row. Returns the CI id.
 *
 * Idempotent: re-running on an already-linked integration is a no-op
 * (returns the existing id). Safe to call from both per-assistant and
 * workspace-driven Slack install paths.
 */
export async function ensureSlackConnectorInstance(
  input: EnsureSlackCiInput,
): Promise<string> {
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
    throw new Error(
      `ensureSlackConnectorInstance: no channel_integrations row for id=${input.channelIntegrationId}`,
    )
  }
  if (row.id) return row.id

  // 2. Pull the rest of what we need to populate the CI.
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

  // 3. Create the workspace-scoped CI. RLS (ci_team_member) requires the
  //    acting user to be a workspace member — slack install routes
  //    already enforce admin/owner above this call.
  const ci = await queryWithRLS<{ id: string }>(
    input.actingUserId,
    `INSERT INTO connector_instance
       (scope, workspace_id, provider, label, sensitivity, connected,
        ingestion_enabled, created_by, config)
     VALUES ('workspace', $1, 'slack', $2, 'internal', true, $3, $4, $5::jsonb)
     RETURNING id`,
    [
      row.workspace_id,
      m.team_name ?? 'Slack',
      m.has_ingest,
      input.actingUserId,
      JSON.stringify({
        channel_integration_id: input.channelIntegrationId,
        slack_team_id: m.team_id,
      }),
    ],
  )
  const connectorInstanceId = ci.rows[0].id

  // 4. Seed default ingest_rules. Mirrors ingestRulesStore.seedDefaults
  //    but inlined to keep this helper dep-free. The `ingest_rules` table
  //    lives in the CLOSED overlay schema (Pipeline-C rules engine) — the OSS
  //    edition doesn't have it, so seeding is skipped there (the CI row is
  //    still created; ingest simply stays rule-less).
  const hasIngestRules =
    (await query<{ t: string | null }>(`SELECT to_regclass('public.ingest_rules') AS t`)).rows[0]?.t != null
  const templates = DEFAULT_INGEST_RULES.slack
  if (hasIngestRules && templates.length > 0) {
    const values: unknown[] = [connectorInstanceId, 'slack']
    const tuples = templates.map((t, i) => {
      const b = 3 + i * 6
      values.push(
        i,
        t.filter_type,
        JSON.stringify(t.filter_params),
        t.routing_mode,
        t.routing_schedule ?? null,
        t.alert ?? false,
      )
      return `($1, $2, $${b}, $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`
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

  // 5. Wire the link. System-level — every caller that reaches here is
  //    permitted to bind the integration they just upserted.
  await query(
    `UPDATE channel_integrations SET connector_instance_id = $1 WHERE id = $2`,
    [connectorInstanceId, input.channelIntegrationId],
  )

  return connectorInstanceId
}
