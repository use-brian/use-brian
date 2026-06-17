/**
 * memory_verifications — staged-memory user-correction event log
 * (migration 165).
 *
 * Each row records one user action on a model-saved memory:
 * confirm / adjust_scope / adjust_sensitivity / edit_summary / delete.
 * The companion `memories.original_scope` / `original_sensitivity` /
 * `original_summary` columns capture the *initial* model state; a
 * verification row carries the *transition* (model_value → user_value)
 * for the specific field that changed. Downstream consumers (the
 * workspace-prompt-evolution worker, the review UI) read this stream
 * to compute aggregate "the model tends to over-share to team scope"
 * signals.
 *
 * Distinct from `correction_audit` (mig 152): that table captures
 * system-level destructive correction actions (soft_delete / retract /
 * purge / re_extract); this table captures pedagogical user feedback.
 * The two complement each other — see
 * `docs/architecture/brain/corrections.md` → "Universal audit".
 *
 * [COMP:brain/memory-verifications-store]
 */

import { query } from './client.js'

export type MemoryVerificationAction =
  | 'confirm'
  | 'adjust_scope'
  | 'adjust_sensitivity'
  | 'edit_summary'
  | 'delete'

export type MemoryVerification = {
  id: string
  memoryId: string
  workspaceId: string
  verifiedBy: string
  action: MemoryVerificationAction
  modelValue: unknown
  userValue: unknown
  reason: string | null
  createdAt: Date
}

const VERIFICATION_SELECT = `
  id,
  memory_id    as "memoryId",
  workspace_id as "workspaceId",
  verified_by  as "verifiedBy",
  action,
  model_value  as "modelValue",
  user_value   as "userValue",
  reason,
  created_at   as "createdAt"
`

export type RecordVerificationParams = {
  memoryId: string
  workspaceId: string
  verifiedBy: string
  action: MemoryVerificationAction
  modelValue?: unknown
  userValue?: unknown
  reason?: string
}

/**
 * Append a verification event. One row per logical field change —
 * a single user "adjust" call that changes both scope and sensitivity
 * writes two rows (one per action). The route layer is responsible for
 * the split; this store does not enforce a uniqueness contract.
 *
 * `modelValue` / `userValue` are JSONB; pass primitives (strings,
 * numbers) or small objects. For `confirm` both can be omitted; for
 * `delete` either omit or pass a small row pointer for audit. Returns
 * the inserted row.
 */
export async function recordVerification(
  params: RecordVerificationParams,
): Promise<MemoryVerification> {
  const result = await query<MemoryVerification>(
    `INSERT INTO memory_verifications (
       memory_id, workspace_id, verified_by, action,
       model_value, user_value, reason
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${VERIFICATION_SELECT}`,
    [
      params.memoryId,
      params.workspaceId,
      params.verifiedBy,
      params.action,
      params.modelValue === undefined ? null : JSON.stringify(params.modelValue),
      params.userValue === undefined ? null : JSON.stringify(params.userValue),
      params.reason ?? null,
    ],
  )
  return result.rows[0]
}

/**
 * Paginated workspace-scoped activity feed — every verification in a
 * workspace, newest first. Backs the workspace-prompt-evolution
 * worker's batch read and the review dashboard's activity surface.
 *
 * Cursor is `{ createdAt, id }`. Strict-pair ordering on
 * `(created_at DESC, id DESC)` makes the page boundary unambiguous
 * even when multiple verifications share a timestamp.
 *
 * System-level — caller (route) enforces workspace membership.
 */
export async function listVerificationsByWorkspace(
  workspaceId: string,
  limit: number,
  cursor?: { createdAt: Date; id: string },
): Promise<MemoryVerification[]> {
  const values: unknown[] = [workspaceId]
  let cursorClause = ''
  if (cursor) {
    values.push(cursor.createdAt, cursor.id)
    cursorClause = `AND (created_at, id) < ($2, $3)`
  }
  values.push(limit)
  const result = await query<MemoryVerification>(
    `SELECT ${VERIFICATION_SELECT} FROM memory_verifications
     WHERE workspace_id = $1
       ${cursorClause}
     ORDER BY created_at DESC, id DESC
     LIMIT $${values.length}`,
    values,
  )
  return result.rows
}

/**
 * Every verification event for a single memory, newest first. Drives
 * the per-memory detail panel.
 */
export async function listVerificationsByMemory(
  memoryId: string,
): Promise<MemoryVerification[]> {
  const result = await query<MemoryVerification>(
    `SELECT ${VERIFICATION_SELECT} FROM memory_verifications
     WHERE memory_id = $1
     ORDER BY created_at DESC, id DESC`,
    [memoryId],
  )
  return result.rows
}
