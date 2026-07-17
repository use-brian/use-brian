/**
 * Postgres-backed `IngestRuleEditorStore` — fulfils the editor port the
 * core agent-tools layer (`packages/core/src/ingest/tools.ts`) calls into.
 *
 * RLS posture. `connector_instance` (mig 083) carries ci_user_own +
 * ci_team_member policies; `ingest_rules` (mig 130) delegates to its
 * parent CI. Every query here is `queryWithRLS(actingUserId, ...)`, so a
 * caller can only enumerate, add, update, or delete rules for instances
 * already visible to them.
 *
 * Workspace-admin-only enforcement on `scope='workspace'` instances is a
 * follow-up — for v1 any workspace member with visibility on the CI can
 * edit. The Studio + agent UX surfaces the rule list to operators only,
 * which limits the practical exposure.
 *
 * [COMP:api/ingest-rules-editor-store]
 */

import type {
  AddIngestRuleInput,
  ConnectorInstanceSummary,
  IngestRuleEditorStore,
  IngestRuleSummary,
  IngestSourceProvider,
  RoutingMode,
  RuleEpisodeSensitivity,
  UpdateIngestRuleInput,
} from '@use-brian/core'
import { INGEST_SOURCE_PROVIDERS } from '@use-brian/core'
import { queryWithRLS } from './client.js'

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

const INGEST_PROVIDER_SET = new Set<IngestSourceProvider>(INGEST_SOURCE_PROVIDERS)

function isIngestProvider(p: string): p is IngestSourceProvider {
  return INGEST_PROVIDER_SET.has(p as IngestSourceProvider)
}

type RuleRow = {
  id: string
  connectorInstanceId: string
  source: string
  ruleOrder: number
  filterType: string
  filterParams: Record<string, unknown>
  routingMode: RoutingMode
  routingSchedule: string | null
  routingTimezone: string
  alert: boolean
  episodeSensitivity: RuleEpisodeSensitivity | null
}

function toSummary(row: RuleRow): IngestRuleSummary {
  return {
    id: row.id,
    connectorInstanceId: row.connectorInstanceId,
    source: row.source,
    ruleOrder: row.ruleOrder,
    filterType: row.filterType,
    filterParams: row.filterParams,
    routingMode: row.routingMode,
    routingSchedule: row.routingSchedule,
    routingTimezone: row.routingTimezone,
    alert: row.alert,
    episodeSensitivity: row.episodeSensitivity,
  }
}

