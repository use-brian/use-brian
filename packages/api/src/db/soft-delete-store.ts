/**
 * `soft-delete-store.ts` — company-brain corrections D.4.
 *
 * DB adapter fulfilling the `SoftDeleteRepository` port declared by the
 * pure orchestration in `packages/core/src/corrections/soft-delete.ts`.
 * `softDelete` / `hardPurge` / `deleteByAuthor` inject this port.
 *
 * Access model: system-level operator state — the admin corrections
 * route. Every soft-delete primitive table carries a `system_bypass`
 * RLS policy, so the bare pool path is correct (see
 * `entity-merge-store.ts` for the same posture).
 *
 * `readForSoftDelete` and `readForAuthorshipDelete` resolve to the same
 * query here: the port distinguishes them so a *predicate-applying*
 * adapter can bypass its sensitivity/visibility filter for the author
 * path. This adapter is system-level and applies no predicate, so the
 * two reads are identical — the distinction is a no-op, kept so the
 * port contract is satisfied and a future RLS-scoped adapter slots in.
 *
 * Episodes are append-only (migration 129 — no `valid_to` column):
 * `applySoftDelete('episode')` is rejected. Episode correction is
 * hard-purge-only (D.4 — "GDPR-only purge"), and `applyHardPurge`
 * supports it.
 *
 * [COMP:corrections/soft-delete-store]
 */

import type { RowSnapshot, SoftDeletePrimitive, SoftDeleteRepository } from '@sidanclaw/core'
import { getPool, query } from './client.js'

/** Soft-delete primitive → table. The map is the SQL-interpolation allowlist. */
const SOFT_DELETE_TABLES: Record<SoftDeletePrimitive, string> = {
  entity: 'entities',
  task: 'tasks',
  kb_chunk: 'kb_chunks',
  workspace_file: 'workspace_files',
  contact: 'contacts',
  company: 'companies',
  deal: 'deals',
  episode: 'episodes',
}

/** Primitives with no `valid_to` / `retracted_at` columns (append-only). */
const APPEND_ONLY: ReadonlySet<SoftDeletePrimitive> = new Set<SoftDeletePrimitive>(['episode'])

function tableFor(primitive: SoftDeletePrimitive): string {
  const table = SOFT_DELETE_TABLES[primitive]
  if (!table) {
    throw new Error(`soft-delete: unsupported primitive "${primitive}"`)
  }
  return table
}

type RowSnapshotRow = {
  rowId: string
  workspaceId: string
  validTo: Date | null
  retractedAt: Date | null
  createdByUserId: string | null
}

async function readSnapshot(
  primitive: SoftDeletePrimitive,
  workspaceId: string,
  rowId: string,
): Promise<RowSnapshot | null> {
  const table = tableFor(primitive)
  // Episodes carry no temporal columns — project them as NULL so the
  // snapshot shape is uniform across primitives.
  const temporalCols = APPEND_ONLY.has(primitive)
    ? 'NULL::timestamptz AS "validTo", NULL::timestamptz AS "retractedAt"'
    : 'valid_to AS "validTo", retracted_at AS "retractedAt"'
  const result = await query<RowSnapshotRow>(
    `SELECT id                 AS "rowId",
            workspace_id       AS "workspaceId",
            created_by_user_id AS "createdByUserId",
            ${temporalCols}
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
    validTo: row.validTo,
    retractedAt: row.retractedAt,
    createdByUserId: row.createdByUserId,
  }
}

export function createSoftDeleteStore(): SoftDeleteRepository {
  return {
    readForSoftDelete(primitive, workspaceId, rowId) {
      return readSnapshot(primitive, workspaceId, rowId)
    },

    // System-level adapter — no read predicate to bypass. Same query as
    // `readForSoftDelete`; see the file header.
    readForAuthorshipDelete(primitive, workspaceId, rowId) {
      return readSnapshot(primitive, workspaceId, rowId)
    },

    async applySoftDelete(input) {
      if (APPEND_ONLY.has(input.primitive)) {
        throw new Error(
          `soft-delete: ${input.primitive} is append-only and cannot be ` +
            'soft-deleted; route GDPR erasure through hardPurge',
        )
      }
      const table = tableFor(input.primitive)
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `UPDATE ${table} SET valid_to = $3 WHERE id = $1 AND workspace_id = $2`,
          [input.rowId, input.workspaceId, input.now],
        )
        // The row keeps no soft-delete reason column — `correction_audit`
        // is where the who/why for a `valid_to` deletion lives.
        await client.query(
          `INSERT INTO correction_audit
             (workspace_id, action, primitive, row_id, actor_user_id, reason)
           VALUES ($1, 'soft_delete', $2, $3, $4, $5)`,
          [
            input.workspaceId,
            input.primitive,
            input.rowId,
            input.actorUserId,
            input.reason,
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

    async applyHardPurge(input) {
      const table = tableFor(input.primitive)
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        // Snapshot before the DELETE — D.7 keeps an existence record of
        // the vanished row. For `workspace_file`, the GCS object itself
        // is removed by the operator file-retention path, not here.
        await client.query(
          `INSERT INTO correction_audit
             (workspace_id, action, primitive, row_id, actor_user_id, reason,
              ticket_reference, row_snapshot)
           VALUES ($1, 'purge', $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            input.workspaceId,
            input.primitive,
            input.rowId,
            input.actorUserId,
            input.reason,
            input.ticketReference,
            JSON.stringify(input.snapshot),
          ],
        )
        await client.query(
          `DELETE FROM ${table} WHERE id = $1 AND workspace_id = $2`,
          [input.rowId, input.workspaceId],
        )
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }
    },
  }
}
