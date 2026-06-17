/**
 * `sensitivity-reclassification-store.ts` — company-brain corrections D.6.
 *
 * DB adapters fulfilling the `SensitivityReclassificationRepository` +
 * `ChannelSensitivityRuleRepository` ports declared by the pure
 * orchestration in
 * `packages/core/src/corrections/sensitivity-reclassification.ts`.
 * `reclassifyRowSensitivity` / `supersedeChannelSensitivityRule` inject
 * these ports.
 *
 * Access model: system-level operator state — the admin corrections
 * route. Primitive tables carry `system_bypass` RLS; the D.6 audit /
 * rule tables (migration 152) carry the same. Bare pool path, mirroring
 * `entity-merge-store.ts`.
 *
 * Two derivation-graph limitations, both schema-bound and documented in
 * corrections.md §D.6:
 *
 *   - `findDerivedRows` resolves only the Episode → derived-row hop
 *     (via `source_episode_id`). Row → row derivation (memory →
 *     connection-memory) has no schema column; the cascade stops there.
 *
 *   - `findRowsUnderRuleScope` returns rows a rule has *reclassified*
 *     (joined via `sensitivity_reclassifications.rule_id`). Rows the
 *     rule classified at creation-time but never reclassified are not
 *     tracked — there is no per-row classifying-rule column.
 *
 * [COMP:corrections/sensitivity-reclassification-store]
 */

import type {
  ChannelSensitivityRule,
  ChannelSensitivityRuleRepository,
  DerivedRowRef,
  ReclassifiablePrimitive,
  RowSensitivitySnapshot,
  SensitivityReclassificationRepository,
  Sensitivity,
} from '@sidanclaw/core'
import { getPool, query } from './client.js'

/** Reclassifiable primitive → table. The map is the interpolation allowlist. */
const RECLASSIFY_TABLES: Record<ReclassifiablePrimitive, string> = {
  memory: 'memories',
  entity: 'entities',
  task: 'tasks',
  episode: 'episodes',
  kb_chunk: 'kb_chunks',
  contact: 'contacts',
  company: 'companies',
  deal: 'deals',
  workspace_file: 'workspace_files',
  entity_link: 'entity_links',
}

/** Primitives with no `valid_to` / `source_episode_id` columns. */
const APPEND_ONLY: ReadonlySet<ReclassifiablePrimitive> =
  new Set<ReclassifiablePrimitive>(['episode'])

/** Primitives that can be the source side of an Episode→derived hop. */
const DERIVED_FROM_EPISODE = [
  ['memory', 'memories'],
  ['task', 'tasks'],
  ['entity', 'entities'],
  ['entity_link', 'entity_links'],
] as const

function tableFor(primitive: ReclassifiablePrimitive): string {
  const table = RECLASSIFY_TABLES[primitive]
  if (!table) {
    throw new Error(`sensitivity-reclassification: unsupported primitive "${primitive}"`)
  }
  return table
}

// ── SensitivityReclassificationRepository ────────────────────────────

type RowSensitivityRow = {
  rowId: string
  workspaceId: string
  sensitivity: string
  sourceEpisodeId: string | null
  validTo: Date | null
}