export function createIngestRuleEditorStore(): IngestRuleEditorStore {
  return {
    async listConnectorInstances(actingUserId, opts) {
      // RLS-gated visibility: callers see their own user-scoped + their
      // workspaces' team-scoped CIs. We additionally narrow to
      // ingest-capable providers (the five in INGEST_SOURCE_PROVIDERS).
      const params: unknown[] = [actingUserId, INGEST_SOURCE_PROVIDERS as readonly string[]]
      const filters: string[] = [
        `((scope = 'user' AND user_id = $1)
          OR (scope = 'workspace' AND workspace_id IN (
                SELECT workspace_id FROM workspace_members WHERE user_id = $1)))`,
        `provider = ANY($2::text[])`,
      ]
      if (opts.provider) {
        filters.push(`provider = $${params.length + 1}`)
        params.push(opts.provider)
      }
      if (opts.workspaceId) {
        filters.push(`workspace_id = $${params.length + 1}`)
        params.push(opts.workspaceId)
      }
      type Row = {
        id: string
        scope: 'user' | 'workspace'
        provider: string
        label: string
        ingestionEnabled: boolean
      }
      const result = await queryWithRLS<Row>(
        actingUserId,
        `SELECT id, scope, provider, label,
                ingestion_enabled AS "ingestionEnabled"
           FROM connector_instance
          WHERE ${filters.join(' AND ')}
          ORDER BY label ASC`,
        params,
      )
      const rows: ConnectorInstanceSummary[] = []
      for (const row of result.rows) {
        if (!isIngestProvider(row.provider)) continue
        rows.push({
          id: row.id,
          scope: row.scope,
          provider: row.provider,
          label: row.label,
          ingestionEnabled: row.ingestionEnabled,
        })
      }
      return rows
    },

    async listRules(actingUserId, connectorInstanceId) {
      const result = await queryWithRLS<RuleRow>(
        actingUserId,
        `SELECT ${PUBLIC_COLS} FROM ingest_rules
          WHERE connector_instance_id = $1
          ORDER BY rule_order ASC`,
        [connectorInstanceId],
      )
      return result.rows.map(toSummary)
    },

    async addRule(actingUserId, input) {
      // Resolve insertion order: caller-supplied or one past the current tail.
      let ruleOrder = input.ruleOrder
      if (ruleOrder === undefined) {
        const tail = await queryWithRLS<{ max: number | null }>(
          actingUserId,
          `SELECT MAX(rule_order) AS max FROM ingest_rules
            WHERE connector_instance_id = $1`,
          [input.connectorInstanceId],
        )
        ruleOrder = (tail.rows[0]?.max ?? -1) + 1
      }

      // Validate cron field shape — engine throws on null schedule for
      // scheduled rules; reject early with a clear message.
      if (input.routingMode === 'scheduled' && !input.routingSchedule) {
        throw new Error(
          'addIngestRule: routing_mode=scheduled requires a non-empty routing_schedule (cron expression).',
        )
      }
      if (input.routingMode !== 'scheduled' && input.routingSchedule) {
        throw new Error(
          `addIngestRule: routing_schedule must be null for routing_mode=${input.routingMode}.`,
        )
      }

      // Source denorm. Look up from the parent CI under RLS; missing →
      // invisible-to-caller and we surface that as not-found.
      const meta = await queryWithRLS<{ provider: string }>(
        actingUserId,
        `SELECT provider FROM connector_instance WHERE id = $1`,
        [input.connectorInstanceId],
      )
      const provider = meta.rows[0]?.provider
      if (!provider) {
        throw new Error(
          `addIngestRule: connector instance ${input.connectorInstanceId} not visible to acting user`,
        )
      }

      const result = await queryWithRLS<RuleRow>(
        actingUserId,
        `INSERT INTO ingest_rules
           (connector_instance_id, source, rule_order, filter_type,
            filter_params, routing_mode, routing_schedule, routing_timezone,
            alert, episode_sensitivity)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
         RETURNING ${PUBLIC_COLS}`,
        [
          input.connectorInstanceId,
          provider,
          ruleOrder,
          input.filterType,
          JSON.stringify(input.filterParams),
          input.routingMode,
          input.routingSchedule ?? null,
          input.routingTimezone ?? 'UTC',
          input.alert ?? false,
          input.episodeSensitivity ?? null,
        ],
      )
      const row = result.rows[0]
      if (!row) {
        throw new Error('addIngestRule: insert did not return a row (RLS may have rejected)')
      }
      return toSummary(row)
    },

    async updateRule(actingUserId, input) {
      // Read-then-update so we can pre-validate the new (routing_mode,
      // routing_schedule) pair against the CHECK constraint and return a
      // helpful error rather than the raw PG message.
      const existing = await queryWithRLS<RuleRow>(
        actingUserId,
        `SELECT ${PUBLIC_COLS} FROM ingest_rules WHERE id = $1`,
        [input.ruleId],
      )
      const current = existing.rows[0]
      if (!current) {
        throw new Error(`updateIngestRule: rule ${input.ruleId} not visible to acting user`)
      }
      const nextMode = input.patch.routingMode ?? current.routingMode
      const nextSched =
        input.patch.routingSchedule === undefined
          ? current.routingSchedule
          : input.patch.routingSchedule
      if (nextMode === 'scheduled' && !nextSched) {
        throw new Error(
          'updateIngestRule: routing_mode=scheduled requires a non-empty routing_schedule.',
        )
      }
      if (nextMode !== 'scheduled' && nextSched) {
        throw new Error(
          `updateIngestRule: routing_schedule must be null for routing_mode=${nextMode}.`,
        )
      }

      const sets: string[] = []
      const params: unknown[] = []
      const pushSet = (col: string, value: unknown) => {
        params.push(value)
        sets.push(`${col} = $${params.length}`)
      }
      if (input.patch.filterType !== undefined) pushSet('filter_type', input.patch.filterType)
      if (input.patch.filterParams !== undefined)
        pushSet('filter_params', JSON.stringify(input.patch.filterParams))
      if (input.patch.routingMode !== undefined) pushSet('routing_mode', input.patch.routingMode)
      if (input.patch.routingSchedule !== undefined)
        pushSet('routing_schedule', input.patch.routingSchedule)
      if (input.patch.routingTimezone !== undefined)
        pushSet('routing_timezone', input.patch.routingTimezone)
      if (input.patch.alert !== undefined) pushSet('alert', input.patch.alert)
      if (input.patch.episodeSensitivity !== undefined)
        pushSet('episode_sensitivity', input.patch.episodeSensitivity)
      if (input.patch.ruleOrder !== undefined) pushSet('rule_order', input.patch.ruleOrder)

      if (sets.length === 0) return toSummary(current)

      // filter_params needs ::jsonb cast — inject after the param push
      // using a small replace, simplest given the dynamic builder.
      const setSql = sets
        .map((s) => (s.startsWith('filter_params = ') ? `${s}::jsonb` : s))
        .join(', ')

      params.push(input.ruleId)
      const result = await queryWithRLS<RuleRow>(
        actingUserId,
        `UPDATE ingest_rules SET ${setSql} WHERE id = $${params.length}
         RETURNING ${PUBLIC_COLS}`,
        params,
      )
      const row = result.rows[0]
      if (!row) {
        throw new Error(
          `updateIngestRule: rule ${input.ruleId} no longer visible after patch (RLS race)`,
        )
      }
      return toSummary(row)
    },

    async deleteRule(actingUserId, ruleId) {
      const result = await queryWithRLS(
        actingUserId,
        `DELETE FROM ingest_rules WHERE id = $1`,
        [ruleId],
      )
      if ((result.rowCount ?? 0) === 0) {
        throw new Error(`deleteIngestRule: rule ${ruleId} not visible to acting user`)
      }
    },
  }
}
