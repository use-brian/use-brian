/**
 * Blueprint records store, backed by PostgreSQL (migration 307).
 *
 * A record is one filled instance of a blueprint's typed contract: subject +
 * `{ key → value }` under the contract's `ExtractionField[]`, with provenance
 * (`source_kind`/`source_id`), inherited sensitivity, completeness
 * (`status`/`missing`), and an optional page PROJECTION (`page_id`). The
 * record — not the page — is what workflows and assistants read for handoff.
 *
 * Write shape mirrors how a fill actually runs:
 *   `ensure` (find-or-create by anchor, artifact-before-the-loop) →
 *   incremental `mergeFields` (each validated `writeField` call flushes, so a
 *   timed-out run still leaves partial values) → `finalize` (status + missing
 *   + the projection link).
 *
 * RLS via the `blueprint_records_workspace_member` policy — workspace-shared
 * like page templates. All access goes through `queryWithRLS(userId, ...)`.
 *
 * Spec: docs/architecture/brain/structural-synthesis.md → "The record".
 *
 * [COMP:api/blueprint-records-store]
 */

import type { BlueprintRecordFields, BlueprintRecordStatus, ExtractionField } from '@use-brian/core'

import { queryWithRLS } from './client.js'

export type BlueprintRecordSourceKind = 'recording' | 'brain' | 'research' | 'chat' | 'workflow'

