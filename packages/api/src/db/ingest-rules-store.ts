/**
 * Ingest-rules store — read + seed for the Pipeline C control plane.
 *
 * Backs the Studio ▸ Ingestion surface. `listByConnectorInstance` reads
 * the ordered rule list for one connector instance; `seedDefaults`
 * idempotently writes `DEFAULT_INGEST_RULES` for a source the first time
 * a user enables ingestion on that instance.
 *
 * RLS: `ingest_rules` (migration 130) delegates its policy to the parent
 * `connector_instance`, so every call is RLS-gated via `queryWithRLS` —
 * a caller can only read/seed rules for instances already visible to
 * them.
 *
 * Component tag: [COMP:api/ingest-rules-store].
 * Spec: docs/plans/company-brain/ingest.md → "Default rule templates per
 * source" + "Ingestion control plane".
 */

import { getDefaultRules, type IngestSourceProvider } from '@use-brian/core'
import { query, queryWithRLS } from './client.js'

// 'reply' (migration 283) is a WhatsApp BotHandler trigger mode — evaluated by
// the bot, never by the ingest engine (the listener filters reply rules out
// before building its engine, so the core RoutingMode union stays narrow). See
// docs/architecture/channels/whatsapp.md.
export type IngestRoutingMode = 'realtime' | 'scheduled' | 'drop' | 'reply'

/** A hydrated `ingest_rules` row (migration 130 + 183), camelCased. */
export type IngestRuleRow = {
  id: string
  connectorInstanceId: string
  source: string
  ruleOrder: number
  filterType: string
  filterParams: Record<string, unknown>
  routingMode: IngestRoutingMode
  routingSchedule: string | null
  routingTimezone: string
  alert: boolean
  /**
   * Per-rule Episode sensitivity override (migration 183). NULL means
   * the produced Episode inherits the source default (`internal`).
   */
  episodeSensitivity: 'public' | 'internal' | 'confidential' | null
}

export type IngestRulesStore = {
  /** Ordered rules for one connector instance (rule_order ASC). RLS-gated. */
  listByConnectorInstance(
    actingUserId: string,
    connectorInstanceId: string,
  ): Promise<IngestRuleRow[]>

  /**
   * Ordered rules for many connector instances in a single query —
   * batched read for the control-plane source list, so listing N
   * connectors costs one query, not N. Empty input → []. RLS-gated.
   */
  listByConnectorInstances(
    actingUserId: string,
    connectorInstanceIds: string[],
  ): Promise<IngestRuleRow[]>

  /**
   * Idempotently seed `DEFAULT_INGEST_RULES[source]` for an instance.
   * No-op (returns 0) when the instance already has any rule. Returns the
   * number of rows inserted. RLS-gated.
   */
  seedDefaults(
    actingUserId: string,
    connectorInstanceId: string,
    source: IngestSourceProvider,
  ): Promise<number>

  /**
   * Ordered rules for one connector instance — system-level (no acting
   * user), for the Pipeline C ingest pollers. `ingest_rules` RLS carries
   * a `system_bypass` policy, so a bare query is correct here.
   */
  listByConnectorInstanceSystem(
    connectorInstanceId: string,
  ): Promise<IngestRuleRow[]>
}

const PUBLIC_COLS = `
  id,
  connector_instance_id AS "connectorInstanceId",
  source,
  rule_order AS "ruleOrder",
  filter_type AS "filterType",
  filter_params AS "filterParams",
  routing_mode AS "routingMode",
  routing_schedule AS "routingSchedule",
  routing_timezone AS "routingTimezone",
  alert,
  episode_sensitivity AS "episodeSensitivity"
` as const

export function createIngestRulesStore(): IngestRulesStore {
  return {
    async listByConnectorInstance(actingUserId, connectorInstanceId) {
      const result = await queryWithRLS<IngestRuleRow>(
        actingUserId,
        `SELECT ${PUBLIC_COLS} FROM ingest_rules
         WHERE connector_instance_id = $1
         ORDER BY rule_order ASC`,
        [connectorInstanceId],
      )
      return result.rows
    },

    async listByConnectorInstances(actingUserId, connectorInstanceIds) {
      if (connectorInstanceIds.length === 0) return []
      const result = await queryWithRLS<IngestRuleRow>(
        actingUserId,
        `SELECT ${PUBLIC_COLS} FROM ingest_rules
         WHERE connector_instance_id = ANY($1::uuid[])
         ORDER BY connector_instance_id, rule_order ASC`,
        [connectorInstanceIds],
      )
      return result.rows
    },

    async seedDefaults(actingUserId, connectorInstanceId, source) {
      const templates = getDefaultRules(source)
      if (templates.length === 0) return 0

      // Idempotent: once an instance has rules — seeded defaults, or
      // agent-customized later — never re-seed. A disable→enable
      // round-trip must not clobber customizations.
      const existing = await queryWithRLS<{ count: string }>(
        actingUserId,
        `SELECT count(*)::text AS count FROM ingest_rules
         WHERE connector_instance_id = $1`,
        [connectorInstanceId],
      )
      if (Number(existing.rows[0]?.count ?? '0') > 0) return 0

      // Multi-row insert. $1/$2 are constant across rows; each template
      // contributes 6 positional params. routing_timezone + created_at
      // fall through to their column defaults ('UTC', now()).
      const values: unknown[] = [connectorInstanceId, source]
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

      const result = await queryWithRLS(
        actingUserId,
        `INSERT INTO ingest_rules
           (connector_instance_id, source, rule_order, filter_type,
            filter_params, routing_mode, routing_schedule, alert)
         VALUES ${tuples.join(', ')}`,
        values,
      )
      return result.rowCount ?? templates.length
    },

    async listByConnectorInstanceSystem(connectorInstanceId) {
      const result = await query<IngestRuleRow>(
        `SELECT ${PUBLIC_COLS} FROM ingest_rules
         WHERE connector_instance_id = $1
         ORDER BY rule_order ASC`,
        [connectorInstanceId],
      )
      return result.rows
    },
  }
}
