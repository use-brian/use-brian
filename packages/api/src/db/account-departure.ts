/**
 * The non-owner half of `DELETE /api/account`, run before the owner-pool
 * teardown transaction (account-teardown.ts).
 *
 * Spec: docs/architecture/features/privacy-controls.md -> "Departure phase".
 *
 * A canonical task changes only through its canonical writer on a non-owner
 * connection, as a current member with patch authority over the live
 * version (migration 8051). The owner-pool teardown therefore cannot move an
 * assignment, so this phase does it first, while the leaving user is still a
 * member: every live task assigned to them in a workspace they do not own is
 * reassigned to the workspace owner's membership through `updateTask`,
 * acting as the leaving user (the departure is their own request). The new
 * version names the leaving user as its author, a recorded actor the
 * teardown keeps as "Deleted user"; the owner is never credited.
 *
 * A move the writer refuses (no patch authority over that task any more, or
 * a concurrent change) is counted and left to the schema: the membership
 * delete sets `assignee_id` to NULL, which the guard admits as bounded FK
 * maintenance. Each move commits on its own and only hands work to the
 * owner, so a teardown that fails afterwards exposes nothing and can retry.
 */

import { getPool } from './client.js'
import { updateTask } from './tasks.js'

export type DepartureResult = { reassigned: number; unassigned: number }

/** Refusal categories of the canonical task writer; anything else is a fault. */
const REFUSED = new Set(['access_unavailable', 'record_version_conflict', 'invalid_value', 'not_found'])

export async function reassignDepartingAssignments(userId: string): Promise<DepartureResult> {
  // Discovery only: ids and the owner's membership, read on the owner pool.
  // The write itself goes through the canonical writer below.
  const { rows } = await getPool().query<{ id: string; owner_member: string }>(
    `SELECT t.id, om.id AS owner_member
       FROM tasks t
       JOIN workspace_members lm ON lm.id = t.assignee_id AND lm.user_id = $1
       JOIN workspaces w ON w.id = t.workspace_id AND w.owner_user_id <> $1
       JOIN workspace_members om ON om.workspace_id = w.id AND om.user_id = w.owner_user_id
      WHERE t.valid_to IS NULL AND t.retracted_at IS NULL
      ORDER BY t.workspace_id, t.id`,
    [userId],
  )
  const result: DepartureResult = { reassigned: 0, unassigned: 0 }
  for (const row of rows) {
    try {
      const moved = await updateTask(userId, row.id, { assigneeId: row.owner_member })
      if (moved) result.reassigned++
      else result.unassigned++
    } catch (err) {
      const code = (err as { code?: unknown }).code
      if (typeof code !== 'string' || !REFUSED.has(code)) throw err
      result.unassigned++
    }
  }
  return result
}
