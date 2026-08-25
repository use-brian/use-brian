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

import type pg from 'pg'

import { getPool, query } from './client.js'
import { appendDecisionEvent } from './decision-event-store.js'

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
  transactionClient?: pg.PoolClient,
): Promise<MemoryVerification> {
  const ownedClient = transactionClient ? null : await getPool().connect()
  const client = transactionClient ?? ownedClient!
  try {
    if (ownedClient) await client.query('BEGIN')
    const source = await client.query<{
      assistantId: string | null
      sourceSessionId: string | null
      scope: string
      sensitivity: 'public' | 'internal' | 'confidential' | 'restricted'
    }>(
      `SELECT assistant_id AS "assistantId",
              source_session_id AS "sourceSessionId",
              scope,
              sensitivity
         FROM memories
        WHERE id = $1 AND workspace_id = $2`,
      [params.memoryId, params.workspaceId],
    )
    if (!source.rows[0]) throw new Error(`Memory ${params.memoryId} not found for verification`)

    const result = await client.query<MemoryVerification>(
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
    const verification = result.rows[0]
    await appendDecisionEvent({
      idempotencyKey: `memory-verification:${verification.id}`,
      workspaceId: params.workspaceId,
      actorUserId: params.verifiedBy,
      assistantId: source.rows[0].assistantId,
      sessionId: source.rows[0].sourceSessionId,
      eventKind: 'brain.verification_recorded',
      schemaVersion: 1,
      sourceKind: 'memory_verification',
      sourceId: verification.id,
      declaredScope: 'instance',
      visibility: source.rows[0].scope === 'workspace' ? 'workspace' : 'owner',
      sensitivity: source.rows[0].sensitivity,
      reason: params.reason,
      payload: {
        primitive: 'memory',
        targetId: params.memoryId,
        action: params.action,
        changedFields: verificationChangedFields(params.action),
      },
    }, client)
    if (ownedClient) await client.query('COMMIT')
    return verification
  } catch (err) {
    if (ownedClient) await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    ownedClient?.release()
  }
}

function verificationChangedFields(action: MemoryVerificationAction): string[] {
  switch (action) {
    case 'adjust_scope': return ['scope']
    case 'adjust_sensitivity': return ['sensitivity']
    case 'edit_summary': return ['summary']
    case 'delete': return ['valid_to']
    case 'confirm': return []
  }
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
