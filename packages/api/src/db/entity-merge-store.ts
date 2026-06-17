/**
 * `entity-merge-store.ts` — company-brain corrections D.1 / D.2.
 *
 * DB adapter fulfilling the `EntityMergeRepository` +
 * `SpecializationCascadeRepository` ports declared by the pure merge
 * orchestration in `packages/core/src/corrections/entity-merge.ts`.
 *
 * `mergeEntities` / `undoMerge` (the orchestration) inject these ports;
 * this file is the only place SQL touches `entity_merges`, the merged
 * `entities` rows, and the CRM specialization tables.
 *
 * Access model: system-level. The caller is the admin corrections route
 * (`X-Admin-Key`-gated). `entities` carries an `entities_system_bypass`
 * RLS policy (migration 125) and `entity_merges` carries the same
 * (migration 150) — the bare pool / `SET LOCAL app.system_bypass` path
 * is correct here, exactly like other operator-facing stores.
 *
 * Merge mechanics:
 *   - applyMerge supersedes the merged entity (`valid_to = now()`,
 *     `superseded_by = survivingId`), overwrites the survivor's
 *     `attributes` with the reconciled set, and writes one
 *     `entity_merges` row — all in one transaction.
 *   - applyUndoMerge reverses it: clears the merged entity's
 *     supersession, restores the survivor's pre-merge `attributes`, and
 *     stamps the merge row undone.
 *   - Edges are intentionally untouched (auto-redirect via `superseded_by`
 *     is retrieval's concern — see entity-merge.ts header).
 *   - Entities have no `tags` column (migration 125); `reconciledTags`
 *     from the orchestration is therefore not persisted, and snapshot
 *     `tags` is always `[]`.
 *
 * [COMP:corrections/entity-merge-store]
 */

import type {
  ApplyMergeInput,
  ApplyUndoMergeInput,
  EntityMergeRecord,
  EntityMergeRepository,
  EntityMergeSnapshot,
  ReconciliationOverride,
  SpecializationCascadeRepository,
  SpecializationPointer,
} from '@sidanclaw/core'
import { getPool, query } from './client.js'

// CRM specialization tables that can carry a merge cascade. The merge
// `sourceKind` is interpolated into SQL — this allowlist is the guard.
const CASCADE_TABLES: Record<string, string> = {
  contacts: 'contacts',
  companies: 'companies',
  deals: 'deals',
}

// ── Snapshot (de)serialization ───────────────────────────────────────

/** Revive an `EntityMergeSnapshot` from JSONB — `validTo` back to a Date. */
function reviveSnapshot(raw: unknown): EntityMergeSnapshot {
  const s = raw as Record<string, unknown>
  return {
    entityId: s.entityId as string,
    displayName: s.displayName as string,
    attributes: (s.attributes as Record<string, unknown>) ?? {},
    tags: (s.tags as string[]) ?? [],
    validTo: s.validTo ? new Date(s.validTo as string) : null,
    supersededBy: (s.supersededBy as string | null) ?? null,
    workspaceId: s.workspaceId as string,
  }
}

type EntityRowForMerge = {
  id: string
  displayName: string
  attributes: Record<string, unknown>
  validTo: Date | null
  supersededBy: string | null
  workspaceId: string
}

function rowToSnapshot(row: EntityRowForMerge): EntityMergeSnapshot {
  return {
    entityId: row.id,
    displayName: row.displayName,
    attributes: row.attributes ?? {},
    tags: [], // entities have no tags column (migration 125)
    validTo: row.validTo,
    supersededBy: row.supersededBy,
    workspaceId: row.workspaceId,
  }
}

const MERGE_COLS = `
  id,
  workspace_id                   AS "workspaceId",
  surviving_id                   AS "survivingId",
  merged_id                      AS "mergedId",
  merged_at                      AS "mergedAt",
  merged_by                      AS "mergedBy",
  reason,
  merged_attributes_snapshot     AS "mergedAttributesSnapshot",
  surviving_attributes_pre_merge AS "survivingAttributesPreMerge",
  merged_specialization_pointer  AS "mergedSpecializationPointer",
  cascade_applied                AS "cascadeApplied",
  reconciliation_overrides       AS "reconciliationOverrides"
`

function rowToMergeRecord(row: Record<string, unknown>): EntityMergeRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspaceId as string,
    survivingId: row.survivingId as string,
    mergedId: row.mergedId as string,
    mergedAt: row.mergedAt as Date,
    mergedBy: (row.mergedBy as string | null) ?? null,
    reason: (row.reason as string | null) ?? null,
    mergedAttributesSnapshot: reviveSnapshot(row.mergedAttributesSnapshot),
    survivingAttributesPreMerge:
      row.survivingAttributesPreMerge != null
        ? reviveSnapshot(row.survivingAttributesPreMerge)
        : null,
    mergedSpecializationPointer:
      (row.mergedSpecializationPointer as SpecializationPointer | null) ?? null,
    cascadeApplied: Boolean(row.cascadeApplied),
    reconciliationOverrides:
      (row.reconciliationOverrides as readonly ReconciliationOverride[] | null) ?? null,
  }
}

// ── EntityMergeRepository ────────────────────────────────────────────