export function createSensitivityReclassificationStore(): SensitivityReclassificationRepository {
  return {
    async readRowForReclassification(primitive, workspaceId, rowId) {
      const table = tableFor(primitive)
      // Episodes carry neither `source_episode_id` nor `valid_to` —
      // project them as NULL to keep the snapshot shape uniform.
      const extraCols = APPEND_ONLY.has(primitive)
        ? 'NULL::uuid AS "sourceEpisodeId", NULL::timestamptz AS "validTo"'
        : 'source_episode_id AS "sourceEpisodeId", valid_to AS "validTo"'
      const result = await query<RowSensitivityRow>(
        `SELECT id           AS "rowId",
                workspace_id AS "workspaceId",
                sensitivity,
                ${extraCols}
           FROM ${table}
          WHERE id = $1 AND workspace_id = $2`,
        [rowId, workspaceId],
      )
      const row = result.rows[0]
      if (!row) return null
      return {
        primitive,
        rowId: row.rowId,
        workspaceId: row.workspaceId,
        sensitivity: row.sensitivity as Sensitivity,
        sourceEpisodeId: row.sourceEpisodeId,
        validTo: row.validTo,
      }
    },

    async applyRowReclassification(input) {
      const table = tableFor(input.primitive)
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `UPDATE ${table} SET sensitivity = $3 WHERE id = $1 AND workspace_id = $2`,
          [input.rowId, input.workspaceId, input.newSensitivity],
        )
        await client.query(
          `INSERT INTO sensitivity_reclassifications
             (workspace_id, primitive, row_id, prior_sensitivity, new_sensitivity,
              direction, triggered_by, rule_id, changed_by, reason, changed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            input.workspaceId,
            input.primitive,
            input.rowId,
            input.priorSensitivity,
            input.newSensitivity,
            input.direction,
            input.triggeredBy,
            input.ruleId,
            input.actorUserId,
            input.reason,
            input.now,
          ],
        )
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },

    async findDerivedRows(input) {
      // Only the Episode → derived-row hop is schema-expressible.
      if (input.sourcePrimitive !== 'episode') return []
      const derived: DerivedRowRef[] = []
      for (const [primitive, table] of DERIVED_FROM_EPISODE) {
        const result = await query<{ rowId: string; sensitivity: string }>(
          `SELECT id AS "rowId", sensitivity
             FROM ${table}
            WHERE workspace_id = $1 AND source_episode_id = $2 AND valid_to IS NULL`,
          [input.workspaceId, input.sourceRowId],
        )
        for (const r of result.rows) {
          derived.push({
            primitive,
            rowId: r.rowId,
            sensitivity: r.sensitivity as Sensitivity,
          })
        }
      }
      return derived
    },
  }
}

// ── ChannelSensitivityRuleRepository ─────────────────────────────────

type ChannelRuleRow = {
  id: string
  workspaceId: string
  sourceKind: string
  sourceRefMatch: Record<string, unknown>
  defaultSensitivity: string
  appliedFrom: Date
  supersededAt: Date | null
  supersededBy: string | null
}

const CHANNEL_RULE_COLS = `
  id,
  workspace_id        AS "workspaceId",
  source_kind         AS "sourceKind",
  source_ref_match    AS "sourceRefMatch",
  default_sensitivity AS "defaultSensitivity",
  applied_from        AS "appliedFrom",
  superseded_at       AS "supersededAt",
  superseded_by       AS "supersededBy"
`

function toChannelRule(row: ChannelRuleRow): ChannelSensitivityRule {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sourceKind: row.sourceKind,
    sourceRefMatch: row.sourceRefMatch ?? {},
    defaultSensitivity: row.defaultSensitivity as Sensitivity,
    appliedFrom: row.appliedFrom,
    supersededAt: row.supersededAt,
    supersededBy: row.supersededBy,
  }
}

export function createChannelSensitivityRuleStore(): ChannelSensitivityRuleRepository {
  return {
    async readRule(workspaceId, ruleId) {
      const result = await query<ChannelRuleRow>(
        `SELECT ${CHANNEL_RULE_COLS}
           FROM channel_sensitivity_rules
          WHERE id = $1 AND workspace_id = $2`,
        [ruleId, workspaceId],
      )
      const row = result.rows[0]
      return row ? toChannelRule(row) : null
    },

    async insertSupersedingRule(input) {
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO channel_sensitivity_rules
             (workspace_id, source_kind, source_ref_match, default_sensitivity,
              applied_from, created_by, reason)
           VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
           RETURNING id`,
          [
            input.workspaceId,
            input.newRule.sourceKind,
            JSON.stringify(input.newRule.sourceRefMatch),
            input.newRule.defaultSensitivity,
            input.now,
            input.actorUserId,
            input.reason,
          ],
        )
        const newRuleId = inserted.rows[0].id
        await client.query(
          `UPDATE channel_sensitivity_rules
              SET superseded_at = $2, superseded_by = $3
            WHERE id = $1 AND workspace_id = $4`,
          [input.priorRuleId, input.now, newRuleId, input.workspaceId],
        )
        await client.query('COMMIT')
        return { newRuleId }
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },

    async findRowsUnderRuleScope(input) {
      // Rows the rule has reclassified, most-recent classification per
      // row. The retroactive-upgrade caller re-reads each row's live
      // state via `readRowForReclassification`, so a slightly stale
      // `sensitivity` here only drives the upgrade pre-filter.
      const result = await query<{ primitive: string; rowId: string; sensitivity: string }>(
        `SELECT DISTINCT ON (primitive, row_id)
                primitive,
                row_id          AS "rowId",
                new_sensitivity AS "sensitivity"
           FROM sensitivity_reclassifications
          WHERE workspace_id = $1 AND rule_id = $2
          ORDER BY primitive, row_id, changed_at DESC`,
        [input.workspaceId, input.ruleId],
      )
      return result.rows.map((r): RowSensitivitySnapshot => ({
        primitive: r.primitive as ReclassifiablePrimitive,
        rowId: r.rowId,
        workspaceId: input.workspaceId,
        sensitivity: r.sensitivity as Sensitivity,
        sourceEpisodeId: null,
        validTo: null,
      }))
    },
  }
}