export type BlueprintRecord = {
  id: string
  workspaceId: string
  /** Null after the source blueprint was deleted — `specSnapshot` keeps the record self-describing. */
  blueprintId: string | null
  specSnapshot: ExtractionField[]
  subject: string
  anchorKey: string
  fields: BlueprintRecordFields
  status: BlueprintRecordStatus
  missing: string[]
  sourceKind: BlueprintRecordSourceKind
  sourceId: string | null
  sensitivity: string
  /** The page projection, when one was rendered. */
  pageId: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

export type EnsureBlueprintRecordInput = {
  workspaceId: string
  blueprintId: string | null
  specSnapshot: ExtractionField[]
  subject: string
  anchorKey: string
  sourceKind: BlueprintRecordSourceKind
  sourceId?: string | null
  sensitivity: string
  /**
   * True (a fresh fill) wipes prior field values so a re-run never leaves
   * stale keys behind; false (a direct partial save) merges over what exists.
   */
  resetFields: boolean
}

export type BlueprintRecordStore = {
  /** Find-or-create by (workspace, anchor) — the artifact exists before any loop runs. */
  ensure(userId: string, input: EnsureBlueprintRecordInput): Promise<BlueprintRecord>
  /** Shallow-merge validated values into `fields` (jsonb `||`). */
  mergeFields(userId: string, id: string, patch: BlueprintRecordFields): Promise<boolean>
  /** Stamp completeness (+ the page projection when one was rendered). */
  finalize(
    userId: string,
    id: string,
    outcome: { status: BlueprintRecordStatus; missing: string[]; pageId?: string | null },
  ): Promise<BlueprintRecord | null>
  getById(userId: string, id: string): Promise<BlueprintRecord | null>
  getByAnchor(userId: string, workspaceId: string, anchorKey: string): Promise<BlueprintRecord | null>
  /**
   * The record a page PROJECTS (mig 321 index) — the forward read behind
   * page-action button resolution and `send_page`'s recordField lookup.
   * Newest first if several records ever point at one page (SET NULL churn).
   */
  getByPageId(userId: string, workspaceId: string, pageId: string): Promise<BlueprintRecord | null>
  /** Latest record a given source produced (e.g. workflow runId) — `{{lastRun.output.*}}`. */
  getLatestForSource(
    userId: string,
    workspaceId: string,
    sourceKind: BlueprintRecordSourceKind,
    sourceId: string,
  ): Promise<BlueprintRecord | null>
  /** Latest record for (blueprint, subject) — the `getBlueprintRecord` handoff read. */
  getLatestBySubject(
    userId: string,
    workspaceId: string,
    blueprintId: string,
    subject: string,
  ): Promise<BlueprintRecord | null>
  /** A blueprint's records, newest first (the Brain → Blueprints rows view). */
  listForBlueprint(
    userId: string,
    workspaceId: string,
    blueprintId: string,
    limit?: number,
  ): Promise<BlueprintRecord[]>
}

type Row = {
  id: string
  workspace_id: string
  blueprint_id: string | null
  spec_snapshot: ExtractionField[]
  subject: string
  anchor_key: string
  fields: BlueprintRecordFields
  status: string
  missing: string[]
  source_kind: string
  source_id: string | null
  sensitivity: string
  page_id: string | null
  created_by: string
  created_at: Date
  updated_at: Date
}

const SELECT =
  'id, workspace_id, blueprint_id, spec_snapshot, subject, anchor_key, fields, status, missing, source_kind, source_id, sensitivity, page_id, created_by, created_at, updated_at'

function rowToRecord(row: Row): BlueprintRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    blueprintId: row.blueprint_id,
    specSnapshot: row.spec_snapshot,
    subject: row.subject,
    anchorKey: row.anchor_key,
    fields: row.fields ?? {},
    status: row.status === 'complete' ? 'complete' : 'incomplete',
    missing: Array.isArray(row.missing) ? row.missing : [],
    sourceKind: row.source_kind as BlueprintRecordSourceKind,
    sourceId: row.source_id,
    sensitivity: row.sensitivity,
    pageId: row.page_id,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

export function createDbBlueprintRecordStore(): BlueprintRecordStore {
  return {
    async ensure(userId, input) {
      const result = await queryWithRLS<Row>(
        userId,
        `INSERT INTO blueprint_records
           (workspace_id, blueprint_id, spec_snapshot, subject, anchor_key,
            source_kind, source_id, sensitivity, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (workspace_id, anchor_key) DO UPDATE SET
           blueprint_id = EXCLUDED.blueprint_id,
           spec_snapshot = EXCLUDED.spec_snapshot,
           subject = EXCLUDED.subject,
           source_kind = EXCLUDED.source_kind,
           source_id = EXCLUDED.source_id,
           sensitivity = EXCLUDED.sensitivity,
           fields = CASE WHEN $10 THEN '{}'::jsonb ELSE blueprint_records.fields END,
           status = 'incomplete',
           missing = '[]'::jsonb
         RETURNING ${SELECT}`,
        [
          input.workspaceId,
          input.blueprintId,
          JSON.stringify(input.specSnapshot),
          input.subject,
          input.anchorKey,
          input.sourceKind,
          input.sourceId ?? null,
          input.sensitivity,
          userId,
          input.resetFields,
        ],
      )
      return rowToRecord(result.rows[0])
    },

    async mergeFields(userId, id, patch) {
      const result = await queryWithRLS<{ id: string }>(
        userId,
        `UPDATE blueprint_records SET fields = fields || $2::jsonb WHERE id = $1 RETURNING id`,
        [id, JSON.stringify(patch)],
      )
      return result.rows.length > 0
    },

    async finalize(userId, id, outcome) {
      const result = await queryWithRLS<Row>(
        userId,
        `UPDATE blueprint_records
         SET status = $2, missing = $3::jsonb, page_id = COALESCE($4, page_id)
         WHERE id = $1
         RETURNING ${SELECT}`,
        [id, outcome.status, JSON.stringify(outcome.missing), outcome.pageId ?? null],
      )
      return result.rows[0] ? rowToRecord(result.rows[0]) : null
    },

    async getById(userId, id) {
      const result = await queryWithRLS<Row>(
        userId,
        `SELECT ${SELECT} FROM blueprint_records WHERE id = $1`,
        [id],
      )
      return result.rows[0] ? rowToRecord(result.rows[0]) : null
    },

    async getByAnchor(userId, workspaceId, anchorKey) {
      const result = await queryWithRLS<Row>(
        userId,
        `SELECT ${SELECT} FROM blueprint_records WHERE workspace_id = $1 AND anchor_key = $2`,
        [workspaceId, anchorKey],
      )
      return result.rows[0] ? rowToRecord(result.rows[0]) : null
    },

    async getByPageId(userId, workspaceId, pageId) {
      const result = await queryWithRLS<Row>(
        userId,
        `SELECT ${SELECT} FROM blueprint_records
         WHERE workspace_id = $1 AND page_id = $2
         ORDER BY updated_at DESC
         LIMIT 1`,
        [workspaceId, pageId],
      )
      return result.rows[0] ? rowToRecord(result.rows[0]) : null
    },

    async getLatestForSource(userId, workspaceId, sourceKind, sourceId) {
      const result = await queryWithRLS<Row>(
        userId,
        `SELECT ${SELECT} FROM blueprint_records
         WHERE workspace_id = $1 AND source_kind = $2 AND source_id = $3
         ORDER BY updated_at DESC
         LIMIT 1`,
        [workspaceId, sourceKind, sourceId],
      )
      return result.rows[0] ? rowToRecord(result.rows[0]) : null
    },

    async getLatestBySubject(userId, workspaceId, blueprintId, subject) {
      const result = await queryWithRLS<Row>(
        userId,
        `SELECT ${SELECT} FROM blueprint_records
         WHERE workspace_id = $1 AND blueprint_id = $2 AND lower(subject) = lower($3)
         ORDER BY updated_at DESC
         LIMIT 1`,
        [workspaceId, blueprintId, subject],
      )
      return result.rows[0] ? rowToRecord(result.rows[0]) : null
    },

    async listForBlueprint(userId, workspaceId, blueprintId, limit = 100) {
      const result = await queryWithRLS<Row>(
        userId,
        `SELECT ${SELECT} FROM blueprint_records
         WHERE workspace_id = $1 AND blueprint_id = $2
         ORDER BY updated_at DESC
         LIMIT $3`,
        [workspaceId, blueprintId, Math.min(Math.max(limit, 1), 500)],
      )
      return result.rows.map(rowToRecord)
    },
  }
}
