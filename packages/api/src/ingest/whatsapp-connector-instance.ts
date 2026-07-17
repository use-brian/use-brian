/**
 * WhatsApp-side glue for the connector_instance substrate.
 *
 * Each WhatsApp `channel_integrations` row (one per workspace — a single
 * Bring-Your-Own-Number companion device) is paired with one
 * workspace-scoped `connector_instance` row that owns its `ingest_rules`.
 * The inbound-relay ingestor reads rules off the CI; the cron-fired batch
 * path keys `pending_ingest_batches` on `ingest_rules.id`.
 *
 * Mirrors `slack-connector-instance.ts` (`provider='whatsapp'`), with one
 * difference: `DEFAULT_INGEST_RULES.whatsapp` is EMPTY (default-drop), so
 * the rule-seed step is a no-op. A group is ingested only after the owner
 * enables it (which appends a `group_match` rule via the ingest REST API).
 *
 * Side-effects, in order: insert `connector_instance` row, (no default
 * rules to seed), update `channel_integrations.connector_instance_id`.
 *
 * [COMP:api/whatsapp-connector-instance]
 */

import { DEFAULT_INGEST_RULES } from '@use-brian/core'
import { query, queryWithRLS } from '../db/client.js'

export type EnsureWhatsappCiInput = {
  /** The WhatsApp `channel_integrations.id` just created/refreshed. */
  channelIntegrationId: string
  /** Workspace admin/owner authorizing the connect — used for RLS + audit. */
  actingUserId: string
}

/**
 * Ensure a `connector_instance` exists for this WhatsApp
 * `channel_integrations` row. Returns the CI id.
 *
 * Idempotent: re-running on an already-linked integration is a no-op
 * (returns the existing id). Safe to call on re-connect of the same
 * number.
 */
export async function ensureWhatsappConnectorInstance(
  input: EnsureWhatsappCiInput,
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
      `ensureWhatsappConnectorInstance: no channel_integrations row for id=${input.channelIntegrationId}`,
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
  //    acting user to be a workspace member — the connect route enforces
  //    admin/owner above this call.
  const ci = await queryWithRLS<{ id: string }>(
    input.actingUserId,
    `INSERT INTO connector_instance
       (scope, workspace_id, provider, label, sensitivity, connected,
        ingestion_enabled, created_by, config)
     VALUES ('workspace', $1, 'whatsapp', $2, 'internal', true, $3, $4, $5::jsonb)
     RETURNING id`,
    [
      row.workspace_id,
      m.team_name ?? 'WhatsApp',
      m.has_ingest,
      input.actingUserId,
      JSON.stringify({
        channel_integration_id: input.channelIntegrationId,
      }),
    ],
  )
  const connectorInstanceId = ci.rows[0].id

  // 4. Seed default ingest_rules. WhatsApp's defaults are EMPTY
  //    (default-drop) — this block is a no-op, kept symmetric with
  //    slack-connector-instance.ts so a future non-empty default would
  //    flow through here.
  const templates = DEFAULT_INGEST_RULES.whatsapp
  if (templates.length > 0) {
    const values: unknown[] = [connectorInstanceId, 'whatsapp']
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