export function createEntityMergeStore(): EntityMergeRepository {
  return {
    async readEntityForMerge(workspaceId, entityId) {
      const result = await query<EntityRowForMerge>(
        `SELECT id,
                display_name  AS "displayName",
                attributes,
                valid_to      AS "validTo",
                superseded_by AS "supersededBy",
                workspace_id  AS "workspaceId"
           FROM entities
          WHERE id = $1 AND workspace_id = $2`,
        [entityId, workspaceId],
      )
      const row = result.rows[0]
      return row ? rowToSnapshot(row) : null
    },

    async applyMerge(input: ApplyMergeInput): Promise<EntityMergeRecord> {
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')

        // 1. Supersede the merged entity → points at the survivor.
        await client.query(
          `UPDATE entities
              SET valid_to      = $2,
                  superseded_by = $3,
                  updated_at    = now()
            WHERE id = $1 AND workspace_id = $4`,
          [input.mergedId, input.now, input.survivingId, input.workspaceId],
        )

        // 2. Overwrite the survivor's attributes with the reconciled set.
        //    (Tags are not persisted — entities have no tags column.)
        await client.query(
          `UPDATE entities
              SET attributes = $2::jsonb,
                  updated_at = now()
            WHERE id = $1 AND workspace_id = $3`,
          [
            input.survivingId,
            JSON.stringify(input.reconciledAttributes),
            input.workspaceId,
          ],
        )

        // 3. Write the merge record.
        const inserted = await client.query(
          `INSERT INTO entity_merges (
             workspace_id, surviving_id, merged_id, merged_at, merged_by,
             reason, merged_attributes_snapshot, surviving_attributes_pre_merge,
             merged_specialization_pointer, cascade_applied, reconciliation_overrides
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11::jsonb)
           RETURNING ${MERGE_COLS}`,
          [
            input.workspaceId,
            input.survivingId,
            input.mergedId,
            input.now,
            input.mergedBy,
            input.reason,
            JSON.stringify(input.mergedAttributesSnapshot),
            JSON.stringify(input.survivingAttributesPreMerge),
            input.mergedSpecializationPointer
              ? JSON.stringify(input.mergedSpecializationPointer)
              : null,
            input.cascadeApplied,
            input.reconciliationOverrides
              ? JSON.stringify(input.reconciliationOverrides)
              : null,
          ],
        )

        await client.query('COMMIT')
        return rowToMergeRecord(inserted.rows[0] as Record<string, unknown>)
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },

    async applyUndoMerge(input: ApplyUndoMergeInput): Promise<void> {
      const { mergeRecord } = input
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')

        // 1. Un-supersede the merged entity.
        await client.query(
          `UPDATE entities
              SET valid_to      = NULL,
                  superseded_by = NULL,
                  updated_at    = now()
            WHERE id = $1 AND workspace_id = $2`,
          [mergeRecord.mergedId, mergeRecord.workspaceId],
        )

        // 2. Restore the survivor's pre-merge attributes.
        if (mergeRecord.survivingAttributesPreMerge) {
          await client.query(
            `UPDATE entities
                SET attributes = $2::jsonb,
                    updated_at = now()
              WHERE id = $1 AND workspace_id = $3`,
            [
              mergeRecord.survivingId,
              JSON.stringify(mergeRecord.survivingAttributesPreMerge.attributes),
              mergeRecord.workspaceId,
            ],
          )
        }

        // 3. Stamp the merge row undone — `findMergeById` filters these
        //    out, so a second undo is a no-op `merge_not_found`.
        await client.query(
          `UPDATE entity_merges
              SET undone_at        = $2,
                  undone_by        = $3,
                  undo_reason      = $4,
                  cascade_reversed = $5
            WHERE id = $1`,
          [
            mergeRecord.id,
            input.now,
            input.actorUserId,
            input.reason,
            input.cascadeReversed,
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

    async findMergeById(workspaceId, mergeId) {
      // Undone merges are excluded — `undoMerge` only ever acts on a
      // live merge, and excluding them gives double-undo protection.
      const result = await query(
        `SELECT ${MERGE_COLS}
           FROM entity_merges
          WHERE id = $1 AND workspace_id = $2 AND undone_at IS NULL`,
        [mergeId, workspaceId],
      )
      const row = result.rows[0]
      return row ? rowToMergeRecord(row as Record<string, unknown>) : null
    },

    async isEntityActive(workspaceId, entityId) {
      const result = await query<{ validTo: Date | null; retractedAt: Date | null }>(
        `SELECT valid_to AS "validTo", retracted_at AS "retractedAt"
           FROM entities
          WHERE id = $1 AND workspace_id = $2`,
        [entityId, workspaceId],
      )
      const row = result.rows[0]
      return row != null && row.validTo === null && row.retractedAt === null
    },
  }
}

// ── SpecializationCascadeRepository ──────────────────────────────────

export function createSpecializationCascadeStore(): SpecializationCascadeRepository {
  return {
    async applyCascade(input) {
      const table = CASCADE_TABLES[input.sourceKind]
      if (!table) {
        throw new Error(
          `entity-merge cascade: unsupported sourceKind "${input.sourceKind}"`,
        )
      }
      // Supersede the merged entity's CRM specialization row → points at
      // the survivor's specialization row.
      await query(
        `UPDATE ${table}
            SET valid_to      = $2,
                superseded_by = $3,
                updated_at    = now()
          WHERE id = $1`,
        [input.mergedSourceId, input.now, input.survivorSourceId],
      )
    },

    async reverseCascade(input) {
      const table = CASCADE_TABLES[input.sourceKind]
      if (!table) {
        throw new Error(
          `entity-merge cascade: unsupported sourceKind "${input.sourceKind}"`,
        )
      }
      const result = await query(
        `UPDATE ${table}
            SET valid_to      = NULL,
                superseded_by = NULL,
                updated_at    = now()
          WHERE id = $1 AND valid_to IS NOT NULL`,
        [input.mergedSourceId],
      )
      return (result.rowCount ?? 0) > 0 ? 'reversed' : 'missing'
    },
  }
}
